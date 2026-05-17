/**
 * AwarenessPane — right sidebar showing the unified awareness stream + chat input.
 * Shows all channel activity (Telegram, Slack, email, web, heartbeat) in real time.
 *
 * Loads recent entries first (tail-first), lazy-loads older entries on scroll-up.
 */

import { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import { useAwarenessStream } from '../hooks/useAwarenessStream';
import { useWebChat } from '../hooks/useWebChat';
import { useVoiceChat } from '../hooks/useVoiceChat';
import type { AwarenessEntry, ContentBlock, ToolCallContent, ToolResultContent } from '../types';
import { AwarenessEntryComponent } from './AwarenessEntry';
import { InputBar } from './InputBar';
import { StatusStrip } from './StatusStrip';

export function AwarenessPane() {
  const {
    entries,
    isLoading,
    backlogDone,
    loadMore,
    isLoadingMore,
    allLoaded,
    connectionState,
    lastEventAt,
    error: streamError,
  } = useAwarenessStream();
  const {
    userEntry,
    streamingEntry,
    isStreaming,
    status: chatStatus,
    error: chatError,
    sendMessage,
    abortStream,
    clearError,
  } = useWebChat();

  const voice = useVoiceChat();
  const isVoiceActive = voice.state !== 'idle' && voice.state !== 'error';

  const error = chatError || streamError || voice.error;

  const visibleEntries = useMemo(
    () => normalizeToolResults(mergeOptimisticEntries(entries, userEntry, streamingEntry)),
    [entries, userEntry, streamingEntry],
  );

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const userScrolledRef = useRef(false);
  const prevScrollHeightRef = useRef(0);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    // Use requestAnimationFrame to ensure DOM has settled
    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior });
      userScrolledRef.current = false;
      setShowScrollBtn(false);
    });
  }, []);

  // Scroll to bottom when initial backlog loads
  useEffect(() => {
    if (backlogDone && visibleEntries.length > 0) {
      scrollToBottom('instant');
    }
  }, [backlogDone]); // eslint-disable-line react-hooks/exhaustive-deps

  // After loading more (prepend), preserve scroll position
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || !isLoadingMore) return;

    // Snapshot scrollHeight before the prepend renders
    prevScrollHeightRef.current = el.scrollHeight;
  }, [isLoadingMore]);

  // After prepend completes, adjust scroll to maintain position
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || isLoadingMore || prevScrollHeightRef.current === 0) return;

    const delta = el.scrollHeight - prevScrollHeightRef.current;
    if (delta > 0) {
      el.scrollTop += delta;
    }
    prevScrollHeightRef.current = 0;
  }, [visibleEntries.length, isLoadingMore]);

  // Auto-scroll on new entries (only if user hasn't scrolled up)
  useEffect(() => {
    if (!userScrolledRef.current && backlogDone) {
      scrollToBottom('smooth');
    }
  }, [visibleEntries.length, scrollToBottom, backlogDone]);

  // Detect user scroll — scroll-up triggers loadMore, scroll-down hides button
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom > 100) {
      userScrolledRef.current = true;
      setShowScrollBtn(true);
    } else {
      userScrolledRef.current = false;
      setShowScrollBtn(false);
    }

    // Load more when scrolled near the top
    if (el.scrollTop < 200 && !isLoadingMore && !allLoaded && backlogDone) {
      loadMore();
    }
  }, [loadMore, isLoadingMore, allLoaded, backlogDone]);

  return (
    <div className="awareness-pane">
      <StatusStrip
        connectionState={connectionState}
        chatStatus={chatStatus}
        isLoading={isLoading}
        isLoadingMore={isLoadingMore}
        lastEventAt={lastEventAt}
      />
      <div
        className="awareness-pane-messages"
        ref={scrollContainerRef}
        onScroll={handleScroll}
      >
        {isLoading ? (
          <div className="awareness-pane-empty">
            <span>Loading...</span>
          </div>
        ) : visibleEntries.length === 0 ? (
          <div className="awareness-pane-empty">
            <span>Send a message to get started.</span>
          </div>
        ) : (
          <div className="awareness-pane-stream">
            {isLoadingMore && (
              <div className="awareness-loading-more">
                <span className="tool-spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
                <span>Loading older messages...</span>
              </div>
            )}
            {!allLoaded && !isLoadingMore && visibleEntries.length > 0 && (
              <div className="awareness-loading-more awareness-load-trigger">
                <span>Scroll up for older messages</span>
              </div>
            )}
            {visibleEntries.map((entry) => (
              <AwarenessEntryComponent key={entry.id} entry={entry} />
            ))}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {showScrollBtn && (
        <button className="scroll-to-bottom-btn" onClick={() => scrollToBottom('smooth')}>
          &#x2193;
        </button>
      )}

      {error && (
        <div className="error-banner" onClick={clearError}>
          <span className="error-text">{error}</span>
          <span className="error-dismiss">&times;</span>
        </div>
      )}

      {isVoiceActive && (
        <div className="voice-status">
          <span className="voice-status-text">
            {voice.state === 'connecting' && 'Connecting...'}
            {voice.state === 'listening' && (voice.partial || 'Listening...')}
            {voice.state === 'thinking' && (voice.transcript || 'Thinking...')}
            {voice.state === 'speaking' && 'Speaking...'}
          </span>
        </div>
      )}

      <InputBar
        onSend={sendMessage}
        onStop={abortStream}
        disabled={isVoiceActive}
        isStreaming={isStreaming}
        extraButtons={
          <button
            className={`mic-button ${isVoiceActive ? 'active' : ''}`}
            onClick={isVoiceActive ? voice.stop : voice.start}
            title={isVoiceActive ? 'Stop voice' : 'Start voice'}
          >
            {isVoiceActive ? (
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <rect x="4" y="4" width="10" height="10" rx="1" fill="currentColor" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <rect x="7" y="2" width="4" height="9" rx="2" fill="currentColor" />
                <path d="M4 8.5a5 5 0 0010 0" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
                <path d="M9 14v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            )}
          </button>
        }
      />
    </div>
  );
}

function mergeOptimisticEntries(
  entries: AwarenessEntry[],
  userEntry: AwarenessEntry | null,
  streamingEntry: AwarenessEntry | null,
): AwarenessEntry[] {
  const merged = [...entries];
  const lastUserText = userEntry?.strippedText || '';
  const turnEntries = userEntry
    ? merged.filter((entry) => isEntryAtOrAfter(entry, userEntry.timestamp))
    : [];
  const hasUser = !!lastUserText && turnEntries
    .some((entry) => entry.role === 'user' && entry.strippedText === lastUserText);

  if (userEntry && !hasUser) {
    merged.push(userEntry);
  }

  const hasAssistantAfterUser = hasUser && turnEntries
    .some((entry) => entry.role === 'assistant' && !entry.isStreaming);

  if (streamingEntry && !hasAssistantAfterUser) {
    merged.push(streamingEntry);
  }

  return merged;
}

function isEntryAtOrAfter(entry: { timestamp: string }, since: string): boolean {
  const entryMs = Date.parse(entry.timestamp);
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(entryMs) || !Number.isFinite(sinceMs)) return false;
  return entryMs >= sinceMs - 5000;
}

function normalizeToolResults(entries: AwarenessEntry[]): AwarenessEntry[] {
  const normalized: AwarenessEntry[] = [];

  for (const entry of entries) {
    if (!isStandaloneToolResultEntry(entry)) {
      normalized.push(entry);
      continue;
    }

    if (!Array.isArray(entry.content)) continue;

    const results = entry.content.filter((block): block is ToolResultContent => block.type === 'toolResult');
    if (results.length === 0) {
      normalized.push(entry);
      continue;
    }

    const unmerged: ToolResultContent[] = [];

    for (const result of results) {
      const assistantIndex = findAssistantWithToolCall(normalized, result.toolCallId);
      if (assistantIndex === -1) {
        unmerged.push(result);
        continue;
      }

      const assistant = normalized[assistantIndex];
      const content = assistant.content || [];
      const alreadyMerged = content.some(
        (block) => block.type === 'toolResult' && block.toolCallId === result.toolCallId,
      );

      if (alreadyMerged) continue;

      normalized[assistantIndex] = {
        ...assistant,
        content: [...content, result],
      };
    }

    if (unmerged.length > 0) {
      normalized.push({ ...entry, role: 'toolResult', content: unmerged });
    }
  }

  return normalized;
}

function isStandaloneToolResultEntry(entry: AwarenessEntry): boolean {
  if (!Array.isArray(entry.content)) return false;
  if (entry.role === 'toolResult') return true;
  if (entry.role === 'assistant') return false;

  const hasToolResult = entry.content.some((block) => block.type === 'toolResult');
  const hasText = entry.content.some((block) => block.type === 'text' && block.text.trim());
  return hasToolResult && !hasText;
}

function findAssistantWithToolCall(entries: AwarenessEntry[], toolCallId: string): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.role !== 'assistant' || !entry.content) continue;
    const hasToolCall = entry.content.some((block: ContentBlock) => {
      if (block.type !== 'toolCall') return false;
      const toolCall = block as ToolCallContent;
      return toolCall.id === toolCallId;
    });
    if (hasToolCall) return i;
  }
  return -1;
}
