import React, { useEffect, useId, useRef, useState } from 'react';
import { cn } from '../../theme';

/** ProgressBar component props. */
export interface ProgressBarProps {
  value: number;
  max?: number;
  /** Visible label; the bar is named by pointing at it. */
  label?: string;
  /**
   * Accessible name when no visible `label` is shown. A progressbar without a
   * name is announced as a bare percentage, and axe reports it as serious.
   */
  ariaLabel?: string;
  /** Id of an element already on screen that names the bar, e.g. its row. */
  'aria-labelledby'?: string;
  /** What a screen reader says for the value. Defaults to the percentage. */
  valueText?: string;
  showPercent?: boolean;
  variant?: 'default' | 'success' | 'warning' | 'error';
  size?: 'sm' | 'md';
  className?: string;
  /** Fill colour in place of the variant's, e.g. a module's own colour. */
  barClassName?: string;
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
  'aria-labelledby': ariaLabelledBy,
  valueText,
  showPercent = false,
  variant = 'default',
  size = 'md',
  className,
  barClassName,
}) => {
  const labelId = useId();
  const percent = Math.min(100, Math.max(0, (value / max) * 100));
  const unnamed = !label && !ariaLabel && !ariaLabelledBy;

  useEffect(() => {
    if (import.meta.env.DEV && unnamed) {
      // eslint-disable-next-line no-console
      console.warn('ProgressBar has no name: pass label, ariaLabel or aria-labelledby.');
    }
  }, [unnamed]);

  return (
    <div className={cn('w-full', className)}>
      {(label || showPercent) && (
        <div className="flex justify-between items-center mb-1">
          {label && (
            <span id={labelId} className="text-xs text-[var(--vscode-editor-foreground,#d4d4d4)]">
              {label}
            </span>
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
        aria-labelledby={ariaLabelledBy ?? (label && !ariaLabel ? labelId : undefined)}
        aria-label={ariaLabelledBy ? undefined : ariaLabel}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuetext={valueText ?? `${Math.round(percent)}%`}
      >
        <div
          className={cn(
            'h-full rounded-full transition-all duration-300',
            barVariants[variant],
            barClassName,
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
};

/** ProgressAnnouncer component props. */
export interface ProgressAnnouncerProps {
  /** The sentence a screen reader should hear, e.g. "Seed progress: 40%". */
  message: string;
  /** Shortest gap between two announcements, in milliseconds. */
  interval?: number;
  /** Say this message now: a run that ended must not wait for the interval. */
  immediate?: boolean;
  testId?: string;
}

/**
 * Polite live region for a running operation's progress.
 *
 * A bar's value changes many times a second; announcing every change would
 * talk over everything else a screen reader user is doing. The region says the
 * first message at once, then at most one message per `interval` — always the
 * latest — and an `immediate` message without waiting.
 */
export const ProgressAnnouncer: React.FC<ProgressAnnouncerProps> = ({
  message,
  interval = 5000,
  immediate = false,
  testId,
}) => {
  const [spoken, setSpoken] = useState('');
  const lastSpokenAt = useRef<number | null>(null);

  useEffect(() => {
    if (message === spoken) return undefined;
    const speak = (): void => {
      lastSpokenAt.current = Date.now();
      setSpoken(message);
    };
    const wait = lastSpokenAt.current === null ? 0 : lastSpokenAt.current + interval - Date.now();
    if (immediate || wait <= 0) {
      speak();
      return undefined;
    }
    const timer = setTimeout(speak, wait);
    return () => clearTimeout(timer);
  }, [message, spoken, interval, immediate]);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
      data-testid={testId}
    >
      {spoken}
    </div>
  );
};
