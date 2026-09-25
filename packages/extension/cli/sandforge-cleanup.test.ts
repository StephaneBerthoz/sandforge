import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
// The session stays the real one unless a test gives the org it runs against.
vi.mock('./sfSession.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sfSession.js')>();
  return { ...actual, loadOrg: vi.fn(actual.loadOrg), makeConn: vi.fn(actual.makeConn) };
});

import type { Connection } from 'jsforce';
import { execFileSync } from 'node:child_process';
import { loadOrg, makeConn } from './sfSession.js';
import { main } from './sandforge-cleanup';

const mockExecFileSync = vi.mocked(execFileSync);

/** Thrown in place of `process.exit` so a test can read the code it was given. */
class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

/** A valid invocation, with `extra` flags appended. */
function argv(...extra: string[]): string[] {
  return ['node', 'sandforge-cleanup.ts', '--target', 'TGT', ...extra];
}

/** Run the CLI and return the exit code it stopped on, or the error it threw. */
async function run(args: string[]): Promise<number | undefined | Error> {
  try {
    await main(args);
    return undefined;
  } catch (err: unknown) {
    if (err instanceof ExitCalled) return err.code;
    return err as Error;
  }
}

/** Lines that call the script by a bare command name, which no install provides. */
const BARE_COMMAND_LINE = /^\s*(?:\*\s*)?sandforge-(clone|cleanup) --/;

describe('sandforge-cleanup', () => {
  let stdout: string;
  let stderr: string;

  beforeEach(() => {
    vi.clearAllMocks();
    stdout = '';
    stderr = '';
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new ExitCalled(typeof code === 'number' ? code : undefined);
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // A valid invocation stops at the org lookup.
    mockExecFileSync.mockImplementation(() => {
      throw new Error('sf org display reached');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /*
   * `--since` and `--max` were only checked after `sf org display` had handed
   * over a session, and a bad alias or object name exited 1 like a failed
   * delete. Every bad flag now exits 2 before the org is contacted.
   */
  it.each([
    ['a missing --target', ['node', 'sandforge-cleanup.ts', '--since', 'today']],
    ['a --target that is not an alias', ['node', 'sandforge-cleanup.ts', '--target', 'TGT&dir']],
    ['a --since carrying a SOQL clause', argv('--since', 'today OR Id != null')],
    ['a --since of zero days', argv('--since', 'last_n_days:0')],
    ['a --max that is not a number', argv('--max', 'abc')],
    ['a --max of zero', argv('--max', '0')],
    ['a --max that is not a whole number', argv('--max', '2.5')],
    ['an --objects name that is not an API name', argv('--objects', 'Bad Name')],
  ])('exits 2 on %s before the org is loaded', async (_label, args) => {
    expect(await run(args)).toBe(2);
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(stderr).not.toBe('');
  });

  it('reaches the org lookup when every flag is valid', async () => {
    const result = await run(
      argv('--since', 'last_n_days:7', '--max', '50', '--objects', 'Case,Contact', '--dry-run'),
    );

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('sf org display reached');
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it('shows the command the script is really run with', async () => {
    expect(await run(['node', 'sandforge-cleanup.ts', '--help'])).toBe(0);

    expect(stdout).toContain('pnpm exec tsx packages/extension/cli/sandforge-cleanup.ts');
    expect(stdout).toContain('pnpm build:shared');
    expect(stdout.split('\n').filter((line) => BARE_COMMAND_LINE.test(line))).toEqual([]);
  });

  it('names no bare command anywhere in the script source', () => {
    const source = readFileSync(join(__dirname, 'sandforge-cleanup.ts'), 'utf8');
    expect(source.split('\n').filter((line) => BARE_COMMAND_LINE.test(line))).toEqual([]);
  });

  describe('against an org', () => {
    let realLoadOrg: typeof loadOrg;
    let realMakeConn: typeof makeConn;
    let printed: string[];

    beforeEach(async () => {
      ({ loadOrg: realLoadOrg, makeConn: realMakeConn } =
        await vi.importActual<typeof import('./sfSession.js')>('./sfSession.js'));
      printed = [];
      vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
        printed.push(String(line));
      });
    });

    afterEach(() => {
      vi.mocked(loadOrg).mockImplementation(realLoadOrg);
      vi.mocked(makeConn).mockImplementation(realMakeConn);
    });

    it('finds the records past the first page when --max asks for more than a page holds', async () => {
      // A query answers with 2 000 records at most and a cursor to the rest:
      // asked for 3 000, the command found 2 000 and said that was all.
      const NEXT = '/services/data/v66.0/query/01g000000000001-2000';
      const cases = (from: number, count: number) =>
        Array.from({ length: count }, (_, i) => ({
          Id: `500${String(from + i).padStart(12, '0')}AAA`,
        }));
      const conn = {
        query: vi.fn(async (soql: string) =>
          soql.includes(' FROM User ')
            ? { records: [{ Id: '005000000000001AAA' }], done: true }
            : { records: cases(0, 2000), done: false, nextRecordsUrl: NEXT },
        ),
        queryMore: vi.fn().mockResolvedValue({ records: cases(2000, 1000), done: true }),
      };
      vi.mocked(loadOrg).mockResolvedValue({
        alias: 'TGT',
        username: 'user@example.com',
        instanceUrl: 'https://tgt.example.com',
        accessToken: 'token',
      });
      vi.mocked(makeConn).mockReturnValue(conn as unknown as Connection);

      expect(await run(argv('--objects', 'Case', '--max', '3000', '--dry-run'))).toBeUndefined();

      expect(conn.queryMore).toHaveBeenCalledWith(NEXT);
      expect(printed).toContain(`  ${'Case'.padEnd(40)} 3000  [dry-run]`);
    });

    it('deletes more than 200 records, 200 to a request', async () => {
      // jsforce sends every id of a delete in one request unless told it may
      // split them, and Salesforce refuses a request past 200: asked to
      // delete 450, the command printed an error and deleted none.
      const { Connection: JsforceConnection } =
        await vi.importActual<typeof import('jsforce')>('jsforce');
      const conn = new JsforceConnection({
        instanceUrl: 'https://tgt.example.com',
        accessToken: 'token',
        version: '66.0',
      });
      const ids = Array.from({ length: 450 }, (_, i) => `500${String(i).padStart(12, '0')}AAA`);
      vi.spyOn(conn, 'query').mockImplementation(((soql: string) =>
        Promise.resolve(
          soql.includes(' FROM User ')
            ? { records: [{ Id: '005000000000001AAA' }], done: true, totalSize: 1 }
            : { records: ids.map((Id) => ({ Id })), done: true, totalSize: ids.length },
        )) as never);
      const deletes: number[] = [];
      vi.spyOn(conn, 'request').mockImplementation(((request: { method: string; url: string }) => {
        const sent = new URL(request.url).searchParams.get('ids')?.split(',') ?? [];
        if (request.method !== 'DELETE' || sent.length > 200) {
          return Promise.reject(
            new Error(
              'EXCEEDED_ID_LIMIT: record limit reached. cannot submit more than 200 records into this call',
            ),
          );
        }
        deletes.push(sent.length);
        return Promise.resolve(sent.map((id) => ({ id, success: true, errors: [] })));
      }) as never);
      vi.mocked(loadOrg).mockResolvedValue({
        alias: 'TGT',
        username: 'user@example.com',
        instanceUrl: 'https://tgt.example.com',
        accessToken: 'token',
      });
      vi.mocked(makeConn).mockReturnValue(conn);

      expect(await run(argv('--objects', 'Case', '--max', '450'))).toBeUndefined();

      expect(deletes).toEqual([200, 200, 50]);
      expect(printed).toContain(`  ${'Case'.padEnd(40)} 450  deleted 450`);
    });
  });
});
