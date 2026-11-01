import { test, expect, type Page } from '@playwright/test';
import { MockBridge, checkAccessibility, formatViolations } from './helpers';
import { MOCK_ORGS } from './fixtures';
import { VSCODE_DEFAULT_STYLES } from './fixtures/vscode-default-styles';
import { sendExtensionMessage } from './mocks/vscode-api';
import { hostColours, vscodeTheme } from '../src/styles/testing/vscodeThemes';

/**
 * A seed refused for the data storage its org has left, and seeded again at
 * the counts that fit: the card under the refusal says the share, what held
 * it, the room kept for the org's flows, each object's count asked and the
 * one that fits; "Seed these counts" sends the seed again at those counts,
 * saying the fit; the results say the counts were fitted. Scanned with axe
 * in VS Code's default light and dark themes, painted as the host paints a
 * webview, its default stylesheet first: contrast is what the page renders.
 *
 * Sales Cloud Starter takes about 14.9 MB, three times a Developer Edition's
 * 5 MB: a new user who picked it was refused with nothing to do but work the
 * counts out by hand.
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

/**
 * What the extension's fit proposes for Sales Cloud Starter on a Developer
 * Edition that says it has all of its 5 MB left, its accounts' follow-up flow
 * creating a Task under each and an Apex trigger on them: the engine's own
 * output for that case (`modules/seed/seedFit.ts`).
 */
const PROPOSAL = {
  share: 0.226,
  budget: {
    budgetMB: 3.37929630279541,
    remainingMB: 5,
    maxMB: 5,
    share: 0.8,
    roundingMB: 0.5,
    limitedBy: 'storage',
    automationMB: 0.220703125,
    notCounted: [{ objectApiName: 'Account', kind: 'trigger', name: 'AccountTrigger' }],
  },
  objects: [
    { objectApiName: 'Product2', before: 50, after: 11 },
    { objectApiName: 'PricebookEntry', before: 50, after: 11 },
    { objectApiName: 'Account', before: 500, after: 113 },
    { objectApiName: 'Contact', before: 1000, after: 226 },
    { objectApiName: 'Opportunity', before: 2000, after: 452 },
    { objectApiName: 'OpportunityLineItem', before: 4000, after: 904 },
  ],
  estimateMB: 3.57421875,
};

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

/** Answer every pending request of a type: StrictMode can send one twice. */
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

/** The extension refusing the seed `run` for its storage, the counts that fit with it. */
async function refusedForStorage(page: Page, run: string): Promise<void> {
  await sendExtensionMessage(page, {
    type: 'seed:error',
    id: `refusal-${run}`,
    correlationId: run,
    payload: {
      message:
        'The seed was refused before it wrote anything: its records take about 14.9 MB of data storage, and DevSandbox has 5 MB left of 5 MB.',
      code: 'SEED_STORAGE_EXCEEDED',
      retryable: false,
      estimateMB: 14.9,
      remainingMB: 5,
      maxMB: 5,
      org: 'DevSandbox',
      fit: PROPOSAL,
    },
  });
}

/** The Seed page on its gallery, the panel's org connected. */
async function openSeedStart(page: Page, theme: Theme): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await paintHostTheme(page, theme);
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

/** Sales Cloud Starter started from its confirmation, and refused for its storage. */
async function refusedSalesCloud(page: Page, theme: Theme): Promise<MockBridge> {
  const bridge = await openSeedStart(page, theme);
  await page
    .getByTestId('template-card-prebuilt-sales-cloud-starter')
    .getByTestId('btn-use-template')
    .click();
  await expect(page.getByTestId('quick-seed-confirm')).toBeVisible();
  await expect(page.getByTestId('quick-seed-org-selector')).toHaveValue('org-src-1');
  await page.getByTestId('btn-quick-seed-start').click();
  const request = await bridge.waitForMessage('seed:execute', { timeout: 10_000 });
  await refusedForStorage(page, String(request.id));
  return bridge;
}

for (const theme of THEMES) {
  test.describe(`a seed refused for its storage, and the counts that fit (${theme})`, () => {
    test('says what fits under the refusal, and passes axe', async ({ page }) => {
      await refusedSalesCloud(page, theme);

      const card = page.getByRole('region', { name: 'What fits in DevSandbox' });
      await expect(card).toBeVisible();
      await expect(page.getByTestId('quick-seed-error')).toContainText(
        'its records take about 14.9 MB of data storage',
      );
      await expect(card.getByTestId('quick-seed-fit-share')).toHaveText(
        'The largest share of every count that fits: 22.6%. Each child keeps no more records than the parents kept can hold.',
      );
      await expect(card.getByTestId('quick-seed-fit-bound')).toHaveText(
        '3.6 MB fit: 80% of the 5 MB DevSandbox says it has left of 5 MB, once 0.5 MB is set aside for the rounding of what it says.',
      );
      await expect(card.getByTestId('quick-seed-fit-room')).toHaveText(
        '0.23 MB of it is kept for what the flows of DevSandbox that still run create under these records.',
      );
      await expect(card.getByTestId('quick-seed-fit-not-counted')).toHaveText(
        'Not counted: what the Apex trigger AccountTrigger on Account creates.',
      );
      await expect(card.getByTestId('quick-seed-fit-object-Account')).toHaveText('Account500113');
      await expect(card.getByTestId('quick-seed-fit-total')).toHaveText(
        '1,717 of 7,600 records, about 3.58 MB with what the flows create under them.',
      );
      await expect(card.getByRole('button', { name: 'Seed these counts' })).toBeVisible();

      const results = await checkAccessibility(page);
      expect(results.violations.length, formatViolations(results.violations)).toBe(0);
    });
  });
}

test('seeds the counts that fit at one click, says the fit in the request, and says it in the results', async ({
  page,
}) => {
  const bridge = await refusedSalesCloud(page, 'Dark 2026');
  expect(await outgoing(page, 'seed:execute')).toHaveLength(1);

  await page.getByRole('button', { name: 'Seed these counts' }).click();

  await expect.poll(async () => (await outgoing(page, 'seed:execute')).length).toBe(2);
  const [, fitted] = await outgoing(page, 'seed:execute');
  const payload = fitted.payload as {
    orgId: string;
    template: { id: string; objects: Array<{ objectApiName: string; recordCount: number }> };
    fit: unknown;
  };
  expect(payload.orgId).toBe('org-src-1');
  expect(payload.template.id).toBe('prebuilt-sales-cloud-starter');
  expect(payload.template.objects.map((o) => [o.objectApiName, o.recordCount])).toEqual(
    PROPOSAL.objects.map((o) => [o.objectApiName, o.after]),
  );
  expect(payload.fit).toEqual({ share: 0.226, before: 7600 });
  // The refusal no longer stands over the run sent again.
  await expect(page.getByTestId('quick-seed-error')).toHaveCount(0);

  const run = String(fitted.id);
  await bridge.stream([
    {
      type: 'operation:progress',
      payload: {
        operationId: run,
        percentage: 10,
        processedRecords: 11,
        totalRecords: 1717,
        currentStep: 'Insert Product2',
      },
    },
  ]);
  await expect(page.getByTestId('quick-seed-fit')).toHaveCount(0);

  await sendExtensionMessage(page, {
    type: 'seed:execute:response',
    id: `resp-${run}`,
    correlationId: run,
    payload: {
      templateId: 'prebuilt-sales-cloud-starter',
      operationId: run,
      status: 'success',
      objectResults: PROPOSAL.objects.map((o) => ({
        objectApiName: o.objectApiName,
        recordsCreated: o.after,
        recordsFailed: 0,
        createdIds: [],
        errors: [],
      })),
      totalRecordsCreated: 1717,
      totalRecordsFailed: 0,
      duration: 4_000,
      timestamp: '2026-11-01T08:00:00.000Z',
    },
  });
  await expect(page.getByTestId('quick-seed-results')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('quick-seed-result-fitted')).toHaveText(
    'Counts fitted to the data storage of DevSandbox: 1,717 of the 7,600 records the template asked for, 22.6% of every count.',
  );

  // Seed again comes back to the counts that fit, to start them again by hand.
  await page.getByTestId('btn-seed-again-quick').click();
  await expect(page.getByTestId('quick-seed-count-Account')).toHaveValue('113');
});

/** The two objects of the wizard's run, as a sandbox describes their required fields. */
const DESCRIBES: Record<string, Record<string, unknown>[]> = {
  Account: [
    {
      fieldApiName: 'Name',
      label: 'Name',
      type: 'string',
      required: true,
      picklistValues: [],
      referenceTo: [],
      length: 255,
    },
  ],
  Contact: [
    {
      fieldApiName: 'LastName',
      label: 'LastName',
      type: 'string',
      required: true,
      picklistValues: [],
      referenceTo: [],
      length: 80,
    },
  ],
};

/** What the extension's fit proposes for 100 accounts and 100 contacts on an org with 1 MB left. */
const WIZARD_PROPOSAL = {
  share: 0.4,
  budget: {
    budgetMB: 0.4,
    remainingMB: 1,
    maxMB: 5,
    share: 0.8,
    roundingMB: 0.5,
    limitedBy: 'storage',
    automationMB: 0,
  },
  objects: [
    { objectApiName: 'Account', before: 100, after: 40 },
    { objectApiName: 'Contact', before: 100, after: 40 },
  ],
  estimateMB: 0.15625,
};

test('the wizard shows the counts that fit on the step its run was refused on, seeds them, and its results say so', async ({
  page,
}) => {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await paintHostTheme(page, 'Light 2026');
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'seed';
  });
  await page.goto('/');
  await bridge.seedOrgs(MOCK_ORGS);
  await page.getByTestId('mode-card-generate').click();
  await page.getByTestId('org-selector').selectOption('org-src-1');
  await bridge.waitForMessage('seed:describe-global', { timeout: 10_000 });
  await respondToAll(page, 'seed:describe-global', 'seed:describe-global:response', {
    objects: Object.keys(DESCRIBES).map((apiName) => ({
      apiName,
      label: apiName,
      recordCount: 0,
      dependencies: [],
    })),
  });
  for (const apiName of Object.keys(DESCRIBES)) {
    await page.getByTestId(`obj-${apiName}`).click();
  }
  await page.getByTestId('seed-wizard-next').click();
  await expect(page.getByTestId('seed-step-execute-content')).toBeVisible();
  // The describes, answered until the step says which rules the run uses.
  const answered = new Set<string>();
  await expect
    .poll(
      async () => {
        for (const request of await outgoing(page, 'seed:describe-object')) {
          const id = String(request.id);
          if (answered.has(id)) continue;
          answered.add(id);
          const objectApiName = String((request.payload as Record<string, unknown>).objectApiName);
          await sendExtensionMessage(page, {
            type: 'seed:describe-object:response',
            id: `resp-${id}`,
            correlationId: id,
            payload: {
              objectApiName,
              objectLabel: objectApiName,
              fields: DESCRIBES[objectApiName],
            },
          });
        }
        return page.getByTestId('seed-fields-status').textContent();
      },
      { timeout: 10_000 },
    )
    .toBe('Using default field rules.');
  await page.getByTestId('seed-wizard-next').click();
  await page.getByTestId('seed-wizard-finish').click();
  const refused = await bridge.waitForMessage('seed:execute', { timeout: 10_000 });
  await sendExtensionMessage(page, {
    type: 'seed:error',
    id: 'refusal',
    correlationId: String(refused.id),
    payload: {
      message: 'The seed was refused before it wrote anything.',
      code: 'SEED_STORAGE_EXCEEDED',
      retryable: false,
      estimateMB: 0.4,
      remainingMB: 1,
      maxMB: 5,
      org: 'DevSandbox',
      fit: WIZARD_PROPOSAL,
    },
  });

  const card = page.getByRole('region', { name: 'What fits in DevSandbox' });
  await expect(card.getByTestId('seed-fit-object-Contact')).toHaveText('Contact10040');
  const results = await checkAccessibility(page);
  expect(results.violations.length, formatViolations(results.violations)).toBe(0);

  await card.getByRole('button', { name: 'Seed these counts' }).click();
  await expect.poll(async () => (await outgoing(page, 'seed:execute')).length).toBe(2);
  const [, fitted] = await outgoing(page, 'seed:execute');
  const payload = fitted.payload as {
    template: { objects: Array<{ objectApiName: string; recordCount: number }> };
    fit: unknown;
  };
  expect(payload.template.objects.map((o) => [o.objectApiName, o.recordCount])).toEqual([
    ['Account', 40],
    ['Contact', 40],
  ]);
  expect(payload.fit).toEqual({ share: 0.4, before: 200 });

  const run = String(fitted.id);
  await sendExtensionMessage(page, {
    type: 'seed:execute:response',
    id: `resp-${run}`,
    correlationId: run,
    payload: {
      templateId: 'seed-from-ui',
      operationId: run,
      status: 'success',
      objectResults: [
        {
          objectApiName: 'Account',
          recordsCreated: 40,
          recordsFailed: 0,
          createdIds: [],
          errors: [],
        },
        {
          objectApiName: 'Contact',
          recordsCreated: 40,
          recordsFailed: 0,
          createdIds: [],
          errors: [],
        },
      ],
      totalRecordsCreated: 80,
      totalRecordsFailed: 0,
      duration: 1_000,
      timestamp: '2026-11-01T08:00:00.000Z',
    },
  });
  await expect(page.getByTestId('seed-results-fitted')).toHaveText(
    'Counts fitted to the data storage of DevSandbox: 80 of the 200 records the template asked for, 40% of every count.',
  );
});

test('goes back from the counts that fit to the confirmation, to set them by hand', async ({
  page,
}) => {
  await refusedSalesCloud(page, 'Light 2026');

  await page.getByRole('button', { name: 'Change the counts' }).click();

  await expect(page.getByTestId('quick-seed-confirm')).toBeVisible();
  await expect(page.getByTestId('quick-seed-count-Account')).toHaveValue('500');
  expect(await outgoing(page, 'seed:execute')).toHaveLength(1);
});
