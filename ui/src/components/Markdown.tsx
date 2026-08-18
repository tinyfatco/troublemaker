import { useMemo } from 'react';
import type { WindowLike } from 'dompurify';
import { renderSafeMarkdown } from '../safeMarkdown';

interface MarkdownProps {
  content: string;
  className?: string;
}

export function Markdown({ content, className }: MarkdownProps) {
  const html = useMemo(() => {
    return renderSafeMarkdown(content, window as unknown as WindowLike);
  }, [content]);
  const classes = ['markdown-content', className].filter(Boolean).join(' ');

  return (
    <div
      className={classes}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
