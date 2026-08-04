/**
 * useAwarenessStream — tail-first awareness loading with lazy scroll-up.
 *
 * 1. Fetches the most recent entries via GET /api/v2/agents/:id/events
 * 2. Connects to the durable event stream plus the in-flight steering stream
 * 3. Exposes loadMore() for paginated scroll-up loading of older entries
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { awarenessStreamUrl, fetchAwarenessBacklog, runtimeLiveStreamUrl } from '../console-api';
import { applyRuntimeSteeringEnvelope, mergeAwarenessEntries, parseRuntimeSteeringEnvelope } from '../steeringProjection';
import { parseContextLine, type AwarenessEntry } from '../types';
import { WEB_CHAT_TURN_COMPLETE_EVENT } from '../webChatTurnEvents';

export interface UseAwarenessStreamReturn {
  entries: AwarenessEntry[];
  isLoading: boolean;
  /** True once the initial backlog has been fetched */
  backlogDone: boolean;
  /** Load older entries (for scroll-up pagination) */
  loadMore: () => void;
  /** True while loading older entries */
  isLoadingMore: boolean;
  /** True when there are no more older entries to load */
  allLoaded: boolean;
  connectionState: 'connecting' | 'connected' | 'reconnecting';
  lastEventAt: string | null;
  error: string | null;
}

export function useAwarenessStream(): UseAwarenessStreamReturn {
  const [entries, setEntries] = useState<AwarenessEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [backlogDone, setBacklogDone] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [allLoaded, setAllLoaded] = useState(false);
  const [connectionState, setConnectionState] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Track the oldest line offset we've loaded (for pagination)
  const oldestOffsetRef = useRef<number>(Infinity);

  const mergeRecentBacklog = useCallback((data: { lines: string[]; offset: number }, replaceEmpty = false) => {
    const parsed = data.lines
      .map((line: string) => parseContextLine(line))
      .filter((e): e is AwarenessEntry => e !== null);

    oldestOffsetRef.current = Math.min(oldestOffsetRef.current, data.offset);
    setAllLoaded(data.offset === 0);
    setEntries((prev) => {
      if (replaceEmpty && prev.length === 0) return parsed;
      return mergeAwarenessEntries(prev, parsed);
    });
  }, []);

  const refreshRecentBacklog = useCallback(async (replaceEmpty = false) => {
    const data = await fetchAwarenessBacklog(50);
    mergeRecentBacklog(data, replaceEmpty);
  }, [mergeRecentBacklog]);

  // Fetch initial backlog (recent entries) — retries on failure for cold starts
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const maxRetries = 5;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await refreshRecentBacklog(true);
          if (cancelled) return;
          setIsLoading(false);
          setBacklogDone(true);
          return;
        } catch {
          if (cancelled) return;
          if (attempt < maxRetries) {
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          // All retries exhausted
          setIsLoading(false);
          setBacklogDone(true);
          setError('Failed to load awareness history');
        }
      }
    })();

    return () => { cancelled = true; };
  }, [refreshRecentBacklog]);

  // Connect SSE for live updates (no backlog replay)
  useEffect(() => {
    setConnectionState('connecting');
    const es = new EventSource(awarenessStreamUrl());

    es.onmessage = (event) => {
      const entry = parseContextLine(event.data);
      if (!entry) return;
      setLastEventAt(new Date().toISOString());
      setEntries((prev) => mergeAwarenessEntries(prev, [entry]));
    };

    es.onerror = () => {
      setConnectionState('reconnecting');
      setError('Connection lost; reconnecting.');
      refreshRecentBacklog(false).catch(() => {});
      setTimeout(() => setError(null), 3000);
    };

    es.onopen = () => {
      setConnectionState('connected');
      setError(null);
      refreshRecentBacklog(false).catch(() => {});
    };

    return () => { es.close(); };
  }, [refreshRecentBacklog]);

  // The companion live stream replays only server-confirmed steering state.
  // Durable awareness delivery above remains unchanged.
  useEffect(() => {
    const es = new EventSource(runtimeLiveStreamUrl());
    es.onmessage = (event) => {
      const steering = parseRuntimeSteeringEnvelope(event.data);
      if (!steering) return;
      setLastEventAt(new Date().toISOString());
      setEntries((prev) => applyRuntimeSteeringEnvelope(prev, steering));
    };
    return () => { es.close(); };
  }, []);

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible') {
        refreshRecentBacklog(false).catch(() => {});
      }
    };
    window.addEventListener('focus', refreshIfVisible);
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      window.removeEventListener('focus', refreshIfVisible);
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [refreshRecentBacklog]);

  useEffect(() => {
    const refreshAfterWebChatTurn = () => {
      refreshRecentBacklog(false).catch(() => {});
    };
    window.addEventListener(WEB_CHAT_TURN_COMPLETE_EVENT, refreshAfterWebChatTurn);
    return () => {
      window.removeEventListener(WEB_CHAT_TURN_COMPLETE_EVENT, refreshAfterWebChatTurn);
    };
  }, [refreshRecentBacklog]);

  // Load older entries (scroll-up pagination)
  const loadMore = useCallback(async () => {
    if (isLoadingMore || allLoaded || oldestOffsetRef.current <= 0) return;

    setIsLoadingMore(true);
    try {
      const data = await fetchAwarenessBacklog(50, oldestOffsetRef.current);

      const parsed = data.lines
        .map((line: string) => parseContextLine(line))
        .filter((e): e is AwarenessEntry => e !== null);

      oldestOffsetRef.current = data.offset;
      if (data.offset === 0) setAllLoaded(true);

      setEntries((prev) => prependAwarenessEntries(prev, parsed));
    } catch {
      setError('Failed to load older messages');
    } finally {
      setIsLoadingMore(false);
    }
  }, [isLoadingMore, allLoaded]);

  return {
    entries,
    isLoading,
    backlogDone,
    loadMore,
    isLoadingMore,
    allLoaded,
    connectionState,
    lastEventAt,
    error,
  };
}

function prependAwarenessEntries(existing: AwarenessEntry[], incoming: AwarenessEntry[]): AwarenessEntry[] {
  const seen = new Set<string>();
  const merged: AwarenessEntry[] = [];
  for (const entry of [...incoming, ...existing]) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }
  return merged;
}
