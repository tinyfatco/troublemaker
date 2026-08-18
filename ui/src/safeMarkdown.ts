import createDOMPurify, { type Config, type WindowLike } from 'dompurify';
import { marked } from 'marked';

const SANITIZE_OPTIONS: Config = {
  USE_PROFILES: { html: true },
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  FORBID_ATTR: ['download', 'ping', 'srcset', 'style', 'target'],
  FORBID_TAGS: [
    'audio',
    'base',
    'button',
    'embed',
    'form',
    'iframe',
    'img',
    'input',
    'link',
    'meta',
    'object',
    'option',
    'select',
    'source',
    'style',
    'textarea',
    'track',
    'video',
  ],
};

export function renderSafeMarkdown(content: string, windowLike: WindowLike): string {
  const html = marked.parse(content, { breaks: true, async: false }) as string;
  return createDOMPurify(windowLike).sanitize(html, SANITIZE_OPTIONS) as string;
}
