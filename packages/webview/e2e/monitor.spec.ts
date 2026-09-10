import { test, expect, type Page } from '@playwright/test';
import { MockBridge } from './helpers';
import { DEV_SANDBOX, QA_SANDBOX, MOCK_ORGS } from './fixtures';
import { sendExtensionMessage } from './mocks/vscode-api';

/**
 * Monitor E2E.
 *
 * The panel is booted directly (`__SANDFORGE_MODULE__ = 'monitor'`) because
 * that is how the extension opens it — there has been no in-app navigation
 * sidebar since 1.8.0, and the five `getByTestId('sidebar')` clicks this file
 * used to open with were the only reason none of it ran.
 *
 * Two org states have to be produced on purpose, because they are genuinely
 * different screens:
 *
 *  - **selected org** — answer `org:list`, and BridgeProvider auto-selects the
 *    first *connected* org (`BridgeProvider.tsx`), which is what puts the
 *    dashboard on screen.
 *  - **orgs, no selection** — push `state:sync` instead. The extension's
 *    `WebviewStateSync` carries `selectedOrgId: null` until someone picks an
 *    org (`extension.ts:277`), and `OrgHandler.syncOrgState()` pushes org
 *    changes through that same channel, so a panel can legitimately hold a
 *    populated org list with nothing selected. Answering `org:list` here
 *    instead would auto-select and the picker would never render.
 *
 * Every in-flight request is answered against its own correlationId: React
 * StrictMode mounts each `useBridgeQuery` twice, and `useMessageResponse`
 * drops any response whose correlationId does not match the *live* request.
 */

/** Boot the Monitor panel with nothing answered yet. */
async function openMonitor(page: Page): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'monitor';
  });
  await page.goto('/');
  return bridge;
}

/** Every outgoing message of a type, unwrapped from the post envelope. */
async function outgoing(page: Page, type: string): Promise<Record<string, unknown>[]> {
  return page.evaluate((msgType) => {
    const msgs = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
    return msgs
      .map((m) => {
        const e = m as Record<string, unknown>;
        return (e.payload as Record<string, unknown> | undefined) ?? e;
      })
      .filter((m) => m.type === msgType) as Record<string, unknown>[];
  }, type);
}

/**
 * Answer *every* pending request of a type, not just the first.
 *
 * StrictMode's double mount leaves two ids in flight for the same query;
 * answering only the first leaves the live one waiting out its 30 s timeout,
 * which is what kept this page on its skeleton.
 */
async function respondToAll(
  page: Page,
  requestType: string,
  responseType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  for (const request of await outgoing(page, requestType)) {
    const correlationId = request.id as string;
    await sendExtensionMessage(page, {
      type: responseType,
      id: `resp-${correlationId}`,
      correlationId,
      payload,
    });
  }
}

/** Push a `state:sync` snapshot: orgs known, none selected yet. */
async function pushOrgsWithoutSelection(page: Page, orgs: readonly unknown[]): Promise<void> {
  await sendExtensionMessage(page, {
    type: 'state:sync',
    id: `state-sync-${Date.now()}`,
    payload: {
      orgs,
      settings: {},
      activeOperations: [],
      extensionReady: true,
      selectedOrgId: null,
    },
  });
}

/**
 * Boot Monitor holding `orgs` with no selection.
 *
 * Waiting for `org:list` first is not cosmetic: it proves BridgeProvider has
 * mounted and its `state:sync` listener is subscribed, so the snapshot below
 * cannot be dispatched into a page that is not listening yet. The request is
 * then deliberately left unanswered — answering it would auto-select.
 */
async function openMonitorWithoutSelection(
  page: Page,
  orgs: readonly unknown[],
): Promise<MockBridge> {
  const bridge = await openMonitor(page);
  await bridge.waitForMessage('org:list', { timeout: 10_000 });
  await pushOrgsWithoutSelection(page, orgs);
  return bridge;
}

/** Boot Monitor on a selected org (BridgeProvider picks the first connected one). */
async function openMonitorOnSelectedOrg(page: Page): Promise<MockBridge> {
  const bridge = await openMonitor(page);
  await bridge.seedOrgs(MOCK_ORGS);
  return bridge;
}

/** An org the user connected once and that is no longer reachable. */
const OFFLINE_ORG = {
  id: 'org-offline-1',
  alias: 'RetiredSandbox',
  username: 'retired@sandbox.com',
  instanceUrl: 'https://retired.salesforce.com',
  orgType: 'Sandbox',
  status: 'disconnected',
};

/**
 * `monitor:data` as MonitorOpsHandler builds it
 * (`MonitorOpsHandler.ts:419`) — limits, jobs, health, org info, lastUpdated.
 * `activeAlertsCount` is *not* part of it: the page counts alerts from the
 * separate `monitor:alerts` query, which is why this file answers both.
 */
const MOCK_MONITOR_DATA = {
  healthScore: 85,
  healthReport: null,
  jobs: [
    {
      id: 'job-1',
      jobType: 'BulkQuery',
      status: 'Processing',
      objectType: 'Account',
      createdBy: 'admin@sandbox.com',
      createdDate: '2026-03-13T10:00:00Z',
      totalRecords: 5000,
      processedRecords: 2500,
      failedRecords: 0,
    },
    {
      id: 'job-2',
      jobType: 'BulkUpsert',
      status: 'Completed',
      objectType: 'Contact',
      createdBy: 'admin@sandbox.com',
      createdDate: '2026-03-13T09:00:00Z',
      totalRecords: 1200,
      processedRecords: 1200,
      failedRecords: 0,
    },
    {
      id: 'job-3',
      jobType: 'BulkDelete',
      status: 'Failed',
      objectType: 'Lead',
      createdBy: 'dev@sandbox.com',
      createdDate: '2026-03-13T11:00:00Z',
      totalRecords: 800,
      processedRecords: 120,
      failedRecords: 680,
    },
  ],
  limits: [
    { name: 'DailyApiRequests', max: 100000, remaining: 45000, usedPercent: 55 },
    { name: 'DataStorageMB', max: 5120, remaining: 3072, usedPercent: 40 },
    { name: 'FileStorageMB', max: 10240, remaining: 8192, usedPercent: 20 },
    { name: 'DailyBulkApiBatches', max: 15000, remaining: 14500, usedPercent: 3.3 },
  ],
  orgInfo: {
    orgId: '00D000000000001',
    name: 'DevSandbox',
    edition: 'Enterprise',
    instanceName: 'CS42',
    apiVersion: '60.0',
    userCount: 25,
    customObjectCount: 45,
    apexClassCount: 120,
    flowCount: 30,
    isHyperforce: false,
  },
  // Left empty on purpose: two sparkline points would mount Recharts and its
  // 1.5 s entry animation, which buys the assertions below nothing.
  trends: {},
  lastUpdated: '2026-03-13T11:05:00Z',
};

/** `monitor:alerts:result` payload — two countable, one already resolved. */
const MOCK_ALERTS = {
  alerts: [
    {
      id: 'alert-1',
      definitionId: 'def-1',
      severity: 'critical',
      status: 'active',
      message: 'DailyApiRequests above 90%',
      currentValue: 92,
      threshold: 90,
      orgId: DEV_SANDBOX.id,
      triggeredAt: '2026-03-13T10:30:00Z',
    },
    {
      id: 'alert-2',
      definitionId: 'def-2',
      severity: 'warning',
      status: 'acknowledged',
      message: 'DataStorageMB above 75%',
      currentValue: 78,
      threshold: 75,
      orgId: DEV_SANDBOX.id,
      triggeredAt: '2026-03-13T09:15:00Z',
      acknowledgedAt: '2026-03-13T09:20:00Z',
    },
    {
      id: 'alert-3',
      definitionId: 'def-3',
      severity: 'info',
      status: 'resolved',
      message: 'Sandbox refresh completed',
      currentValue: 0,
      threshold: 1,
      orgId: DEV_SANDBOX.id,
      triggeredAt: '2026-03-12T08:00:00Z',
      resolvedAt: '2026-03-12T08:30:00Z',
    },
  ],
  history: [],
};

/** Answer the two queries the dashboard needs, and wait for it to render. */
async function loadDashboard(page: Page, bridge: MockBridge): Promise<void> {
  await bridge.waitForMessage('monitor:refresh', { timeout: 10_000 });
  await respondToAll(page, 'monitor:refresh', 'monitor:data', MOCK_MONITOR_DATA);
  await page.getByTestId('monitor-page').waitFor({ state: 'visible', timeout: 10_000 });
  // AlertHistoryPanel only mounts with the dashboard, so its `monitor:alerts`
  // request exists only now — answering earlier would miss it.
  await respondToAll(page, 'monitor:alerts', 'monitor:alerts:result', MOCK_ALERTS);
}

test.describe('Monitor — org picker (orgs known, none selected)', () => {
  test('shows the picker instead of the dashboard', async ({ page }) => {
    await openMonitorWithoutSelection(page, MOCK_ORGS);

    await expect(page.getByTestId('monitor-empty')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('monitor-page')).toHaveCount(0);
    await expect(page.getByTestId('monitor-loading')).toHaveCount(0);

    // Nothing is queried for an org that has not been chosen — every monitor
    // query is `skip`ped while `selectedOrgId` is null.
    expect(await outgoing(page, 'monitor:refresh')).toHaveLength(0);
  });

  test('offers one card per connected org, and none for a disconnected one', async ({ page }) => {
    await openMonitorWithoutSelection(page, [DEV_SANDBOX, QA_SANDBOX, OFFLINE_ORG]);
    await expect(page.getByTestId('monitor-empty')).toBeVisible({ timeout: 10_000 });

    await expect(page.getByTestId(`empty-org-${DEV_SANDBOX.id}`)).toContainText('DevSandbox');
    await expect(page.getByTestId(`empty-org-${QA_SANDBOX.id}`)).toContainText('QASandbox');
    await expect(page.getByTestId(`empty-org-${OFFLINE_ORG.id}`)).toHaveCount(0);
  });

  test('picking an org tells the extension and starts the dashboard load', async ({ page }) => {
    const bridge = await openMonitorWithoutSelection(page, MOCK_ORGS);
    await expect(page.getByTestId('monitor-empty')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId(`empty-org-${QA_SANDBOX.id}`).click();

    // The picker gives way to the loading skeleton…
    await expect(page.getByTestId('monitor-empty')).toHaveCount(0);
    await expect(page.getByTestId('monitor-loading')).toBeVisible({ timeout: 10_000 });

    // …the selection propagates to the extension (status bar + other panels)…
    const selects = await outgoing(page, 'org:select');
    expect(selects.map((m) => (m.payload as Record<string, unknown>).orgId)).toContain(
      QA_SANDBOX.id,
    );

    // …and the refresh is fired for the org that was actually clicked.
    const refresh = await bridge.waitForMessage('monitor:refresh', { timeout: 10_000 });
    expect(refresh.payload).toEqual({ orgId: QA_SANDBOX.id });
  });
});

test.describe('Monitor — dashboard', () => {
  let bridge: MockBridge;

  test.beforeEach(async ({ page }) => {
    bridge = await openMonitorOnSelectedOrg(page);
  });

  test('holds the loading skeleton until monitor:data arrives', async ({ page }) => {
    await expect(page.getByTestId('monitor-loading')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('monitor-page')).toHaveCount(0);

    await loadDashboard(page, bridge);

    await expect(page.getByTestId('monitor-loading')).toHaveCount(0);
    await expect(page.getByTestId('monitor-page')).toBeVisible();
  });

  test('renders org identity and KPIs from the payload', async ({ page }) => {
    await loadDashboard(page, bridge);

    // The org under observation carries the page's only h1.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('DevSandbox');

    await expect(page.getByTestId('org-info-panel')).toContainText('Enterprise');
    await expect(page.getByTestId('org-info-panel')).toContainText('CS42');
    await expect(page.getByTestId('org-info-panel')).toContainText('00D000000000001');

    // API calls used = max - remaining, not the raw limit.
    const apiCard = page.getByTestId('kpi-card').filter({ hasText: 'API Calls Today' });
    await expect(apiCard.getByTestId('kpi-value')).toHaveText('55,000');
    await expect(apiCard.getByTestId('kpi-subtitle')).toHaveText('/ 100,000');

    // 5120 - 3072 MB = 2.0 GB of 5.0 GB.
    const storageCard = page.getByTestId('kpi-card').filter({ hasText: 'Data Storage' });
    await expect(storageCard.getByTestId('kpi-value')).toHaveText('2.0 GB');

    // Alerts come from monitor:alerts, and only active/acknowledged count —
    // the resolved one must not show up here.
    const alertsCard = page.getByTestId('kpi-card').filter({ hasText: 'Alerts' });
    await expect(alertsCard.getByTestId('kpi-value')).toHaveText('2');

    // The daily-limit countdown ticks every second, so assert its shape, never
    // a value: a fixed expectation here would be a flake generator.
    await expect(page.getByTestId('reset-countdown')).toBeVisible();
    await expect(page.getByTestId('reset-countdown-value')).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
  });

  test('governor limits expand to every limit in the payload', async ({ page }) => {
    await loadDashboard(page, bridge);

    // The section ships collapsed; its SectionHeader toggle is the button
    // immediately before the title.
    const limitsTitle = page.getByRole('heading', { name: 'Governor Limits' });
    await expect(page.getByTestId('limit-DailyApiRequests')).toHaveCount(0);
    await limitsTitle.locator('xpath=preceding-sibling::button[1]').click();

    for (const limit of MOCK_MONITOR_DATA.limits) {
      await expect(page.getByTestId(`limit-${limit.name}`)).toBeVisible();
    }

    // Used / max and the rounded percentage, for the busiest limit.
    const apiRow = page.getByTestId('limit-DailyApiRequests');
    await expect(apiRow).toContainText('55,000 / 100,000');
    await expect(apiRow).toContainText('55%');

    // Sorted by usage descending, so the least-used limit lands last.
    const names = await page
      .locator('[data-testid^="limit-Daily"], [data-testid^="limit-DataStorage"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
    expect(names[0]).toBe('limit-DailyApiRequests');
    expect(names.at(-1)).toBe('limit-DailyBulkApiBatches');
  });

  test('jobs table counts, groups and filters the payload jobs', async ({ page }) => {
    await loadDashboard(page, bridge);

    await expect(page.getByTestId('filter-count-all')).toHaveText('3');
    await expect(page.getByTestId('filter-count-running')).toHaveText('1');
    await expect(page.getByTestId('filter-count-failed')).toHaveText('1');
    await expect(page.getByTestId('filter-count-completed')).toHaveText('1');

    // One accordion group per job type, collapsed until asked.
    await expect(page.getByTestId('job-group-BulkQuery')).toBeVisible();
    await expect(page.getByTestId('job-group-BulkUpsert')).toBeVisible();
    await expect(page.getByTestId('job-group-BulkDelete')).toBeVisible();
    await expect(page.getByTestId('job-row-job-1')).toHaveCount(0);

    await page.getByTestId('group-toggle-BulkQuery').click();
    await expect(page.getByTestId('job-row-job-1')).toBeVisible();

    // Filtering drops the groups that no longer hold a matching job.
    await page.getByTestId('filter-failed').click();
    await expect(page.getByTestId('job-group-BulkDelete')).toBeVisible();
    await expect(page.getByTestId('job-group-BulkQuery')).toHaveCount(0);
    await expect(page.getByTestId('job-group-BulkUpsert')).toHaveCount(0);
  });

  test('refresh re-queries the extension and disables itself while in flight', async ({ page }) => {
    await loadDashboard(page, bridge);

    const before = (await outgoing(page, 'monitor:refresh')).length;
    const refreshBtn = page.getByTestId('refresh-btn');
    await expect(refreshBtn).toBeEnabled();

    await refreshBtn.click();

    await expect
      .poll(async () => (await outgoing(page, 'monitor:refresh')).length, { timeout: 10_000 })
      .toBeGreaterThan(before);
    // A second click cannot stack a second refresh on the first.
    await expect(refreshBtn).toBeDisabled();

    await respondToAll(page, 'monitor:refresh', 'monitor:data', MOCK_MONITOR_DATA);
    await expect(refreshBtn).toBeEnabled();
    await expect(page.getByTestId('monitor-page')).toBeVisible();
  });

  test('auto-refresh toggle flips its pressed state', async ({ page }) => {
    await loadDashboard(page, bridge);

    const toggle = page.getByTestId('auto-refresh-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });
});

test.describe('Monitor — nothing to monitor', () => {
  test('no orgs at all shows the module empty state, not the picker', async ({ page }) => {
    const bridge = await openMonitor(page);
    await bridge.seedOrgs([]);

    await expect(page.getByTestId('empty-state')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('empty-illustration-monitor')).toBeVisible();
    await expect(page.getByTestId('empty-action-button')).toBeVisible();
    await expect(page.getByTestId('monitor-empty')).toHaveCount(0);
  });

  test('orgs that are all disconnected show the connect hint and no cards', async ({ page }) => {
    await openMonitorWithoutSelection(page, [OFFLINE_ORG]);

    // Orgs exist, so this is the picker — but there is nothing to pick.
    await expect(page.getByTestId('monitor-empty')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('monitor-empty')).toContainText('No connected orgs');
    await expect(page.getByTestId(`empty-org-${OFFLINE_ORG.id}`)).toHaveCount(0);
  });
});
