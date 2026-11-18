import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type {
  PipelineApprovalRecord,
  PipelineHistoryEntry,
  PipelineHistoryStatus,
  PipelineRunsOutside,
  PipelineStepResult,
} from '@sandforge/shared';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { formatDuration } from '../../utils/formatters';
import { formatTriggerTime } from './TriggerConfigPanel';
import { historyOutsideLine } from './pipelineOutside';
import { SeeInReportsButton } from '../Reports/SeeInReportsButton';

/** A saved pipeline a launcher starts since an export, as History names it. */
export interface HistoryOutsidePipeline {
  pipelineId: string;
  name: string;
  runsOutside: PipelineRunsOutside;
}

/** PipelineHistoryView component props. */
export interface PipelineHistoryViewProps {
  entries?: PipelineHistoryEntry[];
  onSelectRun?: (runId: string) => void;
  /**
   * The saved pipelines a launcher starts since an export: History says whose
   * runs it lists of each, the ones on this machine, and not a CI's.
   */
  outside?: readonly HistoryOutsidePipeline[];
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
      // A schedule that fell due is not a refresh noticed: said as one, its
      // start read as a sandbox refreshed at that time.
      if (entry.triggeredBy !== 'schedule') return t('automation.missed.cannotRun', { time });
      return many
        ? t('automation.missed.cannotRunScheduleMany', { n, first: time, last })
        : t('automation.missed.cannotRunSchedule', { time });
  }
}

/**
 * How an Approval step was answered, in the reader's language: approved or
 * rejected, where, and when — or that nobody answered in time, or its run was
 * cancelled while it waited.
 */
export function approvalLine(record: PipelineApprovalRecord, t: TFunction): string {
  const time = formatTriggerTime(record.at) ?? t('common.dateUnknown');
  // A run of the command line was answered at its terminal, or ahead by
  // `--approve`: said as one of the page, it named a page nobody had open.
  switch (record.decision) {
    case 'approved':
      switch (record.via) {
        case 'notification':
          return t('automation.approval.record.approvedOnNotification', { time });
        case 'terminal':
          return t('automation.approval.record.approvedAtTerminal', { time });
        case 'commandLine':
          return t('automation.approval.record.approvedAhead', { time });
        default:
          return t('automation.approval.record.approvedOnPage', { time });
      }
    case 'rejected':
      switch (record.via) {
        case 'notification':
          return t('automation.approval.record.rejectedOnNotification', { time });
        case 'terminal':
          return t('automation.approval.record.rejectedAtTerminal', { time });
        case 'commandLine':
          return t('automation.approval.record.rejectedOnCommandLine', { time });
        default:
          return t('automation.approval.record.rejectedOnPage', { time });
      }
    case 'timedOut':
      return t('automation.approval.record.timedOut', { time });
    case 'cancelled':
      return t('automation.approval.record.cancelled', { time });
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
  stopped: 'default',
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
  outside = [],
}) => {
  const { t } = useTranslation();

  // Whose runs History lists, for each pipeline a launcher starts: a cron or
  // a scheduled task of this machine keeps them where History reads them, a
  // CI does not.
  // A list inside the note: a note role on the list itself takes its list
  // semantics away, and its items are then items of nothing.
  const outsideNote =
    outside.length > 0 ? (
      <div
        role="note"
        className="rounded-lg border border-dashed border-subtle bg-surface-1 px-3 py-2 text-xs text-(--sf-text-secondary)"
        data-testid="history-outside"
      >
        <ul className="flex flex-col gap-0.5">
          {outside.map((pipeline) => (
            <li key={pipeline.pipelineId} data-testid={`history-outside-${pipeline.pipelineId}`}>
              {historyOutsideLine(pipeline.name, pipeline.runsOutside, t)}
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  if (entries.length === 0) {
    return (
      <div className="flex flex-col gap-2" data-testid="pipeline-history">
        {outsideNote}
        <EmptyState
          icon={<Icon name="history" />}
          title={t('automation.noHistory')}
          description={t('automation.noHistoryDesc')}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="pipeline-history">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-(--sf-text-primary)">
          {t('automation.history')}
        </h3>
        <SeeInReportsButton tab="audit" testId="pipeline-history-reports" />
      </div>
      {outsideNote}
      {entries.map((entry) => (
        <div key={entry.runId} data-testid={`history-${entry.runId}`}>
          <Card hoverable onClick={() => onSelectRun?.(entry.runId)}>
            {/* The start in the reader's language and time zone, as the
                Scheduler and Reports write a date: it was the ISO string the
                extension keeps, in UTC. */}
            <CardHeader
              title={entry.pipelineName}
              subtitle={formatTriggerTime(entry.startTime) ?? t('common.dateUnknown')}
              action={
                <span className="flex items-center gap-1.5">
                  {/* A run `sandforge pipeline run` made on this machine:
                      the editor did not run it, nor keep it. */}
                  {entry.ranFrom === 'commandLine' && (
                    <Badge variant="info" data-testid={`history-command-line-${entry.runId}`}>
                      {t('automation.ranFromCommandLine')}
                    </Badge>
                  )}
                  <Badge variant={STATUS_VARIANT[entry.status]}>
                    {t(`automation.runStatuses.${entry.status}`)}
                  </Badge>
                </span>
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
              {/* What runs it with VS Code closed: the export, whose
                  launcher runs the whole pipeline. A list of one command per
                  step left out its Conditions, Approvals and the values its
                  steps hand on, and ran no pipeline. */}
              {(entry.missed?.reason === 'closed' || entry.missed?.reason === 'asleep') && (
                <p
                  className="mt-1 text-xs text-(--sf-text-secondary)"
                  data-testid={`history-missed-export-${entry.runId}`}
                >
                  {t('automation.missed.export')}
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
                        <span
                          className={
                            step.error && step.status !== 'stopped'
                              ? 'text-status-error'
                              : undefined
                          }
                        >
                          {step.error ?? step.summary}
                        </span>
                      )}
                      {step.approval && (
                        <span data-testid={`history-approval-${entry.runId}-${index}`}>
                          {approvalLine(step.approval, t)}
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
