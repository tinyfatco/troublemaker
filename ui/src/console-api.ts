export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: string;
}

export interface WorkspaceStatus {
  agent_id: string;
  mode: 'standalone' | 'hosted';
  runtime?: string;
  workspace_ready?: boolean;
  display_mode: 'terminal' | 'desktop';
  agent_name: string;
  capabilities?: Record<string, boolean>;
}

export interface AwarenessBacklog {
  lines: string[];
  total: number;
  offset: number;
}

export interface CalendarEventFile {
  name: string;
  path: string;
  content: string;
}

export interface DisplayProjectManifestFile {
  name: string;
  path: string;
  projectPath: string;
  content: string;
}

export interface AgentScheduleManifestEvent {
  file: string;
  type: string;
  nextFire: string;
}

export interface AgentScheduleManifest {
  nextWake: string | null;
  events: AgentScheduleManifestEvent[];
}

export interface AgentModelOption {
  provider: string;
  id: string;
  name: string;
  api: string;
}

export interface AgentSettingsSnapshot {
  spontaneity?: {
    enabled?: boolean;
    level?: number;
    spontaneity?: number;
    intervalMinutes?: number;
    quietHours?: { start: string; end: string };
    timezone?: string;
  };
  verbose?: unknown;
  model?: string | null;
  provider?: string | null;
  models?: AgentModelOption[];
  thinking_level?: string | null;
  thinking_level_accepted?: string[];
  heartbeat?: {
    checklist?: string | null;
    checklist_present?: boolean;
    checklist_empty?: boolean;
    schedule_file?: unknown;
  };
  described_at?: string;
}

const DEFAULT_FETCH_TIMEOUT_MS = 8000;
const OPERATOR_FETCH_TIMEOUT_MS = 75000;
const EMBED_TOKEN_STORAGE_PREFIX = 'troublemaker.embedToken.';

function currentAgentId(): string {
  const match = window.location.pathname.match(/\/agents\/([0-9a-f-]{36})(?:\/|$)/i);
  return match?.[1] ?? 'current';
}

function embedTokenStorageKey(): string {
  return `${EMBED_TOKEN_STORAGE_PREFIX}${currentAgentId()}`;
}

function readEmbedTokenFromHash(): string | null {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  if (!hash) return null;

  const params = new URLSearchParams(hash);
  const token = params.get('embed_token') || params.get('embedToken');
  if (!token) return null;

  params.delete('embed_token');
  params.delete('embedToken');
  try {
    sessionStorage.setItem(embedTokenStorageKey(), token);
  } catch {
    // If storage is unavailable, keep using the fragment token for this load.
  }

  const nextHash = params.toString();
  const nextUrl = `${window.location.pathname}${window.location.search}${nextHash ? `#${nextHash}` : ''}`;
  window.history.replaceState(null, '', nextUrl);
  return token;
}

function embedToken(): string | null {
  const fromHash = readEmbedTokenFromHash();
  if (fromHash) return fromHash;
  try {
    return sessionStorage.getItem(embedTokenStorageKey());
  } catch {
    return null;
  }
}

export function isEmbedMode(): boolean {
  return window.location.pathname.includes('/embed/agents/') || !!embedToken();
}

function appendEmbedToken(url: string): string {
  const token = embedToken();
  if (!token) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}embed_token=${encodeURIComponent(token)}`;
}

export function consoleAgentUrl(endpoint: string): string {
  const suffix = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const base = isEmbedMode() ? '/embed/api/agents' : '/api/v2/agents';
  return appendEmbedToken(`${base}/${encodeURIComponent(currentAgentId())}${suffix}`);
}

export function agentWorkspaceUrl(endpoint: string): string {
  const suffix = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `/agents/${encodeURIComponent(currentAgentId())}${suffix}`;
}

export async function fetchDisplayPreviewUrl(input: { id: string; port: number; path?: string }): Promise<string> {
  const params = new URLSearchParams({
    port: String(input.port),
    name: input.id,
  });
  if (input.path) params.set('path', input.path);
  const resp = await fetchWithTimeout(agentWorkspaceUrl(`/preview-url?${params}`), {}, 12000);
  if (!resp.ok) throw await readError(resp, `Preview failed: ${resp.status}`);
  const data = await resp.json() as { url?: string };
  if (!data.url) throw new Error('Preview URL missing');
  return data.url;
}

async function readError(resp: Response, fallback: string): Promise<Error> {
  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const body = await resp.json().catch(() => null);
    const message = body?.error_description || body?.error || fallback;
    return new Error(message);
  }
  const text = await resp.text().catch(() => '');
  return new Error(text || fallback);
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { credentials: 'same-origin', ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function fetchWorkspaceStatus(): Promise<WorkspaceStatus> {
  const resp = await fetchWithTimeout(consoleAgentUrl('/status'));
  if (!resp.ok) throw await readError(resp, `Status failed: ${resp.status}`);
  return resp.json();
}

export async function fetchAgentSettings(): Promise<AgentSettingsSnapshot> {
  const resp = await fetchWithTimeout(consoleAgentUrl('/describe'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }, OPERATOR_FETCH_TIMEOUT_MS);
  if (!resp.ok) throw await readError(resp, `Settings failed: ${resp.status}`);
  return resp.json();
}

export async function configureAgentSetting(target: string, value: unknown): Promise<void> {
  const resp = await fetchWithTimeout(consoleAgentUrl('/configure'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target, value }),
  }, OPERATOR_FETCH_TIMEOUT_MS);
  if (!resp.ok) throw await readError(resp, `Configure failed: ${resp.status}`);
}

export async function fetchAwarenessBacklog(limit: number, before?: number): Promise<AwarenessBacklog> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before !== undefined) params.set('before', String(before));
  const resp = await fetchWithTimeout(consoleAgentUrl(`/events?${params}`));
  if (!resp.ok) throw await readError(resp, `Awareness failed: ${resp.status}`);
  return resp.json();
}

export function awarenessStreamUrl(): string {
  return consoleAgentUrl('/events/stream');
}

export async function createRealtimeClientSecret(input: { voice?: string; ttlSeconds?: number } = {}): Promise<string> {
  const body: Record<string, unknown> = {
    ttl_seconds: input.ttlSeconds ?? 600,
  };
  if (input.voice) body.voice = input.voice;

  const resp = await fetchWithTimeout(consoleAgentUrl('/realtime/client-secret'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 15000);
  if (!resp.ok) throw await readError(resp, `Realtime client secret failed: ${resp.status}`);

  const data = await resp.json().catch(() => null) as unknown;
  const value = realtimeClientSecretValue(data);
  if (!value) throw new Error('Realtime broker response did not include a client secret value.');
  return value;
}

function realtimeClientSecretValue(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const topLevel = (data as Record<string, unknown>).value;
  if (typeof topLevel === 'string' && topLevel.trim()) return topLevel.trim();

  const clientSecret = (data as Record<string, unknown>).client_secret;
  if (!clientSecret || typeof clientSecret !== 'object' || Array.isArray(clientSecret)) return null;
  const nestedValue = (clientSecret as Record<string, unknown>).value;
  return typeof nestedValue === 'string' && nestedValue.trim() ? nestedValue.trim() : null;
}

export async function listFiles(path: string): Promise<FileNode[]> {
  const params = new URLSearchParams({ path });
  const resp = await fetchWithTimeout(consoleAgentUrl(`/files?${params}`));
  if (!resp.ok) throw await readError(resp, `Files failed: ${resp.status}`);
  const data = await resp.json() as { files?: FileNode[] };
  return data.files || [];
}

export async function readFile(path: string): Promise<string> {
  const params = new URLSearchParams({ path });
  const resp = await fetchWithTimeout(consoleAgentUrl(`/file?${params}`), {}, 15000);
  if (!resp.ok) throw await readError(resp, `File read failed: ${resp.status}`);
  return resp.text();
}

async function fetchJsonWorkspaceFiles(path: string): Promise<CalendarEventFile[]> {
  let files: FileNode[];
  try {
    files = await listFiles(path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes('not found') || message.toLowerCase().includes('missing')) return [];
    throw err;
  }

  const jsonFiles = files
    .filter((file) => file.type === 'file' && file.name.endsWith('.json'))
    .sort((a, b) => a.name.localeCompare(b.name));

  const results = await Promise.allSettled(
    jsonFiles.map(async (file) => ({
      name: file.name,
      path: file.path,
      content: await readFile(file.path),
    })),
  );

  return results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
}

export async function fetchCalendarEventFiles(): Promise<CalendarEventFile[]> {
  return fetchJsonWorkspaceFiles('calendar/events');
}

export async function fetchDisplayProjectManifestFiles(): Promise<DisplayProjectManifestFile[]> {
  let entries: FileNode[];
  try {
    entries = await listFiles('display/projects');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes('not found') || message.toLowerCase().includes('missing')) return [];
    throw err;
  }

  const manifestEntries = entries
    .filter((entry) => entry.type === 'directory' || entry.name.endsWith('.json'))
    .sort((a, b) => a.name.localeCompare(b.name));

  const results = await Promise.allSettled(
    manifestEntries.map(async (entry) => {
      const path = entry.type === 'directory' ? `${entry.path}/display.json` : entry.path;
      return {
        name: entry.name,
        path,
        projectPath: entry.type === 'directory' ? entry.path : entry.path.replace(/\/[^/]+$/, ''),
        content: await readFile(path),
      };
    }),
  );

  return results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
}

export async function fetchAgentSchedulePromptFiles(): Promise<CalendarEventFile[]> {
  return fetchJsonWorkspaceFiles('attention/queue');
}

export async function fetchAgentScheduleManifest(): Promise<AgentScheduleManifest | null> {
  const resp = await fetchWithTimeout(agentWorkspaceUrl('/schedule'), {}, 6000);
  if (!resp.ok) return null;
  const data = await resp.json() as AgentScheduleManifest;
  if (!data || !Array.isArray(data.events)) return null;
  return data;
}

export async function saveWorkspaceFile(path: string, content: string): Promise<void> {
  const resp = await fetch(consoleAgentUrl('/file'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content }),
  });
  if (!resp.ok) throw await readError(resp, `Save failed: ${resp.status}`);
}

export interface WorkspaceToolExecuteResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export async function executeWorkspaceTool(tool: string, args: Record<string, unknown>): Promise<WorkspaceToolExecuteResponse> {
  const resp = await fetchWithTimeout(consoleAgentUrl('/tools/execute'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, args }),
  }, 150000);

  const data = await resp.json().catch(() => null) as WorkspaceToolExecuteResponse | null;
  if (!resp.ok) {
    const message = data?.error || `Tool execution failed: ${resp.status}`;
    throw new Error(message);
  }
  if (!data || typeof data !== 'object') {
    throw new Error('Tool execution returned an invalid response.');
  }
  return data;
}

export async function uploadWorkspaceFiles(files: File[], targetDir = 'attachments'): Promise<string[]> {
  const form = new FormData();
  form.append('targetDir', targetDir);
  for (const file of files) {
    form.append('file', file, file.name);
  }
  const resp = await fetch(consoleAgentUrl('/upload'), { method: 'POST', body: form });
  if (!resp.ok) throw await readError(resp, `Upload failed: ${resp.status}`);
  const data = await resp.json() as { uploaded?: string[] };
  return data.uploaded || [];
}

export function postMessageUrl(): string {
  return consoleAgentUrl('/messages');
}

export async function stopActiveMessage(channelId = 'web'): Promise<void> {
  if (isEmbedMode()) return;
  const resp = await fetch(consoleAgentUrl('/messages/stop'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId }),
  });
  if (!resp.ok) throw await readError(resp, `Stop failed: ${resp.status}`);
}

export function fileContentUrl(path: string): string {
  const params = new URLSearchParams({ path });
  return consoleAgentUrl(`/file?${params}`);
}
