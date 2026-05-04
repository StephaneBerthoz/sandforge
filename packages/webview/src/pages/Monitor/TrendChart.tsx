import React, { useState, useMemo } from 'react';
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
import { cn } from '../../theme';

/** Single data point for the trend chart. */
export interface TrendDataPoint {
  /** Unix timestamp in milliseconds. */
  timestamp: number;
  /** Metric value. */
  value: number;
}

/** Props for the TrendChart component. */
export interface TrendChartProps {
  /** Data points to display. */
  data: TrendDataPoint[];
  /** Additional CSS classes. */
  className?: string;
}

/** Available period options. */
type Period = '24h' | '7d' | '30d';

/** Period label i18n keys. */
const PERIOD_CONFIG: Array<{ key: Period; i18nKey: string; defaultLabel: string; hours: number }> =
  [
    { key: '24h', i18nKey: 'monitor.period24h', defaultLabel: '24h', hours: 24 },
    { key: '7d', i18nKey: 'monitor.period7d', defaultLabel: '7d', hours: 168 },
    { key: '30d', i18nKey: 'monitor.period30d', defaultLabel: '30d', hours: 720 },
  ];

/** Formats a timestamp for the x-axis using locale-aware formatting. */
function formatXAxis(ts: number, period: Period): string {
  const date = new Date(ts);
  if (period === '24h') {
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit' }).format(date);
}

/** Custom tooltip component for the area chart. */
const ChartTooltip: React.FC<{
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: number;
}> = ({ active, payload, label }) => {
  if (!active || !payload || payload.length === 0 || label === undefined) return null;

  const date = new Date(label);
  const timeStr = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);

  return (
    <div
      className="rounded-lg border border-subtle bg-surface-1 px-3 py-2 text-xs shadow-lg"
      data-testid="trend-tooltip"
    >
      <p className="text-text-secondary">{timeStr}</p>
      <p className="font-semibold text-text-primary">{payload[0].value.toLocaleString()}</p>
    </div>
  );
};

/**
 * Recharts AreaChart with period selector (24h/7d/30d).
 * Displays time-series data with hover tooltips and a responsive layout.
 */
export const TrendChart: React.FC<TrendChartProps> = ({ data, className }) => {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<Period>('24h');

  /** Filter data based on selected period. */
  const filteredData = useMemo(() => {
    const config = PERIOD_CONFIG.find((p) => p.key === period);
    if (!config || data.length === 0) return data;
    const cutoff = Date.now() - config.hours * 60 * 60 * 1000;
    const result = data.filter((d) => d.timestamp >= cutoff);
    return result.length > 0 ? result : data;
  }, [data, period]);

  return (
    <div className={cn('flex flex-col', className)} data-testid="trend-chart">
      {/* Period selector */}
      <div className="flex items-center gap-1 mb-3" data-testid="trend-period-selector">
        {PERIOD_CONFIG.map((p) => (
          <button
            key={p.key}
            type="button"
            data-testid={`trend-period-${p.key}`}
            onClick={() => setPeriod(p.key)}
            className={cn(
              'px-2 py-0.5 text-xs rounded border border-subtle cursor-pointer transition-colors',
              period === p.key
                ? 'bg-[var(--sf-accent)] text-[var(--sf-bg-card)]'
                : 'bg-transparent text-text-secondary hover:bg-surface-2',
            )}
          >
            {t(p.i18nKey, p.defaultLabel)}
          </button>
        ))}
      </div>

      {/* Chart area */}
      <div className="w-full h-48" data-testid="trend-chart-container">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={filteredData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="trendGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--sf-accent, #3B82F6)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="var(--sf-accent, #3B82F6)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--sf-border, #3c3c3c)" opacity={0.3} />
            <XAxis
              dataKey="timestamp"
              tickFormatter={(ts: number) => formatXAxis(ts, period)}
              stroke="var(--sf-text-muted, #6b6b6b)"
              fontSize={10}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              stroke="var(--sf-text-muted, #6b6b6b)"
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
      </div>
    </div>
  );
};
