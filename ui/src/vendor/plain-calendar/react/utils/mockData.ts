/**
 * Mock data generators for testing and demos
 */

import type { CalendarEvent } from '@plain-calendar/core';
import { addDays, addMonths } from '@plain-calendar/core';

const COLORS = [
  '#3b82f6', // blue
  '#ef4444', // red
  '#10b981', // green
  '#f59e0b', // amber
  '#8b5cf6', // purple
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#84cc16', // lime
];

const TITLES = [
  'Team Meeting',
  'Project Review',
  'Client Call',
  'Design Review',
  'Sprint Planning',
  'One-on-One',
  'Lunch Break',
  'Coffee Chat',
  'Training Session',
  'Demo Prep',
  'Code Review',
  'Interview',
  'Workshop',
  'Brainstorm',
  'Sync Up',
];

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Generate a single mock event.
 */
export function generateMockEvent(
  date: Date,
  options: {
    id?: string;
    startHour?: number;
    durationMinutes?: number;
  } = {}
): CalendarEvent {
  const {
    id = `event-${Math.random().toString(36).substr(2, 9)}`,
    startHour = randomInt(8, 18),
    durationMinutes = randomItem([30, 45, 60, 90, 120]),
  } = options;

  const start = new Date(date);
  start.setHours(startHour, randomItem([0, 15, 30, 45]), 0, 0);

  const end = new Date(start);
  end.setMinutes(end.getMinutes() + durationMinutes);

  return {
    id,
    title: randomItem(TITLES),
    start,
    end,
    color: randomItem(COLORS),
  };
}

/**
 * Generate mock events for a single day.
 */
export function generateDayEvents(
  date: Date,
  count: number = 3
): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  const usedHours = new Set<number>();

  for (let i = 0; i < count; i++) {
    let startHour: number;
    let attempts = 0;
    
    // Try to avoid overlaps (but don't try forever)
    do {
      startHour = randomInt(8, 18);
      attempts++;
    } while (usedHours.has(startHour) && attempts < 10);
    
    usedHours.add(startHour);
    events.push(generateMockEvent(date, { startHour }));
  }

  return events.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * Generate mock events for a week.
 */
export function generateWeekEvents(
  weekStart: Date,
  eventsPerDay: number = 3
): CalendarEvent[] {
  const events: CalendarEvent[] = [];

  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    const dayCount = randomInt(Math.max(0, eventsPerDay - 2), eventsPerDay + 2);
    events.push(...generateDayEvents(date, dayCount));
  }

  return events;
}

/**
 * Generate mock events for a month.
 */
export function generateMonthEvents(
  month: Date,
  eventsPerDay: number = 2
): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  
  const start = new Date(month);
  start.setDate(1);
  
  const end = addMonths(start, 1);
  
  let current = new Date(start);
  while (current < end) {
    // Not every day has events
    if (Math.random() > 0.3) {
      const dayCount = randomInt(0, eventsPerDay + 1);
      events.push(...generateDayEvents(current, dayCount));
    }
    current = addDays(current, 1);
  }

  // Add a few all-day events
  for (let i = 0; i < 3; i++) {
    const day = new Date(month);
    day.setDate(randomInt(1, 28));
    
    events.push({
      id: `allday-${i}`,
      title: randomItem(['Holiday', 'Conference', 'Team Offsite', 'Deadline']),
      start: day,
      end: addDays(day, randomInt(1, 3)),
      allDay: true,
      color: randomItem(COLORS),
    });
  }

  return events;
}

/**
 * Generate a fixed set of demo events (not random).
 */
export function generateDemoEvents(baseDate: Date = new Date()): CalendarEvent[] {
  const today = new Date(baseDate);
  today.setHours(0, 0, 0, 0);

  return [
    {
      id: 'demo-1',
      title: 'Morning Standup',
      start: new Date(today.setHours(9, 0)),
      end: new Date(today.setHours(9, 30)),
      color: '#3b82f6',
    },
    {
      id: 'demo-2',
      title: 'Design Review',
      start: new Date(today.setHours(10, 0)),
      end: new Date(today.setHours(11, 30)),
      color: '#8b5cf6',
    },
    {
      id: 'demo-3',
      title: 'Lunch with Team',
      start: new Date(today.setHours(12, 0)),
      end: new Date(today.setHours(13, 0)),
      color: '#10b981',
    },
    {
      id: 'demo-4',
      title: 'Client Call',
      start: new Date(today.setHours(14, 0)),
      end: new Date(today.setHours(15, 0)),
      color: '#ef4444',
    },
    {
      id: 'demo-5',
      title: 'Sprint Planning',
      start: new Date(today.setHours(14, 30)),
      end: new Date(today.setHours(16, 0)),
      color: '#f59e0b',
    },
    {
      id: 'demo-6',
      title: 'Code Review',
      start: new Date(today.setHours(16, 30)),
      end: new Date(today.setHours(17, 30)),
      color: '#06b6d4',
    },
  ];
}
