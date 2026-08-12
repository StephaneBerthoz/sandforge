import { test, expect } from '@playwright/test';
import { MockBridge } from './helpers';
import { MOCK_ORGS } from './fixtures';

/**
 * Set window.__SANDFORGE_MODULE__ = 'autopilot' so PanelApp renders the
 * Autopilot page directly (standalone panel, not in sidebar router).
 */
async function setupAutopilotPanel(bridge: MockBridge, page: import('@playwright/test').Page): Promise<void> {
  await bridge.setup(page);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'autopilot';
  });
  await page.goto('/');
  await bridge.seedOrgs();
  await page.waitForSelector('[data-testid="autopilot-page"]', { timeout: 10000 });
}

/** Inject mock orgs into the org store via message. */
async function injectOrgs(bridge: MockBridge): Promise<void> {
  await bridge.respond('org:list:response', { orgs: MOCK_ORGS });
}

/** Mock schema result with sample objects. */
const MOCK_SCHEMA_OBJECTS = [
  { apiName: 'Account', label: 'Account', recordCount: 500 },
  { apiName: 'Contact', label: 'Contact', recordCount: 1200 },
  { apiName: 'Opportunity', label: 'Opportunity', recordCount: 300 },
];

/**
 * Build a mock AutopilotGraph compatible with the store's graph shape.
 * The execution UI reads graph.nodes for rendering.
 */
function buildMockGraph(): Record<string, unknown> {
  return {
    nodes: MOCK_SCHEMA_OBJECTS.map((obj, i) => ({
      objectApiName: obj.apiName,
      recordCount: obj.recordCount,
      estimatedApiCalls: Math.ceil(obj.recordCount / 200),
      piiFields: [],
      anonymizationRules: [],
      status: 'pending',
      progress: 0,
      insertOrder: i,
      level: 0,
      successCount: 0,
      failureCount: 0,
      elapsedMs: 0,
      apiCallsUsed: 0,
    })),
    edges: [],
    cycles: [],
    stats: {
      totalObjects: MOCK_SCHEMA_OBJECTS.length,
      totalRelationships: 0,
      cycleCount: 0,
      maxDepth: 0,
      totalRecords: 2000,
      totalEstimatedApiCalls: 20,
    },
  };
}

/**
 * Set the Zustand autopilot store to execution state directly.
 * The store is exposed on window.__AUTOPILOT_STORE__ in dev mode.
 */
async function enterExecutionState(page: import('@playwright/test').Page): Promise<void> {
  const graph = buildMockGraph();
  await page.evaluate((g) => {
    const store = (window as unknown as Record<string, unknown>).__AUTOPILOT_STORE__ as
      { setState: (state: Record<string, unknown>) => void } | undefined;
    if (store) {
      store.setState({
        step: 'executing',
        executionStatus: 'executing',
        graph: g,
      });
    }
  }, graph);
  await page.waitForSelector('[data-testid="autopilot-graph-area"]', { timeout: 5000 });
}

/**
 * Set the Zustand autopilot store to completed state.
 */
async function enterCompletedState(page: import('@playwright/test').Page): Promise<void> {
  const graph = buildMockGraph();
  // Mark all nodes as completed
  (graph.nodes as Array<Record<string, unknown>>).forEach((n) => {
    n.status = 'completed';
    n.progress = 100;
    n.successCount = n.recordCount;
  });
  await page.evaluate((g) => {
    const store = (window as unknown as Record<string, unknown>).__AUTOPILOT_STORE__ as
      { setState: (state: Record<string, unknown>) => void } | undefined;
    if (store) {
      store.setState({
        step: 'completed',
        executionStatus: 'completed',
        graph: g,
      });
    }
  }, graph);
  await page.waitForSelector('[data-testid="view-compliance-report"]', { timeout: 5000 });
}

test.describe('Autopilot — Wizard Flow', () => {
  let bridge: MockBridge;

  test.beforeEach(async ({ page }) => {
    bridge = new MockBridge();
    await setupAutopilotPanel(bridge, page);
    await injectOrgs(bridge);
  });

  test('displays the autopilot page with wizard', async ({ page }) => {
    await expect(page.getByTestId('autopilot-page')).toBeVisible();
    await expect(page.getByTestId('autopilot-wizard')).toBeVisible();
  });

  test('Step 1: displays org selectors', async ({ page }) => {
    await expect(page.getByTestId('step1-connect')).toBeVisible();
    await expect(page.getByTestId('source-selector')).toBeVisible();
    await expect(page.getByTestId('target-selector')).toBeVisible();
  });

  test('Step 1: displays available orgs for selection', async ({ page }) => {
    await expect(page.getByTestId('source-org-org-src-1')).toBeVisible();
    await expect(page.getByTestId('target-org-org-tgt-1')).toBeVisible();
  });

  test('Step 1: next is disabled until source and target orgs are selected', async ({ page }) => {
    await expect(page.getByTestId('seed-wizard-next')).toBeDisabled();

    // Select source org
    await page.getByTestId('source-org-org-src-1').click();
    await expect(page.getByTestId('seed-wizard-next')).toBeDisabled();

    // Select target org (different from source)
    await page.getByTestId('target-org-org-tgt-1').click();
    await expect(page.getByTestId('seed-wizard-next')).toBeEnabled();
  });

  test('Step 2: displays object list after schema scan', async ({ page }) => {
    // Select orgs and advance
    await page.getByTestId('source-org-org-src-1').click();
    await page.getByTestId('target-org-org-tgt-1').click();
    await page.getByTestId('seed-wizard-next').click();

    // Mock schema scan result
    await bridge.respond('autopilot:schema-result', {
      graph: { objects: MOCK_SCHEMA_OBJECTS },
    });

    await expect(page.getByTestId('step2-objects')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('object-list')).toBeVisible();
  });

  test('Step 2: can select objects and advance', async ({ page }) => {
    await page.getByTestId('source-org-org-src-1').click();
    await page.getByTestId('target-org-org-tgt-1').click();
    await page.getByTestId('seed-wizard-next').click();

    await bridge.respond('autopilot:schema-result', {
      graph: { objects: MOCK_SCHEMA_OBJECTS },
    });

    await page.getByTestId('step2-objects').waitFor({ state: 'visible', timeout: 5000 });

    // Select all objects
    await page.getByTestId('select-all-checkbox').click();
    await expect(page.getByTestId('seed-wizard-next')).toBeEnabled();
  });

  test('Step 3: displays compliance framework options', async ({ page }) => {
    // Navigate to step 3
    await page.getByTestId('source-org-org-src-1').click();
    await page.getByTestId('target-org-org-tgt-1').click();
    await page.getByTestId('seed-wizard-next').click();

    await bridge.respond('autopilot:schema-result', {
      graph: { objects: MOCK_SCHEMA_OBJECTS },
    });

    await page.getByTestId('step2-objects').waitFor({ state: 'visible', timeout: 5000 });
    await page.getByTestId('select-all-checkbox').click();
    await page.getByTestId('seed-wizard-next').click();

    await expect(page.getByTestId('step3-compliance')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('framework-options')).toBeVisible();
  });

  test('Step 4: displays review summary', async ({ page }) => {
    // Navigate through all wizard steps to review
    await page.getByTestId('source-org-org-src-1').click();
    await page.getByTestId('target-org-org-tgt-1').click();
    await page.getByTestId('seed-wizard-next').click();

    await bridge.respond('autopilot:schema-result', {
      graph: { objects: MOCK_SCHEMA_OBJECTS },
    });

    await page.getByTestId('step2-objects').waitFor({ state: 'visible', timeout: 5000 });
    await page.getByTestId('select-all-checkbox').click();
    await page.getByTestId('seed-wizard-next').click();

    await page.getByTestId('step3-compliance').waitFor({ state: 'visible', timeout: 5000 });
    await page.getByTestId('seed-wizard-next').click();

    await expect(page.getByTestId('step4-review')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('execute-button')).toBeVisible();
  });

  test('back button navigates to previous step', async ({ page }) => {
    await page.getByTestId('source-org-org-src-1').click();
    await page.getByTestId('target-org-org-tgt-1').click();
    await page.getByTestId('seed-wizard-next').click();

    await bridge.respond('autopilot:schema-result', {
      graph: { objects: MOCK_SCHEMA_OBJECTS },
    });

    await page.getByTestId('step2-objects').waitFor({ state: 'visible', timeout: 5000 });

    // Go back
    await page.getByTestId('seed-wizard-back').click();
    await expect(page.getByTestId('step1-connect')).toBeVisible({ timeout: 5000 });
  });

  test('execute button disables after click', async ({ page }) => {
    // Navigate to review step
    await page.getByTestId('source-org-org-src-1').click();
    await page.getByTestId('target-org-org-tgt-1').click();
    await page.getByTestId('seed-wizard-next').click();

    await bridge.respond('autopilot:schema-result', {
      graph: { objects: MOCK_SCHEMA_OBJECTS },
    });

    await page.getByTestId('step2-objects').waitFor({ state: 'visible', timeout: 5000 });
    await page.getByTestId('select-all-checkbox').click();
    await page.getByTestId('seed-wizard-next').click();

    await page.getByTestId('step3-compliance').waitFor({ state: 'visible', timeout: 5000 });
    await page.getByTestId('seed-wizard-next').click();

    await page.getByTestId('step4-review').waitFor({ state: 'visible', timeout: 5000 });

    // Click execute
    await page.getByTestId('execute-button').click();

    // Button should be disabled/loading after click
    await expect(page.getByTestId('execute-button')).toBeDisabled();
  });
});

test.describe('Autopilot — Execution UI', () => {
  let bridge: MockBridge;

  test.beforeEach(async ({ page }) => {
    bridge = new MockBridge();
    await setupAutopilotPanel(bridge, page);
  });

  test('displays graph area and control panel during execution', async ({ page }) => {
    await enterExecutionState(page);

    await expect(page.getByTestId('autopilot-graph-area')).toBeVisible();
    await expect(page.getByTestId('control-panel')).toBeVisible();
  });

  test('displays control panel tabs', async ({ page }) => {
    await enterExecutionState(page);

    await expect(page.getByTestId('control-tabs')).toBeVisible();
    await expect(page.getByTestId('control-tab-stats')).toBeVisible();
    await expect(page.getByTestId('control-tab-node')).toBeVisible();
  });

  test('displays action buttons during execution', async ({ page }) => {
    await enterExecutionState(page);

    await expect(page.getByTestId('control-actions')).toBeVisible();
    await expect(page.getByTestId('control-pause-resume')).toBeVisible();
    await expect(page.getByTestId('control-skip')).toBeVisible();
    await expect(page.getByTestId('control-retry')).toBeVisible();
  });

  test('pause toggles execution status', async ({ page }) => {
    await enterExecutionState(page);

    // Click pause
    await page.getByTestId('control-pause-resume').click();

    // Action buttons should still be visible (paused is still "executing")
    await expect(page.getByTestId('control-actions')).toBeVisible();
  });

  test('shows completion state with report button', async ({ page }) => {
    await enterCompletedState(page);

    await expect(page.getByTestId('view-compliance-report')).toBeVisible();
  });

  test('view compliance report navigates to report view', async ({ page }) => {
    await enterCompletedState(page);

    await page.getByTestId('view-compliance-report').click();

    await expect(page.getByTestId('compliance-report')).toBeVisible({ timeout: 5000 });
  });

  test('back from compliance report returns to execution view', async ({ page }) => {
    await enterCompletedState(page);

    await page.getByTestId('view-compliance-report').click();
    await page.getByTestId('compliance-report').waitFor({ state: 'visible', timeout: 5000 });

    await page.getByTestId('back-from-report').click();
    await expect(page.getByTestId('autopilot-page')).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Autopilot — Error Scenarios', () => {
  let bridge: MockBridge;

  test.beforeEach(async ({ page }) => {
    bridge = new MockBridge();
    await setupAutopilotPanel(bridge, page);
    await injectOrgs(bridge);
  });

  test('handles schema scan failure gracefully', async ({ page }) => {
    await page.getByTestId('source-org-org-src-1').click();
    await page.getByTestId('target-org-org-tgt-1').click();
    await page.getByTestId('seed-wizard-next').click();

    // Mock schema scan error
    await bridge.respond('autopilot:schema-result', {
      error: 'Failed to scan schema: INSUFFICIENT_ACCESS',
    });

    // Wizard should still be visible (not crash)
    await expect(page.getByTestId('autopilot-wizard')).toBeVisible({ timeout: 5000 });
  });

  test('wizard remains functional after error', async ({ page }) => {
    await page.getByTestId('source-org-org-src-1').click();
    await page.getByTestId('target-org-org-tgt-1').click();
    await page.getByTestId('seed-wizard-next').click();

    // Mock schema scan error
    await bridge.respond('autopilot:schema-result', {
      error: 'Failed to scan schema',
    });

    // Can still go back
    await page.getByTestId('seed-wizard-back').click();
    await expect(page.getByTestId('step1-connect')).toBeVisible({ timeout: 5000 });
  });

  test('autopilot page remains visible with empty org list', async ({ page }) => {
    // Send empty orgs
    await bridge.respond('org:list:response', { orgs: [] });

    await expect(page.getByTestId('autopilot-page')).toBeVisible();
    await expect(page.getByTestId('autopilot-wizard')).toBeVisible();
  });
});
