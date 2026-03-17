import { test, expect } from '@playwright/test';
import { injectVSCodeApiMock, sendExtensionMessage } from './mocks/vscode-api';

/**
 * Helper: send a mock org:list:response so the HomePage exits loading state.
 * The BridgeProvider fires org:list on mount; without a response, loading
 * stays true for 30s, blocking the getting-started card from appearing.
 */
async function resolveOrgListLoading(page: import('@playwright/test').Page): Promise<void> {
  // Wait a tick for the bridge query to register its listener
  await page.waitForTimeout(200);

  // Retrieve the original request's correlationId from captured messages
  const correlationId = await page.evaluate(() => {
    const msgs = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
    const orgListMsg = msgs.find(
      (m) => (m as Record<string, unknown>).type === 'org:list',
    ) as Record<string, unknown> | undefined;
    return orgListMsg?.id as string | undefined;
  });

  // Send the response with the matching correlationId
  await sendExtensionMessage(page, {
    type: 'org:list:response',
    id: `resp-${Date.now()}`,
    correlationId: correlationId ?? 'unknown',
    payload: { orgs: [] },
  });
}

test.describe('Home page', () => {
  test.beforeEach(async ({ page }) => {
    await injectVSCodeApiMock(page);
    await page.goto('/');
    await page.waitForSelector('[data-testid="home-page"]');
  });

  test('renders the home page with data-testid', async ({ page }) => {
    await expect(page.getByTestId('home-page')).toBeVisible();
  });

  test('displays the forge hero card', async ({ page }) => {
    await expect(page.getByTestId('forge-hero-card')).toBeVisible();
  });

  test('displays the forge record input and start button', async ({ page }) => {
    await expect(page.getByTestId('forge-record-input')).toBeVisible();
    await expect(page.getByTestId('start-forge-btn')).toBeVisible();
  });

  test('displays quick actions tile with action buttons', async ({ page }) => {
    const quickActions = page.getByTestId('quick-actions-tile');
    await expect(quickActions).toBeVisible();

    await expect(page.getByTestId('quick-forge-btn')).toBeVisible();
    await expect(page.getByTestId('quick-grappe-btn')).toBeVisible();
    await expect(page.getByTestId('refresh-monitor-btn')).toBeVisible();
    await expect(page.getByTestId('run-pipeline-btn')).toBeVisible();
  });

  test('displays health tile', async ({ page }) => {
    await expect(page.getByTestId('health-tile')).toBeVisible();
  });

  test('displays recent operations tile', async ({ page }) => {
    await expect(page.getByTestId('recent-ops-tile')).toBeVisible();
  });

  test('shows getting started card when no orgs are connected', async ({ page }) => {
    await resolveOrgListLoading(page);
    await expect(page.getByTestId('getting-started-card')).toBeVisible({ timeout: 5000 });
  });

  test('connect org button navigates to orgs page', async ({ page }) => {
    await resolveOrgListLoading(page);
    await page.getByTestId('getting-started-card').waitFor({ state: 'visible', timeout: 5000 });
    await page.getByTestId('connect-org-btn').click();

    // Should navigate away from home
    const homeButton = page.getByTestId('sidebar').getByRole('button', { name: 'Home' });
    await expect(homeButton).not.toHaveAttribute('aria-current', 'page');
  });

  test('quick forge button navigates to forge page', async ({ page }) => {
    await page.getByTestId('quick-forge-btn').click();

    const forgeHero = page.getByTestId('sidebar-forge-hero');
    await expect(forgeHero).toBeVisible();
  });
});
