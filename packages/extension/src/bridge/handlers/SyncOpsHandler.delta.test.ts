/**
 * Delta runs as the Sync page and a schedule start them: `sync:execute` of a
 * saved configuration, through the real orchestrator, writer and config
 * store, against two mocked connections.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseMessage, SyncConfig, SyncExecutionResult } from '@sandforge/shared';
import { SyncOpsHandler } from './SyncOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { SyncOrchestrator } from '../../modules/sync/SyncOrchestrator.js';
import type { SyncOrchestratorDeps } from '../../modules/sync/SyncOrchestrator.js';
import { SyncConfigStore } from '../../modules/sync/SyncConfigStore.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { clearDescribeCache } from '../../core/connection/describeCache.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

/** An in-memory config store, enough for the configurations, the audit trail and the history. */
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

function createDeps(orgType = 'Sandbox'): HandlerDeps {
  let id = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: {
      getOrg: vi.fn(() => ({ orgType })),
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

/** A saved delta configuration of one Account upsert on an External ID. */
function deltaConfig(extra: Partial<SyncConfig> = {}): SyncConfig {
  return {
    id: 'cfg-delta',
    name: 'delta',
    description: '',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    direction: 'source_to_target',
    mode: 'delta',
    propagateDeletes: true,
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
        where: "Type = 'Customer'",
      },
    ],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...extra,
  };
}

const ACCOUNT_FIELDS = [
  { name: 'Id', type: 'id', createable: false, updateable: false },
  { name: 'Name', type: 'string', createable: true, updateable: true },
  { name: 'Ext_Id__c', type: 'string', createable: true, updateable: true },
  { name: 'Type', type: 'picklist', createable: true, updateable: true },
];

interface SourceRow {
  Id: string;
  Name: string;
  Ext_Id__c: string;
  Type: string;
  SystemModstamp: string;
  IsDeleted?: boolean;
}

/**
 * The two orgs: every query each is asked, with whether it read the recycle
 * bin, and the writes the target took.
 */
function mockOrgs(source: SourceRow[]) {
  const asked: Record<string, Array<{ soql: string; scanAll: boolean }>> = {
    'src-org': [],
    'tgt-org': [],
  };
  const target = new Map<string, Record<string, unknown>>();
  let next = 1;
  const upsert = vi.fn(async (batch: Array<Record<string, unknown>>, field: string) =>
    batch.map((record) => {
      const held = [...target.values()].find((r) => r[field] === record[field]);
      if (held) {
        Object.assign(held, record);
        return { id: held.Id, success: true, errors: [], created: false };
      }
      const id = `001T${next++}`;
      target.set(id, { ...record, Id: id });
      return { id, success: true, errors: [], created: true };
    }),
  );
  const destroy = vi.fn(async (ids: string[]) =>
    ids.map((id) => {
      target.delete(id);
      return { id, success: true, errors: [] };
    }),
  );
  /** The bound a statement reads from, as the records' ISO stamps compare. */
  const boundOf = (soql: string): string | undefined => {
    const bound = /SystemModstamp > (\S+)/.exec(soql)?.[1];
    return bound ? new Date(bound).toISOString() : undefined;
  };
  vi.mocked(getJsforceConnection).mockImplementation(async (orgId: string) => {
    const query = vi.fn(async (soql: string, options?: { scanAll?: boolean }) => {
      const scanAll = options?.scanAll === true;
      asked[orgId].push({ soql, scanAll });
      if (orgId === 'tgt-org') {
        const keys = [...soql.matchAll(/'([^']+)'/g)].map((m) => m[1]);
        return {
          done: true,
          records: [...target.values()].filter((r) => keys.includes(String(r.Ext_Id__c))),
        };
      }
      if (soql.startsWith('SELECT SystemModstamp')) {
        const latest = source
          .filter((r) => !r.IsDeleted)
          .map((r) => r.SystemModstamp)
          .sort()
          .at(-1);
        // As the org writes it.
        return {
          done: true,
          records: latest ? [{ SystemModstamp: latest.replace('Z', '+0000') }] : [],
        };
      }
      const bound = boundOf(soql);
      const rows = source
        .filter((r) => (scanAll ? r.IsDeleted === true : !r.IsDeleted))
        .filter((r) => !bound || r.SystemModstamp > bound)
        .filter((r) => !soql.includes("Type = 'Customer'") || r.Type === 'Customer');
      if (soql.startsWith('SELECT Ext_Id__c FROM Account WHERE Ext_Id__c IN')) {
        const keys = [...soql.matchAll(/'([^']+)'/g)].map((m) => m[1]);
        return {
          done: true,
          records: source.filter((r) => !r.IsDeleted && keys.includes(r.Ext_Id__c)),
        };
      }
      return { done: true, records: rows.map((r) => ({ attributes: { type: 'Account' }, ...r })) };
    });
    return {
      query,
      queryMore: vi.fn(),
      describe: vi.fn(async () => ({ fields: ACCOUNT_FIELDS })),
      sobject: vi.fn(() => ({ upsert, destroy, create: vi.fn(), update: vi.fn() })),
      limitInfo: undefined,
    } as never;
  });
  return { asked, target, upsert, destroy };
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

function run(handler: SyncOpsHandler, id: string, config: SyncConfig): Promise<boolean> {
  return handler.handle(
    inboundRequest({
      id,
      type: 'sync:execute',
      timestamp: Date.now(),
      payload: { config },
    } as BaseMessage),
  );
}

function lastResult(deps: HandlerDeps): SyncExecutionResult {
  return posted(deps, 'sync:execute:response').at(-1)?.payload as unknown as SyncExecutionResult;
}

/** The source: three customers stamped this morning by the org. */
function sourceRows(): SourceRow[] {
  return [
    {
      Id: '001S1',
      Name: 'Acme',
      Ext_Id__c: 'K-1',
      Type: 'Customer',
      SystemModstamp: '2026-10-13T08:00:00.000Z',
    },
    {
      Id: '001S2',
      Name: 'Globex',
      Ext_Id__c: 'K-2',
      Type: 'Customer',
      SystemModstamp: '2026-10-13T08:30:00.000Z',
    },
    {
      Id: '001S3',
      Name: 'Initech',
      Ext_Id__c: 'K-3',
      Type: 'Customer',
      SystemModstamp: '2026-10-13T09:00:00.000Z',
    },
  ];
}

describe('sync:execute of a saved delta configuration', () => {
  let deps: HandlerDeps;
  let handler: SyncOpsHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    clearDescribeCache();
    deps = createDeps();
    handler = new SyncOpsHandler(deps);
    new SyncConfigStore(deps.configStore).save(deltaConfig());
  });

  it('reads whole first, then only what changed since the watermark, and carries the deletion', async () => {
    const source = sourceRows();
    const orgs = mockOrgs(source);

    await run(handler, 'run-1', deltaConfig());

    const first = lastResult(deps);
    expect(first.status).toBe('success');
    expect(first.objectResults[0].delta).toMatchObject({
      read: 'full',
      reason: 'first_run',
      changed: 3,
      recorded: '2026-10-13T09:00:00.000Z',
    });
    // The stamp asked before the read; the read carries the filter alone.
    const firstReads = orgs.asked['src-org'].map((q) => q.soql);
    expect(firstReads[0]).toBe(
      'SELECT SystemModstamp FROM Account ORDER BY SystemModstamp DESC LIMIT 1',
    );
    expect(firstReads[1]).toBe("SELECT FIELDS(ALL) FROM Account WHERE Type = 'Customer'");
    expect(orgs.target.size).toBe(3);

    // Acme renamed, Globex deleted, after the first run.
    source[0].Name = 'Acme Corp';
    source[0].SystemModstamp = '2026-10-13T10:00:00.000Z';
    source[1].IsDeleted = true;
    source[1].SystemModstamp = '2026-10-13T10:05:00.000Z';
    orgs.asked['src-org'] = [];

    await run(handler, 'run-2', deltaConfig());

    const second = lastResult(deps);
    expect(orgs.asked['src-org']).toEqual([
      {
        soql: 'SELECT SystemModstamp FROM Account ORDER BY SystemModstamp DESC LIMIT 1',
        scanAll: false,
      },
      {
        soql: "SELECT FIELDS(ALL) FROM Account WHERE SystemModstamp > 2026-10-13T08:55:00Z AND (Type = 'Customer')",
        scanAll: false,
      },
      {
        soql:
          'SELECT Id, SystemModstamp, Ext_Id__c FROM Account WHERE IsDeleted = true AND ' +
          "(SystemModstamp > 2026-10-13T08:55:00Z AND (Type = 'Customer'))",
        scanAll: true,
      },
      { soql: "SELECT Ext_Id__c FROM Account WHERE Ext_Id__c IN ('K-2')", scanAll: false },
    ]);
    expect(second.objectResults[0]).toMatchObject({ processed: 2, success: 2 });
    expect(second.objectResults[0].delta).toMatchObject({
      read: 'delta',
      since: '2026-10-13T09:00:00.000Z',
      changed: 2,
      deletionsChecked: true,
      deleted: 1,
      recorded: '2026-10-13T10:00:00.000Z',
    });
    expect(orgs.destroy).toHaveBeenCalledTimes(1);
    expect(orgs.target.size).toBe(2);
    expect([...orgs.target.values()].map((r) => r.Name).sort()).toEqual(['Acme Corp', 'Initech']);
    // The audit trail counts the deletion beside the upserts.
    const audit = new AuditTrailStore(deps.configStore).list().entries;
    expect(audit.find((e) => e.operationId === 'run-2')?.objects).toEqual([
      { objectApiName: 'Account', created: 0, updated: 2, deleted: 1, failed: 0 },
    ]);
  });

  it('reads a run of a configuration that is not saved whole, and keeps no watermark for it', async () => {
    const orgs = mockOrgs(sourceRows());

    await run(handler, 'run-unsaved', deltaConfig({ id: 'cfg-wizard' }));

    expect(lastResult(deps).objectResults[0].delta).toMatchObject({
      read: 'full',
      reason: 'not_saved',
    });
    expect(orgs.asked['src-org'].some((q) => q.soql.startsWith('SELECT SystemModstamp'))).toBe(
      false,
    );
    expect(new SyncConfigStore(deps.configStore).loadDelta('cfg-wizard')).toEqual({
      kind: 'none',
    });
  });

  it('a simulation reads from the watermark and records none', async () => {
    const source = sourceRows();
    mockOrgs(source);
    await run(handler, 'run-1', deltaConfig());
    const store = new SyncConfigStore(deps.configStore);
    const stored = JSON.stringify(store.loadDelta('cfg-delta'));
    source[0].SystemModstamp = '2026-10-13T11:00:00.000Z';

    await handler.handle(
      inboundRequest({
        id: 'sim-1',
        type: 'sync:simulate',
        timestamp: Date.now(),
        payload: { config: deltaConfig() },
      } as BaseMessage),
    );

    const [answer] = posted(deps, 'sync:simulate:response');
    expect(answer.payload.objects).toEqual([
      expect.objectContaining({
        read: 2,
        delta: expect.objectContaining({ read: 'delta', since: '2026-10-13T09:00:00.000Z' }),
      }),
    ]);
    expect(JSON.stringify(store.loadDelta('cfg-delta'))).toBe(stored);
  });
});

describe('Production Guard on a delta configuration', () => {
  it('judges a run that carries deletions as the delete it is, and stops it on production', async () => {
    vi.clearAllMocks();
    const deps = createDeps('Production');
    const handler = new SyncOpsHandler(deps);
    mockOrgs(sourceRows());

    await run(handler, 'run-prod', deltaConfig());

    const [error] = posted(deps, 'sync:error');
    expect(String(error.payload.message)).toContain(
      'delete is not allowed on production org tgt-org',
    );
    expect(getJsforceConnection).not.toHaveBeenCalled();
  });

  it('judges a delta run without deletions by what it writes', async () => {
    vi.clearAllMocks();
    const deps = createDeps('Production');
    const handler = new SyncOpsHandler(deps);
    mockOrgs(sourceRows());

    await run(handler, 'run-prod-2', deltaConfig({ propagateDeletes: false }));

    const messages = posted(deps, 'sync:error').map((m) => String(m.payload.message));
    expect(messages.join(' ')).not.toContain('delete is not allowed');
  });
});

describe('the saved configurations and "Run full next time"', () => {
  let deps: HandlerDeps;
  let handler: SyncOpsHandler;
  let store: SyncConfigStore;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createDeps();
    handler = new SyncOpsHandler(deps);
    store = new SyncConfigStore(deps.configStore);
    store.save(deltaConfig());
    store.recordWatermark('cfg-delta', {
      sourceOrgId: 'src-org',
      targetOrgId: 'tgt-org',
      objectApiName: 'Account',
      watermark: '2026-10-13T09:00:00.000Z',
      fingerprint: 'a'.repeat(64),
      recordedAt: '2026-10-13T09:01:00.000Z',
    });
  });

  it('lists each configuration with its mode, its deletions and how many watermarks it holds', async () => {
    store.save({ ...deltaConfig(), id: 'cfg-full', mode: 'full', propagateDeletes: undefined });

    await handler.handle(
      inboundRequest({ id: 'list-1', type: 'sync:config:list', timestamp: Date.now() }),
    );

    const [answer] = posted(deps, 'sync:config:list:response');
    expect(answer.payload.configs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'cfg-delta',
          mode: 'delta',
          propagateDeletes: true,
          watermarks: 1,
        }),
        expect.objectContaining({
          id: 'cfg-full',
          mode: 'full',
          propagateDeletes: false,
          watermarks: 0,
        }),
      ]),
    );
  });

  it('clears the watermarks of a saved configuration and says how many', async () => {
    await handler.handle(
      inboundRequest({
        id: 'reset-1',
        type: 'sync:config:reset-delta',
        timestamp: Date.now(),
        payload: { id: 'cfg-delta' },
      }),
    );

    const [answer] = posted(deps, 'sync:config:reset-delta:response');
    expect(answer.correlationId).toBe('reset-1');
    expect(answer.payload).toEqual({ success: true, id: 'cfg-delta', cleared: 1 });
    expect(store.loadDelta('cfg-delta')).toMatchObject({ state: { entries: [] } });
  });

  it('refuses to reset a configuration that is not saved', async () => {
    await handler.handle(
      inboundRequest({
        id: 'reset-2',
        type: 'sync:config:reset-delta',
        timestamp: Date.now(),
        payload: { id: 'cfg-gone' },
      }),
    );

    expect(posted(deps, 'sync:config:reset-delta:response')).toEqual([]);
    const [error] = posted(deps, 'sync:error');
    expect(error.correlationId).toBe('reset-2');
    expect(String(error.payload.message)).toContain('no longer saved');
  });
});
