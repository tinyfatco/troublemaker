import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import {
	AgentSession,
	convertToLlm,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	ModelRegistry,
	SessionManager,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "crypto";
import { existsSync, writeFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import type { MomContext, RunResult } from "./adapters/types.js";
import {
	createClaudeCliStream,
	getClaudeCliRuntimeAuth,
	isClaudeCliProvider,
	registerClaudeCliRuntimeAuth,
	resetClaudeCliSession,
} from "./claude-cli.js";
import { createCodexCliStream, getCodexCliRuntimeAuth, isCodexCliProvider, registerCodexCliRuntimeAuth, resetCodexCliSession } from "./codex-cli.js";
import { readContextTransitions, saveContextTransition } from "./context-transition.js";
import { MomSettingsManager } from "./context.js";
import { restoreAgentHooks, snapshotAgentHooks } from "./core/agent-hooks.js";
import { buildCompactSystemPrompt, existingCompactRuntimeContext, compactInitialRuntimePrefix, compactPromptEnabled, COMPACT_INITIAL_TOOLS, getCompactWorkspaceContext } from "./core/compact-prompt.js";
import { InputBudget } from "./core/input-budget.js";
import {
	buildWorkspaceRuntimeContext,
	buildSessionRoutingPreamble,
	buildSystemPrompt,
	getWorkspaceContext,
	resolveClaudeCliDeliveryRetry,
	resolveThinkingLevel,
} from "./core/prompt.js";
import { countPreRunHistoryMessages, projectProviderHistory } from "./core/provider-history.js";
import type { RuntimeEventSink } from "./core/runtime-contract.js";
import {
	createDynamicRuntimeContextExtension,
	STABLE_DELIVERY_FORMAT_INSTRUCTIONS,
	withDeliveryInstructions,
} from "./extensions/dynamic-runtime-context.js";
import hostGmailExtension from "./extensions/host-gmail.js";
import hostSitesExtension from "./extensions/host-sites.js";
import tinyfatDomainsExtension from "./extensions/tinyfat-domains.js";
import { detectPlanningOnlyTurn } from "./gpt-steering.js";
import {
	estimateHandoffContextTokens,
	handoffJournalPath,
	localPrefillLimitTokens,
	readHandoffJournal,
	replayHandoffRotation,
	selectBoundedRecentDialogue,
	shouldRequestBoundedHandoff,
	writeHandoffJournal,
	type HandoffRotationJournal,
} from "./handoff-compaction.js";
import { createRunnerOperationQueue, handoffContinuationMessage, runHandoffSegments } from "./handoff-continuation.js";
import { inferenceProgressURL } from "./inference-progress.js";
import * as log from "./log.js";
import { startLiveModelCatalogRefresh } from "./model-catalog-refresh.js";
import { runWithModelCredentialGate } from "./model-auth-gate.js";
import { resolveModelWithAuth, resolveApiKey } from "./model-config.js";
import { normalizeThinkingLevelForModel } from "./model-thinking.js";
import { archiveAndTruncateContextFile, archiveContext, translateToHostPath } from "./runner/context-files.js";
import {
	createCompactionSettingsProxy,
	createCompactionTracker,
	isCliHarnessProvider,
	resolveCompactionTimeoutMs,
	type CompactionStatus,
} from "./runner/compaction.js";
import { createContextTransitionTracker } from "./runner/context-transitions.js";
import { createHandoffContextExtension, createRunnerHandoffTool } from "./runner/handoff.js";
import { createRunPresentation } from "./runner/presentation.js";
import { createPrivateCheckpointGenerator } from "./runner/private-checkpoint.js";
import { buildUserPrompt } from "./runner/prompt-message.js";
import { deliverRunOutcome } from "./runner/run-outcome.js";
import { beginRunState, clearRunState, createRunQueue, createRunState } from "./runner/run-state.js";
import { createSessionEventHandlers } from "./runner/session-events.js";
import { loadMomSkills } from "./runner/skills.js";
import { createRunnerStreamFn } from "./runner/stream-fn.js";
import { createExecutor, withExecutorCwd, type SandboxConfig } from "./sandbox.js";
import { readVerifiedSenderIdentity, type VerifiedSenderIdentity } from "./sender-identity.js";
import { FilesystemWorkspaceStore } from "./storage/node/filesystem-workspace.js";
import { SteeringProjectionTracker } from "./streaming/steering-projection.js";
import { UserInputProvenance } from "./streaming/user-input-provenance.js";
import { ChannelStore } from "./store.js";
import { ToolLoopGuard, TOOL_LOOP_STOP_MESSAGE } from "./tool-loop-guard.js";
import { createMomTools, setUploadFunction } from "./tools/index.js";
import { createSearchToolsTool, type ToolSearchRegistry } from "./tools/search-tools.js";
import { enforceRequiredToolLabel, enforceRequiredToolLabels } from "./tools/tool-label.js";
import { withToolOutputStream } from "./tools/tool-output-stream.js";
import { wasYielded, resetYield } from "./tools/yield-no-action.js";

export { DEFAULT_COMPACTION_TIMEOUT_MS, resolveCompactionTimeoutMs, type CompactionStatus } from "./runner/compaction.js";

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
	/** Pi estimate; null tokens means usage is unknown after compaction. */
	contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
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
		formatInstructions?: string,
		liveEventSink?: RuntimeEventSink,
		completionID?: string,
	): Promise<RunResult>;
	abort(): void;
	/** Abort only an in-progress manual or automatic context compaction. */
	abortCompaction(): boolean;
	/**
	 * Queue a message at the active run's next safe turn boundary.
	 * The returned promise settles only after Pi has drained the batched queue
	 * and the active session is idle, allowing durable ingress receipts to stay
	 * live across the in-memory steering interval.
	 */
	steer(text: string, options?: {
		projectionId?: string;
		deliveryId?: string;
		senderIdentity?: VerifiedSenderIdentity;
		onAccepted?: () => void | Promise<void>;
	}): Promise<void> | null;
	/** Describe an in-progress context compaction for status surfaces. */
	getCompactionStatus(): CompactionStatus | null;
	/** Get current context diagnostics */
	getContextInfo(): ContextInfo;
	/** Compact context — summarize old messages, keep recent */
	compact(instructions?: string): Promise<CompactResult>;
	/** Clear context entirely — archive and start fresh */
	clear(): Promise<{ messagesCleared: number; quarantined?: string }>;
	/** Called on every substantive event (tool call, LLM token, etc.) during a run */
	onActivity?: () => void;
}


// Cache runners per awareness dir
const runners = new Map<string, Promise<AgentRunner>>();

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
	deferredTools: AgentTool<any>[] = [],
): Promise<AgentRunner> {
	const existing = runners.get(awarenessDir);
	if (existing) return existing;

	const runnerPromise = createRunner(
		sandboxConfig,
		awarenessDir,
		formatInstructions,
		extraSkillsDirs,
		extraTools,
		deferredTools,
	).catch((error) => {
		if (runners.get(awarenessDir) === runnerPromise) runners.delete(awarenessDir);
		throw error;
	});
	runners.set(awarenessDir, runnerPromise);
	return runnerPromise;
}

/**
 * Create a new AgentRunner for the unified awareness.
 */
async function createRunner(
	sandboxConfig: SandboxConfig,
	awarenessDir: string,
	formatInstructions: string,
	extraSkillsDirs: string[] = [],
	extraTools: AgentTool<any>[] = [],
	deferredTools: AgentTool<any>[] = [],
): Promise<AgentRunner> {
	const t0 = performance.now();
	const workspaceDir = join(awarenessDir, "..");
	const executor = withExecutorCwd(createExecutor(sandboxConfig), workspaceDir);
	const workspacePath = executor.getWorkspacePath(workspaceDir);

	const toolSearchRegistry: { current: ToolSearchRegistry | null } = { current: null };
	const compactPrompt = compactPromptEnabled(process.env.TROUBLEMAKER_PROMPT_PROFILE);
	const inputBudget = process.env.TROUBLEMAKER_INPUT_BUDGET === "small"
		? new InputBudget(join(awarenessDir, "input-budget")) : undefined;
	const localProgressURL = inferenceProgressURL(process.env.TROUBLEMAKER_INFERENCE_PROGRESS_URL);
	const localPrefillLimit = localProgressURL ? localPrefillLimitTokens() : undefined;

	// Mutable per-run state, and the live presentation / context-transition
	// publishers that read it. See runner/run-state.ts.
	const runState = createRunState();
	const presentation = createRunPresentation(runState, () => getSessionManager());
	const { emitLiveEvent, assistantMessageIDsForRun, claimNewAssistantMessageIDs, emitAssistantTextEvent } = presentation;
	const transitions = createContextTransitionTracker(workspaceDir, emitLiveEvent, () => runState.ctx);
	const { beginTransition, finishTransition } = transitions;
	let forceHandoff = false;
	let completedHandoffRotations = 0;
	let rotationsAtRunStart = 0;

	// Create tools (core + extras like send_message). Extension/custom tools are
	// loaded into the session registry and activated through search_tools.
	const tools = enforceRequiredToolLabels([
		...createMomTools(executor, workspaceDir),
		...extraTools,
		createRunnerHandoffTool({
			getAgent: (): Agent => agent,
			runState,
			getCompletedHandoffRotations: () => completedHandoffRotations,
			getRotationsAtRunStart: () => rotationsAtRunStart,
			beginTransition,
		}),
		...(inputBudget ? [inputBudget.tool] : []),
		createSearchToolsTool(() => toolSearchRegistry.current, compactPrompt),
	]);

	// Minimal system prompt for agent creation — will be replaced with full prompt in run()
	const systemPrompt = "Initializing...";

	// Create session manager and settings manager
	const contextFile = join(awarenessDir, "context.jsonl");
	const workspaceStore = new FilesystemWorkspaceStore(workspaceDir);
	const settingsManager = new MomSettingsManager(workspaceDir);
	const rotationJournalPath = handoffJournalPath(awarenessDir);
	const recoverRotation = async (journal: HandoffRotationJournal): Promise<void> => {
		await replayHandoffRotation(contextFile, awarenessDir, rotationJournalPath, journal);
		log.logInfo(`[handoff] Replayed durable rotation ${journal.id}`);
	};
	const pendingRotation = readHandoffJournal(rotationJournalPath);
	if (existsSync(rotationJournalPath) && !pendingRotation) {
		throw new Error("Invalid handoff rotation journal; refusing to load context until it is repaired");
	}
	if (pendingRotation) await recoverRotation(pendingRotation);

	// The canonical model runtime owns credential storage, provider composition,
	// and request auth. Keep the compatibility registry only for synchronous
	// model selection used by the surrounding Troublemaker code.
	const modelRuntime = await ModelRuntime.create({
		authPath: join(getAgentDir(), "auth.json"),
		modelsPath: join(workspaceDir, "models.json"),
		allowModelNetwork: false,
	});
	await registerClaudeCliRuntimeAuth(modelRuntime);
	await registerCodexCliRuntimeAuth(modelRuntime);
	const modelRegistry = new ModelRegistry(modelRuntime);

	for (const interrupted of readContextTransitions(workspaceDir)) {
		if (interrupted.state === "preparing") saveContextTransition(workspaceDir, {
			...interrupted, state: "aborted", revision: interrupted.revision + 1, updatedAt: new Date().toISOString(),
		});
	}

	// Resolve model before starting catalog refresh so discovery can never
	// mutate the resident's active choice. Refreshed models become eligible only
	// through the existing explicit setting and next-turn resolution path.
	const model = resolveModelWithAuth(workspaceDir, modelRegistry);
	if (compactPrompt && model.api !== "openai-completions") throw new Error("Compact prompt profile currently requires an OpenAI-compatible chat-completions model");

	// FAT-275: read thinking_level from settings.json and clamp it to the
	// selected provider/model's supported runtime shape.
	const requestedInitialThinkingLevel = resolveThinkingLevel(workspaceStore);
	const initialThinkingLevel = normalizeThinkingLevelForModel(model, requestedInitialThinkingLevel);
	if (initialThinkingLevel !== requestedInitialThinkingLevel) {
		log.logInfo(`[thinking] Effective thinking ${requestedInitialThinkingLevel} -> ${initialThinkingLevel} for ${model.provider}/${model.id}`);
	}

	// Session created lazily on first run
	let session: AgentSession | null = null;
	let acceptsSteering = false;
	let privateHandoffAbortController: AbortController | null = null;
	let unsubscribeSession: (() => void) | null = null;
	let resourceLoaderReady = false;
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

	// Activity callback for external watchdog
	let onActivity: (() => void) | undefined;
	const compaction = createCompactionTracker(resolveCompactionTimeoutMs(), () => session);
	const { requestCompactionAbort } = compaction;
	const steeringProjections = new SteeringProjectionTracker(emitLiveEvent);
	const userInputProvenance = new UserInputProvenance();
	// Session events drive logs, live snapshots and platform output. Claude/Codex
	// CLI models run tools over MCP outside the agent loop and report them here too.
	const sessionEvents = createSessionEventHandlers({
		runState,
		presentation,
		beginCompaction: compaction.beginCompaction,
		finishCompaction: compaction.finishCompaction,
		transitions,
		userInputProvenance,
		steeringProjections,
		getSessionManager,
		getOnActivity: () => onActivity,
	});
	const eventHandler = sessionEvents.eventHandler;
	const claudeCliToolOutputHandler = sessionEvents.toolOutputHandler;

	const claudeCliStream = createClaudeCliStream(workspaceDir, {
		tools: () => tools,
		onToolEvent: (event) => sessionEvents.toolEventHandler(event),
		onToolOutput: (event) => sessionEvents.toolOutputHandler(event),
	});
	const codexCliStream = createCodexCliStream(workspaceDir, {
		tools: () => tools,
		onToolEvent: (event) => sessionEvents.toolEventHandler(event),
		onToolOutput: (event) => sessionEvents.toolOutputHandler(event),
	});
	const streamFn = createRunnerStreamFn({
		runState,
		compactPrompt,
		inputBudget,
		localProgressURL,
		localPrefillLimit,
		claudeCliStream,
		codexCliStream,
	});

	// Create agent
	const agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			thinkingLevel: initialThinkingLevel,
			tools,
		},
		convertToLlm: (messages) => (compactPrompt ? compactInitialRuntimePrefix(messages) : messages).flatMap(message => {
			const converted = convertToLlm([message]);
			if (message.role === "user" || (message.role === "custom" && message.customType === "runtime-context")) {
				for (const item of converted) inputBudget?.trust(item);
			}
			return converted;
		}),
		// AgentSession binds lifecycle hooks, but the SDK normally installs this
		// provider-context bridge. Our manually constructed Agent needs it too.
		transformContext: async (messages) => session?.extensionRunner
			? session.extensionRunner.emitContext(messages)
			: messages,
		// Pi 1.x AgentSession rebuilds each request from the SessionManager projection
		// and then calls this baseline hook with that canonical context, so history
		// sanitizing and the concise_watch projection must happen here: assigning
		// agent.state.messages no longer reaches the provider.
		prepareRequest: (request) => {
			const config = runState.providerHistory;
			if (!config || !sessionManager) return undefined;
			const projection = sessionManager.buildSessionProjection();
			let historyMessageCount = countPreRunHistoryMessages(projection, config.runStartLeafId);
			if (historyMessageCount !== undefined && historyMessageCount > request.context.messages.length) {
				historyMessageCount = undefined;
			}
			if (historyMessageCount === undefined && config.conciseWatch) {
				log.logWarning("[voice-context] run-start history boundary not in request context; concise projection skipped");
			}
			const projected = projectProviderHistory(request.context.messages, historyMessageCount, config.conciseWatch);
			return { context: { ...request.context, messages: projected.messages } };
		},
		streamFn,
		steeringMode: "all",
		getApiKey: async (provider: string) => getCodexCliRuntimeAuth(provider) ?? getClaudeCliRuntimeAuth(provider) ?? resolveApiKey(modelRegistry, provider),
	});
	const agentHookBaseline = snapshotAgentHooks(agent);

	log.logInfo(`[perf] createRunner (no R2 reads): ${(performance.now() - t0).toFixed(0)}ms`);

	let activeSystemPrompt = systemPrompt;
	let activeRuntimeContext = "";
	let lastRunContext: MomContext | undefined;
	let lastRunFormatInstructions = formatInstructions;
	const dynamicRuntimeContextExtension = createDynamicRuntimeContextExtension(
		() => activeSystemPrompt,
		() => runState.handoffRequested ? "" : activeRuntimeContext,
		() => agent.state.messages,
	);
	const deferredToolsExtension = (pi: ExtensionAPI): void => {
		for (const tool of deferredTools) pi.registerTool(tool);
	};
	const handoffContextExtension = createHandoffContextExtension({
		settingsManager,
		runState,
		getAgent: (): Agent => agent,
		isForceHandoff: () => forceHandoff,
		localPrefillLimit,
		transitions,
	});
	const toolLoopGuard = new ToolLoopGuard();
	const resourceLoader = new DefaultResourceLoader({
		cwd: workspaceDir,
		agentDir: process.env.PI_AGENT_DIR || getAgentDir(),
		additionalExtensionPaths: parseExtensionPaths(process.env.TROUBLEMAKER_EXTENSION_PATHS),
		extensionFactories: [
			toolLoopGuard.extension,
			handoffContextExtension,
			dynamicRuntimeContextExtension,
			deferredToolsExtension,
			hostGmailExtension,
			hostSitesExtension,
			tinyfatDomainsExtension,
		],
		extensionsOverride: (base) => {
			for (const extension of base.extensions) {
				for (const registered of extension.tools.values()) {
					enforceRequiredToolLabel(registered.definition as any);
				}
			}
			return base;
		},
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt,
	});

	const baseToolsOverride = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
	const compactionSettingsProxy = createCompactionSettingsProxy(settingsManager, () => agent.state.model?.provider);

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
			// Each AgentSession wraps the Agent's hooks; start every session from the
			// pre-session baseline so disposed sessions' hooks never stack.
			restoreAgentHooks(agent, agentHookBaseline);
			session = new AgentSession({
				agent,
				sessionManager: getSessionManager(),
				settingsManager: compactionSettingsProxy as any,
				cwd: process.cwd(),
				modelRuntime,
				resourceLoader,
				baseToolsOverride,
			});
			toolSearchRegistry.current = {
				getAllTools: () => session?.getAllTools() ?? [],
				getActiveToolNames: () => session?.getActiveToolNames() ?? [],
				setActiveToolsByName: (toolNames) => {
					if (!session) return;
					// The runtime prompt is forced per request by the before_agent_start
					// extension, so rebuilding the loadout prompt here cannot replace it.
					session.setActiveToolsByName(toolNames);
				},
			};
			session.setActiveToolsByName(compactPrompt ? [...COMPACT_INITIAL_TOOLS, ...(inputBudget ? ["input_detail"] : [])] : tools.map((tool) => tool.name));
			unsubscribeSession = session.subscribe(eventHandler);
		}
		return session;
	};

	const generatePrivateCheckpoint = createPrivateCheckpointGenerator({
		tools,
		modelRegistry,
		compactPrompt,
		localProgressURL,
		localPrefillLimit,
		getActiveSystemPrompt: () => activeSystemPrompt,
		getActiveRuntimeContext: () => activeRuntimeContext,
		setAbortController: (controller) => { privateHandoffAbortController = controller; },
		getAbortController: () => privateHandoffAbortController,
	});

	const resetSessionState = () => {
		userInputProvenance.clear();
		unsubscribeSession?.();
		unsubscribeSession = null;
		session?.dispose();
		session = null;
		restoreAgentHooks(agent, agentHookBaseline);
		toolSearchRegistry.current = null;
		sessionManager = null;
		resourceLoaderReady = false;
		activeSystemPrompt = systemPrompt;
		activeRuntimeContext = "";
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

		const { quarantined } = await archiveAndTruncateContextFile(contextFile, label);
		resetClaudeCliSession(workspaceDir);
		resetCodexCliSession(workspaceDir);
		resetSessionState();
		log.logInfo(`[awareness] ${label}: context reset (${messagesCleared} messages archived)`);
		return { messagesCleared, ...(quarantined ? { quarantined } : {}) };
	};

	let resumeAfterHandoff = false;
	let handoffRunAborted = false;
	const runner: AgentRunner = {
		async run(
			ctx: MomContext,
			_store: ChannelStore,
			_pendingMessages?: PendingMessage[],
			runFormatInstructions = formatInstructions,
			liveEventSink?: RuntimeEventSink,
			completionID?: string,
		): Promise<RunResult> {
			resumeAfterHandoff = false;
			if (!forceHandoff) {
				lastRunContext = ctx;
				lastRunFormatInstructions = runFormatInstructions;
			}
			const tRun = performance.now();
			runState.completionID = completionID?.trim() || randomUUID();
			runState.assistantText.reset(runState.completionID);

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
			runState.runStartLeafID = sm.getLeafId();
			runState.providerHistory = {
				runStartLeafId: runState.runStartLeafID,
				conciseWatch: ctx.message.contextProjection === "concise_watch",
			};

			// No sync step — the runner is the sole writer to context.jsonl
			const tCtx = performance.now();
			const reloadedSession = sm.buildSessionContext();
			log.logInfo(`[perf] buildSessionContext: ${(performance.now() - tCtx).toFixed(0)}ms`);

			const tSan = performance.now();
			// Provider requests get the same projection from the prepareRequest hook;
			// this in-memory copy feeds handoff pressure and private checkpoints.
			const { messages: promptMessages, conciseWatch } = projectProviderHistory(
				reloadedSession.messages,
				reloadedSession.messages.length,
				runState.providerHistory.conciseWatch,
			);
			agent.state.messages = promptMessages;
			log.logInfo(`[perf] sanitize+replace (${promptMessages.length} msgs): ${(performance.now() - tSan).toFixed(0)}ms`);
			if (conciseWatch) {
				log.logInfo(
					`[voice-context] source_messages=${conciseWatch.sourceMessageCount} source_bytes=${conciseWatch.sourceBytes} projected_messages=${conciseWatch.messages.length} projected_bytes=${conciseWatch.projectedBytes}`,
				);
			}

			const tMem = performance.now();
			const workspaceContext = compactPrompt ? getCompactWorkspaceContext(workspaceStore) : getWorkspaceContext(workspaceStore);
			log.logInfo(`[perf] getWorkspaceContext: ${(performance.now() - tMem).toFixed(0)}ms`);

			const tSkills = performance.now();
			const skills = loadMomSkills(awarenessDir, workspacePath, extraSkillsDirs);
			log.logInfo(`[perf] loadMomSkills (${skills.length} skills): ${(performance.now() - tSkills).toFixed(0)}ms`);

			log.logInfo(`[perf] total R2 reads: ${(performance.now() - tR2).toFixed(0)}ms`);

			const currentSession = await getSession();

			// Re-resolve model each run and keep the session prompt aligned with it.
			const currentModel = resolveModelWithAuth(workspaceDir, modelRegistry);
			if (compactPrompt && currentModel.api !== "openai-completions") throw new Error("Compact prompt profile currently requires an OpenAI-compatible chat-completions model");
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

			const systemPrompt = compactPrompt
				? buildCompactSystemPrompt(
					workspacePath,
					`${currentModel.provider}/${currentModel.id}`,
					STABLE_DELIVERY_FORMAT_INSTRUCTIONS,
				)
				: buildSystemPrompt(
					workspacePath,
					sandboxConfig,
					STABLE_DELIVERY_FORMAT_INSTRUCTIONS,
					agent.state.model,
				);
			// Pi 1.x keeps the prompt in transcript system messages (state.systemPrompt is
			// read-only). The dynamic runtime context extension forces activeSystemPrompt
			// onto each request via before_agent_start.
			activeSystemPrompt = systemPrompt;

			// Keep the system prefix and existing history stable across channels.
			// The extension appends workspace snapshots only when changed or lost
			// to compaction; current routing always travels with the new input.
			settingsManager.reload();
			const compactionSettings = settingsManager.getCompactionSettings();
			const channelVerbosity = settingsManager.getVerbose(ctx.message.channel);
			const sessionContextOptions = {
				workspaceContext,
				channels: ctx.channels,
				users: ctx.users,
				skills: compactPrompt ? [] : skills,
				displayChannelId: ctx.message.channel,
				displayChannelName: ctx.channelName,
				verbosity: channelVerbosity,
				model: currentModel,
			};
			const workspaceRuntimeContext = (compactPrompt ? existingCompactRuntimeContext(agent.state.messages) : undefined)
				?? buildWorkspaceRuntimeContext(sessionContextOptions);
			activeRuntimeContext = withDeliveryInstructions(workspaceRuntimeContext, runFormatInstructions);
			const sessionPreamble = buildSessionRoutingPreamble(sessionContextOptions);

			// Set up file upload function
			setUploadFunction(async (filePath: string, title?: string) => {
				const hostPath = translateToHostPath(filePath, awarenessDir, workspacePath);
				await ctx.uploadFile(hostPath, title);
			});

			log.logInfo(`[perf] run() pre-prompt setup: ${(performance.now() - tRun).toFixed(0)}ms`);

			// Reset per-run state
			beginRunState(runState, ctx, liveEventSink);
			resetYield(); // Clear any stale yield from previous run

			// Create queue for this run
			const runQueue = createRunQueue(ctx);
			runState.queue = runQueue.queue;

			// Log context info
			log.logInfo(`Context sizes - routing: ${sessionPreamble.length} chars, runtime: ${activeRuntimeContext.length} chars, workspace: ${workspaceContext.length} chars`);
			log.logInfo(`Channels: ${ctx.channels.length}, Users: ${ctx.users.length}`);

			const { finalUserMessage, imageAttachments } = buildUserPrompt(ctx, sessionPreamble, workspacePath, currentModel);

			const promptUserMessage: AgentMessage = {
				role: "user",
				content: [{ type: "text", text: finalUserMessage }, ...imageAttachments],
				timestamp: Date.now(),
			};
			const checkpointInput = forceHandoff
				? [...agent.state.messages]
				: [...agent.state.messages, promptUserMessage];
			const checkpointAtStart = compactionSettings.mode === "handoff"
				&& (compactionSettings.enabled || forceHandoff)
				&& !isClaudeCliProvider(currentModel.provider)
				&& !isCodexCliProvider(currentModel.provider)
				&& (forceHandoff || shouldRequestBoundedHandoff(
					estimateHandoffContextTokens(checkpointInput), currentModel.contextWindow || 200_000,
					compactionSettings.reserveTokens, compactionSettings.keepRecentTokens, localPrefillLimit,
				));

			// Debug: write context to last_prompt.jsonl
			const debugContext = {
				systemPrompt: activeSystemPrompt,
				runtimeContext: activeRuntimeContext,
				runtimeContextPlacement: "append-only-message",
				sessionPreamble,
				messages: currentSession.messages,
				newUserMessage: finalUserMessage,
				imageAttachmentCount: imageAttachments.length,
			};
			await writeFile(join(awarenessDir, "last_prompt.jsonl"), JSON.stringify(debugContext, null, 2));

			log.logInfo(`[awareness] Pre-prompt: ${currentSession.messages.length} messages in context`);

			const resolveCurrentModelCredential = async () => {
				if (getCodexCliRuntimeAuth(currentModel.provider) || getClaudeCliRuntimeAuth(currentModel.provider)) return;
				await resolveApiKey(modelRegistry, currentModel.provider);
			};
			const tPrompt = performance.now();
			if (checkpointAtStart) {
				runState.handoffRequested = true;
				runState.handoffContinue = !forceHandoff;
				beginTransition("handoff", forceHandoff ? "user" : "context_limit");
				try {
					// The triggering user input is legitimate durable history. The private
					// checkpoint response itself runs outside AgentSession and is never appended.
					if (!forceHandoff) {
						sm.appendMessage(promptUserMessage as Parameters<typeof sm.appendMessage>[0]);
						agent.state.messages = [...agent.state.messages, promptUserMessage];
					}
					const checkpoint = await generatePrivateCheckpoint(
						forceHandoff ? agent.state.messages : checkpointInput,
						currentModel,
						{ channel: ctx.message.channel, replyTarget: ctx.message.replyTarget || null },
					);
					runState.capturedHandoff = { publicText: "", handoff: checkpoint.handoff };
					runState.handoffContinue = forceHandoff ? false : true;
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					runState.stopReason = handoffRunAborted ? "aborted" : "error";
					runState.errorMessage = handoffRunAborted ? undefined : errMsg;
					log.logWarning(handoffRunAborted ? "Private checkpoint aborted" : "Private checkpoint failed", errMsg);
				}
			} else {
				userInputProvenance.track(finalUserMessage, readVerifiedSenderIdentity(ctx.message.senderIdentity, ctx.message.user));
				try {
					const gated = await runWithModelCredentialGate({
						resolveCredential: resolveCurrentModelCredential,
						prompt: async () => {
							acceptsSteering = true;
							await withToolOutputStream(claudeCliToolOutputHandler, async () => {
								await currentSession.prompt(finalUserMessage, {
									...(imageAttachments.length > 0 ? { images: imageAttachments } : {}),
									streamingBehavior: "steer" as const,
								});
							});
						},
					});
					if (gated.status === "credential_unavailable") {
						runState.stopReason = "error";
						runState.errorMessage = gated.error.message;
						runState.modelCredentialUnavailable = true;
						log.logWarning("Model credential unavailable; prompt skipped without provider output");
					}
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					runState.stopReason = "error";
					runState.errorMessage = errMsg;
					log.logWarning("Model prompt failed", errMsg);
				} finally {
					acceptsSteering = false;
				}
			}
			log.logInfo(`[perf] ${checkpointAtStart ? "private handoff" : "session.prompt"} (incl API): ${(performance.now() - tPrompt).toFixed(0)}ms`);

			// If overflow error triggered background compaction+retry, wait for it.
			if (runState.stopReason === "error" && !runState.modelCredentialUnavailable && !checkpointAtStart) {
				await agent.waitForIdle();

				const msgs = currentSession.messages;
				const last = msgs.filter((m) => m.role === "assistant").pop() as any;
				if (last && last.stopReason && last.stopReason !== "error") {
					runState.stopReason = last.stopReason;
					runState.errorMessage = undefined;
				}
			}

			if (!checkpointAtStart && runState.localPrefillRejected
				&& compactionSettings.enabled && compactionSettings.mode === "handoff") {
				runState.handoffRequested = true;
				runState.handoffContinue = true;
				beginTransition("handoff", "context_limit");
				try {
					const checkpoint = await generatePrivateCheckpoint(
						currentSession.messages,
						currentModel,
						{ channel: ctx.message.channel, replyTarget: ctx.message.replyTarget || null },
					);
					runState.capturedHandoff = { publicText: "", handoff: checkpoint.handoff };
					runState.stopReason = "stop";
					runState.errorMessage = undefined;
					log.logInfo("[handoff] Recovered a rejected local prefill through the bounded private path");
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					runState.stopReason = "error";
					runState.errorMessage = `${runState.localPrefillRejectionMessage ?? "Local prefill rejected"}; bounded recovery failed: ${errMsg}`;
					log.logWarning("Bounded checkpoint recovery failed", errMsg);
				}
			}

			// Retry one text-only turn when the active model failed its concrete
			// action contract. Claude needs an exact deferred MCP selection in
			// messages-only channels; GPT-5 keeps its planning-only act-now nudge.
			if (!toolLoopGuard.stopped && runState.stopReason !== "error" && !wasYielded() && !runState.handoffRequested) {
				const messages = currentSession.messages;
				const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
				const assistantText =
					lastAssistant?.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n") || "";

				const claudeDeliveryRetry = resolveClaudeCliDeliveryRetry({
					model: currentModel,
					verbosity: channelVerbosity,
					toolsUsed: runState.toolsUsed,
					directlyAddressed: ctx.message.directlyAddressed,
					eventType: ctx.message.eventType,
					replyTarget: ctx.message.replyTarget,
				});
				const retryInstruction = claudeDeliveryRetry
					?? detectPlanningOnlyTurn(assistantText, runState.toolsUsed, currentModel);
				if (retryInstruction) {
					const retrySource = claudeDeliveryRetry ? "claude-cli-delivery" : "gpt-steering";
					log.logInfo(`[${retrySource}] Text-only turn detected, retrying with an explicit action contract`);
					if (assistantText) log.logInfo(`[${retrySource}] Assistant said: "${assistantText.substring(0, 120)}..."`);
					try {
						const gated = await runWithModelCredentialGate({
							resolveCredential: resolveCurrentModelCredential,
							prompt: async () => {
								acceptsSteering = true;
								await withToolOutputStream(claudeCliToolOutputHandler, async () => {
									await currentSession.prompt(retryInstruction, {
										streamingBehavior: "steer" as const,
									});
								});
							},
						});
						if (gated.status === "credential_unavailable") {
							runState.stopReason = "error";
							runState.errorMessage = gated.error.message;
							runState.modelCredentialUnavailable = true;
							log.logWarning("Model credential unavailable; retry prompt skipped without provider output");
						}
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						runState.stopReason = "error";
						runState.errorMessage = errMsg;
						log.logWarning("Model retry prompt failed", errMsg);
					} finally {
						acceptsSteering = false;
					}
					log.logInfo(
						runState.modelCredentialUnavailable
							? `[${retrySource}] Retry prompt skipped for unavailable model credential`
							: `[${retrySource}] Retry prompt completed`,
					);
				}
			}

			// Wait for queued messages
			await runQueue.settled();

			if (toolLoopGuard.stopped) {
				runState.stopReason = "error";
				runState.errorMessage = TOOL_LOOP_STOP_MESSAGE;
				runState.handoffRequested = false;
				resumeAfterHandoff = false;
			}

			await deliverRunOutcome(ctx, runState, () => currentSession.messages, presentation);

			const durableMessageIds = assistantMessageIDsForRun();
			const presentationDurableMessageIds = claimNewAssistantMessageIDs();
			const assistantFinal = runState.assistantText.finalize({
				outcome: runState.stopReason === "error"
					? "failed"
					: runState.stopReason === "aborted"
						? "cancelled"
						: "completed",
				durableMessageIds,
				presentationDurableMessageIds,
			});
			emitAssistantTextEvent(assistantFinal);

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
				await runQueue.settled();
			}

			if (runState.handoffRequested) {
				if (runState.stopReason === "error" || runState.stopReason === "aborted" || !runState.capturedHandoff) {
					log.logWarning("[handoff] Terminal checkpoint missing or invalid; preserving the original context without rotation");
                    finishTransition(runState.stopReason === "aborted" ? "aborted" : "failed");
				} else {
					const id = transitions.getActiveTransition()?.id ?? randomUUID();
					const date = new Date().toISOString().slice(0, 10);
					const archivePath = join(awarenessDir, "history", date, `handoff-${id}.jsonl`);
					const tail = selectBoundedRecentDialogue(
						currentSession.messages,
						compactionSettings.keepRecentTokens,
					);
					const journal: HandoffRotationJournal = {
						version: 1,
						id,
						createdAt: new Date().toISOString(),
						archivePath,
						handoff: runState.capturedHandoff.handoff,
                        transition: transitions.getActiveTransition() ?? undefined,
						tail,
					};
					writeHandoffJournal(rotationJournalPath, journal);
					resetSessionState();
					await recoverRotation(journal);
					completedHandoffRotations++;
					resumeAfterHandoff = runState.handoffContinue && (journal.handoff.inProgress.some((item) => item.trim())
                        || journal.handoff.nextSteps.some((item) => item.trim()));
                    finishTransition("completed", {retainedMessages: tail.length});
					log.logInfo(`[handoff] Context rotated with ${tail.length} complete recent messages`);
				}
			}

			// Clear run state
			steeringProjections.dismissAll();
			userInputProvenance.clear();
			clearRunState(runState);

			log.logInfo(`[perf] TOTAL run(): ${(performance.now() - tRun).toFixed(0)}ms`);
			return {
				stopReason: runState.stopReason,
				errorMessage: runState.errorMessage,
				...(runState.modelCredentialUnavailable
					? { failureKind: "model_credential_unavailable" as const }
					: {}),
			};
		},

		abort(): void {
			handoffRunAborted = true;
			acceptsSteering = false;
			userInputProvenance.clear();
			privateHandoffAbortController?.abort(new Error("Private checkpoint cancelled"));
			if (!session) return;
			requestCompactionAbort();
			const cleared = session.clearQueue();
			if (cleared.steering.length > 0 || cleared.followUp.length > 0) {
				log.logInfo(`[awareness] Cleared ${cleared.steering.length} steering and ${cleared.followUp.length} follow-up message(s) during abort`);
			}
			void session.abort();
		},

		abortCompaction(): boolean {
			return requestCompactionAbort();
		},

		steer(text: string, options?: {
			projectionId?: string;
			deliveryId?: string;
			senderIdentity?: VerifiedSenderIdentity;
			onAccepted?: () => void | Promise<void>;
		}): Promise<void> | null {
			if (!session || !acceptsSteering) return null;
			const activeSession = session;
			if (options?.projectionId) {
				let forgetSender = () => {};
				const settlement = steeringProjections.track({
					id: options.projectionId,
					deliveryId: options.deliveryId,
					senderIdentity: options.senderIdentity,
					prompt: text,
					enqueue: () => {
						forgetSender = userInputProvenance.track(text, options.senderIdentity);
						return activeSession.steer(text).then(() => undefined);
					},
					onAccepted: options.onAccepted,
					waitForIdle: () => activeSession.waitForIdle(),
				});
				void settlement.catch((err: Error) => {
					forgetSender();
					log.logWarning(`[awareness] steer failed`, err.message);
				});
				return settlement;
			}
			const forgetSender = userInputProvenance.track(text, options?.senderIdentity);
			const settlement = activeSession.steer(text).then(async () => {
				await activeSession.waitForIdle();
			});
			void settlement.catch((err: Error) => {
				forgetSender();
				log.logWarning(`[awareness] steer failed`, err.message);
			});
			return settlement;
		},

		getCompactionStatus(): CompactionStatus | null {
			const compactionStatus = compaction.getStatus();
			return compactionStatus ? { ...compactionStatus } : null;
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
				contextUsage: session?.getContextUsage(),
				usage,
			};
		},

		async compact(instructions?: string): Promise<CompactResult> {
			if (isCliHarnessProvider(agent.state.model?.provider)) {
				throw new Error("The CLI harness owns compaction for CLI models; use /clear to start a fresh session.");
			}
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
			settingsManager.reload();
			if (settingsManager.getCompactionSettings().mode === "handoff") {
				if (messagesBefore === 0) throw new Error("No conversation to checkpoint.");
				if (runState.ctx) throw new Error("Wait for the active run to finish before compacting.");
				const noop = async () => {};
				const text = `Harness-requested continuity checkpoint. Preserve the current task without performing further work.${instructions ? `\nAdditional checkpoint guidance: ${instructions}` : ""}`;
				const maintenanceContext: MomContext = {
					message: { text, rawText: text, user: "harness", userName: "harness",
						channel: lastRunContext?.message.channel ?? "compaction", ts: String(Date.now()),
						replyTarget: lastRunContext?.message.replyTarget, sourceEventType: "handoff_compaction", attachments: [] },
					channels: lastRunContext?.channels ?? [], users: lastRunContext?.users ?? [],
					channelName: lastRunContext?.channelName,
					respond: noop, sendFinalResponse: noop, respondInThread: noop, setTyping: noop,
					uploadFile: noop, setWorking: noop, deleteMessage: noop, restartWorking: noop,
				};
				const before = completedHandoffRotations;
				forceHandoff = true;
				handoffRunAborted = false;
				try {
					// Use the ordinary warm provider path, but do not resume the task
					// during an explicit maintenance-only compaction operation.
					const result = await runSegment(maintenanceContext, new ChannelStore({ workingDir: workspaceDir, botToken: "" }), undefined, lastRunFormatInstructions);
					if (result.stopReason === "error" || result.stopReason === "aborted" || completedHandoffRotations === before) {
						throw new Error(result.errorMessage ?? "Checkpoint cancelled; original conversation preserved.");
					}
					return { messagesBefore, messagesAfter: getSessionManager().buildSessionContext().messages.length, tokensBefore: info.contextTokens };
				} finally {
					forceHandoff = false;
					resumeAfterHandoff = false;
				}
			}
			const MIN_COMPACT_TOKENS = 50000;
			if (info.contextTokens < MIN_COMPACT_TOKENS && info.contextTokens > 0) {
				throw new Error(`Context too small to compact (${log.formatTokens(info.contextTokens)} tokens, minimum ${log.formatTokens(MIN_COMPACT_TOKENS)})`);
			}

			// Run compaction — this generates the summary and updates
			// agent.messages in memory with the compacted view
			beginTransition("compaction", "user");
            let result;
            try { result = await currentSession.compact(instructions); }
            catch (error) { finishTransition("failed"); throw error; }

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
            finishTransition("completed", {tokensBefore: result.tokensBefore, retainedMessages: compactedMessages.length});

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
	const runSegment = runner.run.bind(runner);
	runner.run = async (ctx, store, pending, format, sink, completionID) => {
		toolLoopGuard.reset();
        rotationsAtRunStart = completedHandoffRotations;
		handoffRunAborted = false;
		return runHandoffSegments(async (continuation) => {
			const segmentContext: MomContext = continuation ? {
				...ctx,
				message: handoffContinuationMessage(ctx.message),
			} : ctx;
			const result = await runSegment(segmentContext, store, continuation ? undefined : pending, format, sink,
				continuation ? randomUUID() : completionID);
			return { result, resume: resumeAfterHandoff };
		}, () => handoffRunAborted);
	};
	const serializeOperation = createRunnerOperationQueue();
	const runCanonical = runner.run.bind(runner);
	const compactCanonical = runner.compact.bind(runner);
	runner.run = (...args) => serializeOperation(() => runCanonical(...args));
	runner.compact = (...args) => serializeOperation(() => compactCanonical(...args));
	startLiveModelCatalogRefresh(workspaceDir, modelRegistry);
	return runner;
}
