import { Agent, type AgentEvent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import {
	AgentSession,
	AuthStorage,
	convertToLlm,
	DefaultResourceLoader,
	getAgentDir,
	loadSkillsFromDir,
	ModelRegistry,
	SessionManager,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "crypto";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { copyFile, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import type { MomContext, RunResult } from "./adapters/types.js";
import { MomSettingsManager } from "./context.js";
import {
	buildSessionPreamble,
	buildSystemPrompt,
	getWorkspaceContext,
	getWorkspaceSkillsMtime,
	resolveThinkingLevel,
} from "./core/prompt.js";
import * as log from "./log.js";
import { resolveModelWithAuth, resolveApiKey } from "./model-config.js";
import { normalizeSimpleStreamOptionsForModel, normalizeThinkingLevelForModel } from "./model-thinking.js";
import { createExecutor, type SandboxConfig } from "./sandbox.js";
import { FilesystemWorkspaceStore } from "./storage/node/filesystem-workspace.js";
import { LiveAssistantSnapshot } from "./streaming/live-turn-snapshot.js";
import { shouldRolloverWorkingAfterToolCompletion } from "./streaming/working-rollover.js";
import { registerToolDisplayBarrier } from "./streaming/tool-delivery-barrier.js";
import type { ChannelStore } from "./store.js";
import { sanitizeMessages } from "./sanitize.js";
import { createMomTools, setUploadFunction } from "./tools/index.js";
import { createSearchToolsTool, type ToolSearchRegistry } from "./tools/search-tools.js";
import { withToolOutputStream } from "./tools/tool-output-stream.js";
import { isYieldNoActionToolName, wasYielded, resetYield } from "./tools/yield-no-action.js";
import { detectPlanningOnlyTurn, resolveAckFastPath } from "./gpt-steering.js";
import tinyfatDomainsExtension from "./extensions/tinyfat-domains.js";

export interface PendingMessage {
	userName: string;
	text: string;
	attachments: { local: string }[];
	timestamp: number;
}

export interface ContextInfo {
	model: string;
	provider: string;
	contextWindow: number;
	messageCount: number;
	contextTokens: number;
	contextPercent: number;
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	};
}

export interface CompactResult {
	messagesBefore: number;
	messagesAfter: number;
	tokensBefore: number;
}

export interface AgentRunner {
	run(
		ctx: MomContext,
		store: ChannelStore,
		pendingMessages?: PendingMessage[],
	): Promise<RunResult>;
	abort(): void;
	/** Steer a message into the active run (mid-run injection via pi-agent) */
	steer(text: string): void;
	/** Get current context diagnostics */
	getContextInfo(): ContextInfo;
	/** Compact context — summarize old messages, keep recent */
	compact(instructions?: string): Promise<CompactResult>;
	/** Clear context entirely — archive and start fresh */
	clear(): Promise<{ messagesCleared: number; quarantined?: string }>;
	/** Called on every substantive event (tool call, LLM token, etc.) during a run */
	onActivity?: () => void;
}


const IMAGE_MIME_TYPES: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
};

function getImageMimeType(filename: string): string | undefined {
	return IMAGE_MIME_TYPES[filename.toLowerCase().split(".").pop() || ""];
}

type StreamingToolCall = {
	type: "toolCall";
	id: string;
	name: string;
	label?: string;
	arguments: Record<string, unknown>;
	contentIndex?: number;
};

function normalizeStreamingToolCall(raw: unknown, contentIndex?: number): StreamingToolCall | null {
	if (!raw || typeof raw !== "object") return null;
	const toolCall = raw as Record<string, unknown>;
	if (toolCall.type !== "toolCall") return null;
	const args = toolCall.arguments;
	const normalizedArgs = args && typeof args === "object" && !Array.isArray(args)
		? args as Record<string, unknown>
		: {};
	const label = cleanToolCallLabel(toolCall.label) || cleanToolCallLabel(normalizedArgs.label);
	return {
		type: "toolCall",
		id: typeof toolCall.id === "string" ? toolCall.id : "",
		name: typeof toolCall.name === "string" ? toolCall.name : "tool",
		...(label ? { label } : {}),
		arguments: normalizedArgs,
		...(typeof contentIndex === "number" ? { contentIndex } : {}),
	};
}

function normalizeStreamingToolCalls(event: Record<string, unknown>): StreamingToolCall[] {
	const calls: StreamingToolCall[] = [];
	const seen = new Set<string>();
	const add = (raw: unknown, contentIndex?: number) => {
		const call = normalizeStreamingToolCall(raw, contentIndex);
		if (!call) return;
		const key = call.id ? `id:${call.id}` : `index:${call.contentIndex ?? calls.length}`;
		if (seen.has(key)) return;
		seen.add(key);
		calls.push(call);
	};

	if (Array.isArray(event.toolCalls)) {
		event.toolCalls.forEach((raw, index) => add(raw, typeof (raw as { contentIndex?: unknown })?.contentIndex === "number"
			? (raw as { contentIndex: number }).contentIndex
			: index));
	}
	add(event.toolCall, typeof event.contentIndex === "number" ? event.contentIndex : undefined);

	const partial = event.partial as { content?: unknown } | undefined;
	if (Array.isArray(partial?.content)) {
		partial.content.forEach((raw, index) => add(raw, index));
	}

	return calls;
}

function cleanToolCallLabel(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function partialText(event: Record<string, unknown>): string | undefined {
	if (typeof event.content === "string") return event.content;
	const partial = event.partial as { content?: unknown } | undefined;
	const contentIndex = event.contentIndex;
	if (!Array.isArray(partial?.content) || typeof contentIndex !== "number") return undefined;
	const block = partial.content[contentIndex] as Record<string, unknown> | undefined;
	return block?.type === "text" && typeof block.text === "string" ? block.text : undefined;
}

function partialThinking(event: Record<string, unknown>): string | undefined {
	if (typeof event.content === "string") return event.content;
	const partial = event.partial as { content?: unknown } | undefined;
	const contentIndex = event.contentIndex;
	if (!Array.isArray(partial?.content) || typeof contentIndex !== "number") return undefined;
	const block = partial.content[contentIndex] as Record<string, unknown> | undefined;
	return block?.type === "thinking" && typeof block.thinking === "string" ? block.thinking : undefined;
}

// Skills cache — skills rarely change, no need to re-scan R2/FUSE on every message
const skillsCache = new Map<string, { skills: Skill[]; workspaceMtime: number }>();

function loadMomSkills(awarenessDir: string, workspacePath: string, extraSkillsDirs: string[] = []): Skill[] {
	const hostWorkspacePath = join(awarenessDir, "..");
	const workspaceSkillsDir = join(hostWorkspacePath, "skills");
	const workspaceStore = new FilesystemWorkspaceStore(hostWorkspacePath);

	// Check cache — invalidate only if workspace skills dir mtime changed
	const cached = skillsCache.get(awarenessDir);
	if (cached) {
		const currentMtime = getWorkspaceSkillsMtime(workspaceStore);
		if (currentMtime === cached.workspaceMtime) {
			return cached.skills;
		}
		log.logInfo(`[skills] Workspace skills changed, reloading`);
	}

	const skillMap = new Map<string, Skill>();

	// Helper to translate host paths to container paths
	const translatePath = (hostPath: string): string => {
		if (hostPath.startsWith(hostWorkspacePath)) {
			return workspacePath + hostPath.slice(hostWorkspacePath.length);
		}
		return hostPath;
	};

	// Load extra skills dirs first (lowest priority — e.g. platform skills via --skills)
	for (const dir of extraSkillsDirs) {
		for (const skill of loadSkillsFromDir({ dir, source: "system" }).skills) {
			skillMap.set(skill.name, skill);
		}
	}

	// Load workspace-level skills (global) — overrides system skills on collision
	for (const skill of loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" }).skills) {
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	const skills = Array.from(skillMap.values());
	skillsCache.set(awarenessDir, { skills, workspaceMtime: getWorkspaceSkillsMtime(workspaceStore) });
	return skills;
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.substring(0, maxLen - 3)}...`;
}

function extractToolResultText(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}

	if (
		result &&
		typeof result === "object" &&
		"content" in result &&
		Array.isArray((result as { content: unknown }).content)
	) {
		const content = (result as { content: Array<{ type: string; text?: string }> }).content;
		const textParts: string[] = [];
		for (const part of content) {
			if (part.type === "text" && part.text) {
				textParts.push(part.text);
			}
		}
		if (textParts.length > 0) {
			return textParts.join("\n");
		}
	}

	return JSON.stringify(result);
}

function formatToolArgs(_toolName: string, args: Record<string, unknown>): string {
	const lines: string[] = [];

	for (const [key, value] of Object.entries(args)) {
		if (key === "label") continue;

		if (key === "path" && typeof value === "string") {
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined && limit !== undefined) {
				lines.push(`${value}:${offset}-${offset + limit}`);
			} else {
				lines.push(value);
			}
			continue;
		}

		if (key === "offset" || key === "limit") continue;

		if (typeof value === "string") {
			lines.push(value);
		} else {
			lines.push(JSON.stringify(value));
		}
	}

	return lines.join("\n");
}

// Cache runners per awareness dir
const runners = new Map<string, AgentRunner>();

function parseExtensionPaths(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(/[\n,:]/)
		.map((entry) => entry.trim())
		.filter(Boolean);
}

/**
 * Get or create an AgentRunner for the unified awareness.
 * One runner per agent process — persistent across messages.
 */
export function getOrCreateRunner(
	sandboxConfig: SandboxConfig,
	awarenessDir: string,
	formatInstructions: string,
	extraSkillsDirs: string[] = [],
	extraTools: AgentTool<any>[] = [],
): AgentRunner {
	const existing = runners.get(awarenessDir);
	if (existing) return existing;

	const runner = createRunner(sandboxConfig, awarenessDir, formatInstructions, extraSkillsDirs, extraTools);
	runners.set(awarenessDir, runner);
	return runner;
}

/**
 * Create a new AgentRunner for the unified awareness.
 */
function createRunner(
	sandboxConfig: SandboxConfig,
	awarenessDir: string,
	formatInstructions: string,
	extraSkillsDirs: string[] = [],
	extraTools: AgentTool<any>[] = [],
): AgentRunner {
	const t0 = performance.now();
	const executor = createExecutor(sandboxConfig);
	const workspacePath = executor.getWorkspacePath(join(awarenessDir, ".."));

	const workspaceDir = join(awarenessDir, "..");

	const toolSearchRegistry: { current: ToolSearchRegistry | null } = { current: null };

	// Create tools (core + extras like send_message). Extension/custom tools are
	// loaded into the session registry and activated through search_tools.
	const tools = [
		...createMomTools(executor, workspaceDir),
		...extraTools,
		createSearchToolsTool(() => toolSearchRegistry.current),
	];

	// Minimal system prompt for agent creation — will be replaced with full prompt in run()
	const systemPrompt = "Initializing...";

	// Create session manager and settings manager
	const contextFile = join(awarenessDir, "context.jsonl");
	const workspaceStore = new FilesystemWorkspaceStore(workspaceDir);
	const settingsManager = new MomSettingsManager(workspaceDir);

	// Create AuthStorage and ModelRegistry
	const authStorage = AuthStorage.create();
	const modelRegistry = ModelRegistry.create(authStorage, join(workspaceDir, "models.json"));

	// Resolve model: env vars > settings.json > defaults
	const model = resolveModelWithAuth(workspaceDir, modelRegistry);

	// FAT-275: read thinking_level from settings.json and clamp it to the
	// selected provider/model's supported runtime shape.
	const requestedInitialThinkingLevel = resolveThinkingLevel(workspaceStore);
	const initialThinkingLevel = normalizeThinkingLevelForModel(model, requestedInitialThinkingLevel);
	if (initialThinkingLevel !== requestedInitialThinkingLevel) {
		log.logInfo(`[thinking] Effective thinking ${requestedInitialThinkingLevel} -> ${initialThinkingLevel} for ${model.provider}/${model.id}`);
	}
	const streamFn: StreamFn = (streamModel, context, options) =>
		streamSimple(streamModel, context, normalizeSimpleStreamOptionsForModel(streamModel, options));

	// Create agent
	const agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			thinkingLevel: initialThinkingLevel,
			tools,
		},
		convertToLlm,
		streamFn,
		getApiKey: async (provider: string) => resolveApiKey(authStorage, provider),
	});

	// Defer context loading to run()
	let sessionManager: SessionManager | null = null;
	const getSessionManager = () => {
		if (!sessionManager) {
			const t = performance.now();
			sessionManager = SessionManager.open(contextFile, awarenessDir);
			log.logInfo(`[perf] SessionManager.open: ${(performance.now() - t).toFixed(0)}ms`);
		}
		return sessionManager;
	};

	log.logInfo(`[perf] createRunner (no R2 reads): ${(performance.now() - t0).toFixed(0)}ms`);

	const resourceLoader = new DefaultResourceLoader({
		cwd: workspaceDir,
		agentDir: process.env.PI_AGENT_DIR || getAgentDir(),
		additionalExtensionPaths: parseExtensionPaths(process.env.TROUBLEMAKER_EXTENSION_PATHS),
		extensionFactories: [tinyfatDomainsExtension],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt,
	});

	const baseToolsOverride = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

	// FAT-279 — wrap settingsManager so getCompactionSettings() derives
	// reserveTokens fresh from the current model's contextWindow and the
	// configured thresholdPercent. A single percentage knob works across
	// models with different window sizes (MiniMax 197k, Anthropic 200k, etc).
	const compactionSettingsProxy = new Proxy(settingsManager, {
		get(target, prop, receiver) {
			if (prop === "getCompactionSettings") {
				return () => {
					const base = target.getCompactionSettings();
					const currentModel = agent.state.model;
					const contextWindow = currentModel?.contextWindow ?? 0;
					if (contextWindow > 0 && base.thresholdPercent > 0 && base.thresholdPercent < 1) {
						const derived = Math.floor(contextWindow * (1 - base.thresholdPercent));
						return { ...base, reserveTokens: derived };
					}
					return base;
				};
			}
			return Reflect.get(target, prop, receiver);
		},
	});

	// Session created lazily on first run
	let session: AgentSession | null = null;
	let unsubscribeSession: (() => void) | null = null;
	let resourceLoaderReady = false;
	const getSession = async () => {
		if (!session) {
			if (!resourceLoaderReady) {
				const t = performance.now();
				await resourceLoader.reload();
				resourceLoaderReady = true;
				const extensions = resourceLoader.getExtensions();
				for (const error of extensions.errors) {
					log.logWarning(`[extensions] ${error.path}: ${error.error}`);
				}
				log.logInfo(`[perf] resourceLoader.reload (${extensions.extensions.length} extensions): ${(performance.now() - t).toFixed(0)}ms`);
			}
			session = new AgentSession({
				agent,
				sessionManager: getSessionManager(),
				settingsManager: compactionSettingsProxy as any,
				cwd: process.cwd(),
				modelRegistry,
				resourceLoader,
				baseToolsOverride,
			});
			toolSearchRegistry.current = {
				getAllTools: () => session?.getAllTools() ?? [],
				getActiveToolNames: () => session?.getActiveToolNames() ?? [],
				setActiveToolsByName: (toolNames) => {
					if (!session) return;
					const currentSystemPrompt = session.agent.state.systemPrompt;
					session.setActiveToolsByName(toolNames);
					session.agent.state.systemPrompt = currentSystemPrompt;
				},
			};
			session.setActiveToolsByName(tools.map((tool) => tool.name));
			unsubscribeSession = session.subscribe(eventHandler);
		}
		return session;
	};

	const resetSessionState = () => {
		unsubscribeSession?.();
		unsubscribeSession = null;
		session?.dispose();
		session = null;
		toolSearchRegistry.current = null;
		sessionManager = null;
		resourceLoaderReady = false;
		agent.state.messages = [];
	};

	const resetContextFile = async (label: string): Promise<{ messagesCleared: number; quarantined?: string }> => {
		let messagesCleared = 0;
		try {
			const restored = getSessionManager().buildSessionContext();
			messagesCleared = restored.messages.length;
		} catch (err) {
			log.logWarning(`[awareness] ${label}: could not read context before reset (continuing): ${err instanceof Error ? err.message : String(err)}`);
		}

		let quarantined: string | undefined;
		try {
			await archiveContext(contextFile);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.logWarning(`[awareness] ${label}: archive failed (${msg}) — quarantining broken file`);
			try {
				if (existsSync(contextFile)) {
					const ts = new Date().toISOString().replace(/[:.]/g, "-");
					const broken = `${contextFile}.broken-${ts}`;
					renameSync(contextFile, broken);
					quarantined = broken;
					log.logInfo(`[awareness] ${label}: quarantined corrupt context to ${broken}`);
				}
			} catch (qerr) {
				log.logWarning(`[awareness] ${label}: quarantine also failed (continuing): ${qerr instanceof Error ? qerr.message : String(qerr)}`);
			}
		}

		try {
			writeFileSync(contextFile, "", "utf-8");
		} catch (err) {
			log.logWarning(`[awareness] ${label}: truncate failed (${err instanceof Error ? err.message : String(err)})`);
			throw err;
		}
		resetSessionState();
		log.logInfo(`[awareness] ${label}: context reset (${messagesCleared} messages archived)`);
		return { messagesCleared, ...(quarantined ? { quarantined } : {}) };
	};

	// Mutable per-run state
	const runState = {
		ctx: null as MomContext | null,
		logCtx: null as { channelId: string; userName?: string; channelName?: string } | null,
		queue: null as {
			enqueue(fn: () => Promise<void>, errorContext: string): Promise<void>;
			enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog?: boolean): void;
		} | null,
		pendingTools: new Map<string, { toolName: string; args: unknown; startTime: number; label: string; show: boolean }>(),
		toolsUsed: [] as string[],
		totalUsage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		errorMessage: undefined as string | undefined,
		initialPromptSent: false,
		liveSnapshot: new LiveAssistantSnapshot(),
	};

	// Activity callback for external watchdog
	let onActivity: (() => void) | undefined;

	// Event handler
	let _eventSeq = 0;
	const eventHandler = async (event: any) => {
		if (!runState.ctx || !runState.logCtx || !runState.queue) return;

		_eventSeq++;
		if (event.type === "tool_execution_start" || event.type === "message_start" || event.type === "message_end") {
			log.logInfo(`[debug] eventHandler seq=${_eventSeq} type=${event.type} id=${event.toolCallId || event.message?.role || "?"}`);
		}

		// Signal activity on any substantive event
		onActivity?.();

		const { ctx, logCtx, queue, pendingTools } = runState;
		const emitSnapshot = (isStreaming = true) => {
			const entry = runState.liveSnapshot.current(isStreaming);
			if (entry) ctx.emitContentBlock?.({ type: "assistant_snapshot", entry });
		};

		if (event.type === "tool_execution_start") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_start" };
			const silentChannelTool = isYieldNoActionToolName(agentEvent.toolName);
			const args = agentEvent.args && typeof agentEvent.args === "object"
				? agentEvent.args as Record<string, unknown>
				: {};
			const label = cleanToolCallLabel(args.label) || agentEvent.toolName;
			const show = args.show === true || agentEvent.toolName === "send_message";

			pendingTools.set(agentEvent.toolCallId, {
				toolName: agentEvent.toolName,
				args: agentEvent.args,
				startTime: Date.now(),
				label,
				show,
			});
			runState.toolsUsed.push(agentEvent.toolName);

			log.logToolStart(logCtx, agentEvent.toolName, label, agentEvent.args as Record<string, unknown>);
			runState.liveSnapshot.upsertToolCall(
				agentEvent.toolCallId,
				agentEvent.toolName,
				args,
				label,
			);
			emitSnapshot(true);
			ctx.emitContentBlock?.({ type: "toolCall", id: agentEvent.toolCallId, name: agentEvent.toolName, label, arguments: args });
			if (!silentChannelTool) {
				const displayBarrier = queue.enqueue(
					() => ctx.updateToolProgress
						? ctx.updateToolProgress({ id: agentEvent.toolCallId, label, status: "in_progress", show })
						: ctx.respond(`_→ ${label}_`, false, { show }),
					"tool label",
				);
				registerToolDisplayBarrier(agentEvent.toolCallId, displayBarrier);
			}
		} else if (event.type === "tool_execution_end") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_end" };
			const resultStr = extractToolResultText(agentEvent.result);
			const pending = pendingTools.get(agentEvent.toolCallId);
			pendingTools.delete(agentEvent.toolCallId);

			const durationMs = pending ? Date.now() - pending.startTime : 0;

			if (agentEvent.isError) {
				log.logToolError(logCtx, agentEvent.toolName, durationMs, resultStr);
			} else {
				log.logToolSuccess(logCtx, agentEvent.toolName, durationMs, resultStr);
			}

			const label = pending?.label;
			const argsFormatted = pending
				? formatToolArgs(agentEvent.toolName, pending.args as Record<string, unknown>)
				: "(args not found)";
			const duration = (durationMs / 1000).toFixed(1);
			let threadMessage = `*${agentEvent.isError ? "✗" : "✓"} ${agentEvent.toolName}*`;
			if (label && label !== agentEvent.toolName) threadMessage += `: ${label}`;
			threadMessage += ` (${duration}s)\n`;
			if (argsFormatted) threadMessage += `\`\`\`\n${argsFormatted}\n\`\`\`\n`;
			threadMessage += `*Result:*\n\`\`\`\n${resultStr}\n\`\`\``;

			runState.liveSnapshot.upsertToolResult(agentEvent.toolCallId, resultStr, agentEvent.isError || false);
			emitSnapshot(true);
			ctx.emitContentBlock?.({ type: "toolResult", toolCallId: agentEvent.toolCallId, result: resultStr, isError: agentEvent.isError || false });
			if (!isYieldNoActionToolName(agentEvent.toolName)) {
				if (ctx.updateToolProgress && pending) {
					queue.enqueue(
						() => ctx.updateToolProgress!({
							id: agentEvent.toolCallId,
							label: pending.label,
							status: agentEvent.isError ? "error" : "complete",
							show: pending.show,
						}),
						"tool progress completion",
					);
				}
				queue.enqueueMessage(threadMessage, "thread", "tool result thread", false);
			}

			if (agentEvent.isError) {
				queue.enqueue(() => ctx.respond(`_Error: ${truncate(resultStr, 200)}_`, false), "tool error");
			}

			if (shouldRolloverWorkingAfterToolCompletion({
				toolName: agentEvent.toolName,
				isError: agentEvent.isError || false,
				args: pending?.args,
				result: agentEvent.result,
				activeReplyTarget: ctx.message.replyTarget,
			})) {
				queue.enqueue(() => ctx.restartWorking(), "restart working after inline send");
			}
		} else if (event.type === "message_update") {
			const agentEvent = event as AgentEvent & { type: "message_update" };
			runState.liveSnapshot.updateAssistantMessage(agentEvent.message);
			emitSnapshot(true);
		} else if (event.type === "message_start") {
			const agentEvent = event as AgentEvent & { type: "message_start" };
			if (agentEvent.message.role === "assistant") {
				log.logResponseStart(logCtx);
				runState.liveSnapshot.beginAssistantMessage(agentEvent.message);
				emitSnapshot(true);
			} else if (agentEvent.message.role === "user") {
				if (runState.initialPromptSent) {
					log.logInfo(`[awareness] Steered message detected, restarting working message`);
					queue.enqueue(async () => {
						await ctx.restartWorking();
					}, "restart working for steer");
				} else {
					runState.initialPromptSent = true;
				}
			}
		} else if (event.type === "message_end") {
			const agentEvent = event as AgentEvent & { type: "message_end" };
			if (agentEvent.message.role === "assistant") {
				runState.liveSnapshot.endAssistantMessage(agentEvent.message);
				emitSnapshot(false);
				const assistantMsg = agentEvent.message as any;

				if (assistantMsg.stopReason) {
					runState.stopReason = assistantMsg.stopReason;
				}
				if (assistantMsg.errorMessage) {
					runState.errorMessage = assistantMsg.errorMessage;
				}

				if (assistantMsg.usage) {
					runState.totalUsage.input += assistantMsg.usage.input;
					runState.totalUsage.output += assistantMsg.usage.output;
					runState.totalUsage.cacheRead += assistantMsg.usage.cacheRead;
					runState.totalUsage.cacheWrite += assistantMsg.usage.cacheWrite;
					runState.totalUsage.cost.input += assistantMsg.usage.cost.input;
					runState.totalUsage.cost.output += assistantMsg.usage.cost.output;
					runState.totalUsage.cost.cacheRead += assistantMsg.usage.cost.cacheRead;
					runState.totalUsage.cost.cacheWrite += assistantMsg.usage.cost.cacheWrite;
					runState.totalUsage.cost.total += assistantMsg.usage.cost.total;
				}

				const content = agentEvent.message.content;
				const thinkingParts: string[] = [];
				const textParts: string[] = [];
				for (const part of content) {
					if (part.type === "thinking") {
						// Only extract .thinking text — never .signature or other fields
						const thinkingText = (part as any).thinking;
						if (typeof thinkingText === "string" && thinkingText.trim()) {
							thinkingParts.push(thinkingText);
						}
					} else if (part.type === "text") {
						const t = (part as any).text;
						if (typeof t === "string") {
							textParts.push(t);
						}
					}
					// Silently skip unknown content block types (e.g. signature blocks)
				}

				const text = textParts.join("\n");

				for (const thinking of thinkingParts) {
					log.logThinking(logCtx, thinking);
					const lines = thinking.trim().split("\n").map((l: string) => l.trim()).filter(Boolean);
					const formatted = "💭 " + lines.map((l: string) => `_${l}_`).join("\n");
					queue.enqueueMessage(formatted, "main", "thinking main");
					queue.enqueueMessage(formatted, "thread", "thinking thread", false);
				}

				// Guard: skip text that looks like leaked debug output or serialized objects
				if (text.trim() && !text.trim().startsWith("(Empty response:") && !text.trim().startsWith("{'content':")) {
					log.logResponse(logCtx, text);
					queue.enqueueMessage(text, "main", "response main");
					queue.enqueueMessage(text, "thread", "response thread", false);
				} else if (text.trim()) {
					log.logWarning("Suppressed leaked debug output from response", text.substring(0, 100));
				}
			}
		} else if (event.type === "compaction_start") {
			log.logInfo(`Compaction started (reason: ${(event as any).reason})`);
			queue.enqueue(() => ctx.respond("_Compacting context..._", false), "compaction start");
		} else if (event.type === "compaction_end") {
			const compEvent = event as any;
			if (compEvent.result) {
				log.logInfo(`Compaction complete: ${compEvent.result.tokensBefore} tokens compacted`);
			} else if (compEvent.aborted) {
				log.logInfo("Compaction aborted");
			} else {
				// FAT-279 — surface silent no-ops so ping-pong cases are visible.
				// result: undefined with no abort means prepareCompaction returned null
				// (nothing to summarize) or model/apiKey was missing.
				log.logInfo(`Compaction no-op: ${compEvent.errorMessage || "nothing to compact or missing model/key"}`);
			}
		} else if (event.type === "auto_retry_start") {
			const retryEvent = event as any;
			log.logWarning(`Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})`, retryEvent.errorMessage);
			queue.enqueue(
				() => ctx.respond(`_Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})..._`, false),
				"retry",
			);
		}
	};

	// Message length limit
	const MAX_MESSAGE_LENGTH = 40000;
	const splitMessage = (text: string): string[] => {
		if (text.length <= MAX_MESSAGE_LENGTH) return [text];
		const parts: string[] = [];
		let remaining = text;
		let partNum = 1;
		while (remaining.length > 0) {
			const chunk = remaining.substring(0, MAX_MESSAGE_LENGTH - 50);
			remaining = remaining.substring(MAX_MESSAGE_LENGTH - 50);
			const suffix = remaining.length > 0 ? `\n_(continued ${partNum}...)_` : "";
			parts.push(chunk + suffix);
			partNum++;
		}
		return parts;
	};

	const formatUserVisibleError = (message: string): string => {
		const normalized = message.replace(/\s+/g, " ").trim();
		const redacted = normalized
			.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
			.replace(/\b(?:sk|sess|ghp|gho|github_pat)_[A-Za-z0-9._~+/=-]{12,}\b/g, "[redacted-token]");
		return redacted.length > 1200 ? `${redacted.substring(0, 1200)}...` : redacted;
	};

	const formatDeliveryContext = (ctx: MomContext): string => {
		const hasActionableDeliveryContext = Boolean(
			ctx.message.sourceEventType ||
			ctx.message.replyTarget ||
			ctx.message.threadTs ||
			typeof ctx.message.directlyAddressed === "boolean",
		);
		if (!hasActionableDeliveryContext) return "";

		const lines: string[] = [];
		if (ctx.message.sourceEventType) lines.push(`Source event: ${ctx.message.sourceEventType}`);
		if (ctx.message.eventType) lines.push(`Message type: ${ctx.message.eventType}`);
		if (typeof ctx.message.directlyAddressed === "boolean") lines.push(`Directly addressed: ${ctx.message.directlyAddressed ? "yes" : "no"}`);
		if (ctx.message.threadTs) lines.push(`Thread timestamp: ${ctx.message.threadTs}`);
		if (ctx.message.replyTarget) {
			lines.push(`Suggested reply target: ${ctx.message.replyTarget}`);
			if (ctx.message.replyTargetDescription) lines.push(`Target meaning: ${ctx.message.replyTargetDescription}`);
			lines.push("Use send_message with this exact target if you choose to reply there. send_message requires a target; never omit it.");
		}
		if (lines.length === 0) return "";
		return `<delivery_context>\n${lines.join("\n")}\n</delivery_context>`;
	};

	return {
		async run(
			ctx: MomContext,
			_store: ChannelStore,
			_pendingMessages?: PendingMessage[],
		): Promise<RunResult> {
			const tRun = performance.now();

			// Ensure awareness directory exists
			await mkdir(awarenessDir, { recursive: true });

			const tR2 = performance.now();
			if (ctx.message.freshContext) {
				const sessionLabel = ctx.message.sessionId ? ` session=${ctx.message.sessionId}` : "";
				await resetContextFile(`fresh context for ${ctx.message.sourceEventType || ctx.message.channel}${sessionLabel}`);
				ctx.emitContentBlock?.({
					type: "status",
					status: "fresh_context",
					message: "Fresh voice session started",
				});
			}
			const sm = getSessionManager();

			// No sync step — the runner is the sole writer to context.jsonl
			const tCtx = performance.now();
			const reloadedSession = sm.buildSessionContext();
			log.logInfo(`[perf] buildSessionContext: ${(performance.now() - tCtx).toFixed(0)}ms`);

			if (reloadedSession.messages.length > 0) {
				const tSan = performance.now();
				const sanitized = sanitizeMessages(reloadedSession.messages as unknown as Parameters<typeof sanitizeMessages>[0]);
				agent.state.messages = sanitized as unknown as typeof reloadedSession.messages;
				log.logInfo(`[perf] sanitize+replace (${sanitized.length} msgs): ${(performance.now() - tSan).toFixed(0)}ms`);
			}

			const tMem = performance.now();
			const workspaceContext = getWorkspaceContext(workspaceStore);
			log.logInfo(`[perf] getWorkspaceContext: ${(performance.now() - tMem).toFixed(0)}ms`);

			const tSkills = performance.now();
			const skills = loadMomSkills(awarenessDir, workspacePath, extraSkillsDirs);
			log.logInfo(`[perf] loadMomSkills (${skills.length} skills): ${(performance.now() - tSkills).toFixed(0)}ms`);

			log.logInfo(`[perf] total R2 reads: ${(performance.now() - tR2).toFixed(0)}ms`);

			const currentSession = await getSession();

			// Re-resolve model each run and keep the session prompt aligned with it.
			const currentModel = resolveModelWithAuth(workspaceDir, modelRegistry);
			const agentModel = agent.state.model;
			if (!agentModel || currentModel.id !== agentModel.id || currentModel.provider !== agentModel.provider) {
				log.logInfo(`[awareness] Model changed to ${currentModel.provider}/${currentModel.id}`);
				agent.state.model = currentModel;
			}
			const requestedThinkingLevel = resolveThinkingLevel(workspaceStore);
			const effectiveThinkingLevel = normalizeThinkingLevelForModel(agent.state.model, requestedThinkingLevel);
			if (agent.state.thinkingLevel !== effectiveThinkingLevel) {
				if (effectiveThinkingLevel !== requestedThinkingLevel) {
					log.logInfo(`[thinking] Effective thinking ${requestedThinkingLevel} -> ${effectiveThinkingLevel} for ${agent.state.model.provider}/${agent.state.model.id}`);
				}
				agent.state.thinkingLevel = effectiveThinkingLevel;
			}

			const systemPrompt = buildSystemPrompt(workspacePath, sandboxConfig, formatInstructions, agent.state.model);
			currentSession.agent.state.systemPrompt = systemPrompt;

			// Build dynamic preamble (injected into user message below)
			settingsManager.reload();
			const channelVerbosity = settingsManager.getVerbose(ctx.message.channel);
			const sessionPreamble = buildSessionPreamble(
				workspaceContext,
				ctx.channels,
				ctx.users,
				skills,
				ctx.message.channel,
				ctx.channelName,
				channelVerbosity,
			);

			// Set up file upload function
			setUploadFunction(async (filePath: string, title?: string) => {
				const hostPath = translateToHostPath(filePath, awarenessDir, workspacePath);
				await ctx.uploadFile(hostPath, title);
			});

			log.logInfo(`[perf] run() pre-prompt setup: ${(performance.now() - tRun).toFixed(0)}ms`);

			// Reset per-run state
			runState.ctx = ctx;
			runState.logCtx = {
				channelId: ctx.message.channel,
				userName: ctx.message.userName,
				channelName: ctx.channelName,
			};
			runState.pendingTools.clear();
			runState.toolsUsed = [];
			runState.totalUsage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			runState.stopReason = "stop";
			runState.errorMessage = undefined;
			runState.initialPromptSent = false;
			runState.liveSnapshot.reset();
			resetYield(); // Clear any stale yield from previous run

			// Create queue for this run
			let queueChain = Promise.resolve();
			runState.queue = {
					enqueue(fn: () => Promise<void>, errorContext: string): Promise<void> {
						queueChain = queueChain.then(async () => {
						try {
							await fn();
						} catch (err) {
							const errMsg = err instanceof Error ? err.message : String(err);
							log.logWarning(`Platform API error (${errorContext})`, errMsg);
							try {
								await ctx.respondInThread(`_Error: ${errMsg}_`);
							} catch {
								// Ignore
							}
							}
						});
						return queueChain;
					},
				enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog = true): void {
					const parts = splitMessage(text);
					for (const part of parts) {
						this.enqueue(
							() => (target === "main" ? ctx.respond(part, doLog) : ctx.respondInThread(part)),
							errorContext,
						);
					}
				},
			};

			// Log context info
			log.logInfo(`Context sizes - preamble: ${sessionPreamble.length} chars, workspace: ${workspaceContext.length} chars`);
			log.logInfo(`Channels: ${ctx.channels.length}, Users: ${ctx.users.length}`);

			// Build user message with timestamp, channel tag, and username
			const now = new Date();
			const pad = (n: number) => n.toString().padStart(2, "0");
			const offset = -now.getTimezoneOffset();
			const offsetSign = offset >= 0 ? "+" : "-";
			const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
			const offsetMins = pad(Math.abs(offset) % 60);
			const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetSign}${offsetHours}:${offsetMins}`;

			// Always tag messages with source channel
			const channelLabel = ctx.channelName || ctx.message.channel;
			const deliveryContext = formatDeliveryContext(ctx);
			const userMessage = `${sessionPreamble}${deliveryContext ? `\n\n${deliveryContext}` : ""}\n\n[${timestamp}] [${channelLabel}] [${ctx.message.userName || "unknown"}]: ${ctx.message.text}`;

			const imageAttachments: ImageContent[] = [];
			const nonImagePaths: string[] = [];

			for (const a of ctx.message.attachments || []) {
				const fullPath = `${workspacePath}/${a.local}`;
				const mimeType = getImageMimeType(a.local);

				if (mimeType && existsSync(fullPath)) {
					try {
						imageAttachments.push({
							type: "image",
							mimeType,
							data: readFileSync(fullPath).toString("base64"),
						});
					} catch {
						nonImagePaths.push(fullPath);
					}
				} else {
					nonImagePaths.push(fullPath);
				}
			}

			let finalUserMessage = userMessage;
			if (nonImagePaths.length > 0) {
				finalUserMessage += `\n\n<attachments>\n${nonImagePaths.join("\n")}\n</attachments>`;
			}

			// GPT-5 ack fast path: short approvals get "skip recap, act now" injection
			const ackInstruction = resolveAckFastPath(ctx.message.text, currentModel);
			if (ackInstruction) {
				finalUserMessage += `\n\n${ackInstruction}`;
				log.logInfo(`[gpt-steering] Ack fast path injected for "${ctx.message.text.substring(0, 40)}"`);
			}

			// Debug: write context to last_prompt.jsonl
			const debugContext = {
				systemPrompt: currentSession.agent.state.systemPrompt,
				sessionPreamble,
				messages: currentSession.messages,
				newUserMessage: finalUserMessage,
				imageAttachmentCount: imageAttachments.length,
			};
			await writeFile(join(awarenessDir, "last_prompt.jsonl"), JSON.stringify(debugContext, null, 2));

			log.logInfo(`[awareness] Pre-prompt: ${currentSession.messages.length} messages in context`);

			const tPrompt = performance.now();
			try {
				await withToolOutputStream((event) => {
					runState.liveSnapshot.appendToolOutput(event);
					const entry = runState.liveSnapshot.current(true);
					if (entry) ctx.emitContentBlock?.({ type: "assistant_snapshot", entry });
					onActivity?.();
				}, async () => {
					await currentSession.prompt(finalUserMessage, {
						...(imageAttachments.length > 0 ? { images: imageAttachments } : {}),
						streamingBehavior: "steer" as const,
					});
				});
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				runState.stopReason = "error";
				runState.errorMessage = errMsg;
				log.logWarning("Model prompt failed", errMsg);
			}
			log.logInfo(`[perf] session.prompt (incl API): ${(performance.now() - tPrompt).toFixed(0)}ms`);

			// If overflow error triggered background compaction+retry, wait for it.
			if (runState.stopReason === "error") {
				await agent.waitForIdle();

				const msgs = currentSession.messages;
				const last = msgs.filter((m) => m.role === "assistant").pop() as any;
				if (last && last.stopReason && last.stopReason !== "error") {
					runState.stopReason = last.stopReason;
					runState.errorMessage = undefined;
				}
			}

			// GPT-5 planning-only retry: if the model narrated a plan without acting, nudge and re-prompt once
			if (runState.stopReason !== "error" && !wasYielded()) {
				const messages = currentSession.messages;
				const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
				const assistantText =
					lastAssistant?.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n") || "";

				const retryInstruction = detectPlanningOnlyTurn(assistantText, runState.toolsUsed, currentModel);
				if (retryInstruction) {
					log.logInfo(`[gpt-steering] Planning-only turn detected, retrying with act-now nudge`);
					log.logInfo(`[gpt-steering] Assistant said: "${assistantText.substring(0, 120)}..."`);
					try {
						await withToolOutputStream((event) => {
							runState.liveSnapshot.appendToolOutput(event);
							const entry = runState.liveSnapshot.current(true);
							if (entry) ctx.emitContentBlock?.({ type: "assistant_snapshot", entry });
							onActivity?.();
						}, async () => {
							await currentSession.prompt(retryInstruction, {
								streamingBehavior: "steer" as const,
							});
						});
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						runState.stopReason = "error";
						runState.errorMessage = errMsg;
						log.logWarning("Model retry prompt failed", errMsg);
					}
					log.logInfo(`[gpt-steering] Retry prompt completed`);
				}
			}

			// Wait for queued messages
			await queueChain;

			// Handle error case
			if (runState.stopReason === "error" && runState.errorMessage) {
				try {
					const visibleError = formatUserVisibleError(runState.errorMessage);
					const userErrorMsg = `_Sorry, something went wrong: ${visibleError}_`;
					ctx.emitContentBlock?.({ type: "error", message: visibleError });
					await ctx.sendFinalResponse(userErrorMsg, { force: true });
					await ctx.respondInThread(`_Error: ${visibleError}_`);
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					log.logWarning("Failed to post error message", errMsg);
				}
			} else {
				// Final message update
				const messages = currentSession.messages;
				const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
				const finalText =
					lastAssistant?.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n") || "";

				// Check if yield_no_action was called — skip posting final response
				if (wasYielded()) {
					log.logInfo("yield_no_action — no output posted");
					resetYield();
				} else if (finalText.trim() && !finalText.trim().startsWith("(Empty response:") && !finalText.trim().startsWith("{'content':")) {
					try {
						// Hard cap: never post more than 40KB (signature blobs can be hundreds of KB)
						const cappedText = finalText.length > 40000 ? finalText.substring(0, 40000) + "\n\n_(truncated)_" : finalText;
						const mainText =
							cappedText.length > MAX_MESSAGE_LENGTH
								? `${cappedText.substring(0, MAX_MESSAGE_LENGTH - 50)}\n\n_(see thread for full response)_`
								: cappedText;
						await ctx.sendFinalResponse(mainText);
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning("Failed to replace message with final text", errMsg);
					}
				}
			}

			// Log usage summary
			if (runState.totalUsage.cost.total > 0 && runState.logCtx && runState.queue) {
				const messages = currentSession.messages;
				const lastAssistantMessage = messages
					.slice()
					.reverse()
					.find((m) => m.role === "assistant" && (m as any).stopReason !== "aborted") as any;

				const contextTokens = lastAssistantMessage
					? lastAssistantMessage.usage.input +
						lastAssistantMessage.usage.output +
						lastAssistantMessage.usage.cacheRead +
						lastAssistantMessage.usage.cacheWrite
					: 0;
				const contextWindow = agent.state.model?.contextWindow || 200000;

				const summary = log.logUsageSummary(runState.logCtx, runState.totalUsage, contextTokens, contextWindow);
				runState.queue.enqueue(() => ctx.respondInThread(summary), "usage summary");
				await queueChain;
			}

			// Clear run state
			runState.ctx = null;
			runState.logCtx = null;
			runState.queue = null;
			runState.liveSnapshot.reset();

			log.logInfo(`[perf] TOTAL run(): ${(performance.now() - tRun).toFixed(0)}ms`);
			return { stopReason: runState.stopReason, errorMessage: runState.errorMessage };
		},

		abort(): void {
			if (session) session.abort();
		},

		steer(text: string): void {
			void getSession().then((s) => {
				if (s.isStreaming) {
					s.steer(text).catch((err: Error) => {
						log.logWarning(`[awareness] steer failed`, err.message);
					});
				} else {
					// A platform message can arrive after the global run gate is held but
					// before pi has entered its streaming phase. Preserve the message as a
					// follow-up instead of dropping it or starting a competing prompt.
					log.logInfo(`[awareness] steer called before streaming; queueing as follow-up`);
					s.followUp(text).catch((err: Error) => {
						log.logWarning(`[awareness] follow-up queue failed`, err.message);
					});
				}
			}).catch((err: Error) => {
				log.logWarning(`[awareness] steer session init failed`, err.message);
			});
		},

		getContextInfo(): ContextInfo {
			// Re-resolve model to pick up settings.json changes
			const currentModel = resolveModelWithAuth(workspaceDir, modelRegistry);
			const contextWindow = currentModel?.contextWindow || 200000;

			// Ensure messages are loaded from context.jsonl
			const sm = getSessionManager();
			if (agent.state.messages.length === 0) {
				const restored = sm.buildSessionContext();
				if (restored.messages.length > 0) {
					agent.state.messages = restored.messages;
				}
			}
			const messages = session?.messages ?? agent.state.messages;

			// Find last assistant message with usage data
			let contextTokens = 0;
			let usage: ContextInfo["usage"] = undefined;
			for (let i = messages.length - 1; i >= 0; i--) {
				const m = messages[i] as any;
				if (m.role === "assistant" && m.usage) {
					contextTokens = m.usage.input + m.usage.output +
						(m.usage.cacheRead || 0) + (m.usage.cacheWrite || 0);
					usage = {
						input: m.usage.input || 0,
						output: m.usage.output || 0,
						cacheRead: m.usage.cacheRead || 0,
						cacheWrite: m.usage.cacheWrite || 0,
						cost: m.usage.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					};
					break;
				}
			}

			const contextPercent = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;

			return {
				model: currentModel?.id || "unknown",
				provider: currentModel?.provider || "unknown",
				contextWindow,
				messageCount: messages.length,
				contextTokens,
				contextPercent,
				usage,
			};
		},

		async compact(instructions?: string): Promise<CompactResult> {
			const contextFile = join(awarenessDir, "context.jsonl");
			// Ensure messages are loaded from context.jsonl before counting
			const currentSession = await getSession();
			if (currentSession.messages.length === 0) {
				const sm = getSessionManager();
				const restored = sm.buildSessionContext();
				if (restored.messages.length > 0) {
					agent.state.messages = restored.messages;
				}
			}
			const messagesBefore = currentSession.messages.length;

			// Don't compact if context is too small to benefit
			const info = this.getContextInfo();
			const MIN_COMPACT_TOKENS = 50000;
			if (info.contextTokens < MIN_COMPACT_TOKENS && info.contextTokens > 0) {
				throw new Error(`Context too small to compact (${log.formatTokens(info.contextTokens)} tokens, minimum ${log.formatTokens(MIN_COMPACT_TOKENS)})`);
			}

			// Run compaction — this generates the summary and updates
			// agent.messages in memory with the compacted view
			const result = await currentSession.compact(instructions);

			// Capture the compacted messages before we tear down the session
			const compactedMessages = [...currentSession.messages];

			// Archive the full pre-compaction file to history/
			await archiveContext(contextFile);

			// Truncate context.jsonl (same as /clear)
			writeFileSync(contextFile, "", "utf-8");

			// Reset in-memory state (same as /clear)
			resetSessionState();

			// Re-open SessionManager on the empty file — writes fresh session header
			const freshSm = getSessionManager();

			// Replay the compacted messages into the fresh file via normal append path.
			// buildSessionContext() produces AgentMessage[] but all compacted messages
			// are standard Message objects (user/assistant turns + compaction summary).
			for (const msg of compactedMessages) {
				freshSm.appendMessage(msg as Parameters<typeof freshSm.appendMessage>[0]);
			}

			// Restore in-memory agent state to match the file
			agent.state.messages = compactedMessages;

			log.logInfo(`[awareness] Context compacted: ${messagesBefore} → ${compactedMessages.length} messages, file rotated`);

			return {
				messagesBefore,
				messagesAfter: compactedMessages.length,
				tokensBefore: result.tokensBefore,
			};
		},

		get onActivity(): (() => void) | undefined { return onActivity; },
		set onActivity(fn: (() => void) | undefined) { onActivity = fn; },

		async clear(): Promise<{ messagesCleared: number; quarantined?: string }> {
			const result = await resetContextFile("/clear");
			if (result.quarantined) {
				log.logInfo(`[awareness] Context cleared — previous file was unreadable and quarantined to ${result.quarantined}`);
			} else {
				log.logInfo(`[awareness] Context cleared (${result.messagesCleared} messages archived)`);
			}
			return result;
		},
	};
}

/**
 * Archive context.jsonl to awareness/history/<date>/<uuid>.jsonl
 */
async function archiveContext(contextFile: string): Promise<void> {
	if (!existsSync(contextFile)) return;
	const stat = statSync(contextFile);
	if (stat.size === 0) return;

	const now = new Date();
	const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
	const historyDir = join(contextFile, "..", "history", dateStr);
	await mkdir(historyDir, { recursive: true });

	const archivePath = join(historyDir, `${randomUUID()}.jsonl`);
	await copyFile(contextFile, archivePath);
	log.logInfo(`[awareness] Archived context to ${archivePath}`);
}

/**
 * Translate container path back to host path for file operations
 */
function translateToHostPath(
	containerPath: string,
	awarenessDir: string,
	workspacePath: string,
): string {
	if (workspacePath === "/data" || workspacePath === "/workspace") {
		const prefixes = workspacePath === "/data" ? ["/data/", "/workspace/"] : ["/workspace/", "/data/"];
		for (const prefix of prefixes) {
			if (containerPath.startsWith(prefix)) {
				return join(awarenessDir, "..", containerPath.slice(prefix.length));
			}
		}
	}
	return containerPath;
}
