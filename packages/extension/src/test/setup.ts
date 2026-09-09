import { afterEach, beforeEach, vi } from 'vitest';

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

/**
 * Network guard.
 *
 * The suite is meant to be hermetic, and nothing enforced it: a concurrency
 * race in `AnthropicAdapter.getClient()` let one of two parallel calls escape
 * the `@anthropic-ai/sdk` module mock and issue a real POST to
 * api.anthropic.com — the test failed with a live 401 body, which reads as an
 * assertion bug rather than as "this test just called the internet".
 *
 * Any test that needs fetch stubs it (`vi.stubGlobal`, `vi.spyOn`) and that
 * still works: the stub simply replaces this guard. What no longer passes
 * silently is an *unstubbed* call leaving the machine.
 */
const blockedFetch = (input: unknown): never => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : ((input as { url?: string } | null)?.url ?? String(input));
  throw new Error(
    `Network access from a test: fetch(${url}). Tests must be hermetic — ` +
      `mock the module or stub globalThis.fetch.`,
  );
};

beforeEach(() => {
  vi.stubGlobal('fetch', blockedFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});
