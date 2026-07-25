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

  return {
    showUserEntry: !!userEntry && !hasRealUser,
    showStreamingEntry: !!streamingEntry && (streamingEntry.isStreaming || !hasAssistantAfterUser),
  };
}

export function mergeOptimisticEntries(
  entries: AwarenessEntry[],
  userEntry: AwarenessEntry | null,
  streamingEntry: AwarenessEntry | null,
  localEntries: AwarenessEntry[] = [],
): AwarenessEntry[] {
  const { showUserEntry, showStreamingEntry } = getOptimisticVisibility(entries, userEntry, streamingEntry, localEntries);
  const visibleBaseEntries = [...entries, ...filterLocalEntries(entries, localEntries)];

  if (streamingEntry?.isStreaming && showStreamingEntry) {
    const realUserIndex = findMatchingTurnUserIndex(visibleBaseEntries, userEntry);
    if (realUserIndex !== -1) {
      return [...visibleBaseEntries.slice(0, realUserIndex + 1), streamingEntry];
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
