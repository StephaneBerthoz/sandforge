import { test, expect } from '@playwright/test';
import { MockBridge } from './helpers/MockBridge';
import { mockSyncConflict } from './fixtures';

/**
 * Plan 02-03 — Spec 2: Quick sync with conflict -> resolve.
 *
 * Uses the `?e2e-harness=sync-conflict` surface. The harness renders a
 * minimal Sync placeholder that:
 *   - emits `sync:start` on button click,
 *   - reacts to `sync:conflict:detected` by rendering the conflict dialog
 *     with one row per field conflict,
 *   - exposes Use source / Use target buttons that emit
 *     `sync:conflict:resolve { resolution }`,
 *   - dismisses the dialog + renders a `sync-resolved-indicator` when the
 *     extension replies with `sync:conflict:resolved`.
 *
 * Exercises:
 *   1. Object selection + start sync -> outgoing `sync:start` message.
 *   2. Conflict injected via MockBridge.respond('sync:conflict:detected').
 *   3. Dialog visible with 2 field rows.
 *   4. Use source path -> outgoing message + resolved indicator.
 *   5. Use target path -> outgoing message carries resolution: 'use-target'.
 */
test.describe('Quick sync with conflict -> resolve', () => {
  let mockBridge: MockBridge;

  test.beforeEach(async ({ page }) => {
    mockBridge = new MockBridge();
    await mockBridge.setup(page);
    await page.goto('/?e2e-harness=sync-conflict');
    await page.waitForSelector('[data-testid="app-shell"]');
    await expect(page.getByTestId('sync-page')).toBeVisible();
  });

  test('detects conflict then resolves via "use source"', async ({ page }) => {
    await page.getByTestId('sync-object-select').selectOption('Contact');
    await page.getByTestId('sync-start-btn').click();

    // Push a conflict notification using the bridge envelope path.
    await mockBridge.respond('sync:conflict:detected', mockSyncConflict(), 'unknown');

    await expect(page.getByTestId('sync-conflict-dialog')).toBeVisible({ timeout: 5_000 });
    const rows = page.getByTestId('sync-conflict-field-row');
    await expect(rows).toHaveCount(2);

    await page.getByTestId('sync-conflict-use-source').click();
    await mockBridge.respond('sync:conflict:resolved', {
      conflictId: 'conflict-1',
      resolution: 'use-source',
    });

    await expect(page.getByTestId('sync-conflict-dialog')).toBeHidden({ timeout: 5_000 });
    await expect(page.getByTestId('sync-resolved-indicator')).toBeVisible();
  });

  test('resolves via "use target" and emits correct outgoing message', async ({ page }) => {
    await page.getByTestId('sync-object-select').selectOption('Contact');
    await page.getByTestId('sync-start-btn').click();
    await mockBridge.respond('sync:conflict:detected', mockSyncConflict(), 'unknown');
    await expect(page.getByTestId('sync-conflict-dialog')).toBeVisible({ timeout: 5_000 });

    await page.getByTestId('sync-conflict-use-target').click();

    const resolves = await mockBridge.getMessages('sync:conflict:resolve');
    expect(resolves.length).toBeGreaterThan(0);
    const payload = resolves[resolves.length - 1].payload as { resolution?: string };
    expect(payload.resolution).toBe('use-target');
  });
});
