import React from 'react';
import { cn } from '../../theme';
import { Skeleton } from './Skeleton';

/** Props for the SkeletonCard composite loading placeholder. */
export interface SkeletonCardProps {
  /** Number of text lines to render. Defaults to 3. */
  lines?: number;
  /** Whether to show a circle skeleton icon. Defaults to true. */
  showIcon?: boolean;
  /** Additional CSS classes. */
  className?: string;
}

/**
 * Composite skeleton component that mimics a KPICard or panel card during loading.
 * Renders an optional circle icon, a title skeleton, and multiple text lines.
 */
export const SkeletonCard: React.FC<SkeletonCardProps> = ({
  lines = 3,
  showIcon = true,
  className,
}) => (
  <div
    className={cn(
      'rounded-lg border border-subtle bg-surface-1 p-4 flex flex-col gap-3',
      className,
    )}
    data-testid="skeleton-card"
    aria-hidden={true}
  >
    {/* Icon + title row */}
    <div className="flex items-center gap-3">
      {showIcon && <Skeleton variant="circle" width="36px" />}
      <Skeleton variant="text" width="45%" height="1.125em" />
    </div>

    {/* Text lines */}
    <Skeleton variant="text" lines={lines} />
  </div>
);
