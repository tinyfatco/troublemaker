/**
 * useEventStack - React hook for priority-based event stacking
 */

import { useMemo } from 'react';
import { calculateStacks } from '@plain-calendar/core';
import type {
  CalendarEvent,
  UseEventStackOptions,
  UseEventStackReturn,
} from '@plain-calendar/core';

/**
 * Hook for calculating stacked event positions based on priority.
 * 
 * Higher priority events (lower number) become the base layer,
 * with lower priority events visually nested inside when they
 * are fully contained within the time range.
 * 
 * @example
 * ```tsx
 * const { stackedEvents, hasStacks } = useEventStack(events, {
 *   getPriority: (e) => e.data?.priority ?? 999,
 *   insetPx: 8,
 * });
 * 
 * return stackedEvents.map(stacked => (
 *   <EventBlock
 *     key={stacked.event.id}
 *     style={{
 *       top: `${stacked.top}%`,
 *       height: `${stacked.height}%`,
 *       left: stacked.insets.left,
 *       right: stacked.insets.right,
 *     }}
 *   />
 * ));
 * ```
 */
export function useEventStack<T extends CalendarEvent = CalendarEvent>(
  events: T[],
  options: UseEventStackOptions<T>
): UseEventStackReturn<T> {
  const {
    getPriority,
    insetPx = 8,
    maxDepth = 5,
    startHour = 0,
    endHour = 24,
  } = options;

  const result = useMemo(() => {
    return calculateStacks(events, {
      getPriority,
      insetPx,
      maxDepth,
      startHour,
      endHour,
    });
  }, [events, getPriority, insetPx, maxDepth, startHour, endHour]);

  return result;
}

export default useEventStack;
