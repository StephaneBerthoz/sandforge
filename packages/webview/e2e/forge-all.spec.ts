import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MockBridge, checkAccessibility, formatViolations } from './helpers';
import { DEV_SANDBOX, QA_SANDBOX } from './fixtures';
import { VSCODE_DEFAULT_STYLES } from './fixtures/vscode-default-styles';
import { sendExtensionMessage } from './mocks/vscode-api';
import { hostColours, vscodeTheme } from '../src/styles/testing/vscodeThemes';
import { wholeOrgDryRun, wholeOrgGraph } from '../src/pages/Forge/testing/wholeOrg';
import { scopeAnswer } from '../src/pages/DataOps/empty/testing/emptyAnswers';

/**
 * The ALL depth: a clone of the whole source org, from the chip to its
 * results. Its prudent defaults — no Clone directly, no file unless ticked,
 * Anonymize PII on for a source that holds real people's data —, its Review —
 * the personal fields it copies as they are, what the target holds already,
 * what it leaves out —, its dry run that stops at the gate, its run, and each
 * refusal of its gate in the user's words. Scanned with axe under VS Code's
 * default themes and the two they replaced, painted as the host paints a
 * webview, as the page scans are.
 */
const THEMES = ['Light 2026', 'Dark 2026', 'Light Modern', 'Dark Modern'] as const;
type Theme = (typeof THEMES)[number];

/** A production org, as a source a clone of the whole org takes real people's data from. */
const PRODUCTION = {
  ...DEV_SANDBOX,
  id: 'org-prod-1',
  alias: 'Production',
  username: 'admin@prod.example.invalid',
  orgType: 'Production',
};

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

/** The messages the page posted of `type`, their payloads. */
async function sentPayloads(page: Page, type: string): Promise<Array<Record<string, unknown>>> {
  return page.evaluate((wanted) => {
    const posted = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
    return posted
      .map((m) => ((m as Record<string, unknown>).payload ?? m) as Record<string, unknown>)
      .filter((m) => m.type === wanted)
      .map((m) => (m.payload ?? {}) as Record<string, unknown>);
  }, type);
}

/** The Forge page, its orgs listed, with ALL picked and the target set. */
async function openAll(
  page: Page,
  theme: Theme,
  source: { id: string } = DEV_SANDBOX,
): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await paintHostTheme(page, theme);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'forge';
  });
  await page.goto('/');
  await bridge.seedOrgs([DEV_SANDBOX, QA_SANDBOX, PRODUCTION]);
  await page.waitForSelector('[data-testid="forge-page"]', { timeout: 10_000 });
  await page.getByTestId('forge-source-org').click();
  await page.getByTestId(`forge-source-org-option-${source.id}`).click();
  await page.getByTestId('forge-target-org').click();
  await page.getByTestId(`forge-target-org-option-${QA_SANDBOX.id}`).click();
  await page.getByTestId('forge-depth-all').click();
  return bridge;
}

/** Discover the whole org, up to its Review, the target's records answered. */
async function openReview(page: Page, theme: Theme): Promise<MockBridge> {
  const bridge = await openAll(page, theme);
  await page.getByTestId('forge-discover-btn').click();
  await page.waitForSelector('[data-testid="forge-discovery-loading"]', { timeout: 10_000 });
  await answerAll(page, 'forge:discover', 'forge:discover:response', { graph: wholeOrgGraph() });
  await expect(page.getByTestId('forge-discovery-summary')).toBeVisible();
  await page.getByTestId('forge-execute-btn').click();
  await expect(page.getByTestId('forge-review')).toBeVisible();
  await expect.poll(() => sentPayloads(page, 'forge:target-records:request')).not.toEqual([]);
  await answerAll(page, 'forge:target-records:request', 'forge:target-records:response', {
    targetOrgId: QA_SANDBOX.id,
    objects: [
      { objectApiName: 'Contact', records: 1_500 },
      { objectApiName: 'Account', records: 20 },
    ],
  });
  return bridge;
}

/** Start the run of the whole org from Review; the run's request id. */
async function startRun(page: Page, bridge: MockBridge, simulate = false): Promise<string> {
  await page.getByTestId(simulate ? 'simulate-button' : 'execute-button').click();
  await page.waitForSelector('[data-testid="forge-execution"]', { timeout: 10_000 });
  const request = await bridge.waitForMessage('forge:execute', { timeout: 10_000 });
  return String(request.id);
}

for (const theme of THEMES) {
  test.describe(`a clone of the whole org (${theme})`, () => {
    test('the ALL chip greys what does not apply, offers no Clone directly, and passes axe', async ({
      page,
    }) => {
      await openAll(page, theme);

      await expect(page.getByTestId('forge-depth-all')).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByTestId('forge-depth-all-hint')).toContainText(
        'Files are copied only if you tick them on Review.',
      );
      await expect(page.getByTestId('forge-tab-soql')).toBeDisabled();
      await expect(page.getByTestId('forge-input-all-note')).toBeVisible();
      await expect(page.getByTestId('forge-max-nodes')).toBeDisabled();
      await expect(page.getByTestId('forge-record-limit')).toBeDisabled();
      await expect(page.getByTestId('forge-clone-directly-btn')).toBeDisabled();
      await expect(page.getByTestId('forge-discover-btn')).toBeEnabled();
      const results = await checkAccessibility(page);
      expect(results.violations.length, formatViolations(results.violations)).toBe(0);
    });

    test('Review says what goes as it is and what the target holds, offers no rehearsal, and passes axe', async ({
      page,
    }) => {
      await openReview(page, theme);

      await expect(page.getByTestId('review-sentence')).toContainText(
        'Copy the whole of DevSandbox into QASandbox',
      );
      await expect(page.getByTestId('review-personal-as-is')).toContainText(
        '5 personal fields, on 3 objects',
      );
      await expect(page.getByTestId('review-target-holds-some')).toContainText(
        'QASandbox already holds about 1,520 records of 2 of these objects.',
      );
      await expect(page.getByTestId('review-target-holds-empty-first')).toContainText(
        'DataOps → Cleanup → Empty objects',
      );
      await expect(page.getByTestId('rehearse-button')).toBeDisabled();
      await expect(page.getByTestId('simulate-button')).toBeEnabled();
      await expect(page.getByTestId('forge-all-simulation')).toBeVisible();
      const review = await checkAccessibility(page);
      expect(review.violations.length, formatViolations(review.violations)).toBe(0);

      // The objects it leaves out, by why, once the Plan row and its list are opened.
      await page.getByTestId('tab-plan').click();
      await page.getByTestId('review-left-out-toggle').click();
      await expect(page.getByTestId('review-left-out-platformCreated')).toContainText(
        'ProcessInstance',
      );
      await expect(page.getByTestId('forge-view-graph-slow')).toBeVisible();
      const plan = await checkAccessibility(page);
      expect(plan.violations.length, formatViolations(plan.violations)).toBe(0);
    });

    test('its dry run stops at the gate, its results say what the run would meet, and pass axe', async ({
      page,
    }) => {
      const bridge = await openReview(page, theme);
      const run = await startRun(page, bridge, true);

      await sendExtensionMessage(page, {
        type: 'forge:execute:response',
        id: 'dry',
        correlationId: run,
        payload: {
          result: {
            forgeId: 'forge-dry',
            status: 'failure',
            graph: wholeOrgGraph(),
            duration: 2_000,
            timestamp: '2026-11-13T10:00:00.000Z',
            idRemapCount: 0,
            createdCount: 0,
            dryRun: true,
            wouldInsertCount: 9_400,
          },
          operationId: 'forge-execute-1',
          wholeOrgDryRun: wholeOrgDryRun(),
        },
      });

      await expect(page.getByTestId('forge-whole-org-dry-run')).toBeVisible();
      await expect(page.getByTestId('forge-whole-org-dry-run-verdict')).toContainText(
        'The run would be refused, for 2 reasons:',
      );
      await expect(page.getByTestId('forge-whole-org-dry-run-refusals')).toContainText(
        'its Bulk API jobs would take about 16,000 batches of the target org',
      );
      await expect(page.getByTestId('forge-whole-org-dry-run-source-requests')).toHaveText(
        'about 120,000, past the 4,000 left today out of 150,000',
      );
      const results = await checkAccessibility(page);
      expect(results.violations.length, formatViolations(results.violations)).toBe(0);
    });
  });
}

test('a production source turns Anonymize PII on as ALL is picked, and the run carries it with no file', async ({
  page,
}) => {
  await openAll(page, 'Dark 2026', PRODUCTION);

  await expect(page.getByTestId('forge-anonymize-toggle')).toBeChecked();
  await expect(page.getByTestId('forge-all-real-data')).toContainText(
    'Production holds real people’s data',
  );
  await page.getByTestId('forge-discover-btn').click();
  const [discover] = await sentPayloads(page, 'forge:discover');
  expect(discover.config).toMatchObject({
    inputMode: 'org',
    depth: 'all',
    anonymizePII: true,
    expandOrphanParents: false,
  });
  expect((discover.config as Record<string, unknown>).maxNodes).toBeUndefined();
  expect((discover.config as Record<string, unknown>).maxRecordsPerObject).toBeUndefined();
});

test('a run of the whole org goes from Review with no file and no Clone directly, and shows its results', async ({
  page,
}) => {
  const bridge = await openReview(page, 'Light 2026');
  const run = await startRun(page, bridge);

  const [execute] = await sentPayloads(page, 'forge:execute');
  expect(execute.config).toMatchObject({ inputMode: 'org', depth: 'all' });
  expect(execute).not.toHaveProperty('files');
  expect(execute).not.toHaveProperty('reviewSkipped');

  await sendExtensionMessage(page, {
    type: 'forge:execute:response',
    id: 'done',
    correlationId: run,
    payload: {
      result: {
        forgeId: 'forge-all',
        status: 'success',
        graph: wholeOrgGraph(),
        duration: 60_000,
        timestamp: '2026-11-13T10:00:00.000Z',
        idRemapCount: 9_400,
        createdCount: 9_400,
      },
      operationId: 'forge-execute-1',
    },
  });

  await expect(page.getByTestId('forge-results')).toBeVisible();
  await expect(page.getByTestId('forge-whole-org-dry-run')).toHaveCount(0);
});

test('Empty these objects first opens DataOps on Cleanup for the target, the objects it holds picked', async ({
  page,
}) => {
  const bridge = await openReview(page, 'Light Modern');

  await page.getByTestId('review-target-holds-empty-first-btn').click();

  await expect(page.getByTestId('dataops-page')).toBeVisible();
  await expect(page.getByTestId('page-tab-cleanup')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('empty-panel').waitFor();
  await bridge.waitForMessage('dataops:empty:scope', { timeout: 10_000 });
  await answerAll(page, 'dataops:empty:scope', 'dataops:empty:scope:response', scopeAnswer());
  await expect(page.getByTestId('empty-pick-option-Contact')).toBeChecked();
  await expect(page.getByTestId('empty-pick-option-Account')).toBeChecked();
  await expect(page.getByTestId('empty-pick-option-Case')).not.toBeChecked();
  const [selected] = (await sentPayloads(page, 'org:select')).slice(-1);
  expect(selected).toEqual({ orgId: QA_SANDBOX.id });
});

/** Each refusal of the gate of a clone of the whole org, and what Review says of it. */
const REFUSALS: Array<{ name: string; gate: Record<string, unknown>; says: string }> = [
  {
    name: 'its files past the file storage left',
    gate: {
      code: 'STORAGE_EXCEEDED',
      storage: { estimateMB: 2_048, remainingMB: 900, kind: 'files' },
    },
    says: 'the files it copies take about 2,048 MB of file storage, and the target org has 900 MB left.',
  },
  {
    name: 'its records past the data storage left',
    gate: { code: 'STORAGE_EXCEEDED', storage: { estimateMB: 3_500, remainingMB: 1_000 } },
    says: 'the records of the whole org take about 3,500 MB of data storage',
  },
  {
    name: "its reads past the source's requests",
    gate: {
      code: 'API_BUDGET_EXCEEDED',
      api: { kind: 'requests', org: 'source', estimate: 120_000, remaining: 4_000 },
    },
    says: 'reading the source org would take about 120,000 of its API requests',
  },
  {
    name: "its writes past the target's requests",
    gate: {
      code: 'API_BUDGET_EXCEEDED',
      api: { kind: 'requests', org: 'target', estimate: 60_000, remaining: 5_000 },
    },
    says: 'it would take about 60,000 API requests of the target org, which has 5,000 left today.',
  },
  {
    name: "its jobs past the target's Bulk API batches",
    gate: {
      code: 'API_BUDGET_EXCEEDED',
      api: { kind: 'bulkBatches', org: 'target', estimate: 16_000, remaining: 2_000 },
    },
    says: 'its Bulk API jobs would take about 16,000 batches of the target org',
  },
  {
    name: 'objects read whole past their bound',
    gate: {
      code: 'READ_BOUND_EXCEEDED',
      readBound: { bound: 50_000, objects: [{ objectApiName: 'PricebookEntry', rows: 72_000 }] },
    },
    says: 'were found in PricebookEntry.',
  },
  {
    name: 'files the source would not weigh',
    gate: { code: 'FILES_UNREAD' },
    says: 'the source org would neither sum nor list its files',
  },
  {
    name: 'a file storage the target would not tell',
    gate: { code: 'FILE_STORAGE_UNREAD' },
    says: 'the target org would not say what file storage it has left',
  },
];

for (const refusal of REFUSALS) {
  test(`a run refused for ${refusal.name} comes back to Review, which says it in its words`, async ({
    page,
  }) => {
    const bridge = await openReview(page, 'Dark Modern');
    const run = await startRun(page, bridge);

    await sendExtensionMessage(page, {
      type: 'forge:execute:error',
      id: 'gate-stop',
      correlationId: run,
      payload: {
        message: 'The host says it in English.',
        code: refusal.gate.code,
        retryable: true,
        gate: refusal.gate,
      },
    });

    await expect(page.getByTestId('forge-review')).toBeVisible();
    await expect(page.getByTestId('forge-run-gate-reason')).toContainText(refusal.says);
    await expect(page.getByTestId('forge-run-gate-reason')).not.toContainText(
      'The host says it in English.',
    );
  });
}
