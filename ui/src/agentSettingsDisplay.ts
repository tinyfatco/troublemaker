import type { AgentSettingsSnapshot } from './console-api';

export function formatCurrentModel(snapshot: AgentSettingsSnapshot | null): string {
  if (!snapshot) return 'model loading';
  if (snapshot.provider && snapshot.model) return `${snapshot.provider}/${snapshot.model}`;
  return snapshot.model || 'default model';
}

export function compactModelLabel(snapshot: AgentSettingsSnapshot | null): string {
  const value = formatCurrentModel(snapshot);
  if (value === 'model loading' || value === 'default model') return value;
  const parts = value.split('/');
  const model = parts[parts.length - 1] || value;
  const provider = parts.length > 1 ? parts[0] : '';
  return provider ? `${provider} / ${model}` : model;
}

export function formatThinkingLevel(snapshot: AgentSettingsSnapshot | null): string {
  if (!snapshot) return 'thinking ...';
  const level = String(snapshot.thinking_level || 'off');
  return `thinking ${level}`;
}
