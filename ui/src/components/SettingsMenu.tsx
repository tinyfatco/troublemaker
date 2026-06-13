import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_REALTIME_VOICE,
  REALTIME_VOICE_OPTIONS,
  configureAgentSetting,
  fetchAgentSettings,
  fetchRealtimeVoicePreference,
  previewRealtimeVoice,
  setRealtimeVoicePreference,
  type AgentSettingsSnapshot,
  type RealtimeVoiceOption,
} from '../console-api';
import { formatCurrentModel } from '../agentSettingsDisplay';
import { getModelSuggestions } from '../modelAutocomplete';

type SettingsSection = 'turn' | 'voice';
type VoiceStatus = 'idle' | 'loading' | 'saving' | 'previewing';
type VoiceModeSetting = 'realtime' | 'turn';

interface SettingsMenuProps {
  open: boolean;
  onClose: () => void;
  initialSection?: SettingsSection;
  focusVersion?: number;
  voiceMode?: VoiceModeSetting;
  onVoiceModeChange?: (mode: VoiceModeSetting) => void;
}

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const SPONTANEITY_LEVELS = [1, 2, 3, 4, 5];

export function SettingsMenu({
  open,
  onClose,
  initialSection = 'turn',
  focusVersion = 0,
  voiceMode,
  onVoiceModeChange,
}: SettingsMenuProps) {
  const [snapshot, setSnapshot] = useState<AgentSettingsSnapshot | null>(null);
  const [modelInput, setModelInput] = useState('');
  const [modelFocused, setModelFocused] = useState(false);
  const [activeModelSuggestion, setActiveModelSuggestion] = useState(0);
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentVoice, setCurrentVoice] = useState(DEFAULT_REALTIME_VOICE);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>('idle');
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null);
  const [savingVoice, setSavingVoice] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (open) setActiveSection(initialSection);
  }, [focusVersion, initialSection, open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchAgentSettings()
      .then((data) => {
        if (cancelled) return;
        setSnapshot(data);
        setModelInput(formatCurrentModel(data));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load settings');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setVoiceStatus('loading');
    setVoiceError(null);
    fetchRealtimeVoicePreference()
      .then((voice) => {
        if (!cancelled) setCurrentVoice(voice);
      })
      .catch((err) => {
        if (!cancelled) setVoiceError(err instanceof Error ? err.message : 'Failed to load voices');
      })
      .finally(() => {
        if (!cancelled) setVoiceStatus('idle');
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => () => stopVoicePreview(), []);

  const modelSuggestions = useMemo(
    () => getModelSuggestions(snapshot?.models ?? [], modelInput, snapshot ? formatCurrentModel(snapshot) : null),
    [modelInput, snapshot],
  );

  useEffect(() => {
    setActiveModelSuggestion(0);
  }, [modelInput, modelSuggestions.length]);

  if (!open) return null;

  const apply = async (target: string, value: unknown) => {
    if (isCurrentSetting(snapshot, target, value)) return;
    setSaving(target);
    setError(null);
    try {
      await configureAgentSetting(target, value);
      setSnapshot((current) => applyLocalSetting(current, target, value));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save setting');
    } finally {
      setSaving(null);
    }
  };

  const currentThinking = String(snapshot?.thinking_level ?? 'off');
  const acceptedThinking = snapshot?.thinking_level_accepted?.length
    ? snapshot.thinking_level_accepted
    : THINKING_LEVELS;
  const spontaneity = snapshot?.spontaneity;
  const currentSpontaneityLevel = Number(spontaneity?.level ?? 3);
  const showModelSuggestions = modelFocused && modelSuggestions.length > 0 && !saving;
  const busyVoice = voiceStatus === 'loading' || voiceStatus === 'saving';
  const subtitle = activeSection === 'voice'
    ? voiceStatus === 'loading'
      ? 'Loading voice settings...'
      : `Voice: ${currentVoice}`
    : snapshot
      ? formatCurrentModel(snapshot)
      : 'Loading...';

  const chooseModelSuggestion = (value: string) => {
    setModelInput(value);
    setModelFocused(false);
  };

  const chooseVoice = async (voice: string) => {
    if (voice === currentVoice || voiceStatus === 'saving') return;
    stopVoicePreview();
    setSavingVoice(voice);
    setVoiceStatus('saving');
    setVoiceError(null);
    try {
      await setRealtimeVoicePreference(voice);
      setCurrentVoice(voice);
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : 'Failed to save voice');
    } finally {
      setSavingVoice(null);
      setVoiceStatus('idle');
    }
  };

  const playPreview = async (voice: string) => {
    if (voiceStatus === 'previewing' && previewingVoice === voice) {
      stopVoicePreview();
      setVoiceStatus('idle');
      return;
    }

    stopVoicePreview();
    setPreviewingVoice(voice);
    setVoiceStatus('previewing');
    setVoiceError(null);
    try {
      const audio = await previewRealtimeVoice(voice);
      const url = URL.createObjectURL(audio);
      audioUrlRef.current = url;
      const player = new Audio(url);
      audioRef.current = player;
      player.onended = () => {
        stopVoicePreview();
        setVoiceStatus('idle');
      };
      player.onerror = () => {
        stopVoicePreview();
        setVoiceStatus('idle');
        setVoiceError('Voice preview failed to play.');
      };
      await player.play();
    } catch (err) {
      stopVoicePreview();
      setVoiceStatus('idle');
      setVoiceError(err instanceof Error ? err.message : 'Failed to preview voice');
    }
  };

  return (
    <div className="settings-menu" role="dialog" aria-label="Settings">
      <div className="settings-menu-header">
        <div>
          <div className="settings-menu-title">Settings</div>
          <div className="settings-menu-subtitle">{subtitle}</div>
        </div>
        <button className="settings-icon-button" type="button" onClick={onClose} aria-label="Close settings">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="settings-menu-tabs" role="tablist" aria-label="Settings sections">
        <button
          type="button"
          className={activeSection === 'turn' ? 'active' : ''}
          onClick={() => setActiveSection('turn')}
          role="tab"
          aria-selected={activeSection === 'turn'}
        >
          Turn
        </button>
        <button
          type="button"
          className={activeSection === 'voice' ? 'active' : ''}
          onClick={() => setActiveSection('voice')}
          role="tab"
          aria-selected={activeSection === 'voice'}
        >
          Voice
        </button>
      </div>

      {activeSection === 'turn' && loading ? (
        <div className="settings-menu-status">Loading settings...</div>
      ) : activeSection === 'turn' && !snapshot ? (
        <div className="settings-menu-status">Settings unavailable.</div>
      ) : activeSection === 'turn' ? (
        <div className="settings-menu-body">
          <form
            className="settings-row model-row"
            onSubmit={(event) => {
              event.preventDefault();
              if (modelInput.trim()) void apply('model', modelInput.trim());
            }}
          >
            <label htmlFor="agent-model-input">Model</label>
            <div className="settings-autocomplete">
              <div className="settings-inline-control">
                <input
                  id="agent-model-input"
                  value={modelInput}
                  onChange={(event) => setModelInput(event.target.value)}
                  onFocus={() => setModelFocused(true)}
                  onBlur={() => window.setTimeout(() => setModelFocused(false), 120)}
                  onKeyDown={(event) => {
                    if (!showModelSuggestions) return;
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      setActiveModelSuggestion((index) => Math.min(index + 1, modelSuggestions.length - 1));
                    } else if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      setActiveModelSuggestion((index) => Math.max(index - 1, 0));
                    } else if (event.key === 'Enter' && modelSuggestions[activeModelSuggestion]) {
                      event.preventDefault();
                      chooseModelSuggestion(modelSuggestions[activeModelSuggestion].value);
                    } else if (event.key === 'Escape') {
                      setModelFocused(false);
                    }
                  }}
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded={showModelSuggestions}
                  aria-controls="agent-model-suggestions"
                  disabled={!!saving}
                  spellCheck={false}
                />
                <button type="submit" disabled={!modelInput.trim() || !!saving}>
                  {saving === 'model' ? 'Saving' : 'Apply'}
                </button>
              </div>
              {showModelSuggestions && (
                <div id="agent-model-suggestions" className="settings-model-suggestions" role="listbox">
                  {modelSuggestions.map((model, index) => (
                    <button
                      key={model.value}
                      type="button"
                      className={index === activeModelSuggestion ? 'active' : ''}
                      role="option"
                      aria-selected={index === activeModelSuggestion}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        chooseModelSuggestion(model.value);
                      }}
                    >
                      <span className="settings-model-value">{model.value}</span>
                      <span className="settings-model-meta">{model.name} - {model.api}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </form>

          <div className="settings-row">
            <span>Thinking</span>
            <div className="settings-segmented" role="group" aria-label="Thinking level">
              {acceptedThinking.map((level) => (
                <button
                  key={level}
                  type="button"
                  className={currentThinking === level ? 'active' : ''}
                  disabled={!!saving}
                  onClick={() => void apply('thinking_level', level)}
                >
                  {level}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-row compact-row">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={spontaneity?.enabled ?? true}
                disabled={!!saving}
                onChange={(event) => void apply('spontaneity.enabled', event.target.checked)}
              />
              <span>Spontaneity</span>
            </label>
            <div className="settings-segmented numeric" role="group" aria-label="Spontaneity level">
              {SPONTANEITY_LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  className={currentSpontaneityLevel === level ? 'active' : ''}
                  disabled={!!saving}
                  onClick={() => void apply('spontaneity.level', level)}
                >
                  {level}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="settings-menu-body voice-settings-body">
          {voiceMode && onVoiceModeChange && (
            <div className="settings-row">
              <span>Mode</span>
              <div className="settings-segmented" role="group" aria-label="Voice mode">
                <button
                  type="button"
                  className={voiceMode === 'realtime' ? 'active' : ''}
                  onClick={() => onVoiceModeChange('realtime')}
                >
                  Realtime
                </button>
                <button
                  type="button"
                  className={voiceMode === 'turn' ? 'active' : ''}
                  onClick={() => onVoiceModeChange('turn')}
                >
                  Turn
                </button>
              </div>
            </div>
          )}
          {voiceStatus === 'loading' ? (
            <div className="settings-menu-status inline">Loading voices...</div>
          ) : (
            <div className="voice-settings-list">
              {REALTIME_VOICE_OPTIONS.map((voice) => (
                <VoiceRow
                  key={voice.name}
                  voice={voice}
                  current={voice.name === currentVoice}
                  previewing={previewingVoice === voice.name && voiceStatus === 'previewing'}
                  saving={savingVoice === voice.name}
                  disabled={busyVoice}
                  onPreview={() => void playPreview(voice.name)}
                  onSelect={() => void chooseVoice(voice.name)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {(error || voiceError) && <div className="settings-menu-error">{error || voiceError}</div>}
    </div>
  );

  function stopVoicePreview() {
    audioRef.current?.pause();
    audioRef.current = null;
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    setPreviewingVoice(null);
  }
}

function isCurrentSetting(
  snapshot: AgentSettingsSnapshot | null,
  target: string,
  value: unknown,
): boolean {
  if (!snapshot) return false;
  if (target === 'thinking_level') return String(snapshot.thinking_level ?? 'off') === String(value);
  if (target === 'model' && typeof value === 'string') return formatCurrentModel(snapshot) === value;
  if (target === 'spontaneity.enabled') return snapshot.spontaneity?.enabled === value;
  if (target === 'spontaneity.level') return Number(snapshot.spontaneity?.level ?? 3) === value;
  return false;
}

function applyLocalSetting(
  snapshot: AgentSettingsSnapshot | null,
  target: string,
  value: unknown,
): AgentSettingsSnapshot | null {
  if (!snapshot) return snapshot;
  if (target === 'thinking_level') {
    return { ...snapshot, thinking_level: typeof value === 'string' ? value : snapshot.thinking_level };
  }
  if (target === 'model' && typeof value === 'string') {
    const slash = value.indexOf('/');
    if (slash > 0) {
      return {
        ...snapshot,
        provider: value.slice(0, slash),
        model: value.slice(slash + 1),
      };
    }
    return { ...snapshot, model: value };
  }
  if (target === 'spontaneity.enabled' && typeof value === 'boolean') {
    return {
      ...snapshot,
      spontaneity: { ...snapshot.spontaneity, enabled: value },
    };
  }
  if (target === 'spontaneity.level' && typeof value === 'number') {
    return {
      ...snapshot,
      spontaneity: { ...snapshot.spontaneity, level: value },
    };
  }
  return snapshot;
}

function VoiceRow({
  voice,
  current,
  previewing,
  saving,
  disabled,
  onPreview,
  onSelect,
}: {
  voice: RealtimeVoiceOption;
  current: boolean;
  previewing: boolean;
  saving: boolean;
  disabled: boolean;
  onPreview: () => void;
  onSelect: () => void;
}) {
  return (
    <div className={`voice-settings-row${current ? ' active' : ''}`}>
      <div className="voice-settings-copy">
        <div className="voice-settings-name">
          <span>{voice.name}</span>
          {current && <span className="voice-settings-current">Current</span>}
        </div>
        <div className="voice-settings-description">{voice.description}</div>
      </div>
      <div className="voice-settings-actions">
        <button
          className={`voice-preview-button${previewing ? ' active' : ''}`}
          type="button"
          onClick={onPreview}
          disabled={disabled && !previewing}
          aria-label={previewing ? `Stop ${voice.name} preview` : `Preview ${voice.name}`}
          title={previewing ? 'Stop preview' : 'Preview voice'}
        >
          {previewing ? (
            <svg viewBox="0 0 24 24" fill="none">
              <rect x="7" y="6" width="3.5" height="12" rx="1" fill="currentColor" />
              <rect x="13.5" y="6" width="3.5" height="12" rx="1" fill="currentColor" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M8 5v14l11-7L8 5z" fill="currentColor" />
            </svg>
          )}
        </button>
        <button
          className="voice-select-button"
          type="button"
          onClick={onSelect}
          disabled={disabled || current}
        >
          {saving ? 'Saving' : current ? 'Selected' : 'Select'}
        </button>
      </div>
    </div>
  );
}
