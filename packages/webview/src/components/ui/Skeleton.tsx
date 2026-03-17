import React from 'react';
import { cn } from '../../theme';

/** Props for the Skeleton loading placeholder component. */
export interface SkeletonProps {
  /** Shape variant of the skeleton. Defaults to 'text'. */
  variant?: 'text' | 'rect' | 'circle';
  /** CSS width value. Defaults to '100%' for text/rect, '40px' for circle. */
  width?: string;
  /** CSS height value. Defaults to '1em' for text, '100px' for rect, same as width for circle. */
  height?: string;
  /** Number of lines to render (text variant only). Defaults to 1. */
  lines?: number;
  /** Additional CSS classes. */
  className?: string;
}

/** Width variation percentages for multi-line text skeletons. */
const lineWidths = ['100%', '92%', '85%', '78%', '95%', '88%', '80%', '90%'];

/**
 * Skeleton loading placeholder that uses the `sf-skeleton` CSS animation
 * from the design system. Renders pulsing placeholders in text, rectangle,
 * or circle shapes.
 */
export const Skeleton: React.FC<SkeletonProps> = ({
  variant = 'text',
  width,
  height,
  lines = 1,
  className,
}) => {
  if (variant === 'circle') {
    const size = width ?? '40px';
    return (
      <div
        className={cn('sf-skeleton rounded-full shrink-0', className)}
        style={{ width: size, height: height ?? size }}
        data-testid="skeleton"
        aria-hidden={true}
      />
    );
  }

  if (variant === 'rect') {
    return (
      <div
        className={cn('sf-skeleton rounded-[var(--sf-radius-md)]', className)}
        style={{ width: width ?? '100%', height: height ?? '100px' }}
        data-testid="skeleton"
        aria-hidden={true}
      />
    );
  }

  /* text variant */
  if (lines > 1) {
    return (
      <div
        className={cn('flex flex-col gap-[var(--sf-space-2)]', className)}
        data-testid="skeleton"
        aria-hidden={true}
      >
        {Array.from({ length: lines }, (_, i) => (
          <div
            key={i}
            className="sf-skeleton rounded-[var(--sf-radius-sm)]"
            style={{
              width: width ?? lineWidths[i % lineWidths.length],
              height: height ?? '1em',
            }}
            data-testid="skeleton-line"
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className={cn('sf-skeleton rounded-[var(--sf-radius-sm)]', className)}
      style={{ width: width ?? '100%', height: height ?? '1em' }}
      data-testid="skeleton"
      aria-hidden={true}
    />
  );
};
