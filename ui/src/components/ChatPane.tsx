import { useRef, useEffect, useCallback, useState } from 'react';
import { useAwarenessStream } from '../hooks/useAwarenessStream';
import { useWebChat } from '../hooks/useWebChat';
import { mergeOptimisticEntries } from '../optimisticEntries';
import { AwarenessEntryComponent } from './AwarenessEntry';
import { InputBar } from './InputBar';
import { SettingsMenu } from './SettingsMenu';
import { isSettingsCommand } from '../slashCommands';

export function ChatPane() {
  const { entries, isLoading, error: streamError } = useAwarenessStream();
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const error = localError || chatError || streamError;

  const visibleEntries = mergeOptimisticEntries(entries, userEntry, streamingEntry, localEntries);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(scrollToBottom, [entries, streamingEntry, scrollToBottom]);

  const handleSend = useCallback((text: string) => {
    setLocalError(null);
    sendMessage(text);
  }, [sendMessage]);

  const handleSlashCommand = useCallback((text: string) => {
    if (isSettingsCommand(text)) {
      setLocalError(null);
      setSettingsOpen(true);
      return true;
    }
    return false;
  }, []);

  const clearVisibleError = useCallback(() => {
    if (localError) {
      setLocalError(null);
      return;
    }
    clearError();
  }, [clearError, localError]);

  return (
    <div className="chat-pane">
      <div className="chat-messages">
        {isLoading ? (
          <div className="chat-empty">
            <p className="chat-empty-text">Loading awareness...</p>
          </div>
        ) : visibleEntries.length === 0 ? (
          <div className="chat-empty">
            <p className="chat-empty-text">Send a message to get started.</p>
          </div>
        ) : (
          <div className="chat-stream">
            {visibleEntries.map((entry) => (
              <AwarenessEntryComponent key={entry.id} entry={entry} />
            ))}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {error && (
        <div className="error-banner" onClick={clearVisibleError}>
          <span className="error-text">{error}</span>
          <span className="error-dismiss">&times;</span>
        </div>
      )}

      <SettingsMenu open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <InputBar
        onSend={handleSend}
        onStop={abortStream}
        disabled={isStreaming}
        isStreaming={isStreaming}
        onSlashCommand={handleSlashCommand}
        onInvalidSlashCommand={(command) => setLocalError(`Unknown command: ${command}`)}
      />
    </div>
  );
}
