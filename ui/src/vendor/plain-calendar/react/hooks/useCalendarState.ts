/**
 * useCalendarState - Core calendar navigation and state management
 * Adapted from useDateManager in PediCalendar
 */

import { useState, useCallback, useMemo } from 'react';
import {
  addDays,
  addMonths,
  startOfDay,
  startOfWeek,
  startOfMonth,
  endOfMonth,
} from '@plain-calendar/core';
import type {
  CalendarView,
  UseCalendarStateReturn,
} from '@plain-calendar/core';

export interface UseCalendarStateOptions {
  /** Initial date (defaults to today) */
  initialDate?: Date;
  /** Calendar view mode */
  view?: CalendarView;
  /** First day of week (0 = Sunday, 1 = Monday) */
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** Number of days to show in day/week view */
  daysToShow?: number;
  /** Callback when date changes */
  onDateChange?: (date: Date) => void;
}

/**
 * Hook for managing calendar navigation state.
 * Provides selected date, view range, and navigation actions.
 */
export function useCalendarState(
  options: UseCalendarStateOptions = {}
): UseCalendarStateReturn {
  const {
    initialDate,
    view = 'week',
    weekStartsOn = 0,
    daysToShow = 7,
    onDateChange,
  } = options;

  const [selectedDate, setSelectedDateInternal] = useState<Date>(() => {
    return initialDate ? startOfDay(initialDate) : startOfDay(new Date());
  });

  const [currentViewingDate, setCurrentViewingDate] = useState<Date>(selectedDate);

  // Calculate view range based on view type
  const { viewStartDate, viewEndDate } = useMemo(() => {
    switch (view) {
      case 'day':
        return {
          viewStartDate: startOfDay(currentViewingDate),
          viewEndDate: addDays(startOfDay(currentViewingDate), 1),
        };
      case 'week':
        const weekStart = startOfWeek(currentViewingDate, weekStartsOn);
        return {
          viewStartDate: weekStart,
          viewEndDate: addDays(weekStart, daysToShow),
        };
      case 'month':
        return {
          viewStartDate: startOfMonth(currentViewingDate),
          viewEndDate: endOfMonth(currentViewingDate),
        };
      case 'agenda':
      default:
        return {
          viewStartDate: startOfDay(currentViewingDate),
          viewEndDate: addDays(startOfDay(currentViewingDate), daysToShow),
        };
    }
  }, [currentViewingDate, view, weekStartsOn, daysToShow]);

  // Wrapped setSelectedDate that also calls onDateChange
  const setSelectedDate = useCallback(
    (date: Date) => {
      const normalized = startOfDay(date);
      setSelectedDateInternal(normalized);
      setCurrentViewingDate(normalized);
      onDateChange?.(normalized);
    },
    [onDateChange]
  );

  // Navigation actions
  const goToToday = useCallback(() => {
    setSelectedDate(new Date());
  }, [setSelectedDate]);

  const goToPrevious = useCallback(() => {
    switch (view) {
      case 'day':
        setSelectedDate(addDays(currentViewingDate, -1));
        break;
      case 'week':
        setSelectedDate(addDays(currentViewingDate, -7));
        break;
      case 'month':
        setSelectedDate(addMonths(currentViewingDate, -1));
        break;
      default:
        setSelectedDate(addDays(currentViewingDate, -daysToShow));
    }
  }, [view, currentViewingDate, daysToShow, setSelectedDate]);

  const goToNext = useCallback(() => {
    switch (view) {
      case 'day':
        setSelectedDate(addDays(currentViewingDate, 1));
        break;
      case 'week':
        setSelectedDate(addDays(currentViewingDate, 7));
        break;
      case 'month':
        setSelectedDate(addMonths(currentViewingDate, 1));
        break;
      default:
        setSelectedDate(addDays(currentViewingDate, daysToShow));
    }
  }, [view, currentViewingDate, daysToShow, setSelectedDate]);

  const goToDate = useCallback(
    (date: Date) => {
      setSelectedDate(date);
    },
    [setSelectedDate]
  );

  return {
    // State
    selectedDate,
    currentViewingDate,
    viewStartDate,
    viewEndDate,
    // Actions
    setSelectedDate,
    goToToday,
    goToPrevious,
    goToNext,
    goToDate,
  };
}

export default useCalendarState;
