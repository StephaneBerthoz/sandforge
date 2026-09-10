import { test, expect, type Page, type Locator } from '@playwright/test';

import { MockBridge } from './helpers';
import { MOCK_ORGS } from './fixtures';
import { sendExtensionMessage } from './mocks/vscode-api';

/**
 * Conflict resolution E2E — the Sync panel's `conflicts` tab.
 *
 * Replaces `quarantine/quick-sync-conflict-resolve.spec.ts`, which drove a
 * `?e2e-harness=sync-conflict` stub over `sync:conflict:detected` /
 * `sync:conflict:resolve`. Neither message type exists anywhere in the repo:
 * the harness answered itself, so the file proved nothing about the product.
 *
 * The shipped feature speaks `realtime:*`:
 *   - the host pushes `realtime:conflict` (`realtime.messages.ts:126`), which
 *     `useCDCLiveStore`'s window listener (`useCDCLiveStore.ts:241`) normalizes
 *     into a `UIConflict` and hands to `useConflictStore`;
 *   - the panel sends `realtime:resolve-conflict`
 *     (`realtime.messages.ts:33`, routed at `ExtensionHandlers.ts`), carrying
 *     either a bulk strategy or the per-field choices.
 *
 * Because the push is a plain `window.postMessage` with no correlationId, no
 * request/response pairing is involved — but the panel is still booted the way
 * every other module spec boots one: `__SANDFORGE_MODULE__` before load,
 * `MockBridge.setup` before `goto`, `seedOrgs` before waiting on `sync-page`
 * (SyncPage short-circuits to an EmptyState below two orgs).
 *
 * What matters most here is the *payload* of `realtime:resolve-conflict`, not
 * the pixels: a panel that renders the right diff but sends the wrong values
 * overwrites live Salesforce records. Every resolution test therefore reads
 * the outgoing message field by field.
 */

/** Fields of `realtime:conflict` as `RealTimeConflictDetected` declares them. */
interface ConflictPush {
  replayId: number;
  objectApiName: string;
  recordIds: string[];
  changeType: string;
  sourceValues: Record<string, unknown>;
  targetValues: Record<string, unknown>;
  targetLastModified: string;
}

/**
 * Two records in conflict on the same object.
 *
 * `Industry` is deliberately identical on both sides of ACCOUNT_A: the store
 * derives `conflictFields` by comparing values, so that field must show up in
 * the diff table without ever becoming a resolvable row. And ACCOUNT_A's
 * `Phone` is a field ACCOUNT_B does not have — that asymmetry is what makes
 * cross-conflict leakage observable.
 */
const ACCOUNT_A: ConflictPush = {
  replayId: 4001,
  objectApiName: 'Account',
  recordIds: ['001A0000000AaaaAAA'],
  changeType: 'UPDATE',
  sourceValues: {
    Name: 'Acme Industries (source)',
    Phone: '+33 1 11 11 11 11',
    Industry: 'Technology',
  },
  targetValues: {
    Name: 'Acme Industries (target)',
    Phone: '+33 2 22 22 22 22',
    Industry: 'Technology',
  },
  targetLastModified: '2026-09-10T08:00:00.000Z',
};

const ACCOUNT_B: ConflictPush = {
  replayId: 4002,
  objectApiName: 'Account',
  recordIds: ['001B0000000BbbbBBB'],
  changeType: 'UPDATE',
  sourceValues: { Name: 'Globex (source)', Industry: 'Finance' },
  targetValues: { Name: 'Globex (target)', Industry: 'Energy' },
  targetLastModified: '2026-09-10T08:05:00.000Z',
};

/**
 * A third record conflicting on exactly the same field names as ACCOUNT_A.
 *
 * Same fields, different record, different values — the case where a panel
 * that reuses the previous conflict's choices looks fully decided the instant
 * it opens.
 */
const ACCOUNT_C: ConflictPush = {
  replayId: 4003,
  objectApiName: 'Account',
  recordIds: ['001C0000000CcccCCC'],
  changeType: 'UPDATE',
  sourceValues: { Name: 'Initech (source)', Phone: '+33 4 44 44 44 44' },
  targetValues: { Name: 'Initech (target)', Phone: '+33 5 55 55 55 55' },
  targetLastModified: '2026-09-10T08:10:00.000Z',
};

/** The id `useCDCLiveStore` builds for a pushed conflict. */
function conflictId(push: ConflictPush): string {
  return `${push.objectApiName}:${push.recordIds[0]}:${String(push.replayId)}`;
}

/**
 * Every outgoing message of a type, unwrapped from the post envelope.
 *
 * Local on purpose. `MockBridge.getMessages(type)` filters on a top-level
 * `type`, but `sendBridgeMessage` posts `{ protocolVersion, correlationId,
 * payload: message }` — the type lives one level down, so that helper returns
 * `[]` for every application message. The shared helpers are read-only here,
 * so the unwrapping lives in this file.
 */
async function outgoing(page: Page, type: string): Promise<Record<string, unknown>[]> {
  return page.evaluate((msgType) => {
    const msgs = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
    return msgs
      .map((m) => {
        const envelope = m as Record<string, unknown>;
        return (envelope.payload as Record<string, unknown> | undefined) ?? envelope;
      })
      .filter((m) => m.type === msgType) as Record<string, unknown>[];
  }, type);
}

/** The application payloads of every `realtime:resolve-conflict` sent so far. */
async function resolutionsSent(page: Page): Promise<
  {
    conflictId?: string;
    resolution?: string;
    fieldResolutions?: Record<string, { value: unknown; source: string }>;
  }[]
> {
  const messages = await outgoing(page, 'realtime:resolve-conflict');
  return messages.map(
    (m) =>
      m.payload as {
        conflictId?: string;
        resolution?: string;
        fieldResolutions?: Record<string, { value: unknown; source: string }>;
      },
  );
}

/** Boot the Sync panel with two connected orgs, as the extension opens it. */
async function openSyncPanel(page: Page): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'sync';
  });
  await page.goto('/');
  await bridge.seedOrgs(MOCK_ORGS);
  await expect(page.getByTestId('sync-page')).toBeVisible({ timeout: 10_000 });
  return bridge;
}

/**
 * Push a `realtime:conflict` from the host.
 *
 * `useCDCLiveStore` registers its listener at module scope, and SyncPage pulls
 * that module in statically through `RealTimeSyncPanel`, so the listener is
 * live from the moment `sync-page` renders — no tab has to be open first.
 */
async function pushConflict(page: Page, push: ConflictPush): Promise<void> {
  await sendExtensionMessage(page, {
    type: 'realtime:conflict',
    id: `conflict-${String(push.replayId)}`,
    payload: push,
  });
}

/** The count badge inside the Conflicts tab — the only `<span>` that button holds. */
function tabBadge(page: Page): Locator {
  return page.getByTestId('tab-conflicts').locator('span');
}

/** Open the Conflicts tab. */
async function openConflictsTab(page: Page): Promise<void> {
  await page.getByTestId('tab-conflicts').click();
  await expect(page.getByTestId('conflict-list-panel')).toBeVisible({ timeout: 10_000 });
}

/** The list row holding a given record id. */
function conflictRow(page: Page, push: ConflictPush): Locator {
  return page
    .getByTestId('data-table')
    .locator('[data-testid^="table-row-"]')
    .filter({ hasText: push.recordIds[0] });
}

/** Select a conflict from the list and wait for its resolution panel. */
async function selectConflict(page: Page, push: ConflictPush): Promise<void> {
  await conflictRow(page, push).click();
  await expect(page.getByTestId('conflict-resolution-panel')).toContainText(push.recordIds[0], {
    timeout: 10_000,
  });
}

/** Type the confirmation word into the open DangerConfirm and confirm it. */
async function confirmDanger(page: Page): Promise<void> {
  const input = page.getByTestId('danger-input');
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill('CONFIRM');
  await page.getByTestId('danger-confirm-btn').click();
  await expect(page.getByTestId('danger-input')).toHaveCount(0);
}

test.describe('Sync conflicts — arrival', () => {
  test('the tab is badge-free and the list empty until the host pushes something', async ({
    page,
  }) => {
    await openSyncPanel(page);

    // No conflict yet: the badge is not merely showing zero, it is absent.
    await expect(tabBadge(page)).toHaveCount(0);

    await openConflictsTab(page);
    await expect(page.getByTestId('conflict-list-panel')).toContainText('No conflicts detected');
    await expect(page.getByTestId('data-table')).toHaveCount(0);
    // Nothing selected, so the detail side says so rather than showing a panel.
    await expect(page.getByTestId('conflict-placeholder')).toContainText(
      'Select a conflict to view details',
    );
    await expect(page.getByTestId('conflict-resolution-panel')).toHaveCount(0);
  });

  test('a pushed conflict raises the tab badge and lands in the list', async ({ page }) => {
    await openSyncPanel(page);

    // The badge must react while another tab is active — the count is how a
    // user working in the wizard learns a conflict is waiting at all.
    await pushConflict(page, ACCOUNT_A);
    await expect(tabBadge(page)).toHaveText('1');

    await pushConflict(page, ACCOUNT_B);
    await expect(tabBadge(page)).toHaveText('2');

    await openConflictsTab(page);
    const rows = page.getByTestId('data-table').locator('[data-testid^="table-row-"]');
    await expect(rows).toHaveCount(2);

    // The row carries what the push said, not placeholders: object, record,
    // the mapped conflict type, and the count of genuinely differing fields
    // (Name + Phone — Industry is identical on both sides of ACCOUNT_A).
    const rowA = conflictRow(page, ACCOUNT_A);
    await expect(rowA).toContainText('Account');
    await expect(rowA).toContainText('Edit / Edit');
    await expect(rowA).toContainText('2 field(s)');
    await expect(rowA).toContainText('Unresolved');

    // ACCOUNT_B differs on both of its fields.
    await expect(conflictRow(page, ACCOUNT_B)).toContainText('2 field(s)');
  });

  test('the same conflict pushed twice is not counted twice', async ({ page }) => {
    await openSyncPanel(page);

    // The host replays CDC events on reconnect; the store dedups on the id it
    // derives from objectApiName + recordId + replayId. A double count here
    // would send the user hunting for a conflict that does not exist.
    await pushConflict(page, ACCOUNT_A);
    await expect(tabBadge(page)).toHaveText('1');
    await pushConflict(page, ACCOUNT_A);

    await openConflictsTab(page);
    await expect(page.getByTestId('data-table').locator('[data-testid^="table-row-"]')).toHaveCount(
      1,
    );
    await expect(tabBadge(page)).toHaveText('1');
  });
});

test.describe('Sync conflicts — the diff', () => {
  test.beforeEach(async ({ page }) => {
    await openSyncPanel(page);
    await pushConflict(page, ACCOUNT_A);
    await openConflictsTab(page);
    await selectConflict(page, ACCOUNT_A);
  });

  test('shows both versions of every field, flagging only the ones that differ', async ({
    page,
  }) => {
    const viewer = page.getByTestId('conflict-diff-viewer');
    await expect(viewer).toBeVisible();

    // Source and target columns hold the two values the host sent, in order.
    const nameRow = page.getByTestId('diff-row-Name');
    await expect(nameRow).toHaveAttribute('data-conflict', 'true');
    await expect(nameRow.locator('td').nth(1)).toHaveText('Acme Industries (source)');
    await expect(nameRow.locator('td').nth(2)).toHaveText('Acme Industries (target)');

    const phoneRow = page.getByTestId('diff-row-Phone');
    await expect(phoneRow).toHaveAttribute('data-conflict', 'true');
    await expect(phoneRow.locator('td').nth(1)).toHaveText('+33 1 11 11 11 11');
    await expect(phoneRow.locator('td').nth(2)).toHaveText('+33 2 22 22 22 22');

    // Industry is identical on both sides: shown, but not a conflict.
    const industryRow = page.getByTestId('diff-row-Industry');
    await expect(industryRow).toHaveAttribute('data-conflict', 'false');
    await expect(industryRow.locator('td').nth(1)).toHaveText('Technology');
    await expect(industryRow.locator('td').nth(2)).toHaveText('Technology');
  });

  test('offers a choice only for the fields actually in conflict', async ({ page }) => {
    await expect(page.getByTestId('field-resolution-Name')).toBeVisible();
    await expect(page.getByTestId('field-resolution-Phone')).toBeVisible();
    // Offering a source/target choice on an unchanged field would invite the
    // user to "resolve" something that was never in dispute.
    await expect(page.getByTestId('field-resolution-Industry')).toHaveCount(0);

    // Each side's button is labelled with the value it would write.
    await expect(page.getByTestId('pick-source-Name')).toHaveText('Acme Industries (source)');
    await expect(page.getByTestId('pick-target-Name')).toHaveText('Acme Industries (target)');
    await expect(page.getByTestId('pick-source-Phone')).toHaveText('+33 1 11 11 11 11');
    await expect(page.getByTestId('pick-target-Phone')).toHaveText('+33 2 22 22 22 22');
  });
});

test.describe('Sync conflicts — per-field resolution', () => {
  test('apply stays locked until every conflicting field has been decided', async ({ page }) => {
    await openSyncPanel(page);
    await pushConflict(page, ACCOUNT_A);
    await openConflictsTab(page);
    await selectConflict(page, ACCOUNT_A);

    const apply = page.getByTestId('apply-resolution-btn');
    await expect(apply).toBeDisabled();

    await page.getByTestId('pick-source-Name').click();
    // One of two fields decided — writing now would leave Phone undecided.
    await expect(apply).toBeDisabled();

    await page.getByTestId('pick-target-Phone').click();
    await expect(apply).toBeEnabled();

    // Nothing has left the webview yet: the picks are local until Apply.
    expect(await resolutionsSent(page)).toHaveLength(0);
  });

  test('sends exactly the values the user picked, field by field', async ({ page }) => {
    await openSyncPanel(page);
    await pushConflict(page, ACCOUNT_A);
    await openConflictsTab(page);
    await selectConflict(page, ACCOUNT_A);

    // A mixed choice — source for one field, target for the other — is the
    // only combination that catches a panel wired to a single strategy.
    await page.getByTestId('pick-source-Name').click();
    await page.getByTestId('pick-target-Phone').click();
    await page.getByTestId('apply-resolution-btn').click();

    await expect
      .poll(async () => (await resolutionsSent(page)).length, { timeout: 10_000 })
      .toBe(1);

    const [sent] = await resolutionsSent(page);
    expect(sent.conflictId).toBe(conflictId(ACCOUNT_A));
    expect(sent.resolution).toBe('manual');
    // The whole point of the panel: these two values are what gets written to
    // a live record. Both the value and its provenance have to survive.
    expect(sent.fieldResolutions).toEqual({
      Name: { value: 'Acme Industries (source)', source: 'source' },
      Phone: { value: '+33 2 22 22 22 22', source: 'target' },
    });
  });

  test('a manually typed value is sent verbatim, marked manual', async ({ page }) => {
    await openSyncPanel(page);
    await pushConflict(page, ACCOUNT_A);
    await openConflictsTab(page);
    await selectConflict(page, ACCOUNT_A);

    await page.getByTestId('pick-source-Name').click();
    await page.getByTestId('pick-manual-Phone').click();
    await page.getByTestId('manual-input-Phone').fill('+33 3 33 33 33 33');
    await page.getByTestId('manual-confirm-Phone').click();

    // The button now reads back the typed value rather than the prompt.
    await expect(page.getByTestId('pick-manual-Phone')).toHaveText('+33 3 33 33 33 33');

    await page.getByTestId('apply-resolution-btn').click();
    await expect
      .poll(async () => (await resolutionsSent(page)).length, { timeout: 10_000 })
      .toBe(1);

    const [sent] = await resolutionsSent(page);
    expect(sent.fieldResolutions).toEqual({
      Name: { value: 'Acme Industries (source)', source: 'source' },
      Phone: { value: '+33 3 33 33 33 33', source: 'manual' },
    });
  });

  test('resolving clears the badge and marks the row resolved', async ({ page }) => {
    await openSyncPanel(page);
    await pushConflict(page, ACCOUNT_A);
    await pushConflict(page, ACCOUNT_B);
    await openConflictsTab(page);
    await selectConflict(page, ACCOUNT_A);

    await page.getByTestId('pick-source-Name').click();
    await page.getByTestId('pick-source-Phone').click();
    await page.getByTestId('apply-resolution-btn').click();

    // One of two conflicts resolved: the badge counts what is still open.
    await expect(tabBadge(page)).toHaveText('1');
    await expect(conflictRow(page, ACCOUNT_A)).toContainText('Resolved');
    await expect(conflictRow(page, ACCOUNT_B)).toContainText('Unresolved');

    // The detail side switches to the read-only recap of what was written.
    const summary = page.getByTestId('resolved-summary');
    await expect(summary).toContainText('Acme Industries (source)');
    await expect(summary).toContainText('+33 1 11 11 11 11');
    // No second choice can be made on a resolved conflict.
    await expect(page.getByTestId('apply-resolution-btn')).toHaveCount(0);
  });
});

test.describe('Sync conflicts — bulk resolution', () => {
  test('"apply source to all" resolves every open conflict with source_wins', async ({ page }) => {
    await openSyncPanel(page);
    await pushConflict(page, ACCOUNT_A);
    await pushConflict(page, ACCOUNT_B);
    await openConflictsTab(page);
    await selectConflict(page, ACCOUNT_A);

    await page.getByTestId('bulk-source-btn').click();
    // The dialog states how many records it is about to overwrite.
    await expect(page.getByTestId('danger-title')).toHaveText('Apply source to all');
    await expect(page.locator('body')).toContainText('This will resolve 2 conflicts');
    await confirmDanger(page);

    await expect
      .poll(async () => (await resolutionsSent(page)).length, { timeout: 10_000 })
      .toBe(2);

    const sent = await resolutionsSent(page);
    // Every open conflict is addressed, each by its own id — a bulk action
    // that resolved only the selected one would silently leave records behind.
    expect(sent.map((s) => s.conflictId).sort()).toEqual(
      [conflictId(ACCOUNT_A), conflictId(ACCOUNT_B)].sort(),
    );
    for (const message of sent) {
      expect(message.resolution).toBe('source_wins');
      // A bulk strategy carries no per-field overrides: the host decides.
      expect(message.fieldResolutions).toBeUndefined();
    }

    await expect(tabBadge(page)).toHaveCount(0);
  });

  test('"apply target to all" sends target_wins, not the source strategy', async ({ page }) => {
    await openSyncPanel(page);
    await pushConflict(page, ACCOUNT_B);
    await openConflictsTab(page);
    await selectConflict(page, ACCOUNT_B);

    await page.getByTestId('bulk-target-btn').click();
    await expect(page.getByTestId('danger-title')).toHaveText('Apply target to all');
    await confirmDanger(page);

    await expect
      .poll(async () => (await resolutionsSent(page)).length, { timeout: 10_000 })
      .toBe(1);

    const [sent] = await resolutionsSent(page);
    expect(sent.conflictId).toBe(conflictId(ACCOUNT_B));
    // Inverting these two strings is the single most destructive bug this
    // panel can have: it overwrites the wrong org's data, everywhere at once.
    expect(sent.resolution).toBe('target_wins');
  });

  test('cancelling the confirmation sends nothing', async ({ page }) => {
    await openSyncPanel(page);
    await pushConflict(page, ACCOUNT_A);
    await openConflictsTab(page);
    await selectConflict(page, ACCOUNT_A);

    await page.getByTestId('bulk-source-btn').click();
    await expect(page.getByTestId('danger-input')).toBeVisible();
    // The typed word is the gate; without it the confirm button is inert.
    await expect(page.getByTestId('danger-confirm-btn')).toBeDisabled();
    await page.getByTestId('danger-input').fill('CONFIRM');
    await page.getByTestId('danger-input').press('Escape');

    await expect(page.getByTestId('danger-input')).toHaveCount(0);
    expect(await resolutionsSent(page)).toHaveLength(0);
    await expect(tabBadge(page)).toHaveText('1');
  });
});

test.describe('Sync conflicts — switching between conflicts', () => {
  /**
   * PRODUCT DEFECT — left red on purpose.
   *
   * `ConflictsTabContent` (SyncPage.tsx) renders
   * `<ConflictResolutionPanel conflict={selectedConflict} />` with no `key`,
   * so selecting another conflict swaps the prop on the *same* component
   * instance. `ConflictResolutionPanel` keeps its per-field choices in
   * `useState` (`fieldResolutions`) and never resets them when `conflict.id`
   * changes, so the choices made on one record stay armed on the next.
   *
   * ACCOUNT_C conflicts on the same two field names as ACCOUNT_A, so the
   * carried-over choices satisfy `allFieldsResolved` outright: opening it
   * shows an armed Apply button on a record the user has not looked at, and
   * pressing it writes Acme's name and phone number onto the Initech record.
   *
   * Fix: key the panel on `conflict.id` in SyncPage, or reset
   * `fieldResolutions` in an effect on `conflict.id`.
   */
  test('a newly selected conflict starts with no choices carried over', async ({ page }) => {
    await openSyncPanel(page);
    await pushConflict(page, ACCOUNT_A);
    await pushConflict(page, ACCOUNT_C);
    await openConflictsTab(page);

    await selectConflict(page, ACCOUNT_A);
    await page.getByTestId('pick-source-Name').click();
    await page.getByTestId('pick-source-Phone').click();
    await expect(page.getByTestId('apply-resolution-btn')).toBeEnabled();

    // Switch away without applying — a perfectly ordinary thing to do.
    await selectConflict(page, ACCOUNT_C);
    // We really are looking at the other record's values.
    await expect(page.getByTestId('pick-source-Name')).toHaveText('Initech (source)');
    await expect(page.getByTestId('pick-target-Phone')).toHaveText('+33 5 55 55 55 55');

    // Nothing has been decided for this record yet, so there is nothing to apply.
    await expect(page.getByTestId('apply-resolution-btn')).toBeDisabled();
  });

  /**
   * PRODUCT DEFECT — same root cause, and this is the destructive face of it.
   *
   * The user decides both of ACCOUNT_B's fields, so the panel looks correct
   * and complete. The message that leaves still carries `Phone` — a field
   * ACCOUNT_B is not even in conflict on — holding ACCOUNT_A's value. The
   * host applies `fieldResolutions` as given, so the Globex record gets Acme's
   * phone number written onto it.
   */
  test('the applied resolution carries only the fields of the conflict shown', async ({ page }) => {
    await openSyncPanel(page);
    await pushConflict(page, ACCOUNT_A);
    await pushConflict(page, ACCOUNT_B);
    await openConflictsTab(page);

    await selectConflict(page, ACCOUNT_A);
    await page.getByTestId('pick-source-Name').click();
    await page.getByTestId('pick-source-Phone').click();

    await selectConflict(page, ACCOUNT_B);
    await page.getByTestId('pick-target-Name').click();
    await page.getByTestId('pick-target-Industry').click();
    await page.getByTestId('apply-resolution-btn').click();

    await expect
      .poll(async () => (await resolutionsSent(page)).length, { timeout: 10_000 })
      .toBe(1);

    const [sent] = await resolutionsSent(page);
    expect(sent.conflictId).toBe(conflictId(ACCOUNT_B));
    expect(sent.fieldResolutions).toEqual({
      Name: { value: 'Globex (target)', source: 'target' },
      Industry: { value: 'Energy', source: 'target' },
    });
  });
});
