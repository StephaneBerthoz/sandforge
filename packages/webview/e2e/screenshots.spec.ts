import { test } from '@playwright/test';
import { MockBridge } from './helpers';
import { MOCK_ORGS, createOrgListResponse } from './fixtures';
import { sendExtensionMessage } from './mocks/vscode-api';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Marketplace screenshot generator.
 *
 * This spec is excluded from the regular E2E suite by default.
 * Run it on-demand to regenerate screenshots:
 *
 *   SCREENSHOTS=1 npx playwright test screenshots.spec.ts
 *
 * Screenshots are saved to assets/screenshots/ at the project root.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCREENSHOT_DIR = path.resolve(__dirname, '../../../assets/screenshots');
const VIEWPORT = { width: 1280, height: 800 };

/** Mock monitor data for a visually rich dashboard. */
const MOCK_MONITOR_DATA = {
  healthScore: 85,
  healthReport: null,
  jobs: [
    {
      id: 'job-1',
      jobType: 'BulkQuery',
      status: 'InProgress',
      objectType: 'Account',
      createdBy: 'admin@sandbox.com',
      createdDate: '2026-03-13T10:00:00Z',
      totalRecords: 5000,
      processedRecords: 2500,
      failedRecords: 0,
    },
    {
      id: 'job-2',
      jobType: 'BulkUpsert',
      status: 'Completed',
      objectType: 'Contact',
      createdBy: 'admin@sandbox.com',
      createdDate: '2026-03-13T09:00:00Z',
      totalRecords: 1200,
      processedRecords: 1200,
      failedRecords: 3,
    },
    {
      id: 'job-3',
      jobType: 'BulkDelete',
      status: 'InProgress',
      objectType: 'Lead',
      createdBy: 'dev@sandbox.com',
      createdDate: '2026-03-13T11:00:00Z',
      totalRecords: 800,
      processedRecords: 400,
      failedRecords: 0,
    },
  ],
  limits: [
    { name: 'DailyApiRequests', max: 100000, remaining: 45000, usedPercent: 55 },
    { name: 'DataStorageMB', max: 5120, remaining: 3072, usedPercent: 40 },
    { name: 'DailyBulkApiRequests', max: 15000, remaining: 14500, usedPercent: 3.3 },
    { name: 'ConcurrentAsyncGetReportInstances', max: 200, remaining: 195, usedPercent: 2.5 },
    { name: 'DailyStreamingApiEvents', max: 200000, remaining: 180000, usedPercent: 10 },
    { name: 'FileStorageMB', max: 10240, remaining: 8192, usedPercent: 20 },
  ],
  orgInfo: {
    orgId: '00D000000000001',
    name: 'DevSandbox',
    edition: 'Enterprise',
    instanceName: 'CS42',
    apiVersion: '60.0',
    userCount: 25,
    customObjectCount: 45,
    apexClassCount: 120,
    flowCount: 30,
    isHyperforce: false,
  },
  trends: {},
  alerts: [],
  activeAlertsCount: 2,
};

/** Mock schema objects for Autopilot graph. */
const MOCK_SCHEMA_OBJECTS = [
  { apiName: 'Account', label: 'Account', recordCount: 500 },
  { apiName: 'Contact', label: 'Contact', recordCount: 1200 },
  { apiName: 'Opportunity', label: 'Opportunity', recordCount: 300 },
  { apiName: 'Lead', label: 'Lead', recordCount: 800 },
  { apiName: 'Case', label: 'Case', recordCount: 450 },
];

/**
 * Build a mock AutopilotGraph with nodes in various execution states
 * for a visually interesting screenshot.
 */
function buildExecutionGraph(): Record<string, unknown> {
  const statuses = ['completed', 'completed', 'processing', 'pending', 'pending'];
  const progresses = [100, 100, 65, 0, 0];

  return {
    nodes: MOCK_SCHEMA_OBJECTS.map((obj, i) => ({
      objectApiName: obj.apiName,
      recordCount: obj.recordCount,
      estimatedApiCalls: Math.ceil(obj.recordCount / 200),
      piiFields: [],
      anonymizationRules: [],
      status: statuses[i],
      progress: progresses[i],
      insertOrder: i,
      level: i < 2 ? 0 : i < 4 ? 1 : 2,
      successCount: statuses[i] === 'completed' ? obj.recordCount : Math.floor(obj.recordCount * progresses[i] / 100),
      failureCount: 0,
      elapsedMs: statuses[i] === 'completed' ? obj.recordCount * 10 : 0,
      apiCallsUsed: statuses[i] === 'completed' ? Math.ceil(obj.recordCount / 200) : 0,
    })),
    edges: [
      { source: 'Account', target: 'Contact' },
      { source: 'Account', target: 'Opportunity' },
      { source: 'Contact', target: 'Case' },
    ],
    cycles: [],
    stats: {
      totalObjects: MOCK_SCHEMA_OBJECTS.length,
      totalRelationships: 3,
      cycleCount: 0,
      maxDepth: 2,
      totalRecords: 3250,
      totalEstimatedApiCalls: 25,
    },
  };
}

/** Helper: resolve the org:list query that fires on mount. */
async function resolveOrgListLoading(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForTimeout(200);

  const correlationId = await page.evaluate(() => {
    const msgs =
      (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
    const orgListMsg = msgs.find(
      (m) => (m as Record<string, unknown>).type === 'org:list',
    ) as Record<string, unknown> | undefined;
    return orgListMsg?.id as string | undefined;
  });

  await sendExtensionMessage(page, {
    type: 'org:list:response',
    id: `resp-${Date.now()}`,
    correlationId: correlationId ?? 'unknown',
    payload: createOrgListResponse(MOCK_ORGS),
  });
}

test.describe('Marketplace Screenshots', () => {
  // This spec only runs when explicitly requested via SCREENSHOTS=1 env var.
  // It is excluded from regular E2E runs and CI.
  test.skip(!process.env.SCREENSHOTS, 'Screenshots are generated on demand (set SCREENSHOTS=1)');

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
  });

  test('home', async ({ page }) => {
    const bridge = new MockBridge();
    await bridge.setup(page);
    await page.goto('/');
    await page.waitForSelector('[data-testid="home-page"]');
    await resolveOrgListLoading(page);

    // Wait for the dashboard to fully render with cards
    await page.waitForSelector('[data-testid="forge-hero-card"]', { timeout: 5000 });
    await page.waitForSelector('[data-testid="quick-actions-tile"]', { timeout: 5000 });
    await page.waitForSelector('[data-testid="health-tile"]', { timeout: 5000 });

    // Allow animations to settle
    await page.waitForTimeout(500);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/home.png`, fullPage: false });
  });

  test('seed wizard', async ({ page }) => {
    const bridge = new MockBridge();
    await bridge.setup(page);
    await page.goto('/');
    await page.waitForSelector('[data-testid="panel-app"]');
    await resolveOrgListLoading(page);

    // Navigate to Forge/Seed page
    await page.getByTestId('sidebar-forge-hero').click();
    await page.waitForSelector('[data-testid="forge-page"]', { timeout: 5000 });

    // Fill in form to show an active state
    await page.getByTestId('forge-source-org').selectOption('org-src-1');
    await page.getByTestId('forge-target-org').selectOption('org-tgt-1');
    await page.getByTestId('forge-input-record').fill('001000000000001');

    // Request preview to show a record preview
    await page.getByTestId('forge-preview-btn').click();

    // Simulate extension preview response
    await sendExtensionMessage(page, {
      type: 'forge:preview:response',
      id: `resp-${Date.now()}`,
      payload: {
        objectApiName: 'Account',
        objectLabel: 'Account',
        recordId: '001000000000001AAA',
        fields: [
          { name: 'Name', value: 'Acme Corporation' },
          { name: 'Industry', value: 'Technology' },
          { name: 'Type', value: 'Enterprise' },
          { name: 'Website', value: 'https://acme.com' },
          { name: 'Phone', value: '+1 (555) 123-4567' },
        ],
      },
    });

    await page.waitForSelector('[data-testid="forge-record-preview"]', { timeout: 5000 });
    await page.waitForTimeout(500);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/seed.png`, fullPage: false });
  });

  test('sync mapping', async ({ page }) => {
    const bridge = new MockBridge();
    await bridge.setup(page);
    await page.goto('/?panel=sync');
    await page.waitForSelector('[data-testid="panel-app"]');
    await resolveOrgListLoading(page);

    // Sync page with sidebar visible and orgs loaded
    await page.waitForTimeout(500);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/sync.png`, fullPage: false });
  });

  test('monitor dashboard', async ({ page }) => {
    const bridge = new MockBridge();
    await bridge.setup(page);
    await page.goto('/');
    await page.waitForSelector('[data-testid="panel-app"]');
    await resolveOrgListLoading(page);

    // Navigate to Monitor
    await page.getByTestId('sidebar').getByRole('button', { name: 'Monitor', exact: true }).click();
    await page.waitForSelector('[data-testid="monitor-empty"]', { timeout: 5000 });

    // Select an org to enter the dashboard
    await page.getByTestId('empty-org-org-src-1').click();

    // Wait for monitor data request then respond
    await page.waitForTimeout(300);

    const correlationId = await page.evaluate(() => {
      const msgs = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
      const monitorMsg = msgs.find(
        (m) => {
          const msg = m as Record<string, unknown>;
          return typeof msg.type === 'string' && (msg.type as string).startsWith('monitor:');
        },
      ) as Record<string, unknown> | undefined;
      return monitorMsg?.id as string | undefined;
    });

    if (correlationId) {
      await sendExtensionMessage(page, {
        type: 'monitor:health:response',
        id: `resp-${Date.now()}`,
        correlationId,
        payload: MOCK_MONITOR_DATA,
      });
    }

    // Wait for dashboard to render with data
    await page.waitForTimeout(1000);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/monitor.png`, fullPage: false });
  });

  test('autopilot graph', async ({ page }) => {
    const bridge = new MockBridge();
    await bridge.setup(page);
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'autopilot';
    });
    await page.goto('/');
    await page.waitForSelector('[data-testid="autopilot-page"]', { timeout: 10000 });

    // Inject execution state via the Zustand store
    const graph = buildExecutionGraph();
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
    await page.waitForTimeout(500);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/autopilot.png`, fullPage: false });
  });

  test('banner', async ({ page }) => {
    const bridge = new MockBridge();
    await bridge.setup(page);

    // Banner uses wider viewport
    await page.setViewportSize({ width: 1440, height: 480 });
    await page.goto('/');
    await page.waitForSelector('[data-testid="home-page"]');
    await resolveOrgListLoading(page);

    // Wait for the branding elements to render
    await page.waitForSelector('[data-testid="forge-hero-card"]', { timeout: 5000 });
    await page.waitForTimeout(500);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/banner.png`, fullPage: false });
  });
});
