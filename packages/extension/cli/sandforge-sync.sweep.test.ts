import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from 'jsforce';
import { MEMORY_ORG_USER, MemoryRemovalOrg } from '../src/test/memoryRemovalOrg.js';
import { REFUSED_UNTIED_LOOSE, refusedUntiedSweep } from '../src/test/refusedUntiedSweep.js';

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./sfSession.js', () => ({
  loadOrg: vi.fn(async (alias: string) => ({ alias })),
  makeConn: vi.fn(),
}));
vi.mock('../src/modules/forge/ForgeRunRemoval.js', async (original) => ({
  ...(await original<typeof import('../src/modules/forge/ForgeRunRemoval.js')>()),
  removalOrg: vi.fn(),
}));
// The sweep itself is Forge's, tested with it: here, what the command line
// hands it, when, and what it says of it.
vi.mock('../src/modules/forge/ForgeRunSweep.js', async (original) => ({
  ...(await original<typeof import('../src/modules/forge/ForgeRunSweep.js')>()),
  sweepParts: vi.fn(),
  listSweep: vi.fn(),
}));
// The mute as it is, unless a test holds its lease to count when it is taken.
vi.mock('../src/modules/forge/AutomationMuteLease.js', async (original) => {
  const actual = await original<typeof import('../src/modules/forge/AutomationMuteLease.js')>();
  return { ...actual, muteForRun: vi.fn(actual.muteForRun) };
});
const automationRead = vi.fn(async () => ({ objectsRead: [], objects: [], unread: [] }));
vi.mock('./sandforge-clone.js', async (original) => ({
  ...(await original<typeof import('./sandforge-clone.js')>()),
  targetAutomationReader: vi.fn(() => ({ read: automationRead })),
}));

import { makeConn } from './sfSession.js';
import { removalOrg } from '../src/modules/forge/ForgeRunRemoval.js';
import {
  listSweep,
  sweepParts,
  type SweepInput,
  type SweepOptions,
  type SweepParts,
} from '../src/modules/forge/ForgeRunSweep.js';
import type { ForgeSweepListing, ForgeSweepResult, MutedAutomation } from '@sandforge/shared';
import { muteForRun } from '../src/modules/forge/AutomationMuteLease.js';
import {
  writePathOrderDefects,
  type WritePathStep,
} from '../src/modules/checkpoint/beforeRunCheckpoint.js';
import { nodeSyncRunCreations } from '../src/modules/sync/SyncRunCreations.js';
import { RELAYED_BY_VARIABLE } from './scriptRunner.js';
import { main } from './sandforge-sync.js';

/**
 * A sweep in parts answering `result`: `first` made by the removal before
 * its first delete, told what the command handed the sweep.
 */
function partsAnswering(
  result: ForgeSweepResult,
  first: (input: SweepInput, options: SweepOptions) => void = () => undefined,
): (org: unknown, input: SweepInput, options: SweepOptions) => SweepParts {
  return (_org, input, options) => ({
    automationMade: new Set<string>(),
    made: new Set<string>(),
    late: new Set<string>(),
    gone: new Set<string>(),
    ask: vi.fn(async () => undefined),
    listing: undefined,
    takes: [],
    first: vi.fn(async () => {
      first(input, options);
      return result.objects.some((object) => object.deleted > 0);
    }),
    afterRemoval: vi.fn(async () => false),
    result: () => result,
  });
}

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const ORG_ID = '00D000000000001AAA';
const A1 = fakeId('001', 1);
const C1 = fakeId('003', 1);
const DOC = fakeId('069', 1);

const argv = (...args: string[]): string[] => ['node', 'sandforge-sync.ts', ...args];

/** A run ten minutes ago that created an account, a contact under it and a file. */
function summary(): Record<string, unknown> {
  const at = new Date(Date.now() - 10 * 60_000).toISOString();
  return {
    tool: 'sandforge-sync',
    source: 'SRC',
    target: 'TGT',
    targetOrgId: ORG_ID,
    dryRun: false,
    startedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
    finishedAt: at,
    result: { status: 'success', objectResults: [] },
    created: {
      runId: 'sandforge-sync-1',
      lastWrittenAt: at,
      objects: [
        { objectApiName: 'Account', ids: [A1] },
        { objectApiName: 'Contact', ids: [C1] },
        { objectApiName: 'ContentDocument', ids: [DOC] },
      ],
    },
    elapsedMs: 900,
  };
}

/** Stop at `process.exit`, with its code. */
function stubExit(): { code: () => number | undefined } {
  let code: number | undefined;
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    code = c;
    throw new Error(`exit ${c}`);
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
  return { code: () => code };
}

describe('sandforge-sync --remove with a sweep', () => {
  let dir: string;
  let file: string;
  let org: MemoryRemovalOrg;
  let stdout: string;

  beforeEach(() => {
    vi.mocked(sweepParts).mockReset();
    vi.mocked(listSweep).mockReset();
    automationRead.mockClear();
    dir = mkdtempSync(join(tmpdir(), 'sandforge-sync-sweep-'));
    // The runs of this machine a sweep is told of: none but the test's own.
    vi.stubEnv('SANDFORGE_JOURNAL_DIR', join(dir, 'journal'));
    file = join(dir, 'run.json');
    writeFileSync(file, JSON.stringify(summary()));
    org = new MemoryRemovalOrg({
      Account: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: false }],
    });
    const at = new Date(Date.now() - 10 * 60_000).toISOString();
    org.add('Account', { Id: A1 }, at);
    org.add('Contact', { Id: C1, AccountId: A1 }, at);
    org.add('ContentDocument', { Id: DOC }, at);
    vi.mocked(removalOrg).mockReturnValue(org);
    vi.mocked(makeConn).mockReturnValue({
      query: vi.fn(async (soql: string) =>
        soql.startsWith('SELECT Id, IsSandbox')
          ? { records: [{ Id: ORG_ID, IsSandbox: false }] }
          : { records: [{ OrganizationType: 'Developer Edition' }] },
      ),
    } as unknown as Connection);
    stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      stdout += chunk;
      return true;
    }) as never);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('sweeps before the run’s records go, handing the sweep every record the run created to leave alone', async () => {
    const order: string[] = [];
    vi.mocked(sweepParts).mockImplementation(
      partsAnswering(
        {
          status: 'success',
          objects: [
            {
              objectApiName: 'Task',
              found: 1,
              deleted: 1,
              alreadyGone: 0,
              keptChanged: 0,
              refused: 0,
              reasons: [],
            },
          ],
          unread: [],
          handWork: [],
        },
        (input, options) => {
          order.push(`sweep, ${org.deletes.length} delete(s) before`);
          expect(input.created).toEqual([
            { objectApiName: 'Account', ids: [A1] },
            { objectApiName: 'Contact', ids: [C1] },
            { objectApiName: 'ContentDocument', ids: [DOC] },
          ]);
          expect([A1, C1, DOC].every((id) => input.remap.has(id.slice(0, 15)))).toBe(true);
          expect(options.includeChanged).toBe(false);
        },
      ),
    );

    await main(argv('--remove', file, '--target', 'TGT', '--sweep', '--json'));

    expect(order).toEqual(['sweep, 0 delete(s) before']);
    // What the target's flows create is read for the records' objects, not the file's.
    expect(automationRead).toHaveBeenCalledWith('TGT', ['Account', 'Contact']);
    expect(org.all('Contact')).toEqual([]);
    expect(JSON.parse(stdout)).toMatchObject({
      result: { status: 'success', sweep: { status: 'success', objects: [{ deleted: 1 }] } },
    });
  });

  it('exits 3 when the sweep was refused, whatever the removal took', async () => {
    vi.mocked(sweepParts).mockImplementation(
      partsAnswering({
        status: 'refused',
        refusal: 'hand work',
        objects: [],
        unread: [],
        handWork: [],
      }),
    );
    const exit = stubExit();

    await expect(
      main(argv('--remove', file, '--target', 'TGT', '--sweep', '--json')),
    ).rejects.toThrow('exit 3');

    expect(exit.code()).toBe(3);
    expect(org.all('Contact')).toEqual([]);
  });

  it('exits 3 and says partial when --sweep-untied was refused, where it ended 0 and a success', async () => {
    const sweep = refusedUntiedSweep({
      sweepParts: (
        await vi.importActual<typeof import('../src/modules/forge/ForgeRunSweep.js')>(
          '../src/modules/forge/ForgeRunSweep.js',
        )
      ).sweepParts,
      removalOrg: (
        await vi.importActual<typeof import('../src/modules/forge/ForgeRunRemoval.js')>(
          '../src/modules/forge/ForgeRunRemoval.js',
        )
      ).removalOrg,
    });
    vi.mocked(sweepParts).mockImplementation(sweep.parts);
    const exit = stubExit();

    await expect(
      main(argv('--remove', file, '--target', 'TGT', '--sweep', '--sweep-untied', '--json')),
    ).rejects.toThrow('exit 3');

    expect(exit.code()).toBe(3);
    expect(JSON.parse(stdout)).toMatchObject({
      result: {
        status: 'partial',
        sweep: {
          status: 'partial',
          left: [expect.objectContaining({ class: 'untied', refusal: expect.any(String) })],
        },
      },
    });
    expect(sweep.org.ids('Task')).toEqual([REFUSED_UNTIED_LOOSE]);
  });

  it('lists what a sweep would take and deletes nothing, the run’s records included', async () => {
    vi.mocked(listSweep).mockResolvedValue({
      looked: ['Account', 'Contact', 'Task'],
      found: [{ objectApiName: 'Task', count: 1, names: ['Follow up'] }],
      unread: [],
      handWork: [],
      window: { from: '2026-10-18T09:00:00Z', to: '2026-10-18T09:01:00Z' },
    });

    await main(argv('--remove', file, '--target', 'TGT', '--sweep-list'));

    expect(listSweep).toHaveBeenCalledTimes(1);
    expect(sweepParts).not.toHaveBeenCalled();
    expect(org.deletes).toEqual([]);
    expect(stdout).toContain('Follow up');
    expect(existsSync(join(dir, 'run.removals.json'))).toBe(false);
  });

  /** Why a sweep of a run whose window cannot be told is refused, in the sweep's words. */
  const WINDOW_UNTOLD =
    'The target did not date this run’s writes: the window its automation wrote in cannot be ' +
    'told, and nothing is swept.';

  it('exits 3 when the sweep it lists would be refused, as that sweep does, where it ended 0 as an empty list', async () => {
    vi.mocked(listSweep).mockResolvedValue({
      looked: [],
      found: [],
      unread: [],
      handWork: [],
      refusal: WINDOW_UNTOLD,
    });
    const exit = stubExit();

    await expect(main(argv('--remove', file, '--target', 'TGT', '--sweep-list'))).rejects.toThrow(
      'exit 3',
    );

    expect(exit.code()).toBe(3);
    expect(stdout).toContain(`sweep refused: ${WINDOW_UNTOLD}`);
    expect(org.deletes).toEqual([]);
  });

  it('exits 3 under --json when the sweep it lists would be refused, its listing saying why as before', async () => {
    vi.mocked(listSweep).mockResolvedValue({
      looked: [],
      found: [],
      unread: [],
      handWork: [],
      refusal: WINDOW_UNTOLD,
    });
    const exit = stubExit();

    await expect(
      main(argv('--remove', file, '--target', 'TGT', '--sweep-list', '--json')),
    ).rejects.toThrow('exit 3');

    expect(exit.code()).toBe(3);
    expect(JSON.parse(stdout)).toMatchObject({
      tool: 'sandforge-sync',
      action: 'sweep-list',
      listing: { found: [], refusal: WINDOW_UNTOLD },
    });
  });

  it('says the list on stderr under --json, the warning about hand work among it, and the listing alone on stdout', async () => {
    vi.mocked(listSweep).mockResolvedValue({
      looked: ['Account', 'Contact', 'Task'],
      found: [
        {
          objectApiName: 'Task',
          count: 1,
          names: ['Follow up'],
          classes: { made: 1, madeOver: 0, late: 0, untied: 0 },
        },
      ],
      unread: [],
      handWork: [],
      window: { from: '2026-10-18T09:00:00Z', to: '2026-10-18T09:01:00Z' },
    });
    let said = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      said += chunk;
      return true;
    }) as never);

    await main(argv('--remove', file, '--target', 'TGT', '--sweep-list', '--json'));

    expect(JSON.parse(stdout)).toMatchObject({ action: 'sweep-list', listing: { handWork: [] } });
    expect(said).toContain('  Task: 1 — 1 made for the run (Follow up)');
    expect(said).toContain(
      "a record made by hand as the run's user under the run's records within a minute of " +
        "them reads as the automation's, and one changed by hand before the run's last write " +
        'as unchanged: check the names before a --sweep',
    );
  });

  it('looks from the run’s first write its summary dates, an update before its first creation', async () => {
    const created = '2026-10-18T09:02:00.000Z';
    const firstWrite = '2026-10-18T09:00:10.000Z';
    const run = summary();
    writeFileSync(
      file,
      JSON.stringify({
        ...run,
        created: { ...(run.created as Record<string, unknown>), firstWrittenAt: firstWrite },
      }),
    );
    // The records as the target dated them, its clock and this machine's agreeing.
    vi.spyOn(org, 'queryDeleted').mockImplementation(async (soql: string) => ({
      records: [A1, C1, DOC]
        .filter((recordId) => soql.includes(recordId))
        .map((Id) => ({ Id, CreatedDate: created })),
    }));
    vi.mocked(listSweep).mockResolvedValue({ looked: [], found: [], unread: [], handWork: [] });

    await main(argv('--remove', file, '--target', 'TGT', '--sweep-list', '--json'));

    const [, input] = vi.mocked(listSweep).mock.calls[0];
    expect(Date.parse(input.writtenBetween?.first ?? '')).toBeLessThan(Date.parse(created));
    expect(
      Math.abs(Date.parse(input.writtenBetween?.first ?? '') - Date.parse(firstWrite)),
    ).toBeLessThan(5_000);
    expect(input.writtenBetween?.last).toBe(created);
  });

  it('lists what a sweep would take up to the run’s last write, an update after its last creation, as the summary dates it', async () => {
    const created = '2026-10-18T09:02:00.000Z';
    const lastWrite = '2026-10-18T09:07:30.000Z';
    const run = summary();
    writeFileSync(
      file,
      JSON.stringify({
        ...run,
        created: {
          ...(run.created as Record<string, unknown>),
          firstWrittenAt: '2026-10-18T09:00:10.000Z',
          lastWriteAt: lastWrite,
        },
      }),
    );
    vi.spyOn(org, 'queryDeleted').mockImplementation(async (soql: string) => ({
      records: [A1, C1, DOC]
        .filter((recordId) => soql.includes(recordId))
        .map((Id) => ({ Id, CreatedDate: created })),
    }));
    vi.mocked(listSweep).mockResolvedValue({ looked: [], found: [], unread: [], handWork: [] });

    await main(argv('--remove', file, '--target', 'TGT', '--sweep-list', '--json'));

    const [, input] = vi.mocked(listSweep).mock.calls[0];
    expect(
      Math.abs(Date.parse(input.writtenBetween?.last ?? '') - Date.parse(lastWrite)),
    ).toBeLessThan(5_000);
  });

  it('dates a run that created nothing by its writes, and reads its user from the records it wrote over', async () => {
    // An upsert that matched an account the target held, and created nothing:
    // the account as the run left it, written by the session's user.
    const held = fakeId('001', 2);
    const wrote = new Date(Date.now() - 10 * 60_000);
    org.add(
      'Account',
      { Id: held, LastModifiedById: MEMORY_ORG_USER },
      new Date(wrote.getTime() + 1_000).toISOString(),
    );
    writeFileSync(
      file,
      JSON.stringify({
        ...summary(),
        created: {
          runId: 'sandforge-sync-1',
          firstWrittenAt: wrote.toISOString(),
          lastWriteAt: new Date(wrote.getTime() + 5_000).toISOString(),
          objects: [],
          overwritten: [{ objectApiName: 'Account', backup: 'sync-before-1', ids: [held] }],
        },
      }),
    );
    vi.mocked(listSweep).mockResolvedValue({ looked: [], found: [], unread: [], handWork: [] });

    await main(argv('--remove', file, '--target', 'TGT', '--sweep-list', '--json'));

    const [, input] = vi.mocked(listSweep).mock.calls[0];
    expect(Math.abs(Date.parse(input.writtenBetween?.first ?? '') - wrote.getTime())).toBeLessThan(
      5_000,
    );
    expect(input.user).toBe(MEMORY_ORG_USER);
    expect(input.remap.has(held.slice(0, 15))).toBe(true);
    // What the target runs on the object it wrote over is read: its update flows.
    expect(automationRead).toHaveBeenCalledWith('TGT', ['Account']);
  });

  it('tells the sweep what ties a record to the run: the other runs of this machine in its window, the mute and the user its summary keeps, when its first removal began', async () => {
    const runUser = fakeId('005', 7);
    const muted = {
      state: 'muted',
      silenced: [{ objectApiName: 'Contact', kind: 'flow', name: 'Welcome', permission: 'Bypass' }],
      stillRan: [
        { objectApiName: 'Contact', kind: 'trigger', name: 'ContactTrigger', why: 'noBypass' },
      ],
    };
    const run = summary();
    writeFileSync(
      file,
      JSON.stringify({
        ...run,
        result: {
          ...(run.result as Record<string, unknown>),
          runUserId: runUser,
          mutedAutomation: muted,
        },
      }),
    );
    const firstRemoval = {
      first: '2026-10-18T09:20:00.000Z',
      last: '2026-10-18T09:21:00.000Z',
      userId: fakeId('005', 1),
    };
    writeFileSync(
      join(dir, 'run.removals.json'),
      JSON.stringify({ version: 1, runId: 'sandforge-sync-1', removalSpans: [firstRemoval] }),
    );
    // A seed of this machine into the same org, a few seconds into the run.
    const seedRuns = join(dir, 'journal', 'seed-runs');
    mkdirSync(seedRuns, { recursive: true });
    const seeded = fakeId('003', 9);
    const at = (minutesAgo: number): string =>
      new Date(Date.now() - minutesAgo * 60_000).toISOString();
    writeFileSync(
      join(seedRuns, 'seed-beside.ndjson'),
      [
        {
          run: {
            runId: 'seed-beside',
            configId: 'sandforge-seed',
            configName: 'seed',
            sourceOrgId: 'SRC',
            targetOrgId: 'TGT',
            startedAt: at(10.5),
            targetOrganizationId: ORG_ID,
          },
        },
        { object: 'Contact', created: [seeded], at: at(10.4) },
        { end: { at: at(10.3), status: 'success' } },
      ]
        .map((value) => JSON.stringify(value))
        .join('\n') + '\n',
    );
    vi.mocked(sweepParts).mockImplementation(
      partsAnswering({ status: 'success', objects: [], unread: [], handWork: [] }),
    );

    await main(argv('--remove', file, '--target', 'TGT', '--sweep', '--sweep-late', '--json'));

    const [sweptOrg, input, options] = vi.mocked(sweepParts).mock.calls[0];
    expect(input.runUserId).toBe(runUser);
    expect(input.ties).toEqual({
      otherRuns: [{ ids: [seeded] }],
      muted: { silenced: muted.silenced, stillRan: muted.stillRan },
      removalBegan: firstRemoval.first,
    });
    expect(options.sweepLate).toBe(true);
    expect(sweptOrg.counts).toEqual(expect.any(Function));
  });

  it('makes the sweep’s last part once the run’s records are gone, the first before its first delete', async () => {
    const order: string[] = [];
    vi.mocked(sweepParts).mockImplementation((sweptOrg, input, options) => {
      const parts = partsAnswering({ status: 'success', objects: [], unread: [], handWork: [] })(
        sweptOrg,
        input,
        options,
      );
      return {
        ...parts,
        first: vi.fn(async () => {
          order.push(`first, ${org.deletes.length} delete(s) before`);
          return false;
        }),
        afterRemoval: vi.fn(async () => {
          order.push(`after, ${org.all('Contact').length} contact(s) left`);
          return false;
        }),
      };
    });

    await main(argv('--remove', file, '--target', 'TGT', '--sweep', '--json'));

    expect(order).toEqual(['first, 0 delete(s) before', 'after, 0 contact(s) left']);
  });

  it('takes the mute’s lease once the sweep has read and asked, holds it from the sweep’s first delete to its last part, then gives it back', async () => {
    const events: WritePathStep[] = [];
    const said: string[] = [];
    const muted: MutedAutomation = {
      state: 'muted',
      assigned: ['PS_Bypass'],
      held: [],
      permissions: ['Bypass'],
      silenced: [],
      stillRan: [],
    };
    const automation = { objectsRead: [], objects: [], unread: [] } as never;
    vi.mocked(muteForRun).mockResolvedValue({
      automation,
      muted,
      prepared: {
        plan: { assign: [], silenced: [], stillRuns: [] },
        automation,
        planned: muted,
        acquire: async () => {
          events.push('leaseAcquire');
          said.push('lease');
          return {
            outcome: muted,
            release: async () => {
              events.push('leaseRelease');
              said.push('release');
              return { ...muted, released: true };
            },
          };
        },
      },
    });
    vi.mocked(sweepParts).mockImplementation((sweptOrg, input, options) => ({
      ...partsAnswering({ status: 'success', objects: [], unread: [], handWork: [] })(
        sweptOrg,
        input,
        options,
      ),
      ask: vi.fn(async () => {
        events.push('question');
        said.push('sweep asks');
      }),
      first: vi.fn(async () => {
        events.push('write');
        said.push('sweep before');
        return true;
      }),
      afterRemoval: vi.fn(async () => {
        events.push('write');
        said.push('sweep after');
        return true;
      }),
    }));
    const destroy = org.destroy.bind(org);
    vi.spyOn(org, 'destroy').mockImplementation(async (objectApiName, ids) => {
      events.push('write');
      if (said.at(-1) !== 'the run’s records') said.push('the run’s records');
      return destroy(objectApiName, ids);
    });

    await main(argv('--remove', file, '--target', 'TGT', '--sweep', '--mute-automation', '--json'));

    expect(said).toEqual([
      'sweep asks',
      'lease',
      'sweep before',
      'the run’s records',
      'sweep after',
      'release',
    ]);
    expect(writePathOrderDefects(events)).toEqual([]);
  });

  describe('what a sweep that takes nothing kept', () => {
    /** What such a sweep read: a task made late, one tied to nothing. */
    const KEPT: ForgeSweepListing = {
      window: { from: '2026-10-18T09:00:00Z', to: '2026-10-18T09:16:00Z' },
      looked: ['Contact', 'Task'],
      found: [
        {
          objectApiName: 'Task',
          count: 2,
          names: ['Late call', 'Loose call'],
          classes: { made: 0, madeOver: 0, late: 1, untied: 1 },
        },
      ],
      unread: [],
      handWork: [],
      late: [{ objectApiName: 'Task', count: 1 }],
      untied: { objects: [{ objectApiName: 'Task', count: 1 }] },
    };
    const NOTHING: ForgeSweepResult = {
      status: 'success',
      objects: [],
      unread: [],
      handWork: [],
    };

    /** A sweep that found `listing` and takes nothing, so it asks nothing. */
    const keeping = (listing: ForgeSweepListing | undefined) =>
      vi.mocked(sweepParts).mockImplementation((sweptOrg, input, options) => ({
        ...partsAnswering(NOTHING)(sweptOrg, input, options),
        listing,
      }));

    it('says it, as its question would have', async () => {
      keeping(KEPT);

      await main(argv('--remove', file, '--target', 'TGT', '--sweep'));

      expect(stdout).toContain('and would delete none of them; per object, all it found:');
      expect(stdout).toContain('Task: 2');
      expect(stdout).toContain('kept, made late');
      expect(stdout).toContain('(--sweep-late takes them)');
      expect(stdout).toContain('(--sweep-untied takes them)');
    });

    it('gives it under --json, and says it on stderr', async () => {
      keeping(KEPT);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);

      await main(argv('--remove', file, '--target', 'TGT', '--sweep', '--json'));

      expect(JSON.parse(stdout).result.sweepListing).toEqual(KEPT);
      expect(stderr.mock.calls.join('')).toContain('kept, made late');
    });

    it('says it once of a sweep that asked, and not of one refused, whose result says why', async () => {
      vi.mocked(sweepParts).mockImplementation((sweptOrg, input, options) => ({
        ...partsAnswering(NOTHING)(sweptOrg, input, options),
        listing: KEPT,
        ask: vi.fn(async () => {
          await options.approve?.(KEPT);
        }),
      }));

      await main(argv('--remove', file, '--target', 'TGT', '--sweep'));

      expect(stdout.split('and would delete none of them; per object, all it found:')).toHaveLength(
        2,
      );

      stdout = '';
      vi.mocked(sweepParts).mockReset();
      writeFileSync(file, JSON.stringify(summary()));
      rmSync(join(dir, 'run.removals.json'), { force: true });
      keeping({ ...KEPT, found: [], refusal: 'The target did not date this run’s writes.' });

      await main(argv('--remove', file, '--target', 'TGT', '--sweep')).catch(() => undefined);

      expect(stdout).not.toContain('a sweep looks in');
    });
  });

  it('takes no lease once a stop came while the sweep read', async () => {
    const acquire = vi.fn();
    const automation = { objectsRead: [], objects: [], unread: [] } as never;
    const muted: MutedAutomation = {
      state: 'muted',
      assigned: ['PS_Bypass'],
      held: [],
      permissions: ['Bypass'],
      silenced: [],
      stillRan: [],
    };
    vi.mocked(muteForRun).mockResolvedValue({
      automation,
      muted,
      prepared: {
        plan: { assign: [], silenced: [], stillRuns: [] },
        automation,
        planned: muted,
        acquire,
      },
    });
    vi.mocked(sweepParts).mockImplementation((sweptOrg, input, options) => ({
      ...partsAnswering({ status: 'cancelled', objects: [], unread: [], handWork: [] })(
        sweptOrg,
        input,
        options,
      ),
      ask: vi.fn(async () => {
        process.emit('SIGINT');
      }),
    }));
    stubExit();

    await main(
      argv('--remove', file, '--target', 'TGT', '--sweep', '--mute-automation', '--json'),
    ).catch(() => undefined);

    expect(acquire).not.toHaveBeenCalled();
    expect(org.deletes).toEqual([]);
  });

  describe('what the sweep found made for the run', () => {
    const TASK = fakeId('00T', 1);
    const LATER = fakeId('00T', 2);

    /** A sweep that found `made` made for the run. */
    const finding = (...made: string[]) =>
      vi.mocked(sweepParts).mockImplementation((sweptOrg, input, options) => ({
        ...partsAnswering({ status: 'success', objects: [], unread: [], handWork: [] })(
          sweptOrg,
          input,
          options,
        ),
        made: new Set(made),
      }));
    const keptBesideIt = (): unknown =>
      (
        JSON.parse(readFileSync(join(dir, 'run.removals.json'), 'utf8')) as {
          madeEarlier?: unknown;
        }
      ).madeEarlier;

    it('is kept beside the summary, and the next sweep is told it, its tie gone with the run’s records', async () => {
      finding(TASK);

      await main(argv('--remove', file, '--target', 'TGT', '--sweep', '--json'));

      expect(keptBesideIt()).toEqual([TASK]);
      expect(vi.mocked(sweepParts).mock.calls[0][1].ties.madeEarlier).toBeUndefined();

      stdout = '';
      finding(LATER);

      await main(argv('--remove', file, '--target', 'TGT', '--sweep', '--json'));

      expect(vi.mocked(sweepParts).mock.calls[1][1].ties.madeEarlier).toEqual([TASK]);
      expect(keptBesideIt()).toEqual([TASK, LATER]);
    });

    it('keeps what it found made late beside the summary apart, and the next sweep is told it', async () => {
      vi.mocked(sweepParts).mockImplementation((sweptOrg, input, options) => ({
        ...partsAnswering({ status: 'success', objects: [], unread: [], handWork: [] })(
          sweptOrg,
          input,
          options,
        ),
        late: new Set([LATER]),
      }));

      await main(argv('--remove', file, '--target', 'TGT', '--sweep', '--json'));

      const kept = JSON.parse(readFileSync(join(dir, 'run.removals.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      expect(kept.lateEarlier).toEqual([LATER]);
      expect(kept).not.toHaveProperty('madeEarlier');

      stdout = '';
      finding(TASK);

      await main(argv('--remove', file, '--target', 'TGT', '--sweep', '--sweep-late', '--json'));

      expect(vi.mocked(sweepParts).mock.calls[1][1].ties.lateEarlier).toEqual([LATER]);
      expect(vi.mocked(sweepParts).mock.calls[1][2]).toMatchObject({ sweepLate: true });
      expect(keptBesideIt()).toEqual([TASK]);
    });

    it('is told to a listing too', async () => {
      finding(TASK);
      await main(argv('--remove', file, '--target', 'TGT', '--sweep', '--json'));
      vi.mocked(listSweep).mockResolvedValue({ looked: [], found: [], unread: [], handWork: [] });

      await main(argv('--remove', file, '--target', 'TGT', '--sweep-list', '--json'));

      expect(vi.mocked(listSweep).mock.calls[0][1].ties.madeEarlier).toEqual([TASK]);
    });

    it('is kept whatever the removal ended on', async () => {
      vi.mocked(sweepParts).mockImplementation((sweptOrg, input, options) => ({
        ...partsAnswering({ status: 'success', objects: [], unread: [], handWork: [] })(
          sweptOrg,
          input,
          options,
        ),
        made: new Set([TASK]),
        afterRemoval: vi.fn(async () => {
          throw new Error('the connection dropped');
        }),
      }));

      await expect(main(argv('--remove', file, '--target', 'TGT', '--sweep'))).rejects.toThrow(
        'the connection dropped',
      );

      expect(keptBesideIt()).toEqual([TASK]);
    });

    it('says it could not be kept, and the removal’s own outcome stands', async () => {
      vi.mocked(sweepParts).mockImplementation((sweptOrg, input, options) => ({
        ...partsAnswering({ status: 'success', objects: [], unread: [], handWork: [] })(
          sweptOrg,
          input,
          options,
        ),
        // Asked once the removal ended: where the file is written is taken by then.
        get made() {
          mkdirSync(`${join(dir, 'run.removals.json')}.${process.pid}.tmp`);
          return new Set([TASK]);
        },
      }));
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);

      await main(argv('--remove', file, '--target', 'TGT', '--sweep', '--json'));

      expect(stderr.mock.calls.join('')).toContain(
        'What the sweep found made for the run could not be kept',
      );
      expect(JSON.parse(stdout).result.status).toBe('success');
    });

    it('is kept beside the run’s file, which told the sweep the user it wrote as', async () => {
      const journal = join(dir, 'journal');
      const recorder = nodeSyncRunCreations(journal).recorder({
        runId: 'run-kept',
        configId: 'cfg-1',
        configName: 'Accounts',
        sourceOrgId: 'SRC',
        targetOrgId: 'TGT',
        targetOrganizationId: ORG_ID,
      });
      const runUser = fakeId('005', 7);
      recorder.runUser?.(runUser);
      recorder.note('Contact', [C1], new Date(Date.now() - 10 * 60_000).toISOString());
      await recorder.end({ status: 'success' });
      finding(TASK);
      const path = nodeSyncRunCreations(journal).pathOf('run-kept');

      await main(argv('--remove', path, '--target', 'TGT', '--sweep', '--json'));

      expect(vi.mocked(sweepParts).mock.calls[0][1].runUserId).toBe(runUser);
      const kept = await nodeSyncRunCreations(journal).get('run-kept');
      expect(kept?.removal?.madeEarlier).toEqual([TASK]);
    });
  });

  it('removes without sweeping unless asked', async () => {
    await main(argv('--remove', file, '--target', 'TGT', '--json'));

    expect(sweepParts).not.toHaveBeenCalled();
    expect(JSON.parse(stdout).result.sweep).toBeUndefined();
  });

  describe('the listing a removal with a sweep names', () => {
    beforeEach(() => {
      vi.mocked(sweepParts).mockImplementation(
        partsAnswering({ status: 'success', objects: [], unread: [], handWork: [] }),
      );
      stubExit();
    });

    it('names --sweep-list on its own output, as a seed’s removal does', async () => {
      vi.stubEnv(RELAYED_BY_VARIABLE, '');

      await main(argv('--remove', file, '--target', 'TGT', '--sweep'));

      expect(stdout).toContain("run's user, tied to its records — run --sweep-list to see what");
    });

    it('names, relayed by a command whose reader lists no sweep, this script’s own removal with it', async () => {
      // Relayed so, "run with --sweep-list" named a flag that reader could
      // not give.
      vi.stubEnv(RELAYED_BY_VARIABLE, 'sandforge-mcp');

      await main(argv('--remove', file, '--target', 'TGT', '--sweep'));

      expect(stdout).toContain(
        "tied to its records — run this script's own removal with --sweep-list to see what",
      );
      expect(stdout).not.toContain('run with --sweep-list');
    });
  });
});
