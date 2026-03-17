import React from 'react';
import { motion } from 'framer-motion';
import { cn } from '../../theme';
import { cardHover, SPRING } from '../../motion/presets';

/** Props for the BentoGrid container. */
export interface BentoGridProps {
  /** Number of columns at the lg breakpoint. */
  columns?: 1 | 2 | 3 | 4;
  /** Gap between tiles: sm (gap-2), md (gap-4), lg (gap-6). */
  gap?: 'sm' | 'md' | 'lg';
  /** Grid children (typically BentoTile components). */
  children: React.ReactNode;
  /** Additional CSS classes for the grid container. */
  className?: string;
}

/** Props for a BentoTile card within a BentoGrid. */
export interface BentoTileProps {
  /** Number of columns this tile spans (1-4). */
  colSpan?: 1 | 2 | 3 | 4;
  /** Number of rows this tile spans (1-2). */
  rowSpan?: 1 | 2;
  /** Tile content. */
  children: React.ReactNode;
  /** Additional CSS classes for the tile. */
  className?: string;
}

/** Tailwind gap class lookup by size token. */
const gapClass: Record<string, string> = {
  sm: 'gap-2',
  md: 'gap-4',
  lg: 'gap-6',
};

/** Tailwind lg:grid-cols-N class lookup. */
const columnsClass: Record<number, string> = {
  1: 'lg:grid-cols-1',
  2: 'lg:grid-cols-2',
  3: 'lg:grid-cols-3',
  4: 'lg:grid-cols-4',
};

/** Tailwind col-span-N class lookup. */
const colSpanClass: Record<number, string> = {
  1: 'col-span-1',
  2: 'col-span-2',
  3: 'col-span-3',
  4: 'col-span-4',
};

/** Tailwind row-span-N class lookup. */
const rowSpanClass: Record<number, string> = {
  1: 'row-span-1',
  2: 'row-span-2',
};

/**
 * Responsive CSS-grid container for a bento-style tile layout.
 * Defaults to 3 columns at lg, 2 at sm, and 1 on mobile.
 */
export const BentoGrid: React.FC<BentoGridProps> = ({
  columns = 3,
  gap = 'md',
  children,
  className,
}) => {
  return (
    <div
      data-testid="bento-grid"
      className={cn(
        'grid grid-cols-1 sm:grid-cols-2',
        columnsClass[columns],
        gapClass[gap],
        className,
      )}
    >
      {children}
    </div>
  );
};

/**
 * Animated tile card for use inside a BentoGrid.
 * Uses framer-motion cardHover preset for hover lift effect.
 */
export const BentoTile: React.FC<BentoTileProps> = ({
  colSpan = 1,
  rowSpan = 1,
  children,
  className,
}) => {
  return (
    <motion.div
      data-testid="bento-tile"
      className={cn(
        'bg-surface-1 rounded-xl border border-subtle p-4',
        colSpanClass[colSpan],
        rowSpanClass[rowSpan],
        className,
      )}
      whileHover={cardHover.whileHover}
      transition={SPRING}
    >
      {children}
    </motion.div>
  );
};
