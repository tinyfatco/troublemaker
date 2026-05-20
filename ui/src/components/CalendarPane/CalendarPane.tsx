import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react';
import {
  Calendar,
  Timeline,
  WeekView,
  addDays,
  formatDate,
  isSameDay,
  startOfDay,
  startOfWeek,
  useCalendarState,
  type CalendarView,
  type PositionedEvent,
  type TimeAxisLabel,
} from '@plain-calendar/react';
import { useCalendarEvents } from '../../hooks/useCalendarEvents';
import { usePersistentState } from '../../hooks/usePersistentState';
import type { AgentCalendarEvent, ParsedCalendarEventFile } from './calendarAdapter';

const VIEWS: CalendarView[] = ['month', 'week', 'day', 'agenda'];
const HOUR_HEIGHTS = [44, 56, 72, 88] as const;
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseCalendarView(value: unknown): CalendarView | null {
  return typeof value === 'string' && VIEWS.includes(value as CalendarView)
    ? value as CalendarView
    : null;
}

function parseBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function parseHourHeightIndex(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(HOUR_HEIGHTS.length - 1, Math.round(value)))
    : null;
}

function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateFromKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  return startOfDay(new Date(year, month - 1, day));
}

function parseDateKey(value: unknown): string | null {
  if (typeof value !== 'string' || !DATE_KEY_PATTERN.test(value)) return null;
  const date = dateFromKey(value);
  return Number.isNaN(date.getTime()) || toDateKey(date) !== value ? null : value;
}

function formatClock(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function eventTime(event: AgentCalendarEvent): string {
  if (event.allDay) return 'All day';
  return `${formatClock(event.start)}-${formatClock(event.end)}`;
}

function rangeLabel(view: CalendarView, date: Date, viewStart: Date): string {
  if (view === 'day') {
    return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }
  if (view === 'week') {
    const weekEnd = addDays(viewStart, 6);
    return `${viewStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} - ${weekEnd.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  }
  if (view === 'agenda') {
    return 'Agenda';
  }
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function filterDayEvents(events: AgentCalendarEvent[], date: Date): AgentCalendarEvent[] {
  return events
    .filter((event) => isSameDay(event.start, date))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

function upcomingEvents(events: AgentCalendarEvent[], date: Date): AgentCalendarEvent[] {
  const start = startOfDay(date);
  const end = addDays(start, 45);
  return events
    .filter((event) => event.end >= start && event.start <= end)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

export function CalendarPane() {
  const [view, setView] = usePersistentState<CalendarView>(
    'troublemaker.calendar.view',
    'month',
    { parse: parseCalendarView },
  );
  const [selectedDateKey, setSelectedDateKey] = usePersistentState(
    'troublemaker.calendar.selectedDate',
    toDateKey(new Date()),
    { parse: parseDateKey },
  );
  const [selectedEvent, setSelectedEvent] = useState<AgentCalendarEvent | null>(null);
  const [detailOpen, setDetailOpen] = usePersistentState(
    'troublemaker.calendar.detailOpen',
    false,
    { parse: parseBoolean },
  );
  const [hourHeightIndex, setHourHeightIndex] = usePersistentState(
    'troublemaker.calendar.hourHeightIndex',
    1,
    { parse: parseHourHeightIndex },
  );
  const initialDate = useMemo(() => dateFromKey(selectedDateKey), [selectedDateKey]);
  const calendar = useCalendarState({ initialDate, view, weekStartsOn: 0 });
  const query = useCalendarEvents();
  const parsedFiles = query.data ?? [];

  useEffect(() => {
    const nextDateKey = toDateKey(calendar.selectedDate);
    setSelectedDateKey((currentDateKey) => (
      currentDateKey === nextDateKey ? currentDateKey : nextDateKey
    ));
  }, [calendar.selectedDate, setSelectedDateKey]);

  const { events, invalidFiles } = useMemo(() => {
    const valid: AgentCalendarEvent[] = [];
    const invalid: ParsedCalendarEventFile[] = [];
    for (const file of parsedFiles) {
      if (file.event) valid.push(file.event);
      else invalid.push(file);
    }
    valid.sort((a, b) => a.start.getTime() - b.start.getTime());
    return { events: valid, invalidFiles: invalid };
  }, [parsedFiles]);

  const dayEvents = useMemo(
    () => filterDayEvents(events, calendar.selectedDate),
    [events, calendar.selectedDate],
  );
  const agendaEvents = useMemo(
    () => upcomingEvents(events, calendar.selectedDate),
    [events, calendar.selectedDate],
  );
  const showDetails = detailOpen;
  const hourHeight = HOUR_HEIGHTS[hourHeightIndex];
  const timeGridStyle = { minHeight: `${24 * hourHeight}px` };
  const selectEvent = (event: AgentCalendarEvent) => {
    setSelectedEvent(event);
    setDetailOpen(true);
  };
  const openDay = (date: Date) => {
    calendar.setSelectedDate(date);
    setSelectedEvent(null);
    setView('day');
  };
  const activateDay = (date: Date, event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openDay(date);
    }
  };
  const isTimedView = view === 'week' || view === 'day';

  return (
    <div className="calendar-pane">
      <div className="calendar-toolbar">
        <div className="calendar-nav">
          <button className="calendar-icon-btn" onClick={calendar.goToPrevious} title="Previous">
            <ChevronLeftIcon />
          </button>
          <button className="calendar-today-btn" onClick={calendar.goToToday}>Today</button>
          <button className="calendar-icon-btn" onClick={calendar.goToNext} title="Next">
            <ChevronRightIcon />
          </button>
        </div>
        <div className="calendar-title">
          {rangeLabel(view, calendar.currentViewingDate, calendar.viewStartDate)}
        </div>
        <div className="calendar-view-tabs" role="tablist" aria-label="Calendar view">
          {VIEWS.map((item) => (
            <button
              key={item}
              className={view === item ? 'active' : ''}
              onClick={() => setView(item)}
              role="tab"
              aria-selected={view === item}
            >
              {item}
            </button>
          ))}
        </div>
        {isTimedView && (
          <div className="calendar-density-controls" aria-label="Time scale">
            <button
              className="calendar-icon-btn"
              onClick={() => setHourHeightIndex((index) => Math.max(0, index - 1))}
              disabled={hourHeightIndex === 0}
              title="Compact time grid"
            >
              <MinusIcon />
            </button>
            <button
              className="calendar-icon-btn"
              onClick={() => setHourHeightIndex((index) => Math.min(HOUR_HEIGHTS.length - 1, index + 1))}
              disabled={hourHeightIndex === HOUR_HEIGHTS.length - 1}
              title="Expand time grid"
            >
              <PlusIcon />
            </button>
          </div>
        )}
        <button
          className={`calendar-icon-btn calendar-detail-toggle ${showDetails ? 'active' : ''}`}
          onClick={() => setDetailOpen((open) => !open)}
          title={showDetails ? 'Hide event details' : 'Show event details'}
        >
          <DetailsIcon />
        </button>
      </div>

      <div className={`calendar-content ${showDetails ? 'with-detail' : ''}`}>
        <div className="calendar-main">
          {query.isLoading && (
            <div className="calendar-state">
              <span className="tool-spinner" />
            </div>
          )}

          {!query.isLoading && view === 'month' && (
            <Calendar
              className="plain-calendar-month"
              events={events}
              month={calendar.currentViewingDate}
              maxEventsPerDay={4}
              renderHeader={() => null}
              renderWeekdayHeader={(weekday) => (
                <div className="calendar-weekday">{weekday}</div>
              )}
              renderDay={(date, dayEventsForCell, isCurrentMonth, isToday) => (
                <div
                  className={[
                    'calendar-day',
                    isCurrentMonth ? '' : 'muted',
                    isToday ? 'today' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => openDay(date)}
                  onKeyDown={(event) => activateDay(date, event)}
                  role="button"
                  tabIndex={0}
                  aria-label={`Open ${date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} day view`}
                >
                  <div className="calendar-day-number">{date.getDate()}</div>
                  <div className="calendar-day-events">
                    {dayEventsForCell.slice(0, 4).map((event) => (
                      <button
                        key={event.id}
                        className="calendar-event-chip"
                        style={{ '--event-color': event.color } as CSSProperties}
                        onClick={(e) => {
                          e.stopPropagation();
                          selectEvent(event as AgentCalendarEvent);
                        }}
                      >
                        {event.title}
                      </button>
                    ))}
                    {dayEventsForCell.length > 4 && (
                      <span className="calendar-more">+{dayEventsForCell.length - 4}</span>
                    )}
                  </div>
                </div>
              )}
            />
          )}

          {!query.isLoading && view === 'week' && (
            <WeekView
              className="plain-calendar-week"
              events={events}
              weekStart={startOfWeek(calendar.currentViewingDate)}
              startHour={0}
              endHour={24}
              style={timeGridStyle}
              renderTimeAxis={renderTimeAxis}
              renderEvent={(event) => (
                <CalendarTimedEvent event={event} onSelect={selectEvent} />
              )}
            />
          )}

          {!query.isLoading && view === 'day' && (
            <Timeline
              className="plain-calendar-day"
              events={dayEvents}
              date={calendar.selectedDate}
              startHour={0}
              endHour={24}
              style={timeGridStyle}
              renderTimeAxis={renderTimeAxis}
              renderEvent={(event) => (
                <CalendarTimedEvent event={event} onSelect={selectEvent} />
              )}
            />
          )}

          {!query.isLoading && view === 'agenda' && (
            <AgendaView events={agendaEvents} onSelect={selectEvent} />
          )}
        </div>

        {showDetails && <CalendarDetail event={selectedEvent} invalidFiles={invalidFiles} />}
      </div>
    </div>
  );
}

function renderTimeAxis(labels: TimeAxisLabel[]) {
  return (
    <div className="calendar-time-axis">
      {labels.slice(1).map((label) => (
        <div
          key={label.hour}
          className="calendar-time-label"
          style={{ top: `${label.position}%` }}
        >
          {label.label}
        </div>
      ))}
    </div>
  );
}

function CalendarTimedEvent({
  event,
  onSelect,
}: {
  event: PositionedEvent<AgentCalendarEvent>;
  onSelect: (event: AgentCalendarEvent) => void;
}) {
  const width = 100 / event.totalColumns;
  const left = event.column * width;

  return (
    <button
      className="calendar-timed-event"
      style={{
        top: `${event.top}%`,
        height: `${event.height}%`,
        left: `${left}%`,
        width: `${width}%`,
        '--event-color': event.event.color,
      } as CSSProperties}
      onClick={() => onSelect(event.event)}
      title={`${event.event.title} ${eventTime(event.event)}`}
    >
      <span>{event.event.title}</span>
      <small>{eventTime(event.event)}</small>
    </button>
  );
}

function AgendaView({
  events,
  onSelect,
}: {
  events: AgentCalendarEvent[];
  onSelect: (event: AgentCalendarEvent) => void;
}) {
  if (events.length === 0) {
    return <div className="calendar-state">No upcoming events</div>;
  }

  return (
    <div className="calendar-agenda">
      {events.map((event) => (
        <button key={event.id} className="calendar-agenda-row" onClick={() => onSelect(event)}>
          <span className="calendar-agenda-date">{formatDate(event.start, { month: 'short', day: 'numeric' })}</span>
          <span className="calendar-agenda-dot" style={{ background: event.color }} />
          <span className="calendar-agenda-title">{event.title}</span>
          <span className="calendar-agenda-time">{eventTime(event)}</span>
        </button>
      ))}
    </div>
  );
}

function CalendarDetail({
  event,
  invalidFiles,
}: {
  event: AgentCalendarEvent | null;
  invalidFiles: ParsedCalendarEventFile[];
}) {
  return (
    <aside className="calendar-detail">
      {event ? (
        <>
          <div className="calendar-detail-header">
            <span className="calendar-detail-dot" style={{ background: event.color }} />
            <div>
              <h3>{event.title}</h3>
              <p>{eventTime(event)}</p>
            </div>
          </div>
          <dl className="calendar-detail-list">
            <div>
              <dt>Date</dt>
              <dd>{event.start.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{event.source ?? 'agent'}</dd>
            </div>
            {event.status && (
              <div>
                <dt>Status</dt>
                <dd>{event.status}</dd>
              </div>
            )}
            <div>
              <dt>Path</dt>
              <dd>{event.path}</dd>
            </div>
          </dl>
          {event.description && <p className="calendar-detail-description">{event.description}</p>}
          <pre className="calendar-json">{JSON.stringify(event.raw, null, 2)}</pre>
        </>
      ) : (
        <div className="calendar-detail-empty">
          <h3>Calendar</h3>
          <p>{invalidFiles.length > 0 ? `${invalidFiles.length} invalid event file${invalidFiles.length === 1 ? '' : 's'}` : 'calendar/events'}</p>
        </div>
      )}
      {invalidFiles.length > 0 && (
        <div className="calendar-invalid">
          {invalidFiles.map((file) => (
            <div key={file.path}>
              <strong>{file.name}</strong>
              <span>{file.error}</span>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

function ChevronLeftIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DetailsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M3 3h10M3 8h10M3 13h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M4 8h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M8 4v8M4 8h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
