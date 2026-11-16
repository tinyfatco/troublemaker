import type { Agent } from "@earendil-works/pi-agent-core";

/**
 * Agent hook fields that pi-coding-agent's AgentSession wraps when it is
 * constructed. AgentSession.dispose() does not unwrap them, so an Agent reused
 * across sessions (handoff rotation, /clear, compaction) would keep running a
 * disposed session's hooks. In Pi 1.x the stale `prepareRequest` replaces the
 * request transcript with the old SessionManager projection, so a rotated
 * context never reaches the model.
 */
const SESSION_HOOK_FIELDS = [
	"beforeToolCall",
	"afterToolCall",
	"finishTurn",
	"prepareRequest",
	"prepareNextTurn",
	"prepareNextTurnWithContext",
	"transformContext",
] as const;

export type AgentHookSnapshot = Pick<Agent, (typeof SESSION_HOOK_FIELDS)[number]>;

export function snapshotAgentHooks(agent: Agent): AgentHookSnapshot {
	return Object.fromEntries(SESSION_HOOK_FIELDS.map((field) => [field, agent[field]])) as AgentHookSnapshot;
}

export function restoreAgentHooks(agent: Agent, snapshot: AgentHookSnapshot): void {
	for (const field of SESSION_HOOK_FIELDS) (agent as any)[field] = snapshot[field];
}
