import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MockBridge, checkAccessibility, formatViolations } from './helpers';
import { DEV_SANDBOX, QA_SANDBOX } from './fixtures';
import { VSCODE_DEFAULT_STYLES } from './fixtures/vscode-default-styles';
import { sendExtensionMessage } from './mocks/vscode-api';
import { hostColours, vscodeTheme } from '../src/styles/testing/vscodeThemes';
import {
  sampleBudget,
  sampleBudgetTerms,
  wholeOrgDryRun,
  wholeOrgGraph,
  wholeOrgSample,
  wholeOrgSampleResult,
} from '../src/pages/Forge/testing/wholeOrg';

/**
 * A sample of the whole org that fits the target, from the ALL chip to its
 * results: the choice of every record or a sample under Records per object,
 * Review's read of what the target has left and of what drawing it costs,
 * its settings, the simulation that says what it drew, the drawing's
 * progress before the gate, the results of the run against its plan, and
 * what a refusal offers to do — simulate again, or take the sample that
 * fits. Scanned with axe under VS Code's two default themes, painted as the
 * host paints a webview.
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

/** The ids of the requests of `type` the page posted, in order. */
async function requestIds(page: Page, type: string): Promise<string[]> {
  return page.evaluate((wanted) => {
    const posted = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
    return posted
      .map((m) => ((m as Record<string, unknown>).payload ?? m) as Record<string, unknown>)
      .filter((m) => m.type === wanted)
      .map((m) => String(m.id));
  }, type);
}

/** Answer every pending request of a type: StrictMode can send one twice. */
async function answerAll(
  page: Page,
  requestType: string,
  responseType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  for (const correlationId of await requestIds(page, requestType)) {
    await sendExtensionMessage(page, {
      type: responseType,
      id: `resp-${correlationId}`,
      correlationId,
      payload,
    });
  }
}

/** The payloads of the messages the page posted of `type`. */
async function sentPayloads(page: Page, type: string): Promise<Array<Record<string, unknown>>> {
  return page.evaluate((wanted) => {
    const posted = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
    return posted
      .map((m) => ((m as Record<string, unknown>).payload ?? m) as Record<string, unknown>)
      .filter((m) => m.type === wanted)
      .map((m) => (m.payload ?? {}) as Record<string, unknown>);
  }, type);
}

/** What the target has left, answered to every budget request so far. */
async function answerBudget(
  page: Page,
  budget: Record<string, unknown> = { ...sampleBudget() },
): Promise<void> {
  await expect.poll(() => requestIds(page, 'forge:sample-budget:request')).not.toEqual([]);
  await answerAll(page, 'forge:sample-budget:request', 'forge:sample-budget:response', {
    targetOrgId: QA_SANDBOX.id,
    budget,
  });
}

/** The Forge page, its orgs listed, with ALL picked and the target set. */
async function openAll(page: Page, theme: Theme): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await paintHostTheme(page, theme);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'forge';
  });
  await page.goto('/');
  await bridge.seedOrgs([DEV_SANDBOX, QA_SANDBOX]);
  await page.waitForSelector('[data-testid="forge-page"]', { timeout: 10_000 });
  await page.getByTestId('forge-source-org').click();
  await page.getByTestId(`forge-source-org-option-${DEV_SANDBOX.id}`).click();
  await page.getByTestId('forge-target-org').click();
  await page.getByTestId(`forge-target-org-option-${QA_SANDBOX.id}`).click();
  await page.getByTestId('forge-depth-all').click();
  return bridge;
}

/** Discover the whole org, up to its Review, what the target holds and has left answered. */
async function openReview(page: Page, theme: Theme, sampled: boolean): Promise<MockBridge> {
  const bridge = await openAll(page, theme);
  if (sampled) await page.getByTestId('forge-record-limit').selectOption('sample');
  await page.getByTestId('forge-discover-btn').click();
  await page.waitForSelector('[data-testid="forge-discovery-loading"]', { timeout: 10_000 });
  await answerAll(page, 'forge:discover', 'forge:discover:response', { graph: wholeOrgGraph() });
  await expect(page.getByTestId('forge-discovery-summary')).toBeVisible();
  await page.getByTestId('forge-execute-btn').click();
  await expect(page.getByTestId('forge-review')).toBeVisible();
  await expect.poll(() => requestIds(page, 'forge:target-records:request')).not.toEqual([]);
  await answerAll(page, 'forge:target-records:request', 'forge:target-records:response', {
    targetOrgId: QA_SANDBOX.id,
    objects: [],
  });
  await answerBudget(page);
  return bridge;
}

/** Start the run from Review; the id of the request it sent. */
async function startRun(page: Page, simulate = false): Promise<string> {
  const before = (await requestIds(page, 'forge:execute')).length;
  await page.getByTestId(simulate ? 'simulate-button' : 'execute-button').click();
  await page.waitForSelector('[data-testid="forge-execution"]', { timeout: 10_000 });
  await expect.poll(async () => (await requestIds(page, 'forge:execute')).length).toBe(before + 1);
  return (await requestIds(page, 'forge:execute')).slice(-1)[0];
}

/** The result of a run of the whole org, as `forge:execute` answers it. */
function runResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    forgeId: 'forge-sample',
    status: 'success',
    graph: wholeOrgGraph(),
    duration: 60_000,
    timestamp: '2026-11-14T14:10:00.000Z',
    idRemapCount: 1_806,
    createdCount: 1_806,
    ...over,
  };
}

for (const theme of THEMES) {
  test.describe(`a sample of the whole org (${theme})`, () => {
    test('is offered under Records per object, never imposed, and passes axe', async ({ page }) => {
      await openAll(page, theme);

      const records = page.getByTestId('forge-record-limit');
      await expect(records).toBeEnabled();
      await expect(records).toHaveValue('every');
      await records.selectOption('sample');
      await expect(page.getByTestId('forge-record-limit-all')).toContainText(
        'Records drawn from each object, with their children and the records they name',
      );
      const input = await checkAccessibility(page);
      expect(input.violations.length, formatViolations(input.violations)).toBe(0);

      await page.getByTestId('forge-discover-btn').click();
      const [discover] = await sentPayloads(page, 'forge:discover');
      expect(discover.config).toMatchObject({ inputMode: 'org', depth: 'all', sample: {} });
    });

    test('Review reads what the target has left, sets the draw and its settings, and passes axe', async ({
      page,
    }) => {
      await openReview(page, theme, true);

      await expect(page.getByTestId('review-sentence')).toContainText(
        'Copy a sample of DevSandbox that fits QASandbox, drawn from 9,400 records',
      );
      await expect(page.getByTestId('review-sample-whole-org')).toHaveText(
        'Every record takes about 412 MB of the data storage of QASandbox, which has 4.5 MB left: the run would be refused. A sample that fits would take about 3.2 MB.',
      );
      await expect(page.getByTestId('review-sample-fits')).toBeChecked();
      await expect(page.getByTestId('review-sample-budget')).toHaveText(
        'The sample may take about 3.2 MB: 80 % of the 4.5 MB QASandbox has left, 0.5 MB kept off for rounding.',
      );
      await expect(page.getByTestId('review-sample-cost')).toContainText(
        'Drawing it reads API requests of DevSandbox: about 1,950',
      );
      // The files go greyed, with why: a sample copies none yet.
      await expect(page.getByTestId('forge-files-toggle')).toBeDisabled();
      await expect(page.getByTestId('forge-files-sample')).toBeVisible();

      await page.getByTestId('review-sample-draw').selectOption('recent');
      await expect(page.getByTestId('review-sample-draw-hint')).toContainText(
        'The records made last, by their creation date',
      );
      await expect
        .poll(async () => {
          const budgets = await sentPayloads(page, 'forge:sample-budget:request');
          return (budgets.slice(-1)[0]?.config as Record<string, unknown> | undefined)?.sample;
        })
        .toEqual({ draw: 'recent' });
      await answerBudget(page, {
        ...sampleBudget({
          planReads: {
            source: { verdict: 'exceeds', estimate: 9_000, max: 15_000, remaining: 14_000 },
            seconds: 1_200,
          },
        }),
      });
      await expect(page.getByTestId('review-sample-cost-refused')).toBeVisible();

      await page.getByTestId('review-sample-more').locator('summary').click();
      await page.getByTestId('review-sample-draw-again').click();
      await expect(page.getByTestId('review-sample-seed')).toHaveText('Seed 2');
      await page.getByTestId('review-sample-whole-toggle').click();
      await expect(page.getByTestId('review-sample-whole-Opportunity')).toBeDisabled();
      await expect(page.getByTestId('review-sample-whole-Opportunity')).toBeChecked();
      const review = await checkAccessibility(page);
      expect(review.violations.length, formatViolations(review.violations)).toBe(0);
    });

    test('its simulation says what it drew before the rest, and passes axe', async ({ page }) => {
      await openReview(page, theme, true);
      const run = await startRun(page, true);

      const [execute] = (await sentPayloads(page, 'forge:execute')).slice(-1);
      expect(execute.config).toMatchObject({ inputMode: 'org', sample: {}, dryRun: true });
      expect(execute.config).not.toHaveProperty('sample.plan');
      expect(execute).not.toHaveProperty('files');

      await sendExtensionMessage(page, {
        type: 'forge:execute:response',
        id: 'dry',
        correlationId: run,
        payload: {
          result: runResult({ status: 'failure', createdCount: 0, dryRun: true }),
          operationId: 'forge-execute-1',
          wholeOrgDryRun: wholeOrgDryRun({ sample: wholeOrgSample(), wouldBeRefused: [] }),
        },
      });

      await expect(page.getByTestId('forge-whole-org-dry-run')).toContainText(
        'Dry run of a sample of the whole org',
      );
      await expect(page.getByTestId('forge-whole-org-sample-kept')).toHaveText(
        '1,812 of 9,400 records of DevSandbox, from 3 objects: 0.41 % of the roots of each object, seed 1, spread over the org, with the records they reach.',
      );
      await expect(page.getByTestId('forge-whole-org-sample-plan')).toContainText(
        'The plan is kept on this machine for a day',
      );
      const results = await checkAccessibility(page);
      expect(results.violations.length, formatViolations(results.violations)).toBe(0);
    });

    test('its run says where the drawing stands, then what it wrote of the plan, and passes axe', async ({
      page,
    }) => {
      await openReview(page, theme, true);
      const run = await startRun(page);

      await sendExtensionMessage(page, {
        type: 'forge:sampling:progress',
        id: 'sampling-1',
        correlationId: run,
        payload: {
          step: 'closing',
          objectApiName: 'Contact',
          done: 2,
          total: 3,
          rows: 1_240,
          requests: 38,
          pricedAt: 61,
        },
      });
      await expect(page.getByTestId('forge-sampling-step')).toHaveText(
        'Drawing the sample, before anything is written: reading the records they reach and name — Contact, 2 of 3 objects.',
      );
      const drawing = await checkAccessibility(page);
      expect(drawing.violations.length, formatViolations(drawing.violations)).toBe(0);

      await sendExtensionMessage(page, {
        type: 'forge:progress',
        id: 'progress-1',
        correlationId: run,
        payload: { objectName: 'Opportunity', status: 'running', progress: 10 },
      });
      await expect(page.getByTestId('forge-sampling')).toHaveCount(0);

      await sendExtensionMessage(page, {
        type: 'forge:execute:response',
        id: 'done',
        correlationId: run,
        payload: {
          result: runResult({ status: 'partial', sample: wholeOrgSampleResult() }),
          operationId: 'forge-execute-1',
        },
      });

      await expect(page.getByTestId('forge-sample-result-verdict')).toHaveText(
        '2 records of the sample were held back: a record they cannot be written without changed since the sample. 4 were gone from DevSandbox since the sample: no failure.',
      );
      await expect(page.getByTestId('forge-sample-result-objects')).toContainText(
        'Account: 712 written of 712 in the sample (500 drawn, 212 as parents) of 1,200 in DevSandbox.',
      );
      const results = await checkAccessibility(page);
      expect(results.violations.length, formatViolations(results.violations)).toBe(0);
    });
  });
}

test('a sample whose target moved since its plan is simulated again from the notice', async ({
  page,
}) => {
  await openReview(page, 'Light 2026', true);
  const run = await startRun(page);

  await sendExtensionMessage(page, {
    type: 'forge:execute:error',
    id: 'gate-stop',
    correlationId: run,
    payload: {
      message: 'The host says it in English.',
      code: 'STORAGE_EXCEEDED',
      retryable: true,
      gate: {
        code: 'STORAGE_EXCEEDED',
        storage: { estimateMB: 3.1, remainingMB: 1 },
        sample: { fittedMB: 3.2, holdsMB: 0.4 },
      },
    },
  });

  await expect(page.getByTestId('forge-run-gate-reason')).toContainText(
    'the sample was fitted to 3.2 MB of the target org’s data storage',
  );
  const notice = await checkAccessibility(page);
  expect(notice.violations.length, formatViolations(notice.violations)).toBe(0);
  await page.getByTestId('forge-run-gate-simulate-again').click();

  await expect(page.getByTestId('forge-execution')).toBeVisible();
  const [execute] = (await sentPayloads(page, 'forge:execute')).slice(-1);
  expect(execute.config).toMatchObject({ sample: {}, dryRun: true });
});

test('a simulation of every record past the storage offers the sample that fits, which goes with no file', async ({
  page,
}) => {
  await openReview(page, 'Dark 2026', false);
  // Files ticked for every record: the sample takes none.
  await page.getByTestId('forge-files-toggle').check();
  const run = await startRun(page, true);
  await sendExtensionMessage(page, {
    type: 'forge:execute:response',
    id: 'dry',
    correlationId: run,
    payload: {
      result: runResult({ status: 'failure', createdCount: 0, dryRun: true }),
      operationId: 'forge-execute-1',
      wholeOrgDryRun: wholeOrgDryRun({
        storage: { verdict: 'exceeds', estimateMB: 412, maxMB: 5, remainingMB: 4.5 },
      }),
      sampleOffer: sampleBudgetTerms(),
    },
  });

  await expect(page.getByTestId('forge-whole-org-dry-run-sample-offer')).toContainText(
    'A sample that fits would take about 3.2 MB.',
  );
  const offered = await checkAccessibility(page);
  expect(offered.violations.length, formatViolations(offered.violations)).toBe(0);
  await page.getByTestId('forge-whole-org-dry-run-copy-sample').click();

  await expect(page.getByTestId('forge-review')).toBeVisible();
  await expect(page.getByTestId('review-sample-fits')).toBeChecked();
  await expect(page.getByTestId('forge-files-toggle')).not.toBeChecked();
  await startRun(page);
  const [execute] = (await sentPayloads(page, 'forge:execute')).slice(-1);
  expect(execute.config).toMatchObject({ inputMode: 'org', sample: {} });
  expect(execute).not.toHaveProperty('files');
});

test('a run of every record refused for its storage offers the sample that fits from the notice', async ({
  page,
}) => {
  await openReview(page, 'Light 2026', false);
  const run = await startRun(page);

  await sendExtensionMessage(page, {
    type: 'forge:execute:error',
    id: 'gate-stop',
    correlationId: run,
    payload: {
      message: 'The host says it in English.',
      code: 'STORAGE_EXCEEDED',
      retryable: true,
      gate: { code: 'STORAGE_EXCEEDED', storage: { estimateMB: 412, remainingMB: 4.5 } },
      sampleOffer: sampleBudgetTerms(),
    },
  });

  await expect(page.getByTestId('forge-run-gate-sample-offer')).toHaveText(
    'A sample that fits would take about 3.2 MB of it.',
  );
  await page.getByTestId('forge-run-gate-copy-sample').click();
  await expect(page.getByTestId('forge-run-gate-notice')).toHaveCount(0);
  await expect(page.getByTestId('review-sample-fits')).toBeChecked();
});
