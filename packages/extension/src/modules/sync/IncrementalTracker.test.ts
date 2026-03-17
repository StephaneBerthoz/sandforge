import { describe, it, expect, beforeEach } from 'vitest';
import { IncrementalTracker } from './IncrementalTracker';

describe('IncrementalTracker', () => {
  let tracker: IncrementalTracker;

  beforeEach(() => {
    tracker = new IncrementalTracker();
  });

  describe('getLastSync', () => {
    it('should return undefined when no sync has been recorded', () => {
      expect(tracker.getLastSync('config-1', 'Account')).toBeUndefined();
    });

    it('should return the recorded timestamp', () => {
      tracker.recordSync('config-1', 'Account', '2026-02-20T10:00:00Z');

      expect(tracker.getLastSync('config-1', 'Account')).toBe('2026-02-20T10:00:00Z');
    });

    it('should return undefined for a different config', () => {
      tracker.recordSync('config-1', 'Account', '2026-02-20T10:00:00Z');

      expect(tracker.getLastSync('config-2', 'Account')).toBeUndefined();
    });

    it('should return undefined for a different object', () => {
      tracker.recordSync('config-1', 'Account', '2026-02-20T10:00:00Z');

      expect(tracker.getLastSync('config-1', 'Contact')).toBeUndefined();
    });

    it('should track multiple config-object combinations independently', () => {
      tracker.recordSync('config-1', 'Account', '2026-01-01T00:00:00Z');
      tracker.recordSync('config-1', 'Contact', '2026-01-02T00:00:00Z');
      tracker.recordSync('config-2', 'Account', '2026-01-03T00:00:00Z');

      expect(tracker.getLastSync('config-1', 'Account')).toBe('2026-01-01T00:00:00Z');
      expect(tracker.getLastSync('config-1', 'Contact')).toBe('2026-01-02T00:00:00Z');
      expect(tracker.getLastSync('config-2', 'Account')).toBe('2026-01-03T00:00:00Z');
    });
  });

  describe('recordSync', () => {
    it('should store the timestamp', () => {
      tracker.recordSync('config-1', 'Account', '2026-02-20T10:00:00Z');

      expect(tracker.getLastSync('config-1', 'Account')).toBeDefined();
    });

    it('should overwrite a previous timestamp for the same pair', () => {
      tracker.recordSync('config-1', 'Account', '2026-01-01T00:00:00Z');
      tracker.recordSync('config-1', 'Account', '2026-02-01T00:00:00Z');

      expect(tracker.getLastSync('config-1', 'Account')).toBe('2026-02-01T00:00:00Z');
    });

    it('should not affect other config-object pairs', () => {
      tracker.recordSync('config-1', 'Account', '2026-01-01T00:00:00Z');
      tracker.recordSync('config-1', 'Contact', '2026-02-01T00:00:00Z');

      expect(tracker.getLastSync('config-1', 'Account')).toBe('2026-01-01T00:00:00Z');
    });
  });

  describe('reset', () => {
    it('should clear all timestamps for a config', () => {
      tracker.recordSync('config-1', 'Account', '2026-01-01T00:00:00Z');
      tracker.recordSync('config-1', 'Contact', '2026-01-02T00:00:00Z');

      tracker.reset('config-1');

      expect(tracker.getLastSync('config-1', 'Account')).toBeUndefined();
      expect(tracker.getLastSync('config-1', 'Contact')).toBeUndefined();
    });

    it('should not affect other configs', () => {
      tracker.recordSync('config-1', 'Account', '2026-01-01T00:00:00Z');
      tracker.recordSync('config-2', 'Account', '2026-01-02T00:00:00Z');

      tracker.reset('config-1');

      expect(tracker.getLastSync('config-1', 'Account')).toBeUndefined();
      expect(tracker.getLastSync('config-2', 'Account')).toBe('2026-01-02T00:00:00Z');
    });

    it('should handle reset for a config with no recorded syncs', () => {
      expect(() => tracker.reset('non-existent')).not.toThrow();
    });

    it('should allow new syncs to be recorded after reset', () => {
      tracker.recordSync('config-1', 'Account', '2026-01-01T00:00:00Z');
      tracker.reset('config-1');
      tracker.recordSync('config-1', 'Account', '2026-02-01T00:00:00Z');

      expect(tracker.getLastSync('config-1', 'Account')).toBe('2026-02-01T00:00:00Z');
    });
  });
});
