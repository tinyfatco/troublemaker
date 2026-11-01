// Images in the chat stream. The UI CSP only allows same-origin or data: images, so the agent
// shows a picture by saving it in its workspace and writing ![caption](relative/path.png);
// the chat swaps that for an image fetched as a data: URL through the console API.

export type ChatImageSegment =
  | { type: 'markdown'; text: string }
  | { type: 'image'; path: string; alt: string };

const IMAGE_RE = /!\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"\n]*")?\s*\)/g;
const FENCE_RE = /^(```|~~~)/;

/** Same rule Hostd enforces: workspace-relative, no parent or hidden segments, image extension. */
export function normalizeChatImagePath(raw: string): string | null {
  let value = raw.trim();
  try {
    value = decodeURI(value);
  } catch {
    return null;
  }
  value = value.replace(/^(\.\/)+/, '');
  if (value.length < 1 || value.length > 512) return null;
  if (!/^[A-Za-z0-9._ ()/-]+$/.test(value)) return null;
  if (!/\.(png|jpe?g|webp|gif)$/i.test(value)) return null;
  return value.split('/').every((segment) => segment.length > 0 && !segment.startsWith('.')) ? value : null;
}

function pushMarkdown(segments: ChatImageSegment[], text: string) {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last?.type === 'markdown') last.text += text;
  else segments.push({ type: 'markdown', text });
}

function splitProse(segments: ChatImageSegment[], text: string) {
  let cursor = 0;
  for (const match of text.matchAll(IMAGE_RE)) {
    const index = match.index ?? 0;
    const path = normalizeChatImagePath(match[2]);
    if (!path) {
      // Not a workspace image (remote URL, data:, absolute path): keep it readable as a link.
      pushMarkdown(segments, text.slice(cursor, index) + `[${match[1] || 'image'}](${match[2]})`);
    } else {
      pushMarkdown(segments, text.slice(cursor, index));
      segments.push({ type: 'image', path, alt: match[1].trim() });
    }
    cursor = index + match[0].length;
  }
  pushMarkdown(segments, text.slice(cursor));
}

/** Split assistant markdown into prose and workspace images, leaving fenced code untouched. */
export function splitChatImages(content: string): ChatImageSegment[] {
  const segments: ChatImageSegment[] = [];
  if (!content.includes('![')) return [{ type: 'markdown', text: content }];
  const lines = content.split(/(?<=\n)/);
  let prose = '';
  let fence: string | null = null;
  for (const line of lines) {
    const marker = line.trimStart().match(FENCE_RE)?.[1] ?? null;
    if (fence) {
      pushMarkdown(segments, line);
      if (marker === fence) fence = null;
      continue;
    }
    if (marker) {
      splitProse(segments, prose);
      prose = '';
      fence = marker;
      pushMarkdown(segments, line);
      continue;
    }
    prose += line;
  }
  splitProse(segments, prose);
  return segments;
}
