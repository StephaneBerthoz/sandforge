import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../theme';

/** Spinner size variants. */
const sizeClasses = {
  sm: 'w-4 h-4 border-2',
  md: 'w-6 h-6 border-2',
  lg: 'w-8 h-8 border-3',
} as const;

/** Spinner component props. */
export interface SpinnerProps {
  size?: keyof typeof sizeClasses;
  label?: string;
  className?: string;
}

/** Animated loading spinner with optional label. */
export const Spinner: React.FC<SpinnerProps> = ({ size = 'md', label, className }) => {
  const { t } = useTranslation();

  return (
    <div
      className={cn('flex flex-col items-center gap-2', className)}
      data-testid="spinner"
      aria-live="polite"
    >
      <div
        className={cn(
          'rounded-full border-[var(--vscode-descriptionForeground,#868686)] border-t-[var(--vscode-textLink-foreground,#3794ff)] animate-spin',
          sizeClasses[size],
        )}
        role="status"
        aria-label={label ?? t('common.loading', 'Loading...')}
      />
      {label && (
        <span className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">{label}</span>
      )}
    </div>
  );
};
