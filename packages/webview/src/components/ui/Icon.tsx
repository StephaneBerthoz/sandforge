import React from 'react';
import { cn } from '../../theme';

/** Props for the Icon component. */
export interface IconProps {
  /** Codicon name (e.g., "dashboard", "database", "sync"). */
  name: string;
  /** Additional CSS classes. */
  className?: string;
  /** Whether the icon should spin (e.g., for loading states). */
  spin?: boolean;
  /** Accessible label. If omitted, icon is decorative (aria-hidden). */
  label?: string;
}

/**
 * Renders a VSCode Codicon icon.
 * Uses the `codicon codicon-{name}` CSS classes provided by VSCode's built-in icon font.
 */
export const Icon: React.FC<IconProps> = ({ name, className, spin, label }) => {
  return (
    <span
      className={cn('codicon', `codicon-${name}`, spin && 'sf-spin', className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-testid={`icon-${name}`}
    />
  );
};
