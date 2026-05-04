import React from 'react';
import { cn } from '../../theme';
import { Skeleton } from './Skeleton';

/** Props for the SkeletonPanel composite loading placeholder. */
export interface SkeletonPanelProps {
  /** Number of section groups to render. Defaults to 2. */
  sections?: number;
  /** Additional CSS classes. */
  className?: string;
}

/** Line counts per section for visual variation. */
const SECTION_LINES = [4, 3, 4, 3, 4];

/**
 * Composite skeleton component that mimics a full panel or page section during loading.
 * Each section renders a title skeleton and several text lines.
 */
export const SkeletonPanel: React.FC<SkeletonPanelProps> = ({ sections = 2, className }) => (
  <div
    className={cn('flex flex-col gap-6', className)}
    data-testid="skeleton-panel"
    aria-hidden={true}
  >
    {Array.from({ length: sections }, (_, i) => (
      <div key={`s-${i}`} className="flex flex-col gap-3" data-testid="skeleton-panel-section">
        {/* Section title */}
        <Skeleton variant="text" width="30%" height="1.125em" />
        {/* Section content lines */}
        <Skeleton variant="text" lines={SECTION_LINES[i % SECTION_LINES.length]} />
      </div>
    ))}
  </div>
);
