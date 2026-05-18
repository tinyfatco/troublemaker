import type { AwarenessEntry } from './types';

export interface OptimisticVisibility {
  showUserEntry: boolean;
  showStreamingEntry: boolean;
}

export function getOptimisticVisibility(
  entries: AwarenessEntry[],
  userEntry: AwarenessEntry | null,
  streamingEntry: AwarenessEntry | null,
): OptimisticVisibility {
  const realUserIndex = findMatchingTurnUserIndex(entries, userEntry);
  const hasRealUser = realUserIndex !== -1;
  const hasAssistantAfterUser = hasRealUser &&
    entries.slice(realUserIndex + 1).some((entry) => entry.role === 'assistant' && !entry.isStreaming);

  return {
    showUserEntry: !!userEntry && !hasRealUser,
    showStreamingEntry: !!streamingEntry && !hasAssistantAfterUser,
  };
}

export function mergeOptimisticEntries(
  entries: AwarenessEntry[],
  userEntry: AwarenessEntry | null,
  streamingEntry: AwarenessEntry | null,
): AwarenessEntry[] {
  const { showUserEntry, showStreamingEntry } = getOptimisticVisibility(entries, userEntry, streamingEntry);
  const merged = [...entries];

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
  return entryMs >= sinceMs - 5000;
}
