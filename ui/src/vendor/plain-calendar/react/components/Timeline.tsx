/**
 * Timeline - Headless day timeline view component
 */

import React from 'react';
import type { CalendarEvent, PositionedEvent, GridLine, TimeAxisLabel } from '@plain-calendar/core';
import { useEventLayout } from '../hooks/useEventLayout';
import { useTimeAxis } from '../hooks/useTimeAxis';
import { useGridLines } from '../hooks/useGridLines';
import { useCurrentTimeIndicator } from '../hooks/useCurrentTimeIndicator';

export interface TimelineProps<T extends CalendarEvent = CalendarEvent> {
  /** Events to display */
  events: T[];
  /** Date being displayed */
  date: Date;
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
  /** Render prop for time axis */
  renderTimeAxis?: (labels: TimeAxisLabel[]) => React.ReactNode;
  /** Render prop for grid lines */
  renderGridLines?: (lines: GridLine[]) => React.ReactNode;
  /** Render prop for current time indicator */
  renderCurrentTime?: (position: number) => React.ReactNode;
  /** Render prop for events */
  renderEvent?: (event: PositionedEvent<T>) => React.ReactNode;
  /** Render prop for entire events container */
  renderEvents?: (events: PositionedEvent<T>[]) => React.ReactNode;
}

/**
 * Default time axis renderer
 */
function DefaultTimeAxis({ labels }: { labels: TimeAxisLabel[] }): React.ReactElement {
  return (
    <div style={{ position: 'relative', width: '60px', flexShrink: 0 }}>
      {labels.map((label) => (
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
  );
}

/**
 * Default grid lines renderer
 */
function DefaultGridLines({ lines }: { lines: GridLine[] }): React.ReactElement {
  return (
    <>
      {lines.map((line) => (
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
      ))}
    </>
  );
}

/**
 * Default current time indicator
 */
function DefaultCurrentTime({ position }: { position: number }): React.ReactElement {
  return (
    <div
      style={{
        position: 'absolute',
        top: `${position}%`,
        left: 0,
        right: 0,
        borderTop: '2px solid #ef4444',
        zIndex: 10,
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: '-4px',
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          backgroundColor: '#ef4444',
        }}
      />
    </div>
  );
}

/**
 * Default event renderer
 */
function DefaultEvent<T extends CalendarEvent>({
  event,
}: {
  event: PositionedEvent<T>;
}): React.ReactElement {
  const width = 100 / event.totalColumns;
  const left = event.column * width;

  return (
    <div
      style={{
        position: 'absolute',
        top: `${event.top}%`,
        height: `${event.height}%`,
        left: `${left}%`,
        width: `${width}%`,
        backgroundColor: event.event.color || '#3b82f6',
        borderRadius: '4px',
        padding: '4px',
        fontSize: '12px',
        color: 'white',
        overflow: 'hidden',
        boxSizing: 'border-box',
      }}
    >
      {event.event.title}
    </div>
  );
}

/**
 * Headless timeline component for day view.
 * Provides structure and logic - you can override any rendering.
 */
export function Timeline<T extends CalendarEvent = CalendarEvent>({
  events,
  date,
  startHour = 6,
  endHour = 22,
  timeFormat = '12h',
  showCurrentTime = true,
  className,
  style,
  renderTimeAxis,
  renderGridLines,
  renderCurrentTime,
  renderEvent,
  renderEvents,
}: TimelineProps<T>): React.ReactElement {
  const { positionedEvents } = useEventLayout(events, { startHour, endHour });
  const timeLabels = useTimeAxis({ startHour, endHour, format: timeFormat });
  const gridLines = useGridLines({ startHour, endHour });
  const currentTime = useCurrentTimeIndicator({ startHour, endHour, date });

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    height: '100%',
    ...style,
  };

  const contentStyle: React.CSSProperties = {
    position: 'relative',
    flex: 1,
    overflow: 'hidden',
  };

  return (
    <div className={className} style={containerStyle}>
      {/* Time axis */}
      {renderTimeAxis ? (
        renderTimeAxis(timeLabels)
      ) : (
        <DefaultTimeAxis labels={timeLabels} />
      )}

      {/* Main content area */}
      <div style={contentStyle}>
        {/* Grid lines */}
        {renderGridLines ? (
          renderGridLines(gridLines)
        ) : (
          <DefaultGridLines lines={gridLines} />
        )}

        {/* Events */}
        {renderEvents ? (
          renderEvents(positionedEvents)
        ) : (
          positionedEvents.map((pe) =>
            renderEvent ? (
              <React.Fragment key={pe.event.id}>{renderEvent(pe)}</React.Fragment>
            ) : (
              <DefaultEvent key={pe.event.id} event={pe} />
            )
          )
        )}

        {/* Current time indicator */}
        {showCurrentTime && currentTime.visible && (
          renderCurrentTime ? (
            renderCurrentTime(currentTime.position)
          ) : (
            <DefaultCurrentTime position={currentTime.position} />
          )
        )}
      </div>
    </div>
  );
}

export default Timeline;
