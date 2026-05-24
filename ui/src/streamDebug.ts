import type { AwarenessEntry, ContentBlock } from './types';

const PREFIX = '[tfat-stream]';
const MAX_PREVIEW = 160;
let sequence = 0;

export function debugStream(label: string, payload?: Record<string, unknown>): void {
  if (!isEnabled()) return;
  const nextSequence = ++sequence;
  try {
    console.debug(PREFIX, nextSequence, label, payload ?? {});
  } catch {
    console.debug(PREFIX, nextSequence, label);
  }
}

export function summarizeEvent(parsed: any): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    type: parsed?.type,
    status: parsed?.status,
    contentIndex: parsed?.contentIndex,
    deltaLen: stringLength(parsed?.delta),
    deltaPreview: preview(parsed?.delta),
    textLen: stringLength(parsed?.text),
    thinkingLen: stringLength(parsed?.thinking),
    message: preview(parsed?.message),
    resultLen: stringLength(parsed?.result),
  };

  if (parsed?.toolCall) summary.toolCall = summarizeToolCall(parsed.toolCall);
  if (Array.isArray(parsed?.toolCalls)) summary.toolCalls = parsed.toolCalls.map((toolCall: unknown) => summarizeToolCall(toolCall));
  if (Array.isArray(parsed?.partial?.content)) {
    summary.partialContent = parsed.partial.content.map((block: unknown) => summarizeContentBlock(block));
  }

  return compact(summary);
}

export function summarizeEntry(entry: AwarenessEntry | null): Record<string, unknown> | null {
  if (!entry) return null;
  return compact({
    id: entry.id,
    role: entry.role,
    isStreaming: entry.isStreaming,
    contentCount: entry.content?.length ?? 0,
    blocks: (entry.content || []).map((block, index) => summarizeContentBlock(block, index)),
  });
}

export function summarizeToolCall(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return { value: preview(raw) };
  const toolCall = raw as Record<string, unknown>;
  const args = isRecord(toolCall.arguments) ? toolCall.arguments : undefined;
  return compact({
    type: toolCall.type,
    id: preview(toolCall.id, 80),
    name: preview(toolCall.name, 80),
    contentIndex: toolCall.contentIndex,
    isPartial: toolCall.isPartial,
    argKeys: args ? Object.keys(args) : [],
    argSummary: args ? summarizeArgs(args) : undefined,
  });
}

export function preview(value: unknown, max = MAX_PREVIEW): string | undefined {
  if (typeof value !== 'string') return undefined;
  const singleLine = value.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= max) return singleLine;
  return `${singleLine.slice(0, max)}...`;
}

function summarizeContentBlock(block: unknown, index?: number): Record<string, unknown> {
  if (!block || typeof block !== 'object') return compact({ index, value: preview(block) });
  const rawRecord = block as Record<string, unknown>;
  const raw = rawRecord as ContentBlock & Record<string, unknown>;
  if (raw.type === 'text') {
    return compact({
      index,
      type: raw.type,
      contentIndex: raw.contentIndex,
      textLen: stringLength(raw.text),
      textPreview: preview(raw.text),
    });
  }
  if (raw.type === 'thinking') {
    return compact({
      index,
      type: raw.type,
      contentIndex: raw.contentIndex,
      thinkingLen: stringLength(raw.thinking),
      thinkingPreview: preview(raw.thinking),
    });
  }
  if (raw.type === 'toolCall') {
    return compact({ index, ...summarizeToolCall(raw) });
  }
  if (raw.type === 'toolResult') {
    return compact({
      index,
      type: raw.type,
      toolCallId: preview(raw.toolCallId, 80),
      isError: raw.isError,
      resultLen: stringLength(raw.result),
      resultPreview: preview(raw.result),
    });
  }
  return compact({ index, type: rawRecord.type });
}

function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const interestingKeys = [
    'command',
    'cmd',
    'path',
    'file',
    'filePath',
    'targetPath',
    'query',
    'pattern',
    'url',
    'text',
    'input',
  ];
  const summary: Record<string, unknown> = {};
  for (const key of interestingKeys) {
    if (!(key in args)) continue;
    const value = args[key];
    summary[key] = typeof value === 'string'
      ? { len: value.length, preview: preview(value) }
      : { type: Array.isArray(value) ? 'array' : typeof value };
  }
  return summary;
}

function isEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem('tfatStreamDebug') !== 'off';
  } catch {
    return true;
  }
}

function stringLength(value: unknown): number | undefined {
  return typeof value === 'string' ? value.length : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}
