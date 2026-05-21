import type { DisplayProjectManifestFile } from '../../console-api';

export type DisplayProjectKind = 'preview' | 'html';

export interface DisplayProjectPreviewConfig {
  port: number;
  path: string;
}

export interface DisplayProject {
  id: string;
  title: string;
  icon: string;
  accent?: string;
  kind: DisplayProjectKind;
  projectPath: string;
  manifestPath: string;
  preview?: DisplayProjectPreviewConfig;
  entry?: string;
  raw: Record<string, unknown>;
}

export interface ParsedDisplayProjectFile {
  path: string;
  name: string;
  project: DisplayProject | null;
  error: string | null;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SAFE_ENTRY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,240}$/;
const RESERVED_PREVIEW_PORTS = new Set([3000, 3002, 6080, 8765, 9222]);

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

function isReservedPreviewPort(port: number): boolean {
  return RESERVED_PREVIEW_PORTS.has(port) || (port >= 5900 && port <= 5999);
}

function isValidPreviewPort(port: number | null): port is number {
  return Number.isInteger(port) && port >= 1024 && port <= 65535 && !isReservedPreviewPort(port);
}

function normalizeId(value: string | null, fallback: string): string {
  const candidate = (value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return ID_PATTERN.test(candidate) ? candidate : 'display-project';
}

function dirname(path: string): string {
  const parts = path.split('/');
  parts.pop();
  return parts.join('/');
}

function projectSlugFromPath(path: string): string {
  const projectPath = dirname(path);
  return projectPath.split('/').filter(Boolean).pop() || path.replace(/\.json$/, '');
}

function normalizePath(path: string | null): string {
  if (!path) return '/';
  if (/^https?:\/\//i.test(path)) return '/';
  return path.startsWith('/') ? path : `/${path}`;
}

function normalizeEntry(value: string | null): string {
  const entry = value || 'index.html';
  if (entry.includes('..') || entry.startsWith('/') || !SAFE_ENTRY_PATTERN.test(entry)) return 'index.html';
  return entry;
}

function normalizeAccent(value: string | null): string | undefined {
  if (!value || value.length > 40) return undefined;
  if (/^#[0-9a-fA-F]{3,8}$/.test(value)) return value;
  if (/^[a-zA-Z]+$/.test(value)) return value;
  return undefined;
}

export function parseDisplayProjectFile(file: DisplayProjectManifestFile): ParsedDisplayProjectFile {
  let raw: unknown;
  try {
    raw = JSON.parse(file.content);
  } catch {
    return { path: file.path, name: file.name, project: null, error: 'Invalid JSON' };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { path: file.path, name: file.name, project: null, error: 'Display project must be a JSON object' };
  }

  const data = raw as Record<string, unknown>;
  const id = normalizeId(stringValue(data.id), projectSlugFromPath(file.path));
  const title = stringValue(data.title ?? data.name) ?? id.replace(/[-_]+/g, ' ');
  const requestedKind = stringValue(data.kind ?? data.type);
  const previewConfig = data.preview && typeof data.preview === 'object' && !Array.isArray(data.preview)
    ? data.preview as Record<string, unknown>
    : data;
  const previewPort = numberValue(previewConfig.port);
  const kind: DisplayProjectKind =
    requestedKind === 'html' || requestedKind === 'generated'
      ? 'html'
      : 'preview';

  if (kind === 'preview') {
    if (!isValidPreviewPort(previewPort)) {
      return {
        path: file.path,
        name: file.name,
        project: null,
        error: 'Preview projects need a port from 1024-65535, excluding 3000, 3002, 6080, 8765, 9222, and 5900-5999',
      };
    }
  }

  const project: DisplayProject = {
    id,
    title,
    icon: stringValue(data.icon) ?? (kind === 'html' ? 'sparkles' : 'monitor'),
    accent: normalizeAccent(stringValue(data.accent ?? data.color)),
    kind,
    projectPath: file.projectPath,
    manifestPath: file.path,
    preview: kind === 'preview' && previewPort
      ? {
        port: previewPort,
        path: normalizePath(stringValue(previewConfig.path ?? previewConfig.entry ?? previewConfig.url)),
      }
      : undefined,
    entry: kind === 'html' ? normalizeEntry(stringValue(data.entry)) : undefined,
    raw: data,
  };

  return { path: file.path, name: file.name, project, error: null };
}
