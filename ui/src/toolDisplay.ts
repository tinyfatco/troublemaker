import type { ToolCallContent, ToolResultContent } from './types';

export type ToolDisplayStatus = 'running' | 'error' | 'done';

const TITLE_KEYS = ['label', 'description', 'summary', 'title', 'action'];
const DETAIL_KEYS = ['path', 'file', 'filePath', 'targetPath', 'command', 'cmd', 'query', 'pattern', 'url'];

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

export function getToolStatusText(status: ToolDisplayStatus, result?: ToolResultContent): string {
  if (status === 'running') return 'running';
  if (status === 'error') return 'error';
  if (result?.result) return summarizeToolResult(String(result.result));
  return 'done';
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
