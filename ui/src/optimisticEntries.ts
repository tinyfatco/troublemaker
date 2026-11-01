import type { AwarenessEntry } from './types';

export interface OptimisticVisibility {
  showUserEntry: boolean;
  showStreamingEntry: boolean;
}

const OPTIMISTIC_MATCH_SKEW_MS = 1000;

export function getOptimisticVisibility(
  entries: AwarenessEntry[],
  userEntry: AwarenessEntry | null,
  streamingEntry: AwarenessEntry | null,
  localEntries: AwarenessEntry[] = [],
): OptimisticVisibility {
  const visibleBaseEntries = [...entries, ...filterLocalEntries(entries, localEntries)];
  const realUserIndex = findMatchingTurnUserIndex(visibleBaseEntries, userEntry);
  const hasRealUser = realUserIndex !== -1;
  const entriesAfterUser = hasRealUser ? visibleBaseEntries.slice(realUserIndex + 1) : [];
  const hasAssistantAfterUser = hasRealUser &&
    entriesAfterUser.some((entry) => entry.role === 'assistant' && !entry.isStreaming);
  const hasSteeringSplit = entriesAfterUser.some((entry) => (
    entry.steeringProjection?.contentBlockOffset !== undefined || entry.streamContentBlockOffset !== undefined
  ));

  return {
    showUserEntry: !!userEntry && !hasRealUser,
    showStreamingEntry: !!streamingEntry && (streamingEntry.isStreaming || !hasAssistantAfterUser || hasSteeringSplit),
  };
}

export function mergeOptimisticEntries(
  entries: AwarenessEntry[],
  userEntry: AwarenessEntry | null,
  streamingEntry: AwarenessEntry | null,
  localEntries: AwarenessEntry[] = [],
  steeringOffsets?: Map<string, number>,
): AwarenessEntry[] {
  if (steeringOffsets) entries = stampSteeringOffsets(entries, streamingEntry, steeringOffsets);
  const { showUserEntry, showStreamingEntry } = getOptimisticVisibility(entries, userEntry, streamingEntry, localEntries);
  const visibleBaseEntries = [...entries, ...filterLocalEntries(entries, localEntries)];

  if (streamingEntry && showStreamingEntry) {
    const realUserIndex = findMatchingTurnUserIndex(visibleBaseEntries, userEntry);
    const hasSteeringSplit = realUserIndex !== -1 && visibleBaseEntries.slice(realUserIndex + 1).some((entry) => (
      entry.steeringProjection?.contentBlockOffset !== undefined || entry.streamContentBlockOffset !== undefined
    ));
    if (realUserIndex !== -1 && (streamingEntry.isStreaming || hasSteeringSplit)) {
      const beforeTurn = visibleBaseEntries.slice(0, realUserIndex + 1);
      const duringTurn = visibleBaseEntries.slice(realUserIndex + 1)
        .filter((entry) => entry.role !== 'assistant');
      return [...beforeTurn, ...interleaveStreamingEntry(streamingEntry, duringTurn)];
    }
  }

  const merged = [...visibleBaseEntries];

  if (userEntry && showUserEntry) {
    merged.push(userEntry);
  }

  if (streamingEntry && showStreamingEntry) {
    merged.push(streamingEntry);
  }

  return merged;
}

/**
 * Pin each steering input to the number of assistant blocks streamed when it
 * first appeared. Offsets live in a caller-owned map (one per chat view), so
 * separate panes, projects, and conversations never share cursor state.
 */
export function stampSteeringOffsets(
  entries: AwarenessEntry[],
  streamingEntry: AwarenessEntry | null,
  offsets: Map<string, number>,
): AwarenessEntry[] {
  const streamedBlocks = streamingEntry?.isStreaming ? (streamingEntry.content?.length ?? 0) : undefined;
  return entries.map((entry) => {
    const projectionId = entry.steeringProjection?.id;
    if (projectionId) {
      if (!offsets.has(projectionId) && streamedBlocks !== undefined) offsets.set(projectionId, streamedBlocks);
      const offset = offsets.get(projectionId);
      return offset === undefined || entry.steeringProjection?.contentBlockOffset !== undefined
        ? entry
        : { ...entry, steeringProjection: { ...entry.steeringProjection!, contentBlockOffset: offset } };
    }
    if (entry.replacesSteeringId && entry.streamContentBlockOffset === undefined) {
      const offset = offsets.get(entry.replacesSteeringId);
      if (offset !== undefined) return { ...entry, streamContentBlockOffset: offset };
    }
    return entry;
  });
}

function interleaveStreamingEntry(streamingEntry: AwarenessEntry, entries: AwarenessEntry[]): AwarenessEntry[] {
  const content = streamingEntry.content || [];
  const positioned = entries
    .map((entry, index) => ({
      entry,
      index,
      offset: entry.steeringProjection?.contentBlockOffset ?? entry.streamContentBlockOffset,
    }))
    .filter((item): item is typeof item & { offset: number } => item.offset !== undefined)
    .sort((a, b) => a.offset - b.offset || a.index - b.index);

  if (positioned.length === 0) return [streamingEntry, ...entries];

  const rendered: AwarenessEntry[] = [];
  let cursor = 0;
  for (const item of positioned) {
    const offset = Math.max(cursor, Math.min(content.length, item.offset));
    if (offset > cursor) rendered.push(streamingSlice(streamingEntry, cursor, offset));
    rendered.push(item.entry);
    cursor = offset;
  }
  if (cursor < content.length || content.length === 0) {
    rendered.push(streamingSlice(streamingEntry, cursor, content.length));
  }
  rendered.push(...entries.filter((entry) => !positioned.some((item) => item.entry === entry)));
  return rendered;
}

function streamingSlice(entry: AwarenessEntry, start: number, end: number): AwarenessEntry {
  return {
    ...entry,
    id: `${entry.id}-slice-${start}-${end}`,
    content: (entry.content || []).slice(start, end),
  };
}

function filterLocalEntries(entries: AwarenessEntry[], localEntries: AwarenessEntry[]): AwarenessEntry[] {
  return localEntries.filter((entry) => !hasEquivalentDurableEntry(entries, entry));
}

function hasEquivalentDurableEntry(entries: AwarenessEntry[], localEntry: AwarenessEntry): boolean {
  if (entries.some((entry) => entry.id === localEntry.id)) return true;

  if (localEntry.role === 'user' && localEntry.strippedText) {
    return entries.some((entry) => (
      entry.role === 'user' &&
      entry.strippedText === localEntry.strippedText &&
      timestampsNear(entry.timestamp, localEntry.timestamp, 5000)
    ));
  }

  if (localEntry.role === 'assistant') {
    const localText = entryText(localEntry);
    if (!localText) return false;
    return entries.some((entry) => (
      entry.role === 'assistant' &&
      entryText(entry) === localText &&
      timestampsNear(entry.timestamp, localEntry.timestamp, 10000)
    ));
  }

  return false;
}

function findMatchingTurnUserIndex(entries: AwarenessEntry[], userEntry: AwarenessEntry | null): number {
  const lastUserText = userEntry?.strippedText || '';
  if (!userEntry || !lastUserText) return -1;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.role !== 'user' || entry.strippedText !== lastUserText) continue;
    if (!isEntryNearOrAfter(entry, userEntry.timestamp)) continue;
    return i;
  }

  return -1;
}

function entryText(entry: AwarenessEntry): string {
  return (entry.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n');
}

function isEntryNearOrAfter(entry: { timestamp: string }, since: string): boolean {
  const entryMs = Date.parse(entry.timestamp);
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(entryMs) || !Number.isFinite(sinceMs)) return false;
  return entryMs >= sinceMs - OPTIMISTIC_MATCH_SKEW_MS;
}

function timestampsNear(a: string, b: string, skewMs: number): boolean {
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs) || !Number.isFinite(bMs)) return false;
  return Math.abs(aMs - bMs) <= skewMs;
}
