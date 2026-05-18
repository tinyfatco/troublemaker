import { useState, useRef, useEffect, useCallback, type KeyboardEvent, type ReactNode } from 'react';

interface InputBarProps {
  onSend: (text: string) => void;
  onStop?: () => void;
  disabled?: boolean;
  isStreaming?: boolean;
  onHeightChange?: (height: number) => void;
  /** Optional extra button(s) rendered after the send button */
  extraButtons?: ReactNode;
}

export function InputBar({ onSend, onStop, disabled, isStreaming, onHeightChange, extraButtons }: InputBarProps) {
  const [value, setValue] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const reportHeight = useCallback(() => {
    const height = containerRef.current?.getBoundingClientRect().height;
    if (height) onHeightChange?.(Math.ceil(height));
  }, [onHeightChange]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }

    const frame = requestAnimationFrame(reportHeight);
    return () => cancelAnimationFrame(frame);
  }, [value, reportHeight]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') {
      reportHeight();
      return;
    }

    const observer = new ResizeObserver(reportHeight);
    observer.observe(container);
    reportHeight();
    return () => observer.disconnect();
  }, [reportHeight, isStreaming, disabled, extraButtons]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleSubmit = () => {
    if (value.trim() && !disabled) {
      onSend(value);
      setValue('');
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="input-bar">
      <div className="input-container" ref={containerRef}>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isStreaming ? 'Type to steer...' : 'Type a message...'}
          disabled={disabled}
          rows={1}
        />

        <button
          className="send-button"
          onClick={handleSubmit}
          disabled={disabled || !value.trim()}
          aria-label={isStreaming ? 'Send steering message' : 'Send'}
        >
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {isStreaming && (
          <button className="control-button stop" onClick={onStop} aria-label="Stop" title="Stop">
            <svg viewBox="0 0 24 24" fill="none">
              <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" />
            </svg>
          </button>
        )}
        {extraButtons}
      </div>
    </div>
  );
}
