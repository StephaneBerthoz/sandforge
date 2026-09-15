import React from 'react';
import { cn } from '../../theme';

/** ProgressBar component props. */
export interface ProgressBarProps {
  value: number;
  max?: number;
  label?: string;
  /**
   * Accessible name when no visible `label` is shown. A progressbar without a
   * name is announced as a bare percentage, and axe reports it as serious.
   */
  ariaLabel?: string;
  showPercent?: boolean;
  variant?: 'default' | 'success' | 'warning' | 'error';
  size?: 'sm' | 'md';
  className?: string;
}

const barVariants: Record<string, string> = {
  default: 'bg-[var(--vscode-progressBar-background,#0e70c0)]',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  error: 'bg-red-500',
};

/** Progress bar matching VSCode theme. */
export const ProgressBar: React.FC<ProgressBarProps> = ({
  value,
  max = 100,
  label,
  ariaLabel,
  showPercent = false,
  variant = 'default',
  size = 'md',
  className,
}) => {
  const percent = Math.min(100, Math.max(0, (value / max) * 100));

  return (
    <div className={cn('w-full', className)}>
      {(label || showPercent) && (
        <div className="flex justify-between items-center mb-1">
          {label && (
            <span className="text-xs text-[var(--vscode-editor-foreground,#d4d4d4)]">{label}</span>
          )}
          {showPercent && (
            <span className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">
              {Math.round(percent)}%
            </span>
          )}
        </div>
      )}
      <div
        className={cn(
          'w-full rounded-full overflow-hidden',
          'bg-[var(--vscode-input-background,#3c3c3c)]',
          size === 'sm' ? 'h-1' : 'h-2',
        )}
        role="progressbar"
        aria-label={ariaLabel ?? label}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
      >
        <div
          className={cn('h-full rounded-full transition-all duration-300', barVariants[variant])}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
};
