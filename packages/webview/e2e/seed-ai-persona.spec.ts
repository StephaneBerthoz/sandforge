import { test, expect } from '@playwright/test';
import { MockBridge } from './helpers/MockBridge';
import { mockAIPersona } from './fixtures';

/**
 * Plan 02-03 — Spec 1: Seed AI persona then execute.
 *
 * Uses the `?e2e-harness=seed-ai` surface to keep the flow deterministic and
 * decoupled from the full Forge wizard (which has many pre-conditions around
 * record IDs / templates / depth chips that are orthogonal to this flow).
 *
 * Exercises:
 *   1. AI tab + prompt + source/target selection enables the generate button.
 *   2. Extension responds with an AI persona -> preview panel appears.
 *   3. User clicks Execute -> outgoing `forge:execute` message is captured.
 *   4. Execution-started response renders the execution indicator.
 */
test.describe('Seed AI persona -> execute', () => {
  let mockBridge: MockBridge;

  test.beforeEach(async ({ page }) => {
    mockBridge = new MockBridge();
    await mockBridge.setup(page);
    await page.goto('/?e2e-harness=seed-ai');
    await page.waitForSelector('[data-testid="app-shell"]');
    await expect(page.getByTestId('forge-page')).toBeVisible();
  });

  test('generates AI persona and starts execution', async ({ page }) => {
    // AI tab visible with input
    await expect(page.getByTestId('forge-tab-ai')).toBeVisible();
    await expect(page.getByTestId('forge-input-ai')).toBeVisible();

    // Fill inputs
    await page.getByTestId('forge-input-ai').fill('Mid-market B2B SaaS customer, 50 records');
    await page.getByTestId('forge-source-org').selectOption('org-src-1');
    await page.getByTestId('forge-target-org').selectOption('org-tgt-1');

    // Generate
    const generateBtn = page.getByTestId('forge-ai-generate-btn');
    await expect(generateBtn).toBeEnabled();
    await generateBtn.click();

    // Extension responds with the persona
    await mockBridge.respond('forge:ai:generate:response', mockAIPersona());

    // Preview visible within 5s
    await expect(page.getByTestId('forge-ai-persona-preview')).toBeVisible({ timeout: 5_000 });

    // Execute
    await page.getByTestId('forge-execute-btn').click();
    await mockBridge.respond('forge:execute:response', { executionId: 'exec-1', status: 'started' });
    await expect(page.getByTestId('forge-execution-indicator')).toBeVisible({ timeout: 5_000 });
  });

  test('captures forge:ai:generate outgoing message', async ({ page }) => {
    await page.getByTestId('forge-input-ai').fill('Mid-market B2B SaaS customer, 50 records');
    await page.getByTestId('forge-source-org').selectOption('org-src-1');
    await page.getByTestId('forge-target-org').selectOption('org-tgt-1');
    await page.getByTestId('forge-ai-generate-btn').click();

    const generateMessages = await mockBridge.getMessages('forge:ai:generate');
    expect(generateMessages.length).toBeGreaterThan(0);
    const first = generateMessages[0];
    expect(first.type).toBe('forge:ai:generate');
    expect(first.payload).toBeDefined();
  });
});
