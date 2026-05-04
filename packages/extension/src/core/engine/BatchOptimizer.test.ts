import { describe, it, expect, beforeEach } from 'vitest';
import { BatchOptimizer } from './BatchOptimizer';
import type { ObjectProfile, BatchHistory } from './BatchOptimizer';

function createSimpleProfile(overrides?: Partial<ObjectProfile>): ObjectProfile {
  return {
    objectName: 'Account',
    fieldCount: 20,
    averageRecordSizeBytes: 500,
    hasTriggersActive: false,
    hasFlowsActive: false,
    hasValidationRules: false,
    ...overrides,
  };
}

function createHistoryEntry(overrides?: Partial<BatchHistory>): BatchHistory {
  return {
    objectName: 'Account',
    batchSize: 10_000,
    durationMs: 5000,
    errorRate: 0,
    timestamp: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('BatchOptimizer', () => {
  let optimizer: BatchOptimizer;

  beforeEach(() => {
    optimizer = new BatchOptimizer();
  });

  describe('calculateOptimalBatchSize', () => {
    it('should return base size of 10000 for a simple object with no penalties', () => {
      const profile = createSimpleProfile();
      const result = optimizer.calculateOptimalBatchSize(profile);

      expect(result.recommendedBatchSize).toBe(10_000);
      expect(result.reason).toContain('no reductions needed');
    });

    it('should reduce by 40% when field count exceeds 50', () => {
      const profile = createSimpleProfile({ fieldCount: 80 });
      const result = optimizer.calculateOptimalBatchSize(profile);

      expect(result.recommendedBatchSize).toBe(6000);
      expect(result.reason).toContain('high field count');
    });

    it('should reduce by 30% when triggers are active', () => {
      const profile = createSimpleProfile({ hasTriggersActive: true });
      const result = optimizer.calculateOptimalBatchSize(profile);

      expect(result.recommendedBatchSize).toBe(7000);
      expect(result.reason).toContain('active triggers');
    });

    it('should reduce by 20% when flows are active', () => {
      const profile = createSimpleProfile({ hasFlowsActive: true });
      const result = optimizer.calculateOptimalBatchSize(profile);

      expect(result.recommendedBatchSize).toBe(8000);
      expect(result.reason).toContain('active flows');
    });

    it('should reduce by 10% when validation rules are present', () => {
      const profile = createSimpleProfile({ hasValidationRules: true });
      const result = optimizer.calculateOptimalBatchSize(profile);

      expect(result.recommendedBatchSize).toBe(9000);
      expect(result.reason).toContain('validation rules');
    });

    it('should apply cumulative reductions for multiple factors', () => {
      const profile = createSimpleProfile({
        fieldCount: 80,
        hasTriggersActive: true,
        hasFlowsActive: true,
        hasValidationRules: true,
      });
      const result = optimizer.calculateOptimalBatchSize(profile);

      // 10000 * 0.6 * 0.7 * 0.8 * 0.9 = 3024
      expect(result.recommendedBatchSize).toBe(3024);
      expect(result.reason).toContain('high field count');
      expect(result.reason).toContain('active triggers');
      expect(result.reason).toContain('active flows');
      expect(result.reason).toContain('validation rules');
    });

    it('should reduce by 30% when historical error rate exceeds 5%', () => {
      const profile = createSimpleProfile();
      const history: BatchHistory[] = [
        createHistoryEntry({ errorRate: 10 }),
        createHistoryEntry({ errorRate: 8 }),
      ];
      const result = optimizer.calculateOptimalBatchSize(profile, history);

      expect(result.recommendedBatchSize).toBe(7000);
      expect(result.reason).toContain('high error rate');
    });

    it('should not reduce for error rate when average is at or below 5%', () => {
      const profile = createSimpleProfile();
      const history: BatchHistory[] = [
        createHistoryEntry({ errorRate: 3 }),
        createHistoryEntry({ errorRate: 5 }),
      ];
      const result = optimizer.calculateOptimalBatchSize(profile, history);

      // Average = 4%, no reduction
      expect(result.recommendedBatchSize).toBe(10_000);
    });

    it('should enforce minimum batch size of 200', () => {
      const profile = createSimpleProfile({
        fieldCount: 100,
        hasTriggersActive: true,
        hasFlowsActive: true,
        hasValidationRules: true,
      });
      const history: BatchHistory[] = [createHistoryEntry({ errorRate: 50 })];
      const result = optimizer.calculateOptimalBatchSize(profile, history);

      // Even with all penalties the minimum is enforced
      expect(result.recommendedBatchSize).toBe(Math.max(200, result.recommendedBatchSize));
      expect(result.recommendedBatchSize).toBeGreaterThanOrEqual(200);
    });

    it('should use stored history when no explicit history is provided', () => {
      const profile = createSimpleProfile({ objectName: 'Contact' });
      optimizer.recordExecution(createHistoryEntry({ objectName: 'Contact', errorRate: 20 }));

      const result = optimizer.calculateOptimalBatchSize(profile);

      expect(result.recommendedBatchSize).toBe(7000);
      expect(result.reason).toContain('high error rate');
    });

    it('should prefer explicit history over stored history', () => {
      const profile = createSimpleProfile({ objectName: 'Lead' });
      optimizer.recordExecution(createHistoryEntry({ objectName: 'Lead', errorRate: 20 }));

      const explicitHistory: BatchHistory[] = [
        createHistoryEntry({ objectName: 'Lead', errorRate: 0 }),
      ];
      const result = optimizer.calculateOptimalBatchSize(profile, explicitHistory);

      expect(result.recommendedBatchSize).toBe(10_000);
    });

    it('should return a confidence value between 0 and 1', () => {
      const profile = createSimpleProfile();
      const result = optimizer.calculateOptimalBatchSize(profile);

      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('should increase confidence with more history data', () => {
      const profile = createSimpleProfile();
      const noHistoryResult = optimizer.calculateOptimalBatchSize(profile, []);

      const richHistory = Array.from({ length: 10 }, () => createHistoryEntry({ errorRate: 1 }));
      const withHistoryResult = optimizer.calculateOptimalBatchSize(profile, richHistory);

      expect(withHistoryResult.confidence).toBeGreaterThan(noHistoryResult.confidence);
    });
  });

  describe('recordExecution', () => {
    it('should store history entries grouped by object name', () => {
      optimizer.recordExecution(createHistoryEntry({ objectName: 'Account' }));
      optimizer.recordExecution(createHistoryEntry({ objectName: 'Account' }));
      optimizer.recordExecution(createHistoryEntry({ objectName: 'Contact' }));

      expect(optimizer.getHistory('Account')).toHaveLength(2);
      expect(optimizer.getHistory('Contact')).toHaveLength(1);
    });
  });

  describe('getHistory', () => {
    it('should return an empty array for unknown objects', () => {
      expect(optimizer.getHistory('Unknown')).toEqual([]);
    });

    it('should return all entries for a known object', () => {
      const entry = createHistoryEntry({ objectName: 'Case', durationMs: 1234 });
      optimizer.recordExecution(entry);

      const history = optimizer.getHistory('Case');

      expect(history).toHaveLength(1);
      expect(history[0].durationMs).toBe(1234);
    });
  });

  describe('clearHistory', () => {
    it('should remove all stored history', () => {
      optimizer.recordExecution(createHistoryEntry({ objectName: 'Account' }));
      optimizer.recordExecution(createHistoryEntry({ objectName: 'Contact' }));

      optimizer.clearHistory();

      expect(optimizer.getHistory('Account')).toEqual([]);
      expect(optimizer.getHistory('Contact')).toEqual([]);
    });
  });
});
