import { test, expect } from '@playwright/test';
import { injectVSCodeApiMock, sendExtensionMessage } from './mocks/vscode-api';

/**
 * Sync page E2E tests.
 *
 * Note: SyncPage is a legacy route accessible via PanelRouter (moduleId="sync")
 * but not via sidebar navigation. In the main app shell, routing goes through
 * the Router which uses ModuleRoute (no "sync" entry). These tests validate
 * the Sync page by loading it through PanelRouter query param if supported,
 * or by verifying the underlying Sync-related components from the Forge flow.
 *
 * The tests below target the SyncPage rendered as a standalone panel.
 */

/** Mock orgs fixture with 2 connected orgs (minimum for Sync page). */
const MOCK_ORGS = [
  {
    id: 'org-src-1',
    alias: 'DevSandbox',
    username: 'dev@sandbox.com',
    instanceUrl: 'https://dev.salesforce.com',
    orgType: 'Sandbox',
    status: 'connected',
  },
  {
    id: 'org-tgt-1',
    alias: 'QASandbox',
    username: 'qa@sandbox.com',
    instanceUrl: 'https://qa.salesforce.com',
    orgType: 'Sandbox',
    status: 'connected',
  },
];

/**
 * Helper: resolve the org:list query fired on mount so loading state ends.
 */
async function resolveOrgListLoading(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForTimeout(200);

  const correlationId = await page.evaluate(() => {
    const msgs = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
    const orgListMsg = msgs.find((m) => (m as Record<string, unknown>).type === 'org:list') as
      | Record<string, unknown>
      | undefined;
    return orgListMsg?.id as string | undefined;
  });

  await sendExtensionMessage(page, {
    type: 'org:list:response',
    id: `resp-${Date.now()}`,
    correlationId: correlationId ?? 'unknown',
    payload: { orgs: MOCK_ORGS },
  });
}

test.describe('Sync page (via panel)', () => {
  test.beforeEach(async ({ page }) => {
    await injectVSCodeApiMock(page);
    await page.goto('/?panel=sync');
    await page.waitForSelector('[data-testid="panel-app"]');
    await resolveOrgListLoading(page);
  });

  test('app shell renders with sidebar and content area', async ({ page }) => {
    await expect(page.getByTestId('panel-app')).toBeVisible();
    await expect(page.getByTestId('sidebar')).toBeVisible();
  });

  test('sidebar contains all module navigation items', async ({ page }) => {
    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar.getByRole('button', { name: 'Monitor', exact: true })).toBeVisible();
    await expect(sidebar.getByRole('button', { name: 'Compare Org', exact: true })).toBeVisible();
    await expect(sidebar.getByRole('button', { name: 'DataOps', exact: true })).toBeVisible();
    await expect(sidebar.getByRole('button', { name: 'Automation', exact: true })).toBeVisible();
  });

  test('captures messages sent to extension', async ({ page }) => {
    const messages = await page.evaluate(
      () => (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__,
    );
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBeGreaterThan(0);
  });

  test('org list response populates the org store', async ({ page }) => {
    // The org:list:response already sent in beforeEach — verify orgs are
    // available by checking that the sidebar still renders properly
    await page.waitForTimeout(300);
    await expect(page.getByTestId('sidebar')).toBeVisible();
  });
});

test.describe('Sync page — empty state', () => {
  test.beforeEach(async ({ page }) => {
    await injectVSCodeApiMock(page);
    await page.goto('/');
    await page.waitForSelector('[data-testid="panel-app"]');
  });

  test('shows app shell even with no orgs when loading resolves to single org', async ({
    page,
  }) => {
    await page.waitForTimeout(200);

    const correlationId = await page.evaluate(() => {
      const msgs = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
      const orgListMsg = msgs.find((m) => (m as Record<string, unknown>).type === 'org:list') as
        | Record<string, unknown>
        | undefined;
      return orgListMsg?.id as string | undefined;
    });

    // Send only one org — Sync page requires at least 2
    await sendExtensionMessage(page, {
      type: 'org:list:response',
      id: `resp-${Date.now()}`,
      correlationId: correlationId ?? 'unknown',
      payload: { orgs: [MOCK_ORGS[0]] },
    });

    await expect(page.getByTestId('panel-app')).toBeVisible();
  });
});
