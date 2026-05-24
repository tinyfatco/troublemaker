import type { AwarenessEntry, ContentBlock } from './types';

export function stripSessionContext(text: string): string {
  return text.replace(/\s*<session_context>[\s\S]*?<\/session_context>\s*/g, '');
}

export function shouldRenderStreamingPlaceholder(entry: Pick<AwarenessEntry, 'content' | 'isStreaming'>): boolean {
  if (!entry.isStreaming) return false;
  return !(entry.content || []).some(isVisibleStreamingBlock);
}

export function shouldRenderContinuationPlaceholder(entry: Pick<AwarenessEntry, 'content' | 'isStreaming'>): boolean {
  if (!entry.isStreaming || shouldRenderStreamingPlaceholder(entry)) return false;
  const content = entry.content || [];
  const toolCallIds = content
    .filter((block) => block.type === 'toolCall' && block.id)
    .map((block) => block.type === 'toolCall' ? block.id : '');
  if (toolCallIds.length === 0) return false;

  const resultIds = new Set(
    content
      .filter((block) => block.type === 'toolResult' && block.toolCallId)
      .map((block) => block.type === 'toolResult' ? block.toolCallId : ''),
  );
  if (!toolCallIds.every((id) => resultIds.has(id))) return false;

  const lastVisible = [...content].reverse().find(isVisibleStreamingBlock);
  return lastVisible?.type === 'toolCall' || lastVisible?.type === 'toolOutput' || lastVisible?.type === 'toolResult';
}

function isVisibleStreamingBlock(block: ContentBlock): boolean {
  if (block.type === 'text') return stripSessionContext(block.text).trim().length > 0;
  if (block.type === 'thinking') return block.thinking.trim().length > 0;
  return block.type === 'toolCall' || block.type === 'toolOutput' || block.type === 'toolResult';
}
