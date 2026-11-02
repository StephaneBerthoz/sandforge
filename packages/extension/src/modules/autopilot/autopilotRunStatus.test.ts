import { describe, expect, it } from 'vitest';
import { autopilotRunStatus } from './autopilotRunStatus.js';

describe('autopilotRunStatus', () => {
  const run = { totalSuccess: 3, totalFailure: 0, failedObjects: [] };
  const refusedLookup = {
    statusCode: 'PARENT_REFUSED',
    fields: ['ParentId'],
    count: 1,
    message: 'the Account record its ParentId names was refused in this run',
  };

  it('takes a run that died, or wrote nothing it was sent, for a failure, and one the target refused part of for partial', () => {
    expect(autopilotRunStatus(run)).toBe('success');
    expect(autopilotRunStatus({ ...run, totalFailure: 1 })).toBe('partial');
    expect(autopilotRunStatus({ ...run, totalSuccess: 0, totalFailure: 2 })).toBe('failure');
    expect(autopilotRunStatus({ ...run, fatalError: 'INVALID_SESSION_ID' })).toBe('failure');
    expect(autopilotRunStatus({ ...run, failedObjects: ['Lead'] })).toBe('partial');
  });

  it('takes a run whose records were all written, one of them left without a lookup, for partial', () => {
    expect(
      autopilotRunStatus({
        ...run,
        lookups: { Account: { filled: 2, refusals: [refusedLookup], leftEmpty: 1 } },
      }),
    ).toBe('partial');
  });

  it('takes a run whose second pass filled every lookup for a success', () => {
    expect(autopilotRunStatus({ ...run, lookups: { Account: { filled: 3, refusals: [] } } })).toBe(
      'success',
    );
  });

  it('never calls a stopped run a success, nothing refused or not', () => {
    expect(autopilotRunStatus({ ...run, stopped: true })).toBe('partial');
    expect(autopilotRunStatus({ ...run, totalSuccess: 0, stopped: true })).toBe('partial');
  });
});
