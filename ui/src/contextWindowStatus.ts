import { stripModelContextBlocks } from './contextBlocks';
import { estimateRealtimeTokens, realtimeContextConfig } from './realtimeContext';
import type { AwarenessEntry, ContentBlock } from './types';

const REALTIME_STATUS_MODEL = 'gpt-realtime-2';
const REALTIME_HANDOFF_BUFFER_TOKENS = 1000;

export interface RealtimeContextWindowStatus {
  capTokens: number;
  handoffLimitTokens: number;
  percentOfCap: number;
  label: string;
  stateLabel: 'direct handoff' | 'compact handoff';
  tone: 'normal' | 'attention';
  title: string;
}

export interface ContextWindowStatus {
  tokenEstimate: number;
  messageCount: number;
  contextLabel: string;
  sourceLabel: string;
  title: string;
  realtime?: RealtimeContextWindowStatus;
}

interface ContextWindowStatusOptions {
  allLoaded?: boolean;
  realtimeVoice?: boolean;
}

export function buildContextWindowStatus(
  entries: AwarenessEntry[],
  options: ContextWindowStatusOptions = {},
): ContextWindowStatus {
  const messageCount = entries.filter((entry) => entry.type === 'message').length;
  const tokenEstimate = estimateAwarenessContextTokens(entries);
  const contextLabel = tokenEstimate > 0
    ? `~${formatContextTokens(tokenEstimate)} loaded`
    : 'no loaded tokens';
  const sourceLabel = options.allLoaded
    ? `${messageCount} loaded messages`
    : `${messageCount} recent messages`;

  return {
    tokenEstimate,
    messageCount,
    contextLabel,
    sourceLabel,
    title: options.allLoaded
      ? `${messageCount} loaded context messages, about ${formatContextTokens(tokenEstimate)} tokens.`
      : `${messageCount} recent loaded messages, about ${formatContextTokens(tokenEstimate)} tokens.`,
    realtime: options.realtimeVoice ? buildRealtimeContextWindowStatus(tokenEstimate) : undefined,
  };
}

export function estimateAwarenessContextTokens(entries: AwarenessEntry[]): number {
  const text = entries
    .map(renderContextEntry)
    .filter(Boolean)
    .join('\n');
  return text ? estimateRealtimeTokens(text) : 0;
}

export function formatContextTokens(tokens: number): string {
  const value = Math.max(0, Math.round(tokens));
  if (value >= 1_000_000) return `${trimFixed(value / 1_000_000, value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${trimFixed(value / 1_000, value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

function buildRealtimeContextWindowStatus(tokenEstimate: number): RealtimeContextWindowStatus {
  const config = realtimeContextConfig(REALTIME_STATUS_MODEL);
  const handoffLimitTokens = Math.max(1000, config.postInstructionsTokenLimit - REALTIME_HANDOFF_BUFFER_TOKENS);
  const willCompact = tokenEstimate > handoffLimitTokens;
  const percentOfCap = Math.max(0, Math.min(100, Math.round((tokenEstimate / config.contextWindowTokens) * 100)));

  return {
    capTokens: config.contextWindowTokens,
    handoffLimitTokens,
    percentOfCap,
    label: willCompact ? 'voice will compact' : 'voice handoff ready',
    stateLabel: willCompact ? 'compact handoff' : 'direct handoff',
    tone: willCompact ? 'attention' : 'normal',
    title: `Realtime voice uses ${formatContextTokens(config.contextWindowTokens)} session context with about ${formatContextTokens(handoffLimitTokens)} available for startup context after audio and response reserve. Larger text threads are handed off compactly.`,
  };
}

function renderContextEntry(entry: AwarenessEntry): string {
  if (entry.type !== 'message') return '';
  const text = entryText(entry);
  if (!text) return '';
  return `${entry.role || 'message'}: ${text}`;
}

function entryText(entry: AwarenessEntry): string {
  if (entry.strippedText?.trim()) return compactWhitespace(entry.strippedText);
  return compactWhitespace((entry.content || []).map(contentBlockText).filter(Boolean).join('\n'));
}

function contentBlockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return stripModelContextBlocks(block.text);
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

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function trimFixed(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.0$/, '');
}
