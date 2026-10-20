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

import { makeConn } from './sfSession.js';
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
 * before it is answered.
 */
function fakeOrg(onCreate: () => void = () => {}) {
  const restCalls: number[] = [];
  const jobs: number[] = [];
  let made = 0;
  const id = (): string => `02i${String(made++).padStart(12, '0')}AAA`;
  const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });
  const conn = {
    sobject: () => ({
      describe: async () => ASSET,
      create: async (sent: unknown[]) => {
        onCreate();
        restCalls.push(sent.length);
        return sent.map(() => ({ success: true, id: id() }));
      },
    }),
    describe: async () => ASSET,
    describeGlobal: async () => ({ sobjects: [{ name: 'Asset', createable: true }] }),
    query: async (soql: string) =>
      soql.includes('FROM Organization') ? page([{ Id: '00D000000000002AAA' }]) : page([]),
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
    expect(stdout.join('')).toContain(
      '[dry-run] Asset: 10500 record(s) (one Bulk API job, its records gathered 2000 at a time)',
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
      result: { objectResults: Array<{ createdIds: string[] }> };
    };
    expect(summary.interrupted).toBe(true);
    expect(summary.result.objectResults[0].createdIds).toHaveLength(50);
    expect(stderr.join('')).toContain(seedInterruptedLine());
    expect(process.exitCode).toBe(130);
    expect(process.listenerCount('SIGINT')).toBe(0);
  });
});
