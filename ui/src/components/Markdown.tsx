import { useMemo } from 'react';
import { marked } from 'marked';

interface MarkdownProps {
  content: string;
  className?: string;
}

export function Markdown({ content, className }: MarkdownProps) {
  const html = useMemo(() => {
    return marked.parse(content, { breaks: true, async: false }) as string;
  }, [content]);
  const classes = ['markdown-content', className].filter(Boolean).join(' ');

  return (
    <div
      className={classes}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
