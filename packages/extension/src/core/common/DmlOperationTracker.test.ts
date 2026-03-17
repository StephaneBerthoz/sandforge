import { describe, it, expect } from 'vitest';
import { DmlOperationTracker } from './DmlOperationTracker';

describe('DmlOperationTracker', () => {
  function createTracker(ttlMs = 60_000, now = Date.now): DmlOperationTracker {
    return new DmlOperationTracker(ttlMs, now);
  }

  describe('register', () => {
    it('should register a new operation', () => {
      const tracker = createTracker();
      const entry = tracker.register('op-1', 'Account', 'insert', 100);

      expect(entry.operationId).toBe('op-1');
      expect(entry.objectApiName).toBe('Account');
      expect(entry.dmlType).toBe('insert');
      expect(entry.recordCount).toBe(100);
      expect(entry.status).toBe('pending');
    });

    it('should throw on duplicate operationId', () => {
      const tracker = createTracker();
      tracker.register('op-1', 'Account', 'insert', 100);

      expect(() => tracker.register('op-1', 'Account', 'insert', 50)).toThrow(
        'Duplicate DML operation detected: op-1'
      );
    });

    it('should allow different operationIds', () => {
      const tracker = createTracker();
      tracker.register('op-1', 'Account', 'insert', 100);
      tracker.register('op-2', 'Account', 'insert', 200);

      expect(tracker.size).toBe(2);
    });
  });

  describe('isDuplicate', () => {
    it('should return false for unknown operationId', () => {
      const tracker = createTracker();
      expect(tracker.isDuplicate('op-unknown')).toBe(false);
    });

    it('should return true for registered operationId', () => {
      const tracker = createTracker();
      tracker.register('op-1', 'Account', 'insert', 100);
      expect(tracker.isDuplicate('op-1')).toBe(true);
    });
  });

  describe('markCompleted / markFailed', () => {
    it('should mark operation as completed', () => {
      const tracker = createTracker();
      tracker.register('op-1', 'Account', 'insert', 100);
      tracker.markCompleted('op-1');

      expect(tracker.get('op-1')?.status).toBe('completed');
    });

    it('should mark operation as failed', () => {
      const tracker = createTracker();
      tracker.register('op-1', 'Account', 'insert', 100);
      tracker.markFailed('op-1');

      expect(tracker.get('op-1')?.status).toBe('failed');
    });

    it('should not throw for unknown operationId', () => {
      const tracker = createTracker();
      expect(() => tracker.markCompleted('unknown')).not.toThrow();
      expect(() => tracker.markFailed('unknown')).not.toThrow();
    });
  });

  describe('TTL pruning', () => {
    it('should prune expired entries on isDuplicate', () => {
      let now = 1000;
      const tracker = createTracker(500, () => now);
      tracker.register('op-1', 'Account', 'insert', 100);

      now = 2000; // 1000ms later, TTL is 500ms

      expect(tracker.isDuplicate('op-1')).toBe(false);
      expect(tracker.size).toBe(0);
    });

    it('should keep non-expired entries', () => {
      let now = 1000;
      const tracker = createTracker(5000, () => now);
      tracker.register('op-1', 'Account', 'insert', 100);

      now = 2000; // 1000ms later, TTL is 5000ms

      expect(tracker.isDuplicate('op-1')).toBe(true);
    });
  });

  describe('clear', () => {
    it('should remove all tracked operations', () => {
      const tracker = createTracker();
      tracker.register('op-1', 'Account', 'insert', 100);
      tracker.register('op-2', 'Contact', 'update', 50);

      tracker.clear();
      expect(tracker.size).toBe(0);
    });
  });
});
