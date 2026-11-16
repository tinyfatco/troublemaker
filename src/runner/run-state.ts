/**
 * Mutable state for the run currently in progress, plus the per-run platform
 * output queue. One RunState lives for the lifetime of a runner; it is reset
 * at the start of every run and cleared when the run finishes.
 */
import type { MomContext } from "../adapters/types.js";
import type { ProviderHistoryRunConfig } from "../core/provider-history.js";
import type { RuntimeEventSink } from "../core/runtime-contract.js";
import type { extractStructuredHandoff } from "../handoff-compaction.js";
import * as log from "../log.js";
import { AssistantTextProjection } from "../streaming/assistant-text-projection.js";
import { LiveAssistantSnapshot } from "../streaming/live-turn-snapshot.js";

export interface RunQueue {
	enqueue(fn: () => Promise<void>, errorContext: string): Promise<void>;
	enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog?: boolean): void;
}

export interface RunUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface PendingTool {
	toolName: string;
	args: unknown;
	startTime: number;
	label: string;
	show: boolean;
}

export interface RunState {
	ctx: MomContext | null;
	logCtx: { channelId: string; userName?: string; channelName?: string } | null;
	queue: RunQueue | null;
	pendingTools: Map<string, PendingTool>;
	toolsUsed: string[];
	totalUsage: RunUsage;
	stopReason: string;
	errorMessage: string | undefined;
	modelCredentialUnavailable: boolean;
	localPrefillRejected: boolean;
	localPrefillRejectionMessage: string | undefined;
	initialPromptSent: boolean;
	liveSnapshot: LiveAssistantSnapshot;
	assistantText: AssistantTextProjection;
	liveEventSink: RuntimeEventSink | null;
	completionID: string;
	runStartLeafID: string | null;
	/** Provider-history rules for the active run; see core/provider-history.ts. */
	providerHistory: ProviderHistoryRunConfig | null;
	claimedAssistantMessageIDs: Set<string>;
	handoffRequested: boolean;
	toolHandoff: boolean;
	handoffContinue: boolean;
	capturedHandoff: ReturnType<typeof extractStructuredHandoff>;
}

function emptyUsage(): RunUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function createRunState(): RunState {
	return {
		ctx: null,
		logCtx: null,
		queue: null,
		pendingTools: new Map(),
		toolsUsed: [],
		totalUsage: emptyUsage(),
		stopReason: "stop",
		errorMessage: undefined,
		modelCredentialUnavailable: false,
		localPrefillRejected: false,
		localPrefillRejectionMessage: undefined,
		initialPromptSent: false,
		liveSnapshot: new LiveAssistantSnapshot(),
		assistantText: new AssistantTextProjection(),
		liveEventSink: null,
		completionID: "",
		runStartLeafID: null,
		providerHistory: null,
		claimedAssistantMessageIDs: new Set(),
		handoffRequested: false,
		toolHandoff: false,
		handoffContinue: true,
		capturedHandoff: null,
	};
}

/** Reset per-run fields at the start of a run (after the prompt is assembled). */
export function beginRunState(runState: RunState, ctx: MomContext, liveEventSink: RuntimeEventSink | undefined): void {
	runState.ctx = ctx;
	runState.logCtx = {
		channelId: ctx.message.channel,
		userName: ctx.message.userName,
		channelName: ctx.channelName,
	};
	runState.pendingTools.clear();
	runState.toolsUsed = [];
	runState.totalUsage = emptyUsage();
	runState.stopReason = "stop";
	runState.errorMessage = undefined;
	runState.modelCredentialUnavailable = false;
	runState.localPrefillRejected = false;
	runState.localPrefillRejectionMessage = undefined;
	runState.initialPromptSent = false;
	runState.liveSnapshot.reset();
	runState.liveEventSink = liveEventSink ?? null;
	runState.claimedAssistantMessageIDs.clear();
	runState.handoffRequested = false;
	runState.toolHandoff = false;
	runState.handoffContinue = true;
	runState.capturedHandoff = null;
}

/** Drop references to the finished run's context and sinks. */
export function clearRunState(runState: RunState): void {
	runState.ctx = null;
	runState.logCtx = null;
	runState.queue = null;
	runState.liveSnapshot.reset();
	runState.liveEventSink = null;
	runState.completionID = "";
	runState.runStartLeafID = null;
	runState.providerHistory = null;
}

/** Message length limit */
export const MAX_MESSAGE_LENGTH = 40000;

export function splitMessage(text: string): string[] {
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
}

/**
 * Serialize platform output for one run. Failures are logged and reported in
 * the thread; they never reject the chain. `settled()` resolves once every
 * item enqueued so far has finished.
 */
export function createRunQueue(ctx: MomContext): { queue: RunQueue; settled(): Promise<void> } {
	let queueChain = Promise.resolve();
	const queue: RunQueue = {
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
	return { queue, settled: () => queueChain };
}
