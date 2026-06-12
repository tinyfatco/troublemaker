import { parseContextLine, type AwarenessEntry, type ContentBlock } from './types';

export const REALTIME_CONTEXT_BACKLOG_LIMIT = 240;

const REALTIME_CONTEXTS: Record<string, { contextWindowTokens: number; outputReserveTokens: number }> = {
  'gpt-realtime-2': { contextWindowTokens: 32000, outputReserveTokens: 4096 },
};

export interface RealtimeContextConfig {
  model: string;
  contextWindowTokens: number;
  outputReserveTokens: number;
  postInstructionsTokenLimit: number;
  retentionRatio: number;
}

export interface RealtimeContextHandoff {
  text: string;
  warning: string | null;
  compacted: boolean;
  tokenEstimate: number;
  originalTokenEstimate: number;
  includedEntryCount: number;
  totalEntryCount: number;
}

export function realtimeContextConfig(model: string): RealtimeContextConfig {
  const config = REALTIME_CONTEXTS[model] ?? { contextWindowTokens: 32000, outputReserveTokens: 4096 };
  return {
    model,
    ...config,
    postInstructionsTokenLimit: Math.max(8000, config.contextWindowTokens - config.outputReserveTokens),
    retentionRatio: 0.8,
  };
}

export function createRealtimeTruncationConfig(model: string): Record<string, unknown> {
  const config = realtimeContextConfig(model);
  return {
    type: 'retention_ratio',
    retention_ratio: config.retentionRatio,
    token_limits: {
      post_instructions: config.postInstructionsTokenLimit,
    },
  };
}

export function buildRealtimeContextHandoff(
  entries: AwarenessEntry[],
  options: { model: string; totalEntryCount?: number; tokenLimit?: number } = { model: 'gpt-realtime-2' },
): RealtimeContextHandoff | null {
  const config = realtimeContextConfig(options.model);
  const tokenLimit = Math.max(1000, options.tokenLimit ?? config.postInstructionsTokenLimit - 1000);
  const rendered = entries
    .map(renderContextEntry)
    .filter((line): line is string => Boolean(line));
  if (rendered.length === 0) return null;

  const totalEntryCount = Math.max(options.totalEntryCount ?? rendered.length, rendered.length);
  const intro = [
    'Realtime voice context handoff.',
    'Treat this as passive current context, not as a user request to answer directly.',
    'Use get_context_briefing for a compact persisted briefing and search_context for exact prior-chat lookup when needed.',
  ].join('\n');
  const fullText = `${intro}\n\nRecent context:\n${rendered.join('\n')}`;
  const originalTokenEstimate = estimateRealtimeTokens(fullText);
  const hasUnloadedContext = totalEntryCount > rendered.length;

  if (originalTokenEstimate <= tokenLimit && !hasUnloadedContext) {
    return {
      text: fullText,
      warning: null,
      compacted: false,
      tokenEstimate: originalTokenEstimate,
      originalTokenEstimate,
      includedEntryCount: rendered.length,
      totalEntryCount,
    };
  }

  const compactIntro = [
    'Realtime voice compact context handoff.',
    'The full current context was larger than the Realtime handoff budget, so this includes the most recent useful entries only.',
    'Use get_context_briefing and search_context before answering questions that depend on earlier details.',
  ].join('\n');
  const selected = newestLinesWithinTokenLimit(rendered, tokenLimit, compactIntro);
  const text = `${compactIntro}\n\nRecent context:\n${selected.join('\n')}`;
  const tokenEstimate = estimateRealtimeTokens(text);
  return {
    text,
    warning: `Realtime voice received a compact context handoff (${selected.length}/${totalEntryCount} entries, ~${tokenEstimate}/${originalTokenEstimate} tokens). Use context search for older details.`,
    compacted: true,
    tokenEstimate,
    originalTokenEstimate,
    includedEntryCount: selected.length,
    totalEntryCount,
  };
}

export function createRealtimeContextItem(handoff: RealtimeContextHandoff): Record<string, unknown> {
  return {
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: handoff.text,
        },
      ],
    },
  };
}

export function parseRealtimeContextBacklog(lines: string[]): AwarenessEntry[] {
  return lines
    .map((line) => parseContextLine(line))
    .filter((entry): entry is AwarenessEntry => entry !== null);
}

export function mergeRealtimeContextEntries(...groups: AwarenessEntry[][]): AwarenessEntry[] {
  const seen = new Set<string>();
  const merged: AwarenessEntry[] = [];
  for (const entry of groups.flat()) {
    const key = entry.id || `${entry.timestamp}:${entry.role || ''}:${contextEntryText(entry).slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
}

export function estimateRealtimeTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function isBenignRealtimeCancellationError(event: Record<string, unknown>): boolean {
  const message = realtimeErrorMessage(event).toLowerCase();
  return message.includes('cancellation failed') && message.includes('no active response found');
}

function newestLinesWithinTokenLimit(lines: string[], tokenLimit: number, intro: string): string[] {
  const selected: string[] = [];
  for (let index = lines.length - 1; index >= 0; index--) {
    const candidate = [lines[index], ...selected];
    const text = `${intro}\n\nRecent context:\n${candidate.join('\n')}`;
    if (estimateRealtimeTokens(text) > tokenLimit && selected.length > 0) break;
    if (estimateRealtimeTokens(text) > tokenLimit) continue;
    selected.unshift(lines[index]);
  }
  return selected;
}

function renderContextEntry(entry: AwarenessEntry): string | null {
  if (entry.type !== 'message') return null;
  const text = truncateContextText(contextEntryText(entry), 1200);
  if (!text) return null;
  const role = entry.role || 'message';
  const channel = entry.channel ? ` ${entry.channel}` : '';
  const timestamp = entry.timestamp ? ` ${entry.timestamp}` : '';
  return `- ${role}${channel}${timestamp}: ${text}`;
}

function contextEntryText(entry: AwarenessEntry): string {
  if (entry.strippedText?.trim()) return compactWhitespace(entry.strippedText);
  return compactWhitespace((entry.content || []).map(contentBlockText).filter(Boolean).join('\n'));
}

function contentBlockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'thinking':
      return '';
    case 'toolCall':
      return `Tool call ${block.name} ${JSON.stringify(block.arguments || {})}`;
    case 'toolOutput':
      return `Tool output ${block.stream}: ${block.text}`;
    case 'toolResult':
      return `Tool result: ${block.result}`;
    default:
      return '';
  }
}

function truncateContextText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 24).trimEnd()} [truncated]`;
}

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function realtimeErrorMessage(event: Record<string, unknown>): string {
  const error = event.error;
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string') return message;
  }
  return typeof event.message === 'string' ? event.message : '';
}
