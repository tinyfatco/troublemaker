import type { AwarenessEntry, ContentBlock } from './types';

/**
 * Turns started outside this web view (Zulip, Slack, SMS, Paint, another tab)
 * never reach the view's own POST stream, so before this the chat only showed
 * their reply once the durable entries landed. The shared /live feed already
 * carries a sanitized cumulative `assistant_snapshot` for every run; this
 * module folds those into one transient streaming entry per run.
 */

export interface LiveRun {
  runId: string;
  source: string;
  channel?: string;
  /** Server timestamp of the first event seen for this run. */
  startedAt: string;
  entry: AwarenessEntry | null;
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
    };

/** Sources whose turns this view already streams itself (or renders locally). */
const SELF_STREAMED_SOURCES = new Set(['web-voice']);

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

export function reduceLiveRuns(runs: LiveRun[], envelope: LiveRunEnvelope): LiveRun[] {
  if (envelope.kind === 'reset') return runs.length ? [] : runs;
  if (envelope.eventType === 'run_complete') {
    return runs.some((run) => run.runId === envelope.runId)
      ? runs.filter((run) => run.runId !== envelope.runId)
      : runs;
  }
  if (SELF_STREAMED_SOURCES.has(envelope.source) || !envelope.snapshot) return runs;
  const index = runs.findIndex((run) => run.runId === envelope.runId);
  if (index === -1) {
    return [...runs, {
      runId: envelope.runId,
      source: envelope.source,
      channel: envelope.channel,
      startedAt: envelope.timestamp,
      entry: envelope.snapshot,
    }];
  }
  const next = [...runs];
  next[index] = { ...next[index], entry: envelope.snapshot };
  return next;
}

/**
 * Remember which `web` runs belong to this view's own send: a web run first
 * seen while the view's POST stream is active is already being streamed there.
 * Mutates and returns `owned` so the claim survives the own stream settling.
 */
export function claimOwnWebRuns(runs: LiveRun[], owned: Set<string>, ownStreamActive: boolean): Set<string> {
  if (!ownStreamActive) return owned;
  for (const run of runs) {
    if (run.source === 'web') owned.add(run.runId);
  }
  return owned;
}

/**
 * Append each foreign live run's streaming entry. The snapshot is cumulative
 * for the whole turn, so durable assistant/tool rows written since the run
 * started are hidden until it completes, then the durable rows take over.
 */
export function mergeLiveRuns(entries: AwarenessEntry[], runs: LiveRun[], owned: Set<string>): AwarenessEntry[] {
  const visible = runs.filter((run) => run.entry && !owned.has(run.runId));
  if (visible.length === 0) return entries;
  const earliest = Math.min(...visible.map((run) => Date.parse(run.startedAt)).filter(Number.isFinite));
  const base = Number.isFinite(earliest)
    ? entries.filter((entry) => {
        if (entry.role !== 'assistant' && entry.role !== 'toolResult') return true;
        if (entry.isStreaming) return true;
        const at = Date.parse(entry.timestamp);
        return !Number.isFinite(at) || at < earliest;
      })
    : entries;
  return [...base, ...visible.map((run) => run.entry as AwarenessEntry)];
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
