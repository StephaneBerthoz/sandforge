import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const automationRead = vi.fn(async () => ({ objectsRead: [], objects: [], unread: [] }));
vi.mock('./sandforge-clone.js', async (original) => ({
  ...(await original<typeof import('./sandforge-clone.js')>()),
  targetAutomationReader: vi.fn(() => ({ read: automationRead })),
}));

import { makeConn } from './sfSession.js';
import { removalOrg } from '../src/modules/forge/ForgeRunRemoval.js';
import { listSweep, sweepRunRecords } from '../src/modules/forge/ForgeRunSweep.js';
import { main } from './sandforge-sync.js';

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
    vi.mocked(sweepRunRecords).mockReset();
    vi.mocked(listSweep).mockReset();
    automationRead.mockClear();
    dir = mkdtempSync(join(tmpdir(), 'sandforge-sync-sweep-'));
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
  });

  it('sweeps before the run’s records go, handing the sweep every record the run created to leave alone', async () => {
    const order: string[] = [];
    vi.mocked(sweepRunRecords).mockImplementation(async (_org, input, options) => {
      order.push(`sweep, ${org.deletes.length} delete(s) before`);
      expect(input.created).toEqual([
        { objectApiName: 'Account', ids: [A1] },
        { objectApiName: 'Contact', ids: [C1] },
        { objectApiName: 'ContentDocument', ids: [DOC] },
      ]);
      expect([A1, C1, DOC].every((id) => input.remap.has(id.slice(0, 15)))).toBe(true);
      expect(options.includeChanged).toBe(false);
      return {
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
      };
    });

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
      found: [{ objectApiName: 'Task', count: 1, names: ['Follow up'] }],
      unread: [],
      handWork: [],
      window: { from: '2026-10-18T09:00:00Z', to: '2026-10-18T09:01:00Z' },
    });

    await main(argv('--remove', file, '--target', 'TGT', '--sweep-list'));

    expect(listSweep).toHaveBeenCalledTimes(1);
    expect(sweepRunRecords).not.toHaveBeenCalled();
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

  it('removes without sweeping unless asked', async () => {
    await main(argv('--remove', file, '--target', 'TGT', '--json'));

    expect(sweepRunRecords).not.toHaveBeenCalled();
    expect(JSON.parse(stdout).result.sweep).toBeUndefined();
  });
});
