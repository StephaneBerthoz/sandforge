import React from 'react';
import { cn } from '../../theme';

/** Props for the BrandMark component. */
export interface BrandMarkProps {
  /** Additional CSS classes: the mark fills the box they size. */
  className?: string;
}

/**
 * The SandForge mark — the forge's fire rising out of a sandbox — as the
 * extension's Marketplace icon draws it (resources/icon.svg), without its
 * ground. Beside the product's name it said "SandForge" with a generic flame,
 * the Forge module's own icon, which made the brand and one of its modules
 * look the same.
 *
 * Decorative: the name it stands beside is the accessible text.
 */
export const BrandMark: React.FC<BrandMarkProps> = ({ className }) => (
  <svg
    viewBox="18 0 64 98"
    className={cn('shrink-0', className)}
    aria-hidden="true"
    focusable="false"
    data-testid="brand-mark"
  >
    <path d="M50 56 L80 68 L50 80 L20 68 Z" fill="#262A3D" />
    <g transform="translate(0 -9)">
      <path
        d="M50 12 C57.5 26 74 35 74 56.5 C74 71.5 63.2 82 50 82 C36.8 82 26 71.5 26 56.5 C26 45 32.4 38.4 37.8 31 C38.8 40 42.4 44.6 46 43.8 C49.6 43 46.6 25.6 50 12 Z"
        fill="#F5A623"
      />
      <path
        d="M50 47 C54.6 55.4 61.6 59.4 61.6 68 C61.6 75.4 56.4 80.6 50 80.6 C43.6 80.6 38.4 75.4 38.4 68 C38.4 62.2 42 58.6 45 55.2 C45.8 59 47.4 60.6 48.8 60 C50.4 59.4 49 52.8 50 47 Z"
        fill="#FFD27A"
      />
    </g>
    <path d="M20 68 L50 80 L50 95 L20 83 Z" fill="#646E8C" />
    <path d="M80 68 L50 80 L50 95 L80 83 Z" fill="#8F99B6" />
    <path
      d="M20 68 L50 80 L80 68"
      fill="none"
      stroke="#C9D0E2"
      strokeWidth="1.6"
      strokeLinejoin="round"
      strokeLinecap="round"
    />
  </svg>
);
