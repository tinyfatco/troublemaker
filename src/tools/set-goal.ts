import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { writeGoalState } from "../goal-state.js";
import { FilesystemWorkspaceStore } from "../storage/node/filesystem-workspace.js";

const MAX_GOAL_LENGTH = 500;

const schema = Type.Object({
	goal: Type.String({
		description: "The concrete objective to persist across turns.",
		minLength: 1,
		maxLength: MAX_GOAL_LENGTH,
		pattern: "\\S",
	}),
});

export function createSetGoalTool(workingDir: string): AgentTool<typeof schema> {
	const workspace = new FilesystemWorkspaceStore(workingDir);
	return {
		name: "set_goal",
		label: "set_goal",
		description:
			"Set or replace this agent's active goal. The goal persists across turns and is surfaced at the start of every subsequent turn until completed or abandoned. Use this when the user explicitly establishes a persistent objective or asks to set a goal; do not infer a durable goal from an ordinary one-turn request.",
		parameters: schema,
		execute: async (_toolCallId: string, params: unknown) => {
			const goal = normalizeGoal((params as { goal?: unknown })?.goal);
			const state = {
				goal,
				setAt: new Date().toISOString(),
				status: "active" as const,
			};
			writeGoalState(workspace, state);
			return {
				content: [{ type: "text" as const, text: `Set active goal: ${state.goal}` }],
				details: state,
			};
		},
	};
}

function normalizeGoal(value: unknown): string {
	if (typeof value !== "string") throw new Error("set_goal requires a goal string.");
	const goal = value.trim();
	if (!goal) throw new Error("set_goal requires a non-empty goal.");
	if (goal.length > MAX_GOAL_LENGTH) {
		throw new Error(`set_goal goal must be ${MAX_GOAL_LENGTH} characters or fewer.`);
	}
	return goal;
}
