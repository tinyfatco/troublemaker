import type { AwarenessEntry, SteeringProjectionState } from './types';

interface LiveSteeringInputEntry {
  channel: string;
  userName: string;
  text: string;
}

interface LiveSteeringInputEvent {
  type: 'steering_input';
  id: string;
  state: 'accepted' | 'consumed' | 'dismissed';
  deliveryMode: 'steered';
  acceptedAt: string;
  entries: LiveSteeringInputEntry[];
}

interface RuntimeSteeringEnvelope {
  kind: 'runtime';
  event: LiveSteeringInputEvent;
}

export function parseRuntimeSteeringEnvelope(data: string): RuntimeSteeringEnvelope | null {
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (parsed.kind !== 'runtime' || !isRecord(parsed.event)) return null;
    const event = parsed.event;
    if (event.type !== 'steering_input') return null;
    if (typeof event.id !== 'string' || !event.id) return null;
    if (!['accepted', 'consumed', 'dismissed'].includes(String(event.state))) return null;
    if (event.deliveryMode !== 'steered' || typeof event.acceptedAt !== 'string') return null;
    if (!Array.isArray(event.entries)) return null;

    const entries = event.entries.flatMap((entry): LiveSteeringInputEntry[] => {
      if (!isRecord(entry)) return [];
      const channel = stringValue(entry.channel).trim();
      const userName = stringValue(entry.userName).trim();
      const text = stringValue(entry.text);
      if (!channel || !text.trim()) return [];
      return [{ channel, userName: userName || 'user', text }];
    });
    if (entries.length === 0) return null;

    return {
      kind: 'runtime',
      event: {
        type: 'steering_input',
        id: event.id,
        state: event.state as LiveSteeringInputEvent['state'],
        deliveryMode: 'steered',
        acceptedAt: event.acceptedAt,
        entries,
      },
    };
  } catch {
    return null;
  }
}

export function applyRuntimeSteeringEnvelope(
  entries: AwarenessEntry[],
  envelope: RuntimeSteeringEnvelope,
): AwarenessEntry[] {
  const event = envelope.event;
  const prefix = steeringEntryPrefix(event.id);
  if (event.state === 'dismissed') {
    return entries.filter((entry) => !entry.id.startsWith(prefix));
  }

  if (event.state === 'consumed') {
    const canonical = entries.flatMap((entry) => (
      entry.steeringProjection
        ? []
        : canonicalUserInputs(entry).map((input) => ({ input, timestamp: entry.timestamp }))
    ));
    const claimedCanonical = new Set<number>();
    let changed = false;
    const next = entries.flatMap((entry): AwarenessEntry[] => {
      if (!entry.id.startsWith(prefix) || !entry.steeringProjection) return [entry];
      const inputIndex = Number(entry.id.slice(prefix.length));
      const input = Number.isInteger(inputIndex) ? event.entries[inputIndex] : undefined;
      if (input) {
        const canonicalIndex = canonical.findIndex((candidate, index) => (
          !claimedCanonical.has(index)
          && sameVisibleInput(candidate.input, input)
          && canReconcileTimestamps(candidate.timestamp, event.acceptedAt)
        ));
        if (canonicalIndex !== -1) {
          claimedCanonical.add(canonicalIndex);
          changed = true;
          return [];
        }
      }
      if (entry.steeringProjection.state === 'consumed') return [entry];
      changed = true;
      return [{
        ...entry,
        steeringProjection: { ...entry.steeringProjection, state: 'consumed' as SteeringProjectionState },
      }];
    });
    return changed ? next : entries;
  }

  const seen = new Set(entries.map((entry) => entry.id));
  const accepted = event.entries.flatMap((input, index): AwarenessEntry[] => {
    const id = `${prefix}${index}`;
    if (seen.has(id)) return [];
    return [{
      id,
      type: 'message',
      timestamp: event.acceptedAt,
      role: 'user',
      content: [{ type: 'text', text: input.text }],
      channel: input.channel,
      userName: input.userName,
      strippedText: input.text,
      steeringProjection: {
        id: event.id,
        state: 'accepted',
        deliveryMode: event.deliveryMode,
      },
    }];
  });
  return accepted.length > 0 ? [...entries, ...accepted] : entries;
}

export function mergeAwarenessEntries(
  existing: AwarenessEntry[],
  incoming: AwarenessEntry[],
): AwarenessEntry[] {
  const merged = [...existing];
  const seen = new Set(existing.map((entry) => entry.id));
  for (const entry of incoming) {
    if (entry.role === 'user') {
      for (const input of canonicalUserInputs(entry)) {
        const projectionIndex = merged.findIndex((candidate) => (
          candidate.steeringProjection?.state === 'consumed'
          && sameAwarenessInput(candidate, input)
          && canReconcileTimestamps(entry.timestamp, candidate.timestamp)
        ));
        if (projectionIndex !== -1) {
          seen.delete(merged[projectionIndex].id);
          merged.splice(projectionIndex, 1);
        }
      }
    }
    // A durable event can arrive before the companion consumed event. Re-run
    // reconciliation even when a backlog refresh repeats an already-seen row.
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }
  return merged;
}

function steeringEntryPrefix(id: string): string {
  return `steering-${id}-`;
}

interface CanonicalUserInput {
  channel: string;
  userName: string;
  text: string;
}

function canonicalUserInputs(entry: AwarenessEntry): CanonicalUserInput[] {
  if (entry.role !== 'user' || !entry.strippedText) return [];
  const batched = parseCanonicalBatch(entry.strippedText);
  if (batched.length > 0) return batched;
  if (!entry.channel || !entry.userName) return [];
  return [{ channel: entry.channel, userName: entry.userName, text: entry.strippedText }];
}

function parseCanonicalBatch(text: string): CanonicalUserInput[] {
  if (!text.startsWith('Recent messages:\n')) return [];
  const body = text.slice('Recent messages:\n'.length);
  const header = /^\[([^\]\n]+)\]\s+\[([^\]\n]+)\]\s+\[([^\]\n]+)\]:[ \t]*/gm;
  const matches = [...body.matchAll(header)];
  if (matches.length < 2) return [];
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? body.length;
    return {
      channel: match[2].trim() || 'unknown',
      userName: match[3].trim() || 'user',
      text: body.slice(start, end).trimEnd(),
    };
  }).filter((input) => Boolean(input.text));
}

function sameAwarenessInput(entry: AwarenessEntry, input: CanonicalUserInput): boolean {
  return entry.role === 'user'
    && entry.channel === input.channel
    && entry.userName === input.userName
    && entry.strippedText === input.text;
}

function sameVisibleInput(a: CanonicalUserInput, b: LiveSteeringInputEntry): boolean {
  return a.channel === b.channel && a.userName === b.userName && a.text === b.text;
}

function canReconcileTimestamps(canonicalTimestamp: string, acceptedAt: string): boolean {
  const canonicalMs = Date.parse(canonicalTimestamp);
  const acceptedMs = Date.parse(acceptedAt);
  if (!Number.isFinite(canonicalMs) || !Number.isFinite(acceptedMs)) return true;
  return canonicalMs >= acceptedMs - 10_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
