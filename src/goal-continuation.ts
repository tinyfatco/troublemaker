import type { MomContext, MomEvent } from "./adapters/types.js";
import type { GoalState } from "./goal-state.js";

export const GOAL_CONTINUATION_SOURCE_EVENT = "goal_continuation";
export const GOAL_TERMINAL_ERROR_REASON = "Automatic continuation stopped after a terminal run error.";

export type GoalContinuationDecision = "continue" | "block" | "stop";

export interface GoalContinuationDecisionInput {
	goal: GoalState | null;
	stopReason: string;
	stopRequested: boolean;
	interruptRequested: boolean;
	runtimeRunning: boolean;
	queuedRuns: number;
}

/**
 * Mirror Codex's idle-turn gate: only an active goal starts automatic work,
 * queued user/client work wins, explicit aborts stop, and terminal errors
 * block the goal so a broken turn cannot spin forever.
 */
export function decideGoalContinuation(input: GoalContinuationDecisionInput): GoalContinuationDecision {
	if (!input.goal || input.goal.status !== "active") return "stop";
	if (input.stopReason === "error") return "block";
	if (input.stopReason === "aborted") return "stop";
	if (input.stopRequested || input.interruptRequested || !input.runtimeRunning) return "stop";
	if (input.queuedRuns > 0) return "stop";
	return "continue";
}

export function buildGoalContinuationPrompt(turnNumber: number, resumedAfterRestart = false): string {
	const origin = resumedAfterRestart
		? "The runtime restarted while this goal was active."
		: "The previous turn became idle while this goal remained active.";
	return `[GOAL CONTINUATION]\n${origin}\n\nContinue working toward the active goal in the latest session context. This is internal runtime continuation, not a new user message. Do not stop merely because a turn ended. Make concrete progress, verify the real end state, and call complete_goal only when the objective is actually achieved. If the user has cancelled or redirected the objective, call abandon_goal. Call block_goal only after the same blocking condition has repeated for at least three consecutive goal turns and no meaningful progress remains without user input or an external state change.\n\nAutomatic goal turn: ${turnNumber}`;
}

export function createGoalContinuationEvent(
	base: MomEvent,
	turnNumber: number,
	resumedAfterRestart = false,
): MomEvent {
	const text = buildGoalContinuationPrompt(turnNumber, resumedAfterRestart);
	return {
		...base,
		text,
		rawText: text,
		freshContext: false,
		sourceEventType: GOAL_CONTINUATION_SOURCE_EVENT,
		files: [],
		attachments: [],
	};
}

export function applyGoalContinuationIdentity(ctx: MomContext): void {
	ctx.message.user = "goal";
	ctx.message.userName = "goal";
	ctx.message.sourceEventType = GOAL_CONTINUATION_SOURCE_EVENT;
	ctx.message.attachments = [];
}

export function isGoalContinuationEvent(event: Pick<MomEvent, "sourceEventType">): boolean {
	return event.sourceEventType === GOAL_CONTINUATION_SOURCE_EVENT;
}
