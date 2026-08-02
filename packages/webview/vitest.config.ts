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
      // (lines 89.9 / branches 85.3 / functions 76.9). Raise as coverage grows.
      thresholds: {
        statements: 85,
        branches: 80,
        functions: 72,
        lines: 85,
      },
    },
  },
});
