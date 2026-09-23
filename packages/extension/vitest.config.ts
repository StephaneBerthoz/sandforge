import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

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
    include: ['src/**/*.test.ts', 'cli/**/*.test.ts', 'tools/**/*.test.ts'],
    /*
     * The smoke suite matches that glob but imports `vscode`, a module only the
     * extension host provides. Run by vitest it fails to load; it is compiled by
     * tsconfig.smoke.json and run by @vscode/test-cli instead.
     */
    exclude: [...configDefaults.exclude, 'src/test/smoke/**'],
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
      // Anti-regression gate, a couple of points under what is measured today:
      // statements 91.4 / branches 81.5 / functions 90.9 / lines 92.2. Those
      // numbers are on vitest 4's scale, which counts more branches than
      // vitest 3 did: the same tests measured 93.1 / 88.6 / 94.3 / 93.1 there,
      // so the branch floor moved down with the scale, not with the tests.
      // Raise as coverage grows.
      thresholds: {
        statements: 89,
        branches: 79,
        functions: 88,
        lines: 90,
      },
    },
  },
});
