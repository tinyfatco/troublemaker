import type { RealtimeOutputPhase } from './types';

export interface RealtimeOutputItemSnapshot {
  key: string;
  phase?: RealtimeOutputPhase;
  text: string;
  outputIndex?: number;
}

export function normalizeRealtimeOutputPhase(value: unknown): RealtimeOutputPhase | undefined {
  return value === 'commentary' || value === 'final_answer' ? value : undefined;
}

export function realtimeOutputKeyFromEvent(event: Record<string, unknown>, fallback: string): string {
  const item = isRecord(event.item) ? event.item : undefined;
  const itemId = stringValue(event.item_id) || stringValue(item?.id);
  if (itemId) return itemId;

  const outputIndex = realtimeOutputIndexFromEvent(event);
  if (outputIndex !== undefined) return `output-${outputIndex}`;

  return fallback;
}

export function realtimeOutputIndexFromEvent(event: Record<string, unknown>): number | undefined {
  return numberValue(event.output_index);
}

export function realtimeOutputPhaseFromEvent(event: Record<string, unknown>): RealtimeOutputPhase | undefined {
  const item = isRecord(event.item) ? event.item : undefined;
  return normalizeRealtimeOutputPhase(event.phase) || normalizeRealtimeOutputPhase(item?.phase);
}

export function realtimeOutputTextFromEvent(event: Record<string, unknown>): string {
  return stringValue(event.transcript) || stringValue(event.text);
}

export function isRealtimeTextOutputItemEvent(event: Record<string, unknown>): boolean {
  const item = isRecord(event.item) ? event.item : undefined;
  const type = stringValue(item?.type);
  return type !== 'function_call' && type !== 'mcp_call';
}

export function extractRealtimeResponseOutputItems(event: Record<string, unknown>): RealtimeOutputItemSnapshot[] {
  const response = isRecord(event.response) ? event.response : undefined;
  const output = Array.isArray(response?.output) ? response.output : [];

  return output.flatMap((item, index): RealtimeOutputItemSnapshot[] => {
    if (!isRecord(item) || item.type === 'function_call' || item.type === 'mcp_call') return [];

    const text = realtimeOutputTextFromItem(item);
    if (!text) return [];

    return [{
      key: stringValue(item.id) || `output-${index}`,
      phase: normalizeRealtimeOutputPhase(item.phase),
      text,
      outputIndex: index,
    }];
  });
}

export function realtimeOutputTextFromItem(item: Record<string, unknown>): string {
  const direct = stringValue(item.transcript) || stringValue(item.text);
  if (direct) return direct;

  const content = Array.isArray(item.content) ? item.content : [];
  return content
    .map((part) => {
      if (!isRecord(part)) return '';
      return stringValue(part.transcript) || stringValue(part.text) || stringValue(part.output_text);
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
