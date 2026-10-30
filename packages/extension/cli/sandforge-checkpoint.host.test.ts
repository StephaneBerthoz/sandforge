import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
import { type MemoryOrgRequest, type MemoryRow } from '../src/test/memoryRemovalOrg.js';
import { MemoryRestoreOrg } from '../src/test/memoryRestoreOrg.js';

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
// Labelled as the org describes every field: what a rewind's give-back reads them by.
const writable = (name: string) => ({
  name,
  label: name,
  type: 'string',
  createable: true,
  updateable: true,
  nillable: true,
});
const FIELDS: Record<string, unknown[]> = {
  Account: [...STAMP_FIELDS, writable('Name')],
  Case: [...STAMP_FIELDS, writable('Subject')],
};

/**
 * The memory org as the handler reaches it: a global describe, `/limits`, its
 * record and its user; its updates made, as a rewind's give-back sends them.
 */
class CliTestOrg extends MemoryRestoreOrg {
  limits = { Max: 15_000, Remaining: 14_900 };
  /** Whether each read of its clock moves it a second, as time passes during a rewind. */
  ticking = false;
  /** Told of each update, once it is made. */
  afterUpdate?: (objectApiName: string) => void;

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

  override async serverTime(): Promise<string> {
    if (this.ticking) clock += 1_000;
    return super.serverTime();
  }

  override async update(
    objectApiName: string,
    records: Array<Record<string, unknown>>,
  ): Promise<unknown> {
    const answer = await super.update(objectApiName, records);
    this.afterUpdate?.(objectApiName);
    return answer;
  }
}

/**
 * The org behind a connection shaped as jsforce's, as every read of the
 * handler and its snapshot takes it, and as a rewind and an undo write
 * through it: updates and deletes by object, undeletes by SOAP. Its Tooling
 * API answers nothing: what the org runs as a rewind writes cannot be read.
 */
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
    sobject: (objectApiName: string) => ({
      update: (records: Array<Record<string, unknown>>) => org.update(objectApiName, records),
      destroy: (ids: string[]) => org.destroy(objectApiName, ids),
    }),
    soap: {
      getServerTimestamp: async () => ({ timestamp: await org.serverTime() }),
      getUserInfo: async () => ({ userId: await org.userId() }),
      undelete: (ids: string[]) => org.undelete(ids),
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
  /** The command run over another store: a teammate's machine. */
  runIn: (
    storeDir: string,
    ...args: string[]
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
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

  const runIn = async (store: string, ...args: string[]) => {
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
      await main(['node', 'sandforge-checkpoint.ts', ...args, '--store', store], {
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
  const run = (...args: string[]) => runIn(storeDir, ...args);

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
    runIn,
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
    expect(stderr).toContain(
      "  it holds the records' values unencrypted, in files only you can read: ",
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
    // connection's requests, as jsforce's do: one of counts, one of what the
    // next phases read of the objects holding records, and one of the bin's
    // reads, as estimated.
    expect(answer.requests.byPhase).toMatchObject({ counts: 2, bin: 1 });
    expect(answer.estimate.requestsByPhase).toMatchObject({ counts: 2, bin: 1 });
    expect(stderr).toMatch(/ {2}sent \d+ API requests to the org, about \d+ estimated: guard /);
  });

  it('says what a take would hold and cost with --estimate, reading no record and keeping nothing', async () => {
    const h = harness();
    const asked: string[] = [];
    h.onQuery((soql) => asked.push(soql));

    const { code, stdout } = await h.run('take', '--org', 'DEV-SB', '--estimate', '--json');

    expect(code).toBe(0);
    const scope = JSON.parse(stdout) as Record<string, unknown>;
    expect(Object.keys(scope).sort()).toEqual([
      'customSettings',
      'estimate',
      'files',
      'leftOut',
      'mode',
      'objects',
    ]);
    expect(scope).toMatchObject({
      mode: 'everything',
      estimate: { records: 3, apiRequestsLeft: 14_900 },
    });
    // The custom settings to pick from: the memory org lists none.
    expect(scope.customSettings).toEqual([]);
    // What it would hold of the org's files, as the handler answers it: the
    // memory org has no file, and its user no Query All Files.
    expect(scope.files).toEqual({ held: false, queryAllFiles: false, addedToPicked: [] });
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

  it('prints the refusal alone of an estimate refused before its scope is read, and no estimate in its JSON', async () => {
    // Run as a Standard User, the estimate printed "would keep 0 objects …
    // about 0 API requests of the 0 left today" above its refusal.
    const org = new CliTestOrg();
    org.add('UserPermissionAccess', {
      Id: '0Up000000000001AAA',
      PermissionsViewAllData: false,
      PermissionsModifyAllData: false,
      PermissionsViewEncryptedData: false,
    });
    const h = harness({ org });

    const said = await h.run('take', '--org', 'DEV-SB', '--estimate');
    expect(said.code).toBe(1);
    expect(said.stdout.trim().split('\n')).toEqual([
      expect.stringMatching(
        /^refused: A checkpoint needs a user with View All Data and Modify All Data/,
      ),
    ]);

    const json = await h.run('take', '--org', 'DEV-SB', '--estimate', '--json');
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual({
      mode: 'everything',
      refusal: { code: 'PERMISSIONS', message: expect.any(String) as unknown },
    });
    expect(await h.kept()).toEqual([]);
  });

  it('keeps the estimate of a take refused once its scope is counted, which the refusal is about', async () => {
    const h = harness();

    const said = await h.run('take', '--org', 'DEV-SB', '--estimate', '--max-total', '2');

    expect(said.code).toBe(1);
    expect(said.stdout).toMatch(/would keep 2 objects .*about 3 records/);
    expect(said.stdout).toMatch(/about \d+ API requests of the 14,?900 left today/);
    expect(said.stdout).toContain('refused: The objects this checkpoint would keep hold 3 records');
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

// ─── rewind and undo ─────────────────────────────────────────────────────────

/** What the org holds of what the tests compare, live and in the bin: no stamp. */
function stateOf(org: CliTestOrg): Record<string, unknown> {
  const of = (rows: MemoryRow[]) =>
    rows
      .map((row) => ({ Id: row.Id, Name: row.Name ?? null, Subject: row.Subject ?? null }))
      .sort((a, b) => String(a.Id).localeCompare(String(b.Id)));
  return {
    live: { Account: of(org.all('Account')), Case: of(org.all('Case')) },
    bin: { Account: of(org.inBin('Account')), Case: of(org.inBin('Case')) },
  };
}

/** The 60-second demo: one record created, two changed and one deleted, by a colleague. */
function demo(h: Harness): void {
  clock = T0 + 60_000;
  h.org.edit('Account', id('001', 1), { Name: 'Renamed' }, COLLEAGUE);
  h.org.edit('Account', id('001', 2), { Name: 'Renamed too' }, COLLEAGUE);
  h.org.add('Case', { Id: id('500', 2), Subject: 'New', LastModifiedById: COLLEAGUE });
  h.org.trash('Case', id('500', 1), COLLEAGUE);
  clock = T0 + 120_000;
  h.org.ticking = true;
}

/** The rewinds' journals kept of a checkpoint. */
function journalsOf(h: Harness, checkpoint: OrgCheckpoint): string[] {
  const dir = h.store.folderOf(ORG_ID, checkpoint.checkpointId).rewindsDir;
  return existsSync(dir) ? readdirSync(dir) : [];
}

/** The rewind's answer with --json. */
interface RewindJson {
  rewindId: string;
  status: string;
  deleted: { planned: number; done: number; left: number };
  givenBack: { planned: number; done: number; left: number };
  broughtBack: { planned: number; done: number; left: number };
  verify: { differences: number; stable: boolean; passes: number; notCompared: string[] };
  residual: Array<{ object: string; reason: string; by?: string; count: number }>;
  undo?: { until: string; cannot: unknown[] };
  apiRequests: { used: number; leftToday: number };
}

describe('sandforge-checkpoint rewind', () => {
  it('rewinds the org to a named checkpoint with --yes, from the preview it shows: exit 0, the org as the checkpoint holds it, its undo offered', async () => {
    const h = harness();
    const checkpoint = await taken(h, '--name', 'Before UAT');
    const atCheckpoint = stateOf(h.org);
    demo(h);

    const { code, stdout, stderr } = await h.run(
      'rewind',
      '--org',
      'DEV-SB',
      '--checkpoint',
      'Before UAT',
      '--yes',
      '--accept-automation',
      '--json',
    );

    expect(code, stderr).toBe(0);
    expect(stateOf(h.org).live).toEqual(atCheckpoint.live);
    const answer = JSON.parse(stdout) as RewindJson & Record<string, unknown>;
    expect(answer).toMatchObject({
      checkpoint: { id: checkpoint.checkpointId, name: 'Before UAT', org: 'DEV-SB' },
      status: 'success',
      deleted: { done: 1, left: 0 },
      // What the preview counted to give back: the record it brought back,
      // given its checkpoint values as it came back, is counted brought back.
      givenBack: { done: 2, left: 0 },
      broughtBack: { done: 1, left: 0 },
      cannotUndo: [],
      verify: { differences: 0, stable: true, notCompared: [] },
      residual: [],
      unread: [],
    });
    expect(answer.undo?.until).toEqual(expect.any(String));
    expect(Object.keys(answer)).toEqual(
      expect.arrayContaining(['objects', 'apiRequests', 'result', 'rewindId']),
    );
    expect(stderr).toContain('  1 to delete · 2 to give back · 1 to bring back');
    expect(stderr).toContain('  gave 2 record(s) back their checkpoint values\n');
    expect(stderr).toContain(
      "DEV-SB is back at 'Before UAT': read again, nothing differs among the objects and fields it holds.",
    );
    expect(stderr).toContain(`undo --org DEV-SB --checkpoint ${checkpoint.checkpointId}`);
    const listed = JSON.parse((await h.run('list', '--org', 'DEV-SB', '--json')).stdout) as Array<{
      lastRewind?: { rewindId: string; undoable: boolean };
    }>;
    expect(listed[0]?.lastRewind).toMatchObject({ rewindId: answer.rewindId, undoable: true });
  });

  it('asks, with no terminal to answer, stops at its question, exit 2, having written nothing', async () => {
    const h = harness();
    const checkpoint = await taken(h, '--name', 'Before UAT');
    demo(h);
    const before = stateOf(h.org);

    const { code, stderr } = await h.run('rewind', '--org', 'DEV-SB', '--accept-automation');

    expect(code).toBe(2);
    expect(stderr).toContain("Rewind DEV-SB to 'Before UAT': it deletes the 1 record(s) created");
    expect(stderr).toContain('Type DEV-SB to rewind it:');
    expect(stderr).toContain('give --yes');
    expect(stateOf(h.org)).toEqual(before);
    expect(h.org.updates).toEqual([]);
    expect(journalsOf(h, checkpoint)).toEqual([]);
  });

  it('refuses --yes without a checkpoint named, exit 2, before the org is reached', async () => {
    const h = harness();
    await taken(h, '--name', 'Before UAT');
    const connected = h.connected.length;

    for (const line of [
      ['rewind', '--org', 'DEV-SB', '--yes'],
      ['rewind', '--org', 'DEV-SB', '--checkpoint', 'latest', '--yes'],
      ['undo', '--org', 'DEV-SB', '--yes'],
    ]) {
      const { code, stdout, stderr } = await h.run(...line);
      expect(code, line.join(' ')).toBe(2);
      expect(stdout).toBe('');
      expect(stderr).toContain('--yes needs');
    }
    expect(h.connected.length).toBe(connected);
  });

  it('refuses, before its question, a rewind whose writes fire automation the org will not say, without --accept-automation: exit 1, nothing written', async () => {
    const h = harness();
    const checkpoint = await taken(h, '--name', 'Before UAT');
    demo(h);
    const before = stateOf(h.org);

    const { code, stdout } = await h.run(
      'rewind',
      '--org',
      'DEV-SB',
      '--checkpoint',
      'Before UAT',
      '--json',
    );

    expect(code).toBe(1);
    // The flows the org would not give are among what sends emails: the
    // preview said them not counted, and so does the refusal.
    const answered = JSON.parse(stdout) as { refusal: { code: string; message: string } };
    expect(answered.refusal.code).toBe('AUTOMATION');
    expect(answered.refusal.message).toMatch(
      /^DEV-SB: what runs as the rewind writes could not all be read, so automation may run\. The emails it sends as the rewind writes were not counted against its daily limits, as what sends them was not read \(the org's workflow rules: .*; the org's flows: .*\)\. Rewind refused; give --accept-automation to rewind all the same\. No record was written\.$/,
    );
    expect(stateOf(h.org)).toEqual(before);
    expect(journalsOf(h, checkpoint)).toEqual([]);
  });

  it('previews with --dry-run and stops: exit 0, nothing written, the preview’s JSON', async () => {
    const h = harness();
    await taken(h, '--name', 'Before UAT');
    demo(h);
    const before = stateOf(h.org);

    const { code, stdout, stderr } = await h.run(
      'rewind',
      '--org',
      'DEV-SB',
      '--dry-run',
      '--json',
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      toDelete: 1,
      toGiveBack: 2,
      toBringBack: 1,
      differs: true,
    });
    // What a rewind now would meet, said beside the preview.
    expect(stderr).toContain(
      'a rewind now would be refused: DEV-SB: what runs as the rewind writes',
    );
    expect(stateOf(h.org)).toEqual(before);
  });

  it('stops comparing a field with --ignore-field from now on, kept in the checkpoint: a difference only there leaves nothing to rewind', async () => {
    const h = harness();
    const checkpoint = await taken(h, '--name', 'Before UAT');
    clock = T0 + 60_000;
    h.org.edit('Case', id('500', 1), { Subject: 'Touched by a flow' }, COLLEAGUE);
    clock = T0 + 120_000;

    const { code, stdout } = await h.run(
      'rewind',
      '--org',
      'DEV-SB',
      '--ignore-field',
      'Case.Subject',
      '--dry-run',
    );

    expect(code).toBe(0);
    expect(stdout).toContain(
      "not compared from now on, nor written back: Case.Subject (kept in 'Before UAT')",
    );
    expect(stdout).toContain('nothing to rewind');
    expect((await h.store.read(checkpoint.checkpointId))?.checkpoint?.ignoredFields).toEqual([
      'Case.Subject',
    ]);
  });

  it('exits 3 when records still differ once it read the org again, each said with why', async () => {
    const h = harness();
    await taken(h, '--name', 'Before UAT');
    demo(h);
    h.org.refuseUpdate.set(id('001', 2), {
      statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
      message: 'Name must say who owns it',
    });

    const { code, stdout, stderr } = await h.run(
      'rewind',
      '--org',
      'DEV-SB',
      '--checkpoint',
      'Before UAT',
      '--yes',
      '--accept-automation',
      '--json',
    );

    expect(code).toBe(3);
    const answer = JSON.parse(stdout) as RewindJson;
    expect(answer.status).toBe('partial');
    expect(answer.residual).toContainEqual(
      expect.objectContaining({ object: 'Account', reason: 'refused', count: 1 }),
    );
    expect(stderr).toContain(
      "DEV-SB is back at 'Before UAT' but for 1 record(s) that still differ",
    );
    expect(stderr).toMatch(/ {2}Account 1 — refused: .*Name must say who owns it/);
  });

  it('exits 4 when someone else changed a record during the rewind, left as they made it', async () => {
    const h = harness();
    await taken(h, '--name', 'Before UAT');
    demo(h);
    h.org.afterUpdate = (objectApiName) => {
      if (objectApiName !== 'Account') return;
      h.org.afterUpdate = undefined;
      h.org.edit('Account', id('001', 1), { Name: 'Changed during the rewind' }, COLLEAGUE);
    };

    const { code, stdout, stderr } = await h.run(
      'rewind',
      '--org',
      'DEV-SB',
      '--checkpoint',
      'Before UAT',
      '--yes',
      '--accept-automation',
      '--json',
    );

    expect(code).toBe(4);
    const answer = JSON.parse(stdout) as RewindJson;
    expect(answer).toMatchObject({ status: 'unstable', verify: { stable: false } });
    expect(answer.residual).toContainEqual(
      expect.objectContaining({ object: 'Account', reason: 'changedDuringRewind', by: COLLEAGUE }),
    );
    expect(stderr).toContain('Someone kept writing to DEV-SB during the rewind');
    expect(h.org.all('Account').find((row) => row.Id === id('001', 1))?.Name).toBe(
      'Changed during the rewind',
    );
  });

  it('stops at Ctrl-C before its next call to the org, exit 130, leaving its journal; rewind again takes it up and finishes', async () => {
    const h = harness();
    const checkpoint = await taken(h, '--name', 'Before UAT');
    const atCheckpoint = stateOf(h.org);
    demo(h);
    h.org.beforeDelete = () => {
      h.org.beforeDelete = undefined;
      process.emit('SIGINT');
    };

    const stopped = await h.run(
      'rewind',
      '--org',
      'DEV-SB',
      '--checkpoint',
      'Before UAT',
      '--yes',
      '--accept-automation',
      '--json',
    );

    expect(stopped.code).toBe(130);
    expect(stopped.stderr).toContain(
      'interrupted: the rewind stops before its next call to the org',
    );
    const first = JSON.parse(stopped.stdout) as RewindJson;
    expect(first.status).toBe('cancelled');
    expect(stopped.stderr).toContain("Stopped part way: DEV-SB is between 'Before UAT' and now.");
    expect(journalsOf(h, checkpoint)).toEqual([first.rewindId]);
    expect((await h.store.read(checkpoint.checkpointId))?.checkpoint?.lastRewind).toMatchObject({
      rewindId: first.rewindId,
    });
    expect(
      (await h.store.read(checkpoint.checkpointId))?.checkpoint?.lastRewind?.endedAt,
    ).toBeUndefined();

    const again = await h.run(
      'rewind',
      '--org',
      'DEV-SB',
      '--checkpoint',
      'Before UAT',
      '--yes',
      '--accept-automation',
      '--json',
    );

    expect(again.code, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ status: 'success', rewindId: first.rewindId });
    expect(stateOf(h.org).live).toEqual(atCheckpoint.live);
  });

  it('refuses a production org with the guard’s words, exit 1, writing nothing', async () => {
    const options: { production?: boolean } = {};
    const h = harness(options);
    await taken(h, '--name', 'Before UAT');
    demo(h);
    h.org.edit('Organization', ORG_ID, { OrganizationType: 'Enterprise Edition' });
    options.production = true;
    const before = stateOf(h.org);

    const { code, stdout } = await h.run(
      'rewind',
      '--org',
      'DEV-SB',
      '--checkpoint',
      'Before UAT',
      '--yes',
      '--accept-automation',
      '--json',
    );

    expect(code).toBe(1);
    expect((JSON.parse(stdout) as { refusal: { code: string } }).refusal.code).toBe('PRODUCTION');
    expect(stateOf(h.org)).toEqual(before);
    expect(h.org.updates).toEqual([]);
  });
});

describe('sandforge-checkpoint, a rewind of some objects', () => {
  it('previews a rewind of the objects named: their numbers, the plan of what it does and leaves, exit 3 with --fail-on-change only when they differ', async () => {
    const h = harness();
    await taken(h, '--name', 'Before UAT');
    demo(h);

    const cases = await h.run(
      'preview',
      '--org',
      'DEV-SB',
      '--object',
      'case',
      '--fail-on-change',
      '--json',
    );

    expect(cases.code).toBe(3);
    const answer = JSON.parse(cases.stdout) as Record<string, unknown>;
    expect(answer).toMatchObject({
      objects: ['Case'],
      toDelete: 1,
      toGiveBack: 0,
      toBringBack: 1,
      differs: true,
      selection: {
        objects: ['Case'],
        acts: [{ objectApiName: 'Case', picked: true, toDelete: 1, toBringBack: 1 }],
        left: [],
        needs: [],
      },
    });
    // The diff whole: the accounts renamed are in it, not in the numbers.
    const diff = answer.diff as { objects: Array<{ objectApiName: string }> };
    expect(diff.objects.map((o) => o.objectApiName).sort()).toEqual(['Account', 'Case']);
    expect(cases.stderr).toContain('  1 to delete · 0 to give back · 1 to bring back');
    expect(cases.stderr).toContain('  limited to Case: the other objects are left as they are');
  });

  it('refuses an --object the checkpoint does not hold, exit 2 and nothing on stdout, before the org is reached', async () => {
    const h = harness();
    await taken(h, '--name', 'Before UAT');
    const connected = h.connected.length;

    const preview = await h.run('preview', '--org', 'DEV-SB', '--object', 'Lead', '--json');
    const rewind = await h.run(
      'rewind',
      '--org',
      'DEV-SB',
      '--checkpoint',
      'Before UAT',
      '--object',
      'Lead',
      '--yes',
    );
    const line = await h.run('preview', '--org', 'DEV-SB', '--object', 'Lead;Case');

    expect(preview).toMatchObject({ code: 2, stdout: '' });
    expect(preview.stderr).toContain("--object: 'Before UAT' holds no Lead.");
    expect(rewind.code).toBe(2);
    expect(line.code).toBe(2);
    expect(line.stderr).toContain('--object takes an object\'s API name, not "Lead;Case".');
    expect(h.connected).toHaveLength(connected);
  });

  it('rewinds the objects named alone: exit 0 once they match, the JSON naming what still differs in the others, the ledger the objects it was limited to', async () => {
    const h = harness();
    const checkpoint = await taken(h, '--name', 'Before UAT');
    const atCheckpoint = stateOf(h.org) as { live: { Account: unknown[]; Case: unknown[] } };
    demo(h);

    const { code, stdout, stderr } = await h.run(
      'rewind',
      '--org',
      'DEV-SB',
      '--checkpoint',
      'Before UAT',
      '--object',
      'Case',
      '--yes',
      '--accept-automation',
      '--json',
    );

    expect(code, stderr).toBe(0);
    const now = stateOf(h.org) as { live: { Account: unknown[]; Case: unknown[] } };
    expect(now.live.Case).toEqual(atCheckpoint.live.Case);
    expect(now.live.Account).not.toEqual(atCheckpoint.live.Account);
    const answer = JSON.parse(stdout) as RewindJson & Record<string, unknown>;
    expect(answer).toMatchObject({
      status: 'success',
      limitedTo: ['Case'],
      notRewound: { objects: ['Account'], records: 2 },
      deleted: { done: 1 },
      broughtBack: { done: 1 },
      residual: [],
    });
    expect(stderr).toContain("Case of DEV-SB is back at 'Before UAT': read again, nothing differs");
    expect(stderr).toContain('  not rewound: 2 record(s) of Account still differ');
    const ledger = h.store.folderOf(ORG_ID, checkpoint.checkpointId).dir;
    const lines = readFileSync(join(ledger, '..', 'rewinds.ndjson'), 'utf8')
      .trim()
      .split('\n');
    expect(JSON.parse(lines[lines.length - 1] ?? '{}')).toMatchObject({
      kind: 'rewind',
      objects: ['Account', 'Case'],
      limitedTo: ['Case'],
    });
  });
});

describe('sandforge-checkpoint undo', () => {
  it('takes the org’s last rewind back, by the checkpoint it went back to: exit 0, the org as before the rewind; then has nothing left to undo', async () => {
    const h = harness();
    const checkpoint = await taken(h, '--name', 'Before UAT');
    demo(h);
    const beforeRewind = stateOf(h.org);
    const rewound = await h.run(
      'rewind',
      '--org',
      'DEV-SB',
      '--checkpoint',
      'Before UAT',
      '--yes',
      '--accept-automation',
      '--json',
    );
    expect(rewound.code, rewound.stderr).toBe(0);
    const { rewindId } = JSON.parse(rewound.stdout) as RewindJson;
    clock += 60_000;

    const asked = await h.run('undo', '--org', 'DEV-SB');
    expect(asked.code).toBe(2);
    expect(asked.stdout).toContain(
      `undo the rewind ${rewindId} of DEV-SB to 'Before UAT' (open until `,
    );
    expect(asked.stdout).toContain('it brings back 1 record(s) the rewind deleted');
    // The question, on stderr, then where it stops with no terminal to answer it.
    expect(asked.stderr).toContain('Type DEV-SB to undo its rewind:');
    expect(asked.stderr).toContain('give --yes');

    const { code, stdout, stderr } = await h.run(
      'undo',
      '--org',
      'DEV-SB',
      '--checkpoint',
      checkpoint.checkpointId,
      '--yes',
      '--accept-automation',
      '--json',
    );

    expect(code, stderr).toBe(0);
    expect(stateOf(h.org).live).toEqual(beforeRewind.live);
    const answer = JSON.parse(stdout) as RewindJson & Record<string, unknown>;
    expect(answer).toMatchObject({ rewindId, status: 'success', residual: [] });
    expect(answer).not.toHaveProperty('cannotUndo');
    expect(answer).not.toHaveProperty('undo');
    expect(stderr).toContain("DEV-SB is back as it was before its rewind to 'Before UAT'.");
    expect((await h.store.read(checkpoint.checkpointId))?.checkpoint?.lastRewind?.undoneAt).toEqual(
      expect.any(String),
    );

    const again = await h.run('undo', '--org', 'DEV-SB', '--json');
    expect(again.code).toBe(1);
    expect(JSON.parse(again.stdout)).toMatchObject({ refusal: { code: 'NOT_FOUND' } });
  });

  it('asks to send back to the recycle bin what the rewind brought back alone, never a record the bin no longer gave back to it', async () => {
    const h = harness();
    h.org.add('Case', { Id: id('500', 3), Subject: 'Emptied' });
    await taken(h, '--name', 'Before UAT');
    demo(h);
    // Deleted since, then emptied from the bin: still listed there, the org
    // answers its undelete that it is not in it.
    h.org.trash('Case', id('500', 3), COLLEAGUE);
    h.org.empty(id('500', 3));
    const rewound = await h.run(
      'rewind',
      '--org',
      'DEV-SB',
      '--checkpoint',
      'Before UAT',
      '--yes',
      '--accept-automation',
      '--json',
    );
    expect(rewound.code, rewound.stderr).toBe(3);
    expect(JSON.parse(rewound.stdout)).toMatchObject({ broughtBack: { planned: 2, done: 1 } });
    clock += 60_000;

    const asked = await h.run('undo', '--org', 'DEV-SB');

    expect(asked.code).toBe(2);
    expect(asked.stdout).toContain('sends 1 record(s) it brought back to the recycle bin');
  });
});

describe('sandforge-checkpoint export and import', () => {
  /** A teammate's store, and where the file goes. */
  function elsewhere(): { store: string; file: string } {
    const dir = mkdtempSync(join(tmpdir(), 'sandforge-checkpoint-team-'));
    dirs.push(dir);
    return { store: join(dir, 'store'), file: join(dir, 'before-uat.sfcheckpoint') };
  }

  /** The key an export showed on stderr. */
  function keyShown(stderr: string): string {
    const key = /key, shown this once and kept nowhere: ([A-Z2-7-]+)/.exec(stderr)?.[1];
    if (key === undefined) throw new Error(`no key shown: ${stderr}`);
    return key;
  }

  it('exports a checkpoint without reaching the org, its key on stderr alone, and imports it into another store with --key-env, where it is listed; the same file again is left as it is', async () => {
    const h = harness();
    const checkpoint = await taken(h, '--name', 'Before UAT');
    const team = elsewhere();
    const connected = h.connected.length;

    const out = await h.run(
      'export',
      '--org',
      'DEV-SB',
      '--checkpoint',
      'Before UAT',
      '--out',
      team.file,
      '--json',
    );

    expect(out.code).toBe(0);
    expect(h.connected.length).toBe(connected);
    const key = keyShown(out.stderr);
    expect(out.stdout.includes(key)).toBe(false);
    expect(out.stdout.includes(key.replaceAll('-', ''))).toBe(false);
    expect(JSON.parse(out.stdout)).toMatchObject({
      checkpoint: { id: checkpoint.checkpointId, name: 'Before UAT', org: 'DEV-SB' },
      file: team.file,
      records: 3,
      objects: 2,
      keyShown: true,
    });
    expect(out.stderr).toContain(
      'Anyone who has this file and its key can read the 3 records it holds of DEV-SB, ' +
        'personal data among them. Send the key another way than the file, and only to people ' +
        'who already see all data in DEV-SB.',
    );
    expect(out.stderr).toContain('The file does not expire: delete it once it has served.');

    vi.stubEnv('SANDFORGE_TEAM_KEY', key.toLowerCase());
    try {
      const into = await h.runIn(
        team.store,
        'import',
        '--org',
        'DEV-SB',
        '--file',
        team.file,
        '--key-env',
        'SANDFORGE_TEAM_KEY',
        '--keep-days',
        '7',
        '--json',
      );
      expect(into.code).toBe(0);
      const answer = JSON.parse(into.stdout) as { expiresAt: string };
      expect(answer).toMatchObject({
        outcome: 'imported',
        checkpoint: { id: checkpoint.checkpointId, name: 'Before UAT', org: 'DEV-SB' },
        records: 3,
        objects: 2,
      });
      const kept = Date.parse(answer.expiresAt) - Date.now();
      expect(kept).toBeGreaterThan(7 * 24 * 60 * 60_000 - 60_000);
      expect(kept).toBeLessThanOrEqual(7 * 24 * 60 * 60_000);
      expect(into.stderr).toContain(`the file holds checkpoint ${checkpoint.checkpointId}`);
      expect(into.stderr).toContain('the lock is per machine. Agree on who rewinds.');
      expect(`${into.stdout}${into.stderr}`.includes(key)).toBe(false);

      const listed = await h.runIn(team.store, 'list', '--org', 'DEV-SB', '--json');
      expect(JSON.parse(listed.stdout)).toEqual([
        expect.objectContaining({ id: checkpoint.checkpointId, valid: true }),
      ]);

      const again = await h.runIn(
        team.store,
        'import',
        '--org',
        'DEV-SB',
        '--file',
        team.file,
        '--key-env',
        'SANDFORGE_TEAM_KEY',
      );
      expect(again.code).toBe(0);
      expect(again.stdout).toContain('is kept on this machine already, the same: left as it is');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('asks the org before the key: a file of another org is refused, exit 1, where a key asked first would have stopped at its question', async () => {
    const h = harness();
    await taken(h, '--name', 'Before UAT');
    const team = elsewhere();
    expect((await h.run('export', '--org', 'DEV-SB', '--out', team.file)).code).toBe(0);
    // The alias reaches another org now, which says so itself.
    h.answersAs(REFRESHED_ORG_ID);
    h.org.edit('Organization', ORG_ID, { Id: REFRESHED_ORG_ID });

    const into = await h.runIn(
      team.store,
      'import',
      '--org',
      'DEV-SB',
      '--file',
      team.file,
      '--json',
    );

    expect(into.code).toBe(1);
    expect(JSON.parse(into.stdout)).toMatchObject({ refusal: { code: 'OTHER_ORG' } });
    expect(into.stderr).not.toContain('Key of the file');
    expect(existsSync(team.store) ? readdirSync(team.store) : []).toEqual([]);
  });

  it('asks the key on a terminal alone: with none, and no --key-env, it stops at its question, exit 2, having imported nothing', async () => {
    const h = harness();
    await taken(h, '--name', 'Before UAT');
    const team = elsewhere();
    expect((await h.run('export', '--org', 'DEV-SB', '--out', team.file)).code).toBe(0);

    const into = await h.runIn(team.store, 'import', '--org', 'DEV-SB', '--file', team.file);

    expect(into.code).toBe(2);
    expect(into.stderr).toContain(
      'Key of the file (not shown as you type it):\nno terminal to type it on: give --key-env VAR',
    );
    expect(existsSync(team.store) ? readdirSync(team.store) : []).toEqual([]);
  });

  it('refuses a key on the line in place of a variable, and a variable that holds no key, exit 2 without repeating either, nothing on stdout', async () => {
    const h = harness();
    await taken(h, '--name', 'Before UAT');
    const team = elsewhere();
    const key = 'ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567-ABCD-EFGH-IJKL-MNOP-QRSQ';

    // With its dashes, and without them, where it reads as a name a variable could have.
    for (const given of [key, key.replaceAll('-', '')]) {
      const onLine = await h.run(
        'export',
        '--org',
        'DEV-SB',
        '--out',
        team.file,
        '--key-env',
        given,
      );
      expect(onLine.code).toBe(2);
      expect(onLine.stdout).toBe('');
      expect(onLine.stderr).toContain('--key-env takes the name of an environment variable');
      expect(onLine.stderr.includes('ABCD')).toBe(false);
    }

    vi.stubEnv('SANDFORGE_TEAM_KEY', 'hunter2-not-a-key');
    try {
      const wrong = await h.run(
        'export',
        '--org',
        'DEV-SB',
        '--out',
        team.file,
        '--key-env',
        'SANDFORGE_TEAM_KEY',
        '--json',
      );
      expect(wrong.code).toBe(2);
      expect(wrong.stdout).toBe('');
      expect(wrong.stderr).toContain('SANDFORGE_TEAM_KEY holds no key SandForge reads');
      expect(wrong.stderr.includes('hunter2')).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(existsSync(team.file)).toBe(false);
  });

  it('refuses an export over a file there already, and an import with another key than the file’s, exit 1', async () => {
    const h = harness();
    await taken(h, '--name', 'Before UAT');
    const team = elsewhere();
    expect((await h.run('export', '--org', 'DEV-SB', '--out', team.file)).code).toBe(0);

    const over = await h.run('export', '--org', 'DEV-SB', '--out', team.file, '--json');
    expect(over.code).toBe(1);
    expect(JSON.parse(over.stdout)).toMatchObject({ refusal: { code: 'EXPORT_EXISTS' } });

    vi.stubEnv('SANDFORGE_TEAM_KEY', 'A'.repeat(52));
    try {
      const into = await h.runIn(
        team.store,
        'import',
        '--org',
        'DEV-SB',
        '--file',
        team.file,
        '--key-env',
        'SANDFORGE_TEAM_KEY',
        '--json',
      );
      expect(into.code).toBe(1);
      expect(JSON.parse(into.stdout)).toMatchObject({ refusal: { code: 'IMPORT_KEY' } });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
