import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_REALTIME_VOICE,
  REALTIME_VOICE_OPTIONS,
  fetchRealtimeVoicePreference,
  previewRealtimeVoice,
  setRealtimeVoicePreference,
  type RealtimeVoiceOption,
} from '../console-api';

interface VoiceSettingsMenuProps {
  open: boolean;
  onClose: () => void;
}

type VoiceStatus = 'idle' | 'loading' | 'saving' | 'previewing';

export function VoiceSettingsMenu({ open, onClose }: VoiceSettingsMenuProps) {
  const [currentVoice, setCurrentVoice] = useState(DEFAULT_REALTIME_VOICE);
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null);
  const [savingVoice, setSavingVoice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  const subtitle = useMemo(() => {
    if (status === 'loading') return 'Loading...';
    return `Current: ${currentVoice}`;
  }, [currentVoice, status]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStatus('loading');
    setError(null);
    fetchRealtimeVoicePreference()
      .then((voice) => {
        if (!cancelled) setCurrentVoice(voice);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load voices');
      })
      .finally(() => {
        if (!cancelled) setStatus('idle');
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => () => stopPreview(), []);

  if (!open) return null;

  const chooseVoice = async (voice: string) => {
    if (voice === currentVoice || status === 'saving') return;
    stopPreview();
    setSavingVoice(voice);
    setStatus('saving');
    setError(null);
    try {
      await setRealtimeVoicePreference(voice);
      setCurrentVoice(voice);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save voice');
    } finally {
      setSavingVoice(null);
      setStatus('idle');
    }
  };

  const playPreview = async (voice: string) => {
    if (status === 'previewing' && previewingVoice === voice) {
      stopPreview();
      setStatus('idle');
      return;
    }

    stopPreview();
    setPreviewingVoice(voice);
    setStatus('previewing');
    setError(null);
    try {
      const audio = await previewRealtimeVoice(voice);
      const url = URL.createObjectURL(audio);
      audioUrlRef.current = url;
      const player = new Audio(url);
      audioRef.current = player;
      player.onended = () => {
        stopPreview();
        setStatus('idle');
      };
      player.onerror = () => {
        stopPreview();
        setStatus('idle');
        setError('Voice preview failed to play.');
      };
      await player.play();
    } catch (err) {
      stopPreview();
      setStatus('idle');
      setError(err instanceof Error ? err.message : 'Failed to preview voice');
    }
  };

  const busy = status === 'loading' || status === 'saving';

  return (
    <div className="settings-menu voice-settings-menu" role="dialog" aria-label="Voice">
      <div className="settings-menu-header">
        <div>
          <div className="settings-menu-title">Voice</div>
          <div className="settings-menu-subtitle">{subtitle}</div>
        </div>
        <button className="settings-icon-button" type="button" onClick={onClose} aria-label="Close voice settings">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {status === 'loading' ? (
        <div className="settings-menu-status">Loading voices...</div>
      ) : (
        <div className="voice-settings-list">
          {REALTIME_VOICE_OPTIONS.map((voice) => (
            <VoiceRow
              key={voice.name}
              voice={voice}
              current={voice.name === currentVoice}
              previewing={previewingVoice === voice.name && status === 'previewing'}
              saving={savingVoice === voice.name}
              disabled={busy}
              onPreview={() => void playPreview(voice.name)}
              onSelect={() => void chooseVoice(voice.name)}
            />
          ))}
        </div>
      )}

      {error && <div className="settings-menu-error">{error}</div>}
    </div>
  );

  function stopPreview() {
    audioRef.current?.pause();
    audioRef.current = null;
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    setPreviewingVoice(null);
  }
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
