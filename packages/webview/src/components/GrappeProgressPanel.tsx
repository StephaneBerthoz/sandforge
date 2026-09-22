import React from 'react';
import { useTranslation } from 'react-i18next';
import { ProgressAnnouncer, ProgressBar } from './ui/ProgressBar';
import { Badge } from './ui/Badge';
import { cn } from '../theme';
import { useGrappeStore } from '../stores/useGrappeStore';
import { uiLocale } from '../utils/formatters';

/**
 * Panel displaying grappe (cluster) operation progress.
 * Shows partition progress and worker status.
 * Only renders when a grappe operation is active or recently completed.
 */
export const GrappeProgressPanel: React.FC<{
  /**
   * Say the run's progress in a live region. Off inside a page that already
   * announces the run the partitions belong to: two polite regions would each
   * speak on their own schedule.
   */
  announce?: boolean;
}> = ({ announce = true }) => {
  const { t } = useTranslation();
  const {
    active,
    operationId,
    totalPartitions,
    totalRecords,
    partitions,
    totalProcessed,
    totalFailed,
  } = useGrappeStore();

  if (!active && !operationId) {
    return null;
  }

  const completedPartitions = Array.from(partitions.values()).filter(
    (p) => p.percentage >= 100,
  ).length;

  const overallPercent =
    totalPartitions > 0 ? Math.round((completedPartitions / totalPartitions) * 100) : 0;

  return (
    <div
      data-testid="grappe-panel"
      className={cn(
        'rounded border p-3 flex flex-col gap-2',
        'border-[var(--sf-border)]',
        'bg-[var(--sf-bg-primary)]',
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge variant={active ? 'warning' : 'success'}>
            {active ? t('grappe.active', 'Grappe') : t('grappe.completed', 'Completed')}
          </Badge>
          <span className="text-xs text-[var(--sf-text-primary)]">
            {t('grappe.partitions', 'Partitions')}: {completedPartitions}/{totalPartitions}
          </span>
        </div>
      </div>

      {/* Overall progress */}
      <ProgressBar
        value={active ? overallPercent : 100}
        max={100}
        showPercent
        variant={!active && totalFailed === 0 ? 'success' : totalFailed > 0 ? 'error' : 'default'}
        ariaLabel={t('a11y.runProgress', { name: t('nav.grappe') })}
      />
      {announce && (
        <ProgressAnnouncer
          message={t('a11y.progressAnnouncement', {
            name: t('nav.grappe'),
            percent: active ? overallPercent : 100,
          })}
          immediate={!active}
          testId="grappe-progress-status"
        />
      )}

      {/* Stats */}
      <div
        className="flex gap-4 text-[10px] text-[var(--sf-text-secondary)]"
        data-testid="grappe-stats"
      >
        <span>
          {t('grappe.totalRecords', 'Records')}: {totalRecords.toLocaleString(uiLocale())}
        </span>
        {!active && (
          <>
            <span className="text-status-success">
              {totalProcessed.toLocaleString(uiLocale())} {t('grappe.processed', 'processed')}
            </span>
            {totalFailed > 0 && (
              <span className="text-status-error">
                {totalFailed.toLocaleString(uiLocale())} {t('grappe.failed', 'failed')}
              </span>
            )}
          </>
        )}
      </div>

      {/* Partition list (collapsed for space, show only active partitions) */}
      {active && partitions.size > 0 && (
        <div className="flex flex-col gap-1 max-h-24 overflow-y-auto">
          {Array.from(partitions.values())
            .filter((p) => p.percentage < 100)
            .slice(0, 5)
            .map((p) => (
              <div
                key={p.grappeId}
                className="flex items-center gap-2 text-[10px]"
                data-testid={`grappe-partition-${p.grappeId}`}
              >
                <span className="w-28 truncate text-[var(--sf-text-secondary)]">{p.grappeId}</span>
                <ProgressBar
                  value={p.percentage}
                  max={100}
                  size="sm"
                  className="flex-1"
                  ariaLabel={p.grappeId}
                />
                <span className="w-12 text-right text-[var(--sf-text-secondary)]">
                  {p.percentage}%
                </span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
};
