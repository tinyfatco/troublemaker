import { useState, useRef, useEffect, useCallback, type KeyboardEvent, type ReactNode } from 'react';
import { getSlashCommand, isKnownSlashCommand, matchSlashCommands, parseSlashCommand } from '../slashCommands';

interface InputBarProps {
  onSend: (text: string) => void;
  onStop?: () => void;
  disabled?: boolean;
  isStreaming?: boolean;
  onHeightChange?: (height: number) => void;
  /** Optional extra button(s) rendered after the send button */
  extraButtons?: ReactNode;
  /** Subtle composer metadata rendered below the prompt */
  status?: ReactNode;
  onSlashCommand?: (text: string) => boolean;
  onInvalidSlashCommand?: (command: string) => void;
  slashCommandsEnabled?: boolean;
  placeholder?: string;
  streamingPlaceholder?: string;
  sendLabel?: string;
  streamingSendLabel?: string;
  initialValue?: string;
}

export function InputBar({
  onSend,
  onStop,
  disabled,
  isStreaming,
  onHeightChange,
  extraButtons,
  status,
  onSlashCommand,
  onInvalidSlashCommand,
  slashCommandsEnabled = true,
  placeholder = 'Type a message...',
  streamingPlaceholder = 'Type to steer...',
  sendLabel = 'Send',
  streamingSendLabel = 'Send steering message',
  initialValue = '',
}: InputBarProps) {
  const [value, setValue] = useState(initialValue);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const slashMatches = slashCommandsEnabled && value.trimStart().startsWith('/') ? matchSlashCommands(value) : [];
  const showSlashMenu = slashCommandsEnabled && value.trimStart().startsWith('/') && slashMatches.length > 0;

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
  }, [reportHeight, isStreaming, disabled, extraButtons, status]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!initialValue.trim()) return;
    setValue((current) => current.trim() ? current : initialValue);
  }, [initialValue]);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (trimmed && !disabled) {
      const slashCommand = parseSlashCommand(trimmed);
      if (slashCommand && !slashCommandsEnabled) {
        onInvalidSlashCommand?.(slashCommand);
        return;
      }
      if (slashCommand) {
        if (!isKnownSlashCommand(trimmed)) {
          onInvalidSlashCommand?.(slashCommand);
          return;
        }
        if (onSlashCommand?.(trimmed)) {
          setValue('');
          if (textareaRef.current) textareaRef.current.style.height = 'auto';
          return;
        }
      }
      onSend(trimmed);
      setValue('');
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSlashMenu && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setSlashSelectedIndex((current) => {
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        return (current + delta + slashMatches.length) % slashMatches.length;
      });
      return;
    }
    if (showSlashMenu && e.key === 'Tab') {
      e.preventDefault();
      applySlashCommand(slashMatches[slashSelectedIndex]?.command);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const applySlashCommand = (command?: string) => {
    if (!command) return;
    const definition = getSlashCommand(command);
    if (command === '/settings' || command === '/voice') {
      if (onSlashCommand?.(command)) {
        setValue('');
        return;
      }
    }
    setValue(definition?.insertText ?? command);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  useEffect(() => {
    setSlashSelectedIndex(0);
  }, [value]);

  return (
    <div className="input-bar">
      {showSlashMenu && (
        <div className="slash-command-menu" role="listbox" aria-label="Slash commands">
          {slashMatches.map((item, index) => (
            <button
              key={item.command}
              type="button"
              className={index === slashSelectedIndex ? 'active' : ''}
              onMouseDown={(event) => {
                event.preventDefault();
                applySlashCommand(item.command);
              }}
            >
              <span className="slash-command-name">{item.command}</span>
              <span className="slash-command-detail">{item.description}</span>
            </button>
          ))}
        </div>
      )}
      <div className="input-container" ref={containerRef}>
        <div className="input-main">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isStreaming ? streamingPlaceholder : placeholder}
            disabled={disabled}
            rows={1}
          />
          {status && <div className="input-status-row">{status}</div>}
        </div>

        <button
          className="send-button"
          onClick={handleSubmit}
          disabled={disabled || !value.trim()}
          aria-label={isStreaming ? streamingSendLabel : sendLabel}
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
