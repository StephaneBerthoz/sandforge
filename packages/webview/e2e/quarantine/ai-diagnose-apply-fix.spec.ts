import { test, expect } from '@playwright/test';
import { MockBridge } from './helpers/MockBridge';
import { mockFailedJob, mockAIDiagnosis, mockFixApplied } from './fixtures';

/**
 * Plan 02-03 — Spec 5: AI diagnose failed job -> apply fix.
 *
 * Uses `?e2e-harness=ai-diagnose`. The AI diagnose UI ships in Phase 04;
 * the placeholder surface emits the requests and reacts to the mocked
 * responses so this spec stabilises the message contract for Phase 04.
 *
 * Exercises:
 *   1. On mount -> outgoing monitor:failed-jobs:request.
 *   2. Response populates one failed-job card with a Diagnose button.
 *   3. Diagnose click -> ai:diagnose request -> ai:diagnose:response
 *      renders the panel + confidence (88%).
 *   4. Apply fix -> ai:fix:apply -> ai:fix:applied renders "12 records
 *      updated" toast.
 *   5. P-6 (prompt-injection defense): no outgoing message payload
 *      contains a 40+ hex-char string (API-key shape).
 */
test.describe('AI diagnose failed job -> apply fix', () => {
  let mockBridge: MockBridge;

  test.beforeEach(async ({ page }) => {
    mockBridge = new MockBridge();
    await mockBridge.setup(page);
    await page.goto('/?e2e-harness=ai-diagnose');
    await page.waitForSelector('[data-testid="panel-app"]');
    await expect(page.getByTestId('monitor-failed-jobs-list')).toBeVisible();
  });

  test('diagnoses a failed job and applies the proposed fix', async ({ page }) => {
    // On-mount request for the failed-jobs list.
    await mockBridge.respondToNext(
      'monitor:failed-jobs:request',
      'monitor:failed-jobs:response',
      { jobs: [mockFailedJob()] },
    );

    const jobCard = page.getByTestId('monitor-failed-job-card').first();
    await expect(jobCard).toBeVisible({ timeout: 5_000 });

    // Diagnose.
    await jobCard.getByTestId('ai-diagnose-btn').click();
    await mockBridge.respond('ai:diagnose:response', mockAIDiagnosis());

    const panel = page.getByTestId('ai-diagnosis-panel');
    await expect(panel).toBeVisible({ timeout: 5_000 });
    await expect(panel).toContainText('EMEA');
    await expect(panel).toContainText('88%');

    // Apply fix.
    const applyBtn = page.getByTestId('ai-apply-fix-btn');
    await expect(applyBtn).toBeVisible();
    await applyBtn.click();
    await mockBridge.respond('ai:fix:applied', mockFixApplied());

    const toast = page.getByTestId('ai-fix-applied-toast');
    await expect(toast).toBeVisible({ timeout: 5_000 });
    await expect(toast).toContainText('12 records updated');

    // P-6: no outgoing payload contains a 40+ hex-character run (API-key /
    // token shape). Guards against accidental prompt-injection leakage.
    const all = await mockBridge.getMessages();
    const serialized = JSON.stringify(all);
    const hexMatches = serialized.match(/[A-Fa-f0-9]{40,}/g) ?? [];
    expect(hexMatches).toEqual([]);
  });
});
