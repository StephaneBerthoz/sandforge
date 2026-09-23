import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BaseMessage } from '@sandforge/shared';
import { SeedCloneHandler } from './SeedCloneHandler.js';
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
 * The pipeline collaborators are constructed inside the handler, so they are
 * replaced at module level. `writer` doubles as the "did anything reach the
 * target org?" probe used by the production-guard cases.
 */
const writer = vi.hoisted(() => ({
  insert: vi.fn(),
  upsert: vi.fn(),
}));
const fetcher = vi.hoisted(() => ({
  fetchRecords: vi.fn(),
  countRecords: vi.fn(),
  fetchSample: vi.fn(),
}));
const linker = vi.hoisted(() => ({
  buildEdgesFromDescribe: vi.fn(),
  resolveInsertOrder: vi.fn(),
}));

vi.mock('../../modules/sync/BulkDataWriter.js', () => ({
  BulkDataWriter: vi.fn().mockImplementation(function () {
    return writer;
  }),
}));
vi.mock('../../modules/seed/CloneRecordFetcher.js', () => ({
  CloneRecordFetcher: vi.fn().mockImplementation(function () {
    return fetcher;
  }),
}));
vi.mock('../../modules/seed/CloneReferenceLinker.js', () => ({
  CloneReferenceLinker: vi.fn().mockImplementation(function () {
    return linker;
  }),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { BulkDataWriter } from '../../modules/sync/BulkDataWriter.js';
import { WriteCancelledError } from '../../modules/sync/WriteCancelledError.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
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

/** A valid `seed:clone:execute` payload (one object, insert mode). */
function clonePayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    objects: [{ objectApiName: 'Account' }],
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
    // A clone refuses to write without a Production Guard, and the extension
    // always injects one.
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

describe('SeedCloneHandler', () => {
  let deps: HandlerDeps;
  let handler: SeedCloneHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
    handler = new SeedCloneHandler(deps);

    mockGetConn.mockResolvedValue({
      describeGlobal: vi.fn().mockResolvedValue({ sobjects: [] }),
      describe: vi.fn().mockResolvedValue({ fields: [] }),
      limitInfo: undefined,
    } as unknown as Awaited<ReturnType<typeof getJsforceConnection>>);
    linker.buildEdgesFromDescribe.mockReturnValue([]);
    linker.resolveInsertOrder.mockReturnValue(['Account']);
    fetcher.fetchRecords.mockResolvedValue([{ Id: '001SRC', Name: 'Acme' }]);
    writer.insert.mockResolvedValue([{ id: '001TGT', success: true, errors: [] }]);
    writer.upsert.mockResolvedValue([{ id: '001TGT', success: true, errors: [] }]);
  });

  describe('routing', () => {
    it('ignores message types it does not own', async () => {
      expect(await handler.handle(buildMsg('sync:execute'))).toBe(false);
      expect(deps.broker.postToWebview).not.toHaveBeenCalled();
    });
  });

  describe('seed:clone:describe-source', () => {
    it('returns only createable and queryable objects', async () => {
      mockGetConn.mockResolvedValue({
        describeGlobal: vi.fn().mockResolvedValue({
          sobjects: [
            {
              name: 'Account',
              label: 'Account',
              createable: true,
              queryable: true,
            },
            {
              name: 'AccountShare',
              label: 'Share',
              createable: true,
              queryable: false,
            },
          ],
        }),
        limitInfo: undefined,
      } as unknown as Awaited<ReturnType<typeof getJsforceConnection>>);

      await handler.handle(buildMsg('seed:clone:describe-source', { sourceOrgId: 'src-org' }));

      const responses = posted(deps, 'seed:clone:describe-source:response');
      expect(responses).toHaveLength(1);
      expect(responses[0].payload).toEqual({
        objects: [{ apiName: 'Account', label: 'Account', recordCount: -1 }],
      });
    });

    it('reports connection failures on seed:clone:error', async () => {
      mockGetConn.mockRejectedValue(new Error('org unreachable'));

      await handler.handle(buildMsg('seed:clone:describe-source', { sourceOrgId: 'src-org' }));

      const errors = posted(deps, 'seed:clone:error');
      expect(errors).toHaveLength(1);
      expect((errors[0].payload as { message: string }).message).toContain('org unreachable');
    });
  });

  describe('seed:clone:execute', () => {
    it('writes through BulkDataWriter and reports a successful clone', async () => {
      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      expect(writer.insert).toHaveBeenCalledWith('Account', [{ Name: 'Acme' }], 200);
      expect(posted(deps, 'operation:started')).toHaveLength(1);
      const responses = posted(deps, 'seed:clone:execute:response');
      expect(responses).toHaveLength(1);
      expect(responses[0].payload as unknown).toMatchObject({
        status: 'success',
        totalInserted: 1,
        totalFailed: 0,
      });
    });

    describe('before and after the write', () => {
      /** Fake ids: the source Account, the one the target holds, a closed record type. */
      const SOURCE_ACCOUNT = '001Fk00000ZzYxWIAV';
      const EXISTING_ACCOUNT = '001Fk00000AbCdEIAV';
      const PARTNER_RT = '012Fk00000RtDeFIAV';

      /** Target describes: Account with a Partner type the running user cannot use; Contact under it. */
      function targetWithRecordTypes(): void {
        mockGetConn.mockResolvedValue({
          describe: vi.fn(async (name: string) =>
            name === 'Account'
              ? {
                  keyPrefix: '001',
                  fields: [
                    { name: 'RecordTypeId', type: 'reference', referenceTo: ['RecordType'] },
                  ],
                  recordTypeInfos: [
                    {
                      active: true,
                      available: false,
                      defaultRecordTypeMapping: false,
                      developerName: 'Partner',
                      master: false,
                      name: 'Partner',
                      recordTypeId: PARTNER_RT,
                      urls: {},
                    },
                  ],
                }
              : {
                  keyPrefix: '003',
                  fields: [{ name: 'AccountId', type: 'reference', referenceTo: ['Account'] }],
                  recordTypeInfos: [],
                },
          ),
          limitInfo: undefined,
        } as unknown as Awaited<ReturnType<typeof getJsforceConnection>>);
      }

      it('holds back an object whose record type the running user cannot use, writing none of it', async () => {
        targetWithRecordTypes();
        fetcher.fetchRecords.mockResolvedValue([
          { Id: SOURCE_ACCOUNT, Name: 'Acme', RecordTypeId: PARTNER_RT },
        ]);

        await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

        expect(writer.insert).not.toHaveBeenCalled();
        const [response] = posted(deps, 'seed:clone:execute:response');
        expect(response.payload as unknown).toMatchObject({
          status: 'failure',
          totalInserted: 0,
          totalFailed: 1,
          objectResults: [
            {
              objectApiName: 'Account',
              failedCount: 1,
              errors: [
                {
                  sourceId: SOURCE_ACCOUNT,
                  message:
                    'RECORD_TYPE_UNAVAILABLE: 1 Account record uses record type Partner, which the ' +
                    'running user cannot use in the target org. Give the running user access to ' +
                    'record type Partner on Account, or map it to one they have.',
                },
              ],
            },
          ],
        });
      });

      it('links the children of a record the target already holds, and counts it apart', async () => {
        targetWithRecordTypes();
        linker.resolveInsertOrder.mockReturnValue(['Account', 'Contact']);
        fetcher.fetchRecords.mockImplementation(async (_conn: unknown, name: string) =>
          name === 'Account'
            ? [{ Id: SOURCE_ACCOUNT, Name: 'Acme' }]
            : [{ Id: '003Fk00000MnOpQIAV', LastName: 'Doe', AccountId: SOURCE_ACCOUNT }],
        );
        writer.insert.mockImplementation(async (name: string) =>
          name === 'Account'
            ? [
                {
                  success: false,
                  errors: [
                    'DUPLICATE_VALUE: duplicate value found: Name duplicates value on record with id: 001Fk00000AbCdE',
                  ],
                  existingId: EXISTING_ACCOUNT,
                },
              ]
            : [{ id: '003Fk00000NeWcTIAV', success: true, errors: [] }],
        );

        await handler.handle(
          buildMsg(
            'seed:clone:execute',
            clonePayload({
              objects: [{ objectApiName: 'Account' }, { objectApiName: 'Contact' }],
            }),
          ),
        );

        expect(writer.insert).toHaveBeenLastCalledWith(
          'Contact',
          [{ LastName: 'Doe', AccountId: EXISTING_ACCOUNT }],
          200,
        );
        const [response] = posted(deps, 'seed:clone:execute:response');
        expect(response.payload as unknown).toMatchObject({
          status: 'success',
          totalInserted: 1,
          totalLinked: 1,
          totalFailed: 0,
          objectResults: [
            {
              objectApiName: 'Account',
              insertedCount: 0,
              linkedCount: 1,
              failedCount: 0,
              idMappings: [{ sourceId: SOURCE_ACCOUNT, targetId: EXISTING_ACCOUNT }],
            },
            { objectApiName: 'Contact', insertedCount: 1, linkedCount: 0 },
          ],
        });
      });

      it('tells the writer the key prefix a duplicate of each object must carry', async () => {
        targetWithRecordTypes();

        await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

        const writerDeps = vi.mocked(BulkDataWriter).mock.calls[0][0];
        expect(writerDeps.keyPrefixOf?.('Account')).toBe('001');
      });
    });

    it('reports execute failures on operation:failed as retryable', async () => {
      writer.insert.mockRejectedValue(new Error('bulk write exploded'));

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      const failures = posted(deps, 'operation:failed');
      expect(failures).toHaveLength(1);
      // The English text is what the output channel and the fix-suggestion
      // table read; the code is what the wizard translates.
      expect(failures[0].payload as unknown).toMatchObject({
        error: 'bulk write exploded',
        retryable: true,
        code: 'CLONE_FAILED',
      });
    });

    describe('a clone a cancel stopped', () => {
      /** The id the clone runs under: its request's. */
      const OPERATION_ID = 'msg-seed:clone:execute';

      /** Account, then Contact. */
      const accountsAndContacts = (): Record<string, unknown> =>
        clonePayload({ objects: [{ objectApiName: 'Account' }, { objectApiName: 'Contact' }] });

      let registry: BackgroundOperationRegistry;
      beforeEach(() => {
        registry = new BackgroundOperationRegistry();
        handler.setRegistry(registry);
        linker.resolveInsertOrder.mockReturnValue(['Account', 'Contact']);
      });

      it('writes no object after the cancel, and ends as aborted with what it wrote', async () => {
        // Only an upload of more than ten thousand records looked at the
        // cancel: every other object went on being read and written.
        writer.insert.mockImplementation(async () => {
          registry.abort(OPERATION_ID);
          return [{ id: '001TGT', success: true, errors: [] }];
        });

        await handler.handle(buildMsg('seed:clone:execute', accountsAndContacts()));

        expect(writer.insert.mock.calls.map((call) => call[0])).toEqual(['Account']);
        expect(posted(deps, 'operation:failed')).toEqual([]);
        expect(posted(deps, 'operation:completed')[0].payload as unknown).toEqual({
          operationId: OPERATION_ID,
          result: { aborted: true, totalInserted: 1, totalFailed: 0 },
        });
        expect(registry.get(OPERATION_ID)?.status).toBe('aborted');
        // The wizard hears what was written, and that the clone did not finish.
        expect(posted(deps, 'seed:clone:execute:response')[0].payload as unknown).toMatchObject({
          cancelled: true,
          status: 'partial',
          totalInserted: 1,
        });
      });

      it('ends cancelled when the cancel aborted the upload of its last object', async () => {
        writer.insert.mockImplementation(async (name: string) => {
          if (name === 'Contact') {
            registry.abort(OPERATION_ID);
            throw new WriteCancelledError('Contact');
          }
          return [{ id: '001TGT', success: true, errors: [] }];
        });

        await handler.handle(buildMsg('seed:clone:execute', accountsAndContacts()));

        expect(posted(deps, 'operation:completed')[0].payload as unknown).toMatchObject({
          result: { aborted: true, totalInserted: 1 },
        });
        expect(posted(deps, 'seed:clone:execute:response')[0].payload as unknown).toMatchObject({
          cancelled: true,
          objectResults: [{ objectApiName: 'Account' }],
        });
      });

      it('counts what an object wrote before the cancel stopped its write between two batches', async () => {
        // Those records stay in the target: a clone that left them out said
        // less was written than was, and lost their ids.
        fetcher.fetchRecords.mockImplementation(async (_conn: unknown, name: string) =>
          name === 'Account'
            ? [{ Id: '001SRC', Name: 'Acme' }]
            : [
                { Id: '003SRC1', LastName: 'Doe' },
                { Id: '003SRC2', LastName: 'Roe' },
                { Id: '003SRC3', LastName: 'Poe' },
              ],
        );
        writer.insert.mockImplementation(async (name: string) => {
          if (name === 'Contact') {
            registry.abort(OPERATION_ID);
            throw new WriteCancelledError('Contact', [
              { id: '003TGT1', success: true, errors: [] },
              { success: false, errors: ['REQUIRED_FIELD_MISSING: LastName'] },
            ]);
          }
          return [{ id: '001TGT', success: true, errors: [] }];
        });

        await handler.handle(buildMsg('seed:clone:execute', accountsAndContacts()));

        expect(posted(deps, 'operation:completed')[0].payload as unknown).toEqual({
          operationId: OPERATION_ID,
          result: { aborted: true, totalInserted: 2, totalFailed: 1 },
        });
        const response = posted(deps, 'seed:clone:execute:response')[0].payload as unknown;
        expect(response).toMatchObject({
          cancelled: true,
          status: 'partial',
          totalInserted: 2,
          totalFailed: 1,
        });
        expect((response as { objectResults: unknown[] }).objectResults[1]).toMatchObject({
          objectApiName: 'Contact',
          sourceCount: 3,
          insertedCount: 1,
          failedCount: 1,
          idMappings: [{ sourceId: '003SRC1', targetId: '003TGT1' }],
          errors: [{ sourceId: '003SRC2', message: 'REQUIRED_FIELD_MISSING: LastName' }],
        });
      });

      it('still fails when a write fails while the cancel is pending', async () => {
        writer.insert.mockImplementation(async () => {
          registry.abort(OPERATION_ID);
          throw new Error('bulk write exploded');
        });

        await handler.handle(buildMsg('seed:clone:execute', accountsAndContacts()));

        expect(posted(deps, 'operation:completed')).toEqual([]);
        expect(posted(deps, 'operation:failed')[0].payload as unknown).toMatchObject({
          operationId: OPERATION_ID,
          error: 'bulk write exploded',
        });
      });
    });
  });

  describe('in Live Operations', () => {
    /** The id the clone runs under: its request's. */
    const OPERATION_ID = 'msg-seed:clone:execute';

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

    it('lists a clone while it runs, under the id its Cancel reaches it by', async () => {
      let listed: LiveOperation[] = [];
      writer.insert.mockImplementation(async () => {
        listed = tracker.getAll().map((op) => ({ ...op }));
        return [{ id: '001TGT', success: true, errors: [] }];
      });

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      expect(listed).toEqual([
        expect.objectContaining({
          operationId: OPERATION_ID,
          module: 'clone',
          status: 'running',
          currentStep: 'Cloning Account',
        }),
      ]);
      expect(registry.get(OPERATION_ID)).toBeDefined();
      expect(tracker.get(OPERATION_ID)?.status).toBe('completed');
    });

    it('counts the objects already written in as the upload of the next one goes', async () => {
      linker.resolveInsertOrder.mockReturnValue(['Account', 'Contact']);
      fetcher.fetchRecords.mockImplementation(async (_conn: unknown, name: string) =>
        name === 'Account'
          ? [{ Id: '001SRC', Name: 'Acme' }]
          : [
              { Id: '003SRC1', LastName: 'One' },
              { Id: '003SRC2', LastName: 'Two' },
            ],
      );
      let midway: LiveOperation | undefined;
      writer.insert.mockImplementation(async (name: string, records: unknown[]) => {
        if (name === 'Contact') {
          // The writer reports the upload of the second object half done.
          const { onProgress } = vi.mocked(BulkDataWriter).mock.calls[0][0] as unknown as {
            onProgress: (processed: number, total: number, label: string) => void;
          };
          onProgress(1, 2, 'Contact: 1/2');
          midway = { ...tracker.getAll()[0] };
        }
        return records.map(() => ({ id: '001TGT', success: true, errors: [] }));
      });

      await handler.handle(
        buildMsg(
          'seed:clone:execute',
          clonePayload({ objects: [{ objectApiName: 'Account' }, { objectApiName: 'Contact' }] }),
        ),
      );

      // One object of two written, and half of the second: three quarters.
      expect(midway).toMatchObject({
        percentage: 75,
        processedRecords: 2,
        currentStep: 'Contact: 1/2',
      });
    });

    it('ends a clone whose write failed as failed, with its error', async () => {
      writer.insert.mockRejectedValue(new Error('bulk write exploded'));

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      expect(tracker.get(OPERATION_ID)).toMatchObject({
        status: 'failed',
        error: 'bulk write exploded',
      });
    });

    it('ends a clone that wrote no record as failed', async () => {
      writer.insert.mockResolvedValue([
        { id: '', success: false, errors: ['REQUIRED_FIELD_MISSING: Name'] },
      ]);

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      expect(tracker.get(OPERATION_ID)).toMatchObject({
        status: 'failed',
        error: 'No record could be cloned.',
      });
    });

    it('ends a clone a cancel stopped as cancelled', async () => {
      writer.insert.mockImplementation(async () => {
        registry.abort(OPERATION_ID);
        throw new WriteCancelledError('Account');
      });

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      expect(tracker.get(OPERATION_ID)?.status).toBe('cancelled');
    });
  });

  describe('how a clone ends in the registry', () => {
    /** The id the clone runs under: its request's. */
    const OPERATION_ID = 'msg-seed:clone:execute';

    let registry: BackgroundOperationRegistry;
    beforeEach(() => {
      registry = new BackgroundOperationRegistry();
      handler.setRegistry(registry);
    });

    it('ends a clone that wrote nothing as failed, as it ends everywhere else', async () => {
      writer.insert.mockResolvedValue([
        { id: '', success: false, errors: ['REQUIRED_FIELD_MISSING: Name'] },
      ]);

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      await vi.waitFor(() => expect(registry.get(OPERATION_ID)?.status).toBe('failed'));
      expect(registry.get(OPERATION_ID)?.resultSummary).toBe('No record could be cloned.');
      expect(posted(deps, 'operation:completed')[0].payload as unknown).toMatchObject({
        result: { status: 'failure' },
      });
    });

    it('ends a clone that wrote its records as completed', async () => {
      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      await vi.waitFor(() => expect(registry.get(OPERATION_ID)?.status).toBe('completed'));
    });
  });

  describe('audit trail', () => {
    const SOURCE_ACCOUNT_ID = '001Fk00000SoUrCIAV';
    const EXISTING_ACCOUNT_ID = '001Fk00000ExIsTIAV';

    /** A real store, read back the way the Reports page reads it. */
    function recordingStore(): ConfigStore {
      const store = new ConfigStore(new InMemoryConfigStoreBackend());
      store.initialize();
      deps.configStore = store;
      return store;
    }

    it('records a clone once, and counts its lineage from its own id mappings', async () => {
      const store = recordingStore();
      linker.resolveInsertOrder.mockReturnValue(['Account', 'Contact']);
      fetcher.fetchRecords.mockImplementation(async (_conn: unknown, name: string) =>
        name === 'Account'
          ? [{ Id: SOURCE_ACCOUNT_ID, Name: 'Acme' }]
          : [
              { Id: '003Fk00000AaAaAIAV', LastName: 'Doe' },
              { Id: '003Fk00000BbBbBIAV', LastName: 'Roe' },
            ],
      );
      writer.insert.mockImplementation(async (name: string) =>
        name === 'Account'
          ? [{ success: false, errors: ['DUPLICATE_VALUE'], existingId: EXISTING_ACCOUNT_ID }]
          : [
              { id: '003Fk00000NeWcTIAV', success: true, errors: [] },
              { success: false, errors: ['REQUIRED_FIELD_MISSING'] },
            ],
      );

      await handler.handle(
        buildMsg(
          'seed:clone:execute',
          clonePayload({ objects: [{ objectApiName: 'Account' }, { objectApiName: 'Contact' }] }),
        ),
      );

      const { entries } = new AuditTrailStore(store).list();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        action: 'seed_clone',
        module: 'seed',
        operationId: 'msg-seed:clone:execute',
        orgId: 'tgt-org',
        sourceOrgId: 'src-org',
        outcome: 'partial',
        objects: [
          // Linked to a record the target held: neither created nor failed.
          { objectApiName: 'Account', created: 0, failed: 0 },
          { objectApiName: 'Contact', created: 1, failed: 1 },
        ],
      });
      // The linked Account has a counterpart in the target, the refused Contact has none.
      const lineage = new LineageStore(store).get('msg-seed:clone:execute');
      expect(
        lineage?.nodes.filter((n) => n.type === 'object').map((n) => [n.label, n.recordCount]),
      ).toEqual([
        ['Account', 1],
        ['Contact', 1],
      ]);
      const stored = JSON.stringify([store.get('audit:trail'), store.get('lineage:runs')]);
      expect(stored).not.toContain(SOURCE_ACCOUNT_ID);
      expect(stored).not.toContain(EXISTING_ACCOUNT_ID);
    });

    it('records a clone that failed partway with the objects it had written', async () => {
      const store = recordingStore();
      linker.resolveInsertOrder.mockReturnValue(['Account', 'Contact']);
      fetcher.fetchRecords.mockResolvedValue([{ Id: SOURCE_ACCOUNT_ID, Name: 'Acme' }]);
      writer.insert.mockImplementation(async (name: string) => {
        if (name === 'Contact') throw new Error('bulk write exploded');
        return [{ id: '001Fk00000NeWaCIAV', success: true, errors: [] }];
      });

      await handler.handle(
        buildMsg(
          'seed:clone:execute',
          clonePayload({ objects: [{ objectApiName: 'Account' }, { objectApiName: 'Contact' }] }),
        ),
      );

      expect(new AuditTrailStore(store).list().entries).toEqual([
        expect.objectContaining({
          outcome: 'failure',
          objects: [expect.objectContaining({ objectApiName: 'Account', created: 1 })],
        }),
      ]);
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
        impactSummary:
          'INSERT an unknown number of Account record(s) on production org tgt-org [module: clone]',
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
      // A host that never wired the guard used to skip it and clone on.
      deps.infraServices = undefined;
      mockTargetOrgType('Production');

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      expect(writer.insert).not.toHaveBeenCalled();
      expect(getJsforceConnection).not.toHaveBeenCalled();
      const failed = posted(deps, 'operation:failed') as Array<
        BaseMessage & { payload: { code?: string; retryable?: boolean } }
      >;
      expect(failed).toHaveLength(1);
      expect(failed[0].payload).toMatchObject({ code: 'NOT_INITIALIZED', retryable: false });
      expect(posted(deps, 'seed:clone:execute:response')).toHaveLength(0);
      // Recorded as the guard's own refusals are, with the code that says why.
      const trail = vi
        .mocked(deps.configStore.set)
        .mock.calls.filter(([key]) => key === 'audit:trail');
      expect(trail.at(-1)?.[1]).toEqual([
        expect.objectContaining({
          action: 'seed_clone',
          outcome: 'stopped',
          details: { code: 'NOT_INITIALIZED' },
        }),
      ]);
    });

    it('resolves the guard tier from the target org and clones once confirmed', async () => {
      const guard = wireGuard({
        allowed: true,
        requiresConfirmation: true,
        confirmed: true,
      });
      mockTargetOrgType('Production');

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      expect(guard.check.mock.calls[0][0]).toMatchObject({
        orgId: 'tgt-org',
        orgTier: 'production',
        operation: 'insert',
        objectName: 'Account',
        module: 'clone',
      });
      expect(guard.check).toHaveBeenCalledTimes(1);
      expect(writer.insert).toHaveBeenCalledTimes(1);
      expect(posted(deps, 'seed:clone:execute:response')).toHaveLength(1);
    });

    it('names every object of the clone to the guard, count unknown until the source is read', async () => {
      const guard = wireGuard({ allowed: true, requiresConfirmation: true, confirmed: true });
      mockTargetOrgType('Production');
      linker.resolveInsertOrder.mockReturnValue(['Account', 'Contact']);

      await handler.handle(
        buildMsg(
          'seed:clone:execute',
          clonePayload({
            objects: [{ objectApiName: 'Account' }, { objectApiName: 'Contact' }],
          }),
        ),
      );

      expect(guard.check.mock.calls[0][0]).toMatchObject({
        objectName: 'Account, Contact',
        recordCount: 'unknown',
      });
    });

    it('declares an upsert clone as an upsert to the guard', async () => {
      const guard = wireGuard({ allowed: true });
      mockTargetOrgType('Sandbox');

      await handler.handle(
        buildMsg(
          'seed:clone:execute',
          clonePayload({ upsert: true, externalIdField: 'External_Id__c' }),
        ),
      );

      expect(guard.check.mock.calls[0][0]).toMatchObject({
        orgTier: 'development',
        operation: 'upsert',
      });
      expect(writer.upsert).toHaveBeenCalledWith(
        'Account',
        'External_Id__c',
        [{ Name: 'Acme' }],
        200,
      );
    });

    it('blocks the clone when the guard refuses — no write, retryable operation:failed', async () => {
      const guard = wireGuard({
        allowed: false,
        blockedReason: 'insert is not allowed on production org tgt-org',
      });
      mockTargetOrgType('Production');

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      expect(guard.check).toHaveBeenCalledTimes(1);
      expect(guard.confirmIfNeeded).not.toHaveBeenCalled();
      expect(writer.insert).not.toHaveBeenCalled();
      expect(writer.upsert).not.toHaveBeenCalled();
      expect(posted(deps, 'seed:clone:execute:response')).toHaveLength(0);

      const failures = posted(deps, 'operation:failed');
      expect(failures).toHaveLength(1);
      expect(failures[0].payload as unknown).toEqual({
        operationId: 'msg-seed:clone:execute',
        error:
          'Operation blocked by Production Guard: insert is not allowed on production org tgt-org',
        retryable: true,
        code: 'PRODUCTION_GUARD_BLOCKED',
      });
    });

    it('falls back to the impact summary when the guard blocks without a reason', async () => {
      wireGuard({ allowed: false });
      mockTargetOrgType('Production');

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      const failures = posted(deps, 'operation:failed');
      expect((failures[0].payload as { error: string }).error).toBe(
        'Operation blocked by Production Guard: INSERT an unknown number of Account record(s) on production org tgt-org [module: clone]',
      );
    });

    it('cancels the clone when the user declines confirmation — no write, not retryable', async () => {
      const guard = wireGuard({
        allowed: true,
        requiresConfirmation: true,
        confirmed: false,
      });
      mockTargetOrgType('Production');

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      expect(guard.confirmIfNeeded).toHaveBeenCalledTimes(1);
      expect(writer.insert).not.toHaveBeenCalled();
      expect(writer.upsert).not.toHaveBeenCalled();
      expect(posted(deps, 'operation:started')).toHaveLength(0);
      expect(posted(deps, 'seed:clone:execute:response')).toHaveLength(0);

      const failures = posted(deps, 'operation:failed');
      expect(failures).toHaveLength(1);
      expect(failures[0].payload as unknown).toEqual({
        operationId: 'msg-seed:clone:execute',
        error: 'Operation cancelled by user (production confirmation declined).',
        retryable: false,
        code: 'PRODUCTION_CONFIRMATION_DECLINED',
      });
    });

    it('asks before cloning into an org the registry does not know, and writes nothing when declined', async () => {
      // A real guard, and getOrg left unstubbed: nothing shows 'tgt-org' is a
      // sandbox. It was classed as development, so the clone wrote without a
      // word to the user.
      const requestConfirmation = vi.fn().mockResolvedValue(false);
      const guard = new ProductionGuard({ requestConfirmation });
      const check = vi.spyOn(guard, 'check');
      deps.infraServices = {
        performanceTracker: { start: vi.fn(), complete: vi.fn() },
        productionGuard: guard,
        offlineManager: undefined,
        piiDetector: undefined,
      } as unknown as NonNullable<HandlerDeps['infraServices']>;

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      expect(requestConfirmation).toHaveBeenCalledWith(
        'INSERT an unknown number of Account record(s) on production org tgt-org [module: clone]',
        'production',
      );
      expect(check.mock.calls.map(([request]) => request.orgTier)).toEqual(['production']);
      expect(mockGetConn).not.toHaveBeenCalled();
      expect(writer.insert).not.toHaveBeenCalled();
      expect(writer.upsert).not.toHaveBeenCalled();
      expect(posted(deps, 'operation:failed')[0].payload as unknown).toMatchObject({
        retryable: false,
        code: 'PRODUCTION_CONFIRMATION_DECLINED',
      });
    });

    it('does not leave a declined clone listed as running', async () => {
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

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(registry.getRunning()).toEqual([]);
    });

    it('tells the model which objects a failed clone was writing', async () => {
      // The prompt is all the model sees: without the run behind it, an org
      // error arrives as a bare sentence and the answer fits any clone.
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

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));
      await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));

      const [prompt] = provider.mock.calls[0];
      expect(prompt).toContain('Module: seed');
      expect(prompt).toContain('Operation: seed:clone:execute');
      expect(prompt).toContain('Target object: Account');
      expect(prompt).toContain('Batch size: 200');
    });
  });
});
