/**
 * EventBlock - Headless event display component
 */

import React from 'react';
import type { CalendarEvent, PositionedEvent } from '@plain-calendar/core';

export interface EventBlockProps<T extends CalendarEvent = CalendarEvent> {
  /** Positioned event data */
  event: PositionedEvent<T>;
  /** Custom class name */
  className?: string;
  /** Custom styles */
  style?: React.CSSProperties;
  /** Click handler */
  onClick?: (event: T) => void;
  /** Children render prop for custom content */
  children?: (event: T) => React.ReactNode;
}

/**
 * Default styles for event block positioning.
 * Use these with your own styling or override completely.
 */
export function getEventBlockStyle<T extends CalendarEvent>(
  event: PositionedEvent<T>
): React.CSSProperties {
  const width = 100 / event.totalColumns;
  const left = event.column * width;

  return {
    position: 'absolute',
    top: `${event.top}%`,
    height: `${event.height}%`,
    left: `${left}%`,
    width: `${width}%`,
    minHeight: '20px',
    boxSizing: 'border-box',
  };
}

/**
 * Headless event block component.
 * Provides positioning and basic structure - you provide the styling.
 */
export function EventBlock<T extends CalendarEvent = CalendarEvent>({
  event,
  className,
  style,
  onClick,
  children,
}: EventBlockProps<T>): React.ReactElement {
  const baseStyle = getEventBlockStyle(event);
  const combinedStyle = { ...baseStyle, ...style };

  const handleClick = () => {
    onClick?.(event.event);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick?.(event.event);
    }
  };

  return (
    <div
      className={className}
      style={combinedStyle}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-label={event.event.title}
      data-event-id={event.event.id}
    >
      {children ? children(event.event) : (
        <span>{event.event.title}</span>
      )}
    </div>
  );
}

export default EventBlock;
