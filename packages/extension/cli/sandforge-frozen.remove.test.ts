import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from 'jsforce';

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./sfSession.js', () => ({
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

import { makeConn } from './sfSession.js';
import { getJsforceConnection } from '../src/core/connection/ConnectionHelper.js';
import { SasReferenceIdMappingStore } from '../src/modules/frozendataset/SasReferenceIdMappingStore.js';
import { otherRunsInSweep } from '../src/bridge/handlers/removalSweep.js';
import {
  commandLineOtherRuns,
  failsTheStep,
  frozenStepExit,
  main,
  messageLines,
  parseArgs,
  removalAsked,
} from './sandforge-frozen.js';

/** The target, a sandbox, as its `Organization` record answers. */
const ORG_ID = '00D000000000009AAA';

const argv = (...args: string[]): string[] => ['node', 'sandforge-frozen.ts', ...args];

let sasDir: string;
let configPath: string;
let printed: string[];

beforeEach(() => {
  sasDir = mkdtempSync(join(tmpdir(), 'sandforge-frozen-remove-'));
  configPath = join(sasDir, 'frozen.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      rootObject: 'Account',
      axes: [
        {
          name: 'account',
          label: 'Account',
          filterField: 'Name',
          valuesSoql: 'SELECT Name axisValue FROM Account GROUP BY Name',
        },
      ],
      edgeCases: [],
      budgetMaxRecords: 2500,
      candidatesPerCombination: 1,
      sasDir,
    }),
  );
  const conn = {
    query: vi.fn(async () => ({
      done: true,
      totalSize: 1,
      records: [{ Id: ORG_ID, IsSandbox: true }],
    })),
    queryMore: vi.fn(),
  } as unknown as Connection;
  vi.mocked(makeConn).mockReturnValue(conn);
  vi.mocked(getJsforceConnection).mockResolvedValue(conn as never);
  printed = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
    printed.push(String(chunk));
    return true;
  }) as never);
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  rmSync(sasDir, { recursive: true, force: true });
});

/** A load into the target that created nothing a removal takes: the price book it matched. */
async function loadThatCreatedNothing(): Promise<void> {
  await new SasReferenceIdMappingStore(sasDir, {
    orgId: ORG_ID,
    now: () => new Date('2026-10-17T08:00:10.000Z'),
  }).persist(new Map([['Pricebook2-000001', '01s000000000001AAA']]), {
    created: [],
    startedAt: new Date('2026-10-17T08:00:00.000Z'),
  });
}

describe('sandforge-frozen remove, with nothing to take', () => {
  it('says why and ends the step as done, where it exited on a failure', async () => {
    await loadThatCreatedNothing();

    await main(argv('remove', '--config', configPath, '--target', 'TGT', '--yes'));

    expect(printed.join('')).toContain('nothing to remove: This load created no record to remove.');
    expect(process.exitCode).toBeUndefined();
  });

  it('ends as done when no load into the target is recorded', async () => {
    await main(argv('remove', '--config', configPath, '--target', 'TGT', '--yes'));

    expect(printed.join('')).toContain(
      'No load into TGT is recorded in this sas: nothing to remove.',
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('prints JSON a parser reads with --json, where an early end printed nothing on stdout', async () => {
    let stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      stderr += chunk;
      return true;
    }) as never);

    await main(argv('remove', '--config', configPath, '--target', 'TGT', '--yes', '--json'));

    expect(JSON.parse(printed.join(''))).toMatchObject({ tool: 'sandforge-frozen', ended: true });
    // What it says on the way goes to stderr, where it was dropped.
    expect(stderr).toContain('No load into TGT is recorded in this sas: nothing to remove.');
    expect(process.exitCode).toBeUndefined();
  });

  it('stops a load asked without --yes and with no terminal to answer: exit 2, nothing written', async () => {
    // Its question waited for a terminal a CI step does not have: the job
    // hung until its timeout, or exited 0 having loaded nothing.
    let stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      stderr += chunk;
      return true;
    }) as never);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    await expect(main(argv('load', '--config', configPath, '--target', 'TGT'))).rejects.toThrow(
      'exit 2',
    );

    expect(stderr).toContain('Load the frozen dataset into TGT? [y/N]');
    expect(stderr).toContain('no terminal to answer: give --yes');
    expect(printed.join('')).not.toContain('loading into');
  });

  it('refuses --dry-run=true, which it dropped and loaded for real, before any org is reached', async () => {
    let stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      stderr += chunk;
      return true;
    }) as never);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    vi.mocked(makeConn).mockClear();

    await expect(
      main(argv('load', '--config', configPath, '--target', 'TGT', '--dry-run=true', '--yes')),
    ).rejects.toThrow('exit 2');

    expect(makeConn).not.toHaveBeenCalled();
    expect(stderr).toContain('"--dry-run=true" is not read');
  });
});

describe('what a sweep of a load is asked, and what the removal says', () => {
  it('asks the panel’s handler for what came late and what is tied to nothing only when told', () => {
    const line = ['remove', '--config', 'c.json', '--target', 'TGT'];

    expect(removalAsked(parseArgs(argv(...line, '--sweep')))).toEqual({ sweep: true });
    expect(
      removalAsked(parseArgs(argv(...line, '--sweep', '--sweep-late', '--sweep-untied'))),
    ).toEqual({ sweep: true, sweepLate: true, sweepUntied: true });
    expect(removalAsked(parseArgs(argv(...line)))).toEqual({});
  });

  it('names the platform’s copies beside their object, and what the automation likely made that kept records', () => {
    const lines = messageLines({
      type: 'frozen:remove:response',
      payload: {
        result: {
          status: 'partial',
          objects: [
            {
              objectApiName: 'QuoteLineItem',
              planned: 4,
              deleted: 4,
              alreadyGone: 0,
              keptChanged: 0,
              keptDependents: 0,
              refused: 0,
              heldBy: [],
              platformCopies: 2,
              unchecked: [],
              reasons: [],
            },
            {
              objectApiName: 'Account',
              planned: 1,
              deleted: 0,
              alreadyGone: 0,
              keptChanged: 0,
              keptDependents: 1,
              refused: 0,
              heldBy: ['Task'],
              heldByAutomation: 1,
              automationHolders: ['Task'],
              unchecked: [],
              reasons: [],
            },
          ],
        },
      },
    });

    expect(lines).toContain(
      '  QuoteLineItem: 4 deleted of 4 (2 the run wrote, and 2 the platform copied between the quote the run synced and its opportunity)',
    );
    expect(lines).toContain(
      "1 record(s) of the run kept for records created under them during the run, as its user, likely by the target's automation (Task): --sweep takes them first (--sweep-list shows them)",
    );
  });
});

describe('the exit code of a step', () => {
  const verdict = (status: string) => ({
    type: 'frozen:verify:result',
    payload: { verdict: { status } },
  });

  it('gives a verification its verdict, as sandforge-clone --verify does', () => {
    // A FAILED, PARTIAL or UNSTABLE verdict exited 0: only an error failed the step.
    expect(frozenStepExit('verify', [verdict('passed')])).toBe(0);
    expect(frozenStepExit('verify', [verdict('failed')])).toBe(1);
    expect(frozenStepExit('verify', [verdict('partial')])).toBe(3);
    expect(frozenStepExit('verify', [verdict('unstable')])).toBe(4);
  });

  it('gives a load that completed with errors 3, judged by its own report', () => {
    const load = (status: string) => ({
      type: 'frozen:load:response',
      payload: { report: { status } },
    });
    expect(frozenStepExit('load', [load('completed'), verdict('passed')])).toBe(0);
    expect(frozenStepExit('load', [load('completed-with-errors'), verdict('passed')])).toBe(3);
    // The verification a load runs after it is said; `verify` gives it a code.
    expect(frozenStepExit('load', [load('completed'), verdict('unstable')])).toBe(0);
  });

  it('gives a reload whose sweep did not take all it was to 3, as the removal its sweep belongs to', () => {
    const reload = (...statuses: string[]) => ({
      type: 'frozen:load:response',
      payload: {
        report: {
          status: 'completed',
          sweeps: statuses.map((status, n) => ({
            loadedAt: `2026-10-0${n + 1}T10:00:00.000Z`,
            result: { status, objects: [], unread: [], handWork: [] },
          })),
        },
      },
    });
    expect(frozenStepExit('load', [reload('success', 'success')])).toBe(0);
    expect(frozenStepExit('load', [reload('success', 'refused')])).toBe(3);
    expect(frozenStepExit('load', [reload('partial')])).toBe(3);
    expect(frozenStepExit('load', [reload('cancelled')])).toBe(3);
  });

  it('says what the sweep of each load a reload replaced did, after its purge', () => {
    const lines = messageLines({
      type: 'frozen:load:response',
      payload: {
        report: {
          status: 'completed',
          durationMs: 1,
          alignment: { excludedObjects: [], removals: [], recordTypeIssues: [] },
          placeholders: [],
          perObject: [],
          pass2: { resolved: 0, unresolved: [] },
          purge: { deleted: { Contact: 30 }, deactivated: {}, failures: [] },
          sweeps: [
            {
              loadedAt: '2026-10-01T10:05:00.000Z',
              result: {
                status: 'success',
                objects: [
                  {
                    objectApiName: 'Task',
                    found: 30,
                    deleted: 30,
                    alreadyGone: 0,
                    keptChanged: 0,
                    refused: 0,
                    reasons: [],
                  },
                ],
                unread: [],
                handWork: [],
              },
            },
          ],
        },
      },
    });

    const purge = lines.indexOf('purge of earlier loads: 30 deleted, 0 deactivated, 0 failed');
    expect(purge).toBeGreaterThanOrEqual(0);
    expect(lines.slice(purge + 1, purge + 4)).toEqual([
      'sweep of the load of 2026-10-01T10:05:00.000Z:',
      'sweep: SUCCESS',
      '  Task: 30 deleted of 30',
    ]);
  });

  it('says what a removal’s sweep did for each other load it swept, after its own', () => {
    const sweep = (deleted: number) => ({
      status: 'success',
      objects: [
        {
          objectApiName: 'Task',
          found: deleted,
          deleted,
          alreadyGone: 0,
          keptChanged: 0,
          refused: 0,
          reasons: [],
        },
      ],
      unread: [],
      handWork: [],
    });
    const lines = messageLines({
      type: 'frozen:remove:response',
      payload: {
        result: {
          status: 'success',
          objects: [],
          sweep: sweep(30),
          otherLoadSweeps: [{ loadedAt: '2026-10-01T10:05:00.000Z', result: sweep(60) }],
        },
      },
    });

    expect(lines).toEqual([
      'sweep: SUCCESS',
      '  Task: 30 deleted of 30',
      'sweep of the load of 2026-10-01T10:05:00.000Z:',
      'sweep: SUCCESS',
      '  Task: 60 deleted of 60',
    ]);
  });

  it('lists, with --sweep-list, what the sweep takes for each other load apart, by the load', () => {
    const listing = (count: number) => ({
      window: { from: '2026-10-01T10:00:00Z', to: '2026-10-01T10:06:00Z' },
      looked: ['Task'],
      found: [
        {
          objectApiName: 'Task',
          count,
          names: [],
          classes: { made: count, madeOver: 0, late: 0, untied: 0 },
        },
      ],
      unread: [],
      handWork: [],
    });
    const alone = messageLines({
      type: 'frozen:remove:sweep:response',
      payload: { loadedAt: '2026-10-02T10:05:00.000Z', listing: listing(1) },
    });
    const both = messageLines({
      type: 'frozen:remove:sweep:response',
      payload: {
        loadedAt: '2026-10-02T10:05:00.000Z',
        listing: listing(1),
        otherLoads: [{ loadedAt: '2026-10-01T10:05:00.000Z', listing: listing(30) }],
      },
    });

    expect(alone.join('\n')).not.toContain('sweep of the load of');
    expect(both.filter((line) => line.startsWith('sweep of the load of'))).toEqual([
      'sweep of the load of 2026-10-02T10:05:00.000Z:',
      'sweep of the load of 2026-10-01T10:05:00.000Z:',
    ]);
    expect(both.join('\n')).toContain('  Task: 30 — 30 made for the run');
  });

  it('gives a removal that left records of the load 3, as the other removals give it', () => {
    const removal = (status: string) => ({
      type: 'frozen:remove:response',
      payload: { result: { status } },
    });
    expect(frozenStepExit('remove', [removal('success')])).toBe(0);
    expect(frozenStepExit('remove', [removal('partial')])).toBe(3);
    expect(frozenStepExit('status', [{ type: 'frozen:status:response', payload: {} }])).toBe(0);
  });
});

describe('failsTheStep', () => {
  it('fails on an error, but for a removal that has nothing to take', () => {
    const removal = (code: string) => ({
      type: 'frozen:remove:error',
      payload: { message: 'refused', code },
    });

    expect(failsTheStep(removal('ALREADY_REMOVED'))).toBe(false);
    expect(failsTheStep(removal('NOTHING_TO_REMOVE'))).toBe(false);
    expect(failsTheStep(removal('NO_LOAD'))).toBe(false);
    expect(failsTheStep(removal('LOAD_CHANGED'))).toBe(true);
    expect(failsTheStep(removal('GUARD_DECLINED'))).toBe(true);
    expect(
      failsTheStep({ type: 'frozen:load:error', payload: { message: 'x', code: 'NO_LOAD' } }),
    ).toBe(true);
    expect(failsTheStep({ type: 'frozen:remove:response', payload: {} })).toBe(false);
    expect(messageLines(removal('ALREADY_REMOVED'))).toEqual(['nothing to remove: refused']);
  });
});

describe('commandLineOtherRuns', () => {
  let dir: string;
  const ORG = '00D000000000001AAA';
  /** When the load being removed wrote. */
  const WRITTEN = { first: '2026-11-03T15:00:00.000Z', last: '2026-11-03T15:05:00.000Z' };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sandforge-frozen-other-runs-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A Sync run's file in the folder, as sandforge-sync keeps one. */
  function syncRan(runId: string, from: string, to: string, ids: string[]): void {
    mkdirSync(join(dir, 'sync-runs'), { recursive: true });
    const lines = [
      {
        run: {
          runId,
          configId: 'sandforge-sync',
          configName: runId,
          sourceOrgId: 'SRC',
          targetOrgId: 'TGT',
          targetOrganizationId: ORG,
          startedAt: from,
        },
      },
      { object: 'Task', created: ids, at: from },
      { end: { at: to, status: 'success' } },
    ];
    writeFileSync(
      join(dir, 'sync-runs', `${runId}.ndjson`),
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    );
  }

  it('names a Sync run of this machine that wrote in the load’s window, which a sweep then never takes', async () => {
    syncRan('beside', '2026-11-03T15:02:00.000Z', '2026-11-03T15:03:00.000Z', [
      '00T000000000007AAA',
    ]);
    const runs = await commandLineOtherRuns('TGT', dir)(ORG, WRITTEN);
    expect(otherRunsInSweep(WRITTEN, runs)).toEqual([{ ids: ['00T000000000007AAA'] }]);
  });

  it('names none written well apart from the load, and none when the load’s window is not known', async () => {
    syncRan('before', '2026-11-03T10:00:00.000Z', '2026-11-03T10:01:00.000Z', [
      '00T000000000008AAA',
    ]);
    expect(await commandLineOtherRuns('TGT', dir)(ORG, WRITTEN)).toEqual([]);
    expect(await commandLineOtherRuns('TGT', dir)(ORG, undefined)).toEqual([]);
  });
});
