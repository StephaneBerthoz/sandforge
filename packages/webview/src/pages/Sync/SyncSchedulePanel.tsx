import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { useMessageListener } from '../../hooks/useMessageBus';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useSyncScheduleStore } from '../../stores/useSyncScheduleStore';
import type { SyncScheduleUpsertPayload } from '../../stores/useSyncScheduleStore';
import { SkeletonTable } from '../../components/ui/SkeletonTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { Icon } from '../../components/ui/Icon';
import { Card, CardBody } from '../../components/ui/Card';
import { CronScheduleBuilder, cronToHuman } from './CronScheduleBuilder';
import type { CronScheduleFormData } from './CronScheduleBuilder';
import type { SyncConfigListResponse, SyncScheduleEntry } from '@sandforge/shared';
import { formatStoredDate } from '../../utils/formatters';

/**
 * How a schedule's last result reads: its badge colour and its word. A run
 * cancelled from Live Operations reads as cancelled, in the neutral colour
 * Home gives a cancelled operation: it was stored as partial, and read as a
 * run whose records had been refused.
 */
const LAST_RESULT_BADGES: Record<
  NonNullable<SyncScheduleEntry['lastResult']>,
  { variant: BadgeVariant; labelKey: string }
> = {
  success: { variant: 'success', labelKey: 'sync.schedules.result_success' },
  partial: { variant: 'warning', labelKey: 'sync.schedules.result_partial' },
  failure: { variant: 'error', labelKey: 'sync.schedules.result_failure' },
  cancelled: { variant: 'default', labelKey: 'sync.schedules.result_cancelled' },
};

/** A schedule's last result as its badge; nothing for a value no build writes. */
export const LastResultBadge: React.FC<{
  result: NonNullable<SyncScheduleEntry['lastResult']>;
}> = ({ result }) => {
  const { t } = useTranslation();
  const badge = LAST_RESULT_BADGES[result];
  if (!badge) return null;
  return <Badge variant={badge.variant}>{t(badge.labelKey)}</Badge>;
};

/**
 * The picker label of a saved configuration. A changed configuration is saved
 * as a new entry under the same name as the one before it, so the name alone
 * can list the same text twice; the time it was saved tells them apart.
 */
function configLabel(config: SyncConfigListResponse['payload']['configs'][number]): string {
  const savedAt = new Date(config.updatedAt);
  return Number.isNaN(savedAt.getTime())
    ? config.name
    : `${config.name} · ${format(savedAt, 'yyyy-MM-dd HH:mm:ss')}`;
}

/** How often the host looks for a due schedule: SyncScheduleExecutor's tick. */
const HOST_TICK_MS = 60_000;

/** The longest one timer waits: setTimeout fires at once past 2^31 - 1 ms. */
const MAX_REFRESH_WAIT_MS = 6 * 60 * 60_000;

/**
 * How long until the list is worth asking for again: one tick after the
 * soonest run an active schedule plans, then every tick while one is due,
 * since the host moves `nextRunAt` and writes `lastResult` only once that run
 * has ended. Undefined when no active schedule plans a run.
 *
 * The host answers the list when asked and never on its own: without asking
 * again, the next run and the last result stay as they were read, over a run
 * that has happened since.
 */
export function nextRefreshDelay(
  schedules: readonly SyncScheduleEntry[],
  now: number,
): number | undefined {
  let soonest = Number.POSITIVE_INFINITY;
  for (const schedule of schedules) {
    if (!schedule.enabled || !schedule.nextRunAt) continue;
    const at = Date.parse(schedule.nextRunAt);
    if (Number.isFinite(at)) soonest = Math.min(soonest, at);
  }
  if (soonest === Number.POSITIVE_INFINITY) return undefined;
  return Math.min(Math.max(soonest - now, 0) + HOST_TICK_MS, MAX_REFRESH_WAIT_MS);
}

/** What a layout of the schedules is given: the list, and each schedule's buttons. */
export interface ScheduleLayoutProps {
  schedules: SyncScheduleEntry[];
  /** Pause or resume, edit, and delete behind a confirmation: what the host lets a schedule do. */
  actionsFor: (schedule: SyncScheduleEntry) => React.ReactNode;
}

/** SyncSchedulePanel props. */
export interface SyncSchedulePanelProps {
  /**
   * How the schedules are laid out. The Sync tab lists them as cards; the
   * Automation calendar lays them out by the day they next run.
   */
  layout?: React.ComponentType<ScheduleLayoutProps>;
}

/** The Sync tab's layout: one card per schedule, in the order the host lists them. */
const ScheduleCards: React.FC<ScheduleLayoutProps> = ({ schedules, actionsFor }) => {
  const { t } = useTranslation();
  return (
    <>
      {schedules.map((schedule) => (
        <Card key={schedule.id} data-testid={`schedule-card-${schedule.id}`}>
          <CardBody>
            <div className="flex items-center justify-between">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-[var(--sf-space-2)]">
                  <span className="text-xs font-semibold text-text-primary">{schedule.name}</span>
                  <Badge variant={schedule.enabled ? 'success' : 'default'}>
                    {schedule.enabled ? t('sync.schedules.active') : t('sync.schedules.paused')}
                  </Badge>
                  {schedule.lastResult && <LastResultBadge result={schedule.lastResult} />}
                </div>
                <div className="flex gap-[var(--sf-space-3)] text-[10px] text-text-secondary">
                  <span>{cronToHuman(schedule.cron, t)}</span>
                  <span>{schedule.timezone}</span>
                  {/* The host keeps `nextRunAt` on pause: on a paused schedule
                      that time is not a run, as the agenda already knew. */}
                  {schedule.enabled && schedule.nextRunAt && (
                    <span>
                      {t('sync.schedules.nextRun')}:{' '}
                      {formatStoredDate(schedule.nextRunAt, 'yyyy-MM-dd HH:mm') ??
                        t('common.dateUnknown')}
                    </span>
                  )}
                  {schedule.lastRunAt && (
                    <span>
                      {t('sync.schedules.lastRun')}:{' '}
                      {formatStoredDate(schedule.lastRunAt, 'yyyy-MM-dd HH:mm') ??
                        t('common.dateUnknown')}
                    </span>
                  )}
                </div>
              </div>
              {actionsFor(schedule)}
            </div>
          </CardBody>
        </Card>
      ))}
    </>
  );
};

/**
 * SyncSchedulePanel lists all sync schedules with management actions
 * (pause/resume, edit, delete) and a "New Schedule" button.
 *
 * A schedule runs a *saved* sync configuration by id, so the builder offers
 * the configurations `sync:config:list` returns and nothing else: the panel
 * used to offer one made-up `cfg-default`, and every schedule built on it
 * named a configuration the executor could never load.
 */
export const SyncSchedulePanel: React.FC<SyncSchedulePanelProps> = ({
  layout: Layout = ScheduleCards,
}) => {
  const { t } = useTranslation();
  const {
    schedules,
    loading,
    error,
    fetchSchedules,
    upsertSchedule,
    toggleSchedule,
    deleteSchedule,
  } = useSyncScheduleStore();

  // The store sends the four schedule requests but subscribed to none of the
  // answers: the list stayed empty and loading stayed on for ever.
  const handleMessage = useSyncScheduleStore((s) => s.handleMessage);
  useMessageListener('sync:schedule:list:response', handleMessage);
  useMessageListener('sync:schedule:upsert:response', handleMessage);
  useMessageListener('sync:schedule:toggle:response', handleMessage);
  useMessageListener('sync:schedule:delete:response', handleMessage);
  useMessageListener('sync:schedule:error', handleMessage);

  const configsQuery = useBridgeQuery<SyncConfigListResponse['payload']>(
    'sync:config:list',
    undefined,
    { responseType: 'sync:config:list:response' },
  );
  const availableConfigs = useMemo(
    () => (configsQuery.data?.configs ?? []).map((c) => ({ id: c.id, name: configLabel(c) })),
    [configsQuery.data],
  );
  const canCreate = availableConfigs.length > 0;
  // "No configuration saved" is only true once the list has answered: while
  // it is loading, or after it was refused, nothing is known yet.
  const noSavedConfig = !canCreate && !configsQuery.loading && !configsQuery.error;

  const [showBuilder, setShowBuilder] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<SyncScheduleEntry | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    fetchSchedules();
  }, [fetchSchedules]);

  // Ask again once the soonest planned run is past: see nextRefreshDelay.
  useEffect(() => {
    const delay = nextRefreshDelay(schedules, Date.now());
    if (delay === undefined) return undefined;
    const timer = setTimeout(fetchSchedules, delay);
    return () => clearTimeout(timer);
  }, [schedules, fetchSchedules]);

  const handleSubmit = useCallback(
    (data: CronScheduleFormData) => {
      const payload: SyncScheduleUpsertPayload = {
        id: editingSchedule?.id ?? `sched-${Date.now()}`,
        name: data.name,
        configId: data.configId,
        cron: data.cron,
        timezone: data.timezone,
        enabled: editingSchedule?.enabled ?? true,
        maxRetries: data.maxRetries,
        notifyOnComplete: data.notifyOnComplete,
        notifyOnFailure: data.notifyOnFailure,
        createdAt: editingSchedule?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: editingSchedule?.version ?? 1,
      };
      upsertSchedule(payload);
      setShowBuilder(false);
      setEditingSchedule(null);
    },
    [editingSchedule, upsertSchedule],
  );

  const handleEdit = useCallback((schedule: SyncScheduleEntry) => {
    setEditingSchedule(schedule);
    setShowBuilder(true);
  }, []);

  const handleDelete = useCallback(
    (scheduleId: string) => {
      deleteSchedule(scheduleId);
      setConfirmDeleteId(null);
    },
    [deleteSchedule],
  );

  const handleCancel = useCallback(() => {
    setShowBuilder(false);
    setEditingSchedule(null);
  }, []);

  // Edit and delete are icons: without a name of their own, a screen reader
  // announced two unnamed buttons after Pause.
  const actionsFor = (schedule: SyncScheduleEntry): React.ReactNode => (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className="text-[10px] px-2 py-1 rounded bg-[var(--sf-button-secondary-bg)] text-[var(--sf-button-secondary-fg)] hover:bg-[var(--sf-button-secondary-hover)]"
        onClick={() => toggleSchedule(schedule.id, !schedule.enabled)}
        data-testid={`toggle-btn-${schedule.id}`}
      >
        {schedule.enabled ? t('sync.schedules.pause') : t('sync.schedules.resume')}
      </button>
      <button
        type="button"
        className="text-[10px] px-2 py-1 rounded bg-[var(--sf-button-secondary-bg)] text-[var(--sf-button-secondary-fg)] hover:bg-[var(--sf-button-secondary-hover)] disabled:opacity-50"
        onClick={() => handleEdit(schedule)}
        disabled={!canCreate}
        aria-label={t('sync.schedules.editNamed', { name: schedule.name })}
        data-testid={`edit-btn-${schedule.id}`}
      >
        <Icon name="edit" />
      </button>
      {confirmDeleteId === schedule.id ? (
        <div className="flex gap-1">
          <button
            type="button"
            className="text-[10px] px-2 py-1 rounded bg-status-error text-[var(--sf-bg-primary)]"
            onClick={() => handleDelete(schedule.id)}
            data-testid={`confirm-delete-btn-${schedule.id}`}
          >
            {t('common.confirm')}
          </button>
          <button
            type="button"
            className="text-[10px] px-2 py-1 rounded bg-[var(--sf-button-secondary-bg)] text-[var(--sf-button-secondary-fg)]"
            onClick={() => setConfirmDeleteId(null)}
            data-testid={`cancel-delete-btn-${schedule.id}`}
          >
            {t('common.cancel')}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="text-[10px] px-2 py-1 rounded bg-[var(--sf-button-secondary-bg)] text-[var(--sf-button-secondary-fg)] hover:bg-[var(--sf-button-secondary-hover)]"
          onClick={() => setConfirmDeleteId(schedule.id)}
          aria-label={t('sync.schedules.deleteNamed', { name: schedule.name })}
          data-testid={`delete-btn-${schedule.id}`}
        >
          <Icon name="trash" />
        </button>
      )}
    </div>
  );

  if (showBuilder) {
    return (
      <div data-testid="sync-schedule-panel">
        <CronScheduleBuilder
          initialName={editingSchedule?.name}
          initialCron={editingSchedule?.cron}
          initialTimezone={editingSchedule?.timezone}
          // The builder leaves the picker empty when this configuration is no
          // longer saved, so the schedule is never moved onto another silently.
          initialConfigId={editingSchedule?.configId}
          initialMaxRetries={editingSchedule?.maxRetries}
          initialNotifyOnComplete={editingSchedule?.notifyOnComplete}
          initialNotifyOnFailure={editingSchedule?.notifyOnFailure}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
          configs={availableConfigs}
        />
      </div>
    );
  }

  // The host answers a refused list, upsert, toggle or delete on
  // `sync:schedule:error`. Nothing rendered it, so the request simply appeared
  // to do nothing. A refused configuration list is shown the same way, rather
  // than read as no configuration saved.
  const shownError = error ?? configsQuery.error;
  const errorBanner = shownError ? (
    <ErrorBanner message={shownError} data-testid="sync-schedule-error" />
  ) : null;

  if (loading && schedules.length === 0) {
    return (
      <div data-testid="sync-schedule-panel">
        <SkeletonTable rows={3} columns={5} />
      </div>
    );
  }

  if (!loading && schedules.length === 0) {
    return (
      <div data-testid="sync-schedule-panel">
        {errorBanner}
        <EmptyState
          title={t('sync.schedules.emptyTitle')}
          description={
            noSavedConfig ? t('sync.schedules.noSavedConfig') : t('sync.schedules.emptyDesc')
          }
          module="sync"
          actionLabel={canCreate ? t('sync.schedules.createFirst') : undefined}
          onAction={canCreate ? () => setShowBuilder(true) : undefined}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[var(--sf-space-3)]" data-testid="sync-schedule-panel">
      {errorBanner}
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-primary">{t('sync.schedules.title')}</h3>
        {noSavedConfig && (
          <p className="text-[10px] text-text-secondary" data-testid="sync-schedule-no-config">
            {t('sync.schedules.noSavedConfig')}
          </p>
        )}
        <button
          type="button"
          className="text-xs px-3 py-1.5 rounded bg-[var(--sf-button-bg)] text-[var(--sf-button-fg)] hover:bg-[var(--sf-button-hover)] disabled:opacity-50"
          onClick={() => setShowBuilder(true)}
          disabled={!canCreate}
          data-testid="new-schedule-btn"
        >
          <Icon name="add" /> {t('sync.schedules.newSchedule')}
        </button>
      </div>

      <Layout schedules={schedules} actionsFor={actionsFor} />
    </div>
  );
};
