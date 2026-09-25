import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type {
  PipelineHistoryEntry,
  PipelineHistoryStatus,
  PipelineStepResult,
} from '@sandforge/shared';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { EmptyState } from '../../components/ui/EmptyState';
import { formatDuration } from '../../utils/formatters';
import { formatTriggerTime } from './TriggerConfigPanel';

/** PipelineHistoryView component props. */
export interface PipelineHistoryViewProps {
  entries?: PipelineHistoryEntry[];
  onSelectRun?: (runId: string) => void;
}

const STATUS_VARIANT: Record<
  PipelineHistoryStatus,
  'default' | 'success' | 'warning' | 'error' | 'info'
> = {
  idle: 'default',
  queued: 'info',
  running: 'info',
  completed: 'success',
  completed_with_warnings: 'warning',
  failed: 'error',
  cancelled: 'default',
  missed: 'warning',
};

/**
 * Why a trigger's start was not made, in the reader's language: when it fell
 * due, how many fell due, and what was in the way.
 */
function missedLine(entry: PipelineHistoryEntry, t: TFunction): string {
  const missed = entry.missed;
  if (!missed) return '';
  // A time the extension sent that is not a date is said to be unknown:
  // formatting it threw, and the history did not render.
  const unknown = t('common.dateUnknown');
  const time = formatTriggerTime(entry.startTime) ?? unknown;
  const n = missed.atLeast ? `${missed.count}+` : String(missed.count);
  const last = missed.lastDueAt ? (formatTriggerTime(missed.lastDueAt) ?? unknown) : time;
  const since = missed.busySince ? (formatTriggerTime(missed.busySince) ?? unknown) : '';
  const many = missed.count > 1;
  switch (missed.reason) {
    case 'closed':
      return many
        ? t('automation.missed.closedMany', { n, first: time, last })
        : t('automation.missed.closed', { time });
    case 'asleep':
      return many
        ? t('automation.missed.asleepMany', { n, first: time, last })
        : t('automation.missed.asleep', { time });
    case 'busy':
      if (entry.triggeredBy === 'sandbox_refresh') {
        return t('automation.missed.busyRefresh', { time, since });
      }
      return many
        ? t('automation.missed.busyMany', { n, first: time, last, since })
        : t('automation.missed.busy', { time, since });
    case 'cannotRun':
      return t('automation.missed.cannotRun', { time });
  }
}

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
      <h3 className="text-xs font-semibold text-(--sf-text-primary)">{t('automation.history')}</h3>
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
              <div className="flex gap-4 text-xs text-(--sf-text-secondary)">
                <span>
                  {t('automation.triggeredBy')}: {t(`automation.triggerTypes.${entry.triggeredBy}`)}
                </span>
                {/* A missed start ran nothing: no duration, no step to count. */}
                {!entry.missed && (
                  <>
                    <span>
                      {t('automation.duration')}: {formatDuration(entry.duration)}
                    </span>
                    <span>{t('automation.stepCount', { count: entry.stepCount })}</span>
                  </>
                )}
                {entry.errorCount > 0 && (
                  <span className="text-status-error">
                    {t('automation.errorCount', { count: entry.errorCount })}
                  </span>
                )}
              </div>
              {entry.missed && (
                <p
                  className="mt-2 text-xs text-(--sf-text-secondary)"
                  data-testid={`history-missed-${entry.runId}`}
                >
                  {missedLine(entry, t)}
                  {entry.missed.detail && (
                    <span className="block font-mono">{entry.missed.detail}</span>
                  )}
                </p>
              )}
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
                      className="flex flex-wrap items-center gap-2 text-xs text-(--sf-text-secondary)"
                    >
                      <span className="font-medium text-(--sf-text-primary)">{step.stepName}</span>
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
