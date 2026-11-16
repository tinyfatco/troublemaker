import { projectConciseWatchHistory, type ConciseWatchContextProjection } from "../console/concise-watch-context.js";
import { sanitizeMessages } from "../sanitize.js";

/**
 * Provider-history projection for Pi 1.x.
 *
 * Pi 1.x's AgentSession rebuilds every request from
 * `sessionManager.buildSessionProjection()`, so assigning
 * `agent.state.messages` no longer changes what reaches the provider. The
 * runner instead installs a `prepareRequest` hook on its Agent; AgentSession
 * calls that hook with the canonical context, and the hook applies the
 * history rules here.
 *
 * Only the history that existed when the run started is rewritten, matching
 * the pre-1.x behavior where the runner replaced `agent.state.messages` once
 * per run and the loop then appended the run's own messages unchanged.
 */

type RoleMessage = { role: string };

export interface ProviderHistoryRunConfig {
	/** Session leaf when the run started; null for an empty session. */
	runStartLeafId: string | null;
	conciseWatch: boolean;
}

export interface ProviderHistoryProjection<T> {
	messages: T[];
	/** Number of leading messages treated as pre-run history, or undefined when unknown. */
	historyMessageCount: number | undefined;
	conciseWatch?: ConciseWatchContextProjection<T>;
}

interface SessionProjectionLike {
	entries: ReadonlyArray<{ sourceEntry: { id: string }; messages: readonly unknown[] }>;
}

/**
 * Count the projected messages that belong to entries up to and including the
 * run-start leaf. Returns undefined when that leaf is no longer in the
 * projection (for example after a mid-run compaction or context rotation).
 */
export function countPreRunHistoryMessages(projection: SessionProjectionLike, runStartLeafId: string | null): number | undefined {
	if (runStartLeafId === null) return 0;
	const index = projection.entries.findIndex((entry) => entry.sourceEntry.id === runStartLeafId);
	if (index < 0) return undefined;
	let count = 0;
	for (let i = 0; i <= index; i++) count += projection.entries[i]!.messages.length;
	return count;
}

/**
 * Sanitize (and for concise_watch, bound) the pre-run history of a provider
 * request. Messages after the history boundary are returned unchanged. When
 * the boundary is unknown the whole context is sanitized and no concise
 * projection is applied.
 *
 * Pi 1.x carries the prompt and tool declarations in `role: "system"`
 * messages; the concise projection never drops them.
 */
export function projectProviderHistory<T extends RoleMessage>(
	messages: readonly T[],
	historyMessageCount: number | undefined,
	conciseWatch: boolean,
): ProviderHistoryProjection<T> {
	const boundary = historyMessageCount === undefined ? messages.length : Math.min(historyMessageCount, messages.length);
	const history = sanitizeMessages(messages.slice(0, boundary) as unknown as Parameters<typeof sanitizeMessages>[0]) as unknown as T[];
	const rest = messages.slice(boundary);
	if (!conciseWatch || historyMessageCount === undefined) {
		return { messages: [...history, ...rest], historyMessageCount };
	}
	const projection = projectConciseWatchHistory(history.filter((message) => message.role !== "system"));
	const kept = new Set<T>(projection.messages);
	return {
		messages: [...history.filter((message) => message.role === "system" || kept.has(message)), ...rest],
		historyMessageCount,
		conciseWatch: projection,
	};
}
