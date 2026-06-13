import type { StreamStatus } from '../hooks/useWebChat';

interface ChatTopBarProps {
  agentName?: string;
  connectionState: 'connecting' | 'connected' | 'reconnecting';
  chatStatus: StreamStatus;
  isLoading: boolean;
  isLoadingMore: boolean;
}

function chatStatusLabel(status: StreamStatus, isLoading: boolean, isLoadingMore: boolean): string {
  if (isLoading) return 'loading history';
  if (isLoadingMore) return 'loading older messages';
  switch (status) {
    case 'waking':
      return 'waking';
    case 'connecting':
      return 'connecting';
    case 'steering':
      return 'updating';
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

export function ChatTopBar({
  agentName,
  connectionState,
  chatStatus,
  isLoading,
  isLoadingMore,
}: ChatTopBarProps) {
  const status = chatStatusLabel(chatStatus, isLoading, isLoadingMore);
  const live = connectionState === 'connected' && !isLoading;
  const showStatus = status !== 'idle';

  return (
    <div className="chat-top-shell">
      <div className="chat-top-bar" aria-label="Chat status">
        <div className="chat-top-identity">
          <span className={`chat-live-dot ${live ? 'connected' : 'reconnecting'}`} aria-hidden="true" />
          <span className="chat-agent-name">{agentName || 'Workspace'}</span>
        </div>

        {showStatus && <span className="chat-top-status">{status}</span>}
      </div>
    </div>
  );
}
