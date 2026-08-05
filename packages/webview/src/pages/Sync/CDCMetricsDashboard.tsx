import React, { useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useCDCMetricsStore,
  getEventsPerSecondHistory,
  getLagHistory,
  getUptimeSeconds,
} from '../../stores/useCDCMetricsStore';
import { useCDCLiveStore } from '../../stores/useCDCLiveStore';

/** SVG viewBox dimensions for sparklines. */
const SPARK_WIDTH = 80;
const SPARK_HEIGHT = 24;

/**
 * Render an inline SVG sparkline polyline from a series of numeric values.
 * @param values - Data points for the sparkline.
 * @param color - Stroke color for the polyline.
 */
function Sparkline({
  values,
  color,
}: {
  values: number[];
  color: string;
}): React.ReactElement | null {
  if (values.length < 2) return null;

  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;

  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * SPARK_WIDTH;
      const y = SPARK_HEIGHT - ((v - min) / range) * SPARK_HEIGHT;
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <svg
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      className="w-20 h-6 inline-block"
      data-testid="sparkline"
      aria-hidden="true"
    >
      <polyline fill="none" stroke={color} strokeWidth="1.5" points={points} />
    </svg>
  );
}

/**
 * Get a health color based on lag thresholds.
 * @param lagMs - Lag value in milliseconds.
 * @returns CSS color class name.
 */
function lagColor(lagMs: number): string {
  if (lagMs < 500) return 'text-green-500';
  if (lagMs <= 2000) return 'text-yellow-500';
  return 'text-red-500';
}

/**
 * Get a health color based on error rate thresholds.
 * @param rate - Error rate as a percentage (0-100).
 * @returns CSS color class name.
 */
function errorRateColor(rate: number): string {
  if (rate < 1) return 'text-green-500';
  if (rate <= 5) return 'text-yellow-500';
  return 'text-red-500';
}

/**
 * Format a lag value in milliseconds to a human-readable string.
 * @param ms - Lag in milliseconds.
 * @returns Formatted string (e.g., "245ms" or "1.2s").
 */
function formatLag(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Format a duration in seconds to a human-readable uptime string.
 * @param totalSeconds - Duration in seconds.
 * @returns Formatted string (e.g., "2h 15m 30s").
 */
export function formatUptime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);

  return parts.join(' ');
}

/**
 * CDC Metrics Dashboard showing real-time throughput, lag, counters, and uptime.
 * Displays a grid of 6 metric cards with sparklines when a CDC session is active.
 */
export const CDCMetricsDashboard: React.FC = () => {
  const { t } = useTranslation();
  const metrics = useCDCMetricsStore((s) => s.metrics);
  const metricsHistory = useCDCMetricsStore((s) => s.metricsHistory);
  const startPolling = useCDCMetricsStore((s) => s.startPolling);
  const stopPolling = useCDCMetricsStore((s) => s.stopPolling);
  const status = useCDCLiveStore((s) => s.status);

  const [uptimeDisplay, setUptimeDisplay] = useState('0s');

  // Start/stop polling based on connection status
  useEffect(() => {
    if (status === 'syncing' || status === 'paused') {
      startPolling();
    } else {
      stopPolling();
    }
    return () => {
      stopPolling();
    };
  }, [status, startPolling, stopPolling]);

  // Update uptime display every second
  useEffect(() => {
    if (!metrics?.startedAt) return;

    const update = (): void => {
      setUptimeDisplay(formatUptime(getUptimeSeconds(metrics.startedAt)));
    };
    update();

    const intervalId = setInterval(update, 1000);
    return () => clearInterval(intervalId);
  }, [metrics?.startedAt]);

  const evtPerSecHistory = useMemo(
    () => getEventsPerSecondHistory(metricsHistory),
    [metricsHistory],
  );
  const lagHistoryValues = useMemo(() => getLagHistory(metricsHistory), [metricsHistory]);

  if (!metrics) {
    return (
      <div
        data-testid="cdc-metrics-dashboard"
        className="p-4 text-center text-[var(--sf-text-muted)]"
      >
        {t('sync.realtime.metricsPanel.noMetrics')}
      </div>
    );
  }

  const evtPerSec = metrics.eventsPerMinute / 60;
  const currentLagColor = lagColor(metrics.currentLagMs);
  const currentErrorColor = errorRateColor(metrics.errorRate);

  return (
    <div
      data-testid="cdc-metrics-dashboard"
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
    >
      {/* Card 1: Throughput */}
      <div
        data-testid="cdc-metric-throughput"
        className="rounded-lg border border-[var(--sf-border)] p-3 bg-[var(--sf-bg-card)]"
      >
        <div className="text-xs text-[var(--sf-text-muted)] mb-1">
          {t('sync.realtime.metricsPanel.throughput')}
        </div>
        <div className="text-xl font-semibold">
          {evtPerSec.toFixed(1)}{' '}
          <span className="text-sm text-[var(--sf-text-muted)]">
            {t('sync.realtime.metricsPanel.evtPerSec')}
          </span>
        </div>
        <Sparkline values={evtPerSecHistory} color="var(--sf-accent)" />
      </div>

      {/* Card 2: Replication Lag */}
      <div
        data-testid="cdc-metric-lag"
        className="rounded-lg border border-[var(--sf-border)] p-3 bg-[var(--sf-bg-card)]"
      >
        <div className="text-xs text-[var(--sf-text-muted)] mb-1">
          {t('sync.realtime.metricsPanel.lag')}
        </div>
        <div className={`text-xl font-semibold ${currentLagColor}`}>
          {formatLag(metrics.currentLagMs)}
        </div>
        <div className="text-xs text-[var(--sf-text-muted)]">
          {t('sync.realtime.metricsPanel.average', { value: Math.round(metrics.averageLagMs) })}
        </div>
        <Sparkline
          values={lagHistoryValues}
          color={
            metrics.currentLagMs < 500
              ? '#22c55e'
              : metrics.currentLagMs <= 2000
                ? '#eab308'
                : '#ef4444'
          }
        />
      </div>

      {/* Card 3: Events Applied */}
      <div
        data-testid="cdc-metric-applied"
        className="rounded-lg border border-[var(--sf-border)] p-3 bg-[var(--sf-bg-card)]"
      >
        <div className="text-xs text-[var(--sf-text-muted)] mb-1">
          {t('sync.realtime.metricsPanel.applied')}
        </div>
        <div className="text-xl font-semibold text-green-500">
          {metrics.eventsApplied.toLocaleString()}
        </div>
      </div>

      {/* Card 4: Events Failed */}
      <div
        data-testid="cdc-metric-failed"
        className="rounded-lg border border-[var(--sf-border)] p-3 bg-[var(--sf-bg-card)]"
      >
        <div className="text-xs text-[var(--sf-text-muted)] mb-1">
          {t('sync.realtime.metricsPanel.failed')}
        </div>
        <div
          className={`text-xl font-semibold ${metrics.eventsFailed > 0 ? 'text-red-500' : 'text-gray-400'}`}
        >
          {metrics.eventsFailed.toLocaleString()}
        </div>
      </div>

      {/* Card 5: Error Rate */}
      <div
        data-testid="cdc-metric-error-rate"
        className="rounded-lg border border-[var(--sf-border)] p-3 bg-[var(--sf-bg-card)]"
      >
        <div className="text-xs text-[var(--sf-text-muted)] mb-1">
          {t('sync.realtime.metricsPanel.errorRate')}
        </div>
        <div className={`text-xl font-semibold ${currentErrorColor}`}>
          {metrics.errorRate.toFixed(1)}%
        </div>
      </div>

      {/* Card 6: Uptime */}
      <div
        data-testid="cdc-metric-uptime"
        className="rounded-lg border border-[var(--sf-border)] p-3 bg-[var(--sf-bg-card)]"
      >
        <div className="text-xs text-[var(--sf-text-muted)] mb-1">
          {t('sync.realtime.metricsPanel.uptime')}
        </div>
        <div className="text-xl font-semibold">{uptimeDisplay}</div>
        <div className="text-xs text-[var(--sf-text-muted)]">
          {t('sync.realtime.metricsPanel.since', {
            time: new Date(metrics.startedAt).toLocaleTimeString(),
          })}
        </div>
      </div>
    </div>
  );
};
