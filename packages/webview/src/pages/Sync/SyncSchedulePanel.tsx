import React, { useEffect, useId, useMemo, useState, useCallback } from 'react';
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
import { Button } from '../../components/ui/Button';
import { CronScheduleBuilder, cronToHuman } from './CronScheduleBuilder';
import type { CronScheduleFormData } from './CronScheduleBuilder';
import type {
  MigrationSaveSyncConfigResponse,
  SyncConfigDeleteResponse,
  SyncConfigListResponse,
  SyncConfigResetDeltaResponse,
  SyncConfigSaveResponse,
  SyncConfigSummary,
  SyncScheduleEntry,
} from '@sandforge/shared';
import { syncConfigNameTaken } from '@sandforge/shared';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
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
  success: { variant: 'success', labelKey: 'syncParts.schedules.result_success' },
  partial: { variant: 'warning', labelKey: 'syncParts.schedules.result_partial' },
  failure: { variant: 'error', labelKey: 'syncParts.schedules.result_failure' },
  cancelled: { variant: 'default', labelKey: 'syncParts.schedules.result_cancelled' },
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

type SavedConfigSummary = SyncConfigListResponse['payload']['configs'][number];

/**
 * The picker label of a saved configuration: its name. A configuration is now
 * saved under a name no other has, but the wizard used to save each changed
 * configuration as a new entry under its pair's name, and those entries are
 * still there: where two share a name, the time each was saved tells them
 * apart.
 */
function configLabel(config: SavedConfigSummary, all: readonly SavedConfigSummary[]): string {
  const savedAt = new Date(config.updatedAt);
  return !syncConfigNameTaken(all, config.name, config.id) || Number.isNaN(savedAt.getTime())
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
  /**
   * Open a saved configuration on the Sync tab's execute step, by its id,
   * under the label the panel lists it by. Given, the panel lists the saved
   * configurations first, each with Open and Delete; the Sync page opens one
   * as SFDMU Import's "Open in Sync" does, where Simulate and Run act on it.
   */
  onOpenConfig?: (configId: string, label: string) => void;
  /** Open SFDMU Import, which turns an SFDMU export.json into a saved configuration. */
  onImportSfdmu?: () => void;
  /** A run or a simulation is under way on the page: nothing else is started. */
  runDisabled?: boolean;
  /**
   * What stands in place of New schedule, and of the first schedule's button
   * when there is none. The Automation calendar puts a way to this page
   * there: its New schedule, right above the pipelines' own schedules, was
   * read as one for the pipeline open.
   */
  createAction?: React.ReactNode;
}

/** A saved configuration as the Saved tab lists it. */
interface SavedConfigRow {
  id: string;
  name: string;
  mode?: SyncConfigSummary['mode'];
  propagateDeletes?: boolean;
  watermarks?: number;
}

/**
 * The saved configurations, each with Open and Delete. They were listed under
 * the schedules, after an empty state that said none existed, with a Run now
 * that wrote at once: no simulation, no checkpoint first, no mute. Open takes
 * one to the Sync tab's execute step, which offers all three; Delete asks
 * first, naming the schedules that run it. A delta configuration says so,
 * and while it holds watermarks offers "Run full next time", which clears
 * them: after a refresh of the target, the one way to read everything again.
 */
const SavedConfigs: React.FC<{
  configs: ReadonlyArray<SavedConfigRow>;
  /** Whether the list has answered: "none saved" is said only then. */
  read: boolean;
  /** How many schedules run each configuration, by its id. */
  schedulesOf: (configId: string) => number;
  onOpen: (configId: string, label: string) => void;
  onImportSfdmu: (() => void) | undefined;
  disabled: boolean;
  onResetDelta: (configId: string, label: string) => void;
  /** The configuration whose watermarks were just cleared, by name. */
  resetDone: string | null;
  resetError: string | null;
  onDelete: (configId: string, label: string) => void;
  /** The configuration just deleted, by name. */
  deleteDone: string | null;
  deleteError: string | null;
}> = ({
  configs,
  read,
  schedulesOf,
  onOpen,
  onImportSfdmu,
  disabled,
  onResetDelta,
  resetDone,
  resetError,
  onDelete,
  deleteDone,
  deleteError,
}) => {
  const { t } = useTranslation();
  const headingId = useId();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-(--sf-space-2)"
      data-testid="sync-saved-configs"
    >
      <h3 id={headingId} className="text-sm font-semibold text-text-primary">
        {t('syncParts.savedConfigs.title')}
      </h3>
      {configs.length > 0 && (
        <p className="text-xs text-text-secondary">{t('syncParts.savedConfigs.hint')}</p>
      )}
      {configs.length === 0 && read && (
        <p className="text-xs text-text-secondary" data-testid="sync-saved-configs-none">
          {t('syncParts.savedConfigs.none')}
        </p>
      )}
      {configs.length > 0 && (
        <ul className="flex flex-col gap-1">
          {configs.map((config) => (
            <li
              key={config.id}
              className="flex flex-col gap-1 text-xs"
              data-testid={`saved-config-${config.id}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-(--sf-space-2)">
                <span className="flex items-center gap-(--sf-space-2) text-text-primary">
                  {config.name}
                  {config.mode === 'delta' && (
                    <Badge variant="info">
                      {config.propagateDeletes
                        ? t('syncParts.delta.withDeletes')
                        : t('syncParts.delta.mode')}
                    </Badge>
                  )}
                </span>
                <span className="flex items-center gap-1">
                  {config.mode === 'delta' && (config.watermarks ?? 0) > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      onClick={() => onResetDelta(config.id, config.name)}
                      aria-label={t('syncParts.savedConfigs.resetDeltaNamed', {
                        name: config.name,
                      })}
                      data-testid={`reset-delta-${config.id}`}
                    >
                      {t('syncParts.savedConfigs.resetDelta')}
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={disabled}
                    onClick={() => onOpen(config.id, config.name)}
                    aria-label={t('syncParts.savedConfigs.openNamed', { name: config.name })}
                    data-testid={`open-saved-config-${config.id}`}
                  >
                    {t('syncParts.savedConfigs.open')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={disabled || confirmDeleteId === config.id}
                    onClick={() => setConfirmDeleteId(config.id)}
                    aria-label={t('syncParts.savedConfigs.deleteNamed', { name: config.name })}
                    data-testid={`delete-config-${config.id}`}
                  >
                    <Icon name="trash" />
                  </Button>
                </span>
              </div>
              {confirmDeleteId === config.id && (
                <div
                  className="flex flex-wrap items-center gap-(--sf-space-2) rounded-sm border border-(--sf-border) p-(--sf-space-2)"
                  role="group"
                  aria-label={t('syncParts.savedConfigs.deleteNamed', { name: config.name })}
                  data-testid={`delete-config-confirm-${config.id}`}
                >
                  <p className="flex-1 min-w-48 text-text-primary">
                    {t('syncParts.savedConfigs.deleteConfirm', { name: config.name })}
                    {schedulesOf(config.id) > 0 && (
                      <>
                        {' '}
                        {t('syncParts.savedConfigs.deleteSchedules', {
                          count: schedulesOf(config.id),
                        })}
                      </>
                    )}
                  </p>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={disabled}
                    onClick={() => {
                      setConfirmDeleteId(null);
                      onDelete(config.id, config.name);
                    }}
                    data-testid={`confirm-delete-config-${config.id}`}
                  >
                    {t('syncParts.savedConfigs.delete')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setConfirmDeleteId(null)}
                    data-testid={`cancel-delete-config-${config.id}`}
                  >
                    {t('common.cancel')}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {resetDone !== null && (
        <p className="text-xs text-text-secondary" role="status" data-testid="reset-delta-done">
          {t('syncParts.savedConfigs.resetDone', { name: resetDone })}
        </p>
      )}
      {resetError !== null && (
        <p className="text-xs text-status-error" role="alert" data-testid="reset-delta-error">
          {resetError}
        </p>
      )}
      {deleteDone !== null && (
        <p className="text-xs text-text-secondary" role="status" data-testid="delete-config-done">
          {t('syncParts.savedConfigs.deleteDone', { name: deleteDone })}
        </p>
      )}
      {deleteError !== null && (
        <p className="text-xs text-status-error" role="alert" data-testid="delete-config-error">
          {deleteError}
        </p>
      )}
      {/* An SFDMU export becomes a saved configuration on SFDMU Import, and
          is listed here once saved: the way there, from where it lands. */}
      {onImportSfdmu && (
        <div
          className="flex flex-wrap items-center justify-between gap-(--sf-space-2) rounded-sm border border-subtle bg-surface-1 p-(--sf-space-2)"
          data-testid="sync-saved-sfdmu"
        >
          <p className="flex-1 min-w-48 text-xs text-text-secondary">
            {t('syncParts.savedConfigs.sfdmuHint')}
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={onImportSfdmu}
            data-testid="sync-saved-sfdmu-btn"
          >
            {t('syncParts.savedConfigs.openSfdmu', { module: t('nav.migration') })}
          </Button>
        </div>
      )}
    </section>
  );
};

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
                <div className="flex items-center gap-(--sf-space-2)">
                  <span className="text-xs font-semibold text-text-primary">{schedule.name}</span>
                  <Badge variant={schedule.enabled ? 'success' : 'default'}>
                    {schedule.enabled
                      ? t('syncParts.schedules.active')
                      : t('syncParts.schedules.paused')}
                  </Badge>
                  {schedule.lastResult && <LastResultBadge result={schedule.lastResult} />}
                </div>
                <div className="flex gap-(--sf-space-3) text-[10px] text-text-secondary">
                  <span>{cronToHuman(schedule.cron, t)}</span>
                  <span>{schedule.timezone}</span>
                  {/* The host keeps `nextRunAt` on pause: on a paused schedule
                      that time is not a run, as the agenda already knew. */}
                  {schedule.enabled && schedule.nextRunAt && (
                    <span>
                      {t('syncParts.schedules.nextRun')}:{' '}
                      {formatStoredDate(schedule.nextRunAt, 'yyyy-MM-dd HH:mm') ??
                        t('common.dateUnknown')}
                    </span>
                  )}
                  {schedule.lastRunAt && (
                    <span>
                      {t('syncParts.schedules.lastRun')}:{' '}
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
 * named a configuration the executor could never load. On the Sync page it
 * lists them too, first, each with Open and Delete (`onOpenConfig`).
 */
export const SyncSchedulePanel: React.FC<SyncSchedulePanelProps> = ({
  layout: Layout = ScheduleCards,
  onOpenConfig,
  onImportSfdmu,
  runDisabled = false,
  createAction,
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
  // A migration saved as a Sync configuration, from the Migration page in
  // this panel or another, is one more a schedule can run: the list is read
  // again rather than left as it was when this panel opened. So is one the
  // Sync wizard saves, in this panel or another: the list stayed as it was,
  // and the Automation calendar open beside it never offered it.
  const { refetch: refetchConfigs } = configsQuery;
  useMessageListener<MigrationSaveSyncConfigResponse>(
    'migration:save-sync-config:response',
    (msg) => {
      if (msg.payload.success) refetchConfigs();
    },
  );
  useMessageListener<SyncConfigSaveResponse>('sync:config:save:response', (msg) => {
    if (msg.payload.success) refetchConfigs();
  });
  const availableConfigs = useMemo(() => {
    const configs = configsQuery.data?.configs ?? [];
    return configs.map((c) => ({ id: c.id, name: configLabel(c, configs) }));
  }, [configsQuery.data]);
  const savedConfigRows = useMemo(
    () =>
      (configsQuery.data?.configs ?? []).map((c, _index, configs): SavedConfigRow => ({
        id: c.id,
        name: configLabel(c, configs),
        mode: c.mode,
        propagateDeletes: c.propagateDeletes,
        watermarks: c.watermarks,
      })),
    [configsQuery.data],
  );

  // "Run full next time": the host clears the watermarks, and the list is
  // read again so the button goes with them.
  const resetDelta = useBridgeMutation<SyncConfigResetDeltaResponse['payload']>(
    'sync:config:reset-delta',
    { responseType: 'sync:config:reset-delta:response' },
  );
  const [resetAsked, setResetAsked] = useState<string | null>(null);
  const { mutate: askReset } = resetDelta;
  const handleResetDelta = useCallback(
    (configId: string, label: string) => {
      setResetAsked(label);
      askReset({ id: configId });
    },
    [askReset],
  );
  const resetAnswer = resetDelta.data;
  useEffect(() => {
    if (resetAnswer?.success) refetchConfigs();
  }, [resetAnswer, refetchConfigs]);

  // Delete, once confirmed: the host deletes the configuration and which
  // record of the target each record of its runs became, and the list is
  // read again so it goes. The host handled it, and nothing sent it.
  const deleteConfig = useBridgeMutation<SyncConfigDeleteResponse['payload']>(
    'sync:config:delete',
    { responseType: 'sync:config:delete:response' },
  );
  const [deleteAsked, setDeleteAsked] = useState<string | null>(null);
  const { mutate: askDelete } = deleteConfig;
  const handleDeleteConfig = useCallback(
    (configId: string, label: string) => {
      setDeleteAsked(label);
      askDelete({ id: configId });
    },
    [askDelete],
  );
  const deleteAnswer = deleteConfig.data;
  useEffect(() => {
    if (deleteAnswer) refetchConfigs();
  }, [deleteAnswer, refetchConfigs]);
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
        className="text-[10px] px-2 py-1 rounded-sm bg-(--sf-button-secondary-bg) text-(--sf-button-secondary-fg) hover:bg-(--sf-button-secondary-hover)"
        onClick={() => toggleSchedule(schedule.id, !schedule.enabled)}
        data-testid={`toggle-btn-${schedule.id}`}
      >
        {schedule.enabled ? t('syncParts.schedules.pause') : t('syncParts.schedules.resume')}
      </button>
      <button
        type="button"
        className="text-[10px] px-2 py-1 rounded-sm bg-(--sf-button-secondary-bg) text-(--sf-button-secondary-fg) hover:bg-(--sf-button-secondary-hover) disabled:opacity-50"
        onClick={() => handleEdit(schedule)}
        disabled={!canCreate}
        aria-label={t('syncParts.schedules.editNamed', { name: schedule.name })}
        data-testid={`edit-btn-${schedule.id}`}
      >
        <Icon name="edit" />
      </button>
      {confirmDeleteId === schedule.id ? (
        <div className="flex gap-1">
          <button
            type="button"
            className="text-[10px] px-2 py-1 rounded-sm bg-status-error text-(--sf-bg-primary)"
            onClick={() => handleDelete(schedule.id)}
            data-testid={`confirm-delete-btn-${schedule.id}`}
          >
            {t('common.confirm')}
          </button>
          <button
            type="button"
            className="text-[10px] px-2 py-1 rounded-sm bg-(--sf-button-secondary-bg) text-(--sf-button-secondary-fg)"
            onClick={() => setConfirmDeleteId(null)}
            data-testid={`cancel-delete-btn-${schedule.id}`}
          >
            {t('common.cancel')}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="text-[10px] px-2 py-1 rounded-sm bg-(--sf-button-secondary-bg) text-(--sf-button-secondary-fg) hover:bg-(--sf-button-secondary-hover)"
          onClick={() => setConfirmDeleteId(schedule.id)}
          aria-label={t('syncParts.schedules.deleteNamed', { name: schedule.name })}
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
    <ErrorBanner message={shownError} code={null} data-testid="sync-schedule-error" />
  ) : null;

  // Read apart from the schedules, and listed first: listed while those load too.
  const savedConfigList = onOpenConfig ? (
    <SavedConfigs
      configs={savedConfigRows}
      read={!configsQuery.loading && !configsQuery.error && configsQuery.data !== null}
      schedulesOf={(configId) => schedules.filter((s) => s.configId === configId).length}
      onOpen={onOpenConfig}
      onImportSfdmu={onImportSfdmu}
      disabled={runDisabled || resetDelta.loading || deleteConfig.loading}
      onResetDelta={handleResetDelta}
      resetDone={resetAnswer?.success && !resetDelta.loading ? resetAsked : null}
      resetError={resetDelta.error}
      onDelete={handleDeleteConfig}
      deleteDone={deleteAnswer?.success && !deleteConfig.loading ? deleteAsked : null}
      deleteError={
        deleteConfig.error ??
        (deleteAnswer && !deleteAnswer.success && deleteAsked !== null
          ? t('syncParts.savedConfigs.deleteGone', { name: deleteAsked })
          : null)
      }
    />
  ) : null;

  if (loading && schedules.length === 0) {
    return (
      <div className="flex flex-col gap-(--sf-space-3)" data-testid="sync-schedule-panel">
        {savedConfigList}
        <SkeletonTable rows={3} columns={5} />
      </div>
    );
  }

  if (!loading && schedules.length === 0) {
    return (
      <div className="flex flex-col gap-(--sf-space-3)" data-testid="sync-schedule-panel">
        {errorBanner}
        {savedConfigList}
        <EmptyState
          title={t('syncParts.schedules.emptyTitle')}
          description={
            noSavedConfig
              ? t('syncParts.schedules.noSavedConfig')
              : t('syncParts.schedules.emptyDesc')
          }
          module="sync"
          actionLabel={
            canCreate && createAction === undefined
              ? t('syncParts.schedules.createFirst')
              : undefined
          }
          onAction={
            canCreate && createAction === undefined ? () => setShowBuilder(true) : undefined
          }
          action={createAction}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-(--sf-space-3)" data-testid="sync-schedule-panel">
      {errorBanner}
      {savedConfigList}
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-primary">
          {t('syncParts.schedules.title')}
        </h3>
        {noSavedConfig && (
          <p className="text-[10px] text-text-secondary" data-testid="sync-schedule-no-config">
            {t('syncParts.schedules.noSavedConfig')}
          </p>
        )}
        {createAction ?? (
          <button
            type="button"
            className="text-xs px-3 py-1.5 rounded-sm bg-(--sf-button-bg) text-(--sf-button-fg) hover:bg-(--sf-button-hover) disabled:opacity-50"
            onClick={() => setShowBuilder(true)}
            disabled={!canCreate}
            data-testid="new-schedule-btn"
          >
            <Icon name="add" /> {t('syncParts.schedules.newSchedule')}
          </button>
        )}
      </div>

      <Layout schedules={schedules} actionsFor={actionsFor} />
    </div>
  );
};
