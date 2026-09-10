import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type Usage,
} from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	startClaudeCliMcpBridge,
	type ClaudeCliMcpBridge,
	type ClaudeCliRuntimeToolEvent,
} from "./claude-cli-mcp.js";
import type { ToolOutputEvent } from "./tools/tool-output-stream.js";

export const CODEX_CLI_PROVIDER = "codex-cli";
export const CODEX_CLI_API = "codex-cli";
export const CODEX_CLI_MODEL_IDS = ["default"] as const;

// Pi's AgentSession requires configured request auth before it calls a custom
// stream function. This runtime-only marker satisfies that generic preflight;
// it is not a Codex credential and is never passed to the Codex subprocess.
const CODEX_CLI_RUNTIME_AUTH_SENTINEL = "troublemaker-local-codex-cli";

interface RuntimeAuthStorage {
	setRuntimeApiKey(provider: string, apiKey: string): void | Promise<void>;
	registerProvider?(
		provider: string,
		config: {
			name: string;
			api: Api;
			apiKey: string;
			streamSimple: () => never;
			models: Array<{
				id: string;
				name: string;
				api: Api;
				baseUrl: string;
				reasoning: boolean;
				input: ("text" | "image")[];
				cost: Model<Api>["cost"];
				contextWindow: number;
				maxTokens: number;
			}>;
		},
	): void;
}

const CODEX_CLI_CLEAR_ENV = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY"] as const;

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_CHARS = 8 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_LINES = 20_000;
const DEFAULT_RESEED_CHARS = 120_000;
const STDERR_TAIL_CHARS = 16_000;

interface CodexCliSessionState {
	version: 1;
	sessionId: string;
	updatedAt: string;
}

interface CodexCliInvocationResult {
	exitCode: number | null;
	sessionId?: string;
	responseModel?: string;
	resultText: string;
	usage: Usage;
	errorText?: string;
	aborted: boolean;
}

interface CodexCliEmitter {
	readonly hasText: boolean;
	append(delta: string): void;
	finish(result: CodexCliInvocationResult, model: Model<Api>): void;
}

export interface CodexCliStreamOptions {
	tools?: () => AgentTool<any>[];
	onToolEvent?: (event: ClaudeCliRuntimeToolEvent) => void | Promise<void>;
	onToolOutput?: (event: ToolOutputEvent) => void | Promise<void>;
}

let authCache: { key: string; expiresAt: number; authenticated: boolean } | undefined;

function createCodexCliModel(id: string, name: string): Model<Api> {
	return {
		id,
		name,
		api: CODEX_CLI_API,
		provider: CODEX_CLI_PROVIDER,
		baseUrl: "codex://local-cli",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	};
}

export function isCodexCliProvider(provider: string | undefined): boolean {
	return provider?.trim().toLowerCase() === CODEX_CLI_PROVIDER;
}

export async function registerCodexCliRuntimeAuth(authStorage: RuntimeAuthStorage): Promise<void> {
	authStorage.registerProvider?.(CODEX_CLI_PROVIDER, {
		name: "Codex",
		api: CODEX_CLI_API,
		apiKey: CODEX_CLI_RUNTIME_AUTH_SENTINEL,
		streamSimple: () => {
			throw new Error("Codex CLI streaming is owned by Troublemaker's local CLI adapter");
		},
		models: listCodexCliModels().map((model) => ({
			id: model.id,
			name: model.name,
			api: model.api,
			baseUrl: model.baseUrl,
			reasoning: model.reasoning,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		})),
	});
	await authStorage.setRuntimeApiKey(CODEX_CLI_PROVIDER, CODEX_CLI_RUNTIME_AUTH_SENTINEL);
}

export function getCodexCliRuntimeAuth(provider: string | undefined): string | undefined {
	return isCodexCliProvider(provider) ? CODEX_CLI_RUNTIME_AUTH_SENTINEL : undefined;
}

export function getCodexCliModel(modelId: string): Model<Api> | undefined {
	const id = modelId.trim();
	return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) ? createCodexCliModel(id, id === "default" ? "Codex CLI (default)" : `Codex CLI ${id}`) : undefined;
}

export function listCodexCliModels(): Model<Api>[] {
	return CODEX_CLI_MODEL_IDS.map((id) => getCodexCliModel(id)!);
}

export function resolveCodexCliCommand(env: NodeJS.ProcessEnv = process.env): string {
	return env.MOM_CODEX_CLI_PATH?.trim() || "codex";
}

export function buildCodexCliEnvironment(
	baseEnv: NodeJS.ProcessEnv = process.env,
	contextWindow = 200_000,
): NodeJS.ProcessEnv {
	const env = { ...baseEnv };
	for (const name of CODEX_CLI_CLEAR_ENV) delete env[name];

	return env;
}

export function resetCodexCliAuthCache(): void {
	authCache = undefined;
}

/**
 * Codex authentication remains owned by the Codex CLI. Troublemaker only
 * checks the existing service user's profile before advertising CLI models.
 */
export function isCodexCliAuthenticated(env: NodeJS.ProcessEnv = process.env): boolean {
	const command = resolveCodexCliCommand(env);
	const cacheMs = readBoundedInteger(env.MOM_CODEX_CLI_AUTH_CACHE_MS, 30_000, 0, 5 * 60_000);
	const key = `${command}\0${env.HOME || ""}\0${env.CODEX_HOME || ""}`;
	if (authCache?.key === key && authCache.expiresAt > Date.now()) return authCache.authenticated;

	let authenticated = false;
	try {
		const result = spawnSync(command, ["login", "status"], {
			encoding: "utf8",
			env: buildCodexCliEnvironment(env),
			timeout: 5_000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		authenticated = result.status === 0;
	} catch {
		authenticated = false;
	}

	authCache = { key, authenticated, expiresAt: Date.now() + cacheMs };
	return authenticated;
}

export function resetCodexCliSession(workspaceDir: string): void {
	const path = codexCliSessionPath(workspaceDir);
	try {
		rmSync(path, { force: true });
	} catch {
		// A missing or already-cleared session is equivalent to success.
	}
}

export function createCodexCliStream(
	workspaceDir: string,
	runtime: CodexCliStreamOptions = {},
) {
	return (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream => {
		const stream = createAssistantMessageEventStream();
		const emitter = createEmitter(stream, model);
		void runCodexCliTurn({ workspaceDir, model, context, options, emitter, runtime }).catch((error) => {
			emitter.finish(
				{
					exitCode: null,
					resultText: "",
					usage: emptyUsage(),
					errorText: error instanceof Error ? error.message : String(error),
					aborted: options?.signal?.aborted === true,
				},
				model,
			);
		});
		return stream;
	};
}

async function runCodexCliTurn(params: {
	workspaceDir: string;
	model: Model<Api>;
	context: Context;
	options?: SimpleStreamOptions;
	emitter: CodexCliEmitter;
	runtime: CodexCliStreamOptions;
}): Promise<void> {
	if (!isCodexCliProvider(params.model.provider)) {
		throw new Error(`Codex CLI stream cannot run provider ${params.model.provider}`);
	}
	if (!getCodexCliModel(params.model.id)) {
		throw new Error(`Unsupported Codex CLI model: ${params.model.id}`);
	}

	const tempDir = await mkdtemp(join(tmpdir(), "troublemaker-codex-cli-"));
	let mcpBridge: ClaudeCliMcpBridge | undefined;
	try {
		const systemPromptFile = join(tempDir, "system-prompt.md");
		const mcpConfigFile = join(tempDir, "mcp-config.json");
		await writeFile(systemPromptFile, params.context.systemPrompt || "", { encoding: "utf8", mode: 0o600 });
		mcpBridge = await startClaudeCliMcpBridge({
			tools: params.runtime.tools?.() || [],
			onToolEvent: params.runtime.onToolEvent,
			onToolOutput: params.runtime.onToolOutput,
		});
		await writeFile(mcpConfigFile, JSON.stringify({ ...mcpBridge.config, toolNames: (params.runtime.tools?.() || []).map((tool) => tool.name) }), { encoding: "utf8", mode: 0o600 });

		const sessionState = readCodexCliSession(params.workspaceDir);
		const resume = Boolean(sessionState && canResumeClaudeSession(params.context));
		const prompt = await buildCodexCliPrompt(params.context, resume, tempDir);
		let requestedSessionId = resume ? sessionState!.sessionId : randomUUID();
		let result = await invokeCodexCli({
			workspaceDir: params.workspaceDir,
			model: params.model,
			options: params.options,
			systemPromptFile,
			mcpConfigFile,
			prompt,
			sessionId: requestedSessionId,
			resume,
			emitter: params.emitter,
		});

		if (resume && !params.emitter.hasText && isMissingSessionError(result.errorText)) {
			resetCodexCliSession(params.workspaceDir);
			requestedSessionId = randomUUID();
			result = await invokeCodexCli({
				workspaceDir: params.workspaceDir,
				model: params.model,
				options: params.options,
				systemPromptFile,
				mcpConfigFile,
				prompt: await buildCodexCliPrompt(params.context, false, tempDir),
				sessionId: requestedSessionId,
				resume: false,
				emitter: params.emitter,
			});
		}

		if (!result.errorText && result.exitCode === 0) {
			if (!result.sessionId) throw new Error("Codex CLI did not return a thread id");
			writeCodexCliSession(params.workspaceDir, result.sessionId);
		} else {
			resetCodexCliSession(params.workspaceDir);
		}
		params.emitter.finish(result, params.model);
	} finally {
		await mcpBridge?.close().catch(() => {});
		await rm(tempDir, { recursive: true, force: true });
	}
}

async function invokeCodexCli(params: {
	workspaceDir: string;
	model: Model<Api>;
	options?: SimpleStreamOptions;
	systemPromptFile: string;
	mcpConfigFile: string;
	prompt: string;
	sessionId: string;
	resume: boolean;
	emitter: CodexCliEmitter;
}): Promise<CodexCliInvocationResult> {
	const env = buildCodexCliEnvironment(process.env, params.model.contextWindow);
	const config = JSON.parse(readFileSync(params.mcpConfigFile, "utf8"));
	const bridge = { ...config.mcpServers.troublemaker, toolNames: config.toolNames };
	Object.assign(env, bridge.env);
	const command = resolveCodexCliCommand(env);
	const args = buildCodexCliArgs({
		modelId: params.model.id,
		systemPromptFile: params.systemPromptFile,
		mcpConfigFile: params.mcpConfigFile,
		sessionId: params.sessionId,
		resume: params.resume,
		reasoning: params.options?.reasoning,
		bridge,
	});
	const timeoutMs = readBoundedInteger(env.MOM_CODEX_CLI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1_000, 24 * 60 * 60 * 1000);
	const idleTimeoutMs = readBoundedInteger(env.MOM_CODEX_CLI_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS, 1_000, timeoutMs);
	const maxOutputChars = readBoundedInteger(env.MOM_CODEX_CLI_MAX_OUTPUT_CHARS, DEFAULT_MAX_OUTPUT_CHARS, 1_024, 64 * 1024 * 1024);
	const maxOutputLines = readBoundedInteger(env.MOM_CODEX_CLI_MAX_OUTPUT_LINES, DEFAULT_MAX_OUTPUT_LINES, 10, 100_000);

	return await new Promise<CodexCliInvocationResult>((resolve) => {
		const child = spawn(command, args, {
			cwd: params.workspaceDir,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let lineBuffer = "";
		let rawChars = 0;
		let rawLines = 0;
		let stderrTail = "";
		let sessionId: string | undefined;
		let responseModel: string | undefined;
		let resultText = "";
		let usage = emptyUsage();
		let errorText: string | undefined;
		let aborted = false;
		let settled = false;
		let completed = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let idleTimer: ReturnType<typeof setTimeout> | undefined;

		const stopProcess = (reason: string, wasAborted = false) => {
			if (settled) return;
			if (!errorText) errorText = reason;
			aborted = aborted || wasAborted;
			if (!child.killed) child.kill("SIGTERM");
			if (!killTimer) killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
		};
		const resetIdleTimer = () => {
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(() => stopProcess(`Codex CLI produced no output for ${idleTimeoutMs}ms`), idleTimeoutMs);
		};
		const hardTimer = setTimeout(() => stopProcess(`Codex CLI exceeded ${timeoutMs}ms`), timeoutMs);
		const abortHandler = () => stopProcess("Codex CLI request was aborted", true);
		params.options?.signal?.addEventListener("abort", abortHandler, { once: true });
		if (params.options?.signal?.aborted) abortHandler();
		resetIdleTimer();

		const consumeLine = (line: string) => {
			if (!line.trim() || errorText) return;
			rawLines += 1;
			if (rawLines > maxOutputLines) {
				stopProcess(`Codex CLI output exceeded ${maxOutputLines} lines`);
				return;
			}
			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(line) as Record<string, unknown>;
			} catch {
				stopProcess("Codex CLI emitted malformed stream-json output");
				return;
			}

			if (parsed.type === "thread.started") sessionId = readString(parsed.thread_id);
			if (parsed.type === "item.completed" && isRecord(parsed.item)
				&& parsed.item.type === "agent_message" && typeof parsed.item.text === "string") {
				params.emitter.append((params.emitter.hasText ? "\n\n" : "") + parsed.item.text);
			}
			if (parsed.type === "turn.completed") {
				completed = true;
				usage = readCodexCliUsage(parsed);
			}
			if (parsed.type === "turn.failed") {
				errorText = isRecord(parsed.error) ? readString(parsed.error.message) : undefined;
				errorText ||= "Codex CLI turn failed";
			}

		};

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			resetIdleTimer();
			const text = chunk;
			rawChars += text.length;
			if (rawChars > maxOutputChars) {
				stopProcess(`Codex CLI output exceeded ${maxOutputChars} characters`);
				return;
			}
			lineBuffer += text;
			let newline = lineBuffer.indexOf("\n");
			while (newline >= 0) {
				consumeLine(lineBuffer.slice(0, newline).replace(/\r$/, ""));
				lineBuffer = lineBuffer.slice(newline + 1);
				newline = lineBuffer.indexOf("\n");
			}
		});
		child.stderr.on("data", (chunk: string) => {
			resetIdleTimer();
			stderrTail = `${stderrTail}${chunk}`.slice(-STDERR_TAIL_CHARS);
		});
		child.on("error", (error) => {
			if (!errorText) errorText = error.message;
		});
		child.on("close", (exitCode) => {
			if (settled) return;
			settled = true;
			if (lineBuffer.trim() && !errorText) consumeLine(lineBuffer);
			clearTimeout(hardTimer);
			if (idleTimer) clearTimeout(idleTimer);
			if (killTimer) clearTimeout(killTimer);
			params.options?.signal?.removeEventListener("abort", abortHandler);
			if (exitCode !== 0 && !errorText) {
				errorText = stderrTail.trim() || resultText.trim() || `Codex CLI exited with code ${exitCode}`;
			}
			if (!completed && !errorText) errorText = "Codex CLI exited before turn.completed";
			resolve({
				exitCode,
				...(sessionId ? { sessionId } : {}),
				...(responseModel ? { responseModel } : {}),
				resultText,
				usage,
				...(errorText ? { errorText } : {}),
				aborted,
			});
		});

		child.stdin.on("error", () => { /* Process exit is reported by close. */ });
		child.stdin.end(params.prompt);
	});
}

export function buildCodexCliArgs(params: {
	modelId: string;
	systemPromptFile: string;
	mcpConfigFile: string;
	sessionId: string;
	resume: boolean;
	reasoning?: string;
	bridge: { command: string; args: string[]; env: Record<string, string>; toolNames: string[] };
}): string[] {
	const args = ["exec", "--json", "--skip-git-repo-check", "--ignore-user-config",
		"-c", 'approval_policy="never"', "-c", 'sandbox_mode="read-only"',
		"-c", "features.shell_tool=false", "-c", "features.browser_use=false", "-c", "features.computer_use=false",
		"-c", "features.apps=false", "-c", 'web_search="disabled"',
		"-c", `developer_instructions=${JSON.stringify(readFileSync(params.systemPromptFile, "utf8"))}`,
		"-c", `mcp_servers.troublemaker.command=${JSON.stringify(params.bridge.command)}`,
		"-c", `mcp_servers.troublemaker.args=${JSON.stringify(params.bridge.args)}`,
		"-c", `mcp_servers.troublemaker.env_vars=${JSON.stringify(Object.keys(params.bridge.env))}`,
		"-c", "mcp_servers.troublemaker.required=true",
		"-c", "mcp_servers.troublemaker.tool_timeout_sec=1800",
	];
	args.push("-c", `mcp_servers.troublemaker.tools={${params.bridge.toolNames.map((name) => `${JSON.stringify(name)}={approval_mode="approve"}`).join(",")}}`);
	if (params.modelId !== "default") args.push("--model", params.modelId);
	const effort = normalizeEffort(params.reasoning);
	if (effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
	if (params.resume) args.push("resume", params.sessionId);
	for (const name of readdirSync(dirname(params.systemPromptFile)).filter((name) => /^image-\d+\./.test(name))) {
		args.push("--image", join(dirname(params.systemPromptFile), name));
	}
	args.push("-");
	return args;
}

function createEmitter(stream: AssistantMessageEventStream, model: Model<Api>): CodexCliEmitter {
	let started = false;
	let textStarted = false;
	let text = "";
	let finished = false;
	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: CODEX_CLI_API,
		provider: CODEX_CLI_PROVIDER,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const snapshot = (): AssistantMessage => ({
		...partial,
		content: partial.content.map((block) => ({ ...block })) as AssistantMessage["content"],
	});
	const ensureStarted = () => {
		if (started) return;
		started = true;
		stream.push({ type: "start", partial: snapshot() });
	};
	return {
		get hasText() {
			return text.length > 0;
		},
		append(delta: string) {
			if (finished || !delta) return;
			ensureStarted();
			if (!textStarted) {
				textStarted = true;
				partial.content.push({ type: "text", text: "" });
				stream.push({ type: "text_start", contentIndex: 0, partial: snapshot() });
			}
			text += delta;
			(partial.content[0] as { type: "text"; text: string }).text = text;
			stream.push({ type: "text_delta", contentIndex: 0, delta, partial: snapshot() });
		},
		finish(result: CodexCliInvocationResult, streamModel: Model<Api>) {
			if (finished) return;
			finished = true;
			if (!text && result.resultText && !result.errorText) {
				ensureStarted();
				textStarted = true;
				text = result.resultText;
				partial.content.push({ type: "text", text });
				stream.push({ type: "text_start", contentIndex: 0, partial: snapshot() });
				stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: snapshot() });
			}
			if (textStarted) {
				stream.push({ type: "text_end", contentIndex: 0, content: text, partial: snapshot() });
			}
			partial.usage = result.usage;
			partial.responseModel = result.responseModel;
			partial.timestamp = Date.now();
			if (result.errorText) {
				partial.stopReason = result.aborted ? "aborted" : "error";
				partial.errorMessage = result.errorText;
				stream.push({ type: "error", reason: partial.stopReason, error: snapshot() });
				return;
			}
			partial.model = streamModel.id;
			partial.stopReason = "stop";
			stream.push({ type: "done", reason: "stop", message: snapshot() });
		},
	};
}

async function buildCodexCliPrompt(context: Context, resume: boolean, tempDir: string): Promise<string> {
	const messages = resume ? messagesAfterLastAssistant(context.messages) : context.messages;
	const rendered: string[] = [];
	let imageIndex = 0;
	for (const message of messages) {
		const body: string[] = [];
		if (message.role === "user") {
			if (typeof message.content === "string") body.push(message.content);
			else {
				for (const block of message.content) {
					if (block.type === "text") body.push(block.text);
					else {
						const extension = extensionForMime(block.mimeType);
						const path = join(tempDir, `image-${imageIndex++}.${extension}`);
						await writeFile(path, Buffer.from(block.data, "base64"), { mode: 0o600 });
						body.push(`Image attachment: @${path}`);
					}
				}
			}
			rendered.push(`User:\n${body.join("\n")}`);
			continue;
		}
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "text") body.push(block.text);
				else if (block.type === "toolCall") body.push(`(tool call: ${block.name})`);
			}
			rendered.push(`Assistant:\n${body.join("\n")}`);
			continue;
		}
		for (const block of message.content) {
			if (block.type === "text") body.push(block.text);
		}
		rendered.push(`Tool result (${message.toolName}):\n${body.join("\n")}`);
	}

	let prompt = rendered.join("\n\n").trim();
	if (!resume && messages.length > 1) {
		prompt = `<conversation_reseed>\n${prompt}\n</conversation_reseed>\n\nContinue from the latest user message.`;
	}
	const maxChars = readBoundedInteger(process.env.MOM_CODEX_CLI_RESEED_CHARS, DEFAULT_RESEED_CHARS, 10_000, 1_000_000);
	if (!resume && prompt.length > maxChars) {
		prompt = `[Earlier conversation omitted by Troublemaker's bounded Codex CLI reseed.]\n\n${prompt.slice(-maxChars)}`;
	}
	return prompt;
}

function messagesAfterLastAssistant(messages: Message[]): Message[] {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.role === "assistant") return messages.slice(index + 1);
	}
	return messages;
}

function canResumeClaudeSession(context: Context): boolean {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message?.role === "assistant") return isCodexCliProvider(message.provider);
	}
	return false;
}

function codexCliSessionPath(workspaceDir: string): string {
	return join(workspaceDir, "awareness", "codex-cli-session.json");
}

function readCodexCliSession(workspaceDir: string): CodexCliSessionState | undefined {
	const path = codexCliSessionPath(workspaceDir);
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CodexCliSessionState>;
		if (parsed.version === 1 && typeof parsed.sessionId === "string" && isUuid(parsed.sessionId)) {
			return { version: 1, sessionId: parsed.sessionId, updatedAt: parsed.updatedAt || "" };
		}
	} catch {
		// Invalid state is cleared below and treated as a fresh CLI session.
	}
	resetCodexCliSession(workspaceDir);
	return undefined;
}

function writeCodexCliSession(workspaceDir: string, sessionId: string): void {
	if (!isUuid(sessionId)) throw new Error("Codex CLI returned an invalid session id");
	const path = codexCliSessionPath(workspaceDir);
	const parent = join(workspaceDir, "awareness");
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	rmSync(tempPath, { force: true });
	try {
		writeFileSync(tempPath, JSON.stringify({ version: 1, sessionId, updatedAt: new Date().toISOString() }) + "\n", {
			encoding: "utf8",
			mode: 0o600,
		});
		renameSync(tempPath, path);
	} finally {
		rmSync(tempPath, { force: true });
	}
}

function readCodexCliUsage(parsed: Record<string, unknown>): Usage {
	const raw = isRecord(parsed.usage) ? parsed.usage : {};
	const cacheRead = readNumber(raw.cached_input_tokens);
	const input = Math.max(0, readNumber(raw.input_tokens) - cacheRead);
	const output = readNumber(raw.output_tokens);
	const cacheWrite = readNumber(raw.cache_creation_input_tokens);
	const totalCost = readNumber(parsed.total_cost_usd);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: totalCost },
	};
}

function readCodexCliError(parsed: Record<string, unknown>): string | undefined {
	return readString(parsed.error) || readString(parsed.result) || readString(parsed.message);
}

function isMissingSessionError(error: string | undefined): boolean {
	return Boolean(error && /(thread|session|conversation).*(not found|missing|does not exist|cannot resume)|no conversation found/i.test(error));
}

function normalizeEffort(value: string | undefined): string | undefined {
	switch (value?.trim().toLowerCase()) {
		case "minimal": return "low";
		case "low": return "low";
		case "medium": return "medium";
		case "high": return "high";
		case "xhigh": return "xhigh";
		case "max": return "xhigh";
		default: return undefined;
	}
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function readBoundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
	const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(min, Math.min(max, parsed));
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function extensionForMime(mimeType: string): string {
	switch (mimeType.toLowerCase()) {
		case "image/jpeg": return "jpg";
		case "image/gif": return "gif";
		case "image/webp": return "webp";
		default: return "png";
	}
}
