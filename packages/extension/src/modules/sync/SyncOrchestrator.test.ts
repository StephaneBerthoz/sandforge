import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncOrchestrator } from './SyncOrchestrator';
import type { SyncOrchestratorDeps } from './SyncOrchestrator';
import type { SyncConfig, SyncObjectConfig, SyncObjectResult } from '@sandforge/shared';

function createObjectConfig(overrides?: Partial<SyncObjectConfig>): SyncObjectConfig {
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
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
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

function createSuccessResult(objectName = 'Account'): SyncObjectResult {
  return {
    objectApiName: objectName,
    operation: 'upsert',
    processed: 1,
    success: 1,
    failed: 0,
    skipped: 0,
    conflictCount: 0,
    errors: [],
  };
}

function createMockDeps(): SyncOrchestratorDeps {
  return {
    dataSync: {
      sync: vi.fn().mockResolvedValue(createSuccessResult()),
    } as unknown as SyncOrchestratorDeps['dataSync'],
    metadataSync: {
      sync: vi.fn().mockResolvedValue(createSuccessResult('Metadata')),
    } as unknown as SyncOrchestratorDeps['metadataSync'],
    deltaDetector: {
      detect: vi.fn().mockResolvedValue({
        objectApiName: 'Account',
        newRecords: 1,
        modifiedRecords: 0,
        deletedRecords: 0,
        unchangedRecords: 0,
      }),
    } as unknown as SyncOrchestratorDeps['deltaDetector'],
    conflictResolver: {
      detectConflicts: vi.fn().mockReturnValue([]),
      resolve: vi.fn().mockReturnValue([]),
    } as unknown as SyncOrchestratorDeps['conflictResolver'],
    fieldMapping: {
      apply: vi.fn().mockImplementation((record: Record<string, unknown>) => ({ ...record })),
      applyAddOns: vi.fn().mockImplementation((record: Record<string, unknown>) => ({ ...record })),
    } as unknown as SyncOrchestratorDeps['fieldMapping'],
    transformPipeline: {
      transformRecord: vi
        .fn()
        .mockImplementation((record: Record<string, unknown>) => ({ ...record })),
    } as unknown as SyncOrchestratorDeps['transformPipeline'],
    incrementalTracker: {
      getLastSync: vi.fn().mockReturnValue(undefined),
      recordSync: vi.fn(),
      reset: vi.fn(),
    } as unknown as SyncOrchestratorDeps['incrementalTracker'],
    querySource: vi.fn().mockResolvedValue([{ Id: '001', Name: 'Acme' }]),
    queryTarget: vi.fn().mockResolvedValue([]),
  };
}

describe('SyncOrchestrator', () => {
  let deps: SyncOrchestratorDeps;
  let orchestrator: SyncOrchestrator;

  beforeEach(() => {
    deps = createMockDeps();
    orchestrator = new SyncOrchestrator(deps);
  });

  describe('execute', () => {
    it('should query source records for each object', async () => {
      await orchestrator.execute(createConfig());

      expect(deps.querySource).toHaveBeenCalledWith(
        'src-org',
        expect.objectContaining({
          objectApiName: 'Account',
        }),
      );
    });

    it('should apply field mappings to source records', async () => {
      await orchestrator.execute(createConfig());

      expect(deps.fieldMapping.apply).toHaveBeenCalled();
    });

    it('should apply transform pipeline to mapped records', async () => {
      await orchestrator.execute(createConfig());

      expect(deps.transformPipeline.transformRecord).toHaveBeenCalled();
    });

    it('should apply add-on fields', async () => {
      await orchestrator.execute(createConfig());

      expect(deps.fieldMapping.applyAddOns).toHaveBeenCalled();
    });

    it('should call dataSync.sync with the processed records', async () => {
      await orchestrator.execute(createConfig());

      expect(deps.dataSync.sync).toHaveBeenCalled();
    });

    it('should ignore script fields left in an old config', async () => {
      const config = {
        ...createConfig(),
        preScript: 'Database.delete([SELECT Id FROM Account]);',
        postScript: 'System.debug("post");',
      } as unknown as SyncConfig;

      const result = await orchestrator.execute(config);

      expect(result.status).toBe('success');
      expect(deps.dataSync.sync).toHaveBeenCalled();
    });

    it('should process objects in insertOrder', async () => {
      const config = createConfig({
        objects: [
          createObjectConfig({ objectApiName: 'Contact', insertOrder: 2 }),
          createObjectConfig({ objectApiName: 'Account', insertOrder: 1 }),
        ],
      });

      await orchestrator.execute(config);

      const calls = vi.mocked(deps.querySource).mock.calls;
      expect(calls[0][1].objectApiName).toBe('Account');
      expect(calls[1][1].objectApiName).toBe('Contact');
    });

    it('should record sync timestamps for each object', async () => {
      await orchestrator.execute(createConfig());

      expect(deps.incrementalTracker.recordSync).toHaveBeenCalledWith(
        'config-1',
        'Account',
        expect.any(String),
      );
    });

    it('should return success status when all objects sync successfully', async () => {
      const result = await orchestrator.execute(createConfig());

      expect(result.status).toBe('success');
      expect(result.configId).toBe('config-1');
    });

    it('should return partial status when some objects have failures', async () => {
      vi.mocked(deps.dataSync.sync).mockResolvedValue({
        objectApiName: 'Account',
        operation: 'upsert',
        processed: 2,
        success: 1,
        failed: 1,
        skipped: 0,
        conflictCount: 0,
        errors: ['Error on record 2'],
      });

      const result = await orchestrator.execute(createConfig());

      expect(result.status).toBe('partial');
    });

    it('should detect and resolve conflicts in bidirectional mode', async () => {
      const config = createConfig({ direction: 'bidirectional' });

      await orchestrator.execute(config);

      expect(deps.queryTarget).toHaveBeenCalled();
      expect(deps.conflictResolver.detectConflicts).toHaveBeenCalled();
    });

    it('should skip conflict detection for source_to_target direction', async () => {
      const config = createConfig({ direction: 'source_to_target' });

      await orchestrator.execute(config);

      expect(deps.conflictResolver.detectConflicts).not.toHaveBeenCalled();
    });

    it('should handle empty source records gracefully', async () => {
      vi.mocked(deps.querySource).mockResolvedValue([]);

      const result = await orchestrator.execute(createConfig());

      expect(result.totalProcessed).toBe(0);
      expect(deps.dataSync.sync).not.toHaveBeenCalled();
    });
  });

  describe('dryRun', () => {
    it('should query source records without writing', async () => {
      await orchestrator.dryRun(createConfig());

      expect(deps.querySource).toHaveBeenCalled();
      expect(deps.dataSync.sync).not.toHaveBeenCalled();
    });

    it('should return success status for dry run', async () => {
      const result = await orchestrator.dryRun(createConfig());

      expect(result.status).toBe('success');
    });

    it('should report record counts without modifying data', async () => {
      vi.mocked(deps.querySource).mockResolvedValue([
        { Id: '001', Name: 'A' },
        { Id: '002', Name: 'B' },
      ]);

      const result = await orchestrator.dryRun(createConfig());

      expect(result.totalProcessed).toBe(2);
    });

    it('should not record sync timestamps', async () => {
      await orchestrator.dryRun(createConfig());

      expect(deps.incrementalTracker.recordSync).not.toHaveBeenCalled();
    });
  });
});
