import type { WorkspaceStore } from "./storage/workspace.js";

export type GoalStatus = "active" | "blocked" | "completed" | "abandoned";

export interface GoalState {
	goal: string;
	setAt: string;
	status: GoalStatus;
	completedAt?: string;
	blockedAt?: string;
	reason?: string;
}

export const GOAL_STATE_PATH = "goal.json";

export function readGoalState(workspace: WorkspaceStore): GoalState | null {
	const raw = workspace.readText(GOAL_STATE_PATH);
	if (!raw) return null;

	try {
		return parseGoalState(JSON.parse(raw));
	} catch {
		return null;
	}
}

export function writeGoalState(workspace: WorkspaceStore, state: GoalState): void {
	workspace.writeText(GOAL_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

export function renderGoalContext(state: GoalState | null): string {
	if (!state) return "";
	if (state.status === "active") {
		return [
			`Current goal [ACTIVE]: ${state.goal}`,
			`Set at: ${state.setAt}`,
			"Persist toward this goal across automatic continuation turns until it is complete, impossible, or the user redirects you.",
		].join("\n");
	}
	if (state.status === "blocked") {
		return [
			`Current goal [BLOCKED]: ${state.goal}`,
			`Set at: ${state.setAt}`,
			...(state.reason ? [`Blocked because: ${state.reason}`] : []),
			"This goal will not continue automatically. Use set_goal only when the user explicitly asks to resume or replace it.",
		].join("\n");
	}
	return "";
}

export function blockActiveGoal(workspace: WorkspaceStore, reason: string): GoalState | null {
	const current = readGoalState(workspace);
	if (!current || current.status !== "active") return current;

	const next: GoalState = {
		...current,
		status: "blocked",
		blockedAt: new Date().toISOString(),
		reason,
	};
	writeGoalState(workspace, next);
	return next;
}

export function parseGoalState(raw: unknown): GoalState | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const record = raw as Record<string, unknown>;
	if (typeof record.goal !== "string" || !record.goal.trim()) return null;
	if (record.status !== "active" && record.status !== "blocked" && record.status !== "completed" && record.status !== "abandoned") return null;
	if (typeof record.setAt !== "string" || !record.setAt.trim()) return null;

	return {
		goal: record.goal.trim(),
		setAt: record.setAt,
		status: record.status,
		...(typeof record.completedAt === "string" ? { completedAt: record.completedAt } : {}),
		...(typeof record.blockedAt === "string" ? { blockedAt: record.blockedAt } : {}),
		...(typeof record.reason === "string" ? { reason: record.reason } : {}),
	};
}
