import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from 'jsforce';
import type { ForgeSweepListing, ForgeTargetAutomation } from '@sandforge/shared';
import { MemoryRemovalOrg } from '../src/test/memoryRemovalOrg.js';
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
/** What the target runs as the removal writes, as it reads it: nothing, unless a test says what. */
// The mute as it is, unless a test holds its lease to count when it is taken.
vi.mock('../src/modules/forge/AutomationMuteLease.js', async (original) => {
  const actual = await original<typeof import('../src/modules/forge/AutomationMuteLease.js')>();
  return { ...actual, muteForRun: vi.fn(actual.muteForRun) };
});
const automationRead = vi.fn(async (..._args: unknown[]): Promise<ForgeTargetAutomation> => ({
  objectsRead: [],
  objects: [],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 0,
}));
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
import { MuteRefusedError, muteForRun } from '../src/modules/forge/AutomationMuteLease.js';
import {
  writePathOrderDefects,
  type WritePathStep,
} from '../src/modules/checkpoint/beforeRunCheckpoint.js';
import { nodeSeedRunCreations } from '../src/modules/seed/SeedRunCreations.js';
import { syncRemovalPlan } from '../src/modules/sync/SyncRunCreations.js';
import { main, parseRemoveArgs, readRunSummary, runOfSummary } from './sandforge-seed.js';
import { refusedSummary } from './runRefused.js';

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const ORG_ID = '00D000000000001AAA';
const A1 = fakeId('001', 1);
const A2 = fakeId('001', 2);
const C1 = fakeId('003', 1);
const C2 = fakeId('003', 2);

const argv = (...args: string[]): string[] => ['node', 'sandforge-seed.ts', ...args];

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

/** A seed ten minutes ago that wrote two accounts, then two contacts under them. */
function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tool: 'sandforge-seed',
    target: 'TGT',
    targetOrgId: ORG_ID,
    dryRun: false,
    seed: 1234,
    startedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
    finishedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    result: {
      templateId: 'cli-1',
      operationId: 'cli-run-1',
      status: 'success',
      objectResults: [
        {
          objectApiName: 'Account',
          recordsCreated: 2,
          recordsFailed: 0,
          createdIds: [A1, A2],
          errors: [],
        },
        {
          objectApiName: 'Contact',
          recordsCreated: 2,
          recordsFailed: 0,
          createdIds: [C1, C2],
          errors: [],
        },
      ],
      totalRecordsCreated: 4,
      totalRecordsFailed: 0,
      duration: 900,
      timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
    },
    elapsedMs: 1200,
    ...overrides,
  };
}

/** Stop at `process.exit`, with its code and what was written to stderr. */
function stubExit(): { code: () => number | undefined; stderr: () => string } {
  let code: number | undefined;
  let stderr = '';
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    code = c;
    throw new Error(`exit ${c}`);
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    stderr += chunk;
    return true;
  }) as never);
  return { code: () => code, stderr: () => stderr };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sandforge-seed --remove: the command line and the summary', () => {
  it('reads the summary, the target and the two switches', () => {
    expect(
      parseRemoveArgs(
        argv('--remove', 'run.json', '--target', 'TGT', '--include-changed', '--json'),
      ),
    ).toEqual({
      summaryPath: 'run.json',
      target: 'TGT',
      includeChanged: true,
      sweep: false,
      sweepList: false,
      json: true,
      leaveUndeletable: false,
      acceptAutomation: false,
      muteAutomation: false,
    });
    expect(
      parseRemoveArgs(argv('--remove', 'run.json', '--target', 'TGT', '--leave-undeletable')),
    ).toMatchObject({ leaveUndeletable: true });
    expect(
      parseRemoveArgs(argv('--remove', 'run.json', '--target', 'TGT', '--accept-automation')),
    ).toMatchObject({ acceptAutomation: true });
    expect(
      parseRemoveArgs(argv('--remove', 'run.json', '--target', 'TGT', '--sweep')),
    ).toMatchObject({ sweep: true, sweepList: false });
  });

  it('refuses a sweep and its listing asked together', () => {
    const exit = stubExit();
    expect(() =>
      parseRemoveArgs(argv('--remove', 'run.json', '--target', 'TGT', '--sweep', '--sweep-list')),
    ).toThrow('exit 2');
    expect(exit.stderr()).toContain('give one of them');
  });

  it('refuses a flag a removal does not read', () => {
    const exit = stubExit();
    expect(() =>
      parseRemoveArgs(argv('--remove', 'run.json', '--target', 'TGT', '--seed', '1')),
    ).toThrow('exit 2');
    expect(exit.stderr()).toContain('not "--seed"');
  });

  it('refuses what it cannot take a run back from, before any org is contacted', () => {
    expect(readRunSummary('not json')).toEqual({
      refusal: 'is not JSON: save the output of a run printed with --json.',
    });
    expect(readRunSummary(JSON.stringify(summary({ dryRun: true })))).toMatchObject({
      refusal: expect.stringMatching(/a dry run, which wrote nothing/),
    });
    expect(readRunSummary(JSON.stringify(summary({ tool: 'sandforge-sync' })))).toMatchObject({
      refusal: expect.stringMatching(/not the summary of a sandforge-seed run/),
    });
    // What `--json` printed of a seed its gate refused: the seed's, its code, no result.
    expect(
      readRunSummary(
        refusedSummary(
          { tool: 'sandforge-seed', target: 'TGT', elapsedMs: 3 },
          {
            code: 'SEED_STORAGE_EXCEEDED',
            message: 'The records do not fit. Nothing was written.',
          },
        ),
      ),
    ).toEqual({
      refusal:
        'is the summary of a run refused before its first write (SEED_STORAGE_EXCEEDED), which ' +
        'wrote nothing to the target: there is nothing of it to remove.',
    });
    const truncated = summary();
    (
      truncated.result as { objectResults: Array<Record<string, unknown>> }
    ).objectResults[1].truncated = true;
    expect(readRunSummary(JSON.stringify(truncated))).toMatchObject({
      refusal: expect.stringMatching(/names only the first of the records/),
    });
  });

  it('takes back the objects in the reverse of the order the run wrote them, children first', () => {
    const read = readRunSummary(JSON.stringify(summary()));
    if ('refusal' in read) throw new Error(read.refusal);

    expect(syncRemovalPlan(runOfSummary(read.summary))).toEqual([
      { objectApiName: 'Contact', ids: [C2, C1] },
      { objectApiName: 'Account', ids: [A2, A1] },
    ]);
  });
});

describe('sandforge-seed --remove', () => {
  let dir: string;
  let file: string;
  let org: MemoryRemovalOrg;
  let edition: string;
  let stdout: string;

  beforeEach(() => {
    vi.mocked(sweepParts).mockReset();
    vi.mocked(listSweep).mockReset();
    dir = mkdtempSync(join(tmpdir(), 'sandforge-seed-remove-'));
    // The runs of this machine a sweep is told of: none but the test's own.
    vi.stubEnv('SANDFORGE_JOURNAL_DIR', join(dir, 'journal'));
    file = join(dir, 'seed.json');
    writeFileSync(file, JSON.stringify(summary()));
    org = new MemoryRemovalOrg({
      Account: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: false }],
    });
    const at = new Date(Date.now() - 10 * 60_000).toISOString();
    org.add('Account', { Id: A1 }, at);
    org.add('Account', { Id: A2 }, at);
    org.add('Contact', { Id: C1, AccountId: A1 }, at);
    org.add('Contact', { Id: C2, AccountId: A2 }, at);
    edition = 'Developer Edition';
    vi.mocked(removalOrg).mockReturnValue(org);
    vi.mocked(makeConn).mockReturnValue({
      query: vi.fn(async (soql: string) =>
        soql.startsWith('SELECT Id, IsSandbox')
          ? { records: [{ Id: ORG_ID, IsSandbox: false }] }
          : { records: [{ OrganizationType: edition }] },
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
    vi.unstubAllEnvs();
  });

  it('removes what the run created, children first, and keeps what it did beside the summary', async () => {
    await main(argv('--remove', file, '--target', 'TGT', '--json'));

    expect(org.deletes.map((d) => d.objectApiName)).toEqual(['Contact', 'Account']);
    expect(org.all('Account')).toEqual([]);
    expect(org.all('Contact')).toEqual([]);
    expect(JSON.parse(stdout)).toMatchObject({
      tool: 'sandforge-seed',
      action: 'remove',
      result: { status: 'success', planned: 4 },
    });
    const removals = JSON.parse(readFileSync(join(dir, 'seed.removals.json'), 'utf8'));
    expect(removals).toMatchObject({ runId: 'cli-run-1', undo: { deleted: 4 } });

    // A second removal of the summary finds nothing left, and asks nothing of the org.
    stdout = '';
    vi.mocked(makeConn).mockClear();
    await main(argv('--remove', file, '--target', 'TGT', '--json'));
    expect(JSON.parse(stdout)).toMatchObject({ result: { status: 'success', planned: 0 } });
    expect(makeConn).not.toHaveBeenCalled();
  });

  it('takes the duplicate record set its deletes left empty, and names it in its answer', async () => {
    const SET = fakeId('0GK', 1);
    org = new MemoryRemovalOrg({
      Account: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: false }],
      Contact: [{ childSObject: 'DuplicateRecordItem', field: 'RecordId', cascadeDelete: true }],
    });
    const at = new Date(Date.now() - 10 * 60_000).toISOString();
    org.add('Account', { Id: A1 }, at);
    org.add('Account', { Id: A2 }, at);
    org.add('Contact', { Id: C1, AccountId: A1 }, at);
    org.add('Contact', { Id: C2, AccountId: A2 }, at);
    org.add('DuplicateRecordSet', { Id: SET }, at);
    org.add(
      'DuplicateRecordItem',
      { Id: fakeId('0GL', 1), RecordId: C1, DuplicateRecordSetId: SET },
      at,
    );
    vi.mocked(removalOrg).mockReturnValue(org);

    await main(argv('--remove', file, '--target', 'TGT', '--json'));

    expect(org.all('DuplicateRecordSet')).toEqual([]);
    expect(JSON.parse(stdout)).toMatchObject({
      result: {
        status: 'success',
        planned: 4,
        objects: expect.arrayContaining([
          expect.objectContaining({ objectApiName: 'DuplicateRecordSet', deleted: 1 }),
        ]),
      },
    });
  });

  it('keeps a record changed since the run unless told to include it, and exits 3', async () => {
    org.touch('Contact', C2, new Date().toISOString());
    const exit = stubExit();

    await expect(main(argv('--remove', file, '--target', 'TGT', '--json'))).rejects.toThrow(
      'exit 3',
    );

    expect(exit.code()).toBe(3);
    expect(org.all('Contact').map((r) => r.Id)).toEqual([C2]);
    const outcome = JSON.parse(stdout) as {
      result: { objects: Array<{ objectApiName: string; keptChanged: number }> };
    };
    expect(outcome.result.objects.find((o) => o.objectApiName === 'Contact')?.keptChanged).toBe(1);
  });

  it('stops before its first delete when the user may not delete an object of the run, unless --leave-undeletable', async () => {
    // It deleted the contacts, then had every account refused.
    org.undeletable.add('Account');
    const exit = stubExit();

    await expect(main(argv('--remove', file, '--target', 'TGT'))).rejects.toThrow('exit 1');

    expect(exit.stderr()).toContain(
      'The user SandForge connects as may not delete the records of Account (2 records) in TGT.',
    );
    expect(exit.stderr()).toContain('run again with --leave-undeletable');
    expect(org.deletes).toEqual([]);

    await expect(
      main(argv('--remove', file, '--target', 'TGT', '--leave-undeletable')),
    ).rejects.toThrow('exit 3');
    expect(org.deletes.map((d) => d.objectApiName)).toEqual(['Contact']);
    expect(org.all('Account').map((r) => r.Id)).toEqual([A1, A2]);
  });

  it('refuses a production org, deleting nothing', async () => {
    edition = 'Enterprise Edition';
    const exit = stubExit();

    await expect(main(argv('--remove', file, '--target', 'TGT'))).rejects.toThrow('exit 1');

    expect(exit.stderr()).toContain('TGT is a production org');
    expect(exit.stderr()).toContain('sandforge-seed removes records');
    expect(org.deletes).toEqual([]);
    expect(existsSync(join(dir, 'seed.removals.json'))).toBe(false);
  });

  it.each([
    ['a production org', 'PRODUCTION_TARGET', 'TGT is a production org'],
    [
      'what fires as it deletes',
      'AUTOMATION_NOT_ACCEPTED',
      'TGT runs automation on the records this removal deletes',
    ],
    [
      'objects its user may not delete',
      'UNDELETABLE_NOT_LEFT',
      'The user SandForge connects as may not delete the records of Account (2 records) in ' +
        'TGT. Nothing was removed. Give that user Delete on those objects, or run again with ' +
        '--leave-undeletable to remove the rest and leave them.',
    ],
    [
      'another org than the one the run wrote to',
      'OTHER_ORG',
      'TGT is not the org the run wrote to (00D000000000002AAA), and what it created is ' +
        'removed from that org only. Nothing was deleted.',
    ],
  ])(
    'names the code of a removal refused for %s, on its line and with --json on stdout',
    async (_why, code, words) => {
      // Refused so, it said a sentence with no code on stderr and left stdout
      // empty: a CI job could not tell one refusal from another.
      if (code === 'PRODUCTION_TARGET') edition = 'Enterprise Edition';
      if (code === 'OTHER_ORG') {
        writeFileSync(file, JSON.stringify(summary({ targetOrgId: '00D000000000002AAA' })));
      }
      if (code === 'UNDELETABLE_NOT_LEFT') org.undeletable.add('Account');
      if (code === 'AUTOMATION_NOT_ACCEPTED') {
        automationRead.mockResolvedValueOnce({
          objectsRead: ['Account', 'Contact'],
          objects: [
            {
              objectApiName: 'Account',
              flows: [],
              triggers: [{ name: 'AccountCleanup', events: ['beforeDelete'] }],
            },
          ],
          unread: [],
          conditionsNotRead: 0,
          conditionsBound: 25,
          requests: 3,
        });
      }
      const exit = stubExit();

      await expect(main(argv('--remove', file, '--target', 'TGT', '--json'))).rejects.toThrow(
        'exit 1',
      );

      expect(exit.stderr()).toContain(`refused (${code}): ${words}`);
      const answer = JSON.parse(stdout) as Record<string, unknown>;
      expect(answer).toEqual({
        tool: 'sandforge-seed',
        action: 'remove',
        summary: file,
        target: 'TGT',
        refused: { code, message: expect.stringContaining(words) as string },
        elapsedMs: expect.any(Number) as number,
      });
      expect(org.deletes).toEqual([]);
    },
  );

  it('sweeps before the run’s records go, handing the sweep every record the run created to leave alone', async () => {
    const order: string[] = [];
    vi.mocked(sweepParts).mockImplementation(
      partsAnswering(
        {
          status: 'success',
          objects: [
            {
              objectApiName: 'Task',
              found: 2,
              deleted: 2,
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
            { objectApiName: 'Account', ids: [A1, A2] },
            { objectApiName: 'Contact', ids: [C1, C2] },
          ]);
          expect([A1, A2, C1, C2].every((id) => input.remap.has(id.slice(0, 15)))).toBe(true);
          expect(options.includeChanged).toBe(false);
        },
      ),
    );

    await main(argv('--remove', file, '--target', 'TGT', '--sweep', '--json'));

    expect(order).toEqual(['sweep, 0 delete(s) before']);
    expect(org.all('Contact')).toEqual([]);
    expect(JSON.parse(stdout)).toMatchObject({
      result: { status: 'success', sweep: { status: 'success', objects: [{ deleted: 2 }] } },
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

  it('tells the sweep what ties a record to the run: the other runs of this machine in its window, the mute and the user its summary keeps', async () => {
    const runUser = fakeId('005', 7);
    const muted = {
      state: 'muted',
      silenced: [{ objectApiName: 'Contact', kind: 'flow', name: 'Welcome', permission: 'Bypass' }],
      stillRan: [],
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
    // A Sync run of this machine into the same org, a few seconds into the seed.
    const syncRuns = join(dir, 'journal', 'sync-runs');
    mkdirSync(syncRuns, { recursive: true });
    const synced = fakeId('500', 9);
    const at = (minutesAgo: number): string =>
      new Date(Date.now() - minutesAgo * 60_000).toISOString();
    writeFileSync(
      join(syncRuns, 'sync-beside.ndjson'),
      [
        {
          run: {
            runId: 'sync-beside',
            configId: 'sandforge-sync',
            configName: 'sync',
            sourceOrgId: 'SRC',
            targetOrgId: 'TGT',
            startedAt: at(10.5),
            targetOrganizationId: ORG_ID,
          },
        },
        { object: 'Case', created: [synced], at: at(10.4) },
        { end: { at: at(10.3), status: 'success' } },
      ]
        .map((value) => JSON.stringify(value))
        .join('\n') + '\n',
    );
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

    await main(argv('--remove', file, '--target', 'TGT', '--sweep', '--sweep-untied', '--json'));

    const [sweptOrg, input, options] = vi.mocked(sweepParts).mock.calls[0];
    expect(input.runUserId).toBe(runUser);
    expect(input.ties).toEqual({
      otherRuns: [{ ids: [synced] }],
      muted: { silenced: muted.silenced, stillRan: [] },
    });
    expect(options.sweepUntied).toBe(true);
    expect(sweptOrg.counts).toEqual(expect.any(Function));
    // The last part once the run's records are gone.
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
      rmSync(join(dir, 'seed.removals.json'), { force: true });
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

  it.each([
    [
      'as it plans the mute',
      'plan',
      {
        code: 'MUTE_NO_RIGHT' as const,
        message: 'The user cannot assign permission sets in TGT. Nothing was assigned.',
      },
    ],
    [
      'as it takes the lease',
      'lease',
      {
        code: 'MUTE_FAILED' as const,
        message: 'The lease could not be kept. Nothing was assigned.',
      },
    ],
  ])(
    'ends a removal whose mute is refused %s under its code, on stderr and with --json on stdout, nothing deleted',
    async (_when, when, refusal) => {
      // A sentence on stderr and an empty stdout: a CI job could not tell why.
      if (when === 'plan') {
        vi.mocked(muteForRun).mockRejectedValue(new MuteRefusedError(refusal));
      } else {
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
            acquire: async () => {
              throw new MuteRefusedError(refusal);
            },
          },
        });
      }
      const exit = stubExit();

      await expect(
        main(argv('--remove', file, '--target', 'TGT', '--mute-automation', '--json')),
      ).rejects.toThrow('exit 1');

      expect(exit.code()).toBe(1);
      expect(exit.stderr()).toContain(`refused (${refusal.code}): ${refusal.message}\n`);
      expect(JSON.parse(stdout)).toEqual({
        tool: 'sandforge-seed',
        action: 'remove',
        summary: file,
        target: 'TGT',
        refused: refusal,
        elapsedMs: expect.any(Number),
      });
      expect(org.deletes).toEqual([]);
    },
  );

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
        JSON.parse(readFileSync(join(dir, 'seed.removals.json'), 'utf8')) as {
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

      const kept = JSON.parse(readFileSync(join(dir, 'seed.removals.json'), 'utf8')) as Record<
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
          mkdirSync(`${join(dir, 'seed.removals.json')}.${process.pid}.tmp`);
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
      const recorder = nodeSeedRunCreations(journal).recorder({
        runId: 'seed-kept',
        targetOrgId: 'TGT',
        startedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
        targetOrganizationId: ORG_ID,
      });
      const runUser = fakeId('005', 7);
      recorder.runUser?.(runUser);
      recorder.note('Contact', [C1]);
      await recorder.end({ status: 'success', objectResults: [] });
      finding(TASK);
      const path = nodeSeedRunCreations(journal).pathOf('seed-kept');

      await main(argv('--remove', path, '--target', 'TGT', '--sweep', '--json'));

      expect(vi.mocked(sweepParts).mock.calls[0][1].runUserId).toBe(runUser);
      const kept = await nodeSeedRunCreations(journal).get('seed-kept');
      expect(kept?.removal?.madeEarlier).toEqual([TASK]);
    });
  });

  it('lists what a sweep would take and deletes nothing, the run’s records included', async () => {
    vi.mocked(listSweep).mockResolvedValue({
      looked: ['Account', 'Contact', 'Task'],
      found: [{ objectApiName: 'Task', count: 2, names: ['Welcome call'] }],
      unread: [],
      handWork: [],
      window: { from: '2026-10-18T09:00:00Z', to: '2026-10-18T09:01:00Z' },
    });

    await main(argv('--remove', file, '--target', 'TGT', '--sweep-list'));

    expect(listSweep).toHaveBeenCalledTimes(1);
    expect(sweepParts).not.toHaveBeenCalled();
    expect(org.deletes).toEqual([]);
    expect(stdout).toContain('Task');
    expect(existsSync(join(dir, 'seed.removals.json'))).toBe(false);
  });

  it('refuses a run another process is still writing under its code, its preview too, deleting nothing', async () => {
    // Refused so, it said a sentence with no code on stderr and left stdout
    // empty, its preview as well.
    const runs = join(dir, 'journal', 'seed-runs');
    mkdirSync(runs, { recursive: true });
    const runFile = join(runs, 'sandforge-seed-writing.ndjson');
    const now = new Date().toISOString();
    writeFileSync(
      runFile,
      [
        {
          run: {
            runId: 'sandforge-seed-writing',
            configId: 'sandforge-seed',
            configName: 'sandforge-seed',
            sourceOrgId: 'TGT',
            targetOrgId: 'TGT',
            targetOrganizationId: ORG_ID,
            startedAt: now,
            writer: { pid: process.ppid, hostStartedAt: now },
          },
        },
        { object: 'Account', created: [A1], at: now },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n') + '\n',
    );
    vi.mocked(makeConn).mockClear();
    const exit = stubExit();

    await expect(main(argv('--remove', runFile, '--target', 'TGT', '--json'))).rejects.toThrow(
      'exit 1',
    );

    expect(exit.stderr()).toContain(
      `refused (RUN_WRITING): The run is still writing, in process ${process.ppid}: remove it ` +
        'once it has ended. Nothing was deleted.',
    );
    expect(JSON.parse(stdout)).toMatchObject({
      tool: 'sandforge-seed',
      action: 'remove',
      refused: { code: 'RUN_WRITING' },
    });

    stdout = '';
    await expect(
      main(argv('--remove', runFile, '--target', 'TGT', '--preview', '--json')),
    ).rejects.toThrow('exit 1');
    expect(JSON.parse(stdout)).toMatchObject({
      tool: 'sandforge-seed',
      action: 'remove-preview',
      refused: { code: 'RUN_WRITING' },
    });
    expect(org.deletes).toEqual([]);
    expect(makeConn).not.toHaveBeenCalled();
  });

  it('refuses an org that is not the one the run wrote to', async () => {
    writeFileSync(file, JSON.stringify(summary({ targetOrgId: '00D000000000002AAA' })));
    const exit = stubExit();

    await expect(main(argv('--remove', file, '--target', 'OTHER'))).rejects.toThrow('exit 1');

    expect(exit.stderr()).toContain('is not the org the run wrote to');
    expect(org.deletes).toEqual([]);
  });

  describe('what the target runs as the removal deletes', () => {
    /** What the target reads as running: an Apex trigger before an account is deleted, and one after a contact is. */
    const firing = (): ForgeTargetAutomation => ({
      objectsRead: ['Account', 'Contact'],
      objects: [
        {
          objectApiName: 'Account',
          flows: [],
          triggers: [{ name: 'AccountCleanup', events: ['beforeDelete'] }],
        },
        {
          objectApiName: 'Contact',
          flows: [],
          triggers: [{ name: 'ContactNotify', events: ['afterDelete'] }],
        },
      ],
      unread: [],
      conditionsNotRead: 0,
      conditionsBound: 25,
      requests: 3,
    });

    it('says what fires as it deletes, before anything is deleted, and deletes nothing without --accept-automation', async () => {
      // The command read the target's automation for the sweep alone, and
      // deleted without a word of what the deletes fire.
      automationRead.mockResolvedValueOnce(firing());
      const exit = stubExit();

      await expect(main(argv('--remove', file, '--target', 'TGT'))).rejects.toThrow('exit 1');

      expect(automationRead).toHaveBeenLastCalledWith('TGT', ['Contact', 'Account']);
      expect(stdout).toContain(
        'removal automation: what TGT runs as the removal takes the run back\n' +
          '  Account: before delete: Apex trigger AccountCleanup\n' +
          '  Contact: after delete: Apex trigger ContactNotify\n',
      );
      expect(exit.stderr()).toContain(
        'TGT runs automation on the records this removal deletes: Account: Apex trigger ' +
          'AccountCleanup (before delete); Contact: Apex trigger ContactNotify (after delete). ' +
          'Nothing was written or deleted. Add --accept-automation to remove all the same, or ' +
          'turn that automation off in TGT first.',
      );
      expect(org.deletes).toEqual([]);
      expect(existsSync(join(dir, 'seed.removals.json'))).toBe(false);
    });

    it('removes all the same with --accept-automation, having said what fires', async () => {
      automationRead.mockResolvedValueOnce(firing());
      let stderr = '';
      vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
        stderr += chunk;
        return true;
      }) as never);

      await main(argv('--remove', file, '--target', 'TGT', '--accept-automation', '--json'));

      // On stderr with --json, the outcome alone on stdout.
      expect(stderr).toContain('  Account: before delete: Apex trigger AccountCleanup');
      expect(org.all('Account')).toEqual([]);
      expect(JSON.parse(stdout)).toMatchObject({ result: { status: 'success', planned: 4 } });
    });

    it('names what fires as it sets an activated order back to Draft before its delete', async () => {
      const O1 = fakeId('801', 1);
      writeFileSync(
        file,
        JSON.stringify(
          summary({
            result: {
              ...(summary().result as Record<string, unknown>),
              objectResults: [
                {
                  objectApiName: 'Order',
                  recordsCreated: 1,
                  recordsFailed: 0,
                  createdIds: [O1],
                  errors: [],
                },
              ],
              totalRecordsCreated: 1,
            },
          }),
        ),
      );
      automationRead.mockResolvedValueOnce({
        ...firing(),
        objectsRead: ['Order'],
        objects: [
          {
            objectApiName: 'Order',
            flows: [],
            triggers: [{ name: 'OrderAudit', events: ['beforeUpdate'] }],
          },
        ],
      });
      const exit = stubExit();

      await expect(main(argv('--remove', file, '--target', 'TGT'))).rejects.toThrow('exit 1');

      expect(stdout).toContain(
        '  Order: set back to Draft before its delete: Apex trigger OrderAudit',
      );
      expect(exit.stderr()).toContain(
        'TGT runs automation as this removal sets activated records back to Draft, the only ' +
          'way the platform deletes them: Order: Apex trigger OrderAudit.',
      );
      expect(org.deletes).toEqual([]);
    });

    it('says nothing fires, and asks for nothing, when nothing does', async () => {
      await main(argv('--remove', file, '--target', 'TGT'));

      expect(stdout).toContain('  nothing fires on the 2 object(s) it writes records of');
      expect(org.all('Account')).toEqual([]);
    });

    it('deletes nothing when it could not read what fires, without --accept-automation', async () => {
      automationRead.mockResolvedValueOnce({
        ...firing(),
        objects: [],
        unread: [{ part: 'triggers', reason: 'API_DISABLED' }],
      });
      const exit = stubExit();

      await expect(main(argv('--remove', file, '--target', 'TGT'))).rejects.toThrow('exit 1');

      expect(exit.stderr()).toContain(
        'The Apex triggers of TGT could not be read (API_DISABLED), so what fires as the ' +
          'removal writes is not known. Nothing was written or deleted.',
      );
      expect(org.deletes).toEqual([]);
    });
  });
});
