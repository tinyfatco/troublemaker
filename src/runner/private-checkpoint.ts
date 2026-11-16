/**
 * Private handoff checkpoint: a bounded, out-of-session provider call that
 * forces a single `handoff_context` tool call and validates its arguments.
 * The response never enters the AgentSession transcript.
 */
import { type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { convertToLlm, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "crypto";
import { getClaudeCliRuntimeAuth } from "../claude-cli.js";
import { getCodexCliRuntimeAuth } from "../codex-cli.js";
import { compactInitialRuntimePrefix } from "../core/compact-prompt.js";
import {
	estimateHandoffContextTokens,
	handoffToolInstruction,
	privateHandoffInputTokens,
	selectBoundedCheckpointTranscript,
} from "../handoff-compaction.js";
import { cancelInferenceRequest, exceedsLocalPrefillLimit, uncachedPrefillTokens, watchInferenceProgress } from "../inference-progress.js";
import * as log from "../log.js";
import { resolveApiKey, type resolveModelWithAuth } from "../model-config.js";
import { boundCompactionStreamOptions, normalizeSimpleStreamOptionsForModel } from "../model-thinking.js";
import { parseHandoffContextArguments } from "../tools/handoff-context.js";

type RunnerModel = ReturnType<typeof resolveModelWithAuth>;

export interface PrivateCheckpointDeps {
	tools: AgentTool<any>[];
	modelRegistry: ModelRegistry;
	compactPrompt: boolean;
	localProgressURL: URL | undefined;
	localPrefillLimit: number | undefined;
	getActiveSystemPrompt: () => string;
	getActiveRuntimeContext: () => string;
	/** Publish (or clear, with null) the controller so abort() can cancel the call. */
	setAbortController: (controller: AbortController | null) => void;
	getAbortController: () => AbortController | null;
}

export function resolvePrivateCheckpointTimeoutMs(): number {
	const value = Number(process.env.TROUBLEMAKER_PRIVATE_HANDOFF_TIMEOUT_MS);
	return Number.isSafeInteger(value) && value >= 10_000 && value <= 300_000 ? value : 120_000;
}

export function createPrivateCheckpointGenerator(deps: PrivateCheckpointDeps) {
	const { tools, modelRegistry, compactPrompt, localProgressURL, localPrefillLimit } = deps;
	const privateCheckpointTimeoutMs = resolvePrivateCheckpointTimeoutMs();
	return async (
		messages: readonly AgentMessage[],
		currentModel: RunnerModel,
		routing: { channel: string; replyTarget: string | null },
	) => {
		const activeRuntimeContext = deps.getActiveRuntimeContext();
		const inputLimit = privateHandoffInputTokens();
		const runtimeCharLimit = Math.max(1024, Math.floor(inputLimit * 0.35) * 4);
		const boundedRuntimeContext = activeRuntimeContext.length <= runtimeCharLimit
			? activeRuntimeContext
			: `${activeRuntimeContext.slice(0, Math.floor(runtimeCharLimit * 0.6))}\n[Middle workspace snapshot omitted by private prefill budget]\n${activeRuntimeContext.slice(-Math.floor(runtimeCharLimit * 0.4))}`;
		const currentRuntimeSnapshot: AgentMessage | null = boundedRuntimeContext.trim() ? {
			role: "custom", customType: "runtime-context", content: boundedRuntimeContext, display: false, timestamp: 0,
		} : null;
		const runtimeTokens = currentRuntimeSnapshot ? estimateHandoffContextTokens([currentRuntimeSnapshot]) : 0;
		const transcript = selectBoundedCheckpointTranscript(messages, Math.max(1024, inputLimit - runtimeTokens));
		const checkpointMessages = currentRuntimeSnapshot ? [...transcript, currentRuntimeSnapshot] : transcript;
		const sourceTokens = estimateHandoffContextTokens(messages);
		const projectedTokens = estimateHandoffContextTokens(checkpointMessages);
		if (projectedTokens > inputLimit) throw new Error(`Private checkpoint projection exceeded its ${inputLimit}-token limit`);
		const providerMessages = (compactPrompt ? compactInitialRuntimePrefix(checkpointMessages) : checkpointMessages)
			.flatMap((message) => convertToLlm([message]));
		providerMessages.push(...convertToLlm([{
			role: "user", content: [{ type: "text", text: handoffToolInstruction() }], timestamp: 0,
		}]));
		const handoffTool = tools.find((tool) => tool.name === "handoff_context");
		if (!handoffTool) throw new Error("Private checkpoint tool is unavailable");
		const privateContext = {
			systemPrompt: deps.getActiveSystemPrompt(),
			messages: providerMessages,
			tools: [{ name: handoffTool.name, description: handoffTool.description, parameters: handoffTool.parameters }],
		};
		const apiKey = getCodexCliRuntimeAuth(currentModel.provider)
			?? getClaudeCliRuntimeAuth(currentModel.provider)
			?? await resolveApiKey(modelRegistry, currentModel.provider);
		const requestId = `chatcmpl-private-handoff-${randomUUID()}`;
		const controller = new AbortController();
		deps.setAbortController(controller);
		const timer = setTimeout(() => controller.abort(new Error(`Private checkpoint exceeded ${privateCheckpointTimeoutMs}ms`)), privateCheckpointTimeoutMs);
		timer.unref?.();
		let stopProgress = () => {};
		try {
			let options = normalizeSimpleStreamOptionsForModel(currentModel, {
				apiKey,
				signal: controller.signal,
				timeoutMs: privateCheckpointTimeoutMs,
				maxRetries: 0,
				maxTokens: 1536,
				temperature: 0,
				reasoning: "minimal",
				headers: localProgressURL ? {
					"x-mtplx-request-id": requestId,
					"x-mtplx-session-id": requestId,
				} : undefined,
				samplingParams: {
					enable_thinking: false,
					tool_choice: { type: "function", function: { name: "handoff_context" } },
				},
			});
			options = boundCompactionStreamOptions(privateContext, options);
			const stream = streamSimple(currentModel, privateContext, options);
			if (localProgressURL) stopProgress = watchInferenceProgress(localProgressURL, requestId, (progress) => {
				if (localPrefillLimit !== undefined && exceedsLocalPrefillLimit(progress, localPrefillLimit)) {
					const uncached = uncachedPrefillTokens(progress);
					void cancelInferenceRequest(localProgressURL, requestId, { apiKey });
					controller.abort(new Error(`Private checkpoint prefill rejected: ${uncached} uncached tokens exceeds ${localPrefillLimit}`));
				}
			}, { apiKey });
			const assistant = await stream.result();
			if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
				throw new Error(assistant.errorMessage || `Private checkpoint ${assistant.stopReason}`);
			}
			const calls = assistant.content.filter((part) => part.type === "toolCall");
			const leaked = assistant.content.some((part) =>
				(part.type === "text" && part.text.trim())
				|| (part.type === "thinking" && part.thinking.trim()));
			if (calls.length !== 1 || calls[0].name !== "handoff_context" || leaked) {
				throw new Error("Private checkpoint returned an invalid structured response");
			}
			const parsed = parseHandoffContextArguments(calls[0].arguments, routing);
			log.logInfo(`[handoff] Private checkpoint validated source_tokens=${sourceTokens} projected_tokens=${projectedTokens}`);
			return { ...parsed, sourceTokens, projectedTokens };
		} finally {
			clearTimeout(timer);
			stopProgress();
			if (controller.signal.aborted && localProgressURL) {
				const cancelled = await cancelInferenceRequest(localProgressURL, requestId, { apiKey });
				log.logInfo(`[handoff] Server-side cancellation ${cancelled ? "accepted" : "unavailable"} for ${requestId}`);
			}
			if (deps.getAbortController() === controller) deps.setAbortController(null);
		}
	};
}
