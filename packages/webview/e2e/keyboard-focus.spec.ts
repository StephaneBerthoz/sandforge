import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MockBridge } from './helpers';
import { MOCK_EMPTY_ORGS, MOCK_ORGS, QA_SANDBOX } from './fixtures';
import { sendExtensionMessage } from './mocks/vscode-api';

/**
 * Where the keyboard lands, and what a screen reader is told, as a keyboard
 * user moves through the first-run path and the runs: what axe cannot see.
 * Each step is taken with keys, not clicks, and the focus is read after it.
 *
 * The controls that move a page on (a call to action, Use This, Start, a
 * palette item, Discover) are drawn away with the screen they lead from: the
 * focus they held used to fall to `<body>`, the next Tab started over at the
 * skip link, and nothing was said about the new screen.
 */

/** Boot a panel on a module, its orgs answered, motion reduced so a step is drawn at once. */
async function openModule(
  page: Page,
  moduleId: string,
  orgs: readonly unknown[] = MOCK_ORGS,
): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript((id) => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = id;
  }, moduleId);
  await page.goto('/');
  await bridge.seedOrgs(orgs);
  return bridge;
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

/** Press a control as a keyboard user does: the focus put on it, then Enter. */
async function pressWithKeyboard(page: Page, testId: string): Promise<void> {
  const control = page.getByTestId(testId);
  await control.focus();
  await page.keyboard.press('Enter');
}

/** The Seed page on its gallery, the saved templates and the earlier seeds answered. */
async function openSeedGallery(page: Page): Promise<MockBridge> {
  const bridge = await openModule(page, 'seed');
  await bridge.waitForMessage('seed:template:list', { timeout: 10_000 });
  await answerAll(page, 'seed:template:list', 'seed:template:list:response', { templates: [] });
  await bridge.waitForMessage('seed:removal:list', { timeout: 10_000 });
  await answerAll(page, 'seed:removal:list', 'seed:removal:list:response', { runs: [] });
  await page
    .getByTestId('template-card-prebuilt-minimal-demo')
    .waitFor({ state: 'visible', timeout: 10_000 });
  return bridge;
}

test.describe('Keyboard and screen reader — moving between pages', () => {
  test('a call to action that opens another page hands its heading the focus, and names it in the title', async ({
    page,
  }) => {
    await openModule(page, 'forge', MOCK_EMPTY_ORGS);
    await page.getByTestId('empty-state').waitFor({ timeout: 10_000 });

    await pressWithKeyboard(page, 'empty-action-button');

    await page.getByTestId('org-manager-page').waitFor({ timeout: 10_000 });
    const heading = page.getByRole('heading', { level: 1, name: 'Organizations' });
    await expect(heading).toBeFocused();
    await expect(page).toHaveTitle('SandForge: Organizations');
    // Reached from the keyboard, its outline is drawn.
    const outline = await heading.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe('none');
  });

  test('the command palette keeps Tab in, gives the focus back on Escape, and a page it opens takes it', async ({
    page,
  }) => {
    await openModule(page, 'home');
    await page.getByTestId('home-page').waitFor({ timeout: 10_000 });
    const opener = page.getByTestId('start-forge-btn');
    await opener.focus();

    await page.keyboard.press('Control+k');
    const palette = page.getByTestId('command-palette');
    await expect(page.getByTestId('command-palette-input')).toBeFocused();
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Tab');
      const inside = await palette.evaluate((el) => el.contains(document.activeElement));
      expect(inside, `Tab ${i + 1} left the palette`).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
    await expect(opener).toBeFocused();

    await page.keyboard.press('Control+k');
    await page.keyboard.type('Help');
    await page.keyboard.press('Enter');
    // Its chunk is compiled on first use by the dev server: given the time.
    await page.getByTestId('help-page').waitFor({ timeout: 30_000 });
    await expect(page.locator('main h1')).toBeFocused();
    await expect(page).toHaveTitle('SandForge: Help');
  });

  test('Monitor heads its skeleton, whose heading takes the focus, and its dashboard’s takes it once drawn', async ({
    page,
  }) => {
    const bridge = await openModule(page, 'home');
    await page.getByTestId('home-page').waitFor({ timeout: 10_000 });
    await page.keyboard.press('Control+k');
    await page.keyboard.type('Monitor');
    await page.keyboard.press('Enter');
    // The skeleton was headed by nothing until the first read, and the focus
    // waited on main: it now carries the page's heading, the org it watches.
    await page.getByTestId('monitor-loading').waitFor({ timeout: 30_000 });
    const skeletonHeading = page.getByTestId('monitor-loading').getByRole('heading', { level: 1 });
    await expect(skeletonHeading).toHaveText(MOCK_ORGS[0].alias);
    await expect(skeletonHeading).toBeFocused();

    await bridge.waitForMessage('monitor:refresh', { timeout: 10_000 });
    await answerAll(page, 'monitor:refresh', 'monitor:data', {
      healthScore: 85,
      healthReport: null,
      jobs: [],
      limits: [{ name: 'DailyApiRequests', max: 100000, remaining: 45000, usedPercent: 55 }],
      orgInfo: null,
      trends: {},
      lastUpdated: '2026-10-21T08:00:00Z',
    });
    await page.getByTestId('monitor-page').waitFor({ timeout: 10_000 });
    await expect(page.locator('main h1')).toBeFocused();
  });

  test('Autopilot has a heading of its own, as every module has', async ({ page }) => {
    await openModule(page, 'autopilot');
    await page.getByTestId('step1-connect').waitFor({ timeout: 10_000 });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Autopilot Setup');
  });
});

test.describe('Keyboard and screen reader — the one-click Seed', () => {
  test('Use This, Start and the run’s end each hand the focus on, and the end is said', async ({
    page,
  }) => {
    const bridge = await openSeedGallery(page);
    const useThis = page
      .getByTestId('template-card-prebuilt-minimal-demo')
      .getByTestId('btn-use-template');
    await expect(useThis).toHaveAccessibleName(/^Use This: /);

    await useThis.focus();
    await page.keyboard.press('Enter');
    await page.getByTestId('quick-seed-confirm').waitFor({ timeout: 10_000 });
    await expect(page.getByRole('heading', { name: 'Template: Minimal Demo' })).toBeFocused();

    await pressWithKeyboard(page, 'btn-quick-seed-start');
    const request = await bridge.waitForMessage('seed:execute', { timeout: 10_000 });
    await expect(page.getByRole('group', { name: 'Seeding data...' })).toBeFocused();

    await sendExtensionMessage(page, {
      type: 'seed:execute:response',
      id: 'seed-done',
      correlationId: String(request.id),
      payload: {
        templateId: 'prebuilt-minimal-demo',
        operationId: String(request.id),
        status: 'success',
        objectResults: [
          {
            objectApiName: 'Account',
            recordsCreated: 10,
            recordsFailed: 0,
            createdIds: ['001000000000001AAA'],
            errors: [],
          },
        ],
        totalRecordsCreated: 10,
        totalRecordsFailed: 0,
        duration: 1200,
        timestamp: '2026-10-21T08:00:00.000Z',
      },
    });
    await expect(page.getByTestId('quick-seed-result-summary')).toBeFocused();
    await expect(page.getByTestId('quick-seed-result-status')).toHaveText(
      /^Seed Complete\. Written: 10 of \d+\.$/,
    );
  });

  test('Back from the confirmation hands the focus to the card it was picked from', async ({
    page,
  }) => {
    await openSeedGallery(page);
    await page
      .getByTestId('template-card-prebuilt-minimal-demo')
      .getByTestId('btn-use-template')
      .focus();
    await page.keyboard.press('Enter');
    await page.getByTestId('quick-seed-confirm').waitFor({ timeout: 10_000 });

    await pressWithKeyboard(page, 'btn-quick-seed-back');

    await expect(
      page.getByTestId('template-card-prebuilt-minimal-demo').getByTestId('btn-use-template'),
    ).toBeFocused();
  });
});

test.describe('Keyboard and screen reader — the org pickers', () => {
  test('Forge’s target picker opens on the arrow, walks with it, and a pick hands the focus back', async ({
    page,
  }) => {
    await openModule(page, 'forge');
    await page.getByTestId('forge-page').waitFor({ timeout: 10_000 });
    const trigger = page.getByTestId('forge-target-org');
    await trigger.focus();

    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('forge-target-org-panel')).toBeVisible();
    await page.keyboard.press('End');
    await expect(page.getByTestId(`forge-target-org-option-${QA_SANDBOX.id}`)).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('forge-target-org-panel')).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAccessibleName(new RegExp(QA_SANDBOX.alias));
  });

  test('a picker left with Tab closes behind it', async ({ page }) => {
    await openModule(page, 'forge');
    await page.getByTestId('forge-page').waitFor({ timeout: 10_000 });
    await page.getByTestId('forge-target-org').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('forge-target-org-panel')).toBeVisible();

    // Tab through the options and out of the picker.
    for (let i = 0; i < MOCK_ORGS.length + 2; i++) await page.keyboard.press('Tab');

    await expect(page.getByTestId('forge-target-org-panel')).toHaveCount(0);
  });
});

test.describe('Keyboard and screen reader — notifications', () => {
  test('Alt+N reaches the error that stays up, and its dismissal gives the focus back', async ({
    page,
  }) => {
    await openModule(page, 'home');
    await page.getByTestId('home-page').waitFor({ timeout: 10_000 });
    const opener = page.getByTestId('start-forge-btn');
    await opener.focus();

    await sendExtensionMessage(page, {
      type: 'notification',
      id: 'n-1',
      payload: { level: 'error', title: 'Sync failed', message: 'The session expired.' },
    });
    const toasts = page.getByTestId('floating-toasts');
    await expect(toasts).toContainText('Sync failed');
    await expect(page.getByTestId('toasts-said-errors')).toHaveText(
      'Sync failed. The session expired. Press Alt+N to reach it.',
    );

    await page.keyboard.press('Alt+n');
    const dismiss = toasts.getByRole('button', { name: 'Dismiss' });
    await expect(dismiss).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(toasts).not.toContainText('Sync failed');
    await expect(opener).toBeFocused();
  });
});

/** An Autopilot node as the scan answers it, waiting for its wave. */
function autopilotNode(objectApiName: string, level: number): Record<string, unknown> {
  return {
    objectApiName,
    recordCount: 100,
    estimatedApiCalls: 1,
    piiFields: [],
    anonymizationRules: [],
    status: 'pending',
    progress: 0,
    insertOrder: level,
    level,
    successCount: 0,
    failureCount: 0,
    errors: [],
    elapsedMs: 0,
    apiCallsUsed: 0,
  };
}

const AUTOPILOT_OBJECTS = ['Account', 'Contact'];

const AUTOPILOT_GRAPH = {
  nodes: [autopilotNode('Account', 0), autopilotNode('Contact', 1)],
  edges: [],
  cycles: [],
  stats: {
    totalObjects: 2,
    totalRelationships: 0,
    cycleCount: 0,
    maxDepth: 1,
    totalRecords: 200,
    totalEstimatedApiCalls: 2,
  },
};

const AUTOPILOT_PLAN = {
  waves: [
    { order: 0, objects: ['Account'], dependsOn: [] },
    { order: 1, objects: ['Contact'], dependsOn: [0] },
  ],
  totalRecords: 200,
  estimatedDurationSec: 60,
  estimatedApiCalls: 2,
  complianceFramework: 'gdpr',
  anonymizationSummary: {
    totalPiiFields: 0,
    totalFieldsToAnonymize: 0,
    methodBreakdown: {},
    objectsWithPii: [],
  },
  cycleResolutions: [],
};

test.describe('Keyboard and screen reader — the Autopilot run', () => {
  test('Enter on a graph node opens its details and names it on Skip; the tabs walk with the arrows', async ({
    page,
  }) => {
    const bridge = await openModule(page, 'autopilot');
    await page.getByTestId('step1-connect').waitFor({ timeout: 10_000 });
    // The source and target lists: pressed buttons in named groups.
    const source = page.getByRole('group', { name: 'Source Org' });
    await pressWithKeyboard(page, 'source-org-org-src-1');
    await expect(source.getByTestId('source-org-org-src-1')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByTestId('target-org-org-tgt-1').click();
    await page.getByTestId('seed-wizard-next').click();
    await bridge.respondToNext('autopilot:list-objects', 'autopilot:objects-listed', {
      objects: AUTOPILOT_OBJECTS.map((name) => ({ apiName: name, label: name, custom: false })),
    });
    await page.getByTestId('select-all-checkbox').check();
    await page.getByTestId('seed-wizard-next').click();
    await bridge.respondToNext('autopilot:scan-schema', 'autopilot:schema-result', {
      graph: AUTOPILOT_GRAPH,
    });
    await bridge.respondToNext('autopilot:generate-plan', 'autopilot:plan-ready', {
      plan: AUTOPILOT_PLAN,
      graph: AUTOPILOT_GRAPH,
    });
    await page.getByTestId('execute-button').click();
    await bridge.waitForMessage('autopilot:execute', { timeout: 10_000 });

    const account = page.getByTestId('rf__node-Account');
    // Drawn hidden until React Flow has measured it, and not focusable till then.
    await account.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(account).toHaveAccessibleName('Account: Pending. Written: 0 of 100');
    await expect(account).toHaveAccessibleDescription(
      "Press Enter or Space to show this object's details and pick it for Skip. Escape lets it go.",
    );
    await account.focus();
    await expect(account).toBeFocused();
    await page.keyboard.press('Enter');

    const nodeTab = page.getByRole('tab', { name: 'Node Detail' });
    await expect(nodeTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('control-skip')).toHaveText('Skip Account');
    await expect(page.getByTestId('control-skip')).toBeEnabled();

    await nodeTab.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Anonymization Preview' })).toBeFocused();
    await expect(page.getByRole('tabpanel', { name: 'Anonymization Preview' })).toBeVisible();
  });
});

/** An object of a Forge graph, as a discovery answers it. */
function forgeNode(objectApiName: string, level: number): Record<string, unknown> {
  return {
    objectApiName,
    recordCount: 10,
    fieldCount: 20,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 15,
    estimatedSizeMB: 0.01,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
  };
}

/** An account and ten children: wider than the pane at the graph's smallest zoom. */
const CHILDREN = Array.from({ length: 10 }, (_, i) => 'Child' + String(i) + '__c');
const WIDE_GRAPH = {
  nodes: [forgeNode('Account', 0), ...CHILDREN.map((name) => forgeNode(name, 1))],
  edges: CHILDREN.map((name) => ({
    sourceObject: 'Account',
    targetObject: name,
    relationshipName: name + 's',
    type: 'lookup',
  })),
  totalRecords: 110,
  estimatedSizeMB: 0.1,
  estimatedDurationSeconds: 5,
};

/** Fill Forge's SOQL tab and its target, ready to discover. */
async function fillForgeInput(page: Page): Promise<void> {
  await page.getByTestId('forge-page').waitFor({ timeout: 10_000 });
  await page.getByTestId('forge-tab-soql').click();
  await page.getByTestId('forge-input-soql').fill('SELECT Id FROM Account');
  await page.getByTestId('forge-target-org').click();
  await page.getByTestId('forge-target-org-option-' + QA_SANDBOX.id).click();
}

test.describe('Keyboard and screen reader — the Forge flow', () => {
  test('each phase takes the focus the button that moved on dropped, the discovery wait is said', async ({
    page,
  }) => {
    const bridge = await openModule(page, 'forge');
    await fillForgeInput(page);

    await pressWithKeyboard(page, 'forge-discover-btn');
    await expect(page.getByRole('group', { name: 'Graph discovery' })).toBeFocused();
    const discover = await bridge.waitForMessage('forge:discover', { timeout: 10_000 });
    // The discovery screen listens once it is drawn, the input's exit played.
    await page.getByTestId('forge-discovery-loading').waitFor({ timeout: 10_000 });
    await sendExtensionMessage(page, {
      type: 'forge:discover:progress',
      id: 'progress-1',
      timestamp: Date.now(),
      correlationId: String(discover.id),
      payload: {
        phase: 'object',
        objectApiName: 'Account',
        discoveredCount: 42,
        queueRemaining: 7,
      },
    });
    await expect(page.getByTestId('forge-discovery-status')).toHaveText(
      'Discovering… 42 objects scanned, 7 queued',
    );

    await answerAll(page, 'forge:discover', 'forge:discover:response', { graph: WIDE_GRAPH });
    await pressWithKeyboard(page, 'forge-execute-btn');
    await page.getByTestId('forge-review').waitFor({ timeout: 10_000 });
    await expect(page.getByRole('group', { name: 'Review' })).toBeFocused();
  });

  test('Tab onto a node outside the pane brings the node into view', async ({ page }) => {
    const bridge = await openModule(page, 'forge');
    await fillForgeInput(page);
    await page.getByTestId('forge-discover-btn').click();
    await bridge.waitForMessage('forge:discover', { timeout: 10_000 });
    await answerAll(page, 'forge:discover', 'forge:discover:response', { graph: WIDE_GRAPH });
    await page.getByTestId('forge-execute-btn').click();
    await page.getByTestId('forge-review').waitFor({ timeout: 10_000 });
    const pane = page.getByTestId('live-graph');
    await pane.locator('.react-flow__node').first().waitFor({ timeout: 10_000 });
    const checkbox = (name: string) =>
      page.locator('.react-flow__node[data-id="' + name + '"]').getByTestId('include-checkbox');
    await checkbox('Account').waitFor({ state: 'visible', timeout: 10_000 });
    const box = await pane.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    const inPane = async (name: string): Promise<boolean> => {
      const shown = await checkbox(name).boundingBox();
      return (
        shown !== null &&
        shown.x >= box.x &&
        shown.y >= box.y &&
        shown.x + shown.width <= box.x + box.width &&
        shown.y + shown.height <= box.y + box.height
      );
    };
    // The last child lies outside the pane until the keyboard reaches it.
    const last = CHILDREN[CHILDREN.length - 1];
    expect(await inPane(last)).toBe(false);

    // Drawn hidden until React Flow has measured it.
    await checkbox(CHILDREN[0]).waitFor({ state: 'visible', timeout: 10_000 });
    await checkbox(CHILDREN[0]).focus();
    await expect(checkbox(CHILDREN[0])).toBeFocused();
    for (let i = 1; i < CHILDREN.length; i++) {
      await page.keyboard.press('Tab');
      await expect(checkbox(CHILDREN[i])).toBeFocused();
      await expect.poll(() => inPane(CHILDREN[i])).toBe(true);
    }
  });
});
