/**
 * useGridLines - Generate grid lines for time-based views
 */

import { useMemo } from 'react';
import { formatMinutesToTime } from '@plain-calendar/core';
import type { GridLine } from '@plain-calendar/core';

type GridInterval = 'hour' | 'half-hour' | 'quarter-hour' | '15min' | '30min' | '60min';

interface UseGridLinesOptions {
  /** Start hour (0-23) */
  startHour?: number;
  /** End hour (0-23) */
  endHour?: number;
  /** Interval between grid lines */
  interval?: GridInterval;
  /** Time format for labels */
  format?: '12h' | '24h';
}

function getIntervalMinutes(interval: GridInterval): number {
  switch (interval) {
    case 'quarter-hour':
    case '15min':
      return 15;
    case 'half-hour':
    case '30min':
      return 30;
    case 'hour':
    case '60min':
    default:
      return 60;
  }
}

/**
 * Hook for generating grid lines at specified intervals.
 */
export function useGridLines(options: UseGridLinesOptions = {}): GridLine[] {
  const {
    startHour = 0,
    endHour = 24,
    interval = 'hour',
    format = '12h',
  } = options;

  return useMemo(() => {
    const lines: GridLine[] = [];
    const intervalMinutes = getIntervalMinutes(interval);
    const totalMinutes = (endHour - startHour) * 60;
    const startMinutes = startHour * 60;
    const endMinutes = endHour * 60;

    for (let minutes = startMinutes; minutes < endMinutes; minutes += intervalMinutes) {
      const relativeMinutes = minutes - startMinutes;
      const position = (relativeMinutes / totalMinutes) * 100;
      
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      const time = `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
      
      lines.push({
        time,
        minutes,
        position,
        label: formatMinutesToTime(minutes, format),
      });
    }

    return lines;
  }, [startHour, endHour, interval, format]);
}

export default useGridLines;
