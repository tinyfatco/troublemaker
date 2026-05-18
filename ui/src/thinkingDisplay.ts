export interface ThinkingPreview {
  text: string;
  isTruncated: boolean;
}

const DEFAULT_MAX_CHARS = 600;
const DEFAULT_MAX_LINES = 8;

export function getThinkingPreview(
  text: string,
  maxChars = DEFAULT_MAX_CHARS,
  maxLines = DEFAULT_MAX_LINES,
): ThinkingPreview {
  const normalized = text.trimEnd();
  const lines = normalized.split('\n');
  const lineLimited = lines.length > maxLines
    ? lines.slice(0, maxLines).join('\n')
    : normalized;
  const charLimited = lineLimited.length > maxChars
    ? lineLimited.slice(0, maxChars)
    : lineLimited;
  const isTruncated = lineLimited !== normalized || charLimited !== lineLimited;

  if (!isTruncated) {
    return { text: normalized, isTruncated: false };
  }

  return {
    text: trimAtWordBoundary(charLimited),
    isTruncated: true,
  };
}

function trimAtWordBoundary(text: string): string {
  const trimmed = text.trimEnd();
  if (trimmed.length < 120) return trimmed;

  const boundary = trimmed.lastIndexOf(' ');
  if (boundary < Math.floor(trimmed.length * 0.75)) return trimmed;
  return trimmed.slice(0, boundary).trimEnd();
}
