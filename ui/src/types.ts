import { stripModelContextBlocks } from './contextBlocks';

/**
 * Shared types for the awareness stream UI.
 *
 * AwarenessEntry is the universal render type — everything in the chat pane
 * is one of these, whether it came from context.jsonl or live SSE streaming.
 */

/** Content block types from pi-agent-core */
export type RealtimeOutputPhase = 'commentary' | 'final_answer';

export interface TextContent {
  type: 'text';
  text: string;
  contentIndex?: number;
  phase?: RealtimeOutputPhase;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
  thinkingSignature?: string;
  contentIndex?: number;
}

export interface ToolCallContent {
  type: 'toolCall';
  id: string;
  name: string;
  label?: string;
  arguments: Record<string, unknown>;
  contentIndex?: number;
}

export interface ToolResultContent {
  type: 'toolResult';
  toolCallId: string;
  result: string;
  isError?: boolean;
}

export interface ToolOutputContent {
  type: 'toolOutput';
  toolCallId: string;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
  pid?: number;
  sequence?: number;
}

export type ContentBlock = TextContent | ThinkingContent | ToolCallContent | ToolOutputContent | ToolResultContent;

export interface AwarenessEntry {
  id: string;
  type: 'session' | 'message';
  timestamp: string;
  role?: 'user' | 'assistant' | 'toolResult';
  content?: ContentBlock[];
  /** Extracted from user message text prefix: [timestamp] [channel] [user]: text */
  channel?: string;
  userName?: string;
  /** The actual message text with the prefix stripped */
  strippedText?: string;
  /** Model info for assistant messages */
  model?: string;
  stopReason?: string;
  /** True while SSE is actively streaming this entry */
  isStreaming?: boolean;
  /** Live stream protocol that produced this transient entry. */
  streamProtocol?: 'snapshot';
  /** True if this is an ambient engagement trigger */
  isAmbient?: boolean;
  /** True if this is a system action (/model, /compact, etc.) */
  isSystemAction?: boolean;
}

/** Parse the [timestamp] [channel] [user]: text prefix from user messages */
export function parseUserPrefix(text: string): { channel: string; userName: string; strippedText: string } | null {
  const match = text.match(/^\[([^\]]+)\]\s*\[([^\]]+)\]\s*\[([^\]]+)\]:\s*([\s\S]*)$/);
  if (!match) return null;
  return { channel: match[2], userName: match[3], strippedText: match[4] };
}

/** Normalize channel identifiers to display-friendly names */
export function formatChannel(channel: string): { label: string; type: string } {
  if (channel === 'heartbeat' || channel.startsWith('heartbeat:')) return { label: 'heartbeat', type: 'heartbeat' };
  if (channel === 'operator' || channel.startsWith('operator:')) return { label: 'operator', type: 'operator' };
  if (channel === 'voice' || channel === 'web-voice') return { label: 'voice', type: 'voice' };
  if (channel === 'web' || channel === 'web-user') return { label: 'web', type: 'web' };
  if (channel.startsWith('slack:')) return { label: channel.slice('slack:'.length), type: 'slack' };
  if (channel.startsWith('email-')) return { label: 'email', type: 'email' };
  if (channel.startsWith('telegram:') || /^-?\d+$/.test(channel)) return { label: channel.replace('telegram:', ''), type: 'telegram' };
  if (channel === 'DM:Alex' || channel.startsWith('DM:')) return { label: channel, type: 'telegram' };
  if (/^[CDG]/.test(channel)) return { label: `#${channel}`, type: 'slack' };
  if (['general', 'zip-chat', 'random'].includes(channel) || channel.includes('-')) {
    return { label: `#${channel}`, type: 'slack' };
  }
  return { label: channel, type: 'unknown' };
}

/** Parse a single JSON line from context.jsonl into an AwarenessEntry */
export function parseContextLine(line: string): AwarenessEntry | null {
  try {
    const raw = JSON.parse(line);

    if (raw.type === 'session') {
      return {
        id: raw.id || `session-${raw.timestamp}`,
        type: 'session',
        timestamp: raw.timestamp,
      };
    }

    if (raw.type === 'message' && raw.message) {
      const msg = raw.message;
      const entry: AwarenessEntry = {
        id: raw.id || `msg-${raw.timestamp}`,
        type: 'message',
        timestamp: raw.timestamp,
        role: msg.role,
        content: normalizeContentBlocks(msg.content),
        model: raw.model,
        stopReason: raw.stopReason,
      };

      if (msg.role === 'user' && Array.isArray(entry.content)) {
        const textBlock = entry.content.find((c: ContentBlock) => c.type === 'text') as TextContent | undefined;
        if (textBlock) {
          // Strip model-only context before parsing — it precedes the [timestamp] prefix
          const cleaned = stripModelContextBlocks(textBlock.text).trim();
          const parsed = parseUserPrefix(cleaned);
          if (parsed) {
            entry.channel = parsed.channel;
            entry.userName = parsed.userName;
            entry.strippedText = parsed.strippedText.trimStart();
            // Detect ambient engagement messages
            if (entry.strippedText.startsWith('[AMBIENT]')) {
              entry.isAmbient = true;
              entry.userName = 'system';
            }
            // Detect system actions (/model, /compact, etc.)
            if (parsed.userName === 'system' && entry.strippedText.startsWith('/')) {
              entry.isSystemAction = true;
            }
          } else if (cleaned.startsWith('[AMBIENT]')) {
            // Same-thread ambient context may be soft-steered directly into an
            // active model turn and persisted without the usual user prefix.
            // Classify it before rendering so model-only evaluation guidance
            // can never fall through as an ordinary awareness user message.
            entry.channel = ambientChannel(cleaned) || 'awareness';
            entry.userName = 'system';
            entry.strippedText = cleaned;
            entry.isAmbient = true;
          } else if (cleaned !== textBlock.text) {
            // Session context was stripped but no prefix found — use cleaned text
            entry.strippedText = cleaned;
          }
        }
      }

      return entry;
    }
  } catch {
    // Malformed line
  }
  return null;
}

function ambientChannel(text: string): string | undefined {
  const match = text.match(/^\[AMBIENT\]\s+A conversation is happening in ([^.\n]+)\./);
  return match?.[1]?.trim() || undefined;
}

function normalizeContentBlocks(content: unknown): ContentBlock[] | undefined {
  if (!Array.isArray(content)) return undefined;
  return content.map((block) => normalizeContentBlock(block)).filter((block): block is ContentBlock => block !== null);
}

function normalizeContentBlock(block: unknown): ContentBlock | null {
  if (!block || typeof block !== 'object') return null;
  const raw = block as Record<string, unknown>;

  if (raw.type === 'text') {
    return {
      type: 'text',
      text: typeof raw.text === 'string' ? raw.text : '',
      phase: normalizeRealtimeOutputPhase(raw.phase),
    };
  }
  if (raw.type === 'thinking') {
    return {
      type: 'thinking',
      thinking: typeof raw.thinking === 'string' ? raw.thinking : '',
      thinkingSignature: typeof raw.thinkingSignature === 'string' ? raw.thinkingSignature : undefined,
    };
  }
  if (raw.type === 'toolCall' || raw.type === 'tool_call' || raw.type === 'tool_use') {
    const rawArgs = raw.arguments ?? raw.args ?? raw.input;
    const args = isRecord(rawArgs) ? rawArgs : {};
    const label = cleanLabel(raw.label) || cleanLabel(args.label);
    return {
      type: 'toolCall',
      id: String(raw.id ?? raw.toolCallId ?? raw.tool_call_id ?? raw.toolUseId ?? raw.tool_use_id ?? ''),
      name: String(raw.name ?? raw.toolName ?? raw.tool_name ?? 'tool'),
      ...(label ? { label } : {}),
      arguments: args,
    };
  }
  if (raw.type === 'toolResult' || raw.type === 'tool_result') {
    const result = raw.result ?? raw.content ?? raw.output ?? '';
    return {
      type: 'toolResult',
      toolCallId: String(raw.toolCallId ?? raw.tool_call_id ?? raw.toolUseId ?? raw.tool_use_id ?? ''),
      result: typeof result === 'string' ? result : JSON.stringify(result),
      isError: Boolean(raw.isError ?? raw.is_error),
    };
  }
  if (raw.type === 'toolOutput' || raw.type === 'toolResultDelta' || raw.type === 'tool_result_delta') {
    return {
      type: 'toolOutput',
      toolCallId: String(raw.toolCallId ?? raw.tool_call_id ?? raw.toolUseId ?? raw.tool_use_id ?? ''),
      stream: normalizeToolOutputStream(raw.stream),
      text: typeof raw.text === 'string' ? raw.text : '',
      pid: typeof raw.pid === 'number' ? raw.pid : undefined,
      sequence: typeof raw.sequence === 'number' ? raw.sequence : undefined,
    };
  }

  return null;
}

function normalizeToolOutputStream(value: unknown): ToolOutputContent['stream'] {
  return value === 'stderr' || value === 'system' ? value : 'stdout';
}

function normalizeRealtimeOutputPhase(value: unknown): RealtimeOutputPhase | undefined {
  return value === 'commentary' || value === 'final_answer' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cleanLabel(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
