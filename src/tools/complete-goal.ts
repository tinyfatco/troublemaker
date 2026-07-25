import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { readGoalState, writeGoalState } from "../goal-state.js";
import { FilesystemWorkspaceStore } from "../storage/node/filesystem-workspace.js";

const schema = Type.Object({});

export function createCompleteGoalTool(workingDir: string): AgentTool<typeof schema> {
	const workspace = new FilesystemWorkspaceStore(workingDir);
	return {
		name: "complete_goal",
		label: "complete_goal",
		description:
			"Mark the active goal completed once its objective has actually been achieved. Do not close a goal merely because the current turn is ending.",
		parameters: schema,
		execute: async () => {
			const current = readGoalState(workspace);
			if (!current) return textResult("No active goal found.", { status: "missing" });
			if (current.status !== "active") return textResult(`Goal is already ${current.status}.`, current);

			const next = {
				...current,
				status: "completed" as const,
				completedAt: new Date().toISOString(),
			};
			writeGoalState(workspace, next);
			return textResult(`Completed goal: ${current.goal}`, next);
		},
	};
}

function textResult(text: string, details: unknown) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}
