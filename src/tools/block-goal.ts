import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { blockActiveGoal, readGoalState } from "../goal-state.js";
import { FilesystemWorkspaceStore } from "../storage/node/filesystem-workspace.js";

const MAX_REASON_LENGTH = 200;

const schema = Type.Object({
	reason: Type.String({
		description: "Concise blocking condition that requires user input or an external state change.",
		minLength: 1,
		maxLength: MAX_REASON_LENGTH,
		pattern: "\\S",
	}),
});

export function createBlockGoalTool(workingDir: string): AgentTool<typeof schema> {
	const workspace = new FilesystemWorkspaceStore(workingDir);
	return {
		name: "block_goal",
		label: "block_goal",
		description:
			"Stop automatic continuation only after the same blocking condition has repeated for at least three consecutive goal turns and no meaningful progress is possible without user input or an external state change. Do not use this merely because work is difficult, incomplete, uncertain, or would benefit from clarification.",
		parameters: schema,
		execute: async (_toolCallId: string, params: unknown) => {
			const reason = normalizeReason((params as { reason?: unknown })?.reason);
			const current = readGoalState(workspace);
			if (!current) return textResult("No active goal found.", { status: "missing" });
			if (current.status !== "active") return textResult(`Goal is already ${current.status}.`, current);

			const next = blockActiveGoal(workspace, reason);
			return textResult(`Blocked goal: ${current.goal} (${reason})`, next);
		},
	};
}

function normalizeReason(value: unknown): string {
	if (typeof value !== "string") throw new Error("block_goal requires a reason string.");
	const reason = value.trim();
	if (!reason) throw new Error("block_goal requires a non-empty reason.");
	if (reason.length > MAX_REASON_LENGTH) {
		throw new Error(`block_goal reason must be ${MAX_REASON_LENGTH} characters or fewer.`);
	}
	return reason;
}

function textResult(text: string, details: unknown) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}
