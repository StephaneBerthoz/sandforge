import React from 'react';
import { useTranslation } from 'react-i18next';
import { Logo } from './ui/Logo';
import { cn } from '../theme';

/** Props for the LoadingScreen component. */
export interface LoadingScreenProps {
  /** Progress percentage from 0 to 100. */
  progress: number;
  /** Current loading step label key or literal text. */
  step: string;
  /** Optional CSS class name. */
  className?: string;
}

/**
 * Branded loading screen displayed during application startup.
 * Shows the SandForge logo, a progress bar with smooth transitions,
 * and a step label describing the current loading phase.
 */
export const LoadingScreen: React.FC<LoadingScreenProps> = ({ progress, step, className }) => {
  const { t } = useTranslation();
  const clampedProgress = Math.min(100, Math.max(0, progress));

  return (
    <div
      data-testid="loading-screen"
      className={cn(
        'flex flex-col items-center justify-center min-h-screen',
        'bg-[var(--sf-bg-primary)]',
        'text-[var(--sf-text-primary)]',
        className,
      )}
      role="status"
      aria-live="polite"
      aria-label={t('common.loading')}
    >
      <div className="flex flex-col items-center gap-6 w-64">
        <Logo size="large" />

        <h1 className="text-lg font-semibold tracking-wide text-[var(--sf-text-primary)]">
          SandForge
        </h1>

        {/* Progress bar */}
        <div className="w-full">
          <div
            className="w-full h-1.5 rounded-full overflow-hidden bg-[var(--sf-bg-input)]"
            role="progressbar"
            aria-valuenow={clampedProgress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full rounded-full bg-[var(--sf-progress-bg)] transition-all duration-500 ease-out"
              style={{ width: `${clampedProgress}%` }}
            />
          </div>
        </div>

        {/* Step label */}
        <p
          data-testid="loading-step"
          className="text-xs text-[var(--sf-text-secondary)] transition-opacity duration-300"
        >
          {step}
        </p>
      </div>
    </div>
  );
};
