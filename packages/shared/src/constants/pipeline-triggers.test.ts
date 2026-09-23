import { describe, it, expect } from 'vitest';
import { TRIGGERED_RUN_PREFIX, isTriggeredRun } from './pipeline-triggers.js';

describe('the operation id of a run a trigger starts', () => {
  it('is told apart by its prefix', () => {
    expect(isTriggeredRun(`${TRIGGERED_RUN_PREFIX}6f1c2d3e`)).toBe(true);
  });

  it('is never taken for a request the page sent, a scheduled sync or a queued replay', () => {
    // The page mints `wv-<uuid>`; the extension's own runs carry their kind.
    for (const id of ['wv-6f1c2d3e', 'sync:schedule:6f1c2d3e', 'offline-replay-6f1c2d3e']) {
      expect(isTriggeredRun(id)).toBe(false);
    }
  });
});
