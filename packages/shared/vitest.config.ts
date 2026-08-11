import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/index.ts', 'src/i18n/locales/**'],
      // Anti-regression gate (2026-08): prudent margin under the measured baseline
      // with i18n locales excluded (lines 85.2 / branches 93.2 / functions 70.8 /
      // statements 85.2 — measured after the dead-export purge). Raise as coverage grows.
      thresholds: {
        statements: 80,
        branches: 90,
        functions: 65,
        lines: 80,
      },
    },
  },
});
