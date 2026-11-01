import { useMemo } from 'react';
import type { WindowLike } from 'dompurify';
import { renderSafeMarkdown } from '../safeMarkdown';
import { splitChatImages } from '../chatImages';
import { ChatImage } from './ChatImage';

interface MarkdownProps {
  content: string;
  className?: string;
  /** Identifies the message, so a workspace image rewritten later is not shown on an older message. */
  imageVersion?: string;
}

function SafeHtml({ content, className }: { content: string; className: string }) {
  const html = useMemo(() => renderSafeMarkdown(content, window as unknown as WindowLike), [content]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Markdown({ content, className, imageVersion }: MarkdownProps) {
  const segments = useMemo(
    () => imageVersion ? splitChatImages(content) : [{ type: 'markdown' as const, text: content }],
    [content, imageVersion],
  );
  const classes = ['markdown-content', className].filter(Boolean).join(' ');

  if (segments.length === 1 && segments[0].type === 'markdown') {
    return <SafeHtml content={segments[0].text} className={classes} />;
  }

  return (
    <div className={`${classes} has-chat-images`}>
      {segments.map((segment, i) => segment.type === 'image'
        ? (
          <ChatImage
            key={`${i}:${segment.path}`}
            source={{ kind: 'workspace', path: segment.path, version: imageVersion }}
            alt={segment.alt}
          />
        )
        : segment.text.trim() && <SafeHtml key={i} content={segment.text} className="markdown-segment" />)}
    </div>
  );
}
