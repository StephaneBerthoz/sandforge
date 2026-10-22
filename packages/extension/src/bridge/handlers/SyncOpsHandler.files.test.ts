/**
 * A saved configuration that copies files, as the Sync page runs and
 * simulates it: through the real orchestrator, writer, file stage and config
 * store, against two mocked connections that answer the requests a run sends.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  BaseMessage,
  SyncConfig,
  SyncExecutionResult,
  SyncSimulationResult,
} from '@sandforge/shared';
import { SyncOpsHandler } from './SyncOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { SyncOrchestrator } from '../../modules/sync/SyncOrchestrator.js';
import type { SyncOrchestratorDeps } from '../../modules/sync/SyncOrchestrator.js';
import { SyncConfigStore } from '../../modules/sync/SyncConfigStore.js';
import { clearDescribeCache } from '../../core/connection/describeCache.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const ACCOUNT = fakeId('001', 1);
const DOCUMENT = fakeId('069', 1);
const VERSION = fakeId('068', 1);
const TARGET_ACCOUNT = fakeId('001', 9);
const TARGET_VERSION = fakeId('068', 9);
const TARGET_DOCUMENT = fakeId('069', 9);
const CONTENT = Buffer.from('hello file').toString('base64');

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

function savedConfig(extra: Partial<SyncConfig> = {}): SyncConfig {
  return {
    id: 'cfg-files',
    name: 'files',
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
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    files: { maxFileSizeMB: 10, maxRunMB: 100 },
    ...extra,
  };
}

const ACCOUNT_FIELDS = [
  { name: 'Id', type: 'id', createable: false, updateable: false },
  { name: 'Name', type: 'string', createable: true, updateable: true },
  { name: 'Ext_Id__c', type: 'string', createable: true, updateable: true },
];

/** The two orgs: what each was asked, and the requests the target took. */
function mockOrgs() {
  const asked: Record<string, string[]> = { 'src-org': [], 'tgt-org': [] };
  const requests: Array<{ orgId: string; method: string; url: string; body?: unknown }> = [];
  vi.mocked(getJsforceConnection).mockImplementation(async (orgId: string) => {
    const source = orgId === 'src-org';
    const query = vi.fn(async (soql: string) => {
      asked[orgId].push(soql);
      // What the run counts before its first write: its one account, no
      // person account among them.
      if (source && soql.startsWith('SELECT COUNT() FROM Account')) {
        return { done: true, totalSize: soql.includes('IsPersonAccount') ? 0 : 1, records: [] };
      }
      if (source && soql.startsWith('SELECT Id, Name, Ext_Id__c FROM Account')) {
        return {
          done: true,
          records: [
            { attributes: { type: 'Account' }, Id: ACCOUNT, Name: 'Acme', Ext_Id__c: 'K-1' },
          ],
        };
      }
      if (source && soql.startsWith('SELECT Id FROM Account')) {
        return { done: true, records: [{ Id: ACCOUNT }] };
      }
      if (source && soql.includes('FROM ContentDocumentLink WHERE LinkedEntityId IN')) {
        return {
          done: true,
          records: [{ ContentDocumentId: DOCUMENT, LinkedEntityId: ACCOUNT, ShareType: 'V' }],
        };
      }
      if (source && soql.includes('FROM ContentVersion WHERE ContentDocumentId IN')) {
        return {
          done: true,
          records: [
            {
              Id: VERSION,
              ContentDocumentId: DOCUMENT,
              Title: 'Report',
              PathOnClient: 'report.txt',
              ContentSize: Buffer.byteLength(CONTENT, 'base64'),
              ContentLocation: 'S',
            },
          ],
        };
      }
      if (!source && soql.startsWith('SELECT ContentDocumentId FROM ContentVersion WHERE Id')) {
        return { done: true, records: [{ ContentDocumentId: TARGET_DOCUMENT }] };
      }
      return { done: true, records: [] };
    });
    const request = vi.fn(async (req: { method: string; url: string; body?: string }) => {
      requests.push({
        orgId,
        method: req.method,
        url: req.url,
        ...(req.body ? { body: JSON.parse(req.body) } : {}),
      });
      if (req.url === '/limits') {
        return {
          FileStorageMB: { Max: 20, Remaining: 20 },
          DataStorageMB: { Max: 5, Remaining: 4 },
        };
      }
      if (req.method === 'GET' && req.url.endsWith('/VersionData')) return CONTENT;
      if (req.method === 'POST') return { id: TARGET_VERSION, success: true, errors: [] };
      throw new Error(`unexpected request ${req.method} ${req.url}`);
    });
    return {
      query,
      queryMore: vi.fn(),
      request,
      describe: vi.fn(async () => ({ fields: ACCOUNT_FIELDS })),
      sobject: vi.fn(() => ({
        upsert: vi.fn(async (batch: unknown[]) =>
          batch.map(() => ({ id: TARGET_ACCOUNT, success: true, errors: [], created: true })),
        ),
        create: vi.fn(async (records: unknown[]) =>
          records.map(() => ({ id: fakeId('06A', 1), success: true, errors: [] })),
        ),
      })),
      limitInfo: undefined,
    } as never;
  });
  return { asked, requests };
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

function posted(deps: HandlerDeps, type: string): Array<BaseMessage & { payload: unknown }> {
  return vi
    .mocked(deps.broker.postToWebview)
    .mock.calls.map(([m]) => m as BaseMessage & { payload: unknown })
    .filter((m) => m.type === type);
}

function send(handler: SyncOpsHandler, type: string, id: string, config: SyncConfig) {
  return handler.handle(
    inboundRequest({ id, type, timestamp: Date.now(), payload: { config } } as BaseMessage),
  );
}

describe('a saved configuration that copies files', () => {
  let deps: HandlerDeps;
  let handler: SyncOpsHandler;
  let store: SyncConfigStore;

  beforeEach(() => {
    vi.clearAllMocks();
    clearDescribeCache();
    deps = createDeps();
    handler = new SyncOpsHandler(deps);
    handler.setTargetAutomation(QUIET_TARGET);
    store = new SyncConfigStore(deps.configStore);
    store.save(savedConfig());
  });

  it("copies a record's file onto its copy in the target, and keeps where it went", async () => {
    const orgs = mockOrgs();

    await send(handler, 'sync:execute', 'run-1', savedConfig());

    const [response] = posted(deps, 'sync:execute:response');
    const result = response.payload as SyncExecutionResult;
    expect(result.status).toBe('success');
    expect(result.objectResults[0].files).toMatchObject({ copied: 1, bytes: 10 });
    // The ids of the records the read returns, asked for alone with the same filter.
    expect(orgs.asked['src-org']).toContain('SELECT Id FROM Account');
    // The target's file storage, then its data storage, read before the first write.
    expect(orgs.requests).toEqual([
      { orgId: 'tgt-org', method: 'GET', url: '/limits' },
      { orgId: 'tgt-org', method: 'GET', url: '/limits' },
      { orgId: 'src-org', method: 'GET', url: `/sobjects/ContentVersion/${VERSION}/VersionData` },
      {
        orgId: 'tgt-org',
        method: 'POST',
        url: '/sobjects/ContentVersion',
        body: {
          Title: 'Report',
          PathOnClient: 'report.txt',
          VersionData: CONTENT,
          FirstPublishLocationId: TARGET_ACCOUNT,
        },
      },
    ]);
    const kept = store.loadFiles('cfg-files');
    expect(kept.kind === 'stored' ? kept.map.entries : []).toEqual([
      expect.objectContaining({
        sourceId: DOCUMENT,
        targetId: TARGET_DOCUMENT,
        sourceVersionId: VERSION,
      }),
    ]);
    expect(deps.log).toHaveBeenCalledWith(
      '[sync] run-1 files: 1 file(s), 10 B copied, 0 skipped past the caps',
    );
  });

  it('simulates the same run: the files and bytes, with nothing read, written or kept', async () => {
    const orgs = mockOrgs();

    await send(handler, 'sync:simulate', 'sim-1', savedConfig());

    const [response] = posted(deps, 'sync:simulate:response');
    const simulation = response.payload as SyncSimulationResult;
    expect(simulation.objects[0].files).toMatchObject({ copied: 1, bytes: 10 });
    expect(simulation.files).toEqual({ remainingBytes: 20 * 1_048_576, plannedBytes: 10 });
    // Its file storage and its data storage, read as the run reads them.
    expect(orgs.requests).toEqual([
      { orgId: 'tgt-org', method: 'GET', url: '/limits' },
      { orgId: 'tgt-org', method: 'GET', url: '/limits' },
    ]);
    expect(store.loadFiles('cfg-files')).toEqual({ kind: 'none' });
  });

  it('refuses the files of a configuration that is not saved, writing nothing', async () => {
    const orgs = mockOrgs();

    await send(handler, 'sync:execute', 'run-unsaved', savedConfig({ id: 'not-saved' }));

    const [error] = posted(deps, 'sync:error') as Array<{ payload: { message: string } }>;
    expect(error.payload.message).toMatch(/^Files are copied by a saved configuration only/);
    expect(orgs.requests).toEqual([]);
  });
});

describe('replacing a changed attachment in the target', () => {
  it('is allowed only where Production Guard would let Sync delete there', async () => {
    const { ProductionGuard } = await import('../../core/precheck/ProductionGuard.js');
    const { targetAllowsDeletes } = await import('../../modules/sync/SyncFiles.js');
    const guard = new ProductionGuard({ requestConfirmation: async () => true });

    // A sandbox: the earlier copy can go once the new one is written.
    expect(targetAllowsDeletes(guard, 'tgt-org', { orgType: 'Sandbox' })).toBe(true);
    // A Developer Edition org, as a sandbox: it holds nobody's business,
    // whether an earlier build registered it as production or not.
    expect(
      targetAllowsDeletes(guard, 'tgt-org', {
        orgType: 'Production',
        metadata: { edition: 'Developer Edition' },
      }),
    ).toBe(true);
    expect(targetAllowsDeletes(guard, 'tgt-org', { orgType: 'Developer' })).toBe(true);
    // A production org: the guard allows no delete there.
    expect(
      targetAllowsDeletes(guard, 'tgt-org', {
        orgType: 'Production',
        metadata: { edition: 'Enterprise Edition' },
      }),
    ).toBe(false);
    expect(targetAllowsDeletes(guard, 'tgt-org', undefined)).toBe(false);
    // No guard to ask: no delete.
    expect(targetAllowsDeletes(undefined, 'tgt-org', { orgType: 'Sandbox' })).toBe(false);
  });
});
