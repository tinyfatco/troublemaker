import { useEffect, useState } from 'react';
import { configureAgentSetting, fetchAgentSettings, type AgentSettingsSnapshot } from '../console-api';

interface SettingsMenuProps {
  open: boolean;
  onClose: () => void;
}

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const SPONTANEITY_LEVELS = [1, 2, 3, 4, 5];

export function SettingsMenu({ open, onClose }: SettingsMenuProps) {
  const [snapshot, setSnapshot] = useState<AgentSettingsSnapshot | null>(null);
  const [modelInput, setModelInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  if (!open) return null;

  const refresh = async () => {
    const data = await fetchAgentSettings();
    setSnapshot(data);
    setModelInput(formatCurrentModel(data));
  };

  const apply = async (target: string, value: unknown) => {
    setSaving(target);
    setError(null);
    try {
      await configureAgentSetting(target, value);
      await refresh();
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

  return (
    <div className="settings-menu" role="dialog" aria-label="Settings">
      <div className="settings-menu-header">
        <div>
          <div className="settings-menu-title">Settings</div>
          <div className="settings-menu-subtitle">{snapshot ? formatCurrentModel(snapshot) : 'Loading...'}</div>
        </div>
        <button className="settings-icon-button" type="button" onClick={onClose} aria-label="Close settings">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {loading ? (
        <div className="settings-menu-status">Loading settings...</div>
      ) : !snapshot ? (
        <div className="settings-menu-status">Settings unavailable.</div>
      ) : (
        <div className="settings-menu-body">
          <form
            className="settings-row model-row"
            onSubmit={(event) => {
              event.preventDefault();
              if (modelInput.trim()) void apply('model', modelInput.trim());
            }}
          >
            <label htmlFor="agent-model-input">Model</label>
            <div className="settings-inline-control">
              <input
                id="agent-model-input"
                value={modelInput}
                onChange={(event) => setModelInput(event.target.value)}
                disabled={!!saving}
                spellCheck={false}
              />
              <button type="submit" disabled={!modelInput.trim() || !!saving}>
                {saving === 'model' ? 'Saving' : 'Apply'}
              </button>
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
      )}

      {error && <div className="settings-menu-error">{error}</div>}
    </div>
  );
}

function formatCurrentModel(snapshot: AgentSettingsSnapshot): string {
  if (snapshot.provider && snapshot.model) return `${snapshot.provider}/${snapshot.model}`;
  return snapshot.model || 'default model';
}
