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
 * template down to id/name/description/category/author. The steps only cross
 * the bridge on install, which is what {@link INSTALLED_PIPELINE} stands in for.
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
    history?: unknown[];
    templates?: unknown[];
  } = {},
): Promise<void> {
  await respondToAll(page, 'pipeline:list', 'pipeline:list:response', {
    pipelines: options.pipelines ?? [],
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
      'Build and automate your Salesforce workflows',
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
    await expect(page.getByTestId('page-header-subtitle')).toHaveText('New Pipeline v1 · 0 Steps');
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
    // The scheduler ships disabled and says so; asserting the badge keeps a
    // silent re-enable from passing as "still coming soon".
    await expect(page.getByTestId('scheduler-coming-soon')).toBeVisible();

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
    await expect(page.getByTestId('saved-pipeline-pipe-1')).toContainText('3 Steps');
    await expect(page.getByTestId('saved-pipeline-pipe-2')).toContainText('Weekly Backup');
    await expect(page.getByTestId('saved-pipeline-pipe-2')).toContainText('v2');
    await expect(page.getByTestId('saved-pipeline-pipe-2')).toContainText('1 Steps');
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
    await expect(page.getByTestId('page-header-subtitle')).toHaveText('Nightly Sync v1 · 3 Steps');
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

    await page.getByTestId('palette-seed').click();
    await expect(canvasSteps(page)).toHaveCount(1);
    await expect(page.getByTestId('pipeline-canvas')).toContainText('seed');
    await expect(kpiValues(page).nth(0)).toHaveText('1');

    await page.getByTestId('palette-anonymize').click();
    await expect(canvasSteps(page)).toHaveCount(2);
    await expect(kpiValues(page).nth(0)).toHaveText('2');

    const firstStepId = await canvasSteps(page).first().getAttribute('data-testid');
    await page.getByTestId(`remove-step-${firstStepId?.replace('canvas-step-', '') ?? ''}`).click();
    await expect(canvasSteps(page)).toHaveCount(1);
    await expect(kpiValues(page).nth(0)).toHaveText('1');
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

test.describe('Automation page — bridge round trips', () => {
  test('save sends the pipeline and only announces success once the host acknowledges', async ({
    page,
  }) => {
    await openAutomation(page);
    await answerMountQueries(page);
    await page.getByTestId('create-pipeline-btn').click();
    await page.getByTestId('palette-seed').click();

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
      'Anonymised nightly refresh v1 · 2 Steps',
    );
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
