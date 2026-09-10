import { test, expect, type Page } from '@playwright/test';
import { MockBridge } from './helpers';
import { MOCK_ORGS } from './fixtures';
import { sendExtensionMessage } from './mocks/vscode-api';

/**
 * DataOps E2E.
 *
 * The panel is booted directly (`__SANDFORGE_MODULE__ = 'dataops'`) because
 * that is how the extension opens it — there has been no in-app navigation
 * sidebar since 1.8.0. The previous version of this file clicked
 * `getByTestId('sidebar')`, a shell element that stopped existing three minor
 * versions ago, so every test in it timed out before it reached the page.
 *
 * DataOps hangs on two bridge round trips, and both have to be answered by
 * message id: `backup:list` → `backup:list:result` and
 * `dataops:anonymization-templates` → `…:response`. `useMessageResponse`
 * drops any reply whose `correlationId` does not match the request it is
 * waiting on, so a bare broadcast leaves the tab on its skeleton forever.
 */

/** Boot the app straight into the DataOps panel, orgs already connected. */
async function openDataOps(page: Page, orgs: readonly unknown[] = MOCK_ORGS): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'dataops';
  });
  await page.goto('/');
  await bridge.seedOrgs(orgs);
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
 * React StrictMode mounts effects twice in dev, so a query can have two
 * in-flight requests with different ids; answering only the first leaves the
 * live one hanging and the tab stuck on `dataops-skeleton`.
 */
async function respondToAll(
  page: Page,
  requestType: string,
  responseType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const requests = await outgoing(page, requestType);

  for (const request of requests) {
    const correlationId = request.id as string;
    await sendExtensionMessage(page, {
      type: responseType,
      id: `resp-${correlationId}`,
      correlationId,
      payload,
    });
  }
}

/**
 * Backups as `backup:list:result` carries them.
 *
 * `BackupSummary` (dataops.messages.ts:28) keys on `operationId` and
 * `timestamp`, and its status is a `BackupStatus` — the old fixture's `id` /
 * `createdAt` / `'success'` / `'partial'` matched no field and no member of
 * that union, so the panels rendered `backup-undefined` rows with an
 * `Invalid Date` heading.
 */
const MOCK_BACKUPS = [
  {
    operationId: 'op-backup-1',
    orgId: 'org-src-1',
    timestamp: '2026-03-12T14:00:00Z',
    totalRecords: 1500,
    totalSize: 2_100_000,
    status: 'completed',
    objectResults: [
      { objectApiName: 'Account', recordCount: 500 },
      { objectApiName: 'Contact', recordCount: 1000 },
    ],
  },
  {
    operationId: 'op-backup-2',
    orgId: 'org-src-1',
    timestamp: '2026-03-10T10:00:00Z',
    totalRecords: 800,
    totalSize: 1_050_000,
    status: 'failed',
    objectResults: [
      { objectApiName: 'Lead', recordCount: 750 },
      { objectApiName: 'Opportunity', recordCount: 50 },
    ],
  },
];

/**
 * Templates as `dataops:anonymization-templates:response` carries them.
 *
 * `AnonymizationTemplate` rules carry `method` (an `AnonymizationMethod`) and
 * a `config` object; `strategy` / `fakerType` / `maskPattern` are fields of no
 * type in the codebase and would render blank badges.
 */
const MOCK_TEMPLATES = [
  {
    id: 'tpl-gdpr',
    name: 'GDPR Compliance',
    description: 'Anonymize all PII fields for GDPR compliance',
    complianceFramework: 'gdpr',
    tags: ['gdpr'],
    createdAt: '2026-03-01T09:00:00Z',
    rules: [
      {
        objectApiName: 'Contact',
        fieldApiName: 'Email',
        method: 'hash',
        config: { hashAlgorithm: 'sha256' },
      },
      {
        objectApiName: 'Contact',
        fieldApiName: 'Phone',
        method: 'mask',
        config: { maskChar: '*', maskStart: 0, maskEnd: 6 },
      },
    ],
  },
  {
    id: 'tpl-dev',
    name: 'Dev Sandbox Mask',
    description: 'Light masking for development sandboxes',
    complianceFramework: 'custom',
    tags: ['dev'],
    createdAt: '2026-03-02T09:00:00Z',
    rules: [
      {
        objectApiName: 'Account',
        fieldApiName: 'Name',
        method: 'fake',
        config: { fakerMethod: 'company.name' },
      },
    ],
  },
];

/**
 * Answer both mount queries.
 *
 * The templates query is not gated on an org and fires at mount; the backup
 * list is `skip`ped until `selectSelectedOrg` returns one, so it only goes out
 * once `seedOrgs` has landed.
 */
async function answerMountQueries(page: Page, bridge: MockBridge): Promise<void> {
  await bridge.waitForMessage('backup:list', { timeout: 10_000 });
  await respondToAll(page, 'backup:list', 'backup:list:result', { backups: MOCK_BACKUPS });
  await bridge.waitForMessage('dataops:anonymization-templates', { timeout: 10_000 });
  await respondToAll(
    page,
    'dataops:anonymization-templates',
    'dataops:anonymization-templates:response',
    { templates: MOCK_TEMPLATES },
  );
}

test.describe('DataOps — empty state', () => {
  test('shows the empty state when no orgs are connected', async ({ page }) => {
    await openDataOps(page, []);

    // With nothing connected DataOps short-circuits before the page: no
    // `dataops-page`, no KPI row, just the connect-an-org screen.
    await expect(page.getByTestId('empty-state')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('empty-illustration-dataops')).toBeVisible();
    await expect(page.getByTestId('empty-action-button')).toBeVisible();
    await expect(page.getByTestId('dataops-page')).toHaveCount(0);

    // Nothing is asked of the extension either — the backup query is gated on
    // a selected org, so an org-less panel must not fire it.
    expect(await outgoing(page, 'backup:list')).toHaveLength(0);
  });
});

test.describe('DataOps — with a connected org', () => {
  let bridge: MockBridge;

  test.beforeEach(async ({ page }) => {
    bridge = await openDataOps(page);
    await page.waitForSelector('[data-testid="dataops-page"]', { timeout: 10_000 });
  });

  test('opens the DataOps panel on the selected org', async ({ page }) => {
    await expect(page.getByTestId('dataops-page')).toBeVisible();

    // BridgeProvider auto-selects the first connected org, so the page names
    // the org it is about to write to and the "no org selected" banner stays
    // off screen.
    await expect(page.getByTestId('dataops-no-org')).toHaveCount(0);
    await expect(page.getByTestId('org-badge')).toContainText('DevSandbox');

    // The backup list is scoped to that org, not to `orgs[0]` by accident.
    const [request] = await outgoing(page, 'backup:list');
    expect((request.payload as Record<string, unknown>).orgId).toBe('org-src-1');
  });

  test('displays KPI summary row', async ({ page }) => {
    await answerMountQueries(page, bridge);

    const kpis = page.getByTestId('dataops-kpi-row');
    await expect(kpis).toBeVisible();

    // The three cards are derived from the answered data: 1500 + 800 records
    // backed up, one failed backup out of four backed-up objects, two
    // anonymization templates.
    const values = kpis.getByTestId('kpi-value');
    await expect(values).toHaveCount(3);
    await expect(values.nth(0)).toHaveText('2,300');
    await expect(values.nth(1)).toHaveText('25.0%');
    await expect(values.nth(2)).toHaveText('2');
  });

  test('shows the loading skeleton until the backup list answers', async ({ page }) => {
    // The backup tab waits on `backup:list` and nothing else, so the skeleton
    // is on screen for as long as the request is unanswered.
    await expect(page.getByTestId('dataops-skeleton')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('backup-panel')).toHaveCount(0);

    await respondToAll(page, 'backup:list', 'backup:list:result', { backups: MOCK_BACKUPS });

    await expect(page.getByTestId('dataops-skeleton')).toHaveCount(0);
    await expect(page.getByTestId('backup-panel')).toBeVisible({ timeout: 10_000 });
  });

  test('displays content area after data loads', async ({ page }) => {
    await answerMountQueries(page, bridge);

    await expect(page.getByTestId('dataops-content')).toBeVisible({ timeout: 10_000 });

    // "Loaded" means the backups reached the panel, not merely that the
    // container exists.
    for (const backup of MOCK_BACKUPS) {
      await expect(page.getByTestId(`backup-${backup.operationId}`)).toBeVisible();
    }
  });

  test('displays tab navigation with all tabs', async ({ page }) => {
    await answerMountQueries(page, bridge);

    const tabs = page.getByTestId('page-tabs').getByRole('tab');
    await expect(tabs).toHaveCount(6);
    await expect(tabs).toHaveText([
      'Backup',
      'Restore',
      'Anonymize',
      'Compliance Framework',
      'Cleanup',
      'Quality',
    ]);
  });

  test('backup tab is active by default', async ({ page }) => {
    await answerMountQueries(page, bridge);

    await expect(page.getByTestId('page-tab-backup')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('backup-panel')).toBeVisible();
    await expect(page.getByTestId('create-backup-btn')).toBeVisible();
    await expect(page.getByTestId('restore-panel')).toHaveCount(0);
    await expect(page.getByTestId('anonymize-panel')).toHaveCount(0);
  });

  test('can switch tabs', async ({ page }) => {
    await answerMountQueries(page, bridge);

    await page.getByTestId('page-tab-restore').click();
    await expect(page.getByTestId('page-tab-restore')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('restore-panel')).toBeVisible();
    await expect(page.getByTestId('backup-panel')).toHaveCount(0);
    // Restore only offers the backups that completed; the failed one is not a
    // restore candidate.
    await expect(page.getByTestId('restore-backup-op-backup-1')).toBeVisible();
    await expect(page.getByTestId('restore-backup-op-backup-2')).toHaveCount(0);

    await page.getByTestId('page-tab-anonymize').click();
    await expect(page.getByTestId('page-tab-anonymize')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('anonymize-panel')).toBeVisible();
    await expect(page.getByTestId('template-select')).toBeVisible();
    await expect(page.getByTestId('restore-panel')).toHaveCount(0);

    await page.getByTestId('page-tab-backup').click();
    await expect(page.getByTestId('page-tab-backup')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('backup-panel')).toBeVisible();
  });

  test('the three tabs with no producer say so instead of showing empty results', async ({
    page,
  }) => {
    await answerMountQueries(page, bridge);

    // Nothing in the codebase produces a DSR list, a StorageRecommendation or
    // a DataQualityScanResult. These tabs used to mount their panels against
    // hardcoded empty arrays, which reads as "the scan ran and found nothing".
    // They now name the gap, and must keep doing so — and must never spin on a
    // query they do not read.
    for (const [tab, testid] of [
      ['gdpr', 'dataops-gdpr-soon'],
      ['cleanup', 'dataops-cleanup-soon'],
      ['quality', 'dataops-quality-soon'],
    ] as const) {
      await page.getByTestId(`page-tab-${tab}`).click();
      await expect(page.getByTestId(testid)).toBeVisible();
      await expect(page.getByTestId(testid)).toContainText('Coming soon');
      await expect(page.getByTestId('dataops-skeleton')).toHaveCount(0);
    }
  });

  test('error banner appears on error and can be dismissed', async ({ page }) => {
    // DataOpsHandler reports failures on the dataops domain channel, correlated
    // to the request that failed — not as a `backup:list:result` carrying an
    // `error` field, which is what this test used to send and why it never
    // saw a banner.
    await respondToAll(page, 'backup:list', 'dataops:error', {
      message: 'INVALID_SESSION_ID: unable to fetch backups',
    });

    const banner = page.getByTestId('dataops-error');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText('INVALID_SESSION_ID: unable to fetch backups');

    await banner.getByRole('button', { name: 'Dismiss' }).click();
    await expect(banner).toHaveCount(0);
  });
});
