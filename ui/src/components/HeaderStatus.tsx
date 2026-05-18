import { useAwarenessStream } from '../hooks/useAwarenessStream';

function formatStatusTime(ts: string | null): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function HeaderStatus() {
  const { connectionState, lastEventAt, isLoading } = useAwarenessStream();
  const live = connectionState === 'connected' && !isLoading;
  const eventTime = formatStatusTime(lastEventAt);
  const label = isLoading ? 'Loading history' : connectionState === 'connected' ? 'Connected' : 'Reconnecting';

  return (
    <div className="header-status" aria-label={`${label}${eventTime ? `, last event ${eventTime}` : ''}`} title={`${label}${eventTime ? ` · ${eventTime}` : ''}`}>
      <span className={`status-dot ${live ? 'connected' : 'reconnecting'}`} />
      {eventTime && <span className="header-status-time">{eventTime}</span>}
    </div>
  );
}
