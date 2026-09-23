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
 * Templates as `dataops:anonymization-templates:response` carries them: each
 * rule an `Object.Field` in `fieldPattern` and its method in `ruleType`
 * (`ListedAnonymizationTemplate`). This fixture used the domain
 * `AnonymizationTemplate` shape, `fieldApiName` and `method`, which the host
 * never sends, so the page passed here while its rules named no field.
 */
const MOCK_TEMPLATES = [
  {
    id: 'tpl-gdpr',
    name: 'GDPR Compliance',
    description: 'Anonymize all PII fields for GDPR compliance',
    complianceFramework: 'gdpr',
    rules: [
      { fieldPattern: 'Contact.Email', ruleType: 'hash', description: 'Hash the email.' },
      { fieldPattern: 'Contact.Phone', ruleType: 'mask', description: 'Mask the phone.' },
    ],
  },
  {
    id: 'tpl-dev',
    name: 'Dev Sandbox Mask',
    description: 'Light masking for development sandboxes',
    complianceFramework: 'custom',
    rules: [{ fieldPattern: 'Account.Name', ruleType: 'fake', description: 'A fake name.' }],
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
      'Compliance',
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

  test('lists each rule of a template by the field it masks and its method', async ({ page }) => {
    await answerMountQueries(page, bridge);
    await page.getByTestId('page-tab-anonymize').click();
    await page.getByTestId('template-select').selectOption('tpl-gdpr');

    const detail = page.getByTestId('template-detail');
    await expect(detail).toContainText('Contact.Email: Hash');
    await expect(detail).toContainText('Contact.Phone: Mask');
    await expect(page.getByTestId('template-rule-count')).toHaveText('2 rules');
  });

  test('saves the rules on screen as a template of the user’s, then picks it', async ({ page }) => {
    await answerMountQueries(page, bridge);
    await page.getByTestId('page-tab-anonymize').click();
    await page.getByTestId('template-select').selectOption('tpl-gdpr');
    await page.getByTestId('create-template-btn').click();

    // The hash rule cannot run without a salt: the template waits for a change.
    await page.getByTestId('template-name-input').fill('Support desk');
    await expect(page.getByTestId('template-save')).toBeDisabled();
    await page.getByTestId('template-rule-method-0').selectOption('fake');
    await page.getByTestId('template-save').click();

    const [save] = await outgoing(page, 'dataops:anonymization-template:save');
    expect(save.payload).toEqual({
      name: 'Support desk',
      rules: [
        { fieldPattern: 'Contact.Email', ruleType: 'fake' },
        { fieldPattern: 'Contact.Phone', ruleType: 'mask' },
      ],
    });

    const saved = {
      id: 'tpl-saved-1',
      name: 'Support desk',
      description: '',
      complianceFramework: 'custom',
      rules: [
        { fieldPattern: 'Contact.Email', ruleType: 'fake', description: '' },
        { fieldPattern: 'Contact.Phone', ruleType: 'mask', description: '' },
      ],
      saved: true,
    };
    await respondToAll(
      page,
      'dataops:anonymization-template:save',
      'dataops:anonymization-template:save:response',
      { template: saved },
    );
    // The page asks the host for the list again rather than patching its own.
    await expect
      .poll(async () => (await outgoing(page, 'dataops:anonymization-templates')).length)
      .toBeGreaterThan(1);
    await respondToAll(
      page,
      'dataops:anonymization-templates',
      'dataops:anonymization-templates:response',
      { templates: [...MOCK_TEMPLATES, saved] },
    );

    await expect(page.getByTestId('template-editor')).toHaveCount(0);
    await expect(page.getByTestId('template-select')).toHaveValue('tpl-saved-1');
    await expect(page.getByTestId('template-saved-badge')).toHaveText('Saved');
    await expect(page.getByTestId('delete-template-btn')).toBeVisible();
  });

  test('the compliance and cleanup tabs open their panels, and never spin on a query they do not read', async ({
    page,
  }) => {
    await answerMountQueries(page, bridge);

    // Both were coming-soon notices while nothing produced a subject request
    // or a cleanup recommendation.
    for (const [tab, testid] of [
      ['gdpr', 'compliance-panel'],
      ['cleanup', 'cleanup-panel'],
    ] as const) {
      await page.getByTestId(`page-tab-${tab}`).click();
      await expect(page.getByTestId(testid)).toBeVisible();
      await expect(page.getByTestId('dataops-skeleton')).toHaveCount(0);
    }
    await expect(page.getByTestId('dataops-gdpr-soon')).toHaveCount(0);
    await expect(page.getByTestId('dataops-cleanup-soon')).toHaveCount(0);
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

/** A scan of Contact as `dataops:quality-scan:response` carries it: every figure a count. */
function qualityAnswer(duplicateKey: 'Email' | 'Phone'): Record<string, unknown> {
  return {
    orgId: 'org-src-1',
    staleDays: 365,
    scannedAt: '2026-09-01T10:00:00.000Z',
    bounds: { duplicateGroupLimit: 2000, duplicateSample: 20, singleFieldQueries: 20 },
    objects: [
      {
        status: 'scanned',
        objectApiName: 'Contact',
        label: 'Contact',
        totalRecords: 18,
        fields: [
          { fieldApiName: 'Fax', label: 'Fax', filled: 0, required: false },
          { fieldApiName: 'Salutation', label: 'Salutation', filled: 7, required: false },
          { fieldApiName: 'Phone', label: 'Business Phone', filled: 13, required: false },
          { fieldApiName: 'Email', label: 'Email', filled: 17, required: false },
          { fieldApiName: 'LastName', label: 'Last Name', filled: 18, required: true },
        ],
        unmeasured: [
          { fieldApiName: 'Description', label: 'Description', reason: 'not-countable' },
        ],
        duplicates:
          duplicateKey === 'Email'
            ? {
                keyField: 'Email',
                keyLabel: 'Email',
                groups: [{ value: 'shared@example.com', count: 2 }],
                groupCount: 1,
                recordCount: 2,
                truncated: false,
              }
            : {
                keyField: 'Phone',
                keyLabel: 'Business Phone',
                groups: [
                  { value: '+33 1 00 00 00 01', count: 3 },
                  { value: '+33 1 00 00 00 02', count: 2 },
                ],
                groupCount: 2,
                recordCount: 5,
                truncated: false,
              },
        stale: { days: 365, records: 3 },
        keyFields: [
          { fieldApiName: 'Phone', label: 'Business Phone' },
          { fieldApiName: 'Email', label: 'Email' },
        ],
        errors: [],
      },
    ],
  };
}

test.describe('DataOps — Quality', () => {
  let bridge: MockBridge;

  test.beforeEach(async ({ page }) => {
    bridge = await openDataOps(page);
    await answerMountQueries(page, bridge);
    await page.getByTestId('page-tab-quality').click();
    await bridge.waitForMessage('seed:describe-global', { timeout: 10_000 });
    await respondToAll(page, 'seed:describe-global', 'seed:describe-global:response', {
      objects: [
        { apiName: 'Account', label: 'Account' },
        { apiName: 'Contact', label: 'Contact' },
        { apiName: 'Opportunity', label: 'Opportunity' },
      ],
    });
  });

  test('scans the objects picked and shows what the org counted', async ({ page }) => {
    // It was a coming-soon notice while nothing produced a quality result.
    await expect(page.getByTestId('dataops-quality-soon')).toHaveCount(0);

    await page.getByTestId('quality-object-option-Contact').check();
    await page.getByTestId('quality-scan-btn').click();
    await bridge.waitForMessage('dataops:quality-scan', { timeout: 10_000 });
    const [request] = await outgoing(page, 'dataops:quality-scan');
    expect(request.payload).toEqual({
      orgId: 'org-src-1',
      objects: [{ objectApiName: 'Contact' }],
      staleDays: 365,
    });

    await respondToAll(
      page,
      'dataops:quality-scan',
      'dataops:quality-scan:response',
      qualityAnswer('Email'),
    );

    const contact = page.getByTestId('quality-object-Contact');
    await expect(contact).toBeVisible({ timeout: 10_000 });
    await expect(contact.getByTestId('quality-total')).toHaveText('18 records');
    await expect(contact.getByTestId('quality-summary-empty')).toHaveText('2 of 5 counted');
    await expect(contact.getByTestId('quality-summary-stale')).toHaveText('3 (16.7%)');
    await expect(contact.getByTestId('quality-duplicate-summary')).toHaveText(
      '1 value of Email is carried by 2 records.',
    );
    await expect(contact.getByTestId('quality-field-Fax').first()).toContainText('Always empty');
    await expect(contact.getByTestId('quality-unmeasured-not-countable')).toContainText(
      'Description',
    );
  });

  test('looks for duplicates by another field when one is picked, for that object alone', async ({
    page,
  }) => {
    await page.getByTestId('quality-object-option-Contact').check();
    await page.getByTestId('quality-scan-btn').click();
    await bridge.waitForMessage('dataops:quality-scan', { timeout: 10_000 });
    await respondToAll(
      page,
      'dataops:quality-scan',
      'dataops:quality-scan:response',
      qualityAnswer('Email'),
    );

    const contact = page.getByTestId('quality-object-Contact');
    await contact.getByLabel('Find duplicates by').selectOption('Phone');

    await expect.poll(async () => (await outgoing(page, 'dataops:quality-scan')).length).toBe(2);
    const [, rescan] = await outgoing(page, 'dataops:quality-scan');
    expect(rescan.payload).toEqual({
      orgId: 'org-src-1',
      objects: [{ objectApiName: 'Contact', duplicateKey: 'Phone' }],
      staleDays: 365,
    });
    await respondToAll(
      page,
      'dataops:quality-scan',
      'dataops:quality-scan:response',
      qualityAnswer('Phone'),
    );

    await expect(contact.getByTestId('quality-duplicate-summary')).toHaveText(
      '2 values of Business Phone are each carried by more than one record: 5 records in all.',
      { timeout: 10_000 },
    );
  });

  test('shows the extension refusing a scan', async ({ page }) => {
    await page.getByTestId('quality-object-option-Account').check();
    await page.getByTestId('quality-scan-btn').click();
    await bridge.waitForMessage('dataops:quality-scan', { timeout: 10_000 });
    await respondToAll(page, 'dataops:quality-scan', 'dataops:error', {
      message: 'INVALID_SESSION_ID: Session expired or invalid',
      code: 'UNKNOWN',
      retryable: false,
    });

    await expect(page.getByTestId('quality-scan-error')).toContainText('INVALID_SESSION_ID', {
      timeout: 10_000,
    });
  });
});

/**
 * Answer only the newest request of a type. The review of an erasure and the
 * erasure itself go out on one channel, each answered by its own reply.
 */
async function respondToLast(
  page: Page,
  requestType: string,
  responseType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const requests = await outgoing(page, requestType);
  const last = requests.at(-1);
  if (!last) throw new Error(`no ${requestType} was sent`);
  const correlationId = last.id as string;
  await sendExtensionMessage(page, {
    type: responseType,
    id: `resp-${correlationId}`,
    correlationId,
    payload,
  });
}

/** Open a tab whose panel asks for the org's objects, and answer with a few. */
async function openObjectTab(
  page: Page,
  bridge: MockBridge,
  tab: 'gdpr' | 'cleanup',
): Promise<void> {
  await answerMountQueries(page, bridge);
  await page.getByTestId(`page-tab-${tab}`).click();
  await bridge.waitForMessage('seed:describe-global', { timeout: 10_000 });
  await respondToAll(page, 'seed:describe-global', 'seed:describe-global:response', {
    objects: [
      { apiName: 'Account', label: 'Account' },
      { apiName: 'Contact', label: 'Contact' },
    ],
  });
}

const REQUEST_ID = '5b0a9b8c-2222-4000-8000-000000000000';

test.describe('DataOps — Compliance', () => {
  let bridge: MockBridge;

  test.beforeEach(async ({ page }) => {
    bridge = await openDataOps(page);
    await openObjectTab(page, bridge, 'gdpr');
  });

  test('finds personal data, then one person’s records, and erases them after a review', async ({
    page,
  }) => {
    await page.getByTestId('compliance-object-option-Contact').check();
    await page.getByTestId('inventory-run-btn').click();
    await bridge.waitForMessage('dataops:pii-inventory', { timeout: 10_000 });
    const [inventory] = await outgoing(page, 'dataops:pii-inventory');
    expect(inventory.payload).toEqual({ orgId: 'org-src-1', objects: ['Contact'] });
    await respondToAll(page, 'dataops:pii-inventory', 'dataops:pii-inventory:response', {
      orgId: 'org-src-1',
      scannedAt: '2026-09-23T10:00:00.000Z',
      sampleSize: 200,
      objects: [
        {
          status: 'scanned',
          objectApiName: 'Contact',
          label: 'Contact',
          sampled: 18,
          fields: [
            {
              fieldApiName: 'Email',
              label: 'Email',
              classification: 'PII',
              detectedBy: 'name',
              pattern: 'email',
              filled: 17,
              searchedFor: 'email',
            },
          ],
          nameField: { fieldApiName: 'Name', label: 'Full Name' },
        },
      ],
    });
    await expect(page.getByTestId('inventory-field-Email')).toContainText('17 of 18 filled', {
      timeout: 10_000,
    });

    await page.getByLabel('Email address').fill('jane.doe@example.com');
    await page.getByTestId('dsr-search-btn').click();
    await bridge.waitForMessage('dataops:dsr:search', { timeout: 10_000 });
    const [search] = await outgoing(page, 'dataops:dsr:search');
    expect(search.payload).toEqual({
      orgId: 'org-src-1',
      objects: ['Contact'],
      email: 'jane.doe@example.com',
    });
    await respondToAll(page, 'dataops:dsr:search', 'dataops:dsr:search:response', {
      requestId: REQUEST_ID,
      orgId: 'org-src-1',
      searchedAt: '2026-09-23T10:01:00.000Z',
      limit: 200,
      objects: [
        {
          status: 'searched',
          objectApiName: 'Contact',
          label: 'Contact',
          counted: 1,
          records: [{ id: '003000000000001AAA', name: 'Jane Doe', matchedBy: ['Email'] }],
          truncated: false,
          searched: [{ fieldApiName: 'Email', label: 'Email', kind: 'email' }],
        },
      ],
    });
    await expect(page.getByTestId('dsr-request')).toHaveText('Request 5b0a9b8c: 1 record found.', {
      timeout: 10_000,
    });

    await page.getByTestId('dsr-review-btn').click();
    await expect.poll(async () => (await outgoing(page, 'dataops:dsr:erase')).length).toBe(1);
    const [review] = await outgoing(page, 'dataops:dsr:erase');
    expect(review.payload).toMatchObject({
      mode: 'anonymize',
      dryRun: true,
      requestId: REQUEST_ID,
    });
    await respondToLast(page, 'dataops:dsr:erase', 'dataops:dsr:erase:response', {
      requestId: REQUEST_ID,
      mode: 'anonymize',
      dryRun: true,
      plan: [
        {
          objectApiName: 'Contact',
          label: 'Contact',
          records: 1,
          fields: [{ fieldApiName: 'Email', label: 'Email', method: 'fake' }],
          kept: [],
        },
      ],
    });
    await expect(page.getByTestId('removal-plan-fields')).toHaveText(
      'Overwrites: Email (made up)',
      { timeout: 10_000 },
    );

    // Nothing goes out until the confirmation is typed.
    await page.getByTestId('dsr-erase-btn').click();
    await expect(page.getByTestId('danger-confirm-btn')).toBeDisabled();
    await page.getByTestId('danger-input').fill('erase');
    await page.getByTestId('danger-confirm-btn').click();
    await expect.poll(async () => (await outgoing(page, 'dataops:dsr:erase')).length).toBe(2);
    const [, erase] = await outgoing(page, 'dataops:dsr:erase');
    expect(erase.payload).toEqual({
      orgId: 'org-src-1',
      requestId: REQUEST_ID,
      mode: 'anonymize',
      records: [{ objectApiName: 'Contact', ids: ['003000000000001AAA'] }],
      dryRun: false,
    });
    await respondToLast(page, 'dataops:dsr:erase', 'dataops:dsr:erase:response', {
      requestId: REQUEST_ID,
      mode: 'anonymize',
      dryRun: false,
      plan: [],
      outcome: {
        status: 'success',
        done: 1,
        failed: 0,
        objects: [{ objectApiName: 'Contact', done: 1, failed: 0 }],
        errors: [],
      },
    });
    await expect(page.getByTestId('removal-outcome')).toHaveText('1 record overwritten.', {
      timeout: 10_000,
    });

    // The log is asked for again, and lists the request in counts.
    await expect
      .poll(async () => (await outgoing(page, 'dataops:dsr:log')).length)
      .toBeGreaterThan(1);
    await respondToAll(page, 'dataops:dsr:log', 'dataops:dsr:log:response', {
      entries: [
        {
          requestId: REQUEST_ID,
          orgId: 'org-src-1',
          openedAt: '2026-09-23T10:01:00.000Z',
          events: [
            {
              kind: 'searched',
              at: '2026-09-23T10:01:00.000Z',
              searchedBy: ['email'],
              objects: [{ objectApiName: 'Contact', found: 1, truncated: false }],
            },
          ],
        },
      ],
    });
    await expect(page.getByTestId('dsr-log-5b0a9b8c')).toContainText('1 record found', {
      timeout: 10_000,
    });
  });

  test('shows the extension refusing an inventory', async ({ page }) => {
    await page.getByTestId('compliance-object-option-Contact').check();
    await page.getByTestId('inventory-run-btn').click();
    await bridge.waitForMessage('dataops:pii-inventory', { timeout: 10_000 });
    await respondToAll(page, 'dataops:pii-inventory', 'dataops:error', {
      message: 'INVALID_SESSION_ID: Session expired or invalid',
      code: 'UNKNOWN',
      retryable: false,
    });

    await expect(page.getByTestId('inventory-error')).toContainText('INVALID_SESSION_ID', {
      timeout: 10_000,
    });
  });
});

test.describe('DataOps — Cleanup', () => {
  let bridge: MockBridge;

  test.beforeEach(async ({ page }) => {
    bridge = await openDataOps(page);
    await openObjectTab(page, bridge, 'cleanup');
  });

  test('scans, says what a delete takes, and deletes only after the confirmation', async ({
    page,
  }) => {
    await page.getByTestId('cleanup-object-option-Account').check();
    await page.getByTestId('cleanup-scan-btn').click();
    await bridge.waitForMessage('dataops:cleanup:scan', { timeout: 10_000 });
    const [scan] = await outgoing(page, 'dataops:cleanup:scan');
    expect(scan.payload).toEqual({
      orgId: 'org-src-1',
      objects: [{ objectApiName: 'Account' }],
      staleDays: 365,
    });
    await respondToAll(page, 'dataops:cleanup:scan', 'dataops:cleanup:scan:response', {
      orgId: 'org-src-1',
      staleDays: 365,
      scannedAt: '2026-09-23T10:00:00.000Z',
      orphanThreshold: 0.9,
      bounds: { duplicateGroupLimit: 2000, duplicateSample: 20, singleFieldQueries: 20 },
      objects: [
        {
          status: 'scanned',
          objectApiName: 'Account',
          label: 'Account',
          totalRecords: 40,
          stale: { days: 365, records: 3 },
          orphans: [],
          duplicates: null,
          keyFields: [],
          errors: [],
        },
      ],
    });
    await expect(page.getByTestId('cleanup-stale-count')).toHaveText(
      '3 records not modified in the last 365 days.',
      { timeout: 10_000 },
    );

    await page.getByTestId('cleanup-stale-delete').click();
    await expect.poll(async () => (await outgoing(page, 'dataops:cleanup:delete')).length).toBe(1);
    const [plan] = await outgoing(page, 'dataops:cleanup:delete');
    expect(plan.payload).toEqual({
      orgId: 'org-src-1',
      objectApiName: 'Account',
      recommendation: { kind: 'stale', days: 365 },
      dryRun: true,
    });
    await respondToLast(page, 'dataops:cleanup:delete', 'dataops:cleanup:delete:response', {
      objectApiName: 'Account',
      dryRun: true,
      plan: {
        objectApiName: 'Account',
        label: 'Account',
        records: 3,
        related: [{ objectApiName: 'Contact', label: 'Contact', records: 7 }],
        uncounted: [],
      },
      truncated: false,
    });
    await expect(page.getByTestId('removal-plan-related')).toContainText('Contact: 7 records', {
      timeout: 10_000,
    });

    await page.getByTestId('cleanup-delete-btn').click();
    await page.getByTestId('danger-input').fill('delete');
    await page.getByTestId('danger-confirm-btn').click();
    await expect.poll(async () => (await outgoing(page, 'dataops:cleanup:delete')).length).toBe(2);
    const [, remove] = await outgoing(page, 'dataops:cleanup:delete');
    expect((remove.payload as Record<string, unknown>).dryRun).toBe(false);
    await respondToLast(page, 'dataops:cleanup:delete', 'dataops:cleanup:delete:response', {
      objectApiName: 'Account',
      dryRun: false,
      plan: { objectApiName: 'Account', label: 'Account', records: 3 },
      truncated: false,
      outcome: {
        status: 'success',
        done: 3,
        failed: 0,
        objects: [{ objectApiName: 'Account', done: 3, failed: 0 }],
        errors: [],
      },
    });
    await expect(page.getByTestId('removal-outcome')).toHaveText('3 records deleted.', {
      timeout: 10_000,
    });
    // The counts on screen predate the delete: the object is scanned again.
    await expect.poll(async () => (await outgoing(page, 'dataops:cleanup:scan')).length).toBe(2);
  });
});
