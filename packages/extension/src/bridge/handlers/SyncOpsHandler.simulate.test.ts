import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BaseMessage, SyncSimulationResult } from '@sandforge/shared';
import { SyncOpsHandler } from './SyncOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { SyncOrchestrator } from '../../modules/sync/SyncOrchestrator.js';
import type { SyncOrchestratorDeps } from '../../modules/sync/SyncOrchestrator.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { clearDescribeCache } from '../../core/connection/describeCache.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

/** An in-memory config store, enough for the audit trail and the history. */
function memoryConfigStore(): HandlerDeps['configStore'] {
  const data = new Map<string, { value: unknown; category: string }>();
  return {
    get: (key: string) => data.get(key)?.value,
    set: (key: string, value: unknown, category = 'default') => {
      data.set(key, { value: JSON.parse(JSON.stringify(value)), category });
    },
    delete: (key: string) => data.delete(key),
    has: (key: string) => data.has(key),
    getByCategory: (category: string) =>
      Object.fromEntries(
        [...data].filter(([, e]) => e.category === category).map(([k, e]) => [k, e.value]),
      ),
    getAllKeys: () => [...data.keys()],
    clearCategory: vi.fn(),
    clearAll: vi.fn(),
    initialize: vi.fn(),
  } as unknown as HandlerDeps['configStore'];
}

function createDeps(): HandlerDeps {
  let id = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: {
      getOrg: vi.fn(() => ({ orgType: 'Sandbox' })),
    } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: memoryConfigStore(),
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    infraServices: {
      productionGuard: new ProductionGuard(),
    } as unknown as HandlerDeps['infraServices'],
    services: {
      getSandforgeSetting: (_key: string, fallback: unknown) => fallback,
      syncOrchestrator: (d: SyncOrchestratorDeps) => new SyncOrchestrator(d),
    } as unknown as HandlerDeps['services'],
    nextId: () => `out-${++id}`,
  };
}

/** A config of one Account upsert on an External ID both orgs carry. */
function upsertConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cfg-sim',
    name: 'sim',
    description: '',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    direction: 'source_to_target',
    mode: 'full',
    objects: [
      {
        objectApiName: 'Account',
        operation: 'upsert',
        externalIdField: 'Ext_Id__c',
        batchSize: 200,
        fieldMappings: [],
        transformRules: [],
        excludedFields: [],
        addOnFields: [],
        insertOrder: 0,
      },
    ],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    ...extra,
  };
}

const ACCOUNT_FIELDS = [
  { name: 'Id', type: 'id', createable: false, updateable: false },
  { name: 'Name', type: 'string', createable: true, updateable: true },
  { name: 'Ext_Id__c', type: 'string', createable: true, updateable: true },
];

/** The writes a connection would make: none may happen in a simulation. */
interface Writes {
  create: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

/**
 * Both orgs: the source holds two accounts, the target the first of them by
 * its External ID. Every query each org is asked is recorded.
 */
function mockOrgs(): { queries: Record<string, string[]>; writes: Writes } {
  const queries: Record<string, string[]> = { 'src-org': [], 'tgt-org': [] };
  const writes: Writes = {
    create: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    destroy: vi.fn(),
  };
  vi.mocked(getJsforceConnection).mockImplementation(async (orgId: string) => {
    const query = vi.fn(async (soql: string) => {
      queries[orgId].push(soql);
      if (orgId === 'src-org') {
        return {
          done: true,
          totalSize: 2,
          records: [
            { attributes: { type: 'Account' }, Id: '001S1', Name: 'Acme', Ext_Id__c: 'A-1' },
            { attributes: { type: 'Account' }, Id: '001S2', Name: 'Globex', Ext_Id__c: 'A-2' },
          ],
        };
      }
      return { done: true, totalSize: 1, records: [{ Ext_Id__c: 'A-1' }] };
    });
    return {
      query,
      queryMore: vi.fn(),
      describe: vi.fn(async () => ({ fields: ACCOUNT_FIELDS })),
      sobject: vi.fn(() => writes),
      limitInfo: undefined,
    } as never;
  });
  return { queries, writes };
}

/** Every message the handler posted, of one type. */
function posted(
  deps: HandlerDeps,
  type: string,
): Array<BaseMessage & { payload: Record<string, unknown>; correlationId?: string }> {
  return vi
    .mocked(deps.broker.postToWebview)
    .mock.calls.map(
      ([m]) => m as BaseMessage & { payload: Record<string, unknown>; correlationId?: string },
    )
    .filter((m) => m.type === type);
}

function simulate(handler: SyncOpsHandler, id: string, config: Record<string, unknown>) {
  return handler.handle(
    inboundRequest({
      id,
      type: 'sync:simulate',
      timestamp: Date.now(),
      payload: { config },
    } as BaseMessage),
  );
}

describe('sync:simulate', () => {
  let deps: HandlerDeps;
  let handler: SyncOpsHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    clearDescribeCache();
    deps = createDeps();
    handler = new SyncOpsHandler(deps);
  });

  it('says per object what the run would insert and update, and writes nothing', async () => {
    const { queries, writes } = mockOrgs();

    await simulate(handler, 'sim-1', upsertConfig());

    const [answer] = posted(deps, 'sync:simulate:response');
    expect(answer.correlationId).toBe('sim-1');
    const result = answer.payload as unknown as SyncSimulationResult;
    expect(result.operationId).toBe('sim-1');
    expect(result.objects).toEqual([
      expect.objectContaining({
        objectApiName: 'Account',
        operation: 'upsert',
        read: 2,
        insert: 1,
        update: 1,
        refused: 0,
      }),
    ]);
    // The target was asked for the keys, not written to.
    expect(queries['tgt-org']).toEqual([
      "SELECT Ext_Id__c FROM Account WHERE Ext_Id__c IN ('A-1', 'A-2')",
    ]);
    expect(writes.create).not.toHaveBeenCalled();
    expect(writes.upsert).not.toHaveBeenCalled();
    expect(writes.update).not.toHaveBeenCalled();
    expect(writes.destroy).not.toHaveBeenCalled();
  });

  it('leaves no trace of a write: no audit entry, a completion that says it was simulated', async () => {
    mockOrgs();
    const tracker = new LiveOperationTracker();
    handler.setLiveOperationTracker(tracker);

    await simulate(handler, 'sim-2', upsertConfig());

    expect(new AuditTrailStore(deps.configStore).list().entries).toEqual([]);
    expect(posted(deps, 'operation:completed')).toEqual([
      expect.objectContaining({
        payload: { operationId: 'sim-2', result: { status: 'success', simulated: true } },
      }),
    ]);
    expect(tracker.get('sim-2')?.status).toBe('completed');
    // Listed with a Cancel and no Pause: a simulation has no pause to hold.
    expect(tracker.get('sim-2')?.pausable).toBeUndefined();
    tracker.dispose();
  });

  it('refuses what a run would refuse before reading anything', async () => {
    mockOrgs();

    await simulate(handler, 'sim-3', upsertConfig({ conflictStrategy: 'manual' }));

    const [error] = posted(deps, 'sync:error');
    expect(error.correlationId).toBe('sim-3');
    expect(String(error.payload.message)).toContain('Manual conflict review is not available');
    expect(getJsforceConnection).not.toHaveBeenCalled();
    expect(posted(deps, 'sync:simulate:response')).toEqual([]);
  });

  it('is listed in the registry, where a cancel stops it as aborted', async () => {
    mockOrgs();
    const registry = new BackgroundOperationRegistry();
    handler.setRegistry(registry);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    deps.services = {
      getSandforgeSetting: (_key: string, fallback: unknown) => fallback,
      syncOrchestrator: (d: SyncOrchestratorDeps) => {
        const real = new SyncOrchestrator(d);
        return {
          simulate: async (config: Parameters<SyncOrchestrator['simulate']>[0]) => {
            await held;
            return real.simulate(config);
          },
        };
      },
    } as unknown as HandlerDeps['services'];

    await simulate(handler, 'sim-4', upsertConfig());
    expect(registry.get('sim-4')?.status).toBe('running');

    registry.abort('sim-4');
    release();

    await vi.waitFor(() => expect(posted(deps, 'sync:simulate:response')).toHaveLength(1));
    const result = posted(deps, 'sync:simulate:response')[0]
      .payload as unknown as SyncSimulationResult;
    expect(result.cancelled).toBe(true);
    expect(result.objects).toEqual([]);
    expect(posted(deps, 'operation:completed')).toEqual([
      expect.objectContaining({ payload: { operationId: 'sim-4', result: { aborted: true } } }),
    ]);
  });
});

describe('sync:pause and sync:resume', () => {
  let deps: HandlerDeps;
  let handler: SyncOpsHandler;
  let tracker: LiveOperationTracker;

  beforeEach(() => {
    vi.clearAllMocks();
    clearDescribeCache();
    deps = createDeps();
    handler = new SyncOpsHandler(deps);
    tracker = new LiveOperationTracker();
    handler.setLiveOperationTracker(tracker);
    handler.setRegistry(new BackgroundOperationRegistry());
  });

  afterEach(() => {
    tracker.dispose();
  });

  function control(type: 'sync:pause' | 'sync:resume', id: string, operationId: string) {
    return handler.handle(
      inboundRequest({ id, type, timestamp: Date.now(), payload: { operationId } } as BaseMessage),
    );
  }

  it('hold a running sync and let it go on, through the pause its engine waits on', async () => {
    mockOrgs();
    let gate: SyncOrchestratorDeps['pauseGate'];
    let finish: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    deps.services = {
      getSandforgeSetting: (_key: string, fallback: unknown) => fallback,
      syncOrchestrator: (d: SyncOrchestratorDeps) => {
        gate = d.pauseGate;
        return {
          execute: async () => {
            await finished;
            await d.pauseGate?.whilePaused(d.signal);
            return {
              configId: 'cfg-sim',
              operationId: 'run',
              status: 'success',
              objectResults: [],
              totalProcessed: 0,
              totalSuccess: 0,
              totalFailed: 0,
              totalSkipped: 0,
              duration: 1,
              timestamp: '2026-10-06T00:00:00.000Z',
            };
          },
        };
      },
    } as unknown as HandlerDeps['services'];

    await handler.handle(
      inboundRequest({
        id: 'run-1',
        type: 'sync:execute',
        timestamp: Date.now(),
        payload: { config: upsertConfig() },
      } as BaseMessage),
    );
    await vi.waitFor(() => expect(gate).toBeDefined());
    // Live Operations offers its Pause on the run, which reaches this gate.
    expect(tracker.get('run-1')?.pausable).toBe(true);

    await control('sync:pause', 'pause-1', 'run-1');
    expect(posted(deps, 'sync:pause:response')[0].payload).toEqual({
      success: true,
      operationId: 'run-1',
      paused: true,
    });
    expect(gate?.isPaused).toBe(true);
    expect(tracker.get('run-1')?.status).toBe('paused');

    // Held where the engine waits: no answer while paused.
    finish();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(posted(deps, 'sync:execute:response')).toEqual([]);

    await control('sync:resume', 'resume-1', 'run-1');
    expect(posted(deps, 'sync:resume:response')[0].payload).toEqual({
      success: true,
      operationId: 'run-1',
      paused: false,
    });
    await vi.waitFor(() => expect(posted(deps, 'sync:execute:response')).toHaveLength(1));
    expect(tracker.get('run-1')?.status).toBe('completed');

    // Over, the run has no pause left to set.
    await control('sync:pause', 'pause-2', 'run-1');
    expect(posted(deps, 'sync:pause:response')[1].payload).toMatchObject({
      success: false,
      operationId: 'run-1',
      paused: false,
    });
  });

  it('say so, and do nothing, for a run that is not under way', async () => {
    await control('sync:resume', 'resume-x', 'no-such-run');

    const [answer] = posted(deps, 'sync:resume:response');
    expect(answer.correlationId).toBe('resume-x');
    expect(answer.payload).toMatchObject({ success: false, paused: false });
    expect(String(answer.payload.error)).toContain('No sync with this id is running');
  });

  it('refuse a request that names no run', async () => {
    await handler.handle(
      inboundRequest({
        id: 'pause-bad',
        type: 'sync:pause',
        timestamp: Date.now(),
        payload: {},
      } as BaseMessage),
    );

    expect(posted(deps, 'sync:error')).toHaveLength(1);
    expect(posted(deps, 'sync:pause:response')).toEqual([]);
  });
});
