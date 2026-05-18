import type { AwarenessEntry, ContentBlock } from './types';

export function stripSessionContext(text: string): string {
  return text.replace(/\s*<session_context>[\s\S]*?<\/session_context>\s*/g, '');
}

export function shouldRenderStreamingPlaceholder(entry: Pick<AwarenessEntry, 'content' | 'isStreaming'>): boolean {
  if (!entry.isStreaming) return false;
  return !(entry.content || []).some(isVisibleStreamingBlock);
}

function isVisibleStreamingBlock(block: ContentBlock): boolean {
  if (block.type === 'text') return stripSessionContext(block.text).trim().length > 0;
  if (block.type === 'thinking') return block.thinking.trim().length > 0;
  return block.type === 'toolCall' || block.type === 'toolResult';
}
