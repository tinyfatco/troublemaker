import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { fetchWebsitePaintImage, fetchWorkspaceImage } from '../console-api';

export type ChatImageSource =
  | { kind: 'paint'; id: string }
  | { kind: 'workspace'; path: string; version?: string };

interface ChatImageProps {
  source: ChatImageSource;
  alt: string;
  /** Shown under the image; the alt text is used when omitted. */
  caption?: string;
  className?: string;
  /** Called when the image cannot be loaded, so a card can drop its image area. */
  onMissing?: () => void;
  /** Called when the image's layout settles (decoded or dropped), so a live chat can re-follow the bottom. */
  onSettled?: () => void;
  /** Image fetcher; defaults to the console API. Overridable for tests. */
  loader?: (source: ChatImageSource) => Promise<string | null>;
}

function load(source: ChatImageSource): Promise<string | null> {
  return source.kind === 'paint'
    ? fetchWebsitePaintImage(source.id)
    : fetchWorkspaceImage(source.path, source.version);
}

/** An image in the chat stream, fetched as a data: URL. Click to view full size. */
export function ChatImage({ source, alt, caption, className, onMissing, onSettled, loader = load }: ChatImageProps) {
  const [image, setImage] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [expanded, setExpanded] = useState(false);
  const key = source.kind === 'paint' ? `paint:${source.id}` : `workspace:${source.version ?? ''}:${source.path}`;
  // Layout settles exactly once per image source, whether it decodes or is dropped.
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  const settledKeyRef = useRef<string | null>(null);
  const settle = () => {
    if (settledKeyRef.current === key) return;
    settledKeyRef.current = key;
    onSettledRef.current?.();
  };

  useEffect(() => {
    let alive = true;
    setState('loading');
    void loader(source).then((url) => {
      if (!alive) return;
      setImage(url);
      setState(url ? 'ready' : 'missing');
      if (!url) {
        onMissing?.();
        settle();
      }
    });
    return () => { alive = false; };
    // The key fully identifies the source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const label = caption ?? alt;
  if (state === 'missing') {
    if (onMissing) return null;
    return (
      <figure className={['chat-image', 'is-missing', className].filter(Boolean).join(' ')}>
        <div className="chat-image-missing">Image unavailable{source.kind === 'workspace' ? `: ${source.path}` : ''}</div>
      </figure>
    );
  }

  const toggle = () => setExpanded((value) => !value);
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggle();
    } else if (event.key === 'Escape') {
      setExpanded(false);
    }
  };

  return (
    <>
      <figure className={['chat-image', className].filter(Boolean).join(' ')}>
        {state === 'ready' && image
          ? (
            <img
              className="chat-image-img"
              src={image}
              alt={alt}
              role="button"
              tabIndex={0}
              onClick={toggle}
              onKeyDown={onKey}
              onLoad={settle}
              onError={settle}
            />
          )
          : <div className="chat-image-loading" aria-label="Loading image" />}
        {label && <figcaption className="chat-image-caption">{label}</figcaption>}
      </figure>
      {expanded && image && (
        <div className="chat-image-lightbox" role="dialog" aria-label={alt || 'Image'} onClick={toggle} onKeyDown={onKey} tabIndex={-1}>
          <img src={image} alt={alt} />
        </div>
      )}
    </>
  );
}
