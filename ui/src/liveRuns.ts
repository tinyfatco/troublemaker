import type { AwarenessEntry, ContentBlock } from './types';

/**
 * Turns started outside this web view (Zulip, Slack, SMS, Paint, another tab)
 * never reach the view's own POST stream, so before this the chat only showed
 * their reply once the durable entries landed. The shared /live feed already
 * carries a sanitized cumulative `assistant_snapshot` for every run; this
 * module folds those into one transient streaming entry per run.
 *
 * Identity is exact, never inferred from source or timing:
 * - this tab's own sends are recognized only by the run id announced on their
 *   POST stream (`{type:'run'}`); without that handshake a run renders as
 *   foreign (fail open: visible, never silently hidden);
 * - a live run hides only durable rows stamped with its own `runId`;
 * - a completed run keeps its settled snapshot until the durable entry named by
 *   `run_complete.lastEntryId` is in history, so the reply never blinks out
 *   between the two streams. A bounded expiry and reset/disconnect clear it.
 *   The expiry clock only runs while the durable feed is connected and caught
 *   up: while it is down or refetching, the successor is demonstrably still
 *   pending, so the settled reply is kept.
 */

export interface LiveRun {
  runId: string;
  source: string;
  channel?: string;
  /** Server timestamp of the first event seen for this run. */
  startedAt: string;
  entry: AwarenessEntry | null;
  /** Client clock (ms) when run_complete arrived; unset while running. */
  completedAt?: number;
  /**
   * Client clock (ms) the settle expiry counts from: completion, or the moment
   * the durable feed caught up again. Unset while the durable feed is down.
   */
  settleClockAt?: number;
  /** Durable successor announced by run_complete. */
  lastEntryId?: string;
}

export type LiveRunEnvelope =
  | { kind: 'reset' }
  | {
      kind: 'runtime';
      runId: string;
      source: string;
      channel?: string;
      timestamp: string;
      eventType: string;
      snapshot?: AwarenessEntry;
      lastEntryId?: string;
    };

/** Sources whose turns this view already renders itself (voice has its own transcript). */
const SELF_STREAMED_SOURCES = new Set(['web-voice']);

/**
 * How long a completed run may wait for its durable successor before the
 * transient entry is dropped anyway (successor id unknown, or history lagging
 * beyond reason). Bounded so a lost write can never pin a ghost reply.
 */
export const LIVE_RUN_SETTLE_TIMEOUT_MS = 30_000;

export function parseLiveRunEnvelope(data: string): LiveRunEnvelope | null {
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (parsed.kind === 'reset') return { kind: 'reset' };
    if (parsed.kind !== 'runtime' || !isRecord(parsed.event)) return null;
    const runId = typeof parsed.runId === 'string' ? parsed.runId : '';
    if (!runId) return null;
    const event = parsed.event;
    const eventType = typeof event.type === 'string' ? event.type : '';
    if (eventType !== 'assistant_snapshot' && eventType !== 'run_complete') return null;
    const timestamp = typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString();
    const channel = typeof parsed.channelLabel === 'string' && parsed.channelLabel.trim()
      ? parsed.channelLabel.trim()
      : undefined;
    const envelope: LiveRunEnvelope = {
      kind: 'runtime',
      runId,
      source: typeof parsed.source === 'string' ? parsed.source : '',
      channel,
      timestamp,
      eventType,
    };
    if (eventType === 'run_complete' && typeof event.lastEntryId === 'string' && event.lastEntryId) {
      envelope.lastEntryId = event.lastEntryId;
    }
    if (eventType === 'assistant_snapshot') {
      if (!isRecord(event.entry) || !Array.isArray(event.entry.content)) return null;
      envelope.snapshot = {
        id: `live-run:${runId}`,
        type: 'message',
        role: 'assistant',
        timestamp: typeof event.entry.timestamp === 'string' && event.entry.timestamp ? event.entry.timestamp : timestamp,
        content: event.entry.content as ContentBlock[],
        model: typeof event.entry.model === 'string' ? event.entry.model : undefined,
        isStreaming: true,
        streamProtocol: 'snapshot',
        ...(channel ? { channel } : {}),
      };
    }
    return envelope;
  } catch {
    return null;
  }
}

export function reduceLiveRuns(
  runs: LiveRun[],
  envelope: LiveRunEnvelope,
  now: number = Date.now(),
  durableCaughtUp = true,
): LiveRun[] {
  if (envelope.kind === 'reset') return runs.length ? [] : runs;
  const index = runs.findIndex((run) => run.runId === envelope.runId);
  if (envelope.eventType === 'run_complete') {
    if (index === -1) return runs;
    const next = [...runs];
    const run = next[index];
    next[index] = {
      ...run,
      completedAt: now,
      settleClockAt: durableCaughtUp ? now : undefined,
      ...(envelope.lastEntryId ? { lastEntryId: envelope.lastEntryId } : {}),
      // Settled: stop the streaming cursor, keep the text on screen.
      entry: run.entry ? { ...run.entry, isStreaming: false } : null,
    };
    return next;
  }
  if (SELF_STREAMED_SOURCES.has(envelope.source) || !envelope.snapshot) return runs;
  if (index === -1) {
    return [...runs, {
      runId: envelope.runId,
      source: envelope.source,
      channel: envelope.channel,
      startedAt: envelope.timestamp,
      entry: envelope.snapshot,
    }];
  }
  // A late snapshot never reopens a completed run.
  if (runs[index].completedAt !== undefined) return runs;
  const next = [...runs];
  next[index] = { ...next[index], entry: envelope.snapshot };
  return next;
}

/** Drop completed runs whose bounded wait for a durable successor has expired. */
export function expireLiveRuns(runs: LiveRun[], now: number = Date.now(), timeoutMs = LIVE_RUN_SETTLE_TIMEOUT_MS): LiveRun[] {
  const kept = runs.filter((run) => run.settleClockAt === undefined || now - run.settleClockAt < timeoutMs);
  return kept.length === runs.length ? runs : kept;
}

/** Durable feed dropped: the successor may be in flight, so stop every settle clock. */
export function pauseLiveRunSettleClocks(runs: LiveRun[]): LiveRun[] {
  if (!runs.some((run) => run.settleClockAt !== undefined)) return runs;
  return runs.map((run) => (run.settleClockAt === undefined ? run : { ...run, settleClockAt: undefined }));
}

/** Durable feed connected and refetched: give each waiting run a fresh bounded window. */
export function resumeLiveRunSettleClocks(runs: LiveRun[], now: number = Date.now()): LiveRun[] {
  if (!runs.some((run) => run.completedAt !== undefined && run.settleClockAt === undefined)) return runs;
  return runs.map((run) => (run.completedAt !== undefined && run.settleClockAt === undefined ? { ...run, settleClockAt: now } : run));
}

/**
 * Forget completed runs whose durable successor is in history. Pruned rather
 * than merely hidden so the settled reply cannot resurface if that row later
 * leaves the loaded window.
 */
export function pruneSettledLiveRuns(runs: LiveRun[], entries: AwarenessEntry[]): LiveRun[] {
  const waiting = runs.filter((run) => run.completedAt !== undefined && run.lastEntryId);
  if (waiting.length === 0) return runs;
  const durableIds = new Set<string>();
  for (const entry of entries) if (!entry.isStreaming) durableIds.add(entry.id);
  const kept = runs.filter((run) => !(run.completedAt !== undefined && run.lastEntryId && durableIds.has(run.lastEntryId)));
  return kept.length === runs.length ? runs : kept;
}

/** On a dropped /live connection: in-flight runs are replayed on reconnect, settled ones are kept. */
export function dropUnsettledLiveRuns(runs: LiveRun[]): LiveRun[] {
  const kept = runs.filter((run) => run.completedAt !== undefined);
  return kept.length === runs.length ? runs : kept;
}

/** Earliest pending expiry, for scheduling one timer instead of polling. */
export function nextLiveRunExpiry(runs: LiveRun[], timeoutMs = LIVE_RUN_SETTLE_TIMEOUT_MS): number | null {
  const times = runs.filter((run) => run.settleClockAt !== undefined).map((run) => (run.settleClockAt as number) + timeoutMs);
  return times.length ? Math.min(...times) : null;
}

/**
 * Append each foreign live run's transient entry.
 *
 * `owned` holds the exact run ids this tab's POST streams announced; nothing
 * else is treated as the tab's own. A run's snapshot is cumulative for the
 * whole run, so while it is shown only durable assistant/tool rows stamped
 * with that same run id are hidden; rows of other runs, untagged history and
 * user messages always stay. Once the run's durable successor is in history
 * the transient entry is dropped and the full durable rows take over.
 */
export function mergeLiveRuns(entries: AwarenessEntry[], runs: LiveRun[], owned: ReadonlySet<string>): AwarenessEntry[] {
  if (runs.length === 0) return entries;
  const durableIds = new Set<string>();
  for (const entry of entries) if (!entry.isStreaming) durableIds.add(entry.id);
  const visible = runs.filter((run) =>
    run.entry
    && !owned.has(run.runId)
    && !(run.lastEntryId && durableIds.has(run.lastEntryId)),
  );
  if (visible.length === 0) return entries;
  const shown = new Set(visible.map((run) => run.runId));
  const base = entries.filter((entry) =>
    !(entry.runId
      && shown.has(entry.runId)
      && !entry.isStreaming
      && (entry.role === 'assistant' || entry.role === 'toolResult')),
  );
  return [...base, ...visible.map((run) => run.entry as AwarenessEntry)];
}

/** True while a foreign run is still streaming (drives instant follow). */
export function hasStreamingForeignRun(runs: LiveRun[], owned: ReadonlySet<string>): boolean {
  return runs.some((run) => run.entry && run.completedAt === undefined && !owned.has(run.runId));
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
