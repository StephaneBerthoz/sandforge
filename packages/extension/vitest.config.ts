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
      exclude: ['src/**/*.test.ts', 'src/**/index.ts'],
      // Anti-regression gate (2026-08): set ~5 pts under the measured baseline
      // (lines 93.4 / branches 87.9 / functions 93.5). Raise as coverage grows.
      thresholds: {
        statements: 88,
        branches: 82,
        functions: 88,
        lines: 88,
      },
    },
  },
});
