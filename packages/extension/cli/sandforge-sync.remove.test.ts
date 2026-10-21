import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from 'jsforce';
import { MemoryRemovalOrg } from '../src/test/memoryRemovalOrg.js';
import { nodeSyncIdMap } from '../src/modules/sync/SyncIdMap.js';

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

import { makeConn } from './sfSession.js';
import { removalOrg } from '../src/modules/forge/ForgeRunRemoval.js';
import {
  cliAllowsDeletes,
  configurationToldLines,
  main,
  memoryCreations,
  parseRemoveArgs,
  readRunSummary,
  removalRefusal,
  removalsPathOf,
  runOfSummary,
  savedConfigStore,
} from './sandforge-sync.js';

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const ORG_ID = '00D000000000001AAA';
const A1 = fakeId('001', 1);
const A2 = fakeId('001', 2);
const C1 = fakeId('003', 1);

const argv = (...args: string[]): string[] => ['node', 'sandforge-sync.ts', ...args];

/** A run ten minutes ago that created two accounts and a contact. */
function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
        { objectApiName: 'Account', ids: [A1, A2] },
        { objectApiName: 'Contact', ids: [C1] },
      ],
    },
    elapsedMs: 900,
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

describe('parseRemoveArgs', () => {
  it('reads the summary, the target and the two switches', () => {
    expect(
      parseRemoveArgs(
        argv('--remove', 'run.json', '--target', 'TGT', '--include-changed', '--json'),
      ),
    ).toEqual({
      summaryPath: 'run.json',
      target: 'TGT',
      includeChanged: true,
      json: true,
      sweep: false,
      sweepList: false,
    });
    expect(
      parseRemoveArgs(argv('--remove', 'run.json', '--target', 'TGT', '--store', 'state')),
    ).toEqual({
      summaryPath: 'run.json',
      target: 'TGT',
      includeChanged: false,
      json: false,
      store: 'state',
      sweep: false,
      sweepList: false,
    });
    expect(
      parseRemoveArgs(argv('--remove', 'run.json', '--target', 'TGT', '--sweep')),
    ).toMatchObject({ sweep: true, sweepList: false });
    expect(
      parseRemoveArgs(argv('--remove', 'run.json', '--target', 'TGT', '--sweep-list')),
    ).toMatchObject({ sweep: false, sweepList: true });
  });

  it('refuses a sweep and its listing asked together', () => {
    const exit = stubExit();
    expect(() =>
      parseRemoveArgs(argv('--remove', 'run.json', '--target', 'TGT', '--sweep', '--sweep-list')),
    ).toThrow('exit 2');
    expect(exit.stderr()).toContain('give one of them');
  });

  it('refuses a flag a removal does not read, and a line without its target', () => {
    const exit = stubExit();
    expect(() =>
      parseRemoveArgs(argv('--remove', 'run.json', '--target', 'TGT', '--object', 'Account')),
    ).toThrow('exit 2');
    expect(exit.stderr()).toContain('not "--object"');
    expect(() => parseRemoveArgs(argv('--remove', 'run.json'))).toThrow('exit 2');
  });
});

describe('readRunSummary', () => {
  it('reads the summary a run printed with --json', () => {
    const read = readRunSummary(JSON.stringify(summary()));
    expect('summary' in read && read.summary.created?.objects).toEqual([
      { objectApiName: 'Account', ids: [A1, A2] },
      { objectApiName: 'Contact', ids: [C1] },
    ]);
  });

  it('refuses what it cannot take a run back from, before any org is contacted', () => {
    expect(readRunSummary('not json')).toEqual({
      refusal: 'is not JSON: save the output of a run printed with --json.',
    });
    expect(readRunSummary(JSON.stringify({ ...summary(), tool: 'sandforge-clone' }))).toMatchObject(
      { refusal: expect.stringContaining('is not the summary of a sandforge-sync run') },
    );
    expect(readRunSummary(JSON.stringify(summary({ dryRun: true })))).toMatchObject({
      refusal: expect.stringContaining('dry run'),
    });
    expect(readRunSummary(JSON.stringify(summary({ created: undefined })))).toMatchObject({
      refusal: expect.stringContaining('names nothing the run created'),
    });
    // An id that is not one never reaches a delete.
    const forged = summary();
    (forged.created as { objects: Array<{ ids: string[] }> }).objects[0].ids = ["x' OR Id != '"];
    expect(readRunSummary(JSON.stringify(forged))).toMatchObject({
      refusal: expect.stringContaining('created.objects.0.ids.0'),
    });
  });
});

describe('what the command takes back, and from where', () => {
  it('keeps what earlier removals left beside the summary, never in it', () => {
    expect(removalsPathOf('runs/run.json')).toBe('runs/run.removals.json');
    expect(removalsPathOf('run.out')).toBe('run.out.removals.json');
  });

  it('reads the run a summary names as the removal reads a kept run', () => {
    const read = readRunSummary(JSON.stringify(summary()));
    if (!('summary' in read)) throw new Error('refused');
    expect(runOfSummary(read.summary)).toMatchObject({
      runId: 'sandforge-sync-1',
      created: [
        { objectApiName: 'Account', ids: [A1, A2] },
        { objectApiName: 'Contact', ids: [C1] },
      ],
      end: { status: 'success' },
    });
  });

  it('removes from a sandbox or a Developer Edition org, and refuses a production org', () => {
    expect(removalRefusal('TGT', { id: ORG_ID, sandbox: true })).toBeUndefined();
    expect(
      removalRefusal('TGT', { id: ORG_ID, sandbox: false, edition: 'Developer Edition' }),
    ).toBeUndefined();
    expect(
      removalRefusal('TGT', { id: ORG_ID, sandbox: false, edition: 'Enterprise Edition' }),
    ).toBe(
      'TGT is a production org (its Organization record says IsSandbox false, edition ' +
        'Enterprise Edition): sandforge-sync removes records from sandboxes and Developer ' +
        'Edition orgs only. Nothing was deleted.',
    );
  });

  it('replaces an attachment in a sandbox or a Developer Edition org, never in a production org', () => {
    // The earlier copy of a changed attachment goes once the new one is
    // written, where the guard lets the run delete: a Developer Edition org,
    // which says IsSandbox false, is typed as the panel types it.
    expect(cliAllowsDeletes({ id: ORG_ID, sandbox: true })).toBe(true);
    expect(cliAllowsDeletes({ id: ORG_ID, sandbox: false, edition: 'Developer Edition' })).toBe(
      true,
    );
    expect(cliAllowsDeletes({ id: ORG_ID, sandbox: false, edition: 'Enterprise Edition' })).toBe(
      false,
    );
    expect(cliAllowsDeletes({ id: ORG_ID, sandbox: false })).toBe(false);
  });

  it('names the configuration of a run it was given the store of, and says what it was told', () => {
    const read = readRunSummary(JSON.stringify(summary({ configId: 'cfg-1' })));
    if (!('summary' in read)) throw new Error('refused');
    expect(runOfSummary(read.summary)).toMatchObject({ configId: 'cfg-1' });

    expect(
      configurationToldLines('cfg-1', {
        readWhole: ['Account'],
        filesForgotten: 2,
        linksForgotten: 3,
      }),
    ).toEqual([
      'configuration cfg-1: its next run reads Account whole',
      'configuration cfg-1: 2 copied file(s) forgotten, copied again by its next run',
      'configuration cfg-1: 3 record(s) forgotten, which no later run points a lookup at',
    ]);
    expect(configurationToldLines(undefined, { readWhole: ['Account'] })).toEqual([]);
  });

  it('keeps in memory what a run created, each object in the order first written', () => {
    const kept = memoryCreations('run-1');
    kept.note('Account', [A1]);
    kept.note('Contact', [C1]);
    kept.note('Account', [A2]);
    kept.note('Account', []);

    expect(kept.created()).toEqual([
      { objectApiName: 'Account', ids: [A1, A2] },
      { objectApiName: 'Contact', ids: [C1] },
    ]);
    expect(kept.lastWrittenAt()).toEqual(expect.any(String));
  });

  it('keeps each id once, whichever length it is noted in and however often', () => {
    const kept = memoryCreations('run-1');
    kept.note('Account', [A1, A2]);
    kept.note('Account', [A1]);
    kept.note('Account', [A2.slice(0, 15)]);
    kept.note('Contact', [C1, C1]);

    expect(kept.created()).toEqual([
      { objectApiName: 'Account', ids: [A1, A2] },
      { objectApiName: 'Contact', ids: [C1] },
    ]);
  });

  it('dates its last write by the records it wrote again, adding nothing it created', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-14T08:00:05.000Z'));
      const kept = memoryCreations('run-1');
      kept.note('Account', [A1]);
      vi.setSystemTime(new Date('2026-10-14T08:00:40.000Z'));
      kept.touched?.('Account', 1);

      expect(kept.lastWrittenAt()).toBe('2026-10-14T08:00:40.000Z');
      expect(kept.created()).toEqual([{ objectApiName: 'Account', ids: [A1] }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dates its last write by its latest call, an update or an answer that created nothing included', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-14T08:00:05.000Z'));
      const kept = memoryCreations('run-1');
      kept.note('Account', [A1]);
      vi.setSystemTime(new Date('2026-10-14T08:02:00.000Z'));
      kept.writing?.('Account', 30);
      vi.setSystemTime(new Date('2026-10-14T08:03:10.000Z'));
      kept.answered?.('Contact', []);

      expect(kept.lastWriteAt()).toBe('2026-10-14T08:03:10.000Z');
      expect(kept.lastWrittenAt()).toBe('2026-10-14T08:00:05.000Z');
      expect(kept.firstWrittenAt()).toBe('2026-10-14T08:00:05.000Z');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('sandforge-sync --remove', () => {
  let dir: string;
  let file: string;
  let org: MemoryRemovalOrg;
  let edition: string;
  let stdout: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sandforge-sync-remove-'));
    file = join(dir, 'run.json');
    writeFileSync(file, JSON.stringify(summary()));
    org = new MemoryRemovalOrg({
      Account: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: true }],
    });
    const at = new Date(Date.now() - 10 * 60_000).toISOString();
    org.add('Account', { Id: A1 }, at);
    org.add('Account', { Id: A2 }, at);
    org.add('Contact', { Id: C1, AccountId: A1 }, at);
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

  it('removes from a Developer Edition org what the run created, children first, and keeps what it did beside the summary', async () => {
    await main(argv('--remove', file, '--target', 'TGT', '--json'));

    expect(org.deletes.map((d) => d.objectApiName)).toEqual(['Contact', 'Account']);
    expect(org.all('Account')).toEqual([]);
    expect(JSON.parse(stdout)).toMatchObject({
      action: 'remove',
      result: { status: 'success', planned: 3 },
    });
    const removals = JSON.parse(readFileSync(join(dir, 'run.removals.json'), 'utf8'));
    expect(removals).toMatchObject({ runId: 'sandforge-sync-1', undo: { deleted: 3 } });

    // A second removal of the summary finds nothing left, and asks nothing of the org.
    stdout = '';
    vi.mocked(makeConn).mockClear();
    await main(argv('--remove', file, '--target', 'TGT', '--json'));
    expect(JSON.parse(stdout)).toMatchObject({ result: { status: 'success', planned: 0 } });
    expect(makeConn).not.toHaveBeenCalled();
  });

  it('refuses a production org, deleting nothing', async () => {
    edition = 'Enterprise Edition';
    const exit = stubExit();

    await expect(main(argv('--remove', file, '--target', 'TGT'))).rejects.toThrow('exit 1');

    expect(exit.stderr()).toContain('TGT is a production org');
    expect(org.deletes).toEqual([]);
    expect(existsSync(join(dir, 'run.removals.json'))).toBe(false);
  });

  it('refuses an org that is not the one the run wrote to', async () => {
    writeFileSync(file, JSON.stringify(summary({ targetOrgId: '00D000000000002AAA' })));
    const exit = stubExit();

    await expect(main(argv('--remove', file, '--target', 'OTHER'))).rejects.toThrow('exit 1');

    expect(exit.stderr()).toContain('is not the org the run wrote to');
    expect(org.deletes).toEqual([]);
  });

  describe('of a run of a saved configuration', () => {
    const watermark = {
      sourceOrgId: 'SRC',
      targetOrgId: 'TGT',
      objectApiName: 'Account',
      watermark: '2026-10-14T08:00:00.000Z',
      fingerprint: 'a'.repeat(64),
      recordedAt: '2026-10-14T08:01:00.000Z',
    };
    let state: string;

    beforeEach(() => {
      state = join(dir, 'state');
      writeFileSync(file, JSON.stringify(summary({ configId: 'cfg-1' })));
      const configs = savedConfigStore(state);
      configs.save({
        id: 'cfg-1',
        name: 'Accounts',
        description: '',
        sourceOrgId: 'SRC',
        targetOrgId: 'TGT',
        direction: 'source_to_target',
        mode: 'delta',
        objects: [],
        conflictStrategy: 'source_wins',
        enableRollback: false,
        createdAt: '2026-10-14T08:00:00.000Z',
        updatedAt: '2026-10-14T08:00:00.000Z',
      });
      configs.recordWatermark('cfg-1', watermark);
    });

    it('tells its store what it took, so that the next delta run reads those objects whole', async () => {
      await main(argv('--remove', file, '--target', 'TGT', '--store', state, '--json'));

      expect(JSON.parse(stdout)).toMatchObject({
        result: { status: 'success', readWhole: ['Account'] },
      });
      const delta = savedConfigStore(state).loadDelta('cfg-1');
      expect(delta.kind === 'stored' ? delta.state.entries : []).toEqual([
        { ...watermark, removedAt: expect.any(String) },
      ]);
    });

    it('has its store forget which source records the accounts it took were the copies of', async () => {
      const pairs = nodeSyncIdMap(state);
      const orgs = { sourceOrgId: 'SRC', targetOrgId: 'TGT' };
      await pairs.record('cfg-1', orgs, 'Account', [
        [fakeId('001', 101), A1],
        [fakeId('001', 102), A2],
        // A record of the target the run linked to, which it did not create: kept.
        [fakeId('001', 103), fakeId('001', 800)],
      ]);

      await main(argv('--remove', file, '--target', 'TGT', '--store', state, '--json'));

      expect(JSON.parse(stdout)).toMatchObject({ result: { linksForgotten: 2 } });
      expect([...(await nodeSyncIdMap(state).load('cfg-1', orgs)).values()]).toEqual([
        fakeId('001', 800),
      ]);
    });

    it('says, when its store was not given, that the next delta run is not told', async () => {
      const exit = stubExit();

      await main(argv('--remove', file, '--target', 'TGT', '--json'));

      expect(exit.stderr()).toContain('its store was not given');
      const delta = savedConfigStore(state).loadDelta('cfg-1');
      expect(delta.kind === 'stored' ? delta.state.entries : []).toEqual([watermark]);
    });

    it('refuses a store that holds no such configuration, and a store for a run of none, deleting nothing', async () => {
      const exit = stubExit();

      await expect(
        main(argv('--remove', file, '--target', 'TGT', '--store', join(dir, 'elsewhere'))),
      ).rejects.toThrow('exit 2');
      expect(exit.stderr()).toContain('holds no configuration cfg-1');

      writeFileSync(file, JSON.stringify(summary()));
      await expect(
        main(argv('--remove', file, '--target', 'TGT', '--store', state)),
      ).rejects.toThrow('exit 2');
      expect(exit.stderr()).toContain('names none');
      expect(org.deletes).toEqual([]);
    });
  });

  it('exits 3 when it leaves records of the run in the org, and takes them on the next removal', async () => {
    org.touch('Account', A2, new Date(Date.now() + 60_000).toISOString());
    const exit = stubExit();

    await expect(main(argv('--remove', file, '--target', 'TGT'))).rejects.toThrow('exit 3');
    expect(exit.code()).toBe(3);
    expect(org.all('Account').map((row) => row.Id)).toEqual([A2]);

    vi.mocked(process.exit).mockClear();
    await main(argv('--remove', file, '--target', 'TGT', '--include-changed'));

    expect(org.all('Account')).toEqual([]);
    expect(process.exit).not.toHaveBeenCalled();
  });
});
