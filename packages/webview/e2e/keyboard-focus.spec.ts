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

    // The gallery asks for its saved templates again. Its grid gave way to
    // placeholders while it waited, the card that held the focus with it; the
    // card is to keep the focus while they load and once they are in.
    const card = page
      .getByTestId('template-card-prebuilt-minimal-demo')
      .getByTestId('btn-use-template');
    await expect
      .poll(async () => {
        await answerAll(page, 'seed:template:list', 'seed:template:list:response', {
          templates: [],
        });
        await answerAll(page, 'seed:removal:list', 'seed:removal:list:response', { runs: [] });
        return card.count();
      })
      .toBe(1);
    await expect(card).toBeFocused();
  });

  test('Read again keeps the focus while the org is read again, and says the read is on its way', async ({
    page,
  }) => {
    // It gave way to a line saying the org was being read: the focus fell to
    // <body> as it was pressed, and the next Tab started over at the skip link.
    const bridge = await openSeedGallery(page);
    await page
      .getByTestId('template-card-prebuilt-minimal-demo')
      .getByTestId('btn-use-template')
      .focus();
    await page.keyboard.press('Enter');
    await bridge.waitForMessage('seed:automation', { timeout: 10_000 });
    await answerAll(page, 'seed:automation', 'seed:automation:error', {
      message: 'INVALID_SESSION_ID',
      code: 'UNKNOWN',
      retryable: true,
    });
    const readAgain = page.getByTestId('seed-automation-read-again');
    await expect(page.getByTestId('seed-automation-unread')).toContainText('INVALID_SESSION_ID');
    const reads = (await bridge.getMessages('seed:automation')).length;

    await pressWithKeyboard(page, 'seed-automation-read-again');
    await expect
      .poll(async () => (await bridge.getMessages('seed:automation')).length)
      .toBeGreaterThan(reads);
    await expect(page.getByTestId('seed-automation-reading')).toBeVisible();
    await expect(readAgain).toBeFocused();
    await expect(readAgain).toHaveAttribute('aria-disabled', 'true');

    await answerAll(page, 'seed:automation', 'seed:automation:error', {
      message: 'REQUEST_LIMIT_EXCEEDED',
      code: 'UNKNOWN',
      retryable: true,
    });
    await expect(page.getByTestId('seed-automation-unread')).toContainText(
      'REQUEST_LIMIT_EXCEEDED',
    );
    await expect(readAgain).toBeFocused();
    await expect(readAgain).not.toHaveAttribute('aria-disabled', 'true');
  });
});

test.describe('Keyboard and screen reader — DataOps backups', () => {
  /** Two backups of the panel's org, as `backup:list:result` carries them. */
  const BACKUPS = ['op-backup-1', 'op-backup-2'].map((operationId, index) => ({
    operationId,
    orgId: 'org-src-1',
    timestamp: `2026-03-1${index}T10:00:00Z`,
    totalRecords: 100,
    totalSize: 200_000,
    status: 'completed',
    objectResults: [{ objectApiName: 'Account', recordCount: 100 }],
  }));

  test('a backup deleted leaves the list on screen, and the focus where it was, while the list is read again', async ({
    page,
  }) => {
    // Each deletion reads the list again, and a skeleton took the panel's
    // place meanwhile: the control the keyboard was on went with it.
    const bridge = await openModule(page, 'dataops');
    await bridge.waitForMessage('backup:list', { timeout: 10_000 });
    await answerAll(page, 'backup:list', 'backup:list:result', { backups: BACKUPS });
    await answerAll(
      page,
      'dataops:anonymization-templates',
      'dataops:anonymization-templates:response',
      { templates: [] },
    );
    const restoreTab = page.getByTestId('page-tabs').getByRole('tab', { name: 'Restore' });
    await restoreTab.focus();
    await page.keyboard.press('Enter');
    const card = (id: string) =>
      page.getByTestId(`restore-backup-${id}`).locator('[role="button"]');
    await card('op-backup-2').focus();
    await page.keyboard.press('Enter');
    await pressWithKeyboard(page, 'delete-backup-btn-op-backup-2');
    await pressWithKeyboard(page, 'delete-backup-confirm');
    const deletion = await bridge.waitForMessage('backup:delete', { timeout: 10_000 });
    const listReads = (await bridge.getMessages('backup:list')).length;

    // The keyboard is on the other backup as the deletion is answered.
    await card('op-backup-1').focus();
    await sendExtensionMessage(page, {
      type: 'backup:delete:result',
      id: 'delete-done',
      correlationId: String(deletion.id),
      payload: { orgId: 'org-src-1', deleted: ['op-backup-2'] },
    });
    await expect
      .poll(async () => (await bridge.getMessages('backup:list')).length)
      .toBeGreaterThan(listReads);
    await expect(page.getByTestId('dataops-skeleton')).toHaveCount(0);
    await expect(card('op-backup-1')).toBeFocused();
    await expect(page.getByTestId('dataops-content')).toHaveAttribute('aria-busy', 'true');

    await answerAll(page, 'backup:list', 'backup:list:result', { backups: BACKUPS.slice(0, 1) });
    await expect(page.getByTestId('dataops-content')).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.getByTestId('restore-backup-op-backup-2')).toHaveCount(0);
    await expect(card('op-backup-1')).toBeFocused();
  });

  /** The Restore tab, its two backups listed, opened with the keys. */
  async function openRestoreTab(page: Page): Promise<MockBridge> {
    const bridge = await openModule(page, 'dataops');
    await bridge.waitForMessage('backup:list', { timeout: 10_000 });
    await answerAll(page, 'backup:list', 'backup:list:result', { backups: BACKUPS });
    await answerAll(
      page,
      'dataops:anonymization-templates',
      'dataops:anonymization-templates:response',
      { templates: [] },
    );
    const restoreTab = page.getByTestId('page-tabs').getByRole('tab', { name: 'Restore' });
    await restoreTab.focus();
    await page.keyboard.press('Enter');
    return bridge;
  }

  test('Cancel and Confirm hand the focus back to the Delete that asked, and the card in its place takes it once the backup is gone', async ({
    page,
  }) => {
    // Both answers took the question away, and the focus with it to <body>.
    const bridge = await openRestoreTab(page);
    const card = (id: string) =>
      page.getByTestId(`restore-backup-${id}`).locator('[role="button"]');
    await card('op-backup-2').focus();
    await page.keyboard.press('Enter');
    const remove = page.getByTestId('delete-backup-btn-op-backup-2');

    await pressWithKeyboard(page, 'delete-backup-btn-op-backup-2');
    await pressWithKeyboard(page, 'delete-backup-cancel');
    await expect(page.getByTestId('delete-backup-question')).toHaveCount(0);
    await expect(remove).toBeFocused();

    await page.keyboard.press('Enter');
    await pressWithKeyboard(page, 'delete-backup-confirm');
    const deletion = await bridge.waitForMessage('backup:delete', { timeout: 10_000 });
    // While the deletion runs, the Delete keeps the keyboard and says it is unavailable.
    await expect(remove).toBeFocused();
    await expect(remove).toHaveAttribute('aria-disabled', 'true');

    const listReads = (await bridge.getMessages('backup:list')).length;
    await sendExtensionMessage(page, {
      type: 'backup:delete:result',
      id: 'delete-done',
      correlationId: String(deletion.id),
      payload: { orgId: 'org-src-1', deleted: ['op-backup-2'] },
    });
    await expect
      .poll(async () => (await bridge.getMessages('backup:list')).length)
      .toBeGreaterThan(listReads);
    await answerAll(page, 'backup:list', 'backup:list:result', { backups: BACKUPS.slice(0, 1) });
    await expect(page.getByTestId('restore-backup-op-backup-2')).toHaveCount(0);
    await expect(card('op-backup-1')).toBeFocused();
  });

  test('Delete all hands the focus back to itself, and the Restore heading takes it once every backup is gone', async ({
    page,
  }) => {
    const bridge = await openRestoreTab(page);
    const deleteAll = page.getByTestId('delete-all-backups-btn');

    await pressWithKeyboard(page, 'delete-all-backups-btn');
    await pressWithKeyboard(page, 'delete-backup-cancel');
    await expect(deleteAll).toBeFocused();

    await page.keyboard.press('Enter');
    await pressWithKeyboard(page, 'delete-backup-confirm');
    const deletion = await bridge.waitForMessage('backup:delete', { timeout: 10_000 });
    await expect(deleteAll).toBeFocused();
    const listReads = (await bridge.getMessages('backup:list')).length;
    await sendExtensionMessage(page, {
      type: 'backup:delete:result',
      id: 'delete-all-done',
      correlationId: String(deletion.id),
      payload: { orgId: 'org-src-1', deleted: ['op-backup-1', 'op-backup-2'] },
    });
    await expect
      .poll(async () => (await bridge.getMessages('backup:list')).length)
      .toBeGreaterThan(listReads);
    await answerAll(page, 'backup:list', 'backup:list:result', { backups: [] });

    await expect(
      page.getByTestId('restore-panel').getByRole('heading', { name: 'Restore', exact: true }),
    ).toBeFocused();
  });
});

test.describe('Keyboard and screen reader — Monitor', () => {
  test('Refresh keeps the focus while the read it started runs, and a second press sends nothing', async ({
    page,
  }) => {
    // It took `disabled` under the Enter that pressed it: the focus fell to
    // <body>, and the next Tab started over at the skip link.
    const bridge = await openModule(page, 'monitor');
    const data = {
      healthScore: 85,
      healthReport: null,
      jobs: [],
      limits: [{ name: 'DailyApiRequests', max: 100000, remaining: 45000, usedPercent: 55 }],
      orgInfo: null,
      trends: {},
      lastUpdated: '2026-10-21T08:00:00Z',
    };
    await bridge.waitForMessage('monitor:refresh', { timeout: 10_000 });
    await answerAll(page, 'monitor:refresh', 'monitor:data', data);
    await page.getByTestId('monitor-page').waitFor({ timeout: 10_000 });
    const refresh = page.getByTestId('refresh-btn');
    const reads = (await bridge.getMessages('monitor:refresh')).length;

    await pressWithKeyboard(page, 'refresh-btn');
    await expect
      .poll(async () => (await bridge.getMessages('monitor:refresh')).length)
      .toBeGreaterThan(reads);
    await expect(refresh).toBeFocused();
    await expect(refresh).toHaveAttribute('aria-disabled', 'true');
    const asked = (await bridge.getMessages('monitor:refresh')).length;
    await page.keyboard.press('Enter');
    expect((await bridge.getMessages('monitor:refresh')).length).toBe(asked);

    await answerAll(page, 'monitor:refresh', 'monitor:data', {
      ...data,
      lastUpdated: '2026-10-21T08:05:00Z',
    });
    await expect(refresh).not.toHaveAttribute('aria-disabled', 'true');
    await expect(refresh).toBeFocused();
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

test.describe('Keyboard and screen reader — the other ways to seed', () => {
  /*
   * Each way is drawn in place of the gallery, the card pressed with it, and
   * Back draws the gallery in place of the way: the focus fell to <body> each
   * time, the next Tab started over at the skip link, and nothing was said.
   */
  for (const way of [
    { name: 'Generate', mode: 'generate', step: 'seed-step-content' },
    { name: 'Import CSV', mode: 'csv', step: 'csv-step-content' },
    { name: 'Clone from Org', mode: 'clone', step: 'clone-step-content' },
  ]) {
    test(`${way.name} takes the keyboard on its step, and Back gives it to its card`, async ({
      page,
    }) => {
      await openSeedGallery(page);
      await pressWithKeyboard(page, `mode-card-${way.mode}`);

      const step = page.getByTestId(way.step);
      await expect(step).toBeFocused({ timeout: 10_000 });
      await expect(step).toHaveAttribute('role', 'group');
      await expect(step).toHaveAttribute('aria-label', /\S/);

      await pressWithKeyboard(page, 'back-to-modes');
      await expect(page.getByTestId(`mode-card-${way.mode}`)).toBeFocused({ timeout: 10_000 });
    });
  }

  test('Generate opened again, its wizard kept, takes the keyboard on its step again', async ({
    page,
  }) => {
    await openSeedGallery(page);
    await pressWithKeyboard(page, 'mode-card-generate');
    await expect(page.getByTestId('seed-step-content')).toBeFocused({ timeout: 10_000 });
    await pressWithKeyboard(page, 'back-to-modes');
    await expect(page.getByTestId('mode-card-generate')).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(page.getByTestId('seed-step-content')).toBeFocused({ timeout: 10_000 });
  });
});

test.describe('Keyboard and screen reader — Reports', () => {
  test('View run on an audit entry hands the focus to the lineage tab it opens', async ({
    page,
  }) => {
    // The button went with the audit tab it was on: the focus fell to <body>.
    const bridge = await openModule(page, 'reports');
    await page.getByTestId('reports-page').waitFor({ timeout: 10_000 });
    await bridge.waitForMessage('reports:audit', { timeout: 10_000 });
    await answerAll(page, 'reports:audit', 'reports:audit:response', {
      entries: [
        {
          id: 'audit-forge',
          action: 'forge_execute',
          module: 'forge',
          orgId: '00D000000000001AAA',
          orgAlias: QA_SANDBOX.alias,
          operationId: 'op-2',
          outcome: 'success',
          objects: [{ objectApiName: 'Account', created: 3, updated: 0, deleted: 0, failed: 0 }],
          details: {},
          timestamp: '2026-09-12T10:00:00.000Z',
        },
      ],
      total: 1,
      offset: 0,
      facets: {
        modules: ['forge'],
        orgs: [{ orgId: '00D000000000001AAA', orgAlias: QA_SANDBOX.alias }],
      },
    });
    await answerAll(page, 'reports:lineage', 'reports:lineage:response', {
      lineage: null,
      runs: [
        {
          operationId: 'op-2',
          generatedAt: '2026-09-12T10:00:00.000Z',
          action: 'forge_execute',
          targetLabel: QA_SANDBOX.alias,
        },
      ],
    });
    await page.getByRole('tab', { name: 'Audit Trail' }).click();

    await pressWithKeyboard(page, 'audit-view-run-audit-forge');

    const lineageTab = page.getByRole('tab', { name: 'Data Lineage' });
    await expect(lineageTab).toBeFocused();
    await expect(lineageTab).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('Keyboard and screen reader — the overlays', () => {
  /*
   * Each overlay's content comes in a chunk of its own. A chunk that takes a
   * moment, as on a remote window, used to leave the focus on the empty
   * dialog the trap had focused: "Welcome wizard, dialog", and nothing of the
   * first step, until the user went looking.
   */
  for (const overlay of [
    {
      name: "What's New",
      chunk: '**/src/pages/Welcome/WhatsNewPage.tsx*',
      open: { type: 'whats-new:show', payload: { version: '1.0.0' } },
      content: 'whats-new-page',
    },
    {
      name: 'the welcome tour',
      chunk: '**/src/pages/Welcome/WelcomePage.tsx*',
      open: { type: 'onboarding:show', payload: {} },
      content: 'welcome-page',
    },
  ]) {
    test(`${overlay.name} whose chunk arrives late puts the focus on its first control, not on the empty dialog`, async ({
      page,
    }) => {
      await page.route(overlay.chunk, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 600));
        await route.continue();
      });
      const bridge = await openModule(page, 'home');
      await page.getByTestId('home-page').waitFor({ timeout: 10_000 });
      await bridge.stream([overlay.open]);

      const content = page.getByTestId(overlay.content);
      await content.waitFor({ state: 'visible', timeout: 10_000 });
      await expect
        .poll(() =>
          page.evaluate((testId) => {
            const active = document.activeElement;
            const inside = document.querySelector(`[data-testid="${testId}"]`);
            return active !== null && inside !== null && inside.contains(active);
          }, overlay.content),
        )
        .toBe(true);
      await expect(page.getByRole('dialog')).not.toBeFocused();
    });
  }
});
