import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JobAnalyzer } from './JobAnalyzer';
import type { AsyncApexJob } from '@sandforge/shared';

function createJob(overrides: Partial<AsyncApexJob> = {}): AsyncApexJob {
  return {
    id: `job-${Math.random().toString(36).slice(2, 8)}`,
    apexClassId: 'cls-001',
    apexClassName: 'BatchAccountSync',
    status: 'Completed',
    jobType: 'BatchApex',
    numberOfErrors: 0,
    totalJobItems: 10,
    jobItemsProcessed: 10,
    createdDate: '2026-02-24T10:00:00Z',
    completedDate: '2026-02-24T10:01:00Z',
    createdById: 'user-001',
    createdByName: 'Admin User',
    ...overrides,
  };
}

describe('JobAnalyzer', () => {
  let analyzer: JobAnalyzer;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-24T12:00:00Z'));
    analyzer = new JobAnalyzer();
  });

  it('should return empty insights for empty jobs', () => {
    const insights = analyzer.analyze([]);
    expect(insights).toHaveLength(0);
  });

  it('should return empty insights for healthy jobs', () => {
    const jobs = [createJob({ status: 'Completed' }), createJob({ status: 'Completed' })];
    const insights = analyzer.analyze(jobs);
    expect(insights).toHaveLength(0);
  });

  describe('frequent failures', () => {
    it('should detect frequent failures (>=3 for same class)', () => {
      const jobs = [
        createJob({ status: 'Failed', extendedStatus: 'System.LimitException' }),
        createJob({ status: 'Failed', extendedStatus: 'System.LimitException' }),
        createJob({ status: 'Failed', extendedStatus: 'System.NullPointerException' }),
      ];
      const insights = analyzer.analyze(jobs);
      const failureInsight = insights.find((i) => i.type === 'frequent_failures');
      expect(failureInsight).toBeDefined();
      expect(failureInsight?.title).toContain('BatchAccountSync');
      expect(failureInsight?.detail).toContain('3 times');
      expect(failureInsight?.detail).toContain('System.LimitException');
      expect(failureInsight?.severity).toBe('warning');
    });

    it('should detect critical severity for >=5 failures', () => {
      const jobs = Array.from({ length: 5 }, () =>
        createJob({ status: 'Failed', extendedStatus: 'System.LimitException' }),
      );
      const insights = analyzer.analyze(jobs);
      const failureInsight = insights.find((i) => i.type === 'frequent_failures');
      expect(failureInsight?.severity).toBe('critical');
    });

    it('should not flag fewer than 3 failures', () => {
      const jobs = [createJob({ status: 'Failed' }), createJob({ status: 'Failed' })];
      const insights = analyzer.analyze(jobs);
      expect(insights.filter((i) => i.type === 'frequent_failures')).toHaveLength(0);
    });

    it('should group failures by class name', () => {
      const jobs = [
        createJob({ apexClassName: 'ClassA', status: 'Failed', extendedStatus: 'err' }),
        createJob({ apexClassName: 'ClassA', status: 'Failed', extendedStatus: 'err' }),
        createJob({ apexClassName: 'ClassA', status: 'Failed', extendedStatus: 'err' }),
        createJob({ apexClassName: 'ClassB', status: 'Failed', extendedStatus: 'err' }),
      ];
      const insights = analyzer.analyze(jobs);
      const failures = insights.filter((i) => i.type === 'frequent_failures');
      expect(failures).toHaveLength(1);
      expect(failures[0].title).toContain('ClassA');
    });
  });

  describe('long running', () => {
    it('should detect long-running completed jobs (>5 min)', () => {
      const jobs = [
        createJob({
          createdDate: '2026-02-24T10:00:00Z',
          completedDate: '2026-02-24T10:10:00Z', // 10 minutes
        }),
      ];
      const insights = analyzer.analyze(jobs);
      const longRunning = insights.find((i) => i.type === 'long_running');
      expect(longRunning).toBeDefined();
      expect(longRunning?.title).toContain('BatchAccountSync');
      expect(longRunning?.detail).toContain('10 minutes');
    });

    it('should not flag jobs under 5 minutes', () => {
      const jobs = [
        createJob({
          createdDate: '2026-02-24T10:00:00Z',
          completedDate: '2026-02-24T10:03:00Z', // 3 minutes
        }),
      ];
      const insights = analyzer.analyze(jobs);
      expect(insights.filter((i) => i.type === 'long_running')).toHaveLength(0);
    });
  });

  describe('high consumers', () => {
    it('should detect high-consumer jobs (>1000 items)', () => {
      const jobs = [createJob({ totalJobItems: 5000, jobItemsProcessed: 5000 })];
      const insights = analyzer.analyze(jobs);
      const highConsumer = insights.find((i) => i.type === 'high_consumer');
      expect(highConsumer).toBeDefined();
      expect(highConsumer?.detail).toContain('5');
      expect(highConsumer?.detail).toContain('000');
      expect(highConsumer?.detail).toContain('batch items');
    });

    it('should not flag jobs with <=1000 items', () => {
      const jobs = [createJob({ totalJobItems: 500 })];
      const insights = analyzer.analyze(jobs);
      expect(insights.filter((i) => i.type === 'high_consumer')).toHaveLength(0);
    });
  });

  describe('stuck jobs', () => {
    it('should detect stuck jobs (Processing >1h)', () => {
      const jobs = [
        createJob({
          status: 'Processing',
          createdDate: '2026-02-24T10:00:00Z', // 2h ago at 12:00
          completedDate: undefined,
        }),
      ];
      const insights = analyzer.analyze(jobs);
      const stuck = insights.find((i) => i.type === 'stuck');
      expect(stuck).toBeDefined();
      expect(stuck?.severity).toBe('critical');
      expect(stuck?.title).toContain('BatchAccountSync');
      expect(stuck?.detail).toContain('2h');
    });

    it('should not flag recent processing jobs', () => {
      const jobs = [
        createJob({
          status: 'Processing',
          createdDate: '2026-02-24T11:30:00Z', // 30 min ago
          completedDate: undefined,
        }),
      ];
      const insights = analyzer.analyze(jobs);
      expect(insights.filter((i) => i.type === 'stuck')).toHaveLength(0);
    });
  });

  describe('combined analysis', () => {
    it('should detect multiple insight types simultaneously', () => {
      const jobs = [
        // Frequent failures
        createJob({ apexClassName: 'FailClass', status: 'Failed', extendedStatus: 'err' }),
        createJob({ apexClassName: 'FailClass', status: 'Failed', extendedStatus: 'err' }),
        createJob({ apexClassName: 'FailClass', status: 'Failed', extendedStatus: 'err' }),
        // Stuck
        createJob({
          apexClassName: 'StuckClass',
          status: 'Processing',
          createdDate: '2026-02-24T08:00:00Z',
          completedDate: undefined,
        }),
        // High consumer
        createJob({ apexClassName: 'BigClass', totalJobItems: 2000 }),
      ];
      const insights = analyzer.analyze(jobs);
      expect(insights.filter((i) => i.type === 'frequent_failures')).toHaveLength(1);
      expect(insights.filter((i) => i.type === 'stuck')).toHaveLength(1);
      expect(insights.filter((i) => i.type === 'high_consumer')).toHaveLength(1);
    });

    it('should include affected job IDs', () => {
      const jobs = [
        createJob({ id: 'j1', status: 'Failed', extendedStatus: 'err' }),
        createJob({ id: 'j2', status: 'Failed', extendedStatus: 'err' }),
        createJob({ id: 'j3', status: 'Failed', extendedStatus: 'err' }),
      ];
      const insights = analyzer.analyze(jobs);
      const failureInsight = insights.find((i) => i.type === 'frequent_failures');
      expect(failureInsight?.affectedJobs).toEqual(['j1', 'j2', 'j3']);
    });
  });
});
