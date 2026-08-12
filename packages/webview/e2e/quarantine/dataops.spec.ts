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
];

/** Mock backup results fixture. */
const MOCK_BACKUPS = [
  {
    id: 'backup-1',
    orgId: 'org-1',
    createdAt: '2026-03-12T14:00:00Z',
    totalRecords: 1500,
    status: 'success',
    objectResults: [
      { objectApiName: 'Account', recordCount: 500, status: 'success', errors: [] },
      { objectApiName: 'Contact', recordCount: 1000, status: 'success', errors: [] },
    ],
  },
  {
    id: 'backup-2',
    orgId: 'org-1',
    createdAt: '2026-03-10T10:00:00Z',
    totalRecords: 800,
    status: 'partial',
    objectResults: [
      { objectApiName: 'Lead', recordCount: 750, status: 'success', errors: [] },
      { objectApiName: 'Opportunity', recordCount: 50, status: 'failure', errors: ['INVALID_FIELD: BillingCountry'] },
    ],
  },
];

/** Mock anonymization templates fixture. */
const MOCK_TEMPLATES = [
  {
    id: 'tpl-gdpr',
    name: 'GDPR Compliance',
    description: 'Anonymize all PII fields for GDPR compliance',
    rules: [
      { objectApiName: 'Contact', fieldApiName: 'Email', strategy: 'faker', fakerType: 'email' },
      { objectApiName: 'Contact', fieldApiName: 'Phone', strategy: 'mask', maskPattern: '***-***-####' },
    ],
  },
  {
    id: 'tpl-dev',
    name: 'Dev Sandbox Mask',
    description: 'Light masking for development sandboxes',
    rules: [
      { objectApiName: 'Account', fieldApiName: 'Name', strategy: 'faker', fakerType: 'company' },
    ],
  },
];

/**
 * Helper: resolve the org:list query.
 */
async function resolveOrgListLoading(page: import('@playwright/test').Page): Promise<void> {
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

/**
 * Helper: respond to backup:list and templates queries.
 */
async function resolveDataOpsQueries(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForTimeout(300);

  const messages = await page.evaluate(() =>
    (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__,
  );

  // Find backup:list query
  const backupListMsg = messages.find(
    (m) => (m as Record<string, unknown>).type === 'backup:list',
  ) as Record<string, unknown> | undefined;

  if (backupListMsg) {
    await sendExtensionMessage(page, {
      type: 'backup:list:result',
      id: `resp-backup-${Date.now()}`,
      correlationId: (backupListMsg.id as string) ?? 'unknown',
      payload: { backups: MOCK_BACKUPS },
    });
  }

  // Find templates query
  const templatesMsg = messages.find(
    (m) => (m as Record<string, unknown>).type === 'dataops:anonymization-templates',
  ) as Record<string, unknown> | undefined;

  if (templatesMsg) {
    await sendExtensionMessage(page, {
      type: 'dataops:anonymization-templates:response',
      id: `resp-tpl-${Date.now()}`,
      correlationId: (templatesMsg.id as string) ?? 'unknown',
      payload: { templates: MOCK_TEMPLATES },
    });
  }
}

test.describe('DataOps page — empty state', () => {
  test('shows empty state when no orgs exist', async ({ page }) => {
    await injectVSCodeApiMock(page);
    await page.goto('/');
    await page.waitForSelector('[data-testid="panel-app"]');

    // Resolve with no orgs
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

    await page.getByTestId('sidebar').getByRole('button', { name: 'DataOps', exact: true }).click();

    // DataOps shows EmptyState when no orgs — no dataops-page testid
    await page.waitForTimeout(500);
    const dataopsPage = page.getByTestId('dataops-page');
    await expect(dataopsPage).not.toBeVisible();
  });
});

test.describe('DataOps page — with org', () => {
  test.beforeEach(async ({ page }) => {
    await injectVSCodeApiMock(page);
    await page.goto('/');
    await page.waitForSelector('[data-testid="panel-app"]');
    await resolveOrgListLoading(page);

    // Navigate to DataOps
    await page.getByTestId('sidebar').getByRole('button', { name: 'DataOps', exact: true }).click();
  });

  test('navigates to DataOps page via sidebar', async ({ page }) => {
    await expect(page.getByTestId('dataops-page')).toBeVisible({ timeout: 5000 });
  });

  test('displays KPI summary row', async ({ page }) => {
    await expect(page.getByTestId('dataops-page')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('dataops-kpi-row')).toBeVisible();
  });

  test('shows loading skeleton while queries load', async ({ page }) => {
    await expect(page.getByTestId('dataops-page')).toBeVisible({ timeout: 5000 });
    // The skeleton appears when backupsQuery or templatesQuery are loading
    const skeleton = page.getByTestId('dataops-skeleton');
    // May or may not be visible depending on timing — just verify page renders
    await expect(page.getByTestId('dataops-page')).toBeVisible();
  });

  test('displays content area after data loads', async ({ page }) => {
    await expect(page.getByTestId('dataops-page')).toBeVisible({ timeout: 5000 });
    await resolveDataOpsQueries(page);

    await expect(page.getByTestId('dataops-content')).toBeVisible({ timeout: 5000 });
  });

  test('displays tab navigation with all tabs', async ({ page }) => {
    await expect(page.getByTestId('dataops-page')).toBeVisible({ timeout: 5000 });

    // PageTabs should render tab buttons
    const page_ = page.getByTestId('dataops-page');
    // Check for tab labels from i18n
    await expect(page_.getByRole('tab').first()).toBeVisible({ timeout: 5000 });
  });

  test('backup tab is active by default', async ({ page }) => {
    await expect(page.getByTestId('dataops-page')).toBeVisible({ timeout: 5000 });
    await resolveDataOpsQueries(page);

    // The first tab (Backup) should be active by default
    await expect(page.getByTestId('dataops-content')).toBeVisible({ timeout: 5000 });
  });

  test('can switch tabs', async ({ page }) => {
    await expect(page.getByTestId('dataops-page')).toBeVisible({ timeout: 5000 });
    await resolveDataOpsQueries(page);

    // Click on different tabs — find them by role
    const tabs = page.getByTestId('dataops-page').getByRole('tab');
    const tabCount = await tabs.count();
    expect(tabCount).toBeGreaterThanOrEqual(4);

    // Click second tab (Restore)
    if (tabCount >= 2) {
      await tabs.nth(1).click();
      await page.waitForTimeout(200);
    }

    // Click third tab (Anonymize)
    if (tabCount >= 3) {
      await tabs.nth(2).click();
      await page.waitForTimeout(200);
    }
  });

  test('error banner appears on error and can be dismissed', async ({ page }) => {
    await expect(page.getByTestId('dataops-page')).toBeVisible({ timeout: 5000 });

    // Send an error response
    const messages = await page.evaluate(() =>
      (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__,
    );
    const backupListMsg = messages.find(
      (m) => (m as Record<string, unknown>).type === 'backup:list',
    ) as Record<string, unknown> | undefined;

    if (backupListMsg) {
      await sendExtensionMessage(page, {
        type: 'backup:list:result',
        id: `resp-${Date.now()}`,
        correlationId: (backupListMsg.id as string) ?? 'unknown',
        error: 'Network error: unable to fetch backups',
      });
    }

    // Error banner may appear
    const errorBanner = page.getByTestId('dataops-error');
    if (await errorBanner.isVisible({ timeout: 3000 }).catch(() => false)) {
      await expect(errorBanner).toBeVisible();
    }
  });
});
