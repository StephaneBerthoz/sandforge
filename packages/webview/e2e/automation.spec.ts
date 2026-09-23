import { test, expect, type Page } from '@playwright/test';
import { MockBridge } from './helpers';
import { MOCK_ORGS } from './fixtures';
import { sendExtensionMessage } from './mocks/vscode-api';

/**
 * Automation E2E.
 *
 * The panel is booted directly (`__SANDFORGE_MODULE__ = 'automation'`) because
 * that is how the extension opens it — there has been no in-app navigation
 * sidebar since 1.8.0, and the five `getByTestId('sidebar')` clicks this file
 * used to open with are why every one of its tests failed before reaching a
 * single assertion about the page.
 *
 * Everything the page shows comes off the bridge. `useAutomationPageData`
 * fires four queries the moment the page mounts — `pipeline:list`,
 * `pipeline:templates`, `pipeline:history`, `marketplace:list` — and each one
 * is correlated by message id: `useMessageResponse` drops any response whose
 * `correlationId` is not the id of the request still in flight. Under React
 * StrictMode the mount effect runs twice, so there are two ids per channel and
 * only the second is live; {@link respondToAll} answers both rather than
 * guessing.
 */

/** Boot the app straight into the Automation panel. */
async function openAutomation(
  page: Page,
  orgs: readonly unknown[] = MOCK_ORGS,
): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'automation';
  });
  await page.goto('/');
  await bridge.seedOrgs(orgs);
  return bridge;
}

/** Every outgoing message of a type, unwrapped from the protocol envelope. */
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

/** Wait until at least one request of `type` has been posted, then return them all. */
async function waitForOutgoing(page: Page, type: string): Promise<Record<string, unknown>[]> {
  await page.waitForFunction(
    (msgType) => {
      const msgs = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
      return msgs.some((m) => {
        const e = m as Record<string, unknown>;
        const inner = (e.payload as Record<string, unknown> | undefined) ?? e;
        return inner.type === msgType;
      });
    },
    type,
    { timeout: 10_000 },
  );
  return outgoing(page, type);
}

/**
 * Answer *every* pending request of a type, not just the last.
 *
 * StrictMode's double mount leaves two ids per query channel; a retry leaves
 * the failed attempt on record next to the live one. Responses carrying a
 * stale correlationId are ignored by the hook, so answering all of them is
 * always safe and never leaves the live request hanging.
 */
async function respondToAll(
  page: Page,
  requestType: string,
  responseType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const requests = await waitForOutgoing(page, requestType);
  for (const request of requests) {
    const correlationId = request.id as string;
    await sendExtensionMessage(page, {
      type: responseType,
      id: `resp-${correlationId}`,
      correlationId,
      payload,
    });
  }
}

/** Saved pipelines as `pipeline:list:response` carries them. */
const SAVED_PIPELINES = [
  {
    id: 'pipe-1',
    name: 'Nightly Sync',
    description: 'Refresh the QA sandbox every night',
    version: 1,
    steps: [
      { id: 'step-1', name: 'Query Accounts', type: 'sync', config: {}, continueOnError: false },
      { id: 'step-2', name: 'Mask PII', type: 'anonymize', config: {}, continueOnError: false },
      { id: 'step-3', name: 'Load Target', type: 'seed', config: {}, continueOnError: false },
    ],
    triggers: [{ id: 'trig-1', type: 'schedule', enabled: true, config: { cron: '0 2 * * *' } }],
    variables: [],
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  },
  {
    id: 'pipe-2',
    name: 'Weekly Backup',
    description: 'Full backup before the release window',
    version: 2,
    steps: [
      { id: 'step-a', name: 'Full Backup', type: 'backup', config: {}, continueOnError: false },
    ],
    triggers: [],
    variables: [],
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
  },
];

/** History entries as `pipeline:history:response` carries them. */
const HISTORY_ENTRIES = [
  {
    runId: 'run-1',
    pipelineId: 'pipe-1',
    pipelineName: 'Nightly Sync',
    status: 'completed',
    triggeredBy: 'schedule',
    startTime: '2026-02-01T02:00:00.000Z',
    duration: 42_000,
    stepCount: 3,
    errorCount: 0,
  },
  {
    runId: 'run-2',
    pipelineId: 'pipe-2',
    pipelineName: 'Weekly Backup',
    status: 'failed',
    triggeredBy: 'manual',
    startTime: '2026-02-02T09:00:00.000Z',
    duration: 8_000,
    stepCount: 1,
    errorCount: 2,
  },
];

/**
 * Marketplace templates as `marketplace:list:response` carries them.
 *
 * The list channel deliberately carries no steps — the handler projects each
 * template down to id/name/description/category/author, plus the type of each
 * step so a card can say which cannot run (left out here: the page must cope
 * without it). The steps only cross the bridge on install, which is what
 * {@link INSTALLED_PIPELINE} stands in for.
 */
const MARKETPLACE_TEMPLATES = [
  {
    id: 'mkt-1',
    name: 'Standard Data Refresh',
    description: 'Query, transform and load standard objects between orgs',
    category: 'ETL',
    author: 'SandForge',
  },
  {
    id: 'mkt-2',
    name: 'GDPR Cleanup Pipeline',
    description: 'Automated anonymization and cleanup for GDPR compliance',
    category: 'Compliance',
    author: 'SandForge',
  },
];

/** A sync schedule as `sync:schedule:list:response` carries it, next run tomorrow. */
const SYNC_SCHEDULE = {
  id: 'sched-1',
  name: 'Nightly accounts',
  configId: 'cfg-1',
  cron: '0 2 * * *',
  timezone: 'UTC',
  enabled: true,
  maxRetries: 3,
  notifyOnComplete: false,
  notifyOnFailure: true,
  nextRunAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
  lastRunAt: new Date(Date.now() - 60 * 60_000).toISOString(),
  lastResult: 'success',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  version: 1,
};

/** Pipeline `marketplace:install:response` hands back for `mkt-1`. */
const INSTALLED_PIPELINE = {
  name: 'Standard Data Refresh',
  description: 'Query, transform and load standard objects between orgs',
  steps: [
    { name: 'Query Source', type: 'sync', config: {} },
    { name: 'Apply Transforms', type: 'anonymize', config: {} },
    { name: 'Load Target', type: 'seed', config: {} },
  ],
  schedule: '0 3 * * *',
};

/** Pipeline `ai:generate-pipeline:response` hands back. */
const GENERATED_PIPELINE = {
  name: 'Anonymised nightly refresh',
  description: 'Generated from a prompt',
  steps: [
    { name: 'Pull Accounts', type: 'sync', config: {} },
    { name: 'Scrub emails', type: 'anonymize', config: {} },
  ],
};

/** Steps currently drawn on the canvas. */
function canvasSteps(page: Page) {
  return page.locator('[data-testid^="canvas-step-"]');
}

/** The three KPI values, in render order: steps, triggers, history runs. */
function kpiValues(page: Page) {
  return page.getByTestId('automation-kpi-row').getByTestId('kpi-value');
}

/** Answer the four queries the page fires on mount, so nothing is left waiting. */
async function answerMountQueries(
  page: Page,
  options: {
    pipelines?: unknown[];
    /** What the extension says each saved schedule and sandbox refresh trigger will do. */
    triggers?: unknown[];
    history?: unknown[];
    templates?: unknown[];
  } = {},
): Promise<void> {
  await respondToAll(page, 'pipeline:list', 'pipeline:list:response', {
    pipelines: options.pipelines ?? [],
    triggers: options.triggers ?? [],
  });
  await respondToAll(page, 'pipeline:history', 'pipeline:history:response', {
    history: options.history ?? [],
  });
  await respondToAll(page, 'pipeline:templates', 'pipeline:templates:response', {
    templates: options.templates ?? [],
  });
}

test.describe('Automation panel — boot', () => {
  test('renders the empty state, not the page, when no org is connected', async ({ page }) => {
    await openAutomation(page, []);

    await expect(page.getByTestId('empty-state')).toBeVisible();
    await expect(page.getByTestId('empty-state')).toContainText('Build Your First Pipeline');
    await expect(page.getByTestId('empty-action-button')).toHaveText('Select an Org');
    await expect(page.getByTestId('automation-page')).toHaveCount(0);
  });

  test('renders the automation panel when the host opens the module', async ({ page }) => {
    await openAutomation(page);

    await expect(page.getByTestId('automation-page')).toBeVisible();
    await expect(page.getByTestId('page-header')).toContainText('Automation');
    await expect(page.getByTestId('page-header-subtitle')).toHaveText(
      'Compose and save multi-step pipelines',
    );
    await expect(page.getByTestId('automation-content')).toBeVisible();
  });
});

test.describe('Automation page — header and KPIs', () => {
  test('KPI row reports zero steps, triggers and runs before a pipeline exists', async ({
    page,
  }) => {
    await openAutomation(page);
    await answerMountQueries(page);

    await expect(page.getByTestId('automation-kpi-row')).toBeVisible();
    await expect(kpiValues(page)).toHaveText(['0', '0', '0']);
  });

  test('history KPI counts the runs the host returned', async ({ page }) => {
    await openAutomation(page);
    await answerMountQueries(page, { history: HISTORY_ENTRIES });

    await expect(kpiValues(page).nth(2)).toHaveText('2');
  });

  test('create is the only pipeline action until a pipeline exists', async ({ page }) => {
    await openAutomation(page);
    await answerMountQueries(page);

    await expect(page.getByTestId('create-pipeline-btn')).toBeVisible();
    await expect(page.getByTestId('save-pipeline-btn')).toHaveCount(0);
    await expect(page.getByTestId('run-pipeline-btn')).toHaveCount(0);
  });

  test('creating a pipeline swaps create for save and run, and names it in the subtitle', async ({
    page,
  }) => {
    await openAutomation(page);
    await answerMountQueries(page);

    await page.getByTestId('create-pipeline-btn').click();

    await expect(page.getByTestId('save-pipeline-btn')).toBeVisible();
    await expect(page.getByTestId('run-pipeline-btn')).toBeVisible();
    await expect(page.getByTestId('create-pipeline-btn')).toHaveCount(0);
    await expect(page.getByTestId('page-header-subtitle')).toHaveText('New Pipeline v1 · 0 steps');
  });
});

test.describe('Automation page — tabs', () => {
  test('exposes the five module tabs', async ({ page }) => {
    await openAutomation(page);
    await answerMountQueries(page);

    const tabs = page.getByTestId('page-tabs').getByRole('tab');
    await expect(tabs).toHaveText([
      'Pipeline Canvas',
      'Triggers',
      'Scheduler',
      'History',
      'Marketplace',
    ]);
    await expect(page.getByTestId('page-tab-canvas')).toHaveAttribute('aria-selected', 'true');
  });

  test('each tab renders its own panel', async ({ page }) => {
    await openAutomation(page);
    await answerMountQueries(page, { history: HISTORY_ENTRIES });
    await respondToAll(page, 'marketplace:list', 'marketplace:list:response', {
      success: true,
      templates: MARKETPLACE_TEMPLATES,
    });

    await expect(page.getByTestId('pipeline-canvas')).toBeVisible();

    await page.getByTestId('page-tab-triggers').click();
    await expect(page.getByTestId('trigger-config')).toBeVisible();
    await expect(page.getByTestId('pipeline-canvas')).toHaveCount(0);

    await page.getByTestId('page-tab-scheduler').click();
    await expect(page.getByTestId('scheduler-calendar')).toBeVisible();
    // The calendar is the sync schedules: it asks the host for them and lays
    // out what it answers, where a "Coming soon" badge used to sit.
    await respondToAll(page, 'sync:schedule:list', 'sync:schedule:list:response', {
      schedules: [SYNC_SCHEDULE],
    });
    await expect(page.getByTestId('scheduler-entry-sched-1')).toContainText('Nightly accounts');
    await expect(page.getByTestId('scheduler-coming-soon')).toHaveCount(0);

    await page.getByTestId('page-tab-history').click();
    await expect(page.getByTestId('history-run-1')).toContainText('Nightly Sync');
    await expect(page.getByTestId('history-run-2')).toContainText('Weekly Backup');

    await page.getByTestId('page-tab-marketplace').click();
    await expect(page.getByTestId('marketplace-content')).toBeVisible();
    await expect(page.getByTestId('page-tab-marketplace')).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('Automation page — saved pipelines', () => {
  test('shows the loading skeleton until pipeline:list answers', async ({ page }) => {
    await openAutomation(page);

    await expect(page.getByTestId('automation-loading')).toBeVisible();
    await expect(page.getByTestId('saved-pipelines')).toHaveCount(0);

    await respondToAll(page, 'pipeline:list', 'pipeline:list:response', {
      pipelines: SAVED_PIPELINES,
    });

    await expect(page.getByTestId('automation-loading')).toHaveCount(0);
    await expect(page.getByTestId('saved-pipelines')).toBeVisible();
  });

  test('lists every saved pipeline the host returned, with its version and step count', async ({
    page,
  }) => {
    await openAutomation(page);
    await answerMountQueries(page, { pipelines: SAVED_PIPELINES });

    await expect(page.getByTestId('saved-pipeline-pipe-1')).toContainText('Nightly Sync');
    await expect(page.getByTestId('saved-pipeline-pipe-1')).toContainText('v1');
    await expect(page.getByTestId('saved-pipeline-pipe-1')).toContainText('3 steps');
    await expect(page.getByTestId('saved-pipeline-pipe-2')).toContainText('Weekly Backup');
    await expect(page.getByTestId('saved-pipeline-pipe-2')).toContainText('v2');
    await expect(page.getByTestId('saved-pipeline-pipe-2')).toContainText('1 step');
  });

  test('loading a saved pipeline puts its steps on the canvas and counts them', async ({
    page,
  }) => {
    await openAutomation(page);
    await answerMountQueries(page, { pipelines: SAVED_PIPELINES });

    await page.getByTestId('saved-pipeline-pipe-1').click();

    await expect(page.getByTestId('save-pipeline-btn')).toBeVisible();
    await expect(page.getByTestId('run-pipeline-btn')).toBeVisible();
    // The chooser is gone: a pipeline is active, so the list no longer renders.
    await expect(page.getByTestId('saved-pipelines')).toHaveCount(0);

    await expect(page.getByTestId('canvas-step-step-1')).toContainText('Query Accounts');
    await expect(page.getByTestId('canvas-step-step-2')).toContainText('Mask PII');
    await expect(page.getByTestId('canvas-step-step-3')).toContainText('Load Target');
    await expect(kpiValues(page)).toHaveText(['3', '1', '0']);
    await expect(page.getByTestId('page-header-subtitle')).toHaveText('Nightly Sync v1 · 3 steps');
  });

  test('a saved pipeline holding steps that cannot run is marked, and cannot be run', async ({
    page,
  }) => {
    await openAutomation(page);
    await answerMountQueries(page, { pipelines: SAVED_PIPELINES });

    await expect(page.getByTestId('saved-pipeline-blocked-pipe-1')).toHaveText('Cannot run');
    await page.getByTestId('saved-pipeline-pipe-1').click();

    await expect(page.getByTestId('run-pipeline-btn')).toBeDisabled();
    const notice = page.getByTestId('pipeline-blocked');
    await expect(notice).toContainText('This pipeline cannot run.');
    await expect(page.getByTestId('pipeline-blocked-step-1')).toHaveText(
      'Query Accounts (Sync) — This step writes to an org, so a pipeline does not run it: ' +
        'run it from its own page, where Production Guard asks before a write to a production org.',
    );
    await expect(page.locator('[data-testid^="canvas-blocked-"]')).toHaveCount(3);

    // Nothing reaches the host: the extension would only refuse it.
    await page.getByTestId('run-pipeline-btn').click({ force: true });
    expect(await outgoing(page, 'pipeline:execute')).toHaveLength(0);
  });
});

test.describe('Automation page — canvas editing', () => {
  test('a palette step lands on the canvas, and removing it takes it back off', async ({
    page,
  }) => {
    await openAutomation(page);
    await answerMountQueries(page);
    await page.getByTestId('create-pipeline-btn').click();

    await expect(canvasSteps(page)).toHaveCount(0);

    await page.getByTestId('palette-delay').click();
    await expect(canvasSteps(page)).toHaveCount(1);
    await expect(page.getByTestId('pipeline-canvas')).toContainText('delay');
    await expect(kpiValues(page).nth(0)).toHaveText('1');

    await page.getByTestId('palette-delay').click();
    await expect(canvasSteps(page)).toHaveCount(2);
    await expect(kpiValues(page).nth(0)).toHaveText('2');

    const firstStepId = await canvasSteps(page).first().getAttribute('data-testid');
    await page.getByTestId(`remove-step-${firstStepId?.replace('canvas-step-', '') ?? ''}`).click();
    await expect(canvasSteps(page)).toHaveCount(1);
    await expect(kpiValues(page).nth(0)).toHaveText('1');
  });

  test('a step is selected and removed from the keyboard', async ({ page }) => {
    await openAutomation(page);
    await answerMountQueries(page);
    await page.getByTestId('create-pipeline-btn').click();
    await page.getByTestId('palette-delay').click();
    await page.getByTestId('palette-delay').click();
    await expect(canvasSteps(page)).toHaveCount(2);

    // Enter on the step selects it, and its config panel opens.
    const first = canvasSteps(page).first();
    await first.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('step-config-panel')).toBeVisible();
    await expect(first).toHaveAttribute('aria-current', 'true');

    // Space selects too: the step is a button of its own now, not a div that
    // listened for Enter.
    const second = canvasSteps(page).nth(1);
    await second.focus();
    await page.keyboard.press('Space');
    await expect(second).toHaveAttribute('aria-current', 'true');
    await expect(first).not.toHaveAttribute('aria-current', 'true');

    // The remove button is the next stop after the step it removes.
    const secondId = (await second.getAttribute('data-testid'))?.replace('canvas-step-', '') ?? '';
    await page.keyboard.press('Tab');
    await expect(page.getByTestId(`remove-step-${secondId}`)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(canvasSteps(page)).toHaveCount(1);
    await expect(page.getByTestId(`canvas-step-${secondId}`)).toHaveCount(0);
  });

  test('a step type that cannot run is disabled in the palette, and says why', async ({ page }) => {
    await openAutomation(page);
    await answerMountQueries(page);
    await page.getByTestId('create-pipeline-btn').click();

    await expect(page.getByTestId('palette-runnable-note')).toContainText(
      'Steps that write to an org — Seed, Sync, Restore, Anonymize, Delete — run only from their own pages',
    );
    for (const type of ['seed', 'sync', 'delete', 'script', 'condition']) {
      await expect(page.getByTestId(`palette-${type}`)).toBeDisabled();
    }
    for (const type of ['backup', 'compare', 'precheck', 'notification']) {
      await expect(page.getByTestId(`palette-${type}`)).toBeEnabled();
    }
    await expect(page.getByTestId('palette-seed')).toHaveAttribute(
      'title',
      'This step writes to an org, so a pipeline does not run it: run it from its own page, ' +
        'where Production Guard asks before a write to a production org.',
    );

    await page.getByTestId('palette-seed').click({ force: true });
    await expect(canvasSteps(page)).toHaveCount(0);
  });

  test('a Delay step runs once its seconds are set, and a failed run says why', async ({
    page,
  }) => {
    await openAutomation(page);
    await answerMountQueries(page);
    await page.getByTestId('create-pipeline-btn').click();
    await page.getByTestId('palette-delay').click();

    await expect(page.getByTestId('run-pipeline-btn')).toBeDisabled();
    await expect(page.getByTestId('pipeline-blocked')).toContainText(
      'Set how many seconds this Delay step waits',
    );

    await canvasSteps(page).first().click();
    await page.getByTestId('config-seconds').fill('2');
    await expect(page.getByTestId('pipeline-blocked')).toHaveCount(0);
    await page.getByTestId('run-pipeline-btn').click();

    const runs = await waitForOutgoing(page, 'pipeline:execute');
    expect(runs).toHaveLength(1);
    const sent = (runs[0].payload as { pipeline: { steps: Array<Record<string, unknown>> } })
      .pipeline.steps;
    expect(sent).toEqual([expect.objectContaining({ type: 'delay', config: { seconds: 2 } })]);

    await respondToAll(page, 'pipeline:execute', 'pipeline:run:response', {
      id: 'run-9',
      status: 'failed',
      error: 'Step execution timed out',
      stepResults: [{ stepId: 'x', stepType: 'delay', status: 'failed' }],
    });
    await expect(page.getByTestId('automation-error')).toContainText(
      'The pipeline run failed: Step execution timed out',
    );
  });

  test('a Backup step runs once its org and objects are set, follows the run, and can be cancelled', async ({
    page,
  }) => {
    await openAutomation(page);
    await answerMountQueries(page);
    await page.getByTestId('create-pipeline-btn').click();
    await page.getByTestId('palette-backup').click();

    await expect(page.getByTestId('run-pipeline-btn')).toBeDisabled();
    await expect(page.getByTestId('pipeline-blocked')).toContainText(
      'Choose the org this step works on.',
    );

    await canvasSteps(page).first().click();
    const orgId = (MOCK_ORGS[0] as { id: string }).id;
    await page.getByTestId('config-orgId').selectOption(orgId);
    await page.getByTestId('config-objects').fill('Account, Contact');
    await expect(page.getByTestId('pipeline-blocked')).toHaveCount(0);
    await page.getByTestId('run-pipeline-btn').click();

    const runs = await waitForOutgoing(page, 'pipeline:execute');
    const request = runs[runs.length - 1];
    const sent = (request.payload as { pipeline: { steps: Array<Record<string, unknown>> } })
      .pipeline.steps;
    expect(sent).toEqual([
      expect.objectContaining({
        type: 'backup',
        config: { orgId, objects: ['Account', 'Contact'] },
      }),
    ]);

    // The host reports the step as it goes, under the id of the request.
    const stepId = sent[0].id as string;
    await sendExtensionMessage(page, {
      type: 'pipeline:step',
      id: 'step-running',
      payload: { operationId: request.id, stepId, status: 'running' },
    });
    await expect(page.getByTestId(`exec-step-status-${stepId}`)).toHaveText('Running');

    await page.getByTestId('execution-cancel').click();
    const aborts = await waitForOutgoing(page, 'execution:abort');
    expect(aborts).toEqual([expect.objectContaining({ payload: { operationId: request.id } })]);
  });

  test('selecting a step opens its config panel and renaming it redraws the canvas', async ({
    page,
  }) => {
    await openAutomation(page);
    await answerMountQueries(page, { pipelines: SAVED_PIPELINES });
    await page.getByTestId('saved-pipeline-pipe-1').click();

    await expect(page.getByTestId('step-config-empty')).toBeVisible();

    await page.getByTestId('canvas-step-step-2').click();
    await expect(page.getByTestId('step-config-panel')).toBeVisible();
    await expect(page.getByTestId('step-name-input')).toHaveValue('Mask PII');

    await page.getByTestId('step-name-input').fill('Scrub PII');
    await expect(page.getByTestId('canvas-step-step-2')).toContainText('Scrub PII');
  });

  test('adding a schedule trigger counts it and exposes its cron field', async ({ page }) => {
    await openAutomation(page);
    await answerMountQueries(page);
    await page.getByTestId('create-pipeline-btn').click();

    await page.getByTestId('page-tab-triggers').click();
    await page.getByTestId('trigger-type-select').selectOption('schedule');
    await page.getByTestId('add-trigger-btn').click();

    await expect(page.getByTestId('trigger-config')).toContainText('Schedule');
    await expect(kpiValues(page).nth(1)).toHaveText('1');

    // The cron row only exists for a schedule trigger — one input, and it is
    // the one the panel just created.
    const cronInput = page.locator('[data-testid^="cron-input-"]');
    await expect(cronInput).toHaveCount(1);
    await cronInput.fill('0 4 * * *');
    await expect(cronInput).toHaveValue('0 4 * * *');

    const removeTrigger = page.locator('[data-testid^="remove-trigger-"]');
    await expect(removeTrigger).toHaveCount(1);
    await removeTrigger.click();
    await expect(kpiValues(page).nth(1)).toHaveText('0');
    await expect(page.locator('[data-testid^="cron-input-"]')).toHaveCount(0);
  });
});

test.describe('Automation page — triggers', () => {
  /** A saved pipeline every step of which can run, started by a schedule and by a refresh. */
  const TRIGGERED_PIPELINE = {
    id: 'pipe-3',
    name: 'Nightly compare',
    description: '',
    version: 1,
    steps: [
      { id: 'step-w', name: 'Wait', type: 'delay', config: { seconds: 0 }, continueOnError: false },
    ],
    triggers: [
      {
        id: 'trig-s',
        type: 'schedule',
        enabled: true,
        config: { cron: '0 2 * * *', timezone: 'UTC' },
      },
      { id: 'trig-r', type: 'sandbox_refresh', enabled: true, config: { orgId: 'org-src-1' } },
    ],
    variables: [],
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };

  /** What the extension says of those two triggers. */
  const STATUSES = [
    {
      pipelineId: 'pipe-3',
      triggerId: 'trig-s',
      type: 'schedule',
      armed: true,
      timezone: 'UTC',
      nextRunAt: '2026-09-24T02:00:00.000Z',
      lastFiredAt: '2026-09-23T02:00:00.000Z',
      lastOutcome: 'started',
    },
    { pipelineId: 'pipe-3', triggerId: 'trig-r', type: 'sandbox_refresh', armed: true },
  ];

  test('shows the next run of a saved schedule, and the sandbox a refresh trigger waits for', async ({
    page,
  }) => {
    await openAutomation(page);
    await answerMountQueries(page, { pipelines: [TRIGGERED_PIPELINE], triggers: STATUSES });
    await page.getByTestId('saved-pipeline-pipe-3').click();
    await page.getByTestId('page-tab-triggers').click();

    await expect(page.getByTestId('trigger-next-run-trig-s')).toContainText('(UTC)');
    await expect(page.getByTestId('trigger-last-trig-s')).toContainText('Last started');
    await expect(page.getByTestId('trigger-armed-trig-r')).toHaveText(
      'Watching for a refresh of DevSandbox.',
    );
    // Neither of them is coming soon: both start runs.
    await expect(page.locator('[data-testid^="trigger-coming-soon-"]')).toHaveCount(0);

    // An edit waits for the save: the next run shown is the saved one's, so it goes.
    await page.getByTestId('cron-input-trig-s').fill('30 3 * * *');
    await expect(page.getByTestId('trigger-unsaved-trig-s')).toBeVisible();
    await expect(page.getByTestId('trigger-next-run-trig-s')).toHaveCount(0);
  });

  test('lists the pipeline schedules on the Scheduler tab, with their next run', async ({
    page,
  }) => {
    await openAutomation(page);
    await answerMountQueries(page, { pipelines: [TRIGGERED_PIPELINE], triggers: STATUSES });
    await page.getByTestId('page-tab-scheduler').click();
    await respondToAll(page, 'sync:schedule:list', 'sync:schedule:list:response', {
      schedules: [],
    });

    const row = page.getByTestId('scheduler-pipeline-pipe-3-trig-s');
    await expect(row).toContainText('Nightly compare');
    await expect(row).toContainText('0 2 * * *');
    await expect(row).toContainText('Next run:');
  });

  test('asks for the history again when a run a trigger started ends', async ({ page }) => {
    await openAutomation(page);
    await answerMountQueries(page);
    const before = (await outgoing(page, 'pipeline:history')).length;

    await sendExtensionMessage(page, {
      type: 'operation:completed',
      id: 'ext-op-1',
      payload: { operationId: 'pipeline:trigger:6f1c', result: { status: 'completed' } },
    });

    await expect
      .poll(async () => (await outgoing(page, 'pipeline:history')).length)
      .toBeGreaterThan(before);
  });
});

test.describe('Automation page — bridge round trips', () => {
  test('save sends the pipeline and only announces success once the host acknowledges', async ({
    page,
  }) => {
    await openAutomation(page);
    await answerMountQueries(page);
    await page.getByTestId('create-pipeline-btn').click();
    await page.getByTestId('palette-delay').click();

    await page.getByTestId('save-pipeline-btn').click();

    const saves = await waitForOutgoing(page, 'pipeline:save');
    expect(saves).toHaveLength(1);
    const savePayload = saves[0].payload as Record<string, unknown>;
    expect(typeof savePayload.id).toBe('string');
    const savedConfig = savePayload.config as Record<string, unknown>;
    expect(savedConfig.name).toBe('New Pipeline');
    expect((savedConfig.steps as unknown[]).length).toBe(1);

    // Nothing is claimed before the answer arrives.
    await expect(page.getByTestId('floating-toasts')).not.toContainText(
      'Pipeline saved successfully',
    );

    await respondToAll(page, 'pipeline:save', 'pipeline:save:response', {
      success: true,
      id: savePayload.id as string,
    });

    await expect(page.getByTestId('floating-toasts')).toContainText('Pipeline saved successfully');
  });

  test('generate sends the typed description and draws the pipeline the host returns', async ({
    page,
  }) => {
    await openAutomation(page);
    await answerMountQueries(page);

    await page.getByTestId('generate-pipeline-btn').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await dialog.getByRole('textbox').fill('nightly refresh with anonymised contacts');
    await dialog.getByRole('button', { name: 'Generate with AI' }).click();
    await expect(dialog).toHaveCount(0);

    const requests = await waitForOutgoing(page, 'ai:generate-pipeline');
    expect(requests).toHaveLength(1);
    expect((requests[0].payload as Record<string, unknown>).description).toBe(
      'nightly refresh with anonymised contacts',
    );

    await respondToAll(page, 'ai:generate-pipeline', 'ai:generate-pipeline:response', {
      success: true,
      pipeline: GENERATED_PIPELINE,
    });

    await expect(canvasSteps(page)).toHaveCount(2);
    await expect(page.getByTestId('pipeline-canvas')).toContainText('Pull Accounts');
    await expect(page.getByTestId('pipeline-canvas')).toContainText('Scrub emails');
    await expect(page.getByTestId('page-header-subtitle')).toHaveText(
      'Anonymised nightly refresh v1 · 2 steps',
    );
    // A draft of sync and anonymize steps is drawn, marked, and not runnable.
    await expect(page.locator('[data-testid^="canvas-blocked-"]')).toHaveCount(2);
    await expect(page.getByTestId('run-pipeline-btn')).toBeDisabled();
  });

  test('a refused generation reports the reason instead of silently doing nothing', async ({
    page,
  }) => {
    await openAutomation(page);
    await answerMountQueries(page);

    await page.getByTestId('generate-pipeline-btn').click();
    await page.getByRole('dialog').getByRole('textbox').fill('anything');
    await page.getByRole('dialog').getByRole('button', { name: 'Generate with AI' }).click();

    await respondToAll(page, 'ai:generate-pipeline', 'ai:generate-pipeline:response', {
      success: false,
      error: 'No API key configured',
    });

    await expect(page.getByTestId('automation-error')).toContainText('No API key configured');
    await expect(canvasSteps(page)).toHaveCount(0);
  });
});

test.describe('Automation page — marketplace', () => {
  test('lists the templates the host returned, each with an install button', async ({ page }) => {
    await openAutomation(page);
    await answerMountQueries(page);
    await page.getByTestId('page-tab-marketplace').click();

    await expect(page.getByTestId('marketplace-loading')).toBeVisible();

    await respondToAll(page, 'marketplace:list', 'marketplace:list:response', {
      success: true,
      templates: MARKETPLACE_TEMPLATES,
    });

    await expect(page.getByTestId('marketplace-loading')).toHaveCount(0);
    await expect(page.getByTestId('marketplace-template-mkt-1')).toContainText(
      'Standard Data Refresh',
    );
    await expect(page.getByTestId('marketplace-template-mkt-1')).toContainText('ETL');
    await expect(page.getByTestId('marketplace-template-mkt-2')).toContainText(
      'GDPR Cleanup Pipeline',
    );
    await expect(page.getByTestId('install-template-mkt-1')).toBeVisible();
    await expect(page.getByTestId('install-template-mkt-2')).toBeVisible();
  });

  test('installing a template loads the exported pipeline onto the canvas', async ({ page }) => {
    await openAutomation(page);
    await answerMountQueries(page);
    await page.getByTestId('page-tab-marketplace').click();
    await respondToAll(page, 'marketplace:list', 'marketplace:list:response', {
      success: true,
      templates: MARKETPLACE_TEMPLATES,
    });

    await page.getByTestId('install-template-mkt-1').click();

    const installs = await waitForOutgoing(page, 'marketplace:install');
    expect(installs).toHaveLength(1);
    expect((installs[0].payload as Record<string, unknown>).templateId).toBe('mkt-1');

    await respondToAll(page, 'marketplace:install', 'marketplace:install:response', {
      success: true,
      pipeline: INSTALLED_PIPELINE,
    });

    // The answer, not the click, decides: the view switches to the canvas and
    // the template's steps are actually there.
    await expect(page.getByTestId('page-tab-canvas')).toHaveAttribute('aria-selected', 'true');
    await expect(canvasSteps(page)).toHaveCount(3);
    await expect(page.getByTestId('pipeline-canvas')).toContainText('Query Source');
    await expect(page.getByTestId('pipeline-canvas')).toContainText('Load Target');
    await expect(kpiValues(page).nth(1)).toHaveText('1');
    await expect(page.getByTestId('floating-toasts')).toContainText(
      'Template installed as new pipeline',
    );
    // Installed is not runnable: its sync, anonymize and seed steps are refused.
    await expect(page.getByTestId('run-pipeline-btn')).toBeDisabled();
    await expect(page.getByTestId('pipeline-blocked')).toContainText('Query Source (Sync)');
  });

  test('a card names the step types of its template that cannot run', async ({ page }) => {
    await openAutomation(page);
    await answerMountQueries(page);
    await page.getByTestId('page-tab-marketplace').click();
    await respondToAll(page, 'marketplace:list', 'marketplace:list:response', {
      success: true,
      templates: [
        { ...MARKETPLACE_TEMPLATES[0], stepTypes: ['sync', 'anonymize', 'seed', 'sync'] },
        { ...MARKETPLACE_TEMPLATES[1], stepTypes: ['delay'] },
      ],
    });

    await expect(page.getByTestId('marketplace-template-blocked-mkt-1')).toContainText(
      'Cannot run as a pipeline. These step types do not run in one: Sync, Anonymize, Seed.',
    );
    await expect(page.getByTestId('marketplace-template-blocked-mkt-2')).toHaveCount(0);
  });

  test('a refused install reports the reason and leaves the canvas empty', async ({ page }) => {
    await openAutomation(page);
    await answerMountQueries(page);
    await page.getByTestId('page-tab-marketplace').click();
    await respondToAll(page, 'marketplace:list', 'marketplace:list:response', {
      success: true,
      templates: MARKETPLACE_TEMPLATES,
    });

    await page.getByTestId('install-template-mkt-2').click();
    await respondToAll(page, 'marketplace:install', 'marketplace:install:response', {
      success: false,
      error: 'Template "mkt-2" not found.',
    });

    await expect(page.getByTestId('automation-error')).toContainText('Template "mkt-2" not found.');
    await expect(page.getByTestId('create-pipeline-btn')).toBeVisible();
  });
});

test.describe('Automation page — errors', () => {
  test('no error banner on a clean load', async ({ page }) => {
    await openAutomation(page);
    await answerMountQueries(page);

    await expect(page.getByTestId('automation-error')).toHaveCount(0);
  });

  test('a pipeline:error reaches the banner and the banner can be dismissed', async ({ page }) => {
    await openAutomation(page);

    // `pipeline:error` is the error channel of the `pipeline:list` query, and
    // it is correlated: it only counts against the request still in flight,
    // which is why it has to be sent before the list is answered.
    const requests = await waitForOutgoing(page, 'pipeline:list');
    const live = requests[requests.length - 1];
    await sendExtensionMessage(page, {
      type: 'pipeline:error',
      id: 'err-1',
      correlationId: live.id as string,
      payload: { message: 'ConfigStore unavailable' },
    });

    await expect(page.getByTestId('automation-error')).toContainText('ConfigStore unavailable');
    await expect(page.getByTestId('floating-toasts')).toContainText('ConfigStore unavailable');

    await page.getByTestId('automation-error').getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByTestId('automation-error')).toHaveCount(0);
  });
});
