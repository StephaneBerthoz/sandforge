import { defineConfig } from 'vitest/config';

/**
 * Repo-root suite: the gates that assert on documentation and CI examples.
 *
 * These live outside the three packages because what they check lives outside
 * them — README claims, `docs/`, `ci-examples/`. Each package's vitest config
 * includes only its own `src/**`, so without this config nothing ran them:
 * they were written, they passed locally when invoked by hand, and every
 * subsequent `pnpm validate` skipped them silently.
 *
 * Wired into `pnpm validate` as `test:docs`, next to `test:gates` — which runs
 * the sibling gates written against `node:test` rather than vitest.
 */
export default defineConfig({
  test: {
    include: ['docs/**/*.test.ts', 'ci-examples/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
