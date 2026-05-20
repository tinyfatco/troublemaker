/**
 * Core types for plain-calendar
 */

// ============================================================================
// Date & Time Types
// ============================================================================

/** Date range with start and end */
export interface DateRange {
  start: Date;
  end: Date;
}

/** Time range in minutes from midnight */
export interface TimeRange {
  startMinutes: number;
  endMinutes: number;
}

/** Time slot for scheduling */
export interface TimeSlot {
  date: Date;
  startTime: string; // HH:MM format
  endTime: string; // HH:MM format
}

// ============================================================================
// Event Types
// ============================================================================

/** Base calendar event */
export interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  allDay?: boolean;
  color?: string;
  data?: Record<string, unknown>;
}

/** Event positioned in a layout (with column assignment for overlaps) */
export interface PositionedEvent<T extends CalendarEvent = CalendarEvent> {
  event: T;
  column: number;
  totalColumns: number;
  top: number; // percentage
  height: number; // percentage
}

/** Events grouped by date string key (YYYY-MM-DD) */
export type EventsByDate<T extends CalendarEvent = CalendarEvent> = Map<string, T[]>;

// ============================================================================
// View Types
// ============================================================================

/** Calendar view mode */
export type CalendarView = 'day' | 'week' | 'month' | 'agenda';

/** Grid line for time displays */
export interface GridLine {
  time: string; // HH:MM format
  minutes: number;
  position: number; // percentage from top
  label: string;
}

/** Time axis label */
export interface TimeAxisLabel {
  hour: number;
  label: string;
  position: number; // percentage from top
}

// ============================================================================
// Hook Return Types
// ============================================================================

/** State for calendar navigation */
export interface CalendarState {
  selectedDate: Date;
  currentViewingDate: Date;
  viewStartDate: Date;
  viewEndDate: Date;
}

/** Actions for calendar navigation */
export interface CalendarActions {
  setSelectedDate: (date: Date) => void;
  goToToday: () => void;
  goToPrevious: () => void;
  goToNext: () => void;
  goToDate: (date: Date) => void;
}

/** useCalendarState return type */
export interface UseCalendarStateReturn extends CalendarState, CalendarActions {}

/** useTimeRange options */
export interface TimeRangeOptions {
  defaultStartHour?: number;
  defaultEndHour?: number;
  expandToFitEvents?: boolean;
}

/** useTimeRange return type */
export interface UseTimeRangeReturn {
  startHour: number;
  endHour: number;
  totalMinutes: number;
  getPositionForTime: (date: Date) => number;
  getTimeForPosition: (position: number) => Date;
}

/** useEventLayout return type */
export interface UseEventLayoutReturn<T extends CalendarEvent = CalendarEvent> {
  positionedEvents: PositionedEvent<T>[];
  hasOverlaps: boolean;
}

// ============================================================================
// Event Stacking Types
// ============================================================================

/** Visual insets for stacked events */
export interface StackInsets {
  left: number;   // pixels
  right: number;  // pixels
}

/** Event with stacking metadata */
export interface StackedEvent<T extends CalendarEvent = CalendarEvent> {
  event: T;
  /** Layer in the stack (0 = base/highest priority) */
  layer: number;
  /** Parent event ID if nested inside another */
  parentId: string | null;
  /** Child event IDs contained within this event */
  childIds: string[];
  /** Visual insets from container edges */
  insets: StackInsets;
  /** Position as percentage (same as PositionedEvent) */
  top: number;
  height: number;
}

/** Group of overlapping events */
export interface StackGroup<T extends CalendarEvent = CalendarEvent> {
  events: T[];
  timeRange: { start: Date; end: Date };
}

/** useEventStack options */
export interface UseEventStackOptions<T extends CalendarEvent = CalendarEvent> {
  /** Function to extract priority from event (lower = higher priority) */
  getPriority: (event: T) => number;
  /** Pixels to inset per layer (default: 8) */
  insetPx?: number;
  /** Maximum nesting depth (default: 5) */
  maxDepth?: number;
  /** Start hour for position calculation */
  startHour?: number;
  /** End hour for position calculation */
  endHour?: number;
}

/** useEventStack return type */
export interface UseEventStackReturn<T extends CalendarEvent = CalendarEvent> {
  stackedEvents: StackedEvent<T>[];
  stackGroups: StackGroup<T>[];
  maxDepth: number;
  hasStacks: boolean;
}

/** useCurrentTimeIndicator return type */
export interface UseCurrentTimeIndicatorReturn {
  position: number; // percentage
  visible: boolean;
  currentTime: Date;
}

// ============================================================================
// Configuration Types
// ============================================================================

/** Calendar configuration */
export interface CalendarConfig {
  /** First day of week (0 = Sunday, 1 = Monday, etc.) */
  weekStartsOn: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** Time format for display */
  timeFormat: '12h' | '24h';
  /** Locale for formatting */
  locale?: string;
}

/** Default calendar configuration */
export const DEFAULT_CONFIG: CalendarConfig = {
  weekStartsOn: 0,
  timeFormat: '12h',
  locale: 'en-US',
};
