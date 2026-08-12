import { test, expect } from '@playwright/test';
import { MockBridge } from './helpers/MockBridge';
import { mockCdcSubscription, mockCdcEvent } from './fixtures';

/**
 * Plan 02-03 — Spec 4: CDC subscription -> events received -> unsubscribe.
 *
 * Uses the `?e2e-harness=cdc` placeholder. The CDC panel is shipped in
 * Phase 05; the harness renders a minimal surface with every required
 * testid so this spec can be green in Phase 02 and the contract stabilises
 * the UI Phase 05 must keep.
 *
 * Exercises:
 *   1. Object selection + subscribe -> outgoing `cdc:subscribe`.
 *   2. cdc:subscribe:response renders the allocation badge.
 *   3. MockBridge.stream() pushes 3 cdc:event messages with a small delay;
 *      3 feed rows render in order.
 *   4. Unsubscribe click -> outgoing message + idle state.
 *
 * Placeholder components per Plan 02-03 instructions; Phase 05 will swap
 * the harness body while keeping the testids stable.
 */
test.describe('CDC subscribe -> stream events -> unsubscribe', () => {
  let mockBridge: MockBridge;

  test.beforeEach(async ({ page }) => {
    mockBridge = new MockBridge();
    await mockBridge.setup(page);
    await page.goto('/?e2e-harness=cdc');
    await page.waitForSelector('[data-testid="panel-app"]');
    await expect(page.getByTestId('monitor-tab-cdc')).toBeVisible();
  });

  test('subscribes, receives 3 events, then unsubscribes', async ({ page }) => {
    await page.getByTestId('monitor-cdc-object-select').selectOption('Account');
    await page.getByTestId('monitor-cdc-subscribe-btn').click();

    // Respond with the subscription payload -> allocation badge visible.
    await mockBridge.respond('cdc:subscribe:response', mockCdcSubscription(), 'unknown');
    const badge = page.getByTestId('monitor-cdc-allocation-badge');
    await expect(badge).toBeVisible({ timeout: 5_000 });
    await expect(badge).toContainText('5200');
    await expect(badge).toContainText('100000');

    // Stream 3 finite events (P-02.9: no infinite stream).
    await mockBridge.stream(
      [
        { type: 'cdc:event', payload: mockCdcEvent(1) },
        { type: 'cdc:event', payload: mockCdcEvent(2) },
        { type: 'cdc:event', payload: mockCdcEvent(3) },
      ],
      { delayMs: 100 },
    );

    const feedRows = page.getByTestId('monitor-cdc-feed-row');
    await expect(feedRows).toHaveCount(3, { timeout: 5_000 });

    // Unsubscribe.
    await page.getByTestId('monitor-cdc-unsubscribe-btn').click();
    await mockBridge.respond('cdc:unsubscribe:response', {
      subscriptionId: 'sub-1',
      status: 'unsubscribed',
    });

    // Allocation badge dismissed or replaced by idle.
    await expect(page.getByTestId('monitor-cdc-allocation-badge')).toBeHidden({ timeout: 5_000 });
    await expect(page.getByTestId('monitor-cdc-idle')).toBeVisible();
  });
});
