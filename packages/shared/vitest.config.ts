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
      // with i18n locales excluded (lines 86.3 / branches 95.4 / functions 82.1).
      // Raise as coverage grows.
      thresholds: {
        statements: 50,
        branches: 78,
        functions: 55,
        lines: 50,
      },
    },
  },
});
