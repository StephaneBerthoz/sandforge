import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MockBridge, checkAccessibility, formatViolations } from './helpers';
import { DEV_SANDBOX, MOCK_ORGS, QA_SANDBOX } from './fixtures';
import { VSCODE_DEFAULT_STYLES } from './fixtures/vscode-default-styles';
import { sendExtensionMessage } from './mocks/vscode-api';
import { hostColours, vscodeTheme } from '../src/styles/testing/vscodeThemes';

/**
 * Checkpoint first, as the pages of Sync and Seed offer it: the option beside
 * Run and on a template's confirmation, what the run sends with it, what a
 * simulation says it would hold and cost, the words of a run refused for it,
 * and the checkpoint on the run's result with the way to the preview of a
 * rewind to it. Scanned with axe in the rendered page, under VS Code's default
 * light and dark themes, painted as the host paints a webview.
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

/** A draft on Sync's execute step: two orgs, one object, ready to simulate or run. */
const READY_DRAFT = {
  currentStep: 4,
  direction: 'source_to_target',
  mode: 'full',
  conflictStrategy: 'source_wins',
  sourceOrgId: DEV_SANDBOX.id,
  targetOrgId: QA_SANDBOX.id,
  objectEntries: [
    {
      objectApiName: 'Account',
      operation: 'upsert',
      externalIdField: 'Legacy_Key__c',
      batchSize: 200,
      where: '',
    },
  ],
  mappingsByObject: {},
  transforms: [],
};

/** Open the Sync panel on its execute step, as it reopens on a saved draft. */
async function openSyncExecute(page: Page, theme: Theme): Promise<MockBridge> {
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
  }, READY_DRAFT);
  await page.goto('/');
  await bridge.seedOrgs(MOCK_ORGS);
  await expect(page.getByTestId('sync-checkpoint-first')).toBeVisible();
  return bridge;
}

/** What a simulation of the draft says a checkpoint first would hold and cost. */
const ESTIMATE = {
  state: 'planned',
  estimate: {
    records: 7588,
    apiRequests: 43,
    apiRequestsLeft: 14000,
    seconds: 22,
    bytes: 2200000,
  },
  objects: ['Account', 'Task'],
  // Each note with its code, as the extension sends it: the page says it in
  // its language, from a namespace the Sync page loads.
  added: [
    {
      objectApiName: 'Task',
      code: 'createdByAutomation',
      reason:
        "The target's flow 'Account follow-up' creates Task records as Account records go in.",
      creators: [
        { kind: 'flow', name: 'Account follow-up', objectApiName: 'Account', write: 'insert' },
      ],
    },
  ],
  notHeld: [
    { objectApiName: 'FeedItem', code: 'chatter', reason: 'Chatter posts are never held.' },
  ],
  keepDays: 7,
};

/** What a simulation answers, nothing written. */
const SIMULATION = {
  configId: 'cfg-e2e',
  operationId: 'sim-e2e',
  direction: 'source_to_target',
  conflictStrategy: 'source_wins',
  objects: [
    {
      objectApiName: 'Account',
      operation: 'upsert',
      read: 12,
      insert: 12,
      update: 0,
      delete: 0,
      skipped: 0,
      refused: 0,
      conflicts: 0,
      conflictFields: [],
      notes: [],
    },
  ],
  duration: 900,
  timestamp: '2026-11-01T10:14:00.000Z',
  checkpoint: ESTIMATE,
};

/** The checkpoint a run took first, as its result names it. */
const TAKEN = {
  state: 'taken',
  checkpointId: 'ck-20261101-101500-a1b2',
  name: 'Before Sync run 2026-11-01 10:15 UTC',
  takenAt: '2026-11-01T10:15:00.000Z',
  expiresAt: '2026-11-08T10:15:00.000Z',
  objects: ['Account', 'Task'],
  records: 7588,
  bytes: 2200000,
  requests: 43,
  added: ESTIMATE.added,
  notHeld: ESTIMATE.notHeld,
};

/** A run of the draft, ended with `checkpoint` named. */
function syncResult(operationId: string, checkpoint: unknown): Record<string, unknown> {
  return {
    configId: 'cfg-e2e',
    operationId,
    status: 'success',
    objectResults: [
      {
        objectApiName: 'Account',
        operation: 'upsert',
        processed: 12,
        success: 12,
        failed: 0,
        skipped: 0,
        conflictCount: 0,
        errors: [],
      },
    ],
    totalProcessed: 12,
    totalSuccess: 12,
    totalFailed: 0,
    totalSkipped: 0,
    duration: 1000,
    timestamp: '2026-11-01T10:15:30.000Z',
    checkpoint,
  };
}

/** Answer every pending request of a type: a development build mounts the panel twice. */
async function answerAll(
  page: Page,
  bridge: MockBridge,
  requestType: string,
  responseType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await bridge.waitForMessage(requestType, { timeout: 10_000 });
  for (const request of await bridge.getMessages(requestType)) {
    const correlationId = String(request.id);
    await sendExtensionMessage(page, {
      type: responseType,
      id: `resp-${correlationId}`,
      correlationId,
      payload,
    });
  }
}

/** The Seed page on a template's confirmation, the panel's org preselected. */
async function openQuickSeed(page: Page, theme: Theme): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await paintHostTheme(page, theme);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'seed';
  });
  await page.goto('/');
  await bridge.seedOrgs(MOCK_ORGS);
  await answerAll(page, bridge, 'seed:template:list', 'seed:template:list:response', {
    templates: [],
  });
  await page
    .getByTestId('template-card-prebuilt-sales-cloud-starter')
    .getByTestId('btn-use-template')
    .click();
  await expect(page.getByTestId('quick-seed-org-selector')).toHaveValue(DEV_SANDBOX.id);
  await expect(page.getByTestId('quick-seed-checkpoint-first')).toBeVisible();
  return bridge;
}

for (const theme of THEMES) {
  test.describe(`Checkpoint first on Sync (${theme})`, () => {
    test('offers it off beside Run, says what it holds and leaves out, and passes axe', async ({
      page,
    }) => {
      await openSyncExecute(page, theme);

      await expect(page.getByTestId('sync-checkpoint-first-toggle')).not.toBeChecked();
      await expect(page.getByTestId('sync-checkpoint-first-leaves-out')).toContainText(
        'Chatter posts, Knowledge article versions',
      );
      await expect(page.getByTestId('sync-checkpoint-first-cost-said')).toContainText('Simulate');

      const results = await checkAccessibility(page);
      expect(results.violations, formatViolations(results.violations)).toEqual([]);
    });

    test('a simulation says what it would hold and cost, on its results and beside Run, and passes axe', async ({
      page,
    }) => {
      const bridge = await openSyncExecute(page, theme);
      await page.getByTestId('sync-checkpoint-first-toggle').check();
      await page.getByTestId('sync-simulate').click();

      const asked = await bridge.waitForMessage('sync:simulate', { timeout: 10_000 });
      expect((asked.payload as { checkpointFirst?: unknown }).checkpointFirst).toEqual({});
      await bridge.respond('sync:simulate:response', SIMULATION);

      await expect(page.getByTestId('sync-simulation-checkpoint-cost')).toContainText(
        'A real run would take a checkpoint first: about 7,588 records of Account and Task',
      );
      await expect(page.getByTestId('sync-simulation-checkpoint-added-Task')).toHaveText(
        "Task · The target's flow 'Account follow-up' creates Task records as Account records go in.",
      );
      // The catalogue's words, by the note's code, not the extension's own.
      await expect(page.getByTestId('sync-simulation-checkpoint-not-held-FeedItem')).toHaveText(
        'FeedItem · Chatter posts, comments and feeds are left out: Salesforce brings a post back ' +
          'only with what it was posted on.',
      );
      const results = await checkAccessibility(page);
      expect(results.violations, formatViolations(results.violations)).toEqual([]);

      // Back on the execute step, from the wizard's own steps: the results end it.
      await page.getByTestId('sync-step-indicator').getByRole('button').nth(4).click();
      await expect(page.getByTestId('sync-checkpoint-first-estimate-cost')).toContainText(
        'At the last simulation:',
      );
    });

    test('a run refused for it says what refused it, its box still ticked, and passes axe', async ({
      page,
    }) => {
      const bridge = await openSyncExecute(page, theme);
      await page.getByTestId('sync-checkpoint-first-toggle').check();
      await page.getByTestId('sync-run').click();

      const run = await bridge.waitForMessage('sync:execute', { timeout: 10_000 });
      expect((run.payload as { checkpointFirst?: unknown }).checkpointFirst).toEqual({});
      await sendExtensionMessage(page, {
        type: 'sync:error',
        id: 'refusal',
        correlationId: String(run.id),
        payload: {
          message: 'The checkpoint before the run was refused: no room.',
          code: 'CHECKPOINT_REFUSED',
          retryable: false,
          checkpointRefusal: 'DISK',
        },
      });

      await expect(page.getByTestId('sync-error')).toContainText(
        "This machine's disk has too little room for it.",
      );
      await expect(page.getByTestId('sync-error')).toContainText('Untick Checkpoint first');
      await expect(page.getByTestId('sync-error')).not.toContainText('no room');
      await expect(page.getByTestId('sync-checkpoint-first-toggle')).toBeChecked();
      const results = await checkAccessibility(page);
      expect(results.violations, formatViolations(results.violations)).toEqual([]);
    });

    test('a run stopped once it was taken says it was deleted, and passes axe', async ({
      page,
    }) => {
      const bridge = await openSyncExecute(page, theme);
      await page.getByTestId('sync-checkpoint-first-toggle').check();
      await page.getByTestId('sync-run').click();
      const run = await bridge.waitForMessage('sync:execute', { timeout: 10_000 });
      await sendExtensionMessage(page, {
        type: 'sync:error',
        id: 'refusal',
        correlationId: String(run.id),
        payload: {
          message: 'The user cannot assign permission sets.',
          code: 'MUTE_NO_RIGHT',
          retryable: false,
          checkpoint: { state: 'deleted', deleted: 'nothingWritten' },
        },
      });

      await expect(page.getByTestId('sync-error-checkpoint-deleted')).toHaveText(
        'The checkpoint taken before the run was deleted: the run wrote nothing.',
      );
      const results = await checkAccessibility(page);
      expect(results.violations, formatViolations(results.violations)).toEqual([]);
    });

    test('the result names it, passes axe, and opens the preview of a rewind to it', async ({
      page,
    }) => {
      const bridge = await openSyncExecute(page, theme);
      await page.getByTestId('sync-checkpoint-first-toggle').check();
      await page.getByTestId('sync-run').click();
      const run = await bridge.waitForMessage('sync:execute', { timeout: 10_000 });
      await sendExtensionMessage(page, {
        type: 'sync:execute:response',
        id: 'answer',
        correlationId: String(run.id),
        payload: syncResult(String(run.id), TAKEN),
      });

      const named = page.getByTestId('sync-result-checkpoint');
      await expect(named).toContainText('Before Sync run 2026-11-01 10:15 UTC');
      await expect(named).toContainText('Not in the checkpoint');
      const results = await checkAccessibility(page);
      expect(results.violations, formatViolations(results.violations)).toEqual([]);

      await page.getByTestId('sync-result-checkpoint-action').click();
      await expect(page.getByTestId('checkpoint-page')).toBeVisible();
    });
  });

  test.describe(`Checkpoint first on a template's seed (${theme})`, () => {
    test('offers it off on the confirmation, says the question has its cost, and passes axe', async ({
      page,
    }) => {
      await openQuickSeed(page, theme);

      await expect(page.getByTestId('quick-seed-checkpoint-first-toggle')).not.toBeChecked();
      await expect(page.getByTestId('quick-seed-checkpoint-first-cost-said')).toContainText(
        'the question before the first write',
      );
      const results = await checkAccessibility(page);
      expect(results.violations, formatViolations(results.violations)).toEqual([]);
    });

    test('a seed refused for it says what refused it, goes back with its box ticked, and passes axe', async ({
      page,
    }) => {
      const bridge = await openQuickSeed(page, theme);
      await page.getByTestId('quick-seed-checkpoint-first-toggle').check();
      await page.getByTestId('btn-quick-seed-start').click();

      const run = await bridge.waitForMessage('seed:execute', { timeout: 10_000 });
      expect((run.payload as { checkpointFirst?: unknown }).checkpointFirst).toEqual({});
      await sendExtensionMessage(page, {
        type: 'seed:error',
        id: 'refusal',
        correlationId: String(run.id),
        payload: {
          message: 'The checkpoint before the run was refused: another run writes.',
          code: 'CHECKPOINT_REFUSED',
          retryable: false,
          checkpointRefusal: 'RUN_WRITING',
        },
      });

      await expect(page.getByTestId('quick-seed-error')).toContainText(
        'Another SandForge run, take, rewind or undo is writing to the org',
      );
      const refused = await checkAccessibility(page);
      expect(refused.violations, formatViolations(refused.violations)).toEqual([]);

      await page.getByTestId('btn-quick-seed-back-to-confirm').click();
      await expect(page.getByTestId('quick-seed-checkpoint-first-toggle')).toBeChecked();
    });

    test('the results name it, pass axe, and open the preview of a rewind to it', async ({
      page,
    }) => {
      const bridge = await openQuickSeed(page, theme);
      await page.getByTestId('quick-seed-checkpoint-first-toggle').check();
      await page.getByTestId('btn-quick-seed-start').click();
      const run = await bridge.waitForMessage('seed:execute', { timeout: 10_000 });
      await sendExtensionMessage(page, {
        type: 'seed:execute:response',
        id: 'answer',
        correlationId: String(run.id),
        payload: {
          templateId: 'prebuilt-sales-cloud-starter',
          operationId: String(run.id),
          status: 'success',
          objectResults: [
            {
              objectApiName: 'Account',
              recordsCreated: 40,
              recordsFailed: 0,
              createdIds: [],
              errors: [],
            },
          ],
          totalRecordsCreated: 40,
          totalRecordsFailed: 0,
          duration: 1000,
          timestamp: '2026-11-01T10:15:30.000Z',
          checkpoint: { ...TAKEN, name: 'Before Seed run 2026-11-01 10:15 UTC' },
        },
      });

      await expect(page.getByTestId('quick-seed-result-checkpoint')).toContainText(
        'Before Seed run 2026-11-01 10:15 UTC',
      );
      const results = await checkAccessibility(page);
      expect(results.violations, formatViolations(results.violations)).toEqual([]);

      await page.getByTestId('quick-seed-result-checkpoint-action').click();
      await expect(page.getByTestId('checkpoint-page')).toBeVisible();
    });
  });
}

test('Quick Sync offers it beside Go and sends it with the run', async ({ page }) => {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await paintHostTheme(page, 'Dark 2026');
  await page.addInitScript(() => {
    const host = window as unknown as {
      acquireVsCodeApi: () => { setState: (state: unknown) => void };
      __SANDFORGE_MODULE__?: string;
    };
    host.acquireVsCodeApi().setState({
      quickSyncDraft: {
        sourceOrgId: 'org-src-1',
        targetOrgId: 'org-tgt-1',
        selectedObjects: ['Account'],
        parentObjects: [],
      },
      quickSyncStep: 'preview',
      quickSyncPreview: {
        objects: [
          {
            objectApiName: 'Account',
            recordCount: 12,
            estimatedApiCalls: 1,
            isParentDependency: false,
          },
        ],
        totalRecords: 12,
        totalApiCalls: 1,
        estimatedDurationSec: 5,
      },
    });
    host.__SANDFORGE_MODULE__ = 'sync';
  });
  await page.goto('/');
  await bridge.seedOrgs(MOCK_ORGS);
  await page.getByTestId('quick-sync-start-btn').click();
  await expect(page.getByTestId('quick-sync-checkpoint-first')).toBeVisible();
  const results = await checkAccessibility(page);
  expect(results.violations, formatViolations(results.violations)).toEqual([]);

  await page.getByTestId('quick-sync-checkpoint-first-toggle').check();
  await page.getByTestId('quick-sync-go-btn').click();
  const prepare = await bridge.waitForMessage('quicksync:execute', { timeout: 10_000 });
  await sendExtensionMessage(page, {
    type: 'quicksync:execute:response',
    id: 'prepared',
    correlationId: String(prepare.id),
    payload: { syncConfig: { id: 'cfg' }, objectCount: 1 },
  });
  const run = await bridge.waitForMessage('sync:execute', { timeout: 10_000 });
  expect((run.payload as { checkpointFirst?: unknown }).checkpointFirst).toEqual({});
});

test('the wizard says what Confirm does on its last step, and nothing beside a refusal', async ({
  page,
}) => {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await paintHostTheme(page, 'Light 2026');
  await page.addInitScript(() => {
    const host = window as unknown as {
      acquireVsCodeApi: () => { setState: (state: unknown) => void };
      __SANDFORGE_MODULE__?: string;
    };
    host.acquireVsCodeApi().setState({
      seedDraft: {
        currentStep: 3,
        selectedOrgId: 'org-src-1',
        selectedObjects: ['Account'],
        volumes: { Account: { count: 5, batchSize: 200 } },
      },
    });
    host.__SANDFORGE_MODULE__ = 'seed';
  });
  await page.goto('/');
  await bridge.seedOrgs(MOCK_ORGS);
  await page.getByTestId('mode-card-generate').click();
  await expect(page.getByTestId('seed-results-waiting')).toHaveText(
    'Nothing has been written yet: Confirm starts the seed.',
  );
  await expect(page.getByText('No data available')).toHaveCount(0);
});
