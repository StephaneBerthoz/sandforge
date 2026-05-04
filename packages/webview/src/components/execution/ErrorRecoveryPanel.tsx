import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RetryStatus } from '@sandforge/shared';
import { cn } from '../../theme';
import { useRetryManager } from '../../hooks/useRetryManager';

/** Props for ErrorRecoveryPanel. */
export interface ErrorRecoveryPanelProps {
  /** Execution ID to display retry status for. */
  executionId: string;
  /** Additional CSS classes. */
  className?: string;
}

/** Status icon component based on retry state. */
const StatusIcon: React.FC<{ status: RetryStatus }> = ({ status }) => {
  if (status.nextRetryAt !== null && status.nextRetryAt > Date.now()) {
    // Spinning icon for active countdown
    return (
      <span
        className="inline-block w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"
        data-testid="status-spinner"
        aria-label="retrying"
      />
    );
  }
  if (!status.canRetry) {
    // Error icon for exhausted
    return (
      <span className="text-red-400" data-testid="status-error" aria-label="exhausted">
        &#9888;
      </span>
    );
  }
  // Warning icon for waiting
  return (
    <span className="text-amber-400" data-testid="status-warning" aria-label="waiting">
      &#9888;
    </span>
  );
};

/** Single retry status row. */
const RetryRow: React.FC<{
  status: RetryStatus;
  countdown: number;
  onRetry: () => void;
  onAbort: () => void;
}> = ({ status, countdown, onRetry, onAbort }) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="flex flex-col gap-2 p-3 rounded bg-[var(--vscode-input-background,#3c3c3c)]"
      data-testid="retry-row"
    >
      <div className="flex items-center gap-2">
        <StatusIcon status={status} />
        <span className="text-sm font-medium text-[var(--vscode-editor-foreground)]">
          {status.objectName}
        </span>
        <span className="text-xs text-[var(--vscode-descriptionForeground)] ml-auto">
          {t('retry.attemptOf', {
            current: status.attemptNumber,
            max: status.maxAttempts,
            defaultValue: 'Attempt {{current}} of {{max}}',
          })}
        </span>
      </div>

      {/* Error message - truncated, expandable */}
      <button
        className="text-xs text-left text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-editor-foreground)] cursor-pointer bg-transparent border-none p-0"
        onClick={() => setExpanded(!expanded)}
        data-testid="error-toggle"
        aria-expanded={expanded}
      >
        {expanded
          ? status.lastError
          : status.lastError.slice(0, 80) + (status.lastError.length > 80 ? '...' : '')}
      </button>

      {expanded && (
        <div
          className="text-xs p-2 rounded bg-[var(--vscode-editor-background,#1e1e1e)] text-[var(--vscode-descriptionForeground)] break-all"
          data-testid="error-details"
        >
          <div className="font-medium mb-1">{t('retry.errorDetails', 'Error Details')}</div>
          {status.lastError}
        </div>
      )}

      {/* Countdown or exhausted message */}
      <div className="flex items-center gap-2">
        {status.nextRetryAt !== null && countdown > 0 ? (
          <span className="text-xs text-blue-400" data-testid="countdown">
            {t('retry.retryingIn', {
              seconds: countdown,
              defaultValue: 'Retrying in {{seconds}}s',
            })}
          </span>
        ) : !status.canRetry ? (
          <span className="text-xs text-red-400" data-testid="exhausted">
            {t('retry.exhausted', 'All retries exhausted')}
          </span>
        ) : null}

        <div className="flex gap-2 ml-auto">
          <button
            className={cn(
              'text-xs px-3 py-1 rounded',
              status.canRetry
                ? 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 cursor-pointer'
                : 'bg-gray-500/20 text-gray-500 cursor-not-allowed',
            )}
            onClick={onRetry}
            disabled={!status.canRetry}
            data-testid="retry-button"
          >
            {t('retry.retryNow', 'Retry Now')}
          </button>
          <button
            className={cn(
              'text-xs px-3 py-1 rounded',
              status.canAbort
                ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30 cursor-pointer'
                : 'bg-gray-500/20 text-gray-500 cursor-not-allowed',
            )}
            onClick={onAbort}
            disabled={!status.canAbort}
            data-testid="abort-button"
          >
            {t('retry.abort', 'Abort')}
          </button>
        </div>
      </div>
    </div>
  );
};

/**
 * Panel displaying error recovery state for failed operations.
 * Shows retry status, countdown timers, and manual retry/abort controls.
 */
export const ErrorRecoveryPanel: React.FC<ErrorRecoveryPanelProps> = ({
  executionId,
  className,
}) => {
  const { t } = useTranslation();
  const { getRetryStatuses, manualRetry, abort, getCountdown } = useRetryManager();
  const statuses = getRetryStatuses(executionId);

  return (
    <div className={cn('flex flex-col gap-4 p-4', className)} data-testid="error-recovery-panel">
      <h3 className="text-sm font-semibold text-[var(--vscode-editor-foreground)]">
        {t('retry.title', 'Error Recovery')}
      </h3>

      {statuses.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-emerald-400" data-testid="no-failures">
          <span>&#10003;</span>
          <span>{t('retry.noFailures', 'No failed operations')}</span>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {statuses.map((status) => (
            <RetryRow
              key={`${status.executionId}-${status.objectName}`}
              status={status}
              countdown={status.nextRetryAt !== null ? getCountdown(status.nextRetryAt) : 0}
              onRetry={() => manualRetry(executionId, status.objectName)}
              onAbort={() => abort(executionId, status.objectName)}
            />
          ))}
        </div>
      )}
    </div>
  );
};
