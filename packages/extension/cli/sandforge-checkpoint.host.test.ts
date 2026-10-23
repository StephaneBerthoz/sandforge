import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgCheckpoint } from '@sandforge/shared';

import { createPanelHost, orgFromIdentity } from './panelHost.js';
import type { PanelHost, PanelHostOptions, PanelHostWiring, PanelRequest } from './panelHost.js';
import { main } from './sandforge-checkpoint.js';
import { getJsforceConnection } from '../src/core/connection/ConnectionHelper.js';
import {
  openCheckpointStore,
  type OrgCheckpointStore,
} from '../src/modules/checkpoint/OrgCheckpointStore.js';
import { MemoryRemovalOrg, type MemoryOrgRequest } from '../src/test/memoryRemovalOrg.js';

vi.mock('../src/core/connection/ConnectionHelper.js', async (original) => ({
  ...(await original<typeof import('../src/core/connection/ConnectionHelper.js')>()),
  getJsforceConnection: vi.fn(),
}));

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * The command line of Checkpoint & Rewind run whole, through the extension's
 * own host (`panelHost.ts`): the Checkpoints page's handler answers it, over a
 * store of the test's own, on the memory org the bricks run on. Only what
 * reaches past this machine is stood in for: the `sf` CLI's session and the
 * identity query of a connection (the host's `connect`), and the org itself.
 */

const ORG_ID = '00D000000000001AAA';
const REFRESHED_ORG_ID = '00D000000000009AAA';
const AUTOMATED_PROCESS = '005000000000002AAA';
const COLLEAGUE = '005000000000003AAA';

/** T0 on the org's clock. */
const T0 = Date.parse('2026-10-22T14:05:12.731Z');
const LONG_AGO = Date.parse('2026-10-01T09:00:00.000Z');
let clock = T0;

const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const STAMP_FIELDS = [
  { name: 'Id', type: 'id', permissionable: false },
  { name: 'SystemModstamp', type: 'datetime', permissionable: false },
  { name: 'CreatedDate', type: 'datetime', permissionable: false },
  { name: 'CreatedById', type: 'reference', referenceTo: ['User'], permissionable: false },
  { name: 'LastModifiedDate', type: 'datetime', permissionable: false },
  { name: 'LastModifiedById', type: 'reference', referenceTo: ['User'], permissionable: false },
  { name: 'IsDeleted', type: 'boolean', permissionable: false },
];
const writable = (name: string) => ({
  name,
  type: 'string',
  createable: true,
  updateable: true,
  nillable: true,
});
const FIELDS: Record<string, unknown[]> = {
  Account: [...STAMP_FIELDS, writable('Name')],
  Case: [...STAMP_FIELDS, writable('Subject')],
};

/** The memory org as the handler reaches it: a global describe, `/limits`, its record and its user. */
class CliTestOrg extends MemoryRemovalOrg {
  limits = { Max: 15_000, Remaining: 14_900 };

  constructor(says: { sandbox?: boolean; edition?: string } = {}) {
    super({}, { now: () => clock });
    clock = LONG_AGO;
    for (const [name, fields] of Object.entries(FIELDS)) this.changeSchema(name, fields);
    this.add('Organization', {
      Id: ORG_ID,
      IsSandbox: says.sandbox ?? false,
      OrganizationType: says.edition ?? 'Developer Edition',
    });
    this.add('UserPermissionAccess', {
      Id: '0Up000000000001AAA',
      PermissionsViewAllData: true,
      PermissionsModifyAllData: true,
      PermissionsViewEncryptedData: false,
    });
    this.add('User', { Id: AUTOMATED_PROCESS, UserType: 'AutomatedProcess' });
    this.add('Account', { Id: id('001', 1), Name: 'Northwind' });
    this.add('Account', { Id: id('001', 2), Name: 'Contoso' });
    this.add('Case', { Id: id('500', 1), Subject: 'Broken' });
    clock = T0;
  }

  override async describeGlobal(): Promise<unknown> {
    this.requests++;
    return {
      sobjects: Object.keys(FIELDS).map((name) => ({
        name,
        label: name,
        queryable: true,
        createable: true,
        updateable: true,
        deletable: true,
        layoutable: true,
      })),
    };
  }

  override async request(request: MemoryOrgRequest): Promise<unknown> {
    if (request.method === 'GET' && request.url.endsWith('/limits')) {
      this.requests++;
      return { DailyApiRequests: this.limits };
    }
    return super.request(request);
  }
}

/** The org behind a connection shaped as jsforce's, as every read of the handler and its snapshot takes it. */
function connectionOf(org: CliTestOrg, onQuery: (soql: string) => void) {
  return {
    get version() {
      return org.version;
    },
    request: (request: MemoryOrgRequest) => org.request(request),
    query: (soql: string, options?: { scanAll?: boolean }) => {
      onQuery(soql);
      return org.query(soql, options);
    },
    queryMore: (nextRecordsUrl: string) => org.queryMore(nextRecordsUrl),
    describe: (objectApiName: string) => org.describe(objectApiName),
    describeGlobal: () => org.describeGlobal(),
    tooling: { describeGlobal: () => Promise.resolve({ sobjects: [] }) },
    soap: {
      getServerTimestamp: async () => ({ timestamp: await org.serverTime() }),
      getUserInfo: async () => ({ userId: await org.userId() }),
    },
  };
}

interface Harness {
  org: CliTestOrg;
  /** The store the command keeps its checkpoints in, opened as the test reads it. */
  store: OrgCheckpointStore;
  storeDir: string;
  /** The aliases the command connected, in order: what reached past this machine. */
  connected: string[];
  /** The Organization Id the next connection answers with. */
  answersAs: (organizationId: string) => void;
  /** Called with every statement the org is sent. */
  onQuery: (hook: (soql: string) => void) => void;
  run: (...args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** The checkpoints kept, as the store lists them. */
  kept: () => Promise<string[]>;
}

const dirs: string[] = [];

beforeEach(() => {
  clock = T0;
  process.exitCode = undefined;
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.mocked(getJsforceConnection).mockReset();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function harness(
  options: {
    org?: CliTestOrg;
    production?: boolean;
    /** What a request becomes on its way to the handler: one another window answers first. */
    sending?: (request: PanelRequest) => PanelRequest;
  } = {},
): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-checkpoint-cli-'));
  dirs.push(dir);
  const storeDir = join(dir, 'store');
  const locksDir = join(dir, 'locks');
  const opened = openCheckpointStore({ root: storeDir, locksDir });
  if ('refusal' in opened) throw new Error(`no store: ${opened.refusal.reason}`);
  const org = options.org ?? new CliTestOrg();
  const connected: string[] = [];
  let organizationId = ORG_ID;
  let hook: (soql: string) => void = () => undefined;
  vi.mocked(getJsforceConnection).mockImplementation(
    async () => connectionOf(org, (soql) => hook(soql)) as never,
  );

  // The product's host, but for its `connect`, whose `sf` session and
  // identity query reach past this machine: the org is registered as the
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
      request: (request) => host.request(options.sending?.(request) ?? request),
      connect: async (alias) => {
        connected.push(alias);
        const session = {
          alias,
          username: 'tester@example.com',
          instanceUrl: 'https://example.my.salesforce.com',
          accessToken: 'not-a-token',
        };
        const registered = orgFromIdentity(session, {
          userId: '005000000000001AAA',
          username: session.username,
          displayName: 'Tester',
          orgId: organizationId,
          orgName: 'Example',
          orgType: options.production ? 'Enterprise Edition' : 'Developer Edition',
          isSandbox: false,
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

  const run = async (...args: string[]) => {
    let stdout = '';
    let stderr = '';
    let exited: number | undefined;
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      stdout += chunk;
      return true;
    }) as never);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      stderr += chunk;
      return true;
    }) as never);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exited = code;
      throw new Error(`exit ${code}`);
    }) as never);
    process.exitCode = undefined;
    try {
      await main(['node', 'sandforge-checkpoint.ts', ...args, '--store', storeDir], {
        createHost,
        locksDir,
      });
    } catch (thrown: unknown) {
      if (exited === undefined) throw thrown;
    } finally {
      out.mockRestore();
      err.mockRestore();
      exit.mockRestore();
    }
    const code = exited ?? Number(process.exitCode ?? 0);
    process.exitCode = undefined;
    return { code, stdout, stderr };
  };

  return {
    org,
    store: opened.store,
    storeDir,
    connected,
    answersAs: (next) => {
      organizationId = next;
    },
    onQuery: (next) => {
      hook = next;
    },
    run,
    kept: async () => (await opened.store.list()).map((entry) => entry.checkpointId),
  };
}

/** Take a checkpoint through the command, and give back what it kept. */
async function taken(h: Harness, ...flags: string[]): Promise<OrgCheckpoint> {
  const { code, stdout } = await h.run('take', '--org', 'DEV-SB', '--json', ...flags);
  expect(code).toBe(0);
  return (JSON.parse(stdout) as { checkpoint: OrgCheckpoint }).checkpoint;
}

describe('sandforge-checkpoint take', () => {
  it('takes a checkpoint through the page’s handler, keeps it in the store, and answers with it', async () => {
    const h = harness();

    const { code, stdout, stderr } = await h.run(
      'take',
      '--org',
      'DEV-SB',
      '--name',
      'Before UAT',
      '--json',
    );

    expect(code).toBe(0);
    const { checkpoint } = JSON.parse(stdout) as { checkpoint: OrgCheckpoint };
    expect(checkpoint).toMatchObject({
      name: 'Before UAT',
      status: 'ready',
      org: { organizationId: ORG_ID, alias: 'DEV-SB', tier: 'developer' },
      ignoredFields: [],
    });
    expect(checkpoint.objects.map((object) => object.objectApiName).sort()).toEqual([
      'Account',
      'Case',
    ]);
    expect(await h.kept()).toEqual([checkpoint.checkpointId]);
    // Its progress came as it went, on stderr with --json.
    expect(stderr).toContain('Checking DEV-SB');
    expect(stderr).toContain(
      `taken 'Before UAT' (${checkpoint.checkpointId}) of DEV-SB: 3 records in 2 objects`,
    );
  });

  it('answers with the requests the take sent the org, phase by phase, beside what it estimated before reading a record', async () => {
    const h = harness();

    const { code, stdout, stderr } = await h.run('take', '--org', 'DEV-SB', '--json');

    expect(code).toBe(0);
    const answer = JSON.parse(stdout) as {
      checkpoint: OrgCheckpoint;
      requests: { total: number; byPhase: Record<string, number> };
      estimate: { apiRequests: number; requestsByPhase: Record<string, number> };
    };
    expect(Object.keys(answer).sort()).toEqual(['checkpoint', 'estimate', 'requests']);
    const phases = ['guard', 'scope', 'start', 'counts', 'bin', 'snapshot', 'stability'];
    expect(Object.keys(answer.requests.byPhase)).toEqual(phases);
    expect(Object.keys(answer.estimate.requestsByPhase)).toEqual(phases);
    expect(answer.requests.total).toBe(
      Object.values(answer.requests.byPhase).reduce((total, sent) => total + sent, 0),
    );
    expect(answer.estimate.apiRequests).toBe(
      Object.values(answer.estimate.requestsByPhase).reduce((total, said) => total + said, 0),
    );
    // The composites of counts and of the recycle bin's reads go through the
    // connection's requests, as jsforce's do: one each, as estimated.
    expect(answer.requests.byPhase).toMatchObject({ counts: 1, bin: 1 });
    expect(stderr).toMatch(/ {2}sent \d+ API requests to the org, about \d+ estimated: guard /);
  });

  it('says what a take would hold and cost with --estimate, reading no record and keeping nothing', async () => {
    const h = harness();
    const asked: string[] = [];
    h.onQuery((soql) => asked.push(soql));

    const { code, stdout } = await h.run('take', '--org', 'DEV-SB', '--estimate', '--json');

    expect(code).toBe(0);
    const scope = JSON.parse(stdout) as Record<string, unknown>;
    expect(Object.keys(scope).sort()).toEqual(['estimate', 'leftOut', 'mode', 'objects']);
    expect(scope).toMatchObject({
      mode: 'everything',
      estimate: { records: 3, apiRequestsLeft: 14_900 },
    });
    expect(asked.filter((soql) => /SELECT Id, SystemModstamp/.test(soql))).toEqual([]);
    expect(await h.kept()).toEqual([]);
  });

  it('refuses a production org with the checkpoint guard’s words, exit 1, keeping nothing', async () => {
    const h = harness({
      org: new CliTestOrg({ sandbox: false, edition: 'Enterprise Edition' }),
      production: true,
    });

    const { code, stdout, stderr } = await h.run('take', '--org', 'PROD', '--json');

    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toEqual({
      refusal: {
        code: 'PRODUCTION',
        message: expect.stringContaining(
          'SandForge never takes a checkpoint of, or rewinds, a production org',
        ) as unknown,
      },
    });
    expect(stderr).toContain('production org');
    expect(await h.kept()).toEqual([]);

    // Its estimate is refused alike, exit 1.
    const estimate = await h.run('take', '--org', 'PROD', '--estimate', '--json');
    expect(estimate.code).toBe(1);
    expect((JSON.parse(estimate.stdout) as { refusal: { code: string } }).refusal.code).toBe(
      'PRODUCTION',
    );
  });

  it('refuses a take past --max-total before reading a record, and takes one that leaves out what it is told', async () => {
    const h = harness();

    const past = await h.run('take', '--org', 'DEV-SB', '--max-total', '2', '--json');
    expect(past.code).toBe(1);
    expect(JSON.parse(past.stdout)).toMatchObject({ refusal: { code: 'TOO_MANY_RECORDS' } });
    expect(await h.kept()).toEqual([]);

    const checkpoint = await taken(h, '--max-total', '2', '--exclude-object', 'Case');
    expect(checkpoint.objects.map((object) => object.objectApiName)).toEqual(['Account']);
    expect(checkpoint.scope.leftOut).toContainEqual({
      objectApiName: 'Case',
      reason: 'Left out as asked.',
    });
  });

  it('keeps the fields not to compare it is given, and the days it is kept', async () => {
    const h = harness();

    const checkpoint = await taken(h, '--ignore-field', 'Case.Subject', '--keep-days', '0');

    expect(checkpoint.ignoredFields).toEqual(['Case.Subject']);
    expect(checkpoint.expiresAt).toBeNull();
  });

  it('stops a take at Ctrl-C between two reads, keeps nothing, and exits 130', async () => {
    const h = harness();
    h.onQuery((soql) => {
      if (/^SELECT Id, SystemModstamp, CreatedDate/.test(soql)) process.emit('SIGINT');
    });

    const { code, stdout, stderr } = await h.run('take', '--org', 'DEV-SB', '--json');

    expect(code).toBe(130);
    expect(JSON.parse(stdout)).toMatchObject({ refusal: { code: 'CANCELLED' } });
    expect(stderr).toContain('interrupted: the take stops after the read under way');
    expect(await h.kept()).toEqual([]);
  });
});

describe('sandforge-checkpoint list', () => {
  it('lists the store from this machine alone, with or without --org, and contacts no org', async () => {
    const h = harness();
    const checkpoint = await taken(h, '--name', 'Before UAT');
    const before = { connected: h.connected.length, requests: h.org.requests + h.org.soapCalls };
    const connections = vi.mocked(getJsforceConnection).mock.calls.length;

    const all = await h.run('list', '--json');
    const ofOrg = await h.run('list', '--org', 'DEV-SB', '--json');
    const ofAnother = await h.run('list', '--org', 'OTHER', '--json');
    const said = await h.run('list', '--org', 'DEV-SB');

    expect(all.code).toBe(0);
    const listed = JSON.parse(all.stdout) as Array<Record<string, unknown>>;
    expect(listed).toEqual([
      {
        id: checkpoint.checkpointId,
        name: 'Before UAT',
        org: 'DEV-SB',
        // The folder it is filed under: the org's id in its 18-character form.
        organizationId: h.store.folderOf(ORG_ID, checkpoint.checkpointId).organizationId,
        takenAt: checkpoint.takenAt,
        records: 3,
        bytes: checkpoint.bytes,
        expiresAt: checkpoint.expiresAt,
        expiresSoon: false,
        binReachSince: null,
        valid: true,
      },
    ]);
    expect(JSON.parse(ofOrg.stdout)).toEqual(listed);
    expect(JSON.parse(ofAnother.stdout)).toEqual([]);
    expect(said.stdout).toContain(`${checkpoint.checkpointId}  'Before UAT'  DEV-SB  taken`);
    expect(h.connected.length).toBe(before.connected);
    expect(h.org.requests + h.org.soapCalls).toBe(before.requests);
    expect(vi.mocked(getJsforceConnection).mock.calls.length).toBe(connections);
  });

  it('removes the checkpoints past their date as it starts, naming each', async () => {
    const h = harness();
    const checkpoint = await taken(h, '--name', 'Before UAT');
    await h.store.update(checkpoint.checkpointId, (kept) => ({
      ...kept,
      expiresAt: '2026-10-01T00:00:00.000Z',
    }));

    const { code, stdout } = await h.run('list');

    expect(code).toBe(0);
    expect(stdout).toContain("Removed checkpoint 'Before UAT' of DEV-SB");
    expect(stdout).toContain('No checkpoint is kept in');
    expect(await h.kept()).toEqual([]);
  });
});

describe('sandforge-checkpoint preview', () => {
  it('previews a rewind: the three numbers of what changed since, exit 3 with --fail-on-change', async () => {
    const h = harness();
    const checkpoint = await taken(h, '--name', 'Before UAT');
    // The 60-second demo: one record created, two changed and one deleted.
    clock = T0 + 60_000;
    h.org.edit('Account', id('001', 1), { Name: 'Renamed' }, COLLEAGUE);
    h.org.edit('Account', id('001', 2), { Name: 'Renamed too' }, COLLEAGUE);
    h.org.add('Case', { Id: id('500', 2), Subject: 'New', LastModifiedById: COLLEAGUE });
    await h.org.destroy('Case', [id('500', 1)]);
    clock = T0 + 120_000;

    const failing = await h.run('preview', '--org', 'DEV-SB', '--fail-on-change', '--json');
    const plain = await h.run('preview', '--org', 'DEV-SB', '--checkpoint', 'Before UAT');

    expect(failing.code).toBe(3);
    const answer = JSON.parse(failing.stdout) as Record<string, unknown>;
    expect(answer).toMatchObject({
      checkpoint: {
        id: checkpoint.checkpointId,
        name: 'Before UAT',
        takenAt: checkpoint.takenAt,
        org: 'DEV-SB',
      },
      toDelete: 1,
      toGiveBack: 2,
      toBringBack: 1,
      differs: true,
      diff: { checkpointId: checkpoint.checkpointId },
      estimate: { apiRequestsLeft: 14_900 },
    });
    expect(Object.keys(answer)).toEqual(
      expect.arrayContaining(['checkpoint', 'diff', 'estimate', 'differs']),
    );
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain('  1 to delete · 2 to give back · 1 to bring back');
  });

  it('says there is nothing to rewind in an org as it was, and exits 0 with --fail-on-change', async () => {
    const h = harness();
    await taken(h, '--name', 'Before UAT');
    clock = T0 + 120_000;

    const { code, stdout } = await h.run('preview', '--org', 'DEV-SB', '--fail-on-change');

    expect(code).toBe(0);
    expect(stdout).toContain(
      "DEV-SB is as it was at 'Before UAT' among the objects and fields it holds: nothing to rewind.",
    );
  });

  it('refuses the preview of a checkpoint the org it now answers as was not taken of, reading no record', async () => {
    const h = harness();
    await taken(h, '--name', 'Before UAT');
    h.answersAs(REFRESHED_ORG_ID);
    const sent = h.org.requests + h.org.soapCalls;

    const { code, stdout } = await h.run('preview', '--org', 'DEV-SB', '--json');

    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toEqual({
      refusal: {
        code: 'OTHER_ORG',
        message: expect.stringContaining(
          "DEV-SB answers as another org than the one 'Before UAT' was taken of",
        ) as unknown,
      },
    });
    expect(h.org.requests + h.org.soapCalls).toBe(sent);
  });

  it('refuses, without reaching the org, a checkpoint it does not keep and one of an expired scratch org', async () => {
    const h = harness();
    const checkpoint = await taken(h, '--name', 'Before UAT');
    const connected = h.connected.length;

    const unknown = await h.run('preview', '--org', 'DEV-SB', '--checkpoint', 'nightly', '--json');
    expect(unknown.code).toBe(1);
    expect(JSON.parse(unknown.stdout)).toMatchObject({ refusal: { code: 'NOT_FOUND' } });

    await h.store.update(checkpoint.checkpointId, (kept) => ({
      ...kept,
      org: { ...kept.org, tier: 'scratch', scratchExpiresAt: '2026-10-01' },
    }));
    const expired = await h.run('preview', '--org', 'DEV-SB', '--json');
    expect(expired.code).toBe(1);
    expect(JSON.parse(expired.stdout)).toMatchObject({ refusal: { code: 'SCRATCH_EXPIRED' } });
    expect(h.connected.length).toBe(connected);
  });

  it('asks for the id of a name two checkpoints have, exit 2 and nothing on stdout', async () => {
    const h = harness();
    await taken(h, '--name', 'baseline');
    await taken(h, '--name', 'baseline');

    const { code, stdout, stderr } = await h.run(
      'preview',
      '--org',
      'DEV-SB',
      '--checkpoint',
      'baseline',
      '--json',
    );

    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain("2 checkpoints of DEV-SB are named 'baseline'");
  });
});

describe('sandforge-checkpoint delete', () => {
  it('deletes a checkpoint from this machine on --yes, the org untouched', async () => {
    const h = harness();
    const first = await taken(h, '--name', 'Before UAT');
    const second = await taken(h, '--name', 'Before demo');
    const connected = h.connected.length;
    const sent = h.org.requests + h.org.soapCalls;

    const one = await h.run(
      'delete',
      '--org',
      'DEV-SB',
      '--checkpoint',
      'Before UAT',
      '--yes',
      '--json',
    );
    expect(one.code).toBe(0);
    expect(JSON.parse(one.stdout)).toEqual({ deleted: [first.checkpointId], kept: [] });
    expect(await h.kept()).toEqual([second.checkpointId]);

    const all = await h.run('delete', '--org', 'DEV-SB', '--all', '--yes');
    expect(all.code).toBe(0);
    expect(all.stdout).toContain(`deleted 'Before demo' (${second.checkpointId})`);
    expect(await h.kept()).toEqual([]);
    expect(h.connected.length).toBe(connected);
    expect(h.org.requests + h.org.soapCalls).toBe(sent);
  });

  it('asks before it deletes, and with no terminal to answer stops, exit 2, deleting nothing', async () => {
    const h = harness();
    const checkpoint = await taken(h, '--name', 'Before UAT');

    const { code, stderr } = await h.run('delete', '--org', 'DEV-SB');

    expect(code).toBe(2);
    expect(stderr).toContain(
      `Delete 'Before UAT' (${checkpoint.checkpointId}), taken ${checkpoint.takenAt.slice(0, 10)}`,
    );
    expect(stderr).toContain('DEV-SB can no longer be rewound to it. The org is not touched.');
    expect(stderr).toContain('give --yes');
    expect(await h.kept()).toEqual([checkpoint.checkpointId]);
  });

  it('keeps a checkpoint while a rewind of its org holds the lock, exit 1, and says so', async () => {
    const h = harness();
    const checkpoint = await taken(h, '--name', 'Before UAT');
    const held = h.store.lock(ORG_ID, 'rewind', checkpoint.checkpointId);
    if (!('lock' in held)) throw new Error('lock not taken');
    try {
      const { code, stdout } = await h.run('delete', '--org', 'DEV-SB', '--yes', '--json');
      expect(code).toBe(1);
      expect(JSON.parse(stdout)).toMatchObject({ refusal: { code: 'RUN_WRITING' } });
    } finally {
      held.lock.release();
    }
    expect(await h.kept()).toEqual([checkpoint.checkpointId]);
  });

  it('names a checkpoint the delete did not remove, exit 3 when it removed others', async () => {
    // Another window's rewind takes the lock of the org between the two
    // deletes: the first goes, the second stays.
    const h = harness({
      sending: (request) =>
        request.type === 'checkpoint:delete'
          ? {
              ...request,
              payload: {
                checkpointIds: (request.payload?.checkpointIds as string[]).slice(0, 1),
              },
            }
          : request,
    });
    await taken(h, '--name', 'Before UAT');
    await taken(h, '--name', 'Before demo');
    // Two takes in one second sort by their ids' random ends: the list says which comes first.
    const [first, second] = (await h.store.list()).map((entry) => entry.checkpoint);
    if (!first || !second) throw new Error('two checkpoints not kept');

    const { code, stdout, stderr } = await h.run(
      'delete',
      '--org',
      'DEV-SB',
      '--all',
      '--yes',
      '--json',
    );

    expect(code).toBe(3);
    expect(JSON.parse(stdout)).toEqual({
      deleted: [first.checkpointId],
      kept: [second.checkpointId],
    });
    expect(stderr).toContain(`kept '${second.name}' (${second.checkpointId})`);
    expect(await h.kept()).toEqual([second.checkpointId]);
  });

  it('says there is nothing to delete of an org with no checkpoint, exit 1', async () => {
    const h = harness();

    const { code, stdout } = await h.run('delete', '--org', 'DEV-SB', '--yes', '--json');

    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ refusal: { code: 'NOT_FOUND' } });
  });
});
