import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod';
import { linkedLockKind, lockHolderShape, type LockFileHead, type LockSelf } from './linkedLock';

/** Whether the system gives files permission bits the lock can rely on. */
const POSIX = process.platform !== 'win32';

const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const BOOTED = NOW - 3 * 60 * 60_000;

/** Another process of this machine, started two hours before {@link NOW}. */
const OTHER: LockSelf = {
  host: hostname(),
  pid: 4242,
  startedAt: new Date(NOW - 2 * 60 * 60_000).toISOString(),
};

const checks = (alive: boolean, now = NOW) => ({
  isAlive: () => alive,
  bootedAt: () => BOOTED,
  now: () => now,
});

/** A kind of lock that says what it is held for. */
const schema = z.object({ ...lockHolderShape, purpose: z.string() });
const LOCKS = linkedLockKind((content) => {
  const parsed = schema.safeParse(content);
  return parsed.success ? parsed.data : undefined;
});
const purpose = (what: string) => (head: LockFileHead) => ({ ...head, purpose: what });

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function lockFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-linked-lock-'));
  made.push(dir);
  return join(dir, 'locks', 'org.lock');
}

describe('a linked lock', () => {
  it('is one file, its owner’s alone, naming the process that holds it and what for', () => {
    const file = lockFile();
    const taken = LOCKS.acquire(file, purpose('apply'));
    if (!('lock' in taken)) throw new Error('the lock was not taken');

    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      version: 1,
      host: hostname(),
      pid: process.pid,
      purpose: 'apply',
    });
    if (POSIX) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(file, '..')).mode & 0o777).toBe(0o700);
    }
    taken.lock.release();
    expect(readdirSync(join(file, '..'))).toEqual([]);
  });

  it('is held once: a second take is refused, naming the holder, until it is released', () => {
    const file = lockFile();
    const first = LOCKS.acquire(file, purpose('apply'));
    if (!('lock' in first)) throw new Error('the lock was not taken');

    expect(LOCKS.acquire(file, purpose('destroy'))).toMatchObject({ busy: { purpose: 'apply' } });
    expect(LOCKS.holder(file)).toMatchObject({ purpose: 'apply', pid: process.pid });
    first.lock.release();
    first.lock.release();

    expect(LOCKS.holder(file)).toBeUndefined();
    const again = LOCKS.acquire(file, purpose('destroy'));
    expect('lock' in again).toBe(true);
    if ('lock' in again) again.lock.release();
  });

  it('refuses while another process of this machine that holds it runs', () => {
    const file = lockFile();
    expect(
      'lock' in LOCKS.acquire(file, purpose('apply'), { self: OTHER, checks: checks(true) }),
    ).toBe(true);

    expect(LOCKS.acquire(file, purpose('destroy'), { checks: checks(true) })).toEqual({
      busy: expect.objectContaining({ pid: 4242, purpose: 'apply' }),
    });
    expect(LOCKS.holder(file, { checks: checks(true) })).toMatchObject({ pid: 4242 });
  });

  it('takes over the lock of a process that is gone, or that started before the machine did', () => {
    const gone = lockFile();
    expect(
      'lock' in LOCKS.acquire(gone, purpose('apply'), { self: OTHER, checks: checks(true) }),
    ).toBe(true);
    const beforeBoot = lockFile();
    const old: LockSelf = { ...OTHER, startedAt: new Date(BOOTED - 60 * 60_000).toISOString() };
    expect('lock' in LOCKS.acquire(beforeBoot, purpose('apply'), { self: old })).toBe(true);

    expect(LOCKS.holder(gone, { checks: checks(false) })).toBeUndefined();
    const taken = LOCKS.acquire(gone, purpose('destroy'), { checks: checks(false) });
    const reused = LOCKS.acquire(beforeBoot, purpose('destroy'), { checks: checks(true) });

    expect('lock' in taken && 'lock' in reused).toBe(true);
    expect(JSON.parse(readFileSync(gone, 'utf8'))).toMatchObject({
      pid: process.pid,
      purpose: 'destroy',
    });
    if ('lock' in taken) taken.lock.release();
    if ('lock' in reused) reused.lock.release();
  });

  it('takes over a file that is no lock of its kind, and never removes one another process took over', () => {
    const file = lockFile();
    const first = LOCKS.acquire(file, purpose('apply'), { self: OTHER, checks: checks(true) });
    if (!('lock' in first)) throw new Error('the lock was not taken');
    // The first process is taken for gone, and this one takes the lock over.
    const second = LOCKS.acquire(file, purpose('destroy'), { checks: checks(false) });
    if (!('lock' in second)) throw new Error('the lock was not taken over');
    first.lock.release();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ purpose: 'destroy' });
    second.lock.release();

    writeFileSync(file, '{"version":1,"purpose":"half"}');
    const third = LOCKS.acquire(file, purpose('reset'));
    expect('lock' in third).toBe(true);
    if ('lock' in third) third.lock.release();
  });

  it('holds a lock taken on another machine sharing this home folder for as long as a run is believed', () => {
    const file = lockFile();
    const elsewhere: LockSelf = { ...OTHER, host: 'build-agent-2' };
    expect(
      'lock' in LOCKS.acquire(file, purpose('apply'), { self: elsewhere, checks: checks(true) }),
    ).toBe(true);

    expect(LOCKS.holder(file, { checks: checks(false, NOW + 60_000) })).toMatchObject({
      host: 'build-agent-2',
    });
    const later = LOCKS.acquire(file, purpose('apply'), {
      checks: checks(false, NOW + 25 * 60 * 60_000),
    });
    expect('lock' in later).toBe(true);
    if ('lock' in later) later.lock.release();
  });
});
