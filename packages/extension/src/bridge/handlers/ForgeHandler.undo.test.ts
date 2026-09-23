import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BaseMessage,
  ForgeExecutionResult,
  ForgeGraph,
  ForgeUndoResult,
} from '@sandforge/shared';

import { ForgeHandler } from './ForgeHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { ForgeAbortedError } from '../../modules/forge/ForgeExecutor.js';
import type { ForgeOrchestrator } from '../../modules/forge/ForgeOrchestrator.js';
import { keepPartialSummary } from '../../modules/forge/interruptedRun.js';
import { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { inboundRequest } from '../../test/mockFactories.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));
vi.mock('../../core/common/sforceLimitParser.js', () => ({
  checkApiLimits: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

const mockGetConn = vi.mocked(getJsforceConnection);

/** A fake record id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;
const src = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}SRC`;

const RUN_ENDED = '2026-09-20T10:05:00.000Z';
const DURING_RUN = '2026-09-20T10:02:00.000+0000';
const AFTER_RUN = '2026-09-20T11:00:00.000+0000';
const TARGET_ORG = 'tgt-org';

const GRAPH: ForgeGraph = {
  nodes: [],
  edges: [],
  totalRecords: 3,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 1,
};

/** A run that created an account and two contacts under it, and linked one account. */
function runEntry(overrides: Partial<ForgeExecutionResult> = {}): ForgeExecutionResult {
  return {
    forgeId: 'forge-1',
    status: 'success',
    graph: GRAPH,
    duration: 300_000,
    timestamp: RUN_ENDED,
    idRemapCount: 4,
    idRemapTable: {
      [src('001', 1)]: id('001', 1),
      [src('001', 2)]: id('001', 9),
      [src('003', 1)]: id('003', 1),
      [src('003', 2)]: id('003', 2),
    },
    idRemapExisting: [src('001', 2)],
    idRemapCreated: [
      { objectApiName: 'Account', sourceIds: [src('001', 1)] },
      { objectApiName: 'Contact', sourceIds: [src('003', 1), src('003', 2)] },
    ],
    targetOrgId: TARGET_ORG,
    config: {
      inputMode: 'record',
      recordId: src('001', 1).slice(0, 15),
      depth: 'direct',
      anonymizePII: false,
      skipEmpty: false,
      batchSize: 'auto',
    },
    ...overrides,
  };
}

type Row = Record<string, unknown> & { Id: string };

/**
 * The target org, as jsforce shows it to the removal: rows per object, the
 * account's cascading children, a delete that takes what cascades along.
 */
function targetOrg() {
  const rows = new Map<string, Row[]>([
    ['Account', [{ Id: id('001', 1), LastModifiedDate: DURING_RUN, CreatedDate: DURING_RUN }]],
    [
      'Contact',
      [
        {
          Id: id('003', 1),
          AccountId: id('001', 1),
          LastModifiedDate: DURING_RUN,
          CreatedDate: DURING_RUN,
        },
        {
          Id: id('003', 2),
          AccountId: id('001', 1),
          LastModifiedDate: DURING_RUN,
          CreatedDate: DURING_RUN,
        },
      ],
    ],
  ]);
  const deletes: Array<{ object: string; ids: string[] }> = [];
  let beforeDelete: (object: string) => void | Promise<void> = () => {};
  const conn = {
    limitInfo: undefined,
    query: vi.fn(async (soql: string) => {
      const match = /^SELECT (.+) FROM (\w+) WHERE (\w+) IN \((.*)\)(?: LIMIT \d+)?$/.exec(soql);
      if (!match) throw new Error(`unexpected query: ${soql}`);
      const [, columns, object, field, list] = match;
      const wanted = new Set(list.split(', ').map((q) => q.slice(1, -1)));
      const records = (rows.get(object) ?? [])
        .filter((row) => wanted.has(String(row[field])))
        .map((row) => Object.fromEntries(columns.split(', ').map((c) => [c, row[c]])));
      return { totalSize: records.length, done: true, records };
    }),
    describe: vi.fn(async (object: string) => ({
      name: object,
      label: object,
      fields: [],
      childRelationships:
        object === 'Account'
          ? [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: true }]
          : [],
    })),
    describeGlobal: vi.fn(async () => ({
      sobjects: ['Account', 'Contact'].map((name) => ({
        name,
        label: name,
        queryable: true,
        createable: true,
        layoutable: true,
      })),
    })),
    sobject: (object: string) => ({
      destroy: vi.fn(async (ids: string[]) => {
        await beforeDelete(object);
        deletes.push({ object, ids: [...ids] });
        return ids.map((recordId) => {
          rows.set(
            object,
            (rows.get(object) ?? []).filter((r) => r.Id !== recordId),
          );
          return { id: recordId, success: true, errors: [] };
        });
      }),
    }),
  };
  return {
    conn,
    rows,
    deletes,
    onDelete: (hook: (object: string) => void | Promise<void>) => {
      beforeDelete = hook;
    },
  };
}

function buildMsg(type: string, payload?: unknown): InboundRequest {
  return inboundRequest({
    id: `req-${type}`,
    type,
    timestamp: Date.now(),
    ...(payload !== undefined ? { payload } : {}),
  } as BaseMessage);
}

describe('forge:undo', () => {
  let deps: HandlerDeps;
  let store: ConfigStore;
  let handler: ForgeHandler;
  let registry: BackgroundOperationRegistry;
  let tracker: LiveOperationTracker;
  let org: ReturnType<typeof targetOrg>;

  /** Messages posted to the webview, of one type. */
  const posted = <T extends BaseMessage>(type: string): T[] =>
    vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as T)
      .filter((m) => m.type === type);
  const errors = () =>
    posted<BaseMessage & { payload: { code: string; message: string } }>('forge:undo:error');
  const answer = (): ForgeUndoResult | undefined =>
    posted<BaseMessage & { payload: { result: ForgeUndoResult } }>('forge:undo:response')[0]
      ?.payload.result;
  const history = (): ForgeExecutionResult[] =>
    store.get<ForgeExecutionResult[]>('forge:history') ?? [];
  const trail = () => new AuditTrailStore(store).list().entries;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new ConfigStore(new InMemoryConfigStoreBackend());
    store.initialize();
    store.set('forge:history', [runEntry()], 'forge');
    registry = new BackgroundOperationRegistry();
    tracker = new LiveOperationTracker();
    let n = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn().mockReturnValue({ orgType: 'Sandbox', alias: 'DEV' }),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as HandlerDeps['orgRegistry'],
      configStore: store,
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      infraServices: {
        productionGuard: new ProductionGuard(),
        backgroundRegistry: registry,
      } as unknown as HandlerDeps['infraServices'],
      nextId: () => String(++n),
    };
    handler = new ForgeHandler(deps);
    handler.setLiveOperationTracker(tracker);
    org = targetOrg();
    mockGetConn.mockResolvedValue(org.conn as never);
  });

  it('removes what the run created, children first, and keeps the account it linked', async () => {
    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

    expect(mockGetConn).toHaveBeenCalledWith(TARGET_ORG, deps.orgRegistry, deps.orgManager);
    expect(org.deletes).toEqual([
      { object: 'Contact', ids: [id('003', 2), id('003', 1)] },
      { object: 'Account', ids: [id('001', 1)] },
    ]);
    expect(org.deletes.flatMap((d) => d.ids)).not.toContain(id('001', 9));
    expect(answer()).toMatchObject({
      forgeId: 'forge-1',
      status: 'success',
      includeChanged: false,
      objects: [
        { objectApiName: 'Contact', planned: 2, deleted: 2 },
        { objectApiName: 'Account', planned: 1, deleted: 1 },
      ],
    });
    expect(errors()).toEqual([]);
  });

  it('records the removal in the audit trail with what it deleted per object', async () => {
    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

    expect(trail()).toEqual([
      expect.objectContaining({
        action: 'cleanup_delete',
        module: 'forge',
        orgId: TARGET_ORG,
        outcome: 'success',
        guard: 'allowed',
        objects: [
          { objectApiName: 'Contact', created: 0, updated: 0, deleted: 2, failed: 0 },
          { objectApiName: 'Account', created: 0, updated: 0, deleted: 1, failed: 0 },
        ],
      }),
    ]);
    // Counts only: no record id reaches the trail.
    expect(JSON.stringify(store.get('audit:trail'))).not.toContain(id('003', 1));
  });

  it('marks the entry, so its removal is not offered or run twice', async () => {
    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

    expect(history()[0].undo).toEqual({
      removedAt: answer()?.finishedAt,
      deleted: 3,
      alreadyGone: 0,
      kept: 0,
      refused: 0,
    });

    vi.mocked(deps.broker.postToWebview).mockClear();
    org.deletes.length = 0;
    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

    expect(org.deletes).toEqual([]);
    expect(errors().map((e) => e.payload.code)).toEqual(['ALREADY_REMOVED']);
  });

  it('keeps a contact modified since the run, and the account it hangs from, unless asked', async () => {
    (org.rows.get('Contact') ?? [])[0].LastModifiedDate = AFTER_RUN;

    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

    expect(answer()).toMatchObject({
      status: 'partial',
      objects: [
        { objectApiName: 'Contact', deleted: 1, keptChanged: 1 },
        { objectApiName: 'Account', deleted: 0, keptDependents: 1, heldBy: ['Contact'] },
      ],
    });
    expect(history()[0].undo).toMatchObject({ deleted: 1, kept: 2 });
  });

  it('removes a contact modified since the run when the request includes it', async () => {
    (org.rows.get('Contact') ?? [])[0].LastModifiedDate = AFTER_RUN;

    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1', includeChanged: true }));

    expect(answer()).toMatchObject({ status: 'success', includeChanged: true });
    expect(org.rows.get('Contact')).toEqual([]);
  });

  it('leaves the entry unmarked when nothing could be removed', async () => {
    for (const row of [...(org.rows.get('Contact') ?? []), ...(org.rows.get('Account') ?? [])]) {
      row.LastModifiedDate = AFTER_RUN;
    }

    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

    expect(answer()?.status).toBe('failure');
    expect(history()[0].undo).toBeUndefined();
    expect(trail()[0]).toMatchObject({ outcome: 'failure', objects: [] });
  });

  it('runs on the registry and in Live Operations, where Cancel stops it', async () => {
    const events: string[] = [];
    registry.onEvent((_, type) => events.push(type));
    // Cancel from Live Operations while the contacts are being deleted.
    org.onDelete(() => {
      const [running] = registry.getRunning();
      if (running) registry.abort(running.operationId);
    });

    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

    // Stopped once, and nothing reported after the stop.
    expect(events.filter((e) => e !== 'progress')).toEqual(['started', 'aborted']);
    expect(events.at(-1)).toBe('aborted');
    expect(org.deletes.map((d) => d.object)).toEqual(['Contact']);
    expect(answer()).toMatchObject({
      status: 'cancelled',
      objects: [{ objectApiName: 'Contact', deleted: 2 }],
    });
    expect(tracker.getAll()).toEqual([
      expect.objectContaining({ module: 'forge', status: 'cancelled', totalRecords: 3 }),
    ]);
    // Stopped part way: recorded with what it deleted, and offered again.
    expect(trail()[0]).toMatchObject({ outcome: 'partial' });
    expect(history()[0].undo).toBeUndefined();
  });

  it('lists a finished removal as completed in the registry and in Live Operations', async () => {
    const events: string[] = [];
    registry.onEvent((_, type) => events.push(type));

    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

    expect(events.filter((e) => e !== 'progress')).toEqual(['started', 'completed']);
    expect(tracker.getAll()).toEqual([
      expect.objectContaining({ module: 'forge', status: 'completed', processedRecords: 3 }),
    ]);
  });

  describe('refusals, before anything is read', () => {
    it.each([
      ['a run no longer in the history', { forgeId: 'forge-gone' }, undefined, 'NOT_FOUND'],
      [
        'a run recorded before runs kept what they created',
        { forgeId: 'forge-1' },
        runEntry({ idRemapCreated: undefined }),
        'NOT_RECORDED',
      ],
      [
        'a run recorded before its target org was kept',
        { forgeId: 'forge-1' },
        runEntry({ targetOrgId: undefined }),
        'NOT_RECORDED',
      ],
      [
        'a run that created nothing',
        { forgeId: 'forge-1' },
        runEntry({ idRemapCreated: [] }),
        'NOTHING_TO_REMOVE',
      ],
      [
        'a run whose records were removed already',
        { forgeId: 'forge-1' },
        runEntry({
          undo: {
            removedAt: '2026-09-21T08:00:00.000Z',
            deleted: 3,
            alreadyGone: 0,
            kept: 0,
            refused: 0,
          },
        }),
        'ALREADY_REMOVED',
      ],
      ['a request that names no run', { includeChanged: true }, undefined, 'INVALID_PAYLOAD'],
    ])('refuses %s', async (_, payload, entry, code) => {
      if (entry) store.set('forge:history', [entry], 'forge');

      await handler.handle(buildMsg('forge:undo', payload));

      expect(errors().map((e) => e.payload.code)).toEqual([code]);
      expect(errors()[0].correlationId).toBe('req-forge:undo');
      expect(mockGetConn).not.toHaveBeenCalled();
      expect(trail()).toEqual([]);
    });

    it('refuses a second removal of a run while the first one runs', async () => {
      let release: () => void = () => {};
      let paused = false;
      org.onDelete(() => {
        org.onDelete(() => {});
        paused = true;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      const first = handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));
      await vi.waitFor(() => expect(paused).toBe(true));

      await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));
      release();
      await first;

      expect(errors().map((e) => e.payload.code)).toEqual(['DUPLICATE']);
    });

    it('refuses a second removal while the first waits on the production confirmation', async () => {
      /** Every question put to the person, answered only once the test says so. */
      const asked: Array<(confirmed: boolean) => void> = [];
      const confirmIfNeeded = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            asked.push(resolve);
          }),
      );
      deps.infraServices = {
        productionGuard: {
          check: vi.fn().mockReturnValue({
            allowed: true,
            requiresConfirmation: true,
            requiresApproval: false,
            warnings: [],
            impactSummary: 'DELETE 3 records',
          }),
          confirmIfNeeded,
          canAskForConfirmation: true,
        },
        backgroundRegistry: registry,
      } as unknown as HandlerDeps['infraServices'];
      const first = handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));
      await vi.waitFor(() => expect(confirmIfNeeded).toHaveBeenCalledTimes(1));

      const second = handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));
      await vi.waitFor(() => expect(errors().length + asked.length).toBeGreaterThan(1));
      asked.forEach((confirm) => confirm(true));
      await Promise.all([first, second]);

      // One question, one removal.
      expect(confirmIfNeeded).toHaveBeenCalledTimes(1);
      expect(errors().map((e) => e.payload.code)).toEqual(['DUPLICATE']);
      expect(org.deletes.map((d) => d.object)).toEqual(['Contact', 'Account']);
    });
  });

  describe('Production Guard', () => {
    it('refuses with NOT_INITIALIZED, and reads nothing, when no guard was injected', async () => {
      deps.infraServices = undefined;

      await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

      expect(mockGetConn).not.toHaveBeenCalled();
      expect(errors().map((e) => e.payload.code)).toEqual(['NOT_INITIALIZED']);
      expect(trail()).toEqual([
        expect.objectContaining({
          action: 'cleanup_delete',
          module: 'forge',
          outcome: 'stopped',
          details: { code: 'NOT_INITIALIZED' },
        }),
      ]);
    });

    it('refuses a production org, recorded as the guard refused it', async () => {
      vi.mocked(deps.orgManager.getOrg).mockReturnValue({
        orgType: 'Production',
      } as unknown as ReturnType<HandlerDeps['orgManager']['getOrg']>);

      await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

      expect(mockGetConn).not.toHaveBeenCalled();
      expect(errors()).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            code: 'GUARD_BLOCKED',
            message: expect.stringContaining('delete is not allowed on production org'),
          }),
        }),
      ]);
      expect(trail()).toEqual([
        expect.objectContaining({ outcome: 'stopped', guard: 'refused', objects: [] }),
      ]);
    });

    it('deletes nothing when the confirmation is declined', async () => {
      deps.infraServices = {
        productionGuard: {
          check: vi.fn().mockReturnValue({
            allowed: true,
            requiresConfirmation: true,
            requiresApproval: false,
            warnings: [],
            impactSummary: 'DELETE 3 records',
          }),
          confirmIfNeeded: vi.fn().mockResolvedValue(false),
          canAskForConfirmation: true,
        },
      } as unknown as HandlerDeps['infraServices'];

      await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

      expect(mockGetConn).not.toHaveBeenCalled();
      expect(errors().map((e) => e.payload.code)).toEqual(['GUARD_DECLINED']);
      expect(trail()).toEqual([expect.objectContaining({ outcome: 'stopped', guard: 'declined' })]);
    });

    it('asks about a delete of the records the run created, on the org it wrote to', async () => {
      const check = vi.spyOn(ProductionGuard.prototype, 'check');

      await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

      expect(check).toHaveBeenCalledWith({
        orgId: TARGET_ORG,
        orgTier: 'development',
        operation: 'delete',
        objectName: 'Contact, Account',
        recordCount: 3,
        module: 'forge',
      });
      check.mockRestore();
    });
  });

  describe('a run that stopped part way', () => {
    /**
     * `error`, carrying what the executor held when the run stopped: the
     * account and the two contacts it created, and the account it linked.
     */
    function stoppedRun(error: Error): Error {
      const entry = runEntry();
      keepPartialSummary(error, {
        successCount: 3,
        updatedCount: 0,
        linkedCount: 1,
        failedCount: 0,
        skippedCount: 0,
        remapCount: 4,
        errors: [],
        truncatedObjects: [],
        remapTable: entry.idRemapTable ?? {},
        existingRecords: [{ objectApiName: 'Account', linked: 1, unidentified: 0 }],
        existingSourceIds: entry.idRemapExisting ?? [],
        remapByObject: [
          { objectApiName: 'Account', created: 1, linked: 1 },
          { objectApiName: 'Contact', created: 2, linked: 0 },
        ],
        createdByObject: entry.idRemapCreated ?? [],
      });
      return error;
    }

    /** Run a clone that throws `error`, and read back the entry the history kept of it. */
    async function runThatThrows(error: Error): Promise<ForgeExecutionResult | undefined> {
      handler.setForgeOrchestrator({
        execute: vi.fn().mockRejectedValue(error),
        on: vi.fn().mockReturnValue(vi.fn()),
        abort: vi.fn(),
      } as unknown as ForgeOrchestrator);
      store.set('forge:history', [], 'forge');
      await handler.handle(
        buildMsg('forge:execute', {
          graph: { ...GRAPH, nodes: [] },
          config: {
            ...runEntry().config,
            sourceOrgId: 'src-org',
            targetOrgId: TARGET_ORG,
          },
        }),
      );
      return history()[0];
    }

    it('removes what a run that failed part way created, from the entry the history kept', async () => {
      const entry = await runThatThrows(
        stoppedRun(new Error('INVALID_SESSION_ID: Session expired or invalid')),
      );
      expect(entry).toMatchObject({ status: 'failure', targetOrgId: TARGET_ORG });

      await handler.handle(buildMsg('forge:undo', { forgeId: entry?.forgeId }));

      expect(org.deletes).toEqual([
        { object: 'Contact', ids: [id('003', 2), id('003', 1)] },
        { object: 'Account', ids: [id('001', 1)] },
      ]);
      expect(errors()).toEqual([]);
    });

    it('removes what a cancelled run created, from an entry that says it was cancelled', async () => {
      const entry = await runThatThrows(
        stoppedRun(new ForgeAbortedError('Forge execution was aborted by user request.')),
      );
      expect(entry).toMatchObject({ status: 'partial', cancelled: true });

      await handler.handle(buildMsg('forge:undo', { forgeId: entry?.forgeId }));

      expect(org.deletes.flatMap((d) => d.ids)).toEqual([id('003', 2), id('003', 1), id('001', 1)]);
      expect(org.deletes.flatMap((d) => d.ids)).not.toContain(id('001', 9));
    });
  });

  it('answers on the error channel when the org cannot be reached, and records the failure', async () => {
    mockGetConn.mockRejectedValue(new Error(`Org not found: ${TARGET_ORG}`));

    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

    expect(errors().map((e) => e.payload.code)).toEqual(['UNDO_ERROR']);
    expect(trail()[0]).toMatchObject({ outcome: 'failure', guard: 'allowed' });
    expect(history()[0].undo).toBeUndefined();
    expect(tracker.getAll()[0]).toMatchObject({ status: 'failed' });
  });
});
