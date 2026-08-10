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
      // (lines 52.9 / branches 83.6 / functions 60.2). Raise as coverage grows.
      thresholds: {
        statements: 47,
        branches: 78,
        functions: 55,
        lines: 47,
      },
    },
  },
});
