import { test, expect } from '@playwright/test';
import { FORGE_SAMPLE_DEFAULTS } from '@sandforge/shared';
import { MockBridge } from './helpers';
import { DEV_SANDBOX, QA_SANDBOX } from './fixtures';
import { daysFromNow, listEntry, readyCheckpoint, scopeAnswer } from './fixtures/checkpoints';
import {
  CARD_THAT_CANNOT_RUN,
  CASE_NOT_COUNTED,
  CASE_NOT_IN_SOURCE,
  CLEANUP_FIRST_EXPORT,
  CLEANUP_LAST_EXPORT,
  CLEANUP_NEXT_CURSOR,
  CLONE_STORAGE_WORDS,
  CSV_STORAGE_WORDS,
  FROZEN_STORAGE_WORDS,
  JOURNAL_UNAVAILABLE_REFUSAL,
  LEFT_OUT_ADMIN_COPY,
  LEFT_OUT_FOR_RIGHTS,
  METADATA_ADMIN_COPY,
  METADATA_DIFFS,
  OBJECT_NOT_IN_TARGET_WORDS,
  QUICK_SYNC_ON_A_CUT_PREVIEW,
  QUICK_SYNC_ON_OBJECTS,
  QUICK_SYNC_ON_PREVIEW,
  QUICK_SYNC_STORAGE_WORDS,
  RESUME_TARGET_UNREAD_REFUSAL,
  SENT_AGAIN_FOR_A_LOCK,
  SENT_AGAIN_WORDS,
  SFDMU_IMPORT_DELETING_FIRST,
  SHIPPED_MARKETPLACE_CARDS,
  SYNC_READY_DRAFT,
  TARGET_USERS_TRUNCATED,
  UNLISTED_TARGET_USER,
  VERIFIED_WITH_THE_PLATFORMS,
  cleanupObject,
  forgeGraph,
  simulationCutAtReadCap,
  syncHistoryEntryCutAtReadCap,
  syncHistoryEntrySentAgain,
  syncRunCutAtReadCap,
  syncRunSentAgain,
} from './fixtures/refusals';
import {
  answerAll,
  answerOnceAsked,
  discoverFromQuery,
  importDeletingFirst,
  openAutopilotNode,
  openForgeReview,
  openMarketplace,
  openModule,
  openMonitorWithAStoppedClone,
  openQuickSyncObjects,
  openSyncHistoryEntry,
  openWholeOrgReview,
  refuseClonePreviewForMissingObject,
  refuseCloneForStorage,
  refuseCsvForStorage,
  refuseFrozenLoadForStorage,
  refuseQuickSync,
  refuseResume,
  requestIds,
  runQuickSync,
  runSyncDraft,
  scanCleanup,
  sentPayloads,
  simulateSyncDraft,
  simulateUnwritable,
  startForgeRun,
  stopAtTheGate,
  verifyForgeRun,
} from './helpers/refusalStates';
import { sampleBudget, wholeOrgGraph } from '../src/pages/Forge/testing/wholeOrg';
import { scopeAnswer as emptyScopeAnswer } from '../src/pages/DataOps/empty/testing/emptyAnswers';

/**
 * Each way out a refusal offers, and each warning that says why a step
 * holds, as the panel draws it from what the extension answers: it shows
 * when it should and not otherwise, and it does what it says — the page it
 * opens, the org it selects there, the objects it picks, the request it
 * sends. What each paints under the host's themes is scanned in
 * axe-accessibility.spec.ts, from the same states (helpers/refusalStates.ts).
 */

test.describe('Quick Sync refused for the target’s data storage', () => {
  test('says what Quick Sync can do about it, with its three ways out, in place of the wizard’s words', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'sync', { state: QUICK_SYNC_ON_PREVIEW });
    await refuseQuickSync(bridge, page);

    const refusal = page.getByTestId('quick-sync-storage-refusal');
    await expect(refusal).toHaveAttribute('role', 'alert');
    await expect(refusal.locator('p')).toHaveText(QUICK_SYNC_STORAGE_WORDS);
    await expect(refusal.getByRole('button')).toHaveText([
      'Open in the wizard',
      'Open Forge',
      'Empty these objects in the target',
    ]);
    await expect(page.getByTestId('quick-sync-error')).toHaveCount(0);
  });

  test('another refusal is said as the error catalogue says it, with none of the three', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'sync', { state: QUICK_SYNC_ON_PREVIEW });
    await refuseQuickSync(bridge, page, {
      message: 'INVALID_SESSION_ID: Session expired or invalid',
      code: 'UNKNOWN',
      retryable: false,
    });

    await expect(page.getByTestId('quick-sync-error')).toContainText('INVALID_SESSION_ID');
    await expect(page.getByTestId('quick-sync-storage-refusal')).toHaveCount(0);
    await expect(page.getByTestId('quick-sync-open-in-wizard')).toHaveCount(0);
  });

  test('Open in the wizard takes the pair and every object picked onto its first step, each an insert', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'sync', { state: QUICK_SYNC_ON_PREVIEW });
    await refuseQuickSync(bridge, page);

    await page.getByTestId('quick-sync-open-in-wizard').click();

    await expect(page.getByTestId('quick-sync-flow')).toHaveCount(0);
    await expect(page.getByTestId('sync-step-orgs')).toBeVisible();
    await expect(page.getByLabel('Source', { exact: true })).toHaveValue(DEV_SANDBOX.id);
    await expect(page.getByLabel('Target', { exact: true })).toHaveValue(QA_SANDBOX.id);
    await answerOnceAsked(page, 'sync:describe-global', 'sync:describe-global:response', {
      objects: ['Account', 'Contact', 'Opportunity'],
    });
    await expect(page.getByTestId('object-entry-Contact')).toBeVisible();
    await expect(page.getByTestId('object-entry-Account')).toBeVisible();
    await expect(page.getByTestId('object-set-table').locator('tbody tr')).toHaveCount(2);
  });

  test('Open Forge opens the Forge page, where a sample of the source that fits is copied', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'sync', { state: QUICK_SYNC_ON_PREVIEW });
    await refuseQuickSync(bridge, page);

    await page.getByTestId('quick-sync-open-forge').click();

    await expect(page.getByTestId('forge-page')).toBeVisible();
    await expect(page.getByTestId('forge-depth-all')).toBeVisible();
  });

  test('Empty these objects opens DataOps on Emptying for the target, the objects picked and the target selected', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'sync', { state: QUICK_SYNC_ON_PREVIEW });
    await refuseQuickSync(bridge, page);

    await page.getByTestId('quick-sync-empty-first').click();

    await expect(page.getByTestId('dataops-page')).toBeVisible();
    await expect(page.getByTestId('page-tab-emptying')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId('empty-panel').waitFor();
    await answerOnceAsked(
      page,
      'dataops:empty:scope',
      'dataops:empty:scope:response',
      emptyScopeAnswer(),
    );
    await expect(page.getByTestId('empty-pick-option-Contact')).toBeChecked();
    await expect(page.getByTestId('empty-pick-option-Account')).toBeChecked();
    await expect(page.getByTestId('empty-pick-option-Case')).not.toBeChecked();
    expect((await sentPayloads(page, 'org:select')).at(-1)).toEqual({ orgId: QA_SANDBOX.id });
  });
});

test.describe('one org on both sides of a sync', () => {
  test('Quick Sync says why Next stays off, until another org is the target', async ({ page }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'sync');
    await page.getByTestId('quick-sync-start-btn').click();
    await page.getByTestId('quick-sync-source-select').selectOption(DEV_SANDBOX.id);
    await page.getByTestId('quick-sync-target-select').selectOption(DEV_SANDBOX.id);

    const warning = page.getByTestId('quick-sync-same-org');
    await expect(warning).toHaveText(
      'Source and target are the same org: pick another org as the target to go on.',
    );
    await expect(warning).toHaveAttribute('role', 'status');
    await expect(page.getByTestId('quick-sync-org-next')).toBeDisabled();

    await page.getByTestId('quick-sync-target-select').selectOption(QA_SANDBOX.id);
    await expect(warning).toHaveCount(0);
    await expect(page.getByTestId('quick-sync-org-next')).toBeEnabled();
  });

  test('the wizard says why Next stays off, until another org is the target', async ({ page }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'sync');
    await page.getByLabel('Source', { exact: true }).selectOption(DEV_SANDBOX.id);
    await page.getByLabel('Target', { exact: true }).selectOption(DEV_SANDBOX.id);

    const warning = page.getByTestId('sync-same-org');
    await expect(warning).toHaveText(
      'Source and target are the same org: pick another org as the target to go on.',
    );
    await expect(warning).toHaveAttribute('role', 'status');
    await expect(page.getByTestId('sync-wizard-next')).toBeDisabled();

    await page.getByLabel('Target', { exact: true }).selectOption(QA_SANDBOX.id);
    await expect(warning).toHaveCount(0);
  });
});

test.describe('Quick Sync’s suggestions, one the source does not let SandForge take', () => {
  test('strikes it, says why to the eye and to a screen reader, keeps it in reach, and adds nothing on a click', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'sync', { state: QUICK_SYNC_ON_OBJECTS });
    await openQuickSyncObjects(page);

    const struck = page.getByTestId('suggestion-chip-Case');
    await expect(struck).toHaveAttribute('aria-disabled', 'true');
    await expect(struck).toHaveAttribute('title', CASE_NOT_IN_SOURCE);
    await expect(page.getByRole('button', { name: CASE_NOT_IN_SOURCE })).toBeVisible();
    await expect(struck.locator('span')).toHaveClass(/line-through/);
    await expect(page.getByTestId('suggestion-chip-Account')).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );

    // In the order of the keyboard, as a disabled button is not.
    await page.getByTestId('suggestion-chip-Contact').focus();
    await page.keyboard.press('Tab');
    await expect(struck).toBeFocused();

    // Playwright holds back a click on what says it is disabled: the page's
    // own handler is what must refuse it.
    await struck.dispatchEvent('click');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('quick-sync-selected-objects')).not.toContainText('Case');
    expect(await requestIds(page, 'quicksync:detect-relationships')).toEqual([]);

    await page.getByTestId('suggestion-chip-Account').click();
    await expect(page.getByTestId('remove-object-Account')).toBeVisible();
    expect(await sentPayloads(page, 'quicksync:detect-relationships')).toEqual([
      { orgId: DEV_SANDBOX.id, objectApiName: 'Account', alreadySelected: ['Account'] },
    ]);
  });
});

test.describe('a simulation whose target lacks an object', () => {
  test('offers Compare beside the words, which opens it', async ({ page }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'sync', { state: { syncDraft: SYNC_READY_DRAFT } });
    await simulateUnwritable(bridge, page, 'notInTarget');

    await expect(page.getByTestId('sync-write-check-unwritable-Invoice__c')).toContainText(
      'If the target has not the object, Compare deploys it from the source',
    );
    await page.getByTestId('sync-write-check-open-compare').click();

    await expect(page.getByTestId('compare-page')).toBeVisible();
  });

  test('offers no Compare for an object the target has and its user may not create', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'sync', { state: { syncDraft: SYNC_READY_DRAFT } });
    await simulateUnwritable(bridge, page, 'notCreateable');

    await expect(page.getByTestId('sync-write-check-unwritable-Invoice__c')).toBeVisible();
    await expect(page.getByTestId('sync-write-check-open-compare')).toHaveCount(0);
  });
});

test.describe('Migration’s import of an SFDMU export that emptied objects first', () => {
  test('offers to empty them, held until the run’s target is picked, then opens DataOps on Emptying for it, those objects picked', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'migration');
    await importDeletingFirst(bridge, page);

    const button = page.getByTestId('migration-empty-first');
    const hint = page.getByTestId('migration-empty-first-hint');
    await expect(button).toHaveText('Empty these objects in the target first');
    await expect(button).toBeDisabled();
    await expect(hint).toHaveText(
      'Pick the target org under Run it from Sync to empty these objects there.',
    );
    await expect(button).toHaveAttribute('aria-describedby', (await hint.getAttribute('id')) ?? '');

    await page.getByTestId('migration-run-source').selectOption(DEV_SANDBOX.id);
    await page.getByTestId('migration-run-target').selectOption(QA_SANDBOX.id);
    await expect(button).toBeEnabled();
    await expect(hint).toHaveCount(0);
    await button.click();

    await expect(page.getByTestId('dataops-page')).toBeVisible();
    await expect(page.getByTestId('page-tab-emptying')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId('empty-panel').waitFor();
    await answerOnceAsked(
      page,
      'dataops:empty:scope',
      'dataops:empty:scope:response',
      emptyScopeAnswer(),
    );
    await expect(page.getByTestId('empty-pick-option-Account')).toBeChecked();
    await expect(page.getByTestId('empty-pick-option-Contact')).toBeChecked();
    await expect(page.getByTestId('empty-pick-option-Case')).not.toBeChecked();
    expect((await sentPayloads(page, 'org:select')).at(-1)).toEqual({ orgId: QA_SANDBOX.id });
  });

  test('offers nothing to empty for an export that deletes nothing first', async ({ page }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'migration');
    await page.getByTestId('migration-path-input').fill('/home/qa/sfdmu/export.json');
    await page.getByTestId('migration-import-btn').click();
    await bridge.waitForMessage('migration:import-sfdmu', { timeout: 10_000 });
    await answerAll(page, 'migration:import-sfdmu', 'migration:import-sfdmu:response', {
      ...SFDMU_IMPORT_DELETING_FIRST,
      notes: SFDMU_IMPORT_DELETING_FIRST.notes.filter((note) => note.code !== 'deleteOldData'),
    });

    await expect(page.getByTestId('migration-notes').getByRole('listitem')).toHaveCount(1);
    await expect(page.getByTestId('migration-empty-first')).toHaveCount(0);
  });
});

test.describe('Seed Clone refused for the data storage the target has left', () => {
  test('says what its records take, the heaviest objects and the ways out, back on its preview', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'seed');
    await refuseCloneForStorage(bridge, page);

    await expect(page.getByTestId('clone-error')).toContainText(CLONE_STORAGE_WORDS);
    await expect(page.getByTestId('clone-error').getByTestId('error-hint')).toHaveCount(0);
    // Back where the run started, for Execute again once something changed.
    await expect(page.getByTestId('clone-preview-execute')).toBeVisible();
  });
});

test.describe('Seed Clone of an object the target does not show', () => {
  test('names it with the org and the two ways on, back on the objects, where the others preview once it is unticked', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'seed');
    await refuseClonePreviewForMissingObject(bridge, page);

    const error = page.getByTestId('clone-error');
    await expect(error).toContainText(OBJECT_NOT_IN_TARGET_WORDS);
    await expect(error.getByTestId('error-hint')).toHaveCount(0);
    await expect(error).not.toContainText('NOT_FOUND');
    const missing = page.getByTestId('clone-obj-check-Invoice__c');
    await expect(missing).toBeChecked();

    await missing.uncheck();
    await page.getByTestId('clone-wizard-next').click();
    await expect
      .poll(async () => (await sentPayloads(page, 'seed:clone:preview')).at(-1)?.objects)
      .toEqual([{ objectApiName: 'Account' }]);
  });
});

test.describe('a CSV import refused for the data storage the target has left', () => {
  test('says what its rows take, how many fit and how to split the file, and offers Execute again', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'seed');
    await refuseCsvForStorage(bridge, page);

    await expect(page.getByTestId('csv-error')).toContainText(CSV_STORAGE_WORDS);
    await expect(page.getByTestId('csv-error').getByTestId('error-hint')).toHaveCount(0);
    // Refused before it wrote: nothing to stop, the import offered as it was.
    await expect(page.getByTestId('execute-button')).toBeEnabled();
    await expect(page.getByTestId('csv-stop')).toHaveCount(0);
  });
});

test.describe('a Frozen load refused for the data storage the target has left', () => {
  test('says what the dataset takes against what is left, and the ways out of a dataset loaded whole', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'frozen');
    await refuseFrozenLoadForStorage(bridge, page);

    await expect(page.getByTestId('frozen-error')).toContainText(FROZEN_STORAGE_WORDS);
    await expect(page.getByTestId('frozen-error').getByTestId('error-hint')).toHaveCount(0);
    await expect(page.getByTestId('frozen-error')).not.toContainText('Nothing was written.');
    await expect(page.getByTestId('frozen-load-run')).toBeEnabled();
  });
});

test.describe('Checkpoint’s Records at most', () => {
  test('asks the scope with the limit typed, says a take past it in the page’s words, refuses a number it cannot be, and takes with the limit raised', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'checkpoint');
    await answerOnceAsked(page, 'checkpoint:list', 'checkpoint:list:response', { checkpoints: [] });
    await page.getByRole('button', { name: 'Take a checkpoint' }).click();
    await answerOnceAsked(page, 'checkpoint:scope', 'checkpoint:scope:response', scopeAnswer());
    const limit = page.getByLabel('Records at most');
    await expect(limit).toHaveValue('500000');
    // The take's own default is not sent: a scope asked as before is asked the same.
    expect((await sentPayloads(page, 'checkpoint:scope'))[0]).toEqual({
      orgId: DEV_SANDBOX.id,
      mode: 'everything',
    });

    await limit.fill('2000');
    await expect
      .poll(async () => (await sentPayloads(page, 'checkpoint:scope')).at(-1)?.maxTotal)
      .toBe(2000);
    await answerAll(
      page,
      'checkpoint:scope',
      'checkpoint:scope:response',
      scopeAnswer({
        refusal: {
          code: 'TOO_MANY_RECORDS',
          message: 'This checkpoint would hold 2424 records, past --max-total (2000).',
        },
      }),
    );
    await expect(page.getByTestId('checkpoint-refusal')).toHaveText(
      'The objects this checkpoint would keep hold 2,424 records, past Records at most (2,000): pick fewer objects, or raise it, up to 1,000,000. No record was read.',
    );
    await expect(page.getByTestId('checkpoint-take-start')).toBeDisabled();

    await limit.fill('0');
    await expect(page.getByText('A whole number of records, from 1 to 1,000,000.')).toBeVisible();
    await expect(page.getByTestId('checkpoint-take-start')).toBeDisabled();

    await limit.fill('5000');
    await expect
      .poll(async () => (await sentPayloads(page, 'checkpoint:scope')).at(-1)?.maxTotal)
      .toBe(5000);
    await answerAll(page, 'checkpoint:scope', 'checkpoint:scope:response', scopeAnswer());
    await expect(page.getByTestId('checkpoint-refusal')).toHaveCount(0);
    await expect(page.getByTestId('checkpoint-take-start')).toBeEnabled();
    await page.getByTestId('checkpoint-take-start').click();
    await expect
      .poll(async () => (await sentPayloads(page, 'checkpoint:take')).at(-1)?.maxTotal)
      .toBe(5000);
    expect(await requestIds(page, 'checkpoint:take')).toHaveLength(1);
  });

  test('says of an object left out for its size the limit that holds it, and of one no checkpoint holds that none does', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'checkpoint');
    await answerOnceAsked(page, 'checkpoint:list', 'checkpoint:list:response', { checkpoints: [] });
    await page.getByRole('button', { name: 'Take a checkpoint' }).click();
    await answerOnceAsked(
      page,
      'checkpoint:scope',
      'checkpoint:scope:response',
      scopeAnswer({
        leftOut: [
          {
            objectApiName: 'Task',
            code: 'pastTheLimit',
            records: 750_000,
            limit: 500_000,
            reason: 'Task has 750000 records, past the limit of 500000.',
          },
          {
            objectApiName: 'EventLog__c',
            code: 'pastTheLimit',
            records: 3_200_000,
            limit: 500_000,
            reason: 'EventLog__c has 3200000 records, past the limit of 500000.',
          },
        ],
      }),
    );
    const leftOut = page.getByTestId('checkpoint-left-out');
    await leftOut.locator('summary').click();
    await expect(leftOut.getByRole('listitem')).toHaveText([
      "Task — Task has 750,000 records, past the checkpoint's limit of 500,000 for one object: left out of the checkpoint, as part of it would be taken for all of it. Records at most set to 752,424 or more holds it.",
      'EventLog__c — EventLog__c has 3,200,000 records, more than any checkpoint holds of one object (1,000,000): left out of the checkpoint, and a rewind to it does not touch EventLog__c. Data Export, in Setup, or a Bulk API query keeps a copy of it.',
    ]);
  });
});

test.describe('Checkpoints of a scratch org about to expire, and of one gone', () => {
  test('warns on the row of each checkpoint of the scratch org before it goes, and offers to replay it in another org', async ({
    page,
  }) => {
    // Three days ahead, as the store warns: a day read as this machine's midnight.
    const day = daysFromNow(3).slice(0, 10);
    const said = new Intl.DateTimeFormat('en', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(new Date(`${day}T00:00:00`));
    const scratch = { ...readyCheckpoint().org, tier: 'scratch' as const, scratchExpiresAt: day };
    const soon = readyCheckpoint({
      checkpointId: 'ck-scratch-soon',
      name: 'Demo data',
      org: scratch,
    });
    const gone = readyCheckpoint({ checkpointId: 'ck-scratch-gone', name: 'Last sprint' });
    const sandbox = readyCheckpoint({ checkpointId: 'ck-sandbox', name: 'Before UAT' });
    const bridge = new MockBridge();
    await openModule(bridge, page, 'checkpoint');
    await answerOnceAsked(page, 'checkpoint:list', 'checkpoint:list:response', {
      checkpoints: [
        listEntry(soon, { scratchExpiresSoon: true }),
        listEntry(gone, { valid: false, why: 'scratchExpired' }),
        listEntry(sandbox),
      ],
    });

    await expect(page.getByTestId('checkpoint-scratch-expires-ck-scratch-soon')).toHaveText(
      `This scratch org expires on ${said}: its checkpoints then rewind nothing, whatever Keep says. They still replay in another org: Replay in another org… sets their records up there again, with new Ids.`,
    );
    await expect(page.getByTestId('checkpoint-elsewhere-ck-scratch-gone')).toHaveText(
      'It no longer brings its org back, and it replays in another org: its records are created there again, with new Ids.',
    );
    await expect(page.getByTestId('checkpoint-replay-ck-scratch-gone')).toHaveText(
      'Replay in another org…',
    );
    await expect(page.getByTestId('checkpoint-scratch-expires-ck-sandbox')).toHaveCount(0);
    await expect(page.getByTestId('checkpoint-elsewhere-ck-sandbox')).toHaveCount(0);
  });
});

test.describe('Cleanup’s export of more stale records than one export takes', () => {
  test('says how many of how many went, carries on from where it stopped, and stops offering once all went', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'dataops');
    await scanCleanup(bridge, page, [cleanupObject('Contact', 1300)]);

    await page.getByTestId('cleanup-object-Contact').getByTestId('cleanup-stale-export').click();
    await answerOnceAsked(
      page,
      'dataops:cleanup:export',
      'dataops:cleanup:export:response',
      CLEANUP_FIRST_EXPORT,
    );
    const status = page.getByTestId('cleanup-export-status');
    await expect(status).toHaveText(
      'Saved 1,000 records to /home/qa/contact-stale-1.csv. 1,000 of 1,300 exported so far: Export the next 1,000 carries on from there.',
    );
    const next = page.getByTestId('cleanup-export-next');
    await expect(next).toHaveText('Export the next 1,000');

    await next.click();
    await expect
      .poll(async () => (await requestIds(page, 'dataops:cleanup:export')).length)
      .toBe(2);
    const [first, second] = await sentPayloads(page, 'dataops:cleanup:export');
    expect(first).toEqual({
      orgId: DEV_SANDBOX.id,
      objectApiName: 'Contact',
      recommendation: { kind: 'stale', days: 365 },
    });
    expect(second).toEqual({ ...first, after: CLEANUP_NEXT_CURSOR });
    await answerAll(
      page,
      'dataops:cleanup:export',
      'dataops:cleanup:export:response',
      CLEANUP_LAST_EXPORT,
    );
    await expect(status).toHaveText('Saved 300 records to /home/qa/contact-stale-2.csv.');
    await expect(next).toHaveCount(0);
  });
});

test.describe('Cleanup of an object the connected user may not delete', () => {
  test('greys its Delete with the reason, keeps its Export, and leaves the other object’s Delete as it is', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'dataops');
    await scanCleanup(bridge, page, [
      cleanupObject('Contact', 40, false),
      cleanupObject('Account', 10),
    ]);

    const contact = page.getByTestId('cleanup-object-Contact');
    await expect(contact.getByTestId('cleanup-stale-delete')).toBeDisabled();
    await expect(contact.getByTestId('cleanup-not-deletable')).toHaveText(
      'The connected user may not delete Contact records: Export keeps a copy of them, and an admin grants Delete on Contact in a permission set.',
    );
    await expect(contact.getByTestId('cleanup-stale-export')).toBeEnabled();
    const account = page.getByTestId('cleanup-object-Account');
    await expect(account.getByTestId('cleanup-stale-delete')).toBeEnabled();
    await expect(account.getByTestId('cleanup-not-deletable')).toHaveCount(0);
  });
});

test.describe('the Automation marketplace', () => {
  test('lists every template it ships, none of them said to be one that cannot run', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'automation');
    await openMarketplace(page, SHIPPED_MARKETPLACE_CARDS);

    expect(SHIPPED_MARKETPLACE_CARDS.length).toBeGreaterThan(0);
    for (const card of SHIPPED_MARKETPLACE_CARDS) {
      await expect(page.getByTestId(`marketplace-template-${card.id}`)).toContainText(card.name);
      await expect(page.getByTestId(`marketplace-template-blocked-${card.id}`)).toHaveCount(0);
      await expect(page.getByTestId(`install-template-${card.id}`)).toBeEnabled();
    }
    await expect(page.getByTestId('marketplace-content')).not.toContainText('Cannot run');
  });

  test('names each step of a card that would not run once installed, and why', async ({ page }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'automation');
    await openMarketplace(page, [CARD_THAT_CANNOT_RUN, SHIPPED_MARKETPLACE_CARDS[0]]);

    const blocked = page.getByTestId(`marketplace-template-blocked-${CARD_THAT_CANNOT_RUN.id}`);
    await expect(blocked).toContainText('Cannot run');
    await expect(blocked.locator('span.block')).toHaveText([
      'Check the org: Choose what this Pre-Check reads: API usage, data storage, Apex error logs or failed Apex jobs.',
      'Tell the team: Write the message this notification shows (up to 500 characters).',
    ]);
    await expect(
      page.getByTestId(`marketplace-template-blocked-${SHIPPED_MARKETPLACE_CARDS[0].id}`),
    ).toHaveCount(0);
  });
});

test.describe('Forge’s Records per object for a run from a query', () => {
  test('offers every choice to a run from a query, which clones each record it chooses as one record, and says what Smart reads', async ({
    page,
  }) => {
    // 500, 1000 and All were greyed, and every object held to 200, its
    // related objects read from their whole tables.
    const bridge = new MockBridge();
    await openModule(bridge, page, 'forge');
    await page.getByTestId('forge-page').waitFor({ timeout: 10_000 });
    const records = page.getByTestId('forge-record-limit');
    const past = ['500', '1000', 'all'].map((value) => records.locator(`option[value="${value}"]`));

    await page.getByTestId('forge-tab-soql').click();
    for (const option of past) await expect(option).toBeEnabled();
    await expect(page.getByTestId('forge-record-limit-soql')).toHaveCount(0);
    await expect(records).toHaveAttribute('aria-describedby', 'forge-record-limit-hint');
    await expect(page.getByTestId('forge-record-limit-smart-hint')).toHaveText(
      'Smart: reads only what the records the query chooses reach, at most 50,000 rows per object and 50,000 in all, and asks before a large write.',
    );
  });
});

test.describe('Forge’s discovery of an object the org did not count in time', () => {
  test('says it is left out and why, offers to include it anyway, and includes it', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'forge');
    await discoverFromQuery(page, forgeGraph(CASE_NOT_COUNTED));
    await page.getByTestId('forge-view-table').click();

    // A counted object says nothing of the kind.
    await page.getByTestId('forge-table-select-Account').click();
    await expect(page.getByTestId('node-not-counted')).toHaveCount(0);
    await expect(page.getByTestId('node-include-anyway')).toHaveCount(0);

    await page.getByTestId('forge-table-select-Case').click();
    await expect(page.getByTestId('node-record-count')).toHaveText('records not counted');
    const said = page.getByTestId('node-not-counted');
    await expect(said).toHaveText(
      'The org gave no answer in time to the count of its records, and it is left out. Included anyway, the run reads what its scope reaches of it.',
    );
    await expect(page.getByTestId('forge-table-include-Case')).not.toBeChecked();

    await page.getByTestId('node-include-anyway').click();
    await expect(said).toHaveText(
      'The org gave no answer in time to the count of its records: it stays in the run, which reads what its scope reaches of it. Turn Include in execution off to leave it out.',
    );
    await expect(page.getByTestId('node-include-anyway')).toHaveCount(0);
    await expect(page.getByTestId('forge-table-include-Case')).toBeChecked();
  });
});

test.describe('a sample of the whole org: its floor, and the ways out of a refused drawing', () => {
  test('sets the records drawn of each object whatever the share, which the run carries and the budget does not read', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'forge');
    await openWholeOrgReview(page, wholeOrgGraph(), sampleBudget(), true);
    await page.getByTestId('review-sample-more').locator('summary').click();

    const floor = page.getByLabel('Records drawn of each object, whatever the share');
    await expect(floor).toHaveValue(String(FORGE_SAMPLE_DEFAULTS.floor));
    await expect(floor.locator('option')).toHaveText(['0', '1', '5', '10', '50', '100']);
    await expect(floor).toHaveAccessibleDescription(
      'Each object keeps at least this many of its records, whatever the share the room left gives it. At 0, an object may have none drawn: a sample then fits where these records alone took more than it may take.',
    );

    // What the sample may take does not hang on it: nothing is read again.
    const budgetsAsked = (await requestIds(page, 'forge:sample-budget:request')).length;
    await floor.selectOption('0');
    await expect(floor).toHaveValue('0');
    expect(await requestIds(page, 'forge:sample-budget:request')).toHaveLength(budgetsAsked);
    await startForgeRun(page);
    const [execute] = (await sentPayloads(page, 'forge:execute')).slice(-1);
    expect(execute.config).toMatchObject({ sample: { floor: 0 } });
  });

  test('a floor set back to its default is left out of the run, as one never set', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'forge');
    await openWholeOrgReview(page, wholeOrgGraph(), sampleBudget(), true);
    await page.getByTestId('review-sample-more').locator('summary').click();
    const floor = page.getByLabel('Records drawn of each object, whatever the share');
    await floor.selectOption('50');
    await floor.selectOption(String(FORGE_SAMPLE_DEFAULTS.floor));

    await startForgeRun(page);
    const [execute] = (await sentPayloads(page, 'forge:execute')).slice(-1);
    expect((execute.config as Record<string, unknown>).sample).toEqual({});
  });

  test('a drawing spread over the org refused for the source’s requests offers the newest first, which Review then draws', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'forge');
    await openWholeOrgReview(page, wholeOrgGraph(), sampleBudget(), true);
    const run = await startForgeRun(page);
    await stopAtTheGate(page, run, {
      code: 'API_BUDGET_EXCEEDED',
      api: {
        kind: 'requests',
        org: 'source',
        estimate: 9_000,
        remaining: 14_000,
        drawing: { share: 0.5, draw: 'uniform' },
      },
    });

    await expect(page.getByTestId('forge-run-gate-reason')).toHaveText(
      'The run was refused before it wrote anything: drawing the sample spread over the org would read about 9,000 API requests of the source org, more than the 50 % of the 14,000 it has left today a drawing may take. No id was read past the counts. Draw the newest or the oldest records, which read only those they keep, choose fewer roots under Which roots, or narrow the large objects with a filter in Review → Controls.',
    );
    // A sample already: no sample offered in its place.
    await expect(page.getByTestId('forge-run-gate-copy-sample-budget')).toHaveCount(0);
    await page.getByTestId('forge-run-gate-draw-newest').click();

    await expect(page.getByTestId('forge-run-gate-notice')).toHaveCount(0);
    await expect(page.getByTestId('review-sample-draw')).toHaveValue('recent');
    await startForgeRun(page);
    const [execute] = (await sentPayloads(page, 'forge:execute')).slice(-1);
    expect(execute.config).toMatchObject({ sample: { draw: 'recent' } });
  });

  test('a drawing of the newest refused is not offered the newest again', async ({ page }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'forge');
    await openWholeOrgReview(page, wholeOrgGraph(), sampleBudget(), true);
    await page.getByTestId('review-sample-draw').selectOption('recent');
    const run = await startForgeRun(page);
    await stopAtTheGate(page, run, {
      code: 'API_BUDGET_EXCEEDED',
      api: {
        kind: 'requests',
        org: 'source',
        estimate: 9_000,
        remaining: 14_000,
        drawing: { share: 0.5, draw: 'recent' },
      },
    });

    await expect(page.getByTestId('forge-run-gate-reason')).toHaveText(
      'The run was refused before it wrote anything: drawing the newest records of the sample would read about 9,000 API requests of the source org, more than the 50 % of the 14,000 it has left today a drawing may take. No id was read past the counts. Choose fewer roots under Which roots, narrow the large objects with a filter in Review → Controls, or draw it once the source has more to spare — the daily limit is counted over the last 24 hours.',
    );
    await expect(page.getByTestId('forge-run-gate-draw-newest')).toHaveCount(0);
  });

  test('a run of every record past the source’s requests offers the sample that fits, which the next run copies', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'forge');
    await openWholeOrgReview(page, wholeOrgGraph(), sampleBudget(), false);
    const run = await startForgeRun(page);
    await stopAtTheGate(page, run, {
      code: 'API_BUDGET_EXCEEDED',
      api: { kind: 'requests', org: 'source', estimate: 120_000, remaining: 4_000 },
    });

    await expect(page.getByTestId('forge-run-gate-reason')).toHaveText(
      'The run was refused before it wrote anything: reading the source org would take about 120,000 of its API requests, and it has 4,000 left today. Run it once the org has more to spare, leave objects out on Review or narrow them with a filter in Review → Controls, or copy a sample of the org that fits the target (Records per object: A sample that fits the target).',
    );
    await expect(page.getByTestId('forge-run-gate-draw-newest')).toHaveCount(0);
    const offer = page.getByTestId('forge-run-gate-copy-sample-budget');
    await expect(offer).toHaveText('Copy a sample that fits');
    await offer.click();

    await expect(page.getByTestId('forge-run-gate-notice')).toHaveCount(0);
    await expect(page.getByTestId('review-sample-fits')).toBeChecked();
    await startForgeRun(page);
    const [execute] = (await sentPayloads(page, 'forge:execute')).slice(-1);
    expect(execute.config).toMatchObject({ inputMode: 'org', sample: {} });
  });
});

test.describe('Forge Review’s owners, on a target with more users than it lists', () => {
  test('gives the records to a user by the id typed, which the run carries', async ({ page }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'forge');
    await openForgeReview(bridge, page, []);
    await page.getByTestId('tab-controls').click();
    await page.getByTestId('review-controls-tab').waitFor({ timeout: 10_000 });
    await answerOnceAsked(
      page,
      'forge:users:request',
      'forge:users:response',
      TARGET_USERS_TRUNCATED,
    );

    await expect(page.getByTestId('controls-users-truncated')).toHaveText(
      "The target org holds more active users: the first 1 by name are listed. Give another by its id, starting 005, in Target user's id.",
    );
    const typed = page.getByLabel("Target user's id");
    await page.getByTestId('controls-owner-source').fill('005000000000001AAA');
    // Picked from the list, the user is that one: the id field is off.
    await page.getByTestId('controls-owner-target').selectOption('005000000000101AAA');
    await expect(typed).toBeDisabled();
    await page.getByTestId('controls-owner-target').selectOption('');
    await typed.fill(UNLISTED_TARGET_USER);
    await page.getByTestId('controls-owner-add').click();

    await expect(page.getByTestId('controls-owner-005000000000001AAA')).toContainText(
      `005000000000001AAA given to ${UNLISTED_TARGET_USER}`,
    );
    await expect(typed).toHaveValue('');
    await startForgeRun(page);
    const [execute] = (await sentPayloads(page, 'forge:execute')).slice(-1);
    expect(execute.config).toMatchObject({
      ownerMappings: { '005000000000001AAA': UNLISTED_TARGET_USER },
    });
  });

  test('offers no id to type when every user is listed', async ({ page }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'forge');
    await openForgeReview(bridge, page, []);
    await page.getByTestId('tab-controls').click();
    await answerOnceAsked(page, 'forge:users:request', 'forge:users:response', {
      ...TARGET_USERS_TRUNCATED,
      truncated: false,
    });

    await expect(page.getByTestId('controls-owner-target')).toBeVisible();
    await expect(page.getByTestId('controls-owner-target-id')).toHaveCount(0);
  });
});

test.describe('Forge Review’s metadata differences', () => {
  test('says each in the page’s words, and does what each offers: a field left out and written again, an object left out, a comparison again', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'forge');
    await openForgeReview(bridge, page);
    await page.getByTestId('tab-metadata').click();

    await expect(page.getByTestId('diff-1')).toContainText(
      'Score__c is a double in the source and a string in the target',
    );
    await expect(page.getByTestId('diff-4')).toContainText(
      'Opportunity could not be compared: the target org did not describe it (REQUEST_LIMIT_EXCEEDED). Compare again once it answers.',
    );
    // Nothing the page does for an object its user may not create: the admin's copy says it.
    await expect(page.getByTestId('diff-5').getByRole('button')).toHaveCount(0);

    const leave = page.getByTestId('diff-0-leave-field');
    await expect(leave).toHaveText('Leave Region__c out');
    await leave.click();
    await expect(page.getByTestId('diff-0-left-out')).toHaveText('Left out of the rows');
    await expect(leave).toHaveText('Write Region__c again');
    await page.getByTestId('diff-2-leave-field').click();
    await page.getByTestId('diff-2-leave-field').click();
    await expect(page.getByTestId('diff-2-left-out')).toHaveCount(0);

    await page.getByTestId('diff-3-leave-object').click();
    await expect(page.getByTestId('diff-3-left-out')).toHaveText('Left out of the clone');
    await expect(page.getByTestId('diff-3-leave-object')).toHaveCount(0);

    const asked = (await requestIds(page, 'forge:metadata-diff:request')).length;
    await page.getByTestId('diff-4-compare-again').click();
    await expect
      .poll(async () => (await requestIds(page, 'forge:metadata-diff:request')).length)
      .toBe(asked + 1);
    await answerAll(page, 'forge:metadata-diff:request', 'forge:metadata-diff:response', {
      diffs: METADATA_DIFFS,
    });
    await expect(page.getByTestId('diff-0-left-out')).toBeVisible();

    await startForgeRun(page);
    const [execute] = (await sentPayloads(page, 'forge:execute')).slice(-1);
    expect(execute.config).toMatchObject({ fieldExclusions: { Contact: ['Region__c'] } });
  });

  test('copies for the target’s admin the grants the differences ask, and says it copied', async ({
    page,
  }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const bridge = new MockBridge();
    await openModule(bridge, page, 'forge');
    await openForgeReview(bridge, page);
    await page.getByTestId('tab-metadata').click();

    const copy = page.getByTestId('metadata-admin-copy');
    await expect(copy).toHaveText("Copy for the target's admin");
    await copy.click();
    await expect(page.getByTestId('metadata-admin-copy-copied')).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(METADATA_ADMIN_COPY);
  });

  test('offers no copy when no difference asks a grant', async ({ page }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'forge');
    await openForgeReview(bridge, page, METADATA_DIFFS.slice(0, 2));
    await page.getByTestId('tab-metadata').click();

    await expect(page.getByTestId('diff-0')).toBeVisible();
    await expect(page.getByTestId('metadata-admin-copy')).toHaveCount(0);
  });
});

test.describe('Forge Review of the whole org, what it leaves out for rights', () => {
  test('says under each reason what lifts it, and copies the changes for the admins of the two orgs', async ({
    page,
  }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const bridge = new MockBridge();
    await openModule(bridge, page, 'forge');
    await openWholeOrgReview(
      page,
      { ...wholeOrgGraph(), leftOut: LEFT_OUT_FOR_RIGHTS },
      sampleBudget(),
      false,
    );
    await page.getByTestId('tab-plan').click();
    await page.getByTestId('review-left-out-toggle').click();

    await expect(page.getByTestId('left-out-way-notWritable')).toHaveText(
      "The target's admin gives the user SandForge writes as Create, Edit and Delete on them, or turns on the feature they come with; then discover again.",
    );
    await expect(page.getByTestId('left-out-way-notQueryable')).toHaveText(
      "The source's admin gives the user SandForge reads as Read on them, then discover again.",
    );
    await expect(page.getByTestId('left-out-way-chatter')).toHaveCount(0);
    const copy = page.getByTestId('left-out-admin-copy');
    await expect(copy).toHaveText('Copy the changes for the admins');
    await copy.click();
    await expect(page.getByTestId('left-out-admin-copy-copied')).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(LEFT_OUT_ADMIN_COPY);
  });
});

test.describe('Monitor’s resume of a stopped clone, refused', () => {
  test('says in a notification that the target could not be read, and to reconnect it', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'monitor');
    await openMonitorWithAStoppedClone(bridge, page);
    await refuseResume(bridge, page, RESUME_TARGET_UNREAD_REFUSAL);

    expect((await sentPayloads(page, 'forge:resume-run')).at(-1)).toEqual({
      forgeId: 'forge-run-stopped',
    });
    const toasts = page.getByTestId('floating-toasts');
    await expect(toasts).toContainText('The clone could not be taken up');
    await expect(toasts).toContainText(
      'The target could not be read for the insert calls the run had under way when it stopped: taken up without them, it would write their records twice. Reconnect the org on Organizations if its session expired, then resume the run again. Nothing was written.',
    );
  });

  test('says in a notification that its journal could not be opened, with the folder and why', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'monitor');
    await openMonitorWithAStoppedClone(bridge, page);
    await refuseResume(bridge, page, JOURNAL_UNAVAILABLE_REFUSAL);

    const toasts = page.getByTestId('floating-toasts');
    await expect(toasts).toContainText('The clone could not be taken up');
    await expect(toasts).toContainText(
      `The run's journal on this machine's disk could not be opened. ${JOURNAL_UNAVAILABLE_REFUSAL.message}`,
    );
  });
});

test.describe('records a lock refused and a run sent again', () => {
  test('an Autopilot node says how many went again, how many were written, and what is among its refusals', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'autopilot');
    await openAutopilotNode(bridge, page, {
      nodeId: 'Contact',
      objectName: 'Contact',
      status: 'completed',
      wave: 1,
      recordCount: 1198,
      failureCount: 2,
      sentAgainForALock: SENT_AGAIN_FOR_A_LOCK,
    });

    await expect(page.getByTestId('node-sent-again-for-a-lock')).toHaveText(SENT_AGAIN_WORDS);
  });

  test('an Autopilot node none of whose records went again says nothing of it', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'autopilot');
    await openAutopilotNode(bridge, page, {
      nodeId: 'Account',
      objectName: 'Account',
      status: 'completed',
      wave: 0,
      recordCount: 500,
      failureCount: 0,
    });

    await expect(page.getByTestId('node-detail')).toBeVisible();
    await expect(page.getByTestId('node-sent-again-for-a-lock')).toHaveCount(0);
  });

  test('the Sync wizard’s results say it under the object, beside its refusals', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'sync', { state: { syncDraft: SYNC_READY_DRAFT } });
    await runSyncDraft(bridge, page, syncRunSentAgain());

    await expect(page.getByTestId('sync-result-written-Contact-sentAgainForALock')).toHaveText(
      SENT_AGAIN_WORDS,
    );
  });

  test('Quick Sync’s results say it under the object', async ({ page }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'sync', { state: QUICK_SYNC_ON_PREVIEW });
    await runQuickSync(bridge, page, syncRunSentAgain());

    await expect(
      page.getByTestId('quick-sync-result-written-Contact-sentAgainForALock'),
    ).toHaveText(SENT_AGAIN_WORDS);
  });

  test('the run, opened from the Sync page’s History, says it under the object', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'sync', { state: { syncDraft: SYNC_READY_DRAFT } });
    await openSyncHistoryEntry(bridge, page, syncHistoryEntrySentAgain());

    await expect(page.getByTestId('history-written-Contact-sentAgainForALock')).toHaveText(
      SENT_AGAIN_WORDS,
    );
  });
});

test.describe('the bound a Sync reads each object to', () => {
  test('Quick Sync’s preview says it, and of an object the source holds more of, how many it copies', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'sync', { state: QUICK_SYNC_ON_A_CUT_PREVIEW });
    await page.getByTestId('quick-sync-start-btn').click();

    await expect(page.getByTestId('quick-sync-preview-read-cap')).toHaveText(
      'Each object is read up to 10,000 records, from either org, as sandforge.sync.maxRecordsPerObject sets it (50,000 at most): one holding more is copied in part, and the run says so. To copy part of a larger org that fits the target, use Forge with Depth ALL and Records per object set to A sample that fits the target.',
    );
    await expect(page.getByTestId('quick-sync-preview-read-cut-Contact')).toHaveText(
      '10,000 of the 30,000 records the source org holds: the rest is not copied.',
    );
    await expect(page.getByTestId('quick-sync-preview-read-cut-Account')).toHaveCount(0);
  });

  test('a Quick Sync preview from a host that says no bound says none', async ({ page }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'sync', { state: QUICK_SYNC_ON_PREVIEW });
    await page.getByTestId('quick-sync-start-btn').click();

    await expect(page.getByTestId('quick-sync-preview-step')).toBeVisible();
    await expect(page.getByTestId('quick-sync-preview-read-cap')).toHaveCount(0);
  });

  test('a simulation says it, and of an object it cut, how to read the rest', async ({ page }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'sync', { state: { syncDraft: SYNC_READY_DRAFT } });
    await simulateSyncDraft(bridge, page, simulationCutAtReadCap(10_000));

    await expect(page.getByTestId('sync-simulation-read-cap')).toContainText(
      'Each object is read up to 10,000 records',
    );
    await expect(page.getByTestId('sync-simulation-read-cut-Invoice__c')).toHaveText(
      'The read stopped at 10,000 records, the bound: a run copies part of this object. To copy the rest, raise sandforge.sync.maxRecordsPerObject (50,000 at most), or read it in slices with a filter on CreatedDate, one range per run.',
    );
  });

  test('a simulation cut at the most a run holds offers slices alone', async ({ page }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'sync', { state: { syncDraft: SYNC_READY_DRAFT } });
    await simulateSyncDraft(bridge, page, simulationCutAtReadCap(50_000));

    await expect(page.getByTestId('sync-simulation-read-cut-Invoice__c')).toHaveText(
      'The read stopped at 50,000 records, the most a run holds of an object: a run copies part of it. To copy the rest, read it in slices with a filter on CreatedDate, one range per run.',
    );
  });

  test('a run whose read the bound cut says partial, and on the object what it copied and how to copy the rest', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'sync', { state: { syncDraft: SYNC_READY_DRAFT } });
    await runSyncDraft(bridge, page, syncRunCutAtReadCap(10_000));

    await expect(page.getByTestId('sync-result-summary')).toContainText('Partially complete');
    await expect(page.getByTestId('sync-result-read-cut-Contact')).toHaveText(
      'The read of the source org stopped at 10,000 records, the bound: this run copied part of this object. To copy the rest, raise sandforge.sync.maxRecordsPerObject (50,000 at most), or read it in slices with a filter on CreatedDate, one range per run. To copy a sample of the source that fits the target instead, use Forge with Depth ALL and Records per object set to A sample that fits the target.',
    );
  });

  test('Quick Sync’s results say it, at the most a run holds, with slices and the sample alone', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'sync', { state: QUICK_SYNC_ON_PREVIEW });
    await runQuickSync(bridge, page, syncRunCutAtReadCap(50_000));

    await expect(page.getByTestId('quick-sync-result-read-cut-Contact')).toHaveText(
      'The read of the source org stopped at 50,000 records, the most a run holds of an object: this run copied part of it. To copy the rest, read it in slices with a filter on CreatedDate, one range per run. To copy a sample of the source that fits the target instead, use Forge with Depth ALL and Records per object set to A sample that fits the target.',
    );
  });

  test('the run, opened from the Sync page’s History, says it as its results did', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'sync', { state: { syncDraft: SYNC_READY_DRAFT } });
    await openSyncHistoryEntry(bridge, page, syncHistoryEntryCutAtReadCap());

    await expect(page.getByTestId('history-read-cut-Contact')).toContainText(
      'The read of the source org stopped at 10,000 records, the bound: this run copied part of this object.',
    );
  });

  test('a write check that counts the requests says what a lock’s sends again add past it', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'sync', { state: { syncDraft: SYNC_READY_DRAFT } });
    await simulateUnwritable(bridge, page, 'notCreateable');

    await expect(page.getByTestId('sync-write-check-api-lock-resends')).toHaveText(
      'Rows the target org refuses for a record lock go again on their own, up to 3 times each: up to 3 more requests for every 200 of them, which this estimate cannot count before the write.',
    );
  });
});

test.describe('Forge Review’s metadata differences, by severity', () => {
  test('names each severity in the page’s language, not the code’s capitals', async ({ page }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'forge');
    await openForgeReview(bridge, page);
    await page.getByTestId('tab-metadata').click();

    await expect(page.getByTestId('diff-0-severity')).toHaveText('Warning');
    await expect(page.getByTestId('diff-3-severity')).toHaveText('Error');
    await expect(page.getByTestId('diff-6-severity')).toHaveText('Info');
  });

  test('names them in French for an editor in French', async ({ page }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'forge', { language: 'fr' });
    await openForgeReview(bridge, page);
    await page.getByTestId('tab-metadata').click();

    await expect(page.getByTestId('diff-0-severity')).toHaveText('Avertissement');
    await expect(page.getByTestId('diff-3-severity')).toHaveText('Erreur');
    await expect(page.getByTestId('diff-6-severity')).toHaveText('Info');
  });
});

test.describe('Forge’s verification of an object only the platform wrote', () => {
  test('says the run wrote none of it, and how many the platform wrote with their record', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await openModule(bridge, page, 'forge');
    await verifyForgeRun(page, VERIFIED_WITH_THE_PLATFORMS);

    await expect(page.getByTestId('forge-verification-OpportunityContactRole')).toHaveText(
      'OpportunityContactRole: none written by the run · 2 written by the platform with their record',
    );
    await expect(page.getByTestId('forge-verification-Opportunity')).not.toContainText(
      'none written by the run',
    );
  });
});
