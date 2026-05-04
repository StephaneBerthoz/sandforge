import { test, expect } from '@playwright/test';
import { MockBridge } from './helpers/MockBridge';
import { mockDriftEvent } from './fixtures';

/**
 * Plan 03-04 — Spec: Monitor Drift Feed.
 *
 * Uses `?e2e-harness=drift-feed`. The harness mounts the production
 * `DriftFeed.tsx` component behind a tab-switch so the spec exercises real
 * production code (subscription wiring, filter chips, expand toggle).
 *
 * Streams a finite 3-event sequence over `MockBridge.stream()` (P-02.9
 * mitigation — never use an infinite source in E2E).
 *
 * Exercises:
 *   1. Tab switch -> DriftFeed visible -> 3 events render as 3 rows.
 *   2. Permission filter chip narrows the visible rows down to the single
 *      `severity: 'permission'` event.
 *   3. Click on an event row reveals the expanded delta block.
 */
test.describe('Monitor drift feed', () => {
  let bridge: MockBridge;

  test.beforeEach(async ({ page }) => {
    bridge = new MockBridge();
    await bridge.setup(page);
    await page.goto('/?e2e-harness=drift-feed');
    await page.waitForSelector('[data-testid="app-shell"]');
    await expect(page.getByTestId('monitor-page')).toBeVisible();
  });

  test('renders 3 drift events from a finite stream', async ({ page }) => {
    await page.click('[data-testid="monitor-tab-drift"]');
    await expect(page.getByTestId('monitor-drift-feed')).toBeVisible();

    // Finite, non-streaming source — P-02.9.
    await bridge.stream(
      [
        { type: 'monitor:drift:detected', payload: mockDriftEvent(1, 'info') },
        { type: 'monitor:drift:detected', payload: mockDriftEvent(2, 'breaking') },
        { type: 'monitor:drift:detected', payload: mockDriftEvent(3, 'permission') },
      ],
      { delayMs: 100 },
    );

    await expect(page.getByTestId('monitor-drift-event-row')).toHaveCount(3, { timeout: 5_000 });
  });

  test('Permission filter chip toggles event visibility', async ({ page }) => {
    await page.click('[data-testid="monitor-tab-drift"]');
    await bridge.stream(
      [
        { type: 'monitor:drift:detected', payload: mockDriftEvent(1, 'info') },
        { type: 'monitor:drift:detected', payload: mockDriftEvent(2, 'permission') },
      ],
      { delayMs: 50 },
    );
    await expect(page.getByTestId('monitor-drift-event-row')).toHaveCount(2, { timeout: 5_000 });

    await page.click('[data-testid="monitor-drift-filter-permission"]');
    await expect(page.getByTestId('monitor-drift-event-row')).toHaveCount(1);
  });

  test('Click on an event row expands its delta panel', async ({ page }) => {
    await page.click('[data-testid="monitor-tab-drift"]');
    await bridge.stream(
      [{ type: 'monitor:drift:detected', payload: mockDriftEvent(1, 'breaking') }],
      { delayMs: 50 },
    );
    await expect(page.getByTestId('monitor-drift-event-row')).toHaveCount(1, { timeout: 5_000 });

    await page.click('[data-testid="monitor-drift-event-row"]');
    await expect(page.getByTestId('monitor-drift-event-row-expanded')).toBeVisible();
  });
});
