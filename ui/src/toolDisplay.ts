import type { ToolCallContent, ToolResultContent } from './types';

export type ToolDisplayStatus = 'running' | 'error' | 'done';

const TITLE_KEYS = ['label', 'description', 'summary', 'title', 'action'];
const DETAIL_KEYS = ['path', 'file', 'filePath', 'targetPath', 'command', 'cmd', 'query', 'pattern', 'url'];
const YIELD_NO_ACTION_TOOL_NAMES = new Set(['yield_no_action', 'functions.yield_no_action']);
const SEND_MESSAGE_TOOL_NAMES = new Set([
  'send_message_to_channel',
  'functions.send_message_to_channel',
  'send_message',
  'functions.send_message',
]);

export function getToolTitle(block: ToolCallContent): string {
  const args = block.arguments || {};
  for (const key of TITLE_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return humanizeToolName(block.name);
}

export function getToolDetail(block: ToolCallContent): string | null {
  const args = block.arguments || {};
  if (YIELD_NO_ACTION_TOOL_NAMES.has(block.name)) {
    const reason = args.reason;
    if (typeof reason === 'string' && reason.trim()) return reason.trim();
  }
  if (SEND_MESSAGE_TOOL_NAMES.has(block.name)) {
    const detail = getSendMessageDetail(args);
    if (detail) return detail;
  }
  for (const key of DETAIL_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

export function getToolStatus(isRunning: boolean, result?: ToolResultContent): ToolDisplayStatus {
  if (isRunning) return 'running';
  if (result?.isError) return 'error';
  return 'done';
}

export function getToolStatusText(status: ToolDisplayStatus, _result?: ToolResultContent): string {
  if (status === 'running') return 'running';
  if (status === 'error') return 'error';
  return '';
}

export function summarizeToolResult(result: string): string {
  if (!result) return 'done';
  const lines = result.split('\n').length;
  if (lines > 1) return `${lines} lines`;
  return result.length > 64 ? `${result.length} chars` : 'done';
}

export function humanizeToolName(name: string): string {
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()) || 'Tool';
}

function getSendMessageDetail(args: Record<string, unknown>): string | null {
  const channel = typeof args.channel === 'string' ? args.channel.trim() : '';
  const text = typeof args.text === 'string' ? args.text.trim() : '';
  if (!channel && !text) return null;
  const target = channel ? formatChannelTarget(channel) : 'Channel';
  if (!text) return target;
  return `${target}: ${truncateOneLine(text, 96)}`;
}

function formatChannelTarget(channel: string): string {
  if (channel.startsWith('email-')) return `Email ${channel.slice(6) || channel}`;
  if (channel.startsWith('phone-')) return 'Phone';
  if (channel.startsWith('discord:') || channel.startsWith('discord-') || /^\d{17,20}$/.test(channel)) return 'Discord';
  if (/^-?\d+$/.test(channel)) return 'Telegram';
  if (/^[CDG]/.test(channel)) return 'Slack';
  return channel;
}

function truncateOneLine(text: string, maxLength: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLength) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}
