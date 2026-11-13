import { test, expect, type Page } from '@playwright/test';
import { MockBridge } from './helpers';
import { MOCK_ORGS, createMockOrg } from './fixtures';
import {
  EMPTY_ORG,
  RUN_ID,
  blockedRunResult,
  cancelledRunResult,
  emptyAudit,
  emptyScope,
  objectsPreview,
  orgPreview,
  runResult,
  undoResult,
} from './fixtures/empty';
import { sendExtensionMessage } from './mocks/vscode-api';

/**
 * DataOps → Cleanup → Empty objects and Empty the org, on the fake bridge,
 * every answer in the shape the extension sends (fixtures/empty.ts): a
 * preview before any button deletes, a production org never asked, a delete
 * for good greyed out without its permission, a confirmation armed by the
 * org's name, a stop, an undo, and a run the preview named blockers for.
 */

/** Every outgoing message of a type, unwrapped from the post envelope. */
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

/** Answer every request of a type sent so far: StrictMode sends a query twice. */
async function respondToAll(
  page: Page,
  requestType: string,
  responseType: string,
  payload: unknown,
): Promise<void> {
  for (const request of await outgoing(page, requestType)) {
    const correlationId = request.id as string;
    await sendExtensionMessage(page, {
      type: responseType,
      id: `resp-${correlationId}`,
      correlationId,
      payload,
    });
  }
}

/** Answer the last request of a type: the one a mutation waits on. */
async function respondToLast(
  page: Page,
  requestType: string,
  responseType: string,
  payload: unknown,
): Promise<string> {
  await expect.poll(async () => (await outgoing(page, requestType)).length).toBeGreaterThan(0);
  const requests = await outgoing(page, requestType);
  const correlationId = requests[requests.length - 1].id as string;
  await sendExtensionMessage(page, {
    type: responseType,
    id: `resp-${correlationId}`,
    correlationId,
    payload,
  });
  return correlationId;
}

/** The payload of the last request of a type. */
async function lastPayload(page: Page, type: string): Promise<Record<string, unknown>> {
  const requests = await outgoing(page, type);
  return requests[requests.length - 1].payload as Record<string, unknown>;
}

/** Boot DataOps on `orgs`, open Cleanup, and answer what its parts ask as they open. */
async function openCleanup(
  page: Page,
  orgs: readonly unknown[] = MOCK_ORGS,
  scope = emptyScope(),
): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'dataops';
  });
  await page.goto('/');
  await bridge.seedOrgs(orgs);
  await page.getByTestId('page-tab-cleanup').click();
  await bridge.waitForMessage('seed:describe-global', { timeout: 10_000 });
  await respondToAll(page, 'seed:describe-global', 'seed:describe-global:response', {
    objects: [{ apiName: 'Account', label: 'Account' }],
  });
  await page.getByTestId('empty-panel').or(page.getByTestId('empty-production')).waitFor();
  if (await page.getByTestId('empty-panel').isVisible()) {
    await bridge.waitForMessage('dataops:empty:scope', { timeout: 10_000 });
    await respondToAll(page, 'dataops:empty:scope', 'dataops:empty:scope:response', scope);
    await bridge.waitForMessage('reports:audit', { timeout: 10_000 });
    await respondToAll(page, 'reports:audit', 'reports:audit:response', {
      entries: emptyAudit(),
      total: 1,
      offset: 0,
      facets: { modules: ['dataops'], orgs: [] },
    });
  }
  return bridge;
}

/** Pick Account and Contact, ask the preview, and answer it with `answer`. */
async function previewObjects(page: Page, answer = objectsPreview()): Promise<void> {
  await page.getByTestId('empty-pick-option-Account').check();
  await page.getByTestId('empty-pick-option-Contact').check();
  await page.getByTestId('empty-objects-preview').click();
  await respondToLast(page, 'dataops:empty:preview', 'dataops:empty:preview:response', answer);
  await page.getByTestId('empty-preview').waitFor();
}

test.describe('DataOps — Empty objects and Empty the org', () => {
  test('says the whole preview before any button deletes, and asks it as picked', async ({
    page,
  }) => {
    await openCleanup(page);
    // Nothing deletes before a preview: no button for it on the page.
    await expect(page.getByTestId('empty-preview-empty')).toHaveCount(0);
    await expect(page.getByTestId('empty-objects-preview')).toBeDisabled();
    await expect(page.getByTestId('empty-objects-not-pickable')).toContainText('5 objects');

    await previewObjects(page);
    expect(await lastPayload(page, 'dataops:empty:preview')).toEqual({
      orgId: EMPTY_ORG.id,
      request: { mode: 'objects', objects: ['Account', 'Contact'] },
      deleteMode: 'recycle',
      fromPage: true,
    });

    const preview = page.getByTestId('empty-preview');
    await expect(page.getByTestId('empty-preview-summary')).toContainText(
      '780 records of 5 objects go to the recycle bin.',
    );
    await expect(page.getByTestId('empty-preview-pass-Contact')).toContainText('340');
    await expect(page.getByTestId('empty-preview-pass-Contact')).toContainText('1 call');
    await expect(page.getByTestId('empty-preview-along-Task')).toHaveText(
      'at most 96 Task, by WhatId → Account',
    );
    await expect(page.getByTestId('empty-preview-likely-activatedOrder')).toContainText(
      'set back to Draft first',
    );
    await expect(page.getByTestId('empty-preview-blocker-Case')).toContainText(
      '2 Case, not emptied, name these records by AccountId → Account',
    );
    await expect(page.getByTestId('empty-preview-cost-requests')).toHaveText(
      'About 31 API requests, 99,000 of 100,000 left today.',
    );
    await expect(page.getByTestId('empty-preview-cost-bin')).toHaveText(
      '780 records go to the recycle bin.',
    );
    await expect(preview.getByTestId('empty-automation')).toContainText(
      `Nothing ${EMPTY_ORG.alias} automates runs as these records are deleted.`,
    );
    await expect(page.getByTestId('empty-preview-empty')).toHaveText(
      'Delete 780 records from 5 objects…',
    );
    await expect(page.getByTestId('empty-preview-empty')).toBeEnabled();

    // An option changed since: the preview no longer says what a run would do.
    await page.getByTestId('empty-pick-option-Region__c').check();
    await expect(page.getByTestId('empty-preview-stale')).toBeVisible();
    await expect(page.getByTestId('empty-preview-empty')).toBeDisabled();
  });

  test('refuses a production org and asks it nothing', async ({ page }) => {
    const production = createMockOrg({
      id: 'org-prod-1',
      alias: 'Prod',
      orgType: 'Production',
    });
    await openCleanup(page, [production]);
    await expect(page.getByTestId('empty-production-refusal')).toContainText(
      'Prod is a production org, or cannot be told from one.',
    );
    await expect(page.getByTestId('empty-objects')).toHaveCount(0);
    await expect(page.getByTestId('empty-org')).toHaveCount(0);
    expect(await outgoing(page, 'dataops:empty:scope')).toEqual([]);
    expect(await outgoing(page, 'dataops:empty:preview')).toEqual([]);
  });

  test('refuses an org the extension finds is a production org, whatever the registry says', async ({
    page,
  }) => {
    const bridge = new MockBridge();
    await bridge.setup(page);
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'dataops';
    });
    await page.goto('/');
    await bridge.seedOrgs(MOCK_ORGS);
    await page.getByTestId('page-tab-cleanup').click();
    await bridge.waitForMessage('dataops:empty:scope', { timeout: 10_000 });
    await respondToAll(page, 'dataops:empty:scope', 'dataops:error', {
      message:
        'DevSandbox is a production org, or cannot be told from one: its Organization record ' +
        'says IsSandbox false, edition Enterprise Edition. No record was read or deleted.',
      code: 'PRODUCTION',
      retryable: false,
    });
    await expect(page.getByTestId('empty-production-refusal')).toBeVisible();
    await expect(page.getByTestId('empty-objects-preview')).toHaveCount(0);
  });

  test('greys the delete for good out without Bulk API Hard Delete, and says why', async ({
    page,
  }) => {
    await openCleanup(page);
    await expect(page.getByTestId('empty-objects-hard')).toBeDisabled();
    await expect(page.getByTestId('empty-objects-hard-why')).toHaveText(
      `Greyed out: ${EMPTY_ORG.username} doesn't have Bulk API Hard Delete, and Salesforce ` +
        'refuses a hard delete without it. A permission set with it lets you tick this.',
    );
    await expect(page.getByTestId('empty-org-hard')).toBeDisabled();
  });

  test('deletes for good only when ticked with the permission, its confirmation saying no Undo', async ({
    page,
  }) => {
    await openCleanup(page, MOCK_ORGS, emptyScope({ permitted: true }));
    await expect(page.getByTestId('empty-objects-hard')).toBeEnabled();
    await page.getByTestId('empty-objects-hard').check();
    const hard = objectsPreview();
    await previewObjects(page, {
      ...hard,
      preview: { ...hard.preview, deleteMode: 'hard', undo: false },
      hardDelete: { permitted: true },
    });
    expect((await lastPayload(page, 'dataops:empty:preview')).deleteMode).toBe('hard');
    await expect(page.getByTestId('empty-preview-hard')).toContainText(
      'Undo will not be possible.',
    );
    await page.getByTestId('empty-preview-empty').click();
    await expect(page.getByTestId('empty-confirm-no-undo')).toHaveText(
      'Undo will not be possible: Salesforce brings back nothing a hard delete takes.',
    );
    await expect(page.getByTestId('danger-title')).toHaveText(`Empty ${EMPTY_ORG.alias}?`);
  });

  test('arms the emptying with the org name typed, the button saying the act and its size', async ({
    page,
  }) => {
    await openCleanup(page);
    await page.getByTestId('empty-org-preview').click();
    expect(await lastPayload(page, 'dataops:empty:preview')).toEqual({
      orgId: EMPTY_ORG.id,
      request: { mode: 'org' },
      deleteMode: 'recycle',
      fromPage: true,
    });
    await respondToLast(
      page,
      'dataops:empty:preview',
      'dataops:empty:preview:response',
      orgPreview(),
    );
    await expect(page.getByTestId('empty-preview-cost-bin-past')).toContainText('12,500');

    // Undo would leave custom prices behind: held until that is accepted.
    await expect(page.getByTestId('empty-preview-holding-NO_UNDO')).toBeVisible();
    await expect(page.getByTestId('empty-preview-empty')).toBeDisabled();
    await page.getByTestId('empty-preview-accept-no-undo').check();
    await expect(page.getByTestId('empty-preview-holding')).toHaveCount(0);

    await page.getByTestId('empty-preview-empty').click();
    const confirm = page.getByTestId('danger-confirm-btn');
    await expect(confirm).toHaveText('Delete 48,213 records from 37 objects');
    await expect(confirm).toBeDisabled();
    await page.getByTestId('danger-input').fill('devsandbox');
    await expect(confirm).toBeDisabled();
    await page.getByTestId('danger-input').fill(EMPTY_ORG.alias);
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect.poll(async () => (await outgoing(page, 'dataops:empty:run')).length).toBe(1);
    expect(await lastPayload(page, 'dataops:empty:run')).toEqual({
      orgId: EMPTY_ORG.id,
      previewId: orgPreview().previewId,
      acceptNoUndo: true,
      acceptAutomation: true,
      fromPage: true,
    });
    await expect(page.getByTestId('empty-outcome-running')).toBeVisible();
  });

  test('stops a run from its page before its next call, and says what it did not reach', async ({
    page,
  }) => {
    await openCleanup(page);
    await previewObjects(page);
    await page.getByTestId('empty-preview-empty').click();
    await page.getByTestId('danger-input').fill(EMPTY_ORG.alias);
    await page.getByTestId('danger-confirm-btn').click();
    await expect.poll(async () => (await outgoing(page, 'dataops:empty:run')).length).toBe(1);
    const [run] = await outgoing(page, 'dataops:empty:run');
    const operationId = run.id as string;
    await sendExtensionMessage(page, {
      type: 'operation:progress',
      payload: {
        operationId,
        percentage: 40,
        processedRecords: 0,
        totalRecords: 0,
        currentStep: 'Contact: 10 of about 25 settled',
      },
    });
    await expect(page.getByTestId('empty-outcome-step')).toHaveText(
      'Contact: 10 of about 25 settled',
    );

    await page.getByTestId('empty-outcome-stop').click();
    await expect.poll(async () => (await outgoing(page, 'dataops:empty:cancel')).length).toBe(1);
    expect(await lastPayload(page, 'dataops:empty:cancel')).toEqual({ operationId });
    await respondToLast(page, 'dataops:empty:cancel', 'dataops:empty:cancel:response', {
      operationId,
      cancelled: true,
    });
    await expect(page.getByTestId('empty-outcome-stopping')).toBeVisible();
    await respondToLast(page, 'dataops:empty:run', 'dataops:empty:run:response', {
      operationId,
      result: cancelledRunResult(),
    });
    await expect(page.getByTestId('empty-outcome-title')).toHaveText(
      `The emptying of ${EMPTY_ORG.alias} was stopped`,
    );
    await expect(page.getByTestId('empty-result-totals')).toContainText('25 not reached');
    await expect(page.getByTestId('empty-result-pass-Contact')).toContainText('25');
  });

  test('brings the records back with Undo, asked with the org name and what fires', async ({
    page,
  }) => {
    await openCleanup(page);
    await previewObjects(page);
    await page.getByTestId('empty-preview-empty').click();
    await page.getByTestId('danger-input').fill(EMPTY_ORG.alias);
    await page.getByTestId('danger-confirm-btn').click();
    await respondToLast(page, 'dataops:empty:run', 'dataops:empty:run:response', {
      operationId: 'r',
      result: runResult(),
    });
    await expect(page.getByTestId('empty-outcome-title')).toHaveText(`${EMPTY_ORG.alias} emptied`);
    await page.getByTestId('empty-result-undo').click();
    await expect(page.getByTestId('danger-title')).toHaveText(
      `Bring back what ${RUN_ID} deleted from ${EMPTY_ORG.alias}?`,
    );
    await page.getByTestId('empty-act-accept-automation').check();
    await page.getByTestId('danger-input').fill(EMPTY_ORG.alias);
    await page.getByTestId('danger-confirm-btn').click();

    await expect.poll(async () => (await outgoing(page, 'dataops:empty:undo')).length).toBe(1);
    expect(await lastPayload(page, 'dataops:empty:undo')).toEqual({
      orgId: EMPTY_ORG.id,
      runId: RUN_ID,
      acceptAutomation: true,
      fromPage: true,
    });
    await respondToLast(page, 'dataops:empty:undo', 'dataops:empty:undo:response', {
      operationId: 'u',
      result: undoResult(),
    });
    await expect(page.getByTestId('empty-outcome-title')).toHaveText(
      `What the emptying deleted is back in ${EMPTY_ORG.alias}`,
    );
    await expect(page.getByTestId('empty-undo-object-Contact')).toContainText(
      '23 of 25 brought back. 2 were back already.',
    );
    // The history is read again once the undo ended.
    await expect
      .poll(async () => (await outgoing(page, 'reports:audit')).length)
      .toBeGreaterThan(2);
  });

  test('a run the preview named blockers for: named before, refused after with the org words', async ({
    page,
  }) => {
    await openCleanup(page);
    await previewObjects(page);
    await expect(page.getByTestId('empty-preview-blockers')).toBeVisible();
    await page.getByTestId('empty-preview-empty').click();
    await expect(page.getByTestId('empty-confirm-blockers')).toContainText('2 records');
    await page.getByTestId('danger-input').fill(EMPTY_ORG.alias);
    await page.getByTestId('danger-confirm-btn').click();
    await respondToLast(page, 'dataops:empty:run', 'dataops:empty:run:response', {
      operationId: 'r',
      result: blockedRunResult(),
    });
    await expect(page.getByTestId('empty-outcome-title')).toHaveText(
      `${EMPTY_ORG.alias} emptied in part`,
    );
    await expect(page.getByTestId('empty-result-pass-Account')).toContainText(
      'DELETE_FAILED: a Case still names it in AccountId',
    );
    await expect(page.getByTestId('empty-result-totals')).toContainText('2 refused');
  });

  test('holds the emptying while a refusal no box lifts stands, and says it', async ({ page }) => {
    await openCleanup(page);
    await previewObjects(
      page,
      objectsPreview({
        peopleActive: { people: 2 },
        refusals: [
          {
            code: 'PEOPLE_ACTIVE',
            message:
              '2 people other than the user SandForge deletes as changed records of these ' +
              'objects in DevSandbox in the last hour: emptying them would take their work. ' +
              'Empty once they have stopped. No record was read or deleted.',
          },
        ],
      }),
    );
    await expect(page.getByTestId('empty-preview-holding-PEOPLE_ACTIVE')).toContainText(
      '2 people other than the user',
    );
    await expect(page.getByTestId('empty-preview-empty')).toBeDisabled();
  });

  test('lists the org history from the audit trail, Undo on its last emptying', async ({
    page,
  }) => {
    await openCleanup(page);
    const entry = page.getByTestId(`empty-history-${emptyAudit()[0].id}`);
    await expect(entry).toContainText('143 records deleted, 2 refused');
    await expect(entry).toContainText(RUN_ID);
    expect(await lastPayload(page, 'reports:audit')).toEqual({
      module: 'dataops',
      orgId: EMPTY_ORG.id,
      limit: 2000,
    });
    await page.getByTestId('empty-history-undo').click();
    await expect(page.getByTestId('danger-title')).toHaveText(
      `Bring back what ${RUN_ID} deleted from ${EMPTY_ORG.alias}?`,
    );
  });

  test('a sandbox marked Staging: the whole org is refused, objects are offered', async ({
    page,
  }) => {
    await openCleanup(page, [{ ...MOCK_ORGS[0], staging: true }]);
    await expect(page.getByTestId('empty-org-staging')).toContainText('marked Staging');
    await expect(page.getByTestId('empty-org-preview')).toHaveCount(0);
    await expect(page.getByTestId('empty-objects-staging')).toBeVisible();
    expect(await lastPayload(page, 'dataops:empty:scope')).toEqual({
      orgId: EMPTY_ORG.id,
      mode: 'objects',
      objects: [],
    });
    await page.getByTestId('empty-pick-option-Account').check();
    await expect(page.getByTestId('empty-objects-preview')).toBeEnabled();
  });
});
