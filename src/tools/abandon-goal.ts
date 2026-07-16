import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { readGoalState, writeGoalState } from "../goal-state.js";
import { FilesystemWorkspaceStore } from "../storage/node/filesystem-workspace.js";

const MAX_REASON_LENGTH = 200;

const schema = Type.Object({
	reason: Type.Optional(Type.String({
		description: "Brief reason the active goal is no longer being pursued.",
		maxLength: MAX_REASON_LENGTH,
	})),
});

export function createAbandonGoalTool(workingDir: string): AgentTool<typeof schema> {
	const workspace = new FilesystemWorkspaceStore(workingDir);
	return {
		name: "abandon_goal",
		label: "abandon_goal",
		description:
			"Abandon the active goal when the user cancels, replaces, or redirects it, optionally recording a concise reason.",
		parameters: schema,
		execute: async (_toolCallId: string, params: unknown) => {
			const reason = normalizeReason((params as { reason?: unknown })?.reason);
			const current = readGoalState(workspace);
			if (!current) return textResult("No active goal found.", { status: "missing" });
			if (current.status !== "active") return textResult(`Goal is already ${current.status}.`, current);

			const next = {
				...current,
				status: "abandoned" as const,
				completedAt: new Date().toISOString(),
				...(reason ? { reason } : {}),
			};
			writeGoalState(workspace, next);
			return textResult(`Abandoned goal: ${current.goal}${reason ? ` (${reason})` : ""}`, next);
		},
	};
}

function normalizeReason(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error("abandon_goal reason must be a string.");
	const reason = value.trim();
	if (reason.length > MAX_REASON_LENGTH) {
		throw new Error(`abandon_goal reason must be ${MAX_REASON_LENGTH} characters or fewer.`);
	}
	return reason || undefined;
}

function textResult(text: string, details: unknown) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}
