import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from 'jsforce';
import { MEMORY_ORG_USER, MemoryRemovalOrg } from '../src/test/memoryRemovalOrg.js';

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
import type { ForgeSweepResult, MutedAutomation } from '@sandforge/shared';
import { muteForRun } from '../src/modules/forge/AutomationMuteLease.js';
import {
  writePathOrderDefects,
  type WritePathStep,
} from '../src/modules/checkpoint/beforeRunCheckpoint.js';
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

  it('holds the mute’s lease from the sweep’s first delete to its last part, then gives it back', async () => {
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

    expect(said).toEqual(['lease', 'sweep before', 'the run’s records', 'sweep after', 'release']);
    expect(writePathOrderDefects(events)).toEqual([]);
  });

  it('removes without sweeping unless asked', async () => {
    await main(argv('--remove', file, '--target', 'TGT', '--json'));

    expect(sweepParts).not.toHaveBeenCalled();
    expect(JSON.parse(stdout).result.sweep).toBeUndefined();
  });
});
