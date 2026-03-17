import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnalyticsCollector } from './AnalyticsCollector';

describe('AnalyticsCollector', () => {
  let collector: AnalyticsCollector;

  beforeEach(() => {
    collector = new AnalyticsCollector();
  });

  describe('recordMetric', () => {
    it('should record a metric and increase total data points', () => {
      collector.recordMetric('records_processed', 100);

      const summary = collector.getSummary();
      expect(summary.totalDataPoints).toBe(1);
      expect(summary.metrics).toContain('records_processed');
    });

    it('should record multiple metrics with different names', () => {
      collector.recordMetric('records_processed', 100);
      collector.recordMetric('api_calls', 5);
      collector.recordMetric('records_processed', 200);

      const summary = collector.getSummary();
      expect(summary.totalDataPoints).toBe(3);
      expect(summary.metrics).toHaveLength(2);
      expect(summary.metrics).toContain('records_processed');
      expect(summary.metrics).toContain('api_calls');
    });

    it('should store dimensions when provided', () => {
      collector.recordMetric('api_calls', 1, { org: 'prod', module: 'seed' });

      const series = collector.getTimeSeries('api_calls', 'day', 'count');
      expect(series.points).toHaveLength(1);
    });

    it('should use empty dimensions when none are provided', () => {
      collector.recordMetric('test', 42);

      const series = collector.getTimeSeries('test', 'day', 'sum');
      expect(series.points[0].dimensions).toEqual({});
    });
  });

  describe('getTimeSeries', () => {
    it('should return an empty time series for an unknown metric', () => {
      const series = collector.getTimeSeries('unknown', 'day', 'sum');

      expect(series.metric).toBe('unknown');
      expect(series.points).toHaveLength(0);
      expect(series.aggregation).toBe('sum');
      expect(series.interval).toBe('day');
    });

    it('should aggregate with sum', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-15T10:00:00.000Z'));

      collector.recordMetric('ops', 10);
      collector.recordMetric('ops', 20);
      collector.recordMetric('ops', 30);

      vi.useRealTimers();

      const series = collector.getTimeSeries('ops', 'day', 'sum');
      expect(series.points).toHaveLength(1);
      expect(series.points[0].value).toBe(60);
    });

    it('should aggregate with avg', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-15T10:00:00.000Z'));

      collector.recordMetric('ops', 10);
      collector.recordMetric('ops', 20);
      collector.recordMetric('ops', 30);

      vi.useRealTimers();

      const series = collector.getTimeSeries('ops', 'day', 'avg');
      expect(series.points[0].value).toBe(20);
    });

    it('should aggregate with min', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-15T10:00:00.000Z'));

      collector.recordMetric('ops', 10);
      collector.recordMetric('ops', 5);
      collector.recordMetric('ops', 30);

      vi.useRealTimers();

      const series = collector.getTimeSeries('ops', 'day', 'min');
      expect(series.points[0].value).toBe(5);
    });

    it('should aggregate with max', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-15T10:00:00.000Z'));

      collector.recordMetric('ops', 10);
      collector.recordMetric('ops', 50);
      collector.recordMetric('ops', 30);

      vi.useRealTimers();

      const series = collector.getTimeSeries('ops', 'day', 'max');
      expect(series.points[0].value).toBe(50);
    });

    it('should aggregate with count', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-15T10:00:00.000Z'));

      collector.recordMetric('ops', 10);
      collector.recordMetric('ops', 20);
      collector.recordMetric('ops', 30);

      vi.useRealTimers();

      const series = collector.getTimeSeries('ops', 'day', 'count');
      expect(series.points[0].value).toBe(3);
    });

    it('should group points by day interval into separate buckets', () => {
      vi.useFakeTimers();

      vi.setSystemTime(new Date('2026-01-15T10:00:00.000Z'));
      collector.recordMetric('ops', 10);

      vi.setSystemTime(new Date('2026-01-16T14:00:00.000Z'));
      collector.recordMetric('ops', 20);

      vi.useRealTimers();

      const series = collector.getTimeSeries('ops', 'day', 'sum');
      expect(series.points).toHaveLength(2);
      expect(series.points[0].value).toBe(10);
      expect(series.points[1].value).toBe(20);
    });

    it('should group points by hour interval', () => {
      vi.useFakeTimers();

      vi.setSystemTime(new Date('2026-01-15T10:05:00.000Z'));
      collector.recordMetric('ops', 10);

      vi.setSystemTime(new Date('2026-01-15T10:30:00.000Z'));
      collector.recordMetric('ops', 20);

      vi.setSystemTime(new Date('2026-01-15T11:05:00.000Z'));
      collector.recordMetric('ops', 30);

      vi.useRealTimers();

      const series = collector.getTimeSeries('ops', 'hour', 'sum');
      expect(series.points).toHaveLength(2);
      expect(series.points[0].value).toBe(30);
      expect(series.points[1].value).toBe(30);
    });

    it('should filter only the requested metric', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-15T10:00:00.000Z'));

      collector.recordMetric('alpha', 10);
      collector.recordMetric('beta', 999);
      collector.recordMetric('alpha', 20);

      vi.useRealTimers();

      const series = collector.getTimeSeries('alpha', 'day', 'sum');
      expect(series.points).toHaveLength(1);
      expect(series.points[0].value).toBe(30);
    });

    it('should sort points chronologically', () => {
      vi.useFakeTimers();

      vi.setSystemTime(new Date('2026-01-17T10:00:00.000Z'));
      collector.recordMetric('ops', 30);

      vi.setSystemTime(new Date('2026-01-15T10:00:00.000Z'));
      collector.recordMetric('ops', 10);

      vi.setSystemTime(new Date('2026-01-16T10:00:00.000Z'));
      collector.recordMetric('ops', 20);

      vi.useRealTimers();

      const series = collector.getTimeSeries('ops', 'day', 'sum');
      expect(series.points).toHaveLength(3);
      expect(series.points[0].value).toBe(10);
      expect(series.points[1].value).toBe(20);
      expect(series.points[2].value).toBe(30);
    });
  });

  describe('getSummary', () => {
    it('should return zero totals when empty', () => {
      const summary = collector.getSummary();

      expect(summary.totalDataPoints).toBe(0);
      expect(summary.metrics).toHaveLength(0);
    });

    it('should return accurate counts and unique metric names', () => {
      collector.recordMetric('a', 1);
      collector.recordMetric('b', 2);
      collector.recordMetric('a', 3);
      collector.recordMetric('c', 4);

      const summary = collector.getSummary();
      expect(summary.totalDataPoints).toBe(4);
      expect(summary.metrics).toHaveLength(3);
      expect(summary.metrics).toContain('a');
      expect(summary.metrics).toContain('b');
      expect(summary.metrics).toContain('c');
    });
  });

  describe('clear', () => {
    it('should remove all data points', () => {
      collector.recordMetric('a', 1);
      collector.recordMetric('b', 2);

      collector.clear();

      const summary = collector.getSummary();
      expect(summary.totalDataPoints).toBe(0);
      expect(summary.metrics).toHaveLength(0);
    });

    it('should allow recording new metrics after clear', () => {
      collector.recordMetric('old', 1);
      collector.clear();
      collector.recordMetric('new', 2);

      const summary = collector.getSummary();
      expect(summary.totalDataPoints).toBe(1);
      expect(summary.metrics).toEqual(['new']);
    });
  });
});
