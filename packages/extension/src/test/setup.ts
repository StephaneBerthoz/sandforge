import { afterEach, vi } from 'vitest';

/**
 * Global test-isolation guard.
 *
 * `vi.useFakeTimers()` mutates worker-process globals, and vitest does not
 * restore them between test files that share a worker (singleThread,
 * isolate:false, or any non-default pool setup). A file that forgets to
 * restore poisons every later file in that worker: real `setTimeout` never
 * fires and `Date` stays frozen (root cause of the intermittent
 * `SeedOpsHandler.test.ts` "sends TimeoutError" failure, reproduced by
 * running TrendStorage/OrgInfoFetcher before SeedOpsHandler in one worker).
 *
 * Restoring real timers after every test makes that leak class impossible,
 * regardless of individual test files' hygiene. `vi.useRealTimers()` is a
 * no-op when timers are already real.
 */
afterEach(() => {
  vi.useRealTimers();
});
