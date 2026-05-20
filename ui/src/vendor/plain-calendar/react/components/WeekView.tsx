/**
 * WeekView - Headless week view component
 */

import React from 'react';
import type { CalendarEvent, PositionedEvent, GridLine, TimeAxisLabel } from '@plain-calendar/core';
import { getWeekDates, getWeekdayName, toDateString, isToday } from '@plain-calendar/core';
import { useEventsMap, getEventsForDate } from '../hooks/useEventsMap';
import { useEventLayout } from '../hooks/useEventLayout';
import { useTimeAxis } from '../hooks/useTimeAxis';
import { useGridLines } from '../hooks/useGridLines';
import { useCurrentTimeIndicator } from '../hooks/useCurrentTimeIndicator';

export interface WeekViewProps<T extends CalendarEvent = CalendarEvent> {
  /** Events to display */
  events: T[];
  /** Start date of the week */
  weekStart: Date;
  /** Start hour (0-23) */
  startHour?: number;
  /** End hour (0-23) */
  endHour?: number;
  /** Time format */
  timeFormat?: '12h' | '24h';
  /** Show current time indicator */
  showCurrentTime?: boolean;
  /** Container class name */
  className?: string;
  /** Container style */
  style?: React.CSSProperties;
  /** Render prop for day header */
  renderDayHeader?: (date: Date, isToday: boolean) => React.ReactNode;
  /** Render prop for time axis */
  renderTimeAxis?: (labels: TimeAxisLabel[]) => React.ReactNode;
  /** Render prop for grid lines */
  renderGridLines?: (lines: GridLine[]) => React.ReactNode;
  /** Render prop for events in a day */
  renderDayEvents?: (events: PositionedEvent<T>[], date: Date) => React.ReactNode;
  /** Render prop for single event */
  renderEvent?: (event: PositionedEvent<T>) => React.ReactNode;
  /** Render prop for current time indicator */
  renderCurrentTime?: (position: number, dayIndex: number) => React.ReactNode;
}

interface DayColumnProps<T extends CalendarEvent> {
  events: T[];
  date: Date;
  startHour: number;
  endHour: number;
  showCurrentTime: boolean;
  renderEvent?: (event: PositionedEvent<T>) => React.ReactNode;
  renderCurrentTime?: (position: number, dayIndex: number) => React.ReactNode;
  dayIndex: number;
}

function DayColumn<T extends CalendarEvent>({
  events,
  date,
  startHour,
  endHour,
  showCurrentTime,
  renderEvent,
  renderCurrentTime,
  dayIndex,
}: DayColumnProps<T>): React.ReactElement {
  const { positionedEvents } = useEventLayout(events, { startHour, endHour });
  const currentTime = useCurrentTimeIndicator({ startHour, endHour, date });

  return (
    <div style={{ position: 'relative', flex: 1, borderLeft: '1px solid #e5e5e5' }}>
      {positionedEvents.map((pe) => {
        if (renderEvent) {
          return <React.Fragment key={pe.event.id}>{renderEvent(pe)}</React.Fragment>;
        }

        const width = 100 / pe.totalColumns;
        const left = pe.column * width;

        return (
          <div
            key={pe.event.id}
            style={{
              position: 'absolute',
              top: `${pe.top}%`,
              height: `${pe.height}%`,
              left: `${left}%`,
              width: `${width}%`,
              backgroundColor: pe.event.color || '#3b82f6',
              borderRadius: '4px',
              padding: '2px 4px',
              fontSize: '11px',
              color: 'white',
              overflow: 'hidden',
              boxSizing: 'border-box',
            }}
          >
            {pe.event.title}
          </div>
        );
      })}

      {showCurrentTime && currentTime.visible && (
        renderCurrentTime ? (
          renderCurrentTime(currentTime.position, dayIndex)
        ) : (
          <div
            style={{
              position: 'absolute',
              top: `${currentTime.position}%`,
              left: 0,
              right: 0,
              borderTop: '2px solid #ef4444',
              zIndex: 10,
            }}
          />
        )
      )}
    </div>
  );
}

/**
 * Headless week view component.
 * Displays a 7-day week with time-based event layout.
 */
export function WeekView<T extends CalendarEvent = CalendarEvent>({
  events,
  weekStart,
  startHour = 6,
  endHour = 22,
  timeFormat = '12h',
  showCurrentTime = true,
  className,
  style,
  renderDayHeader,
  renderTimeAxis,
  renderGridLines,
  renderEvent,
  renderCurrentTime,
}: WeekViewProps<T>): React.ReactElement {
  const weekDates = getWeekDates(weekStart);
  const eventsMap = useEventsMap(events);
  const timeLabels = useTimeAxis({ startHour, endHour, format: timeFormat });
  const gridLines = useGridLines({ startHour, endHour });

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    ...style,
  };

  return (
    <div className={className} style={containerStyle}>
      {/* Header row with day names */}
      <div style={{ display: 'flex', borderBottom: '1px solid #e5e5e5' }}>
        {/* Time axis spacer */}
        <div style={{ width: '60px', flexShrink: 0 }} />
        
        {/* Day headers */}
        {weekDates.map((date) => {
          const today = isToday(date);
          
          return (
            <div
              key={toDateString(date)}
              style={{
                flex: 1,
                textAlign: 'center',
                padding: '8px',
                borderLeft: '1px solid #e5e5e5',
                fontWeight: today ? 'bold' : 'normal',
              }}
            >
              {renderDayHeader ? (
                renderDayHeader(date, today)
              ) : (
                <>
                  <div style={{ fontSize: '12px' }}>{getWeekdayName(date, 'short')}</div>
                  <div style={{ 
                    fontSize: '20px',
                    ...(today ? {
                      backgroundColor: '#3b82f6',
                      color: 'white',
                      borderRadius: '50%',
                      width: '32px',
                      height: '32px',
                      lineHeight: '32px',
                      margin: '0 auto',
                    } : {})
                  }}>
                    {date.getDate()}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* Content area */}
      <div style={{ display: 'flex', flex: 1, overflow: 'auto' }}>
        {/* Time axis */}
        {renderTimeAxis ? (
          renderTimeAxis(timeLabels)
        ) : (
          <div style={{ position: 'relative', width: '60px', flexShrink: 0 }}>
            {timeLabels.map((label) => (
              <div
                key={label.hour}
                style={{
                  position: 'absolute',
                  top: `${label.position}%`,
                  right: '8px',
                  fontSize: '12px',
                  transform: 'translateY(-50%)',
                }}
              >
                {label.label}
              </div>
            ))}
          </div>
        )}

        {/* Day columns */}
        <div style={{ display: 'flex', flex: 1, position: 'relative' }}>
          {/* Grid lines (behind all columns) */}
          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
            {renderGridLines ? (
              renderGridLines(gridLines)
            ) : (
              gridLines.map((line) => (
                <div
                  key={line.minutes}
                  style={{
                    position: 'absolute',
                    top: `${line.position}%`,
                    left: 0,
                    right: 0,
                    borderTop: '1px solid #e5e5e5',
                  }}
                />
              ))
            )}
          </div>

          {/* Day columns */}
          {weekDates.map((date, dayIndex) => (
            <DayColumn
              key={toDateString(date)}
              events={getEventsForDate(eventsMap, date)}
              date={date}
              startHour={startHour}
              endHour={endHour}
              showCurrentTime={showCurrentTime}
              renderEvent={renderEvent}
              renderCurrentTime={renderCurrentTime}
              dayIndex={dayIndex}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default WeekView;
