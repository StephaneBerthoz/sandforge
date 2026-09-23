import { describe, it, expect, vi, beforeEach } from 'vitest';

import { DataOpsHandler } from './DataOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type { BaseMessage, DataQualityScanResult } from '@sandforge/shared';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { inboundRequest } from '../../test/mockFactories.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

/**
 * `dataops:quality-scan` through the handler: the payload is checked, the
 * answer is correlated to the request that asked, and nothing the scan sends
 * can change the org.
 */

function createDeps(): HandlerDeps {
  let idCounter = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() },
    stateSync: {},
    orgManager: { getOrg: vi.fn() },
    orgRegistry: {},
    configStore: {
      get: vi.fn(),
      set: vi.fn(),
      getKeysByPrefix: vi.fn(() => [] as string[]),
    },
    secretVault: {},
    authProvider: {},
    sfdxBridge: {},
    nextId: () => String(++idCounter),
  } as unknown as HandlerDeps;
}

/** A small Contact: 18 records, one repeated email, three untouched for a year. */
function contactOrg() {
  const query = vi.fn(async (soql: string) => {
    if (soql === 'SELECT COUNT() FROM Contact') return { totalSize: 18, records: [] };
    if (soql.startsWith('SELECT COUNT(Email)')) {
      return { totalSize: 1, records: [{ attributes: { type: 'AggregateResult' }, expr0: 17 }] };
    }
    if (soql.includes('GROUP BY Email')) {
      return { totalSize: 1, records: [{ k: 'shared@example.com', n: 2 }] };
    }
    if (soql.includes('LAST_N_DAYS:365')) return { totalSize: 3, records: [] };
    throw new Error(`unexpected query: ${soql}`);
  });
  const describe = vi.fn(async () => ({
    name: 'Contact',
    label: 'Contact',
    queryable: true,
    fields: [
      {
        name: 'Email',
        label: 'Email',
        type: 'email',
        createable: true,
        updateable: true,
        nillable: true,
        defaultedOnCreate: false,
        aggregatable: true,
        groupable: true,
        filterable: true,
      },
      {
        name: 'LastModifiedDate',
        label: 'Last Modified Date',
        type: 'datetime',
        createable: false,
        updateable: false,
        filterable: true,
      },
    ],
  }));
  const writes = { update: vi.fn(), create: vi.fn(), destroy: vi.fn(), upsert: vi.fn() };
  return {
    conn: { describe, query, limitInfo: {}, sobject: vi.fn(() => writes) },
    query,
    writes,
  };
}

const scanRequest = (payload: Record<string, unknown>) =>
  inboundRequest({
    id: 'req-quality-1',
    type: 'dataops:quality-scan',
    timestamp: Date.now(),
    payload,
  });

describe('DataOpsHandler — dataops:quality-scan', () => {
  let deps: HandlerDeps;
  let handler: DataOpsHandler;

  beforeEach(() => {
    vi.mocked(getJsforceConnection).mockReset();
    deps = createDeps();
    handler = new DataOpsHandler(deps);
  });

  const posted = (): Array<BaseMessage & { payload?: unknown }> =>
    vi.mocked(deps.broker.postToWebview).mock.calls.map((c) => c[0] as BaseMessage);

  it('answers the scan on its own channel, correlated to the request that asked', async () => {
    const org = contactOrg();
    vi.mocked(getJsforceConnection).mockResolvedValue(org.conn as never);

    await handler.handle(
      scanRequest({ orgId: 'org-1', objects: [{ objectApiName: 'Contact' }], staleDays: 365 }),
    );

    const [answer] = posted();
    expect(answer.type).toBe('dataops:quality-scan:response');
    expect(answer.correlationId).toBe('req-quality-1');
    const result = answer.payload as DataQualityScanResult;
    expect(result.orgId).toBe('org-1');
    expect(result.objects[0]).toMatchObject({
      status: 'scanned',
      objectApiName: 'Contact',
      totalRecords: 18,
      fields: [{ fieldApiName: 'Email', filled: 17 }],
      duplicates: { keyField: 'Email', groupCount: 1, recordCount: 2 },
      stale: { days: 365, records: 3 },
    });
  });

  it('sends the org describes and counts, and nothing that writes', async () => {
    const org = contactOrg();
    vi.mocked(getJsforceConnection).mockResolvedValue(org.conn as never);

    await handler.handle(
      scanRequest({ orgId: 'org-1', objects: [{ objectApiName: 'Contact' }], staleDays: 365 }),
    );

    expect(org.conn.sobject).not.toHaveBeenCalled();
    expect(org.query.mock.calls.every(([soql]) => /^SELECT .*COUNT\(/.test(soql))).toBe(true);
  });

  it('runs while a backup of the same org holds its lock, since it writes nothing', async () => {
    const org = contactOrg();
    let releaseBackup: () => void = () => {};
    vi.mocked(getJsforceConnection)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseBackup = () =>
              resolve({ ...org.conn, query: vi.fn(async () => ({ records: [] })) } as never);
          }),
      )
      .mockResolvedValue(org.conn as never);

    const backup = handler.handle(
      inboundRequest({
        id: 'req-backup-1',
        type: 'backup:execute',
        timestamp: Date.now(),
        payload: { orgId: 'org-1', objects: ['Contact'] },
      }),
    );
    await handler.handle(
      scanRequest({ orgId: 'org-1', objects: [{ objectApiName: 'Contact' }], staleDays: 365 }),
    );

    expect(posted().map((m) => m.type)).toContain('dataops:quality-scan:response');
    releaseBackup();
    await backup;
  });

  it('refuses a duplicate key that is not an API name before it reaches the org', async () => {
    await handler.handle(
      scanRequest({
        orgId: 'org-1',
        objects: [{ objectApiName: 'Contact', duplicateKey: 'Email) FROM User --' }],
        staleDays: 365,
      }),
    );

    expect(getJsforceConnection).not.toHaveBeenCalled();
    const [refusal] = posted();
    expect(refusal.type).toBe('dataops:error');
    expect(refusal.correlationId).toBe('req-quality-1');
    expect(refusal.payload).toMatchObject({ code: 'INVALID_PAYLOAD' });
  });

  it('answers on dataops:error, correlated, when the org cannot be reached', async () => {
    vi.mocked(getJsforceConnection).mockRejectedValue(new Error('No session for org org-1'));

    await handler.handle(
      scanRequest({ orgId: 'org-1', objects: [{ objectApiName: 'Contact' }], staleDays: 365 }),
    );

    const [failure] = posted();
    expect(failure.type).toBe('dataops:error');
    expect(failure.correlationId).toBe('req-quality-1');
    expect(failure.payload).toMatchObject({ message: 'No session for org org-1' });
  });
});
