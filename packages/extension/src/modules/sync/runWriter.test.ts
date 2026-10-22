import { describe, expect, it } from 'vitest';
import { processRunning, THIS_HOST, WRITER_QUIET_MS, writtenElsewhere } from './runWriter';

const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const BOOTED = NOW - 3 * 60 * 60_000;

/** A run with no end that another window began an hour ago and wrote to a minute ago. */
const run = (
  writer: { pid: number; hostStartedAt: string } | undefined,
  extra: Record<string, unknown> = {},
) => ({
  startedAt: new Date(NOW - 60 * 60_000).toISOString(),
  lastWriteAt: new Date(NOW - 60_000).toISOString(),
  ...(writer ? { writer } : {}),
  ...extra,
});

const OTHER = { pid: 4242, hostStartedAt: new Date(NOW - 2 * 60 * 60_000).toISOString() };
const SELF = { pid: 1717, startedAt: new Date(NOW - 30 * 60_000).toISOString() };
const checks = (alive: boolean) => ({
  isAlive: () => alive,
  bootedAt: () => BOOTED,
  now: () => NOW,
});

describe('writtenElsewhere', () => {
  it('reads a run with no end whose process is alive as written by another window', () => {
    expect(writtenElsewhere(run(OTHER), SELF, checks(true))).toBe(true);
  });

  it('reads it as stopped once that process is gone', () => {
    expect(writtenElsewhere(run(OTHER), SELF, checks(false))).toBe(false);
  });

  it('leaves a run of this very process to the window that writes it', () => {
    expect(
      writtenElsewhere(run({ pid: SELF.pid, hostStartedAt: SELF.startedAt }), SELF, checks(true)),
    ).toBe(false);
  });

  it('never reads a run that ended, or one whose file names no process, as being written', () => {
    expect(writtenElsewhere(run(OTHER, { end: { status: 'success' } }), SELF, checks(true))).toBe(
      false,
    );
    expect(writtenElsewhere(run(undefined), SELF, checks(true))).toBe(false);
  });

  it('takes a process that started before the machine did for another one holding the same id', () => {
    const before = { pid: OTHER.pid, hostStartedAt: new Date(BOOTED - 60 * 60_000).toISOString() };
    expect(writtenElsewhere(run(before), SELF, checks(true))).toBe(false);
  });

  it('stops taking a run for one being written once its file has said nothing for a day', () => {
    const quiet = run(OTHER, {
      lastWriteAt: new Date(NOW - WRITER_QUIET_MS - 60_000).toISOString(),
    });
    expect(writtenElsewhere(quiet, SELF, checks(true))).toBe(false);
  });

  it('reads the process running the tests as alive, and this process as its own host', () => {
    expect(processRunning(process.pid)).toBe(true);
    expect(THIS_HOST.pid).toBe(process.pid);
    expect(Date.parse(THIS_HOST.startedAt)).toBeLessThanOrEqual(Date.now());
  });
});
