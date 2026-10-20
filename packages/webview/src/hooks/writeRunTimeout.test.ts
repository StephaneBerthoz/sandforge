import { describe, it, expect } from 'vitest';
import { WRITE_RUN_TIMEOUT_MS } from './writeRunTimeout';

describe('WRITE_RUN_TIMEOUT_MS', () => {
  it('waits on a run for longer than a person may keep it paused through a working day', () => {
    expect(WRITE_RUN_TIMEOUT_MS).toBeGreaterThanOrEqual(8 * 60 * 60 * 1000);
  });
});
