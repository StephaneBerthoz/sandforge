import { chromium, type FullConfig } from '@playwright/test';

/**
 * Load the panel once before any test, so the dev server has transformed its
 * modules by the time the first tests open it.
 *
 * Vite answers the page at once and transforms each module on its first
 * request: the server counted as ready while the panel's first load, asked by
 * six workers at the same time, still had hundreds of modules to transform.
 * Run in full on 2026-09-30, the first five tests of the suite waited past the
 * ten seconds `seedOrgs` gives the panel's first message, and every test after
 * them passed. Waiting for the network to settle is enough: a module the panel
 * requests is transformed, whatever the page does with it.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) return;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(baseURL, { waitUntil: 'networkidle', timeout: 120_000 });
  } finally {
    await browser.close();
  }
}
