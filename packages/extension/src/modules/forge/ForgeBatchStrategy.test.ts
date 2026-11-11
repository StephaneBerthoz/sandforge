import { describe, it, expect } from 'vitest';
import {
  DUPLICATE_RULE_FALLBACK_OBJECTS,
  FORGE_BULK_MIN_ROWS,
  FORGE_REST_ONLY_OBJECTS,
  ForgeBatchStrategy,
} from './ForgeBatchStrategy.js';
import {
  bulkJobRequests,
  bulkJobStateReads,
  FORGE_BULK_POLL_SCHEDULE,
} from '../../core/engine/bulkJobCost.js';

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

    it('plans no batch, on REST, for an object with no record', () => {
      const result = strategy.resolve('auto', 0);
      expect(result.api).toBe('rest');
      expect(result.batchCount).toBe(0);
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

  describe('the Bulk API transport of a run that asks for it', () => {
    it('sends a job from 2 000 rows, where it costs no more calls than the REST calls of 200 it stands for', () => {
      expect(FORGE_BULK_MIN_ROWS).toBe(2_000);
      const job = bulkJobRequests({
        stateReads: bulkJobStateReads(FORGE_BULK_MIN_ROWS, FORGE_BULK_POLL_SCHEDULE),
      });
      expect(job).toBeLessThanOrEqual(FORGE_BULK_MIN_ROWS / 200);
      // The plan's own threshold is not the transport's.
      expect(strategy.resolve('auto', 201).api).toBe('bulk');
    });

    it('writes files, attachments, emails and tasks by REST, and the objects of the standard duplicate rules unless told', () => {
      expect([...FORGE_REST_ONLY_OBJECTS].sort()).toEqual([
        'Attachment',
        'ContentVersion',
        'EmailMessage',
        'Task',
      ]);
      expect([...DUPLICATE_RULE_FALLBACK_OBJECTS].sort()).toEqual(['Account', 'Contact', 'Lead']);
    });
  });
});
