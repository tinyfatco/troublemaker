import type { CalendarEvent } from '@plain-calendar/react';
import type { AgentScheduleManifestEvent, CalendarEventFile } from '../../console-api';

export type CalendarLayer = 'calendar' | 'agent-schedule';
export type AgentScheduleType = 'immediate' | 'one-shot' | 'periodic';

export interface AgentCalendarEvent extends CalendarEvent {
  path: string;
  layer: CalendarLayer;
  source?: string;
  status?: string;
  description?: string;
  scheduleType?: AgentScheduleType;
  schedule?: string;
  timezone?: string;
  nextFire?: string;
  isSystem?: boolean;
  raw: Record<string, unknown>;
}

export interface ParsedCalendarEventFile {
  path: string;
  name: string;
  event: AgentCalendarEvent | null;
  error: string | null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function dateValue(value: unknown): Date | null {
  const text = stringValue(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function fallbackEnd(start: Date, allDay: boolean): Date {
  const end = new Date(start);
  end.setMinutes(end.getMinutes() + (allDay ? 24 * 60 : 30));
  return end;
}

function eventColor(source?: string, status?: string): string {
  if (status === 'cancelled') return '#9ca3af';
  if (source === 'google') return '#2563eb';
  if (source === 'agent') return '#0f766e';
  if (source === 'agent-schedule') return '#b45309';
  if (source === 'system') return '#9b3f55';
  if (source === 'user') return '#7c3aed';
  return '#334155';
}

export function parseCalendarEventFile(file: CalendarEventFile): ParsedCalendarEventFile {
  let raw: unknown;
  try {
    raw = JSON.parse(file.content);
  } catch {
    return { path: file.path, name: file.name, event: null, error: 'Invalid JSON' };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { path: file.path, name: file.name, event: null, error: 'Calendar event must be a JSON object' };
  }

  const data = raw as Record<string, unknown>;
  const start = dateValue(data.start ?? data.start_at ?? data.at ?? data.date);
  if (!start) {
    return { path: file.path, name: file.name, event: null, error: 'Missing valid start time' };
  }

  const allDay = data.allDay === true || data.all_day === true;
  const explicitEnd = dateValue(data.end ?? data.end_at);
  const end = explicitEnd && explicitEnd > start ? explicitEnd : fallbackEnd(start, allDay);
  const source = stringValue(data.source) ?? 'agent';
  const status = stringValue(data.status) ?? undefined;
  const title =
    stringValue(data.title) ??
    stringValue(data.summary) ??
    stringValue(data.text) ??
    file.name.replace(/\.json$/, '');

  const event: AgentCalendarEvent = {
    id: stringValue(data.id) ?? file.path,
    layer: 'calendar',
    title,
    start,
    end,
    allDay,
    color: stringValue(data.color) ?? eventColor(source, status),
    source,
    status,
    description: stringValue(data.description ?? data.notes) ?? undefined,
    data,
    raw: data,
    path: file.path,
  };

  return { path: file.path, name: file.name, event, error: null };
}


function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function titleFromText(text: string | null): string | null {
  if (!text) return null;
  const clean = text.replace(/^\[[^\]]+\]\s*/, '').trim();
  if (!clean) return null;
  return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
}

function filenameTitle(file: CalendarEventFile): string {
  return file.name
    .replace(/\.json$/, '')
    .replace(/^\d{4}-\d{2}-\d{2}[-_]?/, '')
    .replace(/[-_]+/g, ' ')
    .trim() || file.name.replace(/\.json$/, '');
}

function isSystemSchedule(file: CalendarEventFile, data: Record<string, unknown>): boolean {
  const action = stringValue(data.action);
  const text = stringValue(data.text);
  return file.name === 'heartbeat.json' || action === 'compact' || text === '[heartbeat] Spontaneous reflection';
}

function agentScheduleTitle(file: CalendarEventFile, data: Record<string, unknown>, isSystem: boolean): string {
  if (isSystem && file.name === 'heartbeat.json') return 'Heartbeat';
  if (stringValue(data.action) === 'compact') return 'Memory compact';
  return (
    stringValue(data.title) ??
    stringValue(data.summary) ??
    titleFromText(stringValue(data.text)) ??
    filenameTitle(file)
  );
}

export function parseAgentScheduleFile(
  file: CalendarEventFile,
  manifestEvent?: AgentScheduleManifestEvent,
): ParsedCalendarEventFile {
  let raw: unknown;
  try {
    raw = JSON.parse(file.content);
  } catch {
    return { path: file.path, name: file.name, event: null, error: 'Invalid JSON' };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { path: file.path, name: file.name, event: null, error: 'Agent schedule file must be a JSON object' };
  }

  const data = raw as Record<string, unknown>;
  const type = stringValue(data.type) as AgentScheduleType | null;
  if (type !== 'immediate' && type !== 'one-shot' && type !== 'periodic') {
    return { path: file.path, name: file.name, event: null, error: 'Unknown agent schedule type' };
  }

  const start = dateValue(manifestEvent?.nextFire ?? (type === 'one-shot' ? data.at : null));
  if (!start) {
    return { path: file.path, name: file.name, event: null, error: null };
  }

  const duration = Math.max(5, Math.min(240, numberValue(data.durationMinutes) ?? (type === 'periodic' ? 10 : 15)));
  const end = new Date(start);
  end.setMinutes(end.getMinutes() + duration);
  const isSystem = isSystemSchedule(file, data);
  const source = isSystem ? 'system' : 'agent-schedule';
  const title = agentScheduleTitle(file, data, isSystem);
  const rawWithSchedule = manifestEvent
    ? { ...data, _nextFire: manifestEvent.nextFire, _manifestType: manifestEvent.type }
    : data;

  const event: AgentCalendarEvent = {
    id: `agent-schedule:${file.path}`,
    layer: 'agent-schedule',
    title,
    start,
    end,
    allDay: false,
    color: stringValue(data.color) ?? eventColor(source),
    source,
    status: stringValue(data.status) ?? 'queued',
    description: stringValue(data.description ?? data.notes ?? data.text) ?? undefined,
    scheduleType: type,
    schedule: stringValue(data.schedule) ?? undefined,
    timezone: stringValue(data.timezone) ?? undefined,
    nextFire: manifestEvent?.nextFire ?? start.toISOString(),
    isSystem,
    data,
    raw: rawWithSchedule,
    path: file.path,
  };

  return { path: file.path, name: file.name, event, error: null };
}
