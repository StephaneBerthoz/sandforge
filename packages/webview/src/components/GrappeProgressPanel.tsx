import React from 'react';
import { useTranslation } from 'react-i18next';
import { ProgressBar } from './ui/ProgressBar';
import { Badge } from './ui/Badge';
import { cn } from '../theme';
import { useGrappeStore } from '../stores/useGrappeStore';

/**
 * Panel displaying grappe (cluster) operation progress.
 * Shows partition progress, back-pressure level, and worker status.
 * Only renders when a grappe operation is active or recently completed.
 */
export const GrappeProgressPanel: React.FC = () => {
  const { t } = useTranslation();
  const {
    active,
    operationId,
    totalPartitions,
    totalRecords,
    partitions,
    backPressureLevel,
    apiUsagePercent,
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
    totalPartitions > 0
      ? Math.round((completedPartitions / totalPartitions) * 100)
      : 0;

  const bpVariant =
    backPressureLevel === 'critical'
      ? 'error'
      : backPressureLevel === 'warning'
        ? 'warning'
        : 'success';

  return (
    <div
      data-testid="grappe-panel"
      className={cn(
        'rounded border p-3 flex flex-col gap-2',
        'border-[var(--vscode-panel-border,#3c3c3c)]',
        'bg-[var(--vscode-editor-background,#1e1e1e)]',
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge variant={active ? 'warning' : 'success'}>
            {active ? t('grappe.active', 'Grappe') : t('grappe.completed', 'Completed')}
          </Badge>
          <span className="text-xs text-[var(--vscode-editor-foreground,#d4d4d4)]">
            {t('grappe.partitions', 'Partitions')}: {completedPartitions}/{totalPartitions}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={bpVariant}>
            {t(`grappe.pressure.${backPressureLevel}`, backPressureLevel)}
          </Badge>
          {apiUsagePercent > 0 && (
            <span className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)]">
              API {apiUsagePercent}%
            </span>
          )}
        </div>
      </div>

      {/* Overall progress */}
      <ProgressBar
        value={active ? overallPercent : 100}
        max={100}
        showPercent
        variant={!active && totalFailed === 0 ? 'success' : totalFailed > 0 ? 'error' : 'default'}
      />

      {/* Stats */}
      <div
        className="flex gap-4 text-[10px] text-[var(--vscode-descriptionForeground,#868686)]"
        data-testid="grappe-stats"
      >
        <span>{t('grappe.totalRecords', 'Records')}: {totalRecords.toLocaleString()}</span>
        {!active && (
          <>
            <span className="text-[var(--vscode-testing-iconPassed,#73c991)]">
              {totalProcessed.toLocaleString()} {t('grappe.processed', 'processed')}
            </span>
            {totalFailed > 0 && (
              <span className="text-[var(--vscode-errorForeground,#f48771)]">
                {totalFailed.toLocaleString()} {t('grappe.failed', 'failed')}
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
                <span className="w-28 truncate text-[var(--vscode-descriptionForeground,#868686)]">
                  {p.grappeId}
                </span>
                <ProgressBar value={p.percentage} max={100} size="sm" className="flex-1" />
                <span className="w-12 text-right text-[var(--vscode-descriptionForeground,#868686)]">
                  {p.percentage}%
                </span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
};
