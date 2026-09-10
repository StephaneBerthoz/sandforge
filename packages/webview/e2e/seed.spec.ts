import { test, expect, type Page } from '@playwright/test';
import { MockBridge } from './helpers';
import { MOCK_ORGS } from './fixtures';
import { sendExtensionMessage } from './mocks/vscode-api';

/**
 * Forge input form E2E — the record-scoped clone module.
 *
 * The file name says "seed" and its subject does not: the describe block has
 * read `Forge / Seed page` since it was written, and every assertion in it
 * targets `forge-*` testids. Seed (`src/pages/Seed`) is a different module with
 * its own page, wizard and testids, and nothing in here has ever touched it.
 * The name is left alone on purpose — renaming the file is a separate, central
 * move — but read this as the Forge spec it is.
 *
 * What changed to make it run again:
 *
 * - The panel is booted straight into the module (`__SANDFORGE_MODULE__`),
 *   because that is how the extension opens it. The old version clicked
 *   `sidebar-forge-hero`, and there has been no in-app navigation sidebar
 *   since 1.8.0 (11f12588) — that one click is why all 16 tests were red.
 * - `forge-source-org` / `forge-target-org` are `OrgDropdown` buttons, not
 *   `<select>` elements, so `selectOption` cannot drive them: open the trigger,
 *   then click `<testid>-option-<orgId>`.
 * - The source org is no longer picked by hand. `useForgeForm` adopts the
 *   globally selected org on mount, and `BridgeProvider` auto-selects the first
 *   connected org from `org:list:response`, so the form opens with DevSandbox
 *   already on the left and only the target missing.
 * - `forge:preview:response` is correlated (`useRecordPreview` keeps the id of
 *   the request in flight and drops anything answering a different one), so
 *   every response here carries the requesting message's id.
 */

/** Boot the app straight into the Forge panel, orgs already connected. */
async function openForge(page: Page, orgs: readonly unknown[] = MOCK_ORGS): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'forge';
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
 * React StrictMode mounts effects twice in dev, so a panel can carry two
 * in-flight requests of the same type under different ids. `useRecordPreview`
 * only accepts the response whose `correlationId` matches the request it is
 * still waiting on and silently drops the rest, so answering all of them is
 * both safe and the only way to be sure the live one was answered.
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

/** Open an OrgDropdown and pick one org out of it. */
async function pickOrg(page: Page, testId: string, orgId: string): Promise<void> {
  await page.getByTestId(testId).click();
  await page.getByTestId(`${testId}-option-${orgId}`).click();
}

/** A valid 18-character record id — what `extractRecordId` accepts verbatim. */
const RECORD_ID = '001000000000001AAA';

/** Account preview as `forge:preview:response` carries one. */
const ACCOUNT_PREVIEW = {
  objectApiName: 'Account',
  objectLabel: 'Account',
  recordId: RECORD_ID,
  fields: [
    { name: 'Name', value: 'Acme Corp' },
    { name: 'Industry', value: 'Technology' },
    { name: 'Type', value: 'Enterprise' },
  ],
};

/** Contact preview whose Email and Phone are what `isPiiField` flags. */
const CONTACT_PREVIEW = {
  objectApiName: 'Contact',
  objectLabel: 'Contact',
  recordId: '003000000000001AAA',
  fields: [
    { name: 'Name', value: 'John Doe' },
    { name: 'Email', value: 'john@example.com' },
    { name: 'Phone', value: '+1234567890' },
  ],
};

/**
 * Type a record id and settle the preview round trip it triggers.
 *
 * A valid id schedules a debounced `forge:preview` 400 ms later whether or not
 * the refresh button is pressed, and while that request is in flight the
 * refresh button is disabled and the preview card is cleared. Answering it is
 * what makes the form's state deterministic for anything asserted afterwards.
 */
async function enterRecordIdAndSettlePreview(
  page: Page,
  bridge: MockBridge,
  recordId: string,
  preview: Record<string, unknown>,
): Promise<void> {
  await page.getByTestId('forge-input-record').fill(recordId);
  await bridge.waitForMessage('forge:preview', { timeout: 10_000 });
  await respondToAll(page, 'forge:preview', 'forge:preview:response', preview);
}

test.describe('Forge — input form', () => {
  let bridge: MockBridge;

  test.beforeEach(async ({ page }) => {
    bridge = await openForge(page);
    await page.waitForSelector('[data-testid="forge-page"]', { timeout: 10_000 });
  });

  test('renders the forge page and its input form', async ({ page }) => {
    await expect(page.getByTestId('forge-page')).toBeVisible();
    await expect(page.getByTestId('forge-input')).toBeVisible();
  });

  test('offers the four input modes as tabs', async ({ page }) => {
    await expect(page.getByTestId('forge-tab-record')).toBeVisible();
    await expect(page.getByTestId('forge-tab-soql')).toBeVisible();
    await expect(page.getByTestId('forge-tab-template')).toBeVisible();
    await expect(page.getByTestId('forge-tab-ai')).toBeVisible();
  });

  test('opens on the record tab with the record id field', async ({ page }) => {
    await expect(page.getByTestId('forge-tab-record')).toHaveAttribute('data-state', 'active');
    await expect(page.getByTestId('forge-input-record')).toBeVisible();
    await expect(page.getByTestId('forge-input-record')).toHaveValue('');
  });

  test('switches to the SOQL tab and shows its textarea', async ({ page }) => {
    await page.getByTestId('forge-tab-soql').click();
    await expect(page.getByTestId('forge-input-soql')).toBeVisible();
    await expect(page.getByTestId('forge-input-record')).toHaveCount(0);
  });

  test('switches to the AI tab and shows its prompt textarea', async ({ page }) => {
    await page.getByTestId('forge-tab-ai').click();
    await expect(page.getByTestId('forge-input-ai')).toBeVisible();
  });

  test('displays the three depth chips, direct selected', async ({ page }) => {
    await expect(page.getByTestId('forge-depth-direct')).toBeVisible();
    await expect(page.getByTestId('forge-depth-full')).toBeVisible();
    await expect(page.getByTestId('forge-depth-custom')).toBeVisible();

    // The chips are a radiogroup, so the selection is `aria-checked`, not a class.
    await expect(page.getByTestId('forge-depth-direct')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('forge-depth-custom')).toHaveAttribute('aria-checked', 'false');
  });

  test('selecting custom depth reveals the numeric input', async ({ page }) => {
    await expect(page.getByTestId('forge-depth-custom-input')).toHaveCount(0);

    await page.getByTestId('forge-depth-custom').click();

    await expect(page.getByTestId('forge-depth-custom-input')).toBeVisible();
    await expect(page.getByTestId('forge-depth-custom-input')).toHaveValue('3');
    await expect(page.getByTestId('forge-depth-custom')).toHaveAttribute('aria-checked', 'true');
  });

  test('opens with the source org already picked and the target still empty', async ({ page }) => {
    await expect(page.getByTestId('forge-source-org')).toBeVisible();
    await expect(page.getByTestId('forge-target-org')).toBeVisible();

    // BridgeProvider auto-selects the first connected org and useForgeForm
    // adopts it as the source, so the user only has to choose a target.
    await expect(page.getByTestId('forge-source-org')).toContainText('DevSandbox');
    await expect(page.getByTestId('forge-target-org')).toContainText('Select an org');
  });

  test('carries the anonymize and skip-empty toggles, both off', async ({ page }) => {
    // Both inputs are `sr-only` — attached and operable, never "visible".
    await expect(page.getByTestId('forge-anonymize-toggle')).toBeAttached();
    await expect(page.getByTestId('forge-skip-empty-toggle')).toBeAttached();
    await expect(page.getByTestId('forge-anonymize-toggle')).not.toBeChecked();
    await expect(page.getByTestId('forge-skip-empty-toggle')).not.toBeChecked();
  });

  test('discover stays disabled without a target org, and says so', async ({ page }) => {
    await expect(page.getByTestId('forge-discover-btn')).toBeDisabled();
    await expect(page.getByTestId('forge-discover-hint')).toHaveText('Select a target org');
  });

  test('discover asks for an input once both orgs are set', async ({ page }) => {
    await pickOrg(page, 'forge-target-org', 'org-tgt-1');

    await expect(page.getByTestId('forge-discover-btn')).toBeDisabled();
    await expect(page.getByTestId('forge-discover-hint')).toHaveText(
      'Enter a record ID, query, or prompt',
    );
  });

  test('discover becomes enabled once orgs and a record id are provided', async ({ page }) => {
    await pickOrg(page, 'forge-target-org', 'org-tgt-1');
    await page.getByTestId('forge-input-record').fill(RECORD_ID);

    await expect(page.getByTestId('forge-discover-btn')).toBeEnabled();
    await expect(page.getByTestId('forge-discover-hint')).toHaveCount(0);
  });

  test('the same org on both sides warns and blocks discovery', async ({ page }) => {
    await pickOrg(page, 'forge-target-org', 'org-src-1');
    await page.getByTestId('forge-input-record').fill(RECORD_ID);

    await expect(page.getByTestId('forge-same-org-warning')).toBeVisible();
    await expect(page.getByTestId('forge-same-org-warning')).toContainText(
      'Source and target must be different orgs',
    );
    await expect(page.getByTestId('forge-discover-btn')).toBeDisabled();
    await expect(page.getByTestId('forge-discover-hint')).toHaveText(
      'Source and target must be different',
    );
  });

  test('an unreadable record id is refused before any round trip', async ({ page }) => {
    await pickOrg(page, 'forge-target-org', 'org-tgt-1');
    await page.getByTestId('forge-input-record').fill('not-an-id');

    await expect(page.getByTestId('forge-record-id-error')).toBeVisible();
    await expect(page.getByTestId('forge-record-id-error')).toHaveText(
      'Not a valid Salesforce record ID or URL',
    );
    await expect(page.getByTestId('forge-input-record')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByTestId('forge-discover-btn')).toBeDisabled();

    // Nothing is asked of the extension: the id never resolves to a root object,
    // so the trip would come back with "Cannot resolve root object" regardless.
    expect(await outgoing(page, 'forge:preview')).toHaveLength(0);
    expect(await outgoing(page, 'forge:discover')).toHaveLength(0);
  });

  test('preview is disabled while the record field is empty', async ({ page }) => {
    await expect(page.getByTestId('forge-preview-btn')).toBeDisabled();
  });

  test('preview is live once a valid record id is in the field', async ({ page }) => {
    await expect(page.getByTestId('forge-preview-btn')).toBeDisabled();

    // The id alone re-enables it — the source org is already selected. The
    // debounced request it schedules is answered first, because the button is
    // deliberately dead while a preview is in flight.
    await enterRecordIdAndSettlePreview(page, bridge, RECORD_ID, ACCOUNT_PREVIEW);

    await expect(page.getByTestId('forge-preview-btn')).toBeEnabled();
  });

  test('typing a record id asks the extension for that record', async ({ page }) => {
    await page.getByTestId('forge-input-record').fill(RECORD_ID);

    const request = await bridge.waitForMessage('forge:preview', { timeout: 10_000 });
    expect(request.payload).toMatchObject({ recordId: RECORD_ID, orgId: 'org-src-1' });
  });

  test('the refresh button asks again for the same record', async ({ page }) => {
    await enterRecordIdAndSettlePreview(page, bridge, RECORD_ID, ACCOUNT_PREVIEW);
    const before = (await outgoing(page, 'forge:preview')).length;

    await page.getByTestId('forge-preview-btn').click();

    await expect
      .poll(async () => (await outgoing(page, 'forge:preview')).length, { timeout: 10_000 })
      .toBeGreaterThan(before);
    const latest = (await outgoing(page, 'forge:preview')).at(-1);
    expect(latest?.payload).toMatchObject({ recordId: RECORD_ID, orgId: 'org-src-1' });
  });

  test('renders the record preview the extension answers with', async ({ page }) => {
    await enterRecordIdAndSettlePreview(page, bridge, RECORD_ID, ACCOUNT_PREVIEW);

    const preview = page.getByTestId('forge-record-preview');
    await expect(preview).toBeVisible({ timeout: 10_000 });
    await expect(preview).toContainText('Account');
    await expect(preview).toContainText('Acme Corp');
    await expect(preview).toContainText('Technology');

    // The estimate card reads the same payload: three fields, no counts sent.
    await expect(page.getByTestId('est-objects')).toHaveText('1');
    await expect(page.getByTestId('est-fields')).toHaveText('3');
  });

  test('warns about PII fields while anonymize is off', async ({ page }) => {
    await enterRecordIdAndSettlePreview(page, bridge, '003000000000001AAA', CONTACT_PREVIEW);

    await expect(page.getByTestId('forge-record-preview')).toBeVisible({ timeout: 10_000 });
    const warning = page.getByTestId('forge-pii-warning');
    await expect(warning).toBeVisible();
    // Email and Phone — the two fields `isPiiField` matches in this record.
    await expect(warning).toContainText('2 PII field');

    // Turning anonymization on answers the warning, so it goes away.
    await page.getByTestId('forge-anonymize-toggle').check({ force: true });
    await expect(page.getByTestId('forge-anonymize-toggle')).toBeChecked();
    await expect(warning).toHaveCount(0);
  });

  test('discover posts the assembled config and leaves the input form', async ({ page }) => {
    await pickOrg(page, 'forge-target-org', 'org-tgt-1');
    await enterRecordIdAndSettlePreview(page, bridge, RECORD_ID, ACCOUNT_PREVIEW);
    await page.getByTestId('forge-depth-custom').click();

    await page.getByTestId('forge-discover-btn').click();

    const request = await bridge.waitForMessage('forge:discover', { timeout: 10_000 });
    expect(request.payload).toMatchObject({
      config: {
        inputMode: 'record',
        recordId: RECORD_ID,
        depth: 'custom',
        customDepth: 3,
        sourceOrgId: 'org-src-1',
        targetOrgId: 'org-tgt-1',
        anonymizePII: false,
        skipEmpty: false,
      },
    });

    // The phase moves on: the form is gone and discovery waits on the graph.
    await expect(page.getByTestId('forge-discovery-loading')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('forge-input')).toHaveCount(0);
  });
});

test.describe('Forge — no org connected', () => {
  test('shows the forge empty state instead of the input form', async ({ page }) => {
    await openForge(page, []);

    // With nothing connected there is no form to render: ForgePage short-circuits
    // to its empty state and points the user at org setup.
    await expect(page.getByTestId('empty-state')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('empty-illustration-forge')).toBeVisible();
    await expect(page.getByTestId('empty-action-button')).toBeVisible();
    await expect(page.getByTestId('forge-input')).toHaveCount(0);
  });
});
