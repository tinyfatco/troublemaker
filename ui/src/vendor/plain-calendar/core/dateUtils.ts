/**
 * Date manipulation and formatting utilities
 * Extracted from PediCalendar (pedicab512)
 */

// ============================================================================
// Date Manipulation
// ============================================================================

/**
 * Adds days to a date.
 * @param date The starting date
 * @param days Number of days to add (can be negative)
 * @returns New date with days added
 */
export const addDays = (date: Date, days: number): Date => {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
};

/**
 * Adds months to a date.
 * @param date The starting date
 * @param months Number of months to add (can be negative)
 * @returns New date with months added
 */
export const addMonths = (date: Date, months: number): Date => {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
};

/**
 * Gets start of day (midnight) for a date.
 * @param date The date
 * @returns New date at 00:00:00.000
 */
export const startOfDay = (date: Date): Date => {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
};

/**
 * Gets end of day (23:59:59.999) for a date.
 * @param date The date
 * @returns New date at 23:59:59.999
 */
export const endOfDay = (date: Date): Date => {
  const result = new Date(date);
  result.setHours(23, 59, 59, 999);
  return result;
};

/**
 * Gets the start of the week containing the given date.
 * @param date The date
 * @param weekStartsOn Day the week starts on (0 = Sunday, 1 = Monday)
 * @returns Start of week
 */
export const startOfWeek = (date: Date, weekStartsOn: number = 0): Date => {
  const result = startOfDay(date);
  const day = result.getDay();
  const diff = (day - weekStartsOn + 7) % 7;
  result.setDate(result.getDate() - diff);
  return result;
};

/**
 * Gets the start of the month containing the given date.
 * @param date The date
 * @returns First day of month at midnight
 */
export const startOfMonth = (date: Date): Date => {
  const result = new Date(date);
  result.setDate(1);
  result.setHours(0, 0, 0, 0);
  return result;
};

/**
 * Gets the end of the month containing the given date.
 * @param date The date
 * @returns Last day of month at 23:59:59.999
 */
export const endOfMonth = (date: Date): Date => {
  const result = new Date(date);
  result.setMonth(result.getMonth() + 1);
  result.setDate(0);
  result.setHours(23, 59, 59, 999);
  return result;
};

// ============================================================================
// Date Comparison
// ============================================================================

/**
 * Checks if two dates are the same calendar day.
 * @param date1 First date
 * @param date2 Second date
 * @returns true if same day
 */
export const isSameDay = (date1: Date, date2: Date): boolean => {
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate()
  );
};

/**
 * Checks if two dates are in the same month.
 * @param date1 First date
 * @param date2 Second date
 * @returns true if same month
 */
export const isSameMonth = (date1: Date, date2: Date): boolean => {
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth()
  );
};

/**
 * Checks if a date is today.
 * @param date The date to check
 * @returns true if today
 */
export const isToday = (date: Date): boolean => {
  return isSameDay(date, new Date());
};

/**
 * Checks if a date is in the past.
 * @param date The date to check
 * @returns true if before today
 */
export const isPast = (date: Date): boolean => {
  const today = startOfDay(new Date());
  return date < today;
};

/**
 * Checks if a date is in the future.
 * @param date The date to check
 * @returns true if after today
 */
export const isFuture = (date: Date): boolean => {
  const today = endOfDay(new Date());
  return date > today;
};

/**
 * Checks if a date is a weekend.
 * @param date The date to check
 * @returns true if Saturday or Sunday
 */
export const isWeekend = (date: Date): boolean => {
  const day = date.getDay();
  return day === 0 || day === 6;
};

// ============================================================================
// Date Formatting
// ============================================================================

/**
 * Formats a date as YYYY-MM-DD string (for use as map keys).
 * @param date The date
 * @returns Date string in YYYY-MM-DD format
 */
export const toDateString = (date: Date): string => {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * Parses a YYYY-MM-DD string to a Date.
 * @param dateStr The date string
 * @returns Date object or null if invalid
 */
export const fromDateString = (dateStr: string): Date | null => {
  if (!dateStr) return null;
  try {
    const [year, month, day] = dateStr.split('-').map(Number);
    const date = new Date(year, month - 1, day, 12, 0, 0);
    if (isNaN(date.getTime())) return null;
    return date;
  } catch {
    return null;
  }
};

/**
 * Formats a scheduled time with relative date context.
 * @param scheduledTime The date/time
 * @returns Formatted string like "Today at 2:30 PM" or "Dec 15 at 2:30 PM"
 */
export const formatScheduledTime = (scheduledTime: Date | string): string => {
  const date =
    typeof scheduledTime === 'string' ? new Date(scheduledTime) : scheduledTime;

  const today = new Date();
  const tomorrow = addDays(today, 1);

  const timeStr = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  if (isSameDay(date, today)) {
    return `Today at ${timeStr}`;
  } else if (isSameDay(date, tomorrow)) {
    return `Tomorrow at ${timeStr}`;
  } else {
    const dateStr = date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
    return `${dateStr} at ${timeStr}`;
  }
};

/**
 * Formats a date/time with full context.
 * @param scheduledTime The date/time
 * @returns Formatted string like "Monday, December 15, 2024 at 2:30 PM"
 */
export const formatFullDateTime = (scheduledTime: Date | string): string => {
  const date =
    typeof scheduledTime === 'string' ? new Date(scheduledTime) : scheduledTime;

  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
};

/**
 * Formats a date for display (without time).
 * @param date The date
 * @param options Formatting options
 * @returns Formatted date string
 */
export const formatDate = (
  date: Date,
  options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }
): string => {
  return date.toLocaleDateString('en-US', options);
};

/**
 * Gets the weekday name for a date.
 * @param date The date
 * @param format 'long' | 'short' | 'narrow'
 * @returns Weekday name
 */
export const getWeekdayName = (
  date: Date,
  format: 'long' | 'short' | 'narrow' = 'long'
): string => {
  return date.toLocaleDateString('en-US', { weekday: format });
};

/**
 * Gets the month name for a date.
 * @param date The date
 * @param format 'long' | 'short' | 'narrow'
 * @returns Month name
 */
export const getMonthName = (
  date: Date,
  format: 'long' | 'short' | 'narrow' = 'long'
): string => {
  return date.toLocaleDateString('en-US', { month: format });
};

// ============================================================================
// Date Ranges
// ============================================================================

/**
 * Gets an array of dates for a week.
 * @param startDate Start of the week
 * @returns Array of 7 dates
 */
export const getWeekDates = (startDate: Date): Date[] => {
  return Array.from({ length: 7 }, (_, i) => addDays(startDate, i));
};

/**
 * Gets all dates in a month (including leading/trailing days for full weeks).
 * @param date Any date in the target month
 * @param weekStartsOn Day the week starts on (0 = Sunday)
 * @returns Array of dates for calendar grid
 */
export const getMonthCalendarDates = (
  date: Date,
  weekStartsOn: number = 0
): Date[] => {
  const monthStart = startOfMonth(date);
  const monthEnd = endOfMonth(date);
  const calendarStart = startOfWeek(monthStart, weekStartsOn);

  const dates: Date[] = [];
  let current = calendarStart;

  // Generate 6 weeks (42 days) to cover all possible month layouts
  for (let i = 0; i < 42; i++) {
    dates.push(current);
    current = addDays(current, 1);

    // Stop if we've passed the month end and completed the week
    if (current > monthEnd && current.getDay() === weekStartsOn && i >= 28) {
      break;
    }
  }

  return dates;
};

/**
 * Gets the number of days between two dates.
 * @param start Start date
 * @param end End date
 * @returns Number of days (can be negative)
 */
export const daysBetween = (start: Date, end: Date): number => {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((end.getTime() - start.getTime()) / msPerDay);
};
