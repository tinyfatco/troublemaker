import type { UseAwarenessStreamReturn } from '../hooks/useAwarenessStream';

interface HeaderStatusProps {
  stream: Pick<UseAwarenessStreamReturn, 'connectionState' | 'isLoading'>;
}

export function HeaderStatus({ stream }: HeaderStatusProps) {
  const { connectionState, isLoading } = stream;
  const live = connectionState === 'connected' && !isLoading;
  const label = isLoading ? 'Loading history' : connectionState === 'connected' ? 'Connected' : 'Reconnecting';

  return (
    <div className="header-status" aria-label={label} title={label}>
      <span className={`status-dot ${live ? 'connected' : 'reconnecting'}`} />
    </div>
  );
}
