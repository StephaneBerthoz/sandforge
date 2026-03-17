import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeltaDetector } from './DeltaDetector';
import type { DeltaDetectorDeps, QueryRecord } from './DeltaDetector';
import type { SyncObjectConfig } from '@sandforge/shared';

function createConfig(overrides?: Partial<SyncObjectConfig>): SyncObjectConfig {
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

function createDeps(records: QueryRecord[] = []): DeltaDetectorDeps {
  return {
    query: vi.fn().mockResolvedValue(records),
  };
}

describe('DeltaDetector', () => {
  let deps: DeltaDetectorDeps;
  let detector: DeltaDetector;

  beforeEach(() => {
    deps = createDeps();
    detector = new DeltaDetector(deps);
  });

  describe('detect', () => {
    it('should treat all records as new when no lastSync is provided', async () => {
      deps = createDeps([
        { Id: '001', LastModifiedDate: '2026-01-01T00:00:00Z' },
        { Id: '002', LastModifiedDate: '2026-01-02T00:00:00Z' },
      ]);
      detector = new DeltaDetector(deps);

      const result = await detector.detect(createConfig(), 'org-1');

      expect(result.newRecords).toBe(2);
      expect(result.modifiedRecords).toBe(0);
      expect(result.deletedRecords).toBe(0);
      expect(result.unchangedRecords).toBe(0);
    });

    it('should detect modified records after lastSync', async () => {
      deps = createDeps([
        {
          Id: '001',
          LastModifiedDate: '2026-02-01T00:00:00Z',
          CreatedDate: '2025-01-01T00:00:00Z',
        },
      ]);
      detector = new DeltaDetector(deps);

      const result = await detector.detect(
        createConfig(),
        'org-1',
        '2026-01-15T00:00:00Z'
      );

      expect(result.modifiedRecords).toBe(1);
      expect(result.newRecords).toBe(0);
    });

    it('should detect new records created after lastSync', async () => {
      deps = createDeps([
        {
          Id: '001',
          LastModifiedDate: '2026-02-01T00:00:00Z',
          CreatedDate: '2026-02-01T00:00:00Z',
        },
      ]);
      detector = new DeltaDetector(deps);

      const result = await detector.detect(
        createConfig(),
        'org-1',
        '2026-01-15T00:00:00Z'
      );

      expect(result.newRecords).toBe(1);
      expect(result.modifiedRecords).toBe(0);
    });

    it('should detect deleted records', async () => {
      deps = createDeps([
        { Id: '001', IsDeleted: true, LastModifiedDate: '2026-02-01T00:00:00Z' },
      ]);
      detector = new DeltaDetector(deps);

      const result = await detector.detect(
        createConfig(),
        'org-1',
        '2026-01-15T00:00:00Z'
      );

      expect(result.deletedRecords).toBe(1);
    });

    it('should detect unchanged records before lastSync', async () => {
      deps = createDeps([
        {
          Id: '001',
          LastModifiedDate: '2026-01-01T00:00:00Z',
          CreatedDate: '2025-06-01T00:00:00Z',
        },
      ]);
      detector = new DeltaDetector(deps);

      const result = await detector.detect(
        createConfig(),
        'org-1',
        '2026-01-15T00:00:00Z'
      );

      expect(result.unchangedRecords).toBe(1);
    });

    it('should include lastSyncTimestamp in result when provided', async () => {
      const result = await detector.detect(
        createConfig(),
        'org-1',
        '2026-01-15T00:00:00Z'
      );

      expect(result.lastSyncTimestamp).toBe('2026-01-15T00:00:00Z');
    });

    it('should not include lastSyncTimestamp when not provided', async () => {
      const result = await detector.detect(createConfig(), 'org-1');

      expect(result.lastSyncTimestamp).toBeUndefined();
    });

    it('should set objectApiName from config', async () => {
      const result = await detector.detect(
        createConfig({ objectApiName: 'Contact' }),
        'org-1'
      );

      expect(result.objectApiName).toBe('Contact');
    });

    it('should include WHERE clause in query when config has where', async () => {
      await detector.detect(
        createConfig({ where: "Industry = 'Tech'" }),
        'org-1'
      );

      const query = vi.mocked(deps.query).mock.calls[0][1];
      expect(query).toContain("WHERE Industry = 'Tech'");
    });

    it('should include ORDER BY clause in query when config has orderBy', async () => {
      await detector.detect(
        createConfig({ orderBy: 'Name ASC' }),
        'org-1'
      );

      const query = vi.mocked(deps.query).mock.calls[0][1];
      expect(query).toContain('ORDER BY Name ASC');
    });

    it('should handle mixed record states', async () => {
      deps = createDeps([
        { Id: '001', LastModifiedDate: '2026-02-01T00:00:00Z', CreatedDate: '2026-02-01T00:00:00Z' },
        { Id: '002', LastModifiedDate: '2026-02-01T00:00:00Z', CreatedDate: '2025-01-01T00:00:00Z' },
        { Id: '003', IsDeleted: true, LastModifiedDate: '2026-02-01T00:00:00Z' },
        { Id: '004', LastModifiedDate: '2025-12-01T00:00:00Z', CreatedDate: '2025-06-01T00:00:00Z' },
      ]);
      detector = new DeltaDetector(deps);

      const result = await detector.detect(
        createConfig(),
        'org-1',
        '2026-01-15T00:00:00Z'
      );

      expect(result.newRecords).toBe(1);
      expect(result.modifiedRecords).toBe(1);
      expect(result.deletedRecords).toBe(1);
      expect(result.unchangedRecords).toBe(1);
    });

    it('should treat records without LastModifiedDate as new', async () => {
      deps = createDeps([{ Id: '001' }]);
      detector = new DeltaDetector(deps);

      const result = await detector.detect(
        createConfig(),
        'org-1',
        '2026-01-15T00:00:00Z'
      );

      expect(result.newRecords).toBe(1);
    });
  });
});
