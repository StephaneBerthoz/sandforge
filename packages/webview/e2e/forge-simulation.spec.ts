import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MockBridge, checkAccessibility, formatViolations } from './helpers';
import { QA_SANDBOX } from './fixtures';
import { VSCODE_DEFAULT_STYLES } from './fixtures/vscode-default-styles';
import { sendExtensionMessage } from './mocks/vscode-api';
import { hostColours, vscodeTheme } from '../src/styles/testing/vscodeThemes';

/**
 * Review's Simulate: the same run as Execute Forge, asking for a simulation —
 * every record read goes through the write stage and nothing is written. The
 * execution screen says so before any count, and the results say nothing was
 * written, what a real run would insert and the gaps found, with the way
 * back to Review. Scanned with axe under VS Code's default themes and the two
 * they replaced, painted as the host paints a webview.
 */
const THEMES = ['Light 2026', 'Dark 2026', 'Light Modern', 'Dark Modern'] as const;
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

/** An account, as a Forge discovery answers with it. */
const GRAPH = {
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
  ],
  edges: [],
  totalRecords: 1,
  estimatedSizeMB: 0.01,
  estimatedDurationSeconds: 1,
};

/** What a simulation of the account answers: one record a real run would insert, one gap. */
const SIMULATION = {
  forgeId: 'forge-simulated',
  status: 'success',
  graph: GRAPH,
  duration: 900,
  timestamp: '2026-10-06T10:00:00.000Z',
  idRemapCount: 0,
  idRemapTable: {},
  createdCount: 0,
  dryRun: true,
  wouldInsertCount: 1,
  readByObject: [{ objectApiName: 'Account', read: 1 }],
  failedReads: [],
  errors: [],
  truncatedObjects: [],
  gaps: [
    {
      id: 'value_too_long|Account|Name||',
      kind: 'value_too_long',
      severity: 'blocking',
      source: 'simulation',
      objectApiName: 'Account',
      field: 'Name',
      rows: 1,
      detail: { length: 40, longest: 52 },
      decisions: ['truncate', 'exclude_object', 'ignore'],
    },
  ],
};

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

/** Discover the account from the SOQL tab and stop on Review. */
async function openReview(page: Page, theme: Theme): Promise<MockBridge> {
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
  await page.getByTestId('forge-input-soql').fill('SELECT Id FROM Account');
  await page.getByTestId('forge-target-org').click();
  await page.getByTestId(`forge-target-org-option-${QA_SANDBOX.id}`).click();
  await page.getByTestId('forge-discover-btn').click();
  await page.waitForSelector('[data-testid="forge-discovery-loading"]', { timeout: 10_000 });
  await answerAll(page, 'forge:discover', 'forge:discover:response', { graph: GRAPH });
  await page.getByTestId('forge-execute-btn').click();
  await page.waitForSelector('[data-testid="forge-review"]', { timeout: 10_000 });
  return bridge;
}

for (const theme of THEMES) {
  test.describe(`a Forge simulation (${theme})`, () => {
    test('Simulate sits beside Execute on Review, and passes axe', async ({ page }) => {
      await openReview(page, theme);

      await expect(page.getByTestId('simulate-button')).toBeEnabled();
      await expect(page.getByTestId('simulate-button')).toHaveText('Simulate');
      await expect(page.getByTestId('execute-button')).toBeEnabled();
      const results = await checkAccessibility(page);
      expect(results.violations.length, formatViolations(results.violations)).toBe(0);
    });

    test('runs as a simulation, says on its results that nothing was written, and passes axe', async ({
      page,
    }) => {
      const bridge = await openReview(page, theme);

      await page.getByTestId('simulate-button').click();
      await page.waitForSelector('[data-testid="forge-execution"]', { timeout: 10_000 });
      const request = await bridge.waitForMessage('forge:execute', { timeout: 10_000 });
      const sent = (request.payload ?? request) as { config?: { dryRun?: boolean } };
      expect(sent.config?.dryRun).toBe(true);
      await expect(page.getByTestId('forge-execution-simulation')).toBeVisible();
      const running = await checkAccessibility(page);
      expect(running.violations.length, formatViolations(running.violations)).toBe(0);

      await sendExtensionMessage(page, {
        type: 'forge:execute:response',
        id: 'simulated',
        correlationId: String(request.id),
        payload: { result: SIMULATION, operationId: 'forge-execute-1' },
      });

      await expect(page.getByTestId('forge-results-simulation')).toContainText(
        'Simulation, nothing was written.',
      );
      await expect(page.getByTestId('forge-results-simulation-gaps')).toHaveText(
        'Gaps found against the target: 1',
      );
      await expect(page.getByTestId('forge-retry-failed')).toHaveCount(0);
      const results = await checkAccessibility(page);
      expect(results.violations.length, formatViolations(results.violations)).toBe(0);

      await page.getByTestId('forge-results-simulation-review').click();
      await expect(page.getByTestId('forge-review')).toBeVisible();
    });
  });
}
