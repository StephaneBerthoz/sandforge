import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/index.ts', 'src/main.tsx'],
      // Anti-regression gate (2026-08): set ~5 pts under the measured baseline
      // (lines 87.7 / branches 85.4 / functions 77.9 — measured under vitest 3,
      // whose v8 provider ignores empty lines by default). Raise as coverage grows.
      thresholds: {
        statements: 85,
        branches: 80,
        functions: 72,
        lines: 85,
      },
    },
  },
});
