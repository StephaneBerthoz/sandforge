import { test, expect } from '@playwright/test';
import { injectVSCodeApiMock, sendExtensionMessage } from './mocks/vscode-api';

/**
 * Helper: inject mock orgs into the org store so the Forge page
 * renders its input form instead of the empty state.
 */
async function injectMockOrgs(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const event = new MessageEvent('message', {
      data: {
        type: 'org:list:response',
        id: `resp-${Date.now()}`,
        correlationId: 'boot',
        payload: {
          orgs: [
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
          ],
        },
      },
      origin: '',
    });
    window.dispatchEvent(event);
  });
}

/**
 * Helper: resolve the org:list query that fires on mount so the page
 * exits its loading state.
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
    payload: {
      orgs: [
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
      ],
    },
  });
}

test.describe('Forge / Seed page', () => {
  test.beforeEach(async ({ page }) => {
    await injectVSCodeApiMock(page);
    await page.goto('/');
    await page.waitForSelector('[data-testid="panel-app"]');
    await resolveOrgListLoading(page);
  });

  test('navigates to forge page via sidebar hero button', async ({ page }) => {
    await page.getByTestId('sidebar-forge-hero').click();
    await expect(page.getByTestId('forge-page')).toBeVisible();
  });

  test('displays forge input form with tab navigation', async ({ page }) => {
    await page.getByTestId('sidebar-forge-hero').click();
    await expect(page.getByTestId('forge-page')).toBeVisible();
    await expect(page.getByTestId('forge-input')).toBeVisible();

    // Tab buttons are visible
    await expect(page.getByTestId('forge-tab-record')).toBeVisible();
    await expect(page.getByTestId('forge-tab-soql')).toBeVisible();
    await expect(page.getByTestId('forge-tab-template')).toBeVisible();
    await expect(page.getByTestId('forge-tab-ai')).toBeVisible();
  });

  test('displays record ID input on the record tab', async ({ page }) => {
    await page.getByTestId('sidebar-forge-hero').click();
    await expect(page.getByTestId('forge-input-record')).toBeVisible();
  });

  test('switches to SOQL tab and shows textarea', async ({ page }) => {
    await page.getByTestId('sidebar-forge-hero').click();
    await page.getByTestId('forge-tab-soql').click();
    await expect(page.getByTestId('forge-input-soql')).toBeVisible();
  });

  test('switches to AI tab and shows prompt textarea', async ({ page }) => {
    await page.getByTestId('sidebar-forge-hero').click();
    await page.getByTestId('forge-tab-ai').click();
    await expect(page.getByTestId('forge-input-ai')).toBeVisible();
  });

  test('displays depth selector chips', async ({ page }) => {
    await page.getByTestId('sidebar-forge-hero').click();
    await expect(page.getByTestId('forge-depth-direct')).toBeVisible();
    await expect(page.getByTestId('forge-depth-full')).toBeVisible();
    await expect(page.getByTestId('forge-depth-custom')).toBeVisible();
  });

  test('selecting custom depth shows numeric input', async ({ page }) => {
    await page.getByTestId('sidebar-forge-hero').click();
    await page.getByTestId('forge-depth-custom').click();
    await expect(page.getByTestId('forge-depth-custom-input')).toBeVisible();
  });

  test('displays org selection cards for source and target', async ({ page }) => {
    await page.getByTestId('sidebar-forge-hero').click();
    await expect(page.getByTestId('forge-source-org')).toBeVisible();
    await expect(page.getByTestId('forge-target-org')).toBeVisible();
  });

  test('displays option toggles for anonymize and skip empty', async ({ page }) => {
    await page.getByTestId('sidebar-forge-hero').click();
    await expect(page.getByTestId('forge-anonymize-toggle')).toBeAttached();
    await expect(page.getByTestId('forge-skip-empty-toggle')).toBeAttached();
  });

  test('discover button is disabled when no input and no orgs selected', async ({ page }) => {
    await page.getByTestId('sidebar-forge-hero').click();
    await expect(page.getByTestId('forge-discover-btn')).toBeDisabled();
  });

  test('discover button becomes enabled when record ID and orgs are provided', async ({ page }) => {
    await page.getByTestId('sidebar-forge-hero').click();

    // Select source org
    await page.getByTestId('forge-source-org').selectOption('org-src-1');
    // Select target org
    await page.getByTestId('forge-target-org').selectOption('org-tgt-1');
    // Type a record ID
    await page.getByTestId('forge-input-record').fill('001000000000001');

    await expect(page.getByTestId('forge-discover-btn')).toBeEnabled();
  });

  test('preview button is disabled without a valid record ID', async ({ page }) => {
    await page.getByTestId('sidebar-forge-hero').click();
    await expect(page.getByTestId('forge-preview-btn')).toBeDisabled();
  });

  test('typing a record ID and selecting source org enables preview button', async ({ page }) => {
    await page.getByTestId('sidebar-forge-hero').click();

    await page.getByTestId('forge-source-org').selectOption('org-src-1');
    await page.getByTestId('forge-input-record').fill('001000000000001');

    await expect(page.getByTestId('forge-preview-btn')).toBeEnabled();
  });

  test('clicking preview sends forge:preview message to extension', async ({ page }) => {
    await page.getByTestId('sidebar-forge-hero').click();

    await page.getByTestId('forge-source-org').selectOption('org-src-1');
    await page.getByTestId('forge-input-record').fill('001000000000001');
    await page.getByTestId('forge-preview-btn').click();

    const messages = await page.evaluate(
      () => (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__,
    );
    const previewMsg = messages.find(
      (m) => (m as Record<string, unknown>).type === 'forge:preview',
    );
    expect(previewMsg).toBeDefined();
  });

  test('displays record preview when extension sends preview response', async ({ page }) => {
    await page.getByTestId('sidebar-forge-hero').click();

    await page.getByTestId('forge-source-org').selectOption('org-src-1');
    await page.getByTestId('forge-input-record').fill('001000000000001');
    await page.getByTestId('forge-preview-btn').click();

    // Simulate extension response
    await sendExtensionMessage(page, {
      type: 'forge:preview:response',
      id: `resp-${Date.now()}`,
      payload: {
        objectApiName: 'Account',
        objectLabel: 'Account',
        recordId: '001000000000001AAA',
        fields: [
          { name: 'Name', value: 'Acme Corp' },
          { name: 'Industry', value: 'Technology' },
          { name: 'Email', value: 'info@acme.com' },
        ],
      },
    });

    await expect(page.getByTestId('forge-record-preview')).toBeVisible({ timeout: 5000 });
  });

  test('shows PII warning when preview contains PII fields and anonymize is off', async ({
    page,
  }) => {
    await page.getByTestId('sidebar-forge-hero').click();

    await page.getByTestId('forge-source-org').selectOption('org-src-1');
    await page.getByTestId('forge-input-record').fill('001000000000001');
    await page.getByTestId('forge-preview-btn').click();

    await sendExtensionMessage(page, {
      type: 'forge:preview:response',
      id: `resp-${Date.now()}`,
      payload: {
        objectApiName: 'Contact',
        objectLabel: 'Contact',
        recordId: '003000000000001AAA',
        fields: [
          { name: 'Name', value: 'John Doe' },
          { name: 'Email', value: 'john@example.com' },
          { name: 'Phone', value: '+1234567890' },
        ],
      },
    });

    await expect(page.getByTestId('forge-pii-warning')).toBeVisible({ timeout: 5000 });
  });
});
