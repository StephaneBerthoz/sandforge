import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileTriggerClaims, memoryTriggerClaims } from './TriggerClaims';
import type { RunHolder } from './TriggerClaims';

const BY_HAND: RunHolder = { startedAt: '2026-09-23T10:00:00.000Z', triggeredBy: 'manual' };
const BY_SCHEDULE: RunHolder = { startedAt: '2026-09-23T10:05:00.000Z', triggeredBy: 'schedule' };

describe('the claims of one window', () => {
  it('give a key to its first claimant only', () => {
    const claims = memoryTriggerClaims();
    expect(claims.claim('due:p1:t1:1000')).toBe(true);
    expect(claims.claim('due:p1:t1:1000')).toBe(false);
    expect(claims.claim('due:p1:t1:2000')).toBe(true);
  });

  it('hold a pipeline for one run, and say which run holds it', () => {
    const claims = memoryTriggerClaims();
    const first = claims.hold('p1', BY_HAND);
    expect('release' in first).toBe(true);
    expect(claims.hold('p1', BY_SCHEDULE)).toEqual({ busy: BY_HAND });
    // Another pipeline is not held up.
    expect('release' in claims.hold('p2', BY_SCHEDULE)).toBe(true);
    if ('release' in first) first.release();
    expect('release' in claims.hold('p1', BY_SCHEDULE)).toBe(true);
  });
});

describe('the claims the windows of a machine share', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sandforge-claims-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Two windows: two extension hosts, each with its own process id, on one directory. */
  function windows(alive: Set<number> = new Set([101, 202])) {
    const isAlive = (pid: number): boolean => alive.has(pid);
    return {
      a: fileTriggerClaims(dir, { pid: 101, isAlive }),
      b: fileTriggerClaims(dir, { pid: 202, isAlive }),
    };
  }

  it('give a start to one window only', () => {
    const { a, b } = windows();
    expect(a.claim('due:p1:t1:1000')).toBe(true);
    expect(b.claim('due:p1:t1:1000')).toBe(false);
    expect(b.claim('due:p1:t1:2000')).toBe(true);
    expect(a.claim('due:p1:t1:2000')).toBe(false);
  });

  it('keep a pipeline another window runs from starting here, and name that run', () => {
    const { a, b } = windows();
    const held = a.hold('p1', BY_HAND);
    expect('release' in held).toBe(true);
    expect(b.hold('p1', BY_SCHEDULE)).toEqual({ busy: BY_HAND });
    // Nor twice in the window that runs it.
    expect(a.hold('p1', BY_SCHEDULE)).toEqual({ busy: BY_HAND });
    if ('release' in held) held.release();
    expect('release' in b.hold('p1', BY_SCHEDULE)).toBe(true);
  });

  it('take no notice of the mark a window left when its host is gone', () => {
    const alive = new Set([101, 202]);
    const { a, b } = windows(alive);
    expect('release' in a.hold('p1', BY_HAND)).toBe(true);
    // The first window crashed mid-run: its mark stays, its process does not.
    alive.delete(101);
    expect('release' in b.hold('p1', BY_SCHEDULE)).toBe(true);
  });

  it('take no notice of a mark older than any run can last, whoever wrote it', () => {
    let clock = Date.parse('2026-09-23T10:00:00.000Z');
    const isAlive = (): boolean => true;
    const a = fileTriggerClaims(dir, { pid: 101, isAlive, now: () => clock });
    const b = fileTriggerClaims(dir, { pid: 202, isAlive, now: () => clock });
    expect('release' in a.hold('p1', BY_HAND)).toBe(true);
    clock += 30 * 60_000;
    expect('busy' in b.hold('p1', BY_SCHEDULE)).toBe(true);
    // Past the longest pipeline timeout, an hour, and its margin.
    clock += 40 * 60_000;
    expect('release' in b.hold('p1', BY_SCHEDULE)).toBe(true);
  });

  it('never use a pipeline id as a path', () => {
    const { a } = windows();
    expect('release' in a.hold('../../outside', BY_HAND)).toBe(true);
    expect(a.claim('due:../../outside:t1:1000')).toBe(true);
    expect(readdirSync(join(dir, '..')).some((name) => name === 'outside')).toBe(false);
    for (const name of [
      ...readdirSync(join(dir, 'claims')),
      ...readdirSync(join(dir, 'running')),
    ]) {
      expect(name).toMatch(/^[0-9a-f]{64}(\.json)?$/);
    }
  });

  it('forget the claims older than the age asked, and keep the others', () => {
    const { a, b } = windows();
    a.claim('due:p1:t1:old');
    // Three days ago, as far as the directory can tell.
    const aged = new Date(Date.now() - 3 * 24 * 60 * 60_000);
    const [old] = readdirSync(join(dir, 'claims'));
    utimesSync(join(dir, 'claims', old), aged, aged);
    a.claim('due:p1:t1:new');
    a.prune(2 * 24 * 60 * 60_000);
    expect(readdirSync(join(dir, 'claims'))).toHaveLength(1);
    // What was pruned can be claimed again; what was kept cannot.
    const again = [b.claim('due:p1:t1:old'), b.claim('due:p1:t1:new')];
    expect(again.filter(Boolean)).toHaveLength(1);
  });

  it('fall back to the memory of the window when the directory cannot be written', () => {
    // A file where the directory should be: every create under it fails.
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, '');
    const logged: string[] = [];
    const claims = fileTriggerClaims(blocked, { pid: 101, log: (line) => logged.push(line) });
    expect(claims.claim('due:p1:t1:1000')).toBe(true);
    expect(claims.claim('due:p1:t1:1000')).toBe(false);
    const held = claims.hold('p1', BY_HAND);
    expect('release' in held).toBe(true);
    expect(claims.hold('p1', BY_SCHEDULE)).toEqual({ busy: BY_HAND });
    expect(logged.some((line) => line.includes('kept in memory'))).toBe(true);
  });

  it('name the caller whose claims fell back to memory', () => {
    // The sync schedules keep theirs in a directory of their own.
    const blocked = join(dir, 'sync-schedules');
    writeFileSync(blocked, '');
    const logged: string[] = [];
    const claims = fileTriggerClaims(blocked, { pid: 101, log: (line) => logged.push(line) });

    claims.claim('sync-schedule:s1:1000');
    claims.hold('s1', BY_SCHEDULE);

    expect(logged).toHaveLength(2);
    expect(logged.every((line) => line.startsWith('[sync-schedules] '))).toBe(true);
  });
});
