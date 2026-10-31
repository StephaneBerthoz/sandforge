import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MockBridge } from './helpers';
import { QA_SANDBOX } from './fixtures';
import { sendExtensionMessage } from './mocks/vscode-api';

/**
 * The Frozen page's Reload, which replaces the loads before it. It reads the
 * plan of its purge first: refused by the extension before anything is
 * written while a removal of those loads would leave records in the org, it
 * says on the last load's card what and why, in the extension's words, and
 * offers to take the load back first -- the records changed since included,
 * typed as every removal of the panel is -- or to cancel. Planned, it asks
 * with how many records its purge deletes before it loads. Its purge deleted
 * those records without a word.
 */

/** The last load into the QA sandbox: an account and two contacts it created. */
const LOAD_RECORDS = {
  orgId: QA_SANDBOX.id,
  loadedAt: '2026-10-24T10:05:00.000Z',
  created: [
    { objectApiName: 'Contact', count: 2 },
    { objectApiName: 'Account', count: 1 },
  ],
  linked: 1,
  recorded: true,
};

/** A frozen dataset, and that load. */
const STATUS = {
  configured: true,
  sasDir: '/home/qa/.sandforge-sas',
  datasetDir: '/home/qa/.sandforge-sas/dataset',
  salt: { present: true, fingerprint: 'abc123def456' },
  mockDetectionConfigured: true,
  selection: null,
  manifest: {
    version: '1.0.0',
    status: 'frozen',
    frozenAt: '2026-10-24T09:00:00.000Z',
    source: { orgId: 'org-src-1', decisionDate: '2026-10-24T08:00:00.000Z' },
    saltFingerprint: 'abc123def456',
    rulesVersion: '1.0.0',
    volumetry: { budgetMax: 100, measured: { Account: 1, Contact: 2 }, measuredAt: '2026-10-24' },
    controls: {
      nonReidentification: { passed: true, checks: [], author: 'qa', checkedAt: '2026-10-24' },
      dryRunLoad: null,
      author: 'qa',
      date: '2026-10-24',
    },
  },
  lastLoad: { status: 'completed', orgId: QA_SANDBOX.id, at: LOAD_RECORDS.loadedAt },
  lastLoads: [{ status: 'completed', orgId: QA_SANDBOX.id, at: LOAD_RECORDS.loadedAt }],
  lastVerifies: [],
  loadRecords: [LOAD_RECORDS],
};

/** What the extension refuses the reload with, as its handler words it. */
const REFUSAL =
  'A removal of the loads this reload replaces would leave 1 of their records in the org — ' +
  'Contact (1: 1 changed since the load): loaded again, the dataset would stand beside them, ' +
  'and the reload would delete what was changed since. Nothing was written. Take the load ' +
  'back first with a removal — records changed since go too when it is told to include them ' +
  '— then load the dataset again.';

/** Answer every pending request of a type: StrictMode can send one twice. */
async function answerAll(
  page: Page,
  requestType: string,
  responseType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const requests = await page.evaluate((type) => {
    const posted = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
    return posted
      .map((m) => ((m as Record<string, unknown>).payload ?? m) as Record<string, unknown>)
      .filter((m) => m.type === type)
      .map((m) => String(m.id));
  }, requestType);
  for (const correlationId of requests) {
    await sendExtensionMessage(page, {
      type: responseType,
      id: `resp-${correlationId}`,
      correlationId,
      payload,
    });
  }
}

/** What a reload into the QA sandbox would do: two contacts the last load created purged. */
const RELOAD_PLAN = {
  orgId: QA_SANDBOX.id,
  mode: { pilot: false, reload: true },
  plannedAt: '2026-10-24T11:00:00.000Z',
  perObject: [
    {
      objectApiName: 'Contact',
      fromFiles: 2,
      toInsert: 2,
      reusedByKeys: 0,
      reusedFromCatalog: 0,
      fieldsDropped: 0,
      picklistsRewritten: 0,
      notSent: 0,
      toPurge: 2,
      toDeactivate: 0,
    },
  ],
  excludedObjects: [],
  removals: [],
  placeholders: [],
  requiredDefaults: [],
  recordTypeIssues: 0,
  personContacts: 0,
  earlierLoads: 1,
};

/** The Load tab, the QA sandbox picked, Reload ticked and clicked: the plan of its purge asked. */
async function reloadAsked(
  page: Page,
): Promise<{ bridge: MockBridge; preview: Record<string, unknown> }> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'frozen';
  });
  await page.goto('/');
  await bridge.seedOrgs();
  await page.waitForSelector('[data-testid="frozen-page"]', { timeout: 10_000 });
  await bridge.waitForMessage('frozen:status', { timeout: 10_000 });
  await answerAll(page, 'frozen:status', 'frozen:status:response', { status: STATUS });
  await page.getByTestId('page-tab-load').click();
  await page.getByTestId('frozen-load-target').click();
  await page.getByTestId(`frozen-load-target-option-${QA_SANDBOX.id}`).click();
  await page.getByTestId('frozen-removal').waitFor({ timeout: 10_000 });

  await page.getByTestId('frozen-load-reload').check();
  await expect(page.getByTestId('frozen-load-run')).toHaveText('Reload');
  await page.getByTestId('frozen-load-run').click();
  const preview = await bridge.waitForMessage('frozen:load:preview', { timeout: 10_000 });
  expect(preview.payload).toEqual({ targetOrgId: QA_SANDBOX.id, reload: true });
  return { bridge, preview };
}

/** The reload asked, and refused at its plan, before anything is written. */
async function refusedReload(page: Page): Promise<MockBridge> {
  const { bridge, preview } = await reloadAsked(page);
  await sendExtensionMessage(page, {
    type: 'frozen:load:preview:error',
    id: 'err-preview-1',
    correlationId: preview.id,
    payload: { message: REFUSAL, code: 'REPLACE_LEAVES_RECORDS', retryable: false },
  });
  return bridge;
}

test.describe('the Frozen page’s Reload, refused while records would be left', () => {
  test('says what would be left and why, then takes the load back first, the records changed since included, once the org is typed', async ({
    page,
  }) => {
    const bridge = await refusedReload(page);

    const refused = page.getByTestId('frozen-removal').getByTestId('frozen-reload-refused');
    await expect(refused.getByRole('heading')).toHaveText(
      `Reload refused: nothing was written to ${QA_SANDBOX.alias}`,
    );
    await expect(refused.getByTestId('frozen-reload-refused-why')).toHaveText(REFUSAL);
    await expect(refused.getByTestId('frozen-reload-refused-way-out')).toContainText(
      'the ones changed since included',
    );
    await expect(page.getByTestId('frozen-error')).toHaveCount(0);

    await refused.getByTestId('frozen-reload-take-back').click();
    const dialog = page.getByRole('dialog', {
      name: `Remove this load's records from ${QA_SANDBOX.alias}`,
    });
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await expect(dialog.getByTestId('frozen-removal-include-changed')).toBeChecked();
    await expect(dialog.getByTestId('forge-removal-plan')).toContainText('Contact');
    // Armed by the org's name alone.
    await expect(dialog.getByTestId('danger-confirm-btn')).toBeDisabled();
    await dialog.getByTestId('danger-input').fill(QA_SANDBOX.alias);
    await dialog.getByTestId('danger-confirm-btn').click();

    const removal = await bridge.waitForMessage('frozen:remove', { timeout: 10_000 });
    expect(removal.payload).toEqual({
      targetOrgId: QA_SANDBOX.id,
      loadedAt: LOAD_RECORDS.loadedAt,
      includeChanged: true,
    });
    await expect(page.getByTestId('frozen-reload-refused')).toHaveCount(0);
    await expect(page.getByTestId('frozen-removal-removing')).toBeVisible();
    // Nothing is loaded until the user asks.
    expect(await bridge.getMessages('frozen:load')).toEqual([]);
  });

  test('cancelled, leaves the org as it is: no removal, no load', async ({ page }) => {
    const bridge = await refusedReload(page);

    await page.getByTestId('frozen-reload-cancel').click();

    await expect(page.getByTestId('frozen-reload-refused')).toHaveCount(0);
    await expect(page.getByTestId('frozen-error')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await bridge.getMessages('frozen:remove')).toEqual([]);
    expect(await bridge.getMessages('frozen:load')).toEqual([]);
  });
});

test.describe('the Frozen page’s Reload, planned', () => {
  test('asks with how many records its purge deletes, and loads once the org is typed', async ({
    page,
  }) => {
    const { bridge } = await reloadAsked(page);
    await answerAll(page, 'frozen:load:preview', 'frozen:load:preview:response', {
      plan: RELOAD_PLAN,
    });

    const dialog = page.getByRole('dialog', { name: `Reload into ${QA_SANDBOX.alias}` });
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await expect(dialog).toContainText(
      `This reload deletes from ${QA_SANDBOX.alias} 2 records that earlier loads of this ` +
        'dataset created and this one does not find again, then loads the dataset.',
    );
    await expect(dialog.getByTestId('danger-confirm-btn')).toBeDisabled();
    expect(await bridge.getMessages('frozen:load')).toEqual([]);
    await dialog.getByTestId('danger-input').fill(QA_SANDBOX.alias);
    await dialog.getByTestId('danger-confirm-btn').click();

    const load = await bridge.waitForMessage('frozen:load', { timeout: 10_000 });
    // The panel sends the reload as it always did: the extension makes it a replace.
    expect(load.payload).toEqual({ targetOrgId: QA_SANDBOX.id, reload: true });
  });
});
