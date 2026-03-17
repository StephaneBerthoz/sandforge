import type { TrendData, LimitsSnapshot } from '@sandforge/shared';

/** Threshold in percentage-point change to be considered "stable". */
const STABLE_THRESHOLD = 2;

/**
 * Options for computing a single trend entry.
 */
export interface ComputeTrendOptions {
  /** The limit name to extract from snapshots. */
  limitName: string;
  /** Historical snapshots (oldest first). */
  snapshots: LimitsSnapshot[];
  /** Whether to compute predictedTimeToLimit when direction is "up". */
  predictTime?: boolean;
}

/**
 * Extract sparkline data (usedPercent values) for a given limit name
 * from an ordered list of snapshots.
 *
 * @param snapshots - Snapshots ordered chronologically (oldest first).
 * @param limitName - The API limit name to extract.
 * @returns An array of usedPercent values for matching entries.
 */
export function extractSparklineData(snapshots: LimitsSnapshot[], limitName: string): number[] {
  const data: number[] = [];
  for (const snapshot of snapshots) {
    const limit = snapshot.limits.find((l) => l.name === limitName);
    if (limit) {
      data.push(limit.usedPercent);
    }
  }
  return data;
}

/**
 * Compute the trend direction and change percent from sparkline data points.
 *
 * @param sparklineData - Array of usedPercent values (oldest to newest).
 * @returns An object with `direction` and `changePercent`.
 */
export function computeTrendDirection(sparklineData: number[]): {
  direction: 'up' | 'down' | 'stable';
  changePercent: number;
} {
  if (sparklineData.length < 2) {
    return { direction: 'stable', changePercent: 0 };
  }

  const first = sparklineData[0];
  const last = sparklineData[sparklineData.length - 1];
  const changePercent = Math.round((last - first) * 10) / 10;
  const absChange = Math.abs(changePercent);

  let direction: 'up' | 'down' | 'stable';
  if (absChange <= STABLE_THRESHOLD) {
    direction = 'stable';
  } else if (changePercent > 0) {
    direction = 'up';
  } else {
    direction = 'down';
  }

  return { direction, changePercent };
}

/**
 * Compute predictedTimeToLimit in hours, estimating when a rising metric
 * will reach 100% based on the observed rate of change.
 *
 * @param snapshots - Snapshots used for the time range calculation.
 * @param changePercent - The observed change in percentage points.
 * @param lastValue - The most recent usedPercent value.
 * @returns Predicted hours until 100%, or `undefined` if not applicable.
 */
export function computePredictedTimeToLimit(
  snapshots: LimitsSnapshot[],
  changePercent: number,
  lastValue: number,
): number | undefined {
  if (lastValue >= 100 || snapshots.length < 2) {
    return undefined;
  }
  const firstTime = new Date(snapshots[0].timestamp).getTime();
  const lastTime = new Date(snapshots[snapshots.length - 1].timestamp).getTime();
  const timeSpanMs = lastTime - firstTime;
  if (timeSpanMs <= 0) {
    return undefined;
  }
  const ratePerMs = changePercent / timeSpanMs;
  if (ratePerMs <= 0) {
    return undefined;
  }
  const remainingPercent = 100 - lastValue;
  const msToLimit = remainingPercent / ratePerMs;
  return Math.round((msToLimit / (60 * 60 * 1000)) * 10) / 10;
}

/**
 * Compute a full TrendData entry for a single limit.
 *
 * Extracts sparkline data from snapshots, derives direction and change,
 * and optionally computes a time-to-limit prediction.
 *
 * @param options - The limit name, snapshots, and feature flags.
 * @returns A complete TrendData object.
 */
export function computeTrendData(options: ComputeTrendOptions): TrendData {
  const { limitName, snapshots, predictTime = false } = options;
  const sparklineData = extractSparklineData(snapshots, limitName);
  const { direction, changePercent } = computeTrendDirection(sparklineData);

  let predictedTimeToLimit: number | undefined;
  if (predictTime && direction === 'up' && sparklineData.length >= 2) {
    const last = sparklineData[sparklineData.length - 1];
    predictedTimeToLimit = computePredictedTimeToLimit(snapshots, changePercent, last);
  }

  return {
    limitName,
    direction,
    changePercent,
    predictedTimeToLimit,
    sparklineData,
  };
}
