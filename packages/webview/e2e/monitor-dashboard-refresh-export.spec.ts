import { test, expect } from '@playwright/test';
import { MockBridge } from './helpers/MockBridge';
import { mockMonitorMetrics, mockExportUrl } from './fixtures';

/**
 * Plan 02-03 — Spec 3: Monitor dashboard refresh -> export CSV.
 *
 * Uses `?e2e-harness=monitor`. The harness fires a single
 * `monitor:metrics:request` on mount and another on refresh click —
 * finite, no streaming (P-02.9 mitigation).
 *
 * Exercises:
 *   1. On mount -> outgoing metrics request, response renders both cards
 *      and the `monitor-last-updated` timestamp.
 *   2. Refresh click -> second response with a later timestamp; two
 *      snapshots differ in the UI.
 *   3. Export CSV click -> outgoing `monitor:export:request` and the
 *      `monitor-export-toast` surfaces with the `monitor-export-` file
 *      prefix.
 *   4. Console has zero warnings containing 'leak' or 'orphan'.
 */
test.describe('Monitor dashboard refresh -> export', () => {
  let mockBridge: MockBridge;
  let consoleWarnings: string[];

  test.beforeEach(async ({ page }) => {
    consoleWarnings = [];
    page.on('console', (msg) => {
      if (msg.type() === 'warning' || msg.type() === 'warn') {
        consoleWarnings.push(msg.text());
      }
    });
    mockBridge = new MockBridge();
    await mockBridge.setup(page);
    await page.goto('/?e2e-harness=monitor');
    await page.waitForSelector('[data-testid="app-shell"]');
    await expect(page.getByTestId('monitor-page')).toBeVisible();
  });

  test('refreshes metrics and exports CSV', async ({ page }) => {
    // On-mount metrics request -> respond with initial snapshot.
    const initialSnapshot = mockMonitorMetrics();
    await mockBridge.respondToNext(
      'monitor:metrics:request',
      'monitor:metrics:response',
      initialSnapshot,
    );

    await expect(page.getByTestId('monitor-metric-card-apiRequests')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('monitor-metric-card-jobs')).toBeVisible();
    const firstUpdatedText = await page.getByTestId('monitor-last-updated').textContent();
    expect(firstUpdatedText).toBeTruthy();

    // Click refresh -> respond with an updated (later) snapshot.
    await page.getByTestId('monitor-refresh-btn').click();
    const refreshed = {
      ...mockMonitorMetrics(),
      lastUpdated: new Date(Date.now() + 60_000).toISOString(),
    };
    await mockBridge.respondToNext(
      'monitor:metrics:request',
      'monitor:metrics:response',
      refreshed,
    );

    // Timestamp should change.
    await expect(page.getByTestId('monitor-last-updated')).not.toHaveText(firstUpdatedText ?? '', {
      timeout: 5_000,
    });

    // Export CSV.
    await page.getByTestId('monitor-export-csv-btn').click();
    await mockBridge.respond('monitor:export:response', mockExportUrl());

    const toast = page.getByTestId('monitor-export-toast');
    await expect(toast).toBeVisible({ timeout: 5_000 });
    const toastText = await toast.textContent();
    expect(toastText).toContain('monitor-export-');

    // P-02.9: no leak / orphan warnings emitted during the flow.
    const suspect = consoleWarnings.filter(
      (w) => /leak|orphan/i.test(w),
    );
    expect(suspect).toEqual([]);
  });
});
