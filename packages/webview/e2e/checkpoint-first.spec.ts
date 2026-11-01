import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MockBridge, checkAccessibility, formatViolations } from './helpers';
import { QA_SANDBOX } from './fixtures';
import { listEntry, readyCheckpoint } from './fixtures/checkpoints';
import { VSCODE_DEFAULT_STYLES } from './fixtures/vscode-default-styles';
import { sendExtensionMessage } from './mocks/vscode-api';
import { hostColours, vscodeTheme } from '../src/styles/testing/vscodeThemes';

/**
 * Checkpoint first, as a page offers it: the option on Review, what the run
 * sends with it, the notice of a run refused for it, and the way from a run's
 * result to the preview of a rewind to the checkpoint it took. Scanned with
 * axe in the rendered page, under VS Code's default light and dark themes,
 * painted as the host paints a webview.
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

/** The checkpoint the run took before its first write. */
const TAKEN = {
  state: 'taken',
  checkpointId: 'ck-20261101-101540-a1b2',
  name: 'Before Forge run 2026-11-01 10:15 UTC',
  takenAt: '2026-11-01T10:15:40.000Z',
  expiresAt: '2026-11-08T10:15:40.000Z',
  objects: ['Account'],
  records: 38,
  bytes: 2_306_867,
  requests: 66,
  added: [],
  notHeld: [{ objectApiName: 'FeedItem', reason: 'Chatter posts are never held.' }],
};

/** A run that wrote one account, its checkpoint taken first. */
const RUN = {
  forgeId: 'forge-with-checkpoint',
  status: 'success',
  graph: GRAPH,
  duration: 900,
  timestamp: '2026-11-01T10:16:00.000Z',
  targetOrgId: QA_SANDBOX.id,
  idRemapCount: 1,
  idRemapTable: {},
  createdCount: 1,
  readByObject: [{ objectApiName: 'Account', read: 1 }],
  failedReads: [],
  errors: [],
  truncatedObjects: [],
  checkpoint: TAKEN,
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

/** Open Review of a clone of the account, on its Controls tab. */
async function openControls(page: Page, theme: Theme): Promise<MockBridge> {
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
  await page.getByTestId('tab-controls').click();
  await expect(page.getByTestId('controls-checkpoint-first')).toBeVisible();
  return bridge;
}

/** Tick the option and press Execute; the run's request. */
async function executeWithTheCheckpoint(
  page: Page,
  bridge: MockBridge,
): Promise<Record<string, unknown>> {
  await page.getByTestId('controls-checkpoint-first-toggle').check();
  await page.getByTestId('execute-button').click();
  await page.waitForSelector('[data-testid="forge-execution"]', { timeout: 10_000 });
  return bridge.waitForMessage('forge:execute', { timeout: 10_000 });
}

for (const theme of THEMES) {
  test.describe(`Checkpoint first (${theme})`, () => {
    test('Review offers it off, says what it holds and leaves out, and passes axe', async ({
      page,
    }) => {
      await openControls(page, theme);

      await expect(page.getByTestId('controls-checkpoint-first-toggle')).not.toBeChecked();
      await expect(page.getByTestId('controls-checkpoint-first-holds')).toContainText(
        `takes a checkpoint of ${QA_SANDBOX.alias}`,
      );
      await expect(page.getByTestId('controls-checkpoint-first-leaves-out')).toContainText(
        'An Apex trigger, or a flow SandForge could not read',
      );
      const results = await checkAccessibility(page);
      expect(results.violations.length, formatViolations(results.violations)).toBe(0);
    });

    test('ticked, it goes with Execute', async ({ page }) => {
      const bridge = await openControls(page, theme);

      const request = await executeWithTheCheckpoint(page, bridge);

      expect((request.payload as Record<string, unknown>).checkpointFirst).toEqual({});
    });

    test('a run refused for it says what refused it, in Review, and passes axe', async ({
      page,
    }) => {
      const bridge = await openControls(page, theme);
      const request = await executeWithTheCheckpoint(page, bridge);

      await sendExtensionMessage(page, {
        type: 'forge:execute:error',
        id: 'gate-stop',
        correlationId: String(request.id),
        payload: {
          message: 'The checkpoint before the run was refused: The disk has 1.0 MB free.',
          code: 'CHECKPOINT_REFUSED',
          retryable: true,
          gate: { code: 'CHECKPOINT_REFUSED', reason: 'DISK' },
        },
      });

      await expect(page.getByTestId('forge-review')).toBeVisible();
      await expect(page.getByTestId('forge-run-gate-reason')).toContainText(
        "This machine's disk has too little room for it.",
      );
      const results = await checkAccessibility(page);
      expect(results.violations.length, formatViolations(results.violations)).toBe(0);
    });

    test('the result names it, passes axe, and opens the preview of a rewind to it', async ({
      page,
    }) => {
      const bridge = await openControls(page, theme);
      const request = await executeWithTheCheckpoint(page, bridge);

      await sendExtensionMessage(page, {
        type: 'forge:execute:response',
        id: 'run-ended',
        correlationId: String(request.id),
        payload: { result: RUN, operationId: 'forge-execute-1' },
      });

      await expect(page.getByTestId('forge-results-checkpoint-taken')).toContainText(TAKEN.name);
      await expect(page.getByTestId('forge-results-checkpoint-not-held')).toContainText('FeedItem');
      const results = await checkAccessibility(page);
      expect(results.violations.length, formatViolations(results.violations)).toBe(0);

      await page.getByTestId('forge-results-checkpoint-action').click();

      await expect(page.getByTestId('checkpoint-page')).toBeVisible();
      // The preview opens once the list says the checkpoint is there.
      const listed = await bridge.waitForMessage('checkpoint:list', { timeout: 10_000 });
      expect((listed.payload as Record<string, unknown>).orgId).toBe(QA_SANDBOX.id);
      await answerAll(page, 'checkpoint:list', 'checkpoint:list:response', {
        checkpoints: [
          listEntry(readyCheckpoint({ checkpointId: TAKEN.checkpointId, name: TAKEN.name })),
        ],
      });
      const preview = await bridge.waitForMessage('checkpoint:preview', { timeout: 10_000 });
      expect((preview.payload as Record<string, unknown>).checkpointId).toBe(TAKEN.checkpointId);
    });
  });
}
