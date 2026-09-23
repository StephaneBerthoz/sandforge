import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BaseMessage } from '@sandforge/shared';
import { SeedCsvHandler } from './SeedCsvHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { ErrorResolver } from '../../modules/ai/ErrorResolver.js';
import type { AIProvider } from '../../modules/ai/ErrorResolver.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));
vi.mock('../../core/common/sforceLimitParser.js', () => ({
  checkApiLimits: vi.fn(),
}));

/**
 * The writer and the validator are constructed inside the handler, so they are
 * replaced at module level. `writer` doubles as the "did anything reach the
 * target org?" probe used by the production-guard cases.
 */
const writer = vi.hoisted(() => ({
  insert: vi.fn(),
  upsert: vi.fn(),
}));
const validator = vi.hoisted(() => ({ validate: vi.fn() }));

vi.mock('../../modules/sync/BulkDataWriter.js', () => ({
  BulkDataWriter: vi.fn().mockImplementation(function () {
    return writer;
  }),
}));
vi.mock('../../modules/seed/CsvValidator.js', () => ({
  CsvValidator: vi.fn().mockImplementation(function () {
    return validator;
  }),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { BulkDataWriter } from '../../modules/sync/BulkDataWriter.js';
import { WriteCancelledError } from '../../modules/sync/WriteCancelledError.js';
import { BulkApiManager } from '../../core/engine/BulkApiManager.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { DEFAULT_ROBUSTNESS_CONFIG } from '@sandforge/shared';
import { inboundRequest } from '../../test/mockFactories.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { LineageStore } from '../../modules/audit/lineage.js';
import { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import type { LiveOperation } from '../../modules/monitor/LiveOperationTracker.js';

const mockGetConn = vi.mocked(getJsforceConnection);

/** Message envelope shaped like what MessageBroker hands a handler. */
function buildMsg(type: string, payload?: unknown): InboundRequest {
  return inboundRequest({
    id: `msg-${type}`,
    type,
    timestamp: Date.now(),
    payload,
  } as BaseMessage);
}

/** A valid `seed:csv:*` payload: one mapped column, one row. */
function csvPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    orgId: 'tgt-org',
    objectApiName: 'Account',
    records: [{ name: 'Acme' }],
    columnMappings: [
      {
        csvHeader: 'name',
        sfFieldApiName: 'Name',
        sfFieldType: 'string',
        sfFieldLength: 255,
      },
    ],
    ...overrides,
  };
}

function createMockDeps(): HandlerDeps {
  let idCounter = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: { getOrg: vi.fn() } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: {
      get: vi.fn().mockReturnValue(undefined),
      set: vi.fn(),
    } as unknown as HandlerDeps['configStore'],
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    // An import refuses to write without a Production Guard, and the
    // extension always injects one.
    infraServices: {
      productionGuard: new ProductionGuard(),
    } as unknown as HandlerDeps['infraServices'],
    nextId: () => String(++idCounter),
  };
}

/** All messages of one type posted to the webview, in emission order. */
function posted(deps: HandlerDeps, type: string): Array<BaseMessage & { payload: never }> {
  return vi
    .mocked(deps.broker.postToWebview)
    .mock.calls.map((call) => call[0] as BaseMessage & { payload: never })
    .filter((msg) => msg.type === type);
}

describe('SeedCsvHandler', () => {
  let deps: HandlerDeps;
  let handler: SeedCsvHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
    handler = new SeedCsvHandler(deps);

    mockGetConn.mockResolvedValue({
      describe: vi.fn().mockResolvedValue({ fields: [{ name: 'Name', type: 'string' }] }),
      limitInfo: undefined,
    } as unknown as Awaited<ReturnType<typeof getJsforceConnection>>);
    validator.validate.mockReturnValue({
      valid: true,
      errors: [],
      validRowCount: 1,
    });
    writer.insert.mockResolvedValue([{ id: '001TGT', success: true, errors: [] }]);
    writer.upsert.mockResolvedValue([{ id: '001TGT', success: true, errors: [] }]);
  });

  describe('routing', () => {
    it('ignores message types it does not own', async () => {
      expect(await handler.handle(buildMsg('seed:clone:execute'))).toBe(false);
      expect(deps.broker.postToWebview).not.toHaveBeenCalled();
    });
  });

  describe('seed:csv:validate', () => {
    it('validates the rows against the live describe and returns the verdict', async () => {
      await handler.handle(buildMsg('seed:csv:validate', csvPayload()));

      expect(validator.validate).toHaveBeenCalledWith(
        [{ name: 'Acme' }],
        expect.any(Array),
        [{ name: 'Name', type: 'string' }],
        undefined,
      );
      const responses = posted(deps, 'seed:csv:validate:response');
      expect(responses).toHaveLength(1);
      expect(responses[0].payload as unknown).toMatchObject({ valid: true });
    });

    it('reports describe failures on seed:csv:error', async () => {
      mockGetConn.mockRejectedValue(new Error('org unreachable'));

      await handler.handle(buildMsg('seed:csv:validate', csvPayload()));

      const errors = posted(deps, 'seed:csv:error');
      expect(errors).toHaveLength(1);
      expect((errors[0].payload as { message: string }).message).toContain('org unreachable');
    });
  });

  describe('audit trail', () => {
    /** A real store, read back the way the Reports page reads it. */
    function recordingStore(): ConfigStore {
      const store = new ConfigStore(new InMemoryConfigStoreBackend());
      store.initialize();
      deps.configStore = store;
      return store;
    }

    it('records an import once: the rows it created and the rows the org refused', async () => {
      const store = recordingStore();
      writer.insert.mockResolvedValue([
        { id: '001TGT', success: true, errors: [] },
        { success: false, errors: ['REQUIRED_FIELD_MISSING: Name'] },
      ]);

      await handler.handle(
        buildMsg('seed:csv:execute', csvPayload({ records: [{ name: 'Acme' }, { name: '' }] })),
      );

      const { entries } = new AuditTrailStore(store).list();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        action: 'seed_csv_import',
        module: 'seed',
        operationId: 'msg-seed:csv:execute',
        orgId: 'tgt-org',
        outcome: 'partial',
        objects: [{ objectApiName: 'Account', created: 1, updated: 0, deleted: 0, failed: 1 }],
      });
      // Neither the refused value nor the new record's id goes in.
      const stored = JSON.stringify([store.get('audit:trail'), store.get('lineage:runs')]);
      expect(stored).not.toContain('001TGT');
      expect(stored).not.toContain('REQUIRED_FIELD_MISSING');
      expect(new LineageStore(store).get()?.nodes[0]).toMatchObject({ origin: 'csv' });
    });

    it('counts an upsert apart: it says it wrote a row, not whether it created it', async () => {
      const store = recordingStore();

      await handler.handle(
        buildMsg('seed:csv:execute', csvPayload({ externalIdField: 'Ext_Id__c' })),
      );

      expect(new AuditTrailStore(store).list().entries[0].objects).toEqual([
        { objectApiName: 'Account', created: 0, updated: 0, deleted: 0, failed: 0, upserted: 1 },
      ]);
    });

    it('records an import that failed after it started as failed, and one never started not at all', async () => {
      const store = recordingStore();
      writer.insert.mockRejectedValue(new Error('Bulk job failed'));
      await handler.handle(buildMsg('seed:csv:execute', csvPayload()));

      mockGetConn.mockRejectedValue(new Error('No credentials for org tgt-org'));
      await handler.handle(buildMsg('seed:csv:execute', csvPayload()));

      expect(new AuditTrailStore(store).list().entries).toEqual([
        expect.objectContaining({ outcome: 'failure', objects: [] }),
      ]);
    });
  });

  describe('seed:csv:execute', () => {
    /** The dependencies each run handed to the (mocked) BulkDataWriter. */
    function writerDeps(): Array<ConstructorParameters<typeof BulkDataWriter>[0]> {
      return vi.mocked(BulkDataWriter).mock.calls.map((call) => call[0]);
    }

    it('writes through the injected Bulk API job limiter, the same one every run', async () => {
      const bulkManager = new BulkApiManager(2);
      deps.bulkManager = bulkManager;

      await handler.handle(buildMsg('seed:csv:execute', csvPayload()));
      await handler.handle(buildMsg('seed:csv:execute', csvPayload()));

      const managers = writerDeps().map((d) => d.bulkManager);
      expect(managers).toHaveLength(2);
      expect(managers[0]).toBe(bulkManager);
      expect(managers[1]).toBe(bulkManager);
    });

    it('bounds concurrent bulk jobs with the default limit when none is injected', async () => {
      await handler.handle(buildMsg('seed:csv:execute', csvPayload()));

      expect(writerDeps()[0].bulkManager.maxConcurrentJobs).toBe(
        DEFAULT_ROBUSTNESS_CONFIG.bulk.maxConcurrentJobs,
      );
    });

    it('coerces cell values and skips unmapped columns before writing', async () => {
      await handler.handle(
        buildMsg(
          'seed:csv:execute',
          csvPayload({
            records: [
              {
                name: 'Acme',
                active: 'true',
                employees: '42',
                note: 'null',
                skip: 'x',
              },
            ],
            columnMappings: [
              {
                csvHeader: 'name',
                sfFieldApiName: 'Name',
                sfFieldType: 'string',
                sfFieldLength: 255,
              },
              {
                csvHeader: 'active',
                sfFieldApiName: 'Active__c',
                sfFieldType: 'boolean',
                sfFieldLength: null,
              },
              {
                csvHeader: 'employees',
                sfFieldApiName: 'NumberOfEmployees',
                sfFieldType: 'int',
                sfFieldLength: null,
              },
              {
                csvHeader: 'note',
                sfFieldApiName: 'Description',
                sfFieldType: 'textarea',
                sfFieldLength: null,
              },
              // Empty target = column deliberately left unmapped in the wizard.
              {
                csvHeader: 'skip',
                sfFieldApiName: '',
                sfFieldType: '',
                sfFieldLength: null,
              },
            ],
          }),
        ),
      );

      expect(writer.insert).toHaveBeenCalledWith(
        'Account',
        [
          {
            Name: 'Acme',
            Active__c: true,
            NumberOfEmployees: 42,
            Description: null,
          },
        ],
        200,
      );
    });

    it('counts failures and caps the errors carried back to the webview', async () => {
      const outcomes = Array.from({ length: 150 }, () => ({
        success: false,
        errors: ['REQUIRED_FIELD_MISSING: Name'],
      }));
      writer.insert.mockResolvedValue(outcomes);

      await handler.handle(
        buildMsg(
          'seed:csv:execute',
          csvPayload({
            records: Array.from({ length: 150 }, () => ({ name: 'Acme' })),
          }),
        ),
      );

      const responses = posted(deps, 'seed:csv:execute:response');
      const payload = responses[0].payload as unknown as {
        insertedCount: number;
        failedCount: number;
        errors: string[];
      };
      expect(payload.insertedCount).toBe(0);
      expect(payload.failedCount).toBe(150);
      expect(payload.errors).toHaveLength(100);
    });

    it('upserts when the payload carries an external ID field', async () => {
      await handler.handle(
        buildMsg('seed:csv:execute', csvPayload({ externalIdField: 'External_Id__c' })),
      );

      expect(writer.upsert).toHaveBeenCalledWith(
        'Account',
        'External_Id__c',
        [{ Name: 'Acme' }],
        200,
      );
      expect(writer.insert).not.toHaveBeenCalled();
    });

    it('reports execute failures on operation:failed as retryable', async () => {
      writer.insert.mockRejectedValue(new Error('bulk write exploded'));

      await handler.handle(buildMsg('seed:csv:execute', csvPayload()));

      const failures = posted(deps, 'operation:failed');
      expect(failures).toHaveLength(1);
      expect(failures[0].payload as unknown).toMatchObject({
        error: 'bulk write exploded',
        retryable: true,
      });
    });

    describe('an import a cancel stopped', () => {
      /** The id the import runs under: its request's. */
      const OPERATION_ID = 'msg-seed:csv:execute';

      let registry: BackgroundOperationRegistry;
      beforeEach(() => {
        registry = new BackgroundOperationRegistry();
        handler.setRegistry(registry);
      });

      it('writes no row when the cancel came before the write, and ends as aborted', async () => {
        // Nothing but an upload of more than ten thousand rows looked at the
        // cancel: every other import wrote all of its rows.
        mockGetConn.mockImplementation(async () => {
          registry.abort(OPERATION_ID);
          return { limitInfo: undefined } as unknown as Awaited<
            ReturnType<typeof getJsforceConnection>
          >;
        });

        await handler.handle(buildMsg('seed:csv:execute', csvPayload()));

        expect(writer.insert).not.toHaveBeenCalled();
        expect(posted(deps, 'operation:failed')).toEqual([]);
        expect(posted(deps, 'operation:completed')[0].payload as unknown).toEqual({
          operationId: OPERATION_ID,
          result: { aborted: true, insertedCount: 0, failedCount: 0 },
        });
        expect(registry.get(OPERATION_ID)?.status).toBe('aborted');
        expect(posted(deps, 'seed:csv:execute:response')[0].payload as unknown).toEqual({
          insertedCount: 0,
          failedCount: 0,
          errors: [],
          cancelled: true,
        });
      });

      it('ends as aborted when the cancel aborted the upload of its rows', async () => {
        writer.insert.mockImplementation(async () => {
          registry.abort(OPERATION_ID);
          throw new WriteCancelledError('Account');
        });

        await handler.handle(buildMsg('seed:csv:execute', csvPayload()));

        expect(posted(deps, 'operation:failed')).toEqual([]);
        expect(posted(deps, 'operation:completed')[0].payload as unknown).toMatchObject({
          result: { aborted: true, insertedCount: 0 },
        });
      });

      it('counts the rows written before the cancel stopped the write between two batches', async () => {
        // Those rows stay in the org: an import that left them out said it
        // wrote nothing.
        writer.insert.mockImplementation(async () => {
          registry.abort(OPERATION_ID);
          throw new WriteCancelledError('Account', [
            { id: '001TGT1', success: true, errors: [] },
            { success: false, errors: ['REQUIRED_FIELD_MISSING: Name'] },
          ]);
        });

        await handler.handle(buildMsg('seed:csv:execute', csvPayload()));

        expect(posted(deps, 'operation:completed')[0].payload as unknown).toEqual({
          operationId: OPERATION_ID,
          result: { aborted: true, insertedCount: 1, failedCount: 1 },
        });
        expect(posted(deps, 'seed:csv:execute:response')[0].payload as unknown).toEqual({
          insertedCount: 1,
          failedCount: 1,
          errors: ['REQUIRED_FIELD_MISSING: Name'],
          cancelled: true,
        });
      });

      it('still fails when the write fails while the cancel is pending', async () => {
        writer.insert.mockImplementation(async () => {
          registry.abort(OPERATION_ID);
          throw new Error('bulk write exploded');
        });

        await handler.handle(buildMsg('seed:csv:execute', csvPayload()));

        expect(posted(deps, 'operation:completed')).toEqual([]);
        expect(posted(deps, 'operation:failed')[0].payload as unknown).toMatchObject({
          operationId: OPERATION_ID,
          error: 'bulk write exploded',
        });
      });
    });
  });

  describe('in Live Operations', () => {
    /** The id the import runs under: its request's. */
    const OPERATION_ID = 'msg-seed:csv:execute';

    let tracker: LiveOperationTracker;
    let registry: BackgroundOperationRegistry;
    beforeEach(() => {
      tracker = new LiveOperationTracker();
      handler.setLiveOperationTracker(tracker);
      registry = new BackgroundOperationRegistry();
      handler.setRegistry(registry);
    });
    afterEach(() => {
      tracker.dispose();
    });

    it('lists an import while it runs, with its rows, under the id its Cancel reaches it by', async () => {
      let listed: LiveOperation[] = [];
      writer.insert.mockImplementation(async () => {
        const { onProgress } = vi.mocked(BulkDataWriter).mock.calls[0][0] as unknown as {
          onProgress: (processed: number, total: number, label: string) => void;
        };
        onProgress(1, 2, 'Account: 1/2');
        listed = tracker.getAll().map((op) => ({ ...op }));
        return [
          { id: '001TGT1', success: true, errors: [] },
          { id: '001TGT2', success: true, errors: [] },
        ];
      });

      await handler.handle(
        buildMsg('seed:csv:execute', csvPayload({ records: [{ name: 'Acme' }, { name: 'Beta' }] })),
      );

      expect(listed).toEqual([
        expect.objectContaining({
          operationId: OPERATION_ID,
          module: 'csv',
          status: 'running',
          percentage: 50,
          processedRecords: 1,
          totalRecords: 2,
        }),
      ]);
      expect(registry.get(OPERATION_ID)).toBeDefined();
      expect(tracker.get(OPERATION_ID)?.status).toBe('completed');
    });

    it('ends an import whose write failed as failed, with its error', async () => {
      writer.insert.mockRejectedValue(new Error('bulk write exploded'));

      await handler.handle(buildMsg('seed:csv:execute', csvPayload()));

      expect(tracker.get(OPERATION_ID)).toMatchObject({
        status: 'failed',
        error: 'bulk write exploded',
      });
    });

    it('ends an import that wrote no row as failed, with the first refusal', async () => {
      writer.insert.mockResolvedValue([
        { id: '', success: false, errors: ['REQUIRED_FIELD_MISSING: Name'] },
      ]);

      await handler.handle(buildMsg('seed:csv:execute', csvPayload()));

      expect(tracker.get(OPERATION_ID)).toMatchObject({
        status: 'failed',
        error: 'REQUIRED_FIELD_MISSING: Name',
      });
    });

    it('ends an import a cancel stopped as cancelled', async () => {
      writer.insert.mockImplementation(async () => {
        registry.abort(OPERATION_ID);
        throw new WriteCancelledError('Account');
      });

      await handler.handle(buildMsg('seed:csv:execute', csvPayload()));

      expect(tracker.get(OPERATION_ID)?.status).toBe('cancelled');
    });
  });

  describe('production guard', () => {
    /** Wire a mock ProductionGuard into deps.infraServices and return its spies. */
    function wireGuard(behavior: {
      allowed: boolean;
      requiresConfirmation?: boolean;
      blockedReason?: string;
      confirmed?: boolean;
    }): {
      check: ReturnType<typeof vi.fn>;
      confirmIfNeeded: ReturnType<typeof vi.fn>;
    } {
      const check = vi.fn().mockReturnValue({
        allowed: behavior.allowed,
        requiresConfirmation: behavior.requiresConfirmation ?? false,
        requiresApproval: false,
        blockedReason: behavior.blockedReason,
        warnings: [],
        impactSummary: 'INSERT 1 Account record(s) on production org tgt-org [module: seed]',
      });
      const confirmIfNeeded = vi.fn().mockResolvedValue(behavior.confirmed ?? true);
      deps.infraServices = {
        performanceTracker: { start: vi.fn(), complete: vi.fn() },
        productionGuard: { check, confirmIfNeeded },
        offlineManager: undefined,
        piiDetector: undefined,
      } as unknown as NonNullable<HandlerDeps['infraServices']>;
      return { check, confirmIfNeeded };
    }

    function mockTargetOrgType(orgType: string): void {
      vi.mocked(deps.orgManager.getOrg).mockReturnValue({
        orgType,
      } as unknown as ReturnType<HandlerDeps['orgManager']['getOrg']>);
    }

    it('refuses with NOT_INITIALIZED, writing nothing, when no Production Guard was injected', async () => {
      // A host that never wired the guard used to skip it and import on.
      deps.infraServices = undefined;
      mockTargetOrgType('Production');

      await handler.handle(buildMsg('seed:csv:execute', csvPayload()));

      expect(writer.insert).not.toHaveBeenCalled();
      expect(writer.upsert).not.toHaveBeenCalled();
      const failed = posted(deps, 'operation:failed') as Array<
        BaseMessage & { payload: { code?: string; retryable?: boolean } }
      >;
      expect(failed).toHaveLength(1);
      expect(failed[0].payload).toMatchObject({ code: 'NOT_INITIALIZED', retryable: false });
      expect(posted(deps, 'seed:csv:execute:response')).toHaveLength(0);
      // Recorded as the guard's own refusals are, with the code that says why.
      const trail = vi
        .mocked(deps.configStore.set)
        .mock.calls.filter(([key]) => key === 'audit:trail');
      expect(trail.at(-1)?.[1]).toEqual([
        expect.objectContaining({
          action: 'seed_csv_import',
          outcome: 'stopped',
          details: { code: 'NOT_INITIALIZED' },
        }),
      ]);
    });

    it('resolves the guard tier from the target org and imports once confirmed', async () => {
      const guard = wireGuard({
        allowed: true,
        requiresConfirmation: true,
        confirmed: true,
      });
      mockTargetOrgType('Production');

      await handler.handle(buildMsg('seed:csv:execute', csvPayload()));

      expect(guard.check.mock.calls[0][0]).toMatchObject({
        orgId: 'tgt-org',
        orgTier: 'production',
        operation: 'insert',
        objectName: 'Account',
        recordCount: 1,
        module: 'seed',
      });
      expect(guard.check).toHaveBeenCalledTimes(1);
      expect(writer.insert).toHaveBeenCalledTimes(1);
      expect(posted(deps, 'seed:csv:execute:response')).toHaveLength(1);
    });

    it('declares an external-ID import as an upsert to the guard', async () => {
      const guard = wireGuard({ allowed: true });
      mockTargetOrgType('Scratch');

      await handler.handle(
        buildMsg('seed:csv:execute', csvPayload({ externalIdField: 'External_Id__c' })),
      );

      expect(guard.check.mock.calls[0][0]).toMatchObject({
        orgTier: 'scratch',
        operation: 'upsert',
      });
    });

    it('blocks the import when the guard refuses — no write, retryable operation:failed', async () => {
      const guard = wireGuard({
        allowed: false,
        blockedReason: 'insert is not allowed on production org tgt-org',
      });
      mockTargetOrgType('Production');

      await handler.handle(buildMsg('seed:csv:execute', csvPayload()));

      expect(guard.check).toHaveBeenCalledTimes(1);
      expect(guard.confirmIfNeeded).not.toHaveBeenCalled();
      expect(writer.insert).not.toHaveBeenCalled();
      expect(writer.upsert).not.toHaveBeenCalled();
      expect(posted(deps, 'seed:csv:execute:response')).toHaveLength(0);

      const failures = posted(deps, 'operation:failed');
      expect(failures).toHaveLength(1);
      expect(failures[0].payload as unknown).toEqual({
        operationId: 'msg-seed:csv:execute',
        error:
          'Operation blocked by Production Guard: insert is not allowed on production org tgt-org',
        retryable: true,
      });
    });

    it('falls back to the impact summary when the guard blocks without a reason', async () => {
      wireGuard({ allowed: false });
      mockTargetOrgType('Production');

      await handler.handle(buildMsg('seed:csv:execute', csvPayload()));

      const failures = posted(deps, 'operation:failed');
      expect((failures[0].payload as { error: string }).error).toBe(
        'Operation blocked by Production Guard: INSERT 1 Account record(s) on production org tgt-org [module: seed]',
      );
    });

    it('cancels the import when the user declines confirmation — no write, not retryable', async () => {
      const guard = wireGuard({
        allowed: true,
        requiresConfirmation: true,
        confirmed: false,
      });
      mockTargetOrgType('Production');

      await handler.handle(buildMsg('seed:csv:execute', csvPayload()));

      expect(guard.confirmIfNeeded).toHaveBeenCalledTimes(1);
      expect(writer.insert).not.toHaveBeenCalled();
      expect(writer.upsert).not.toHaveBeenCalled();
      expect(posted(deps, 'operation:started')).toHaveLength(0);
      expect(posted(deps, 'seed:csv:execute:response')).toHaveLength(0);

      const failures = posted(deps, 'operation:failed');
      expect(failures).toHaveLength(1);
      expect(failures[0].payload as unknown).toEqual({
        operationId: 'msg-seed:csv:execute',
        error: 'Operation cancelled by user (production confirmation declined).',
        retryable: false,
      });
    });

    it('asks before importing into an org the registry does not know, and writes nothing when declined', async () => {
      // A real guard, and getOrg left unstubbed: nothing shows 'tgt-org' is a
      // sandbox. It was classed as development, so the rows went straight to
      // the writer without a word to the user.
      const requestConfirmation = vi.fn().mockResolvedValue(false);
      const guard = new ProductionGuard({ requestConfirmation });
      const check = vi.spyOn(guard, 'check');
      deps.infraServices = {
        performanceTracker: { start: vi.fn(), complete: vi.fn() },
        productionGuard: guard,
        offlineManager: undefined,
        piiDetector: undefined,
      } as unknown as NonNullable<HandlerDeps['infraServices']>;

      await handler.handle(buildMsg('seed:csv:execute', csvPayload()));

      expect(requestConfirmation).toHaveBeenCalledWith(
        'INSERT 1 Account record(s) on production org tgt-org [module: seed]',
        'production',
      );
      expect(check.mock.calls.map(([request]) => request.orgTier)).toEqual(['production']);
      expect(mockGetConn).not.toHaveBeenCalled();
      expect(writer.insert).not.toHaveBeenCalled();
      expect(writer.upsert).not.toHaveBeenCalled();
      expect(posted(deps, 'operation:failed')[0].payload as unknown).toEqual({
        operationId: 'msg-seed:csv:execute',
        error: 'Operation cancelled by user (production confirmation declined).',
        retryable: false,
      });
    });

    it('does not leave a declined import listed as running', async () => {
      // Registered before the question was asked; left unsettled, it stayed
      // "running" in Live Operations for the rest of the session.
      const registry = new BackgroundOperationRegistry();
      handler.setRegistry(registry);
      deps.infraServices = {
        performanceTracker: { start: vi.fn(), complete: vi.fn() },
        productionGuard: new ProductionGuard({
          requestConfirmation: vi.fn().mockResolvedValue(false),
        }),
        offlineManager: undefined,
        piiDetector: undefined,
      } as unknown as NonNullable<HandlerDeps['infraServices']>;

      await handler.handle(buildMsg('seed:csv:execute', csvPayload()));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(registry.getRunning()).toEqual([]);
    });

    it('tells the model the object and batch size a failed import was writing to', async () => {
      // The prompt is all the model sees: without the run behind it, an org
      // error arrives as a bare sentence and the answer fits any import.
      const provider = vi.fn<AIProvider>(function () {
        return Promise.resolve(
          JSON.stringify({ explanation: 'why', suggestions: [], confidence: 0.4 }),
        );
      });
      deps.errorResolver = new ErrorResolver(provider);
      deps.broker = {
        postToWebview: vi.fn(),
        panelCount: 1,
        showFixSuggestion: vi.fn(),
      } as unknown as HandlerDeps['broker'];
      writer.insert.mockRejectedValue(new Error('SOMETHING_WE_HAVE_NEVER_SEEN: odd'));

      await handler.handle(buildMsg('seed:csv:execute', csvPayload()));
      await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));

      const [prompt] = provider.mock.calls[0];
      expect(prompt).toContain('Module: seed');
      expect(prompt).toContain('Operation: seed:csv:execute');
      expect(prompt).toContain('Target object: Account');
      expect(prompt).toContain('Batch size: 200');
    });
  });
});
