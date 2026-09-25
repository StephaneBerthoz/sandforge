import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    /* Vitest 5 clears every mock's calls before each test by default, where
       Vitest 4 kept them: a test asserting what a module did as it was
       imported (the i18n boot restore) then read no call at all. */
    clearMocks: false,
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/index.ts', 'src/i18n/locales/**'],
      // Anti-regression gate (2026-08): prudent margin under the measured baseline
      // with i18n locales excluded (lines 84.3 / branches 95.3 / functions 83.6 /
      // statements 84.3 — measured under vitest 3, whose v8 provider ignores empty
      // lines by default). Raise as coverage grows.
      thresholds: {
        statements: 80,
        branches: 90,
        functions: 65,
        lines: 80,
      },
    },
  },
});
