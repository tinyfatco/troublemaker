/**
 * useTimeRange - Calculate visible time range for day/week views
 */

import { useMemo } from 'react';
import { dateToMinutes, minutesToDate } from '@plain-calendar/core';
import type { CalendarEvent, UseTimeRangeReturn, TimeRangeOptions } from '@plain-calendar/core';

const DEFAULT_START_HOUR = 6; // 6 AM
const DEFAULT_END_HOUR = 22; // 10 PM
const MINUTES_PER_HOUR = 60;

/**
 * Hook for calculating the visible time range in day/week views.
 * Can automatically expand to fit events outside the default range.
 */
export function useTimeRange<T extends CalendarEvent = CalendarEvent>(
  events: T[] = [],
  options: TimeRangeOptions = {}
): UseTimeRangeReturn {
  const {
    defaultStartHour = DEFAULT_START_HOUR,
    defaultEndHour = DEFAULT_END_HOUR,
    expandToFitEvents = true,
  } = options;

  const { startHour, endHour } = useMemo(() => {
    let start = defaultStartHour;
    let end = defaultEndHour;

    if (expandToFitEvents && events.length > 0) {
      for (const event of events) {
        if (event.allDay) continue;

        const eventStartMinutes = dateToMinutes(event.start);
        const eventEndMinutes = dateToMinutes(event.end);

        const eventStartHour = Math.floor(eventStartMinutes / MINUTES_PER_HOUR);
        const eventEndHour = Math.ceil(eventEndMinutes / MINUTES_PER_HOUR);

        if (eventStartHour < start) {
          start = eventStartHour;
        }
        if (eventEndHour > end) {
          end = Math.min(eventEndHour, 24);
        }
      }
    }

    return { startHour: start, endHour: end };
  }, [events, defaultStartHour, defaultEndHour, expandToFitEvents]);

  const totalMinutes = (endHour - startHour) * MINUTES_PER_HOUR;

  /**
   * Get the percentage position (0-100) for a given time.
   */
  const getPositionForTime = (date: Date): number => {
    const minutes = dateToMinutes(date);
    const startMinutes = startHour * MINUTES_PER_HOUR;
    const relativeMinutes = minutes - startMinutes;
    return (relativeMinutes / totalMinutes) * 100;
  };

  /**
   * Get the time for a given percentage position (0-100).
   */
  const getTimeForPosition = (position: number): Date => {
    const startMinutes = startHour * MINUTES_PER_HOUR;
    const relativeMinutes = (position / 100) * totalMinutes;
    const totalMinutesFromMidnight = startMinutes + relativeMinutes;
    return minutesToDate(totalMinutesFromMidnight);
  };

  return {
    startHour,
    endHour,
    totalMinutes,
    getPositionForTime,
    getTimeForPosition,
  };
}

export default useTimeRange;
