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

const DEFAULT_FETCH_TIMEOUT_MS = 8000;

function currentAgentId(): string {
  const match = window.location.pathname.match(/\/agents\/([0-9a-f-]{36})(?:\/|$)/i);
  return match?.[1] ?? 'current';
}

export function consoleAgentUrl(endpoint: string): string {
  const suffix = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `/api/v2/agents/${encodeURIComponent(currentAgentId())}${suffix}`;
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
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function fetchWorkspaceStatus(): Promise<WorkspaceStatus> {
  const resp = await fetchWithTimeout(consoleAgentUrl('/status'));
  if (!resp.ok) throw await readError(resp, `Status failed: ${resp.status}`);
  return resp.json();
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
