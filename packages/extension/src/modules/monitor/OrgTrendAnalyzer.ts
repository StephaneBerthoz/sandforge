import type { LimitsTracker } from './LimitsTracker';
import type { JobMonitor } from './JobMonitor';

/** A single timestamped data point for trend analysis */
export interface TrendDataPoint {
  timestamp: string;
  value: number;
}

/** Result of analyzing a metric trend over time */
export interface TrendAnalysis {
  metric: string;
  orgId: string;
  dataPoints: TrendDataPoint[];
  trend: 'increasing' | 'stable' | 'decreasing';
  changePercent: number;
  period: string;
}

/** Result of trend calculation from raw data points */
export interface TrendResult {
  trend: 'increasing' | 'stable' | 'decreasing';
  changePercent: number;
}

/** Minimum data points required for trend analysis */
const MIN_TREND_POINTS = 2;

/** Slope threshold for classifying trend direction */
const TREND_SLOPE_THRESHOLD = 0.5;

/**
 * Analyzes trends across monitoring data over time.
 * Uses data from LimitsTracker and JobMonitor to identify
 * increasing, stable, or decreasing trends in org metrics.
 */
export class OrgTrendAnalyzer {
  private readonly limitsTracker: LimitsTracker;
  private readonly jobMonitor: JobMonitor;

  constructor(limitsTracker: LimitsTracker, jobMonitor: JobMonitor) {
    this.limitsTracker = limitsTracker;
    this.jobMonitor = jobMonitor;
  }

  /** Analyze the usage trend for a specific API limit */
  analyzeLimitTrend(orgId: string, limitName: string): TrendAnalysis {
    const snapshots = this.limitsTracker.getHistory(orgId);
    const dataPoints: TrendDataPoint[] = [];

    for (const snapshot of snapshots) {
      const limit = snapshot.limits.find((l) => l.name === limitName);
      if (limit) {
        dataPoints.push({
          timestamp: snapshot.timestamp,
          value: limit.usedPercent,
        });
      }
    }

    const { trend, changePercent } = calculateTrend(dataPoints);

    return {
      metric: `limit:${limitName}`,
      orgId,
      dataPoints,
      trend,
      changePercent,
      period: computePeriod(dataPoints),
    };
  }

  /** Analyze the job activity trend based on job stats */
  analyzeJobTrend(orgId: string): TrendAnalysis {
    const stats = this.jobMonitor.getJobStats(orgId);
    const dataPoints: TrendDataPoint[] = [
      {
        timestamp: new Date().toISOString(),
        value: stats.active,
      },
    ];

    const { trend, changePercent } = calculateTrend(dataPoints);

    return {
      metric: 'jobs:active',
      orgId,
      dataPoints,
      trend,
      changePercent,
      period: computePeriod(dataPoints),
    };
  }

  /** Return the most notable trends across all available metrics */
  getTopTrends(orgId: string): TrendAnalysis[] {
    const snapshots = this.limitsTracker.getHistory(orgId);
    if (snapshots.length === 0) {
      return [];
    }

    const limitNames = new Set<string>();
    for (const snapshot of snapshots) {
      for (const limit of snapshot.limits) {
        limitNames.add(limit.name);
      }
    }

    const trends: TrendAnalysis[] = [];
    for (const name of limitNames) {
      trends.push(this.analyzeLimitTrend(orgId, name));
    }
    trends.push(this.analyzeJobTrend(orgId));

    trends.sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));

    return trends;
  }
}

/** Calculate trend direction and percentage change from data points */
export function calculateTrend(points: TrendDataPoint[]): TrendResult {
  if (points.length < MIN_TREND_POINTS) {
    return { trend: 'stable', changePercent: 0 };
  }

  const values = points.map((p) => p.value);
  const regression = linearRegression(values);

  const firstValue = values[0];
  const lastValue = values[values.length - 1];
  const changePercent =
    firstValue !== 0
      ? ((lastValue - firstValue) / Math.abs(firstValue)) * 100
      : lastValue > 0
        ? 100
        : 0;

  let trend: 'increasing' | 'stable' | 'decreasing';
  if (regression.slope > TREND_SLOPE_THRESHOLD) {
    trend = 'increasing';
  } else if (regression.slope < -TREND_SLOPE_THRESHOLD) {
    trend = 'decreasing';
  } else {
    trend = 'stable';
  }

  return { trend, changePercent: Math.round(changePercent * 100) / 100 };
}

interface RegressionResult {
  slope: number;
  intercept: number;
}

/** Simple linear regression on ordered values */
function linearRegression(values: number[]): RegressionResult {
  const n = values.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;

  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumXX += i * i;
  }

  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) {
    return { slope: 0, intercept: sumY / n };
  }

  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;

  return { slope, intercept };
}

/** Compute a human-readable period string from data points */
function computePeriod(dataPoints: TrendDataPoint[]): string {
  if (dataPoints.length < MIN_TREND_POINTS) {
    return 'insufficient data';
  }
  const first = new Date(dataPoints[0].timestamp);
  const last = new Date(dataPoints[dataPoints.length - 1].timestamp);
  const diffMs = last.getTime() - first.getTime();
  const diffMinutes = Math.round(diffMs / 60_000);

  if (diffMinutes < 60) {
    return `${diffMinutes}m`;
  }
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h`;
  }
  const diffDays = Math.round(diffHours / 24);
  return `${diffDays}d`;
}
