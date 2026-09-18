import type { ToolCallContent, ToolResultContent } from './types';

export type ToolDisplayStatus = 'running' | 'error' | 'done';

const TITLE_KEYS = ['label', 'description', 'summary', 'title', 'action'];
const DETAIL_KEYS = ['path', 'file', 'filePath', 'targetPath', 'command', 'cmd', 'query', 'pattern', 'url'];
const YIELD_NO_ACTION_TOOL_NAMES = new Set(['yield_no_action', 'functions.yield_no_action']);
const SEND_MESSAGE_TOOL_NAMES = new Set([
  'send_message',
  'functions.send_message',
]);
const CONFIGURE_TOOL_NAMES = new Set([
  'configure',
  'functions.configure',
  'self_configure',
  'functions.self_configure',
]);

export function getToolTitle(block: ToolCallContent): string {
  if (typeof block.label === 'string' && block.label.trim()) return block.label.trim();
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
  if (CONFIGURE_TOOL_NAMES.has(block.name)) {
    const detail = getConfigureDetail(args);
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
  const targetValue = typeof args.target === 'string' ? args.target : '';
  const target = targetValue.trim();
  const text = firstString(args, ['text', 'body', 'message', 'content']);
  if (!target && !text) return null;
  if (!target) return truncateOneLine(text, 96);
  const formattedTarget = formatMessageTarget(target);
  if (!text) return formattedTarget;
  return `${formattedTarget}: ${truncateOneLine(text, 96)}`;
}

function getConfigureDetail(args: Record<string, unknown>): string | null {
  const target = firstString(args, ['setting', 'target', 'key', 'path']);
  const hasValue = Object.prototype.hasOwnProperty.call(args, 'value')
    || Object.prototype.hasOwnProperty.call(args, 'newValue');
  const value = Object.prototype.hasOwnProperty.call(args, 'value') ? args.value : args.newValue;
  if (!target && !hasValue) return null;

  const formattedValue = hasValue ? formatConfigureValue(target, value) : null;
  if (target && formattedValue) return `${target} = ${formattedValue}`;
  return target || formattedValue;
}

function firstString(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function formatConfigureValue(target: string, value: unknown): string | null {
  if (value === undefined) return null;
  if (isSensitiveConfigureTarget(target)) return '[redacted]';
  if (typeof value === 'string') return truncateOneLine(value || '""', 96);
  try {
    return truncateOneLine(JSON.stringify(value), 96);
  } catch {
    return truncateOneLine(String(value), 96);
  }
}

function isSensitiveConfigureTarget(target: string): boolean {
  return /(^|[._-])(secret|secrets|token|password|credential|credentials|api[_-]?key|private[_-]?key)([._-]|$)/i.test(target);
}

function formatMessageTarget(target: string): string {
  if (target.startsWith('email-thread:')) return 'Email thread';
  if (target.startsWith('email-')) return `Email ${target.slice(6) || target}`;
  if (target.startsWith('phone-')) return 'Phone';
  if (/^slack:[CDG][A-Z0-9]+:\d+\.\d+$/i.test(target)) return 'Slack thread';
  if (target.startsWith('teams:')) return target.slice('teams:'.length).includes(':') ? 'Microsoft Teams thread' : 'Microsoft Teams';
  if (target.startsWith('discord:') || target.startsWith('discord-') || /^\d{17,20}$/.test(target)) return 'Discord';
  if (/^-?\d+$/.test(target)) return 'Telegram';
  if (/^[CDG]/.test(target)) return 'Slack';
  return target;
}

function truncateOneLine(text: string, maxLength: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLength) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}
