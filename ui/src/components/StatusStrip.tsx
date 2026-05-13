import type { StreamStatus } from '../hooks/useWebChat';

interface StatusStripProps {
  connectionState: 'connecting' | 'connected' | 'reconnecting';
  chatStatus: StreamStatus;
  isLoading: boolean;
  isLoadingMore: boolean;
  lastEventAt: string | null;
}

function formatStatusTime(ts: string | null): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

function chatLabel(status: StreamStatus): string {
  switch (status) {
    case 'connecting':
      return 'waking';
    case 'streaming':
      return 'responding';
    case 'tool_running':
      return 'using tools';
    case 'stopping':
      return 'stopping';
    case 'error':
      return 'error';
    case 'idle':
    default:
      return 'idle';
  }
}

export function StatusStrip({
  connectionState,
  chatStatus,
  isLoading,
  isLoadingMore,
  lastEventAt,
}: StatusStripProps) {
  const live = connectionState === 'connected';
  const eventTime = formatStatusTime(lastEventAt);

  return (
    <div className="status-strip" aria-live="polite">
      <span className={`status-dot ${live ? 'connected' : 'reconnecting'}`} />
      <span className="status-label">
        {isLoading ? 'loading history' : connectionState}
      </span>
      <span className="status-divider" />
      <span className={`status-label chat-status chat-status-${chatStatus}`}>
        {chatLabel(chatStatus)}
      </span>
      {isLoadingMore && (
        <>
          <span className="status-divider" />
          <span className="status-label">older messages</span>
        </>
      )}
      {eventTime && (
        <>
          <span className="status-divider" />
          <span className="status-label muted">{eventTime}</span>
        </>
      )}
    </div>
  );
}
