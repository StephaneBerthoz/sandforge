import { describe, it, expect, beforeEach } from 'vitest';
import { GrappePartitioner, generateId } from './GrappePartitioner';
import type { RecordMetadata } from './GrappePartitioner';
import type { GrappeConfig } from '@sandforge/shared';

function createConfig(
  overrides: Partial<GrappeConfig> = {}
): GrappeConfig {
  return {
    enabled: true,
    autoActivateThreshold: 1000,
    maxWorkers: 4,
    grappeSize: 3,
    strategy: 'round_robin',
    backPressure: {
      enabled: true,
      maxQueueDepth: 100,
      highWaterMark: 80,
      lowWaterMark: 60,
      strategy: 'pause',
      monitoringInterval: 1000,
    },
    checkpointing: false,
    isolationLevel: 'none',
    ...overrides,
  };
}

describe('GrappePartitioner', () => {
  let partitioner: GrappePartitioner;

  beforeEach(() => {
    partitioner = new GrappePartitioner();
  });

  describe('generateId', () => {
    it('should generate a UUID-like string', () => {
      const id = generateId();
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
    });

    it('should generate unique IDs', () => {
      const ids = new Set(Array.from({ length: 50 }, () => generateId()));
      expect(ids.size).toBe(50);
    });
  });

  describe('getPartitionCount', () => {
    it('should return 0 for 0 records', () => {
      expect(partitioner.getPartitionCount(0, 10)).toBe(0);
    });

    it('should return 1 for records fitting in one partition', () => {
      expect(partitioner.getPartitionCount(5, 10)).toBe(1);
    });

    it('should round up for partial partitions', () => {
      expect(partitioner.getPartitionCount(7, 3)).toBe(3);
    });

    it('should return exact count for evenly divisible records', () => {
      expect(partitioner.getPartitionCount(9, 3)).toBe(3);
    });
  });

  describe('selectStrategy', () => {
    it('should return the strategy from config', () => {
      const config = createConfig({ strategy: 'by_hash' });
      expect(partitioner.selectStrategy(config)).toBe('by_hash');
    });
  });

  describe('partition — round_robin', () => {
    it('should distribute records evenly across partitions', () => {
      const records = ['a', 'b', 'c', 'd', 'e', 'f'];
      const config = createConfig({ strategy: 'round_robin', grappeSize: 3 });
      const partitions = partitioner.partition(records, config);

      expect(partitions).toHaveLength(2);
      expect(partitions[0].records).toEqual(['a', 'c', 'e']);
      expect(partitions[1].records).toEqual(['b', 'd', 'f']);
    });

    it('should return empty array for empty input', () => {
      const config = createConfig({ strategy: 'round_robin' });
      expect(partitioner.partition([], config)).toEqual([]);
    });

    it('should set correct partition metadata', () => {
      const records = ['a', 'b', 'c'];
      const config = createConfig({ strategy: 'round_robin', grappeSize: 2 });
      const partitions = partitioner.partition(records, config);

      expect(partitions).toHaveLength(2);
      for (const p of partitions) {
        expect(p.status).toBe('pending');
        expect(p.retryCount).toBe(0);
        expect(p.totalPartitions).toBe(2);
        expect(p.id).toBeTruthy();
        expect(p.progress.processedRecords).toBe(0);
      }
    });
  });

  describe('partition — by_record_type', () => {
    it('should group records by record type', () => {
      const metadata: RecordMetadata[] = [
        { id: 'r1', recordTypeId: 'RT1' },
        { id: 'r2', recordTypeId: 'RT2' },
        { id: 'r3', recordTypeId: 'RT1' },
        { id: 'r4', recordTypeId: 'RT2' },
      ];
      partitioner.setMetadata(metadata);

      const config = createConfig({ strategy: 'by_record_type' });
      const partitions = partitioner.partition(
        ['r1', 'r2', 'r3', 'r4'],
        config
      );

      expect(partitions).toHaveLength(2);
      const allRecords = partitions.flatMap((p) => p.records).sort();
      expect(allRecords).toEqual(['r1', 'r2', 'r3', 'r4']);
    });

    it('should place records without metadata in a default group', () => {
      const config = createConfig({ strategy: 'by_record_type' });
      const partitions = partitioner.partition(['a', 'b', 'c'], config);

      expect(partitions).toHaveLength(1);
      expect(partitions[0].records).toEqual(['a', 'b', 'c']);
    });
  });

  describe('partition — by_parent', () => {
    it('should group records by parent ID', () => {
      const metadata: RecordMetadata[] = [
        { id: 'c1', parentId: 'p1' },
        { id: 'c2', parentId: 'p2' },
        { id: 'c3', parentId: 'p1' },
      ];
      partitioner.setMetadata(metadata);

      const config = createConfig({ strategy: 'by_parent' });
      const partitions = partitioner.partition(['c1', 'c2', 'c3'], config);

      expect(partitions).toHaveLength(2);
    });
  });

  describe('partition — by_volume', () => {
    it('should split records into chunks of grappeSize', () => {
      const records = ['a', 'b', 'c', 'd', 'e'];
      const config = createConfig({ strategy: 'by_volume', grappeSize: 2 });
      const partitions = partitioner.partition(records, config);

      expect(partitions).toHaveLength(3);
      expect(partitions[0].records).toEqual(['a', 'b']);
      expect(partitions[1].records).toEqual(['c', 'd']);
      expect(partitions[2].records).toEqual(['e']);
    });
  });

  describe('partition — by_hash', () => {
    it('should distribute all records across partitions', () => {
      const records = ['rec1', 'rec2', 'rec3', 'rec4', 'rec5'];
      const config = createConfig({ strategy: 'by_hash', grappeSize: 3 });
      const partitions = partitioner.partition(records, config);

      const allRecords = partitions.flatMap((p) => p.records).sort();
      expect(allRecords).toEqual([...records].sort());
    });

    it('should produce deterministic results for same inputs', () => {
      const records = ['x', 'y', 'z'];
      const config = createConfig({ strategy: 'by_hash', grappeSize: 2 });
      const first = partitioner.partition(records, config);
      const second = partitioner.partition(records, config);

      expect(first.map((p) => p.records)).toEqual(
        second.map((p) => p.records)
      );
    });
  });

  describe('partition — by_date_range', () => {
    it('should sort records by date and split into partitions', () => {
      const metadata: RecordMetadata[] = [
        { id: 'r1', createdDate: '2024-03-01T00:00:00Z' },
        { id: 'r2', createdDate: '2024-01-01T00:00:00Z' },
        { id: 'r3', createdDate: '2024-02-01T00:00:00Z' },
        { id: 'r4', createdDate: '2024-04-01T00:00:00Z' },
      ];
      partitioner.setMetadata(metadata);

      const config = createConfig({
        strategy: 'by_date_range',
        grappeSize: 2,
      });
      const partitions = partitioner.partition(
        ['r1', 'r2', 'r3', 'r4'],
        config
      );

      expect(partitions).toHaveLength(2);
      expect(partitions[0].records).toEqual(['r2', 'r3']);
      expect(partitions[1].records).toEqual(['r1', 'r4']);
    });
  });

  describe('partition — dependency_aware', () => {
    it('should place parent records before children', () => {
      const metadata: RecordMetadata[] = [
        { id: 'child', dependencies: ['parent'] },
        { id: 'parent', dependencies: [] },
      ];
      partitioner.setMetadata(metadata);

      const config = createConfig({
        strategy: 'dependency_aware',
        grappeSize: 1,
      });
      const partitions = partitioner.partition(
        ['child', 'parent'],
        config
      );

      const firstPartitionRecords = partitions[0].records;
      const secondPartitionRecords = partitions[1].records;
      expect(firstPartitionRecords).toContain('parent');
      expect(secondPartitionRecords).toContain('child');
    });

    it('should handle circular dependencies by including remaining records', () => {
      const metadata: RecordMetadata[] = [
        { id: 'a', dependencies: ['b'] },
        { id: 'b', dependencies: ['a'] },
      ];
      partitioner.setMetadata(metadata);

      const config = createConfig({
        strategy: 'dependency_aware',
        grappeSize: 10,
      });
      const partitions = partitioner.partition(['a', 'b'], config);

      const allRecords = partitions.flatMap((p) => p.records);
      expect(allRecords).toContain('a');
      expect(allRecords).toContain('b');
    });

    it('should set dependencies on partitions that reference external records', () => {
      const metadata: RecordMetadata[] = [
        { id: 'p1', dependencies: [] },
        { id: 'c1', dependencies: ['p1'] },
      ];
      partitioner.setMetadata(metadata);

      const config = createConfig({
        strategy: 'dependency_aware',
        grappeSize: 1,
      });
      const partitions = partitioner.partition(['p1', 'c1'], config);

      const childPartition = partitions.find((p) =>
        p.records.includes('c1')
      );
      expect(childPartition?.dependencies).toContain('p1');
    });
  });
});
