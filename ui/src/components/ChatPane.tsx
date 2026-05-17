import { useRef, useEffect, useCallback } from 'react';
import { useAwarenessStream } from '../hooks/useAwarenessStream';
import { useWebChat } from '../hooks/useWebChat';
import { AwarenessEntryComponent } from './AwarenessEntry';
import { InputBar } from './InputBar';

export function ChatPane() {
  const { entries, isLoading, error: streamError } = useAwarenessStream();
  const {
    userEntry,
    streamingEntry,
    isStreaming,
    error: chatError,
    sendMessage,
    abortStream,
    clearError,
  } = useWebChat();

  const error = chatError || streamError;

  // Dedup: hide optimistic entries once the awareness stream has the real versions.
  // The awareness stream delivers the user message first, then the assistant response.
  // Bound matching to this turn so repeated identical messages don't hide the
  // new streaming entry behind an older user/assistant pair.
  const lastUserText = userEntry?.strippedText || '';
  const turnEntries = userEntry
    ? entries.filter((entry) => isEntryAtOrAfter(entry, userEntry.timestamp))
    : [];
  const awarenessHasUser = lastUserText && entries.length > 0 &&
    turnEntries.some((e) => e.role === 'user' && e.strippedText === lastUserText);
  const awarenessHasAssistant = awarenessHasUser &&
    turnEntries.some((e) => e.role === 'assistant' && !e.isStreaming);

  const showUserEntry = userEntry && !awarenessHasUser;
  const showStreamingEntry = streamingEntry && !awarenessHasAssistant;

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(scrollToBottom, [entries, streamingEntry, scrollToBottom]);

  return (
    <div className="chat-pane">
      <div className="chat-messages">
        {isLoading ? (
          <div className="chat-empty">
            <p className="chat-empty-text">Loading awareness...</p>
          </div>
        ) : entries.length === 0 && !showUserEntry && !showStreamingEntry ? (
          <div className="chat-empty">
            <p className="chat-empty-text">Send a message to get started.</p>
          </div>
        ) : (
          <div className="chat-stream">
            {entries.map((entry) => (
              <AwarenessEntryComponent key={entry.id} entry={entry} />
            ))}
            {showUserEntry && <AwarenessEntryComponent key={userEntry.id} entry={userEntry} />}
            {showStreamingEntry && <AwarenessEntryComponent key={streamingEntry.id} entry={streamingEntry} />}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {error && (
        <div className="error-banner" onClick={clearError}>
          <span className="error-text">{error}</span>
          <span className="error-dismiss">&times;</span>
        </div>
      )}

      <InputBar
        onSend={sendMessage}
        onStop={abortStream}
        disabled={isStreaming}
        isStreaming={isStreaming}
      />
    </div>
  );
}

function isEntryAtOrAfter(entry: { timestamp: string }, since: string): boolean {
  const entryMs = Date.parse(entry.timestamp);
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(entryMs) || !Number.isFinite(sinceMs)) return false;
  return entryMs >= sinceMs - 5000;
}
