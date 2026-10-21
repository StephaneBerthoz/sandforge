import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { ChartTooltip, formatXAxis } from './TrendChart';
import type { Period, TrendDataPoint } from './TrendChart';

/** Props of {@link TrendArea}. */
export interface TrendAreaProps {
  /** The points of the period shown. */
  data: TrendDataPoint[];
  /** The period shown, which the axis's times are written for. */
  period: Period;
}

/**
 * A trend's area chart, drawn by Recharts.
 *
 * A chunk of its own (monitorCharts.ts), which TrendChart draws inside a box
 * of fixed height: Monitor's dashboard parsed Recharts, 337 kB, before it
 * painted anything, and its period buttons and the rest of the page need
 * none of it.
 */
export const TrendArea: React.FC<TrendAreaProps> = ({ data, period }) => {
  const { t } = useTranslation();
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="trendGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--sf-accent, #3B82F6)" stopOpacity={0.3} />
            <stop offset="95%" stopColor="var(--sf-accent, #3B82F6)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--sf-border, #3c3c3c)" opacity={0.3} />
        <XAxis
          dataKey="timestamp"
          tickFormatter={(ts: number) => formatXAxis(ts, period) ?? t('common.dateUnknown')}
          stroke="var(--sf-text-secondary)"
          fontSize={10}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          stroke="var(--sf-text-secondary)"
          fontSize={10}
          tickLine={false}
          axisLine={false}
          width={40}
        />
        <Tooltip content={<ChartTooltip />} />
        <Area
          type="monotone"
          dataKey="value"
          stroke="var(--sf-accent, #3B82F6)"
          strokeWidth={2}
          fill="url(#trendGradient)"
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
};
