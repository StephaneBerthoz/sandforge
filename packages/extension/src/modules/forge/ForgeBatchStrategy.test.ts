import { describe, it, expect } from 'vitest';
import { ForgeBatchStrategy } from './ForgeBatchStrategy.js';

describe('ForgeBatchStrategy', () => {
  const strategy = new ForgeBatchStrategy();

  describe('auto strategy', () => {
    it('should return REST for <=200 records', () => {
      const result = strategy.resolve('auto', 200);
      expect(result.api).toBe('rest');
      expect(result.batchSize).toBe(200);
      expect(result.batchCount).toBe(1);
    });

    it('should return Bulk for >200 records', () => {
      const result = strategy.resolve('auto', 500);
      expect(result.api).toBe('bulk');
      expect(result.batchSize).toBe(10000);
      expect(result.batchCount).toBe(1);
    });

    it('should return REST for 0 records', () => {
      const result = strategy.resolve('auto', 0);
      expect(result.api).toBe('rest');
      expect(result.batchCount).toBe(1);
    });

    it('should return Bulk with multiple batches for large sets', () => {
      const result = strategy.resolve('auto', 25000);
      expect(result.api).toBe('bulk');
      expect(result.batchSize).toBe(10000);
      expect(result.batchCount).toBe(3);
    });
  });

  describe('explicit overrides', () => {
    it('should respect explicit rest override even for large sets', () => {
      const result = strategy.resolve('rest', 5000);
      expect(result.api).toBe('rest');
      expect(result.batchSize).toBe(200);
      expect(result.batchCount).toBe(25);
    });

    it('should respect explicit bulk override even for small sets', () => {
      const result = strategy.resolve('bulk', 50);
      expect(result.api).toBe('bulk');
      expect(result.batchSize).toBe(10000);
      expect(result.batchCount).toBe(1);
    });
  });

  describe('batch count calculation', () => {
    it('should calculate exact batch count for REST', () => {
      const result = strategy.resolve('rest', 600);
      expect(result.batchCount).toBe(3); // ceil(600/200)
    });

    it('should handle partial last batch', () => {
      const result = strategy.resolve('rest', 401);
      expect(result.batchCount).toBe(3); // ceil(401/200)
    });
  });
});
