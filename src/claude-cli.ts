import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

export const CLAUDE_CLI_PROVIDER = "claude-cli";
export const CLAUDE_CLI_API = "claude-cli";
export const CLAUDE_CLI_MODEL_IDS = ["haiku", "sonnet", "opus", "fable"] as const;

// Pi's AgentSession requires configured request auth before it calls a custom
// stream function. This runtime-only marker satisfies that generic preflight;
// it is not a Claude credential and is never passed to the Claude subprocess.
const CLAUDE_CLI_RUNTIME_AUTH_SENTINEL = "troublemaker-local-claude-cli";

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

type ClaudeCliModelId = (typeof CLAUDE_CLI_MODEL_IDS)[number];

const CLAUDE_CLI_MODELS: Record<ClaudeCliModelId, Model<Api>> = {
	haiku: createClaudeCliModel("haiku", "Claude Code Haiku"),
	sonnet: createClaudeCliModel("sonnet", "Claude Code Sonnet"),
	opus: createClaudeCliModel("opus", "Claude Code Opus"),
	fable: createClaudeCliModel("fable", "Claude Code Fable"),
};

const CLAUDE_CLI_CLEAR_ENV = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_API_KEY_OLD",
	"ANTHROPIC_API_TOKEN",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_CUSTOM_HEADERS",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANTHROPIC_UNIX_SOCKET",
	"CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
	"CLAUDE_CODE_ENTRYPOINT",
	"CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
	"CLAUDE_CODE_OAUTH_SCOPES",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
	"CLAUDE_CODE_REMOTE",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDE_CODE_USE_VERTEX",
] as const;

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_CHARS = 8 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_LINES = 20_000;
const DEFAULT_RESEED_CHARS = 120_000;
const STDERR_TAIL_CHARS = 16_000;

interface ClaudeCliSessionState {
	version: 1;
	sessionId: string;
	updatedAt: string;
}

interface ClaudeCliInvocationResult {
	exitCode: number | null;
	sessionId?: string;
	responseModel?: string;
	resultText: string;
	usage: Usage;
	errorText?: string;
	aborted: boolean;
}

interface ClaudeCliEmitter {
	readonly hasText: boolean;
	append(delta: string): void;
	finish(result: ClaudeCliInvocationResult, model: Model<Api>): void;
}

export interface ClaudeCliStreamOptions {
	tools?: () => AgentTool<any>[];
	onToolEvent?: (event: ClaudeCliRuntimeToolEvent) => void | Promise<void>;
	onToolOutput?: (event: ToolOutputEvent) => void | Promise<void>;
}

let authCache: { key: string; expiresAt: number; authenticated: boolean } | undefined;

function createClaudeCliModel(id: ClaudeCliModelId, name: string): Model<Api> {
	return {
		id,
		name,
		api: CLAUDE_CLI_API,
		provider: CLAUDE_CLI_PROVIDER,
		baseUrl: "claude://local-cli",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	};
}

export function isClaudeCliProvider(provider: string | undefined): boolean {
	return provider?.trim().toLowerCase() === CLAUDE_CLI_PROVIDER;
}

export async function registerClaudeCliRuntimeAuth(authStorage: RuntimeAuthStorage): Promise<void> {
	authStorage.registerProvider?.(CLAUDE_CLI_PROVIDER, {
		name: "Claude Code",
		api: CLAUDE_CLI_API,
		apiKey: CLAUDE_CLI_RUNTIME_AUTH_SENTINEL,
		streamSimple: () => {
			throw new Error("Claude CLI streaming is owned by Troublemaker's local CLI adapter");
		},
		models: listClaudeCliModels().map((model) => ({
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
	await authStorage.setRuntimeApiKey(CLAUDE_CLI_PROVIDER, CLAUDE_CLI_RUNTIME_AUTH_SENTINEL);
}

export function getClaudeCliRuntimeAuth(provider: string | undefined): string | undefined {
	return isClaudeCliProvider(provider) ? CLAUDE_CLI_RUNTIME_AUTH_SENTINEL : undefined;
}

export function getClaudeCliModel(modelId: string): Model<Api> | undefined {
	return CLAUDE_CLI_MODELS[modelId.trim().toLowerCase() as ClaudeCliModelId];
}

export function listClaudeCliModels(): Model<Api>[] {
	return CLAUDE_CLI_MODEL_IDS.map((id) => CLAUDE_CLI_MODELS[id]);
}

export function resolveClaudeCliCommand(env: NodeJS.ProcessEnv = process.env): string {
	return env.MOM_CLAUDE_CLI_PATH?.trim() || "claude";
}

export function buildClaudeCliEnvironment(
	baseEnv: NodeJS.ProcessEnv = process.env,
	contextWindow = 200_000,
): NodeJS.ProcessEnv {
	const env = { ...baseEnv };
	for (const name of CLAUDE_CLI_CLEAR_ENV) delete env[name];
	env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(contextWindow);
	return env;
}

export function resetClaudeCliAuthCache(): void {
	authCache = undefined;
}

/**
 * Claude authentication remains owned by the Claude CLI. Troublemaker only
 * checks the existing service user's profile before advertising CLI models.
 */
export function isClaudeCliAuthenticated(env: NodeJS.ProcessEnv = process.env): boolean {
	const command = resolveClaudeCliCommand(env);
	const cacheMs = readBoundedInteger(env.MOM_CLAUDE_CLI_AUTH_CACHE_MS, 30_000, 0, 5 * 60_000);
	const key = `${command}\0${env.HOME || ""}\0${env.CLAUDE_CONFIG_DIR || ""}`;
	if (authCache?.key === key && authCache.expiresAt > Date.now()) return authCache.authenticated;

	let authenticated = false;
	try {
		const result = spawnSync(command, ["auth", "status"], {
			encoding: "utf8",
			env: buildClaudeCliEnvironment(env),
			timeout: 5_000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		if (result.status === 0 && result.stdout) {
			const parsed = JSON.parse(result.stdout) as { loggedIn?: unknown };
			authenticated = parsed.loggedIn === true;
		}
	} catch {
		authenticated = false;
	}

	authCache = { key, authenticated, expiresAt: Date.now() + cacheMs };
	return authenticated;
}

export function resetClaudeCliSession(workspaceDir: string): void {
	const path = claudeCliSessionPath(workspaceDir);
	try {
		rmSync(path, { force: true });
	} catch {
		// A missing or already-cleared session is equivalent to success.
	}
}

export function createClaudeCliStream(
	workspaceDir: string,
	runtime: ClaudeCliStreamOptions = {},
) {
	return (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream => {
		const stream = createAssistantMessageEventStream();
		const emitter = createEmitter(stream, model);
		void runClaudeCliTurn({ workspaceDir, model, context, options, emitter, runtime }).catch((error) => {
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

async function runClaudeCliTurn(params: {
	workspaceDir: string;
	model: Model<Api>;
	context: Context;
	options?: SimpleStreamOptions;
	emitter: ClaudeCliEmitter;
	runtime: ClaudeCliStreamOptions;
}): Promise<void> {
	if (!isClaudeCliProvider(params.model.provider)) {
		throw new Error(`Claude CLI stream cannot run provider ${params.model.provider}`);
	}
	if (!getClaudeCliModel(params.model.id)) {
		throw new Error(`Unsupported Claude CLI model: ${params.model.id}`);
	}

	const tempDir = await mkdtemp(join(tmpdir(), "troublemaker-claude-cli-"));
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
		await writeFile(mcpConfigFile, JSON.stringify(mcpBridge.config), { encoding: "utf8", mode: 0o600 });

		const sessionState = readClaudeCliSession(params.workspaceDir);
		const resume = Boolean(sessionState && canResumeClaudeSession(params.context));
		const prompt = await buildClaudeCliPrompt(params.context, resume, tempDir);
		let requestedSessionId = resume ? sessionState!.sessionId : randomUUID();
		let result = await invokeClaudeCli({
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
			resetClaudeCliSession(params.workspaceDir);
			requestedSessionId = randomUUID();
			result = await invokeClaudeCli({
				workspaceDir: params.workspaceDir,
				model: params.model,
				options: params.options,
				systemPromptFile,
				mcpConfigFile,
				prompt: await buildClaudeCliPrompt(params.context, false, tempDir),
				sessionId: requestedSessionId,
				resume: false,
				emitter: params.emitter,
			});
		}

		if (!result.errorText && result.exitCode === 0) {
			writeClaudeCliSession(params.workspaceDir, result.sessionId || requestedSessionId);
		} else {
			resetClaudeCliSession(params.workspaceDir);
		}
		params.emitter.finish(result, params.model);
	} finally {
		await mcpBridge?.close().catch(() => {});
		await rm(tempDir, { recursive: true, force: true });
	}
}

async function invokeClaudeCli(params: {
	workspaceDir: string;
	model: Model<Api>;
	options?: SimpleStreamOptions;
	systemPromptFile: string;
	mcpConfigFile: string;
	prompt: string;
	sessionId: string;
	resume: boolean;
	emitter: ClaudeCliEmitter;
}): Promise<ClaudeCliInvocationResult> {
	const env = buildClaudeCliEnvironment(process.env, params.model.contextWindow);
	const command = resolveClaudeCliCommand(env);
	const args = buildClaudeCliArgs({
		modelId: params.model.id,
		systemPromptFile: params.systemPromptFile,
		mcpConfigFile: params.mcpConfigFile,
		sessionId: params.sessionId,
		resume: params.resume,
		reasoning: params.options?.reasoning,
		permissionMode: env.MOM_CLAUDE_CLI_PERMISSION_MODE,
	});
	const timeoutMs = readBoundedInteger(env.MOM_CLAUDE_CLI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1_000, 24 * 60 * 60 * 1000);
	const idleTimeoutMs = readBoundedInteger(env.MOM_CLAUDE_CLI_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS, 1_000, timeoutMs);
	const maxOutputChars = readBoundedInteger(env.MOM_CLAUDE_CLI_MAX_OUTPUT_CHARS, DEFAULT_MAX_OUTPUT_CHARS, 1_024, 64 * 1024 * 1024);
	const maxOutputLines = readBoundedInteger(env.MOM_CLAUDE_CLI_MAX_OUTPUT_LINES, DEFAULT_MAX_OUTPUT_LINES, 10, 100_000);

	return await new Promise<ClaudeCliInvocationResult>((resolve) => {
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
			idleTimer = setTimeout(() => stopProcess(`Claude CLI produced no output for ${idleTimeoutMs}ms`), idleTimeoutMs);
		};
		const hardTimer = setTimeout(() => stopProcess(`Claude CLI exceeded ${timeoutMs}ms`), timeoutMs);
		const abortHandler = () => stopProcess("Claude CLI request was aborted", true);
		params.options?.signal?.addEventListener("abort", abortHandler, { once: true });
		if (params.options?.signal?.aborted) abortHandler();
		resetIdleTimer();

		const consumeLine = (line: string) => {
			if (!line.trim() || errorText) return;
			rawLines += 1;
			if (rawLines > maxOutputLines) {
				stopProcess(`Claude CLI output exceeded ${maxOutputLines} lines`);
				return;
			}
			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(line) as Record<string, unknown>;
			} catch {
				stopProcess("Claude CLI emitted malformed stream-json output");
				return;
			}

			const parsedSessionId = readString(parsed.session_id) || readString(parsed.sessionId);
			if (parsedSessionId) sessionId = parsedSessionId;
			if (parsed.type === "system" && parsed.subtype === "init") {
				responseModel = readString(parsed.model) || responseModel;
				return;
			}
			if (parsed.type === "stream_event" && isRecord(parsed.event)) {
				const event = parsed.event;
				const parentToolUseId = readString(parsed.parent_tool_use_id) || readString(event.parent_tool_use_id);
				if (parentToolUseId) return;
				if (event.type === "content_block_delta" && isRecord(event.delta)) {
					const delta = event.delta;
					if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
						params.emitter.append(delta.text);
					}
				}
				return;
			}
			if (parsed.type === "result") {
				resultText = readString(parsed.result) || resultText;
				usage = readClaudeCliUsage(parsed);
				if (parsed.is_error === true || parsed.subtype === "error" || parsed.status === "error") {
					errorText = readClaudeCliError(parsed) || "Claude CLI reported an error";
				}
			}
		};

		child.stdout.on("data", (chunk: Buffer) => {
			resetIdleTimer();
			const text = chunk.toString("utf8");
			rawChars += text.length;
			if (rawChars > maxOutputChars) {
				stopProcess(`Claude CLI output exceeded ${maxOutputChars} characters`);
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
		child.stderr.on("data", (chunk: Buffer) => {
			resetIdleTimer();
			stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-STDERR_TAIL_CHARS);
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
				errorText = stderrTail.trim() || resultText.trim() || `Claude CLI exited with code ${exitCode}`;
			}
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

		child.stdin.end(params.prompt);
	});
}

export function buildClaudeCliArgs(params: {
	modelId: string;
	systemPromptFile: string;
	mcpConfigFile: string;
	sessionId: string;
	resume: boolean;
	reasoning?: string;
	permissionMode?: string;
}): string[] {
	const args = [
		"-p",
		"--output-format",
		"stream-json",
		"--include-partial-messages",
		"--verbose",
		"--setting-sources",
		"user",
		"--strict-mcp-config",
		"--mcp-config",
		params.mcpConfigFile,
		"--tools",
		"ToolSearch",
		"--allowedTools",
		"ToolSearch,mcp__troublemaker__*",
		"--disallowedTools",
		"SendMessage",
		"--disable-slash-commands",
		"--no-chrome",
		"--model",
		params.modelId,
		"--append-system-prompt-file",
		params.systemPromptFile,
	];
	if (params.resume) args.push("--resume", params.sessionId);
	else args.push("--session-id", params.sessionId);

	const effort = normalizeEffort(params.reasoning);
	if (effort) args.push("--effort", effort);
	const permissionMode = normalizePermissionMode(params.permissionMode);
	if (permissionMode) args.push("--permission-mode", permissionMode);
	return args;
}

function createEmitter(stream: AssistantMessageEventStream, model: Model<Api>): ClaudeCliEmitter {
	let started = false;
	let textStarted = false;
	let text = "";
	let finished = false;
	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: CLAUDE_CLI_API,
		provider: CLAUDE_CLI_PROVIDER,
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
		finish(result: ClaudeCliInvocationResult, streamModel: Model<Api>) {
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

async function buildClaudeCliPrompt(context: Context, resume: boolean, tempDir: string): Promise<string> {
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
	const maxChars = readBoundedInteger(process.env.MOM_CLAUDE_CLI_RESEED_CHARS, DEFAULT_RESEED_CHARS, 10_000, 1_000_000);
	if (!resume && prompt.length > maxChars) {
		prompt = `[Earlier conversation omitted by Troublemaker's bounded Claude CLI reseed.]\n\n${prompt.slice(-maxChars)}`;
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
		if (message?.role === "assistant") return isClaudeCliProvider(message.provider);
	}
	return false;
}

function claudeCliSessionPath(workspaceDir: string): string {
	return join(workspaceDir, "awareness", "claude-cli-session.json");
}

function readClaudeCliSession(workspaceDir: string): ClaudeCliSessionState | undefined {
	const path = claudeCliSessionPath(workspaceDir);
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ClaudeCliSessionState>;
		if (parsed.version === 1 && typeof parsed.sessionId === "string" && isUuid(parsed.sessionId)) {
			return { version: 1, sessionId: parsed.sessionId, updatedAt: parsed.updatedAt || "" };
		}
	} catch {
		// Invalid state is cleared below and treated as a fresh CLI session.
	}
	resetClaudeCliSession(workspaceDir);
	return undefined;
}

function writeClaudeCliSession(workspaceDir: string, sessionId: string): void {
	if (!isUuid(sessionId)) throw new Error("Claude CLI returned an invalid session id");
	const path = claudeCliSessionPath(workspaceDir);
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

function readClaudeCliUsage(parsed: Record<string, unknown>): Usage {
	const raw = isRecord(parsed.usage) ? parsed.usage : {};
	const input = readNumber(raw.input_tokens);
	const output = readNumber(raw.output_tokens);
	const cacheRead = readNumber(raw.cache_read_input_tokens);
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

function readClaudeCliError(parsed: Record<string, unknown>): string | undefined {
	return readString(parsed.error) || readString(parsed.result) || readString(parsed.message);
}

function isMissingSessionError(error: string | undefined): boolean {
	return Boolean(error && /(session|conversation).*(not found|missing|does not exist|cannot resume)|no conversation found/i.test(error));
}

function normalizeEffort(value: string | undefined): string | undefined {
	switch (value?.trim().toLowerCase()) {
		case "minimal": return "low";
		case "low": return "low";
		case "medium": return "medium";
		case "high": return "high";
		case "xhigh": return "xhigh";
		case "max": return "max";
		default: return undefined;
	}
}

function normalizePermissionMode(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	if (!normalized) return undefined;
	const allowed = new Set(["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]);
	if (!allowed.has(normalized)) {
		throw new Error(`Unsupported MOM_CLAUDE_CLI_PERMISSION_MODE: ${normalized}`);
	}
	return normalized;
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
