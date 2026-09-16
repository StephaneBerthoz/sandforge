import { defineConfig, devices, type ReporterDescription } from '@playwright/test';

/**
 * Playwright E2E configuration for the SandForge webview.
 *
 * Only Chromium is configured since VSCode webviews use a Chromium-based shell.
 *
 * The dev server port comes from `E2E_PORT` so that two checkouts can run the
 * suite at the same time. They could not before: both booted a server on 5173,
 * the second reused the first one's, and the first checkout's sources answered
 * the second checkout's assertions. `--strictPort` makes a collision an error
 * instead of a silent hop to the next free port, which would leave the server
 * and the tests looking at two different ones.
 *
 * The value is read once and checked here, where the run can still be stopped
 * with a sentence naming the variable. Handed straight to `Number`, a blank
 * `E2E_PORT` became port 0 — a random port, with the server reuse an empty
 * string is falsy enough to turn back on — and a typo became `--port NaN`,
 * which the dev server rejects without a word about where NaN came from. A
 * blank value is no port at all, which is what an unset variable means too.
 */
const requestedPort = process.env.E2E_PORT?.trim() || undefined;
if (requestedPort !== undefined && !/^\d+$/.test(requestedPort)) {
  throw new Error(`E2E_PORT must be a whole number, got "${process.env.E2E_PORT}"`);
}
const port = requestedPort === undefined ? 5173 : Number(requestedPort);
if (port < 1 || port > 65535) {
  throw new Error(`E2E_PORT must be a port between 1 and 65535, got "${requestedPort}"`);
}
const baseURL = `http://localhost:${port}`;

/**
 * html for reading a failure, json for counting retries.
 *
 * A test that fails and then passes leaves a green run, and the html report is
 * an artifact nobody opens when the run is green — so a flake was recorded
 * nowhere. `stats.flaky` in the json report is what CI reads to annotate it.
 * The github reporter only has somewhere to write when it runs there.
 */
const reporter: ReporterDescription[] = [
  ['html', { open: 'never' }],
  ['json', { outputFile: 'test-results/results.json' }],
];
if (process.env.CI) reporter.push(['github']);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter,

  use: {
    baseURL,
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
    command: `npx vite --config vite.config.e2e.ts --port ${port} --strictPort`,
    url: baseURL,
    // A run that asked for its own port must own the server on it: reusing
    // one started by another checkout is the failure this port exists to end.
    // An empty E2E_PORT counts as unset here too, as it does for the port.
    reuseExistingServer: !process.env.CI && requestedPort === undefined,
    timeout: 30_000,
  },
});
