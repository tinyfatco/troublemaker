import type { CalendarEvent } from '@plain-calendar/react';
import type { CalendarEventFile } from '../../console-api';

export interface AgentCalendarEvent extends CalendarEvent {
  path: string;
  source?: string;
  status?: string;
  description?: string;
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
    title,
    start,
    end,
    allDay,
    color: stringValue(data.color) ?? eventColor(source, status),
    source,
    status,
    description: stringValue(data.description ?? data.notes),
    data,
    raw: data,
    path: file.path,
  };

  return { path: file.path, name: file.name, event, error: null };
}
