import React from 'react';
import { useTranslation } from 'react-i18next';
import type { PipelineStepResult, PipelineRunStatus } from '@sandforge/shared';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { cn } from '../../theme';
import { formatDurationSec } from '../../utils/formatters';

/** Execution view data. */
export interface PipelineExecutionData {
  runId: string;
  pipelineName: string;
  status: PipelineRunStatus;
  steps: PipelineStepResult[];
  startTime: string;
  elapsed: number;
  progress: number;
}

/**
 * PipelineExecutionView props. There is no pause control: a run asked to pause
 * stopped where it was, and nothing ever took it up again, so a run offers
 * only to be cancelled.
 */
export interface PipelineExecutionViewProps {
  execution?: PipelineExecutionData;
  onCancel?: () => void;
  className?: string;
}

/** Badge variant for step status. */
function stepStatusBadge(status: PipelineStepResult['status']): BadgeVariant {
  switch (status) {
    case 'completed':
      return 'success';
    case 'running':
      return 'info';
    case 'failed':
      return 'error';
    case 'skipped':
      return 'default';
    default:
      return 'default';
  }
}

/** Badge variant for run status. */
function runStatusBadge(status: PipelineRunStatus): BadgeVariant {
  switch (status) {
    case 'completed':
      return 'success';
    case 'completed_with_warnings':
      return 'warning';
    case 'running':
      return 'info';
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'error';
    default:
      return 'default';
  }
}

/**
 * Real-time pipeline execution view showing step-by-step progress,
 * overall status, and a cancel control.
 */
export const PipelineExecutionView: React.FC<PipelineExecutionViewProps> = ({
  execution,
  onCancel,
  className,
}) => {
  const { t } = useTranslation();

  if (!execution) {
    return (
      <div
        className={cn('text-xs text-center py-8 text-text-secondary', className)}
        data-testid="execution-empty"
      >
        {t('automation.noExecution', 'No active execution')}
      </div>
    );
  }

  const isActive = execution.status === 'running';
  const completedSteps = execution.steps.filter((s) => s.status === 'completed').length;
  const failedSteps = execution.steps.filter((s) => s.status === 'failed').length;

  return (
    <div className={cn('flex flex-col gap-3', className)} data-testid="execution-view">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-[var(--sf-text-primary,#d4d4d4)]">
            {execution.pipelineName}
          </span>
          <span data-testid="execution-status">
            <Badge variant={runStatusBadge(execution.status)}>
              {t(`automation.runStatuses.${execution.status}`)}
            </Badge>
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isActive && onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="text-[10px] px-2 py-0.5 rounded bg-status-error text-[var(--sf-bg-primary)] cursor-pointer"
              data-testid="execution-cancel"
            >
              {t('automation.cancel', 'Cancel')}
            </button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div data-testid="execution-progress">
        <ProgressBar value={execution.progress} max={100} ariaLabel={t('common.progress')} />
      </div>

      {/* Stats row */}
      <div className="flex gap-4 text-[10px] text-text-secondary" data-testid="execution-stats">
        <span>
          {t('automation.stepsDone', { done: completedSteps, count: execution.steps.length })}
        </span>
        {failedSteps > 0 && (
          <span className="text-status-error">
            {t('automation.failedStepCount', { count: failedSteps })}
          </span>
        )}
        <span>{formatDurationSec(execution.elapsed)}</span>
      </div>

      {/* Step list: each step as the host last reported it. A step that has
          done its work says what it did, in the host's words. */}
      <div className="flex flex-col gap-1" data-testid="execution-steps">
        {execution.steps.map((step) => (
          <div
            key={step.stepId}
            className={cn(
              'flex flex-wrap items-center justify-between px-2 py-1.5 rounded text-xs',
              'border border-[var(--sf-border,#3c3c3c)]',
              step.status === 'running' && 'bg-status-info/10',
            )}
            data-testid={`exec-step-${step.stepId}`}
          >
            <div className="flex items-center gap-2">
              {step.status === 'running' && (
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--sf-info,#3B82F6)] animate-pulse" />
              )}
              {step.status === 'completed' && (
                <span className="text-status-success">{'\u2713'}</span>
              )}
              {step.status === 'failed' && <span className="text-status-error">{'\u2717'}</span>}
              {step.status === 'pending' && (
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--sf-text-muted,#868686)]" />
              )}
              {step.status === 'skipped' && <span className="text-text-secondary">{'\u2014'}</span>}
              <span className="text-[var(--sf-text-primary,#d4d4d4)]">{step.stepName}</span>
              <Badge variant="default">{t(`automation.stepTypes.${step.stepType}`)}</Badge>
            </div>
            <div className="flex items-center gap-2">
              {step.duration !== undefined && step.duration > 0 && (
                <span
                  className={
                    step.status === 'running' ? 'text-text-primary' : 'text-text-secondary'
                  }
                >
                  {formatDurationSec(Math.round(step.duration / 1000))}
                </span>
              )}
              <span data-testid={`exec-step-status-${step.stepId}`}>
                <Badge variant={stepStatusBadge(step.status)}>
                  {t(`automation.runStatuses.${step.status}`)}
                </Badge>
              </span>
            </div>
            {step.summary && (
              <p
                className={cn(
                  'w-full text-[10px]',
                  step.status === 'running' ? 'text-text-primary' : 'text-text-secondary',
                )}
                data-testid={`exec-step-summary-${step.stepId}`}
              >
                {step.summary}
              </p>
            )}
          </div>
        ))}
      </div>

      {/* Error details */}
      {execution.steps.some((s) => s.error) && (
        <div className="flex flex-col gap-1" data-testid="execution-errors">
          {execution.steps
            .filter((s) => s.error)
            .map((s) => (
              <div
                key={`error-${s.stepId}`}
                className="text-[10px] px-2 py-1 rounded bg-status-error/10 text-status-error border border-status-error/40"
                data-testid={`exec-error-${s.stepId}`}
              >
                <strong>{s.stepName}:</strong> {s.error}
              </div>
            ))}
        </div>
      )}
    </div>
  );
};
