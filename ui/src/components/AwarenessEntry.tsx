import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { debugStream, summarizeToolCall } from '../streamDebug';
import { getToolDetail, getToolStatus, getToolStatusText, getToolTitle } from '../toolDisplay';
import {
  isToolDetailsExpanded,
  shouldAutoCollapseToolDetails,
  shouldAutoOpenToolDetails,
  TOOL_AUTO_COLLAPSE_DELAY_MS,
} from '../toolExpansion';
import { getThinkingPreview } from '../thinkingDisplay';
import { shouldRenderContinuationPlaceholder, shouldRenderStreamingPlaceholder, stripSessionContext } from '../streamingCursor';
import type { AwarenessEntry as AwarenessEntryType, ContentBlock, ToolCallContent, ToolResultContent } from '../types';
import { ChannelBadge } from './ChannelBadge';
import { Markdown } from './Markdown';

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch { return ''; }
}

interface AwarenessEntryProps {
  entry: AwarenessEntryType;
  onExpandingContent?: () => void;
}

function EventEntry({ channel, label, description, fullDescription }: {
  channel?: string;
  label: string;
  description: string;
  fullDescription?: string;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="awareness-entry event-entry">
      <div className="event-header">
        {channel && <ChannelBadge channel={channel} />}
        <span className="event-icon">{'\u25C6'}</span>
        <span className="event-name">{label}</span>
      </div>
      {description && (
        <div
          className={`event-desc ${fullDescription ? 'expandable' : ''}`}
          onClick={fullDescription ? () => setExpanded(!expanded) : undefined}
        >
          {expanded ? fullDescription : description}
        </div>
      )}
    </div>
  );
}

function ToolCallGroup({ children }: { children: ReactNode }) {
  return (
    <div className="awareness-entry tool-call-group">
      {children}
    </div>
  );
}

function ToolCallBlock({ block, isRunning, result, onExpandingContent }: {
  block: ToolCallContent;
  isRunning?: boolean;
  result?: ToolResultContent;
  onExpandingContent?: () => void;
}) {
  const args = block.arguments || {};
  const hasArgs = Object.keys(args).length > 0;
  const resultText = result?.result ? String(result.result) : '';
  const hasDetails = hasArgs || !!resultText;
  const [manualDetailsOpen, setManualDetailsOpen] = useState(false);
  const [autoDetailsOpen, setAutoDetailsOpen] = useState(() => shouldAutoOpenToolDetails(hasDetails, isRunning));
  const autoExpandedRef = useRef(autoDetailsOpen);
  const autoCollapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const status = getToolStatus(!!isRunning, result);
  const statusText = getToolStatusText(status, result);
  const title = getToolTitle(block);
  const detail = getToolDetail(block);
  const detailsOpen = isToolDetailsExpanded(hasDetails, manualDetailsOpen, autoDetailsOpen);
  const debugSignature = useMemo(() => JSON.stringify({
    id: block.id,
    name: block.name,
    status,
    argKeys: Object.keys(args),
    title,
    detail,
    resultLen: resultText.length,
    isRunning: !!isRunning,
  }), [args, block.id, block.name, detail, isRunning, resultText.length, status, title]);

  useEffect(() => {
    return () => {
      if (autoCollapseTimerRef.current) clearTimeout(autoCollapseTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (autoCollapseTimerRef.current) {
      clearTimeout(autoCollapseTimerRef.current);
      autoCollapseTimerRef.current = null;
    }

    if (!hasDetails) {
      autoExpandedRef.current = false;
      setAutoDetailsOpen(false);
      setManualDetailsOpen(false);
      return;
    }

    if (shouldAutoOpenToolDetails(hasDetails, isRunning)) {
      if (!autoDetailsOpen) onExpandingContent?.();
      autoExpandedRef.current = true;
      setAutoDetailsOpen(true);
      return;
    }

    if (shouldAutoCollapseToolDetails(autoExpandedRef.current, isRunning)) {
      autoCollapseTimerRef.current = setTimeout(() => {
        autoExpandedRef.current = false;
        setAutoDetailsOpen(false);
        autoCollapseTimerRef.current = null;
      }, TOOL_AUTO_COLLAPSE_DELAY_MS);
    }
  }, [autoDetailsOpen, hasDetails, isRunning, onExpandingContent]);

  useEffect(() => {
    debugStream('render:tool-call', {
      signature: debugSignature,
      toolCall: summarizeToolCall(block),
      title,
      detail,
      status,
      statusText,
      resultLen: resultText.length,
    });
  }, [block, debugSignature, detail, resultText.length, status, statusText, title]);

  const statusIcon = status === 'running'
    ? <span className="tool-spinner" />
    : status === 'error'
      ? <span className="tool-status-icon error">!</span>
      : <span className="tool-status-icon success">{'\u2713'}</span>;

  return (
    <div className={`tool-call-row ${status}`}>
      <button
        className="tool-call-main"
        onClick={() => {
          if (!hasDetails) return;
          if (!detailsOpen) onExpandingContent?.();
          setManualDetailsOpen(!detailsOpen);
        }}
        aria-expanded={detailsOpen}
        disabled={!hasDetails}
      >
        {statusIcon}
        <span className="tool-call-copy">
          <span className="tool-title">{title}</span>
          {detail && <span className="tool-subtitle">{detail}</span>}
        </span>
        <span className="tool-result-summary">{statusText}</span>
        {hasDetails && <span className={`tool-caret ${detailsOpen ? 'open' : ''}`} aria-hidden="true">&gt;</span>}
      </button>

      {hasDetails && (
        <div className={`tool-accordion ${detailsOpen ? 'open' : 'closed'}`} aria-hidden={!detailsOpen}>
          <div className="tool-accordion-inner">
            {hasArgs && (
              <div className="tool-detail-section">
                <span className="tool-detail-label">details</span>
                <StructuredValue value={args} />
              </div>
            )}
            {resultText && (
              <div className="tool-detail-section">
                <span className="tool-detail-label">{result?.isError ? 'error' : 'output'}</span>
                <pre className="tool-output-pre">{resultText}</pre>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StructuredValue({ value, name, depth = 0 }: { value: unknown; name?: string; depth?: number }) {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="structured-empty">[]</span>;
    return (
      <div className={`structured-value structured-array depth-${Math.min(depth, 3)}`}>
        {value.map((item, index) => (
          <div className="structured-row" key={index}>
            <span className="structured-key">{index}</span>
            <StructuredValue value={item} depth={depth + 1} />
          </div>
        ))}
      </div>
    );
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className="structured-empty">{'{}'}</span>;
    return (
      <div className={`structured-value structured-object depth-${Math.min(depth, 3)}`}>
        {entries.map(([key, item]) => (
          <div className="structured-row" key={key}>
            <span className="structured-key">{humanizeKey(key)}</span>
            <StructuredValue value={item} name={key} depth={depth + 1} />
          </div>
        ))}
      </div>
    );
  }

  if (typeof value === 'string') {
    if (value.includes('\n') || value.length > 120) {
      return <pre className="structured-string-block">{value}</pre>;
    }
    return <code className={isCodeLikeKey(name) ? 'structured-code' : 'structured-string'}>{value}</code>;
  }

  if (typeof value === 'number') return <span className="structured-number">{value}</span>;
  if (typeof value === 'boolean') return <span className="structured-boolean">{String(value)}</span>;
  if (value === null) return <span className="structured-null">null</span>;
  if (value === undefined) return <span className="structured-null">undefined</span>;
  return <span className="structured-string">{String(value)}</span>;
}

function humanizeKey(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
}

function isCodeLikeKey(key?: string): boolean {
  return !!key && ['path', 'file', 'filePath', 'targetPath', 'command', 'cmd', 'url'].includes(key);
}

function getToolResultId(result: ToolResultContent): string {
  const raw = result as ToolResultContent & {
    tool_call_id?: string;
    toolUseId?: string;
    tool_use_id?: string;
  };
  return String(raw.toolCallId || raw.tool_call_id || raw.toolUseId || raw.tool_use_id || '');
}

function ToolResultBlock({ content, isError, onExpandingContent }: {
  content: string;
  isError?: boolean;
  onExpandingContent?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const preview = content.length > 90 ? content.substring(0, 90) + '...' : content;

  return (
    <div className={`awareness-tool-result ${isError ? 'error' : ''}`}>
      <button
        className="tool-result-toggle"
        onClick={() => {
          if (!expanded) onExpandingContent?.();
          setExpanded(!expanded);
        }}
        aria-expanded={expanded}
      >
        <span className={`tool-caret ${expanded ? 'open' : ''}`} aria-hidden="true">&gt;</span>
        <span className="tool-result-preview">{preview || (isError ? 'error' : 'output')}</span>
      </button>
      {expanded && (
        <div className="tool-accordion">
          <pre className="tool-output-pre">{content}</pre>
        </div>
      )}
    </div>
  );
}

export const AwarenessEntryComponent = memo(function AwarenessEntryComponent({ entry, onExpandingContent }: AwarenessEntryProps) {
  if (entry.type === 'session') return null;
  if (!entry.content || !Array.isArray(entry.content)) return null;

  // Orphan tool results are rare after stream normalization, but keep a
  // fallback so unmatched output is never silently dropped.
  if (entry.role === 'toolResult') {
    const results = entry.content.filter((c) => c.type === 'toolResult');
    if (results.length === 0) return null;

    return (
      <div className="awareness-entry tool-result-entry">
        {results.map((r, i) => (
          <ToolResultBlock
            key={i}
            content={'result' in r ? String(r.result) : ''}
            isError={'isError' in r ? r.isError : false}
            onExpandingContent={onExpandingContent}
          />
        ))}
      </div>
    );
  }

  // User messages
  if (entry.role === 'user') {
    const text = entry.strippedText || extractText(entry.content);

    // Attention triggers (heartbeat, scheduled) — compact indicator
    // Formats: [ATTENTION:name:type:cron] [source] label OR legacy [EVENT:...]
    const eventMatch = text.match(/^\[(?:EVENT|ATTENTION):([^:\]]+)[^\]]*\]\s*(?:\[([^\]]+)\]\s*)?([\s\S]*)$/);
    if (eventMatch) {
      const eventFile = eventMatch[1].replace(/\.json$/, ''); // e.g. "daily-5am-checkin"
      const eventSource = eventMatch[2]; // e.g. "heartbeat" (optional)
      const eventDesc = (eventMatch[3] || '').trim();
      const label = eventSource || eventFile;
      // Heartbeat events always show as heartbeat channel, regardless of target channelId
      const displayChannel = (eventFile === 'heartbeat' || eventSource === 'heartbeat') ? 'heartbeat' : entry.channel;
      // Truncate long descriptions to first sentence
      const shortDesc = eventDesc.length > 60 ? eventDesc.substring(0, 60) + '...' : eventDesc;
      return (
        <EventEntry
          channel={displayChannel}
          label={label}
          description={shortDesc}
          fullDescription={eventDesc.length > 60 ? eventDesc : undefined}
        />
      );
    }

    // System actions (/model, /compact, etc.) — compact inline indicator
    if (entry.isSystemAction) {
      // e.g. "/model → fireworks/minimax-m2p5" or "/compact 437 → 12 messages"
      const actionText = text.startsWith('/') ? text : text;
      const cmdMatch = actionText.match(/^(\/\w+)\s*(.*)/);
      const cmd = cmdMatch ? cmdMatch[1] : '/action';
      const detail = cmdMatch ? cmdMatch[2] : actionText;

      return (
        <div className="awareness-entry system-action-entry">
          <div className="event-header">
            {entry.timestamp && <span className="entry-timestamp">{formatTime(entry.timestamp)}</span>}
            <span className="system-action-cmd">{cmd}</span>
            {detail && <span className="system-action-detail">{detail}</span>}
          </div>
        </div>
      );
    }

    // Ambient engagement — show as a compact trigger with conversation snippet
    if (entry.isAmbient) {
      const ambientText = text.replace(/^\[AMBIENT\]\s*/, '');
      // Extract just the conversation lines (between "Recent messages:" and "Channel pulse:")
      const convoMatch = ambientText.match(/Recent messages:\s*\n\n([\s\S]*?)\n\nChannel pulse:/);
      const convoLines = convoMatch ? convoMatch[1].trim() : '';
      const pulseMatch = ambientText.match(/Channel pulse:\s*(.*?)\.?\s*$/m);
      const pulseInfo = pulseMatch ? pulseMatch[1] : '';

      return (
        <div className="awareness-entry ambient-entry">
          <div className="event-header">
            {entry.channel && <ChannelBadge channel={entry.channel} />}
            <span className="event-icon">{'\u25C8'}</span>
            <span className="event-name">ambient</span>
            {pulseInfo && <span className="ambient-pulse">{pulseInfo}</span>}
          </div>
          {convoLines && (
            <div className="ambient-conversation">
              {convoLines.split('\n').map((line, i) => (
                <div key={i} className="ambient-line">{line}</div>
              ))}
            </div>
          )}
        </div>
      );
    }

    return (
      <div className={`awareness-entry user-entry ${entry.channel === 'web' ? 'web-user-entry' : ''}`}>
        <div className="awareness-meta">
          {entry.timestamp && <span className="entry-timestamp">{formatTime(entry.timestamp)}</span>}
          {entry.channel && <ChannelBadge channel={entry.channel} />}
          {entry.userName && <span className="awareness-username">{(entry.channel === 'web' && (entry.userName === 'user' || entry.userName === 'web-user')) ? 'you' : entry.userName}</span>}
        </div>
        <div className="awareness-user-text">{text}</div>
      </div>
    );
  }

  // Assistant messages
  if (entry.role === 'assistant') {
    const thinkingBlocks = entry.content.filter((c) => c.type === 'thinking');
    const textBlocks = entry.content.filter((c) => c.type === 'text');
    const toolCallBlocks = entry.content.filter((c) => c.type === 'toolCall') as ToolCallContent[];
    const toolResults = entry.content.filter((c) => c.type === 'toolResult') as ToolResultContent[];
    const rawText = textBlocks.map((c) => c.type === 'text' ? c.text : '').join('').trim();
    const hasText = textBlocks.some((c) => c.type === 'text' && stripSessionContext(c.text).trim());

    const getToolResult = (tc: ToolCallContent): ToolResultContent | undefined =>
      tc.id ? toolResults.find((r) => getToolResultId(r) === tc.id) : undefined;

    const isToolRunning = (tc: ToolCallContent): boolean =>
      !!entry.isStreaming && !getToolResult(tc);

    // [SILENT] responses — minimal indicator
    if (rawText === '[SILENT]') {
      return (
        <div className="awareness-entry silent-entry">
          <span className="silent-dot" />
          <span className="silent-label">silent</span>
        </div>
      );
    }

    // Skip entries that only have session_context and no other content
    if (!hasText && thinkingBlocks.length === 0 && toolCallBlocks.length === 0 && !entry.isStreaming) {
      return null;
    }

    const renderedBlocks: ReactNode[] = [];
    let pendingToolCalls: ToolCallContent[] = [];

    const flushToolCalls = (key: string) => {
      if (pendingToolCalls.length === 0) return;
      const calls = pendingToolCalls;
      pendingToolCalls = [];
      renderedBlocks.push(
        <ToolCallGroup key={key}>
          {calls.map((toolCall, index) => (
            <ToolCallBlock
              key={toolCall.id || `${toolCall.name}-${key}-${index}`}
              block={toolCall}
              isRunning={isToolRunning(toolCall)}
              result={getToolResult(toolCall)}
              onExpandingContent={onExpandingContent}
            />
          ))}
        </ToolCallGroup>,
      );
    };

    entry.content.forEach((block, i) => {
      if (block.type === 'toolCall') {
        pendingToolCalls.push(block as ToolCallContent);
        return;
      }
      if (block.type === 'toolResult') return;

      flushToolCalls(`tools-${i}`);

      if (block.type === 'thinking') {
        renderedBlocks.push(<ThinkingBlock key={i} text={block.thinking} />);
        return;
      }

      if (block.type === 'text') {
        const cleaned = stripSessionContext(block.text);
        if (!cleaned.trim()) return;
        renderedBlocks.push(
          <div key={i} className={`awareness-entry assistant-entry ${entry.isStreaming ? 'streaming' : ''}`}>
            {!entry.isStreaming && entry.timestamp && (
              <div className="awareness-meta">
                <span className="entry-timestamp">{formatTime(entry.timestamp)}</span>
              </div>
            )}
            <Markdown content={cleaned} />
          </div>,
        );
      }
    });
    flushToolCalls('tools-final');

    return (
      <>
        {renderedBlocks}
        {shouldRenderStreamingPlaceholder(entry) && (
          <div className="waiting-entry">
            <span className="waiting-spinner" role="status" aria-label="Waiting for agent response" />
          </div>
        )}
        {shouldRenderContinuationPlaceholder(entry) && (
          <div className="waiting-entry continuation">
            <span className="waiting-spinner" role="status" aria-label="Agent is writing" />
          </div>
        )}
      </>
    );
  }

  return null;
});

function ThinkingBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!text.trim()) return null;

  const preview = getThinkingPreview(text);
  const canExpand = preview.isTruncated;
  const displayText = expanded || !canExpand ? text.trimEnd() : preview.text;

  return (
    <button
      type="button"
      className={`awareness-entry awareness-thinking ${canExpand ? 'toggleable' : ''}`}
      onClick={() => canExpand && setExpanded(!expanded)}
      aria-expanded={canExpand ? expanded : undefined}
    >
      <span className="thinking-icon">{'\uD83D\uDCAD'}</span>
      <span className="thinking-text">{displayText}</span>
      {canExpand && <span className="thinking-toggle">{expanded ? 'less' : 'more'}</span>}
    </button>
  );
}

function extractText(content: ContentBlock[]): string {
  return content
    .filter((c) => c.type === 'text')
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('');
}
