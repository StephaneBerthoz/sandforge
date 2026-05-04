import type { LimitsSnapshot } from '@sandforge/shared';
import type { LimitsTracker } from './LimitsTracker';

/** Prediction result for a single governor limit */
export interface LimitPrediction {
  limitName: string;
  currentPercent: number;
  predictedPercent: number;
  predictedTimeToExhaustion?: number;
  trend: 'increasing' | 'stable' | 'decreasing';
  confidence: number;
}

/** Minimum data points required for meaningful prediction */
const MIN_DATA_POINTS = 2;

/**
 * Predicts when Salesforce governor limits will be exhausted
 * based on historical usage trends. Uses simple linear regression
 * to extrapolate future values from past snapshots.
 */
export class GovernorLimitPredictor {
  private readonly limitsTracker: LimitsTracker;

  constructor(limitsTracker: LimitsTracker) {
    this.limitsTracker = limitsTracker;
  }

  /** Generate predictions for all tracked limits in an org */
  predict(orgId: string): LimitPrediction[] {
    const snapshots = this.limitsTracker.getHistory(orgId);
    if (snapshots.length < MIN_DATA_POINTS) {
      return [];
    }

    const limitNames = getLimitNames(snapshots);
    return limitNames.map((name) => this.predictLimit(snapshots, name));
  }

  /** Generate a prediction for a single named limit */
  predictLimit(snapshots: LimitsSnapshot[], limitName: string): LimitPrediction {
    const dataPoints = extractDataPoints(snapshots, limitName);

    if (dataPoints.length < MIN_DATA_POINTS) {
      const currentPercent = dataPoints.length > 0 ? dataPoints[dataPoints.length - 1].value : 0;
      return {
        limitName,
        currentPercent,
        predictedPercent: currentPercent,
        trend: 'stable',
        confidence: 0,
      };
    }

    const regression = linearRegression(dataPoints);
    const currentPercent = dataPoints[dataPoints.length - 1].value;
    const predictedPercent = Math.max(0, Math.min(100, currentPercent + regression.slope * 10));

    const trend = classifyTrend(regression.slope);
    const confidence = computeConfidence(dataPoints, regression);

    let predictedTimeToExhaustion: number | undefined;
    if (regression.slope > 0 && currentPercent < 100) {
      const remaining = 100 - currentPercent;
      predictedTimeToExhaustion = remaining / regression.slope;
    }

    return {
      limitName,
      currentPercent,
      predictedPercent,
      predictedTimeToExhaustion,
      trend,
      confidence,
    };
  }
}

interface DataPoint {
  x: number;
  value: number;
}

/** Extract time-indexed data points for a specific limit */
function extractDataPoints(snapshots: LimitsSnapshot[], limitName: string): DataPoint[] {
  const points: DataPoint[] = [];

  for (let i = 0; i < snapshots.length; i++) {
    const limit = snapshots[i].limits.find((l) => l.name === limitName);
    if (limit) {
      points.push({ x: i, value: limit.usedPercent });
    }
  }

  return points;
}

/** Get all unique limit names across snapshots */
function getLimitNames(snapshots: LimitsSnapshot[]): string[] {
  const names = new Set<string>();
  for (const snapshot of snapshots) {
    for (const limit of snapshot.limits) {
      names.add(limit.name);
    }
  }
  return [...names];
}

interface RegressionResult {
  slope: number;
  intercept: number;
}

/** Simple linear regression: y = slope * x + intercept */
function linearRegression(points: DataPoint[]): RegressionResult {
  const n = points.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;

  for (const point of points) {
    sumX += point.x;
    sumY += point.value;
    sumXY += point.x * point.value;
    sumXX += point.x * point.x;
  }

  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) {
    return { slope: 0, intercept: sumY / n };
  }

  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;

  return { slope, intercept };
}

/** Classify trend direction from regression slope */
function classifyTrend(slope: number): 'increasing' | 'stable' | 'decreasing' {
  if (slope > 0.5) {
    return 'increasing';
  }
  if (slope < -0.5) {
    return 'decreasing';
  }
  return 'stable';
}

/** Compute R-squared confidence value (0-1) */
function computeConfidence(points: DataPoint[], regression: RegressionResult): number {
  if (points.length < MIN_DATA_POINTS) {
    return 0;
  }

  const meanY = points.reduce((sum, p) => sum + p.value, 0) / points.length;
  let ssTotal = 0;
  let ssResidual = 0;

  for (const point of points) {
    const predicted = regression.slope * point.x + regression.intercept;
    ssTotal += (point.value - meanY) ** 2;
    ssResidual += (point.value - predicted) ** 2;
  }

  if (ssTotal === 0) {
    return 1;
  }

  return Math.max(0, Math.min(1, 1 - ssResidual / ssTotal));
}
