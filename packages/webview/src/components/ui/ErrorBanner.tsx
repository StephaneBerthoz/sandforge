import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../theme';

/** ErrorBanner component props. */
export interface ErrorBannerProps {
  message: string;
  onDismiss?: () => void;
  className?: string;
  'data-testid'?: string;
}

/** Reusable inline error banner matching VSCode error styling. */
export const ErrorBanner: React.FC<ErrorBannerProps> = ({
  message,
  onDismiss,
  className,
  'data-testid': testId = 'error-banner',
}) => {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2',
        'text-xs text-[var(--vscode-errorForeground,#f44747)]',
        'px-2 py-1.5 rounded',
        'bg-[var(--vscode-inputValidation-errorBackground,#5a1d1d)]',
        className,
      )}
      data-testid={testId}
      role="alert"
    >
      <span className="flex-1 min-w-0">{message}</span>
      {onDismiss && (
        <button
          className="shrink-0 opacity-60 hover:opacity-100"
          onClick={onDismiss}
          aria-label={t('common.dismiss', 'Dismiss')}
        >
          {'\u2715'}
        </button>
      )}
    </div>
  );
};
