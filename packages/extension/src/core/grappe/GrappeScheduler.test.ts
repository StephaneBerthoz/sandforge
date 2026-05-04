import { describe, it, expect, beforeEach } from 'vitest';
import { GrappeScheduler } from './GrappeScheduler';
import type { GrappePartition, GrappeProgress } from '@sandforge/shared';

function createPartition(overrides: Partial<GrappePartition> = {}): GrappePartition {
  const progress: GrappeProgress = {
    processedRecords: 0,
    totalRecords: 5,
    successCount: 0,
    failureCount: 0,
    percentage: 0,
    recordsPerSecond: 0,
  };

  return {
    id: 'p-001',
    index: 0,
    totalPartitions: 1,
    recordCount: 5,
    records: ['r1', 'r2', 'r3', 'r4', 'r5'],
    dependencies: [],
    status: 'pending',
    progress,
    retryCount: 0,
    ...overrides,
  };
}

describe('GrappeScheduler', () => {
  let scheduler: GrappeScheduler;

  beforeEach(() => {
    scheduler = new GrappeScheduler();
  });

  describe('schedule', () => {
    it('should return empty array for empty input', () => {
      expect(scheduler.schedule([])).toEqual([]);
    });

    it('should place all independent partitions in a single wave', () => {
      const partitions = [
        createPartition({ id: 'p1' }),
        createPartition({ id: 'p2' }),
        createPartition({ id: 'p3' }),
      ];

      const waves = scheduler.schedule(partitions);

      expect(waves).toHaveLength(1);
      expect(waves[0]).toHaveLength(3);
    });

    it('should create multiple waves for dependent partitions', () => {
      const partitions = [
        createPartition({ id: 'parent', dependencies: [] }),
        createPartition({ id: 'child', dependencies: ['parent'] }),
      ];

      const waves = scheduler.schedule(partitions);

      expect(waves).toHaveLength(2);
      expect(waves[0].map((p) => p.id)).toContain('parent');
      expect(waves[1].map((p) => p.id)).toContain('child');
    });

    it('should handle a chain of dependencies (A -> B -> C)', () => {
      const partitions = [
        createPartition({ id: 'C', dependencies: ['B'] }),
        createPartition({ id: 'B', dependencies: ['A'] }),
        createPartition({ id: 'A', dependencies: [] }),
      ];

      const waves = scheduler.schedule(partitions);

      expect(waves).toHaveLength(3);
      expect(waves[0].map((p) => p.id)).toEqual(['A']);
      expect(waves[1].map((p) => p.id)).toEqual(['B']);
      expect(waves[2].map((p) => p.id)).toEqual(['C']);
    });

    it('should handle circular dependencies by grouping remaining in last wave', () => {
      const partitions = [
        createPartition({ id: 'x', dependencies: ['y'] }),
        createPartition({ id: 'y', dependencies: ['x'] }),
      ];

      const waves = scheduler.schedule(partitions);

      const allIds = waves.flatMap((w) => w.map((p) => p.id));
      expect(allIds).toContain('x');
      expect(allIds).toContain('y');
    });

    it('should handle diamond dependencies', () => {
      const partitions = [
        createPartition({ id: 'A', dependencies: [] }),
        createPartition({ id: 'B', dependencies: ['A'] }),
        createPartition({ id: 'C', dependencies: ['A'] }),
        createPartition({ id: 'D', dependencies: ['B', 'C'] }),
      ];

      const waves = scheduler.schedule(partitions);

      expect(waves.length).toBeGreaterThanOrEqual(3);
      const waveIds = waves.map((w) => w.map((p) => p.id));
      expect(waveIds[0]).toContain('A');
      expect(waveIds[1]).toContain('B');
      expect(waveIds[1]).toContain('C');
    });
  });

  describe('getNextBatch', () => {
    it('should return pending partitions with satisfied dependencies', () => {
      const partitions = [
        createPartition({ id: 'p1', dependencies: [] }),
        createPartition({ id: 'p2', dependencies: ['p1'] }),
      ];

      const completed = new Set<string>();
      const batch = scheduler.getNextBatch(partitions, completed);

      expect(batch.map((p) => p.id)).toEqual(['p1']);
    });

    it('should include dependent partitions after their dependencies complete', () => {
      const partitions = [
        createPartition({ id: 'p1', status: 'completed', dependencies: [] }),
        createPartition({ id: 'p2', dependencies: ['p1'] }),
      ];

      const completed = new Set(['p1']);
      const batch = scheduler.getNextBatch(partitions, completed);

      expect(batch.map((p) => p.id)).toEqual(['p2']);
    });

    it('should not include already completed partitions', () => {
      const partitions = [createPartition({ id: 'p1', dependencies: [] })];

      const completed = new Set(['p1']);
      const batch = scheduler.getNextBatch(partitions, completed);

      expect(batch).toHaveLength(0);
    });
  });

  describe('canExecute', () => {
    it('should return true for partitions with no dependencies', () => {
      const partition = createPartition({ dependencies: [] });
      expect(scheduler.canExecute(partition, new Set())).toBe(true);
    });

    it('should return false when dependencies are not met', () => {
      const partition = createPartition({ dependencies: ['dep1'] });
      expect(scheduler.canExecute(partition, new Set())).toBe(false);
    });

    it('should return true when all dependencies are in the completed set', () => {
      const partition = createPartition({
        dependencies: ['dep1', 'dep2'],
      });
      expect(scheduler.canExecute(partition, new Set(['dep1', 'dep2']))).toBe(true);
    });
  });

  describe('reorderByPriority', () => {
    it('should place partitions with fewer dependencies first', () => {
      const partitions = [
        createPartition({ id: 'many', dependencies: ['a', 'b', 'c'] }),
        createPartition({ id: 'none', dependencies: [] }),
        createPartition({ id: 'one', dependencies: ['a'] }),
      ];

      const ordered = scheduler.reorderByPriority(partitions);

      expect(ordered[0].id).toBe('none');
      expect(ordered[1].id).toBe('one');
      expect(ordered[2].id).toBe('many');
    });

    it('should use record count as tiebreaker', () => {
      const partitions = [
        createPartition({ id: 'big', recordCount: 100, dependencies: [] }),
        createPartition({ id: 'small', recordCount: 10, dependencies: [] }),
      ];

      const ordered = scheduler.reorderByPriority(partitions);

      expect(ordered[0].id).toBe('small');
      expect(ordered[1].id).toBe('big');
    });

    it('should not mutate the original array', () => {
      const partitions = [
        createPartition({ id: 'b', dependencies: ['x'] }),
        createPartition({ id: 'a', dependencies: [] }),
      ];

      const ordered = scheduler.reorderByPriority(partitions);

      expect(partitions[0].id).toBe('b');
      expect(ordered[0].id).toBe('a');
    });
  });
});
