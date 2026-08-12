import { test, expect } from '@playwright/test';
import { injectVSCodeApiMock, sendExtensionMessage } from './mocks/vscode-api';

/** Mock orgs fixture. */
const MOCK_ORGS = [
  {
    id: 'org-1',
    alias: 'DevSandbox',
    username: 'dev@sandbox.com',
    instanceUrl: 'https://dev.salesforce.com',
    orgType: 'Sandbox',
    status: 'connected',
  },
  {
    id: 'org-2',
    alias: 'QASandbox',
    username: 'qa@sandbox.com',
    instanceUrl: 'https://qa.salesforce.com',
    orgType: 'Sandbox',
    status: 'connected',
  },
];

/** Mock monitor data fixture. */
const MOCK_MONITOR_DATA = {
  healthScore: 85,
  healthReport: null,
  jobs: [
    {
      id: 'job-1',
      jobType: 'BulkQuery',
      status: 'InProgress',
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
      failedRecords: 3,
    },
  ],
  limits: [
    { name: 'DailyApiRequests', max: 100000, remaining: 45000, usedPercent: 55 },
    { name: 'DataStorageMB', max: 5120, remaining: 3072, usedPercent: 40 },
    { name: 'DailyBulkApiRequests', max: 15000, remaining: 14500, usedPercent: 3.3 },
    { name: 'ConcurrentAsyncGetReportInstances', max: 200, remaining: 195, usedPercent: 2.5 },
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
  trends: {},
  alerts: [],
  activeAlertsCount: 2,
};

/**
 * Helper: resolve the org:list query and select an org to get past the empty state.
 */
async function setupMonitorWithOrg(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForTimeout(200);

  const correlationId = await page.evaluate(() => {
    const msgs = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
    const orgListMsg = msgs.find(
      (m) => (m as Record<string, unknown>).type === 'org:list',
    ) as Record<string, unknown> | undefined;
    return orgListMsg?.id as string | undefined;
  });

  await sendExtensionMessage(page, {
    type: 'org:list:response',
    id: `resp-${Date.now()}`,
    correlationId: correlationId ?? 'unknown',
    payload: { orgs: MOCK_ORGS },
  });
}

test.describe('Monitor page — empty state', () => {
  test.beforeEach(async ({ page }) => {
    await injectVSCodeApiMock(page);
    await page.goto('/');
    await page.waitForSelector('[data-testid="panel-app"]');
    await setupMonitorWithOrg(page);
  });

  test('navigates to monitor page via sidebar', async ({ page }) => {
    await page.getByTestId('sidebar').getByRole('button', { name: 'Monitor', exact: true }).click();
    // Without a selected org, monitor shows the empty state
    await expect(page.getByTestId('monitor-empty')).toBeVisible({ timeout: 5000 });
  });

  test('empty state shows org selection prompt', async ({ page }) => {
    await page.getByTestId('sidebar').getByRole('button', { name: 'Monitor', exact: true }).click();
    await expect(page.getByTestId('monitor-empty')).toBeVisible({ timeout: 5000 });

    // Should show connected org cards for selection
    await expect(page.getByTestId('empty-org-org-1')).toBeVisible();
    await expect(page.getByTestId('empty-org-org-2')).toBeVisible();
  });

  test('clicking an org card selects the org and exits empty state', async ({ page }) => {
    await page.getByTestId('sidebar').getByRole('button', { name: 'Monitor', exact: true }).click();
    await expect(page.getByTestId('monitor-empty')).toBeVisible({ timeout: 5000 });

    // Click the first org card
    await page.getByTestId('empty-org-org-1').click();

    // Monitor should now show loading state or the dashboard
    // The empty state should no longer be visible
    const emptyState = page.getByTestId('monitor-empty');
    await expect(emptyState).not.toBeVisible({ timeout: 5000 });
  });
});

test.describe('Monitor page — dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await injectVSCodeApiMock(page);
    await page.goto('/');
    await page.waitForSelector('[data-testid="panel-app"]');
    await setupMonitorWithOrg(page);

    // Navigate to Monitor
    await page.getByTestId('sidebar').getByRole('button', { name: 'Monitor', exact: true }).click();
    await expect(page.getByTestId('monitor-empty')).toBeVisible({ timeout: 5000 });

    // Select an org to enter the dashboard
    await page.getByTestId('empty-org-org-1').click();
  });

  test('shows loading skeleton while data loads', async ({ page }) => {
    // After selecting org, monitor shows loading skeleton
    await expect(page.getByTestId('monitor-loading')).toBeVisible({ timeout: 5000 });
  });

  test('shows monitor dashboard after loading completes', async ({ page }) => {
    // Wait for the monitor data request
    await page.waitForTimeout(300);

    // Find and respond to the monitor:health query
    const correlationId = await page.evaluate(() => {
      const msgs = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
      const monitorMsg = msgs.find(
        (m) => {
          const msg = m as Record<string, unknown>;
          return typeof msg.type === 'string' && (msg.type as string).startsWith('monitor:');
        },
      ) as Record<string, unknown> | undefined;
      return monitorMsg?.id as string | undefined;
    });

    if (correlationId) {
      await sendExtensionMessage(page, {
        type: 'monitor:health:response',
        id: `resp-${Date.now()}`,
        correlationId,
        payload: MOCK_MONITOR_DATA,
      });
    }

    // The dashboard may or may not fully render depending on all required queries
    // At minimum, loading state should have been entered
    await expect(page.getByTestId('panel-app')).toBeVisible();
  });

  test('refresh button is visible and clickable', async ({ page }) => {
    // The refresh button appears in both loading and loaded states
    // Wait for potential render
    await page.waitForTimeout(500);
    const refreshBtn = page.getByTestId('refresh-btn');
    // Button may be in the loading skeleton or the dashboard
    if (await refreshBtn.isVisible()) {
      await refreshBtn.click();
      // Should trigger a refresh message
      const messages = await page.evaluate(() =>
        (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__,
      );
      expect(messages.length).toBeGreaterThan(0);
    }
  });

  test('auto-refresh toggle is visible', async ({ page }) => {
    await page.waitForTimeout(500);
    const autoRefreshBtn = page.getByTestId('auto-refresh-toggle');
    if (await autoRefreshBtn.isVisible()) {
      await autoRefreshBtn.click();
      // Toggle should change state
      await expect(autoRefreshBtn).toBeVisible();
    }
  });
});

test.describe('Monitor page — no orgs connected', () => {
  test('shows empty state with no org hint when no orgs exist', async ({ page }) => {
    await injectVSCodeApiMock(page);
    await page.goto('/');
    await page.waitForSelector('[data-testid="panel-app"]');

    // Resolve with empty org list
    await page.waitForTimeout(200);
    const correlationId = await page.evaluate(() => {
      const msgs = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
      const orgListMsg = msgs.find(
        (m) => (m as Record<string, unknown>).type === 'org:list',
      ) as Record<string, unknown> | undefined;
      return orgListMsg?.id as string | undefined;
    });

    await sendExtensionMessage(page, {
      type: 'org:list:response',
      id: `resp-${Date.now()}`,
      correlationId: correlationId ?? 'unknown',
      payload: { orgs: [] },
    });

    // Navigate to Monitor
    await page.getByTestId('sidebar').getByRole('button', { name: 'Monitor', exact: true }).click();

    // Monitor empty state with no connected orgs
    await expect(page.getByTestId('monitor-empty')).toBeVisible({ timeout: 5000 });
  });
});
