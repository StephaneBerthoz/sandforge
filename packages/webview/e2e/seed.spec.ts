import { test, expect, type Page } from '@playwright/test';
import { MockBridge } from './helpers';
import { MOCK_ORGS } from './fixtures';
import { sendExtensionMessage } from './mocks/vscode-api';

/**
 * Forge input form E2E — the record-scoped clone module — and, further down,
 * one run of the Seed wizard and the Seed Clone wizard with no org selected.
 *
 * The file name says "seed" and most of its subject does not: the first
 * describe block has read `Forge / Seed page` since it was written, and every
 * assertion in it targets `forge-*` testids. Seed (`src/pages/Seed`) is a
 * different module with its own page, wizard and testids; only the two `Seed`
 * blocks drive it. The name is left alone on purpose — renaming the file is a
 * separate, central move — but read the Forge blocks as the Forge spec they are.
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

/** The query the AI tab's draft answers with. */
const AI_DRAFT = "SELECT Id, Name, Industry FROM Account WHERE Industry = 'Energy'";

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

  test('opens the AI tab, and says how to set up a provider when none is', async ({ page }) => {
    const aiTab = page.getByTestId('forge-tab-ai');
    await expect(aiTab).toBeEnabled();

    await aiTab.click();

    await expect(aiTab).toHaveAttribute('data-state', 'active');
    await expect(page.getByTestId('forge-ai-not-configured')).toBeVisible();
    await expect(page.getByTestId('forge-ai-open-settings')).toBeVisible();
    await expect(page.getByTestId('forge-input-ai')).toHaveCount(0);
  });

  test('drafts a query from a prompt, and discovers from it only on the click', async ({
    page,
  }) => {
    // AI on and a key stored: the extension pushes its status to every panel.
    await sendExtensionMessage(page, {
      type: 'ai:status:response',
      id: 'ai-status-push',
      payload: { enabled: true, provider: 'anthropic', model: 'model' },
    });
    await pickOrg(page, 'forge-target-org', 'org-tgt-1');
    await page.getByTestId('forge-tab-ai').click();

    await page.getByTestId('forge-input-ai').fill('Accounts in the energy industry');
    await page.getByTestId('forge-ai-draft-btn').click();
    const request = await bridge.waitForMessage('ai:forge-plan', { timeout: 10_000 });
    expect(request.payload).toEqual({
      orgId: 'org-src-1',
      prompt: 'Accounts in the energy industry',
    });
    await respondToAll(page, 'ai:forge-plan', 'ai:forge-plan:response', {
      success: true,
      soql: AI_DRAFT,
      explanation: 'Accounts whose industry is Energy',
      rootObject: 'Account',
      rootLabel: 'Account',
      fieldsChecked: 3,
      problems: [],
    });

    await expect(page.getByTestId('forge-ai-query')).toHaveValue(AI_DRAFT);
    await expect(page.getByTestId('forge-ai-checked')).toBeVisible();
    // The WHERE clause narrows the root only, as on the SOQL tab.
    await expect(page.getByTestId('forge-soql-where-warning')).toBeVisible();
    expect(await outgoing(page, 'forge:discover')).toHaveLength(0);

    await page.getByTestId('forge-discover-btn').click();

    const discover = await bridge.waitForMessage('forge:discover', { timeout: 10_000 });
    expect(discover.payload).toMatchObject({
      config: {
        inputMode: 'soql',
        soqlQuery: AI_DRAFT,
        objectSoqlFilters: { Account: "Industry = 'Energy'" },
        sourceOrgId: 'org-src-1',
        targetOrgId: 'org-tgt-1',
      },
    });
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
      'Enter a record ID or a query, or pick a template',
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

/** A createable field as `seed:describe-object` reports it. */
function seedField(
  fieldApiName: string,
  type: string,
  extra: {
    required?: boolean;
    length?: number;
    referenceTo?: string[];
    picklistValues?: string[];
  } = {},
): Record<string, unknown> {
  return {
    fieldApiName,
    label: fieldApiName,
    type,
    required: false,
    picklistValues: [],
    referenceTo: [],
    length: 0,
    ...extra,
  };
}

/** The three objects of the wizard run, as a sandbox describes their required fields. */
const SEED_DESCRIBES: Record<string, Record<string, unknown>[]> = {
  Account: [seedField('Name', 'string', { required: true, length: 255 })],
  Contact: [
    seedField('LastName', 'string', { required: true, length: 80 }),
    seedField('AccountId', 'reference', { referenceTo: ['Account'], length: 18 }),
  ],
  Opportunity: [
    seedField('Name', 'string', { required: true, length: 120 }),
    seedField('CloseDate', 'date', { required: true }),
    seedField('StageName', 'picklist', { required: true, picklistValues: ['Prospecting'] }),
  ],
};

/**
 * Answer each `seed:describe-object` not answered yet with the describe of the
 * object it names. The wizard describes one object per request and asks again
 * for an object whose answer it dropped, so this is polled until it is done.
 */
async function answerSeedDescribes(page: Page, answered: Set<string>): Promise<void> {
  for (const request of await outgoing(page, 'seed:describe-object')) {
    const id = String(request.id);
    if (answered.has(id)) continue;
    answered.add(id);
    const objectApiName = String((request.payload as Record<string, unknown>).objectApiName);
    await sendExtensionMessage(page, {
      type: 'seed:describe-object:response',
      id: `resp-${id}`,
      correlationId: id,
      payload: { objectApiName, objectLabel: objectApiName, fields: SEED_DESCRIBES[objectApiName] },
    });
  }
}

/**
 * Open the Seed wizard on DevSandbox, pick Account, Contact and Opportunity
 * and leave the select step: three objects, so the configure step is skipped.
 */
async function pickThreeObjectsAndMoveOn(page: Page): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'seed';
  });
  await page.goto('/');
  await bridge.seedOrgs(MOCK_ORGS);
  await page.getByTestId('mode-card-ai').click();
  await page.getByTestId('fork-card-scratch').click();
  await page.getByTestId('org-selector').selectOption('org-src-1');
  await bridge.waitForMessage('seed:describe-global', { timeout: 10_000 });
  await respondToAll(page, 'seed:describe-global', 'seed:describe-global:response', {
    objects: Object.keys(SEED_DESCRIBES).map((apiName) => ({
      apiName,
      label: apiName,
      recordCount: 0,
      dependencies: [],
    })),
  });
  for (const apiName of Object.keys(SEED_DESCRIBES)) {
    await page.getByTestId(`obj-${apiName}`).click();
  }
  await page.getByTestId('seed-wizard-next').click();
  await expect(page.getByTestId('seed-step-execute-content')).toBeVisible();
  return bridge;
}

/** Answer the describes until the step says which rules the run uses. */
async function settleDescribes(page: Page): Promise<void> {
  const answered = new Set<string>();
  await expect
    .poll(
      async () => {
        await answerSeedDescribes(page, answered);
        return page.getByTestId('seed-fields-status').textContent();
      },
      { timeout: 10_000 },
    )
    .toBe('Using default field rules.');
}

/** The part of the template a `seed:execute` carries that these tests read. */
interface SentTemplate {
  objects: Array<{
    objectApiName: string;
    recordCount: number;
    fieldRules: Array<{ fieldApiName: string }>;
  }>;
  relations?: unknown[];
}

/** The template of the one `seed:execute` the wizard sent. */
async function sentTemplate(bridge: MockBridge): Promise<SentTemplate> {
  const request = await bridge.waitForMessage('seed:execute', { timeout: 10_000 });
  return (request.payload as { template: SentTemplate }).template;
}

test.describe('Seed — a wizard run of three objects, which skips the configure step', () => {
  test('reaches seed:execute with the rules the describes gave each object', async ({ page }) => {
    // The describes happened on the configure step alone, so this run went out
    // with `fieldRules: []` for every object and the extension refused it.
    const bridge = await pickThreeObjectsAndMoveOn(page);

    await expect(page.getByTestId('seed-fields-status')).toHaveText(
      'Reading the fields of the selected objects...',
    );
    await expect(page.getByTestId('seed-wizard-next')).toBeDisabled();

    await settleDescribes(page);
    await page.getByTestId('seed-wizard-next').click();
    await page.getByTestId('seed-wizard-finish').click();

    const template = await sentTemplate(bridge);
    expect(
      Object.fromEntries(
        template.objects.map((o) => [o.objectApiName, o.fieldRules.map((r) => r.fieldApiName)]),
      ),
    ).toEqual({
      Account: ['Name'],
      Contact: ['LastName', 'AccountId'],
      Opportunity: ['Name', 'CloseDate', 'StageName'],
    });
    expect((await bridge.getMessages('seed:execute')).length).toBe(1);
  });

  test('sets a relation on the execute step and sends it with the run', async ({ page }) => {
    const bridge = await pickThreeObjectsAndMoveOn(page);
    await settleDescribes(page);

    await page.getByTestId('add-relation-btn').click();
    await expect(page.getByTestId('relation-0-planned')).toHaveText(
      'Contact: up to 300 records — parents: 100 × Account, created by this run.',
    );
    await page.getByTestId('seed-wizard-next').click();
    await page.getByTestId('seed-wizard-finish').click();

    const template = await sentTemplate(bridge);
    expect(template.relations).toEqual([
      {
        childObject: 'Contact',
        lookupField: 'AccountId',
        parentObject: 'Account',
        parents: { kind: 'generated' },
        distribution: { mode: 'perParent', count: 3 },
      },
    ]);
    const contact = template.objects.find((o) => o.objectApiName === 'Contact');
    expect(contact?.recordCount).toBe(300);
    expect(contact?.fieldRules.map((r) => r.fieldApiName)).toEqual(['LastName']);
  });
});

/** Both sandboxes, neither connected: no org is selected, so a clone has no target. */
const NONE_SELECTED = MOCK_ORGS.map((org) => ({ ...org, status: 'expired' }));

/** What the Clone wizard says of a missing target, on its first two steps. */
const NEEDS_BOTH_ORGS =
  'The clone needs a source org and a target org. It writes to the org selected in SandForge: ' +
  'pick one on the Organizations page.';

test.describe('Seed Clone — with no org selected', () => {
  test('never asks for the preview, and says why on both steps', async ({ page }) => {
    // Sent with an empty target, the preview came back as the bridge's
    // refusal, shown as it was written: "Invalid payload — targetOrgId: …".
    const bridge = new MockBridge();
    await bridge.setup(page);
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'seed';
    });
    await page.goto('/');
    await bridge.seedOrgs(NONE_SELECTED);
    await page.getByTestId('mode-card-clone').click();

    await expect(page.getByTestId('clone-no-target')).toHaveText(NEEDS_BOTH_ORGS);
    await page.getByTestId('clone-source-select').selectOption('org-src-1');
    await bridge.waitForMessage('seed:clone:describe-source', { timeout: 10_000 });
    await respondToAll(page, 'seed:clone:describe-source', 'seed:clone:describe-source:response', {
      objects: [{ apiName: 'Account', label: 'Account', recordCount: -1 }],
    });
    await page.getByTestId('clone-wizard-next').click();
    await page.getByTestId('clone-obj-check-Account').check();

    await expect(page.getByTestId('clone-wizard-next')).toBeDisabled();
    await expect(page.getByTestId('clone-needs-both-orgs')).toHaveText(NEEDS_BOTH_ORGS);
    expect(await outgoing(page, 'seed:clone:preview')).toEqual([]);
  });
});

/** A third sandbox, selected in the sidebar once the preview is made. */
const UAT_SANDBOX = {
  ...MOCK_ORGS[1],
  id: 'org-uat-1',
  alias: 'UatSandbox',
  username: 'uat@sandbox.com',
  instanceUrl: 'https://uat.salesforce.com',
};

/** What the Clone wizard says when the org selected changes after its preview. */
const TARGET_CHANGED =
  'The target org changed after the preview. A clone writes only to the org its preview was ' +
  'made for: preview again to clone into the org selected now.';

test.describe('Seed Clone — the orgs its preview was made for', () => {
  /**
   * Open the Clone wizard with three sandboxes, the first one selected as the
   * target, and preview the accounts of the second: answered, on screen.
   */
  async function previewAccounts(page: Page): Promise<MockBridge> {
    const bridge = new MockBridge();
    await bridge.setup(page);
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'seed';
    });
    await page.goto('/');
    await bridge.seedOrgs([...MOCK_ORGS, UAT_SANDBOX]);
    await page.getByTestId('mode-card-clone').click();
    await page.getByTestId('clone-source-select').selectOption(MOCK_ORGS[1].id);
    await bridge.waitForMessage('seed:clone:describe-source', { timeout: 10_000 });
    await respondToAll(page, 'seed:clone:describe-source', 'seed:clone:describe-source:response', {
      objects: [{ apiName: 'Account', label: 'Account', recordCount: -1 }],
    });
    await page.getByTestId('clone-wizard-next').click();
    await page.getByTestId('clone-obj-check-Account').check();
    await page.getByTestId('clone-wizard-next').click();
    await bridge.waitForMessage('seed:clone:preview', { timeout: 10_000 });
    await respondToAll(page, 'seed:clone:preview', 'seed:clone:preview:response', {
      objects: [{ objectApiName: 'Account', recordCount: 3, sampleRecords: [], relationships: [] }],
      insertOrder: ['Account'],
    });
    await expect(page.getByTestId('clone-preview-panel')).toBeVisible();
    return bridge;
  }

  test('sends the run to the orgs its preview was made for, naming that preview', async ({
    page,
  }) => {
    await previewAccounts(page);
    const [preview] = await outgoing(page, 'seed:clone:preview');

    await page.getByTestId('clone-preview-execute').click();

    await expect(page.getByTestId('clone-executing')).toBeVisible();
    const runs = await outgoing(page, 'seed:clone:execute');
    expect(runs.map((run) => run.payload)).toEqual([
      {
        sourceOrgId: MOCK_ORGS[1].id,
        targetOrgId: MOCK_ORGS[0].id,
        objects: [{ objectApiName: 'Account' }],
        previewId: preview.id,
      },
    ]);
  });

  test('sets the preview aside when another org is selected after it, says why, and previews again for that org', async ({
    page,
  }) => {
    // Selected in the sidebar after the preview, another org became the
    // target Execute wrote to.
    await previewAccounts(page);

    await sendExtensionMessage(page, {
      type: 'org:selected',
      id: 'host-org-selected',
      payload: { orgId: UAT_SANDBOX.id },
    });

    await expect(page.getByTestId('clone-error')).toContainText(TARGET_CHANGED);
    await expect(page.getByTestId('clone-preview-execute')).toHaveCount(0);
    await expect(page.getByTestId('clone-obj-check-Account')).toBeChecked();
    expect(await outgoing(page, 'seed:clone:execute')).toEqual([]);
    await page.getByTestId('clone-wizard-next').click();
    await expect
      .poll(async () =>
        (await outgoing(page, 'seed:clone:preview')).map(
          (request) => (request.payload as { targetOrgId: string }).targetOrgId,
        ),
      )
      .toEqual([MOCK_ORGS[0].id, UAT_SANDBOX.id]);
  });

  test('runs the clone on Next from its preview, and shows it running', async ({ page }) => {
    // Next went on to an empty execute step, and nothing was run.
    await previewAccounts(page);

    await page.getByTestId('clone-wizard-next').click();

    await expect(page.getByTestId('clone-executing')).toBeVisible();
    expect(await outgoing(page, 'seed:clone:execute')).toHaveLength(1);
  });

  test('shows the steps it has passed as not clickable while the clone runs', async ({ page }) => {
    // Clicks on them were ignored while it ran, and they kept the pointer and
    // the hover of a step the wizard goes back to.
    await previewAccounts(page);

    await page.getByTestId('clone-preview-execute').click();

    await expect(page.getByTestId('clone-executing')).toBeVisible();
    for (const step of ['source', 'objects', 'preview']) {
      await expect(page.getByTestId(`clone-step-${step}`)).toBeDisabled();
      await expect(page.getByTestId(`clone-step-${step}`)).toHaveCSS('cursor', 'default');
    }
  });
});

/** What the Clone wizard says while its preview is on its way. */
const PREPARING_THE_PREVIEW =
  'Preparing the preview: SandForge is reading each object in both orgs and counting the ' +
  'records to clone.';

test.describe('Seed Clone — a preview on its way', () => {
  test('is shown being prepared on its step, in words, and set aside on Back', async ({ page }) => {
    // Next left the wizard on the objects until the answer came: nothing said
    // a preview was on its way, and Next stayed on to send another.
    const bridge = new MockBridge();
    await bridge.setup(page);
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'seed';
    });
    await page.goto('/');
    await bridge.seedOrgs(MOCK_ORGS);
    await page.getByTestId('mode-card-clone').click();
    await page.getByTestId('clone-source-select').selectOption(MOCK_ORGS[1].id);
    await bridge.waitForMessage('seed:clone:describe-source', { timeout: 10_000 });
    await respondToAll(page, 'seed:clone:describe-source', 'seed:clone:describe-source:response', {
      objects: [{ apiName: 'Account', label: 'Account', recordCount: -1 }],
    });
    await page.getByTestId('clone-wizard-next').click();
    await page.getByTestId('clone-obj-check-Account').check();

    await page.getByTestId('clone-wizard-next').click();

    await expect(page.getByTestId('clone-preview-loading').getByRole('status')).toHaveText(
      PREPARING_THE_PREVIEW,
    );
    await expect(page.getByTestId('clone-wizard-next')).toBeDisabled();
    await page.getByTestId('clone-wizard-back').click();
    await expect(page.getByTestId('clone-obj-check-Account')).toBeChecked();
    // Answered once the wizard went back, it no longer brings the wizard forward.
    await respondToAll(page, 'seed:clone:preview', 'seed:clone:preview:response', {
      objects: [{ objectApiName: 'Account', recordCount: 3, sampleRecords: [], relationships: [] }],
      insertOrder: ['Account'],
    });
    await expect(page.getByTestId('clone-preview-panel')).toHaveCount(0);
    await expect(page.getByTestId('clone-obj-check-Account')).toBeVisible();
    expect(await outgoing(page, 'seed:clone:preview')).toHaveLength(1);
  });
});

/** The graph a discovery of one Account and its Contacts answers with. */
const DISCOVERED_GRAPH = {
  nodes: [
    {
      objectApiName: 'Account',
      recordCount: 1,
      fieldCount: 50,
      status: 'idle',
      progress: 0,
      included: true,
      piiFields: [],
      anonymizeFields: [],
      level: 0,
      successCount: 0,
      failureCount: 0,
      errors: [],
      createableFieldCount: 40,
      estimatedSizeMB: 0.01,
      estimatedApiCalls: 1,
      batchStrategy: 'auto',
    },
    {
      objectApiName: 'Contact',
      recordCount: 3,
      fieldCount: 60,
      status: 'idle',
      progress: 0,
      included: true,
      piiFields: ['Email'],
      anonymizeFields: [],
      level: 1,
      successCount: 0,
      failureCount: 0,
      errors: [],
      createableFieldCount: 45,
      estimatedSizeMB: 0.02,
      estimatedApiCalls: 1,
      batchStrategy: 'auto',
    },
  ],
  edges: [
    {
      sourceObject: 'Account',
      targetObject: 'Contact',
      relationshipName: 'Contacts',
      type: 'lookup',
    },
  ],
  totalRecords: 4,
  estimatedSizeMB: 0.03,
  estimatedDurationSeconds: 2,
};

test.describe('Forge — a run saved as a template', () => {
  let bridge: MockBridge;

  test.beforeEach(async ({ page }) => {
    bridge = await openForge(page);
    await page.waitForSelector('[data-testid="forge-page"]', { timeout: 10_000 });
  });

  /** Take one record through discovery, review and execution to the results. */
  async function runToResults(page: Page): Promise<void> {
    await pickOrg(page, 'forge-target-org', 'org-tgt-1');
    await enterRecordIdAndSettlePreview(page, bridge, RECORD_ID, ACCOUNT_PREVIEW);
    await page.getByTestId('forge-depth-full').click();
    await page.getByTestId('forge-discover-btn').click();
    await bridge.waitForMessage('forge:discover', { timeout: 10_000 });
    // Each phase mounts once the last one has animated out, and only then
    // listens: an answer sent sooner reaches no one.
    await expect(page.getByTestId('forge-discovery-loading')).toBeVisible({ timeout: 10_000 });
    await respondToAll(page, 'forge:discover', 'forge:discover:response', {
      graph: DISCOVERED_GRAPH,
    });
    await page.getByTestId('forge-execute-btn').click();
    await page.getByTestId('execute-button').click();
    await bridge.waitForMessage('forge:execute', { timeout: 10_000 });
    await expect(page.getByTestId('forge-execution')).toBeVisible({ timeout: 10_000 });
    await respondToAll(page, 'forge:execute', 'forge:execute:response', {
      result: {
        forgeId: 'forge-run-1',
        status: 'success',
        graph: DISCOVERED_GRAPH,
        duration: 2_000,
        timestamp: '2026-09-01T08:00:00.000Z',
        idRemapCount: 4,
        createdCount: 4,
      },
    });
    await expect(page.getByTestId('forge-results')).toBeVisible({ timeout: 10_000 });
  }

  test('saves the run, and the Template tab applies it to a new run', async ({ page }) => {
    await runToResults(page);

    await page.getByTestId('forge-save-template').click();
    await expect(page.getByTestId('forge-save-template-name')).toBeFocused();
    await page.getByTestId('forge-save-template-name').fill('Account 360, full depth');
    await page.getByTestId('forge-save-template-submit').click();

    const save = await bridge.waitForMessage('forge:templates:save', { timeout: 10_000 });
    const { template } = save.payload as { template: Record<string, unknown> };
    expect(template).toMatchObject({
      name: 'Account 360, full depth',
      targetOrgId: 'org-tgt-1',
      config: { inputMode: 'record', recordId: RECORD_ID, depth: 'full' },
    });
    expect(JSON.stringify(template)).not.toContain('org-src-1');
    await respondToAll(page, 'forge:templates:save', 'forge:templates:save:response', {
      success: true,
    });
    await expect(page.getByTestId('forge-save-template-saved')).toContainText(
      'Account 360, full depth',
    );

    // A new run: the form starts over, and the Template tab lists what the
    // extension keeps.
    await page.getByTestId('forge-again').click();
    // The first form asked once already; the new one asks again on mount.
    await expect
      .poll(async () => (await outgoing(page, 'forge:templates:list')).length)
      .toBeGreaterThanOrEqual(2);
    await respondToAll(page, 'forge:templates:list', 'forge:templates:list:response', {
      templates: [template],
    });
    await page.getByTestId('forge-depth-direct').click();
    await page.getByTestId('forge-tab-template').click();
    const apply = page.getByTestId(`forge-template-apply-${String(template.id)}`);
    await expect(apply).toContainText('Account 360, full depth');

    await apply.click();

    await expect(apply).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('forge-template-applied')).toBeVisible();
    await expect(page.getByTestId('forge-depth-full')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('forge-discover-btn')).toBeEnabled();
  });
});
