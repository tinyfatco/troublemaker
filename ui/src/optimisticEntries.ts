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
  const keepActiveToolStream = hasUncoveredActiveToolActivity(streamingEntry, entriesAfterUser);
  const hasAssistantAfterUser = hasRealUser &&
    !keepActiveToolStream &&
    entriesAfterUser.some((entry) => entry.role === 'assistant' && !entry.isStreaming);

  return {
    showUserEntry: !!userEntry && !hasRealUser,
    showStreamingEntry: !!streamingEntry && !hasAssistantAfterUser,
  };
}

function hasUncoveredActiveToolActivity(entry: AwarenessEntry | null, laterEntries: AwarenessEntry[]): boolean {
  if (!entry?.isStreaming) return false;
  const activeIds = new Set<string>();
  let hasAnonymousToolActivity = false;

  for (const block of entry.content || []) {
    if (block.type === 'toolCall') {
      if (block.id) activeIds.add(block.id);
      else hasAnonymousToolActivity = true;
    } else if (block.type === 'toolResult') {
      if (block.toolCallId) activeIds.add(block.toolCallId);
      else hasAnonymousToolActivity = true;
    } else if (block.type === 'toolOutput') {
      if (block.toolCallId) activeIds.add(block.toolCallId);
      else hasAnonymousToolActivity = true;
    }
  }

  if (activeIds.size === 0) return hasAnonymousToolActivity;
  const coveredIds = collectToolIds(laterEntries);
  for (const id of activeIds) {
    if (!coveredIds.has(id)) return true;
  }
  return false;
}

function collectToolIds(entries: AwarenessEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry.content) continue;
    for (const block of entry.content) {
      if (block.type === 'toolCall' && block.id) ids.add(block.id);
      if (block.type === 'toolOutput' && block.toolCallId) ids.add(block.toolCallId);
      if (block.type === 'toolResult' && block.toolCallId) ids.add(block.toolCallId);
    }
  }
  return ids;
}

export function mergeOptimisticEntries(
  entries: AwarenessEntry[],
  userEntry: AwarenessEntry | null,
  streamingEntry: AwarenessEntry | null,
  localEntries: AwarenessEntry[] = [],
): AwarenessEntry[] {
  const { showUserEntry, showStreamingEntry } = getOptimisticVisibility(entries, userEntry, streamingEntry, localEntries);
  const merged = [...entries, ...localEntries];

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
