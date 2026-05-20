/**
 * useEventsMap - Group events by date for efficient lookup
 */

import { useMemo } from 'react';
import { toDateString, isSameDay, addDays } from '@plain-calendar/core';
import type { CalendarEvent, EventsByDate } from '@plain-calendar/core';

/**
 * Hook for grouping events by date string key.
 * Handles multi-day events by adding them to each day they span.
 */
export function useEventsMap<T extends CalendarEvent = CalendarEvent>(
  events: T[]
): EventsByDate<T> {
  return useMemo(() => {
    const map: EventsByDate<T> = new Map();

    for (const event of events) {
      // For all-day or multi-day events, add to each day
      if (event.allDay || !isSameDay(event.start, event.end)) {
        let current = new Date(event.start);
        const endDate = new Date(event.end);
        
        // Iterate through each day the event spans
        while (current <= endDate) {
          const key = toDateString(current);
          const existing = map.get(key) || [];
          existing.push(event);
          map.set(key, existing);
          current = addDays(current, 1);
        }
      } else {
        // Single-day event
        const key = toDateString(event.start);
        const existing = map.get(key) || [];
        existing.push(event);
        map.set(key, existing);
      }
    }

    // Sort events within each day by start time
    for (const [key, dayEvents] of map) {
      dayEvents.sort((a, b) => a.start.getTime() - b.start.getTime());
      map.set(key, dayEvents);
    }

    return map;
  }, [events]);
}

/**
 * Get events for a specific date from the events map.
 */
export function getEventsForDate<T extends CalendarEvent = CalendarEvent>(
  eventsMap: EventsByDate<T>,
  date: Date
): T[] {
  return eventsMap.get(toDateString(date)) || [];
}

/**
 * Get events for a date range from the events map.
 */
export function getEventsForRange<T extends CalendarEvent = CalendarEvent>(
  eventsMap: EventsByDate<T>,
  startDate: Date,
  endDate: Date
): T[] {
  const result: T[] = [];
  const seen = new Set<string>();
  
  let current = new Date(startDate);
  while (current <= endDate) {
    const dayEvents = eventsMap.get(toDateString(current)) || [];
    for (const event of dayEvents) {
      if (!seen.has(event.id)) {
        seen.add(event.id);
        result.push(event);
      }
    }
    current = addDays(current, 1);
  }

  return result.sort((a, b) => a.start.getTime() - b.start.getTime());
}

export default useEventsMap;
