import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireOrgLock } from '../../src/modules/checkpoint/OrgCheckpointStore.js';
import type { LockSelf } from '../../src/modules/checkpoint/linkedLock.js';
import {
  acquireEnvLock,
  checkpointLockRefusal,
  defaultEnvLocksDir,
  envLockFileOf,
  envLockHolder,
  envLockLine,
  envLockRefusal,
} from './envLock.js';

/** An Organization Id in its 18-character form, and the 15 it is made from. */
const ORG = '00Dxx0000001234EAA';
const ORG_15 = '00Dxx0000001234';
const OTHER_ORG = '00Dxx0000005678EAA';

const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const BOOTED = NOW - 3 * 60 * 60_000;

/** Another process of this machine, started two hours before {@link NOW}. */
const OTHER: LockSelf = {
  host: hostname(),
  pid: 4242,
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
function locksDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-env-lock-'));
  made.push(dir);
  return join(dir, 'locks');
}

describe('the environment lock of an org', () => {
  it('sits beside the checkpoint locks, in a file of its own named by the 18-character Organization Id', () => {
    expect(defaultEnvLocksDir()).toBe(join(homedir(), '.sandforge', 'locks'));
    expect(envLockFileOf('/locks', ORG_15)).toBe(join('/locks', `${ORG}.env.lock`));
    expect(() => envLockFileOf('/locks', '005xx0000001234AAA')).toThrow();
  });

  it('is held once: a second apply of the org, in either form of its id, is refused, naming the first', () => {
    const dir = locksDir();
    const first = acquireEnvLock(dir, ORG, {
      operation: 'apply',
      env: 'case-flow',
      alias: 'pool-1',
    });
    if (!('lock' in first)) throw new Error('the lock was not taken');

    const second = acquireEnvLock(dir, ORG_15, { operation: 'destroy', env: 'case-flow' });

    expect(second).toEqual({
      busy: expect.objectContaining({
        operation: 'apply',
        env: 'case-flow',
        alias: 'pool-1',
        pid: process.pid,
      }),
    });
    expect(first.lock.organizationId).toBe(ORG);
    const other = acquireEnvLock(dir, OTHER_ORG, { operation: 'apply', env: 'case-flow' });
    expect('lock' in other).toBe(true);
    if ('lock' in other) other.lock.release();
    first.lock.release();
  });

  it('is let go by its release, once or twice, and can be taken again', () => {
    const dir = locksDir();
    const taken = acquireEnvLock(dir, ORG, { operation: 'apply', env: 'case-flow' });
    if (!('lock' in taken)) throw new Error('the lock was not taken');
    expect(envLockHolder(dir, ORG)).toMatchObject({ operation: 'apply', env: 'case-flow' });

    taken.lock.release();
    taken.lock.release();

    expect(envLockHolder(dir, ORG)).toBeUndefined();
    expect(existsSync(envLockFileOf(dir, ORG))).toBe(false);
    const again = acquireEnvLock(dir, ORG, { operation: 'reset', env: 'case-flow' });
    expect('lock' in again).toBe(true);
    if ('lock' in again) again.lock.release();
  });

  it('refuses while another process of this machine that holds it runs, and takes it over once it is gone', () => {
    const dir = locksDir();
    const left = acquireEnvLock(
      dir,
      ORG,
      { operation: 'apply', env: 'case-flow' },
      { self: OTHER, checks: checks(true) },
    );
    expect('lock' in left).toBe(true);

    expect(
      acquireEnvLock(dir, ORG, { operation: 'apply', env: 'case-flow' }, { checks: checks(true) }),
    ).toEqual({ busy: expect.objectContaining({ pid: 4242, operation: 'apply' }) });

    // The process was killed with its lock held: nothing is under way any more.
    expect(envLockHolder(dir, ORG, { checks: checks(false) })).toBeUndefined();
    const taken = acquireEnvLock(
      dir,
      ORG,
      { operation: 'destroy', env: 'case-flow' },
      { checks: checks(false) },
    );
    if (!('lock' in taken)) throw new Error('the lock of a gone process was not taken over');
    expect(JSON.parse(readFileSync(envLockFileOf(dir, ORG), 'utf8'))).toMatchObject({
      pid: process.pid,
      operation: 'destroy',
    });
    taken.lock.release();
  });

  it('neither blocks nor is blocked by the checkpoint lock of the same org', () => {
    const dir = locksDir();
    const env = acquireEnvLock(dir, ORG, { operation: 'apply', env: 'case-flow' });
    if (!('lock' in env)) throw new Error('the lock was not taken');
    const checkpoint = acquireOrgLock(dir, ORG, { operation: 'take' });

    expect('lock' in checkpoint).toBe(true);
    expect(readdirSync(dir).sort()).toEqual([`${ORG}.env.lock`, `${ORG}.lock`]);
    if ('lock' in checkpoint) checkpoint.lock.release();
    env.lock.release();
  });

  it('refuses an environment name that is not one, before any file is made', () => {
    const dir = locksDir();

    expect(() => acquireEnvLock(dir, ORG, { operation: 'apply', env: '../x' })).toThrow();
    expect(existsSync(dir)).toBe(false);
  });
});

describe('what the locks say', () => {
  it('names the operation, the environment, the org and the process under way', () => {
    const holder = {
      host: 'runner-1',
      pid: 4242,
      hostStartedAt: '2026-10-25T10:00:00.000Z',
      acquiredAt: '2026-10-25T11:00:00.000Z',
      operation: 'apply' as const,
      env: 'case-flow',
      alias: 'pool-1',
    };

    expect(envLockLine(holder)).toBe(
      'an apply of case-flow to pool-1 is under way on this machine (process 4242 on runner-1, since 2026-10-25T11:00:00.000Z)',
    );
    expect(envLockLine({ ...holder, operation: 'destroy', alias: undefined })).toMatch(
      /^a destroy of case-flow is under way/,
    );
    expect(envLockLine({ ...holder, operation: 'recover' })).toMatch(
      /^a state recover of case-flow to pool-1 is under way/,
    );
    expect(envLockRefusal(holder)).toContain('Nothing was written: run this again once it ends.');
  });

  it('refuses a step while a take, a rewind or an undo of the org’s checkpoints runs', () => {
    const dir = locksDir();
    expect(checkpointLockRefusal(dir, ORG)).toBeUndefined();
    const rewind = acquireOrgLock(dir, ORG, { operation: 'rewind' });
    if (!('lock' in rewind)) throw new Error('the lock was not taken');

    expect(checkpointLockRefusal(dir, ORG_15)).toMatch(
      /^a checkpoint rewind of this org is under way on this machine \(process \d+ on /,
    );
    rewind.lock.release();
    expect(checkpointLockRefusal(dir, ORG)).toBeUndefined();
  });
});
