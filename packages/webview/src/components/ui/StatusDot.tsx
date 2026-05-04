import React from 'react';
import { cn } from '../../theme';

/** Possible status values. */
export type StatusDotStatus = 'online' | 'offline' | 'warning' | 'error' | 'unknown';

/** StatusDot component props. */
export interface StatusDotProps {
  status: StatusDotStatus;
  /** Optional text label next to the dot. */
  label?: string;
  /** When true, the dot pulses. */
  pulse?: boolean;
  className?: string;
}

const statusClasses: Record<StatusDotStatus, string> = {
  online: 'bg-emerald-500',
  offline: 'bg-gray-500',
  warning: 'bg-amber-500',
  error: 'bg-red-500',
  unknown: 'bg-gray-400',
};

const pulseClasses: Record<StatusDotStatus, string> = {
  online: 'bg-emerald-400',
  offline: 'bg-gray-400',
  warning: 'bg-amber-400',
  error: 'bg-red-400',
  unknown: 'bg-gray-300',
};

/** Small colored status indicator dot with optional label. */
export const StatusDot: React.FC<StatusDotProps> = ({
  status,
  label,
  pulse = false,
  className,
}) => {
  return (
    <span
      className={cn('inline-flex items-center gap-1.5', className)}
      role="status"
      aria-label={label ?? status}
    >
      <span className="relative flex h-2.5 w-2.5">
        {pulse && (
          <span
            className={cn(
              'absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping',
              pulseClasses[status],
            )}
            aria-hidden="true"
          />
        )}
        <span
          className={cn('relative inline-flex rounded-full h-2.5 w-2.5', statusClasses[status])}
          data-testid="status-dot"
        />
      </span>
      {label && (
        <span className="text-xs text-[var(--vscode-editor-foreground,#d4d4d4)]">{label}</span>
      )}
    </span>
  );
};
