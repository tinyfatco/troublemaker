/**
 * useCurrentTimeIndicator - Track current time position for "now" line
 */

import { useState, useEffect, useMemo } from 'react';
import { dateToMinutes, isSameDay } from '@plain-calendar/core';
import type { UseCurrentTimeIndicatorReturn } from '@plain-calendar/core';

interface UseCurrentTimeIndicatorOptions {
  /** Start hour of the visible range (0-23) */
  startHour?: number;
  /** End hour of the visible range (0-23) */
  endHour?: number;
  /** Update interval in milliseconds */
  updateInterval?: number;
  /** Date to show indicator for (only visible if today) */
  date?: Date;
  /** Whether the indicator is enabled */
  enabled?: boolean;
}

/**
 * Hook for tracking the current time indicator position.
 * Updates at the specified interval and only shows when viewing today.
 */
export function useCurrentTimeIndicator(
  options: UseCurrentTimeIndicatorOptions = {}
): UseCurrentTimeIndicatorReturn {
  const {
    startHour = 0,
    endHour = 24,
    updateInterval = 60000, // 1 minute default
    date,
    enabled = true,
  } = options;

  const [currentTime, setCurrentTime] = useState(() => new Date());

  // Update current time at interval
  useEffect(() => {
    if (!enabled) return;

    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, updateInterval);

    return () => clearInterval(timer);
  }, [updateInterval, enabled]);

  const { position, visible } = useMemo(() => {
    // Only visible if viewing today (or no date specified)
    const isViewingToday = date ? isSameDay(date, currentTime) : true;
    
    if (!enabled || !isViewingToday) {
      return { position: 0, visible: false };
    }

    const currentMinutes = dateToMinutes(currentTime);
    const startMinutes = startHour * 60;
    const endMinutes = endHour * 60;

    // Check if current time is within the visible range
    if (currentMinutes < startMinutes || currentMinutes > endMinutes) {
      return { position: 0, visible: false };
    }

    const totalMinutes = endMinutes - startMinutes;
    const relativeMinutes = currentMinutes - startMinutes;
    const pos = (relativeMinutes / totalMinutes) * 100;

    return { position: pos, visible: true };
  }, [currentTime, startHour, endHour, date, enabled]);

  return {
    position,
    visible,
    currentTime,
  };
}

export default useCurrentTimeIndicator;
