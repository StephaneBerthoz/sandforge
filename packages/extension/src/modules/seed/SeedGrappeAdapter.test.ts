import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SeedGrappeAdapter } from './SeedGrappeAdapter';
import type { GenerateIdFn } from './SeedGrappeAdapter';
import type { SeedTemplate, GrappeResult } from '@sandforge/shared';

function createTemplate(objects: SeedTemplate['objects'] = []): SeedTemplate {
  return {
    id: 'tpl-1',
    name: 'Test',
    description: '',
    version: 1,
    strategy: 'faker',
    objects,
    tags: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('SeedGrappeAdapter', () => {
  let adapter: SeedGrappeAdapter;
  let generateId: GenerateIdFn;
  let idCounter: number;

  beforeEach(() => {
    idCounter = 0;
    generateId = vi.fn<GenerateIdFn>(() => {
      idCounter++;
      return `gid-${idCounter}`;
    });
    adapter = new SeedGrappeAdapter(generateId, 100);
  });

  describe('partition', () => {
    it('should create partitions for a single object', () => {
      const template = createTemplate([
        {
          objectApiName: 'Account',
          recordCount: 250,
          fieldRules: [],
          excludedFields: [],
          insertOrder: 0,
          batchSize: 200,
        },
      ]);

      const partitions = adapter.partition(template);
      expect(partitions).toHaveLength(3);
    });

    it('should set correct record counts on partitions', () => {
      const template = createTemplate([
        {
          objectApiName: 'Account',
          recordCount: 250,
          fieldRules: [],
          excludedFields: [],
          insertOrder: 0,
          batchSize: 200,
        },
      ]);

      const partitions = adapter.partition(template);
      expect(partitions[0].recordCount).toBe(100);
      expect(partitions[1].recordCount).toBe(100);
      expect(partitions[2].recordCount).toBe(50);
    });

    it('should assign unique IDs to each partition', () => {
      const template = createTemplate([
        {
          objectApiName: 'Account',
          recordCount: 200,
          fieldRules: [],
          excludedFields: [],
          insertOrder: 0,
          batchSize: 200,
        },
      ]);

      const partitions = adapter.partition(template);
      const ids = partitions.map((p) => p.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('should set dependencies from reference fields', () => {
      const template = createTemplate([
        {
          objectApiName: 'Account',
          recordCount: 50,
          fieldRules: [],
          excludedFields: [],
          insertOrder: 0,
          batchSize: 200,
        },
        {
          objectApiName: 'Contact',
          recordCount: 50,
          fieldRules: [
            {
              fieldApiName: 'AccountId',
              ruleType: 'reference',
              config: { referenceObject: 'Account' },
            },
          ],
          excludedFields: [],
          insertOrder: 1,
          batchSize: 200,
        },
      ]);

      const partitions = adapter.partition(template);
      const contactPartitions = partitions.filter((p) => p.records[0]?.startsWith('Contact:'));

      expect(contactPartitions.length).toBeGreaterThan(0);
      expect(contactPartitions[0].dependencies.length).toBeGreaterThan(0);
    });

    it('should set totalPartitions correctly on all partitions', () => {
      const template = createTemplate([
        {
          objectApiName: 'Account',
          recordCount: 150,
          fieldRules: [],
          excludedFields: [],
          insertOrder: 0,
          batchSize: 200,
        },
      ]);

      const partitions = adapter.partition(template);
      for (const p of partitions) {
        expect(p.totalPartitions).toBe(2);
      }
    });

    it('should initialize partitions with pending status', () => {
      const template = createTemplate([
        {
          objectApiName: 'Account',
          recordCount: 50,
          fieldRules: [],
          excludedFields: [],
          insertOrder: 0,
          batchSize: 200,
        },
      ]);

      const partitions = adapter.partition(template);
      for (const p of partitions) {
        expect(p.status).toBe('pending');
      }
    });

    it('should initialize progress to zero', () => {
      const template = createTemplate([
        {
          objectApiName: 'Account',
          recordCount: 50,
          fieldRules: [],
          excludedFields: [],
          insertOrder: 0,
          batchSize: 200,
        },
      ]);

      const partitions = adapter.partition(template);
      expect(partitions[0].progress.processedRecords).toBe(0);
      expect(partitions[0].progress.percentage).toBe(0);
    });

    it('should handle empty template', () => {
      const template = createTemplate([]);
      const partitions = adapter.partition(template);
      expect(partitions).toEqual([]);
    });

    it('should sort objects by insertOrder', () => {
      const template = createTemplate([
        {
          objectApiName: 'Contact',
          recordCount: 50,
          fieldRules: [],
          excludedFields: [],
          insertOrder: 2,
          batchSize: 200,
        },
        {
          objectApiName: 'Account',
          recordCount: 50,
          fieldRules: [],
          excludedFields: [],
          insertOrder: 1,
          batchSize: 200,
        },
      ]);

      const partitions = adapter.partition(template);
      expect(partitions[0].records[0]).toContain('Account');
    });
  });

  describe('aggregateResults', () => {
    it('should aggregate success counts', () => {
      const results: GrappeResult[] = [
        {
          grappeId: 'g1',
          status: 'success',
          processedRecords: 100,
          successCount: 100,
          failureCount: 0,
          errors: [],
          duration: 500,
        },
        {
          grappeId: 'g2',
          status: 'success',
          processedRecords: 50,
          successCount: 50,
          failureCount: 0,
          errors: [],
          duration: 300,
        },
      ];

      const aggregated = adapter.aggregateResults(results);
      expect(aggregated.successRecords).toBe(150);
      expect(aggregated.failedRecords).toBe(0);
    });

    it('should count completed and failed partitions', () => {
      const results: GrappeResult[] = [
        {
          grappeId: 'g1',
          status: 'success',
          processedRecords: 100,
          successCount: 100,
          failureCount: 0,
          errors: [],
          duration: 500,
        },
        {
          grappeId: 'g2',
          status: 'failure',
          processedRecords: 50,
          successCount: 0,
          failureCount: 50,
          errors: ['Error'],
          duration: 200,
        },
      ];

      const aggregated = adapter.aggregateResults(results);
      expect(aggregated.completedPartitions).toBe(1);
      expect(aggregated.failedPartitions).toBe(1);
    });

    it('should use max duration across partitions', () => {
      const results: GrappeResult[] = [
        {
          grappeId: 'g1',
          status: 'success',
          processedRecords: 100,
          successCount: 100,
          failureCount: 0,
          errors: [],
          duration: 1000,
        },
        {
          grappeId: 'g2',
          status: 'success',
          processedRecords: 50,
          successCount: 50,
          failureCount: 0,
          errors: [],
          duration: 500,
        },
      ];

      const aggregated = adapter.aggregateResults(results);
      expect(aggregated.duration).toBe(1000);
    });

    it('should handle empty results', () => {
      const aggregated = adapter.aggregateResults([]);
      expect(aggregated.totalPartitions).toBe(0);
      expect(aggregated.totalRecords).toBe(0);
    });

    it('should include all partition results', () => {
      const results: GrappeResult[] = [
        {
          grappeId: 'g1',
          status: 'success',
          processedRecords: 50,
          successCount: 50,
          failureCount: 0,
          errors: [],
          duration: 100,
        },
      ];

      const aggregated = adapter.aggregateResults(results);
      expect(aggregated.partitionResults).toEqual(results);
    });

    it('should count partial status as completed', () => {
      const results: GrappeResult[] = [
        {
          grappeId: 'g1',
          status: 'partial',
          processedRecords: 100,
          successCount: 80,
          failureCount: 20,
          errors: [],
          duration: 500,
        },
      ];

      const aggregated = adapter.aggregateResults(results);
      expect(aggregated.completedPartitions).toBe(1);
      expect(aggregated.failedPartitions).toBe(0);
    });
  });
});
