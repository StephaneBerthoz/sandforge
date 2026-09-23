import React from 'react';
import { useTranslation } from 'react-i18next';
import type {
  PipelineHistoryEntry,
  PipelineRunStatus,
  PipelineStepResult,
} from '@sandforge/shared';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { EmptyState } from '../../components/ui/EmptyState';
import { formatDuration } from '../../utils/formatters';

/** PipelineHistoryView component props. */
export interface PipelineHistoryViewProps {
  entries?: PipelineHistoryEntry[];
  onSelectRun?: (runId: string) => void;
}

const STATUS_VARIANT: Record<
  PipelineRunStatus,
  'default' | 'success' | 'warning' | 'error' | 'info'
> = {
  idle: 'default',
  queued: 'info',
  running: 'info',
  completed: 'success',
  completed_with_warnings: 'warning',
  failed: 'error',
  cancelled: 'default',
};

const STEP_STATUS_VARIANT: Record<
  PipelineStepResult['status'],
  'default' | 'success' | 'warning' | 'error' | 'info'
> = {
  pending: 'default',
  running: 'info',
  completed: 'success',
  failed: 'error',
  skipped: 'default',
};

/**
 * View of pipeline execution history. Each run lists its steps, with how long
 * each took and what it did or why it failed, in the host's words — a
 * backup's records, a comparison's differences. Runs written before steps
 * were kept show none.
 */
export const PipelineHistoryView: React.FC<PipelineHistoryViewProps> = ({
  entries = [],
  onSelectRun,
}) => {
  const { t } = useTranslation();

  if (entries.length === 0) {
    return (
      <div data-testid="pipeline-history">
        <EmptyState
          icon="📜"
          title={t('automation.noHistory')}
          description={t('automation.history')}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="pipeline-history">
      <h3 className="text-xs font-semibold text-[var(--sf-text-primary)]">
        {t('automation.history')}
      </h3>
      {entries.map((entry) => (
        <div key={entry.runId} data-testid={`history-${entry.runId}`}>
          <Card hoverable onClick={() => onSelectRun?.(entry.runId)}>
            <CardHeader
              title={entry.pipelineName}
              subtitle={entry.startTime}
              action={
                <Badge variant={STATUS_VARIANT[entry.status]}>
                  {t(`automation.runStatuses.${entry.status}`)}
                </Badge>
              }
            />
            <CardBody>
              <div className="flex gap-4 text-xs text-[var(--sf-text-secondary)]">
                <span>
                  {t('automation.triggeredBy')}: {t(`automation.triggerTypes.${entry.triggeredBy}`)}
                </span>
                <span>
                  {t('automation.duration')}: {formatDuration(entry.duration)}
                </span>
                <span>
                  {entry.stepCount} {t('automation.steps')}
                </span>
                {entry.errorCount > 0 && (
                  <span className="text-status-error">
                    {entry.errorCount} {t('automation.errors')}
                  </span>
                )}
              </div>
              {entry.steps && entry.steps.length > 0 && (
                <ol
                  className="mt-2 flex flex-col gap-1"
                  aria-label={t('automation.steps')}
                  data-testid={`history-steps-${entry.runId}`}
                >
                  {entry.steps.map((step, index) => (
                    <li
                      // Steps have no id of their own here, and a name can
                      // repeat; the list is written once, in run order.
                      key={`${index}:${step.stepName}`}
                      className="flex flex-wrap items-center gap-2 text-xs text-[var(--sf-text-secondary)]"
                    >
                      <span className="font-medium text-[var(--sf-text-primary)]">
                        {step.stepName}
                      </span>
                      <Badge variant={STEP_STATUS_VARIANT[step.status]}>
                        {t(`automation.runStatuses.${step.status}`)}
                      </Badge>
                      {step.duration !== undefined && <span>{formatDuration(step.duration)}</span>}
                      {(step.error ?? step.summary) && (
                        <span className={step.error ? 'text-status-error' : undefined}>
                          {step.error ?? step.summary}
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </CardBody>
          </Card>
        </div>
      ))}
    </div>
  );
};
