import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Clock,
  Plus,
  Trash2,
  Play,
  Pause,
  CheckCircle,
  XCircle,
  AlertTriangle,
} from 'lucide-react';
import { cn } from '../../theme';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { DataTable } from '../../components/ui/DataTable';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { formatDuration } from '../../utils/formatters';
import type {
  ScheduledOperation,
  ScheduledOperationRun,
  ScheduleFrequency,
  SchedulableOperation,
} from '@sandforge/shared';

/** Response from scheduler list. */
interface SchedulerListPayload {
  schedules: ScheduledOperation[];
  history: ScheduledOperationRun[];
}

/** Frequency options. */
const FREQUENCIES: ScheduleFrequency[] = ['hourly', 'daily', 'weekly', 'monthly'];

/** Operation types. */
const OPERATION_TYPES: SchedulableOperation[] = ['backup', 'sync', 'cleanup'];

/** Day of week labels. */
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Format ISO date to relative time. */
function formatRelativeTime(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (Math.abs(diff) < 60_000) return 'just now';
  const minutes = Math.round(Math.abs(diff) / 60_000);
  if (minutes < 60) return diff > 0 ? `in ${minutes}m` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return diff > 0 ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return diff > 0 ? `in ${days}d` : `${days}d ago`;
}

/** Status icon for a run. */
function runStatusIcon(status: ScheduledOperationRun['status']): React.ReactNode {
  switch (status) {
    case 'success':
      return <CheckCircle className="w-4 h-4 text-green-400" />;
    case 'failure':
      return <XCircle className="w-4 h-4 text-red-400" />;
    case 'partial':
      return <AlertTriangle className="w-4 h-4 text-amber-400" />;
  }
}

/** Add schedule form inline. */
const AddScheduleForm: React.FC<{
  onSubmit: (schedule: Omit<ScheduledOperation, 'id' | 'lastRunAt' | 'nextRunAt'>) => void;
  onCancel: () => void;
}> = ({ onSubmit, onCancel }) => {
  const { t } = useTranslation();
  const [opType, setOpType] = useState<SchedulableOperation>('backup');
  const [frequency, setFrequency] = useState<ScheduleFrequency>('daily');
  const [time, setTime] = useState('02:00');
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [dayOfMonth, setDayOfMonth] = useState(1);

  const handleSubmit = () => {
    onSubmit({
      operationType: opType,
      frequency,
      time,
      enabled: true,
      ...(frequency === 'weekly' ? { dayOfWeek } : {}),
      ...(frequency === 'monthly' ? { dayOfMonth } : {}),
    });
  };

  return (
    <div
      className="rounded-lg border border-active bg-surface-2 p-4 flex flex-col gap-3"
      data-testid="add-schedule-form"
    >
      <div className="grid grid-cols-2 gap-3">
        {/* Operation type */}
        <div>
          <label className="text-xs text-text-secondary block mb-1">
            {t('scheduler.operationType', 'Operation Type')}
          </label>
          <select
            className="w-full bg-surface-1 border border-subtle rounded px-2 py-1.5 text-xs text-text-primary"
            value={opType}
            onChange={(e) => setOpType(e.target.value as SchedulableOperation)}
            data-testid="select-op-type"
          >
            {OPERATION_TYPES.map((op) => (
              <option key={op} value={op}>
                {t(`scheduler.opTypes.${op}`, op)}
              </option>
            ))}
          </select>
        </div>

        {/* Frequency */}
        <div>
          <label className="text-xs text-text-secondary block mb-1">
            {t('scheduler.frequency', 'Frequency')}
          </label>
          <select
            className="w-full bg-surface-1 border border-subtle rounded px-2 py-1.5 text-xs text-text-primary"
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as ScheduleFrequency)}
            data-testid="select-frequency"
          >
            {FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {t(`scheduler.frequencies.${f}`, f)}
              </option>
            ))}
          </select>
        </div>

        {/* Time */}
        <div>
          <label className="text-xs text-text-secondary block mb-1">
            {t('scheduler.time', 'Time')}
          </label>
          <input
            type="time"
            className="w-full bg-surface-1 border border-subtle rounded px-2 py-1.5 text-xs text-text-primary"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            data-testid="input-time"
          />
        </div>

        {/* Day of week (shown for weekly) */}
        {frequency === 'weekly' && (
          <div>
            <label className="text-xs text-text-secondary block mb-1">
              {t('scheduler.dayOfWeek', 'Day of Week')}
            </label>
            <select
              className="w-full bg-surface-1 border border-subtle rounded px-2 py-1.5 text-xs text-text-primary"
              value={dayOfWeek}
              onChange={(e) => setDayOfWeek(Number(e.target.value))}
              data-testid="select-day-of-week"
            >
              {DAY_LABELS.map((label, idx) => (
                <option key={idx} value={idx}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Day of month (shown for monthly) */}
        {frequency === 'monthly' && (
          <div>
            <label className="text-xs text-text-secondary block mb-1">
              {t('scheduler.dayOfMonth', 'Day of Month')}
            </label>
            <input
              type="number"
              min={1}
              max={28}
              className="w-full bg-surface-1 border border-subtle rounded px-2 py-1.5 text-xs text-text-primary"
              value={dayOfMonth}
              onChange={(e) => setDayOfMonth(Number(e.target.value))}
              data-testid="input-day-of-month"
            />
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel} data-testid="cancel-add">
          {t('common.cancel', 'Cancel')}
        </Button>
        <Button variant="primary" size="sm" onClick={handleSubmit} data-testid="confirm-add">
          {t('scheduler.addSchedule', 'Add Schedule')}
        </Button>
      </div>
    </div>
  );
};

/** Batch Operation Scheduler panel with schedule list and history table. */
export const SchedulerPanel: React.FC = () => {
  const { t } = useTranslation();
  const [showAddForm, setShowAddForm] = useState(false);

  const listQuery = useBridgeQuery<SchedulerListPayload>('scheduler:list', undefined, {
    responseType: 'scheduler:list:response',
  });

  const upsertMutation = useBridgeMutation<{ success: boolean; schedule?: ScheduledOperation }>(
    'scheduler:upsert',
    { responseType: 'scheduler:upsert:response' },
  );

  const deleteMutation = useBridgeMutation<{ success: boolean }>('scheduler:delete', {
    responseType: 'scheduler:delete:response',
  });

  const toggleMutation = useBridgeMutation<{ success: boolean; schedule?: ScheduledOperation }>(
    'scheduler:toggle',
    { responseType: 'scheduler:toggle:response' },
  );

  const schedules = listQuery.data?.schedules ?? [];
  const history = listQuery.data?.history ?? [];

  const handleAddSchedule = (
    schedule: Omit<ScheduledOperation, 'id' | 'lastRunAt' | 'nextRunAt'>,
  ) => {
    const id = `sched-${Date.now()}`;
    upsertMutation.mutate({
      schedule: { ...schedule, id },
    });
    setShowAddForm(false);
    setTimeout(() => listQuery.refetch(), 500);
  };

  const handleDelete = (scheduleId: string) => {
    deleteMutation.mutate({ scheduleId });
    setTimeout(() => listQuery.refetch(), 500);
  };

  const handleToggle = (scheduleId: string, enabled: boolean) => {
    toggleMutation.mutate({ scheduleId, enabled });
    setTimeout(() => listQuery.refetch(), 500);
  };

  return (
    <div className="flex flex-col gap-4" data-testid="scheduler-panel">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Clock className="w-5 h-5 text-text-secondary" />
          <h3 className="text-sm font-semibold text-text-primary">
            {t('scheduler.title', 'Batch Operation Scheduler')}
          </h3>
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => setShowAddForm(true)}
          disabled={showAddForm}
          data-testid="add-schedule-btn"
        >
          <Plus className="w-3.5 h-3.5 mr-1" />
          {t('scheduler.addSchedule', 'Add Schedule')}
        </Button>
      </div>

      {/* Add form */}
      {showAddForm && (
        <AddScheduleForm onSubmit={handleAddSchedule} onCancel={() => setShowAddForm(false)} />
      )}

      {/* Schedules list */}
      {schedules.length === 0 && !showAddForm ? (
        <div
          className="flex flex-col items-center justify-center py-8 text-center"
          data-testid="scheduler-empty"
        >
          <Clock className="w-10 h-10 text-text-muted mb-3" />
          <p className="text-sm text-text-secondary">
            {t(
              'scheduler.emptyDescription',
              'No scheduled operations. Click "Add Schedule" to create recurring backup, sync, or cleanup operations.',
            )}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2" data-testid="schedules-list">
          {schedules.map((schedule) => (
            <div
              key={schedule.id}
              className={cn(
                'rounded-lg border bg-surface-1 p-3 flex items-center gap-3',
                schedule.enabled ? 'border-subtle' : 'border-subtle opacity-60',
              )}
              data-testid={`schedule-${schedule.id}`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <Badge variant={schedule.enabled ? 'success' : 'default'}>
                    {t(`scheduler.opTypes.${schedule.operationType}`, schedule.operationType)}
                  </Badge>
                  <span className="text-xs text-text-secondary">
                    {t(`scheduler.frequencies.${schedule.frequency}`, schedule.frequency)} @{' '}
                    {schedule.time}
                  </span>
                  {schedule.frequency === 'weekly' && schedule.dayOfWeek !== undefined && (
                    <span className="text-xs text-text-muted">
                      ({DAY_LABELS[schedule.dayOfWeek]})
                    </span>
                  )}
                  {schedule.frequency === 'monthly' && schedule.dayOfMonth !== undefined && (
                    <span className="text-xs text-text-muted">
                      ({t('scheduler.dayLabel', 'day')} {schedule.dayOfMonth})
                    </span>
                  )}
                </div>
                {schedule.nextRunAt && (
                  <span className="text-[11px] text-text-muted">
                    {t('scheduler.nextRun', 'Next run')}: {formatRelativeTime(schedule.nextRunAt)}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleToggle(schedule.id, !schedule.enabled)}
                  data-testid={`toggle-${schedule.id}`}
                >
                  {schedule.enabled ? (
                    <Pause className="w-3.5 h-3.5" />
                  ) : (
                    <Play className="w-3.5 h-3.5" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDelete(schedule.id)}
                  data-testid={`delete-${schedule.id}`}
                >
                  <Trash2 className="w-3.5 h-3.5 text-red-400" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* History table */}
      {history.length > 0 && (
        <div data-testid="history-section">
          <h4 className="text-xs font-semibold text-text-primary mb-2">
            {t('scheduler.history', 'Operation History')}
          </h4>
          <DataTable
            columns={[
              {
                key: 'status',
                header: t('common.status', 'Status'),
                render: (run) => (
                  <div className="flex items-center gap-1.5">
                    {runStatusIcon(run.status)}
                    <span className="text-text-primary capitalize">{run.status}</span>
                  </div>
                ),
              },
              {
                key: 'operationType',
                header: t('common.type', 'Type'),
                render: (run) => (
                  <span className="text-text-secondary capitalize">{run.operationType}</span>
                ),
              },
              {
                key: 'startedAt',
                header: t('scheduler.startedAt', 'Started'),
                render: (run) => (
                  <span className="text-text-secondary">{formatRelativeTime(run.startedAt)}</span>
                ),
              },
              {
                key: 'durationMs',
                header: t('scheduler.duration', 'Duration'),
                align: 'right',
                render: (run) => (
                  <span className="text-text-secondary tabular-nums">
                    {formatDuration(run.durationMs)}
                  </span>
                ),
              },
              {
                key: 'recordsProcessed',
                header: t('scheduler.records', 'Records'),
                align: 'right',
                render: (run) => (
                  <span className="text-text-secondary tabular-nums">
                    {run.recordsProcessed.toLocaleString()}
                  </span>
                ),
              },
            ]}
            data={history
              .slice(-10)
              .reverse()
              .map((run) => ({ ...run }))}
            keyExtractor={(run) => run.id}
          />
        </div>
      )}
    </div>
  );
};
