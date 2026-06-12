import { useEffect, useMemo, useState } from 'react';
import type { ContextWindowStatus } from '../contextWindowStatus';
import { compactModelLabel, formatCurrentModel, formatThinkingLevel } from '../agentSettingsDisplay';
import { fetchAgentSettings, type AgentSettingsSnapshot } from '../console-api';
import type { StreamStatus } from '../hooks/useWebChat';
import type { VoiceMode, VoiceState } from '../hooks/useVoiceChat';

interface ChatTopBarProps {
  agentName?: string;
  connectionState: 'connecting' | 'connected' | 'reconnecting';
  chatStatus: StreamStatus;
  isLoading: boolean;
  isLoadingMore: boolean;
  contextWindow: ContextWindowStatus;
  allowSettings: boolean;
  allowVoice: boolean;
  voiceMode: VoiceMode;
  voiceState: VoiceState;
  isVoiceActive: boolean;
  settingsVersion?: number;
  onOpenSettings: () => void;
  onOpenVoiceSettings: () => void;
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

function modeLabel(isVoiceActive: boolean, voiceMode: VoiceMode, voiceState: VoiceState): string {
  if (!isVoiceActive) return 'text chat';
  const label = voiceMode === 'turn' ? 'turn voice' : 'realtime voice';
  return voiceState === 'listening' ? label : `${label} ${voiceState}`;
}

export function ChatTopBar({
  agentName,
  connectionState,
  chatStatus,
  isLoading,
  isLoadingMore,
  contextWindow,
  allowSettings,
  allowVoice,
  voiceMode,
  voiceState,
  isVoiceActive,
  settingsVersion = 0,
  onOpenSettings,
  onOpenVoiceSettings,
}: ChatTopBarProps) {
  const [snapshot, setSnapshot] = useState<AgentSettingsSnapshot | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(false);

  useEffect(() => {
    if (!allowSettings) return;
    let cancelled = false;
    setSettingsError(null);
    fetchAgentSettings()
      .then((data) => {
        if (!cancelled) setSnapshot(data);
      })
      .catch((err) => {
        if (!cancelled) setSettingsError(err instanceof Error ? err.message : 'Settings unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, [allowSettings, settingsVersion]);

  const status = chatStatusLabel(chatStatus, isLoading, isLoadingMore);
  const live = connectionState === 'connected' && !isLoading;
  const activeModeLabel = modeLabel(isVoiceActive, voiceMode, voiceState);
  const modelLabel = useMemo(() => compactModelLabel(snapshot), [snapshot]);
  const modelTitle = useMemo(() => formatCurrentModel(snapshot), [snapshot]);
  const thinkingLabel = useMemo(() => formatThinkingLevel(snapshot), [snapshot]);

  return (
    <div className="chat-top-shell">
      <div className="chat-top-bar" aria-label="Chat status and controls">
        <div className="chat-top-identity">
          <span className={`chat-live-dot ${live ? 'connected' : 'reconnecting'}`} aria-hidden="true" />
          <span className="chat-agent-name">{agentName || 'Workspace'}</span>
          <span className="chat-thread-label">current thread</span>
        </div>

        <div className="chat-top-controls">
          <span className={`chat-mode-chip ${isVoiceActive ? 'voice-active' : ''}`} title={status}>
            {activeModeLabel}
          </span>
          {allowSettings && (
            <>
              <button className="chat-chip chat-model-chip" type="button" onClick={onOpenSettings} title={modelTitle}>
                {modelLabel}
              </button>
              <button className="chat-chip" type="button" onClick={onOpenSettings} title={settingsError || thinkingLabel}>
                {settingsError ? 'settings unavailable' : thinkingLabel}
              </button>
            </>
          )}
          <button
            className={`chat-icon-button ${contextOpen ? 'active' : ''}`}
            type="button"
            onClick={() => setContextOpen((open) => !open)}
            aria-expanded={contextOpen}
            aria-label="Context details"
            title="Context details"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 3.5h10M3 8h10M3 12.5h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          {allowVoice && (
            <button
              className="chat-icon-button"
              type="button"
              onClick={onOpenVoiceSettings}
              aria-label="Voice settings"
              title="Voice settings"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 2.25a2 2 0 0 0-2 2V8a2 2 0 1 0 4 0V4.25a2 2 0 0 0-2-2Z" stroke="currentColor" strokeWidth="1.45" />
                <path d="M3.75 7.5a4.25 4.25 0 0 0 8.5 0M8 11.75v2" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
              </svg>
            </button>
          )}
          {allowSettings && (
            <button className="chat-icon-button" type="button" onClick={onOpenSettings} aria-label="Settings" title="Settings">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M6.7 2.25h2.6l.35 1.35c.32.12.62.3.9.52l1.34-.38 1.3 2.25-1 .98c.03.17.05.34.05.53s-.02.36-.05.53l1 .98-1.3 2.25-1.34-.38c-.28.22-.58.4-.9.52l-.35 1.35H6.7l-.35-1.35c-.32-.12-.62-.3-.9-.52l-1.34.38-1.3-2.25 1-.98a3.1 3.1 0 0 1-.05-.53c0-.19.02-.36.05-.53l-1-.98 1.3-2.25 1.34.38c.28-.22.58-.4.9-.52l.35-1.35Z" stroke="currentColor" strokeWidth="1.15" strokeLinejoin="round" />
                <circle cx="8" cy="7.5" r="1.75" stroke="currentColor" strokeWidth="1.15" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {contextOpen && <ContextInspector contextWindow={contextWindow} voiceMode={voiceMode} />}
    </div>
  );
}

function ContextInspector({
  contextWindow,
  voiceMode,
}: {
  contextWindow: ContextWindowStatus;
  voiceMode: VoiceMode;
}) {
  return (
    <div className="context-inspector" role="status">
      <div className="context-inspector-row">
        <span>Loaded context</span>
        <strong>{contextWindow.contextLabel}</strong>
      </div>
      <div className="context-inspector-row">
        <span>History scope</span>
        <strong>{contextWindow.sourceLabel}</strong>
      </div>
      {contextWindow.realtime && (
        <>
          <div className="context-inspector-meter" aria-hidden="true">
            <span style={{ width: `${contextWindow.realtime.percentOfCap}%` }} />
          </div>
          <div className="context-inspector-note">
            {voiceMode === 'realtime'
              ? contextWindow.realtime.title
              : 'Turn-based voice uses the normal text agent path and does not use the Realtime handoff budget.'}
          </div>
        </>
      )}
    </div>
  );
}
