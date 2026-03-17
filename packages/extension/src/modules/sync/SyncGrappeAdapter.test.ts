import { describe, it, expect, beforeEach } from 'vitest';
import { SyncGrappeAdapter } from './SyncGrappeAdapter';
import type { SyncConfig, SyncObjectConfig, GrappeResult } from '@sandforge/shared';

function createObjectConfig(
  overrides?: Partial<SyncObjectConfig>
): SyncObjectConfig {
  return {
    objectApiName: 'Account',
    operation: 'upsert',
    fieldMappings: [],
    transformRules: [],
    excludedFields: [],
    addOnFields: [],
    batchSize: 200,
    insertOrder: 1,
    ...overrides,
  };
}

function createConfig(overrides?: Partial<SyncConfig>): SyncConfig {
  return {
    id: 'config-1',
    name: 'Test Sync',
    description: '',
    sourceOrgId: 'src',
    targetOrgId: 'tgt',
    direction: 'source_to_target',
    mode: 'full',
    objects: [createObjectConfig()],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    dryRun: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function createGrappeResult(overrides?: Partial<GrappeResult>): GrappeResult {
  return {
    grappeId: 'g-1',
    status: 'success',
    processedRecords: 100,
    successCount: 100,
    failureCount: 0,
    errors: [],
    duration: 5000,
    ...overrides,
  };
}

describe('SyncGrappeAdapter', () => {
  let adapter: SyncGrappeAdapter;

  beforeEach(() => {
    adapter = new SyncGrappeAdapter();
  });

  describe('partition', () => {
    it('should create partitions based on batch size', () => {
      const config = createConfig({
        objects: [createObjectConfig({ batchSize: 2 })],
      });
      const records = new Map<string, Record<string, unknown>[]>();
      records.set('Account', [
        { Id: '001', Name: 'A' },
        { Id: '002', Name: 'B' },
        { Id: '003', Name: 'C' },
      ]);

      const partitions = adapter.partition(config, records);

      expect(partitions).toHaveLength(2);
      expect(partitions[0].recordCount).toBe(2);
      expect(partitions[1].recordCount).toBe(1);
    });

    it('should create one partition when records fit in batch size', () => {
      const config = createConfig({
        objects: [createObjectConfig({ batchSize: 200 })],
      });
      const records = new Map<string, Record<string, unknown>[]>();
      records.set('Account', [{ Id: '001', Name: 'A' }]);

      const partitions = adapter.partition(config, records);

      expect(partitions).toHaveLength(1);
    });

    it('should set totalPartitions on all partitions', () => {
      const config = createConfig({
        objects: [createObjectConfig({ batchSize: 1 })],
      });
      const records = new Map<string, Record<string, unknown>[]>();
      records.set('Account', [
        { Id: '001', Name: 'A' },
        { Id: '002', Name: 'B' },
      ]);

      const partitions = adapter.partition(config, records);

      expect(partitions[0].totalPartitions).toBe(2);
      expect(partitions[1].totalPartitions).toBe(2);
    });

    it('should set status to pending for all partitions', () => {
      const config = createConfig();
      const records = new Map<string, Record<string, unknown>[]>();
      records.set('Account', [{ Id: '001', Name: 'A' }]);

      const partitions = adapter.partition(config, records);

      expect(partitions[0].status).toBe('pending');
    });

    it('should return empty array when no records exist', () => {
      const config = createConfig();
      const records = new Map<string, Record<string, unknown>[]>();

      const partitions = adapter.partition(config, records);

      expect(partitions).toHaveLength(0);
    });

    it('should skip objects with no matching records', () => {
      const config = createConfig({
        objects: [
          createObjectConfig({ objectApiName: 'Account' }),
          createObjectConfig({ objectApiName: 'Contact' }),
        ],
      });
      const records = new Map<string, Record<string, unknown>[]>();
      records.set('Account', [{ Id: '001', Name: 'A' }]);

      const partitions = adapter.partition(config, records);

      expect(partitions).toHaveLength(1);
    });

    it('should extract record IDs into the records array', () => {
      const config = createConfig({
        objects: [createObjectConfig({ batchSize: 10 })],
      });
      const records = new Map<string, Record<string, unknown>[]>();
      records.set('Account', [
        { Id: '001', Name: 'A' },
        { Id: '002', Name: 'B' },
      ]);

      const partitions = adapter.partition(config, records);

      expect(partitions[0].records).toEqual(['001', '002']);
    });

    it('should initialize progress with zero values', () => {
      const config = createConfig();
      const records = new Map<string, Record<string, unknown>[]>();
      records.set('Account', [{ Id: '001', Name: 'A' }]);

      const partitions = adapter.partition(config, records);

      expect(partitions[0].progress.processedRecords).toBe(0);
      expect(partitions[0].progress.percentage).toBe(0);
    });

    it('should use default batch size of 200 when batch size is zero', () => {
      const config = createConfig({
        objects: [createObjectConfig({ batchSize: 0 })],
      });
      const records = new Map<string, Record<string, unknown>[]>();
      const fiveRecords = Array.from({ length: 5 }, (_, i) => ({
        Id: `00${i}`,
        Name: `R${i}`,
      }));
      records.set('Account', fiveRecords);

      const partitions = adapter.partition(config, records);

      expect(partitions).toHaveLength(1);
    });
  });

  describe('aggregateResults', () => {
    it('should sum total records across partitions', () => {
      const results = [
        createGrappeResult({ processedRecords: 100, successCount: 100 }),
        createGrappeResult({ processedRecords: 50, successCount: 50 }),
      ];

      const aggregated = adapter.aggregateResults(results);

      expect(aggregated.totalRecords).toBe(150);
      expect(aggregated.successRecords).toBe(150);
    });

    it('should count failed partitions', () => {
      const results = [
        createGrappeResult({ status: 'success' }),
        createGrappeResult({ status: 'failure' }),
      ];

      const aggregated = adapter.aggregateResults(results);

      expect(aggregated.completedPartitions).toBe(1);
      expect(aggregated.failedPartitions).toBe(1);
    });

    it('should count partial as completed', () => {
      const results = [
        createGrappeResult({ status: 'partial' }),
      ];

      const aggregated = adapter.aggregateResults(results);

      expect(aggregated.completedPartitions).toBe(1);
    });

    it('should use max duration from partitions', () => {
      const results = [
        createGrappeResult({ duration: 3000 }),
        createGrappeResult({ duration: 8000 }),
        createGrappeResult({ duration: 5000 }),
      ];

      const aggregated = adapter.aggregateResults(results);

      expect(aggregated.duration).toBe(8000);
    });

    it('should set totalPartitions to the number of results', () => {
      const results = [createGrappeResult(), createGrappeResult()];

      const aggregated = adapter.aggregateResults(results);

      expect(aggregated.totalPartitions).toBe(2);
    });

    it('should include all partition results', () => {
      const results = [createGrappeResult()];

      const aggregated = adapter.aggregateResults(results);

      expect(aggregated.partitionResults).toEqual(results);
    });

    it('should handle empty results array', () => {
      const aggregated = adapter.aggregateResults([]);

      expect(aggregated.totalPartitions).toBe(0);
      expect(aggregated.totalRecords).toBe(0);
    });
  });
});
