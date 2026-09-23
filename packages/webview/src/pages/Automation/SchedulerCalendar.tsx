import React from 'react';
import { useTranslation } from 'react-i18next';
import { addDays, format } from 'date-fns';
import type { PipelineTrigger, PipelineTriggerStatus, SyncScheduleEntry } from '@sandforge/shared';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { SyncSchedulePanel } from '../Sync/SyncSchedulePanel';
import type { ScheduleLayoutProps } from '../Sync/SyncSchedulePanel';
import { dateTimeFormat } from '../../utils/formatters';
import { formatTriggerTime } from './TriggerConfigPanel';

/** A schedule trigger of a saved pipeline, with what the extension says of it. */
export interface PipelineScheduleRow {
  pipelineId: string;
  pipelineName: string;
  trigger: PipelineTrigger;
  /** Absent until the extension has answered for the saved pipeline. */
  status?: PipelineTriggerStatus;
}

/** Where a schedule sits in the agenda. */
export type AgendaGroupKind = 'due' | 'day' | 'unplanned' | 'paused';

/** One heading of the agenda and the schedules under it. */
export interface AgendaGroup {
  kind: AgendaGroupKind;
  /** The day the runs fall on, `yyyy-MM-dd` in the reader's time zone; `day` groups only. */
  day?: string;
  schedules: SyncScheduleEntry[];
}

/** When a schedule's next run is planned, or undefined when the host planned none. */
function plannedAt(schedule: SyncScheduleEntry): number | undefined {
  if (!schedule.nextRunAt) return undefined;
  const at = Date.parse(schedule.nextRunAt);
  return Number.isFinite(at) ? at : undefined;
}

/**
 * The schedules by when they next run, as the host planned it:
 *
 * - `due`: active, and the planned run is already past. The host runs it at
 *   its next check, once a minute, and moves the time on only when the run
 *   ends, so a schedule running now is here too.
 * - one `day` group per day, in order, each soonest first.
 * - `unplanned`: active, but its cron gave the host no next run.
 * - `paused`: nothing runs until it is resumed. The host keeps the old
 *   `nextRunAt` on pause, so that time is not a run and is not shown as one.
 */
export function groupByNextRun(
  schedules: readonly SyncScheduleEntry[],
  now: number,
): AgendaGroup[] {
  const due: SyncScheduleEntry[] = [];
  const days = new Map<string, SyncScheduleEntry[]>();
  const unplanned: SyncScheduleEntry[] = [];
  const paused: SyncScheduleEntry[] = [];

  const byTime = [...schedules].sort(
    (a, b) =>
      (plannedAt(a) ?? Number.POSITIVE_INFINITY) - (plannedAt(b) ?? Number.POSITIVE_INFINITY),
  );
  for (const schedule of byTime) {
    const at = plannedAt(schedule);
    if (!schedule.enabled) {
      paused.push(schedule);
    } else if (at === undefined) {
      unplanned.push(schedule);
    } else if (at <= now) {
      due.push(schedule);
    } else {
      const day = format(at, 'yyyy-MM-dd');
      days.set(day, [...(days.get(day) ?? []), schedule]);
    }
  }

  const groups: AgendaGroup[] = [];
  if (due.length > 0) groups.push({ kind: 'due', schedules: due });
  for (const [day, inDay] of days) groups.push({ kind: 'day', day, schedules: inDay });
  if (unplanned.length > 0) groups.push({ kind: 'unplanned', schedules: unplanned });
  if (paused.length > 0) groups.push({ kind: 'paused', schedules: paused });
  return groups;
}

/** Map a last result to its badge, as the Sync tab shows it. */
const resultVariant: Record<NonNullable<SyncScheduleEntry['lastResult']>, BadgeVariant> = {
  success: 'success',
  partial: 'warning',
  failure: 'error',
};

/** One schedule in the agenda: when it runs, what it is, how its last run went. */
const AgendaEntry: React.FC<{
  schedule: SyncScheduleEntry;
  kind: AgendaGroupKind;
  actions: React.ReactNode;
}> = ({ schedule, kind, actions }) => {
  const { t } = useTranslation();
  const at = plannedAt(schedule);
  // Under a day heading, the hour is enough; a due run is shown with its date.
  const shownAt =
    at === undefined || kind === 'paused' || kind === 'unplanned'
      ? undefined
      : format(at, kind === 'due' ? 'yyyy-MM-dd HH:mm' : 'HH:mm');

  return (
    <li
      className="flex items-center justify-between gap-[var(--sf-space-2)] rounded-lg border border-subtle bg-surface-2 px-3 py-2"
      data-testid={`scheduler-entry-${schedule.id}`}
    >
      <div className="flex min-w-0 items-start gap-[var(--sf-space-3)]">
        {shownAt && (
          <time
            dateTime={schedule.nextRunAt}
            className="text-xs font-semibold tabular-nums text-text-primary"
            data-testid={`scheduler-entry-time-${schedule.id}`}
          >
            {shownAt}
          </time>
        )}
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-[var(--sf-space-2)]">
            <span className="text-xs font-medium text-text-primary">{schedule.name}</span>
            {schedule.lastResult && (
              <Badge variant={resultVariant[schedule.lastResult]}>
                {t(`sync.schedules.result_${schedule.lastResult}`)}
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap gap-x-[var(--sf-space-3)] text-[10px] text-text-secondary">
            <span className="font-mono">{schedule.cron}</span>
            <span>{schedule.timezone}</span>
            {schedule.lastRunAt && (
              <span>
                {t('sync.schedules.lastRun')}:{' '}
                {format(new Date(schedule.lastRunAt), 'yyyy-MM-dd HH:mm')}
              </span>
            )}
          </div>
        </div>
      </div>
      {actions}
    </li>
  );
};

/** The Automation layout of the schedules: an agenda, by the day each next runs. */
const ScheduleAgenda: React.FC<ScheduleLayoutProps> = ({ schedules, actionsFor }) => {
  const { t } = useTranslation();
  const now = Date.now();
  const today = format(now, 'yyyy-MM-dd');
  const tomorrow = format(addDays(now, 1), 'yyyy-MM-dd');
  // The language picked in SandForge, as every date in the panel is written.
  const dayFormat = dateTimeFormat({
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const heading = (group: AgendaGroup): string => {
    if (group.kind === 'due') return t('automation.agenda.due');
    if (group.kind === 'unplanned') return t('automation.agenda.unplanned');
    if (group.kind === 'paused') return t('sync.schedules.paused');
    if (group.day === today) return t('automation.agenda.today');
    if (group.day === tomorrow) return t('automation.agenda.tomorrow');
    return dayFormat.format(new Date(`${group.day}T00:00:00`));
  };

  return (
    <div className="flex flex-col gap-[var(--sf-space-3)]" data-testid="scheduler-agenda">
      {groupByNextRun(schedules, now).map((group) => {
        const key = group.kind === 'day' ? `day-${group.day}` : group.kind;
        const headingId = `scheduler-group-heading-${key}`;
        return (
          <section
            key={key}
            aria-labelledby={headingId}
            className="flex flex-col gap-1"
            data-testid={`scheduler-group-${key}`}
          >
            <h4 id={headingId} className="text-xs font-semibold text-text-primary">
              {heading(group)}
            </h4>
            {group.kind === 'due' && (
              <p className="text-[10px] text-text-secondary">{t('automation.agenda.dueHint')}</p>
            )}
            <ul className="flex flex-col gap-1">
              {group.schedules.map((schedule) => (
                <AgendaEntry
                  key={schedule.id}
                  schedule={schedule}
                  kind={group.kind}
                  actions={actionsFor(schedule)}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
};

/**
 * The schedules of the saved pipelines, each with its next run or why it has
 * none. They are set on the Triggers tab of their pipeline; this lists them.
 */
const PipelineSchedules: React.FC<{ rows: readonly PipelineScheduleRow[] }> = ({ rows }) => {
  const { t } = useTranslation();
  const headingId = 'scheduler-pipelines-heading';
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-1"
      data-testid="scheduler-pipelines"
    >
      <h4 id={headingId} className="text-xs font-semibold text-text-primary">
        {t('automation.pipelineSchedules.title')}
      </h4>
      {rows.length === 0 ? (
        <p className="text-[10px] text-text-secondary" data-testid="scheduler-pipelines-empty">
          {t('automation.pipelineSchedules.empty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map(({ pipelineId, pipelineName, trigger, status }) => (
            <li
              key={`${pipelineId}:${trigger.id}`}
              className="flex flex-col gap-0.5 rounded-lg border border-subtle bg-surface-2 px-3 py-2"
              data-testid={`scheduler-pipeline-${pipelineId}-${trigger.id}`}
            >
              <span className="text-xs font-medium text-text-primary">{pipelineName}</span>
              <div className="flex flex-wrap gap-x-[var(--sf-space-3)] text-[10px] text-text-secondary">
                <span className="font-mono">{trigger.config.cron}</span>
                {status?.timezone && <span>{status.timezone}</span>}
                {status?.armed && status.nextRunAt ? (
                  <span>
                    {t('automation.triggerNextRun', {
                      time: formatTriggerTime(status.nextRunAt, status.timezone),
                      timezone: status.timezone ?? '',
                    })}
                  </span>
                ) : (
                  status?.idle && <span>{t(`automation.triggerIdle.${status.idle}`)}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

/** SchedulerCalendar props. */
export interface SchedulerCalendarProps {
  /** The schedule triggers of the saved pipelines. */
  pipelineSchedules?: readonly PipelineScheduleRow[];
}

/**
 * The Scheduler tab: every sync schedule, by the day it next runs, with the
 * buttons the Sync tab gives it; then the schedules of the saved pipelines,
 * with the next run of each.
 *
 * A saved sync configuration runs on a timer through `sync:schedule:*`, and
 * a saved pipeline through its schedule trigger, which is edited on the
 * Triggers tab of the pipeline.
 */
export const SchedulerCalendar: React.FC<SchedulerCalendarProps> = ({ pipelineSchedules = [] }) => {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-[var(--sf-space-3)]" data-testid="scheduler-calendar">
      <p className="text-xs text-text-secondary" data-testid="scheduler-intro">
        {t('automation.schedulerIntro')}
      </p>
      <SyncSchedulePanel layout={ScheduleAgenda} />
      <PipelineSchedules rows={pipelineSchedules} />
    </div>
  );
};
