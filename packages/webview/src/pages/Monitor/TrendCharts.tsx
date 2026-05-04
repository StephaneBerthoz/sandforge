import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../theme';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Tabs } from '../../components/ui/Tabs';
import { Sparkline } from '../../components/ui/Sparkline';

/** Data point for trend charts. */
export interface TrendDataPoint {
  timestamp: string;
  value: number;
  label?: string;
}

/** Trend series configuration. */
export interface TrendSeries {
  id: string;
  name: string;
  data: TrendDataPoint[];
  color: string;
}

/** Available period options for the period selector. */
type PeriodOption = '1h' | '6h' | '24h' | '7d';

/** TrendCharts component props. */
export interface TrendChartsProps {
  series: TrendSeries[];
  className?: string;
  /** Callback when period selector changes. */
  onPeriodChange?: (period: string) => void;
}

/** Chart dimensions. */
const CHART_WIDTH = 600;
const CHART_HEIGHT = 200;
const PADDING_LEFT = 40;
const PADDING_RIGHT = 10;
const PADDING_TOP = 10;
const PADDING_BOTTOM = 30;

/** Y-axis label positions (0%, 25%, 50%, 75%, 100%). */
const Y_LABELS = [0, 25, 50, 75, 100];

/** Milliseconds in 24 hours. */
const MS_24H = 24 * 60 * 60 * 1000;

/**
 * Format timestamp for x-axis display using locale-aware formatting.
 * Shows date + time for multi-day ranges, time-only for intra-day.
 * @param ts - ISO timestamp string to format.
 * @param multiDay - Whether the chart spans more than 24 hours.
 * @returns Formatted time or date+time string.
 */
export function formatTime(ts: string, multiDay = false): string {
  const date = new Date(ts);
  if (multiDay) {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/**
 * Build a smooth SVG path from data points within the chart area.
 * Uses time-proportional x-positioning when timestamps are valid.
 * Falls back to evenly-spaced positioning when time range is zero.
 * @param data - Array of trend data points with timestamps and values.
 * @param chartWidth - Total chart width in SVG units.
 * @param chartHeight - Total chart height in SVG units.
 * @returns SVG path string.
 */
export function buildChartPath(
  data: TrendDataPoint[],
  chartWidth: number,
  chartHeight: number,
): string {
  if (data.length < 2) return '';

  const usableWidth = chartWidth - PADDING_LEFT - PADDING_RIGHT;
  const usableHeight = chartHeight - PADDING_TOP - PADDING_BOTTOM;

  const timestamps = data.map((d) => new Date(d.timestamp).getTime());
  const minT = timestamps[0];
  const maxT = timestamps[timestamps.length - 1];
  const timeRange = maxT - minT;

  const points = data.map((d, i) => ({
    x:
      timeRange > 0
        ? PADDING_LEFT + ((timestamps[i] - minT) / timeRange) * usableWidth
        : PADDING_LEFT + (i / Math.max(data.length - 1, 1)) * usableWidth,
    y: PADDING_TOP + usableHeight - (d.value / 100) * usableHeight,
  }));

  if (points.length === 2) {
    return `M ${points[0].x},${points[0].y} L ${points[1].x},${points[1].y}`;
  }

  let path = `M ${points[0].x},${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[Math.min(points.length - 1, i + 1)];
    const p3 = points[Math.min(points.length - 1, i + 2)];

    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;

    path += ` C ${cp1x},${cp1y} ${cp2x},${cp2y} ${p2.x},${p2.y}`;
  }

  return path;
}

/** Period selector buttons. */
const PERIODS: PeriodOption[] = ['1h', '6h', '24h', '7d'];

/** Period label i18n keys. */
const PERIOD_I18N: Record<PeriodOption, { key: string; defaultValue: string }> = {
  '1h': { key: 'monitor.period1h', defaultValue: '1h' },
  '6h': { key: 'monitor.period6h', defaultValue: '6h' },
  '24h': { key: 'monitor.period24h', defaultValue: '24h' },
  '7d': { key: 'monitor.period7d', defaultValue: '7d' },
};

/** Pure SVG trend charts for monitoring data visualization. */
export const TrendCharts: React.FC<TrendChartsProps> = ({ series, className, onPeriodChange }) => {
  const { t } = useTranslation();
  const [activeSeriesId, setActiveSeriesId] = React.useState(series[0]?.id ?? '');
  const [activePeriod, setActivePeriod] = React.useState<PeriodOption>('24h');

  const activeSeries = series.find((s) => s.id === activeSeriesId);
  const tabs = React.useMemo(() => series.map((s) => ({ id: s.id, label: s.name })), [series]);

  /** Handle period button clicks. */
  const handlePeriodChange = React.useCallback(
    (period: PeriodOption): void => {
      setActivePeriod(period);
      onPeriodChange?.(period);
    },
    [onPeriodChange],
  );

  const usableHeight = CHART_HEIGHT - PADDING_TOP - PADDING_BOTTOM;

  /** Compute threshold line Y positions. */
  const threshold75Y = PADDING_TOP + usableHeight - (75 / 100) * usableHeight;
  const threshold90Y = PADDING_TOP + usableHeight - (90 / 100) * usableHeight;

  /** Build x-axis labels from active series timestamps with time-proportional positioning. */
  const xLabels = React.useMemo(() => {
    if (!activeSeries || activeSeries.data.length === 0) return [];
    const usableWidth = CHART_WIDTH - PADDING_LEFT - PADDING_RIGHT;
    const timestamps = activeSeries.data.map((d) => new Date(d.timestamp).getTime());
    const minT = timestamps[0];
    const maxT = timestamps[timestamps.length - 1];
    const timeRange = maxT - minT;
    const multiDay = timeRange > MS_24H;

    const maxLabels = 6;
    const step = Math.max(1, Math.floor(activeSeries.data.length / maxLabels));
    const labels: Array<{ x: number; text: string }> = [];
    for (let i = 0; i < activeSeries.data.length; i += step) {
      const x =
        timeRange > 0
          ? PADDING_LEFT + ((timestamps[i] - minT) / timeRange) * usableWidth
          : PADDING_LEFT + (i / (activeSeries.data.length - 1)) * usableWidth;
      labels.push({ x, text: formatTime(activeSeries.data[i].timestamp, multiDay) });
    }
    return labels;
  }, [activeSeries]);

  return (
    <Card className={cn('border-0 bg-transparent shadow-none', className)}>
      <CardHeader title={t('monitor.trends', 'Trends')} />
      <CardBody>
        {series.length === 0 ? (
          <p className="text-xs text-[var(--sf-text-muted)] text-center py-4">
            {t('common.noData', 'No data available')}
          </p>
        ) : (
          <>
            {/* Period selector */}
            <div
              className="flex items-center"
              style={{ gap: 'var(--sf-space-1)', marginBottom: 'var(--sf-space-3)' }}
              data-testid="period-selector"
            >
              {PERIODS.map((period) => (
                <button
                  key={period}
                  type="button"
                  data-testid={`period-${period}`}
                  onClick={() => handlePeriodChange(period)}
                  style={{
                    padding: '2px 8px',
                    fontSize: 'var(--sf-font-size-xs)',
                    borderRadius: 'var(--sf-radius-sm)',
                    border: '1px solid var(--sf-border)',
                    backgroundColor: activePeriod === period ? 'var(--sf-accent)' : 'transparent',
                    color:
                      activePeriod === period ? 'var(--sf-bg-card)' : 'var(--sf-text-secondary)',
                    cursor: 'pointer',
                  }}
                >
                  {t(PERIOD_I18N[period].key, PERIOD_I18N[period].defaultValue)}
                </button>
              ))}
            </div>

            {/* Tab switcher */}
            {series.length > 1 && (
              <Tabs
                tabs={tabs}
                activeTab={activeSeriesId}
                onTabChange={setActiveSeriesId}
                className="mb-3"
              />
            )}

            {/* SVG Chart */}
            <div data-testid="trend-chart" style={{ width: '100%', height: CHART_HEIGHT }}>
              {activeSeries && activeSeries.data.length >= 2 ? (
                <svg
                  data-testid="trend-svg"
                  width="100%"
                  height={CHART_HEIGHT}
                  viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
                  preserveAspectRatio="none"
                  role="img"
                  aria-label="Trend chart"
                >
                  {/* Y-axis labels */}
                  {Y_LABELS.map((pct) => {
                    const y = PADDING_TOP + usableHeight - (pct / 100) * usableHeight;
                    return (
                      <text
                        key={`y-${pct}`}
                        x={PADDING_LEFT - 5}
                        y={y + 3}
                        textAnchor="end"
                        fill="var(--sf-text-muted)"
                        fontSize={9}
                        data-testid={`y-label-${pct}`}
                      >
                        {pct}%
                      </text>
                    );
                  })}

                  {/* Y-axis grid lines */}
                  {Y_LABELS.map((pct) => {
                    const y = PADDING_TOP + usableHeight - (pct / 100) * usableHeight;
                    return (
                      <line
                        key={`grid-${pct}`}
                        x1={PADDING_LEFT}
                        y1={y}
                        x2={CHART_WIDTH - PADDING_RIGHT}
                        y2={y}
                        stroke="var(--sf-border)"
                        strokeWidth={0.5}
                        opacity={0.3}
                      />
                    );
                  })}

                  {/* Threshold lines */}
                  <line
                    data-testid="threshold-75"
                    x1={PADDING_LEFT}
                    y1={threshold75Y}
                    x2={CHART_WIDTH - PADDING_RIGHT}
                    y2={threshold75Y}
                    stroke="var(--sf-warning)"
                    strokeWidth={0.5}
                    strokeDasharray="4 4"
                    opacity={0.6}
                  />
                  <line
                    data-testid="threshold-90"
                    x1={PADDING_LEFT}
                    y1={threshold90Y}
                    x2={CHART_WIDTH - PADDING_RIGHT}
                    y2={threshold90Y}
                    stroke="var(--sf-error)"
                    strokeWidth={0.5}
                    strokeDasharray="4 4"
                    opacity={0.6}
                  />

                  {/* X-axis labels */}
                  {xLabels.map((label, i) => (
                    <text
                      key={`x-${i}`}
                      x={label.x}
                      y={CHART_HEIGHT - 5}
                      textAnchor="middle"
                      fill="var(--sf-text-muted)"
                      fontSize={9}
                    >
                      {label.text}
                    </text>
                  ))}

                  {/* Data line */}
                  <path
                    d={buildChartPath(activeSeries.data, CHART_WIDTH, CHART_HEIGHT)}
                    fill="none"
                    stroke={activeSeries.color}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : activeSeries && activeSeries.data.length === 1 ? (
                <Sparkline
                  data={[activeSeries.data[0].value]}
                  width={CHART_WIDTH}
                  height={CHART_HEIGHT}
                  color={activeSeries.color}
                />
              ) : null}
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
};
