// WebsitePaint requests reach the agent as a long model-facing prompt. The chat shows them
// as a card instead: the painted image, the painter's note and the marked elements.

export interface WebsitePaintElement {
  tag: string;
  text: string;
  rect?: { x: number; y: number; width: number; height: number };
}

export interface WebsitePaintRequest {
  kind: 'markup' | 'canvas';
  site: string;
  imageId?: string;
  note?: string;
  pagePath?: string;
  origin?: { x: number; y: number };
  elements: WebsitePaintElement[];
}

const HEADER_RE = /^\[WebsitePaint\](?: \(image ([a-f0-9]{16})\))? (?:(The painter drew marks directly on top of the live review preview)|The canvas settled) for site ([a-z0-9][a-z0-9-]*)/;
const NOTES_RE = /\n\nNotes from the painter: ([\s\S]*)$/;
const DETAILS_RE = /```json\n([\s\S]+?)\n```/;

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function point(value: unknown): { x: number; y: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { x, y } = value as Record<string, unknown>;
  return finiteNumber(x) && finiteNumber(y) ? { x, y } : undefined;
}

export function parseWebsitePaintMessage(raw: string): WebsitePaintRequest | null {
  const text = raw.trimStart();
  const header = text.match(HEADER_RE);
  if (!header) return null;
  const request: WebsitePaintRequest = {
    kind: header[2] ? 'markup' : 'canvas',
    site: header[3],
    elements: [],
  };
  if (header[1]) request.imageId = header[1];

  const notes = text.match(NOTES_RE);
  const note = notes?.[1].trim();
  if (note) request.note = note;
  const body = notes ? text.slice(0, notes.index) : text;

  const fenced = body.match(DETAILS_RE);
  if (fenced) {
    try {
      const details = JSON.parse(fenced[1]) as Record<string, unknown>;
      if (typeof details.page_url === 'string') {
        try {
          const url = new URL(details.page_url);
          request.pagePath = `${url.pathname}${url.search}`;
        } catch { /* keep the card without a path */ }
      }
      request.origin = point(details.marks_origin_in_page);
      if (Array.isArray(details.marked_elements)) {
        for (const item of details.marked_elements.slice(0, 24)) {
          if (!item || typeof item !== 'object') continue;
          const { tag, text: elementText, rect } = item as Record<string, unknown>;
          if (typeof tag !== 'string' || typeof elementText !== 'string') continue;
          const element: WebsitePaintElement = { tag, text: elementText.trim() };
          if (rect && typeof rect === 'object') {
            const r = rect as Record<string, unknown>;
            if (finiteNumber(r.x) && finiteNumber(r.y) && finiteNumber(r.width) && finiteNumber(r.height)) {
              element.rect = { x: r.x, y: r.y, width: r.width, height: r.height };
            }
          }
          request.elements.push(element);
        }
      }
    } catch { /* malformed details: show the card without element chips */ }
  }
  return request;
}

const TAG_NAMES: Record<string, string> = {
  a: 'link',
  button: 'button',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  img: 'image',
  p: 'text',
  nav: 'nav',
  header: 'header',
  footer: 'footer',
  section: 'section',
  form: 'form',
  input: 'field',
  li: 'list item',
};

export function websitePaintElementLabel(element: WebsitePaintElement, maxText = 36): string {
  const kind = TAG_NAMES[element.tag] ?? element.tag;
  const text = element.text.replace(/\s+/g, ' ').trim();
  if (!text) return kind;
  const short = text.length > maxText ? `${text.slice(0, maxText - 1).trimEnd()}…` : text;
  return `${kind} “${short}”`;
}
