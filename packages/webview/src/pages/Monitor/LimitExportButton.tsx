import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Download } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { useNotificationStore } from '../../stores/useNotificationStore';
import type { ApiLimit, TrendData } from '@sandforge/shared';

/** Props for the LimitExportButton component. */
export interface LimitExportButtonProps {
  /** Current limits array to export. */
  limits: ApiLimit[];
  /** Trends record keyed by limit name (optional). */
  trends?: Record<string, TrendData>;
}

/**
 * Determines trend direction from sparkline data.
 * @param sparkline - Array of numeric values over time.
 * @returns 'up', 'down', or 'stable'.
 */
function getTrendDirection(sparkline: number[]): string {
  if (sparkline.length < 2) return 'stable';
  const first = sparkline[0];
  const last = sparkline[sparkline.length - 1];
  const diff = last - first;
  const threshold = Math.max(Math.abs(first) * 0.05, 1);
  if (diff > threshold) return 'up';
  if (diff < -threshold) return 'down';
  return 'stable';
}

/**
 * Generates a CSV string from limits and trend data.
 * @param limits - Current API limits.
 * @param trends - Optional trend data keyed by limit name.
 * @returns CSV content string.
 */
export function generateLimitsCsv(
  limits: ApiLimit[],
  trends?: Record<string, TrendData>,
): string {
  const header = 'Limit Name,Max,Remaining,Used %,Trend Direction';
  const rows = limits.map((l) => {
    const trend = trends?.[l.name];
    const direction = trend ? getTrendDirection(trend.sparklineData) : 'N/A';
    return `"${l.name}",${l.max},${l.remaining},${Math.round(l.usedPercent)},${direction}`;
  });
  return [header, ...rows].join('\n');
}

/**
 * Button that exports current monitor limits data as a CSV file.
 *
 * Uses Blob + URL.createObjectURL for browser-side download.
 * Shows a success toast notification after export.
 */
export const LimitExportButton: React.FC<LimitExportButtonProps> = ({ limits, trends }) => {
  const { t } = useTranslation();
  const addNotification = useNotificationStore((s) => s.addNotification);

  const handleExport = useCallback(() => {
    const csv = generateLimitsCsv(limits, trends);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = `sandforge-limits-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();

    URL.revokeObjectURL(url);

    addNotification({
      level: 'success',
      title: t('monitor.export.success', 'Limits exported'),
      message: t('monitor.export.successDetail', 'CSV file downloaded successfully'),
    });
  }, [limits, trends, addNotification, t]);

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleExport}
      disabled={limits.length === 0}
      data-testid="limit-export-btn"
    >
      <Download className="w-3.5 h-3.5 mr-1" />
      {t('monitor.export.button', 'Export CSV')}
    </Button>
  );
};
