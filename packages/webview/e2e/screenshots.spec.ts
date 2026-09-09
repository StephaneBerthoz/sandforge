import { test } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

import { MockBridge } from './helpers';
import { MOCK_ORGS } from './fixtures';
import { sendExtensionMessage } from './mocks/vscode-api';

/**
 * Marketplace screenshot generator.
 *
 * Excluded from the regular E2E suite. Regenerate on demand:
 *
 *   SCREENSHOTS=1 npx playwright test screenshots.spec.ts
 *
 * Output lands in assets/screenshots/ at the repo root, and
 * `scripts/check-screenshots.mjs` fails the release if what ships no longer
 * matches what this file produces.
 *
 * Each shot boots one module panel directly (`__SANDFORGE_MODULE__`) because
 * that is how the extension opens them — there has been no in-app navigation
 * sidebar since 1.10. The previous version of this file clicked through that
 * sidebar, which is why the shipped screenshots showed a UI that no longer
 * exists.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCREENSHOT_DIR = path.resolve(__dirname, '../../../assets/screenshots');
const VIEWPORT = { width: 1280, height: 800 };

/** Boot the app straight into one module panel, orgs already connected. */
async function openModule(
  page: import('@playwright/test').Page,
  moduleId: string,
): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await page.addInitScript((id) => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = id;
  }, moduleId);
  await page.goto('/');
  await bridge.seedOrgs(MOCK_ORGS);
  return bridge;
}

/**
 * Answer *every* pending request of a type, not just the first.
 *
 * React StrictMode mounts effects twice in dev, so a panel can have two
 * in-flight queries of the same type with different ids; answering only the
 * first leaves the live one hanging and the panel stuck on its skeleton.
 */
async function respondToAll(
  page: import('@playwright/test').Page,
  requestType: string,
  responseType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const ids = await page.evaluate((type) => {
    const msgs = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
    return msgs
      .map((m) => {
        const e = m as Record<string, unknown>;
        return (e.payload as Record<string, unknown> | undefined) ?? e;
      })
      .filter((m) => m.type === type)
      .map((m) => m.id as string);
  }, requestType);

  for (const correlationId of ids) {
    await sendExtensionMessage(page, {
      type: responseType,
      id: `resp-${correlationId}`,
      correlationId,
      payload,
    });
  }
}

/**
 * Shrink the viewport to the height the panel actually renders, then shoot.
 *
 * A fixed 1280x800 spent between 10% and 29% of every image on empty
 * background, and the Marketplace scales the whole thing down to fit its
 * carousel — so the padding is paid for twice: once in dead pixels, once in
 * the legibility of what is left.
 *
 * The obvious measurement is wrong. `main.scrollHeight` is clamped to the
 * element's own `clientHeight` when the element is the scroll container, so it
 * answers 800 for content that ends at 570. The panel's first child is not a
 * scroll container and reports its real height.
 *
 * Recharts restarts its 1500 ms entry animation on resize, so the second
 * settle is not belt-and-braces — without it Monitor shoots mid-animation.
 */
async function shoot(page: import('@playwright/test').Page, name: string): Promise<void> {
  const height = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="panel-app"]');
    const content = panel?.firstElementChild as HTMLElement | null | undefined;
    return content ? Math.ceil(content.getBoundingClientRect().height) : 0;
  });

  // Never grow past the design viewport, and keep a floor so a panel that
  // measures oddly still produces a usable image rather than a sliver.
  if (height > 0 && height < VIEWPORT.height) {
    await page.setViewportSize({ width: VIEWPORT.width, height: Math.max(height, 360) });
    await settle(page);
  }

  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png` });
}

/**
 * Let entry animations and layout settle before capturing.
 *
 * Long enough to outlast Recharts' 1500ms default entry animation — a shorter
 * wait catches the donut mid-sweep as a partial off-centre arc.
 */
async function settle(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForTimeout(2500);
}

const MOCK_HEALTH = {
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

const MOCK_BACKUPS = {
  backups: [
    {
      operationId: 'op-2026-08-12-1',
      orgId: 'org-src-1',
      timestamp: '2026-08-12T09:14:00Z',
      totalRecords: 3250,
      totalSize: 4_812_000,
      status: 'completed',
      objectResults: [
        { objectApiName: 'Account', recordCount: 500 },
        { objectApiName: 'Contact', recordCount: 1200 },
        { objectApiName: 'Opportunity', recordCount: 300 },
      ],
    },
    {
      operationId: 'op-2026-08-11-2',
      orgId: 'org-src-1',
      timestamp: '2026-08-11T17:02:00Z',
      totalRecords: 1250,
      totalSize: 1_940_000,
      status: 'completed',
      objectResults: [
        { objectApiName: 'Lead', recordCount: 800 },
        { objectApiName: 'Case', recordCount: 450 },
      ],
    },
  ],
};

const MOCK_STORAGE = {
  success: true,
  totalRecords: 3250,
  objects: [
    { objectName: 'Contact', label: 'Contact', recordCount: 1200 },
    { objectName: 'Lead', label: 'Lead', recordCount: 800 },
    { objectName: 'Account', label: 'Account', recordCount: 500 },
    { objectName: 'Case', label: 'Case', recordCount: 450 },
    { objectName: 'Opportunity', label: 'Opportunity', recordCount: 300 },
  ],
};

/**
 * Saved templates, as `seed:template:list:response` returns them.
 *
 * The gallery merges these with the three pre-built templates the extension
 * ships, so answering `{ templates: [] }` would still fill — but it would
 * picture a product nobody has ever used, and the saved half of the gallery
 * (the half a team actually builds) would never appear in the listing.
 */
const MOCK_SEED_TEMPLATES = {
  templates: [
    {
      id: 'tpl-uat-refresh',
      name: 'UAT refresh set',
      description:
        'Accounts, their contacts and a spread of open opportunities — what the UAT sandbox needs back after every refresh.',
      tags: ['uat', 'shared'],
      updatedAt: '2026-08-28T14:20:00Z',
      objectCount: 4,
      totalRecords: 1450,
    },
    {
      id: 'tpl-support-bench',
      name: 'Support console bench',
      description:
        'Cases across every status with the contacts behind them, so the Service Console has something to open.',
      tags: ['service'],
      updatedAt: '2026-09-02T08:05:00Z',
      objectCount: 3,
      totalRecords: 900,
    },
  ],
};

/**
 * Objects a `seed:describe-global` answers with, dependencies included.
 *
 * A three-entry list would shoot a panel no real org produces: the describe
 * returns every createable object, and the dependency badges — the thing that
 * makes the picker worth looking at — only appear on objects that have one.
 */
const MOCK_SEED_OBJECTS = {
  objects: [
    { apiName: 'Account', label: 'Account', recordCount: 0, dependencies: [] },
    { apiName: 'Contact', label: 'Contact', recordCount: 0, dependencies: ['Account'] },
    { apiName: 'Lead', label: 'Lead', recordCount: 0, dependencies: [] },
    {
      apiName: 'Opportunity',
      label: 'Opportunity',
      recordCount: 0,
      dependencies: ['Account', 'Pricebook2'],
    },
    { apiName: 'Case', label: 'Case', recordCount: 0, dependencies: ['Account', 'Contact'] },
    { apiName: 'Campaign', label: 'Campaign', recordCount: 0, dependencies: [] },
    {
      apiName: 'CampaignMember',
      label: 'Campaign Member',
      recordCount: 0,
      dependencies: ['Campaign', 'Contact', 'Lead'],
    },
    { apiName: 'Product2', label: 'Product', recordCount: 0, dependencies: [] },
    { apiName: 'Pricebook2', label: 'Price Book', recordCount: 0, dependencies: [] },
    {
      apiName: 'PricebookEntry',
      label: 'Price Book Entry',
      recordCount: 0,
      dependencies: ['Pricebook2', 'Product2'],
    },
    { apiName: 'Task', label: 'Task', recordCount: 0, dependencies: ['Account', 'Contact'] },
    { apiName: 'Event', label: 'Event', recordCount: 0, dependencies: ['Account', 'Contact'] },
  ],
};

/**
 * Objects a `sync:describe-global` answers with — API names only, per the
 * contract. Long enough that the "Add Object" picker reads like a real org's
 * describe rather than a fixture with room for three.
 */
const MOCK_SYNC_OBJECTS = {
  objects: [
    'Account',
    'Asset',
    'Campaign',
    'CampaignMember',
    'Case',
    'Contact',
    'Contract',
    'Event',
    'Lead',
    'Opportunity',
    'OpportunityLineItem',
    'Order',
    'Pricebook2',
    'PricebookEntry',
    'Product2',
    'Quote',
    'Task',
  ],
};

test.describe('Marketplace Screenshots', () => {
  test.skip(!process.env.SCREENSHOTS, 'Screenshots are generated on demand (set SCREENSHOTS=1)');

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
  });

  test('home', async ({ page }) => {
    const bridge = await openModule(page, 'home');
    // Home's KPI row no longer fabricates zeros — it reads the same
    // monitor:refresh round trip Monitor does, and renders skeletons until it
    // answers. Leaving it unanswered shoots three blank cards.
    await bridge.waitForMessage('monitor:refresh', { timeout: 10_000 });
    await respondToAll(page, 'monitor:refresh', 'monitor:data', MOCK_HEALTH);
    await page.waitForSelector('[data-testid="home-page"]');
    await page.waitForSelector('[data-testid="forge-hero-card"]');
    await settle(page);
    await shoot(page, 'home');
  });

  test('forge', async ({ page }) => {
    const bridge = await openModule(page, 'forge');
    await page.waitForSelector('[data-testid="forge-page"]');

    // Pick a target org so the CTA is enabled and the estimate panel fills —
    // an unconfigured form with a greyed-out button is a poor first impression.
    await page.getByTestId('forge-target-org').click();
    await page.getByTestId('forge-target-org-option-org-tgt-1').click();

    await page.getByTestId('forge-input-record').fill('001000000000001AAA');
    await page.getByTestId('forge-preview-btn').click();
    // Typing into the input invalidates the in-flight preview and schedules a
    // debounced one; answer after that fires, or the response reads as stale.
    await bridge.waitForMessage('forge:preview', { timeout: 10_000 });
    await page.waitForTimeout(1200);
    await respondToAll(page, 'forge:preview', 'forge:preview:response', {
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
      // Without these three the Estimated Graph card renders two numbers and
      // two dashes — half an empty card, on the flagship module's screenshot.
      // They must agree with each other: the product derives size from the
      // record count with `estimatedRecordCount * 0.001` (ForgeHandler.ts:465),
      // so any pair that does not satisfy it shows the user an arithmetic the
      // product would never produce.
      estimatedRecordCount: 500,
      totalFieldCount: 68,
      estimatedSize: 0.5,
    });

    await page.waitForSelector('[data-testid="forge-record-preview"]');
    await settle(page);
    await shoot(page, 'forge');
  });

  test('monitor', async ({ page }) => {
    const bridge = await openModule(page, 'monitor');
    await bridge.respondToNext('monitor:refresh', 'monitor:data', MOCK_HEALTH);
    // Without this the storage panel stays on its loading skeleton and the
    // shot shows a 200px grey slab in the middle of the dashboard.
    await bridge.waitForMessage('monitor:storage', { timeout: 10_000 });
    await respondToAll(page, 'monitor:storage', 'monitor:storage:response', MOCK_STORAGE);
    await page.waitForSelector('[data-testid="monitor-page"]');
    await page.waitForSelector('[data-testid="storage-donut-chart"]');
    await settle(page);
    await shoot(page, 'monitor');
  });

  test('seed', async ({ page }) => {
    const bridge = await openModule(page, 'seed');
    await page.waitForSelector('[data-testid="seed-page"]');

    // Seed lands on its three-card mode selector; the gallery that carries the
    // product's promise ("fill an empty dev org") is two clicks in, down the
    // AI branch, and nothing fetches until it mounts.
    await page.getByTestId('mode-card-ai').click();
    await page.getByTestId('fork-card-scratch').click();

    // Unanswered, the gallery renders three grey 180px slabs instead of cards.
    await bridge.waitForMessage('seed:template:list', { timeout: 10_000 });
    await respondToAll(
      page,
      'seed:template:list',
      'seed:template:list:response',
      MOCK_SEED_TEMPLATES,
    );

    // The object picker is gated on a chosen org — leaving it unpicked shoots
    // a wizard step holding one empty dropdown.
    await page.getByTestId('org-selector').selectOption('org-tgt-1');
    await bridge.waitForMessage('seed:describe-global', { timeout: 10_000 });
    await respondToAll(
      page,
      'seed:describe-global',
      'seed:describe-global:response',
      MOCK_SEED_OBJECTS,
    );

    await page.waitForSelector('[data-testid="template-card-tpl-uat-refresh"]');
    await page.waitForSelector('[data-testid="obj-Account"]');
    await settle(page);
    await shoot(page, 'seed');
  });

  test('sync', async ({ page }) => {
    const bridge = await openModule(page, 'sync');
    await page.waitForSelector('[data-testid="sync-page"]');

    // Source and target both matter: the object editor is not rendered at all
    // until a source is picked, and the header's org-to-org badge pair — the
    // one image that says "between two orgs" — needs the target too.
    await page.getByLabel('Source', { exact: true }).selectOption('org-src-1');
    await page.getByLabel('Target', { exact: true }).selectOption('org-tgt-1');

    // Without this the editor sits on `sync-objects-skeleton`.
    await bridge.waitForMessage('sync:describe-global', { timeout: 10_000 });
    await respondToAll(
      page,
      'sync:describe-global',
      'sync:describe-global:response',
      MOCK_SYNC_OBJECTS,
    );

    // An answered describe still leaves "No objects configured" on screen —
    // the object set is the user's, not the org's. Configure three.
    for (const objectApiName of ['Account', 'Contact', 'Opportunity']) {
      await page.getByTestId('add-object-row').locator('select').selectOption(objectApiName);
      await page.getByTestId('add-object-btn').click();
    }

    // One filtered row: three rows of untouched defaults photograph as a form
    // nobody filled in, and the WHERE fragment is the field that says the sync
    // moves a slice rather than the whole object. `WHERE` itself is not typed —
    // SyncOpsHandler appends the keyword to the fragment, so a value starting
    // with it would picture SOQL the product never builds. Keep the
    // fragment short and blur it: a filled input that still holds focus shoots
    // with a focus ring and scrolled left, so the first characters are cut and
    // the clause reads as truncated rather than typed.
    const accountWhere = page.getByLabel('WHERE clause — Account');
    await accountWhere.fill("Type = 'Customer'");
    await accountWhere.blur();

    await page.waitForSelector('[data-testid="object-entry-Opportunity"]');
    await settle(page);
    await shoot(page, 'sync');
  });

  test('dataops', async ({ page }) => {
    const bridge = await openModule(page, 'dataops');
    await bridge.waitForMessage('backup:list', { timeout: 10_000 });
    await respondToAll(page, 'backup:list', 'backup:list:result', MOCK_BACKUPS);
    // The tab body renders a skeleton while EITHER query is loading, so the
    // templates query has to be answered even for the Backup tab.
    await bridge.waitForMessage('dataops:anonymization-templates', { timeout: 10_000 });
    await respondToAll(
      page,
      'dataops:anonymization-templates',
      'dataops:anonymization-templates:response',
      { templates: [] },
    );
    await page.waitForSelector('[data-testid="dataops-page"]');
    await settle(page);
    await shoot(page, 'dataops');
  });
});
