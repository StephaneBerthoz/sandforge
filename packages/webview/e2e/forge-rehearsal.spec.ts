import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MockBridge, checkAccessibility, formatViolations } from './helpers';
import { QA_SANDBOX } from './fixtures';
import { VSCODE_DEFAULT_STYLES } from './fixtures/vscode-default-styles';
import { sendExtensionMessage } from './mocks/vscode-api';
import { hostColours, vscodeTheme } from '../src/styles/testing/vscodeThemes';

/**
 * Review's Rehearse: the run as Execute Forge would send it, a sample of its
 * rows created in the target and every write rolled back. The line beside the
 * button says each phase — reading, the confirmation in VS Code with the calls
 * it costs, the call under way — then what the rehearsal found. Scanned with
 * axe under VS Code's default themes and the two they replaced, painted as the
 * host paints a webview.
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

/** What a rehearsal of the account answers: one row judged, refused on a validation rule. */
const REHEARSAL = {
  gaps: [
    {
      id: 'rehearsal_refusal|Account|Phone||FIELD_CUSTOM_VALIDATION_EXCEPTION',
      kind: 'rehearsal_refusal',
      severity: 'warning',
      source: 'rehearsal',
      objectApiName: 'Account',
      field: 'Phone',
      value: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
      rows: 1,
      detail: {
        statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
        fields: ['Phone'],
        rowsOfTheRun: 1,
      },
      decisions: ['leave_empty', 'exclude_object', 'ignore'],
      defaultDecision: 'leave_empty',
    },
  ],
  rows: 1,
  sampled: 1,
  judged: 1,
  passed: 0,
  notJudged: 0,
  notJudgedWhy: [],
  updatesNotRehearsed: 0,
  calls: 1,
  plannedCalls: 1,
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
  test.describe(`a Forge rehearsal (${theme})`, () => {
    test('Rehearse sits in the action bar of Review, and passes axe', async ({ page }) => {
      await openReview(page, theme);

      await expect(page.getByTestId('rehearse-button')).toBeEnabled();
      await expect(page.getByTestId('rehearse-button')).toHaveText('Rehearse');
      await expect(page.getByTestId('execute-button')).toBeEnabled();
      const results = await checkAccessibility(page);
      expect(results.violations.length, formatViolations(results.violations)).toBe(0);
    });

    test('says each phase of the rehearsal, then what it found, and passes axe all along', async ({
      page,
    }) => {
      const bridge = await openReview(page, theme);

      await page.getByTestId('rehearse-button').click();
      const request = await bridge.waitForMessage('forge:rehearse:request', { timeout: 10_000 });
      const sent = (request.payload ?? request) as { graph?: unknown; config?: unknown };
      expect(sent.graph).toBeTruthy();
      expect(sent.config).toBeTruthy();
      await expect(page.getByTestId('rehearse-button')).toBeDisabled();
      const correlationId = String(request.id);

      await sendExtensionMessage(page, {
        type: 'forge:rehearse:progress',
        id: 'progress-1',
        correlationId,
        payload: { phase: 'reading', objectApiName: 'Account' },
      });
      await expect(page.getByTestId('forge-rehearse-status')).toHaveText(
        'Rehearsal: reading the rows as the run would (Account)…',
      );
      const reading = await checkAccessibility(page);
      expect(reading.violations.length, formatViolations(reading.violations)).toBe(0);

      await sendExtensionMessage(page, {
        type: 'forge:rehearse:progress',
        id: 'progress-2',
        correlationId,
        payload: { phase: 'confirming', calls: 1 },
      });
      await expect(page.getByTestId('forge-rehearse-status')).toHaveText(
        'Rehearsal: confirm in VS Code the 1 composite call it costs.',
      );

      await sendExtensionMessage(page, {
        type: 'forge:rehearse:progress',
        id: 'progress-3',
        correlationId,
        payload: { phase: 'rehearsing', call: 1, calls: 1 },
      });
      await expect(page.getByTestId('forge-rehearse-status')).toHaveText(
        'Rehearsal: call 1 of 1, rolled back as it ends…',
      );

      await sendExtensionMessage(page, {
        type: 'forge:rehearse:response',
        id: 'rehearsed',
        correlationId,
        payload: { rehearsal: REHEARSAL },
      });
      await expect(page.getByTestId('forge-rehearse-status')).toHaveText(
        'Rehearsal done, every write rolled back. Judged: 1; would save: 0; refused: 1; not judged: 0; composite calls: 1.',
      );
      await expect(page.getByTestId('rehearse-button')).toBeEnabled();
      const done = await checkAccessibility(page);
      expect(done.violations.length, formatViolations(done.violations)).toBe(0);
    });

    test('says a rehearsal declined at its confirmation sent nothing, and passes axe', async ({
      page,
    }) => {
      const bridge = await openReview(page, theme);

      await page.getByTestId('rehearse-button').click();
      const request = await bridge.waitForMessage('forge:rehearse:request', { timeout: 10_000 });
      await sendExtensionMessage(page, {
        type: 'forge:rehearse:error',
        id: 'declined',
        correlationId: String(request.id),
        payload: { message: 'cancelled', code: 'REHEARSAL_DECLINED', retryable: true },
      });
      await expect(page.getByTestId('forge-rehearse-status')).toHaveText(
        'Rehearsal cancelled at its confirmation. Nothing was sent to the target.',
      );
      const results = await checkAccessibility(page);
      expect(results.violations.length, formatViolations(results.violations)).toBe(0);
    });
  });
}
