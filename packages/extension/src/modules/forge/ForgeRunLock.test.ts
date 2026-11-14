import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LockSelf } from '../checkpoint/linkedLock.js';
import {
  forgeRunLockFileOf,
  forgeRunStopWords,
  forgeRunWriting,
  forgeRunWritingWords,
  lockForgeRun,
} from './ForgeRunLock.js';

const NOW = Date.parse('2026-11-20T02:00:00.000Z');
const BOOTED = NOW - 3 * 60 * 60_000;

/** A clone from the command line on this machine, started half an hour before {@link NOW}. */
const CLONE: LockSelf = {
  host: hostname(),
  pid: 4242,
  startedAt: new Date(NOW - 30 * 60_000).toISOString(),
};

/** A clone in an editor window of this machine. */
const WINDOW: LockSelf = {
  host: hostname(),
  pid: 5151,
  startedAt: new Date(NOW - 2 * 60 * 60_000).toISOString(),
};

const checks = (alive: boolean) => ({
  isAlive: () => alive,
  bootedAt: () => BOOTED,
  now: () => NOW,
});

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A journal's path in a folder of runs of its own, the journal not written. */
function journalPath(name = 'sandforge-clone-2026-11-20T01-30-00-000Z-0a1b2c3d'): string {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-forge-run-lock-'));
  made.push(dir);
  return join(dir, 'forge-runs', `${name}.ndjson`);
}

describe('the lock a Forge run holds on its journal', () => {
  it('sits beside the journal, under its name', () => {
    expect(forgeRunLockFileOf('/store/forge-runs/run-a.ndjson')).toBe(
      '/store/forge-runs/run-a.lock',
    );
    expect(forgeRunLockFileOf('/store/forge-runs/run-a')).toBe('/store/forge-runs/run-a.lock');
  });

  it('names the run that holds it while it writes, and nobody once it is let go', () => {
    const journal = journalPath();
    const taken = lockForgeRun(
      journal,
      { journalId: 'run-a', ranFrom: 'commandLine', target: 'TGT' },
      { self: CLONE, checks: checks(true) },
    );
    if (!('lock' in taken)) throw new Error('the lock was not taken');

    const writing = forgeRunWriting(journal, { checks: checks(true) });
    expect(writing).toMatchObject({
      journalId: 'run-a',
      ranFrom: 'commandLine',
      target: 'TGT',
      pid: CLONE.pid,
      host: CLONE.host,
    });
    // Its owner's alone, as every lock file of the store.
    if (process.platform !== 'win32') {
      expect(statSync(forgeRunLockFileOf(journal)).mode & 0o777).toBe(0o600);
    }

    taken.lock.release();
    expect(existsSync(forgeRunLockFileOf(journal))).toBe(false);
    expect(forgeRunWriting(journal, { checks: checks(true) })).toBeUndefined();
  });

  it('is held by one run at a time: a second run of the same journal is told which writes it', () => {
    const journal = journalPath();
    const first = lockForgeRun(
      journal,
      { journalId: 'run-a', ranFrom: 'editor', target: 'Sandbox UAT' },
      { self: WINDOW, checks: checks(true) },
    );
    expect('lock' in first).toBe(true);

    const second = lockForgeRun(
      journal,
      { journalId: 'run-a', ranFrom: 'commandLine', target: 'TGT', resumes: true },
      { self: CLONE, checks: checks(true) },
    );
    expect(second).toEqual({
      busy: expect.objectContaining({ journalId: 'run-a', ranFrom: 'editor', pid: WINDOW.pid }),
    });
    // The first run's lock stands, as it wrote it.
    expect(JSON.parse(readFileSync(forgeRunLockFileOf(journal), 'utf8'))).toMatchObject({
      pid: WINDOW.pid,
      ranFrom: 'editor',
    });
  });

  it('keeps each journal apart: a run of one does not hold another', () => {
    const one = journalPath('run-one');
    const other = join(one, '..', 'run-other.ndjson');
    expect('lock' in lockForgeRun(one, { journalId: 'run-one', ranFrom: 'commandLine' })).toBe(
      true,
    );
    expect(forgeRunWriting(other)).toBeUndefined();
    expect('lock' in lockForgeRun(other, { journalId: 'run-other', ranFrom: 'commandLine' })).toBe(
      true,
    );
  });

  it('is taken over from a run whose process has ended, and that run no longer writes', () => {
    const journal = journalPath();
    const killed = lockForgeRun(
      journal,
      { journalId: 'run-a', ranFrom: 'commandLine' },
      { self: CLONE, checks: checks(true) },
    );
    expect('lock' in killed).toBe(true);

    expect(forgeRunWriting(journal, { checks: checks(false) })).toBeUndefined();
    const next = lockForgeRun(
      journal,
      { journalId: 'run-a', ranFrom: 'commandLine', resumes: true },
      { self: WINDOW, checks: checks(false) },
    );
    expect('lock' in next).toBe(true);
    expect(JSON.parse(readFileSync(forgeRunLockFileOf(journal), 'utf8'))).toMatchObject({
      pid: WINDOW.pid,
      resumes: true,
    });
  });

  it('says which run writes, from where and since when, and what to do before removing it', () => {
    const journal = journalPath();
    const taken = lockForgeRun(
      journal,
      { journalId: 'run-a', ranFrom: 'commandLine', target: 'TGT' },
      { self: CLONE, checks: checks(true) },
    );
    if (!('lock' in taken)) throw new Error('the lock was not taken');
    const holder = forgeRunWriting(journal, { checks: checks(true) });
    if (!holder) throw new Error('nobody holds the lock');

    const words = forgeRunWritingWords(holder);
    expect(words).toContain('run-a');
    expect(words).toContain('from the command line');
    expect(words).toContain(`process ${CLONE.pid} on ${CLONE.host}`);
    expect(words).toContain('to TGT');
    expect(words).toContain(holder.acquiredAt);
    expect(forgeRunStopWords(holder)).toMatch(/Ctrl-C in the terminal it runs in/);

    const inTheEditor = { ...holder, ranFrom: 'editor' as const, target: undefined };
    expect(forgeRunWritingWords(inTheEditor)).toContain('in VS Code');
    expect(forgeRunWritingWords(inTheEditor)).not.toContain('to undefined');
    expect(forgeRunStopWords(inTheEditor)).toMatch(/Forge page/);
    expect(forgeRunWritingWords({ ...holder, resumes: true })).toContain(
      'taking up an earlier part',
    );
  });
});
