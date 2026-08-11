import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApexLogAnalyzer } from './ApexLogAnalyzer';
import type { FetchLogsFn } from './ApexLogAnalyzer';
import type { ApexLogEntry } from '@sandforge/shared';

function createMockLog(overrides?: Partial<ApexLogEntry>): ApexLogEntry {
  return {
    id: 'log-1',
    operation: 'AccountTrigger',
    status: 'Success',
    durationMs: 1000,
    logSize: 5000,
    startTime: '2026-01-01T10:00:00Z',
    user: 'admin@sandbox.com',
    ...overrides,
  };
}

describe('ApexLogAnalyzer', () => {
  let analyzer: ApexLogAnalyzer;
  let fetchLogs: FetchLogsFn;

  beforeEach(() => {
    fetchLogs = vi
      .fn<FetchLogsFn>()
      .mockResolvedValue([
        createMockLog({ id: 'log-1', durationMs: 1000, logSize: 5000 }),
        createMockLog({ id: 'log-2', durationMs: 8000, logSize: 60000 }),
        createMockLog({ id: 'log-3', durationMs: 500, logSize: 200 }),
      ]);
    analyzer = new ApexLogAnalyzer(fetchLogs);
  });

  describe('analyze', () => {
    it('should return analysis with correct logId', () => {
      const log = createMockLog({ id: 'log-42' });
      const result = analyzer.analyze(log);
      expect(result.logId).toBe('log-42');
    });

    it('should set totalDuration from log durationMs', () => {
      const log = createMockLog({ durationMs: 3500 });
      const result = analyzer.analyze(log);
      expect(result.totalDuration).toBe(3500);
    });

    it('should estimate SOQL queries based on log size', () => {
      const log = createMockLog({ logSize: 10000 });
      const result = analyzer.analyze(log);
      expect(result.soqlQueries).toBe(20);
    });

    it('should estimate DML statements based on log size', () => {
      const log = createMockLog({ logSize: 5000 });
      const result = analyzer.analyze(log);
      expect(result.dmlStatements).toBe(5);
    });

    it('should estimate heap usage based on log size', () => {
      const log = createMockLog({ logSize: 1000 });
      const result = analyzer.analyze(log);
      expect(result.heapUsed).toBe(10000);
    });

    it('should detect slow query issue for long-running logs', () => {
      const log = createMockLog({ durationMs: 6000 });
      const result = analyzer.analyze(log);
      const slowIssues = result.issues.filter((i) => i.type === 'slow_query');
      expect(slowIssues).toHaveLength(1);
      expect(slowIssues[0].severity).toBe('warning');
    });

    it('should detect SOQL limit warning for large logs', () => {
      const log = createMockLog({ logSize: 45000 });
      const result = analyzer.analyze(log);
      const soqlIssues = result.issues.filter(
        (i) =>
          i.type === 'soql_in_loop' ||
          (i.type === 'governor_warning' && i.message.includes('SOQL')),
      );
      expect(soqlIssues.length).toBeGreaterThan(0);
    });

    it('should detect critical SOQL issue at the limit', () => {
      const log = createMockLog({ logSize: 50000 });
      const result = analyzer.analyze(log);
      const criticalSoql = result.issues.filter(
        (i) => i.type === 'soql_in_loop' && i.severity === 'critical',
      );
      expect(criticalSoql).toHaveLength(1);
    });

    it('should return no issues for small, fast logs', () => {
      const log = createMockLog({ durationMs: 100, logSize: 200 });
      const result = analyzer.analyze(log);
      expect(result.issues).toHaveLength(0);
    });

    it('should cap SOQL estimate at the governor limit', () => {
      const log = createMockLog({ logSize: 100000 });
      const result = analyzer.analyze(log);
      expect(result.soqlQueries).toBeLessThanOrEqual(100);
    });
  });

  describe('fetchAndAnalyze', () => {
    it('should fetch logs and analyze each one', async () => {
      const results = await analyzer.fetchAndAnalyze('org-1');
      expect(results).toHaveLength(3);
      expect(fetchLogs).toHaveBeenCalledWith('org-1', 10);
    });

    it('should cache results for getRecentAnalyses', async () => {
      await analyzer.fetchAndAnalyze('org-1');
      expect(analyzer.getRecentAnalyses('org-1')).toHaveLength(3);
    });
  });

  describe('getRecentAnalyses', () => {
    it('should return empty array for unknown org', () => {
      expect(analyzer.getRecentAnalyses('unknown')).toEqual([]);
    });

    it('should return cached analyses after fetchAndAnalyze', async () => {
      await analyzer.fetchAndAnalyze('org-1');
      const analyses = analyzer.getRecentAnalyses('org-1');
      expect(analyses[0].logId).toBe('log-1');
    });
  });

  describe('getTopIssues', () => {
    it('should return empty array for unknown org', () => {
      expect(analyzer.getTopIssues('unknown')).toEqual([]);
    });

    it('should return issues sorted by frequency', async () => {
      await analyzer.fetchAndAnalyze('org-1');
      const issues = analyzer.getTopIssues('org-1');
      expect(issues.length).toBeGreaterThan(0);
    });

    it('should deduplicate identical issues', async () => {
      vi.mocked(fetchLogs).mockResolvedValue([
        createMockLog({ id: 'log-1', durationMs: 6000, logSize: 200 }),
        createMockLog({ id: 'log-2', durationMs: 6000, logSize: 200 }),
      ]);
      await analyzer.fetchAndAnalyze('org-1');
      const issues = analyzer.getTopIssues('org-1');
      const slowIssues = issues.filter((i) => i.type === 'slow_query');
      expect(slowIssues).toHaveLength(1);
    });
  });
});
