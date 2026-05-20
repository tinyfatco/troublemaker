/**
 * useTimeProportionalLayout - Convert times to Y-positions
 */

import { useCallback, useMemo } from 'react';
import { dateToMinutes } from '@plain-calendar/core';

interface UseTimeProportionalLayoutOptions {
  /** Start hour of the visible range (0-23) */
  startHour?: number;
  /** End hour of the visible range (0-23) */
  endHour?: number;
}

interface TimeProportionalLayout {
  /** Get Y position (percentage) for a time */
  getYPosition: (time: Date | number) => number;
  /** Get height (percentage) for a duration in minutes */
  getHeight: (durationMinutes: number) => number;
  /** Get Y position and height for a time range */
  getPositionAndHeight: (start: Date, end: Date) => { top: number; height: number };
  /** Total minutes in the visible range */
  totalMinutes: number;
  /** Minutes per percent */
  minutesPerPercent: number;
}

/**
 * Hook for converting times to proportional Y-positions in a time-based layout.
 */
export function useTimeProportionalLayout(
  options: UseTimeProportionalLayoutOptions = {}
): TimeProportionalLayout {
  const { startHour = 0, endHour = 24 } = options;

  const { totalMinutes, startMinutes, minutesPerPercent } = useMemo(() => {
    const total = (endHour - startHour) * 60;
    return {
      totalMinutes: total,
      startMinutes: startHour * 60,
      minutesPerPercent: total / 100,
    };
  }, [startHour, endHour]);

  const getYPosition = useCallback(
    (time: Date | number): number => {
      const minutes = typeof time === 'number' ? time : dateToMinutes(time);
      const relativeMinutes = minutes - startMinutes;
      const position = (relativeMinutes / totalMinutes) * 100;
      return Math.max(0, Math.min(100, position));
    },
    [startMinutes, totalMinutes]
  );

  const getHeight = useCallback(
    (durationMinutes: number): number => {
      const height = (durationMinutes / totalMinutes) * 100;
      return Math.max(0, Math.min(100, height));
    },
    [totalMinutes]
  );

  const getPositionAndHeight = useCallback(
    (start: Date, end: Date): { top: number; height: number } => {
      const startMins = dateToMinutes(start);
      const endMins = dateToMinutes(end);
      
      const top = getYPosition(startMins);
      const bottom = getYPosition(endMins);
      const height = bottom - top;

      return {
        top,
        height: Math.max(0.5, height), // Minimum height
      };
    },
    [getYPosition]
  );

  return {
    getYPosition,
    getHeight,
    getPositionAndHeight,
    totalMinutes,
    minutesPerPercent,
  };
}

export default useTimeProportionalLayout;
