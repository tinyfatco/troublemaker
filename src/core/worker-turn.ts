import { Agent, type AgentMessage, type AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import { getModel, type Api, type Model } from "@mariozechner/pi-ai";
import type { ToolRouter } from "./routing.js";

export interface WorkerWorkspace {
	exists(path: string): Promise<boolean>;
	readText(path: string): Promise<string | null>;
	writeText(path: string, content: string): Promise<void>;
}

export interface WorkerSessionStore {
	readContext(): Promise<string | null>;
	writeContext(content: string): Promise<void>;
	appendLog?(entry: Record<string, unknown>): Promise<void>;
}

export interface WorkerTurnHost {
	workspace: WorkerWorkspace;
	session: WorkerSessionStore;
	router?: ToolRouter;
	env(name: string): string | undefined;
	now(): Date;
	randomUUID(): string;
}

export interface WorkerTurnInput {
	message: string;
	channelId?: string;
	userName?: string;
	formatInstructions?: string;
}

export interface WorkerTurnEvent {
	type: string;
	[key: string]: unknown;
}

export interface WorkerTurnResult {
	events: WorkerTurnEvent[];
	finalText: string;
	stopReason?: string;
	errorMessage?: string;
	model: {
		provider: string;
		id: string;
	};
}

type SessionHeader = {
	type: "session";
	version: number;
	id: string;
	timestamp: string;
	cwd: string;
};

type SessionEntry = {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: AgentMessage;
};

type FileEntry = SessionHeader | SessionEntry | Record<string, unknown>;

const CURRENT_SESSION_VERSION = 3;
const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL_ID = "claude-sonnet-4-6";

const FIREWORKS_ALIAS_TO_MODEL_ID: Record<string, string> = {
	minimax: "accounts/fireworks/models/minimax-m2p7",
	"minimax-m2p5": "accounts/fireworks/models/minimax-m2p5",
	"minimax-2.5": "accounts/fireworks/models/minimax-m2p5",
	"minimax-m2p7": "accounts/fireworks/models/minimax-m2p7",
	"minimax-2.7": "accounts/fireworks/models/minimax-m2p7",
	kimi: "accounts/fireworks/models/kimi-k2p5",
	"kimi-k2p5": "accounts/fireworks/models/kimi-k2p5",
	glm: "accounts/fireworks/models/glm-5p1",
	glm5: "accounts/fireworks/models/glm-5p1",
	"glm-5": "accounts/fireworks/models/glm-5",
	"glm-5p1": "accounts/fireworks/models/glm-5p1",
	"glm-5.1": "accounts/fireworks/models/glm-5p1",
};

const ANTHROPIC_ALIAS_TO_MODEL_ID: Record<string, string> = {
	opus: "claude-opus-4-6",
	sonnet: "claude-sonnet-4-6",
	haiku: "claude-haiku-4-5-20251001",
};

const OPENAI_ALIAS_TO_MODEL_ID: Record<string, string> = {
	gpt5: "gpt-5.5",
	"gpt-5": "gpt-5.5",
	"gpt-5.5": "gpt-5.5",
};

function parseJsonl(content: string | null): FileEntry[] {
	if (!content?.trim()) return [];
	const entries: FileEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line) as FileEntry);
		} catch {
			// Ignore malformed historical lines; this mirrors pi's tolerant session parsing.
		}
	}
	return entries;
}

function stringifyJsonl(entries: FileEntry[]): string {
	return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

function isSessionHeader(entry: FileEntry): entry is SessionHeader {
	return entry.type === "session";
}

function isMessageEntry(entry: FileEntry): entry is SessionEntry {
	return entry.type === "message" && typeof (entry as { id?: unknown }).id === "string";
}

function getHeader(entries: FileEntry[], host: WorkerTurnHost): SessionHeader {
	const existing = entries.find(isSessionHeader);
	if (existing) return existing;
	return {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: host.randomUUID(),
		timestamp: host.now().toISOString(),
		cwd: "/workspace",
	};
}

function getLeafId(entries: FileEntry[]): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (isMessageEntry(entry)) return entry.id;
	}
	return null;
}

function buildLinearMessages(entries: FileEntry[]): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (const entry of entries) {
		if (isMessageEntry(entry)) messages.push(entry.message);
	}
	return messages;
}

function appendMessages(
	entries: FileEntry[],
	messages: AgentMessage[],
	host: WorkerTurnHost,
	parentId: string | null,
): string | null {
	let leaf = parentId;
	for (const message of messages) {
		const id = host.randomUUID().slice(0, 8);
		entries.push({
			type: "message",
			id,
			parentId: leaf,
			timestamp: new Date(message.timestamp || host.now().getTime()).toISOString(),
			message,
		});
		leaf = id;
	}
	return leaf;
}

async function readWorkspaceContext(workspace: WorkerWorkspace): Promise<string> {
	const contextFiles = ["BOOTSTRAP.md", "AGENTS.md", "IDENTITY.md", "SOUL.md", "USER.md", "MEMORY.md", "BRIEF.md"];
	const sections: string[] = [];
	for (const file of contextFiles) {
		const content = (await workspace.readText(file))?.trim();
		if (content) sections.push(`## ${file}\n${content}`);
	}
	return sections.length > 0 ? sections.join("\n\n") : "No workspace context files found.";
}

function resolveModelId(provider: string, modelId: string): string {
	const key = modelId.toLowerCase().trim();
	if (provider === "fireworks") return FIREWORKS_ALIAS_TO_MODEL_ID[key] || modelId;
	if (provider === "anthropic") return ANTHROPIC_ALIAS_TO_MODEL_ID[key] || modelId;
	if (provider === "openai") return OPENAI_ALIAS_TO_MODEL_ID[key] || modelId;
	return modelId;
}

async function readSettingsModel(workspace: WorkerWorkspace): Promise<{ provider?: string; modelId?: string }> {
	const raw = await workspace.readText("settings.json");
	if (!raw) return {};
	try {
		const settings = JSON.parse(raw) as {
			defaultProvider?: string;
			defaultModel?: string;
			model_provider?: string;
			model_id?: string;
		};
		return {
			provider: settings.defaultProvider || settings.model_provider,
			modelId: settings.defaultModel || settings.model_id,
		};
	} catch {
		return {};
	}
}

async function resolveWorkerModel(host: WorkerTurnHost): Promise<Model<Api>> {
	const settings = await readSettingsModel(host.workspace);
	const provider = (host.env("MOM_MODEL_PROVIDER") || settings.provider || DEFAULT_PROVIDER).trim();
	const rawModelId = (host.env("MOM_MODEL_ID") || settings.modelId || DEFAULT_MODEL_ID).trim();
	const modelId = resolveModelId(provider, rawModelId);
	const model = getModel(provider as never, modelId as never) as Model<Api> | undefined;
	if (!model) {
		const fallback = getModel(DEFAULT_PROVIDER as never, DEFAULT_MODEL_ID as never) as Model<Api> | undefined;
		if (!fallback) throw new Error(`Model not found: ${provider}/${modelId}`);
		return fallback;
	}
	const baseUrl = host.env(`${provider.toUpperCase().replace(/-/g, "_")}_BASE_URL`);
	return baseUrl ? { ...model, baseUrl } : model;
}

function getApiKey(host: WorkerTurnHost, provider: string): string | undefined {
	const normalized = provider.toLowerCase();
	const direct = host.env(`${normalized.toUpperCase().replace(/-/g, "_")}_API_KEY`);
	if (direct) return direct;
	if (normalized === "anthropic") return host.env("ANTHROPIC_API_KEY");
	if (normalized === "fireworks") return host.env("FIREWORKS_API_KEY");
	if (normalized === "openai") return host.env("OPENAI_API_KEY");
	if (normalized === "openai-codex") return host.env("OPENAI_CODEX_API_KEY") || host.env("OPENAI_API_KEY");
	return undefined;
}

function createSystemPrompt(workspaceContext: string, formatInstructions?: string): string {
	return `## Context
You are Troublemaker running inside Crawdad CF's Worker/Durable Object runtime.
Use the provided tools for workspace file reads and edits. You are not in a Linux container unless a tool explicitly says so.

${formatInstructions || "Use concise Markdown for web chat."}

## Runtime
- Canonical workspace state is encrypted R2 exposed through the host workspace API.
- Shell/container execution is not the default path in this Worker-owned web turn.
- If you need real Linux, package managers, native binaries, long-running servers, browser/desktop, or PTY access, say exactly what container-backed action is needed.

## Workspace Context
${workspaceContext}`;
}

function normalizePath(path: string): string {
	if (path.includes("\0")) throw new Error("Invalid path");
	const parts = path.split("/").filter(Boolean);
	for (const part of parts) {
		if (part === "." || part === "..") throw new Error("Invalid path");
	}
	return parts.join("/");
}

function createPortableTools(host: WorkerTurnHost): AgentTool<any>[] {
	const readSchema = Type.Object({
		label: Type.String({ description: "Brief description of what you're reading and why" }),
		path: Type.String({ description: "Workspace-relative path to read" }),
	});
	const writeSchema = Type.Object({
		label: Type.String({ description: "Brief description of what you're writing" }),
		path: Type.String({ description: "Workspace-relative path to write" }),
		content: Type.String({ description: "Content to write" }),
	});
	const editSchema = Type.Object({
		label: Type.String({ description: "Brief description of the edit" }),
		path: Type.String({ description: "Workspace-relative path to edit" }),
		oldText: Type.String({ description: "Exact text to replace" }),
		newText: Type.String({ description: "Replacement text" }),
	});
	const bashSchema = Type.Object({
		label: Type.String({ description: "Brief description of what this command does" }),
		command: Type.String({ description: "Shell command requested" }),
	});

	return [
		{
			name: "read",
			label: "read",
			description: "Read a text file from the encrypted workspace.",
			parameters: readSchema,
			execute: async (_id: string, params: unknown) => {
				const { path } = params as { path: string };
				const normalized = normalizePath(path);
				const text = await host.workspace.readText(normalized);
				if (text === null) throw new Error(`File not found: ${normalized}`);
				return { content: [{ type: "text", text }], details: undefined };
			},
		},
		{
			name: "write",
			label: "write",
			description: "Write a text file to the encrypted workspace.",
			parameters: writeSchema,
			execute: async (_id: string, params: unknown) => {
				const { path, content } = params as { path: string; content: string };
				const normalized = normalizePath(path);
				await host.workspace.writeText(normalized, content);
				return { content: [{ type: "text", text: `Wrote ${content.length} bytes to ${normalized}` }], details: undefined };
			},
		},
		{
			name: "edit",
			label: "edit",
			description: "Edit a text file by replacing exact text in the encrypted workspace.",
			parameters: editSchema,
			execute: async (_id: string, params: unknown) => {
				const { path, oldText, newText } = params as { path: string; oldText: string; newText: string };
				const normalized = normalizePath(path);
				const text = await host.workspace.readText(normalized);
				if (text === null) throw new Error(`File not found: ${normalized}`);
				const count = text.split(oldText).length - 1;
				if (count === 0) throw new Error(`Could not find exact text in ${normalized}`);
				if (count > 1) throw new Error(`Found ${count} occurrences in ${normalized}; oldText must be unique`);
				const next = text.replace(oldText, newText);
				await host.workspace.writeText(normalized, next);
				return { content: [{ type: "text", text: `Edited ${normalized}` }], details: undefined };
			},
		},
		{
			name: "bash",
			label: "bash",
			description: "Request shell execution. The Worker host decides whether this can run without a container.",
			parameters: bashSchema,
			execute: async (_id: string, params: unknown) => {
				const { command } = params as { command: string };
				const decision = await host.router?.routeTool({ tool: "bash", args: { command } });
				const hostName = decision?.host || "container";
				if (hostName !== "worker-shell") {
					throw new Error(
						`Container-backed execution required: ${decision?.reason || "shell command is not available in this Worker turn"}`,
					);
				}
				throw new Error("Worker-shell execution is not enabled in this runtime yet.");
			},
		},
	];
}

export async function runWorkerTurn(host: WorkerTurnHost, input: WorkerTurnInput): Promise<WorkerTurnResult> {
	const rawContext = await host.session.readContext();
	const entries = parseJsonl(rawContext);
	const header = getHeader(entries, host);
	if (!entries.includes(header)) entries.unshift(header);
	const parentId = getLeafId(entries);
	const initialMessages = buildLinearMessages(entries);
	const workspaceContext = await readWorkspaceContext(host.workspace);
	const model = await resolveWorkerModel(host);
	const events: WorkerTurnEvent[] = [];

	const agent = new Agent({
		initialState: {
			systemPrompt: createSystemPrompt(workspaceContext, input.formatInstructions),
			model,
			tools: createPortableTools(host),
			messages: initialMessages,
		},
		getApiKey: async (provider: string) => getApiKey(host, provider),
	});

	agent.subscribe((event: any) => {
		if (event.type === "message_update") {
			const update = event.assistantMessageEvent;
			if (update?.type === "text_delta") events.push({ type: "text_delta", delta: update.delta });
			if (update?.type === "thinking_delta") events.push({ type: "thinking_delta", delta: update.delta });
		} else if (event.type === "tool_execution_start") {
			events.push({ type: "toolCall", id: event.toolCallId, name: event.toolName, arguments: event.args || {} });
		} else if (event.type === "tool_execution_end") {
			events.push({
				type: "toolResult",
				toolCallId: event.toolCallId,
				name: event.toolName,
				result: typeof event.result === "string" ? event.result : JSON.stringify(event.result),
				isError: event.isError || false,
			});
		}
	});

	await host.session.appendLog?.({
		date: host.now().toISOString(),
		ts: String(host.now().getTime()),
		channel: `web:${input.channelId || "web"}`,
		channelId: input.channelId || "web",
		user: "web-user",
		userName: input.userName || "user",
		text: input.message,
		attachments: [],
		isBot: false,
	});

	const userMessage = `[${host.now().toISOString()}] [web:${input.channelId || "web"}] [${input.userName || "user"}]: ${input.message}`;
	await agent.prompt(userMessage);
	await agent.waitForIdle();

	const newMessages = agent.state.messages.slice(initialMessages.length);
	appendMessages(entries, newMessages, host, parentId);
	await host.session.writeContext(stringifyJsonl(entries));

	const assistantMessages = agent.state.messages.filter((message) => message.role === "assistant") as any[];
	const lastAssistant = assistantMessages[assistantMessages.length - 1];
	const finalText =
		lastAssistant?.content
			?.filter((part: any) => part.type === "text")
			.map((part: any) => part.text)
			.join("\n") || "";

	if (finalText) {
		await host.session.appendLog?.({
			date: host.now().toISOString(),
			ts: String(host.now().getTime()),
			channel: `web:${input.channelId || "web"}`,
			channelId: input.channelId || "web",
			user: "bot",
			text: finalText,
			attachments: [],
			isBot: true,
		});
		events.push({ type: "text", text: finalText });
	}

	return {
		events,
		finalText,
		stopReason: lastAssistant?.stopReason,
		errorMessage: lastAssistant?.errorMessage,
		model: {
			provider: model.provider,
			id: model.id,
		},
	};
}
