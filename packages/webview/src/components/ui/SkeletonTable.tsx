import React from 'react';
import { cn } from '../../theme';
import { Skeleton } from './Skeleton';

/** Props for the SkeletonTable composite loading placeholder. */
export interface SkeletonTableProps {
  /** Number of body rows to render. Defaults to 5. */
  rows?: number;
  /** Number of columns per row. Defaults to 4. */
  columns?: number;
  /** Additional CSS classes. */
  className?: string;
}

/** Column width percentages for visual variation. */
const COL_WIDTHS = ['70%', '50%', '85%', '60%', '75%', '55%', '90%', '65%'];

/**
 * Composite skeleton component that mimics a DataTable during loading.
 * Renders a header row of rectangle skeletons followed by text skeleton rows.
 */
export const SkeletonTable: React.FC<SkeletonTableProps> = ({
  rows = 5,
  columns = 4,
  className,
}) => (
  <div
    className={cn(
      'rounded-lg border border-subtle bg-surface-1 overflow-hidden',
      className,
    )}
    data-testid="skeleton-table"
    aria-hidden={true}
  >
    {/* Header row */}
    <div
      className="flex gap-4 px-4 py-3 border-b border-subtle bg-surface-2"
      data-testid="skeleton-table-header"
    >
      {Array.from({ length: columns }, (_, i) => (
        <Skeleton key={`h-${i}`} variant="rect" width={COL_WIDTHS[i % COL_WIDTHS.length]} height="0.75em" />
      ))}
    </div>

    {/* Body rows */}
    {Array.from({ length: rows }, (_, rowIdx) => (
      <div
        key={`r-${rowIdx}`}
        className="flex gap-4 px-4 py-2.5 border-b border-subtle last:border-b-0"
        data-testid="skeleton-table-row"
      >
        {Array.from({ length: columns }, (_, colIdx) => (
          <Skeleton
            key={`c-${rowIdx}-${colIdx}`}
            variant="text"
            width={COL_WIDTHS[(rowIdx + colIdx) % COL_WIDTHS.length]}
            height="0.875em"
          />
        ))}
      </div>
    ))}
  </div>
);
