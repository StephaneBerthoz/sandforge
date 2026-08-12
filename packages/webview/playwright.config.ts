import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E configuration for the SandForge webview.
 *
 * Runs against the Vite dev server on port 5173.
 * Only Chromium is configured since VSCode webviews use a Chromium-based shell.
 */
export default defineConfig({
  testDir: './e2e',
  // Specs driving surfaces that no longer exist. Kept, not deleted — see
  // e2e/quarantine/README.md for why each one is there and what unblocks it.
  // Everything still in e2e/ must be able to fail for a real reason.
  testIgnore: ['**/quarantine/**'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['html', { open: 'never' }]],

  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'npx vite --config vite.config.e2e.ts',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
