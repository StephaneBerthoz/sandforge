import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { useSyncScheduleStore } from '../../stores/useSyncScheduleStore';
import type { SyncScheduleUpsertPayload } from '../../stores/useSyncScheduleStore';
import { SkeletonTable } from '../../components/ui/SkeletonTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { Icon } from '../../components/ui/Icon';
import { Card, CardBody } from '../../components/ui/Card';
import { CronScheduleBuilder, cronToHuman } from './CronScheduleBuilder';
import type { CronScheduleFormData } from './CronScheduleBuilder';
import type { SyncScheduleEntry } from '@sandforge/shared';

/** Map last result to badge variant. */
const resultVariant: Record<string, BadgeVariant> = {
  success: 'success',
  partial: 'warning',
  failure: 'error',
};

/**
 * SyncSchedulePanel lists all sync schedules with management actions
 * (pause/resume, edit, delete) and a "New Schedule" button.
 */
export const SyncSchedulePanel: React.FC = () => {
  const { t } = useTranslation();
  const { schedules, loading, fetchSchedules, upsertSchedule, toggleSchedule, deleteSchedule } =
    useSyncScheduleStore();

  const [showBuilder, setShowBuilder] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<SyncScheduleEntry | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    fetchSchedules();
  }, [fetchSchedules]);

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

  // Mock configs for the builder (in production, these would come from a store)
  const availableConfigs = [{ id: 'cfg-default', name: t('sync.schedules.defaultConfig') }];

  if (showBuilder) {
    return (
      <div data-testid="sync-schedule-panel">
        <CronScheduleBuilder
          initialName={editingSchedule?.name}
          initialCron={editingSchedule?.cron}
          initialTimezone={editingSchedule?.timezone}
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
        <EmptyState
          title={t('sync.schedules.emptyTitle')}
          description={t('sync.schedules.emptyDesc')}
          module="sync"
          actionLabel={t('sync.schedules.createFirst')}
          onAction={() => setShowBuilder(true)}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[var(--sf-space-3)]" data-testid="sync-schedule-panel">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-primary">{t('sync.schedules.title')}</h3>
        <button
          type="button"
          className="text-xs px-3 py-1.5 rounded bg-[var(--sf-button-bg)] text-[var(--sf-button-fg)] hover:bg-[var(--sf-button-hover)]"
          onClick={() => setShowBuilder(true)}
          data-testid="new-schedule-btn"
        >
          <Icon name="add" /> {t('sync.schedules.newSchedule')}
        </button>
      </div>

      {/* Schedule list */}
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
                  {schedule.lastResult && (
                    <Badge variant={resultVariant[schedule.lastResult] ?? 'default'}>
                      {t(`sync.schedules.result_${schedule.lastResult}`)}
                    </Badge>
                  )}
                </div>
                <div className="flex gap-[var(--sf-space-3)] text-[10px] text-text-secondary">
                  <span>{cronToHuman(schedule.cron)}</span>
                  <span>{schedule.timezone}</span>
                  {schedule.nextRunAt && (
                    <span>
                      {t('sync.schedules.nextRun')}:{' '}
                      {format(new Date(schedule.nextRunAt), 'yyyy-MM-dd HH:mm')}
                    </span>
                  )}
                  {schedule.lastRunAt && (
                    <span>
                      {t('sync.schedules.lastRun')}:{' '}
                      {format(new Date(schedule.lastRunAt), 'yyyy-MM-dd HH:mm')}
                    </span>
                  )}
                </div>
              </div>
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
                  className="text-[10px] px-2 py-1 rounded bg-[var(--sf-button-secondary-bg)] text-[var(--sf-button-secondary-fg)] hover:bg-[var(--sf-button-secondary-hover)]"
                  onClick={() => handleEdit(schedule)}
                  data-testid={`edit-btn-${schedule.id}`}
                >
                  <Icon name="edit" />
                </button>
                {confirmDeleteId === schedule.id ? (
                  <div className="flex gap-1">
                    <button
                      type="button"
                      className="text-[10px] px-2 py-1 rounded bg-[var(--sf-error)] text-white"
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
                    data-testid={`delete-btn-${schedule.id}`}
                  >
                    <Icon name="trash" />
                  </button>
                )}
              </div>
            </div>
          </CardBody>
        </Card>
      ))}
    </div>
  );
};
