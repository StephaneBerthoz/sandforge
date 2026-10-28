import { test, expect, type Page } from '@playwright/test';
import { RETAIL_ORDERS_PACK } from '@sandforge/shared';
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
  await page.getByTestId('mode-card-generate').click();
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

/** One object's removal, as the extension counts it. */
function removedObject(objectApiName: string, deleted: number): Record<string, unknown> {
  return {
    objectApiName,
    planned: deleted,
    deleted,
    alreadyGone: 0,
    keptChanged: 0,
    keptDependents: 0,
    refused: 0,
    heldBy: [],
    unchecked: [],
    reasons: [],
  };
}

test.describe('Seed — a run taken back from its results', () => {
  test('removes what the run created, by its id, once the org is typed', async ({ page }) => {
    // The command line could take a seed back from its summary; the panel
    // offered nothing, and what a seed wrote from it stayed in the org.
    const bridge = await pickThreeObjectsAndMoveOn(page);
    await settleDescribes(page);
    await page.getByTestId('seed-wizard-next').click();
    await page.getByTestId('seed-wizard-finish').click();
    await bridge.waitForMessage('seed:execute', { timeout: 10_000 });
    await respondToAll(page, 'seed:execute', 'seed:execute:response', {
      templateId: 'tpl',
      operationId: 'op-seed-1',
      status: 'success',
      objectResults: [
        {
          objectApiName: 'Account',
          recordsCreated: 1,
          recordsFailed: 0,
          createdIds: [],
          errors: [],
        },
        {
          objectApiName: 'Contact',
          recordsCreated: 2,
          recordsFailed: 0,
          createdIds: [],
          errors: [],
        },
      ],
      totalRecordsCreated: 3,
      totalRecordsFailed: 0,
      duration: 1_000,
      timestamp: '2026-10-17T08:01:00.000Z',
    });
    await expect(page.getByTestId('seed-step-results-content')).toBeVisible({ timeout: 10_000 });

    const asked = await bridge.waitForMessage('seed:removal:info', { timeout: 10_000 });
    expect(asked.payload).toEqual({ runId: 'op-seed-1' });
    await respondToAll(page, 'seed:removal:info', 'seed:removal:info:response', {
      info: {
        runId: 'op-seed-1',
        targetOrgId: 'org-src-1',
        startedAt: '2026-10-17T08:00:00.000Z',
        endedAt: '2026-10-17T08:01:00.000Z',
        created: 3,
        left: [
          { objectApiName: 'Contact', count: 2 },
          { objectApiName: 'Account', count: 1 },
        ],
      },
    });
    await expect(page.getByTestId('seed-removal-created')).toHaveText(
      '3 records created in DevSandbox',
    );

    await page.getByTestId('seed-removal-remove').click();
    await expect(page.getByTestId('forge-removal-plan')).toContainText('Contact');
    expect(await outgoing(page, 'seed:remove')).toEqual([]);
    await page.getByTestId('danger-input').fill('DevSandbox');
    await page.getByTestId('danger-confirm-btn').click();

    const remove = await bridge.waitForMessage('seed:remove', { timeout: 10_000 });
    expect(remove.payload).toEqual({ runId: 'op-seed-1' });
    await expect(page.getByTestId('seed-removal-removing')).toBeVisible();
    await respondToAll(page, 'seed:remove', 'seed:remove:response', {
      result: {
        runId: 'op-seed-1',
        status: 'success',
        includeChanged: false,
        finishedAt: '2026-10-17T09:00:00.000Z',
        objects: [removedObject('Contact', 2), removedObject('Account', 1)],
      },
      operationId: String(remove.id),
    });
    await expect(page.getByTestId('forge-removal-result')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('seed-removal-removing')).toHaveCount(0);
  });
});

/** Account's record types as the extension reads them from the target, the person account's marked. */
const ACCOUNT_RECORD_TYPES = [
  {
    recordTypeId: '012000000000001AAA',
    developerName: 'PersonAccount',
    label: 'Person Account',
    person: true,
    isDefault: false,
  },
  {
    recordTypeId: '012000000000002AAA',
    developerName: 'Customer',
    label: 'Customer',
    person: false,
    isDefault: true,
  },
];

test.describe('Seed — the record types of the accounts a run writes', () => {
  test('writes person accounts for the person account type, and waits on a mix of kinds', async ({
    page,
  }) => {
    // Person accounts could be seeded from the command line only
    // (--record-type): the panel offered no record type.
    const bridge = await pickThreeObjectsAndMoveOn(page);
    const answered = new Set<string>();
    await expect
      .poll(
        async () => {
          for (const request of await outgoing(page, 'seed:describe-object')) {
            const id = String(request.id);
            if (answered.has(id)) continue;
            answered.add(id);
            const objectApiName = String(
              (request.payload as Record<string, unknown>).objectApiName,
            );
            await sendExtensionMessage(page, {
              type: 'seed:describe-object:response',
              id: `resp-${id}`,
              correlationId: id,
              payload: {
                objectApiName,
                objectLabel: objectApiName,
                fields: SEED_DESCRIBES[objectApiName],
                ...(objectApiName === 'Account' ? { recordTypes: ACCOUNT_RECORD_TYPES } : {}),
              },
            });
          }
          return page.getByTestId('seed-fields-status').textContent();
        },
        { timeout: 10_000 },
      )
      .toBe('Using default field rules.');

    const picker = page.getByTestId('seed-record-types-Account');
    await expect(picker).toContainText('person account');
    await expect(picker).toContainText('your default');
    await expect(page.getByTestId('seed-record-types-Contact')).toHaveCount(0);

    await page.getByTestId('seed-record-type-Account-PersonAccount').check();
    await page.getByTestId('seed-record-type-Account-Customer').check();
    await expect(page.getByRole('alert')).toContainText('take different fields');
    await expect(page.getByTestId('seed-wizard-next')).toBeDisabled();

    await page.getByTestId('seed-record-type-Account-Customer').uncheck();
    await expect(page.getByTestId('seed-record-types-person-Account')).toContainText('no Name');
    await page.getByTestId('seed-wizard-next').click();
    await page.getByTestId('seed-wizard-finish').click();

    const request = await bridge.waitForMessage('seed:execute', { timeout: 10_000 });
    const account = (
      request.payload as {
        template: { objects: Array<{ objectApiName: string; fieldRules: unknown[] }> };
      }
    ).template.objects.find((o) => o.objectApiName === 'Account');
    expect(account?.fieldRules).toContainEqual({
      fieldApiName: 'RecordTypeId',
      fieldType: 'reference',
      ruleType: 'static',
      config: { staticValue: '012000000000001AAA' },
    });
  });
});

/** Account as an org with person accounts describes it: a company's name and a person's. */
const PERSON_ORG_ACCOUNT = [
  seedField('Name', 'string', { length: 255 }),
  seedField('Phone', 'phone', { length: 40 }),
  seedField('FirstName', 'string', { length: 40 }),
  seedField('LastName', 'string', { length: 80 }),
  seedField('PersonEmail', 'email', { length: 80 }),
];

test.describe("Seed — the configure step lists an account's fields for the kind of account chosen", () => {
  test('a person account without Name, its last name required; a business account without the person fields', async ({
    page,
  }) => {
    // The step listed every field the describe gave: Name was set a rule on a
    // person account, which the extension dropped before the run.
    const bridge = new MockBridge();
    await bridge.setup(page);
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'seed';
    });
    await page.goto('/');
    await bridge.seedOrgs(MOCK_ORGS);
    await page.getByTestId('mode-card-generate').click();
    await page.getByTestId('org-selector').selectOption('org-src-1');
    await bridge.waitForMessage('seed:describe-global', { timeout: 10_000 });
    await respondToAll(page, 'seed:describe-global', 'seed:describe-global:response', {
      objects: ['Account', 'Contact'].map((apiName) => ({
        apiName,
        label: apiName,
        recordCount: 0,
        dependencies: [],
      })),
    });
    await page.getByTestId('obj-Account').click();
    await page.getByTestId('obj-Contact').click();
    await page.getByTestId('seed-wizard-next').click();
    // Two objects skip the configure step; the link on the next one leads back.
    await page.getByTestId('adaptive-customize-link').click();
    const answered = new Set<string>();
    await expect
      .poll(
        async () => {
          for (const request of await outgoing(page, 'seed:describe-object')) {
            const id = String(request.id);
            if (answered.has(id)) continue;
            answered.add(id);
            const objectApiName = String(
              (request.payload as Record<string, unknown>).objectApiName,
            );
            await sendExtensionMessage(page, {
              type: 'seed:describe-object:response',
              id: `resp-${id}`,
              correlationId: id,
              payload: {
                objectApiName,
                objectLabel: objectApiName,
                ...(objectApiName === 'Account'
                  ? { fields: PERSON_ORG_ACCOUNT, recordTypes: ACCOUNT_RECORD_TYPES }
                  : { fields: SEED_DESCRIBES[objectApiName] }),
              },
            });
          }
          return page.getByTestId('obj-header-Contact').count();
        },
        { timeout: 10_000 },
      )
      .toBe(1);
    const fields = page.getByTestId('step-configure-fields');
    const row = (name: string) => fields.getByTestId(`field-Account-${name}`);

    await page.getByTestId('seed-record-type-Account-PersonAccount').check();
    await expect(row('Name')).toHaveCount(0);
    await expect(row('FirstName')).toBeVisible();
    await expect(row('LastName')).toContainText('*');
    await expect(row('PersonEmail')).toBeVisible();

    await page.getByTestId('seed-record-type-Account-PersonAccount').uncheck();
    await page.getByTestId('seed-record-type-Account-Customer').check();
    await expect(row('Name')).toContainText('*');
    await expect(row('Phone')).toBeVisible();
    await expect(row('FirstName')).toHaveCount(0);
    await expect(row('LastName')).toHaveCount(0);
    await expect(row('PersonEmail')).toHaveCount(0);

    await page.getByTestId('seed-wizard-next').click();
    await expect(page.getByTestId('seed-step-execute-content')).toBeVisible();
    await page.getByTestId('seed-wizard-next').click();
    await page.getByTestId('seed-wizard-finish').click();
    const template = await sentTemplate(bridge);
    expect(
      template.objects
        .find((o) => o.objectApiName === 'Account')
        ?.fieldRules.map((r) => r.fieldApiName),
    ).toEqual(['Name', 'Phone', 'RecordTypeId']);
  });
});

test.describe('Seed — earlier seeds, removable after a reload', () => {
  test('lists the seeds kept and opens one onto its removal', async ({ page }) => {
    // What a seed from the panel created was kept for the window's life:
    // once it was reloaded, nothing led back to the run.
    const bridge = new MockBridge();
    await bridge.setup(page);
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'seed';
    });
    await page.goto('/');
    await bridge.seedOrgs(MOCK_ORGS);
    await bridge.waitForMessage('seed:removal:list', { timeout: 10_000 });
    await respondToAll(page, 'seed:removal:list', 'seed:removal:list:response', {
      runs: [
        {
          runId: 'op-earlier',
          targetOrgId: 'org-src-1',
          startedAt: '2026-10-17T08:00:00.000Z',
          endedAt: '2026-10-17T08:01:00.000Z',
          created: 3,
          left: [{ objectApiName: 'Account', count: 3 }],
        },
      ],
    });

    await expect(page.getByTestId('seed-run-history-op-earlier')).toContainText(
      'DevSandbox · 3 records created',
    );
    await expect(page.getByTestId('seed-run-history-state-op-earlier')).toHaveText(
      'can be removed',
    );
    await page.getByTestId('seed-run-history-toggle-op-earlier').click();
    const asked = await bridge.waitForMessage('seed:removal:info', { timeout: 10_000 });
    expect(asked.payload).toEqual({ runId: 'op-earlier' });
  });
});

/** Boot the Seed page on its start, the saved templates and the kept seeds answered. */
async function openSeedStart(page: Page): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'seed';
  });
  await page.goto('/');
  await bridge.seedOrgs(MOCK_ORGS);
  await bridge.waitForMessage('seed:template:list', { timeout: 10_000 });
  await respondToAll(page, 'seed:template:list', 'seed:template:list:response', {
    templates: [],
  });
  return bridge;
}

test.describe('Seed — test data for an Agentforce agent, from a scenario', () => {
  test('reviews a shipped pack, reads the org, seeds it with what was read, and writes the test file, never deploying it', async ({
    page,
  }) => {
    const bridge = await openSeedStart(page);
    await bridge.waitForMessage('seed:scenario:packs', { timeout: 10_000 });
    await respondToAll(page, 'seed:scenario:packs', 'seed:scenario:packs:response', {
      packs: [{ source: 'built-in', pack: RETAIL_ORDERS_PACK }],
      workspace: true,
    });

    await page.getByRole('button', { name: 'Review the scenario Online shop orders' }).click();
    await expect(page.getByTestId('scenario-review')).toContainText(
      RETAIL_ORDERS_PACK.topics[0].article.title,
    );
    await page.getByTestId('btn-scenario-continue').click();
    // The org the panel selected, read before anything is written.
    const prepare = await bridge.waitForMessage('seed:scenario:prepare', { timeout: 10_000 });
    expect((prepare.payload as { orgId: string }).orgId).toBe('org-src-1');
    const options = { seed: 1, caseStatus: { open: 'Received', closed: 'Resolved' } };
    await respondToAll(page, 'seed:scenario:prepare', 'seed:scenario:prepare:response', {
      preparation: {
        options,
        objects: [
          { objectApiName: 'Account', recordCount: 10 },
          { objectApiName: 'Knowledge__kav', recordCount: 6, optional: true },
        ],
        tests: 14,
        caseStatusFrom: { from: 'org' },
        knowledge: { available: false, reason: 'Salesforce Knowledge is not turned on in it' },
      },
    });
    await expect(page.getByTestId('scenario-statuses')).toHaveText(
      "Open cases are written as Received and closed ones as Resolved: the org's own statuses.",
    );
    expect(await outgoing(page, 'seed:scenario:execute')).toEqual([]);

    await page.getByTestId('btn-scenario-start').click();
    const run = await bridge.waitForMessage('seed:scenario:execute', { timeout: 10_000 });
    expect(run.payload).toEqual({ orgId: 'org-src-1', pack: RETAIL_ORDERS_PACK, options });
    await respondToAll(page, 'seed:scenario:execute', 'seed:execute:response', {
      templateId: 'scenario-retail-orders',
      operationId: 'scenario-run-1',
      status: 'success',
      objectResults: [
        {
          objectApiName: 'Account',
          recordsCreated: 10,
          recordsFailed: 0,
          createdIds: [],
          errors: [],
        },
      ],
      totalRecordsCreated: 10,
      totalRecordsFailed: 0,
      duration: 1000,
      timestamp: '2026-10-28T00:00:00.000Z',
      scenario: {
        packId: 'retail-orders',
        packName: RETAIL_ORDERS_PACK.name,
        tests: 14,
        openCasesWritten: 10,
        openCases: 10,
        articlesPublished: false,
        companion: { kind: 'kept' },
      },
    });
    await bridge.waitForMessage('seed:scenario:agents', { timeout: 10_000 });
    await respondToAll(page, 'seed:scenario:agents', 'seed:scenario:agents:response', {
      orgId: 'org-src-1',
      agents: {
        kind: 'agents',
        agents: [
          {
            id: '16j000000000001AAA',
            name: 'Retail_Service_Agent',
            topics: [{ name: 'Order_Issues', described: true, actions: [], unnamedActions: 0 }],
            unnamedTopics: 0,
            variables: [],
          },
        ],
      },
      project: { kind: 'dx', dir: '/workspace' },
    });
    for (const topic of RETAIL_ORDERS_PACK.topics) {
      await page.getByTestId(`scenario-tests-map-${topic.key}`).selectOption('Order_Issues');
    }
    await page.getByTestId('btn-scenario-tests-write').click();

    const write = await bridge.waitForMessage('seed:scenario:test-file', { timeout: 10_000 });
    expect(write.payload).toMatchObject({
      runId: 'scenario-run-1',
      choice: { agent: 'Retail_Service_Agent', runner: 'testing-center', guardTopic: null },
    });
    await respondToAll(page, 'seed:scenario:test-file', 'seed:scenario:test-file:response', {
      runId: 'scenario-run-1',
      outcome: {
        kind: 'written',
        path: '/workspace/specs/a.yaml',
        specPath: 'specs/a.yaml',
        apiName: 'A',
        commands: { create: 'sf agent test create --spec specs/a.yaml', run: 'sf agent test run' },
        leftOut: [],
      },
    });
    await expect(page.getByTestId('scenario-tests-create')).toHaveText(
      'sf agent test create --spec specs/a.yaml',
    );
  });
});

test.describe('Seed — the start, and a template seeded from its one confirmation', () => {
  test('opens on the gallery, the CRM starter first, and seeds it on the panel’s org after one Start', async ({
    page,
  }) => {
    // The gallery sat behind "AI Generate" then "Start from Scratch"; Use This
    // opened a dialog whose "Start Seeding" started nothing, then a step asked
    // for an org the panel had already selected, under a second "Start Seeding".
    const bridge = await openSeedStart(page);

    const cards = page.getByTestId('template-gallery').locator('[data-testid^="template-card-"]');
    await expect(cards.first()).toHaveAttribute(
      'data-testid',
      'template-card-prebuilt-crm-starter',
    );
    await expect(cards.first().getByTestId('template-recommended')).toHaveText('Start here');
    await expect(page.getByTestId('seed-other-ways')).toContainText('Generate data');
    await expect(page.getByTestId('guided-first-step-card')).toHaveCount(0);

    await cards.first().getByTestId('btn-use-template').click();
    await expect(page.getByTestId('quick-seed-confirm')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('quick-seed-org-selector')).toHaveValue('org-src-1');
    await expect(page.getByRole('button', { name: 'Start Seeding' })).toHaveCount(1);
    await page.getByTestId('quick-seed-count-Contact').fill('10');
    // The cases a relation places under the contacts follow them; products
    // set to 0 are left out, with their prices and the line items on them.
    await expect(page.getByTestId('quick-seed-count-Case')).toHaveValue('6');
    await page.getByTestId('quick-seed-count-Product2').fill('0');

    await page.getByTestId('btn-quick-seed-start').click();
    const request = await bridge.waitForMessage('seed:execute', { timeout: 10_000 });
    const sent = request.payload as {
      orgId: string;
      template: { id: string; objects: Array<{ objectApiName: string; recordCount: number }> };
    };
    expect(sent.orgId).toBe('org-src-1');
    expect(sent.template.id).toBe('prebuilt-crm-starter');
    expect(sent.template.objects.find((o) => o.objectApiName === 'Contact')?.recordCount).toBe(10);
    expect(sent.template.objects.map((o) => o.objectApiName)).toEqual([
      'Account',
      'Contact',
      'Opportunity',
      'Case',
    ]);

    // Running: its Cancel, which the one-click path did not have, stops it by its id.
    const operationId = String(request.id);
    await bridge.stream([
      {
        type: 'operation:progress',
        payload: {
          operationId,
          percentage: 20,
          processedRecords: 30,
          totalRecords: 260,
          currentStep: 'Insert Account',
        },
      },
    ]);
    await page.getByTestId('btn-quick-seed-cancel').click();
    await page.getByTestId('danger-confirm-btn').click();
    const abort = await bridge.waitForMessage('execution:abort', { timeout: 10_000 });
    expect(abort.payload).toEqual({ operationId });

    // Its results: the refusals grouped, and the data one click away.
    await respondToAll(page, 'seed:execute', 'seed:execute:response', {
      templateId: 'prebuilt-minimal-demo',
      operationId,
      status: 'partial',
      cancelled: true,
      objectResults: [
        {
          objectApiName: 'Account',
          recordsCreated: 50,
          recordsFailed: 0,
          createdIds: ['001000000000001AAA', '001000000000002AAA'],
          errors: [],
        },
        {
          objectApiName: 'Contact',
          recordsCreated: 0,
          recordsFailed: 10,
          createdIds: [],
          errors: Array.from(
            { length: 10 },
            () => 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone must be written +33. [Phone]',
          ),
        },
      ],
      totalRecordsCreated: 50,
      totalRecordsFailed: 10,
      duration: 2_000,
      timestamp: '2026-10-20T08:00:00.000Z',
    });
    await expect(page.getByTestId('quick-seed-results')).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByTestId('seed-result-error-group-Contact-0').locator('summary'),
    ).toHaveText('10 × FIELD_CUSTOM_VALIDATION_EXCEPTION (Phone)');
    await expect(page.getByTestId('seed-result-errors-Contact').locator('details')).toHaveCount(1);

    await page.getByRole('button', { name: 'Open a created Account in DevSandbox' }).click();
    const open = await bridge.waitForMessage('seed:open-record', { timeout: 10_000 });
    expect(open.payload).toEqual({ runId: operationId, recordId: '001000000000001AAA' });
  });
});

test.describe('Seed — the org a template filled, kept as a checkpoint from its results', () => {
  test('opens Checkpoints on a take of the org the run wrote to, not of the org selected before', async ({
    page,
  }) => {
    // The moment worth keeping is right after the fill, before the testers
    // start: the results offer it, of the org the template went into.
    const bridge = await openSeedStart(page);
    const cards = page.getByTestId('template-gallery').locator('[data-testid^="template-card-"]');
    await cards.first().getByTestId('btn-use-template').click();
    await expect(page.getByTestId('quick-seed-org-selector')).toHaveValue('org-src-1');
    await page.getByTestId('quick-seed-org-selector').selectOption('org-tgt-1');
    await page.getByTestId('btn-quick-seed-start').click();
    const request = await bridge.waitForMessage('seed:execute', { timeout: 10_000 });
    expect((request.payload as { orgId: string }).orgId).toBe('org-tgt-1');
    await respondToAll(page, 'seed:execute', 'seed:execute:response', {
      templateId: 'prebuilt-crm-starter',
      operationId: String(request.id),
      status: 'success',
      objectResults: [
        {
          objectApiName: 'Account',
          recordsCreated: 50,
          recordsFailed: 0,
          createdIds: ['001000000000001AAA'],
          errors: [],
        },
      ],
      totalRecordsCreated: 50,
      totalRecordsFailed: 0,
      duration: 2_000,
      timestamp: '2026-10-23T08:00:00.000Z',
    });

    const offer = page.getByTestId('quick-seed-checkpoint-now');
    await expect(offer).toBeVisible({ timeout: 10_000 });
    await expect(offer).toContainText('keep QASandbox as it is now');
    const take = offer.getByRole('button', { name: 'Take a checkpoint now' });
    await expect(take).toHaveAccessibleDescription(/point to come back to/);
    await take.click();

    // The org is selected everywhere, then the take opens on it.
    await expect
      .poll(async () => (await outgoing(page, 'org:select')).map((message) => message.payload))
      .toContainEqual({ orgId: 'org-tgt-1' });
    await expect(page.getByTestId('checkpoint-page')).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByTestId('checkpoint-take').getByRole('heading', {
        name: 'Take a checkpoint of QASandbox',
      }),
    ).toBeVisible({ timeout: 10_000 });
    const scope = await bridge.waitForMessage('checkpoint:scope', { timeout: 10_000 });
    expect(scope.payload).toMatchObject({ orgId: 'org-tgt-1' });
  });
});

/**
 * What a Developer Edition runs as contacts are created: a workflow rule and
 * a flow that email each one unless the user holds the bypass, a flow that
 * opens a task; fifteen single emails left today.
 */
function contactAutomation(objects: string[]): Record<string, unknown> {
  const bypasses = [{ name: 'Trap_Bypass_Flow', held: false }];
  const entry = (over: Record<string, unknown>) => ({
    kind: 'flow',
    when: 'after',
    emails: 0,
    messages: [],
    creates: [],
    afterCommit: false,
    bypasses: [],
    keptQuiet: false,
    unread: false,
    ...over,
  });
  return {
    orgId: 'org-src-1',
    objects,
    preview: {
      org: 'DevSandbox',
      objectsRead: objects,
      objects: [
        {
          objectApiName: 'Contact',
          entries: [
            entry({ kind: 'workflowRule', name: 'Contact_Welcome', emails: 1, bypasses }),
            entry({ name: 'Follow Up Task', creates: ['Task'] }),
            entry({ name: 'Welcome Email', emails: 2, afterCommit: true, bypasses }),
          ],
        },
      ],
      emailsPerRecord: [
        {
          objectApiName: 'Contact',
          limit: 'DailyWorkflowEmails',
          perRecord: 1,
          sentBy: ['Contact_Welcome'],
        },
        {
          objectApiName: 'Contact',
          limit: 'SingleEmail',
          perRecord: 3,
          sentBy: ['Contact_Welcome', 'Welcome Email'],
        },
      ],
      limits: {
        SingleEmail: { max: 15, remaining: 15 },
        DailyWorkflowEmails: { max: 8040, remaining: 8040 },
      },
      alertsAsSingle: true,
      bypasses: [{ permission: 'Trap_Bypass_Flow', permissionSet: 'Trap_Bypass' }],
      bypassesHeld: [],
      unread: [],
      blinded: false,
      conditionsNotRead: 0,
    },
  };
}

test.describe('Seed — what the org runs, said before Start', () => {
  test('says on the confirmation what fires as the records are created, and holds Start past the emails left today', async ({
    page,
  }) => {
    // A seed of 75 contacts left a Developer Edition at -60 of its 15 single
    // emails, a workflow rule emailing each contact, with nothing said first.
    const bridge = await openSeedStart(page);
    await page
      .getByTestId('template-card-prebuilt-crm-starter')
      .getByTestId('btn-use-template')
      .click();
    const asked = await bridge.waitForMessage('seed:automation', { timeout: 10_000 });
    const objects = (asked.payload as { objects: string[] }).objects;
    expect(asked.payload).toEqual({
      orgId: 'org-src-1',
      objects: [
        'Account',
        'Contact',
        'Product2',
        'PricebookEntry',
        'Opportunity',
        'OpportunityLineItem',
        'Case',
      ],
    });
    // Start is not held while the org is read.
    await expect(page.getByTestId('seed-automation-reading')).toBeVisible();
    await expect(page.getByTestId('btn-quick-seed-start')).toBeEnabled();

    await respondToAll(
      page,
      'seed:automation',
      'seed:automation:response',
      contactAutomation(objects),
    );
    await expect(page.getByTestId('seed-automation-entry-Contact-Welcome Email')).toContainText(
      '2 emails per record',
    );
    await expect(page.getByTestId('seed-automation-bypass-Trap_Bypass_Flow')).toContainText(
      'the permission set Trap_Bypass holds it',
    );
    const refused = page.getByTestId('seed-automation-refused-SingleEmail');
    await expect(refused).toContainText(
      'Single emails these records make DevSandbox send: about 225, with 15 of 15 left today.',
    );
    await expect(refused).toContainText('set Contact to 0');
    await expect(page.getByTestId('btn-quick-seed-start')).toBeDisabled();
    const reads = (await bridge.getMessages('seed:automation')).length;

    // Five contacts send fifteen: Start again, from the same read.
    await page.getByTestId('quick-seed-count-Contact').fill('5');
    await expect(refused).toHaveCount(0);
    await expect(page.getByTestId('seed-automation-emails-SingleEmail')).toHaveText(
      'Single emails these records make DevSandbox send: about 15, with 15 of 15 left today.',
    );
    await expect(page.getByTestId('btn-quick-seed-start')).toBeEnabled();
    expect((await bridge.getMessages('seed:automation')).length).toBe(reads);
  });

  test('says a read that failed, holds nothing back, and reads again when asked', async ({
    page,
  }) => {
    const bridge = await openSeedStart(page);
    await page
      .getByTestId('template-card-prebuilt-crm-starter')
      .getByTestId('btn-use-template')
      .click();
    await bridge.waitForMessage('seed:automation', { timeout: 10_000 });
    await respondToAll(page, 'seed:automation', 'seed:automation:error', {
      message: 'INVALID_SESSION_ID',
      code: 'UNKNOWN',
      retryable: true,
    });
    await expect(page.getByTestId('seed-automation-unread')).toContainText('INVALID_SESSION_ID');
    await expect(page.getByTestId('btn-quick-seed-start')).toBeEnabled();
    const reads = (await bridge.getMessages('seed:automation')).length;

    await page.getByTestId('seed-automation-read-again').click();
    await expect(page.getByTestId('seed-automation-reading')).toBeVisible();
    await expect
      .poll(async () => (await bridge.getMessages('seed:automation')).length)
      .toBe(reads + 1);
  });
});

test.describe('Seed — the objects of the wizard', () => {
  test('pins the common objects, finds one by name, and offers the parent of a child ticked', async ({
    page,
  }) => {
    // About 670 objects in the API's order in a frame of a few rows, with no
    // search: Opportunity was a long scroll away.
    const bridge = await openSeedStart(page);
    await page.getByTestId('mode-card-generate').click();
    await page.getByTestId('org-selector').selectOption('org-src-1');
    await bridge.waitForMessage('seed:describe-global', { timeout: 10_000 });
    await respondToAll(page, 'seed:describe-global', 'seed:describe-global:response', {
      objects: ['AcceptedEventRelation', 'Invoice__c', 'Opportunity', 'Account', 'Contact'].map(
        (apiName) => ({ apiName, label: apiName, recordCount: 0, dependencies: [] }),
      ),
    });

    const common = page.getByTestId('seed-common-objects').getByRole('checkbox');
    await expect(common).toHaveCount(3);
    await expect(common.nth(0)).toHaveAttribute('data-testid', 'obj-Account');
    await expect(common.nth(2)).toHaveAttribute('data-testid', 'obj-Opportunity');
    await expect(page.getByTestId('nl2soql-helper')).toHaveCount(0);

    await page.getByTestId('seed-object-search').fill('invoice');
    await expect(page.getByRole('checkbox')).toHaveCount(1);
    await expect(page.getByTestId('obj-Invoice__c')).toBeVisible();
    await page.getByTestId('seed-object-search').fill('');

    await page.getByTestId('obj-Contact').click();
    await expect(page.getByTestId('seed-parent-suggestion-Account')).toContainText(
      'Contact records hang from Account',
    );
    await page.getByTestId('seed-add-parent-Account').click();
    await expect(page.getByTestId('obj-Account')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('seed-parent-suggestions')).toHaveCount(0);
    await expect(page.getByTestId('volume-Account')).toBeVisible();
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

  /** The Clone wizard on its objects step, the accounts of the second sandbox checked. */
  async function accountsChecked(page: Page): Promise<MockBridge> {
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
    return bridge;
  }

  /** The extension's preview of three accounts, for every preview asked for. */
  async function answerThePreview(page: Page): Promise<void> {
    await respondToAll(page, 'seed:clone:preview', 'seed:clone:preview:response', {
      objects: [{ objectApiName: 'Account', recordCount: 3, sampleRecords: [], relationships: [] }],
      insertOrder: ['Account'],
    });
  }

  test('takes the keyboard to the preview step, where a second Enter runs nothing once the preview comes', async ({
    page,
  }) => {
    // Next on the preview step runs the clone. Left on it, a second Enter
    // pressed while the preview was prepared wrote to the target as soon as
    // the preview came, before anyone had read it.
    await accountsChecked(page);

    await page.getByTestId('clone-wizard-next').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('clone-preview-loading')).toBeVisible();
    await answerThePreview(page);
    await expect(page.getByTestId('clone-preview-panel')).toBeVisible();
    await page.keyboard.press('Enter');

    expect(await outgoing(page, 'seed:clone:execute')).toEqual([]);
    await expect(page.getByTestId('clone-executing')).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Preview', exact: true })).toBeFocused();
  });

  test('hands the keyboard to the running step when the preview’s Execute starts the clone', async ({
    page,
  }) => {
    // Execute goes with the preview, and the focus it held fell to the page.
    await accountsChecked(page);
    await page.getByTestId('clone-wizard-next').click();
    await answerThePreview(page);

    await page.getByTestId('clone-preview-execute').focus();
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('clone-executing')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Execute', exact: true })).toBeFocused();
    expect(await outgoing(page, 'seed:clone:execute')).toHaveLength(1);
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

/*
 * The discovery screen used to take the answer itself: an answer that came
 * while it was not there went to no one, and the page showed a spinner with
 * nothing behind it.
 */
test.describe('Forge — a discovery that answers while its screen is not there', () => {
  let bridge: MockBridge;

  test.beforeEach(async ({ page }) => {
    bridge = await openForge(page);
    await page.waitForSelector('[data-testid="forge-page"]', { timeout: 10_000 });
    await pickOrg(page, 'forge-target-org', 'org-tgt-1');
    await enterRecordIdAndSettlePreview(page, bridge, RECORD_ID, ACCOUNT_PREVIEW);
  });

  test('shows the graph it answered with while a shortcut had taken the panel elsewhere', async ({
    page,
  }) => {
    await page.getByTestId('forge-discover-btn').click();
    await expect(page.getByTestId('forge-discovery-loading')).toBeVisible({ timeout: 10_000 });

    // G then O: the panel goes to the org manager, and the Forge page with it.
    await page.keyboard.press('g');
    await page.keyboard.press('o');
    await expect(page.getByTestId('org-manager-page')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('forge-page')).toHaveCount(0);
    await respondToAll(page, 'forge:discover', 'forge:discover:response', {
      graph: DISCOVERED_GRAPH,
    });

    await page.keyboard.press('g');
    await page.keyboard.press('f');
    await expect(page.getByTestId('forge-discovery')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('stat-objects')).toHaveText('2');
    await expect(page.getByTestId('forge-discovery-loading')).toHaveCount(0);
  });

  test('shows the graph it answered with before its screen had come in', async ({ page }) => {
    await page.getByTestId('forge-discover-btn').click();
    // Answered at once, as the extension answers a discovery it holds in its
    // cache: the input screen is still on its way out.
    await bridge.waitForMessage('forge:discover', { timeout: 10_000 });
    await respondToAll(page, 'forge:discover', 'forge:discover:response', {
      graph: DISCOVERED_GRAPH,
    });

    await expect(page.getByTestId('forge-discovery')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('stat-objects')).toHaveText('2');
  });
});

/*
 * One handler serves every panel. A newer discovery stopped any other and
 * answered it nothing: the page of the other panel span for good. And a stop
 * named nothing, so Back on one panel stopped a run of another.
 */
test.describe('Forge — a discovery that was stopped, and the stop that names it', () => {
  let bridge: MockBridge;

  test.beforeEach(async ({ page }) => {
    bridge = await openForge(page);
    await page.waitForSelector('[data-testid="forge-page"]', { timeout: 10_000 });
    await pickOrg(page, 'forge-target-org', 'org-tgt-1');
    await enterRecordIdAndSettlePreview(page, bridge, RECORD_ID, ACCOUNT_PREVIEW);
  });

  test('leaves the spinner for a discovery stopped to make way for a newer one, says so, and offers it again', async ({
    page,
  }) => {
    await page.getByTestId('forge-discover-btn').click();
    await expect(page.getByTestId('forge-discovery-loading')).toBeVisible({ timeout: 10_000 });

    await respondToAll(page, 'forge:discover', 'forge:discover:error', {
      message: 'The discovery was stopped to make way for a newer one.',
      code: 'DISCOVERY_SUPERSEDED',
      retryable: true,
    });

    await expect(page.getByTestId('forge-discovery-loading')).toHaveCount(0);
    await expect(page.getByTestId('forge-discovery-empty')).toContainText(
      'The discovery was stopped to make way for a newer one, from this panel or another',
    );
    await expect(page.getByTestId('forge-retry-discovery')).toBeVisible();
  });

  test('stops the discovery it leaves by its request, and no other', async ({ page }) => {
    await page.getByTestId('forge-discover-btn').click();
    await expect(page.getByTestId('forge-discovery-loading')).toBeVisible({ timeout: 10_000 });
    const [discovery] = await outgoing(page, 'forge:discover');

    await page.getByTestId('forge-discovery-cancel').click();

    await bridge.waitForMessage('forge:abort', { timeout: 10_000 });
    const stops = await outgoing(page, 'forge:abort');
    expect(stops).toHaveLength(1);
    expect(stops[0].payload).toEqual({ requestId: discovery.id });
  });
});
