import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MockBridge, checkAccessibility, formatViolations } from './helpers';
import { DEV_SANDBOX, MOCK_ORGS, QA_SANDBOX } from './fixtures';
import { VSCODE_DEFAULT_STYLES } from './fixtures/vscode-default-styles';
import { sendExtensionMessage } from './mocks/vscode-api';
import { hostColours, vscodeTheme } from '../src/styles/testing/vscodeThemes';

/**
 * The record type the target gives the records a run creates without one,
 * as the pages say it: before a Sync run, in its simulation; after a Forge
 * run, read back from the records, with what still ran of its mute named
 * where the target set another; before a Frozen Dataset load, in its
 * preview. On a scratch org whose admin had Master for default and one other
 * Opportunity type open, an Opportunity created without one got that type,
 * and nothing said so. Scanned with axe in the rendered page, under VS
 * Code's default light and dark themes, painted as the host paints a
 * webview.
 */
const THEMES = ['Light 2026', 'Dark 2026'] as const;
type Theme = (typeof THEMES)[number];

/** Paint the host theme before first paint, and prepend VS Code's default webview stylesheet. */
async function paintHostTheme(page: Page, theme: Theme): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(
    ({ colours, defaultStyles }: { colours: Record<string, string>; defaultStyles: string }) => {
      const paint = (): void => {
        for (const [name, value] of Object.entries(colours)) {
          document.documentElement.style.setProperty(`--vscode-${name}`, value);
        }
      };
      const prependDefaultStyles = (): void => {
        const style = document.createElement('style');
        style.id = '_defaultStyles';
        style.textContent = defaultStyles;
        document.head.prepend(style);
      };
      if (document.documentElement) paint();
      else document.addEventListener('DOMContentLoaded', paint);
      if (document.head) prependDefaultStyles();
      else document.addEventListener('DOMContentLoaded', prependDefaultStyles);
    },
    { colours: hostColours(vscodeTheme(theme)), defaultStyles: VSCODE_DEFAULT_STYLES },
  );
}

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

/** The one other Opportunity type the target opens to the user it writes as. */
const RETAIL = { developerName: 'SFX_Retail', label: 'SFX Retail' };

/** What the target gives an Opportunity on Master in the source, as its describe predicts. */
const PREDICTED = { ...RETAIL, basis: 'onlyOneOpen' };

/** The line of that prediction, from its first words. */
const PREDICTED_WORDS =
  'the target org would give it SFX_Retail (SFX Retail), the only other Opportunity record ' +
  'type open to the user SandForge writes as';

/* ── Sync ─────────────────────────────────────────────────────────────── */

/** A draft on the execute step: an account and an opportunity, ready to simulate. */
const SYNC_DRAFT = {
  currentStep: 4,
  direction: 'source_to_target',
  mode: 'full',
  conflictStrategy: 'source_wins',
  sourceOrgId: DEV_SANDBOX.id,
  targetOrgId: QA_SANDBOX.id,
  objectEntries: ['Account', 'Opportunity'].map((objectApiName) => ({
    objectApiName,
    operation: 'insert',
    externalIdField: '',
    batchSize: 200,
    where: '',
  })),
  mappingsByObject: {},
  transforms: [],
};

/** One simulated object, its counts the insert of one record. */
function simulated(objectApiName: string, extra: Record<string, unknown> = {}) {
  return {
    objectApiName,
    operation: 'insert',
    read: 1,
    insert: 1,
    update: 0,
    delete: 0,
    skipped: 0,
    refused: 0,
    conflicts: 0,
    conflictFields: [],
    notes: [],
    ...extra,
  };
}

/**
 * The case the probes found: the account carries its type, and the
 * opportunity, on Master in the source, goes without one.
 */
const SYNC_SIMULATION = {
  configId: 'cfg-record-types',
  operationId: 'sim-record-types',
  direction: 'source_to_target',
  conflictStrategy: 'source_wins',
  objects: [
    simulated('Account'),
    simulated('Opportunity', {
      recordTypeGiven: {
        objectApiName: 'Opportunity',
        rows: 1,
        why: { masterInSource: 1 },
        predicted: PREDICTED,
      },
    }),
  ],
  duration: 600,
  timestamp: '2026-11-01T10:00:00.000Z',
};

/* ── Forge ────────────────────────────────────────────────────────────── */

/** An opportunity, as a Forge discovery answers with it. */
const GRAPH = {
  nodes: [
    {
      objectApiName: 'Opportunity',
      recordCount: 1,
      fieldCount: 40,
      status: 'idle',
      progress: 0,
      included: true,
      piiFields: [],
      anonymizeFields: [],
      level: 0,
      successCount: 0,
      failureCount: 0,
      errors: [],
      createableFieldCount: 30,
      estimatedSizeMB: 0.01,
      estimatedApiCalls: 1,
      batchStrategy: 'auto',
    },
  ],
  edges: [],
  totalRecords: 1,
  estimatedSizeMB: 0.01,
  estimatedDurationSeconds: 1,
};

/**
 * A run that muted the target's automation and created two opportunities on
 * Master in the source: read back, they hold another type than the describe
 * said, set by a flow the mute could not silence.
 */
const FORGE_RUN = {
  forgeId: 'forge-record-types',
  status: 'success',
  graph: GRAPH,
  duration: 900,
  timestamp: '2026-11-01T10:16:00.000Z',
  targetOrgId: QA_SANDBOX.id,
  idRemapCount: 2,
  idRemapTable: {},
  createdCount: 2,
  readByObject: [{ objectApiName: 'Opportunity', read: 2 }],
  failedReads: [],
  errors: [],
  truncatedObjects: [],
  mutedAutomation: {
    state: 'muted',
    assigned: ['Bypass_Automation'],
    held: [],
    permissions: ['Bypass_Flows'],
    silenced: [],
    stillRan: [
      {
        objectApiName: 'Opportunity',
        kind: 'flow',
        name: 'Set Opportunity Type',
        why: 'managedPackage',
      },
    ],
    released: true,
  },
  recordTypesGiven: [
    {
      objectApiName: 'Opportunity',
      rows: 2,
      why: { masterInSource: 2 },
      predicted: PREDICTED,
      readBack: {
        read: 2,
        types: [{ developerName: 'SFX_Partner', label: 'SFX Partner', rows: 2 }],
      },
    },
  ],
};

/* ── Frozen Dataset ───────────────────────────────────────────────────── */

/** A frozen dataset ready to load. */
const FROZEN_STATUS = {
  configured: true,
  sasDir: '/home/qa/.sandforge-sas',
  datasetDir: '/home/qa/.sandforge-sas/dataset',
  salt: { present: true, fingerprint: 'abc123def456' },
  mockDetectionConfigured: true,
  selection: null,
  manifest: {
    version: '1.0.0',
    status: 'frozen',
    frozenAt: '2026-11-01T09:00:00.000Z',
    source: { orgId: 'org-src-1', decisionDate: '2026-11-01T08:00:00.000Z' },
    saltFingerprint: 'abc123def456',
    rulesVersion: '1.0.0',
    volumetry: {
      budgetMax: 100,
      measured: { Account: 1, Opportunity: 1 },
      measuredAt: '2026-11-01',
    },
    controls: {
      nonReidentification: { passed: true, checks: [], author: 'qa', checkedAt: '2026-11-01' },
      dryRunLoad: null,
      author: 'qa',
      date: '2026-11-01',
    },
  },
  lastLoad: null,
  lastLoads: [],
  lastVerifies: [],
  loadRecords: [],
};

/** What a load into the QA sandbox would do: one account, one opportunity on Master at the extraction. */
const FROZEN_PLAN = {
  orgId: QA_SANDBOX.id,
  mode: { pilot: false, reload: false },
  plannedAt: '2026-11-01T11:00:00.000Z',
  perObject: ['Account', 'Opportunity'].map((objectApiName) => ({
    objectApiName,
    fromFiles: 1,
    toInsert: 1,
    reusedByKeys: 0,
    reusedFromCatalog: 0,
    fieldsDropped: 0,
    picklistsRewritten: 0,
    notSent: 0,
    toPurge: 0,
    toDeactivate: 0,
  })),
  excludedObjects: [],
  removals: [],
  placeholders: [],
  requiredDefaults: [],
  recordTypeIssues: 0,
  personContacts: 0,
  earlierLoads: 0,
  recordTypesGiven: [
    { objectApiName: 'Opportunity', rows: 1, why: { masterInSource: 1 }, predicted: PREDICTED },
  ],
};

for (const theme of THEMES) {
  test.describe(`The record type the target gives (${theme})`, () => {
    test('a Sync simulation says it beside the object whose records go without one, and passes axe', async ({
      page,
    }) => {
      const bridge = new MockBridge();
      await bridge.setup(page);
      await paintHostTheme(page, theme);
      await page.addInitScript((syncDraft) => {
        const host = window as unknown as {
          acquireVsCodeApi: () => { setState: (state: unknown) => void };
          __SANDFORGE_MODULE__?: string;
        };
        host.acquireVsCodeApi().setState({ syncDraft });
        host.__SANDFORGE_MODULE__ = 'sync';
      }, SYNC_DRAFT);
      await page.goto('/');
      await bridge.seedOrgs(MOCK_ORGS);
      await expect(page.getByTestId('sync-page')).toBeVisible();

      await page.getByTestId('sync-simulate').click();
      await bridge.respondToNext('sync:simulate', 'sync:simulate:response', SYNC_SIMULATION, {
        timeout: 10_000,
      });

      const line = page.getByTestId('sync-simulation-record-type-Opportunity');
      await expect(line).toHaveText(
        `1 Opportunity record to create without a record type, on Master in the source: ` +
          `${PREDICTED_WORDS} — its describe names Master that user's default, yet a record ` +
          'written without one gets this one.',
      );
      // The account carries its type: nothing is said of it.
      await expect(page.getByTestId('sync-simulation-record-type-Account')).toHaveCount(0);
      const results = await checkAccessibility(page);
      expect(results.violations.length, formatViolations(results.violations)).toBe(0);
    });

    test('a Forge result says what the records were read back holding, names what still ran, and passes axe', async ({
      page,
    }) => {
      const bridge = new MockBridge();
      await bridge.setup(page);
      await paintHostTheme(page, theme);
      await page.addInitScript(() => {
        (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'forge';
      });
      await page.goto('/');
      await bridge.seedOrgs();
      await page.waitForSelector('[data-testid="forge-page"]', { timeout: 10_000 });
      await page.getByTestId('forge-tab-soql').click();
      await page.getByTestId('forge-input-soql').fill('SELECT Id FROM Opportunity');
      await page.getByTestId('forge-target-org').click();
      await page.getByTestId(`forge-target-org-option-${QA_SANDBOX.id}`).click();
      await page.getByTestId('forge-discover-btn').click();
      await page.waitForSelector('[data-testid="forge-discovery-loading"]', { timeout: 10_000 });
      await answerAll(page, 'forge:discover', 'forge:discover:response', { graph: GRAPH });
      await page.getByTestId('forge-execute-btn').click();
      await page.getByTestId('execute-button').click();
      await page.waitForSelector('[data-testid="forge-execution"]', { timeout: 10_000 });
      const request = await bridge.waitForMessage('forge:execute', { timeout: 10_000 });

      await sendExtensionMessage(page, {
        type: 'forge:execute:response',
        id: 'run-ended',
        correlationId: String(request.id),
        payload: { result: FORGE_RUN, operationId: 'forge-execute-1' },
      });

      const section = page.getByTestId('forge-results-record-types');
      await expect(
        section.getByRole('heading', { name: 'Record types the target org gave' }),
      ).toBeVisible();
      await expect(section.getByTestId('forge-results-record-types-Opportunity')).toHaveText(
        '2 Opportunity records created without a record type, on Master in the source: read ' +
          'back on 2, 2 with SFX_Partner (SFX Partner), where SFX_Retail (SFX Retail) was ' +
          "predicted. The target org's automation sets the record type, among what still ran " +
          'on Opportunity: Flow: Set Opportunity Type.',
      );
      const results = await checkAccessibility(page);
      expect(results.violations.length, formatViolations(results.violations)).toBe(0);
    });

    test('a Frozen Dataset preview says it before the load, and passes axe', async ({ page }) => {
      const bridge = new MockBridge();
      await bridge.setup(page);
      await paintHostTheme(page, theme);
      await page.addInitScript(() => {
        (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'frozen';
      });
      await page.goto('/');
      await bridge.seedOrgs();
      await page.waitForSelector('[data-testid="frozen-page"]', { timeout: 10_000 });
      await bridge.waitForMessage('frozen:status', { timeout: 10_000 });
      await answerAll(page, 'frozen:status', 'frozen:status:response', { status: FROZEN_STATUS });
      await page.getByTestId('page-tab-load').click();
      await page.getByTestId('frozen-load-target').click();
      await page.getByTestId(`frozen-load-target-option-${QA_SANDBOX.id}`).click();
      await page.getByTestId('frozen-load-preview').click();
      await bridge.waitForMessage('frozen:load:preview', { timeout: 10_000 });
      await answerAll(page, 'frozen:load:preview', 'frozen:load:preview:response', {
        plan: FROZEN_PLAN,
      });

      const section = page.getByTestId('frozen-preview-record-types');
      await expect(
        section.getByRole('heading', { name: 'Record types the target org would give' }),
      ).toBeVisible();
      await expect(section.getByTestId('frozen-preview-record-types-Opportunity')).toContainText(
        `1 Opportunity record to create without a record type, on Master in the source: ${PREDICTED_WORDS}`,
      );
      await expect(section.getByTestId('frozen-preview-record-types-Account')).toHaveCount(0);
      const results = await checkAccessibility(page);
      expect(results.violations.length, formatViolations(results.violations)).toBe(0);
    });

    test('a Frozen Dataset preview says what the emails come to and the box that lets them go, and passes axe', async ({
      page,
    }) => {
      const bridge = new MockBridge();
      await bridge.setup(page);
      await paintHostTheme(page, theme);
      await page.addInitScript(() => {
        (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'frozen';
      });
      await page.goto('/');
      await bridge.seedOrgs();
      await page.waitForSelector('[data-testid="frozen-page"]', { timeout: 10_000 });
      await bridge.waitForMessage('frozen:status', { timeout: 10_000 });
      await answerAll(page, 'frozen:status', 'frozen:status:response', { status: FROZEN_STATUS });
      await page.getByTestId('page-tab-load').click();
      await page.getByTestId('frozen-load-target').click();
      await page.getByTestId(`frozen-load-target-option-${QA_SANDBOX.id}`).click();
      await expect(page.getByTestId('frozen-load-accept-emails')).not.toBeChecked();
      await page.getByTestId('frozen-load-preview').click();
      await bridge.waitForMessage('frozen:load:preview', { timeout: 10_000 });
      await answerAll(page, 'frozen:load:preview', 'frozen:load:preview:response', {
        plan: {
          ...FROZEN_PLAN,
          emails: {
            counted: [
              {
                limit: 'SingleEmail',
                objects: [
                  { objectApiName: 'Contact', rows: 3, perRecord: 2, sentBy: ['Contact welcome'] },
                ],
                emails: 6,
                verdict: 'fits',
                remaining: 15,
                max: 15,
              },
            ],
            verdict: 'asks',
            deliverability: {
              reading: { level: 'all' },
              senders: [
                { objectApiName: 'Contact', kind: 'flow', name: 'Contact welcome', why: 'email' },
              ],
            },
            accepted: false,
            refused: { code: 'EMAILS_NOT_ACCEPTED', message: 'QA delivers every email…' },
          },
        },
      });

      const emails = page.getByTestId('frozen-preview-emails');
      await expect(emails.getByTestId('frozen-preview-emails-verdict')).toContainText(
        'the load would be refused, nothing written, unless you tick',
      );
      await expect(emails.getByTestId('frozen-preview-emails-count-SingleEmail')).toHaveText(
        'Single emails: about 6, with 15 of 15 left today.',
      );
      const results = await checkAccessibility(page);
      expect(results.violations.length, formatViolations(results.violations)).toBe(0);
    });
  });
}
