import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs, fileConfigStore } from './sandforge-backup.js';

/** A command line, as `process.argv` hands it over. */
function argv(...args: string[]): string[] {
  return ['node', 'sandforge-backup.ts', ...args];
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Run a parse that is meant to be refused, and report the exit. */
function refuse(...args: string[]): { code: number | undefined; message: string } {
  let code: number | undefined;
  let message = '';
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    code = c;
    throw new Error('exit');
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    message += chunk;
    return true;
  }) as never);
  try {
    parseArgs(argv(...args));
  } catch {
    // `process.exit` is stubbed to throw so the parse stops where it would.
  }
  return { code, message };
}

describe('parseArgs', () => {
  it('reads the objects to snapshot', () => {
    const args = parseArgs(argv('--org', 'TGT', '--object', 'Account', '--object', 'Contact'));
    expect(args.org).toBe('TGT');
    expect(args.objects).toEqual(['Account', 'Contact']);
  });

  it('reads a listing', () => {
    expect(parseArgs(argv('--org', 'T', '--list')).list).toBe(true);
  });

  it('reads a restore', () => {
    expect(parseArgs(argv('--org', 'T', '--restore', 'op-1')).restoreId).toBe('op-1');
  });

  it('refuses a line with nothing to do', () => {
    expect(refuse('--org', 'T').code).toBe(2);
  });

  it('refuses two things to do at once', () => {
    // Three answers to "what should this run do" is two too many.
    const { code, message } = refuse('--org', 'T', '--list', '--object', 'Account');
    expect(code).toBe(2);
    expect(message).toContain('one of');
  });

  it('refuses an object name that is not one', () => {
    expect(refuse('--org', 'T', '--object', 'Account; DROP').code).toBe(2);
  });

  it('refuses a line with no org', () => {
    expect(refuse('--object', 'Account').code).toBe(2);
  });

  it('does not write without being told to, unless --yes says so', () => {
    expect(parseArgs(argv('--org', 'T', '--restore', 'op-1')).yes).toBe(false);
    expect(parseArgs(argv('--org', 'T', '--restore', 'op-1', '--yes')).yes).toBe(true);
  });
});

describe('fileConfigStore', () => {
  it('keeps what it was given across two openings of the same file', () => {
    // The handler writes snapshot metadata through it and reads it back to
    // list and to restore, so a map in memory would lose every snapshot
    // between one run of the script and the next.
    const dir = mkdtempSync(join(tmpdir(), 'sandforge-cli-test-'));
    const path = join(dir, 'snapshots.json');
    try {
      const first = fileConfigStore(path);
      first.set('backup:op-1', { operationId: 'op-1', totalRecords: 3 }, 'backups');

      const second = fileConfigStore(path);
      expect(second.get('backup:op-1')).toEqual({ operationId: 'op-1', totalRecords: 3 });
      expect(second.getKeysByPrefix('backup:')).toEqual(['backup:op-1']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts empty on a file that is not there yet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandforge-cli-test-'));
    try {
      const store = fileConfigStore(join(dir, 'nothing-here.json'));
      expect(store.getKeysByPrefix('backup:')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
