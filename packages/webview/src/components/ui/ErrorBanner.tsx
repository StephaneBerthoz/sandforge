import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';
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
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  /* Salesforce errors are the payload of a bug report: retyping one by hand
     from a webview is how the useful half (the status code, the record id)
     gets lost. */
  const handleCopy = useCallback(() => {
    const clipboard: Clipboard | undefined = navigator.clipboard;
    if (!clipboard) return;
    void clipboard.writeText(message).then(
      () => {
        setCopied(true);
        if (resetTimer.current) clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(() => setCopied(false), 2000);
      },
      () => {
        /* Clipboard denied by the host: leave the banner as it was rather than
           claiming a copy that never happened. */
      },
    );
  }, [message]);

  const copyLabel = copied ? t('errorBoundary.copied', 'Copied!') : t('common.copy', 'Copy');

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
      {/* whitespace-pre-wrap keeps the line breaks of a multi-row Bulk API
          failure; break-words keeps a long unbroken id or URL inside the
          banner instead of spilling out of the sidebar. */}
      <span className="flex-1 min-w-0 whitespace-pre-wrap break-words">{message}</span>
      {/* flex-row-reverse: the dismiss cross keeps its far-right position while
          staying the first button in the DOM, so callers that reach for the
          banner's first button still find dismiss. */}
      <div className="flex shrink-0 flex-row-reverse items-center gap-1">
        {onDismiss && (
          <button
            type="button"
            className="shrink-0 opacity-60 hover:opacity-100"
            onClick={onDismiss}
            aria-label={t('common.dismiss', 'Dismiss')}
          >
            {'\u2715'}
          </button>
        )}
        <button
          type="button"
          className="shrink-0 opacity-60 hover:opacity-100"
          onClick={handleCopy}
          aria-label={copyLabel}
          title={copyLabel}
          data-testid={`${testId}-copy`}
        >
          {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
};
