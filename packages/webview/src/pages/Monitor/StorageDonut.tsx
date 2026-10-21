import React, { useCallback } from 'react';
import { PieChart, Pie, Sector, ResponsiveContainer, Tooltip } from 'recharts';
import type { PieSectorShapeProps } from 'recharts';
import { formatNumber } from '../../utils/formatters';

/** Props of {@link StorageDonut}. */
export interface StorageDonutProps {
  /** One slice per object, its name and its record count. */
  data: Array<{ name: string; value: number }>;
  /** The fill class of each slice, by its index: the hue of its row's dot in the table. */
  fills: readonly string[];
}

/**
 * The storage panel's donut, drawn by Recharts.
 *
 * A chunk of its own (monitorCharts.ts), which the panel draws inside a box of
 * fixed height: the panel's counts and table come with the page, and Recharts,
 * 337 kB, after it has painted.
 *
 * Recharts 3 deprecates `Cell`, which carried the class before, for the
 * `shape` of the chart's items: it is handed each slice's geometry and its
 * index, which is the index of its row in the table.
 */
export const StorageDonut: React.FC<StorageDonutProps> = ({ data, fills }) => {
  const slice = useCallback(
    (props: PieSectorShapeProps): React.ReactElement => (
      <Sector {...props} className={fills[props.index % fills.length]} />
    ),
    [fills],
  );
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart accessibilityLayer={false}>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          innerRadius={50}
          outerRadius={80}
          dataKey="value"
          paddingAngle={2}
          rootTabIndex={-1}
          shape={slice}
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
  );
};
