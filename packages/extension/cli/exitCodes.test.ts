import { afterEach, describe, expect, it } from 'vitest';
import { endWith, restoreExitCode, runExitCode, worstExit } from './exitCodes.js';

describe('the exit codes of the command lines', () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it('ends a run that produced only failures on 1, and a partial one on 0 unless --fail-on-partial', () => {
    // As the clone ends: a pipeline that lets a few refusals through goes on.
    expect(runExitCode('success', false)).toBe(0);
    expect(runExitCode('partial', false)).toBe(0);
    expect(runExitCode('partial', true)).toBe(3);
    expect(runExitCode('failure', false)).toBe(1);
    expect(runExitCode('failure', true)).toBe(1);
  });

  it('ends a restore that left values as they are on 3, and one that put nothing back on 1', () => {
    expect(restoreExitCode({ status: 'success', totalFailed: 0 })).toBe(0);
    expect(restoreExitCode({ status: 'partial', totalFailed: 2 })).toBe(3);
    expect(restoreExitCode({ status: 'success', totalFailed: 0, partial: true })).toBe(3);
    expect(restoreExitCode({ status: 'failure', totalFailed: 5 })).toBe(1);
    // Records of a Sync run's snapshot changed since the run, held back: partial.
    expect(
      restoreExitCode({
        status: 'partial',
        totalFailed: 0,
        keptChanged: { total: 4, objects: [] },
      }),
    ).toBe(3);
  });

  it('takes the worst of the codes a step came to: a failure, then an unstable verdict, then a partial one', () => {
    expect(worstExit([])).toBe(0);
    expect(worstExit([0, 3, 0])).toBe(3);
    expect(worstExit([3, 4])).toBe(4);
    expect(worstExit([4, 1, 3])).toBe(1);
  });

  it('sets the code a command ends with, 0 leaving it unset and a failure set before standing', () => {
    endWith(0);
    expect(process.exitCode).toBeUndefined();
    endWith(3);
    expect(process.exitCode).toBe(3);
    process.exitCode = 1;
    endWith(3);
    expect(process.exitCode).toBe(1);
  });
});
