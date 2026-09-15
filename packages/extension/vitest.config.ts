import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /*
     * Paths below resolve from this directory, not from wherever the run
     * starts. Stryker starts vitest from the repository root with this file
     * as its config, and there `src/test/setup.ts` named nothing: every test
     * file failed to load and the mutation run found no test at all.
     */
    root: fileURLToPath(new URL('.', import.meta.url)),
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'cli/**/*.test.ts'],
    // Absolute for the same reason: tools that read this config without
    // applying `root` (knip resolves it from the repository) find the file too.
    setupFiles: [fileURLToPath(new URL('./src/test/setup.ts', import.meta.url))],
    /*
     * The full suite runs in parallel with the webview/shared suites during
     * `pnpm validate`; on loaded machines the event loop can starve a worker
     * for more than vitest's 5 s default and fail an otherwise-fast test
     * (observed on autopilotComposition, SeedOpsHandler, SyncHistoryStore —
     * all <150 ms in isolation). 15 s keeps real hangs detectable while
     * absorbing scheduling jitter.
     */
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/index.ts'],
      // Anti-regression gate (2026-08): set ~5 pts under the measured baseline
      // (lines 90.0 / branches 87.1 / functions 93.4 — measured under vitest 3,
      // whose v8 provider ignores empty lines by default). Raise as coverage grows.
      thresholds: {
        statements: 88,
        branches: 82,
        functions: 88,
        lines: 88,
      },
    },
  },
});
