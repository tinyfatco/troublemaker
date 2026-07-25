/**
 * stackUtils - Pure functions for priority-based event stacking
 * 
 * Events that overlap in time are stacked based on priority.
 * Higher priority events (lower number) form the base layer,
 * with lower priority events visually nested inside.
 */

import type { CalendarEvent, StackedEvent, StackGroup, StackInsets } from './types';

/**
 * Check if two events overlap in time
 */
export function eventsOverlap(a: CalendarEvent, b: CalendarEvent): boolean {
  return a.start < b.end && a.end > b.start;
}

/**
 * Check if event B is fully contained within event A's time range
 * (B starts at or after A, and B ends at or before A)
 */
export function eventContains(container: CalendarEvent, contained: CalendarEvent): boolean {
  return contained.start >= container.start && contained.end <= container.end;
}

/**
 * Find groups of overlapping events using union-find approach
 */
export function findOverlapGroups<T extends CalendarEvent>(events: T[]): StackGroup<T>[] {
  if (events.length === 0) return [];
  
  // Sort by start time
  const sorted = [...events].sort((a, b) => a.start.getTime() - b.start.getTime());
  
  const groups: StackGroup<T>[] = [];
  let currentGroup: T[] = [sorted[0]];
  let groupEnd = sorted[0].end;
  
  for (let i = 1; i < sorted.length; i++) {
    const event = sorted[i];
    
    // If this event starts before the current group ends, it overlaps
    if (event.start < groupEnd) {
      currentGroup.push(event);
      // Extend group end if this event ends later
      if (event.end > groupEnd) {
        groupEnd = event.end;
      }
    } else {
      // Start a new group
      groups.push({
        events: currentGroup,
        timeRange: {
          start: currentGroup[0].start,
          end: groupEnd,
        },
      });
      currentGroup = [event];
      groupEnd = event.end;
    }
  }
  
  // Don't forget the last group
  groups.push({
    events: currentGroup,
    timeRange: {
      start: currentGroup[0].start,
      end: groupEnd,
    },
  });
  
  return groups;
}

/**
 * Sort events by priority (lower number = higher priority = first)
 */
export function sortByPriority<T extends CalendarEvent>(
  events: T[],
  getPriority: (event: T) => number
): T[] {
  return [...events].sort((a, b) => getPriority(a) - getPriority(b));
}

/**
 * Build containment tree for a group of overlapping events
 * Returns map of event ID -> parent event ID (or null for roots)
 */
export function calculateContainment<T extends CalendarEvent>(
  events: T[],
  getPriority: (event: T) => number
): Map<string, { parentId: string | null; childIds: string[]; layer: number }> {
  const result = new Map<string, { parentId: string | null; childIds: string[]; layer: number }>();
  
  // Sort by priority - highest priority (lowest number) first
  const sorted = sortByPriority(events, getPriority);
  
  // Initialize all events
  for (const event of sorted) {
    result.set(event.id, { parentId: null, childIds: [], layer: 0 });
  }
  
  // For each event, find its closest containing parent
  for (let i = 1; i < sorted.length; i++) {
    const event = sorted[i];
    
    // Look backwards for the closest (lowest priority among higher) container
    for (let j = i - 1; j >= 0; j--) {
      const potentialParent = sorted[j];
      
      if (eventContains(potentialParent, event)) {
        const parentInfo = result.get(potentialParent.id)!;
        const eventInfo = result.get(event.id)!;
        
        eventInfo.parentId = potentialParent.id;
        eventInfo.layer = parentInfo.layer + 1;
        parentInfo.childIds.push(event.id);
        break;
      }
    }
  }
  
  return result;
}

/**
 * Calculate visual insets for a given layer depth
 */
export function getStackInsets(layer: number, insetPx: number): StackInsets {
  const totalInset = layer * insetPx;
  return {
    left: totalInset,
    right: totalInset,
  };
}

/**
 * Convert minutes from midnight to percentage position
 */
function minutesToPercent(minutes: number, startHour: number, endHour: number): number {
  const startMinutes = startHour * 60;
  const totalMinutes = (endHour - startHour) * 60;
  return ((minutes - startMinutes) / totalMinutes) * 100;
}

/**
 * Main function: Calculate stacked events from a list of events
 */
export function calculateStacks<T extends CalendarEvent>(
  events: T[],
  options: {
    getPriority: (event: T) => number;
    insetPx?: number;
    maxDepth?: number;
    startHour?: number;
    endHour?: number;
  }
): {
  stackedEvents: StackedEvent<T>[];
  stackGroups: StackGroup<T>[];
  maxDepth: number;
  hasStacks: boolean;
} {
  const {
    getPriority,
    insetPx = 8,
    maxDepth = 5,
    startHour = 0,
    endHour = 24,
  } = options;
  
  if (events.length === 0) {
    return {
      stackedEvents: [],
      stackGroups: [],
      maxDepth: 0,
      hasStacks: false,
    };
  }
  
  // Find overlap groups
  const stackGroups = findOverlapGroups(events);
  
  // Process each group
  const allStackedEvents: StackedEvent<T>[] = [];
  let globalMaxDepth = 0;
  let hasStacks = false;
  
  for (const group of stackGroups) {
    if (group.events.length === 1) {
      // Single event - no stacking needed
      const event = group.events[0];
      const startMinutes = event.start.getHours() * 60 + event.start.getMinutes();
      const endMinutes = event.end.getHours() * 60 + event.end.getMinutes();
      
      allStackedEvents.push({
        event,
        layer: 0,
        parentId: null,
        childIds: [],
        insets: { left: 0, right: 0 },
        top: minutesToPercent(startMinutes, startHour, endHour),
        height: minutesToPercent(endMinutes, startHour, endHour) - minutesToPercent(startMinutes, startHour, endHour),
      });
      continue;
    }
    
    // Multiple events - calculate containment
    const containment = calculateContainment(group.events, getPriority);
    
    for (const event of group.events) {
      const info = containment.get(event.id)!;
      const layer = Math.min(info.layer, maxDepth);
      
      if (layer > 0) hasStacks = true;
      if (layer > globalMaxDepth) globalMaxDepth = layer;
      
      const startMinutes = event.start.getHours() * 60 + event.start.getMinutes();
      const endMinutes = event.end.getHours() * 60 + event.end.getMinutes();
      
      allStackedEvents.push({
        event,
        layer,
        parentId: info.parentId,
        childIds: info.childIds,
        insets: getStackInsets(layer, insetPx),
        top: minutesToPercent(startMinutes, startHour, endHour),
        height: minutesToPercent(endMinutes, startHour, endHour) - minutesToPercent(startMinutes, startHour, endHour),
      });
    }
  }
  
  return {
    stackedEvents: allStackedEvents,
    stackGroups,
    maxDepth: globalMaxDepth,
    hasStacks,
  };
}
