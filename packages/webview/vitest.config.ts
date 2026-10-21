import { defineConfig } from 'vitest/config';
import { englishCatalogue } from './vite.config.ts';

export default defineConfig({
  /* The loaders of the English namespaces resolve here as in the build. The
     tests start with the whole catalogue (no alias to the panel's), so a
     component rendered on its own has its English: what a page loads with
     it is held to what it renders by src/PanelRouter.english.test.ts. */
  plugins: [englishCatalogue()],
  define: {
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
  },
  test: {
    globals: true,
    environment: 'jsdom',
    /* Vitest 5 clears every mock's calls before each test by default, where
       Vitest 4 kept them: a test asserting what a module did as it was
       imported (the i18n boot restore) then read no call at all. */
    clearMocks: false,
    include: ['src/**/*.test.{ts,tsx}'],
    /* See packages/extension/vitest.config.ts — absorb event-loop starvation
       when the three suites run in parallel under `pnpm validate`. */
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/index.ts',
        'src/main.tsx',
        // Test-only bridge doubles (e.g. i18n/testing/mockLocaleBridge.ts).
        'src/**/testing/**',
      ],
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
