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

export function getWebChatStreamEffect(parsed: any): WebChatStreamEffect {
  if (parsed.type === 'text_delta' || parsed.type === 'thinking_delta' || parsed.type === 'text' || parsed.type === 'thinking') {
    return { status: 'streaming' };
  }
  if (parsed.type === 'toolCall' || parsed.type === 'toolcall_delta' || parsed.type === 'toolcall_end') {
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

  if (parsed.type === 'text_delta' && parsed.delta) {
    return appendTextDelta(prev, parsed.delta);
  }
  if (parsed.type === 'thinking_delta' && parsed.delta) {
    return appendThinkingDelta(prev, parsed.delta);
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
  if (parsed.type === 'toolcall_delta' || parsed.type === 'toolcall_end') {
    const toolCall = normalizeToolCallPatch(parsed);
    if (!toolCall) return prev;
    return upsertToolCall(prev, {
      ...toolCall,
      isPartial: parsed.type === 'toolcall_delta',
    });
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

function appendTextDelta(entry: AwarenessEntry, delta: string): AwarenessEntry {
  const content = [...(entry.content || [])];
  const last = content[content.length - 1];
  if (last && last.type === 'text') {
    content[content.length - 1] = { ...last, text: last.text + delta };
  } else {
    content.push({ type: 'text', text: delta });
  }
  return { ...entry, content };
}

function appendThinkingDelta(entry: AwarenessEntry, delta: string): AwarenessEntry {
  const content = [...(entry.content || [])];
  const last = content[content.length - 1];
  if (last && last.type === 'thinking') {
    content[content.length - 1] = { ...last, thinking: last.thinking + delta };
  } else {
    content.push({ type: 'thinking', thinking: delta });
  }
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

function normalizeToolCallPatch(parsed: any): ToolCallPatch | null {
  const raw = parsed.toolCall || parsed.partial?.content?.[parsed.contentIndex];
  if (!raw || raw.type !== 'toolCall') return null;
  return {
    type: 'toolCall',
    id: String(raw.id ?? parsed.id ?? ''),
    name: String(raw.name ?? parsed.name ?? 'tool'),
    arguments: isRecord(raw.arguments) ? raw.arguments : {},
    contentIndex: typeof parsed.contentIndex === 'number' ? parsed.contentIndex : undefined,
  };
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
