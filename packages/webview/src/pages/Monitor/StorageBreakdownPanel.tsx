import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { PieChart, Pie, Sector, ResponsiveContainer, Tooltip } from 'recharts';
import type { PieSectorShapeProps } from 'recharts';
import { Database } from 'lucide-react';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useOrgStore } from '../../stores/useOrgStore';
import { Skeleton } from '../../components/ui/Skeleton';
import { formatNumber } from '../../utils/formatters';
import { cn } from '../../theme';
import type { StorageObjectEntry } from '@sandforge/shared';

/**
 * One identity hue per donut slice, as the slice's fill and as the dot on its
 * table row. The classes override the fill Recharts sets as an attribute, so a
 * slice follows the theme like the rest of the panel.
 */
const SLICE_HUES = [
  { fill: 'fill-hue-blue', dot: 'bg-hue-blue' },
  { fill: 'fill-hue-green', dot: 'bg-hue-green' },
  { fill: 'fill-hue-amber', dot: 'bg-hue-amber' },
  { fill: 'fill-hue-purple', dot: 'bg-hue-purple' },
  { fill: 'fill-hue-rose', dot: 'bg-hue-rose' },
  { fill: 'fill-hue-cyan', dot: 'bg-hue-cyan' },
  { fill: 'fill-hue-fuchsia', dot: 'bg-hue-fuchsia' },
  { fill: 'fill-hue-teal', dot: 'bg-hue-teal' },
  { fill: 'fill-hue-orange', dot: 'bg-hue-orange' },
  { fill: 'fill-hue-indigo', dot: 'bg-hue-indigo' },
];

/**
 * A slice, drawn as Recharts draws one, with the class of its hue.
 *
 * Recharts 3 deprecates `Cell`, which carried the class before, for the
 * `shape` of the chart's items: it is handed each slice's geometry and its
 * index, which is the index of its row in the table.
 */
function StorageSlice(props: PieSectorShapeProps): React.ReactElement {
  return <Sector {...props} className={SLICE_HUES[props.index % SLICE_HUES.length].fill} />;
}

/** Response shape from monitor:storage. */
interface StorageData {
  success: boolean;
  objects: StorageObjectEntry[];
  totalRecords: number;
  /** Objects holding at least one record, of which `objects` lists the first. */
  objectCount?: number;
  error?: string;
}

/**
 * Panel displaying the org's record counts per object, with a donut chart and
 * table.
 *
 * Fetches data via useBridgeQuery('monitor:storage') and renders
 * the top 10 objects in a Recharts PieChart (donut variant) with
 * a detailed table below.
 *
 * The counts are every object the org counts. On a real sandbox the list was
 * led by ObjectPermissions, FieldPermissions and LoginHistory under the title
 * "Storage Breakdown", where none of them uses data storage: the panel now
 * says what the list is, and how much of it is shown.
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
  const objectCount = data?.objectCount ?? objects.length;
  const chartData = useMemo(
    () => objects.slice(0, 10).map((o) => ({ name: o.label, value: o.recordCount })),
    [objects],
  );

  if (loading) {
    return (
      <div
        className="rounded-lg border border-subtle bg-surface-1 p-4"
        data-testid="storage-panel-loading"
      >
        <Skeleton variant="rect" height="200px" />
      </div>
    );
  }

  if (objects.length === 0) {
    return (
      <div
        className="rounded-lg border border-subtle bg-surface-1 p-4"
        data-testid="storage-panel-empty"
      >
        <div className="flex items-center gap-2 mb-3">
          <Database className="w-4 h-4 text-text-secondary" />
          <h3 className="text-sm font-semibold text-text-primary">{t('monitor.storage.title')}</h3>
        </div>
        <p className="text-xs text-text-secondary text-center py-6">{t('monitor.storage.empty')}</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-subtle bg-surface-1 p-4" data-testid="storage-panel">
      <div className="flex items-center gap-2 mb-1">
        <Database className="w-4 h-4 text-text-secondary" />
        <h3 className="text-sm font-semibold text-text-primary">{t('monitor.storage.title')}</h3>
        <span className="text-xs text-text-secondary ml-auto">
          {t('monitor.storage.totalRecordCount', {
            count: totalRecords,
            formatted: formatNumber(totalRecords),
          })}
        </span>
      </div>
      <p className="text-[11px] text-text-secondary mb-3" data-testid="storage-scope">
        {t('monitor.storage.scope')}
        {objectCount > objects.length && (
          <>
            {' '}
            {t('monitor.storage.listed', {
              shown: formatNumber(objects.length),
              total: formatNumber(objectCount),
            })}
          </>
        )}
      </p>

      {/* Donut chart. Hidden from assistive technology, and out of the tab
          order with it: Recharts draws each slice as a path with role img and
          no text, which axe fails the first time the panel is scanned with
          data, and the table below gives every slice's name, count and share
          in words. Recharts 3 makes a chart a tab stop for its keyboard
          tooltips (`accessibilityLayer`): inside this hidden block that stop
          was a control no reader could name, as axe said. */}
      <div className="h-48" data-testid="storage-donut-chart" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart accessibilityLayer={false}>
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              innerRadius={50}
              outerRadius={80}
              dataKey="value"
              paddingAngle={2}
              rootTabIndex={-1}
              shape={StorageSlice}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'var(--sf-bg-primary)',
                border: '1px solid var(--sf-border)',
                borderRadius: '6px',
              }}
              itemStyle={{ color: 'var(--sf-text-primary)' }}
              formatter={(value) => (typeof value === 'number' ? formatNumber(value) : value)}
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
              className="flex items-center gap-3 px-2 py-1 rounded-sm hover:bg-surface-2 transition-colors text-xs"
              data-testid={`storage-row-${obj.objectName}`}
            >
              <span
                className={cn(
                  'w-2.5 h-2.5 rounded-full shrink-0',
                  idx < SLICE_HUES.length ? SLICE_HUES[idx].dot : 'bg-text-secondary',
                )}
              />
              <span className="text-text-primary flex-1 truncate font-medium">{obj.label}</span>
              <span className="text-text-secondary tabular-nums w-20 text-right">
                {formatNumber(obj.recordCount)}
              </span>
              <span className="text-text-secondary tabular-nums w-12 text-right">{pct}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
