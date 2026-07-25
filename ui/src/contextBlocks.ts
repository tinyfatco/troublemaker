const MODEL_CONTEXT_BLOCK_RE = /\s*<(session_context|delivery_context)>[\s\S]*?<\/\1>\s*/g;

export function stripModelContextBlocks(text: string): string {
  return text.replace(MODEL_CONTEXT_BLOCK_RE, '');
}
