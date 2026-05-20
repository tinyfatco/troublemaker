/**
 * Calendar - Headless month view calendar component
 */

import React from 'react';
import type { CalendarEvent } from '@plain-calendar/core';
import {
  getMonthCalendarDates,
  getMonthName,
  getWeekdayName,
  toDateString,
  isSameMonth,
  isToday,
} from '@plain-calendar/core';
import { useEventsMap, getEventsForDate } from '../hooks/useEventsMap';

export interface CalendarProps<T extends CalendarEvent = CalendarEvent> {
  /** Events to display */
  events: T[];
  /** Month to display (any date in that month) */
  month: Date;
  /** First day of week (0 = Sunday, 1 = Monday) */
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** Container class name */
  className?: string;
  /** Container style */
  style?: React.CSSProperties;
  /** Click handler for dates */
  onDateClick?: (date: Date) => void;
  /** Click handler for events */
  onEventClick?: (event: T) => void;
  /** Render prop for header */
  renderHeader?: (month: Date) => React.ReactNode;
  /** Render prop for weekday headers */
  renderWeekdayHeader?: (weekday: string, index: number) => React.ReactNode;
  /** Render prop for day cell */
  renderDay?: (date: Date, events: T[], isCurrentMonth: boolean, isToday: boolean) => React.ReactNode;
  /** Render prop for event in day cell */
  renderEvent?: (event: T) => React.ReactNode;
  /** Maximum events to show per day (others collapsed) */
  maxEventsPerDay?: number;
}

/**
 * Headless month calendar component.
 * Displays a month grid with events.
 */
export function Calendar<T extends CalendarEvent = CalendarEvent>({
  events,
  month,
  weekStartsOn = 0,
  className,
  style,
  onDateClick,
  onEventClick,
  renderHeader,
  renderWeekdayHeader,
  renderDay,
  renderEvent,
  maxEventsPerDay = 3,
}: CalendarProps<T>): React.ReactElement {
  const calendarDates = getMonthCalendarDates(month, weekStartsOn);
  const eventsMap = useEventsMap(events);

  // Generate weekday headers
  const weekdays: string[] = [];
  for (let i = 0; i < 7; i++) {
    const dayIndex = (weekStartsOn + i) % 7;
    const date = new Date(2024, 0, dayIndex); // Jan 2024 starts on Monday
    // Find the correct day
    while (date.getDay() !== dayIndex) {
      date.setDate(date.getDate() + 1);
    }
    weekdays.push(getWeekdayName(date, 'short'));
  }

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    ...style,
  };

  const gridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(7, 1fr)',
    gap: '1px',
    backgroundColor: '#e5e5e5',
  };

  return (
    <div className={className} style={containerStyle}>
      {/* Header */}
      {renderHeader ? (
        renderHeader(month)
      ) : (
        <div style={{ textAlign: 'center', padding: '16px', fontWeight: 'bold', fontSize: '18px' }}>
          {getMonthName(month)} {month.getFullYear()}
        </div>
      )}

      {/* Weekday headers */}
      <div style={gridStyle}>
        {weekdays.map((weekday, index) =>
          renderWeekdayHeader ? (
            <React.Fragment key={weekday}>{renderWeekdayHeader(weekday, index)}</React.Fragment>
          ) : (
            <div
              key={weekday}
              style={{
                backgroundColor: 'white',
                padding: '8px',
                textAlign: 'center',
                fontSize: '12px',
                fontWeight: '500',
              }}
            >
              {weekday}
            </div>
          )
        )}
      </div>

      {/* Calendar grid */}
      <div style={gridStyle}>
        {calendarDates.map((date) => {
          const dateKey = toDateString(date);
          const dayEvents = getEventsForDate(eventsMap, date);
          const isCurrentMonth = isSameMonth(date, month);
          const todayFlag = isToday(date);
          const displayEvents = dayEvents.slice(0, maxEventsPerDay);
          const moreCount = dayEvents.length - maxEventsPerDay;

          if (renderDay) {
            return (
              <React.Fragment key={dateKey}>
                {renderDay(date, dayEvents, isCurrentMonth, todayFlag)}
              </React.Fragment>
            );
          }

          return (
            <div
              key={dateKey}
              onClick={() => onDateClick?.(date)}
              style={{
                backgroundColor: 'white',
                minHeight: '80px',
                padding: '4px',
                opacity: isCurrentMonth ? 1 : 0.5,
                cursor: onDateClick ? 'pointer' : 'default',
              }}
            >
              {/* Day number */}
              <div
                style={{
                  fontSize: '14px',
                  fontWeight: todayFlag ? 'bold' : 'normal',
                  marginBottom: '4px',
                  ...(todayFlag
                    ? {
                        backgroundColor: '#3b82f6',
                        color: 'white',
                        borderRadius: '50%',
                        width: '24px',
                        height: '24px',
                        lineHeight: '24px',
                        textAlign: 'center',
                      }
                    : {}),
                }}
              >
                {date.getDate()}
              </div>

              {/* Events */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {displayEvents.map((event) =>
                  renderEvent ? (
                    <React.Fragment key={event.id}>{renderEvent(event)}</React.Fragment>
                  ) : (
                    <div
                      key={event.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        onEventClick?.(event);
                      }}
                      style={{
                        backgroundColor: event.color || '#3b82f6',
                        color: 'white',
                        fontSize: '11px',
                        padding: '2px 4px',
                        borderRadius: '2px',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        cursor: onEventClick ? 'pointer' : 'default',
                      }}
                    >
                      {event.title}
                    </div>
                  )
                )}
                {moreCount > 0 && (
                  <div style={{ fontSize: '11px', color: '#666' }}>
                    +{moreCount} more
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default Calendar;
