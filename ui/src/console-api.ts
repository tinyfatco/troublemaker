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

const DEFAULT_FETCH_TIMEOUT_MS = 8000;

function currentAgentId(): string {
  const match = window.location.pathname.match(/\/agents\/([0-9a-f-]{36})(?:\/|$)/i);
  return match?.[1] ?? 'current';
}

export function consoleAgentUrl(endpoint: string): string {
  const suffix = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `/api/v2/agents/${encodeURIComponent(currentAgentId())}${suffix}`;
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

export async function fetchCalendarEventFiles(): Promise<CalendarEventFile[]> {
  let files: FileNode[];
  try {
    files = await listFiles('calendar/events');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes('not found')) return [];
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
