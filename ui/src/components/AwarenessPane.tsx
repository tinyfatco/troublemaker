/**
 * AwarenessPane — right sidebar showing the unified awareness stream + chat input.
 * Shows all channel activity (Telegram, Slack, email, web, heartbeat) in real time.
 *
 * Loads recent entries first (tail-first), lazy-loads older entries on scroll-up.
 */

import { useRef, useEffect, useCallback, useMemo, useState, type CSSProperties, type TouchEvent, type WheelEvent } from 'react';
import type { UseAwarenessStreamReturn } from '../hooks/useAwarenessStream';
import { useWebChat } from '../hooks/useWebChat';
import { useVoiceChat } from '../hooks/useVoiceChat';
import { mergeOptimisticEntries } from '../optimisticEntries';
import type { AwarenessEntry, ContentBlock, ToolCallContent, ToolResultContent } from '../types';
import { AwarenessEntryComponent } from './AwarenessEntry';
import { InputBar } from './InputBar';

interface AwarenessPaneProps {
  stream: UseAwarenessStreamReturn;
}

export function AwarenessPane({ stream }: AwarenessPaneProps) {
  const {
    entries,
    isLoading,
    backlogDone,
    loadMore,
    isLoadingMore,
    allLoaded,
    error: streamError,
  } = stream;
  const {
    localEntries,
    userEntry,
    streamingEntry,
    isStreaming,
    error: chatError,
    sendMessage,
    abortStream,
    clearError,
  } = useWebChat();

  const voice = useVoiceChat();
  const isVoiceActive = voice.state !== 'idle' && voice.state !== 'error';

  const error = chatError || streamError || voice.error;

  const visibleEntries = useMemo(
    () => normalizeToolResults(mergeOptimisticEntries(entries, userEntry, streamingEntry, localEntries)),
    [entries, userEntry, streamingEntry, localEntries],
  );

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [composerHeight, setComposerHeight] = useState(0);
  const userScrolledRef = useRef(false);
  const prevScrollHeightRef = useRef(0);
  const composerHeightRef = useRef(0);
  const pendingExpansionFollowRef = useRef(false);
  const pinnedToBottomRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const touchStartYRef = useRef<number | null>(null);

  const isNearBottom = useCallback((threshold = 48) => {
    const el = scrollContainerRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    // Use requestAnimationFrame to ensure DOM has settled
    requestAnimationFrame(() => {
      programmaticScrollRef.current = true;
      messagesEndRef.current?.scrollIntoView({ behavior });
      pinnedToBottomRef.current = true;
      userScrolledRef.current = false;
      setShowScrollBtn(false);
      window.setTimeout(() => {
        programmaticScrollRef.current = false;
        lastScrollTopRef.current = scrollContainerRef.current?.scrollTop || 0;
      }, 80);
    });
  }, []);

  const handleComposerHeightChange = useCallback((height: number) => {
    if (Math.abs(height - composerHeightRef.current) < 1) return;

    const shouldFollowBottom = pinnedToBottomRef.current || isNearBottom();
    composerHeightRef.current = height;
    setComposerHeight(height);

    if (shouldFollowBottom && backlogDone) {
      scrollToBottom('instant');
    }
  }, [backlogDone, isNearBottom, scrollToBottom]);

  const handleExpandingContent = useCallback(() => {
    if (!backlogDone || isLoadingMore) return;
    const shouldFollowBottom = pinnedToBottomRef.current || isNearBottom();
    if (!shouldFollowBottom) return;

    pendingExpansionFollowRef.current = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!pendingExpansionFollowRef.current) return;
        programmaticScrollRef.current = true;
        messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
        pinnedToBottomRef.current = true;
        userScrolledRef.current = false;
        pendingExpansionFollowRef.current = false;
        setShowScrollBtn(false);
        window.setTimeout(() => {
          programmaticScrollRef.current = false;
          lastScrollTopRef.current = scrollContainerRef.current?.scrollTop || 0;
        }, 80);
      });
    });
  }, [backlogDone, isLoadingMore, isNearBottom]);

  const liveScrollSignal = useMemo(
    () => getLiveScrollSignal(visibleEntries),
    [visibleEntries],
  );

  const paneStyle = useMemo(() => ({
    '--composer-height': `${composerHeight}px`,
  }) as CSSProperties, [composerHeight]);

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

  // Auto-scroll on new entries and streaming text growth, but only while the
  // user is still reading near the live bottom.
  useEffect(() => {
    if (!backlogDone || isLoadingMore) return;

    if (pinnedToBottomRef.current || isNearBottom()) {
      scrollToBottom(isStreaming ? 'instant' : 'smooth');
    }
  }, [liveScrollSignal, composerHeight, scrollToBottom, backlogDone, isLoadingMore, isNearBottom, isStreaming]);

  // Detect user scroll — scroll-up triggers loadMore, scroll-down hides button
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const scrollingUp = el.scrollTop < lastScrollTopRef.current - 2;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distFromBottom <= 48;

    if (programmaticScrollRef.current) {
      lastScrollTopRef.current = el.scrollTop;
      return;
    }

    if (scrollingUp && !atBottom) {
      pinnedToBottomRef.current = false;
    } else if (atBottom) {
      pinnedToBottomRef.current = true;
    }

    if (!pinnedToBottomRef.current && !atBottom) {
      userScrolledRef.current = true;
      setShowScrollBtn(true);
    } else {
      userScrolledRef.current = false;
      setShowScrollBtn(false);
    }
    lastScrollTopRef.current = el.scrollTop;

    // Load more when scrolled near the top
    if (el.scrollTop < 200 && !isLoadingMore && !allLoaded && backlogDone) {
      loadMore();
    }
  }, [loadMore, isLoadingMore, allLoaded, backlogDone]);

  const handleWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < -2 && !isNearBottom()) {
      pinnedToBottomRef.current = false;
      userScrolledRef.current = true;
      setShowScrollBtn(true);
    }
  }, [isNearBottom]);

  const handleTouchStart = useCallback((event: TouchEvent<HTMLDivElement>) => {
    touchStartYRef.current = event.touches[0]?.clientY ?? null;
  }, []);

  const handleTouchMove = useCallback((event: TouchEvent<HTMLDivElement>) => {
    const startY = touchStartYRef.current;
    const currentY = event.touches[0]?.clientY;
    if (startY === null || currentY === undefined) return;
    if (currentY > startY + 4 && !isNearBottom()) {
      pinnedToBottomRef.current = false;
      userScrolledRef.current = true;
      setShowScrollBtn(true);
    }
  }, [isNearBottom]);

  return (
    <div className="awareness-pane" style={paneStyle}>
      <div
        className="awareness-pane-messages"
        ref={scrollContainerRef}
        onScroll={handleScroll}
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
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
              <AwarenessEntryComponent
                key={entry.id}
                entry={entry}
                onExpandingContent={handleExpandingContent}
              />
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
        onHeightChange={handleComposerHeightChange}
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

function getLiveScrollSignal(entries: AwarenessEntry[]): string {
  const last = entries[entries.length - 1];
  if (!last) return 'empty';
  const contentSignal = (last.content || []).map(getContentBlockSignal).join('|');
  return `${last.id}:${last.role || ''}:${last.isStreaming ? 'streaming' : 'settled'}:${contentSignal}`;
}

function getContentBlockSignal(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return `text:${block.text.length}`;
    case 'thinking':
      return `thinking:${block.thinking.length}`;
    case 'toolCall':
      return `tool:${block.id}:${block.name}:${JSON.stringify(block.arguments || {}).length}`;
    case 'toolOutput':
      return `output:${block.toolCallId}:${block.stream}:${block.pid || ''}:${block.text.length}`;
    case 'toolResult':
      return `result:${block.toolCallId}:${block.isError ? 'error' : 'ok'}:${block.result.length}`;
    default:
      return 'unknown';
  }
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
      const resultId = getToolResultId(result);
      const assistantIndex = findAssistantWithToolCall(normalized, resultId);
      if (assistantIndex === -1) {
        unmerged.push(result);
        continue;
      }

      const assistant = normalized[assistantIndex];
      const content = assistant.content || [];
      const alreadyMerged = content.some(
        (block) => block.type === 'toolResult' && getToolResultId(block) === resultId,
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
  if (!toolCallId) return -1;
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

function getToolResultId(result: ToolResultContent): string {
  return String((result as ToolResultContent & {
    tool_call_id?: string;
    toolUseId?: string;
    tool_use_id?: string;
  }).toolCallId || (result as any).tool_call_id || (result as any).toolUseId || (result as any).tool_use_id || '');
}
