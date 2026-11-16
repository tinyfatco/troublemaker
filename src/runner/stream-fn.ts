/**
 * The runner's provider stream boundary: shapes request options (compaction
 * bounds, model-specific normalization, forced checkpoint tool calls), routes
 * CLI-harness models to their own streams, applies the compact prompt and
 * input budget, and watches local inference prefill progress.
 */
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { randomUUID } from "crypto";
import { isClaudeCliProvider, type createClaudeCliStream } from "../claude-cli.js";
import { isCodexCliProvider, type createCodexCliStream } from "../codex-cli.js";
import { compactToolContext, restoreCompactToolStream } from "../core/compact-tool-surface.js";
import type { InputBudget } from "../core/input-budget.js";
import { toLegacyContext } from "../core/legacy-context.js";
import { cancelInferenceRequest, exceedsLocalPrefillLimit, uncachedPrefillTokens, watchInferenceProgress } from "../inference-progress.js";
import * as log from "../log.js";
import { boundCompactionStreamOptions, normalizeSimpleStreamOptionsForModel } from "../model-thinking.js";
import type { RunState } from "./run-state.js";

export interface RunnerStreamFnDeps {
	runState: RunState;
	compactPrompt: boolean;
	inputBudget: InputBudget | undefined;
	localProgressURL: URL | undefined;
	localPrefillLimit: number | undefined;
	claudeCliStream: ReturnType<typeof createClaudeCliStream>;
	codexCliStream: ReturnType<typeof createCodexCliStream>;
}

export function createRunnerStreamFn(deps: RunnerStreamFnDeps): StreamFn {
	const { runState, compactPrompt, inputBudget, localProgressURL, localPrefillLimit, claudeCliStream, codexCliStream } = deps;
	const streamFn: StreamFn = (streamModel, transcript, options) => {
		const context = toLegacyContext(transcript);
		const boundedOptions = boundCompactionStreamOptions(context, options);
		let normalizedOptions = normalizeSimpleStreamOptionsForModel(streamModel, boundedOptions);
		if (runState.handoffRequested) {
			normalizedOptions = {
				...normalizedOptions,
				maxTokens: Math.min(normalizedOptions?.maxTokens ?? 1536, 1536),
				temperature: 0,
				samplingParams: {
					...normalizedOptions?.samplingParams,
					enable_thinking: false,
					tool_choice: { type: "function", function: { name: "handoff_context" } },
				},
			};
		}
		if (isCodexCliProvider(streamModel.provider)) return codexCliStream(streamModel, context, normalizedOptions);
		if (isClaudeCliProvider(streamModel.provider)) return claudeCliStream(streamModel, context, normalizedOptions);
		const requestId = `chatcmpl-${randomUUID()}`;
		const prefillAbort = localProgressURL ? new AbortController() : undefined;
		if (prefillAbort) {
			const upstreamSignal = normalizedOptions?.signal;
			if (upstreamSignal) {
				if (upstreamSignal.aborted) prefillAbort.abort(upstreamSignal.reason);
				else upstreamSignal.addEventListener("abort", () => prefillAbort.abort(upstreamSignal.reason), { once: true });
			}
			normalizedOptions = {
				...normalizedOptions,
				signal: prefillAbort.signal,
				maxRetries: 0,
				headers: { ...normalizedOptions?.headers, "x-mtplx-request-id": requestId },
			};
			prefillAbort.signal.addEventListener("abort", () => {
				void cancelInferenceRequest(localProgressURL!, requestId, { apiKey: normalizedOptions?.apiKey });
			}, { once: true });
		}
		const boundedContext = inputBudget ? inputBudget.project(context, runState.handoffRequested) : context;
		const result = streamSimple(
			streamModel,
			compactPrompt ? compactToolContext(boundedContext) : boundedContext,
			normalizedOptions,
		);
		if (localProgressURL) {
			const sink = runState.liveEventSink;
			const responseContext = runState.ctx;
			const stop = watchInferenceProgress(localProgressURL, requestId, (processing) => {
				if (localPrefillLimit !== undefined && exceedsLocalPrefillLimit(processing, localPrefillLimit)) {
					const uncached = uncachedPrefillTokens(processing);
					runState.localPrefillRejected = true;
					runState.localPrefillRejectionMessage = `Local prefill rejected: ${uncached} uncached tokens exceeds the ${localPrefillLimit}-token safety limit`;
					log.logWarning(`[inference] Rejected local prefill: ${uncached} uncached tokens exceeds ${localPrefillLimit}`);
					prefillAbort?.abort(new Error(runState.localPrefillRejectionMessage));
					return;
				}
				const event = { type: "status", status: "processing", processing } as const;
				try { void Promise.resolve(sink?.(event)).catch(() => {}); } catch { /* Best effort. */ }
				try { responseContext?.emitContentBlock?.(event); } catch { /* Best effort. */ }
			}, { apiKey: normalizedOptions?.apiKey });
			void result.result().then(stop, stop);
		}
		return compactPrompt ? restoreCompactToolStream(result, {
			role: "assistant", content: [], api: streamModel.api, provider: streamModel.provider, model: streamModel.id,
			stopReason: "error", timestamp: Date.now(),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		}) : result;
	};
	return streamFn;
}
