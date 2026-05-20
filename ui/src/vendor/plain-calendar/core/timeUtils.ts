/**
 * Time parsing and formatting utilities
 * Extracted from PediCalendar (pedicab512)
 */

/**
 * Parses HH:MM:SS or HH:MM into total minutes from midnight.
 * @param timeStr The time string to parse.
 * @returns Total minutes from midnight, or 0 if parsing fails.
 */
export const parseTimeToMinutes = (timeStr: string | undefined): number => {
  if (!timeStr) return 0;
  try {
    if (timeStr.includes(':')) {
      const parts = timeStr.split(':').map(Number);
      if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        return parts[0] * 60 + parts[1];
      }
    }
    console.warn('Could not parse time string:', timeStr);
    return 0;
  } catch (e) {
    console.error('Error parsing time string:', timeStr, e);
    return 0;
  }
};

/**
 * Parses various time formats (HH:MM:SS, HH:MM, H:MM AM/PM) into minutes from midnight.
 * @param timeStr The event time string to parse.
 * @returns Total minutes from midnight, or null if parsing fails.
 */
export const parseEventTimeToMinutes = (timeStr: string | undefined): number | null => {
  if (!timeStr) return null;
  try {
    // Try HH:MM:SS or HH:MM first (24-hour format)
    if (timeStr.includes(':') && !/[aApP][mM]/.test(timeStr)) {
      const parts = timeStr.split(':').map(Number);
      if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        if (parts[0] >= 0 && parts[0] <= 23 && parts[1] >= 0 && parts[1] <= 59) {
          return parts[0] * 60 + parts[1];
        }
      }
    }

    // Try H:MM AM/PM or HH:MM AM/PM
    const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (match) {
      let hours = parseInt(match[1], 10);
      const minutes = parseInt(match[2], 10);
      const period = match[3].toUpperCase();

      if (hours < 1 || hours > 12 || minutes < 0 || minutes > 59) {
        console.warn('Invalid AM/PM time format:', timeStr);
        return null;
      }

      if (period === 'PM' && hours !== 12) hours += 12;
      if (period === 'AM' && hours === 12) hours = 0;
      return hours * 60 + minutes;
    }

    console.warn('Could not parse event time string:', timeStr);
    return null;
  } catch (e) {
    console.error('Error parsing event time string:', timeStr, e);
    return null;
  }
};

/**
 * Converts minutes from midnight to a Date object on the given day.
 * @param minutes Minutes from midnight
 * @param referenceDate Date to use for year/month/day
 * @returns Date object at the specified time
 */
export const minutesToDate = (minutes: number, referenceDate: Date = new Date()): Date => {
  const result = new Date(referenceDate);
  result.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return result;
};

/**
 * Gets minutes from midnight for a Date object.
 * @param date Date to extract time from
 * @returns Minutes from midnight
 */
export const dateToMinutes = (date: Date): number => {
  return date.getHours() * 60 + date.getMinutes();
};

/**
 * Formats an hour (0-23) into a 12-hour AM/PM string (e.g., "12AM", "1PM").
 * @param hour The hour in 24-hour format (0-23).
 * @returns The formatted time string.
 */
export const formatHourLabel = (hour: number): string => {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 || hour === 24 ? 'AM' : 'PM';
  return `${h}${ampm}`;
};

/**
 * Formats an hour with 24-hour format.
 * @param hour The hour (0-23)
 * @returns Formatted string like "00:00", "14:00"
 */
export const formatHourLabel24 = (hour: number): string => {
  return `${hour.toString().padStart(2, '0')}:00`;
};

/**
 * Formats minutes from midnight into a time string.
 * @param minutes Minutes from midnight
 * @param format '12h' or '24h'
 * @returns Formatted time string
 */
export const formatMinutesToTime = (
  minutes: number,
  format: '12h' | '24h' = '12h'
): string => {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  if (format === '24h') {
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
  }

  const displayHour = hours % 12 === 0 ? 12 : hours % 12;
  const ampm = hours < 12 ? 'AM' : 'PM';
  return `${displayHour}:${mins.toString().padStart(2, '0')} ${ampm}`;
};

/**
 * Formats any time string into consistent 12-hour AM/PM format.
 * @param timeStr The time string to format (e.g., "19:00", "7:00 PM").
 * @returns Formatted time string in "H:MM AM/PM" format.
 */
export const formatDisplayTime = (timeStr: string | undefined): string => {
  if (!timeStr || timeStr.trim() === '') return '';

  const minutes = parseEventTimeToMinutes(timeStr);
  if (minutes === null) return timeStr;

  return formatMinutesToTime(minutes, '12h');
};

/**
 * Calculates duration in minutes between two time strings.
 * @param startTime Start time string
 * @param endTime End time string
 * @returns Duration in minutes, or null if parsing fails
 */
export const getTimeDuration = (
  startTime: string,
  endTime: string
): number | null => {
  const start = parseEventTimeToMinutes(startTime);
  const end = parseEventTimeToMinutes(endTime);

  if (start === null || end === null) return null;

  // Handle overnight events
  if (end < start) {
    return 24 * 60 - start + end;
  }

  return end - start;
};

/**
 * Checks if a time falls within a range.
 * @param time Time to check (minutes from midnight)
 * @param rangeStart Range start (minutes from midnight)
 * @param rangeEnd Range end (minutes from midnight)
 * @returns true if time is within range
 */
export const isTimeInRange = (
  time: number,
  rangeStart: number,
  rangeEnd: number
): boolean => {
  // Handle overnight ranges
  if (rangeEnd < rangeStart) {
    return time >= rangeStart || time <= rangeEnd;
  }
  return time >= rangeStart && time <= rangeEnd;
};
