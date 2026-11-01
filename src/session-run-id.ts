import type { SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * Stamp each message entry persisted during a run with that run's live-feed id
 * (`entry.runId`, beside `id`/`timestamp`, never inside `message`, so it is not
 * sent to a model). The web UI keys its transient /live rendering to this id:
 * it hides only the durable rows of the exact run it is streaming, and keeps a
 * completed run's snapshot until that run's own durable reply has landed.
 *
 * Every SessionManager append funnels through `_appendEntry` before `_persist`,
 * so stamping there covers buffered and immediately flushed writes alike.
 */
export function stampRunId(
	manager: SessionManager,
	currentRunId: () => string | null,
	onStamped?: (entryId: string, runId: string) => void,
): SessionManager {
	const target = manager as unknown as { _appendEntry?: (entry: Record<string, unknown>) => void };
	const append = target._appendEntry;
	if (typeof append !== "function") return manager;
	target._appendEntry = function stampedAppendEntry(this: unknown, entry: Record<string, unknown>) {
		const runId = currentRunId();
		const stamp = runId && entry.type === "message" && entry.runId === undefined;
		if (stamp) entry.runId = runId;
		const result = append.call(this, entry);
		if (stamp && typeof entry.id === "string") onStamped?.(entry.id, runId);
		return result;
	};
	return manager;
}
