import { describe, expect, it } from 'vitest';
import { RUNNER_PACE, paced } from './runnerPace';

describe('paced', () => {
  it('stretches a time by the pace of this runner, three times on Windows, as is elsewhere', () => {
    expect(RUNNER_PACE).toBe(process.platform === 'win32' ? 3 : 1);
    expect(paced(15_000)).toBe(15_000 * RUNNER_PACE);
  });
});
