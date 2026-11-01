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
 * the extension has to answer (`autopilot:list-objects` → `autopilot:objects-listed`,
 * `autopilot:scan-schema` → `autopilot:schema-result`, `autopilot:generate-plan`
 * → `autopilot:plan-ready`), correlated by message id.
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

/** The same objects, as `autopilot:objects-listed` lists them: no count. */
const MOCK_LISTING = MOCK_SCHEMA_OBJECTS.map(({ apiName }) => ({
  apiName,
  label: apiName,
  custom: false,
}));

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

/** Step 1 → Step 2: pick both orgs, advance, answer the listing of the objects. */
async function advanceToObjects(page: Page, bridge: MockBridge): Promise<void> {
  await page.getByTestId('source-org-org-src-1').click();
  await page.getByTestId('target-org-org-tgt-1').click();
  await page.getByTestId('seed-wizard-next').click();
  await bridge.waitForMessage('autopilot:list-objects', { timeout: 10_000 });
  await respondToAll(page, 'autopilot:list-objects', 'autopilot:objects-listed', {
    objects: MOCK_LISTING,
  });
  await page.getByTestId('step2-objects').waitFor({ state: 'visible', timeout: 10_000 });
}

/**
 * Step 2 → the plan: pick every listed object, advance, answer the scan of the
 * selection, which asks for the plan at once. Nothing is picked for the user,
 * and the scan starts from what was.
 */
async function advanceToPlan(page: Page, bridge: MockBridge): Promise<void> {
  await page.getByTestId('select-all-checkbox').check();
  await page.getByTestId('seed-wizard-next').click();
  await expect
    .poll(async () => (await outgoing(page, 'autopilot:scan-schema')).length, { timeout: 10_000 })
    .toBeGreaterThan(0);
  await respondToAll(page, 'autopilot:scan-schema', 'autopilot:schema-result', {
    graph: buildMockGraph(),
  });
  await bridge.waitForMessage('autopilot:generate-plan', { timeout: 10_000 });
}

/** The plan → Step 3: answer the plan the wizard asked the extension to build. */
async function advanceToReview(page: Page, bridge: MockBridge): Promise<void> {
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
      { setState: (state: Record<string, unknown>) => void } | undefined;
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
      { setState: (state: Record<string, unknown>) => void } | undefined;
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

  test('Step 2: displays object list after the listing, scanning nothing', async ({ page }) => {
    await advanceToObjects(page, bridge);

    await expect(page.getByTestId('step2-objects')).toBeVisible();
    await expect(page.getByTestId('object-list')).toBeVisible();
    for (const obj of MOCK_SCHEMA_OBJECTS) {
      await expect(page.getByTestId(`object-${obj.apiName}`)).toBeVisible();
    }
    expect(await outgoing(page, 'autopilot:scan-schema')).toEqual([]);
  });

  test('Step 2: counts the objects picked, then scans the selection', async ({ page }) => {
    await advanceToObjects(page, bridge);

    // Nothing is picked for the user, and nothing is counted before a pick.
    await expect(page.getByTestId('select-all-checkbox')).not.toBeChecked();
    await expect(page.getByTestId('seed-wizard-next')).toBeDisabled();
    expect(await outgoing(page, 'autopilot:count-objects')).toEqual([]);

    await page.getByTestId('object-Account').click();
    await expect
      .poll(async () => (await outgoing(page, 'autopilot:count-objects')).length, {
        timeout: 10_000,
      })
      .toBeGreaterThan(0);
    const counted = (await outgoing(page, 'autopilot:count-objects')).at(-1);
    expect((counted?.payload as Record<string, unknown>).objectApiNames).toEqual(['Account']);
    await respondToAll(page, 'autopilot:count-objects', 'autopilot:objects-counted', {
      counts: { Account: 500 },
    });
    await expect(page.getByTestId('object-Account')).toContainText('500');

    await page.getByTestId('object-Opportunity').click();
    await expect(page.getByTestId('seed-wizard-next')).toBeEnabled();
    await page.getByTestId('seed-wizard-next').click();
    await expect
      .poll(async () => (await outgoing(page, 'autopilot:scan-schema')).length, {
        timeout: 10_000,
      })
      .toBeGreaterThan(0);

    const scan = (await outgoing(page, 'autopilot:scan-schema')).at(-1);
    const scanPayload = scan?.payload as Record<string, unknown>;
    expect(scanPayload.selectedObjects).toEqual(['Account', 'Opportunity']);

    await respondToAll(page, 'autopilot:scan-schema', 'autopilot:schema-result', {
      graph: buildMockGraph(),
    });
    // No compliance step between the objects and the review: the plan is
    // asked for at once.
    await bridge.waitForMessage('autopilot:generate-plan', { timeout: 10_000 });
  });

  test('Review: neutralizes emails and phone numbers by default, the framework behind Advanced', async ({
    page,
  }) => {
    await advanceToObjects(page, bridge);
    await advanceToPlan(page, bridge);
    await advanceToReview(page, bridge);

    await expect(page.getByTestId('step4-contact-points-toggle')).toBeChecked();
    await expect(page.getByTestId('framework-gdpr')).toBeHidden();
    await page.getByTestId('step4-compliance-advanced').locator('summary').click();
    await page.getByTestId('framework-gdpr').click();
    await expect
      .poll(async () => (await outgoing(page, 'autopilot:generate-plan')).length, {
        timeout: 10_000,
      })
      .toBe(2);
    const replanned = (await outgoing(page, 'autopilot:generate-plan')).at(-1);
    expect((replanned?.payload as Record<string, unknown>).complianceFramework).toBe('gdpr');
  });

  test('Step 4: displays review summary', async ({ page }) => {
    await advanceToObjects(page, bridge);
    await advanceToPlan(page, bridge);
    await advanceToReview(page, bridge);

    await expect(page.getByTestId('step4-review')).toBeVisible();
    await expect(page.getByTestId('execute-button')).toBeVisible();

    // The summary shows the generated plan's numbers, not scan fallbacks.
    await expect(page.getByTestId('stat-objects')).toContainText('3');
    await expect(page.getByTestId('stat-records')).toContainText('2,000');
    await expect(page.getByTestId('stat-waves')).toContainText('2');
  });

  test('Review: names both orgs by alias, type and instance, and the target on the button that copies into it', async ({
    page,
  }) => {
    // The panel named them "Source: org-src-1 → Target: org-tgt-1", the ids
    // the store keys them on, on the one screen where the target is checked.
    await advanceToObjects(page, bridge);
    await advanceToPlan(page, bridge);
    await advanceToReview(page, bridge);

    const orgs = page.getByTestId('step4-orgs');
    await expect(orgs).not.toContainText('org-src-1');
    await expect(orgs).not.toContainText('org-tgt-1');
    const source = page.getByTestId('step4-source-org');
    await expect(source.getByTestId('org-badge-alias')).toHaveText('DevSandbox');
    await expect(source.getByTestId('org-badge-type')).toHaveText('SANDBOX');
    await expect(source.getByTestId('org-badge-url')).toHaveText('dev.salesforce.com');
    await expect(page.getByTestId('step4-target-org').getByTestId('org-badge-alias')).toHaveText(
      'QASandbox',
    );
    await expect(page.getByTestId('execute-button')).toHaveText('Copy into QASandbox');
  });

  test('Review: one Personal data tile follows the framework and the neutralization box together', async ({
    page,
  }) => {
    // "No anonymization" was written under the ticked box that neutralizes
    // every email and phone number.
    await advanceToObjects(page, bridge);
    await advanceToPlan(page, bridge);
    await advanceToReview(page, bridge);

    const tile = page.getByTestId('stat-personal-data');
    await expect(tile).toContainText('Emails and phones neutralized');
    await expect(page.getByTestId('stat-anonymization')).toHaveCount(0);
    await page.getByTestId('step4-contact-points-toggle').uncheck();
    await expect(tile).toContainText('None: copied as in the source');
  });

  test('keeps every word of each step title in the stepper’s narrow column', async ({ page }) => {
    // "Connect Source & T…": the titles were cut, and their descriptions
    // under them, which each step's body says in full.
    const titles = page.getByTestId('seed-step-indicator').locator('button > span:last-child');
    await expect(titles).toHaveCount(3);
    for (const title of await titles.all()) {
      const cut = await title.evaluate((spans) =>
        [...spans.querySelectorAll('span'), spans].some(
          (span) =>
            span.scrollWidth > span.clientWidth ||
            getComputedStyle(span).textOverflow === 'ellipsis',
        ),
      );
      expect(cut).toBe(false);
    }
    await expect(page.getByTestId('seed-step-indicator')).toHaveText(
      '1Connect source and target2Select objects3Review plan',
    );
  });

  test('back button navigates to previous step', async ({ page }) => {
    await advanceToObjects(page, bridge);

    await page.getByTestId('seed-wizard-back').click();
    await expect(page.getByTestId('step1-connect')).toBeVisible({ timeout: 10_000 });
  });

  test('keeps the keyboard on Next while the listing it asked for runs, sends one listing, and takes the keyboard to the step it brings', async ({
    page,
  }) => {
    // Next turned disabled under the Enter that started the scan, and a
    // focused button that turns disabled hands the focus to the page: the
    // keyboard started again from the top of the panel.
    await page.getByTestId('source-org-org-src-1').click();
    await page.getByTestId('target-org-org-tgt-1').click();
    const next = page.getByTestId('seed-wizard-next');

    await next.focus();
    await page.keyboard.press('Enter');
    await bridge.waitForMessage('autopilot:list-objects', { timeout: 10_000 });

    const listing = page.getByTestId('autopilot-scan-loading');
    await expect(listing).toHaveRole('status');
    await expect(listing).toHaveText('Listing the objects...');
    await expect(next).toBeDisabled();
    await expect(next).toBeFocused();
    // Pressed again while the listing runs, Next asks for no second one.
    await page.keyboard.press('Enter');
    expect(await outgoing(page, 'autopilot:list-objects')).toHaveLength(1);
    await respondToAll(page, 'autopilot:list-objects', 'autopilot:objects-listed', {
      objects: MOCK_LISTING,
    });
    await expect(page.getByTestId('step2-objects')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Select objects', exact: true })).toBeFocused();
  });

  test('takes the keyboard to the review once the plan is built, where a second Enter starts nothing', async ({
    page,
  }) => {
    // The review turns Next into Confirm, which starts the run. Left on it, a
    // second Enter pressed while the plan was built started a run nobody had
    // reviewed, as soon as the plan came.
    await advanceToObjects(page, bridge);
    await page.getByTestId('select-all-checkbox').check();
    const next = page.getByTestId('seed-wizard-next');

    await next.focus();
    await page.keyboard.press('Enter');
    await bridge.waitForMessage('autopilot:scan-schema', { timeout: 10_000 });
    await respondToAll(page, 'autopilot:scan-schema', 'autopilot:schema-result', {
      graph: buildMockGraph(),
    });
    await bridge.waitForMessage('autopilot:generate-plan', { timeout: 10_000 });
    const planning = page.getByTestId('autopilot-plan-loading');
    await expect(planning).toHaveRole('status');
    await expect(planning).toHaveText('Generating plan...');
    await expect(next).toBeFocused();
    await page.keyboard.press('Enter');
    expect(await outgoing(page, 'autopilot:generate-plan')).toHaveLength(1);
    await respondToAll(page, 'autopilot:generate-plan', 'autopilot:plan-ready', {
      plan: MOCK_PLAN,
      graph: buildMockGraph(),
    });
    await expect(page.getByTestId('step4-review')).toBeVisible();
    await page.keyboard.press('Enter');

    expect(await outgoing(page, 'autopilot:execute')).toEqual([]);
    await expect(page.getByTestId('autopilot-graph-area')).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Review plan', exact: true })).toBeFocused();
  });

  test('hands the keyboard to the running view’s heading when Execute starts the run', async ({
    page,
  }) => {
    // Execute leaves with the wizard, and the focus it held fell to the page.
    await advanceToObjects(page, bridge);
    await advanceToPlan(page, bridge);
    await advanceToReview(page, bridge);

    await page.getByTestId('execute-button').focus();
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('autopilot-graph-area')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Autopilot', exact: true })).toBeFocused();
    expect(await outgoing(page, 'autopilot:execute')).toHaveLength(1);
  });

  test('takes the keyboard back to the review when the Production Guard refuses the run', async ({
    page,
  }) => {
    // The running view's heading held the keyboard and went with the view:
    // the review came back with the focus on the page, where the keyboard
    // started again from the top of the panel.
    await advanceToObjects(page, bridge);
    await advanceToPlan(page, bridge);
    await advanceToReview(page, bridge);
    await page.getByTestId('execute-button').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Autopilot', exact: true })).toBeFocused();

    await bridge.waitForMessage('autopilot:execute', { timeout: 10_000 });
    await respondToAll(page, 'autopilot:execute', 'autopilot:error', {
      message: 'Operation blocked by Production Guard: production org',
      code: 'EXECUTE_ERROR',
      retryable: false,
    });

    await expect(page.getByTestId('autopilot-execute-error')).toContainText('Production Guard');
    await expect(page.getByRole('group', { name: 'Review plan', exact: true })).toBeFocused();
    expect(await outgoing(page, 'autopilot:execute')).toHaveLength(1);
  });

  test('execute starts the run and leaves the wizard for the execution view', async ({ page }) => {
    await advanceToObjects(page, bridge);
    await advanceToPlan(page, bridge);
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
   * The two tests below send what the extension sends, the report wrapped
   * as `{ report }` (`AutopilotHandler`), which `ComplianceReport` unwraps. Do
   * not flatten the payload: read as the report itself, the envelope once
   * left the page on "Something went wrong".
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

  test('dates each object of the report’s timeline by the host’s message that finished it, listing no object still running', async ({
    page,
  }) => {
    // Every object read the time the report was drawn, the same for all and
    // moving on each redraw, and a node still writing read "Completed".
    await advanceToObjects(page, bridge);
    await advanceToPlan(page, bridge);
    await advanceToReview(page, bridge);
    await page.getByTestId('execute-button').click();
    const execute = await bridge.waitForMessage('autopilot:execute', { timeout: 10_000 });
    const correlationId = execute.id as string;
    const accountDone = Date.UTC(2026, 9, 31, 8, 4, 12);
    const progress = async (objectName: string, status: string, timestamp: number): Promise<void> =>
      sendExtensionMessage(page, {
        type: 'autopilot:node-progress',
        id: `progress-${objectName}-${status}-${timestamp}`,
        correlationId,
        timestamp,
        payload: { nodeId: objectName, objectName, status, wave: 0, recordCount: 0 },
      });
    await progress('Account', 'processing', accountDone - 60_000);
    await progress('Contact', 'processing', accountDone - 60_000);
    await progress('Account', 'completed', accountDone);
    // The run's end settles Account once more, half an hour on.
    await progress('Account', 'completed', accountDone + 1_800_000);
    await page.evaluate(() => {
      const store = (window as unknown as Record<string, unknown>).__AUTOPILOT_STORE__ as
        { setState: (state: Record<string, unknown>) => void } | undefined;
      store?.setState({ step: 'completed', executionStatus: 'completed' });
    });
    await page.getByTestId('view-compliance-report').click();
    await bridge.waitForMessage('autopilot:compliance-report', { timeout: 10_000 });
    await respondToAll(page, 'autopilot:compliance-report', 'autopilot:compliance-report', {
      report: MOCK_COMPLIANCE_REPORT,
    });

    const timeline = page.getByTestId('compliance-timeline');
    await expect(timeline.getByRole('listitem')).toHaveCount(1);
    await expect(page.getByTestId('compliance-timeline-Account').locator('time')).toHaveAttribute(
      'datetime',
      new Date(accountDone).toISOString(),
    );
    await expect(page.getByTestId('compliance-timeline-Contact')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'When each object finished' })).toBeVisible();
  });

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
  test('handles a failed listing of the objects gracefully', async ({ page }) => {
    const bridge = await openAutopilot(page);
    await page.waitForSelector('[data-testid="autopilot-page"]', { timeout: 10_000 });

    await page.getByTestId('source-org-org-src-1').click();
    await page.getByTestId('target-org-org-tgt-1').click();
    await page.getByTestId('seed-wizard-next').click();

    await bridge.waitForMessage('autopilot:list-objects', { timeout: 10_000 });
    await respondToAll(page, 'autopilot:list-objects', 'autopilot:error', {
      message: 'Failed to list the objects: INSUFFICIENT_ACCESS',
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

    await bridge.waitForMessage('autopilot:list-objects', { timeout: 10_000 });
    await respondToAll(page, 'autopilot:list-objects', 'autopilot:error', {
      message: 'Failed to list the objects',
      code: 'UNKNOWN',
      retryable: true,
    });
    await expect(page.getByTestId('autopilot-scan-error')).toBeVisible({ timeout: 10_000 });

    // A failed listing releases the wizard: Next comes back and a second
    // attempt gets through. (Back stays disabled because step 1 is the first
    // step — the failure never moved the user off it.)
    await expect(page.getByTestId('seed-wizard-next')).toBeEnabled();
    await page.getByTestId('seed-wizard-next').click();
    await respondToAll(page, 'autopilot:list-objects', 'autopilot:objects-listed', {
      objects: MOCK_LISTING,
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
