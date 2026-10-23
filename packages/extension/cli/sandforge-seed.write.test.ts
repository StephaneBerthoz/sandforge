import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from 'jsforce';

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./sfSession.js', () => ({
  loadOrg: vi.fn(async (alias: string) => ({ alias })),
  makeConn: vi.fn(),
}));
vi.mock('./sandforge-clone.js', async (original) => ({
  ...(await original<typeof import('./sandforge-clone.js')>()),
  targetAutomationReader: vi.fn(() => ({
    read: async () => ({ objectsRead: [], objects: [], unread: [] }),
  })),
}));
// The removal is Forge's, tested with it: here, what it is handed from a run's file.
vi.mock('../src/modules/forge/ForgeRunRemoval.js', async (original) => ({
  ...(await original<typeof import('../src/modules/forge/ForgeRunRemoval.js')>()),
  removalOrg: vi.fn(),
}));

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadOrg, makeConn } from './sfSession.js';
import { removalOrg } from '../src/modules/forge/ForgeRunRemoval.js';
import { MemoryRemovalOrg } from '../src/test/memoryRemovalOrg.js';
import { readRunFile } from '../src/modules/sync/SyncRunCreations.js';
import { main, seedInterruptedLine, seedWritePathOf } from './sandforge-seed.js';
import type { BulkJobHandle } from '../src/core/engine/BulkApiExecutor.js';

/** Asset, as the fake org describes it: a name to fill, nothing else required. */
const ASSET = {
  name: 'Asset',
  createable: true,
  recordTypeInfos: [],
  fields: [
    { name: 'Id', type: 'id', createable: false, nillable: false, length: 18 },
    { name: 'Name', type: 'string', createable: true, nillable: false, length: 80 },
  ].map((f) => ({ referenceTo: [], defaultedOnCreate: false, picklistValues: [], ...f })),
};

/**
 * An org that takes every Asset it is sent, through REST or a Bulk API job,
 * and runs nothing as they are created. `onCreate` is told of each REST call
 * before it is answered. It says it is a sandbox, unless `kind` says otherwise.
 */
function fakeOrg(
  onCreate: () => void | Promise<void> = () => {},
  kind: Record<string, unknown> = { IsSandbox: true },
  refusedFrom = Infinity,
) {
  const restCalls: number[] = [];
  const jobs: number[] = [];
  let made = 0;
  const id = (): string => `02i${String(made++).padStart(12, '0')}AAA`;
  const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });
  const conn = {
    sobject: () => ({
      describe: async () => ASSET,
      create: async (sent: unknown[]) => {
        await onCreate();
        restCalls.push(sent.length);
        // The records of a call from `refusedFrom` on are refused.
        return sent.map((_, i) =>
          i >= refusedFrom
            ? { success: false, errors: [{ statusCode: 'X', message: 'refused' }] }
            : { success: true, id: id() },
        );
      },
    }),
    describe: async () => ASSET,
    describeGlobal: async () => ({ sobjects: [{ name: 'Asset', createable: true }] }),
    query: async (soql: string) =>
      soql.includes('FROM Organization') ? page([{ Id: '00D000000000002AAA', ...kind }]) : page([]),
    tooling: { query: async () => page([]) },
    request: async () => ({}),
    bulk2: {
      createJob: (): BulkJobHandle => {
        let sent = 0;
        return {
          id: '750000000000001AAA',
          open: async () => {},
          uploadData: async (csv: string) => {
            sent = csv.trim().split('\n').length - 1;
            jobs.push(sent);
          },
          close: async () => {},
          abort: async () => {},
          check: async () => ({ state: 'JobComplete', numberRecordsProcessed: sent }),
          getAllResults: async () =>
            Array.from({ length: sent }, () => ({ success: true, id: id() })),
        };
      },
    },
  };
  vi.mocked(makeConn).mockReturnValue(conn as unknown as Connection);
  return { restCalls, jobs };
}

/** A seed of `count` assets into TGT, with `extra` flags. */
function argv(count: number, ...extra: string[]): string[] {
  return [
    'node',
    'sandforge-seed.ts',
    '--target',
    'TGT',
    '--object',
    `Asset:${count}`,
    '--locale',
    'en_US',
    '--seed',
    '7',
    ...extra,
  ];
}

describe('a seed from the command line', () => {
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('writes an object of more than 200 records as a Bulk API job, as the panel does', async () => {
    const org = fakeOrg();

    await main(argv(250, '--json'));

    expect(org.restCalls).toEqual([]);
    expect(org.jobs).toEqual([250]);
    const summary = JSON.parse(stdout.join('')) as {
      result: { objectResults: Array<{ recordsCreated: number }> };
    };
    expect(summary.result.objectResults[0].recordsCreated).toBe(250);
  });

  it('writes 200 records or fewer through REST, --batch-size a call', async () => {
    const org = fakeOrg();

    await main(argv(150, '--batch-size', '50', '--json'));

    expect(org.jobs).toEqual([]);
    expect(org.restCalls).toEqual([50, 50, 50]);
  });

  it('says on a dry run how each object would be written, and writes nothing', async () => {
    const org = fakeOrg();

    await main(argv(10_500, '--dry-run'));

    expect(org.jobs).toEqual([]);
    expect(org.restCalls).toEqual([]);
    // Generated and written ten thousand at a time: a job for each slice.
    expect(stdout.join('')).toContain(
      '[dry-run] Asset: 10000 record(s) (a Bulk API job, or REST when an active duplicate rule watches the object)',
    );
    expect(stdout.join('')).toContain(
      '[dry-run] Asset: 500 record(s) (a Bulk API job, or REST when an active duplicate rule watches the object)',
    );
    expect(seedWritePathOf(201, 200)).toBe(
      '(a Bulk API job, or REST when an active duplicate rule watches the object)',
    );
    expect(seedWritePathOf(200, 200)).toBe('(REST)');
  });

  it('stops at Ctrl-C before its next call, says what it wrote, and exits 130', async () => {
    const org = fakeOrg(() => {
      if (org.restCalls.length === 0) process.emit('SIGINT');
    });

    await main(argv(150, '--batch-size', '50', '--json'));

    expect(org.restCalls).toEqual([50]);
    const summary = JSON.parse(stdout.join('')) as {
      interrupted?: boolean;
      runFile?: string;
      result: { objectResults: Array<{ createdIds: string[] }> };
    };
    expect(summary.interrupted).toBe(true);
    expect(summary.result.objectResults[0].createdIds).toHaveLength(50);
    expect(summary.runFile).toBeDefined();
    expect(stderr.join('')).toContain(seedInterruptedLine(summary.runFile));
    expect(process.exitCode).toBe(130);
    expect(process.listenerCount('SIGINT')).toBe(0);
  });

  it('stops at a SIGTERM, as Jenkins sends on abort or timeout, as at Ctrl-C, and exits 143', async () => {
    const org = fakeOrg(() => {
      if (org.restCalls.length === 0) process.emit('SIGTERM');
    });

    await main(argv(150, '--batch-size', '50', '--json'));

    expect(org.restCalls).toEqual([50]);
    expect(JSON.parse(stdout.join(''))).toMatchObject({ interrupted: true });
    expect(process.exitCode).toBe(143);
    expect(process.listenerCount('SIGTERM')).toBe(0);
    expect(process.listenerCount('SIGHUP')).toBe(0);
  });

  it('writes nothing to a production org, refused before anything is read, and exits 1', async () => {
    // The seed went from the session to its writes: its own --remove refuses
    // such an org, so what it wrote there stayed.
    const org = fakeOrg(undefined, { IsSandbox: false, OrganizationType: 'Enterprise Edition' });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    await expect(main(argv(10))).rejects.toThrow('exit 1');

    expect(org.restCalls).toEqual([]);
    expect(stderr.join('')).toContain(
      'TGT is a production org (its Organization record says IsSandbox false, edition ' +
        'Enterprise Edition): sandforge-seed writes to sandboxes and Developer Edition orgs ' +
        'only. Nothing was written; --dry-run, which only reads, runs against it.',
    );
  });

  it('dry-runs against a production org all the same, which only reads', async () => {
    const org = fakeOrg(undefined, { IsSandbox: false, OrganizationType: 'Enterprise Edition' });

    await main(argv(10, '--dry-run'));

    expect(org.restCalls).toEqual([]);
    expect(stdout.join('')).toContain('[dry-run] Asset: 10 record(s) (REST)');
  });

  it('exits 1 when the org refused every record, and 3 for a partial run with --fail-on-partial', async () => {
    // Every record refused, the seed exited 0 as one that wrote them all.
    fakeOrg(undefined, undefined, 0);
    await main(argv(4, '--json'));
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    fakeOrg(undefined, undefined, 2);
    await main(argv(4, '--json'));
    expect(process.exitCode).toBeUndefined();
    await main(argv(4, '--json', '--fail-on-partial'));
    expect(process.exitCode).toBe(3);
  });

  it('refuses --dry-run=true, the way a pipeline writes --dry-run=$DRY_RUN, before any org is reached', async () => {
    // Dropped without a word, it seeded for real.
    const org = fakeOrg();
    vi.mocked(makeConn).mockClear();
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    await expect(main(argv(10, '--dry-run=true'))).rejects.toThrow('exit 2');

    expect(makeConn).not.toHaveBeenCalled();
    expect(org.restCalls).toEqual([]);
    expect(stderr.join('')).toContain('"--dry-run=true" is not read');
  });

  it('refuses --target followed by --dry-run, which it took for the alias, before any org is reached', async () => {
    // `--target --dry-run` logged in to an org named "--dry-run", and the run
    // was no dry run.
    const org = fakeOrg();
    vi.mocked(loadOrg).mockClear();
    vi.mocked(makeConn).mockClear();
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    await expect(
      main(['node', 'sandforge-seed.ts', '--target', '--dry-run', '--object', 'Asset:10']),
    ).rejects.toThrow('exit 2');

    expect(loadOrg).not.toHaveBeenCalled();
    expect(makeConn).not.toHaveBeenCalled();
    expect(org.restCalls).toEqual([]);
    expect(stderr.join('')).toContain('--target wants a value. Nothing was run.');
  });

  it('keeps what it creates in its file insert by insert, and --remove takes back a run killed before it printed its summary', async () => {
    // The ids were in memory alone until the run printed its summary: a kill
    // by the job's timeout, an OOM, or an error thrown out of the run left
    // its records in the org with nothing --remove could read.
    let file: string | undefined;
    let atKill: string | undefined;
    const org = fakeOrg(async () => {
      if (org.restCalls.length !== 1) return;
      // The second call is under way, the org taking its time: what is on
      // disk once the first call's answer is written is what a kill here
      // would have left. Waited for, not timed: after 50 ms a Windows
      // runner's disk had not taken the line yet.
      const until = Date.now() + 5_000;
      do {
        file = /run file: (\S+)/.exec(stderr.join(''))?.[1];
        atKill = file && existsSync(file) ? readFileSync(file, 'utf8') : undefined;
        if ((readRunFile(atKill ?? '')?.created.length ?? 0) > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      } while (Date.now() < until);
    });

    await main(argv(100, '--batch-size', '50', '--json'));

    expect(file).toBeDefined();
    expect(readRunFile(atKill ?? '')?.created).toEqual([
      { objectApiName: 'Asset', ids: expect.arrayContaining([expect.any(String)]) },
    ]);
    const firstCall = readRunFile(atKill ?? '')?.created[0]?.ids ?? [];
    expect(firstCall).toHaveLength(50);
    expect(readRunFile(atKill ?? '')?.end).toBeUndefined();

    // Killed there: the file as it stood, its records in the org.
    writeFileSync(file as string, atKill as string);
    const memory = new MemoryRemovalOrg();
    for (const id of firstCall)
      memory.add('Asset', { Id: id }, new Date(Date.now() - 60_000).toISOString());
    vi.mocked(removalOrg).mockReturnValue(memory);
    const runId = readRunFile(atKill ?? '')?.runId ?? '';
    stdout.length = 0;

    await main(['node', 'sandforge-seed.ts', '--remove', runId, '--target', 'TGT', '--json']);

    expect(memory.all('Asset')).toEqual([]);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      result: { status: 'success', planned: 50 },
    });
  });
});
