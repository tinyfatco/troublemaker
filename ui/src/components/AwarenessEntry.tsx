import { memo, useState } from 'react';
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

/** Strip <session_context>...</session_context> blocks from text */
function stripSessionContext(text: string): string {
  return text.replace(/\s*<session_context>[\s\S]*?<\/session_context>\s*/g, '');
}

function ToolCallBlock({ block, isRunning, result }: { block: ToolCallContent; isRunning?: boolean; result?: ToolResultContent }) {
  const [argsExpanded, setArgsExpanded] = useState(false);
  const [outputHidden, setOutputHidden] = useState(false);
  const args = block.arguments || {};
  const primaryArg = getPrimaryToolArg(args);
  const hasArgs = Object.keys(args).length > 0;
  const resultText = result?.result ? String(result.result) : '';
  const resultSummary = result
    ? result.isError
      ? 'error'
      : summarizeToolResult(resultText)
    : isRunning
      ? 'running'
      : 'pending';

  const statusIcon = isRunning
    ? <span className="tool-spinner" />
    : result?.isError
      ? <span className="tool-status-icon error">!</span>
      : <span className="tool-status-icon success">{'\u2713'}</span>;

  return (
    <div className={`awareness-entry tool-call ${isRunning ? 'running' : ''} ${result?.isError ? 'error' : ''}`}>
      <div className="tool-header">
        {statusIcon}
        <span className="tool-label">{block.name}</span>
        <span className="tool-result-summary">{resultSummary}</span>
      </div>

      <div className="tool-summary">
        {primaryArg && <span className="tool-primary-arg">{primaryArg}</span>}
        {result && (
          <button className="tool-inline-action" onClick={() => setOutputHidden(!outputHidden)}>
            {outputHidden ? 'show output' : 'hide output'}
          </button>
        )}
        {hasArgs && (
          <button className="tool-inline-action" onClick={() => setArgsExpanded(!argsExpanded)}>
            {argsExpanded ? 'hide args' : 'show args'}
          </button>
        )}
      </div>

      {result && !outputHidden && (
        <div className="tool-output">
          <span className="tool-detail-label">output</span>
          <pre className="tool-detail-pre">{resultText}</pre>
        </div>
      )}

      {argsExpanded && (
        <div className="tool-details">
          <div className="tool-detail">
            <span className="tool-detail-label">args</span>
            <pre className="tool-detail-pre">{JSON.stringify(args, null, 2)}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

function ToolResultBlock({ content }: { content: string; isError?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const preview = content.length > 80 ? content.substring(0, 80) + '...' : content;

  return (
    <div className="awareness-tool-result">
      <button className="tool-result-toggle" onClick={() => setExpanded(!expanded)}>
        <span className="tool-result-preview">{preview}</span>
        <span className="tool-expand">{expanded ? '\u2212' : '+'}</span>
      </button>
      {expanded && <pre className="tool-detail-pre">{content}</pre>}
    </div>
  );
}

export const AwarenessEntryComponent = memo(function AwarenessEntryComponent({ entry }: AwarenessEntryProps) {
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
          />
        ))}
      </div>
    );
  }

  // User messages
  if (entry.role === 'user') {
    const text = entry.strippedText || extractText(entry.content);

    // Event triggers (heartbeat, scheduled) — compact indicator
    // Formats: [EVENT:name:type:cron] [source] label  OR  [EVENT:name:type:cron] label
    const eventMatch = text.match(/^\[EVENT:([^:\]]+)[^\]]*\]\s*(?:\[([^\]]+)\]\s*)?([\s\S]*)$/);
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
      toolResults.find((r) => r.toolCallId === tc.id);

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

    return (
      <>
        {entry.content.map((block, i) => {
          if (block.type === 'thinking') {
            return <ThinkingBlock key={i} text={block.thinking} />;
          }

          if (block.type === 'text') {
            const cleaned = stripSessionContext(block.text);
            if (!cleaned.trim()) return null;
            return (
              <div key={i} className={`awareness-entry assistant-entry ${entry.isStreaming ? 'streaming' : ''}`}>
                {!entry.isStreaming && entry.timestamp && (
                  <div className="awareness-meta">
                    <span className="entry-timestamp">{formatTime(entry.timestamp)}</span>
                  </div>
                )}
                <Markdown content={cleaned} />
              </div>
            );
          }

          if (block.type === 'toolCall') {
            return (
              <ToolCallBlock
                key={i}
                block={block}
                isRunning={isToolRunning(block)}
                result={getToolResult(block)}
              />
            );
          }

          return null;
        })}
        {entry.isStreaming && (
          <div className="awareness-entry assistant-entry streaming cursor-entry">
            <span className="cursor" />
          </div>
        )}
      </>
    );
  }

  return null;
});

function getPrimaryToolArg(args: Record<string, unknown>): string | null {
  const keys = ['label', 'path', 'file', 'filePath', 'targetPath', 'command', 'cmd', 'query', 'pattern', 'url'];
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function summarizeToolResult(result: string): string {
  if (!result) return 'done';
  const lines = result.split('\n').length;
  if (lines > 1) return `${lines} lines`;
  return result.length > 64 ? `${result.length} chars` : 'done';
}

function ThinkingBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!text.trim()) return null;

  return (
    <div className="awareness-entry awareness-thinking" onClick={() => setExpanded(!expanded)}>
      <span className="thinking-icon">{'\uD83D\uDCAD'}</span>
      <span className="thinking-text">
        {expanded ? text : text.substring(0, 80) + (text.length > 80 ? '...' : '')}
      </span>
    </div>
  );
}

function extractText(content: ContentBlock[]): string {
  return content
    .filter((c) => c.type === 'text')
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('');
}
