import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from 'jsforce';
import type { ForgeTargetAutomation, ForgeTargetFlow } from '@sandforge/shared';

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./sfSession.js', async (original) => ({
  ...(await original<typeof import('./sfSession.js')>()),
  loadOrg: vi.fn(async (alias: string) => ({
    alias,
    username: 'someone@example.invalid',
    instanceUrl: 'https://target.example.invalid',
    accessToken: 'token',
  })),
  makeConn: vi.fn(),
}));
vi.mock('../src/core/connection/ConnectionHelper.js', async (original) => ({
  ...(await original<typeof import('../src/core/connection/ConnectionHelper.js')>()),
  getJsforceConnection: vi.fn(),
}));
vi.mock('./prompt.js', async (original) => {
  const actual = await original<typeof import('./prompt.js')>();
  return { ...actual, typed: vi.fn(actual.typed) };
});

import { makeConn } from './sfSession.js';
import { typed } from './prompt.js';
import { getJsforceConnection } from '../src/core/connection/ConnectionHelper.js';
import { TargetAutomationReader } from '../src/modules/forge/TargetAutomationReader.js';
import { FrozenDatasetLoader } from '../src/modules/frozendataset/FrozenDatasetLoader.js';
import { SasReferenceIdMappingStore } from '../src/modules/frozendataset/SasReferenceIdMappingStore.js';
import { memoryPermissionOrg } from '../src/test/memoryPermissionOrg.js';
import { tiedTargetOrg, type TiedRow, type TiedTargetOrg } from '../src/test/tiedTargetOrg.js';
import { main, removalAutomation, removalAsked, parseArgs } from './sandforge-frozen.js';

/**
 * What `sandforge-frozen remove` does of what the target runs as the records
 * go, on a fake org that refuses what the real one refused: the handler, the
 * sweep and the removal are the real ones, on an org where a Flow with a bypass
 * refuses the delete of an asset the load never wrote, unless the user holds
 * that bypass. A Frozen removal read nothing of the target's automation: it
 * deleted with no question, and a sweep the org refused ended exit 0.
 */

/** Thrown in place of `process.exit`, with its code. */
class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const ORG_ID = '00D000000000009AAA';
const USER = fakeId('005', 1);
const ACCOUNT = fakeId('001', 1);
const CASE = fakeId('500', 1);
const ASSET = fakeId('02i', 1);

const WRITTEN = '2026-10-01T10:00:00.000Z';
/** Two seconds into the load, as the org writes a date. */
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

/** What runs on a record of the load, with no bypass. */
const CASE_FLOW = {
  apiName: 'Case_Audit',
  label: 'Case audit',
  timing: 'afterSave',
  startsOn: 'delete',
  condition: 'read',
  permissions: [],
} as unknown as ForgeTargetFlow;

/**
 * What the org runs, read on `objects` as the real reader reads: an object not
 * asked for is not said.
 */
function automationOn(objects: readonly string[], onCase: boolean): ForgeTargetAutomation {
  return {
    objectsRead: [...objects],
    objects: [
      ...(objects.includes('Asset')
        ? [{ objectApiName: 'Asset', flows: [ASSET_FLOW], triggers: [] }]
        : []),
      ...(onCase && objects.includes('Case')
        ? [{ objectApiName: 'Case', flows: [CASE_FLOW], triggers: [] }]
        : []),
    ],
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

/** The org after the load: its account and its case, and the asset a Flow made and named on the case. */
function targetOrg(): TiedTargetOrg {
  const org = tiedTargetOrg(USER);
  org.shape('Account', {
    children: [{ childSObject: 'Case', field: 'AccountId', cascadeDelete: true }],
  });
  org.shape('Case', { references: { AccountId: ['Account'], AssetId: ['Asset'] } });
  org.shape('Asset', {
    children: [{ childSObject: 'Case', field: 'AssetId', restrictedDelete: true }],
  });
  org.add('Account', rec(ACCOUNT, 'Loaded account'));
  org.add('Case', rec(CASE, 'Loaded case', { AccountId: ACCOUNT, AssetId: ASSET }));
  org.add('Asset', rec(ASSET, 'Insured risk'));
  return org;
}

describe('sandforge-frozen remove, and what the target runs as the records go', () => {
  let dir: string;
  let configPath: string;
  let org: TiedTargetOrg;
  let permissions: ReturnType<typeof memoryPermissionOrg>;
  /** What the org was told, in order: each read of what fires, each lease, each delete. */
  let steps: string[];
  let stdout: string;
  let stderr: string;
  /** Whether a Flow runs on the case, with no bypass. */
  let onCase: boolean;

  /** The command's step with `args`: how it ended. */
  async function remove(...args: string[]): Promise<number> {
    stdout = '';
    stderr = '';
    process.exitCode = undefined;
    await main([
      'node',
      'sandforge-frozen.ts',
      'remove',
      '--config',
      configPath,
      '--target',
      'TGT',
      ...args,
    ]);
    return Number(process.exitCode ?? 0);
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sandforge-frozen-automation-'));
    vi.stubEnv('SANDFORGE_JOURNAL_DIR', join(dir, 'journal'));
    vi.stubEnv('SANDFORGE_MUTE_LEASES_DIR', join(dir, 'leases'));
    configPath = join(dir, 'frozen.json');
    writeFileSync(
      configPath,
      JSON.stringify({ rootObject: 'Account', axes: [], edgeCases: [], sasDir: dir }),
    );
    await new SasReferenceIdMappingStore(dir, {
      orgId: ORG_ID,
      organizationId: ORG_ID,
      now: () => new Date(WRITTEN_OVER),
    }).persist(
      new Map([
        ['Account-000001', ACCOUNT],
        ['Case-000001', CASE],
      ]),
      {
        created: [
          { objectApiName: 'Account', referenceIds: ['Account-000001'] },
          { objectApiName: 'Case', referenceIds: ['Case-000001'] },
        ],
        startedAt: new Date(WRITTEN),
        writtenBetween: { first: WRITTEN, last: WRITTEN_OVER },
        runUserId: USER,
      },
    );
    org = targetOrg();
    steps = [];
    onCase = false;
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
        const taken = {
          ...records,
          destroy: async (ids: string[]) => {
            steps.push(`delete ${object}`);
            return records.destroy(ids);
          },
        };
        if (object !== 'Asset') return taken;
        return {
          ...taken,
          destroy: async (ids: string[]) =>
            permissions.assignments().length > 0
              ? taken.destroy(ids)
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
    vi.mocked(getJsforceConnection).mockResolvedValue(conn as never);
    vi.spyOn(TargetAutomationReader.prototype, 'read').mockImplementation(async (_org, objects) => {
      steps.push(`read ${[...objects].sort().join(' ')}`);
      return automationOn(objects, onCase);
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
    vi.mocked(typed).mockReset();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
  });

  it('names what fires on what the sweep deletes, and deletes nothing unaccepted', async () => {
    expect(await remove('--sweep', '--yes')).toBe(1);

    expect(stdout).toContain('Asset: flow "Asset guard"');
    expect(stdout).toContain('--accept-automation');
    expect(stdout).toContain('[AUTOMATION_NOT_ACCEPTED]');
    expect(org.deletes).toEqual([]);
    expect(org.ids('Asset')).toEqual([ASSET]);
    expect(org.ids('Case')).toEqual([CASE]);
    // Once, on what both delete: the sweep's own read of what the load's
    // objects fire comes before it, and tells nothing of the asset.
    expect(steps.at(-1)).toBe('read Account Asset Case');
  });

  it('names what fires on the load’s own records, with no sweep', async () => {
    onCase = true;

    expect(await remove('--yes')).toBe(1);

    expect(stdout).toContain('Case: after delete: flow "Case audit"');
    expect(org.deletes).toEqual([]);
    expect(steps).toEqual(['read Account Case']);
  });

  it('goes unasked where nothing fires, and says so', async () => {
    expect(await remove('--yes')).toBe(0);

    expect(stdout).toContain('nothing fires on the 2 object(s) it writes records of');
    expect(org.ids('Case')).toEqual([]);
    expect(org.ids('Account')).toEqual([]);
  });

  it('says a sweep the org refused in its status and its exit code, where it ended 0 and a success', async () => {
    expect(await remove('--sweep', '--accept-automation', '--yes', '--json')).toBe(3);

    const answer = JSON.parse(stdout) as {
      status: string;
      posted: Array<{ type: string; payload: { result?: Record<string, unknown> } }>;
    };
    expect(answer.status).toBe('partial');
    const result = answer.posted.find((m) => m.type === 'frozen:remove:response')?.payload.result;
    expect(result).toMatchObject({
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
    });
    expect(org.ids('Asset')).toEqual([ASSET]);
    expect(org.ids('Case')).toEqual([]);
  });

  it('says so in words too', async () => {
    expect(await remove('--sweep', '--accept-automation', '--yes')).toBe(3);

    expect(stdout).toContain('sweep: FAILURE');
    expect(stdout).toContain('removal: PARTIAL');
  });

  describe('asked to take what is tied to nothing while another load of the sas wrote in the window', () => {
    const ACCOUNT_B = fakeId('001', 2);
    const LOOSE = fakeId('00T', 9);

    beforeEach(async () => {
      // A second load into the target, three seconds into the first, which
      // keeps its records: what is tied to nothing may be the first's.
      org.add('Account', rec(ACCOUNT_B, 'Second account'));
      org.shape('Task', {});
      org.add('Task', { ...rec(LOOSE, 'Loose task'), CreatedDate: '2026-10-01T10:00:04.000+0000' });
      await new SasReferenceIdMappingStore(dir, {
        orgId: ORG_ID,
        organizationId: ORG_ID,
        now: () => new Date('2026-10-01T10:00:06.000Z'),
      }).persist(new Map([['Account-000002', ACCOUNT_B]]), {
        created: [{ objectApiName: 'Account', referenceIds: ['Account-000002'] }],
        startedAt: new Date('2026-10-01T10:00:03.000Z'),
        writtenBetween: { first: '2026-10-01T10:00:03.000Z', last: '2026-10-01T10:00:06.000Z' },
        earlier: { settled: [] },
        runUserId: USER,
      });
    });

    it('ends partial and exits 3 when --sweep-untied is refused, where it ended a success and 0', async () => {
      // Run for real: "sweep: SUCCESS", exit 0, above "--sweep-untied is
      // refused" and the thirty tasks it left.
      expect(
        await remove('--sweep', '--sweep-untied', '--accept-automation', '--yes', '--json'),
      ).toBe(3);

      const answer = JSON.parse(stdout) as {
        status: string;
        posted: Array<{ type: string; payload: { result?: Record<string, unknown> } }>;
      };
      expect(answer.status).toBe('partial');
      expect(
        answer.posted.find((m) => m.type === 'frozen:remove:response')?.payload.result,
      ).toMatchObject({
        status: 'partial',
        sweep: {
          status: 'failure',
          left: [
            expect.objectContaining({
              class: 'untied',
              refusal: expect.stringContaining('Another run of this machine'),
            }),
          ],
        },
      });
      expect(org.ids('Account')).toEqual([ACCOUNT]);
      expect(org.ids('Task')).toEqual([LOOSE]);
    });

    it('says so in words too', async () => {
      expect(await remove('--sweep', '--sweep-untied', '--accept-automation', '--yes')).toBe(3);

      expect(stdout).toContain('sweep: FAILURE');
      expect(stdout).toContain('--sweep-untied is refused');
      expect(stdout).toContain('removal: PARTIAL');
    });

    it('stays a success, exit 0, when what is tied to nothing was not asked for', async () => {
      expect(await remove('--sweep', '--accept-automation', '--yes')).toBe(0);

      expect(stdout).toContain('sweep: SUCCESS');
      expect(org.ids('Task')).toEqual([LOOSE]);
    });
  });

  describe('of a chain whose reload left what the load it replaced was to take', () => {
    const ACCOUNT_B = fakeId('001', 3);
    const FIRST_LOOSE = fakeId('00T', 11);
    const SECOND_LOOSE = fakeId('00T', 12);

    beforeEach(async () => {
      // The reload two minutes later purged the first load's records and its
      // sweep, unasked, left the task the flow opened on nothing: the first
      // load stays, with none of its records, for that task.
      org.rows.set('Account', []);
      org.rows.set('Case', []);
      org.rows.set('Asset', []);
      org.add('Account', {
        ...rec(ACCOUNT_B, 'Reloaded account'),
        CreatedDate: '2026-10-01T10:02:02.000+0000',
      });
      org.shape('Task', {});
      org.add(
        'Task',
        { ...rec(FIRST_LOOSE, 'Trap follow-up'), CreatedDate: '2026-10-01T10:00:03.000+0000' },
        { ...rec(SECOND_LOOSE, 'Trap follow-up'), CreatedDate: '2026-10-01T10:02:03.000+0000' },
      );
      await new SasReferenceIdMappingStore(dir, {
        orgId: ORG_ID,
        organizationId: ORG_ID,
        now: () => new Date('2026-10-01T10:02:06.000Z'),
      }).persist(new Map([['Account-000001', ACCOUNT_B]]), {
        created: [{ objectApiName: 'Account', referenceIds: ['Account-000001'] }],
        startedAt: new Date('2026-10-01T10:02:00.000Z'),
        writtenBetween: { first: '2026-10-01T10:02:00.000Z', last: '2026-10-01T10:02:05.000Z' },
        earlier: { settled: [ACCOUNT, CASE], stillToSweep: [WRITTEN_OVER] },
        runUserId: USER,
      });
    });

    it('takes what both loads left with --sweep --sweep-untied, none of the tasks staying, exit 0', async () => {
      // Run for real: sixty tasks stayed, which only a delete by hand took.
      expect(
        await remove('--sweep', '--sweep-untied', '--accept-automation', '--yes', '--json'),
      ).toBe(0);

      expect(org.ids('Task')).toEqual([]);
      expect(org.ids('Account')).toEqual([]);
      const answer = JSON.parse(stdout) as {
        status: string;
        posted: Array<{ type: string; payload: { result?: Record<string, unknown> } }>;
      };
      expect(answer.status).toBe('success');
      expect(
        answer.posted.find((m) => m.type === 'frozen:remove:response')?.payload.result,
      ).toMatchObject({
        status: 'success',
        otherLoadSweeps: [{ loadedAt: WRITTEN_OVER, result: { status: 'success' } }],
      });
    });

    it('lists both with --sweep-list, the first load’s task among what it would take, and deletes nothing', async () => {
      expect(await remove('--sweep-list')).toBe(0);

      expect(stdout).toContain(`sweep of the load of ${WRITTEN_OVER}:`);
      expect(stdout).toContain('sweep of the load of 2026-10-01T10:02:06.000Z:');
      expect(stdout).not.toContain('--sweep-untied is refused');
      expect(org.ids('Task')).toEqual([FIRST_LOOSE, SECOND_LOOSE]);
    });
  });

  it('mutes what fires on what the sweep deletes, under a lease taken after the question, and says it under --json', async () => {
    expect(await remove('--sweep', '--mute-automation', '--yes', '--json')).toBe(0);

    expect(org.ids('Asset')).toEqual([]);
    expect(org.ids('Case')).toEqual([]);
    expect(permissions.assignments()).toEqual([]);
    expect(steps.filter((step) => step === 'lease')).toHaveLength(1);
    expect(steps.indexOf('read Account Asset Case')).toBeLessThan(steps.indexOf('lease'));
    expect(steps.indexOf('lease')).toBeLessThan(steps.indexOf('delete Asset'));
    expect(steps.indexOf('delete Asset')).toBeLessThan(steps.indexOf('release'));
    expect(JSON.parse(stdout)).toMatchObject({
      status: 'success',
      mutedAutomation: { state: 'muted', assigned: ['Data_Load'], released: true },
    });
    expect(stderr).toContain('mute: assigned Data_Load');
  });

  // The removal runs in this process, as the editor's does: the leases'
  // folder turned read only once the lease was journaled, the error left it
  // uncoded, the set assigned to the user and the lease held for its hour.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses with its code and deletes nothing when the journal of its lease cannot be written once the set is assigned, the set taken back',
    async () => {
      const leases = join(dir, 'leases');
      let readOnly = false;
      permissions = memoryPermissionOrg({
        userId: USER,
        organizationId: ORG_ID,
        sets: [{ id: '0PS000000000001AAA', name: 'Data_Load' }],
        beforeWrite: (write) => {
          steps.push(write.kind === 'insert' ? 'lease' : 'release');
          if (write.kind === 'insert' && !readOnly) {
            chmodSync(leases, 0o500);
            readOnly = true;
          }
        },
      });

      let exit: number;
      try {
        exit = await remove('--sweep', '--mute-automation', '--yes');
      } finally {
        if (readOnly) chmodSync(leases, 0o700);
      }

      expect(exit).toBe(1);
      expect(steps.filter((step) => step === 'lease' || step === 'release')).toEqual([
        'lease',
        'release',
      ]);
      expect(permissions.assignments()).toEqual([]);
      expect(org.deletes).toEqual([]);
      expect(`${stdout}${stderr}`).toContain('[MUTE_FAILED]');
      expect(`${stdout}${stderr}`).toContain(
        'could not be written (EACCES): the user SandForge runs as must read and write that ' +
          'folder, or SANDFORGE_MUTE_LEASES_DIR name another, the same for every run that mutes ' +
          'the org. What this run had assigned was taken back: Data_Load.',
      );
    },
  );

  it('still asks about what no bypass keeps quiet, and takes no lease for a removal that stops', async () => {
    onCase = true;

    expect(await remove('--sweep', '--mute-automation', '--yes')).toBe(1);

    expect(stdout).toContain('silenced: Asset');
    expect(stdout).toContain('Case: flow "Case audit" (after delete)');
    expect(steps).not.toContain('lease');
    expect(org.deletes).toEqual([]);
  });

  it('stays a success when the sweep kept what is tied to nothing, and says what it left', async () => {
    org.add('Task', rec(fakeId('00T', 1), 'Loose task'));

    expect(await remove('--sweep', '--mute-automation', '--yes')).toBe(0);

    expect(org.ids('Task')).toHaveLength(1);
    expect(stdout).toContain('sweep: SUCCESS');
    expect(stdout).toContain('removal: SUCCESS');
    expect(stdout).toContain('left, tied to nothing of the run: Task: 1');
  });

  describe('run again once the load’s records went and its sweep did not take all it was to', () => {
    /** The removal whose records went and whose sweep the org refused: exit 3, the asset in the org. */
    const sweepRefused = async (): Promise<void> => {
      expect(await remove('--sweep', '--accept-automation', '--yes')).toBe(3);
      expect(org.ids('Case')).toEqual([]);
      expect(org.ids('Asset')).toEqual([ASSET]);
      steps = [];
    };

    it('runs the sweep alone, which the bypass lets through, where it answered nothing to do, exit 0', async () => {
      await sweepRefused();

      expect(await remove('--sweep', '--mute-automation', '--yes', '--json')).toBe(0);

      expect(org.ids('Asset')).toEqual([]);
      const answer = JSON.parse(stdout) as {
        status: string;
        posted: Array<{ type: string; payload: { code?: string; result?: unknown } }>;
      };
      expect(answer.status).toBe('success');
      expect(answer.posted.map((message) => message.payload.code)).not.toContain('ALREADY_REMOVED');
      expect(
        answer.posted.find((message) => message.type === 'frozen:remove:response')?.payload.result,
      ).toMatchObject({
        status: 'success',
        objects: [],
        sweep: { status: 'success', objects: [{ objectApiName: 'Asset', deleted: 1 }] },
      });
      // On what it deletes alone, under the lease.
      expect(steps).toContain('read Asset');
      expect(steps.indexOf('lease')).toBeLessThan(steps.indexOf('delete Asset'));
    });

    it('ends exit 3 and partial while the org still refuses it, with its own lines alone', async () => {
      await sweepRefused();

      expect(await remove('--sweep', '--accept-automation', '--yes')).toBe(3);

      expect(stdout).toContain('sweep: FAILURE');
      expect(stdout).not.toContain('removal: ');
      expect(org.ids('Asset')).toEqual([ASSET]);
    });

    it('asks of what fires on what it takes, and deletes nothing unaccepted', async () => {
      await sweepRefused();

      expect(await remove('--sweep', '--yes')).toBe(1);

      expect(stdout).toContain('Asset: flow "Asset guard"');
      expect(stdout).toContain('[AUTOMATION_NOT_ACCEPTED]');
      expect(org.deletes.map((call) => call.object)).not.toContain('Asset');
    });

    it('asks for the name of the org before it deletes, the records it takes being in no plan', async () => {
      await sweepRefused();
      vi.mocked(typed).mockResolvedValue('no');

      expect(await remove('--sweep', '--accept-automation')).toBe(0);

      expect(typed).toHaveBeenCalledWith('Type TGT to delete them:');
      expect(stdout).toContain('Nothing deleted.');
      expect(org.ids('Asset')).toEqual([ASSET]);
    });

    it('answers as before with no sweep asked: nothing to remove, no failure', async () => {
      await sweepRefused();

      expect(await remove('--accept-automation', '--yes')).toBe(0);

      expect(stdout).toContain('nothing to remove: The records this load created were already');
      expect(org.ids('Asset')).toEqual([ASSET]);
    });

    it('takes nothing and asks nothing of a sweep that finds nothing', async () => {
      expect(await remove('--sweep', '--mute-automation', '--yes')).toBe(0);
      steps = [];

      expect(await remove('--sweep')).toBe(0);

      expect(typed).not.toHaveBeenCalled();
      expect(steps.filter((step) => step.startsWith('delete'))).toEqual([]);
      expect(stdout).toContain('sweep: SUCCESS');
    });
  });

  describe('load --reload --sweep, which sweeps around its purge what the automation made for the load it replaces', () => {
    /** The command's load step with `args`: how it ended. */
    async function reloadStep(...args: string[]): Promise<number> {
      stdout = '';
      stderr = '';
      process.exitCode = undefined;
      await main([
        'node',
        'sandforge-frozen.ts',
        'load',
        '--config',
        configPath,
        '--target',
        'TGT',
        '--reload',
        ...args,
      ]);
      return Number(process.exitCode ?? 0);
    }

    beforeEach(() => {
      // The dataset loaded again, and the loader's purge as it runs it: the
      // sweep's first part, the load before's records, children first, then
      // its last part, which takes the asset once the case that names it went.
      mkdirSync(join(dir, 'dataset', 'data'), { recursive: true });
      writeFileSync(
        join(dir, 'dataset', 'manifest.json'),
        JSON.stringify({
          version: '1.4.0',
          status: 'frozen',
          frozenAt: WRITTEN,
          source: { orgId: fakeId('00D', 2), decisionDate: WRITTEN },
          saltFingerprint: 'abcdef012345',
          rulesVersion: '1.0.0',
          volumetry: { budgetMax: 2500, measured: { Account: 1 }, measuredAt: 'x' },
          controls: {
            nonReidentification: { passed: true, checks: [], author: 'qa', checkedAt: 'x' },
            dryRunLoad: null,
            author: 'qa',
            date: 'x',
          },
        }),
      );
      writeFileSync(
        join(dir, 'dataset', 'data', 'Account.json'),
        JSON.stringify({
          objectApiName: 'Account',
          records: [{ referenceId: 'Account-1', fields: { Name: 'Account-1' } }],
        }),
      );
      vi.spyOn(FrozenDatasetLoader.prototype, 'gateLoad').mockResolvedValue('allowed');
      vi.spyOn(FrozenDatasetLoader.prototype, 'load').mockImplementation(async (options) => {
        await options.purgeSweep?.first();
        for (const object of ['Case', 'Account']) {
          const ids = org.ids(object);
          if (ids.length > 0) await org.conn.sobject(object).destroy(ids);
        }
        if (!options.signal?.aborted) await options.purgeSweep?.afterPurge();
        return {
          status: 'completed',
          orgId: ORG_ID,
          mode: { pilot: false, reload: true },
          startedAt: WRITTEN_OVER,
          durationMs: 1,
          alignment: {
            objectResults: [],
            excludedObjects: [],
            removals: [],
            adjustments: [],
            recordTypeIssues: [],
          },
          placeholders: [],
          requiredDefaults: [],
          perObject: [],
          pass2: { resolved: 0, unresolved: [] },
          personContact: { restored: 0, sent: [], unresolved: [] },
          statuses: { restored: 0, refused: [] },
          purge: { deleted: { Case: 1, Account: 1 }, deactivated: {}, failures: [] },
          mappingPath: '',
          contractPath: join(dir, 'no-such-contract.json'),
        } as unknown as Awaited<ReturnType<FrozenDatasetLoader['load']>>;
      });
    });

    /** What the command printed under --json. */
    const answered = () =>
      JSON.parse(stdout) as {
        refused?: { code: string; message: string };
        posted: Array<{
          type: string;
          payload: {
            report?: {
              sweeps?: Array<{ loadedAt: string; result: { status: string } }>;
            };
          };
        }>;
      };

    it('names what fires on what its sweep takes, the purge’s own deletes asked first, and writes nothing unaccepted', async () => {
      expect(await reloadStep('--sweep', '--yes', '--json')).toBe(1);

      // Nothing fires as the account and the case go: the purge goes by;
      // the asset the sweep would take fires its flow, unaccepted.
      expect(stderr).toContain(
        'reload automation: what TGT runs as the reload purges what earlier loads created',
      );
      expect(stderr).toContain('Asset: before delete: flow "Asset guard"');
      expect(answered().refused).toMatchObject({
        code: 'AUTOMATION_NOT_ACCEPTED',
        message: expect.stringContaining(
          "TGT runs automation on the records this reload's sweep deletes: Asset",
        ),
      });
      expect(FrozenDatasetLoader.prototype.load).not.toHaveBeenCalled();
      expect(org.deletes).toEqual([]);
      expect(org.ids('Asset')).toEqual([ASSET]);
    });

    it('names before anything is written what fires on the purge’s deletes and on the sweep’s, each with what deletes it', async () => {
      // Run for real on the trap org, the refusal named the flow on the
      // contacts the purge deletes alone; the one on the tasks the sweep
      // takes met whoever had turned the first off.
      onCase = true;

      expect(await reloadStep('--sweep', '--yes', '--json')).toBe(1);

      expect(answered().refused).toMatchObject({ code: 'AUTOMATION_NOT_ACCEPTED' });
      expect(answered().refused?.message).toContain(
        `TGT runs automation on the records this reload's purge deletes: Case: flow "Case audit" (after delete). ` +
          `TGT runs automation on the records this reload's sweep deletes: Asset: flow "Asset guard" (before delete).`,
      );
      expect(FrozenDatasetLoader.prototype.load).not.toHaveBeenCalled();
      expect(org.deletes).toEqual([]);
    });

    it('writes nothing when what its sweep would take could not be read', async () => {
      vi.mocked(getJsforceConnection).mockRejectedValue(new Error('INVALID_SESSION_ID'));

      expect(await reloadStep('--sweep', '--accept-automation', '--yes')).toBe(1);

      expect(stdout + stderr).toContain('! frozen:remove:sweep:error: ');
      expect(stdout + stderr).toContain('Nothing written.');
      expect(FrozenDatasetLoader.prototype.load).not.toHaveBeenCalled();
      expect(org.deletes).toEqual([]);
    });

    it('takes the asset once accepted, and says what the sweep left: the org refused it', async () => {
      await reloadStep('--sweep', '--accept-automation', '--yes', '--json');

      expect(org.ids('Case')).toEqual([]);
      const report = answered().posted.find((m) => m.type === 'frozen:load:response')?.payload
        .report;
      expect(report?.sweeps).toEqual([
        { loadedAt: WRITTEN_OVER, result: expect.objectContaining({ status: 'failure' }) },
      ]);
      expect(org.ids('Asset')).toEqual([ASSET]);
      // The sweep's own question, once it read what it takes, in the sweep's
      // words: never under the purge's.
      expect(stderr).not.toContain(
        'reload automation: what TGT runs as the reload purges what earlier loads created\n  Asset',
      );
      expect(stderr.split("as the reload's sweep deletes").length - 1).toBe(2);
    });

    it('mutes what fires on what its sweep deletes, and takes it', async () => {
      await reloadStep('--sweep', '--mute-automation', '--yes', '--json');

      expect(org.ids('Asset')).toEqual([]);
      const report = answered().posted.find((m) => m.type === 'frozen:load:response')?.payload
        .report;
      expect(report?.sweeps?.[0]?.result.status).toBe('success');
      expect(permissions.assignments()).toEqual([]);
      expect(steps.indexOf('lease')).toBeLessThan(steps.indexOf('delete Asset'));
    });

    it('takes nothing of what the automation made without the sweep, as the purge alone did', async () => {
      await reloadStep('--yes', '--json');

      expect(org.ids('Case')).toEqual([]);
      expect(org.ids('Asset')).toEqual([ASSET]);
      expect(
        answered().posted.find((m) => m.type === 'frozen:load:response')?.payload.report,
      ).not.toHaveProperty('sweeps');
    });

    it('lists with --dry-run what its sweep would take, deletes nothing, and says a reload would be refused unaccepted', async () => {
      vi.spyOn(FrozenDatasetLoader.prototype, 'planLoad').mockResolvedValue({
        orgId: ORG_ID,
        mode: { pilot: false, reload: true },
        plannedAt: WRITTEN_OVER,
        perObject: [],
        excludedObjects: [],
        removals: [],
        placeholders: [],
        requiredDefaults: [],
        recordTypeIssues: 0,
        personContacts: 0,
        earlierLoads: 1,
      } as unknown as Awaited<ReturnType<FrozenDatasetLoader['planLoad']>>);

      expect(await reloadStep('--dry-run', '--sweep')).toBe(1);

      expect(stdout).toContain(`sweep of the load of ${WRITTEN_OVER}:`);
      expect(stdout).toContain('Asset');
      expect(stdout).toContain(
        "a load would be refused: TGT runs automation on the records this reload's sweep deletes: Asset",
      );
      expect(org.deletes).toEqual([]);
      expect(FrozenDatasetLoader.prototype.load).not.toHaveBeenCalled();
    });
  });

  it('refuses a read that failed unaccepted, and goes on accepted', async () => {
    vi.mocked(TargetAutomationReader.prototype.read).mockRejectedValue(new Error('REQUEST_LIMIT'));

    expect(await remove('--yes')).toBe(1);
    expect(stdout).toContain('could not be read: REQUEST_LIMIT');
    expect(stdout).toContain('--accept-automation');
    expect(org.deletes).toEqual([]);

    expect(await remove('--accept-automation', '--yes')).toBe(0);
    expect(org.ids('Case')).toEqual([]);
  });

  describe('at the question a removal asks without --yes', () => {
    it('asks for the name of the org last, once what fires is said', async () => {
      vi.mocked(typed).mockImplementation(async () => {
        expect(stdout).toContain('nothing fires on the 2 object(s)');
        expect(steps).toEqual(['read Account Case']);
        return 'TGT';
      });

      expect(await remove()).toBe(0);

      expect(typed).toHaveBeenCalledWith('Type TGT to delete them:');
      expect(org.ids('Case')).toEqual([]);
    });

    it('never asks a removal it refuses', async () => {
      onCase = true;

      expect(await remove()).toBe(1);

      expect(typed).not.toHaveBeenCalled();
    });

    it('deletes nothing for another word, and ends as done, nothing failed', async () => {
      vi.mocked(typed).mockResolvedValue('no');

      expect(await remove('--json')).toBe(0);

      expect(stderr).toContain('Nothing deleted.');
      expect(org.deletes).toEqual([]);
      expect(JSON.parse(stdout)).toMatchObject({ ended: true });
    });

    it('stops at it with no terminal to answer, exit 2, what fires said and nothing deleted', async () => {
      // A CI step: stdin is no terminal, and the question ends the command.
      await remove();

      expect(process.exit).toHaveBeenCalledWith(2);
      expect(stderr).toContain('no terminal to answer: give --yes');
      expect(stdout).toContain('nothing fires on the 2 object(s)');
      expect(org.deletes).toEqual([]);
    });

    it('takes no lease before it is answered', async () => {
      vi.mocked(typed).mockImplementation(async () => {
        expect(steps).not.toContain('lease');
        return 'TGT';
      });

      expect(await remove('--sweep', '--mute-automation')).toBe(0);

      expect(steps).toContain('lease');
    });
  });

  describe('--preview', () => {
    it('says what fires and what a removal would be refused for, deletes nothing, and ends as done', async () => {
      onCase = true;

      expect(await remove('--preview', '--json')).toBe(0);

      expect(org.deletes).toEqual([]);
      expect(stderr).toContain('Case: after delete: flow "Case audit"');
      const answer = JSON.parse(stdout) as { refusals: string[] };
      expect(answer.refusals).toHaveLength(1);
      expect(answer.refusals[0]).toContain('--accept-automation');
    });

    it('refuses nothing accepted', async () => {
      onCase = true;

      expect(await remove('--preview', '--accept-automation', '--json')).toBe(0);

      expect(stderr).toContain('Case: after delete: flow "Case audit"');
      expect(JSON.parse(stdout)).not.toHaveProperty('refusals');
    });

    it('says what a mute would keep quiet, and assigns nothing', async () => {
      expect(await remove('--preview', '--mute-automation', '--json')).toBe(0);

      expect(steps).toEqual(['read Account Case']);
      expect(permissions.assignments()).toEqual([]);
      expect(JSON.parse(stdout)).toMatchObject({ mutedAutomation: { state: 'nothing' } });
    });

    it('says the mute a user who cannot assign permission sets is refused, as the removal is', async () => {
      // Planned from the read alone, the preview said "mute: planned" and
      // refused nothing; the removal itself then ended MUTE_NO_RIGHT.
      permissions = memoryPermissionOrg({
        userId: USER,
        organizationId: ORG_ID,
        canAssign: false,
        sets: [{ id: '0PS000000000001AAA', name: 'Data_Load' }],
      });
      vi.mocked(TargetAutomationReader.prototype.read).mockImplementation(
        async (_org, objects) => ({
          ...automationOn(objects, false),
          objects: [
            {
              objectApiName: 'Case',
              flows: [{ ...ASSET_FLOW, apiName: 'Case_Guard', label: 'Case guard' }],
              triggers: [],
            },
          ],
        }),
      );

      expect(await remove('--preview', '--mute-automation', '--json')).toBe(0);

      const answer = JSON.parse(stdout) as { refusals?: string[]; mutedAutomation?: unknown };
      expect(answer.refusals).toEqual([
        expect.stringContaining('the user the run writes as cannot assign permission sets'),
      ]);
      expect(answer).not.toHaveProperty('mutedAutomation');
      expect(permissions.assignments()).toEqual([]);

      expect(await remove('--mute-automation', '--yes')).toBe(1);
      expect(`${stdout}${stderr}`).toContain('[MUTE_NO_RIGHT]');
      expect(org.deletes).toEqual([]);
    });

    it('says a read that failed among what a removal would be refused for, its preview standing', async () => {
      vi.mocked(TargetAutomationReader.prototype.read).mockRejectedValue(
        new Error('REQUEST_LIMIT'),
      );

      expect(await remove('--preview', '--json')).toBe(0);

      const answer = JSON.parse(stdout) as { refusals: string[]; objects: unknown[] };
      expect(answer.objects).toHaveLength(2);
      expect(answer.refusals[0]).toContain('could not be read (REQUEST_LIMIT)');
    });
  });
});

describe('the words of what a removal runs into', () => {
  it('says a read that failed whole, and refuses it', () => {
    const { lines, refusal } = removalAutomation(
      { read: { unread: 'timed out' }, steps: { delete: ['Case'] } },
      'TGT',
    );

    expect(lines).toEqual(['removal automation: what TGT runs could not be read: timed out']);
    expect(refusal).toContain('--accept-automation');
    expect(refusal).toContain('Nothing was written or deleted.');
  });

  it('refuses nothing when nothing fires and all of it was read', () => {
    const { refusal } = removalAutomation(
      { read: automationOn(['Account'], false), steps: { delete: ['Account'] } },
      'TGT',
    );

    expect(refusal).toBeUndefined();
  });

  it('offers --mute-automation for what a bypass keeps quiet, never a command that assigns it by hand', () => {
    // It gave `sf org assign permset … --on-behalf-of <the user>`: assigned
    // so, the set stays assigned past the removal, outside any lease.
    const { refusal } = removalAutomation(
      { read: automationOn(['Asset'], false), steps: { delete: ['Asset'] } },
      'TGT',
    );

    expect(refusal).toContain(
      'With --mute-automation, the removal assigns Data_Load to the user it writes as for the removal alone, under a lease, and what it keeps quiet does not fire.',
    );
    expect(refusal).not.toContain('sf org assign permset');
    expect(refusal).not.toContain('--on-behalf-of');
  });

  it('offers no mute to a removal that mutes already, nor for what no bypass keeps quiet', () => {
    const asked = removalAutomation(
      {
        read: automationOn(['Asset'], false),
        steps: { delete: ['Asset'] },
        mute: {
          automation: automationOn(['Asset'], false),
          muted: {
            state: 'planned',
            assigned: ['Data_Load'],
            held: [],
            permissions: ['Load_Data'],
            silenced: [],
            stillRan: [],
          },
        },
      },
      'TGT',
    );
    const noBypass = removalAutomation(
      { read: automationOn(['Case'], true), steps: { delete: ['Case'] } },
      'TGT',
    );

    expect(asked.refusal).not.toContain('With --mute-automation');
    expect(noBypass.refusal).toContain('Case audit');
    expect(noBypass.refusal).not.toContain('--mute-automation');
  });

  it('says a reload’s purge in a reload’s words, where it said a removal and to remove all the same', () => {
    const fires = removalAutomation(
      { read: automationOn(['Asset'], false), steps: { setToDraft: [], delete: ['Asset'] } },
      'TGT',
      'reload',
    );
    const unread = removalAutomation(
      { read: { unread: 'timed out' }, steps: { delete: ['Asset'] } },
      'TGT',
      'reload',
    );

    expect(fires.lines[0]).toBe(
      'reload automation: what TGT runs as the reload purges what earlier loads created',
    );
    expect(fires.refusal).toBe(
      `TGT runs automation on the records this reload's purge deletes: Asset: flow "Asset guard" (before delete). ` +
        'With --mute-automation, the reload assigns Data_Load to the user it writes as for the ' +
        'reload alone, under a lease, and what it keeps quiet does not fire. Nothing was written ' +
        'or deleted. Add --accept-automation to reload all the same, or turn that automation off ' +
        'in TGT first.',
    );
    expect(unread.lines).toEqual(['reload automation: what TGT runs could not be read: timed out']);
    expect(unread.refusal).toContain(
      "What TGT runs as this reload's purge writes could not be read",
    );
    expect(unread.refusal).toContain('Add --accept-automation to reload all the same');
    expect(`${fires.refusal ?? ''}${unread.refusal ?? ''}`).not.toContain('removal');
  });

  it('names what fires on what a reload’s sweep deletes as the sweep’s, apart from its purge’s', () => {
    // Run for real on the trap org, the sweep's question said "this
    // reload's purge deletes: Task", tasks the sweep took and the purge
    // never touched.
    const both = removalAutomation(
      {
        read: automationOn(['Case', 'Asset'], true),
        steps: { setToDraft: [], delete: ['Case'] },
      },
      'TGT',
      'reload',
      { delete: ['Asset'] },
    );
    const sweepAlone = removalAutomation(
      { read: automationOn(['Asset'], false), steps: { setToDraft: [], delete: ['Asset'] } },
      'TGT',
      'reloadSweep',
    );

    expect(both.lines).toEqual([
      'reload automation: what TGT runs as the reload purges what earlier loads created',
      '  Case: after delete: flow "Case audit"',
      "reload automation: what TGT runs as the reload's sweep deletes what the target's automation made for the loads it replaces",
      '  Asset: before delete: flow "Asset guard"',
    ]);
    expect(both.refusal).toContain(
      `TGT runs automation on the records this reload's purge deletes: Case: flow "Case audit" (after delete). ` +
        `TGT runs automation on the records this reload's sweep deletes: Asset: flow "Asset guard" (before delete).`,
    );
    expect(sweepAlone.lines[0]).toBe(
      "reload automation: what TGT runs as the reload's sweep deletes what the target's automation made for the loads it replaces",
    );
    expect(sweepAlone.refusal).toContain(
      `TGT runs automation on the records this reload's sweep deletes: Asset: flow "Asset guard" (before delete).`,
    );
    expect(sweepAlone.refusal).not.toContain('purge');
  });

  it('says that nothing fires on what a reload’s sweep deletes in a sweep’s words, where it said it writes them', () => {
    // Run for real on the trap org: "nothing fires on the 1 object(s) it
    // writes records of", under the line of a sweep that only deletes.
    const quiet = removalAutomation(
      { read: automationOn(['Contact'], false), steps: { setToDraft: [], delete: ['Contact'] } },
      'TGT',
      'reload',
      { setToDraft: [], delete: ['Task'] },
    );
    const sweepAlone = removalAutomation(
      { read: automationOn(['Task'], false), steps: { setToDraft: [], delete: ['Task'] } },
      'TGT',
      'reloadSweep',
    );

    expect(quiet.lines).toEqual([
      'reload automation: what TGT runs as the reload purges what earlier loads created',
      '  nothing fires on the 1 object(s) it writes records of',
      "reload automation: what TGT runs as the reload's sweep deletes what the target's automation made for the loads it replaces",
      '  nothing fires on the 1 object(s) it deletes records of',
    ]);
    expect(sweepAlone.lines).toEqual([
      "reload automation: what TGT runs as the reload's sweep deletes what the target's automation made for the loads it replaces",
      '  nothing fires on the 1 object(s) it deletes records of',
    ]);
  });
});

describe('the command line of a removal', () => {
  const argv = (...args: string[]): string[] => [
    'node',
    'sandforge-frozen.ts',
    ...args,
    '--config',
    'c.json',
    '--target',
    'TGT',
  ];

  it('asks the handler to mute, as the panel’s box does', () => {
    expect(removalAsked(parseArgs(argv('remove', '--mute-automation')))).toEqual({
      muteAutomation: true,
    });
  });

  it('reads --accept-automation with remove and with a reload, and only there', () => {
    expect(parseArgs(argv('remove', '--accept-automation')).acceptAutomation).toBe(true);
    expect(parseArgs(argv('remove')).acceptAutomation).toBe(false);
    expect(parseArgs(argv('load', '--reload', '--accept-automation')).acceptAutomation).toBe(true);

    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitCalled(code);
    }) as never);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(() => parseArgs(argv('load', '--accept-automation'))).toThrow('process.exit(2)');
      expect(stderr).toHaveBeenCalledWith(
        '--accept-automation goes with remove or load --reload. Run with --help.\n',
      );
      expect(() => parseArgs(argv('verify', '--mute-automation'))).toThrow('process.exit(2)');
      expect(stderr).toHaveBeenCalledWith(
        '--mute-automation goes with load or remove. Run with --help.\n',
      );
    } finally {
      exit.mockRestore();
      stderr.mockRestore();
    }
  });
});
