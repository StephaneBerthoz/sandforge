import { describe, it, expect, beforeEach } from 'vitest';
import { StorageOptimizer } from './StorageOptimizer';
import type { StorageRecommendation } from '@sandforge/shared';

describe('StorageOptimizer', () => {
  let optimizer: StorageOptimizer;

  beforeEach(() => {
    optimizer = new StorageOptimizer();
  });

  describe('analyze', () => {
    it('should recommend archive for high record count and large size', () => {
      const stats = [{ objectApiName: 'EventLog', recordCount: 200000, size: 80_000_000 }];

      const recommendations = optimizer.analyze('org-1', stats);

      expect(recommendations).toHaveLength(1);
      expect(recommendations[0].recommendation).toBe('archive');
    });

    it('should recommend delete for high record count but moderate size', () => {
      const stats = [{ objectApiName: 'Task', recordCount: 200000, size: 10_000_000 }];

      const recommendations = optimizer.analyze('org-1', stats);

      expect(recommendations).toHaveLength(1);
      expect(recommendations[0].recommendation).toBe('delete');
    });

    it('should recommend compress for large size but moderate records', () => {
      const stats = [{ objectApiName: 'Attachment', recordCount: 5000, size: 80_000_000 }];

      const recommendations = optimizer.analyze('org-1', stats);

      expect(recommendations).toHaveLength(1);
      expect(recommendations[0].recommendation).toBe('compress');
    });

    it('should recommend optimize for many records but small size', () => {
      const stats = [{ objectApiName: 'Log__c', recordCount: 50000, size: 500_000 }];

      const recommendations = optimizer.analyze('org-1', stats);

      expect(recommendations).toHaveLength(1);
      expect(recommendations[0].recommendation).toBe('optimize');
    });

    it('should return no recommendations for small objects', () => {
      const stats = [{ objectApiName: 'Account', recordCount: 100, size: 5000 }];

      const recommendations = optimizer.analyze('org-1', stats);

      expect(recommendations).toHaveLength(0);
    });

    it('should handle multiple objects', () => {
      const stats = [
        { objectApiName: 'EventLog', recordCount: 200000, size: 80_000_000 },
        { objectApiName: 'Account', recordCount: 100, size: 5000 },
        { objectApiName: 'Attachment', recordCount: 5000, size: 80_000_000 },
      ];

      const recommendations = optimizer.analyze('org-1', stats);

      expect(recommendations).toHaveLength(2);
    });

    it('should include estimated savings in each recommendation', () => {
      const stats = [{ objectApiName: 'EventLog', recordCount: 200000, size: 80_000_000 }];

      const recommendations = optimizer.analyze('org-1', stats);

      expect(recommendations[0].estimatedSaving).toBeGreaterThan(0);
    });
  });

  describe('getTopConsumers', () => {
    it('should return top N consumers sorted by size descending', () => {
      const stats = [
        { objectApiName: 'A', size: 100 },
        { objectApiName: 'B', size: 300 },
        { objectApiName: 'C', size: 200 },
      ];

      const top = optimizer.getTopConsumers(stats, 2);

      expect(top).toHaveLength(2);
      expect(top[0].objectApiName).toBe('B');
      expect(top[1].objectApiName).toBe('C');
    });

    it('should return all if limit exceeds count', () => {
      const stats = [{ objectApiName: 'A', size: 100 }];

      const top = optimizer.getTopConsumers(stats, 10);

      expect(top).toHaveLength(1);
    });
  });

  describe('estimateSavings', () => {
    it('should sum up estimated savings from all recommendations', () => {
      const recommendations: StorageRecommendation[] = [
        {
          objectApiName: 'A',
          currentRecords: 100,
          currentSize: 1000,
          recommendation: 'archive',
          estimatedSaving: 500,
          reason: 'test',
        },
        {
          objectApiName: 'B',
          currentRecords: 200,
          currentSize: 2000,
          recommendation: 'delete',
          estimatedSaving: 1000,
          reason: 'test',
        },
      ];

      expect(optimizer.estimateSavings(recommendations)).toBe(1500);
    });

    it('should return 0 for empty recommendations', () => {
      expect(optimizer.estimateSavings([])).toBe(0);
    });
  });
});
