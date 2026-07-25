// @plain-calendar/react
// React hooks and components for calendar UI

// Re-export core utilities and types
export * from '@plain-calendar/core';

// Hooks
export { useCalendarState } from './hooks/useCalendarState';
export type { UseCalendarStateOptions } from './hooks/useCalendarState';

export { useTimeRange } from './hooks/useTimeRange';

export { useEventLayout } from './hooks/useEventLayout';

export { useEventStack } from './hooks/useEventStack';

export { useEventsMap, getEventsForDate, getEventsForRange } from './hooks/useEventsMap';

export { useTimeAxis } from './hooks/useTimeAxis';

export { useGridLines } from './hooks/useGridLines';

export { useCurrentTimeIndicator } from './hooks/useCurrentTimeIndicator';

export { useDateCache } from './hooks/useDateCache';

export { useTimeProportionalLayout } from './hooks/useTimeProportionalLayout';

// Components
export * from './components';

// Utilities
export * from './utils';
