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
  const visibleBaseEntries = [...entries, ...localEntries];
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
  const visibleBaseEntries = [...entries, ...localEntries];

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

function isEntryNearOrAfter(entry: { timestamp: string }, since: string): boolean {
  const entryMs = Date.parse(entry.timestamp);
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(entryMs) || !Number.isFinite(sinceMs)) return false;
  return entryMs >= sinceMs - OPTIMISTIC_MATCH_SKEW_MS;
}
