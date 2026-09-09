import type { MomContext, RunResult } from "./adapters/types.js";

/** Serialize state-owning operations; cancellation remains outside the queue. */
export function createRunnerOperationQueue(): <T>(operation: () => Promise<T>) => Promise<T> {
	let tail: Promise<unknown> = Promise.resolve();
	return <T>(operation: () => Promise<T>): Promise<T> => {
		const result = tail.then(operation, operation);
		tail = result.then(() => undefined, () => undefined);
		return result;
	};
}

export const HANDOFF_RESUME_INSTRUCTION = "Harness continuation after context rotation. The requested rotation has completed. Do not call handoff_context again to fulfill the same request. Continue the unfinished work recorded in the private continuity handoff. Completed actions and tool receipts are already settled: do not replay them. Honor the latest user corrections and all current boundaries. If no authorized work remains, report the outcome and stop.";

export function handoffContinuationMessage(message: MomContext["message"]): MomContext["message"] {
	return {
		...message, text: HANDOFF_RESUME_INSTRUCTION, rawText: HANDOFF_RESUME_INSTRUCTION,
		freshContext: false, attachments: [], deliveryId: undefined, senderIdentity: undefined,
		userName: "harness", sourceEventType: "handoff_continuation",
	};
}

/** Keep the canonical run open across rotations, without redelivering its input. */
export async function runHandoffSegments(
	run: (continuation: boolean) => Promise<{ result: RunResult; resume: boolean }>,
	isAborted: () => boolean,
): Promise<RunResult> {
	let continuation = false;
	for (;;) {
		if (isAborted()) return { stopReason: "aborted" };
		const { result, resume } = await run(continuation);
		if (isAborted()) return { stopReason: "aborted" };
		if (!resume || result.stopReason === "error" || result.stopReason === "aborted") return result;
		continuation = true;
	}
}
