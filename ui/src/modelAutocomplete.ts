import type { AgentModelOption } from './console-api';

export interface ModelSuggestion extends AgentModelOption {
  value: string;
}

const MODEL_ALIASES: Record<string, string[]> = {
  'fireworks/accounts/fireworks/models/minimax-m2p7': ['minimax', 'm2p7', 'minimax-m2p7'],
  'fireworks/accounts/fireworks/models/deepseek-v4-pro': ['deepseek', 'deepseek-v4'],
  'fireworks/accounts/fireworks/models/kimi-k2p6': ['kimi', 'kimi-k2'],
  'fireworks/accounts/fireworks/models/glm-5p1': ['glm', 'glm5', 'glm-5.1', 'glm-5p1'],
  'fireworks/accounts/fireworks/models/qwen3p6-plus': ['qwen', 'qwen3p6', 'qwen3.6'],
  'anthropic/claude-opus-4-6': ['opus', 'opus-4.6'],
  'anthropic/claude-sonnet-4-6': ['sonnet', 'sonnet-4.6'],
  'anthropic/claude-haiku-4-5-20251001': ['haiku', 'haiku-4.5'],
  'openai-codex/gpt-5.5': ['gpt5', 'gptfive', 'gpt-5'],
  'openai/gpt-5.5': ['gpt5', 'gptfive', 'gpt-5'],
  'openai-codex/codex-5.3': ['codex'],
};

export function formatModelValue(option: AgentModelOption): string {
  return `${option.provider}/${option.id}`;
}

export function getModelSuggestions(
  options: AgentModelOption[],
  query: string,
  currentValue?: string | null,
  limit = 8,
): ModelSuggestion[] {
  const normalizedQuery = normalize(query);
  const normalizedCurrent = normalize(currentValue ?? '');
  const seen = new Set<string>();

  return options
    .map((option) => {
      const value = formatModelValue(option);
      const normalizedValue = normalize(value);
      if (seen.has(normalizedValue)) return null;
      seen.add(normalizedValue);
      return {
        ...option,
        value,
        score: scoreModel(option, value, normalizedQuery, normalizedCurrent),
      };
    })
    .filter((item): item is ModelSuggestion & { score: number } => item !== null && item.score < Number.POSITIVE_INFINITY)
    .sort((a, b) => a.score - b.score || a.value.localeCompare(b.value))
    .slice(0, limit)
    .map(({ score: _score, ...item }) => item);
}

function scoreModel(
  option: AgentModelOption,
  value: string,
  query: string,
  currentValue: string,
): number {
  const normalizedValue = normalize(value);
  const id = normalize(option.id);
  const provider = normalize(option.provider);
  const name = normalize(option.name);
  const api = normalize(option.api);
  const aliases = MODEL_ALIASES[normalizedValue] ?? [];

  if (!query) return normalizedValue === currentValue ? 0 : 20;
  if (normalizedValue === query || id === query || aliases.some((alias) => normalize(alias) === query)) return 0;
  if (normalizedValue.startsWith(query)) return 1;
  if (id.startsWith(query)) return 2;
  if (name.startsWith(query)) return 3;
  if (aliases.some((alias) => normalize(alias).startsWith(query))) return 4;
  if (normalizedValue.includes(query)) return 5;
  if (id.includes(query)) return 6;
  if (name.includes(query)) return 7;
  if (aliases.some((alias) => normalize(alias).includes(query))) return 8;
  if (provider.includes(query) || api.includes(query)) return 9;

  const tokens = query.split(/\s+/).filter(Boolean);
  const haystack = [normalizedValue, id, provider, name, api, aliases.map(normalize).join(' ')].join(' ');
  if (tokens.length > 1 && tokens.every((token) => haystack.includes(token))) return 10;

  return Number.POSITIVE_INFINITY;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
