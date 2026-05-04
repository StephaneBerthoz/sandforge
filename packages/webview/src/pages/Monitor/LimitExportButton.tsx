import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { useNotificationStore } from '../../stores/useNotificationStore';
import type { ApiLimit, TrendData } from '@sandforge/shared';

/** Export mode: current snapshot or full historical trend data. */
type ExportMode = 'current' | 'historical';

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
export function generateLimitsCsv(limits: ApiLimit[], trends?: Record<string, TrendData>): string {
  const header = 'Limit Name,Max,Remaining,Used %,Trend Direction';
  const rows = limits.map((l) => {
    const trend = trends?.[l.name];
    const direction = trend ? getTrendDirection(trend.sparklineData) : 'N/A';
    return `"${l.name}",${l.max},${l.remaining},${Math.round(l.usedPercent)},${direction}`;
  });
  return [header, ...rows].join('\n');
}

/**
 * Generates a CSV string with historical trend data rows.
 * One row per limit per timestamp.
 * @param trends - Trend data keyed by limit name (with timestamps and sparklineData).
 * @returns CSV content string with columns: Timestamp,Limit Name,Used %.
 */
export function generateHistoricalCsv(trends: Record<string, TrendData>): string {
  const header = 'Timestamp,Limit Name,Used %';
  const rows: string[] = [];
  for (const [limitName, td] of Object.entries(trends)) {
    if (!td.timestamps || td.timestamps.length === 0) continue;
    for (let i = 0; i < td.sparklineData.length; i++) {
      const ts = td.timestamps[i] ?? '';
      rows.push(`"${ts}","${limitName}",${td.sparklineData[i]}`);
    }
  }
  return [header, ...rows].join('\n');
}

/**
 * Button that exports current monitor limits data as a CSV file.
 *
 * Supports two modes:
 * - "current": exports a single-row-per-limit snapshot (default).
 * - "historical": exports one row per limit per timestamp using trend data.
 *
 * Uses Blob + URL.createObjectURL for browser-side download.
 * Shows a success toast notification after export.
 */
export const LimitExportButton: React.FC<LimitExportButtonProps> = ({ limits, trends }) => {
  const { t } = useTranslation();
  const addNotification = useNotificationStore((s) => s.addNotification);
  const [exportMode, setExportMode] = useState<ExportMode>('current');

  const handleExport = useCallback(() => {
    let csv: string;
    let filename: string;
    const date = new Date().toISOString().slice(0, 10);

    if (exportMode === 'historical') {
      csv = generateHistoricalCsv(trends ?? {});
      filename = `sandforge-limits-history-${date}.csv`;

      // If only the header (no data rows), warn instead of downloading
      const lines = csv.split('\n');
      if (lines.length <= 1) {
        addNotification({
          level: 'warning',
          title: t('monitor.export.noHistory', 'No historical data'),
          message: t(
            'monitor.export.noHistoryDetail',
            'No trend timestamps available for historical export',
          ),
        });
        return;
      }
    } else {
      csv = generateLimitsCsv(limits, trends);
      filename = `sandforge-limits-${date}.csv`;
    }

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();

    URL.revokeObjectURL(url);

    addNotification({
      level: 'success',
      title: t('monitor.export.success', 'Limits exported'),
      message: t('monitor.export.successDetail', 'CSV file downloaded successfully'),
    });
  }, [limits, trends, exportMode, addNotification, t]);

  return (
    <div className="flex items-center" data-testid="export-group">
      <Button
        variant="ghost"
        size="sm"
        onClick={handleExport}
        disabled={limits.length === 0}
        data-testid="limit-export-btn"
      >
        <Download className="w-3.5 h-3.5 mr-1" />
        {exportMode === 'current'
          ? t('monitor.export.button', 'Export CSV')
          : t('monitor.export.buttonHistorical', 'Export History')}
      </Button>
      <select
        value={exportMode}
        onChange={(e) => setExportMode(e.target.value as ExportMode)}
        className="text-xs bg-transparent border-0 text-text-muted cursor-pointer"
        data-testid="export-mode-select"
        aria-label={t('monitor.export.modeLabel', 'Export mode')}
      >
        <option value="current">{t('monitor.export.modeCurrent', 'Current')}</option>
        <option value="historical">{t('monitor.export.modeHistorical', 'Historical')}</option>
      </select>
    </div>
  );
};
