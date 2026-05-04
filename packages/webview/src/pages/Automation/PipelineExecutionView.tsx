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

/** PipelineExecutionView props. */
export interface PipelineExecutionViewProps {
  execution?: PipelineExecutionData;
  onPause?: () => void;
  onResume?: () => void;
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
    case 'paused':
      return 'warning';
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
 * overall status, and pause/resume/cancel controls.
 */
export const PipelineExecutionView: React.FC<PipelineExecutionViewProps> = ({
  execution,
  onPause,
  onResume,
  onCancel,
  className,
}) => {
  const { t } = useTranslation();

  if (!execution) {
    return (
      <div
        className={cn('text-xs text-center py-8 text-[var(--sf-text-muted,#868686)]', className)}
        data-testid="execution-empty"
      >
        {t('automation.noExecution', 'No active execution')}
      </div>
    );
  }

  const isActive =
    execution.status === 'running' ||
    execution.status === 'paused' ||
    execution.status === 'waiting_approval';
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
          {isActive && execution.status === 'running' && onPause && (
            <button
              onClick={onPause}
              className="text-[10px] px-2 py-0.5 rounded bg-[var(--sf-warning,#F59E0B)] text-black cursor-pointer"
              data-testid="execution-pause"
            >
              {t('automation.pause', 'Pause')}
            </button>
          )}
          {execution.status === 'paused' && onResume && (
            <button
              onClick={onResume}
              className="text-[10px] px-2 py-0.5 rounded bg-[var(--sf-info,#3B82F6)] text-white cursor-pointer"
              data-testid="execution-resume"
            >
              {t('automation.resume', 'Resume')}
            </button>
          )}
          {isActive && onCancel && (
            <button
              onClick={onCancel}
              className="text-[10px] px-2 py-0.5 rounded bg-[var(--sf-error,#EF4444)] text-white cursor-pointer"
              data-testid="execution-cancel"
            >
              {t('automation.cancel', 'Cancel')}
            </button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div data-testid="execution-progress">
        <ProgressBar value={execution.progress} max={100} />
      </div>

      {/* Stats row */}
      <div
        className="flex gap-4 text-[10px] text-[var(--sf-text-muted,#868686)]"
        data-testid="execution-stats"
      >
        <span>
          {completedSteps}/{execution.steps.length} {t('automation.steps', 'steps')}
        </span>
        {failedSteps > 0 && (
          <span style={{ color: 'var(--sf-error, #EF4444)' }}>
            {failedSteps} {t('automation.failed', 'failed')}
          </span>
        )}
        <span>{formatDurationSec(execution.elapsed)}</span>
      </div>

      {/* Step list */}
      <div className="flex flex-col gap-1" data-testid="execution-steps">
        {execution.steps.map((step) => (
          <div
            key={step.stepId}
            className={cn(
              'flex items-center justify-between px-2 py-1.5 rounded text-xs',
              'border border-[var(--sf-border,#3c3c3c)]',
              step.status === 'running' && 'bg-[var(--sf-bg-active,#1a3a5c)]',
            )}
            data-testid={`exec-step-${step.stepId}`}
          >
            <div className="flex items-center gap-2">
              {step.status === 'running' && (
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--sf-info,#3B82F6)] animate-pulse" />
              )}
              {step.status === 'completed' && (
                <span className="text-[var(--sf-success,#22C55E)]">{'\u2713'}</span>
              )}
              {step.status === 'failed' && (
                <span className="text-[var(--sf-error,#EF4444)]">{'\u2717'}</span>
              )}
              {step.status === 'pending' && (
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--sf-text-muted,#868686)]" />
              )}
              {step.status === 'skipped' && (
                <span className="text-[var(--sf-text-muted,#868686)]">{'\u2014'}</span>
              )}
              <span className="text-[var(--sf-text-primary,#d4d4d4)]">{step.stepName}</span>
              <Badge variant="default">{t(`automation.stepTypes.${step.stepType}`)}</Badge>
            </div>
            <div className="flex items-center gap-2">
              {step.duration !== undefined && step.duration > 0 && (
                <span className="text-[var(--sf-text-muted,#868686)]">
                  {formatDurationSec(Math.round(step.duration / 1000))}
                </span>
              )}
              <span data-testid={`exec-step-status-${step.stepId}`}>
                <Badge variant={stepStatusBadge(step.status)}>
                  {t(`automation.runStatuses.${step.status}`)}
                </Badge>
              </span>
            </div>
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
                className="text-[10px] px-2 py-1 rounded bg-[var(--sf-error,#EF4444)]/10 text-[var(--sf-error,#EF4444)] border border-[var(--sf-error,#EF4444)]/30"
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
