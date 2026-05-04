import type { AnalyticsDataPoint, AnalyticsTimeSeries } from '@sandforge/shared';

/** Summary of all collected analytics data */
export interface AnalyticsSummary {
  totalDataPoints: number;
  metrics: string[];
}

/**
 * Collects analytics data points and provides time-series aggregation.
 * All data is stored in memory and can be queried or cleared.
 */
export class AnalyticsCollector {
  private readonly dataPoints: AnalyticsDataPoint[] = [];

  /**
   * Record a single metric data point.
   * @param metric - The metric name (e.g. 'records_processed')
   * @param value - The numeric value
   * @param dimensions - Optional key-value dimensions for grouping
   */
  recordMetric(metric: string, value: number, dimensions?: Record<string, string>): void {
    const point: AnalyticsDataPoint = {
      metric,
      value,
      timestamp: new Date().toISOString(),
      dimensions: dimensions ?? {},
    };
    this.dataPoints.push(point);
  }

  /**
   * Build a time series for a given metric with the specified interval and aggregation.
   * Points are grouped into time buckets and aggregated according to the chosen function.
   * @param metric - The metric name to query
   * @param interval - The time bucket interval
   * @param aggregation - The aggregation function to apply
   * @returns A time series object with aggregated points
   */
  getTimeSeries(
    metric: string,
    interval: AnalyticsTimeSeries['interval'],
    aggregation: AnalyticsTimeSeries['aggregation'],
  ): AnalyticsTimeSeries {
    const filtered = this.dataPoints.filter((p) => p.metric === metric);
    const buckets = this.groupByInterval(filtered, interval);

    const points: AnalyticsDataPoint[] = [];
    for (const [bucketKey, bucketPoints] of buckets.entries()) {
      const aggregatedValue = this.aggregate(
        bucketPoints.map((p) => p.value),
        aggregation,
      );
      points.push({
        metric,
        value: aggregatedValue,
        timestamp: bucketKey,
        dimensions: {},
      });
    }

    points.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return {
      metric,
      points,
      aggregation,
      interval,
    };
  }

  /**
   * Get a summary of all collected data.
   * @returns Total data point count and list of unique metric names
   */
  getSummary(): AnalyticsSummary {
    const metricSet = new Set<string>();
    for (const point of this.dataPoints) {
      metricSet.add(point.metric);
    }
    return {
      totalDataPoints: this.dataPoints.length,
      metrics: Array.from(metricSet),
    };
  }

  /**
   * Clear all collected data points.
   */
  clear(): void {
    this.dataPoints.length = 0;
  }

  private groupByInterval(
    points: AnalyticsDataPoint[],
    interval: AnalyticsTimeSeries['interval'],
  ): Map<string, AnalyticsDataPoint[]> {
    const buckets = new Map<string, AnalyticsDataPoint[]>();

    for (const point of points) {
      const key = this.getBucketKey(point.timestamp, interval);
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.push(point);
      } else {
        buckets.set(key, [point]);
      }
    }

    return buckets;
  }

  private getBucketKey(timestamp: string, interval: AnalyticsTimeSeries['interval']): string {
    const date = new Date(timestamp);

    switch (interval) {
      case 'minute':
        date.setSeconds(0, 0);
        return date.toISOString();
      case 'hour':
        date.setMinutes(0, 0, 0);
        return date.toISOString();
      case 'day':
        date.setHours(0, 0, 0, 0);
        return date.toISOString();
      case 'week': {
        const dayOfWeek = date.getDay();
        date.setDate(date.getDate() - dayOfWeek);
        date.setHours(0, 0, 0, 0);
        return date.toISOString();
      }
      case 'month':
        date.setDate(1);
        date.setHours(0, 0, 0, 0);
        return date.toISOString();
    }
  }

  private aggregate(values: number[], aggregation: AnalyticsTimeSeries['aggregation']): number {
    if (values.length === 0) {
      return 0;
    }

    switch (aggregation) {
      case 'sum':
        return values.reduce((acc, v) => acc + v, 0);
      case 'avg':
        return values.reduce((acc, v) => acc + v, 0) / values.length;
      case 'min':
        return Math.min(...values);
      case 'max':
        return Math.max(...values);
      case 'count':
        return values.length;
    }
  }
}
