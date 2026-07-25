/**
 * useEventLayout - Calculate event positions with overlap handling
 */

import { useMemo } from 'react';
import { dateToMinutes } from '@plain-calendar/core';
import type {
  CalendarEvent,
  PositionedEvent,
  UseEventLayoutReturn,
} from '@plain-calendar/core';

interface EventLayoutOptions {
  /** Start hour of the visible range (0-23) */
  startHour?: number;
  /** End hour of the visible range (0-23) */
  endHour?: number;
}

/**
 * Check if two events overlap in time.
 */
function eventsOverlap(a: CalendarEvent, b: CalendarEvent): boolean {
  return a.start < b.end && a.end > b.start;
}

/**
 * Assign columns to overlapping events using a greedy algorithm.
 * Returns a map of event ID to column index.
 */
function assignColumns<T extends CalendarEvent>(events: T[]): Map<string, { column: number; totalColumns: number }> {
  if (events.length === 0) return new Map();

  // Sort events by start time, then by duration (longer first)
  const sorted = [...events].sort((a, b) => {
    const startDiff = a.start.getTime() - b.start.getTime();
    if (startDiff !== 0) return startDiff;
    // Longer events first (they span more columns typically)
    return (b.end.getTime() - b.start.getTime()) - (a.end.getTime() - a.start.getTime());
  });

  // Track which column each event is assigned to
  const columnAssignments = new Map<string, number>();
  
  // Track the end time of the last event in each column
  const columnEndTimes: Date[] = [];

  for (const event of sorted) {
    // Find the first available column
    let assignedColumn = -1;
    for (let col = 0; col < columnEndTimes.length; col++) {
      if (columnEndTimes[col] <= event.start) {
        assignedColumn = col;
        break;
      }
    }

    // If no column is available, create a new one
    if (assignedColumn === -1) {
      assignedColumn = columnEndTimes.length;
      columnEndTimes.push(event.end);
    } else {
      columnEndTimes[assignedColumn] = event.end;
    }

    columnAssignments.set(event.id, assignedColumn);
  }

  // Now determine totalColumns for each event based on its overlap group
  const result = new Map<string, { column: number; totalColumns: number }>();
  
  // Group events that overlap with each other
  for (const event of sorted) {
    const column = columnAssignments.get(event.id)!;
    
    // Find all events that overlap with this one
    const overlapping = sorted.filter(other => eventsOverlap(event, other));
    
    // The total columns for this event is the max column + 1 among overlapping events
    const maxColumn = Math.max(...overlapping.map(e => columnAssignments.get(e.id)!));
    const totalColumns = maxColumn + 1;
    
    result.set(event.id, { column, totalColumns });
  }

  return result;
}

/**
 * Hook for calculating event positions in a time-based layout.
 * Handles overlapping events by assigning them to columns.
 */
export function useEventLayout<T extends CalendarEvent = CalendarEvent>(
  events: T[],
  options: EventLayoutOptions = {}
): UseEventLayoutReturn<T> {
  const { startHour = 0, endHour = 24 } = options;

  const positionedEvents = useMemo(() => {
    // Filter out all-day events (they're handled separately)
    const timedEvents = events.filter(e => !e.allDay);
    
    if (timedEvents.length === 0) return [];

    const totalMinutes = (endHour - startHour) * 60;
    const startMinutes = startHour * 60;

    // Assign columns to overlapping events
    const columnInfo = assignColumns(timedEvents);

    return timedEvents.map((event): PositionedEvent<T> => {
      const eventStartMinutes = dateToMinutes(event.start);
      const eventEndMinutes = dateToMinutes(event.end);

      // Calculate position as percentage
      const top = ((eventStartMinutes - startMinutes) / totalMinutes) * 100;
      const height = ((eventEndMinutes - eventStartMinutes) / totalMinutes) * 100;

      const { column, totalColumns } = columnInfo.get(event.id) || { column: 0, totalColumns: 1 };

      return {
        event,
        column,
        totalColumns,
        top: Math.max(0, Math.min(100, top)),
        height: Math.max(0.5, Math.min(100 - top, height)), // Minimum height of 0.5%
      };
    });
  }, [events, startHour, endHour]);

  const hasOverlaps = useMemo(() => {
    return positionedEvents.some(pe => pe.totalColumns > 1);
  }, [positionedEvents]);

  return {
    positionedEvents,
    hasOverlaps,
  };
}

export default useEventLayout;
