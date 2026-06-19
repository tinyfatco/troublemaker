import type { AwarenessEntry, ContentBlock, ToolCallContent, ToolOutputContent, ToolResultContent } from './types';
import { normalizeRealtimeOutputPhase } from './realtimePhases';
import { debugStream, summarizeEntry, summarizeEvent, summarizeToolCall } from './streamDebug';

export type WebChatStreamEffect = {
  status?: 'waking' | 'connecting' | 'steering' | 'streaming' | 'tool_running' | 'error';
  error?: string | null;
  endedWithError?: boolean;
  completed?: boolean;
};

type ToolCallPatch = ToolCallContent & {
  contentIndex?: number;
  isPartial?: boolean;
};

type TextPatch = {
  type: 'text';
  text: string;
  contentIndex?: number;
  phase?: 'commentary' | 'final_answer';
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
  if (
    parsed.type === 'toolCall' ||
    parsed.type === 'toolcall_start' ||
    parsed.type === 'toolcall_delta' ||
    parsed.type === 'toolcall_end' ||
    parsed.type === 'toolResultDelta'
  ) {
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
  if (parsed.type === 'run_complete') {
    return { completed: true };
  }
  return {};
}

export function reduceWebChatStreamEntry(prev: AwarenessEntry | null, parsed: any): AwarenessEntry | null {
  if (!prev) {
    debugStream('reducer:no-prev-entry', { event: summarizeEvent(parsed) });
    return prev;
  }

  if (parsed.type === 'assistant_snapshot' && isRecord(parsed.entry)) {
    return mergeAssistantSnapshot(prev, parsed.entry as AwarenessEntry);
  }

  if (prev.streamProtocol === 'snapshot' && isLegacyAssistantDelta(parsed)) {
    return prev;
  }

  if (parsed.type === 'text_delta' && (parsed.delta || parsed.text)) {
    return appendTextDelta(prev, String(parsed.delta || ''), numberOrUndefined(parsed.contentIndex), stringOrUndefined(parsed.text), normalizeRealtimeOutputPhase(parsed.phase));
  }
  if (parsed.type === 'text_patch' && typeof parsed.text === 'string') {
    return upsertTextBlock(prev, {
      type: 'text',
      text: parsed.text,
      contentIndex: numberOrUndefined(parsed.contentIndex),
      phase: normalizeRealtimeOutputPhase(parsed.phase),
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
    return { ...prev, content: [...nonText, { type: 'text', text: parsed.text, phase: normalizeRealtimeOutputPhase(parsed.phase) }] };
  }
  if (parsed.type === 'thinking' && parsed.thinking) {
    const nonThinking = (prev.content || []).filter((c) => c.type !== 'thinking');
    return { ...prev, content: [{ type: 'thinking', thinking: parsed.thinking }, ...nonThinking] };
  }
  if (parsed.type === 'toolCall') {
    const args = isRecord(parsed.arguments) ? parsed.arguments : {};
    const label = cleanToolCallLabel(parsed.label) || cleanToolCallLabel(args.label);
    return upsertToolCall(prev, {
      type: 'toolCall',
      id: parsed.id || `tool-${Date.now()}`,
      name: parsed.name,
      ...(label ? { label } : {}),
      arguments: args,
    });
  }
  if (parsed.type === 'toolcall_start' || parsed.type === 'toolcall_delta' || parsed.type === 'toolcall_end') {
    const toolCalls = normalizeToolCallPatches(parsed);
    debugStream('reducer:toolcall:normalized', {
      event: summarizeEvent(parsed),
      patchCount: toolCalls.length,
      patches: toolCalls.map((toolCall) => summarizeToolCall(toolCall)),
    });
    if (toolCalls.length === 0) {
      debugStream('reducer:toolcall:no-patches', { event: summarizeEvent(parsed) });
      return prev;
    }
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
  if (parsed.type === 'toolResultDelta') {
    return upsertToolOutput(prev, {
      type: 'toolOutput',
      toolCallId: parsed.toolCallId || '',
      stream: normalizeToolOutputStream(parsed.stream),
      text: typeof parsed.text === 'string' ? parsed.text : '',
      pid: typeof parsed.pid === 'number' ? parsed.pid : undefined,
      sequence: typeof parsed.sequence === 'number' ? parsed.sequence : undefined,
    });
  }
  if (parsed.type === 'error') {
    const message = parsed.message || 'Stream error';
    const hasContent = prev.content?.some((c) => c.type === 'text' && c.text.trim());
    if (hasContent) return { ...prev, isStreaming: false };
    return { ...prev, content: [{ type: 'text', text: message }], isStreaming: false };
  }
  if (parsed.type === 'run_complete') {
    return { ...prev, isStreaming: false };
  }

  return prev;
}

function mergeAssistantSnapshot(prev: AwarenessEntry, snapshot: AwarenessEntry): AwarenessEntry {
  const snapshotContent = Array.isArray(snapshot.content) ? [...snapshot.content] : [];
  const priorOutputs = (prev.content || []).filter((block): block is ToolOutputContent => block.type === 'toolOutput');
  const content = mergePriorToolOutputs(snapshotContent, priorOutputs);
  return {
    ...prev,
    ...snapshot,
    type: snapshot.type || 'message',
    role: snapshot.role || 'assistant',
    content,
    streamProtocol: 'snapshot',
  };
}

function mergePriorToolOutputs(content: ContentBlock[], outputs: ToolOutputContent[]): ContentBlock[] {
  const merged = [...content];
  for (const output of outputs) {
    const id = getToolOutputId(output);
    if (!id || merged.some((block) => block.type === 'toolOutput' && getToolOutputId(block) === id)) continue;
    const insertAt = findToolInsertIndex(merged, id);
    merged.splice(insertAt, 0, output);
  }
  return merged;
}

function findToolInsertIndex(content: ContentBlock[], toolCallId: string): number {
  for (let index = content.length - 1; index >= 0; index--) {
    const block = content[index];
    if (block.type === 'toolCall' && block.id === toolCallId) return index + 1;
    if (block.type === 'toolOutput' && getToolOutputId(block) === toolCallId) return index + 1;
    if (block.type === 'toolResult' && getToolResultId(block) === toolCallId) return index + 1;
  }
  return content.length;
}

function isLegacyAssistantDelta(parsed: any): boolean {
  return parsed?.type === 'text_delta' ||
    parsed?.type === 'text_patch' ||
    parsed?.type === 'thinking_delta' ||
    parsed?.type === 'thinking_patch' ||
    parsed?.type === 'text' ||
    parsed?.type === 'thinking';
}

function appendTextDelta(entry: AwarenessEntry, delta: string, contentIndex?: number, text?: string, phase?: TextPatch['phase']): AwarenessEntry {
  const content = [...(entry.content || [])];
  const existingIndex = findTextIndex(content, contentIndex);
  if (existingIndex !== -1) {
    const existing = content[existingIndex] as TextPatch;
    content[existingIndex] = {
      ...existing,
      text: delta ? existing.text + delta : text ?? existing.text,
      contentIndex: contentIndex ?? existing.contentIndex,
      phase: phase ?? existing.phase,
    };
  } else {
    content.push({ type: 'text', text: text ?? delta, contentIndex, phase });
  }
  debugStream('reducer:text-delta', {
    entryId: entry.id,
    contentIndex,
    deltaLen: delta.length,
    textLen: text?.length,
    existingIndex,
  });
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
  debugStream('reducer:thinking-delta', {
    entryId: entry.id,
    contentIndex,
    deltaLen: delta.length,
    thinkingLen: thinking?.length,
    existingIndex,
  });
  return { ...entry, content };
}

function upsertTextBlock(entry: AwarenessEntry, patch: TextPatch): AwarenessEntry {
  const content = [...(entry.content || [])];
  const existingIndex = findTextIndex(content, patch.contentIndex);
  debugStream('reducer:text-patch', {
    entryId: entry.id,
    contentIndex: patch.contentIndex,
    textLen: patch.text.length,
    existingIndex,
  });
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
  debugStream('reducer:thinking-patch', {
    entryId: entry.id,
    contentIndex: patch.contentIndex,
    thinkingLen: patch.thinking.length,
    existingIndex,
  });
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
    debugStream('reducer:toolcall:insert', {
      entry: summarizeEntry(entry),
      toolCall: summarizeToolCall(toolCall),
    });
    return { ...entry, content: [...content, toolCall] };
  }

  const existing = content[existingIndex] as ToolCallPatch;
  content[existingIndex] = {
    ...existing,
    ...toolCall,
    id: toolCall.id || existing.id,
    name: toolCall.name || existing.name,
    label: toolCall.label || existing.label,
    arguments: {
      ...(existing.arguments || {}),
      ...(toolCall.arguments || {}),
    },
  };
  debugStream('reducer:toolcall:update', {
    entryId: entry.id,
    existingIndex,
    existing: summarizeToolCall(existing),
    patch: summarizeToolCall(toolCall),
    merged: summarizeToolCall(content[existingIndex]),
  });
  return { ...entry, content };
}

function upsertToolResult(entry: AwarenessEntry, result: ToolResultContent): AwarenessEntry {
  const content = [...(entry.content || [])];
  const existingIndex = content.findIndex((block) =>
    block.type === 'toolResult' && getToolResultId(block) === getToolResultId(result)
  );
  if (existingIndex === -1) {
    debugStream('reducer:toolresult:insert', {
      entryId: entry.id,
      toolCallId: result.toolCallId,
      resultLen: result.result.length,
      isError: result.isError,
    });
    return { ...entry, content: [...content, result] };
  }
  content[existingIndex] = result;
  debugStream('reducer:toolresult:update', {
    entryId: entry.id,
    existingIndex,
    toolCallId: result.toolCallId,
    resultLen: result.result.length,
    isError: result.isError,
  });
  return { ...entry, content };
}

function upsertToolOutput(entry: AwarenessEntry, output: ToolOutputContent): AwarenessEntry {
  if (!output.toolCallId) return entry;

  const content = [...(entry.content || [])];
  const existingIndex = content.findIndex((block) =>
    block.type === 'toolOutput' && getToolOutputId(block) === getToolOutputId(output)
  );
  if (existingIndex === -1) {
    debugStream('reducer:tooloutput:insert', {
      entryId: entry.id,
      toolCallId: output.toolCallId,
      stream: output.stream,
      textLen: output.text.length,
      pid: output.pid,
      sequence: output.sequence,
    });
    return { ...entry, content: [...content, output] };
  }

  const existing = content[existingIndex] as ToolOutputContent;
  content[existingIndex] = {
    ...existing,
    stream: output.stream || existing.stream,
    text: existing.text + output.text,
    pid: output.pid ?? existing.pid,
    sequence: output.sequence ?? existing.sequence,
  };
  debugStream('reducer:tooloutput:update', {
    entryId: entry.id,
    existingIndex,
    toolCallId: output.toolCallId,
    stream: output.stream,
    textLen: output.text.length,
    totalLen: (content[existingIndex] as ToolOutputContent).text.length,
    pid: (content[existingIndex] as ToolOutputContent).pid,
    sequence: output.sequence,
  });
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
      ...(cleanToolCallLabel(raw.label) || cleanToolCallLabel(raw.arguments?.label)
        ? { label: cleanToolCallLabel(raw.label) || cleanToolCallLabel(raw.arguments?.label) }
        : {}),
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

function getToolOutputId(output: ToolOutputContent): string {
  return String((output as ToolOutputContent & {
    tool_call_id?: string;
    toolUseId?: string;
    tool_use_id?: string;
  }).toolCallId || (output as any).tool_call_id || (output as any).toolUseId || (output as any).tool_use_id || '');
}

function normalizeToolOutputStream(stream: unknown): ToolOutputContent['stream'] {
  return stream === 'stderr' || stream === 'system' ? stream : 'stdout';
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

function cleanToolCallLabel(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
