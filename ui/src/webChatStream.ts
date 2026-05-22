import type { AwarenessEntry, ContentBlock, ToolCallContent, ToolResultContent } from './types';

export type WebChatStreamEffect = {
  status?: 'waking' | 'connecting' | 'steering' | 'streaming' | 'tool_running' | 'error';
  error?: string | null;
  endedWithError?: boolean;
};

type ToolCallPatch = ToolCallContent & {
  contentIndex?: number;
  isPartial?: boolean;
};

type TextPatch = {
  type: 'text';
  text: string;
  contentIndex?: number;
};

type ThinkingPatch = {
  type: 'thinking';
  thinking: string;
  contentIndex?: number;
};

export function getWebChatStreamEffect(parsed: any): WebChatStreamEffect {
  if (
    parsed.type === 'text_delta' ||
    parsed.type === 'text_patch' ||
    parsed.type === 'thinking_delta' ||
    parsed.type === 'thinking_patch' ||
    parsed.type === 'text' ||
    parsed.type === 'thinking'
  ) {
    return { status: 'streaming' };
  }
  if (parsed.type === 'toolCall' || parsed.type === 'toolcall_start' || parsed.type === 'toolcall_delta' || parsed.type === 'toolcall_end') {
    return { status: 'tool_running' };
  }
  if (parsed.type === 'toolResult') {
    return { status: 'streaming' };
  }
  if (parsed.type === 'status') {
    if (parsed.status === 'waking') return { status: 'waking' };
    if (parsed.status === 'connecting' || parsed.status === 'container') return { status: 'connecting' };
    if (parsed.status === 'steering') return { status: 'steering' };
  }
  if (parsed.type === 'error') {
    return { status: 'error', error: parsed.message || 'Stream error', endedWithError: true };
  }
  return {};
}

export function reduceWebChatStreamEntry(prev: AwarenessEntry | null, parsed: any): AwarenessEntry | null {
  if (!prev) return prev;

  if (parsed.type === 'text_delta' && (parsed.delta || parsed.text)) {
    return appendTextDelta(prev, String(parsed.delta || ''), numberOrUndefined(parsed.contentIndex), stringOrUndefined(parsed.text));
  }
  if (parsed.type === 'text_patch' && typeof parsed.text === 'string') {
    return upsertTextBlock(prev, {
      type: 'text',
      text: parsed.text,
      contentIndex: numberOrUndefined(parsed.contentIndex),
    });
  }
  if (parsed.type === 'thinking_delta' && (parsed.delta || parsed.thinking)) {
    return appendThinkingDelta(prev, String(parsed.delta || ''), numberOrUndefined(parsed.contentIndex), stringOrUndefined(parsed.thinking));
  }
  if (parsed.type === 'thinking_patch' && typeof parsed.thinking === 'string') {
    return upsertThinkingBlock(prev, {
      type: 'thinking',
      thinking: parsed.thinking,
      contentIndex: numberOrUndefined(parsed.contentIndex),
    });
  }
  if (parsed.type === 'text' && parsed.text) {
    const nonText = (prev.content || []).filter((c) => c.type !== 'text');
    return { ...prev, content: [...nonText, { type: 'text', text: parsed.text }] };
  }
  if (parsed.type === 'thinking' && parsed.thinking) {
    const nonThinking = (prev.content || []).filter((c) => c.type !== 'thinking');
    return { ...prev, content: [{ type: 'thinking', thinking: parsed.thinking }, ...nonThinking] };
  }
  if (parsed.type === 'toolCall') {
    return upsertToolCall(prev, {
      type: 'toolCall',
      id: parsed.id || `tool-${Date.now()}`,
      name: parsed.name,
      arguments: parsed.arguments || {},
    });
  }
  if (parsed.type === 'toolcall_start' || parsed.type === 'toolcall_delta' || parsed.type === 'toolcall_end') {
    const toolCalls = normalizeToolCallPatches(parsed);
    if (toolCalls.length === 0) return prev;
    return toolCalls.reduce(
      (entry, toolCall) => upsertToolCall(entry, {
        ...toolCall,
        isPartial: parsed.type !== 'toolcall_end',
      }),
      prev,
    );
  }
  if (parsed.type === 'toolResult') {
    return upsertToolResult(prev, {
      type: 'toolResult',
      toolCallId: parsed.toolCallId || '',
      result: parsed.result || '',
      isError: parsed.isError,
    });
  }
  if (parsed.type === 'error') {
    const message = parsed.message || 'Stream error';
    const hasContent = prev.content?.some((c) => c.type === 'text' && c.text.trim());
    if (hasContent) return { ...prev, isStreaming: false };
    return { ...prev, content: [{ type: 'text', text: message }], isStreaming: false };
  }

  return prev;
}

function appendTextDelta(entry: AwarenessEntry, delta: string, contentIndex?: number, text?: string): AwarenessEntry {
  const content = [...(entry.content || [])];
  const existingIndex = findTextIndex(content, contentIndex);
  if (existingIndex !== -1) {
    const existing = content[existingIndex] as TextPatch;
    content[existingIndex] = {
      ...existing,
      text: delta ? existing.text + delta : text ?? existing.text,
      contentIndex: contentIndex ?? existing.contentIndex,
    };
  } else {
    content.push({ type: 'text', text: text ?? delta, contentIndex });
  }
  return { ...entry, content };
}

function appendThinkingDelta(entry: AwarenessEntry, delta: string, contentIndex?: number, thinking?: string): AwarenessEntry {
  const content = [...(entry.content || [])];
  const existingIndex = findThinkingIndex(content, contentIndex);
  if (existingIndex !== -1) {
    const existing = content[existingIndex] as ThinkingPatch;
    content[existingIndex] = {
      ...existing,
      thinking: delta ? existing.thinking + delta : thinking ?? existing.thinking,
      contentIndex: contentIndex ?? existing.contentIndex,
    };
  } else {
    content.push({ type: 'thinking', thinking: thinking ?? delta, contentIndex });
  }
  return { ...entry, content };
}

function upsertTextBlock(entry: AwarenessEntry, patch: TextPatch): AwarenessEntry {
  const content = [...(entry.content || [])];
  const existingIndex = findTextIndex(content, patch.contentIndex);
  if (existingIndex === -1) return { ...entry, content: [...content, patch] };
  content[existingIndex] = {
    ...(content[existingIndex] as TextPatch),
    ...patch,
  };
  return { ...entry, content };
}

function upsertThinkingBlock(entry: AwarenessEntry, patch: ThinkingPatch): AwarenessEntry {
  const content = [...(entry.content || [])];
  const existingIndex = findThinkingIndex(content, patch.contentIndex);
  if (existingIndex === -1) return { ...entry, content: [...content, patch] };
  content[existingIndex] = {
    ...(content[existingIndex] as ThinkingPatch),
    ...patch,
  };
  return { ...entry, content };
}

function upsertToolCall(entry: AwarenessEntry, toolCall: ToolCallPatch): AwarenessEntry {
  const content = [...(entry.content || [])];
  const existingIndex = content.findIndex((block) => isSameToolCall(block, toolCall));
  if (existingIndex === -1) {
    return { ...entry, content: [...content, toolCall] };
  }

  const existing = content[existingIndex] as ToolCallPatch;
  content[existingIndex] = {
    ...existing,
    ...toolCall,
    id: toolCall.id || existing.id,
    name: toolCall.name || existing.name,
    arguments: {
      ...(existing.arguments || {}),
      ...(toolCall.arguments || {}),
    },
  };
  return { ...entry, content };
}

function upsertToolResult(entry: AwarenessEntry, result: ToolResultContent): AwarenessEntry {
  const content = [...(entry.content || [])];
  const existingIndex = content.findIndex((block) =>
    block.type === 'toolResult' && getToolResultId(block) === getToolResultId(result)
  );
  if (existingIndex === -1) {
    return { ...entry, content: [...content, result] };
  }
  content[existingIndex] = result;
  return { ...entry, content };
}

function isSameToolCall(block: ContentBlock, toolCall: ToolCallPatch): boolean {
  if (block.type !== 'toolCall') return false;
  const existing = block as ToolCallPatch;
  if (toolCall.id && existing.id === toolCall.id) return true;
  return toolCall.contentIndex !== undefined && existing.contentIndex === toolCall.contentIndex;
}

function normalizeToolCallPatches(parsed: any): ToolCallPatch[] {
  const patches: ToolCallPatch[] = [];
  const seen = new Set<string>();
  const add = (raw: any, fallbackIndex?: number) => {
    if (!raw || raw.type !== 'toolCall') return;
    const contentIndex = numberOrUndefined(raw.contentIndex) ?? fallbackIndex;
    const patch: ToolCallPatch = {
      type: 'toolCall',
      id: String(raw.id ?? parsed.id ?? ''),
      name: String(raw.name ?? parsed.name ?? 'tool'),
      arguments: isRecord(raw.arguments) ? raw.arguments : {},
      contentIndex,
    };
    const key = patch.id ? `id:${patch.id}` : `index:${patch.contentIndex ?? patches.length}`;
    if (seen.has(key)) return;
    seen.add(key);
    patches.push(patch);
  };

  if (Array.isArray(parsed.toolCalls)) {
    parsed.toolCalls.forEach((raw: any, index: number) => add(raw, index));
  }
  add(parsed.toolCall, numberOrUndefined(parsed.contentIndex));

  if (Array.isArray(parsed.partial?.content)) {
    parsed.partial.content.forEach((raw: any, index: number) => add(raw, index));
  }

  return patches;
}

function findTextIndex(content: ContentBlock[], contentIndex?: number): number {
  if (contentIndex !== undefined) {
    const indexed = content.findIndex((block) =>
      block.type === 'text' && (block as TextPatch).contentIndex === contentIndex
    );
    if (indexed !== -1) return indexed;
  }
  return contentIndex === undefined ? findLastIndex(content, (block) => block.type === 'text') : -1;
}

function findThinkingIndex(content: ContentBlock[], contentIndex?: number): number {
  if (contentIndex !== undefined) {
    const indexed = content.findIndex((block) =>
      block.type === 'thinking' && (block as ThinkingPatch).contentIndex === contentIndex
    );
    if (indexed !== -1) return indexed;
  }
  return contentIndex === undefined ? findLastIndex(content, (block) => block.type === 'thinking') : -1;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i])) return i;
  }
  return -1;
}

function getToolResultId(result: ToolResultContent): string {
  return String((result as ToolResultContent & {
    tool_call_id?: string;
    toolUseId?: string;
    tool_use_id?: string;
  }).toolCallId || (result as any).tool_call_id || (result as any).toolUseId || (result as any).tool_use_id || '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
