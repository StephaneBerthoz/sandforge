import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

import { execFileSync } from 'node:child_process';
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
});
