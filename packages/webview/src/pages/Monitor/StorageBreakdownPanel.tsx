import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { Database } from 'lucide-react';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useOrgStore } from '../../stores/useOrgStore';
import { Skeleton } from '../../components/ui/Skeleton';
import { formatNumber } from '../../utils/formatters';
import type { StorageObjectEntry } from '@sandforge/shared';

/** Color palette for the donut chart slices. */
const SLICE_COLORS = [
  '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444',
  '#06B6D4', '#EC4899', '#14B8A6', '#F97316', '#6366F1',
];

/** Response shape from monitor:storage. */
interface StorageData {
  success: boolean;
  objects: StorageObjectEntry[];
  totalRecords: number;
  error?: string;
}

/**
 * Panel displaying per-object storage breakdown with a donut chart and table.
 *
 * Fetches data via useBridgeQuery('monitor:storage') and renders
 * the top 10 objects in a Recharts PieChart (donut variant) with
 * a detailed table below.
 */
export const StorageBreakdownPanel: React.FC = () => {
  const { t } = useTranslation();
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);

  const { data, loading } = useBridgeQuery<StorageData>(
    'monitor:storage',
    selectedOrgId ? { orgId: selectedOrgId } : undefined,
    { responseType: 'monitor:storage:response', skip: !selectedOrgId },
  );

  const objects = useMemo(() => data?.objects ?? [], [data?.objects]);
  const totalRecords = data?.totalRecords ?? 0;
  const chartData = useMemo(
    () => objects.slice(0, 10).map((o) => ({ name: o.label, value: o.recordCount })),
    [objects],
  );

  if (loading) {
    return (
      <div className="rounded-lg border border-subtle bg-surface-1 p-4" data-testid="storage-panel-loading">
        <Skeleton variant="rect" height="200px" />
      </div>
    );
  }

  if (objects.length === 0) {
    return (
      <div className="rounded-lg border border-subtle bg-surface-1 p-4" data-testid="storage-panel-empty">
        <div className="flex items-center gap-2 mb-3">
          <Database className="w-4 h-4 text-text-secondary" />
          <h3 className="text-sm font-semibold text-text-primary">{t('monitor.storage.title', 'Storage Breakdown')}</h3>
        </div>
        <p className="text-xs text-text-muted text-center py-6">
          {t('monitor.storage.empty', 'No object storage data available')}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-subtle bg-surface-1 p-4" data-testid="storage-panel">
      <div className="flex items-center gap-2 mb-3">
        <Database className="w-4 h-4 text-text-secondary" />
        <h3 className="text-sm font-semibold text-text-primary">{t('monitor.storage.title', 'Storage Breakdown')}</h3>
        <span className="text-xs text-text-muted ml-auto">
          {formatNumber(totalRecords)} {t('monitor.storage.totalRecords', 'total records')}
        </span>
      </div>

      {/* Donut chart */}
      <div className="h-48" data-testid="storage-donut-chart">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              innerRadius={50}
              outerRadius={80}
              dataKey="value"
              paddingAngle={2}
            >
              {chartData.map((_entry, index) => (
                <Cell key={`cell-${index}`} fill={SLICE_COLORS[index % SLICE_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{ backgroundColor: 'var(--vscode-editor-background, #1e1e1e)', border: '1px solid var(--vscode-panel-border, #3c3c3c)', borderRadius: '6px' }}
              itemStyle={{ color: 'var(--vscode-editor-foreground, #d4d4d4)' }}
              formatter={(value: number) => formatNumber(value)}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>

      {/* Table */}
      <div className="flex flex-col gap-1 mt-3" data-testid="storage-table">
        {objects.map((obj, idx) => {
          const pct = totalRecords > 0 ? Math.round((obj.recordCount / totalRecords) * 100) : 0;
          return (
            <div
              key={obj.objectName}
              className="flex items-center gap-3 px-2 py-1 rounded hover:bg-surface-2 transition-colors text-xs"
              data-testid={`storage-row-${obj.objectName}`}
            >
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: idx < 10 ? SLICE_COLORS[idx] : '#6B7280' }}
              />
              <span className="text-text-primary flex-1 truncate font-medium">{obj.label}</span>
              <span className="text-text-secondary tabular-nums w-20 text-right">{formatNumber(obj.recordCount)}</span>
              <span className="text-text-muted tabular-nums w-12 text-right">{pct}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
