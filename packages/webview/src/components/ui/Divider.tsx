import React from 'react';
import { cn } from '../../theme';

/** Divider orientation. */
export type DividerOrientation = 'horizontal' | 'vertical';

/** Divider component props. */
export interface DividerProps {
  /** Optional centered label text. */
  label?: string;
  orientation?: DividerOrientation;
  className?: string;
}

/** Visual separator with optional centered label. */
export const Divider: React.FC<DividerProps> = ({
  label,
  orientation = 'horizontal',
  className,
}) => {
  if (orientation === 'vertical') {
    return (
      <div
        role="separator"
        aria-orientation="vertical"
        className={cn(
          'inline-block w-px self-stretch bg-[var(--vscode-panel-border,#3c3c3c)]',
          className,
        )}
      />
    );
  }

  if (label) {
    return (
      <div
        role="separator"
        aria-orientation="horizontal"
        className={cn('flex items-center gap-3', className)}
      >
        <div className="flex-1 h-px bg-[var(--vscode-panel-border,#3c3c3c)]" />
        <span className="text-[11px] text-[var(--vscode-descriptionForeground,#868686)] shrink-0">
          {label}
        </span>
        <div className="flex-1 h-px bg-[var(--vscode-panel-border,#3c3c3c)]" />
      </div>
    );
  }

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      className={cn('h-px w-full bg-[var(--vscode-panel-border,#3c3c3c)]', className)}
    />
  );
};
