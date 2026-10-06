import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

import { MockBridge, checkAccessibility, formatViolations } from './helpers';
import { MOCK_ORGS, DEV_SANDBOX, QA_SANDBOX } from './fixtures';

/**
 * Sync panel E2E tests.
 *
 * The extension opens one module per panel — it injects `__SANDFORGE_MODULE__`
 * and `main.tsx` renders that module through `PanelApp`. There has been no
 * in-app navigation sidebar since 1.8.0, and `?panel=sync` was never read by
 * anything: a spec that navigated to it landed on the Home fallback and then
 * asserted against a shell that no longer exists. These tests boot the Sync
 * panel the way the extension does, following `screenshots.spec.ts`.
 */

/** Boot the app straight into the Sync panel, with `orgs` already connected. */
async function openSync(page: Page, orgs: readonly unknown[] = MOCK_ORGS): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'sync';
  });
  await page.goto('/');
  await bridge.seedOrgs(orgs);
  return bridge;
}

test.describe('Sync panel — org bridge', () => {
  // A third test used to sit here, asserting only that `org:list` went out.
  // It was removed rather than kept: every org-gated panel sends that request,
  // so the same body passed unchanged when booted on Home — it never tested
  // Sync, despite its name. The test below subsumes it anyway, since the store
  // cannot be populated by a response to a request that was never sent.
  test('org list response populates the org store', async ({ page }) => {
    const bridge = await openSync(page);

    // SyncPage short-circuits to its EmptyState below two orgs, so `sync-page`
    // rendering at all is the first proof the response reached the store.
    await expect(page.getByTestId('sync-page')).toBeVisible();

    // Both orgs from the payload, by the alias the response carried.
    const sourceSelect = page.getByLabel('Source', { exact: true });
    const targetSelect = page.getByLabel('Target', { exact: true });
    await expect(sourceSelect.locator('option[value="org-src-1"]')).toHaveText(/DevSandbox/);
    await expect(sourceSelect.locator('option[value="org-tgt-1"]')).toHaveText(/QASandbox/);
    await expect(targetSelect.locator('option[value="org-src-1"]')).toHaveText(/DevSandbox/);
    await expect(targetSelect.locator('option[value="org-tgt-1"]')).toHaveText(/QASandbox/);

    // And the store's org id travels back out: picking the source fires the
    // describe carrying it. A store that merely rendered the right labels but
    // handed the next request the wrong id would still pass the checks above.
    await sourceSelect.selectOption('org-src-1');
    const describe = await bridge.waitForMessage('sync:describe-global', { timeout: 10_000 });
    expect((describe.payload as Record<string, unknown>).orgId).toBe('org-src-1');
  });
});

test.describe('Sync panel — empty state', () => {
  test('a single connected org holds Sync on its empty state', async ({ page }) => {
    // Sync moves data between two orgs; one is not a degraded run, it is no run.
    await openSync(page, [DEV_SANDBOX]);

    await expect(page.getByTestId('empty-state')).toBeVisible();
    await expect(page.getByTestId('empty-illustration-sync')).toBeVisible();
    // The first step is org-count aware: with one org it asks for a second,
    // not for the two an empty org list would ask for.
    await expect(page.getByTestId('empty-step-0')).toContainText('Connect a second org');
    await expect(page.getByTestId('sync-page')).toHaveCount(0);
  });
});

/** A draft on the execute step: two orgs, one object, ready to simulate or run. */
const READY_DRAFT = {
  currentStep: 4,
  direction: 'bidirectional',
  mode: 'full',
  conflictStrategy: 'target_wins',
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

/** Boot the Sync panel on a saved draft, the way it reopens on one. */
async function openSyncOnDraft(
  page: Page,
  draft: Record<string, unknown> = READY_DRAFT,
): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await page.addInitScript((syncDraft) => {
    const host = window as unknown as {
      acquireVsCodeApi: () => { setState: (state: unknown) => void };
      __SANDFORGE_MODULE__?: string;
    };
    host.acquireVsCodeApi().setState({ syncDraft });
    host.__SANDFORGE_MODULE__ = 'sync';
  }, draft);
  await page.goto('/');
  await bridge.seedOrgs(MOCK_ORGS);
  await expect(page.getByTestId('sync-page')).toBeVisible();
  return bridge;
}

/** What the extension answers a simulation of {@link READY_DRAFT} with. */
const SIMULATION = {
  configId: 'cfg-e2e',
  operationId: 'sim-e2e',
  direction: 'bidirectional',
  conflictStrategy: 'target_wins',
  objects: [
    {
      objectApiName: 'Account',
      operation: 'upsert',
      read: 12,
      insert: 4,
      update: 7,
      delete: 0,
      skipped: 0,
      refused: 1,
      conflicts: 3,
      conflictFields: ['Phone', 'Name'],
      notes: [
        '1 record(s) carry no value in Legacy_Key__c: an upsert matches on it, and the target refuses a record without one.',
      ],
    },
  ],
  duration: 840,
  timestamp: '2026-10-06T09:00:00.000Z',
};

test.describe('Sync panel — simulate, then run', () => {
  test('a simulation sends the configuration to be simulated and shows what it found', async ({
    page,
  }) => {
    const bridge = await openSyncOnDraft(page);

    await page.getByTestId('sync-simulate').click();
    const request = await bridge.waitForMessage('sync:simulate', { timeout: 10_000 });
    const config = (request.payload as { config: Record<string, unknown> }).config;
    expect(config.conflictStrategy).toBe('target_wins');
    expect(await bridge.getMessages('sync:execute')).toEqual([]);

    // While it reads, only a cancel: a simulation writes nothing to hold.
    await expect(page.getByTestId('sync-cancel')).toHaveText('Cancel simulation');
    await expect(page.getByTestId('sync-pause')).toHaveCount(0);

    await bridge.respond('sync:simulate:response', SIMULATION);

    const summary = page.getByTestId('sync-simulation-summary');
    await expect(summary).toContainText('Simulation — nothing written');
    await expect(summary).toContainText('In conflict: 3');
    await expect(page.getByTestId('sync-simulation-object-Account')).toContainText(
      'Fields that differ: Phone, Name.',
    );

    const results = await checkAccessibility(page);
    expect(results.violations, formatViolations(results.violations)).toEqual([]);
  });

  test('a run can be paused and cancelled from the page, on the channel Live Operations uses', async ({
    page,
  }) => {
    const bridge = await openSyncOnDraft(page);

    await page.getByTestId('sync-run').click();
    const run = await bridge.waitForMessage('sync:execute', { timeout: 10_000 });

    await page.getByTestId('sync-pause').click();
    const pause = await bridge.waitForMessage('sync:pause');
    expect(pause.payload).toEqual({ operationId: run.id });
    await bridge.respond('sync:pause:response', {
      success: true,
      operationId: run.id,
      paused: true,
    });
    await expect(page.getByTestId('sync-run-state')).toContainText(
      'nothing more is written until you resume',
    );
    await expect(page.getByTestId('sync-resume')).toBeVisible();

    const paused = await checkAccessibility(page);
    expect(paused.violations, formatViolations(paused.violations)).toEqual([]);

    await page.getByTestId('sync-cancel').click();
    await page.getByTestId('danger-input').fill('Cancel');
    await page.getByTestId('danger-confirm-btn').click();
    const abort = await bridge.waitForMessage('execution:abort');
    expect(abort.payload).toEqual({ operationId: run.id });
    await expect(page.getByTestId('sync-run-state')).toContainText('Stopping');
  });

  test('a draft that asked for manual review reopens on target wins, and says so', async ({
    page,
  }) => {
    await openSyncOnDraft(page, {
      ...READY_DRAFT,
      currentStep: 0,
      direction: 'source_to_target',
      conflictStrategy: 'manual',
    });

    await expect(page.getByTestId('sync-strategy-notice')).toContainText('It now uses Target Wins');
    await expect(page.getByLabel('Conflict Strategy')).toHaveValue('target_wins');

    const results = await checkAccessibility(page);
    expect(results.violations, formatViolations(results.violations)).toEqual([]);
  });
});
