/**
 * A Sync run from the panel whose read of an object stopped at
 * `sandforge.sync.maxRecordsPerObject`: through the real orchestrator,
 * writer and gate, over a source of three contacts and a sandbox target, the
 * bound lowered to two. What the run says it was, to the page, at the end of
 * its file, in the history and in the audit trail.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BaseMessage,
  SyncConfig,
  SyncExecutionResult,
  SyncObjectConfig,
} from '@sandforge/shared';
import { SyncOpsHandler } from './SyncOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { SyncOrchestrator } from '../../modules/sync/SyncOrchestrator.js';
import type { SyncOrchestratorDeps } from '../../modules/sync/SyncOrchestrator.js';
import { SyncHistoryStore } from '../../modules/sync/SyncHistoryStore.js';
import { SyncExecutionLogger } from '../../modules/sync/SyncExecutionLogger.js';
import {
  nodeSyncRunCreations,
  type SyncRunCreations,
} from '../../modules/sync/SyncRunCreations.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { clearDescribeCache } from '../../core/connection/describeCache.js';
import { answeringDeliverability } from '../../test/deliverabilityOrg.js';

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

/**
 * Two sandboxes, and the setting's bound when one is given: the default
 * (50 000) otherwise.
 */
function createDeps(bound?: number): HandlerDeps {
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
      getSandforgeSetting: (key: string, fallback: unknown) =>
        key === 'sync.maxRecordsPerObject' && bound !== undefined ? bound : fallback,
      syncOrchestrator: (d: SyncOrchestratorDeps) => new SyncOrchestrator(d),
    } as unknown as HandlerDeps['services'],
    nextId: () => `out-${++id}`,
  };
}

/** A target whose automation runs nothing on the objects written. */
const QUIET_TARGET = {
  read: async () => ({
    objectsRead: [],
    objects: [],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 0,
    requests: 0,
  }),
};

const CONTACT_FIELDS = [
  { name: 'Id', type: 'id', createable: false, updateable: false },
  { name: 'LastName', type: 'string', createable: true, updateable: true },
];

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

/**
 * A source of three contacts, answered on one page as an org answers a read
 * under its page size, and a target that creates each record it is sent, or
 * refuses each when `refuse` says so.
 */
function mockOrgs(refuse = false) {
  const rows = Array.from({ length: 3 }, (_, n) => ({
    attributes: { type: 'Contact' },
    Id: fakeId('003', n + 1),
    LastName: `Doe ${n}`,
  }));
  const create = vi.fn(async (batch: unknown[]) =>
    batch.map((_, n) =>
      refuse
        ? {
            success: false,
            errors: [{ statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'No' }],
          }
        : { id: fakeId('003', 900 + n), success: true, errors: [] },
    ),
  );
  vi.mocked(getJsforceConnection).mockImplementation(
    async (orgId: string) =>
      ({
        query: vi.fn(async (soql: string) => {
          if (soql.startsWith('SELECT COUNT()')) {
            return { done: true, totalSize: soql.includes('IsPersonAccount') ? 0 : rows.length };
          }
          if (orgId === 'src-org' && /^SELECT Id, LastName\b.* FROM Contact/.test(soql)) {
            return { done: true, totalSize: rows.length, records: rows };
          }
          return { done: true, totalSize: 0, records: [] };
        }),
        queryMore: vi.fn(),
        describe: vi.fn(async (name: string) => ({
          name,
          fields: name === 'Contact' ? CONTACT_FIELDS : [],
        })),
        sobject: vi.fn(() => ({ create, upsert: vi.fn(), update: vi.fn(), destroy: vi.fn() })),
        request: vi.fn(
          answeringDeliverability('withheld', async () =>
            orgId === 'tgt-org' ? { DataStorageMB: { Max: 500, Remaining: 400 } } : {},
          ).request,
        ),
        limitInfo: undefined,
      }) as never,
  );
  return { create };
}

const CONTACTS: SyncObjectConfig = {
  objectApiName: 'Contact',
  operation: 'insert',
  batchSize: 200,
  fieldMappings: [],
  transformRules: [],
  excludedFields: [],
  addOnFields: [],
  insertOrder: 0,
};

function config(): SyncConfig {
  return {
    id: 'cfg-cut',
    name: 'contacts',
    description: '',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    direction: 'source_to_target',
    mode: 'full',
    objects: [CONTACTS],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
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

describe('a Sync run from the panel whose read of an object the bound cut', () => {
  let dir: string;
  let deps: HandlerDeps;
  let handler: SyncOpsHandler;
  let history: SyncHistoryStore;
  let creations: SyncRunCreations;

  /** The handler over the setting's bound, its history, its run files and a quiet target. */
  function wire(bound?: number): void {
    deps = createDeps(bound);
    handler = new SyncOpsHandler(deps);
    handler.setTargetAutomation(QUIET_TARGET);
    history = new SyncHistoryStore(deps.configStore);
    handler.setHistoryLogger(new SyncExecutionLogger(history));
    creations = nodeSyncRunCreations(dir);
    handler.setRunCreations(creations);
  }

  /** The run from the page, answered once its response is posted. */
  async function run(id: string): Promise<SyncExecutionResult> {
    await handler.handle(
      inboundRequest({
        id,
        type: 'sync:execute',
        timestamp: Date.now(),
        payload: { config: config() },
      } as BaseMessage),
    );
    await vi.waitFor(() => expect(posted(deps, 'sync:execute:response')).toHaveLength(1));
    return posted(deps, 'sync:execute:response')[0]?.payload as unknown as SyncExecutionResult;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    clearDescribeCache();
    dir = mkdtempSync(join(tmpdir(), 'sandforge-sync-read-cut-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('says partial to the page, at the end of its file, in the history and the audit trail, naming the object and the bound', async () => {
    // It wrote the two contacts it read of three and said success: on the
    // page, in its file, in the history and in Live Operations, with a toast
    // that closed itself the only word of the cut.
    wire(2);
    const { create } = mockOrgs();

    const result = await run('run-cut');

    expect(create).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 'partial',
      totalSuccess: 2,
      totalFailed: 0,
      readCap: 2,
      cutAtReadCap: ['Contact'],
    });
    expect(result.cancelled).toBeUndefined();
    expect((await creations.get('run-cut'))?.end?.status).toBe('partial');
    const [entry] = history.list();
    expect(entry?.result).toMatchObject({
      status: 'partial',
      readCap: 2,
      cutAtReadCap: ['Contact'],
    });
    const audit = new AuditTrailStore(deps.configStore).list().entries;
    expect(audit.find((e) => e.operationId === 'run-cut')?.outcome).toBe('partial');
    const completed = posted(deps, 'operation:completed').map((m) => m.payload);
    expect(completed).toContainEqual({ operationId: 'run-cut', result: { status: 'partial' } });
  });

  it('says success and names no cut when the read held every record', async () => {
    wire();
    mockOrgs();

    const result = await run('run-whole');

    expect(result.status).toBe('success');
    expect(result.totalSuccess).toBe(3);
    expect(result.readCap).toBeUndefined();
    expect(result.cutAtReadCap).toBeUndefined();
    expect((await creations.get('run-whole'))?.end?.status).toBe('success');
    expect(history.list()[0]?.result.status).toBe('success');
  });

  it('stays a failure when the target refused every record it read, the cut named beside it', async () => {
    wire(2);
    mockOrgs(true);

    const result = await run('run-refused');

    expect(result).toMatchObject({
      status: 'failure',
      totalFailed: 2,
      cutAtReadCap: ['Contact'],
    });
    expect((await creations.get('run-refused'))?.end?.status).toBe('failure');
  });

  it('resolves partial on a scheduled run, which no page watches', async () => {
    wire(2);
    mockOrgs();

    const result = await handler.executeScheduled(config(), 'schedule');

    expect(result).toMatchObject({ status: 'partial', readCap: 2, cutAtReadCap: ['Contact'] });
    expect(history.list()[0]?.result.status).toBe('partial');
  });
});
