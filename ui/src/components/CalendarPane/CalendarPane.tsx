import { useMemo, useState, type CSSProperties } from 'react';
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
} from '@plain-calendar/react';
import { useCalendarEvents } from '../../hooks/useCalendarEvents';
import type { AgentCalendarEvent, ParsedCalendarEventFile } from './calendarAdapter';

const VIEWS: CalendarView[] = ['month', 'week', 'day', 'agenda'];

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
  const [view, setView] = useState<CalendarView>('month');
  const [selectedEvent, setSelectedEvent] = useState<AgentCalendarEvent | null>(null);
  const calendar = useCalendarState({ view, weekStartsOn: 0 });
  const query = useCalendarEvents();
  const parsedFiles = query.data ?? [];

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
      </div>

      <div className="calendar-content">
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
                  onClick={() => calendar.setSelectedDate(date)}
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
                          setSelectedEvent(event as AgentCalendarEvent);
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
              startHour={6}
              endHour={22}
              renderEvent={(event) => (
                <CalendarTimedEvent event={event} onSelect={setSelectedEvent} />
              )}
            />
          )}

          {!query.isLoading && view === 'day' && (
            <Timeline
              className="plain-calendar-day"
              events={dayEvents}
              date={calendar.selectedDate}
              startHour={6}
              endHour={22}
              renderEvent={(event) => (
                <CalendarTimedEvent event={event} onSelect={setSelectedEvent} />
              )}
            />
          )}

          {!query.isLoading && view === 'agenda' && (
            <AgendaView events={agendaEvents} onSelect={setSelectedEvent} />
          )}

          {!query.isLoading && events.length === 0 && invalidFiles.length === 0 && (
            <div className="calendar-state">No calendar events</div>
          )}
        </div>

        <CalendarDetail event={selectedEvent} invalidFiles={invalidFiles} />
      </div>
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
