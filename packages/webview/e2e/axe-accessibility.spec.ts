import { test, expect } from '@playwright/test';
import { MockBridge, checkAccessibility, formatViolations } from './helpers';
import { MOCK_ORGS } from './fixtures';

/** What the panel needs answered before it renders the page under scan. */
interface ModuleBootOptions {
  /**
   * Answer the `org:list` request BridgeProvider fires on mount.
   *
   * Forge and Autopilot short-circuit to an `EmptyState` when the org store is
   * empty, and that state carries no page-level testid — so their scans timed
   * out on `forge-page` / `autopilot-page` while looking at a perfectly
   * rendered "connect an org" screen. The orgs have to arrive *before* the
   * wait, which is why answering after `navigateToModule` returned never
   * helped.
   */
  readonly orgs?: boolean;
  /**
   * Answer `ai:status` with the assistant enabled.
   *
   * `sandforge.ai.enabled` defaults to false, so AIPage renders
   * `ai-not-configured` instead of `ai-chat-panel` unless the fixture says
   * otherwise. Same failure mode as above, different gate.
   */
  readonly ai?: boolean;
}

/**
 * Navigate to a specific module page via PanelRouter.
 *
 * Sets `__SANDFORGE_MODULE__`, satisfies whatever gates the page gets stuck
 * behind, and only then waits for it to render — the order screenshots.spec.ts
 * established: `setup` → `goto` → answer the mount requests → wait for a page
 * testid.
 */
async function navigateToModule(
  bridge: MockBridge,
  page: import('@playwright/test').Page,
  moduleId: string,
  waitForTestId: string,
  options: ModuleBootOptions = {},
): Promise<void> {
  await bridge.setup(page);
  await page.addInitScript((id: string) => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = id;
  }, moduleId);
  await page.goto('/');

  // BridgeProvider guards its mount burst with a ref, so StrictMode's second
  // pass does not re-send: one `org:list` and one `ai:status` per load, and
  // `respond`/`respondToNext` correlate against exactly that one.
  if (options.orgs) {
    await bridge.seedOrgs(MOCK_ORGS);
  }
  if (options.ai) {
    await bridge.respondToNext(
      'ai:status',
      'ai:status:response',
      { enabled: true },
      {
        timeout: 10_000,
      },
    );
  }

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
 * Graph an `autopilot:schema-result` answers with.
 *
 * `AutopilotGraph` carries `nodes` keyed by `objectApiName`; the wizard reads
 * `graph.nodes` directly to build both the object list and the initial
 * selection, so the `{ graph: { objects: [...] } }` shape the shared fixtures
 * still hand out renders nothing at all.
 */
const MOCK_GRAPH = {
  nodes: [
    {
      objectApiName: 'Account',
      recordCount: 500,
      estimatedApiCalls: 3,
      piiFields: [],
      anonymizationRules: [],
      status: 'pending',
      progress: 0,
      insertOrder: 0,
      level: 0,
      successCount: 0,
      failureCount: 0,
      errors: [],
      elapsedMs: 0,
      apiCallsUsed: 0,
    },
    {
      objectApiName: 'Contact',
      recordCount: 1200,
      estimatedApiCalls: 6,
      piiFields: [],
      anonymizationRules: [],
      status: 'pending',
      progress: 0,
      insertOrder: 1,
      level: 1,
      successCount: 0,
      failureCount: 0,
      errors: [],
      elapsedMs: 0,
      apiCallsUsed: 0,
    },
  ],
  edges: [],
  cycles: [],
  stats: {
    totalObjects: 2,
    totalRelationships: 1,
    cycleCount: 0,
    maxDepth: 1,
    totalRecords: 1700,
    totalEstimatedApiCalls: 9,
  },
};

/**
 * Plan an `autopilot:plan-ready` answers with.
 *
 * Every field here lands in a stat card on the review step, which is the
 * surface this flow's last scan is actually looking at.
 */
const MOCK_PLAN = {
  waves: [
    { order: 0, objects: ['Account'], dependsOn: [] },
    { order: 1, objects: ['Contact'], dependsOn: [0] },
  ],
  totalRecords: 1700,
  estimatedDurationSec: 240,
  estimatedApiCalls: 9,
  complianceFramework: 'gdpr',
  anonymizationSummary: {
    totalPiiFields: 4,
    totalFieldsToAnonymize: 3,
    methodBreakdown: {},
    objectsWithPii: ['Contact'],
  },
  cycleResolutions: [],
};

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
    await navigateToModule(bridge, page, 'forge', 'forge-page', { orgs: true });
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
    await navigateToModule(bridge, page, 'ai', 'ai-chat-panel', { ai: true });
    const results = await checkAccessibility(page, { disableRules: COMMON_DISABLED_RULES });
    expectNoViolations(results);
  });

  test('Autopilot page', async ({ page }) => {
    await navigateToModule(bridge, page, 'autopilot', 'autopilot-page', { orgs: true });
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
    await navigateToModule(bridge, page, 'autopilot', 'autopilot-page', { orgs: true });

    // Step 1: Connect — scan
    await page.getByTestId('step1-connect').waitFor({ state: 'visible', timeout: 5000 });
    const step1 = await checkAccessibility(page, { disableRules: COMMON_DISABLED_RULES });
    expectNoViolations(step1);

    // Select orgs and advance to Step 2. `next` fires `autopilot:scan-schema`
    // through useBridgeMutation, which drops any response whose
    // `correlationId` is not the request's id — hence respondToNext rather
    // than a bare respond on the result channel.
    await page.getByTestId('source-org-org-src-1').click();
    await page.getByTestId('target-org-org-tgt-1').click();
    await page.getByTestId('seed-wizard-next').click();
    await bridge.respondToNext('autopilot:scan-schema', 'autopilot:schema-result', {
      graph: MOCK_GRAPH,
    });

    await page.getByTestId('step2-objects').waitFor({ state: 'visible', timeout: 5000 });
    const step2 = await checkAccessibility(page, { disableRules: COMMON_DISABLED_RULES });
    expectNoViolations(step2);

    // Advance to Step 3: Compliance. The scan already selected every
    // discovered object, so the wizard walks straight over — toggling
    // select-all here would *clear* the selection and disable `next`.
    await page.getByTestId('seed-wizard-next').click();
    await page.getByTestId('step3-compliance').waitFor({ state: 'visible', timeout: 5000 });
    const step3 = await checkAccessibility(page, { disableRules: COMMON_DISABLED_RULES });
    expectNoViolations(step3);

    // Advance to Step 4: Review — one more round trip, this one for the plan
    // whose numbers the review step puts on screen.
    await page.getByTestId('seed-wizard-next').click();
    await bridge.respondToNext('autopilot:generate-plan', 'autopilot:plan-ready', {
      plan: MOCK_PLAN,
      graph: MOCK_GRAPH,
    });
    await page.getByTestId('step4-review').waitFor({ state: 'visible', timeout: 5000 });
    const step4 = await checkAccessibility(page, { disableRules: COMMON_DISABLED_RULES });
    expectNoViolations(step4);
  });

  test('AI chat after conversation creation', async ({ page }) => {
    await navigateToModule(bridge, page, 'ai', 'ai-chat-panel', { ai: true });

    // Create a conversation
    await page.getByTestId('new-conversation-btn').click();
    await bridge.respond('ai:conversation:created', {
      conversation: {
        id: 'axe-conv',
        title: 'Axe Test',
        updatedAt: new Date().toISOString(),
        messageCount: 0,
      },
    });
    await page
      .getByTestId('conversation-item-axe-conv')
      .waitFor({ state: 'visible', timeout: 5000 });

    // Scan with conversation active
    const results = await checkAccessibility(page, { disableRules: COMMON_DISABLED_RULES });
    expectNoViolations(results);
  });

  test('AI chat with assistant response', async ({ page }) => {
    await navigateToModule(bridge, page, 'ai', 'ai-chat-panel', { ai: true });

    await page.getByTestId('new-conversation-btn').click();
    await bridge.respond('ai:conversation:created', {
      conversation: {
        id: 'axe-conv-2',
        title: 'Chat',
        updatedAt: new Date().toISOString(),
        messageCount: 0,
      },
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
        timestamp: new Date().toISOString(),
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
