/**
 * The checkpoint script run in this process on an environment world's own
 * memory org: its `main`, whole, through the extension's own host
 * (`panelHost.ts`), as `sandforge-checkpoint.host.test.ts` and the MCP
 * server's host test run it. Its takes, previews, rewinds and undos read and
 * write the records the seed and the clone wrote there, so a reset or a
 * destroy by rewind is held to what the checkpoint script itself does to
 * them — never to a stand-in of it.
 *
 * Only what reaches past this machine is stood in for: the host's `connect`,
 * whose `sf` session and identity query are the world's, and the connection
 * the Checkpoints handler reads the org through, which is the world's org.
 * Its describes are given the stamp fields a checkpoint reads; what it runs
 * as records are written reads as nothing, its Tooling API answering no row;
 * and during a rewind or an undo its clock moves a second at each read, as
 * time passes while one runs.
 *
 * A test file that uses it mocks, beside what the world asks,
 * `../src/core/connection/ConnectionHelper.js` (`getJsforceConnection`).
 */

import { vi } from 'vitest';
import type { Connection } from 'jsforce';
import { createPanelHost, orgFromIdentity } from '../panelHost.js';
import type { PanelHost, PanelHostOptions, PanelHostWiring } from '../panelHost.js';
import { main as checkpointMain } from '../sandforge-checkpoint.js';
import type { CommandRunner } from '../scriptRunner.js';
import { loadOrg, makeConn } from '../sfSession.js';
import { getJsforceConnection } from '../../src/core/connection/ConnectionHelper.js';
import { MEMORY_ORG_USER, type MemoryOrgRequest } from '../../src/test/memoryRemovalOrg.js';
import { runInProcess, type EnvWorld } from './envWorld.js';

/** The fields every object's describe gives, which a checkpoint reads each record's stamps by. */
const STAMP_FIELDS: readonly unknown[] = [
  { name: 'Id', label: 'Id', type: 'id', permissionable: false },
  { name: 'SystemModstamp', label: 'System Modstamp', type: 'datetime', permissionable: false },
  { name: 'CreatedDate', label: 'Created Date', type: 'datetime', permissionable: false },
  {
    name: 'CreatedById',
    label: 'Created By',
    type: 'reference',
    referenceTo: ['User'],
    permissionable: false,
  },
  {
    name: 'LastModifiedDate',
    label: 'Last Modified Date',
    type: 'datetime',
    permissionable: false,
  },
  {
    name: 'LastModifiedById',
    label: 'Last Modified By',
    type: 'reference',
    referenceTo: ['User'],
    permissionable: false,
  },
  { name: 'IsDeleted', label: 'Deleted', type: 'boolean', permissionable: false },
];

/** A field a record's value is written to and given back. */
const writable = (name: string, reference?: string): Record<string, unknown> => ({
  name,
  label: name,
  type: reference !== undefined ? 'reference' : 'string',
  createable: true,
  updateable: true,
  nillable: true,
  ...(reference !== undefined ? { referenceTo: [reference], relationshipName: reference } : {}),
});

/** The objects a checkpoint of the world's org keeps, with the fields it compares: the world's own. */
const CHECKPOINTED: Readonly<Record<string, readonly unknown[]>> = {
  Account: [...STAMP_FIELDS, writable('Name')],
  Contact: [...STAMP_FIELDS, writable('LastName'), writable('AccountId', 'Account')],
  Asset: [...STAMP_FIELDS, writable('Name')],
};

/** What the checkpoint script runs with, beside the world. */
export interface EnvCheckpointWorldOptions {
  /** Where the orgs' locks are: the environment's own, as on a machine. */
  locksDir: string;
  /** What the user the alias connects as holds: both unless a test says otherwise. */
  permissions?: { viewAllData?: boolean; modifyAllData?: boolean };
  /** Called after each run of the checkpoint script: a test moves its fake clock on from it. */
  tick?: () => void;
  /** The users of the org by Id, with their names: who a preview says last changed what. */
  users?: Readonly<Record<string, string>>;
}

/** A page of a query, every record in it. */
const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });

/**
 * A runner of the scripts against the world: `sandforge-checkpoint` in this
 * process on its org, every other script as the world runs it. Each run is
 * listed among the world's calls.
 */
export function runnerWithCheckpoints(
  world: EnvWorld,
  options: EnvCheckpointWorldOptions,
): CommandRunner {
  const org = world.org;
  for (const [name, fields] of Object.entries(CHECKPOINTED)) org.changeSchema(name, [...fields]);
  for (const [id, name] of Object.entries(options.users ?? {})) {
    org.add('User', { Id: id, Name: name });
  }
  let ticking = false;
  /** The world's own connection: what it says of its Organization record and its `/limits`. */
  const worldConn = async (alias: string): Promise<Connection> =>
    makeConn(await loadOrg(alias)) as Connection;
  /**
   * The world's Organization record, with the edition every org gives: the
   * world names one for an org that is not a sandbox alone, and a scratch
   * org's is its definition's, a Developer Edition's here.
   */
  const organizationOf = async (
    alias: string,
  ): Promise<{
    totalSize: number;
    done: boolean;
    records: Array<{ Id?: string; IsSandbox?: boolean; OrganizationType: string }>;
  }> => {
    const said = (
      (await (
        await worldConn(alias)
      ).query('SELECT Id, IsSandbox, OrganizationType FROM Organization LIMIT 1')) as {
        records: Array<{ Id: string; IsSandbox?: boolean; OrganizationType?: string }>;
      }
    ).records[0];
    const record = { ...said, OrganizationType: said?.OrganizationType ?? 'Developer Edition' };
    return { totalSize: 1, done: true, records: [record] };
  };
  const connection = (alias: string) => ({
    get version() {
      return org.version;
    },
    request: async (request: MemoryOrgRequest | string) => {
      const url = typeof request === 'string' ? request : request.url;
      if (url.endsWith('/limits') || url.endsWith('/tooling/composite')) {
        return (await worldConn(alias)).request(request as never);
      }
      return org.request(request as MemoryOrgRequest);
    },
    query: async (soql: string, queryOptions?: { scanAll?: boolean }) => {
      if (/\bFROM Organization\b/.test(soql)) return organizationOf(alias);
      if (/\bFROM UserPermissionAccess\b/.test(soql)) {
        return page([
          {
            Id: '0Up000000000001AAA',
            PermissionsViewAllData: options.permissions?.viewAllData ?? true,
            PermissionsModifyAllData: options.permissions?.modifyAllData ?? true,
            PermissionsViewEncryptedData: false,
          },
        ]);
      }
      // The records of the objects it keeps, and the users who changed them;
      // what the org runs as records are written — its flows, its processes,
      // its duplicate rules — is none.
      if (
        new RegExp(`\\bFROM (${[...Object.keys(CHECKPOINTED), 'User'].join('|')})\\b`).test(soql)
      ) {
        return org.query(soql, queryOptions);
      }
      return page([]);
    },
    queryMore: (nextRecordsUrl: string) => org.queryMore(nextRecordsUrl),
    describe: (objectApiName: string) => org.describe(objectApiName),
    describeGlobal: async () => ({
      sobjects: Object.keys(CHECKPOINTED).map((name) => ({
        name,
        label: name,
        queryable: true,
        createable: true,
        updateable: true,
        deletable: true,
        layoutable: true,
      })),
    }),
    tooling: {
      describeGlobal: async () => ({ sobjects: [] }),
      query: async () => page([]),
      queryMore: async () => page([]),
    },
    sobject: (objectApiName: string) => ({
      update: (records: Array<Record<string, unknown>>) => org.update(objectApiName, records),
      destroy: (ids: string[]) => org.destroy(objectApiName, ids),
    }),
    soap: {
      getServerTimestamp: async () => {
        if (ticking) vi.setSystemTime(Date.now() + 1_000);
        return { timestamp: await org.serverTime() };
      },
      getUserInfo: async () => ({ userId: await org.userId() }),
      undelete: (ids: string[]) => org.undelete(ids),
    },
  });

  // The product's host, but for its `connect`: the org registered as the
  // host's own connect registers it, typed from what it says it is.
  const createHost = (hostOptions: PanelHostOptions): PanelHost => {
    let wiring: PanelHostWiring | undefined;
    const host = createPanelHost({
      ...hostOptions,
      compose: (built) => {
        hostOptions.compose?.(built);
        wiring = built;
      },
    });
    return {
      get posted() {
        return host.posted;
      },
      request: (request) => host.request(request),
      connect: async (alias) => {
        const session = await loadOrg(alias);
        const said = (await organizationOf(alias)).records[0];
        vi.mocked(getJsforceConnection).mockImplementation(
          async () => connection(alias) as unknown as Connection,
        );
        const registered = orgFromIdentity(session, {
          userId: MEMORY_ORG_USER,
          username: session.username,
          displayName: 'Tester',
          orgId: said?.Id ?? world.organizationId,
          orgName: 'Example',
          orgType: said?.OrganizationType ?? '',
          isSandbox: said?.IsSandbox === true,
        });
        if (!wiring) throw new Error('The host built no handlers.');
        await wiring.orgRegistry.saveOrg(registered, {
          loginUrl: session.instanceUrl,
          instanceUrl: session.instanceUrl,
          accessToken: session.accessToken,
          username: session.username,
        });
        return registered;
      },
    };
  };

  return async (script, args, signal) => {
    if (script !== 'sandforge-checkpoint') return world.runner(script, args, signal);
    ticking = args[0] === 'rewind' || args[0] === 'undo';
    try {
      const run = await runInProcess(() =>
        checkpointMain(['node', 'sandforge-checkpoint.ts', ...args], {
          createHost,
          locksDir: options.locksDir,
        }),
      );
      world.calls.push({ script, args: [...args], code: run.code });
      options.tick?.();
      return run;
    } finally {
      ticking = false;
    }
  };
}
