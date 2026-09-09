import { test, expect } from '@playwright/test';
import { MockBridge, checkAccessibility, formatViolations } from './helpers';
import { MOCK_ORGS } from './fixtures';

/**
 * Navigate to a specific module page via PanelRouter.
 * Sets __SANDFORGE_MODULE__ and waits for the page to render.
 */
async function navigateToModule(
  bridge: MockBridge,
  page: import('@playwright/test').Page,
  moduleId: string,
  waitForTestId: string,
): Promise<void> {
  await bridge.setup(page);
  await page.addInitScript((id: string) => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = id;
  }, moduleId);
  await page.goto('/');
  await page.waitForSelector(`[data-testid="${waitForTestId}"]`, { timeout: 10000 });
}

/**
 * Common axe-core rules to disable across all pages.
 * These are documented exceptions for the VSCode WebView environment.
 */
const COMMON_DISABLED_RULES = [
  // VSCode CSS variables may not resolve to real colors in the E2E Vite
  // environment, causing false-positive contrast failures.
  'color-contrast',
];

/**
 * Assert zero axe violations, with a formatted error message on failure.
 */
function expectNoViolations(results: Awaited<ReturnType<typeof checkAccessibility>>): void {
  const violations = results.violations;
  expect(violations.length, formatViolations(violations)).toBe(0);
}

test.describe('axe-core WCAG 2.1 AA — Page Scans', () => {
  // axe-core analyze can be slow on complex pages with animations
  test.describe.configure({ timeout: 60000 });
  let bridge: MockBridge;

  test.beforeEach(() => {
    bridge = new MockBridge();
  });

  test('Home page', async ({ page }) => {
    await navigateToModule(bridge, page, 'home', 'home-page');
    const results = await checkAccessibility(page, { disableRules: COMMON_DISABLED_RULES });
    expectNoViolations(results);
  });

  test('Organizations page', async ({ page }) => {
    await navigateToModule(bridge, page, 'orgs', 'org-manager-page');
    const results = await checkAccessibility(page, { disableRules: COMMON_DISABLED_RULES });
    expectNoViolations(results);
  });

  test('Forge page', async ({ page }) => {
    await navigateToModule(bridge, page, 'forge', 'forge-page');
    await bridge.respond('org:list:response', { orgs: MOCK_ORGS });
    const results = await checkAccessibility(page, { disableRules: COMMON_DISABLED_RULES });
    expectNoViolations(results);
  });

  test('Grappe page', async ({ page }) => {
    await navigateToModule(bridge, page, 'grappe', 'grappe-page');
    const results = await checkAccessibility(page, { disableRules: COMMON_DISABLED_RULES });
    expectNoViolations(results);
  });

  test('Seed page', async ({ page }) => {
    await navigateToModule(bridge, page, 'seed', 'panel-app');
    await bridge.respond('org:list:response', { orgs: MOCK_ORGS });
    await page.waitForSelector('[data-testid="seed-page"]', { timeout: 5000 }).catch(() => {
      // Page may render EmptyState if orgs not processed yet — still scan
    });
    const results = await checkAccessibility(page, { disableRules: COMMON_DISABLED_RULES });
    expectNoViolations(results);
  });

  test('Sync page', async ({ page }) => {
    await navigateToModule(bridge, page, 'sync', 'panel-app');
    await bridge.respond('org:list:response', { orgs: MOCK_ORGS });
    await page.waitForSelector('[data-testid="sync-page"]', { timeout: 5000 }).catch(() => {
      // Scan whatever state rendered
    });
    const results = await checkAccessibility(page, { disableRules: COMMON_DISABLED_RULES });
    expectNoViolations(results);
  });

  test('Monitor page', async ({ page }) => {
    // Monitor shows empty state without org selection — scan the empty state
    await navigateToModule(bridge, page, 'monitor', 'panel-app');
    await page.waitForTimeout(1000);
    const results = await checkAccessibility(page, { disableRules: COMMON_DISABLED_RULES });
    expectNoViolations(results);
  });

  test('Compare page', async ({ page }) => {
    await navigateToModule(bridge, page, 'compare', 'panel-app');
    await bridge.respond('org:list:response', { orgs: MOCK_ORGS });
    await page.waitForSelector('[data-testid="compare-page"]', { timeout: 5000 }).catch(() => {
      // May show EmptyState if < 2 orgs processed — still scan
    });
    const results = await checkAccessibility(page, { disableRules: COMMON_DISABLED_RULES });
    expectNoViolations(results);
  });

  test('DataOps page', async ({ page }) => {
    await navigateToModule(bridge, page, 'dataops', 'panel-app');
    await page.waitForSelector('[data-testid="dataops-page"]', { timeout: 5000 }).catch(() => {
      // Scan whatever state rendered
    });
    const results = await checkAccessibility(page, { disableRules: COMMON_DISABLED_RULES });
    expectNoViolations(results);
  });

  test('Automation page', async ({ page }) => {
    await navigateToModule(bridge, page, 'automation', 'panel-app');
    await bridge.respond('org:list:response', { orgs: MOCK_ORGS });
    await page.waitForSelector('[data-testid="automation-page"]', { timeout: 5000 }).catch(() => {
      // May show EmptyState without orgs — still scan
    });
    const results = await checkAccessibility(page, { disableRules: COMMON_DISABLED_RULES });
    expectNoViolations(results);
  });

  test('Reports page', async ({ page }) => {
    await navigateToModule(bridge, page, 'reports', 'reports-page');
    const results = await checkAccessibility(page, { disableRules: COMMON_DISABLED_RULES });
    expectNoViolations(results);
  });

  test('Settings page', async ({ page }) => {
    await navigateToModule(bridge, page, 'settings', 'settings-page');
    const results = await checkAccessibility(page, { disableRules: COMMON_DISABLED_RULES });
    expectNoViolations(results);
  });

  test('Help page', async ({ page }) => {
    await navigateToModule(bridge, page, 'help', 'help-page');
    const results = await checkAccessibility(page, { disableRules: COMMON_DISABLED_RULES });
    expectNoViolations(results);
  });

  test('AI page', async ({ page }) => {
    await navigateToModule(bridge, page, 'ai', 'ai-chat-panel');
    const results = await checkAccessibility(page, { disableRules: COMMON_DISABLED_RULES });
    expectNoViolations(results);
  });

  test('Autopilot page', async ({ page }) => {
    await navigateToModule(bridge, page, 'autopilot', 'autopilot-page');
    const results = await checkAccessibility(page, { disableRules: COMMON_DISABLED_RULES });
    expectNoViolations(results);
  });
});

test.describe('axe-core WCAG 2.1 AA — Interactive Flows', () => {
  test.describe.configure({ timeout: 60000 });
  let bridge: MockBridge;

  test.beforeEach(() => {
    bridge = new MockBridge();
  });

  test('Autopilot wizard step progression', async ({ page }) => {
    await navigateToModule(bridge, page, 'autopilot', 'autopilot-page');
    await bridge.respond('org:list:response', { orgs: MOCK_ORGS });

    // Step 1: Connect — scan
    const step1 = await checkAccessibility(page, { disableRules: COMMON_DISABLED_RULES });
    expectNoViolations(step1);

    // Select orgs and advance to Step 2
    await page.getByTestId('source-org-org-src-1').click();
    await page.getByTestId('target-org-org-tgt-1').click();
    await page.getByTestId('seed-wizard-next').click();

    await bridge.respond('autopilot:schema-result', {
      graph: {
        objects: [
          { apiName: 'Account', label: 'Account', recordCount: 500 },
          { apiName: 'Contact', label: 'Contact', recordCount: 1200 },
        ],
      },
    });

    await page.getByTestId('step2-objects').waitFor({ state: 'visible', timeout: 5000 });
    const step2 = await checkAccessibility(page, { disableRules: COMMON_DISABLED_RULES });
    expectNoViolations(step2);

    // Advance to Step 3: Compliance
    await page.getByTestId('select-all-checkbox').click();
    await page.getByTestId('seed-wizard-next').click();
    await page.getByTestId('step3-compliance').waitFor({ state: 'visible', timeout: 5000 });
    const step3 = await checkAccessibility(page, { disableRules: COMMON_DISABLED_RULES });
    expectNoViolations(step3);

    // Advance to Step 4: Review
    await page.getByTestId('seed-wizard-next').click();
    await page.getByTestId('step4-review').waitFor({ state: 'visible', timeout: 5000 });
    const step4 = await checkAccessibility(page, { disableRules: COMMON_DISABLED_RULES });
    expectNoViolations(step4);
  });

  test('AI chat after conversation creation', async ({ page }) => {
    await navigateToModule(bridge, page, 'ai', 'ai-chat-panel');

    // Create a conversation
    await page.getByTestId('new-conversation-btn').click();
    await bridge.respond('ai:conversation:created', {
      conversation: { id: 'axe-conv', title: 'Axe Test', createdAt: Date.now() },
    });
    await page
      .getByTestId('conversation-item-axe-conv')
      .waitFor({ state: 'visible', timeout: 5000 });

    // Scan with conversation active
    const results = await checkAccessibility(page, { disableRules: COMMON_DISABLED_RULES });
    expectNoViolations(results);
  });

  test('AI chat with assistant response', async ({ page }) => {
    await navigateToModule(bridge, page, 'ai', 'ai-chat-panel');

    await page.getByTestId('new-conversation-btn').click();
    await bridge.respond('ai:conversation:created', {
      conversation: { id: 'axe-conv-2', title: 'Chat', createdAt: Date.now() },
    });
    await page
      .getByTestId('conversation-item-axe-conv-2')
      .waitFor({ state: 'visible', timeout: 5000 });

    // Send message and receive response
    await page.getByTestId('chat-input').fill('Test query');
    await page.getByTestId('send-btn').click();
    await bridge.respond('ai:chat:response', {
      conversationId: 'axe-conv-2',
      message: {
        id: 'msg-axe',
        role: 'assistant',
        content: 'Here is a test response with a code block:\n```sql\nSELECT Id FROM Account\n```',
        timestamp: Date.now(),
      },
    });
    await page.getByTestId('message-bubble-assistant').waitFor({ state: 'visible', timeout: 5000 });

    const results = await checkAccessibility(page, { disableRules: COMMON_DISABLED_RULES });
    expectNoViolations(results);
  });

  test('Settings page with tabs', async ({ page }) => {
    await navigateToModule(bridge, page, 'settings', 'settings-page');

    // Scan initial state
    const initial = await checkAccessibility(page, { disableRules: COMMON_DISABLED_RULES });
    expectNoViolations(initial);
  });
});
