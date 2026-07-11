export interface WorkingRolloverToolCompletion {
	toolName: string;
	isError: boolean;
	args: unknown;
	result: unknown;
	activeReplyTarget?: string;
}

/**
 * A successful send_message to the current delivery locus is a chronological
 * boundary. Later harness labels should open a fresh working message after the
 * user-visible send instead of continuing to edit an older message above it.
 */
export function shouldRolloverWorkingAfterToolCompletion(
	completion: WorkingRolloverToolCompletion,
): boolean {
	if (completion.toolName !== "send_message" || completion.isError || !completion.activeReplyTarget) {
		return false;
	}

	const args = completion.args && typeof completion.args === "object"
		? completion.args as { target?: unknown }
		: {};
	const target = typeof args.target === "string" ? args.target.trim() : "";
	if (!target || target !== completion.activeReplyTarget) return false;

	const result = completion.result && typeof completion.result === "object"
		? completion.result as { details?: unknown }
		: {};
	const details = result.details && typeof result.details === "object"
		? result.details as { delivered?: unknown }
		: {};

	return details.delivered === true;
}
