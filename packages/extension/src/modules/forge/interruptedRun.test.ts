import { describe, it, expect } from 'vitest';
import { keepPartialSummary, partialSummaryOf } from './interruptedRun.js';
import type { ExecutionSummary } from './ForgeExecutor.js';

/** A run that created two Accounts before it stopped. */
const TWO_ACCOUNTS: ExecutionSummary = {
  successCount: 2,
  linkedCount: 0,
  failedCount: 0,
  skippedCount: 0,
  remapCount: 2,
  errors: [],
  truncatedObjects: [],
  remapTable: { '001000000000001': '001000000000901', '001000000000002': '001000000000902' },
  existingRecords: [],
  existingSourceIds: [],
  remapByObject: [{ objectApiName: 'Account', created: 2, linked: 0 }],
};

describe('interruptedRun', () => {
  it('gives back what the run had done, by the error it threw', () => {
    const stopped = new Error('aborted');
    keepPartialSummary(stopped, TWO_ACCOUNTS);

    expect(partialSummaryOf(stopped)).toBe(TWO_ACCOUNTS);
  });

  it('knows nothing of an error no run threw, nor of a thrown value that is not an object', () => {
    keepPartialSummary('aborted', TWO_ACCOUNTS);

    expect(partialSummaryOf(new Error('aborted'))).toBeUndefined();
    expect(partialSummaryOf('aborted')).toBeUndefined();
    expect(partialSummaryOf(undefined)).toBeUndefined();
  });
});
