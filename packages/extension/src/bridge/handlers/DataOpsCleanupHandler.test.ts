import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseMessage, CleanupScanResult } from '@sandforge/shared';
import { CLEANUP_ACTION_LIMIT } from '@sandforge/shared';

import { DataOpsCleanupHandler } from './DataOpsCleanupHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { inboundRequest } from '../../test/mockFactories.js';
import type { SaveDialogAdapter } from '../../adapters/fs/SaveDialogAdapter.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

/**
 * The Cleanup tab through its handler: a scan counts, an export writes a
 * file, and a delete says what it takes before it takes it.
 */

const accountDescribe = {
  name: 'Account',
  label: 'Account',
  queryable: true,
  deletable: true,
  fields: [
    { name: 'Id', label: 'Account ID', type: 'id', filterable: true },
    {
      name: 'Name',
      label: 'Account Name',
      type: 'string',
      nameField: true,
      groupable: true,
      createable: true,
      updateable: true,
      filterable: true,
      aggregatable: true,
    },
    { name: 'LastModifiedDate', label: 'Last Modified Date', type: 'datetime', filterable: true },
  ],
  childRelationships: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: true }],
};

const stale = ['001000000000001AAA', '001000000000002AAA'];

function accountOrg() {
  const destroy = vi.fn(async (ids: string[]) => ids.map((id) => ({ success: true, id })));
  const query = vi.fn(async (soql: string) => {
    if (soql === 'SELECT COUNT() FROM Account') return { totalSize: 10, records: [] };
    if (soql.startsWith('SELECT COUNT() FROM Account WHERE LastModifiedDate')) {
      return { totalSize: 2, records: [] };
    }
    if (soql.startsWith('SELECT COUNT() FROM Contact')) return { totalSize: 5, records: [] };
    if (soql.includes('GROUP BY Name')) return { totalSize: 0, records: [] };
    if (soql.startsWith('SELECT Id FROM Account')) {
      return { totalSize: 2, records: stale.map((Id) => ({ Id })) };
    }
    if (soql.startsWith('SELECT Id, Name, LastModifiedDate FROM Account WHERE Id IN')) {
      return { totalSize: 2, records: stale.map((Id) => ({ Id, Name: 'Old account' })) };
    }
    throw new Error(`unexpected query: ${soql}`);
  });
  return {
    conn: {
      describe: vi.fn(async () => accountDescribe),
      describeGlobal: vi.fn(async () => ({
        sobjects: [
          {
            name: 'Contact',
            label: 'Contact',
            queryable: true,
            createable: true,
            layoutable: true,
          },
        ],
      })),
      query,
      limitInfo: {},
      sobject: vi.fn(() => ({ destroy })),
    },
    query,
    destroy,
  };
}

function createDeps(orgType = 'Sandbox'): HandlerDeps {
  const configStore = new ConfigStore(new InMemoryConfigStoreBackend());
  configStore.initialize();
  let id = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() },
    orgManager: { getOrg: vi.fn(() => ({ orgType, alias: 'dev' })) },
    orgRegistry: {},
    configStore,
    nextId: () => String(++id),
    infraServices: { productionGuard: new ProductionGuard() },
  } as unknown as HandlerDeps;
}

function request(type: string, payload: Record<string, unknown>, id = `req-${type}`) {
  return inboundRequest({ id, type, timestamp: Date.now(), payload });
}

const deleteStale = (dryRun: boolean) =>
  request('dataops:cleanup:delete', {
    orgId: 'org-1',
    objectApiName: 'Account',
    recommendation: { kind: 'stale', days: 365 },
    dryRun,
  });

describe('DataOpsCleanupHandler', () => {
  let deps: HandlerDeps;
  let save: ReturnType<typeof vi.fn>;
  let handler: DataOpsCleanupHandler;
  let org: ReturnType<typeof accountOrg>;

  beforeEach(() => {
    vi.mocked(getJsforceConnection).mockReset();
    org = accountOrg();
    vi.mocked(getJsforceConnection).mockResolvedValue(org.conn as never);
    deps = createDeps();
    save = vi.fn(async () => ({ status: 'saved', path: '/tmp/cleanup.json' }));
    handler = new DataOpsCleanupHandler(deps, { save } as unknown as SaveDialogAdapter);
  });

  const posted = (): Array<BaseMessage & { payload?: unknown }> =>
    vi.mocked(deps.broker.postToWebview).mock.calls.map((c) => c[0] as BaseMessage);
  const answer = <T>(type: string): T =>
    posted()
      .filter((m) => m.type === type)
      .at(-1)?.payload as T;

  it('answers the scan on its own channel, correlated, with counts only', async () => {
    await handler.handle(
      request(
        'dataops:cleanup:scan',
        { orgId: 'org-1', objects: [{ objectApiName: 'Account' }], staleDays: 365 },
        'req-scan',
      ),
    );

    const [reply] = posted();
    expect(reply).toMatchObject({
      type: 'dataops:cleanup:scan:response',
      correlationId: 'req-scan',
    });
    expect((reply.payload as CleanupScanResult).objects[0]).toMatchObject({
      status: 'scanned',
      totalRecords: 10,
      stale: { days: 365, records: 2 },
    });
    expect(org.conn.sobject).not.toHaveBeenCalled();
  });

  it('says what a delete takes on a dry run — the records, and what goes with them — and deletes nothing', async () => {
    await handler.handle(deleteStale(true));

    expect(answer('dataops:cleanup:delete:response')).toEqual({
      objectApiName: 'Account',
      dryRun: true,
      plan: {
        objectApiName: 'Account',
        label: 'Account',
        records: 2,
        related: [{ objectApiName: 'Contact', label: 'Contact', records: 5 }],
        uncounted: [],
      },
      truncated: false,
    });
    expect(org.destroy).not.toHaveBeenCalled();
  });

  it('deletes through the guard, at most one run’s worth, and records it in the audit trail', async () => {
    await handler.handle(deleteStale(false));

    expect(org.destroy).toHaveBeenCalledWith(stale);
    expect(
      org.query.mock.calls.some(([soql]) => soql.endsWith(`LIMIT ${CLEANUP_ACTION_LIMIT}`)),
    ).toBe(true);
    expect(answer('dataops:cleanup:delete:response')).toMatchObject({
      dryRun: false,
      outcome: { status: 'success', done: 2, failed: 0 },
    });
    expect(new AuditTrailStore(deps.configStore).list().entries[0]).toMatchObject({
      action: 'cleanup_delete',
      outcome: 'success',
      guard: 'allowed',
      objects: [{ objectApiName: 'Account', deleted: 2 }],
    });
  });

  it('deletes nothing on production', async () => {
    deps = createDeps('Production');
    handler = new DataOpsCleanupHandler(deps, { save } as unknown as SaveDialogAdapter);

    await handler.handle(deleteStale(false));

    expect(org.destroy).not.toHaveBeenCalled();
    expect(posted().at(-1)).toMatchObject({
      type: 'dataops:error',
      payload: { message: expect.stringMatching(/^Operation blocked by Production Guard: /) },
    });
    expect(new AuditTrailStore(deps.configStore).list().entries[0]).toMatchObject({
      action: 'cleanup_delete',
      outcome: 'stopped',
      guard: 'refused',
    });
  });

  it('refuses a delete the connected user may not make, before the guard is asked', async () => {
    org.conn.describe.mockResolvedValue({ ...accountDescribe, deletable: false });

    await handler.handle(deleteStale(false));

    expect(org.destroy).not.toHaveBeenCalled();
    expect(posted().at(-1)).toMatchObject({
      type: 'dataops:error',
      payload: { message: 'The connected user may not delete Account records.' },
    });
    expect(new AuditTrailStore(deps.configStore).list().entries).toEqual([]);
  });

  it('writes the records a recommendation names to the file the user picks', async () => {
    await handler.handle(
      request('dataops:cleanup:export', {
        orgId: 'org-1',
        objectApiName: 'Account',
        recommendation: { kind: 'stale', days: 365 },
      }),
    );

    const [name, content] = save.mock.calls[0];
    expect(name).toBe('sandforge-cleanup-Account-stale-365d.json');
    expect(JSON.parse(content)).toMatchObject({ objectApiName: 'Account', recommended: 2 });
    expect(JSON.parse(content).records).toHaveLength(2);
    expect(answer('dataops:cleanup:export:response')).toMatchObject({
      records: 2,
      truncated: false,
      saved: { status: 'saved' },
    });
  });

  it('refuses a recommendation that is not a field name before it reaches the org', async () => {
    await handler.handle(
      request('dataops:cleanup:delete', {
        orgId: 'org-1',
        objectApiName: 'Account',
        recommendation: { kind: 'orphans', fieldApiName: 'ParentId = null OR Id != null' },
        dryRun: false,
      }),
    );

    expect(getJsforceConnection).not.toHaveBeenCalled();
    expect(posted()[0]).toMatchObject({
      type: 'dataops:error',
      payload: { code: 'INVALID_PAYLOAD' },
    });
  });
});
