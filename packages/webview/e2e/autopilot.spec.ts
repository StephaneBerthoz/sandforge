import { test, expect, type Page } from '@playwright/test';
import { MockBridge } from './helpers';
import { MOCK_ORGS } from './fixtures';
import { sendExtensionMessage } from './mocks/vscode-api';

/**
 * Autopilot E2E.
 *
 * The panel is booted directly (`__SANDFORGE_MODULE__ = 'autopilot'`) because
 * that is how the extension opens it — there has been no in-app navigation
 * sidebar since 1.8.0.
 *
 * The wizard is wired to the real bridge: every step transition is a request
 * the extension has to answer (`autopilot:scan-schema` → `autopilot:schema-result`,
 * `autopilot:generate-plan` → `autopilot:plan-ready`), correlated by message id.
 * Posting a bare response with no correlation — what this file used to do —
 * leaves the mutation in flight forever, which is why every step past the first
 * timed out.
 */

/** Boot the app straight into the Autopilot panel, orgs already connected. */
async function openAutopilot(
  page: Page,
  orgs: readonly unknown[] = MOCK_ORGS,
): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'autopilot';
  });
  await page.goto('/');
  await bridge.seedOrgs(orgs);
  return bridge;
}

/** Every outgoing message of a type, unwrapped from the post envelope. */
async function outgoing(page: Page, type: string): Promise<Record<string, unknown>[]> {
  return page.evaluate((msgType) => {
    const msgs = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
    return msgs
      .map((m) => {
        const e = m as Record<string, unknown>;
        return (e.payload as Record<string, unknown> | undefined) ?? e;
      })
      .filter((m) => m.type === msgType) as Record<string, unknown>[];
  }, type);
}

/**
 * Answer *every* pending request of a type, not just the first.
 *
 * React StrictMode mounts effects twice in dev, so a panel can have two
 * in-flight queries of the same type with different ids; answering only the
 * first leaves the live one hanging. The same applies after a retry, where the
 * failed attempt and the new one are both on record.
 */
async function respondToAll(
  page: Page,
  requestType: string,
  responseType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const requests = await outgoing(page, requestType);

  for (const request of requests) {
    const correlationId = request.id as string;
    await sendExtensionMessage(page, {
      type: responseType,
      id: `resp-${correlationId}`,
      correlationId,
      payload,
    });
  }
}

/** Objects the mocked schema scan discovers. */
const MOCK_SCHEMA_OBJECTS = [
  { apiName: 'Account', recordCount: 500 },
  { apiName: 'Contact', recordCount: 1200 },
  { apiName: 'Opportunity', recordCount: 300 },
];

/**
 * Build an AutopilotGraph as `autopilot:schema-result` carries one.
 *
 * The wizard reads `graph.nodes[].objectApiName` to build both the object list
 * and the initial selection, so a `{ objects: [...] }` stand-in renders an
 * empty step and throws on the selection.
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
      errors: [],
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

/** Execution plan as `autopilot:plan-ready` carries one. */
const MOCK_PLAN = {
  waves: [
    { order: 0, objects: ['Account'], dependsOn: [] },
    { order: 1, objects: ['Contact', 'Opportunity'], dependsOn: [0] },
  ],
  totalRecords: 2000,
  estimatedDurationSec: 180,
  estimatedApiCalls: 20,
  complianceFramework: 'gdpr',
  anonymizationSummary: {
    totalPiiFields: 4,
    totalFieldsToAnonymize: 3,
    methodBreakdown: {},
    objectsWithPii: ['Contact'],
  },
  cycleResolutions: [],
};

/** Compliance report as the handler's `autopilot:compliance-report` carries one. */
const MOCK_COMPLIANCE_REPORT = {
  id: 'report-1',
  framework: 'gdpr',
  generatedAt: '2026-09-01T10:00:00.000Z',
  sourceOrgId: 'org-src-1',
  targetOrgId: 'org-tgt-1',
  totalFieldsScanned: 120,
  piiFieldsDetected: 4,
  piiFieldsAnonymized: 3,
  entries: [
    {
      objectApiName: 'Contact',
      fieldApiName: 'Email',
      piiCategory: 'PII',
      anonymizationMethod: 'hash',
      recordsAnonymized: 1200,
      ruleApplied: 'gdpr-email',
      userOverridden: false,
    },
  ],
  objectSummaries: [],
  overallStatus: 'pass',
  checksumSha256: 'abc123',
};

/** Step 1 → Step 2: pick both orgs, advance, answer the schema scan. */
async function advanceToObjects(page: Page, bridge: MockBridge): Promise<void> {
  await page.getByTestId('source-org-org-src-1').click();
  await page.getByTestId('target-org-org-tgt-1').click();
  await page.getByTestId('seed-wizard-next').click();
  await bridge.waitForMessage('autopilot:scan-schema', { timeout: 10_000 });
  await respondToAll(page, 'autopilot:scan-schema', 'autopilot:schema-result', {
    graph: buildMockGraph(),
  });
  await page.getByTestId('step2-objects').waitFor({ state: 'visible', timeout: 10_000 });
}

/**
 * Step 2 → Step 3.
 *
 * No second scan is needed here: the initial scan already selected every
 * discovered object, and the wizard only re-scans for a narrowed subset.
 */
async function advanceToCompliance(page: Page): Promise<void> {
  await page.getByTestId('seed-wizard-next').click();
  await page.getByTestId('step3-compliance').waitFor({ state: 'visible', timeout: 10_000 });
}

/** Step 3 → Step 4: answer the plan the wizard asks the extension to build. */
async function advanceToReview(page: Page, bridge: MockBridge): Promise<void> {
  await page.getByTestId('seed-wizard-next').click();
  await bridge.waitForMessage('autopilot:generate-plan', { timeout: 10_000 });
  await respondToAll(page, 'autopilot:generate-plan', 'autopilot:plan-ready', {
    plan: MOCK_PLAN,
    graph: buildMockGraph(),
  });
  await page.getByTestId('step4-review').waitFor({ state: 'visible', timeout: 10_000 });
}

/**
 * Drive the store straight to the execution view.
 *
 * The wizard path to it is covered above; these tests are about what the
 * execution view renders, so they set the state the run would have produced.
 */
async function enterExecutionState(page: Page): Promise<void> {
  await page.evaluate((graph) => {
    const store = (window as unknown as Record<string, unknown>).__AUTOPILOT_STORE__ as
      | { setState: (state: Record<string, unknown>) => void }
      | undefined;
    store?.setState({ step: 'executing', executionStatus: 'executing', graph });
  }, buildMockGraph());
  await page.waitForSelector('[data-testid="autopilot-graph-area"]', { timeout: 10_000 });
}

/** Drive the store to the completed state, every node done. */
async function enterCompletedState(page: Page): Promise<void> {
  const graph = buildMockGraph();
  (graph.nodes as Record<string, unknown>[]).forEach((n) => {
    n.status = 'completed';
    n.progress = 100;
    n.successCount = n.recordCount;
  });
  await page.evaluate((g) => {
    const store = (window as unknown as Record<string, unknown>).__AUTOPILOT_STORE__ as
      | { setState: (state: Record<string, unknown>) => void }
      | undefined;
    store?.setState({ step: 'completed', executionStatus: 'completed', graph: g });
  }, graph);
  await page.waitForSelector('[data-testid="view-compliance-report"]', { timeout: 10_000 });
}

test.describe('Autopilot — Wizard Flow', () => {
  let bridge: MockBridge;

  test.beforeEach(async ({ page }) => {
    bridge = await openAutopilot(page);
    await page.waitForSelector('[data-testid="autopilot-page"]', { timeout: 10_000 });
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
    await advanceToObjects(page, bridge);

    await expect(page.getByTestId('step2-objects')).toBeVisible();
    await expect(page.getByTestId('object-list')).toBeVisible();
    for (const obj of MOCK_SCHEMA_OBJECTS) {
      await expect(page.getByTestId(`object-${obj.apiName}`)).toBeVisible();
    }
  });

  test('Step 2: can select objects and advance', async ({ page }) => {
    await advanceToObjects(page, bridge);

    // The scan pre-selects every object it discovered.
    await expect(page.getByTestId('select-all-checkbox')).toBeChecked();

    // Narrowing the selection re-scans on the subset, so the plan is built
    // from the filtered graph rather than the whole org.
    await page.getByTestId('object-Contact').click();
    await expect(page.getByTestId('select-all-checkbox')).not.toBeChecked();
    await expect(page.getByTestId('seed-wizard-next')).toBeEnabled();

    const scansBefore = (await outgoing(page, 'autopilot:scan-schema')).length;
    await page.getByTestId('seed-wizard-next').click();
    await expect
      .poll(async () => (await outgoing(page, 'autopilot:scan-schema')).length, {
        timeout: 10_000,
      })
      .toBeGreaterThan(scansBefore);

    const rescan = (await outgoing(page, 'autopilot:scan-schema')).at(-1);
    const rescanPayload = rescan?.payload as Record<string, unknown>;
    expect(rescanPayload.selectedObjects).toEqual(['Account', 'Opportunity']);

    await respondToAll(page, 'autopilot:scan-schema', 'autopilot:schema-result', {
      graph: buildMockGraph(),
    });
    await expect(page.getByTestId('step3-compliance')).toBeVisible({ timeout: 10_000 });
  });

  test('Step 3: displays compliance framework options', async ({ page }) => {
    await advanceToObjects(page, bridge);
    await advanceToCompliance(page);

    await expect(page.getByTestId('step3-compliance')).toBeVisible();
    await expect(page.getByTestId('framework-options')).toBeVisible();
    await expect(page.getByTestId('framework-gdpr')).toBeVisible();
  });

  test('Step 4: displays review summary', async ({ page }) => {
    await advanceToObjects(page, bridge);
    await advanceToCompliance(page);
    await advanceToReview(page, bridge);

    await expect(page.getByTestId('step4-review')).toBeVisible();
    await expect(page.getByTestId('execute-button')).toBeVisible();

    // The summary shows the generated plan's numbers, not scan fallbacks.
    await expect(page.getByTestId('stat-objects')).toContainText('3');
    await expect(page.getByTestId('stat-records')).toContainText('2,000');
    await expect(page.getByTestId('stat-waves')).toContainText('2');
  });

  test('back button navigates to previous step', async ({ page }) => {
    await advanceToObjects(page, bridge);

    await page.getByTestId('seed-wizard-back').click();
    await expect(page.getByTestId('step1-connect')).toBeVisible({ timeout: 10_000 });
  });

  test('execute starts the run and leaves the wizard for the execution view', async ({ page }) => {
    await advanceToObjects(page, bridge);
    await advanceToCompliance(page);
    await advanceToReview(page, bridge);

    await page.getByTestId('execute-button').click();

    // One execution request goes out, and the button cannot be pressed a
    // second time because the page flips to the execution view.
    await bridge.waitForMessage('autopilot:execute', { timeout: 10_000 });
    await expect(page.getByTestId('autopilot-graph-area')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('execute-button')).toHaveCount(0);
    expect(await outgoing(page, 'autopilot:execute')).toHaveLength(1);
  });
});

test.describe('Autopilot — Execution UI', () => {
  let bridge: MockBridge;

  test.beforeEach(async ({ page }) => {
    bridge = await openAutopilot(page);
    await page.waitForSelector('[data-testid="autopilot-page"]', { timeout: 10_000 });
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

    // Skip acts on the selected node, so it stays dead until one is picked.
    await expect(page.getByTestId('control-skip')).toBeDisabled();
  });

  test('pause toggles execution status', async ({ page }) => {
    await enterExecutionState(page);

    await page.getByTestId('control-pause-resume').click();

    // The pause command reaches the extension and the panel stays usable —
    // paused is still an execution, so the actions remain on screen.
    await bridge.waitForMessage('autopilot:pause', { timeout: 10_000 });
    await expect(page.getByTestId('control-actions')).toBeVisible();
  });

  test('shows completion state with report button', async ({ page }) => {
    await enterCompletedState(page);

    await expect(page.getByTestId('view-compliance-report')).toBeVisible();
  });

  /*
   * KNOWN RED — product defect, not a test defect. Do not "fix" by flattening
   * the payload below.
   *
   * `AutopilotHandler.ts:525` answers this query with
   * `buildResponse(..., 'autopilot:compliance-report', { report })`, but
   * `ComplianceReport.tsx:35` reads it through
   * `useBridgeQuery<ComplianceReport>(...)`, which hands the component
   * `msg.payload` verbatim — the envelope, not the report. So `report.entries`
   * is undefined and the render throws
   * `TypeError: Cannot read properties of undefined (reading 'length')`,
   * caught by the panel's ErrorBoundary: the user clicks "Compliance Report"
   * and gets "Something went wrong".
   *
   * The two tests below send what the extension actually sends, and stay red
   * until one side of that contract is corrected.
   */
  test('view compliance report navigates to report view', async ({ page }) => {
    await enterCompletedState(page);

    await page.getByTestId('view-compliance-report').click();

    // The report body is fetched, not derived from the store.
    await bridge.waitForMessage('autopilot:compliance-report', { timeout: 10_000 });
    await respondToAll(page, 'autopilot:compliance-report', 'autopilot:compliance-report', {
      report: MOCK_COMPLIANCE_REPORT,
    });

    await expect(page.getByTestId('compliance-report')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('report-framework')).toContainText('GDPR');
  });

  /* KNOWN RED — blocked by the same payload-shape defect as the test above. */
  test('back from compliance report returns to execution view', async ({ page }) => {
    await enterCompletedState(page);

    await page.getByTestId('view-compliance-report').click();
    await bridge.waitForMessage('autopilot:compliance-report', { timeout: 10_000 });
    await respondToAll(page, 'autopilot:compliance-report', 'autopilot:compliance-report', {
      report: MOCK_COMPLIANCE_REPORT,
    });
    await page.getByTestId('compliance-report').waitFor({ state: 'visible', timeout: 10_000 });

    await page.getByTestId('back-from-report').click();
    await expect(page.getByTestId('autopilot-graph-area')).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('Autopilot — Error Scenarios', () => {
  test('handles schema scan failure gracefully', async ({ page }) => {
    const bridge = await openAutopilot(page);
    await page.waitForSelector('[data-testid="autopilot-page"]', { timeout: 10_000 });

    await page.getByTestId('source-org-org-src-1').click();
    await page.getByTestId('target-org-org-tgt-1').click();
    await page.getByTestId('seed-wizard-next').click();

    await bridge.waitForMessage('autopilot:scan-schema', { timeout: 10_000 });
    await respondToAll(page, 'autopilot:scan-schema', 'autopilot:error', {
      message: 'Failed to scan schema: INSUFFICIENT_ACCESS',
      code: 'INSUFFICIENT_ACCESS',
      retryable: true,
    });

    // The wizard holds its step and says why, instead of crashing or hanging
    // on the scan.
    await expect(page.getByTestId('autopilot-wizard')).toBeVisible();
    await expect(page.getByTestId('autopilot-scan-error')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('autopilot-scan-error')).toContainText('INSUFFICIENT_ACCESS');
    await expect(page.getByTestId('step1-connect')).toBeVisible();
  });

  test('wizard remains functional after error', async ({ page }) => {
    const bridge = await openAutopilot(page);
    await page.waitForSelector('[data-testid="autopilot-page"]', { timeout: 10_000 });

    await page.getByTestId('source-org-org-src-1').click();
    await page.getByTestId('target-org-org-tgt-1').click();
    await page.getByTestId('seed-wizard-next').click();

    await bridge.waitForMessage('autopilot:scan-schema', { timeout: 10_000 });
    await respondToAll(page, 'autopilot:scan-schema', 'autopilot:error', {
      message: 'Failed to scan schema',
      code: 'UNKNOWN',
      retryable: true,
    });
    await expect(page.getByTestId('autopilot-scan-error')).toBeVisible({ timeout: 10_000 });

    // A failed scan releases the wizard: Next comes back and a second attempt
    // gets through. (Back stays disabled because step 1 is the first step —
    // the failure never moved the user off it.)
    await expect(page.getByTestId('seed-wizard-next')).toBeEnabled();
    await page.getByTestId('seed-wizard-next').click();
    await respondToAll(page, 'autopilot:scan-schema', 'autopilot:schema-result', {
      graph: buildMockGraph(),
    });

    await expect(page.getByTestId('step2-objects')).toBeVisible({ timeout: 10_000 });
  });

  test('empty org list shows the autopilot empty state instead of the wizard', async ({ page }) => {
    await openAutopilot(page, []);

    // With nothing connected there is no page to render: Autopilot short-circuits
    // to its empty state and points the user at org setup.
    await expect(page.getByTestId('empty-state')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('empty-illustration-autopilot')).toBeVisible();
    await expect(page.getByTestId('empty-action-button')).toBeVisible();
    await expect(page.getByTestId('autopilot-wizard')).toHaveCount(0);
  });
});
