/**
 * Deliver the outcome of a run to the platform: a redacted runtime error, the
 * final assistant text, or nothing (yield_no_action, private checkpoints, or
 * unavailable model credentials). Also captures a text-form handoff checkpoint.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MomContext } from "../adapters/types.js";
import { extractStructuredHandoff } from "../handoff-compaction.js";
import * as log from "../log.js";
import { resetYield, wasYielded } from "../tools/yield-no-action.js";
import type { RunPresentation } from "./presentation.js";
import { formatUserVisibleError } from "./prompt-message.js";
import { MAX_MESSAGE_LENGTH, type RunState } from "./run-state.js";

export async function deliverRunOutcome(
	ctx: MomContext,
	runState: RunState,
	getMessages: () => AgentMessage[],
	presentation: Pick<RunPresentation, "emitLiveEvent" | "closeAssistantPresentation">,
): Promise<void> {
	const { emitLiveEvent, closeAssistantPresentation } = presentation;
	// Handle error case. Missing model credentials are an operational
	// condition, not assistant-authored conversation content. Failing quiet
	// prevents one resident's auth outage from becoming another resident's
	// inbound message and feedback-loop trigger.
	if (runState.stopReason === "error" && runState.errorMessage) {
		if (runState.modelCredentialUnavailable) {
			log.logWarning("Model credential unavailable; no user-visible runtime error posted");
		} else {
			try {
				const visibleError = formatUserVisibleError(runState.errorMessage);
				const userErrorMsg = `_Sorry, something went wrong: ${visibleError}_`;
				const errorEvent = { type: "error" as const, message: visibleError };
				closeAssistantPresentation();
				emitLiveEvent(errorEvent);
				ctx.emitContentBlock?.(errorEvent);
				await ctx.sendFinalResponse(userErrorMsg, { force: true });
				await ctx.respondInThread(`_Error: ${visibleError}_`);
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				log.logWarning("Failed to post error message", errMsg);
			}
		}
	} else {
		// Final message update
		const messages = getMessages();
		const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
		const rawFinalTextParts = lastAssistant?.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text) ?? [];
		const rawFinalText = rawFinalTextParts.join("");
		runState.capturedHandoff = runState.capturedHandoff ?? (runState.handoffRequested
			? extractStructuredHandoff(rawFinalText, {
				channel: ctx.message.channel,
				replyTarget: ctx.message.replyTarget || null,
			})
			: null);
		if (runState.handoffRequested && !runState.capturedHandoff && runState.stopReason !== "aborted") {
			runState.stopReason = "error";
			runState.errorMessage = "Could not create a valid continuity checkpoint. The conversation was preserved and no continuation was started.";
			const errorEvent = { type: "error" as const, message: runState.errorMessage };
			emitLiveEvent(errorEvent);
			ctx.emitContentBlock?.(errorEvent);
			await ctx.sendFinalResponse(runState.errorMessage);
		}
		// Checkpoint generation is private harness work. Its prose must never
		// become a platform response; the continuation supplies user-visible text.
		const finalText = runState.handoffRequested ? "" : rawFinalTextParts.join("\n");

		// Check if yield_no_action was called — skip posting final response
		if (wasYielded()) {
			log.logInfo("yield_no_action — no output posted");
			resetYield();
		} else if (runState.stopReason !== "error" && finalText.trim() && !finalText.trim().startsWith("(Empty response:") && !finalText.trim().startsWith("{'content':")) {
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
}
