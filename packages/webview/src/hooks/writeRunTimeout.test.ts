import { describe, it, expect } from 'vitest';
import { REMOVAL_TIMEOUT_MS, WRITE_RUN_TIMEOUT_MS } from './writeRunTimeout';

describe('WRITE_RUN_TIMEOUT_MS', () => {
  it('waits on a run for longer than a person may keep it paused through a working day', () => {
    expect(WRITE_RUN_TIMEOUT_MS).toBeGreaterThanOrEqual(8 * 60 * 60 * 1000);
  });
});

describe('REMOVAL_TIMEOUT_MS', () => {
  it('waits on a removal for at least the half hour Seed, Sync and Frozen cards wait, in whole hours the timeout message counts', () => {
    expect(REMOVAL_TIMEOUT_MS).toBeGreaterThanOrEqual(30 * 60 * 1000);
    expect(REMOVAL_TIMEOUT_MS % (60 * 60 * 1000)).toBe(0);
  });
});
