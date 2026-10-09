import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Connection } from 'jsforce';
import type { ForgeGraph, ForgeGraphNode } from '@sandforge/shared';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('../src/core/connection/ConnectionHelper.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/connection/ConnectionHelper.js')>()),
  refreshTokenViaCli: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { refreshTokenViaCli } from '../src/core/connection/ConnectionHelper.js';
import { buildExecutorDeps, loadSfOrgs, READ_ONLY_RECIPE } from './recipe-forge-grappe.js';
import { ForgeExecutor } from '../src/modules/forge/ForgeExecutor.js';

/** What CLI 2.150 prints where `sf org display` used to print the token. */
const PLACEHOLDER = "[REDACTED] Use 'sf org auth show-access-token' to view";

/** A token of the shape Salesforce takes, and of no org. */
const LIVE_TOKEN = 'live-session-token';

describe('loadSfOrgs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The `sf` CLI as CLI 2.150 answers: `org display` with the placeholder
    // where the token was, and any other command failing.
    vi.mocked(execFileSync).mockImplementation(((_file: string, args: readonly string[]) => {
      if (args.includes('display')) {
        return JSON.stringify({
          result: {
            accessToken: PLACEHOLDER,
            instanceUrl: 'https://example.my.salesforce.com',
            username: 'user@example.com',
          },
        });
      }
      throw new Error('not answered');
    }) as unknown as typeof execFileSync);
    vi.mocked(refreshTokenViaCli).mockResolvedValue({
      accessToken: LIVE_TOKEN,
      instanceUrl: 'https://example.my.salesforce.com',
    });
  });

  it('gives each org the token the CLI session reads, never the placeholder sf org display prints', async () => {
    const orgs = await loadSfOrgs(['SOURCE-UAT', 'TARGET-DEV']);

    expect([...orgs.keys()]).toEqual(['SOURCE-UAT', 'TARGET-DEV']);
    expect([...orgs.values()].map((org) => org.accessToken)).toEqual([LIVE_TOKEN, LIVE_TOKEN]);
    expect(orgs.get('TARGET-DEV')?.username).toBe('user@example.com');
    expect(refreshTokenViaCli).toHaveBeenCalledWith('SOURCE-UAT');
    expect(refreshTokenViaCli).toHaveBeenCalledWith('TARGET-DEV');
  });

  it('stops with the way to sign in again when the CLI has no usable token for an org', async () => {
    vi.mocked(refreshTokenViaCli).mockResolvedValue({ accessToken: PLACEHOLDER });

    await expect(loadSfOrgs(['TARGET-DEV'])).rejects.toThrow(
      /no usable access token for alias 'TARGET-DEV'.*sf org login web --alias TARGET-DEV/,
    );
  });
});

/** A fake id: the object's prefix, then a counter. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const ACCOUNT_ID = fakeId('001', 1);

/** The rows the source answers, by object, as `conn.query` would. */
const SOURCE_ROWS: Record<string, Record<string, unknown>[]> = {
  Account: [{ Id: ACCOUNT_ID, Name: 'Acme' }],
  Contact: [
    { Id: fakeId('003', 1), LastName: 'One', AccountId: ACCOUNT_ID },
    { Id: fakeId('003', 2), LastName: 'Two', AccountId: ACCOUNT_ID },
  ],
};

/** The describe each org answers, as `conn.sobject(name).describe()` would. */
const DESCRIBES: Record<string, { createable: boolean; fields: Record<string, unknown>[] }> = {
  Account: {
    createable: true,
    fields: [
      { name: 'Id', type: 'id', createable: false, nillable: false },
      { name: 'Name', type: 'string', createable: true, nillable: false },
    ],
  },
  Contact: {
    createable: true,
    fields: [
      { name: 'Id', type: 'id', createable: false, nillable: false },
      { name: 'LastName', type: 'string', createable: true, nillable: false },
      {
        name: 'AccountId',
        type: 'reference',
        referenceTo: ['Account'],
        createable: true,
        nillable: true,
      },
    ],
  },
};

/**
 * A jsforce connection that answers reads from the tables above, and whose
 * every write is a spy: the tests assert that none of them is ever reached.
 */
function stubConnection(rows: Record<string, Record<string, unknown>[]>) {
  const writes = { create: vi.fn(), upsert: vi.fn(), update: vi.fn() };
  const conn = {
    query: vi.fn(async (soql: string) => {
      const object = /FROM\s+(\w+)/i.exec(soql)?.[1] ?? '';
      const records = (rows[object] ?? []).map((row) => ({ ...row }));
      return { totalSize: records.length, done: true, records };
    }),
    sobject: vi.fn((name: string) => ({
      describe: vi.fn(async () => DESCRIBES[name] ?? { createable: true, fields: [] }),
      ...writes,
    })),
  };
  return { conn: conn as unknown as Connection, writes };
}

function graphNode(objectApiName: string, level: number, recordCount: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount,
    fieldCount: 3,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 2,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'rest',
  };
}

/** An account and its contacts. */
const GRAPH: ForgeGraph = {
  nodes: [graphNode('Account', 0, 1), graphNode('Contact', 1, 2)],
  edges: [
    {
      sourceObject: 'Account',
      targetObject: 'Contact',
      relationshipName: 'Contacts',
      type: 'lookup',
    },
  ],
  totalRecords: 3,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 0,
};

describe('buildExecutorDeps', () => {
  it('refuses every write the executor could send, and reaches no writer of the org', async () => {
    const target = stubConnection({});
    const deps = buildExecutorDeps(new Map([['TARGET-DEV', target.conn]]), []);
    const rows = [{ Name: 'Acme' }];

    await expect(deps.insertRecords('TARGET-DEV', 'Account', rows)).rejects.toThrow(
      READ_ONLY_RECIPE,
    );
    await expect(
      deps.upsertRecords?.('TARGET-DEV', 'Account', 'External_Id__c', rows),
    ).rejects.toThrow(READ_ONLY_RECIPE);
    await expect(
      deps.updateRecords?.('TARGET-DEV', 'Account', [{ Id: ACCOUNT_ID, Name: 'Acme' }]),
    ).rejects.toThrow(READ_ONLY_RECIPE);

    expect(target.writes.create).not.toHaveBeenCalled();
    expect(target.writes.upsert).not.toHaveBeenCalled();
    expect(target.writes.update).not.toHaveBeenCalled();
  });

  it('reads through the org it is asked, and logs each query with its count', async () => {
    const source = stubConnection(SOURCE_ROWS);
    const queryLog: Parameters<typeof buildExecutorDeps>[1] = [];
    const deps = buildExecutorDeps(new Map([['SOURCE-UAT', source.conn]]), queryLog);

    const read = await deps.queryRecords('SOURCE-UAT', 'SELECT Id, LastName FROM Contact');

    expect(read).toHaveLength(2);
    expect(queryLog).toEqual([expect.objectContaining({ object: 'Contact', count: 2 })]);
    await expect(deps.queryRecords('ELSEWHERE', 'SELECT Id FROM Account')).rejects.toThrow(
      /No connection for ELSEWHERE/,
    );
  });

  it('carries a simulation of the clone through, and writes nothing to the target', async () => {
    const source = stubConnection(SOURCE_ROWS);
    const target = stubConnection({});
    const deps = buildExecutorDeps(
      new Map([
        ['SOURCE-UAT', source.conn],
        ['TARGET-DEV', target.conn],
      ]),
      [],
    );

    const summary = await new ForgeExecutor(deps).execute(
      GRAPH,
      'SOURCE-UAT',
      'TARGET-DEV',
      () => undefined,
      { rootRecordId: ACCOUNT_ID, rootObjectApiName: 'Account', dryRun: true },
    );

    expect(summary.wouldInsertCount).toBe(3);
    expect(summary.successCount).toBe(0);
    expect(target.writes.create).not.toHaveBeenCalled();
    expect(target.writes.upsert).not.toHaveBeenCalled();
    expect(target.writes.update).not.toHaveBeenCalled();
  });
});
