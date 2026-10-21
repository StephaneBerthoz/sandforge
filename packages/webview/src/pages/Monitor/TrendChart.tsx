import React, { Suspense, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../theme';
import { dateTimeFormat, formatStoredDate, uiLocale } from '../../utils/formatters';
import { TrendArea } from './monitorCharts';

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

/**
 * Available period options. Nothing longer than a week: trend history is kept
 * for seven days, so a 30-day view could only show that same week again.
 */
export type Period = '24h' | '7d';

/** Period label i18n keys. */
const PERIOD_CONFIG: Array<{ key: Period; i18nKey: string; defaultLabel: string; hours: number }> =
  [
    { key: '24h', i18nKey: 'monitor.period24h', defaultLabel: '24h', hours: 24 },
    { key: '7d', i18nKey: 'monitor.period7d', defaultLabel: '7d', hours: 168 },
  ];

/**
 * Formats a timestamp for the x-axis using locale-aware formatting; null for a
 * point whose time is not a date, which threw "Invalid time value" and left
 * the chart blank.
 */
export function formatXAxis(ts: number, period: Period): string | null {
  return formatStoredDate(
    ts,
    period === '24h'
      ? dateTimeFormat({ hour: '2-digit', minute: '2-digit', hour12: false }).format
      : dateTimeFormat({ month: '2-digit', day: '2-digit' }).format,
  );
}

/** Custom tooltip component for the area chart. */
export const ChartTooltip: React.FC<{
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: number;
}> = ({ active, payload, label }) => {
  const { t } = useTranslation();
  if (!active || !payload || payload.length === 0 || label === undefined) return null;

  const timeStr =
    formatStoredDate(label, dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }).format) ??
    t('common.dateUnknown');

  return (
    <div
      className="rounded-lg border border-subtle bg-surface-1 px-3 py-2 text-xs shadow-lg"
      data-testid="trend-tooltip"
    >
      <p className="text-text-secondary">{timeStr}</p>
      <p className="font-semibold text-text-primary">
        {payload[0].value.toLocaleString(uiLocale())}
      </p>
    </div>
  );
};

/**
 * A trend's area chart with its period selector (24h/7d).
 * Displays time-series data with hover tooltips and a responsive layout; the
 * chart itself, Recharts', comes in a chunk of its own (TrendArea).
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
              'px-2 py-0.5 text-xs rounded-sm border border-subtle cursor-pointer transition-colors',
              period === p.key
                ? 'bg-(--sf-button-bg) text-(--sf-button-fg)'
                : 'bg-transparent text-text-secondary hover:bg-surface-2',
            )}
          >
            {t(p.i18nKey, p.defaultLabel)}
          </button>
        ))}
      </div>

      {/* Chart area: its box keeps its height while Recharts loads. */}
      <div className="w-full h-48" data-testid="trend-chart-container">
        <Suspense fallback={null}>
          <TrendArea data={filteredData} period={period} />
        </Suspense>
      </div>
    </div>
  );
};
