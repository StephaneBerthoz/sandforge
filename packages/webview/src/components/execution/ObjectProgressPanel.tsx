import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ObjectProgress } from '@sandforge/shared';
import { cn } from '../../theme';
import { ProgressBar } from '../ui/ProgressBar';
import { SkeletonPanel } from '../ui/SkeletonPanel';
import { useExecutionProgress } from '../../hooks/useExecutionProgress';

/** Props for ObjectProgressPanel. */
export interface ObjectProgressPanelProps {
  /** Execution ID to track. */
  executionId: string;
  /** Additional CSS classes. */
  className?: string;
}

/** Map object state to ProgressBar variant. */
function stateToVariant(state: ObjectProgress['state']): 'default' | 'success' | 'warning' | 'error' {
  switch (state) {
    case 'complete':
      return 'success';
    case 'failed':
    case 'aborted':
      return 'error';
    case 'processing':
      return 'default';
    case 'queued':
    default:
      return 'warning';
  }
}

/** Map object state to badge color classes. */
function stateBadgeClass(state: ObjectProgress['state']): string {
  switch (state) {
    case 'complete':
      return 'bg-emerald-500/20 text-emerald-400';
    case 'failed':
    case 'aborted':
      return 'bg-red-500/20 text-red-400';
    case 'processing':
      return 'bg-blue-500/20 text-blue-400';
    case 'queued':
    default:
      return 'bg-gray-500/20 text-gray-400';
  }
}

/** Format elapsed milliseconds as "Xm Ys". */
function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Panel displaying per-object progress bars for a running execution.
 * Uses the useExecutionProgress hook to subscribe to real-time updates.
 */
export const ObjectProgressPanel: React.FC<ObjectProgressPanelProps> = ({
  executionId,
  className,
}) => {
  const { t } = useTranslation();
  const { getProgress } = useExecutionProgress();
  const progress = getProgress(executionId);

  if (!progress) {
    return (
      <div className={cn('p-4', className)} data-testid="object-progress-empty">
        <SkeletonPanel sections={1} />
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-4 p-4', className)} data-testid="object-progress-panel">
      {/* Overall progress */}
      <div className="flex flex-col gap-1">
        <div className="flex justify-between items-center">
          <span className="text-sm font-medium text-[var(--vscode-editor-foreground)]">
            {t('execution.overallProgress', 'Overall Progress')}
          </span>
          <span className="text-xs text-[var(--vscode-descriptionForeground)]">
            {t('execution.elapsed', { time: formatElapsed(progress.elapsedMs), defaultValue: 'Elapsed: {{time}}' })}
          </span>
        </div>
        <ProgressBar
          value={progress.overallPercent}
          max={100}
          showPercent
          variant="default"
        />
      </div>

      {/* Per-object progress rows */}
      <div className="flex flex-col gap-3" data-testid="object-progress-list">
        {progress.objects.map((obj) => (
          <div key={obj.jobId} className="flex flex-col gap-1" data-testid="object-progress-row">
            <div className="flex justify-between items-center">
              <span className="text-sm text-[var(--vscode-editor-foreground)]">
                {obj.objectName}
              </span>
              <span className={cn('text-xs px-2 py-0.5 rounded', stateBadgeClass(obj.state))}>
                {t(`execution.${obj.state}`, obj.state)}
              </span>
            </div>
            <ProgressBar
              value={obj.recordsProcessed}
              max={obj.totalRecords || 1}
              showPercent
              variant={stateToVariant(obj.state)}
            />
            <div className="flex justify-between text-xs text-[var(--vscode-descriptionForeground)]">
              <span>
                {t('execution.recordsOf', {
                  processed: obj.recordsProcessed,
                  total: obj.totalRecords,
                  defaultValue: '{{processed}} / {{total}} records',
                })}
              </span>
              {obj.recordsFailed > 0 && (
                <span className="text-red-400" data-testid="failed-count">
                  {t('execution.failedRecords', { count: obj.recordsFailed, defaultValue: '{{count}} failed' })}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
