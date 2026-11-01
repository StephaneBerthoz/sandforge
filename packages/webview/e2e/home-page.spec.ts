import { test, expect } from '@playwright/test';
import { injectVSCodeApiMock, sendExtensionMessage } from './mocks/vscode-api';
import { DEV_SANDBOX, MOCK_ORGS } from './fixtures';

/**
 * Answer *every* in-flight `org:list`, not just the first one captured.
 *
 * The Home panel leaves several of them in flight: BridgeProvider fires one on
 * mount, HomePage's own `useBridgeQuery('org:list')` fires another, and React
 * StrictMode re-runs both effects, so each request carries a different id. The
 * previous helper answered `msgs.find(...)` — the first id — which is never the
 * one the live listener is waiting on. `orgsLoading` then stayed true for the
 * hook's full 30s timeout and the getting-started card, gated on
 * `!hasOrgs && !orgsLoading`, never rendered. Same idiom as `respondToAll` in
 * screenshots.spec.ts, for the same reason.
 */
async function answerOrgList(
  page: import('@playwright/test').Page,
  orgs: readonly unknown[],
): Promise<void> {
  // Wait until at least one request is out; the StrictMode twin is posted in
  // the same effect flush, so it is already in the array by the time this
  // resolves.
  await page.waitForFunction(() => {
    const msgs = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
    return msgs.some((m) => {
      const e = m as Record<string, unknown>;
      const inner = (e.payload as Record<string, unknown> | undefined) ?? e;
      return inner.type === 'org:list';
    });
  });

  const ids = await page.evaluate(() => {
    const msgs = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
    return msgs
      .map((m) => {
        const e = m as Record<string, unknown>;
        return (e.payload as Record<string, unknown> | undefined) ?? e;
      })
      .filter((m) => m.type === 'org:list')
      .map((m) => m.id as string);
  });

  for (const correlationId of ids) {
    await sendExtensionMessage(page, {
      type: 'org:list:response',
      id: `resp-${correlationId}`,
      correlationId,
      payload: { orgs: orgs as unknown[] },
    });
  }
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

  /**
   * The hero follows the orgs connected, as the launcher's does: Forge, which
   * copies from one org into another, once there are two.
   */
  test('displays the forge hero card once two orgs are connected', async ({ page }) => {
    await answerOrgList(page, MOCK_ORGS);
    await expect(page.getByTestId('forge-hero-card')).toBeVisible();
    await expect(page.getByTestId('forge-record-input')).toBeVisible();
    await expect(page.getByTestId('start-forge-btn')).toBeVisible();
  });

  test('leads with filling the one Developer Edition connected, not with Forge', async ({
    page,
  }) => {
    await answerOrgList(page, [{ ...DEV_SANDBOX, orgType: 'Developer' }]);
    const hero = page.getByTestId('fill-hero-card');
    await expect(hero.getByRole('heading', { level: 1 })).toHaveText(
      `Fill ${DEV_SANDBOX.alias} with demo data`,
    );
    await expect(page.getByTestId('forge-hero-card')).toHaveCount(0);
  });

  test('displays quick actions tile with action buttons', async ({ page }) => {
    const quickActions = page.getByTestId('quick-actions-tile');
    await expect(quickActions).toBeVisible();

    // Each named by the page it opens: they open it and do nothing more.
    await expect(page.getByTestId('open-forge-btn')).toHaveText('Open Forge');
    await expect(page.getByTestId('open-monitor-btn')).toHaveText('Open Monitor');
    await expect(page.getByTestId('open-automation-btn')).toHaveText('Open Automation');
    // Grappe shows nothing until sandforge.grappe.enabled is on.
    await expect(page.getByTestId('quick-grappe-btn')).toHaveCount(0);
    await sendExtensionMessage(page, {
      type: 'settings:response',
      id: 'settings-grappe-on',
      payload: { settings: {}, grappeEnabled: true },
    });
    await expect(page.getByTestId('quick-grappe-btn')).toBeVisible();
  });

  test('displays health tile', async ({ page }) => {
    await expect(page.getByTestId('health-tile')).toBeVisible();
  });

  test('displays recent operations tile', async ({ page }) => {
    await expect(page.getByTestId('recent-ops-tile')).toBeVisible();
  });

  /**
   * The card is gated on `!hasOrgs && !orgsLoading`, so both halves are worth
   * asserting: it appears once an empty org list has answered, and it goes away
   * once orgs exist. Asserting only the first half would keep passing if the
   * card were rendered unconditionally.
   */
  test('shows getting started card when no orgs are connected', async ({ page }) => {
    await answerOrgList(page, []);

    const card = page.getByTestId('getting-started-card');
    await expect(card).toBeVisible();
    // It is the hero now, with the page's heading, and not under every tile.
    await expect(card.getByRole('heading', { level: 1 })).toHaveText('Getting started');
    await expect(card.getByTestId('home-import-cli-btn')).toHaveText('Import from Salesforce CLI');
    await expect(card.getByTestId('home-login-web-btn')).toHaveText('Log in with your browser');

    // BridgeProvider fills the org store from any `org:list:response`, so a
    // second answer carrying connected orgs is the real path out of the
    // no-orgs state — the card must retract.
    await answerOrgList(page, MOCK_ORGS);
    await expect(card).toHaveCount(0);
  });

  /**
   * Navigation, post-1.8.0: there is no sidebar to leave a `Home` item
   * unhighlighted. Each module is its own panel, and an in-panel `navigate()`
   * swaps what PanelRouter renders inside `panel-app` — so "went to the orgs
   * page" is observable as the org manager replacing Home in the same panel.
   */
  test('the browser login button swaps the panel to the org manager, its form open', async ({
    page,
  }) => {
    await answerOrgList(page, []);
    await page.getByTestId('getting-started-card').waitFor({ state: 'visible' });

    // Precondition, so the assertion below cannot pass on a panel that was
    // already showing the org manager.
    await expect(page.getByTestId('org-manager-page')).toHaveCount(0);
    await page.getByTestId('home-login-web-btn').click();

    await expect(page.getByTestId('org-manager-page')).toBeVisible();
    await expect(page.getByTestId('org-inline-form')).toBeVisible();
    await expect(page.getByTestId('home-page')).toHaveCount(0);
  });

  test('a recent operation opens the page of the module that ran it', async ({ page }) => {
    await answerOrgList(page, MOCK_ORGS);
    await sendExtensionMessage(page, {
      type: 'operation:started',
      id: 'op-started',
      payload: { operationId: 'op-sync', module: 'sync', description: 'Sync Contacts' },
    });
    await sendExtensionMessage(page, {
      type: 'operation:failed',
      id: 'op-failed',
      payload: { operationId: 'op-sync', error: 'refused', retryable: false },
    });
    const row = page.getByTestId('recent-op-item');
    await expect(row).toContainText('Sync Contacts');
    await row.click();

    await expect(page.getByTestId('home-page')).toHaveCount(0);
    await expect(page).toHaveTitle('SandForge: Sync');
  });

  /**
   * Forge short-circuits to an EmptyState (which carries no `forge-page`
   * testid) until an org is selected, so the org list has to be answered with
   * connected orgs before the click — BridgeProvider auto-selects the first.
   */
  test('the Open Forge button swaps the panel to the forge module', async ({ page }) => {
    await answerOrgList(page, MOCK_ORGS);

    await expect(page.getByTestId('forge-page')).toHaveCount(0);
    await page.getByTestId('open-forge-btn').click();

    await expect(page.getByTestId('forge-page')).toBeVisible();
    await expect(page.getByTestId('home-page')).toHaveCount(0);
  });
});
