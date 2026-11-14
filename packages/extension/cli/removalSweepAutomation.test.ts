import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from 'jsforce';
import type { ForgeTargetAutomation, ForgeTargetFlow } from '@sandforge/shared';

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./sfSession.js', async (original) => ({
  ...(await original<typeof import('./sfSession.js')>()),
  loadOrg: vi.fn(async (alias: string) => ({ alias })),
  makeConn: vi.fn(),
}));

import { loadOrg, makeConn } from './sfSession.js';
import { TargetAutomationReader } from '../src/modules/forge/TargetAutomationReader.js';
import { memoryPermissionOrg } from '../src/test/memoryPermissionOrg.js';
import { tiedTargetOrg, type TiedRow, type TiedTargetOrg } from '../src/test/tiedTargetOrg.js';
import { main as cloneMain } from './sandforge-clone.js';
import { main as seedMain } from './sandforge-seed.js';
import { main as syncMain } from './sandforge-sync.js';

/**
 * What a removal's command line does of what its sweep deletes, on a fake org
 * that refuses what the real one refused: the sweep and the removal are the
 * real ones, on an org where a Flow with a bypass refuses the delete of an
 * asset the run never wrote, unless the user holds that bypass. A real org
 * answered `FIELD_CUSTOM_VALIDATION_EXCEPTION` after the removal had said that
 * nothing fired on its objects and that its mute found nothing to mute.
 */

/** Thrown in place of `process.exit`, with its code. */
class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const ORG_ID = '00D000000000001AAA';
const USER = fakeId('005', 1);
const ACCOUNT = fakeId('001', 1);
const CASE = fakeId('500', 1);
const ASSET = fakeId('02i', 1);

const WRITTEN = '2026-10-01T10:00:00.000Z';
/** Two seconds into the run, as the org writes a date. */
const SAVED = '2026-10-01T10:00:02.000+0000';
const WRITTEN_OVER = '2026-10-01T10:00:05.000Z';

/** What refuses the delete, keeps quiet for the holder of `Load_Data`. */
const ASSET_FLOW = {
  apiName: 'Asset_Guard',
  label: 'Asset guard',
  timing: 'beforeSave',
  startsOn: 'delete',
  condition: 'read',
  permissions: [{ name: 'Load_Data', bypass: true }],
} as unknown as ForgeTargetFlow;

/** What the org runs, read on `objects` as the real reader reads: an object not asked for is not said. */
function automationOn(objects: readonly string[]): ForgeTargetAutomation {
  return {
    objectsRead: [...objects],
    objects: objects.includes('Asset')
      ? [{ objectApiName: 'Asset', flows: [ASSET_FLOW], triggers: [] }]
      : [],
    bypassGrants: [
      {
        permission: 'Load_Data',
        permissionSets: [{ name: 'Data_Load', label: 'Data load', grants: 1 }],
      },
    ],
    unread: [],
  } as unknown as ForgeTargetAutomation;
}

/** The objects the permission org answers for: a mute's reads of the permission sets. */
const PERMISSION_OBJECTS =
  /\bFROM\s+(UserPermissionAccess|PermissionSetAssignment|SetupEntityAccess|ObjectPermissions|CustomPermission|PermissionSet)\b/i;

const rec = (id: string, name: string, lookups: Record<string, string> = {}): TiedRow => ({
  Id: id,
  Name: name,
  CreatedById: USER,
  CreatedDate: SAVED,
  LastModifiedDate: SAVED,
  LastModifiedById: USER,
  SystemModstamp: SAVED,
  ...lookups,
});

/** The org after the run: its account and its case, and the asset a Flow made and named on the case. */
function targetOrg(): TiedTargetOrg {
  const org = tiedTargetOrg(USER);
  org.shape('Account', {
    children: [{ childSObject: 'Case', field: 'AccountId', cascadeDelete: true }],
  });
  org.shape('Case', { references: { AccountId: ['Account'], AssetId: ['Asset'] } });
  org.shape('Asset', {
    children: [{ childSObject: 'Case', field: 'AssetId', restrictedDelete: true }],
  });
  org.add('Account', rec(ACCOUNT, 'Cloned account'));
  org.add('Case', rec(CASE, 'Cloned case', { AccountId: ACCOUNT, AssetId: ASSET }));
  org.add('Asset', rec(ASSET, 'Insured risk'));
  return org;
}

/** A clone's summary: what `--json` printed, as the removal reads it. */
const cloneSummary = (): unknown => ({
  tool: 'sandforge-clone',
  version: 1,
  source: 'SRC',
  target: 'TGT',
  targetOrgId: ORG_ID,
  record: fakeId('001', 901),
  dryRun: false,
  upsert: false,
  expandOrphans: false,
  files: false,
  graph: { nodes: 2, edges: 1, waves: 2, cycles: 0, truncated: false },
  result: {
    successCount: 2,
    updatedCount: 0,
    linkedCount: 0,
    wouldInsertCount: 0,
    failedCount: 0,
    skippedCount: 0,
    remapCount: 2,
    existingRecords: [],
    errors: [],
    remapTable: { [fakeId('001', 901)]: ACCOUNT, [fakeId('500', 901)]: CASE },
    existingSourceIds: [],
    updatedSourceIds: [],
    createdByObject: [
      { objectApiName: 'Account', sourceIds: [fakeId('001', 901)] },
      { objectApiName: 'Case', sourceIds: [fakeId('500', 901)] },
    ],
    writtenBetween: { first: WRITTEN, last: WRITTEN_OVER },
    runUserId: USER,
    readByObject: [],
    failedReads: [],
  },
  elapsedMs: 5_000,
  finishedAt: WRITTEN_OVER,
});

/** A Sync run's summary, the records it created beside it. */
const syncSummary = (): unknown => ({
  tool: 'sandforge-sync',
  source: 'SRC',
  target: 'TGT',
  targetOrgId: ORG_ID,
  dryRun: false,
  startedAt: WRITTEN,
  finishedAt: WRITTEN_OVER,
  result: { status: 'success', objectResults: [], runUserId: USER },
  created: {
    runId: 'sandforge-sync-1',
    firstWrittenAt: WRITTEN,
    lastWrittenAt: WRITTEN_OVER,
    objects: [
      { objectApiName: 'Account', ids: [ACCOUNT] },
      { objectApiName: 'Case', ids: [CASE] },
    ],
  },
  elapsedMs: 5_000,
});

/** A seed's summary. */
const seedSummary = (): unknown => ({
  tool: 'sandforge-seed',
  target: 'TGT',
  targetOrgId: ORG_ID,
  dryRun: false,
  seed: 1234,
  startedAt: WRITTEN,
  finishedAt: WRITTEN_OVER,
  result: {
    templateId: 'cli-1',
    operationId: 'cli-run-1',
    status: 'success',
    runUserId: USER,
    objectResults: [
      {
        objectApiName: 'Account',
        recordsCreated: 1,
        recordsFailed: 0,
        createdIds: [ACCOUNT],
        errors: [],
      },
      {
        objectApiName: 'Case',
        recordsCreated: 1,
        recordsFailed: 0,
        createdIds: [CASE],
        errors: [],
      },
    ],
  },
  elapsedMs: 5_000,
});

const COMMANDS = [
  { name: 'sandforge-clone', main: cloneMain, summary: cloneSummary },
  { name: 'sandforge-sync', main: syncMain, summary: syncSummary },
  { name: 'sandforge-seed', main: seedMain, summary: seedSummary },
] as const;

describe.each(COMMANDS)('$name --remove --sweep', ({ name, main, summary }) => {
  let dir: string;
  let file: string;
  let org: TiedTargetOrg;
  let permissions: ReturnType<typeof memoryPermissionOrg>;
  let read: ReturnType<typeof vi.spyOn>;
  /** What the org was told, in order: the sweep's question, each read of what fires, each lease. */
  let steps: string[];
  let stdout: string;
  let stderr: string;

  /** The command with `args` after what names the run: its exit code, undefined when it ended. */
  async function remove(...args: string[]): Promise<number | undefined> {
    stdout = '';
    stderr = '';
    try {
      await main(['node', `${name}.ts`, '--remove', file, '--target', 'TGT', ...args]);
      return undefined;
    } catch (err: unknown) {
      if (err instanceof ExitCalled) return err.code;
      throw err;
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sandforge-sweep-automation-'));
    vi.stubEnv('SANDFORGE_JOURNAL_DIR', join(dir, 'journal'));
    vi.stubEnv('SANDFORGE_MUTE_LEASES_DIR', join(dir, 'leases'));
    file = join(dir, 'run.json');
    writeFileSync(file, JSON.stringify(summary()));
    org = targetOrg();
    steps = [];
    permissions = memoryPermissionOrg({
      userId: USER,
      organizationId: ORG_ID,
      sets: [{ id: '0PS000000000001AAA', name: 'Data_Load' }],
      beforeWrite: (write) => {
        steps.push(write.kind === 'insert' ? 'lease' : 'release');
      },
    });
    const conn = {
      ...org.conn,
      identity: permissions.connection.identity,
      query: async (soql: string, options?: { scanAll?: boolean }) => {
        if (soql.startsWith('SELECT Id, IsSandbox')) {
          return { records: [{ Id: ORG_ID, IsSandbox: true }] };
        }
        if (/\bFROM\s+Organization\b/i.test(soql)) return permissions.connection.query(soql);
        if (PERMISSION_OBJECTS.test(soql)) return permissions.connection.query(soql);
        return org.conn.query(soql, options);
      },
      // The Flow on the asset refuses its delete, unless the user holds the bypass.
      sobject: (object: string) => {
        if (object === 'PermissionSetAssignment') return permissions.connection.sobject(object);
        const records = org.conn.sobject(object);
        if (object !== 'Asset') return records;
        return {
          ...records,
          destroy: async (ids: string[]) =>
            permissions.assignments().length > 0
              ? records.destroy(ids)
              : ids.map((id) => ({
                  id,
                  success: false,
                  errors: [
                    {
                      statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
                      message: 'An asset cannot be deleted without the bypass.',
                    },
                  ],
                })),
        };
      },
    };
    vi.mocked(makeConn).mockReturnValue(conn as unknown as Connection);
    read = vi
      .spyOn(TargetAutomationReader.prototype, 'read')
      .mockImplementation(async (_org, objects) => {
        steps.push(`read ${[...objects].sort().join(' ')}`);
        return automationOn(objects);
      });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitCalled(code);
    }) as never);
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      stdout += chunk;
      return true;
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      stderr += chunk;
      return true;
    }) as never);
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
      stdout += `${String(line)}\n`;
    });
    vi.spyOn(console, 'error').mockImplementation((line?: unknown) => {
      stderr += `${String(line)}\n`;
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('asks about what fires on what the sweep deletes, and deletes nothing unaccepted', async () => {
    expect(await remove('--sweep')).toBe(1);

    expect(stderr).toContain('Asset: flow "Asset guard"');
    expect(stderr).toContain('--accept-automation');
    expect(org.deletes).toEqual([]);
    expect(org.ids('Asset')).toEqual([ASSET]);
    expect(org.ids('Case')).toEqual([CASE]);
    // Read once, on what both delete: the sweep's own read of what the run's
    // objects fire comes before it, and tells nothing of the asset. The clone
    // kept its user: its removal takes the sets the target's duplicate rules
    // made of its records, read with the rest.
    expect(steps.at(-1)).toBe(
      name === 'sandforge-clone'
        ? 'read Account Asset Case DuplicateRecordSet'
        : 'read Account Asset Case',
    );
  });

  it('names the set that keeps it quiet, which --mute-automation assigns, and no command with the user’s name', async () => {
    // Run on the trap org, the refusal gave `sf org assign permset ...
    // --on-behalf-of <username>`, the name in clear: run, it assigned the set
    // past the removal, outside the lease another run held.
    vi.mocked(loadOrg).mockImplementation(async (alias: string) => ({
      alias,
      username: 'loader@example.com.dev',
      instanceUrl: 'https://tgt.example.com',
      accessToken: 'token',
    }));

    expect(await remove('--sweep')).toBe(1);

    expect(stderr).toContain(
      'With --mute-automation, the removal assigns Data_Load to the user it writes as for the ' +
        'removal alone, under a lease, and what it keeps quiet does not fire.',
    );
    expect(`${stdout}${stderr}`).not.toContain('sf org assign permset');
    expect(`${stdout}${stderr}`).not.toContain('loader@example.com.dev');
    expect(org.deletes).toEqual([]);
  });

  it('offers no mute to the reader of an environment, which never mutes a removal', async () => {
    // Relayed by sandforge-env, the refusal said "With --mute-automation, the
    // removal assigns ...", a flag neither its destroy nor its file takes.
    vi.stubEnv('SANDFORGE_RELAYED_BY', 'sandforge env');
    try {
      expect(await remove('--sweep')).toBe(1);

      expect(stderr).toContain('refused (AUTOMATION_NOT_ACCEPTED): ');
      expect(stderr).not.toContain('--mute-automation');
      expect(org.deletes).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('says which records its user may not delete before it assigns anything, and assigns nothing once it stops there', async () => {
    // Taken before the question, the lease held the sets assigned while it
    // stayed open, for nothing once it was answered no.
    const conn = vi.mocked(makeConn)({} as never) as unknown as {
      describe: (object: string) => Promise<Record<string, unknown>>;
    };
    const describe = conn.describe.bind(conn);
    conn.describe = async (object: string) => ({
      ...(await describe(object)),
      deletable: object !== 'Case',
    });

    expect(await remove('--sweep', '--mute-automation')).toBe(1);

    expect(stderr).toContain('may not delete the records of Case');
    expect(steps).not.toContain('lease');
    expect(permissions.assignments()).toEqual([]);
    expect(org.deletes).toEqual([]);
  });

  it('takes the lease once told to leave what its user may not delete, before its first delete', async () => {
    const conn = vi.mocked(makeConn)({} as never) as unknown as {
      describe: (object: string) => Promise<Record<string, unknown>>;
    };
    const describe = conn.describe.bind(conn);
    let asked = -1;
    conn.describe = async (object: string) => ({
      ...(await describe(object)),
      deletable: object !== 'Case',
    });
    const write = vi.mocked(process.stderr.write).getMockImplementation();
    vi.mocked(process.stderr.write).mockImplementation(((chunk: string) => {
      if (String(chunk).includes('may not delete the records of Case')) asked = steps.length;
      return write?.(chunk) ?? true;
    }) as never);

    await remove('--sweep', '--mute-automation', '--leave-undeletable');

    expect(asked).toBeGreaterThan(-1);
    expect(steps.slice(0, asked)).not.toContain('lease');
    expect(steps.indexOf('lease')).toBeGreaterThanOrEqual(asked);
    expect(org.deletes.length).toBeGreaterThan(0);
  });

  it('has the swept delete refused without the bypass, as the org refused it, automation accepted or not', async () => {
    expect(await remove('--sweep', '--accept-automation', '--json')).toBe(3);

    expect(JSON.parse(stdout)).toMatchObject({
      result: {
        // Exit 3 said it, and the status of the removal did not.
        status: 'partial',
        sweep: {
          status: 'failure',
          objects: [
            {
              objectApiName: 'Asset',
              refused: 1,
              reasons: [expect.stringContaining('FIELD_CUSTOM_VALIDATION_EXCEPTION')],
            },
          ],
        },
      },
    });
    expect(org.ids('Asset')).toEqual([ASSET]);
    expect(org.ids('Case')).toEqual([]);
  });

  it('says it without --json too', async () => {
    expect(await remove('--sweep', '--accept-automation')).toBe(3);

    expect(stdout).toContain('removal: PARTIAL');
    expect(stdout).toContain('sweep: FAILURE');
  });

  it('mutes what fires on what the sweep deletes, under a lease taken after the question, and says it under --json', async () => {
    expect(await remove('--sweep', '--mute-automation', '--json')).toBeUndefined();

    expect(org.ids('Asset')).toEqual([]);
    expect(org.ids('Case')).toEqual([]);
    expect(permissions.assignments()).toEqual([]);
    expect(steps.filter((step) => step === 'lease')).toHaveLength(1);
    expect(steps.indexOf('read Account Asset Case')).toBeLessThan(steps.indexOf('lease'));
    expect(steps.indexOf('lease')).toBeLessThan(steps.indexOf('release'));
    expect(JSON.parse(stdout)).toMatchObject({
      result: {
        status: 'success',
        mutedAutomation: { state: 'muted', assigned: ['Data_Load'], released: true },
      },
    });
  });

  describe('that leaves a task tied to nothing of the run', () => {
    beforeEach(() => {
      org.add('Task', rec(fakeId('00T', 1), 'Loose task'));
    });

    it('says at the end what it found and left and what takes it, its status a success all the same', async () => {
      expect(await remove('--sweep', '--mute-automation')).toBeUndefined();

      expect(org.ids('Task')).toHaveLength(1);
      const lines = stdout.split('\n');
      const left = '  left, tied to nothing of the run: Task: 1 (--sweep-untied takes them)';
      expect(lines).toContain(left);
      expect(lines).toContain('sweep: SUCCESS');
      expect(lines.indexOf(left)).toBeGreaterThan(lines.indexOf('sweep: SUCCESS'));
    });

    it('gives it under --json, by class, with the option', async () => {
      expect(await remove('--sweep', '--mute-automation', '--json')).toBeUndefined();

      expect(JSON.parse(stdout)).toMatchObject({
        result: {
          status: 'success',
          sweep: {
            status: 'success',
            left: [
              {
                class: 'untied',
                objects: [{ objectApiName: 'Task', count: 1 }],
                option: '--sweep-untied',
              },
            ],
          },
        },
      });
    });

    it('says nothing of it left once it is taken', async () => {
      expect(await remove('--sweep', '--sweep-untied', '--mute-automation')).toBeUndefined();

      expect(org.ids('Task')).toEqual([]);
      expect(stdout).not.toContain('left, ');
    });
  });

  it('asks and mutes for a sweep that goes alone, nothing of the run left', async () => {
    // The run's records go; the asset the org refused stays, found made for the run.
    expect(await remove('--sweep', '--accept-automation', '--json')).toBe(3);
    expect(org.ids('Case')).toEqual([]);
    steps.length = 0;
    read.mockClear();

    expect(await remove('--sweep')).toBe(1);
    expect(stderr).toContain('Asset: flow "Asset guard"');
    expect(org.ids('Asset')).toEqual([ASSET]);
    expect(steps.at(-1)).toBe('read Asset');

    steps.length = 0;
    expect(await remove('--sweep', '--mute-automation', '--json')).toBeUndefined();

    expect(org.ids('Asset')).toEqual([]);
    expect(permissions.assignments()).toEqual([]);
    expect(steps.indexOf('read Asset')).toBeLessThan(steps.indexOf('lease'));
    expect(steps.at(-1)).toBe('release');
    expect(JSON.parse(stdout)).toMatchObject({
      result: {
        sweep: { status: 'success', objects: [{ objectApiName: 'Asset', deleted: 1 }] },
        mutedAutomation: { state: 'muted', assigned: ['Data_Load'], released: true },
      },
    });
  });
});
