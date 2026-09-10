import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

import { MockBridge } from './helpers';
import { MOCK_ORGS, DEV_SANDBOX } from './fixtures';

/**
 * Sync panel E2E tests.
 *
 * The extension opens one module per panel — it injects `__SANDFORGE_MODULE__`
 * and `main.tsx` renders that module through `PanelApp`. There has been no
 * in-app navigation sidebar since 1.8.0, and `?panel=sync` was never read by
 * anything: a spec that navigated to it landed on the Home fallback and then
 * asserted against a shell that no longer exists. These tests boot the Sync
 * panel the way the extension does, following `screenshots.spec.ts`.
 */

/** Boot the app straight into the Sync panel, with `orgs` already connected. */
async function openSync(page: Page, orgs: readonly unknown[] = MOCK_ORGS): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'sync';
  });
  await page.goto('/');
  await bridge.seedOrgs(orgs);
  return bridge;
}

test.describe('Sync panel — org bridge', () => {
  // A third test used to sit here, asserting only that `org:list` went out.
  // It was removed rather than kept: every org-gated panel sends that request,
  // so the same body passed unchanged when booted on Home — it never tested
  // Sync, despite its name. The test below subsumes it anyway, since the store
  // cannot be populated by a response to a request that was never sent.
  test('org list response populates the org store', async ({ page }) => {
    const bridge = await openSync(page);

    // SyncPage short-circuits to its EmptyState below two orgs, so `sync-page`
    // rendering at all is the first proof the response reached the store.
    await expect(page.getByTestId('sync-page')).toBeVisible();

    // Both orgs from the payload, by the alias the response carried.
    const sourceSelect = page.getByLabel('Source', { exact: true });
    const targetSelect = page.getByLabel('Target', { exact: true });
    await expect(sourceSelect.locator('option[value="org-src-1"]')).toHaveText(/DevSandbox/);
    await expect(sourceSelect.locator('option[value="org-tgt-1"]')).toHaveText(/QASandbox/);
    await expect(targetSelect.locator('option[value="org-src-1"]')).toHaveText(/DevSandbox/);
    await expect(targetSelect.locator('option[value="org-tgt-1"]')).toHaveText(/QASandbox/);

    // And the store's org id travels back out: picking the source fires the
    // describe carrying it. A store that merely rendered the right labels but
    // handed the next request the wrong id would still pass the checks above.
    await sourceSelect.selectOption('org-src-1');
    const describe = await bridge.waitForMessage('sync:describe-global', { timeout: 10_000 });
    expect((describe.payload as Record<string, unknown>).orgId).toBe('org-src-1');
  });
});

test.describe('Sync panel — empty state', () => {
  test('a single connected org holds Sync on its empty state', async ({ page }) => {
    // Sync moves data between two orgs; one is not a degraded run, it is no run.
    await openSync(page, [DEV_SANDBOX]);

    await expect(page.getByTestId('empty-state')).toBeVisible();
    await expect(page.getByTestId('empty-illustration-sync')).toBeVisible();
    // The first step is org-count aware: with one org it asks for a second,
    // not for the two an empty org list would ask for.
    await expect(page.getByTestId('empty-step-0')).toContainText('Connect a second org');
    await expect(page.getByTestId('sync-page')).toHaveCount(0);
  });
});
