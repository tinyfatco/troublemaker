/**
 * useTimeAxis - Generate time axis labels for day/week views
 */

import { useMemo } from 'react';
import { formatHourLabel, formatHourLabel24 } from '@plain-calendar/core';
import type { TimeAxisLabel } from '@plain-calendar/core';

interface UseTimeAxisOptions {
  /** Start hour (0-23) */
  startHour?: number;
  /** End hour (0-23) */
  endHour?: number;
  /** Interval in hours between labels */
  interval?: number;
  /** Time format */
  format?: '12h' | '24h';
}

/**
 * Hook for generating time axis labels.
 */
export function useTimeAxis(options: UseTimeAxisOptions = {}): TimeAxisLabel[] {
  const {
    startHour = 0,
    endHour = 24,
    interval = 1,
    format = '12h',
  } = options;

  return useMemo(() => {
    const labels: TimeAxisLabel[] = [];
    const totalHours = endHour - startHour;

    for (let hour = startHour; hour < endHour; hour += interval) {
      const relativeHour = hour - startHour;
      const position = (relativeHour / totalHours) * 100;
      
      labels.push({
        hour,
        label: format === '12h' ? formatHourLabel(hour) : formatHourLabel24(hour),
        position,
      });
    }

    return labels;
  }, [startHour, endHour, interval, format]);
}

export default useTimeAxis;
