import { test, expect, type Page } from '@playwright/test';

import { MockBridge } from './helpers';
import { MOCK_ORGS, DEV_SANDBOX, QA_SANDBOX } from './fixtures';
import { sendExtensionMessage } from './mocks/vscode-api';

/**
 * Real-time CDC sync E2E — the Sync panel's `realtime` tab.
 *
 * This file replaces `quarantine/cdc-subscription-event.spec.ts`, which was
 * deleted on the belief that the feature did not exist. It does: the channels
 * were renamed, not removed. `cdc:subscribe` / `cdc:event` became
 * `realtime:start` / `realtime:events-batch`
 * (packages/shared/src/types/messages/realtime.messages.ts, registered at
 * messageSchemas.ts:443-457), and the UI is `SyncPage` -> `tab-realtime` ->
 * `RealTimeSyncPanel` -> `CDCSubscriptionPanel` + `CDCMetricsDashboard` +
 * `CDCEventFeed`.
 *
 * The old file is not resurrected because it drove `?e2e-harness=cdc` — a
 * placeholder surface with invented testids (`monitor-cdc-subscribe-btn`,
 * `monitor-cdc-feed-row`) that the shipped product never adopted. It asserted
 * against a fixture of itself.
 *
 * Access follows the idiom the rest of the suite settled on: `__SANDFORGE_MODULE__`
 * before `page.goto`, orgs seeded through `MockBridge`, every in-flight request
 * answered against its own `correlationId`.
 *
 * One thing this panel does NOT share with the others: the CDC feed is not fed
 * through `useBridgeQuery`. `useCDCLiveStore` registers its own
 * `window.addEventListener('message', ...)` at module scope and dispatches on
 * `type` alone (useCDCLiveStore.ts:203-296), so pushes are posted with
 * `sendExtensionMessage` and carry no correlationId. Only the mount burst
 * (`org:list`, `sync:describe-global`) is correlated.
 */

/** What a `sync:describe-global` answers with — API names only, per the contract. */
const WATCHABLE_OBJECTS = ['Account', 'Contact', 'Opportunity', 'Case', 'Lead'];

/** The session id a working extension would hand back on `realtime:started`. */
const SESSION_ID = 'sess-cdc-1';

/**
 * Every outgoing message of a type, unwrapped from the post envelope.
 *
 * Since 1.5.0 `postEnvelopedMessage` posts `{ protocolVersion, correlationId,
 * payload: message }`, so the application `type` sits one level down.
 * `MockBridge.getMessages` matches the top-level `type` and answers `[]` for
 * every application message; this is the local replacement the shared helper
 * being read-only calls for.
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
 * Boot the Sync panel and land on the real-time tab with a usable object list.
 *
 * Both orgs have to be picked on the Sync tab first, and not for cosmetic
 * reasons: `useSyncPageData` skips `sync:describe-global` while `sourceOrgId`
 * is empty (useSyncPageData.ts:208-211), so `availableObjects` — the array the
 * CDC object picker renders from — stays empty and the panel shows "No objects
 * available for CDC". `RealTimeSyncPanel` also copies both ids into the store
 * on mount, which is what `realtime:start` later carries.
 */
async function openRealtimeTab(page: Page): Promise<MockBridge> {
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
  await answerAll(page, 'sync:describe-global', 'sync:describe-global:response', {
    objects: WATCHABLE_OBJECTS,
  });

  await page.getByTestId('tab-realtime').click();
  await expect(page.getByTestId('cdc-subscription-panel')).toBeVisible({ timeout: 10_000 });
  // The picker fills from the describe above; without it every start is a
  // no-op and the tests below would be driving an empty form.
  await expect(page.getByTestId('cdc-object-checkbox-Account')).toBeVisible({ timeout: 10_000 });
  return bridge;
}

/** Tick an object in the picker and fire the subscription. */
async function startWatching(page: Page, objectApiName: string): Promise<void> {
  await page.getByTestId(`cdc-object-checkbox-${objectApiName}`).check();
  await expect(page.getByTestId('cdc-start-btn')).toBeEnabled();
  await page.getByTestId('cdc-start-btn').click();
}

/**
 * The `realtime:started` a *working* extension would send.
 *
 * `success` matters: `useCDCLiveStore` reads it and only reports 'syncing' when
 * it is not `false`, precisely so the shipped no-op answer cannot paint a green
 * "Syncing" badge over a stream that does not exist.
 */
async function confirmStarted(page: Page, watchedObjects: string[]): Promise<void> {
  await sendExtensionMessage(page, {
    type: 'realtime:started',
    id: 'evt-realtime-started',
    payload: { sessionId: SESSION_ID, watchedObjects, success: true },
  });
  await expect(page.getByTestId('cdc-status-badge')).toHaveText('Syncing', { timeout: 10_000 });
}

/** Push a CDC batch the way the extension's flush timer would. */
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
    commitUser: 'admin@sandbox.com',
    transactionKey: `txn-${replayId}`,
    applied: true,
    ...extra,
  };
}

test.describe('Real-time CDC — reaching the panel', () => {
  test('the realtime tab mounts the subscription panel, metrics and feed', async ({ page }) => {
    await openRealtimeTab(page);

    await expect(page.getByTestId('tab-realtime')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('realtime-sync-panel')).toBeVisible();
    await expect(page.getByTestId('cdc-object-picker')).toBeVisible();
    await expect(page.getByTestId('cdc-metrics-section')).toBeVisible();
    await expect(page.getByTestId('cdc-event-feed')).toBeVisible();

    // Every object the describe returned is offered, and none is pre-ticked.
    for (const objectApiName of WATCHABLE_OBJECTS) {
      await expect(page.getByTestId(`cdc-object-checkbox-${objectApiName}`)).not.toBeChecked();
    }

    // Nothing is running: the badge says so and the feed is honest about it.
    await expect(page.getByTestId('cdc-status-badge')).toHaveText('Disconnected');
    await expect(page.getByTestId('cdc-event-feed')).toContainText(
      'No events yet. Start CDC stream to begin receiving changes.',
    );
    await expect(page.getByTestId('cdc-event-count')).toHaveText('0 events');
  });

  test('start is gated on at least one watched object', async ({ page }) => {
    await openRealtimeTab(page);

    const startBtn = page.getByTestId('cdc-start-btn');
    await expect(startBtn).toBeVisible();
    await expect(startBtn).toHaveText('Start');
    // A subscription to nothing is not a degraded subscription, it is no
    // subscription — and the extension would open a CometD channel for it.
    await expect(startBtn).toBeDisabled();

    await page.getByTestId('cdc-object-checkbox-Contact').check();
    await expect(startBtn).toBeEnabled();

    // Unticking the only object closes the gate again.
    await page.getByTestId('cdc-object-checkbox-Contact').uncheck();
    await expect(startBtn).toBeDisabled();

    // And nothing has gone out to the host on the way.
    expect(await outgoing(page, 'realtime:start')).toHaveLength(0);
  });
});

test.describe('Real-time CDC — starting a subscription', () => {
  test('realtime:start carries the org pair, the watched objects and the flush budget', async ({
    page,
  }) => {
    await openRealtimeTab(page);
    await page.getByTestId('cdc-object-checkbox-Account').check();
    await page.getByTestId('cdc-object-checkbox-Contact').check();
    await page.getByTestId('cdc-start-btn').click();

    const starts = await outgoingPayloads(page, 'realtime:start');
    expect(starts).toHaveLength(1);
    // The org ids are the ones picked on the Sync tab, carried into the store
    // by RealTimeSyncPanel's mount effect. A panel that posted empty strings
    // here would still look identical on screen.
    expect(starts[0].sourceOrgId).toBe(DEV_SANDBOX.id);
    expect(starts[0].targetOrgId).toBe(QA_SANDBOX.id);
    expect(starts[0].watchedObjects).toEqual(['Account', 'Contact']);
    // The batching contract the extension's flush timer is built against.
    expect(starts[0].flushIntervalMs).toBe(150);
    expect(starts[0].maxBatchSize).toBe(100);
  });

  test('the panel reports connecting until the host confirms', async ({ page }) => {
    await openRealtimeTab(page);
    await startWatching(page, 'Account');

    // Optimistic 'connecting', not optimistic 'syncing': nothing has confirmed
    // a stream yet.
    await expect(page.getByTestId('cdc-status-badge')).toHaveText('Connecting');
    // Start is swapped for Stop, and Stop is inert mid-handshake — there is no
    // session to stop yet.
    await expect(page.getByTestId('cdc-start-btn')).toHaveCount(0);
    await expect(page.getByTestId('cdc-stop-btn')).toBeVisible();
    await expect(page.getByTestId('cdc-stop-btn')).toBeDisabled();
    // The watched set is frozen for the lifetime of the subscription.
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
    // A live session is what opens the metrics section — collapsed while idle.
    await expect(page.getByTestId('cdc-metrics-section')).toHaveAttribute('open', '');
  });

  /**
   * PRODUCT DEFECT — left red on purpose.
   *
   * `CDCSubscriptionPanel` offers a per-object conflict strategy
   * (`cdc-conflict-select-<object>`, five options), and `useCDCLiveStore`
   * stores every choice in `autoSyncObjects`. `startStream()` then ignores the
   * store and hardcodes `conflictStrategy: 'source_wins'`
   * (useCDCLiveStore.ts:189). Whatever the user picks, the host is told
   * "source wins" — a control that changes nothing, on the setting that
   * decides which org's data survives a collision.
   */
  test('the conflict strategy picked in the panel travels in realtime:start', async ({ page }) => {
    await openRealtimeTab(page);
    await page.getByTestId('cdc-object-checkbox-Account').check();

    // Auto-sync has to be on for the strategy selector to exist at all.
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
});

test.describe('Real-time CDC — receiving events', () => {
  test('a pushed batch fills the feed oldest first and counts every event', async ({ page }) => {
    await openRealtimeTab(page);
    await startWatching(page, 'Account');
    await confirmStarted(page, ['Account']);

    await pushBatch(page, [
      cdcEvent(1001, 'Account', 'CREATE', ['001000000000001AAA']),
      cdcEvent(1002, 'Contact', 'UPDATE', ['003000000000001AAA', '003000000000002AAA']),
      cdcEvent(1003, 'Opportunity', 'DELETE', [
        '006000000000001AAA',
        '006000000000002AAA',
        '006000000000003AAA',
      ]),
    ]);

    const feed = page.getByTestId('cdc-event-feed');
    await expect(feed.getByTestId('cdc-event-row-0')).toBeVisible({ timeout: 10_000 });
    await expect(feed).not.toContainText('No events yet');

    // Chronological order, oldest at row 0 — a feed that reversed the ring
    // buffer would read as "the newest change happened first".
    const first = feed.getByTestId('cdc-event-row-0');
    await expect(first).toContainText('Account');
    await expect(first).toContainText('Create');
    await expect(first).toContainText('001000000000001AAA');

    const second = feed.getByTestId('cdc-event-row-1');
    await expect(second).toContainText('Contact');
    await expect(second).toContainText('Update');

    // Beyond two ids the row truncates and says how many it hid, rather than
    // silently dropping them.
    const third = feed.getByTestId('cdc-event-row-2');
    await expect(third).toContainText('Opportunity');
    await expect(third).toContainText('Delete');
    await expect(third).toContainText('006000000000001AAA, 006000000000002AAA');
    await expect(third).not.toContainText('006000000000003AAA');
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
    // The first batch is still the head of the buffer, not overwritten by it.
    await expect(page.getByTestId('cdc-event-row-0')).toContainText('Account');
    await expect(page.getByTestId('cdc-event-row-1')).toContainText('Case');
    await expect(page.getByTestId('cdc-event-row-2')).toContainText('Lead');
    await expect(page.getByTestId('cdc-event-row-2')).toContainText('Undelete');
  });

  test('an event the target refused is marked as failed, not as applied', async ({ page }) => {
    await openRealtimeTab(page);
    await startWatching(page, 'Account');
    await confirmStarted(page, ['Account']);

    await pushBatch(page, [
      cdcEvent(3001, 'Account', 'UPDATE', ['001000000000001AAA'], {
        applied: false,
        error: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Rating is required',
      }),
      cdcEvent(3002, 'Contact', 'CREATE', ['003000000000001AAA']),
    ]);

    const failed = page.getByTestId('cdc-event-row-0');
    await expect(failed).toBeVisible({ timeout: 10_000 });
    // The reason is only ever visible on hover, so the title is the assertion:
    // a row that lost it tells the user nothing about why replication stalled.
    await expect(failed.locator('.codicon-error')).toHaveAttribute(
      'title',
      'FIELD_CUSTOM_VALIDATION_EXCEPTION: Rating is required',
    );
    await expect(failed.locator('.codicon-check')).toHaveCount(0);

    // The applied one beside it still reads as applied.
    await expect(page.getByTestId('cdc-event-row-1').locator('.codicon-check')).toHaveCount(1);
    await expect(page.getByTestId('cdc-event-row-1').locator('.codicon-error')).toHaveCount(0);
  });

  /**
   * PRODUCT DEFECT — left red on purpose.
   *
   * `realtime:event` is a declared, schema-registered push channel:
   * `RealTimeCDCEventMessage` in realtime.messages.ts:65-76, registered at
   * messageSchemas.ts:454, documented as "Push event when a CDC change is
   * received and processed". Nothing in the webview listens for it —
   * `useCDCLiveStore`'s switch handles `realtime:events-batch`,
   * `realtime:started`, `realtime:stopped`, `realtime:conflict` and
   * `realtime:status:response`, and falls through on everything else
   * (useCDCLiveStore.ts:216-296). A single event posted on the singular
   * channel is dropped without a trace: no row, no count, no error.
   *
   * The batch channel is the one that works, which is why the tests above use
   * it. This one covers the half of the contract that ships dead.
   */
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
  test('stop posts realtime:stop and realtime:stopped returns the panel to idle', async ({
    page,
  }) => {
    await openRealtimeTab(page);
    await startWatching(page, 'Account');
    await confirmStarted(page, ['Account']);
    await pushBatch(page, [cdcEvent(5001, 'Account', 'CREATE', ['001000000000001AAA'])]);
    await expect(page.getByTestId('cdc-event-count')).toHaveText('1 events', { timeout: 10_000 });

    await page.getByTestId('cdc-stop-btn').click();
    expect(await outgoing(page, 'realtime:stop')).toHaveLength(1);

    // The badge does not flip on the click: the host owns the transition, and
    // a panel that claimed 'Disconnected' before the host agreed would hide a
    // stream that is still running.
    await expect(page.getByTestId('cdc-status-badge')).toHaveText('Syncing');

    await sendExtensionMessage(page, {
      type: 'realtime:stopped',
      id: 'evt-realtime-stopped',
      payload: { sessionId: SESSION_ID, reason: 'user_requested' },
    });

    await expect(page.getByTestId('cdc-status-badge')).toHaveText('Disconnected', {
      timeout: 10_000,
    });
    await expect(page.getByTestId('cdc-start-btn')).toBeVisible();
    await expect(page.getByTestId('cdc-stop-btn')).toHaveCount(0);
    // The watched set is editable again, and what was already received stays on
    // screen — stopping a stream is not the same as clearing its history.
    await expect(page.getByTestId('cdc-object-checkbox-Account')).toBeEnabled();
    await expect(page.getByTestId('cdc-event-row-0')).toContainText('Account');
    await expect(page.getByTestId('cdc-event-count')).toHaveText('1 events');
  });

  /**
   * PRODUCT DEFECT — left red on purpose.
   *
   * `RealTimeStopRequest.payload` is `{ sessionId: string }` and
   * `realtime:started` hands the session id back, but `stopStream()` never
   * keeps it: it posts `sessionId: ''` unconditionally
   * (useCDCLiveStore.ts:200). The host is asked to stop a session it cannot
   * identify — with two panels open, or a session that outlived a webview
   * reload, there is nothing in the request saying which stream to close.
   */
  test('realtime:stop names the session realtime:started opened', async ({ page }) => {
    await openRealtimeTab(page);
    await startWatching(page, 'Account');
    await confirmStarted(page, ['Account']);

    await page.getByTestId('cdc-stop-btn').click();

    const stops = await outgoingPayloads(page, 'realtime:stop');
    expect(stops).toHaveLength(1);
    expect(stops[0].sessionId).toBe(SESSION_ID);
  });

  test('restarting after a stop opens a second subscription', async ({ page }) => {
    await openRealtimeTab(page);
    await startWatching(page, 'Account');
    await confirmStarted(page, ['Account']);
    await page.getByTestId('cdc-stop-btn').click();
    await sendExtensionMessage(page, {
      type: 'realtime:stopped',
      id: 'evt-realtime-stopped-2',
      payload: { sessionId: SESSION_ID, reason: 'user_requested' },
    });
    await expect(page.getByTestId('cdc-start-btn')).toBeVisible({ timeout: 10_000 });

    // Widen the watch set and go again — the picker unlocked, so this has to
    // reach the host as a *new* subscription, not a replay of the first.
    await page.getByTestId('cdc-object-checkbox-Case').check();
    await page.getByTestId('cdc-start-btn').click();

    const starts = await outgoingPayloads(page, 'realtime:start');
    expect(starts).toHaveLength(2);
    expect(starts[1].watchedObjects).toEqual(['Account', 'Case']);
    await expect(page.getByTestId('cdc-status-badge')).toHaveText('Connecting');
  });
});

/**
 * What the shipped extension actually answers.
 *
 * `realtime:start` is routed to `NoOpHandler` (ExtensionHandlers.ts:664-678),
 * which replies on `realtime:started` with
 * `{ success: false, error: 'Feature not yet available', comingSoon: true }`.
 * So in the product as installed today, this whole panel ends at a red badge:
 * the UI is complete and the host behind it is not.
 *
 * That is worth a test rather than a footnote. The store used to report
 * 'syncing' for any `realtime:started`, which painted a success-green "Syncing"
 * badge over a stream that would never deliver an event. The guard that fixed
 * it is one line and easy to lose.
 */
test.describe('Real-time CDC — the host that ships', () => {
  test('a comingSoon start is reported as an error, not as a live stream', async ({ page }) => {
    await openRealtimeTab(page);
    await startWatching(page, 'Account');

    await sendExtensionMessage(page, {
      type: 'realtime:started',
      id: 'evt-realtime-noop',
      payload: { success: false, error: 'Feature not yet available', comingSoon: true },
    });

    await expect(page.getByTestId('cdc-status-badge')).toHaveText('Error', { timeout: 10_000 });
    // No stream means no lie about one: the feed stays empty and the picker
    // opens back up so the user can change something and retry.
    await expect(page.getByTestId('cdc-event-count')).toHaveText('0 events');
    await expect(page.getByTestId('cdc-event-feed')).toContainText('No events yet');
    await expect(page.getByTestId('cdc-start-btn')).toBeEnabled();
    await expect(page.getByTestId('cdc-object-checkbox-Account')).toBeEnabled();
  });
});
