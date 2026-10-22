import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from 'jsforce';
import { MemoryRemovalOrg } from '../src/test/memoryRemovalOrg.js';

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
  sweepRunRecords: vi.fn(),
  listSweep: vi.fn(),
}));
vi.mock('./sandforge-clone.js', async (original) => ({
  ...(await original<typeof import('./sandforge-clone.js')>()),
  targetAutomationReader: vi.fn(() => ({
    read: async () => ({ objectsRead: [], objects: [], unread: [] }),
  })),
}));

import { makeConn } from './sfSession.js';
import { removalOrg } from '../src/modules/forge/ForgeRunRemoval.js';
import { listSweep, sweepRunRecords } from '../src/modules/forge/ForgeRunSweep.js';
import { syncRemovalPlan } from '../src/modules/sync/SyncRunCreations.js';
import { main, parseRemoveArgs, readRunSummary, runOfSummary } from './sandforge-seed.js';

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const ORG_ID = '00D000000000001AAA';
const A1 = fakeId('001', 1);
const A2 = fakeId('001', 2);
const C1 = fakeId('003', 1);
const C2 = fakeId('003', 2);

const argv = (...args: string[]): string[] => ['node', 'sandforge-seed.ts', ...args];

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
    });
    expect(
      parseRemoveArgs(argv('--remove', 'run.json', '--target', 'TGT', '--leave-undeletable')),
    ).toMatchObject({ leaveUndeletable: true });
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
    vi.mocked(sweepRunRecords).mockReset();
    vi.mocked(listSweep).mockReset();
    dir = mkdtempSync(join(tmpdir(), 'sandforge-seed-remove-'));
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

  it('sweeps before the run’s records go, handing the sweep every record the run created to leave alone', async () => {
    const order: string[] = [];
    vi.mocked(sweepRunRecords).mockImplementation(async (_org, input, options) => {
      order.push(`sweep, ${org.deletes.length} delete(s) before`);
      expect(input.created).toEqual([
        { objectApiName: 'Account', ids: [A1, A2] },
        { objectApiName: 'Contact', ids: [C1, C2] },
      ]);
      expect([A1, A2, C1, C2].every((id) => input.remap.has(id.slice(0, 15)))).toBe(true);
      expect(options.includeChanged).toBe(false);
      return {
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
      };
    });

    await main(argv('--remove', file, '--target', 'TGT', '--sweep', '--json'));

    expect(order).toEqual(['sweep, 0 delete(s) before']);
    expect(org.all('Contact')).toEqual([]);
    expect(JSON.parse(stdout)).toMatchObject({
      result: { status: 'success', sweep: { status: 'success', objects: [{ deleted: 2 }] } },
    });
  });

  it('exits 3 when the sweep was refused, whatever the removal took', async () => {
    vi.mocked(sweepRunRecords).mockResolvedValue({
      status: 'refused',
      refusal: 'hand work',
      objects: [],
      unread: [],
      handWork: [],
    });
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
      found: [{ objectApiName: 'Task', count: 2, names: ['Welcome call'] }],
      unread: [],
      handWork: [],
      window: { from: '2026-10-18T09:00:00Z', to: '2026-10-18T09:01:00Z' },
    });

    await main(argv('--remove', file, '--target', 'TGT', '--sweep-list'));

    expect(listSweep).toHaveBeenCalledTimes(1);
    expect(sweepRunRecords).not.toHaveBeenCalled();
    expect(org.deletes).toEqual([]);
    expect(stdout).toContain('Task');
    expect(existsSync(join(dir, 'seed.removals.json'))).toBe(false);
  });

  it('refuses an org that is not the one the run wrote to', async () => {
    writeFileSync(file, JSON.stringify(summary({ targetOrgId: '00D000000000002AAA' })));
    const exit = stubExit();

    await expect(main(argv('--remove', file, '--target', 'OTHER'))).rejects.toThrow('exit 1');

    expect(exit.stderr()).toContain('is not the org the run wrote to');
    expect(org.deletes).toEqual([]);
  });
});
