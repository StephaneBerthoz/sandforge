import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MockBridge, checkAccessibility, formatViolations } from './helpers';
import { DEV_SANDBOX, MOCK_ORGS, QA_SANDBOX } from './fixtures';
import { VSCODE_DEFAULT_STYLES } from './fixtures/vscode-default-styles';
import { sendExtensionMessage } from './mocks/vscode-api';
import { hostColours, vscodeTheme } from '../src/styles/testing/vscodeThemes';

/**
 * What the pages say of the emails of a run before it writes, and when it is
 * refused for them once its lease is read back: Forge's Review and Sync's
 * Simulate say whether the target delivers them, who sends and that the run
 * reads the org again; a run its lease left a sender running is refused in the
 * interface language, on a key its page loaded. Scanned with axe in VS Code's
 * default light and dark themes, painted as the host paints a webview.
 */
const THEMES = ['Light 2026', 'Dark 2026'] as const;
type Theme = (typeof THEMES)[number];

/** The target org, as the pages name it. */
const TARGET = QA_SANDBOX.alias;

/** What the host says of a run its lease left a sender running, in English, with its flag. */
const AFTER_THE_LEASE =
  "The mute's lease does not hold every permission set it was to assign. Nothing was written. Add --accept-emails to sync all the same, or run it again once the lease can assign them.";

const FR_BUNDLE = JSON.parse(
  readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/i18n/locales/fr.json'),
    'utf8',
  ),
) as { errors: { emailsNotAccepted: { explanation: string; action: string } } };

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

/** The page as it is painted now passes axe. */
async function expectAxeClean(page: Page): Promise<void> {
  const results = await checkAccessibility(page);
  expect(results.violations.length, formatViolations(results.violations)).toBe(0);
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

/** A contact, as a Forge discovery answers with it. */
const GRAPH = {
  nodes: [
    {
      objectApiName: 'Contact',
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
  ],
  edges: [],
  totalRecords: 1,
  estimatedSizeMB: 0.01,
  estimatedDurationSeconds: 1,
};

/** A flow after a contact is created, with an email, quiet for whoever holds `bypass`. */
function sendingFlow(label: string, bypass?: string): Record<string, unknown> {
  return {
    apiName: label.split(' ').join('_'),
    label,
    timing: 'afterSave',
    startsOn: 'create',
    condition: 'read',
    permissions: bypass ? [{ name: bypass, bypass: true, held: false }] : [],
    messages: [{ kind: 'email', name: 'Tell them', limit: 'SingleEmail' }],
  };
}

/** What the target runs on the contact the run writes, and whether it delivers its emails. */
function automationSending(deliverability: Record<string, unknown>): Record<string, unknown> {
  return {
    objectsRead: ['Contact'],
    objects: [
      {
        objectApiName: 'Contact',
        flows: [sendingFlow('Welcome email'), sendingFlow('Survey email', 'Skip_Flows')],
        triggers: [],
      },
    ],
    bypassGrants: [
      {
        permission: 'Skip_Flows',
        permissionSets: [{ name: 'Skip_Set', label: 'Skip', grants: 1 }],
      },
    ],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 25,
    requests: 3,
    deliverability,
  };
}

/** Run a clone of the contact from the SOQL tab to Review's Automation tab. */
async function openReviewAutomation(page: Page, theme: Theme): Promise<void> {
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
  await page.getByTestId('forge-input-soql').fill('SELECT Id FROM Contact');
  await page.getByTestId('forge-target-org').click();
  await page.getByTestId(`forge-target-org-option-${QA_SANDBOX.id}`).click();
  await page.getByTestId('forge-discover-btn').click();
  await page.waitForSelector('[data-testid="forge-discovery-loading"]', { timeout: 10_000 });
  await answerAll(page, 'forge:discover', 'forge:discover:response', { graph: GRAPH });
  await page.getByTestId('forge-execute-btn').click();
  await page.getByTestId('forge-review').waitFor({ timeout: 10_000 });
  await bridge.waitForMessage('forge:automation:request', { timeout: 10_000 });
  await page.getByTestId('tab-automation').click();
}

/** Boot the Sync panel on a draft ready to simulate or run, the way it reopens on one. */
async function openSync(page: Page, theme: Theme | undefined): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  if (theme) await paintHostTheme(page, theme);
  await page.addInitScript(
    (syncDraft) => {
      const host = window as unknown as {
        acquireVsCodeApi: () => { setState: (state: unknown) => void };
        __SANDFORGE_MODULE__?: string;
      };
      host.acquireVsCodeApi().setState({ syncDraft });
      host.__SANDFORGE_MODULE__ = 'sync';
    },
    {
      currentStep: 4,
      direction: 'source_to_target',
      mode: 'full',
      conflictStrategy: 'source_wins',
      sourceOrgId: DEV_SANDBOX.id,
      targetOrgId: QA_SANDBOX.id,
      objectEntries: [
        {
          objectApiName: 'Contact',
          operation: 'insert',
          externalIdField: '',
          batchSize: 200,
          where: '',
        },
      ],
      mappingsByObject: {},
      transforms: [],
    },
  );
  await page.goto('/');
  return bridge;
}

/** What the extension answers a simulation with, whose target reads as `deliverability` says. */
function simulationSending(deliverability: Record<string, unknown>): Record<string, unknown> {
  return {
    configId: 'cfg-e2e',
    operationId: 'sim-e2e',
    direction: 'source_to_target',
    conflictStrategy: 'source_wins',
    objects: [
      {
        objectApiName: 'Contact',
        operation: 'insert',
        read: 3,
        insert: 3,
        update: 0,
        delete: 0,
        skipped: 0,
        refused: 0,
        conflicts: 0,
        conflictFields: [],
        notes: [],
      },
    ],
    writeCheck: {
      objects: [{ objectApiName: 'Contact', rows: 3 }],
      total: 3,
      alreadyCopied: 0,
      storage: { verdict: 'fits', estimateMB: 0.01, maxMB: 5, remainingMB: 4 },
      emails: [],
      deliverability,
      verdict: 'asks',
    },
    duration: 840,
    timestamp: '2026-10-06T09:00:00.000Z',
  };
}

for (const theme of THEMES) {
  test.describe(`The emails of a run, before it writes (${theme})`, () => {
    test.describe.configure({ timeout: 120_000 });

    test('Review says the target delivers them, who sends, and that the run reads it again; a mute takes what it quiets off the list', async ({
      page,
    }) => {
      await openReviewAutomation(page, theme);
      await answerAll(page, 'forge:automation:request', 'forge:automation:response', {
        automation: automationSending({ level: 'all' }),
      });

      const reading = page.getByTestId('automation-deliverability-reading');
      await expect(reading).toContainText(`${TARGET} delivers every email`);
      await expect(reading).toContainText('Flow “Welcome email” on Contact');
      await expect(reading).toContainText('Flow “Survey email” on Contact');
      await expect(page.getByTestId('automation-deliverability-addresses')).toContainText(
        `the records already in ${TARGET}`,
      );
      await expect(page.getByTestId('automation-deliverability-read-again')).toHaveText(
        `The run reads ${TARGET} again just before it writes, and asks first if they would go out.`,
      );
      await expectAxeClean(page);

      await page.getByTestId('automation-mute-toggle').check();
      await expect(reading).toContainText('Flow “Welcome email” on Contact');
      await expect(reading).not.toContainText('Survey email');
      await expectAxeClean(page);
    });

    test('Review says a target that withholds them lets none out, and one that would not say why, as the read again finds them', async ({
      page,
    }) => {
      await openReviewAutomation(page, theme);
      await answerAll(page, 'forge:automation:request', 'forge:automation:response', {
        automation: automationSending({ level: 'withheld' }),
      });

      const reading = page.getByTestId('automation-deliverability-reading');
      await expect(reading).toContainText(`${TARGET} delivers none of the emails`);
      await expect(page.getByTestId('automation-deliverability-addresses')).toHaveCount(0);
      await expectAxeClean(page);

      await page.getByTestId('automation-read-again').click();
      await answerAll(page, 'forge:automation:request', 'forge:automation:response', {
        automation: automationSending({ unread: 'the org answered nothing' }),
      });
      await expect(reading).toContainText('could not be read (the org answered nothing)');
      await expectAxeClean(page);
    });

    test('Sync’s simulation says the same in its results, and passes axe', async ({ page }) => {
      const bridge = await openSync(page, theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await expect(page.getByTestId('sync-page')).toBeVisible();
      await page.getByTestId('sync-simulate').click();
      await bridge.waitForMessage('sync:simulate', { timeout: 10_000 });
      await bridge.respond(
        'sync:simulate:response',
        simulationSending({
          reading: { level: 'all' },
          senders: [
            { objectApiName: 'Contact', kind: 'flow', name: 'Welcome email', why: 'email' },
          ],
        }),
      );

      await expect(page.getByTestId('sync-simulation-deliverability-reading')).toContainText(
        `${TARGET} delivers every email`,
      );
      await expect(page.getByTestId('sync-simulation-deliverability-reading')).toContainText(
        'Flow “Welcome email” on Contact',
      );
      await expect(page.getByTestId('sync-simulation-deliverability-read-again')).toBeVisible();
      await expectAxeClean(page);
    });

    test('a Sync run its lease left a sender running says so in the page’s words, with no flag, and passes axe', async ({
      page,
    }) => {
      const bridge = await openSync(page, theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await expect(page.getByTestId('sync-page')).toBeVisible();
      await page.getByTestId('sync-run').click();
      const run = await bridge.waitForMessage('sync:execute', { timeout: 10_000 });

      await sendExtensionMessage(page, {
        type: 'sync:error',
        id: 'sync-refused',
        correlationId: String(run.id),
        payload: { message: AFTER_THE_LEASE, code: 'EMAILS_NOT_ACCEPTED', retryable: false },
      });

      const error = page.getByTestId('sync-error');
      await expect(error).toContainText('nobody accepted them');
      await expect(error).not.toContainText('--accept-emails');
      // Its words are all it says: no hint under it says them a second time.
      await expect(page.getByTestId('error-hint')).toHaveCount(0);
      await expectAxeClean(page);
    });
  });
}

test.describe('The emails of a run, in the interface language', () => {
  test.use({ locale: 'fr-FR' });

  test('a Sync run its lease left a sender running says so in French, on a key its page loaded', async ({
    page,
  }) => {
    const bridge = await openSync(page, undefined);
    await bridge.respondToNext(
      'i18n:locale',
      'i18n:locale:response',
      { lng: 'fr', bundle: FR_BUNDLE },
      { timeout: 10_000 },
    );
    await bridge.seedOrgs(MOCK_ORGS);
    await expect(page.getByTestId('sync-page')).toBeVisible();
    await page.getByTestId('sync-run').click();
    const run = await bridge.waitForMessage('sync:execute', { timeout: 10_000 });

    await sendExtensionMessage(page, {
      type: 'sync:error',
      id: 'sync-refused',
      correlationId: String(run.id),
      payload: { message: AFTER_THE_LEASE, code: 'EMAILS_NOT_ACCEPTED', retryable: false },
    });

    const { explanation, action } = FR_BUNDLE.errors.emailsNotAccepted;
    await expect(page.getByTestId('sync-error')).toContainText(`${explanation} ${action}`);
  });
});
