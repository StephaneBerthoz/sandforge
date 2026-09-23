import { test, expect, type Page } from '@playwright/test';

import { MockBridge } from './helpers';
import { MOCK_ORGS, DEV_SANDBOX, QA_SANDBOX } from './fixtures';
import { sendExtensionMessage } from './mocks/vscode-api';

/**
 * Real-time CDC sync E2E — the Sync panel's `realtime` tab.
 *
 * The tab asks the host which objects the source org publishes change events
 * for (`realtime:objects`) and offers only those; the host answers from the
 * org's own list of channel members. The UI is `SyncPage` -> `tab-realtime` ->
 * `RealTimeSyncPanel` -> `CDCSubscriptionPanel` + `CDCMetricsDashboard` +
 * `CDCEventFeed`, and the channels are `realtime:start` / `realtime:started` /
 * `realtime:events-batch` (packages/shared/src/types/messages/realtime.messages.ts).
 *
 * This file replaces `quarantine/cdc-subscription-event.spec.ts`, which drove
 * a `?e2e-harness=cdc` placeholder surface with invented testids that the
 * shipped product never adopted. It asserted against a fixture of itself.
 *
 * Access follows the idiom the rest of the suite settled on: `__SANDFORGE_MODULE__`
 * before `page.goto`, orgs seeded through `MockBridge`, every in-flight request
 * answered against its own `correlationId`.
 *
 * One thing this panel does NOT share with the others: the CDC feed is not fed
 * through `useBridgeQuery`. `useCDCLiveStore` registers its own
 * `window.addEventListener('message', ...)` at module scope and dispatches on
 * `type` alone, so pushes are posted with `sendExtensionMessage` and carry no
 * correlationId.
 */

/** What the host answers `realtime:objects` with: what the source publishes, and on which channel. */
const PUBLISHED = [
  {
    objectApiName: 'Account',
    channel: 'ChangeEvents',
    inTarget: true,
    externalIdFields: ['Legacy_Key__c'],
    syncConfigs: [],
  },
  {
    objectApiName: 'Contact',
    channel: 'ActivityEngagementVirtualChannel',
    inTarget: true,
    externalIdFields: [],
    syncConfigs: [],
  },
  {
    objectApiName: 'Lead',
    channel: 'ActivityEngagementVirtualChannel',
    inTarget: true,
    externalIdFields: [],
    syncConfigs: [],
  },
  {
    objectApiName: 'Case',
    channel: 'ChangeEvents',
    inTarget: true,
    externalIdFields: [],
    syncConfigs: [],
  },
];

/** The session id a working extension would hand back on `realtime:started`. */
const SESSION_ID = 'sess-cdc-1';

/**
 * Every outgoing message of a type, unwrapped from the post envelope.
 *
 * Since 1.5.0 `postEnvelopedMessage` posts `{ protocolVersion, correlationId,
 * payload: message }`, so the application `type` sits one level down.
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

/** Payloads of every outgoing message of a type, oldest first. */
async function outgoingPayloads(page: Page, type: string): Promise<Record<string, unknown>[]> {
  const messages = await outgoing(page, type);
  return messages.map((m) => (m.payload as Record<string, unknown> | undefined) ?? {});
}

/**
 * Answer *every* in-flight request of a type, each against its own id.
 *
 * `useMessageResponse` drops a response whose `correlationId` is not the live
 * request's id, and React StrictMode can leave two ids in flight for one query.
 */
async function answerAll(
  page: Page,
  requestType: string,
  responseType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await page.waitForFunction(
    (type) => {
      const msgs = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
      return msgs.some((m) => {
        const envelope = m as Record<string, unknown>;
        const inner = (envelope.payload as Record<string, unknown> | undefined) ?? envelope;
        return inner.type === type;
      });
    },
    requestType,
    { timeout: 10_000 },
  );

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

/**
 * Boot the Sync panel and land on the real-time tab with the objects the host
 * says the source publishes. Both orgs are picked on the Sync tab first: the
 * tab asks about the pair, and asks nothing until both are known.
 */
async function openRealtimeTab(
  page: Page,
  objects: Record<string, unknown>[] = PUBLISHED,
): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'sync';
  });
  await page.goto('/');
  await bridge.seedOrgs(MOCK_ORGS);
  await expect(page.getByTestId('sync-page')).toBeVisible({ timeout: 10_000 });

  await page.getByLabel('Source', { exact: true }).selectOption(DEV_SANDBOX.id);
  await page.getByLabel('Target', { exact: true }).selectOption(QA_SANDBOX.id);

  await page.getByTestId('tab-realtime').click();
  await expect(page.getByTestId('realtime-sync-panel')).toBeVisible({ timeout: 10_000 });
  await answerAll(page, 'realtime:objects', 'realtime:objects:response', { objects });
  return bridge;
}

/** Tick an object in the picker and fire the subscription. */
async function startWatching(page: Page, objectApiName: string): Promise<void> {
  await page.getByTestId(`cdc-object-checkbox-${objectApiName}`).check();
  await expect(page.getByTestId('cdc-start-btn')).toBeEnabled();
  await page.getByTestId('cdc-start-btn').click();
}

/**
 * The `realtime:started` a working extension sends.
 *
 * `success` matters: `useCDCLiveStore` reads it and only reports 'syncing' when
 * it is not `false`, so a refused start cannot paint a green "Syncing" badge
 * over a stream that does not exist.
 */
async function confirmStarted(
  page: Page,
  watchedObjects: string[],
  extra: Record<string, unknown> = {},
): Promise<void> {
  await sendExtensionMessage(page, {
    type: 'realtime:started',
    id: 'evt-realtime-started',
    payload: {
      sessionId: SESSION_ID,
      watchedObjects,
      success: true,
      refused: [],
      notes: [],
      ...extra,
    },
  });
  await expect(page.getByTestId('cdc-status-badge')).toHaveText('Syncing', { timeout: 10_000 });
}

/** Push a CDC batch the way the extension's flush timer does. */
async function pushBatch(page: Page, events: Record<string, unknown>[]): Promise<void> {
  await sendExtensionMessage(page, {
    type: 'realtime:events-batch',
    id: `evt-batch-${events.length}-${Date.now()}`,
    payload: { events },
  });
}

/** One CDC event, shaped as `RealTimeEventsBatchMessage` declares it. */
function cdcEvent(
  replayId: number,
  objectApiName: string,
  changeType: string,
  recordIds: string[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    replayId,
    objectApiName,
    changeType,
    recordIds,
    commitTimestamp: new Date().toISOString(),
    changedFields: { Name: 'Acme Corporation' },
    commitUser: '005000000000001AAA',
    transactionKey: `txn-${replayId}`,
    applied: true,
    outcome: 'applied',
    ...extra,
  };
}

test.describe('Real-time CDC — reaching the panel', () => {
  test('the realtime tab lists what the source publishes, and nothing is running', async ({
    page,
  }) => {
    await openRealtimeTab(page);

    // It asked about the pair picked on the Sync tab.
    const [asked] = await outgoingPayloads(page, 'realtime:objects');
    expect(asked).toEqual({ sourceOrgId: DEV_SANDBOX.id, targetOrgId: QA_SANDBOX.id });

    await expect(page.getByTestId('tab-realtime')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('cdc-object-picker')).toBeVisible();
    await expect(page.getByTestId('cdc-metrics-section')).toBeVisible();
    await expect(page.getByTestId('cdc-event-feed')).toBeVisible();
    for (const { objectApiName } of PUBLISHED) {
      await expect(page.getByTestId(`cdc-object-checkbox-${objectApiName}`)).not.toBeChecked();
    }
    await expect(page.getByTestId('cdc-object-picker')).toContainText(
      'Contact (ActivityEngagementVirtualChannel)',
    );
    await expect(page.getByTestId('cdc-how-to-enable')).toContainText(
      'Setup → Change Data Capture',
    );

    await expect(page.getByTestId('cdc-status-badge')).toHaveText('Disconnected');
    await expect(page.getByTestId('cdc-event-feed')).toContainText('No change received yet.');
    await expect(page.getByTestId('cdc-event-count')).toHaveText('0 events');
  });

  test('says why nothing can be watched when the source publishes nothing', async ({ page }) => {
    await openRealtimeTab(page, []);

    await expect(page.getByTestId('realtime-no-publishing')).toContainText(
      'No object publishes change events on the source org',
    );
    await expect(page.getByTestId('cdc-subscription-panel')).toHaveCount(0);
  });

  test('start is gated on at least one watched object', async ({ page }) => {
    await openRealtimeTab(page);

    const startBtn = page.getByTestId('cdc-start-btn');
    await expect(startBtn).toHaveText('Start');
    await expect(startBtn).toBeDisabled();

    await page.getByTestId('cdc-object-checkbox-Contact').check();
    await expect(startBtn).toBeEnabled();

    await page.getByTestId('cdc-object-checkbox-Contact').uncheck();
    await expect(startBtn).toBeDisabled();

    expect(await outgoing(page, 'realtime:start')).toHaveLength(0);
  });
});

test.describe('Real-time CDC — starting a subscription', () => {
  test('realtime:start carries the org pair, the watched objects, what is written and how', async ({
    page,
  }) => {
    await openRealtimeTab(page);
    await page.getByTestId('cdc-object-checkbox-Account').check();
    await page.getByTestId('cdc-object-checkbox-Contact').check();
    await page.getByTestId('cdc-autosync-toggle-Account').check();
    await page.getByTestId('cdc-delete-toggle-Account').check();
    await page.getByTestId('cdc-start-btn').click();

    const starts = await outgoingPayloads(page, 'realtime:start');
    expect(starts).toHaveLength(1);
    expect(starts[0].sourceOrgId).toBe(DEV_SANDBOX.id);
    expect(starts[0].targetOrgId).toBe(QA_SANDBOX.id);
    expect(starts[0].watchedObjects).toEqual(['Account', 'Contact']);
    // Account is written, found by its external id; Contact is only watched.
    expect(starts[0].apply).toEqual([
      {
        objectApiName: 'Account',
        match: { kind: 'externalId', field: 'Legacy_Key__c' },
        applyDeletes: true,
      },
    ]);
    expect(starts[0].flushIntervalMs).toBe(150);
    expect(starts[0].maxBatchSize).toBe(100);
  });

  test('the panel reports connecting until the host confirms', async ({ page }) => {
    await openRealtimeTab(page);
    await startWatching(page, 'Account');

    await expect(page.getByTestId('cdc-status-badge')).toHaveText('Connecting');
    await expect(page.getByTestId('cdc-start-btn')).toHaveCount(0);
    await expect(page.getByTestId('cdc-stop-btn')).toBeDisabled();
    await expect(page.getByTestId('cdc-object-checkbox-Account')).toBeDisabled();
    await expect(page.getByTestId('cdc-object-checkbox-Lead')).toBeDisabled();
  });

  test('realtime:started opens the stream and releases the stop button', async ({ page }) => {
    await openRealtimeTab(page);
    await startWatching(page, 'Account');
    await confirmStarted(page, ['Account']);

    await expect(page.getByTestId('cdc-stop-btn')).toBeEnabled();
    await expect(page.getByTestId('cdc-stop-btn')).toHaveText('Stop');
    await expect(page.getByTestId('cdc-object-checkbox-Account')).toBeDisabled();
    await expect(page.getByTestId('cdc-metrics-section')).toHaveAttribute('open', '');
  });

  test('the objects the org refused are listed with its answer', async ({ page }) => {
    await openRealtimeTab(page);
    await page.getByTestId('cdc-object-checkbox-Case').check();
    await startWatching(page, 'Contact');
    await confirmStarted(page, ['Contact'], {
      refused: [
        {
          objectApiName: 'Case',
          reason: '403::User not allowed to subscribe CDC without required permissions',
        },
      ],
    });

    const refused = page.getByTestId('realtime-refused');
    await expect(refused).toContainText(
      'Case: 403::User not allowed to subscribe CDC without required permissions',
    );
    await expect(refused).toContainText('Setup → Change Data Capture');
  });

  test('the conflict strategy picked in the panel travels in realtime:start', async ({ page }) => {
    await openRealtimeTab(page);
    await page.getByTestId('cdc-object-checkbox-Account').check();

    await page.getByTestId('cdc-autosync-toggle-Account').check();
    const strategy = page.getByTestId('cdc-conflict-select-Account');
    await expect(strategy).toBeVisible();
    await strategy.selectOption('target_wins');
    await expect(strategy).toHaveValue('target_wins');

    await page.getByTestId('cdc-start-btn').click();

    const starts = await outgoingPayloads(page, 'realtime:start');
    expect(starts).toHaveLength(1);
    expect(starts[0].conflictStrategy).toBe('target_wins');
  });

  test('a refused start is reported as an error, in the host’s words', async ({ page }) => {
    await openRealtimeTab(page);
    await startWatching(page, 'Account');

    await sendExtensionMessage(page, {
      type: 'realtime:started',
      id: 'evt-realtime-refused',
      payload: {
        success: false,
        watchedObjects: [],
        refused: [],
        notes: [],
        error:
          'The target org is protected by the Production Guard, which did not allow the writes.',
      },
    });

    await expect(page.getByTestId('cdc-status-badge')).toHaveText('Error', { timeout: 10_000 });
    await expect(page.getByTestId('realtime-session-error')).toContainText('Production Guard');
    await expect(page.getByTestId('cdc-event-count')).toHaveText('0 events');
    await expect(page.getByTestId('cdc-start-btn')).toBeEnabled();
    await expect(page.getByTestId('cdc-object-checkbox-Account')).toBeEnabled();
  });
});

test.describe('Real-time CDC — receiving events', () => {
  test('a pushed batch fills the feed oldest first and counts every event', async ({ page }) => {
    await openRealtimeTab(page);
    await startWatching(page, 'Account');
    await confirmStarted(page, ['Account']);

    await pushBatch(page, [
      cdcEvent(1001, 'Account', 'CREATE', ['001000000000001AAA']),
      cdcEvent(1002, 'Contact', 'UPDATE', ['003000000000001AAA', '003000000000002AAA']),
      cdcEvent(1003, 'Case', 'DELETE', [
        '500000000000001AAA',
        '500000000000002AAA',
        '500000000000003AAA',
      ]),
    ]);

    const feed = page.getByTestId('cdc-event-feed');
    await expect(feed.getByTestId('cdc-event-row-0')).toBeVisible({ timeout: 10_000 });

    const first = feed.getByTestId('cdc-event-row-0');
    await expect(first).toContainText('Account');
    await expect(first).toContainText('Create');
    await expect(first).toContainText('001000000000001AAA');

    const second = feed.getByTestId('cdc-event-row-1');
    await expect(second).toContainText('Contact');
    await expect(second).toContainText('Update');

    const third = feed.getByTestId('cdc-event-row-2');
    await expect(third).toContainText('Case');
    await expect(third).toContainText('Delete');
    await expect(third).toContainText('500000000000001AAA, 500000000000002AAA');
    await expect(third).not.toContainText('500000000000003AAA');
    await expect(third).toContainText('+1 more');

    await expect(page.getByTestId('cdc-event-count')).toHaveText('3 events');
  });

  test('a second batch appends without dropping the first', async ({ page }) => {
    await openRealtimeTab(page);
    await startWatching(page, 'Account');
    await confirmStarted(page, ['Account']);

    await pushBatch(page, [cdcEvent(2001, 'Account', 'CREATE', ['001000000000001AAA'])]);
    await expect(page.getByTestId('cdc-event-count')).toHaveText('1 events', { timeout: 10_000 });

    await pushBatch(page, [
      cdcEvent(2002, 'Case', 'UPDATE', ['500000000000001AAA']),
      cdcEvent(2003, 'Lead', 'UNDELETE', ['00Q000000000001AAA']),
    ]);

    await expect(page.getByTestId('cdc-event-count')).toHaveText('3 events', { timeout: 10_000 });
    await expect(page.getByTestId('cdc-event-row-0')).toContainText('Account');
    await expect(page.getByTestId('cdc-event-row-1')).toContainText('Case');
    await expect(page.getByTestId('cdc-event-row-2')).toContainText('Undelete');
  });

  test('says what became of each change, the target’s refusal included', async ({ page }) => {
    await openRealtimeTab(page);
    await startWatching(page, 'Account');
    await confirmStarted(page, ['Account']);

    await pushBatch(page, [
      cdcEvent(3001, 'Account', 'UPDATE', ['001000000000001AAA'], {
        applied: false,
        outcome: 'failed',
        error: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Rating is required',
      }),
      cdcEvent(3002, 'Account', 'CREATE', ['001000000000002AAA']),
      cdcEvent(3003, 'Contact', 'UPDATE', ['003000000000001AAA'], {
        applied: false,
        outcome: 'watched',
      }),
    ]);

    const failed = page.getByTestId('cdc-event-row-0');
    await expect(failed).toBeVisible({ timeout: 10_000 });
    await expect(failed.locator('.codicon-error')).toHaveAttribute(
      'title',
      'FIELD_CUSTOM_VALIDATION_EXCEPTION: Rating is required',
    );
    await expect(failed).toContainText('Not written: FIELD_CUSTOM_VALIDATION_EXCEPTION');
    await expect(page.getByTestId('cdc-event-row-1').locator('.codicon-check')).toHaveCount(1);
    await expect(page.getByTestId('cdc-event-row-2')).toHaveAttribute('data-outcome', 'watched');
    await expect(page.getByTestId('cdc-event-row-2')).toContainText('Watched only, not written');
  });

  test('a single realtime:event lands in the feed', async ({ page }) => {
    await openRealtimeTab(page);
    await startWatching(page, 'Account');
    await confirmStarted(page, ['Account']);

    await sendExtensionMessage(page, {
      type: 'realtime:event',
      id: 'evt-realtime-single',
      payload: {
        replayId: 4001,
        objectApiName: 'Account',
        changeType: 'UPDATE',
        recordIds: ['001000000000009AAA'],
        commitTimestamp: new Date().toISOString(),
        applied: true,
      },
    });

    await expect(page.getByTestId('cdc-event-row-0')).toContainText('001000000000009AAA', {
      timeout: 10_000,
    });
    await expect(page.getByTestId('cdc-event-count')).toHaveText('1 events');
  });
});

test.describe('Real-time CDC — stopping', () => {
  test('stop posts realtime:stop naming the session, and realtime:stopped returns the panel to idle', async ({
    page,
  }) => {
    await openRealtimeTab(page);
    await startWatching(page, 'Account');
    await confirmStarted(page, ['Account']);
    await pushBatch(page, [cdcEvent(5001, 'Account', 'CREATE', ['001000000000001AAA'])]);
    await expect(page.getByTestId('cdc-event-count')).toHaveText('1 events', { timeout: 10_000 });

    await page.getByTestId('cdc-stop-btn').click();
    const stops = await outgoingPayloads(page, 'realtime:stop');
    expect(stops).toHaveLength(1);
    expect(stops[0].sessionId).toBe(SESSION_ID);

    // The badge does not flip on the click: the host owns the transition.
    await expect(page.getByTestId('cdc-status-badge')).toHaveText('Syncing');

    await sendExtensionMessage(page, {
      type: 'realtime:stopped',
      id: 'evt-realtime-stopped',
      payload: { sessionId: SESSION_ID, reason: 'stopped', success: true },
    });

    await expect(page.getByTestId('cdc-status-badge')).toHaveText('Disconnected', {
      timeout: 10_000,
    });
    await expect(page.getByTestId('cdc-start-btn')).toBeVisible();
    await expect(page.getByTestId('cdc-object-checkbox-Account')).toBeEnabled();
    // Stopping a stream is not the same as clearing its history.
    await expect(page.getByTestId('cdc-event-row-0')).toContainText('Account');
    await expect(page.getByTestId('cdc-event-count')).toHaveText('1 events');
  });

  test('restarting after a stop opens a second subscription', async ({ page }) => {
    await openRealtimeTab(page);
    await startWatching(page, 'Account');
    await confirmStarted(page, ['Account']);
    await page.getByTestId('cdc-stop-btn').click();
    await sendExtensionMessage(page, {
      type: 'realtime:stopped',
      id: 'evt-realtime-stopped-2',
      payload: { sessionId: SESSION_ID, reason: 'stopped', success: true },
    });
    await expect(page.getByTestId('cdc-start-btn')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('cdc-object-checkbox-Case').check();
    await page.getByTestId('cdc-start-btn').click();

    const starts = await outgoingPayloads(page, 'realtime:start');
    expect(starts).toHaveLength(2);
    expect(starts[1].watchedObjects).toEqual(['Account', 'Case']);
    await expect(page.getByTestId('cdc-status-badge')).toHaveText('Connecting');
  });
});
