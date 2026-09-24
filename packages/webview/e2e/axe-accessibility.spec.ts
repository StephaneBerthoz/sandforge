import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MockBridge, checkAccessibility, formatViolations } from './helpers';
import { themeContrastShortfalls } from './helpers/theme-contrast';
import { DEV_SANDBOX, MOCK_ORGS, QA_SANDBOX } from './fixtures';
import { VSCODE_DEFAULT_STYLES } from './fixtures/vscode-default-styles';
import { sendExtensionMessage } from './mocks/vscode-api';
import { hostColours, vscodeTheme } from '../src/styles/testing/vscodeThemes';

/**
 * What Chromium paints: the reference evidence for a contrast claim in this
 * package. src/styles/design-system.test.ts models contrast from the source on
 * every commit, which guards the class, style and theme shapes that model
 * follows and proves nothing about the others.
 *
 * Every page scan runs under VS Code's default themes, Light 2026 and Dark 2026,
 * and under Light Modern and Dark Modern, the defaults they replaced, with the
 * colours VS Code actually sends the webview under each: the theme's own values
 * and, for what it leaves unset, the registry defaults (Light Modern does not
 * set disabledForeground, so it gets `#61616180`). The page carries the
 * stylesheet VS Code prepends to every webview (fixtures/vscode-default-styles.ts),
 * whose rules paint whatever the panel's own leave unset. Colour contrast is
 * scanned like every other rule.
 */
const SCANNED_THEMES = ['Light 2026', 'Dark 2026', 'Light Modern', 'Dark Modern'] as const;
type ScannedTheme = (typeof SCANNED_THEMES)[number];

/**
 * The states at the end of this file are rendered on every measured theme held
 * to a contrast bar (src/styles/testing/vscodeThemes.ts): the four above, and
 * Light+, Quiet Light and Dark+. On each, every text axe measures or leaves
 * incomplete (symbols included), every SVG text and every placeholder on screen
 * is held to the bar or to the theme's own contrast for its colour
 * (helpers/theme-contrast.ts), since Light+ and Quiet Light write description
 * text under 4.5:1 on their own surfaces. The full axe scan runs on the four
 * above as well. Two of the states come from Reports components a page scan
 * cannot reach in every state, mounted with data by harness/unwired-reports.html.
 */
const STATE_THEMES = [...SCANNED_THEMES, 'Light+', 'Quiet Light', 'Dark+'] as const;
type StateTheme = (typeof STATE_THEMES)[number];

/**
 * Set the host theme's custom properties on the document before first paint,
 * where VS Code puts them in a real webview, and prepend the default stylesheet
 * VS Code puts at the head of every webview.
 */
async function paintHostTheme(page: Page, theme: StateTheme): Promise<void> {
  // Scans measure what a user reads once the panel is still; with reduced motion
  // the design system ends CSS animations at once instead of mid-fade.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(
    ({ colours, defaultStyles }: { colours: Record<string, string>; defaultStyles: string }) => {
      const paint = (): void => {
        for (const [name, value] of Object.entries(colours)) {
          document.documentElement.style.setProperty(`--vscode-${name}`, value);
        }
      };
      const prependDefaultStyles = (): void => {
        const style = document.createElement('style');
        style.id = '_defaultStyles';
        style.textContent = defaultStyles;
        document.head.prepend(style);
      };
      // An init script can run before the document element exists.
      if (document.documentElement) {
        paint();
      } else {
        document.addEventListener('DOMContentLoaded', paint);
      }
      if (document.head) {
        prependDefaultStyles();
      } else {
        document.addEventListener('DOMContentLoaded', prependDefaultStyles);
      }
    },
    { colours: hostColours(vscodeTheme(theme)), defaultStyles: VSCODE_DEFAULT_STYLES },
  );
}

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
  /** The host theme the panel is painted in. */
  readonly theme: ScannedTheme;
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
  page: Page,
  moduleId: string,
  waitForTestId: string,
  options: ModuleBootOptions,
): Promise<void> {
  await bridge.setup(page);
  await paintHostTheme(page, options.theme);
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

/** The query Forge's AI tab is answered with, and the SOQL run the results flow starts from. */
const FORGE_AI_DRAFT = "SELECT Id, Name, Industry FROM Account WHERE Industry = 'Energy'";

/** A template saved from a run, as `forge:templates:list` answers it. */
const FORGE_SAVED_TEMPLATE = {
  id: 'tpl-energy',
  name: 'Energy accounts',
  description: 'Every energy account, for the QA sandbox',
  config: {
    inputMode: 'soql',
    soqlQuery: FORGE_AI_DRAFT,
    depth: 'full',
    anonymizePII: true,
    skipEmpty: false,
    batchSize: 'auto',
    maxRecordsPerObject: 200,
  },
  targetOrgId: QA_SANDBOX.id,
  anonymization: { presetId: 'preset:gdpr-default', rules: { email: 'hash' } },
  objectCount: 2,
  recordCount: 40,
  createdAt: '2026-09-01T08:00:00.000Z',
  lastUsedAt: '2026-09-01T08:00:00.000Z',
};

/** A one-object graph a Forge discovery answers with, run and done. */
const FORGE_RUN_GRAPH = {
  nodes: [
    {
      objectApiName: 'Account',
      recordCount: 1,
      fieldCount: 50,
      status: 'idle',
      progress: 0,
      included: true,
      piiFields: [],
      anonymizeFields: [],
      level: 0,
      successCount: 0,
      failureCount: 0,
      errors: [],
      createableFieldCount: 40,
      estimatedSizeMB: 0.01,
      estimatedApiCalls: 1,
      batchStrategy: 'auto',
    },
  ],
  edges: [],
  totalRecords: 1,
  estimatedSizeMB: 0.01,
  estimatedDurationSeconds: 1,
};

/** A fake record id: the object's prefix, then a counter. */
const fakeId = (prefix: string, n: number, tail = 'AAA'): string =>
  `${prefix}${String(n).padStart(12, '0')}${tail}`;

/**
 * A past run, as `forge:history:list` answers it, that wrote an account, a case
 * and two contacts to the QA sandbox and linked an account it already held.
 */
const FORGE_REMOVABLE_RUN = {
  forgeId: 'forge-run-removable',
  status: 'partial',
  graph: FORGE_RUN_GRAPH,
  duration: 60_000,
  timestamp: '2026-09-22T09:00:00.000Z',
  idRemapCount: 5,
  createdCount: 4,
  linkedExistingCount: 1,
  idRemapTable: {
    [fakeId('001', 1, 'SRC')]: fakeId('001', 1),
    [fakeId('001', 2, 'SRC')]: fakeId('001', 9),
    [fakeId('500', 1, 'SRC')]: fakeId('500', 1),
    [fakeId('003', 1, 'SRC')]: fakeId('003', 1),
    [fakeId('003', 2, 'SRC')]: fakeId('003', 2),
  },
  idRemapExisting: [fakeId('001', 2, 'SRC')],
  idRemapCreated: [
    { objectApiName: 'Account', sourceIds: [fakeId('001', 1, 'SRC')] },
    { objectApiName: 'Case', sourceIds: [fakeId('500', 1, 'SRC')] },
    { objectApiName: 'Contact', sourceIds: [fakeId('003', 1, 'SRC'), fakeId('003', 2, 'SRC')] },
  ],
  targetOrgId: QA_SANDBOX.id,
  config: {
    inputMode: 'soql',
    soqlQuery: FORGE_AI_DRAFT,
    depth: 'direct',
    anonymizePII: false,
    skipEmpty: false,
    batchSize: 'auto',
  },
};

/**
 * What removing that run's records did, one object of each outcome: a contact
 * deleted, one already gone and one changed since the run, a case the org
 * refused, and the account the kept contact still hangs from.
 */
const FORGE_REMOVAL_RESULT = {
  forgeId: FORGE_REMOVABLE_RUN.forgeId,
  status: 'partial',
  includeChanged: false,
  finishedAt: '2026-09-23T10:00:00.000Z',
  objects: [
    {
      objectApiName: 'Contact',
      planned: 2,
      deleted: 1,
      alreadyGone: 0,
      keptChanged: 1,
      keptDependents: 0,
      refused: 0,
      heldBy: [],
      unchecked: ['ActionableListMember'],
      reasons: [],
    },
    {
      objectApiName: 'Case',
      planned: 1,
      deleted: 0,
      alreadyGone: 0,
      keptChanged: 0,
      keptDependents: 0,
      refused: 1,
      heldBy: [],
      unchecked: [],
      reasons: [
        'DELETE_FAILED: Your attempt to delete this case could not be completed because it is associated with an entitlement.',
      ],
    },
    {
      objectApiName: 'Account',
      planned: 1,
      deleted: 0,
      alreadyGone: 0,
      keptChanged: 0,
      keptDependents: 1,
      refused: 0,
      heldBy: ['Contact'],
      unchecked: ['ActionableListMember'],
      reasons: [],
    },
  ],
};

/**
 * The Frozen page's status once a load into the QA sandbox created an order
 * with its items, a contact and a technical placeholder, and linked the
 * standard price book and a selling model the sandbox already held.
 */
const FROZEN_STATUS_AFTER_LOAD = {
  configured: true,
  sasDir: '/home/dev/.sandforge-sas',
  datasetDir: '/home/dev/.sandforge-sas/dataset',
  salt: { present: true, fingerprint: 'abc123def456' },
  mockDetectionConfigured: true,
  selection: null,
  manifest: null,
  lastLoad: { status: 'completed', orgId: QA_SANDBOX.id, at: '2026-09-24T10:05:00.000Z' },
  lastVerify: null,
  lastLoadRecords: {
    orgId: QA_SANDBOX.id,
    loadedAt: '2026-09-24T10:05:00.000Z',
    created: [
      { objectApiName: 'OrderItem', count: 24 },
      { objectApiName: 'Order', count: 11 },
      { objectApiName: 'Contact', count: 2 },
      { objectApiName: 'Account', count: 1 },
    ],
    linked: 2,
    recorded: true,
  },
};

/** What removing that load's records did: the Forge removal's outcomes, on a load. */
const FROZEN_REMOVAL_RESULT = {
  status: 'partial',
  includeChanged: false,
  finishedAt: '2026-09-24T11:00:00.000Z',
  objects: FORGE_REMOVAL_RESULT.objects,
};

/**
 * A page of the audit trail as `reports:audit` answers it: a partial clone the
 * guard asked about, and a restore the guard refused.
 */
const REPORTS_AUDIT = {
  entries: [
    {
      id: 'audit-forge',
      action: 'forge_execute',
      module: 'forge',
      orgId: '00D000000000001AAA',
      orgAlias: QA_SANDBOX.alias,
      sourceOrgId: '00D000000000002AAA',
      sourceOrgAlias: DEV_SANDBOX.alias,
      operationId: 'op-2',
      outcome: 'partial',
      guard: 'confirmed',
      objects: [
        { objectApiName: 'Account', created: 3, updated: 0, deleted: 0, failed: 1 },
        { objectApiName: 'Contact', created: 0, updated: 0, deleted: 0, failed: 0, upserted: 12 },
      ],
      details: {},
      timestamp: '2026-09-12T10:00:00.000Z',
    },
    {
      id: 'audit-restore',
      action: 'backup_restore',
      module: 'dataops',
      orgId: '00D000000000001AAA',
      orgAlias: QA_SANDBOX.alias,
      operationId: 'op-1',
      outcome: 'stopped',
      guard: 'refused',
      objects: [],
      details: {},
      timestamp: '2026-09-11T10:00:00.000Z',
    },
  ],
  total: 240,
  offset: 0,
  facets: {
    modules: ['dataops', 'forge'],
    orgs: [{ orgId: '00D000000000001AAA', orgAlias: QA_SANDBOX.alias }],
  },
};

/** The lineage of the clone above, and the two runs a graph is kept for. */
const REPORTS_LINEAGE = {
  lineage: {
    operationId: 'op-2',
    generatedAt: '2026-09-12T10:00:00.000Z',
    module: 'forge',
    action: 'forge_execute',
    nodes: [
      { id: 'source', type: 'source', label: DEV_SANDBOX.alias, origin: 'org' },
      { id: 'object:Account', type: 'object', label: 'Account', recordCount: 3 },
      { id: 'object:Contact', type: 'object', label: 'Contact', recordCount: 12 },
      { id: 'target', type: 'destination', label: QA_SANDBOX.alias, origin: 'org' },
    ],
    edges: [
      { sourceId: 'source', targetId: 'object:Account' },
      { sourceId: 'object:Account', targetId: 'target', recordCount: 3 },
      { sourceId: 'source', targetId: 'object:Contact' },
      { sourceId: 'object:Contact', targetId: 'target', recordCount: 12 },
    ],
  },
  runs: [
    {
      operationId: 'op-2',
      generatedAt: '2026-09-12T10:00:00.000Z',
      action: 'forge_execute',
      targetLabel: QA_SANDBOX.alias,
    },
    {
      operationId: 'op-0',
      generatedAt: '2026-09-10T10:00:00.000Z',
      action: 'seed_execute',
      targetLabel: QA_SANDBOX.alias,
    },
  ],
};

/** The Frozen status once a dataset is frozen: what the load tab needs to offer a run. */
const FROZEN_STATUS_WITH_DATASET = {
  configured: true,
  sasDir: '/home/qa/.sandforge-sas',
  datasetDir: '/home/qa/.sandforge-sas/dataset',
  salt: { present: true, fingerprint: 'abc123def456' },
  mockDetectionConfigured: false,
  selection: null,
  manifest: {
    version: '0.1.0',
    status: 'frozen',
    frozenAt: '2026-09-20T10:00:00.000Z',
    source: { orgId: DEV_SANDBOX.id, decisionDate: '2026-09-20T09:00:00.000Z' },
    saltFingerprint: 'abc123def456',
    rulesVersion: '1.0.0',
    volumetry: {
      budgetMax: 2500,
      measured: { Opportunity: 1, FeedItem: 2 },
      measuredAt: '2026-09-20T10:00:00.000Z',
    },
    controls: {
      nonReidentification: {
        passed: true,
        checks: [],
        author: 'qa',
        checkedAt: '2026-09-20T10:00:00.000Z',
      },
      dryRunLoad: null,
      author: 'qa',
      date: '2026-09-20',
    },
  },
  lastLoad: null,
  lastVerify: null,
};

/**
 * A pilot load's report: one object the target takes no insert of, and feed
 * items a dataset extracted before their type was kept could not load.
 */
const FROZEN_LOAD_REPORT_WITH_LEFT_OUT = {
  status: 'completed-with-errors',
  orgId: QA_SANDBOX.id,
  mode: { pilot: true, reload: false },
  startedAt: '2026-09-21T10:00:00.000Z',
  durationMs: 7_000,
  alignment: {
    excludedObjects: [
      {
        objectApiName: 'RevenueTransactionErrorLog',
        reason: 'Not createable in target org: 1 record of the dataset not loaded',
      },
    ],
    removals: [],
    adjustments: [],
    recordTypeIssues: [],
  },
  placeholders: [],
  requiredDefaults: [],
  perObject: [
    {
      objectApiName: 'Opportunity',
      fromFiles: 1,
      inserted: 1,
      reused: 0,
      skippedDuplicates: [],
      failed: [],
    },
  ],
  pass2: { resolved: 0, unresolved: [] },
  personContact: { restored: 0, unresolved: [] },
  statuses: { restored: 0, refused: [] },
  purge: { deleted: {}, deactivated: {}, failures: [] },
  untypedFeedItems: [
    { objectApiName: 'FeedItem', count: 2, note: '2 feed items left out' },
    { objectApiName: 'FeedComment', count: 1, note: '1 left out' },
  ],
  mappingPath: '/home/qa/.sandforge-sas/referenceid-mapping.json',
  contractPath: '/home/qa/.sandforge-sas/counting-contract.json',
};

/**
 * Assert zero axe violations, with a formatted error message on failure.
 */
function expectNoViolations(results: Awaited<ReturnType<typeof checkAccessibility>>): void {
  const violations = results.violations;
  expect(violations.length, formatViolations(violations)).toBe(0);
}

/**
 * How many texts inside `container` axe measured the contrast of.
 *
 * A clean scan proves nothing about a surface axe did not look at: text it
 * cannot see — scrolled away, under an overlay, not rendered yet — lands in
 * `incomplete`, not in `violations`. A scan that opens something new has to
 * show that what it opened was measured.
 */
async function contrastMeasuredIn(
  page: Page,
  results: Awaited<ReturnType<typeof checkAccessibility>>,
  container: string,
): Promise<number> {
  const selectors = results.passes
    .filter((rule) => rule.id === 'color-contrast')
    .flatMap((rule) => rule.nodes)
    .map((node) => node.target[0])
    .map((target) => (typeof target === 'string' ? target : target[target.length - 1]));
  return page.evaluate(
    ({ selectors: all, container: within }) =>
      all.filter((selector) => document.querySelector(selector)?.closest(within) != null).length,
    { selectors, container },
  );
}

/** The `operation:started` the extension broadcasts when an operation begins. */
function started(
  operationId: string,
  module: string,
  description: string,
): { type: string; payload: Record<string, unknown> } {
  return { type: 'operation:started', payload: { operationId, module, description } };
}

/** Boot a module panel under a host theme, without waiting on any page. */
async function openPanel(
  bridge: MockBridge,
  page: Page,
  moduleId: string,
  theme: StateTheme,
): Promise<void> {
  await bridge.setup(page);
  await paintHostTheme(page, theme);
  await page.addInitScript((id: string) => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = id;
  }, moduleId);
  await page.goto('/');
}

/**
 * Answer every pending request of a type. StrictMode mounts each query twice,
 * and only the live request's correlationId reaches the page.
 */
async function answerAll(
  page: Page,
  requestType: string,
  responseType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const requests = await page.evaluate((type) => {
    const posted = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
    return posted
      .map((m) => ((m as Record<string, unknown>).payload ?? m) as Record<string, unknown>)
      .filter((m) => m.type === type)
      .map((m) => String(m.id));
  }, requestType);
  for (const correlationId of requests) {
    await sendExtensionMessage(page, {
      type: responseType,
      id: `resp-${correlationId}`,
      correlationId,
      payload,
    });
  }
}

/** The Frozen page's Load tab, with the last load's records `status` names. */
async function openFrozenLastLoad(
  bridge: MockBridge,
  page: Page,
  theme: ScannedTheme,
  status: Record<string, unknown> = FROZEN_STATUS_AFTER_LOAD,
): Promise<void> {
  await navigateToModule(bridge, page, 'frozen', 'frozen-page', { theme, orgs: true });
  await bridge.waitForMessage('frozen:status', { timeout: 10_000 });
  await answerAll(page, 'frozen:status', 'frozen:status:response', { status });
  await page.getByTestId('page-tab-load').click();
  await page.getByTestId('frozen-removal').waitFor({ timeout: 10_000 });
}

/** An account and its contacts, as a Forge discovery answers with them. */
const FORGE_TWO_NODE_GRAPH = {
  ...FORGE_RUN_GRAPH,
  nodes: [
    FORGE_RUN_GRAPH.nodes[0],
    { ...FORGE_RUN_GRAPH.nodes[0], objectApiName: 'Contact', recordCount: 2, level: 1 },
  ],
  totalRecords: 3,
};

/**
 * Start a Forge run of that graph from the SOQL tab, up to its execution
 * screen, and give back the id of its `forge:execute` request: what the
 * extension correlates the run's progress and its answer to.
 */
async function startForgeRun(bridge: MockBridge, page: Page, theme: ScannedTheme): Promise<string> {
  await navigateToModule(bridge, page, 'forge', 'forge-page', { theme, orgs: true });
  await page.getByTestId('forge-tab-soql').click();
  await page.getByTestId('forge-input-soql').fill(FORGE_AI_DRAFT);
  await page.getByTestId('forge-target-org').click();
  await page.getByTestId(`forge-target-org-option-${QA_SANDBOX.id}`).click();
  await page.getByTestId('forge-discover-btn').click();
  await page.waitForSelector('[data-testid="forge-discovery-loading"]', { timeout: 10_000 });
  await answerAll(page, 'forge:discover', 'forge:discover:response', {
    graph: FORGE_TWO_NODE_GRAPH,
  });
  await page.getByTestId('forge-execute-btn').click();
  await page.getByTestId('execute-button').click();
  await page.waitForSelector('[data-testid="forge-execution"]', { timeout: 10_000 });
  const request = await bridge.waitForMessage('forge:execute', { timeout: 10_000 });
  return String(request.id);
}

/** The extension saying where the run stands on one object. */
async function forgeProgress(
  page: Page,
  request: string,
  objectName: string,
  status: 'done' | 'error',
): Promise<void> {
  await sendExtensionMessage(page, {
    type: 'forge:progress',
    id: `progress-${objectName}`,
    correlationId: request,
    payload: { objectName, status, progress: 100 },
  });
}

/** The Forge page with its recent runs listed: one run whose records can be removed. */
async function openForgeHistory(
  bridge: MockBridge,
  page: Page,
  theme: ScannedTheme,
): Promise<void> {
  await navigateToModule(bridge, page, 'forge', 'forge-page', { theme, orgs: true });
  await bridge.waitForMessage('forge:history:list', { timeout: 10_000 });
  await answerAll(page, 'forge:history:list', 'forge:history:list:response', {
    history: [FORGE_REMOVABLE_RUN],
  });
  await page
    .getByTestId(`forge-history-remove-${FORGE_REMOVABLE_RUN.forgeId}`)
    .waitFor({ timeout: 10_000 });
}

for (const theme of SCANNED_THEMES) {
  test.describe(`axe-core WCAG 2.1 AA — ${theme} — Page Scans`, () => {
    // axe-core analyze can be slow on complex pages with animations
    test.describe.configure({ timeout: 60000 });
    let bridge: MockBridge;

    test.beforeEach(() => {
      bridge = new MockBridge();
    });

    test('Home page', async ({ page }) => {
      await navigateToModule(bridge, page, 'home', 'home-page', { theme });
      const results = await checkAccessibility(page);
      expectNoViolations(results);
    });

    test('Organizations page', async ({ page }) => {
      await navigateToModule(bridge, page, 'orgs', 'org-manager-page', { theme });
      const results = await checkAccessibility(page);
      expectNoViolations(results);
    });

    test('Forge page', async ({ page }) => {
      await navigateToModule(bridge, page, 'forge', 'forge-page', { theme, orgs: true });
      const results = await checkAccessibility(page);
      expectNoViolations(results);
    });

    test('Forge AI tab with no provider set up', async ({ page }) => {
      await navigateToModule(bridge, page, 'forge', 'forge-page', { theme, orgs: true });
      await page.getByTestId('forge-tab-ai').click();
      await page.waitForSelector('[data-testid="forge-ai-not-configured"]', { timeout: 10_000 });
      expectNoViolations(await checkAccessibility(page));
    });

    test('Forge AI tab with a checked draft, an edited one, and a refused one', async ({
      page,
    }) => {
      await navigateToModule(bridge, page, 'forge', 'forge-page', { theme, orgs: true, ai: true });
      await page.getByTestId('forge-tab-ai').click();
      await page.getByTestId('forge-input-ai').fill('Accounts in the energy industry');
      await page.getByTestId('forge-ai-draft-btn').click();
      await bridge.waitForMessage('ai:forge-plan', { timeout: 10_000 });
      await answerAll(page, 'ai:forge-plan', 'ai:forge-plan:response', {
        success: true,
        soql: FORGE_AI_DRAFT,
        explanation: 'Accounts whose industry is Energy',
        rootObject: 'Account',
        rootLabel: 'Account',
        fieldsChecked: 3,
        problems: [],
      });
      await page.waitForSelector('[data-testid="forge-ai-checked"]', { timeout: 10_000 });
      expectNoViolations(await checkAccessibility(page));

      await page.getByTestId('forge-ai-query').fill(`${FORGE_AI_DRAFT} AND Tier__c = 1`);
      await page.waitForSelector('[data-testid="forge-ai-stale"]', { timeout: 10_000 });
      expectNoViolations(await checkAccessibility(page));

      await page.getByTestId('forge-ai-recheck').click();
      await answerAll(page, 'ai:forge-plan', 'ai:forge-plan:response', {
        success: false,
        soql: `${FORGE_AI_DRAFT} AND Tier__c = 1`,
        rootObject: 'Account',
        rootLabel: 'Account',
        fieldsChecked: 4,
        problems: [{ kind: 'field-missing', object: 'Account', field: 'Tier__c' }],
      });
      await page.waitForSelector('[data-testid="forge-ai-problems"]', { timeout: 10_000 });
      expectNoViolations(await checkAccessibility(page));
    });

    test('Forge Template tab with a saved template applied', async ({ page }) => {
      await navigateToModule(bridge, page, 'forge', 'forge-page', { theme, orgs: true });
      await bridge.waitForMessage('forge:templates:list', { timeout: 10_000 });
      await answerAll(page, 'forge:templates:list', 'forge:templates:list:response', {
        templates: [FORGE_SAVED_TEMPLATE],
      });
      await page.getByTestId('forge-tab-template').click();
      await page.getByTestId(`forge-template-apply-${FORGE_SAVED_TEMPLATE.id}`).click();
      await page.waitForSelector('[data-testid="forge-template-applied"]', { timeout: 10_000 });
      expectNoViolations(await checkAccessibility(page));
    });

    test('Forge Template tab saying why imported templates are not listed yet', async ({
      page,
    }) => {
      await navigateToModule(bridge, page, 'forge', 'forge-page', { theme, orgs: true });
      await bridge.waitForMessage('forge:templates:list', { timeout: 10_000 });
      await answerAll(page, 'forge:templates:list', 'forge:templates:list:response', {
        templates: [FORGE_SAVED_TEMPLATE],
        importNotMerged:
          "EROFS: read-only file system, open '/projects/qa/.sandforge/forge-templates.json'",
      });
      await page.getByTestId('forge-tab-template').click();
      await page.waitForSelector('[data-testid="forge-templates-import-not-merged"]', {
        timeout: 10_000,
      });
      expectNoViolations(await checkAccessibility(page));
    });

    test('Forge results saving the run as a template', async ({ page }) => {
      await navigateToModule(bridge, page, 'forge', 'forge-page', { theme, orgs: true });
      await page.getByTestId('forge-tab-soql').click();
      await page.getByTestId('forge-input-soql').fill(FORGE_AI_DRAFT);
      await page.getByTestId('forge-target-org').click();
      await page.getByTestId(`forge-target-org-option-${QA_SANDBOX.id}`).click();
      await page.getByTestId('forge-discover-btn').click();
      await page.waitForSelector('[data-testid="forge-discovery-loading"]', { timeout: 10_000 });
      await answerAll(page, 'forge:discover', 'forge:discover:response', {
        graph: FORGE_RUN_GRAPH,
      });
      await page.getByTestId('forge-execute-btn').click();
      await page.getByTestId('execute-button').click();
      await page.waitForSelector('[data-testid="forge-execution"]', { timeout: 10_000 });
      await answerAll(page, 'forge:execute', 'forge:execute:response', {
        result: {
          forgeId: 'forge-run-1',
          status: 'success',
          graph: FORGE_RUN_GRAPH,
          duration: 2_000,
          timestamp: '2026-09-01T08:00:00.000Z',
          idRemapCount: 1,
          createdCount: 1,
          readByObject: [{ objectApiName: 'Account', read: 1 }],
        },
      });
      await page.waitForSelector('[data-testid="forge-results"]', { timeout: 10_000 });

      await page.getByTestId('forge-save-template').click();
      await page.getByTestId('forge-save-template-submit').click();
      await page.waitForSelector('[data-testid="forge-save-template-name-error"]', {
        timeout: 10_000,
      });
      expectNoViolations(await checkAccessibility(page));

      await page.getByTestId('forge-save-template-name').fill('Energy accounts');
      await page.getByTestId('forge-save-template-submit').click();
      await bridge.waitForMessage('forge:templates:save', { timeout: 10_000 });
      await answerAll(page, 'forge:templates:save', 'forge:templates:save:response', {
        success: true,
      });
      await expect(page.getByTestId('forge-save-template-saved')).toContainText('Energy accounts');
      expectNoViolations(await checkAccessibility(page));
    });

    test('Forge results naming the objects the run could not read', async ({ page }) => {
      await navigateToModule(bridge, page, 'forge', 'forge-page', { theme, orgs: true });
      await page.getByTestId('forge-tab-soql').click();
      await page.getByTestId('forge-input-soql').fill(FORGE_AI_DRAFT);
      await page.getByTestId('forge-target-org').click();
      await page.getByTestId(`forge-target-org-option-${QA_SANDBOX.id}`).click();
      await page.getByTestId('forge-discover-btn').click();
      await page.waitForSelector('[data-testid="forge-discovery-loading"]', { timeout: 10_000 });
      await answerAll(page, 'forge:discover', 'forge:discover:response', {
        graph: FORGE_RUN_GRAPH,
      });
      await page.getByTestId('forge-execute-btn').click();
      await page.getByTestId('execute-button').click();
      await page.waitForSelector('[data-testid="forge-execution"]', { timeout: 10_000 });
      await answerAll(page, 'forge:execute', 'forge:execute:response', {
        result: {
          forgeId: 'forge-run-unread',
          status: 'partial',
          graph: FORGE_RUN_GRAPH,
          duration: 2_000,
          timestamp: '2026-09-01T08:00:00.000Z',
          idRemapCount: 1,
          createdCount: 1,
          readByObject: [{ objectApiName: 'Account', read: 1 }],
          failedReads: ['Contact'],
          errors: [
            {
              objectApiName: 'Contact',
              stage: 'query',
              failedCount: 0,
              attemptedCount: 0,
              samples: [
                {
                  recordSummary: '(stage failed before insert)',
                  messages: ["No such column 'Region__c' on entity 'Contact'."],
                },
              ],
            },
          ],
        },
      });
      await page.waitForSelector('[data-testid="forge-results-read-failed"]', { timeout: 10_000 });
      const results = await checkAccessibility(page);
      expectNoViolations(results);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="forge-results-read-failed"]'),
      ).toBeGreaterThan(0);
    });

    test('Forge results listing an object the run added, and the empty tables in one line', async ({
      page,
    }) => {
      /** A node discovery left out: an empty table, unless it could not count it. */
      const leftOut = (objectApiName: string, errors: string[] = []) => ({
        ...FORGE_RUN_GRAPH.nodes[0],
        objectApiName,
        recordCount: 0,
        status: errors.length > 0 ? 'error' : 'idle',
        included: false,
        errors,
      });
      const graph = {
        ...FORGE_RUN_GRAPH,
        nodes: [
          ...FORGE_RUN_GRAPH.nodes,
          leftOut('Lead'),
          leftOut('Asset'),
          leftOut('EmailStatus', [
            'Record count unavailable: INVALID_TYPE_FOR_OPERATION: entity type EmailStatus does not support query',
          ]),
        ],
      };
      await navigateToModule(bridge, page, 'forge', 'forge-page', { theme, orgs: true });
      await page.getByTestId('forge-tab-soql').click();
      await page.getByTestId('forge-input-soql').fill(FORGE_AI_DRAFT);
      await page.getByTestId('forge-target-org').click();
      await page.getByTestId(`forge-target-org-option-${QA_SANDBOX.id}`).click();
      await page.getByTestId('forge-discover-btn').click();
      await page.waitForSelector('[data-testid="forge-discovery-loading"]', { timeout: 10_000 });
      await answerAll(page, 'forge:discover', 'forge:discover:response', { graph });
      await page.getByTestId('forge-execute-btn').click();
      await page.getByTestId('execute-button').click();
      await page.waitForSelector('[data-testid="forge-execution"]', { timeout: 10_000 });
      await answerAll(page, 'forge:execute', 'forge:execute:response', {
        result: {
          forgeId: 'forge-run-beyond',
          status: 'success',
          graph,
          duration: 2_000,
          timestamp: '2026-09-01T08:00:00.000Z',
          idRemapCount: 3,
          createdCount: 3,
          readByObject: [
            { objectApiName: 'Account', read: 1 },
            { objectApiName: 'ProductSellingModelOption', read: 2 },
          ],
        },
      });
      await page.waitForSelector('[data-testid="forge-results-empty-tables"]', { timeout: 10_000 });
      const table = page.getByTestId('forge-results-table');
      await expect(table).toContainText('ProductSellingModelOption');
      await expect(table).toContainText('Record count unavailable');
      await expect(table).not.toContainText('Lead');
      const results = await checkAccessibility(page);
      expectNoViolations(results);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="forge-results-empty-tables"]'),
      ).toBeGreaterThan(0);
    });

    test('Forge finishing a run after its last object, then the results its later answer carries', async ({
      page,
    }) => {
      const request = await startForgeRun(bridge, page, theme);
      await forgeProgress(page, request, 'Account', 'done');
      await forgeProgress(page, request, 'Contact', 'done');

      // Every object has settled and the run goes on: its statuses, its
      // write dates and its files come after its last object.
      await expect(page.getByTestId('forge-execution-status')).toHaveText('FINISHING...');
      await page.getByTestId('forge-execution-finishing').waitFor({ timeout: 10_000 });
      const finishing = await checkAccessibility(page);
      expectNoViolations(finishing);
      expect(
        await contrastMeasuredIn(page, finishing, '[data-testid="forge-execution-finishing"]'),
      ).toBeGreaterThan(0);

      // A second later: the screen that used to take the answer had left.
      await page.waitForTimeout(1_000);
      await sendExtensionMessage(page, {
        type: 'forge:execute:response',
        id: 'resp-forge-late',
        correlationId: request,
        payload: {
          result: {
            forgeId: 'forge-run-late',
            status: 'success',
            graph: FORGE_TWO_NODE_GRAPH,
            duration: 9_000,
            timestamp: '2026-09-01T08:00:00.000Z',
            idRemapCount: 4,
            createdCount: 4,
            idRemapTable: {
              [fakeId('001', 1, 'SRC')]: fakeId('001', 1),
              [fakeId('003', 1, 'SRC')]: fakeId('003', 1),
              [fakeId('003', 2, 'SRC')]: fakeId('003', 2),
              [fakeId('0jM', 1, 'SRC')]: fakeId('0jM', 1),
            },
            readByObject: [
              { objectApiName: 'Account', read: 1 },
              { objectApiName: 'Contact', read: 2 },
              { objectApiName: 'ProductSellingModelOption', read: 1 },
            ],
          },
          operationId: 'forge-execute-1',
        },
      });

      await page.waitForSelector('[data-testid="forge-results"]', { timeout: 10_000 });
      await expect(page.getByTestId('kpi-value').first()).toHaveText('4');
      await expect(page.getByTestId('forge-results-table')).toContainText(
        'ProductSellingModelOption',
      );
      await expect(page.getByTestId('forge-id-mapping-row')).toHaveCount(4);
      expectNoViolations(await checkAccessibility(page));
    });

    test('Forge results retrying what failed, and the retry they send', async ({ page }) => {
      const request = await startForgeRun(bridge, page, theme);
      await forgeProgress(page, request, 'Account', 'done');
      await forgeProgress(page, request, 'Contact', 'error');
      await sendExtensionMessage(page, {
        type: 'forge:execute:response',
        id: 'resp-forge-partial',
        correlationId: request,
        payload: {
          result: {
            forgeId: 'forge-run-partial',
            status: 'partial',
            graph: FORGE_TWO_NODE_GRAPH,
            duration: 3_000,
            timestamp: '2026-09-01T08:00:00.000Z',
            idRemapCount: 1,
            createdCount: 1,
            idRemapTable: { [fakeId('001', 1, 'SRC')]: fakeId('001', 1) },
            readByObject: [
              { objectApiName: 'Account', read: 1 },
              { objectApiName: 'Contact', read: 2 },
            ],
            errors: [
              {
                objectApiName: 'Contact',
                stage: 'insert',
                failedCount: 2,
                attemptedCount: 2,
                samples: [
                  {
                    recordSummary: 'LastName=Doe',
                    messages: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: Region is required'],
                  },
                ],
              },
            ],
          },
          operationId: 'forge-execute-1',
        },
      });
      await page.getByTestId('forge-retry-failed-hint').waitFor({ timeout: 10_000 });
      const results = await checkAccessibility(page);
      expectNoViolations(results);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="forge-retry-failed-hint"]'),
      ).toBeGreaterThan(0);

      await page.getByTestId('forge-retry-failed').click();

      await page.waitForSelector('[data-testid="forge-execution"]', { timeout: 10_000 });
      const runs = await bridge.getMessages('forge:execute');
      expect(runs).toHaveLength(2);
      const retry = runs[1].payload as {
        retryOf?: string;
        graph: { nodes: Array<{ status: string }> };
      };
      expect(retry.retryOf).toBe('forge-run-partial');
      expect(retry.graph.nodes.map((n) => n.status)).toEqual(['idle', 'idle']);
      await expect(page.getByTestId('forge-execution-status')).toHaveText('FORGING...');
    });

    test('Forge Review copying files while the run anonymizes, then the files it copied', async ({
      page,
    }) => {
      await navigateToModule(bridge, page, 'forge', 'forge-page', { theme, orgs: true });
      await page.getByTestId('forge-tab-soql').click();
      await page.getByTestId('forge-input-soql').fill(FORGE_AI_DRAFT);
      await page.getByTestId('forge-target-org').click();
      await page.getByTestId(`forge-target-org-option-${QA_SANDBOX.id}`).click();
      await page.getByTestId('forge-anonymize-toggle').check({ force: true });
      await page.getByTestId('forge-discover-btn').click();
      await page.waitForSelector('[data-testid="forge-discovery-loading"]', { timeout: 10_000 });
      await answerAll(page, 'forge:discover', 'forge:discover:response', {
        graph: FORGE_RUN_GRAPH,
      });
      await page.getByTestId('forge-execute-btn').click();

      // The copy turned on: the size, and the confirmation that holds Execute.
      // The dependency graph beside it is scanned too: its nodes were buttons
      // holding their own checkbox (nested-interactive) until the card
      // stopped being one.
      const reviewScan = {};
      await page.getByTestId('forge-files-toggle').check();
      await page.waitForSelector('[data-testid="forge-files-as-is"]', { timeout: 10_000 });
      await expect(page.getByTestId('execute-button')).toBeDisabled();
      const asked = await checkAccessibility(page, reviewScan);
      expectNoViolations(asked);
      expect(
        await contrastMeasuredIn(page, asked, '[data-testid="forge-files-as-is"]'),
      ).toBeGreaterThan(0);

      await page.getByTestId('forge-files-as-is-accept').check();
      await expect(page.getByTestId('execute-button')).toBeEnabled();
      const accepted = await checkAccessibility(page, reviewScan);
      expectNoViolations(accepted);
      expect(
        await contrastMeasuredIn(page, accepted, '[data-testid="forge-files-option"]'),
      ).toBeGreaterThan(0);

      // A size the field refuses, then Execute: the run takes the last size
      // the field took, never the 5 that typing 50 went through.
      const size = page.getByTestId('forge-files-max-size');
      await size.fill('20');
      await size.blur();
      await size.fill('');
      await size.pressSequentially('50');
      await expect(size).toHaveAttribute('aria-invalid', 'true');
      expectNoViolations(await checkAccessibility(page, reviewScan));

      await page.getByTestId('execute-button').click();
      await page.waitForSelector('[data-testid="forge-execution"]', { timeout: 10_000 });
      const execute = await bridge.waitForMessage('forge:execute', { timeout: 10_000 });
      expect((execute.payload as Record<string, unknown>).files).toEqual({
        maxFileSizeMB: 20,
        acceptedAsIs: true,
      });
      await answerAll(page, 'forge:execute', 'forge:execute:response', {
        result: {
          forgeId: 'forge-run-files',
          status: 'success',
          graph: FORGE_RUN_GRAPH,
          duration: 3_000,
          timestamp: '2026-09-01T08:00:00.000Z',
          idRemapCount: 3,
          createdCount: 1,
          files: {
            maxFileBytes: 10 * 1_048_576,
            objects: [
              {
                objectApiName: 'ContentDocument',
                planned: 2,
                plannedBytes: 24_000,
                copied: 1,
                failed: 1,
              },
              { objectApiName: 'Attachment', planned: 1, plannedBytes: 512, copied: 1, failed: 0 },
            ],
            links: 1,
            leftOut: [
              {
                objectApiName: 'ContentDocument',
                sourceId: fakeId('069', 1),
                name: 'Site survey.mov',
                bytes: 48 * 1_048_576,
                reason: 'too-large',
              },
            ],
            remainingStorageBytes: 200 * 1_048_576,
          },
          fileContentFieldsLeftOut: [{ objectApiName: 'QuoteDocument', fields: ['Document'] }],
        },
      });
      await page.waitForSelector('[data-testid="forge-results-files"]', { timeout: 10_000 });
      await page.waitForSelector('[data-testid="forge-results-file-content"]', {
        timeout: 10_000,
      });
      const results = await checkAccessibility(page);
      expectNoViolations(results);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="forge-results-file-content"]'),
      ).toBeGreaterThan(0);
    });

    test('Grappe page', async ({ page }) => {
      await navigateToModule(bridge, page, 'grappe', 'grappe-page', { theme });
      const results = await checkAccessibility(page);
      expectNoViolations(results);
    });

    test('Seed page', async ({ page }) => {
      await navigateToModule(bridge, page, 'seed', 'panel-app', { theme });
      await bridge.respond('org:list:response', { orgs: MOCK_ORGS });
      await page.waitForSelector('[data-testid="seed-page"]', { timeout: 5000 }).catch(() => {
        // Page may render EmptyState if orgs not processed yet — still scan
      });
      const results = await checkAccessibility(page);
      expectNoViolations(results);
    });

    test('Seed Clone preview saying what the clone leaves to the platform', async ({ page }) => {
      await navigateToModule(bridge, page, 'seed', 'seed-page', { theme, orgs: true });
      await page.getByTestId('mode-card-clone').click();
      // The first connected org is the target: the other is the source.
      await page.getByTestId('clone-source-select').selectOption(QA_SANDBOX.id);
      await bridge.waitForMessage('seed:clone:describe-source', { timeout: 10_000 });
      await answerAll(page, 'seed:clone:describe-source', 'seed:clone:describe-source:response', {
        objects: [{ apiName: 'FeedItem', label: 'Feed Item', recordCount: -1 }],
      });
      await page.getByTestId('clone-wizard-next').click();
      await page.getByTestId('clone-obj-check-FeedItem').check();
      await page.getByTestId('clone-wizard-next').click();
      await bridge.waitForMessage('seed:clone:preview', { timeout: 10_000 });
      await answerAll(page, 'seed:clone:preview', 'seed:clone:preview:response', {
        objects: [
          {
            objectApiName: 'FeedItem',
            recordCount: 4,
            leftToThePlatform: 40,
            sampleRecords: [{ Type: 'CreateRecordEvent' }, { Type: 'CallLogPost' }],
            relationships: [],
          },
        ],
        insertOrder: ['FeedItem'],
      });
      await page.waitForSelector('[data-testid="clone-preview-left-to-the-platform"]', {
        timeout: 10_000,
      });
      const results = await checkAccessibility(page);
      expectNoViolations(results);
      expect(
        await contrastMeasuredIn(
          page,
          results,
          '[data-testid="clone-preview-left-to-the-platform"]',
        ),
      ).toBeGreaterThan(0);
    });

    test('Sync page', async ({ page }) => {
      await navigateToModule(bridge, page, 'sync', 'panel-app', { theme });
      await bridge.respond('org:list:response', { orgs: MOCK_ORGS });
      await page.waitForSelector('[data-testid="sync-page"]', { timeout: 5000 }).catch(() => {
        // Scan whatever state rendered
      });
      const results = await checkAccessibility(page);
      expectNoViolations(results);
    });

    test('Monitor page', async ({ page }) => {
      // Monitor shows empty state without org selection — scan the empty state
      await navigateToModule(bridge, page, 'monitor', 'panel-app', { theme });
      await page.waitForTimeout(1000);
      const results = await checkAccessibility(page);
      expectNoViolations(results);
    });

    test('Compare page', async ({ page }) => {
      await navigateToModule(bridge, page, 'compare', 'panel-app', { theme });
      await bridge.respond('org:list:response', { orgs: MOCK_ORGS });
      await page.waitForSelector('[data-testid="compare-page"]', { timeout: 5000 }).catch(() => {
        // May show EmptyState if < 2 orgs processed — still scan
      });
      const results = await checkAccessibility(page);
      expectNoViolations(results);
    });

    test('DataOps page', async ({ page }) => {
      await navigateToModule(bridge, page, 'dataops', 'panel-app', { theme });
      await page.waitForSelector('[data-testid="dataops-page"]', { timeout: 5000 }).catch(() => {
        // Scan whatever state rendered
      });
      const results = await checkAccessibility(page);
      expectNoViolations(results);
    });

    test('Automation page', async ({ page }) => {
      await navigateToModule(bridge, page, 'automation', 'panel-app', { theme });
      await bridge.respond('org:list:response', { orgs: MOCK_ORGS });
      await page.waitForSelector('[data-testid="automation-page"]', { timeout: 5000 }).catch(() => {
        // May show EmptyState without orgs — still scan
      });
      const results = await checkAccessibility(page);
      expectNoViolations(results);
    });

    test('Reports page', async ({ page }) => {
      await navigateToModule(bridge, page, 'reports', 'reports-page', { theme });
      const results = await checkAccessibility(page);
      expectNoViolations(results);
    });

    test('Reports audit trail and lineage, with runs recorded', async ({ page }) => {
      await navigateToModule(bridge, page, 'reports', 'reports-page', { theme });
      await answerAll(page, 'reports:audit', 'reports:audit:response', REPORTS_AUDIT);
      await answerAll(page, 'reports:lineage', 'reports:lineage:response', REPORTS_LINEAGE);

      await page.getByRole('tab', { name: 'Audit Trail' }).click();
      await page.waitForSelector('[data-testid="audit-audit-forge"]', { timeout: 10_000 });
      expectNoViolations(await checkAccessibility(page));

      await page.getByRole('tab', { name: 'Data Lineage' }).click();
      await page.waitForSelector('[data-testid="lineage-run"]', { timeout: 10_000 });
      expectNoViolations(await checkAccessibility(page));
    });

    test('Reports audit trail and lineage, before any run is recorded', async ({ page }) => {
      await navigateToModule(bridge, page, 'reports', 'reports-page', { theme });
      await answerAll(page, 'reports:audit', 'reports:audit:response', {
        entries: [],
        total: 0,
        offset: 0,
        facets: { modules: [], orgs: [] },
      });
      await answerAll(page, 'reports:lineage', 'reports:lineage:response', {
        lineage: null,
        runs: [],
      });

      await page.getByRole('tab', { name: 'Audit Trail' }).click();
      await page.waitForSelector('[data-testid="reports-audit-empty"]', { timeout: 10_000 });
      expectNoViolations(await checkAccessibility(page));

      await page.getByRole('tab', { name: 'Data Lineage' }).click();
      await page.waitForSelector('[data-testid="reports-lineage-empty"]', { timeout: 10_000 });
      expectNoViolations(await checkAccessibility(page));
    });

    test('Settings page', async ({ page }) => {
      await navigateToModule(bridge, page, 'settings', 'settings-page', { theme });
      const results = await checkAccessibility(page);
      expectNoViolations(results);
    });

    test('Help page', async ({ page }) => {
      await navigateToModule(bridge, page, 'help', 'help-page', { theme });
      const results = await checkAccessibility(page);
      expectNoViolations(results);
    });

    test('AI page', async ({ page }) => {
      await navigateToModule(bridge, page, 'ai', 'ai-chat-panel', { theme, ai: true });
      const results = await checkAccessibility(page);
      expectNoViolations(results);
    });

    test('Autopilot page', async ({ page }) => {
      await navigateToModule(bridge, page, 'autopilot', 'autopilot-page', { theme, orgs: true });
      const results = await checkAccessibility(page);
      expectNoViolations(results);
    });
  });

  test.describe(`axe-core WCAG 2.1 AA — ${theme} — states with data`, () => {
    test.describe.configure({ timeout: 60000 });
    let bridge: MockBridge;

    test.beforeEach(() => {
      bridge = new MockBridge();
    });

    test('Monitor dashboard with limits, live operations and alert history', async ({ page }) => {
      await openPanel(bridge, page, 'monitor', theme);
      // A scratch org under observation: its type badge writes purple on a purple tint.
      await bridge.seedOrgs([{ ...DEV_SANDBOX, orgType: 'Scratch' }, QA_SANDBOX]);
      await bridge.waitForMessage('monitor:refresh', { timeout: 10_000 });
      await answerAll(page, 'monitor:refresh', 'monitor:data', {
        healthScore: 85,
        healthReport: null,
        jobs: [],
        limits: [
          { name: 'DailyApiRequests', max: 100000, remaining: 45000, usedPercent: 55 },
          { name: 'DataStorageMB', max: 5120, remaining: 3072, usedPercent: 40 },
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
        lastUpdated: '2026-03-13T11:05:00Z',
      });
      await page.getByTestId('monitor-page').waitFor({ state: 'visible', timeout: 10_000 });

      // Acknowledged and resolved entries carry the timestamps written in severity colours.
      await answerAll(page, 'monitor:alerts', 'monitor:alerts:result', {
        alerts: [],
        history: [
          {
            id: 'alert-ack',
            definitionId: 'def-1',
            severity: 'warning',
            status: 'acknowledged',
            message: 'DataStorageMB above 75%',
            currentValue: 78,
            threshold: 75,
            orgId: DEV_SANDBOX.id,
            triggeredAt: '2026-03-13T09:15:00Z',
            acknowledgedAt: '2026-03-13T09:20:00Z',
          },
          {
            id: 'alert-resolved',
            definitionId: 'def-2',
            severity: 'info',
            status: 'resolved',
            message: 'Sandbox refresh completed',
            currentValue: 0,
            threshold: 1,
            orgId: DEV_SANDBOX.id,
            triggeredAt: '2026-03-12T08:00:00Z',
            resolvedAt: '2026-03-12T08:30:00Z',
          },
        ],
      });
      await answerAll(page, 'monitor:live-operations', 'monitor:live-operations:response', {
        operations: [
          {
            operationId: 'op-1',
            module: 'seed',
            description: 'Seed Account',
            status: 'running',
            percentage: 42,
            processedRecords: 420,
            totalRecords: 1000,
            currentStep: 'Inserting',
            startedAt: '2026-03-13T11:00:00Z',
            elapsedMs: 5000,
            recordsPerSecond: 84,
          },
        ],
      });
      await page.getByTestId('live-ops-section').waitFor({ state: 'visible', timeout: 10_000 });
      await page.getByTestId('history-entry-alert-resolved').waitFor({ timeout: 10_000 });
      await page.getByRole('button', { name: 'Governor Limits' }).click();
      await page.getByTestId('limit-DailyApiRequests').waitFor({ timeout: 10_000 });
      await expect(page.getByRole('progressbar', { name: 'DailyApiRequests' })).toBeVisible();
      await expect(page.getByRole('progressbar', { name: 'Seed Account' })).toBeVisible();

      expectNoViolations(await checkAccessibility(page));

      // Opening the limits scrolled the header away, and axe files text it cannot
      // see as unmeasured rather than failing it: bring the org type badge back
      // and make sure it was measured.
      const badge = page.getByText('SCRATCH', { exact: true });
      await badge.scrollIntoViewIfNeeded();
      const header = await checkAccessibility(page);
      expectNoViolations(header);
      const measured = header.passes
        .filter((rule) => rule.id === 'color-contrast')
        .flatMap((rule) => rule.nodes)
        .some((node) => node.html.includes('>SCRATCH<'));
      expect(measured, 'axe did not measure the org type badge').toBe(true);
    });

    test('Monitor Live Operations with every write run, running and ended', async ({ page }) => {
      await openPanel(bridge, page, 'monitor', theme);
      await bridge.seedOrgs([DEV_SANDBOX, QA_SANDBOX]);
      await bridge.waitForMessage('monitor:refresh', { timeout: 10_000 });
      await answerAll(page, 'monitor:refresh', 'monitor:data', {
        healthScore: 85,
        healthReport: null,
        jobs: [],
        limits: [],
        trends: {},
        lastUpdated: '2026-03-13T11:05:00Z',
      });
      await page.getByTestId('monitor-page').waitFor({ state: 'visible', timeout: 10_000 });

      const run = (
        operationId: string,
        module: string,
        status: string,
        extra: Record<string, unknown> = {},
      ): Record<string, unknown> => ({
        operationId,
        module,
        description: `${module} run`,
        status,
        percentage: 60,
        processedRecords: 120,
        totalRecords: 0,
        currentStep: 'Completed Account: 120 succeeded, 0 failed',
        startedAt: '2026-03-13T11:00:00Z',
        elapsedMs: 5000,
        recordsPerSecond: 24,
        ...extra,
      });
      // A Forge clone and a Frozen load running — the load counts phases, not
      // records — and a record clone, a CSV import and a load that ended.
      await answerAll(page, 'monitor:live-operations', 'monitor:live-operations:response', {
        operations: [
          run('op-forge', 'forge', 'running'),
          run('op-frozen-running', 'frozen', 'running', {
            processedRecords: 0,
            recordsPerSecond: 0,
            currentStep: 'Inserting Account',
          }),
          run('op-clone', 'clone', 'completed', { percentage: 100 }),
          run('op-csv', 'csv', 'failed', { error: 'REQUIRED_FIELD_MISSING: Name' }),
          run('op-frozen', 'frozen', 'cancelled', { processedRecords: 0, recordsPerSecond: 0 }),
        ],
      });
      await page.getByTestId('live-op-op-frozen').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('cancel-op-forge')).toBeVisible();
      await expect(page.getByRole('img', { name: 'Cancelled' })).toBeVisible();
      await page.getByTestId('live-op-op-csv').scrollIntoViewIfNeeded();

      const results = await checkAccessibility(page);
      expectNoViolations(results);
      // Text axe cannot see is filed as unmeasured, not failed: the module
      // badges of the new rows must have been measured.
      const measured = results.passes
        .filter((rule) => rule.id === 'color-contrast')
        .flatMap((rule) => rule.nodes)
        .some((node) => node.html.includes('>CSV Import<'));
      expect(measured, 'axe did not measure the badge of the CSV import').toBe(true);
    });

    test('Monitor lists that stop at their bound, and the record counts per object', async ({
      page,
    }) => {
      await openPanel(bridge, page, 'monitor', theme);
      await bridge.seedOrgs([DEV_SANDBOX, QA_SANDBOX]);
      await bridge.waitForMessage('monitor:refresh', { timeout: 10_000 });
      const job = (id: string): Record<string, unknown> => ({
        id,
        jobType: 'Queueable',
        status: 'Completed',
        createdBy: 'Admin',
        createdDate: '2026-03-13T11:00:00Z',
        failedRecords: 0,
      });
      await answerAll(page, 'monitor:refresh', 'monitor:data', {
        healthScore: 85,
        healthReport: null,
        jobs: [job('707000000000001'), job('707000000000002')],
        jobsTruncated: true,
        limits: [{ name: 'DailyApiRequests', max: 100000, remaining: 45000, usedPercent: 55 }],
        orgInfo: {
          orgId: '00D000000000001',
          name: 'DevSandbox',
          type: 'Sandbox',
          edition: 'Enterprise Edition',
          instanceName: 'CS42',
          apiVersion: '68.0',
          userCount: 25,
          customObjectCount: 45,
          apexClassCount: 120,
          flowCount: 30,
          namespacePrefix: 'acme',
          createdDate: '2026-04-24T10:20:51.000Z',
        },
        // Failed Jobs says how many of the latest jobs it was counted among.
        orgHealthStatus: {
          orgId: DEV_SANDBOX.id,
          overall: 'degraded',
          apiLimitsStatus: 'ok',
          storageStatus: 'ok',
          failedJobs: 2,
          failedJobsOutOf: 50,
          recentErrorLogs: 0,
          lastChecked: '2026-03-13T11:05:00Z',
        },
        trends: {},
        lastUpdated: '2026-03-13T11:05:00Z',
      });
      await page.getByTestId('monitor-page').waitFor({ state: 'visible', timeout: 10_000 });

      const panels: Array<[string, string, Record<string, unknown>]> = [
        [
          'monitor:storage',
          'monitor:storage:response',
          {
            success: true,
            totalRecords: 81100,
            objectCount: 216,
            objects: [
              { objectName: 'ObjectPermissions', label: 'Object Permissions', recordCount: 37000 },
              { objectName: 'FieldPermissions', label: 'Field Permissions', recordCount: 36900 },
              { objectName: 'LoginHistory', label: 'Login History', recordCount: 7200 },
            ],
          },
        ],
        [
          'monitor:sessions',
          'monitor:sessions:response',
          {
            success: true,
            activeUserCount: 1,
            truncated: true,
            sessions: [
              {
                sessionId: 'session-1',
                userId: 'user-1',
                username: 'admin@dev.sandbox',
                sessionType: 'UI',
                loginTime: '2026-03-13T10:00:00Z',
                sourceIp: '10.0.0.1',
              },
            ],
          },
        ],
        [
          'monitor:error-logs',
          'monitor:error-logs:response',
          {
            success: true,
            totalCount: 1,
            truncated: true,
            errorsByType: [{ type: 'Failed', count: 1 }],
            errors: [
              {
                id: 'log-1',
                errorType: 'Failed',
                message: 'Api - Failed',
                timestamp: '2026-03-13T10:00:00Z',
              },
            ],
          },
        ],
        [
          'monitor:deployments',
          'monitor:deployments:response',
          {
            success: true,
            truncated: true,
            deployments: [
              {
                id: '0Af000000000001',
                status: 'Succeeded',
                startDate: '2026-03-13T09:00:00Z',
                createdBy: 'Admin',
                componentCount: 12,
                errorCount: 0,
              },
            ],
          },
        ],
        [
          'monitor:apex-insights',
          'monitor:apex-insights:response',
          {
            success: true,
            truncated: true,
            topIssues: [],
            analyses: [
              {
                logId: '07L000000000001',
                totalDuration: 1200,
                soqlQueries: 10,
                dmlStatements: 2,
                heapUsed: 12000,
                cpuTime: 800,
                issues: [],
              },
            ],
          },
        ],
        [
          'monitor:sandbox-refresh',
          'monitor:sandbox-refresh:response',
          {
            success: true,
            supported: true,
            inProgress: false,
            truncated: true,
            refreshes: [
              {
                orgId: DEV_SANDBOX.id,
                sandboxName: 'uat',
                refreshDate: '2026-03-12T08:00:00Z',
                status: 'Completed',
              },
            ],
          },
        ],
      ];
      for (const [request, response, payload] of panels) {
        await bridge.waitForMessage(request, { timeout: 10_000 });
        await answerAll(page, request, response, payload);
      }
      for (const note of [
        'jobs-list-cap',
        'storage-scope',
        'sessions-list-cap',
        'error-logs-list-cap',
        'deployment-list-cap',
        'apex-insights-list-cap',
        'refresh-list-cap',
      ]) {
        await page.getByTestId(note).waitFor({ state: 'visible', timeout: 10_000 });
      }
      await expect(page.getByTestId('org-info-panel')).toContainText('Namespace: acme');
      await expect(page.getByTestId('health-failed-jobs-out-of')).toHaveText(
        'of the 50 latest jobs',
      );

      // The anomaly scan says which sample its findings come from.
      await page.getByTestId('anomaly-scan-btn').click();
      await bridge.waitForMessage('ai:anomaly-scan', { timeout: 10_000 });
      await answerAll(page, 'ai:anomaly-scan', 'ai:anomaly-scan:response', {
        success: true,
        anomalies: [{ field: 'Email', type: 'duplicate', description: 'Twice', severity: 'low' }],
        sample: { read: 200, limit: 200 },
      });
      await expect(
        page.getByTestId('anomaly-scan-results').getByTestId('anomaly-scan-sample'),
      ).toHaveText('Scanned 200 records; a scan reads at most 200.');

      expectNoViolations(await checkAccessibility(page));
    });

    test('Monitor sandbox refresh panel with a refresh SandForge noticed', async ({ page }) => {
      await openPanel(bridge, page, 'monitor', theme);
      await bridge.seedOrgs([DEV_SANDBOX, QA_SANDBOX]);
      await bridge.waitForMessage('monitor:refresh', { timeout: 10_000 });
      await answerAll(page, 'monitor:refresh', 'monitor:data', {
        healthScore: 85,
        healthReport: null,
        jobs: [],
        limits: [],
        trends: {},
        lastUpdated: '2026-03-13T11:05:00Z',
      });
      await page.getByTestId('monitor-page').waitFor({ state: 'visible', timeout: 10_000 });
      await bridge.waitForMessage('monitor:sandbox-refresh', { timeout: 10_000 });
      // A sandbox: no history of its own to list, one refresh it revealed.
      await answerAll(page, 'monitor:sandbox-refresh', 'monitor:sandbox-refresh:response', {
        success: true,
        supported: false,
        refreshes: [],
        inProgress: false,
        detected: [
          {
            detectedAt: '2026-03-13T09:15:00Z',
            evidence: 'connection',
            previousOrganizationId: '00D000000000001',
            organizationId: '00D000000000002',
            previousInstanceName: 'CS42',
            instanceName: 'CS44',
          },
        ],
      });
      const noticed = page.getByTestId('refresh-detected');
      await noticed.waitFor({ state: 'visible', timeout: 10_000 });
      await noticed.scrollIntoViewIfNeeded();

      const results = await checkAccessibility(page);
      expectNoViolations(results);
      const measured = results.passes
        .filter((rule) => rule.id === 'color-contrast')
        .flatMap((rule) => rule.nodes)
        .some((node) => node.html.includes('Was org'));
      expect(measured, 'axe did not measure the noticed refresh').toBe(true);
    });

    test('Automation schedule, sandbox refresh and webhook triggers saying what they will do', async ({
      page,
    }) => {
      await navigateToModule(bridge, page, 'automation', 'automation-page', { theme, orgs: true });
      await page.getByTestId('create-pipeline-btn').click();
      await page.getByRole('tab', { name: 'Triggers' }).click();
      for (const type of ['schedule', 'sandbox_refresh', 'webhook']) {
        await page.getByTestId('trigger-type-select').selectOption(type);
        await page.getByTestId('add-trigger-btn').click();
      }
      await page
        .locator('[data-testid^="trigger-soon-reason-"]')
        .first()
        .waitFor({ state: 'visible', timeout: 5000 });
      // The time zone and sandbox pickers are named, the notes are measured.
      await expect(page.getByLabel('Time zone')).toBeVisible();
      await expect(page.getByLabel('Sandbox')).toBeVisible();

      const results = await checkAccessibility(page);
      expectNoViolations(results);
      const measured = results.passes
        .filter((rule) => rule.id === 'color-contrast')
        .flatMap((rule) => rule.nodes)
        .map((node) => node.html);
      for (const note of ['trigger-unsaved-', 'trigger-soon-reason-']) {
        expect(
          measured.some((html) => html.includes(note)),
          `axe did not measure ${note}`,
        ).toBe(true);
      }
    });

    test('Grappe page while a partitioned run is in progress', async ({ page }) => {
      await openPanel(bridge, page, 'grappe', theme);
      await page.waitForSelector('[data-testid="grappe-page"]', { timeout: 10_000 });
      await bridge.stream([
        {
          type: 'grappe:started',
          payload: { operationId: 'grappe-1', totalPartitions: 2, totalRecords: 2000 },
        },
        {
          type: 'grappe:partitionProgress',
          payload: { grappeId: 'Account-1', percentage: 40, processedRecords: 400 },
        },
      ]);
      await expect(page.getByRole('progressbar', { name: 'Account-1' })).toBeVisible({
        timeout: 10_000,
      });

      expectNoViolations(await checkAccessibility(page));
    });
  });

  test.describe(`axe-core WCAG 2.1 AA — ${theme} — Interactive Flows`, () => {
    test.describe.configure({ timeout: 60000 });
    let bridge: MockBridge;

    test.beforeEach(() => {
      bridge = new MockBridge();
    });

    test('Autopilot wizard step progression', async ({ page }) => {
      await navigateToModule(bridge, page, 'autopilot', 'autopilot-page', { theme, orgs: true });

      // Step 1: Connect — scan
      await page.getByTestId('step1-connect').waitFor({ state: 'visible', timeout: 5000 });
      const step1 = await checkAccessibility(page);
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
      const step2 = await checkAccessibility(page);
      expectNoViolations(step2);

      // Advance to Step 3: Compliance. The scan already selected every
      // discovered object, so the wizard walks straight over — toggling
      // select-all here would *clear* the selection and disable `next`.
      await page.getByTestId('seed-wizard-next').click();
      await page.getByTestId('step3-compliance').waitFor({ state: 'visible', timeout: 5000 });
      const step3 = await checkAccessibility(page);
      expectNoViolations(step3);

      // Advance to Step 4: Review — one more round trip, this one for the plan
      // whose numbers the review step puts on screen.
      await page.getByTestId('seed-wizard-next').click();
      await bridge.respondToNext('autopilot:generate-plan', 'autopilot:plan-ready', {
        plan: MOCK_PLAN,
        graph: MOCK_GRAPH,
      });
      await page.getByTestId('step4-review').waitFor({ state: 'visible', timeout: 5000 });
      const step4 = await checkAccessibility(page);
      expectNoViolations(step4);
    });

    test('AI chat after conversation creation', async ({ page }) => {
      await navigateToModule(bridge, page, 'ai', 'ai-chat-panel', { theme, ai: true });

      // Create a conversation
      await page.getByTestId('new-conversation-btn').click();
      await bridge.respond('ai:conversation:created', {
        conversation: {
          id: 'axe-conv',
          title: 'Axe Test',
          createdAt: new Date().toISOString(),
        },
      });
      await page
        .getByTestId('conversation-item-axe-conv')
        .waitFor({ state: 'visible', timeout: 5000 });

      // Scan with conversation active
      const results = await checkAccessibility(page);
      expectNoViolations(results);
    });

    test('AI chat with assistant response', async ({ page }) => {
      await navigateToModule(bridge, page, 'ai', 'ai-chat-panel', { theme, ai: true });

      await page.getByTestId('new-conversation-btn').click();
      await bridge.respond('ai:conversation:created', {
        conversation: {
          id: 'axe-conv-2',
          title: 'Chat',
          createdAt: new Date().toISOString(),
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
          content:
            'Here is a test response with a code block:\n```sql\nSELECT Id FROM Account\n```',
          timestamp: new Date().toISOString(),
        },
      });
      await page
        .getByTestId('message-bubble-assistant')
        .waitFor({ state: 'visible', timeout: 5000 });

      const results = await checkAccessibility(page);
      expectNoViolations(results);
    });

    test('Welcome overlay open over a page', async ({ page }) => {
      await navigateToModule(bridge, page, 'home', 'home-page', { theme });
      await bridge.stream([{ type: 'onboarding:show', payload: {} }]);

      const dialog = page.getByRole('dialog', { name: 'Welcome wizard' });
      await dialog.getByTestId('welcome-page').waitFor({ state: 'visible', timeout: 5000 });
      // The trap moved focus into the overlay when it opened.
      await expect
        .poll(() => dialog.evaluate((el) => el.contains(document.activeElement)))
        .toBe(true);

      const results = await checkAccessibility(page);
      expectNoViolations(results);
    });

    test("What's New overlay open over a page", async ({ page }) => {
      await navigateToModule(bridge, page, 'home', 'home-page', { theme });
      // The panel opens only for a version that has highlights, and 1.0.0 has them.
      await bridge.stream([{ type: 'whats-new:show', payload: { version: '1.0.0' } }]);

      const dialog = page.getByRole('dialog', { name: "What's new" });
      await dialog.getByTestId('whats-new-page').waitFor({ state: 'visible', timeout: 5000 });
      await expect
        .poll(() => dialog.evaluate((el) => el.contains(document.activeElement)))
        .toBe(true);

      const results = await checkAccessibility(page);
      expectNoViolations(results);
    });

    test('Automation generate dialog open', async ({ page }) => {
      await navigateToModule(bridge, page, 'automation', 'automation-page', { theme, orgs: true });
      await page.getByTestId('generate-pipeline-btn').click();

      const dialog = page.getByRole('dialog', { name: 'Generate with AI' });
      await dialog.waitFor({ state: 'visible', timeout: 5000 });
      await expect(dialog.getByRole('textbox')).toBeFocused();

      const results = await checkAccessibility(page);
      expectNoViolations(results);

      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    });

    test('Automation pipeline that cannot run yet', async ({ page }) => {
      await navigateToModule(bridge, page, 'automation', 'automation-page', { theme, orgs: true });
      await page.getByTestId('create-pipeline-btn').click();
      // A Delay step with no seconds: the notice, the canvas marker and the
      // disabled palette entries are all on screen for the scan.
      await page.getByTestId('palette-delay').click();
      await page.getByTestId('pipeline-blocked').waitFor({ state: 'visible', timeout: 5000 });

      const results = await checkAccessibility(page);
      expectNoViolations(results);
    });

    test('Automation step panel of the steps that run a module', async ({ page }) => {
      await navigateToModule(bridge, page, 'automation', 'automation-page', { theme, orgs: true });
      await page.getByTestId('create-pipeline-btn').click();
      // The org choice, the object list, the checks and the Compare page's own
      // selectors, each in the narrow side panel, for the scan.
      for (const type of ['backup', 'precheck', 'compare']) {
        await page.getByTestId(`palette-${type}`).click();
        await page.locator('[data-testid^="canvas-step-"]').last().click();
        await page.getByTestId('step-type-config').waitFor({ state: 'visible', timeout: 5000 });
        expectNoViolations(await checkAccessibility(page));
      }
    });

    test('Automation pipeline while a run is in progress', async ({ page }) => {
      await navigateToModule(bridge, page, 'automation', 'automation-page', { theme, orgs: true });
      await page.getByTestId('create-pipeline-btn').click();
      await page.getByTestId('palette-delay').click();
      await page.locator('[data-testid^="canvas-step-"]').first().click();
      await page.getByTestId('config-seconds').fill('5');

      // `pipeline:execute` is left unanswered, so the run stays in flight and
      // the canvas shows the execution view for the whole scan.
      await page.getByTestId('run-pipeline-btn').click();
      await bridge.waitForMessage('pipeline:execute');
      await page.getByTestId('execution-view').waitFor({ state: 'visible', timeout: 5000 });

      const results = await checkAccessibility(page);
      expectNoViolations(results);
    });

    test('Compare deployment confirmation open over the Deploy tab', async ({ page }) => {
      await openDeployTab(bridge, page, theme);
      await validateInvoicing(page);
      await bridge.waitForMessage('compare:validate-deployment', { timeout: 10_000 });
      await answerAll(page, 'compare:validate-deployment', 'compare:validate-deployment:response', {
        report: validationReport(),
      });
      await page.getByTestId('deploy-deploy-btn').click();

      const dialog = page.getByRole('dialog', { name: 'Deploy to QASandbox' });
      await dialog.waitFor({ state: 'visible', timeout: 5000 });

      const results = await checkAccessibility(page);
      expectNoViolations(results);
    });

    test('Forge run removal confirmation open over the history', async ({ page }) => {
      await openForgeHistory(bridge, page, theme);
      await page.getByTestId(`forge-history-remove-${FORGE_REMOVABLE_RUN.forgeId}`).click();

      const dialog = page.getByRole('dialog', {
        name: `Remove this run's records from ${QA_SANDBOX.alias}`,
      });
      await dialog.waitFor({ state: 'visible', timeout: 5000 });
      await expect(dialog.getByTestId('forge-removal-plan')).toBeVisible();
      await expect(dialog.getByTestId('forge-removal-linked')).toBeVisible();

      const results = await checkAccessibility(page);
      expectNoViolations(results);
    });

    test('Forge run removal result, per object, with what the org refused', async ({ page }) => {
      await openForgeHistory(bridge, page, theme);
      await page.getByTestId(`forge-history-remove-${FORGE_REMOVABLE_RUN.forgeId}`).click();
      await page.getByTestId('danger-input').fill(QA_SANDBOX.alias);
      await page.getByTestId('danger-confirm-btn').click();
      await bridge.waitForMessage('forge:undo', { timeout: 10_000 });
      await answerAll(page, 'forge:undo', 'forge:undo:response', {
        result: FORGE_REMOVAL_RESULT,
        operationId: 'forge-undo-1',
      });
      await page.getByTestId('forge-removal-result').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('forge-removal-unchecked')).toBeVisible();

      const results = await checkAccessibility(page);
      expectNoViolations(results);
    });

    test('Frozen load removal confirmation open over the last load', async ({ page }) => {
      await openFrozenLastLoad(bridge, page, theme);
      await page.getByTestId('frozen-removal-remove').click();

      const dialog = page.getByRole('dialog', {
        name: `Remove this load's records from ${QA_SANDBOX.alias}`,
      });
      await dialog.waitFor({ state: 'visible', timeout: 5000 });
      await expect(dialog.getByTestId('forge-removal-plan')).toBeVisible();
      await expect(dialog.getByTestId('forge-removal-linked')).toBeVisible();
      await expect(dialog.getByTestId('frozen-removal-include-changed')).toBeVisible();

      const results = await checkAccessibility(page);
      expectNoViolations(results);
    });

    test('Frozen load removal result, per object, with what the org refused', async ({ page }) => {
      await openFrozenLastLoad(bridge, page, theme);
      await page.getByTestId('frozen-removal-remove').click();
      await page.getByTestId('danger-input').fill(QA_SANDBOX.alias);
      await page.getByTestId('danger-confirm-btn').click();
      await bridge.waitForMessage('frozen:remove', { timeout: 10_000 });
      await answerAll(page, 'frozen:remove', 'frozen:remove:response', {
        result: FROZEN_REMOVAL_RESULT,
        operationId: 'frozen-remove-1',
      });
      await page.getByTestId('forge-removal-result').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('forge-removal-result')).toContainText(
        'changed since the load',
      );

      const results = await checkAccessibility(page);
      expectNoViolations(results);
    });

    test('Frozen last load whose records were removed', async ({ page }) => {
      await openFrozenLastLoad(bridge, page, theme, {
        ...FROZEN_STATUS_AFTER_LOAD,
        lastLoadRecords: {
          ...FROZEN_STATUS_AFTER_LOAD.lastLoadRecords,
          created: [],
          removed: {
            removedAt: '2026-09-24T11:00:00.000Z',
            deleted: 36,
            alreadyGone: 1,
            kept: 1,
            refused: 0,
          },
        },
      });
      await expect(page.getByTestId('forge-removal-mark')).toBeVisible();

      expectNoViolations(await checkAccessibility(page));
    });

    test('Frozen last load recorded before loads kept what they created', async ({ page }) => {
      await openFrozenLastLoad(bridge, page, theme, {
        ...FROZEN_STATUS_AFTER_LOAD,
        lastLoadRecords: {
          ...FROZEN_STATUS_AFTER_LOAD.lastLoadRecords,
          created: [],
          linked: 0,
          recorded: false,
        },
      });
      await expect(page.getByTestId('frozen-removal-not-recorded')).toBeVisible();

      expectNoViolations(await checkAccessibility(page));
    });

    test('Frozen load before the last one, offered once the last one was removed', async ({
      page,
    }) => {
      await openFrozenLastLoad(bridge, page, theme, {
        ...FROZEN_STATUS_AFTER_LOAD,
        lastLoadRecords: { ...FROZEN_STATUS_AFTER_LOAD.lastLoadRecords, earlier: true },
      });
      await expect(page.getByTestId('frozen-removal-earlier')).toBeVisible();
      await expect(page.getByTestId('frozen-removal-remove')).toBeVisible();

      expectNoViolations(await checkAccessibility(page));
    });

    test('Forge recent runs with a run that failed and one a cancel stopped, each removable', async ({
      page,
    }) => {
      await navigateToModule(bridge, page, 'forge', 'forge-page', { theme, orgs: true });
      await bridge.waitForMessage('forge:history:list', { timeout: 10_000 });
      await answerAll(page, 'forge:history:list', 'forge:history:list:response', {
        history: [
          { ...FORGE_REMOVABLE_RUN, forgeId: 'forge-run-cancelled', cancelled: true },
          { ...FORGE_REMOVABLE_RUN, forgeId: 'forge-run-failed', status: 'failure' },
        ],
      });
      await page.getByTestId('forge-history-remove-forge-run-failed').waitFor({ timeout: 10_000 });
      const cancelled = page.getByTestId('forge-history-entry-forge-run-cancelled');
      await expect(cancelled).toContainText('Cancelled');
      await cancelled.scrollIntoViewIfNeeded();

      const results = await checkAccessibility(page);
      expectNoViolations(results);
      // Text axe cannot see is filed as unmeasured, not failed: the status
      // a cancelled run reads by must have been measured.
      const measured = results.passes
        .filter((rule) => rule.id === 'color-contrast')
        .flatMap((rule) => rule.nodes)
        .some((node) => node.html.includes('>Cancelled<'));
      expect(measured, 'axe did not measure the status of the cancelled run').toBe(true);
    });

    test('Settings page with tabs', async ({ page }) => {
      await navigateToModule(bridge, page, 'settings', 'settings-page', { theme });

      // Scan initial state
      const initial = await checkAccessibility(page);
      expectNoViolations(initial);
    });

    test('Settings, each tab open', async ({ page }) => {
      // The page scan only ever saw the General tab: the four others were
      // never rendered while axe looked.
      await navigateToModule(bridge, page, 'settings', 'settings-page', { theme });
      for (const tab of ['general', 'ai', 'advanced', 'profiles', 'telemetry']) {
        await page.locator(`#tab-${tab}`).click();
        const panel = page.locator(`#tabpanel-${tab}`);
        await panel.waitFor({ state: 'visible', timeout: 5000 });
        await expect(page.locator(`#tab-${tab}`)).toHaveAttribute('aria-selected', 'true');

        const results = await checkAccessibility(page);
        expectNoViolations(results);
        expect(
          await contrastMeasuredIn(page, results, `#tabpanel-${tab}`),
          `axe measured no text of the ${tab} tab`,
        ).toBeGreaterThan(0);
      }
    });

    test('Command palette open over a page, with results', async ({ page }) => {
      await navigateToModule(bridge, page, 'home', 'home-page', { theme });
      await page.keyboard.press('Control+k');
      const palette = page.getByTestId('command-palette');
      await palette.waitFor({ state: 'visible', timeout: 5000 });
      await page.getByTestId('command-palette-input').pressSequentially('se');
      await page
        .locator('[data-testid^="command-palette-item-"]')
        .first()
        .waitFor({ state: 'visible', timeout: 5000 });

      const results = await checkAccessibility(page);
      expectNoViolations(results);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="command-palette"]'),
        'axe measured no text of the palette',
      ).toBeGreaterThan(1);
    });

    test('Sync schedule builder, in simple and in advanced mode', async ({ page }) => {
      await navigateToModule(bridge, page, 'automation', 'automation-page', { theme, orgs: true });
      await page.getByTestId('page-tab-scheduler').click();
      await bridge.waitForMessage('sync:schedule:list', { timeout: 10_000 });
      await answerAll(page, 'sync:config:list', 'sync:config:list:response', {
        configs: [
          { id: 'cfg-1', name: 'Dev to QA', description: '', updatedAt: '2026-09-01T09:00:00Z' },
        ],
      });
      await answerAll(page, 'sync:schedule:list', 'sync:schedule:list:response', {
        schedules: [
          {
            id: 'nightly',
            name: 'Accounts',
            configId: 'cfg-1',
            cron: '0 2 * * *',
            timezone: 'UTC',
            enabled: true,
            maxRetries: 3,
            notifyOnComplete: false,
            notifyOnFailure: true,
            createdAt: '2026-09-01T00:00:00Z',
            updatedAt: '2026-09-01T00:00:00Z',
            version: 1,
          },
        ],
      });
      await page.getByTestId('new-schedule-btn').click();
      const builder = '[data-testid="cron-schedule-builder"]';
      await page.locator(builder).waitFor({ state: 'visible', timeout: 5000 });

      // Weekly: the day toggles, picked and not, and the preview that names them.
      await page.getByTestId('preset-selector').selectOption('weekly');
      await page.getByTestId('day-btn-WED').click();
      await expect(page.getByTestId('day-btn-WED')).toHaveAttribute('aria-pressed', 'true');
      const simple = await checkAccessibility(page);
      expectNoViolations(simple);
      expect(
        await contrastMeasuredIn(page, simple, builder),
        'axe measured no text of the builder',
      ).toBeGreaterThan(5);
      for (const measured of ['[data-testid="day-btn-MON"]', '[data-testid="day-btn-TUE"]']) {
        expect(await contrastMeasuredIn(page, simple, measured), measured).toBe(1);
      }

      await page.getByTestId('mode-advanced-btn').click();
      await page.getByTestId('advanced-mode-panel').waitFor({ state: 'visible', timeout: 5000 });
      const advanced = await checkAccessibility(page);
      expectNoViolations(advanced);
      expect(
        await contrastMeasuredIn(page, advanced, '[data-testid="advanced-mode-panel"]'),
        'axe measured no text of the cron field or its help',
      ).toBeGreaterThan(0);
    });
  });
}

/**
 * Hold what is painted to the bar: the full axe scan on the scanned themes, and
 * on every state theme the contrast of each text, symbol and placeholder
 * against the bar or the theme's own contrast for its colour.
 */
async function expectReadable(page: Page, theme: StateTheme, include?: string): Promise<void> {
  if ((SCANNED_THEMES as readonly string[]).includes(theme)) {
    expectNoViolations(await checkAccessibility(page));
  }
  const shortfalls = await themeContrastShortfalls(page, vscodeTheme(theme), include);
  expect(shortfalls, shortfalls.join('\n')).toEqual([]);
}

/** Open the Org Manager's JWT form, with its key file hint and placeholders on screen. */
async function openJwtForm(bridge: MockBridge, page: Page, theme: StateTheme): Promise<void> {
  await openPanel(bridge, page, 'orgs', theme);
  await page.getByTestId('org-manager-page').waitFor({ timeout: 10_000 });
  await page.getByTestId('org-auth-jwt').click();
  await page.getByTestId('inline-key-file-input').waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Start a device sign-in in the Org Manager and answer it with a code, the
 * way the host does while it waits for the approval. `org:connect` itself is
 * left unanswered, so the code stays on screen for the scan.
 */
async function openDeviceCode(bridge: MockBridge, page: Page, theme: StateTheme): Promise<void> {
  await openPanel(bridge, page, 'orgs', theme);
  await page.getByTestId('org-manager-page').waitFor({ timeout: 10_000 });
  await page.getByTestId('org-auth-oauth_device').click();
  await page.getByTestId('inline-alias-input').fill('uat');
  await page.getByTestId('inline-client-id-input').fill('3MVG9FakeConsumerKey.ForTests_Only');
  await page.getByTestId('org-inline-connect').click();
  await bridge.respondToNext('org:connect', 'org:device-code', {
    userCode: 'AB12CD34',
    verificationUri: 'https://test.salesforce.com/setup/connect',
    expiresAt: Date.now() + 10 * 60_000,
  });
  await page.getByTestId('org-device-code').waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Open Compare's Deploy tab on a comparison holding a component of each kind
 * the tab lists: one that differs, one only the source holds, one only the
 * target holds, and one it could not read.
 */
async function openDeployTab(bridge: MockBridge, page: Page, theme: StateTheme): Promise<void> {
  await openPanel(bridge, page, 'compare', theme);
  await bridge.seedOrgs(MOCK_ORGS);
  await page.getByTestId('compare-page').waitFor({ timeout: 10_000 });
  await page.getByLabel('Source Org').selectOption(DEV_SANDBOX.id);
  await page.getByLabel('Target Org').selectOption(QA_SANDBOX.id);
  await page.getByTestId('cat-ApexClass').click();
  await page.getByTestId('run-compare-btn').click();
  await bridge.waitForMessage('compare:execute', { timeout: 10_000 });
  await answerAll(page, 'compare:execute', 'compare:execute:response', {
    configId: '4f1a2b3c-0000-4000-8000-000000000004',
    sourceOrgId: DEV_SANDBOX.id,
    targetOrgId: QA_SANDBOX.id,
    mode: 'metadata',
    summary: {
      totalItems: 4,
      added: 1,
      removed: 1,
      modified: 1,
      unchanged: 0,
      notCompared: 1,
      byType: {},
    },
    content: {
      compared: 1,
      notCompared: { unreadable: 1, read_failed: 0, over_budget: 0 },
      budget: { components: 500, seconds: 90 },
    },
    diffs: [
      {
        componentType: 'ApexClass',
        fullName: 'Invoicing',
        status: 'modified',
        severity: 'breaking',
        deployable: true,
      },
      {
        componentType: 'ApexClass',
        fullName: 'Billing',
        status: 'removed',
        severity: 'info',
        deployable: true,
      },
      {
        componentType: 'ApexClass',
        fullName: 'Legacy',
        status: 'added',
        severity: 'breaking',
        deployable: true,
      },
      {
        componentType: 'ApexClass',
        fullName: 'pkg__Engine',
        status: 'not_compared',
        notComparedReason: 'unreadable',
        severity: 'info',
        deployable: false,
        managed: true,
      },
    ],
    timestamp: '2026-09-10T09:00:00.000Z',
    duration: 1200,
  });
  await page.getByTestId('page-tab-deploy').click();
  await page.getByTestId('compare-deploy').waitFor({ timeout: 10_000 });
}

/** A validation report, as the extension answers `compare:validate-deployment`. */
function validationReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deployId: '0Af000000000001',
    checkOnly: true,
    status: 'Succeeded',
    success: true,
    sourceOrgId: DEV_SANDBOX.id,
    targetOrgId: QA_SANDBOX.id,
    testLevel: 'RunSpecifiedTests',
    runTests: ['InvoicingTest'],
    components: [{ componentType: 'ApexClass', fullName: 'Invoicing', outcome: 'changed' }],
    counts: {
      componentsTotal: 1,
      componentsDeployed: 1,
      componentErrors: 0,
      testsTotal: 1,
      testsCompleted: 1,
      testErrors: 0,
    },
    testFailures: [],
    coverageWarnings: [],
    ...overrides,
  };
}

/** Pick one class, name its test, and send the validation. */
async function validateInvoicing(page: Page): Promise<void> {
  await page.getByTestId('deploy-pick-ApexClass:Invoicing').check();
  await page.getByTestId('deploy-test-level-RunSpecifiedTests').check();
  await page.getByTestId('deploy-test-names').fill('InvoicingTest');
  await page.getByTestId('deploy-validate-btn').click();
}

/** Open the CSV import with a target org picked, so the drop zone takes files. */
async function openCsvImport(bridge: MockBridge, page: Page, theme: StateTheme): Promise<void> {
  await openPanel(bridge, page, 'seed', theme);
  await bridge.seedOrgs(MOCK_ORGS);
  await page.getByTestId('mode-card-csv').click();
  await page.getByTestId('csv-org-selector').selectOption(QA_SANDBOX.id);
  await bridge.waitForMessage('seed:describe-global', { timeout: 10_000 });
  await answerAll(page, 'seed:describe-global', 'seed:describe-global:response', {
    objects: [{ apiName: 'Account', label: 'Account' }],
  });
  await expect(page.getByTestId('browse-button')).toBeEnabled({ timeout: 10_000 });
}

/** Describes of the two objects the Seed relation state seeds, as `seed:describe-object` answers. */
const SEED_DESCRIBES: Record<string, Record<string, unknown>> = {
  Account: {
    objectApiName: 'Account',
    objectLabel: 'Account',
    fields: [
      {
        fieldApiName: 'Name',
        label: 'Account Name',
        type: 'string',
        required: true,
        picklistValues: [],
        referenceTo: [],
        length: 255,
      },
      {
        fieldApiName: 'ParentId',
        label: 'Parent Account ID',
        type: 'reference',
        required: false,
        picklistValues: [],
        referenceTo: ['Account'],
        length: 18,
      },
    ],
  },
  Contact: {
    objectApiName: 'Contact',
    objectLabel: 'Contact',
    fields: [
      {
        fieldApiName: 'LastName',
        label: 'Last Name',
        type: 'string',
        required: true,
        picklistValues: [],
        referenceTo: [],
        length: 80,
      },
      {
        fieldApiName: 'AccountId',
        label: 'Account ID',
        type: 'reference',
        required: false,
        picklistValues: [],
        referenceTo: ['Account'],
        length: 18,
      },
    ],
  },
};

/**
 * Answer each `seed:describe-object` not answered yet with the describe of the
 * object it names. The wizard describes one object per request and asks again
 * for any object whose answer it dropped, so this runs until each is on screen.
 */
async function answerSeedDescribes(page: Page, answered: Set<string>): Promise<void> {
  const requests = await page.evaluate(() => {
    const posted = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
    return posted
      .map((m) => ((m as Record<string, unknown>).payload ?? m) as Record<string, unknown>)
      .filter((m) => m.type === 'seed:describe-object')
      .map((m) => ({
        id: String(m.id),
        objectApiName: String((m.payload as Record<string, unknown>).objectApiName),
      }));
  });
  for (const request of requests) {
    if (answered.has(request.id)) continue;
    answered.add(request.id);
    await sendExtensionMessage(page, {
      type: 'seed:describe-object:response',
      id: `resp-${request.id}`,
      correlationId: request.id,
      payload: SEED_DESCRIBES[request.objectApiName],
    });
  }
}

/**
 * Open the Seed wizard's relation editor with Account and Contact selected:
 * one row fills Contact.AccountId from the accounts the run creates, the other
 * fills Account.ParentId from accounts already in the org, at a ratio that
 * plans no child — so a planned line, the filter fields and a problem line are
 * all on screen.
 */
async function openSeedRelations(bridge: MockBridge, page: Page, theme: StateTheme): Promise<void> {
  await openPanel(bridge, page, 'seed', theme);
  await bridge.seedOrgs(MOCK_ORGS);
  await page.getByTestId('mode-card-ai').click();
  await page.getByTestId('fork-card-scratch').click();
  await page.getByTestId('org-selector').selectOption(DEV_SANDBOX.id);
  await bridge.waitForMessage('seed:describe-global', { timeout: 10_000 });
  await answerAll(page, 'seed:describe-global', 'seed:describe-global:response', {
    objects: [
      { apiName: 'Account', label: 'Account', recordCount: 0, dependencies: [] },
      { apiName: 'Contact', label: 'Contact', recordCount: 0, dependencies: [] },
    ],
  });
  await page.getByTestId('obj-Account').click();
  await page.getByTestId('obj-Contact').click();
  await page.getByTestId('seed-wizard-next').click();
  // Two objects skip the configure step; the link on the next one leads back.
  await page.getByTestId('adaptive-customize-link').click();
  const answered = new Set<string>();
  for (const objectApiName of Object.keys(SEED_DESCRIBES)) {
    await expect
      .poll(
        async () => {
          await answerSeedDescribes(page, answered);
          return page.getByTestId(`obj-header-${objectApiName}`).count();
        },
        { timeout: 10_000 },
      )
      .toBe(1);
  }
  await answerAll(page, 'precheck:pii-scan', 'precheck:pii-scan:response', {
    success: true,
    results: [],
  });
  await page.getByRole('button', { name: 'Advanced Settings' }).click();
  await page.getByTestId('add-relation-btn').click();
  await page.getByTestId('add-relation-btn').click();
  await page.getByTestId('relation-1-mode').selectOption('ratio');
  await page.getByTestId('relation-1-ratio').fill('0.05');
  await expect(page.getByTestId('relation-0-planned')).toHaveText(
    'Contact: up to 300 records — parents: 100 × Account, created by this run.',
  );
  const problem = page.getByTestId('relation-1-problem');
  await problem.waitFor({ state: 'visible', timeout: 10_000 });
  await problem.scrollIntoViewIfNeeded();
}

/**
 * Open the Seed wizard's execute step as a run of Account and Contact reaches
 * it: the configure step skipped, both objects described, the banner saying
 * the run uses the default rules, and a relation added on the step itself.
 */
async function openSeedExecuteSkipped(
  bridge: MockBridge,
  page: Page,
  theme: StateTheme,
): Promise<void> {
  await openPanel(bridge, page, 'seed', theme);
  await bridge.seedOrgs(MOCK_ORGS);
  await page.getByTestId('mode-card-ai').click();
  await page.getByTestId('fork-card-scratch').click();
  await page.getByTestId('org-selector').selectOption(DEV_SANDBOX.id);
  await bridge.waitForMessage('seed:describe-global', { timeout: 10_000 });
  await answerAll(page, 'seed:describe-global', 'seed:describe-global:response', {
    objects: [
      { apiName: 'Account', label: 'Account', recordCount: 0, dependencies: [] },
      { apiName: 'Contact', label: 'Contact', recordCount: 0, dependencies: [] },
    ],
  });
  await page.getByTestId('obj-Account').click();
  await page.getByTestId('obj-Contact').click();
  await page.getByTestId('seed-wizard-next').click();
  const answered = new Set<string>();
  await expect
    .poll(
      async () => {
        await answerSeedDescribes(page, answered);
        return page.getByTestId('seed-fields-status').textContent();
      },
      { timeout: 10_000 },
    )
    .toBe('Using default field rules.');
  await page.getByTestId('add-relation-btn').click();
  await page.getByTestId('relation-0-planned').waitFor({ state: 'visible', timeout: 10_000 });
}

for (const theme of STATE_THEMES) {
  test.describe(`rendered contrast — ${theme} — states`, () => {
    test.describe.configure({ timeout: 60000 });
    let bridge: MockBridge;

    test.beforeEach(() => {
      bridge = new MockBridge();
    });

    test('Home recent operations, one of each status', async ({ page }) => {
      await openPanel(bridge, page, 'home', theme);
      await page.getByTestId('home-page').waitFor({ timeout: 10_000 });
      // Each status writes its own badge; a cancelled one is the neutral pill.
      await bridge.stream([
        started('op-ok', 'seed', 'Seed Accounts'),
        { type: 'operation:completed', payload: { operationId: 'op-ok', result: {} } },
        started('op-failed', 'sync', 'Sync Contacts'),
        {
          type: 'operation:failed',
          payload: { operationId: 'op-failed', error: 'refused', retryable: false },
        },
        started('op-cancelled', 'dataops', 'Backup 3 object(s)'),
        {
          type: 'operation:completed',
          payload: { operationId: 'op-cancelled', result: { aborted: true } },
        },
        started('op-running', 'forge', 'Discovering object graph'),
      ]);
      const card = page.getByTestId('recent-ops-card');
      await expect(card.getByTestId('recent-op-item')).toHaveCount(4);
      await expect(card).toContainText('Cancelled');

      await expectReadable(page, theme, '[data-testid="recent-ops-card"]');
    });

    test('Side panel last operation, named by how it ended', async ({ page }) => {
      await openPanel(bridge, page, 'sidepanel', theme);
      await page.getByTestId('sidepanel-root').waitFor({ timeout: 10_000 });
      // The panel shows the last operation only: each ending in turn, each
      // status icon named, and each state scanned.
      const endings: Array<[string, { type: string; payload: Record<string, unknown> }]> = [
        [
          'Succeeded',
          { type: 'operation:completed', payload: { operationId: 'op-ok', result: {} } },
        ],
        [
          'Failed',
          {
            type: 'operation:failed',
            payload: { operationId: 'op-failed', error: 'refused', retryable: false },
          },
        ],
        [
          'Cancelled',
          {
            type: 'operation:completed',
            payload: { operationId: 'op-cancelled', result: { aborted: true } },
          },
        ],
      ];
      for (const [name, ended] of endings) {
        await bridge.stream([
          started(String(ended.payload.operationId), 'seed', 'Seed data generation'),
          ended,
        ]);
        const lastOp = page.getByTestId('sidepanel-last-op');
        await expect(lastOp.getByRole('img', { name })).toBeVisible();

        await expectReadable(page, theme, '[data-testid="sidepanel-last-op"]');
      }
    });

    test('Compare result with its risk score card', async ({ page }) => {
      await openPanel(bridge, page, 'compare', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('compare-page').waitFor({ timeout: 10_000 });
      await page.getByLabel('Source Org').selectOption(DEV_SANDBOX.id);
      await page.getByLabel('Target Org').selectOption(QA_SANDBOX.id);
      await page.getByTestId('cat-ApexClass').click();
      await page.getByTestId('run-compare-btn').click();
      await bridge.waitForMessage('compare:execute', { timeout: 10_000 });
      // One new class: a low risk score, whose label is written in the success colour.
      await answerAll(page, 'compare:execute', 'compare:execute:response', {
        configId: '4f1a2b3c-0000-4000-8000-000000000002',
        sourceOrgId: DEV_SANDBOX.id,
        targetOrgId: QA_SANDBOX.id,
        mode: 'metadata',
        summary: {
          totalItems: 2,
          added: 0,
          removed: 1,
          modified: 0,
          unchanged: 0,
          notCompared: 1,
          byType: {},
        },
        // One class past the read budget, so the not-compared count and the
        // coverage lines are painted and read against the theme too.
        content: {
          compared: 0,
          notCompared: { unreadable: 0, read_failed: 0, over_budget: 1 },
          budget: { components: 500, seconds: 90 },
        },
        diffs: [
          {
            componentType: 'ApexClass',
            fullName: 'MyClass',
            status: 'removed',
            sourceValue: 'public class MyClass { }',
            severity: 'info',
            deployable: true,
          },
          {
            componentType: 'ApexClass',
            fullName: 'Billing',
            status: 'not_compared',
            notComparedReason: 'over_budget',
            severity: 'info',
            deployable: false,
          },
        ],
        timestamp: '2026-09-10T09:00:00.000Z',
        duration: 1200,
      });
      await expect(page.getByTestId('risk-score-label')).toHaveText('Low risk', {
        timeout: 10_000,
      });
      await expect(page.getByTestId('compare-coverage-over-budget')).toBeVisible();

      await expectReadable(page, theme);
    });

    test('Compare result with every kind of difference, its groups open', async ({ page }) => {
      await openPanel(bridge, page, 'compare', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('compare-page').waitFor({ timeout: 10_000 });
      await page.getByLabel('Source Org').selectOption(DEV_SANDBOX.id);
      await page.getByLabel('Target Org').selectOption(QA_SANDBOX.id);
      await page.getByTestId('cat-ApexClass').click();
      await page.getByTestId('run-compare-btn').click();
      await bridge.waitForMessage('compare:execute', { timeout: 10_000 });
      // A class only the source holds, one both hold differently, and a field
      // only the target holds whose removal would break: drawn as a deployment
      // reads them, a plus, a tilde and a minus, each on the tint of its risk.
      await answerAll(page, 'compare:execute', 'compare:execute:response', {
        configId: '4f1a2b3c-0000-4000-8000-000000000005',
        sourceOrgId: DEV_SANDBOX.id,
        targetOrgId: QA_SANDBOX.id,
        mode: 'metadata',
        summary: {
          totalItems: 3,
          added: 1,
          removed: 1,
          modified: 1,
          unchanged: 0,
          notCompared: 0,
          byType: {},
        },
        content: {
          compared: 1,
          notCompared: { unreadable: 0, read_failed: 0, over_budget: 0 },
          budget: { components: 500, seconds: 90 },
        },
        diffs: [
          {
            componentType: 'ApexClass',
            fullName: 'Billing',
            status: 'removed',
            sourceValue: 'public class Billing { }',
            severity: 'info',
            deployable: true,
          },
          {
            componentType: 'ApexClass',
            fullName: 'Invoicing',
            status: 'modified',
            sourceValue: 'public class Invoicing { }',
            targetValue: 'public class Invoicing { Integer total; }',
            severity: 'breaking',
            deployable: true,
          },
          {
            componentType: 'CustomField',
            fullName: 'Account.Legacy__c',
            status: 'added',
            targetValue: '<CustomField />',
            severity: 'breaking',
            deployable: true,
          },
        ],
        timestamp: '2026-09-10T09:00:00.000Z',
        duration: 1200,
      });
      await expect(page.getByTestId('compare-change-legend')).toBeVisible({ timeout: 10_000 });
      await page.getByTestId('diff-group-toggle-Apex Code').click();
      await page.getByTestId('diff-group-toggle-Data Model').click();
      await expect(page.getByTestId('diff-item-Billing')).toContainText('Only in the source');
      await expect(page.getByTestId('diff-item-Account.Legacy__c')).toContainText(
        'Only in the target',
      );
      await expect(page.getByTestId('diff-item-Invoicing')).toContainText('High risk');

      await expectReadable(page, theme);
    });

    test('Compare result that found nothing different, managed packages left out', async ({
      page,
    }) => {
      await openPanel(bridge, page, 'compare', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('compare-page').waitFor({ timeout: 10_000 });
      await page.getByLabel('Source Org').selectOption(DEV_SANDBOX.id);
      await page.getByLabel('Target Org').selectOption(QA_SANDBOX.id);
      await page.getByTestId('cat-ApexClass').click();
      await page.getByLabel('Include managed package components').uncheck();
      await page.getByTestId('run-compare-btn').click();
      await bridge.waitForMessage('compare:execute', { timeout: 10_000 });
      await answerAll(page, 'compare:execute', 'compare:execute:response', {
        configId: '4f1a2b3c-0000-4000-8000-000000000003',
        sourceOrgId: DEV_SANDBOX.id,
        targetOrgId: QA_SANDBOX.id,
        mode: 'metadata',
        summary: {
          totalItems: 1,
          added: 0,
          removed: 0,
          modified: 0,
          unchanged: 1,
          notCompared: 0,
          byType: {},
        },
        content: {
          compared: 1,
          notCompared: { unreadable: 0, read_failed: 0, over_budget: 0 },
          managedLeftOut: 8,
          budget: { components: 500, seconds: 90 },
        },
        diffs: [
          {
            componentType: 'ApexClass',
            fullName: 'Invoicing',
            status: 'unchanged',
            severity: 'info',
            deployable: false,
          },
        ],
        timestamp: '2026-09-10T09:00:00.000Z',
        duration: 900,
      });
      await expect(page.getByTestId('no-diffs')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('compare-coverage-managed-left-out')).toBeVisible();

      await expectReadable(page, theme);
    });

    test('Compare deploy tab after a validation that failed', async ({ page }) => {
      await openDeployTab(bridge, page, theme);
      await validateInvoicing(page);
      await bridge.waitForMessage('compare:validate-deployment', { timeout: 10_000 });
      // Every line a failed validation can paint: a component that failed on
      // a line, a warning, one the source did not return, a failed test, a
      // coverage warning, and what the source said.
      await answerAll(page, 'compare:validate-deployment', 'compare:validate-deployment:response', {
        report: validationReport({
          status: 'Failed',
          success: false,
          components: [
            {
              componentType: 'ApexClass',
              fullName: 'Invoicing',
              outcome: 'failed',
              problem: 'Variable does not exist: total',
              problemType: 'Error',
              fileName: 'classes/Invoicing.cls',
              line: 12,
              column: 5,
            },
            {
              componentType: 'Layout',
              fullName: 'Order-Order Layout',
              outcome: 'failed',
              problem: 'Cannot find the field in the target',
              problemType: 'Warning',
            },
            {
              componentType: 'ApexClass',
              fullName: 'Billing',
              outcome: 'not_retrieved',
              problem: "Entity of type 'ApexClass' named 'Billing' cannot be found",
            },
          ],
          counts: {
            componentsTotal: 2,
            componentsDeployed: 0,
            componentErrors: 2,
            testsTotal: 1,
            testsCompleted: 0,
            testErrors: 1,
          },
          testFailures: [
            {
              className: 'InvoicingTest',
              methodName: 'charges',
              message: 'System.AssertException: Assertion Failed',
              line: 21,
            },
          ],
          coverageWarnings: ['Invoicing: Test coverage of 40%'],
          retrieveProblems: ['classes/Invoicing.cls: Unable to read file'],
        }),
      });
      await expect(page.getByTestId('deploy-validation-report-test-failures')).toBeVisible({
        timeout: 10_000,
      });

      await expectReadable(page, theme);
    });

    test('Automation scheduler laying the sync schedules out by day', async ({ page }) => {
      await openPanel(bridge, page, 'automation', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('automation-page').waitFor({ timeout: 10_000 });
      await page.getByTestId('page-tab-scheduler').click();
      await bridge.waitForMessage('sync:schedule:list', { timeout: 10_000 });
      await answerAll(page, 'sync:config:list', 'sync:config:list:response', {
        configs: [
          { id: 'cfg-1', name: 'Dev to QA', description: '', updatedAt: '2026-09-01T09:00:00Z' },
        ],
      });
      const now = Date.now();
      const at = (offsetMs: number): string => new Date(now + offsetMs).toISOString();
      const schedule = (id: string, name: string, extra: Record<string, unknown>) => ({
        id,
        name,
        configId: 'cfg-1',
        cron: '0 2 * * *',
        timezone: 'UTC',
        enabled: true,
        maxRetries: 3,
        notifyOnComplete: false,
        notifyOnFailure: true,
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
        version: 1,
        ...extra,
      });
      // A run past its time, one to come, one days away and one paused, with
      // a last result of each kind: every group and every badge is painted.
      // The paused one was cancelled, at a time the panel cannot read.
      await answerAll(page, 'sync:schedule:list', 'sync:schedule:list:response', {
        schedules: [
          schedule('due', 'Accounts', {
            nextRunAt: at(-5 * 60_000),
            lastRunAt: at(-86_400_000),
            lastResult: 'failure',
          }),
          schedule('soon', 'Contacts', {
            nextRunAt: at(2 * 3_600_000),
            lastRunAt: at(-3_600_000),
            lastResult: 'success',
          }),
          schedule('later', 'Cases', {
            nextRunAt: at(4 * 86_400_000),
            lastRunAt: at(-2 * 86_400_000),
            lastResult: 'partial',
          }),
          schedule('paused', 'Leads', {
            enabled: false,
            nextRunAt: at(3_600_000),
            lastRunAt: 'not a date',
            lastResult: 'cancelled',
          }),
        ],
      });
      await expect(page.getByTestId('scheduler-group-due')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('scheduler-group-paused')).toBeVisible();
      const cancelled = page.getByTestId('scheduler-entry-paused');
      await expect(cancelled).toContainText('Cancelled');
      await expect(cancelled).toContainText('Last run: unknown');

      await expectReadable(page, theme);
    });

    test('Sync real-time tab while a session writes, with a refused object and every outcome', async ({
      page,
    }) => {
      await openPanel(bridge, page, 'sync', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('sync-page').waitFor({ timeout: 10_000 });
      await page.getByLabel('Source', { exact: true }).selectOption(DEV_SANDBOX.id);
      await page.getByLabel('Target', { exact: true }).selectOption(QA_SANDBOX.id);
      await page.getByTestId('tab-realtime').click();
      await bridge.waitForMessage('realtime:objects', { timeout: 10_000 });
      await answerAll(page, 'realtime:objects', 'realtime:objects:response', {
        objects: [
          {
            objectApiName: 'Lead',
            channel: 'ActivityEngagementVirtualChannel',
            inTarget: true,
            externalIdFields: ['Legacy_Key__c'],
            syncConfigs: [{ id: 'cfg-1', name: 'Leads nightly' }],
          },
          {
            objectApiName: 'Case',
            channel: 'ChangeEvents',
            inTarget: true,
            externalIdFields: [],
            syncConfigs: [],
          },
          {
            objectApiName: 'ListEmailSentResult',
            channel: 'ActivityEngagementVirtualChannel',
            inTarget: false,
            externalIdFields: [],
            syncConfigs: [],
          },
        ],
      });
      // Every control of a written object on screen: its match, its strategy,
      // its deletions — and one object the target does not have.
      await page.getByTestId('cdc-object-checkbox-Lead').check();
      await page.getByTestId('cdc-object-checkbox-Case').check();
      await page.getByTestId('cdc-object-checkbox-ListEmailSentResult').check();
      await page.getByTestId('cdc-autosync-toggle-Lead').check();
      await page.getByTestId('cdc-start-btn').click();
      await sendExtensionMessage(page, {
        type: 'realtime:started',
        id: 'evt-realtime-started',
        payload: {
          success: true,
          sessionId: 'session-1',
          watchedObjects: ['Lead', 'ListEmailSentResult'],
          refused: [
            {
              objectApiName: 'Case',
              reason: '403::User not allowed to subscribe CDC without required permissions',
            },
          ],
          notes: ['Lead: the org no longer holds the point the last session stopped at.'],
        },
      });
      await answerAll(page, 'realtime:metrics', 'realtime:metrics:response', {
        metrics: {
          eventsReceived: 7,
          eventsApplied: 2,
          eventsFailed: 1,
          eventsPerMinute: 7,
          averageLagMs: 850,
          currentLagMs: 2400,
          errorRate: 33.3,
          startedAt: new Date(Date.now() - 90_000).toISOString(),
        },
      });
      const outcomes = [
        'applied',
        'failed',
        'watched',
        'kept-target',
        'held',
        'deletes-off',
        'own-write',
      ];
      await sendExtensionMessage(page, {
        type: 'realtime:events-batch',
        id: 'evt-batch',
        payload: {
          events: outcomes.map((outcome, i) => ({
            replayId: 100 + i,
            objectApiName: 'Lead',
            changeType: i === 5 ? 'DELETE' : 'UPDATE',
            recordIds: [`00Q00000000000${i}AAA`],
            commitTimestamp: new Date().toISOString(),
            changedFields: { Title: 'Buyer' },
            commitUser: '005000000000001AAA',
            transactionKey: `txn-${i}`,
            applied: outcome === 'applied',
            outcome,
            ...(outcome === 'failed' ? { error: 'ENTITY_IS_LOCKED: the record is locked' } : {}),
          })),
        },
      });
      await expect(page.getByTestId('cdc-event-row-6')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('realtime-refused')).toBeVisible();
      await expect(page.getByTestId('cdc-metric-throughput')).toBeVisible();

      await expectReadable(page, theme);
    });

    test('Sync conflicts tab with a change held for a decision', async ({ page }) => {
      await openPanel(bridge, page, 'sync', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('sync-page').waitFor({ timeout: 10_000 });
      for (const [replayId, recordId] of [
        [201, '00Q000000000001AAA'],
        [202, '00Q000000000002AAA'],
      ] as const) {
        await sendExtensionMessage(page, {
          type: 'realtime:conflict',
          id: `conflict-${replayId}`,
          payload: {
            replayId,
            objectApiName: 'Lead',
            recordIds: [recordId],
            changeType: 'UPDATE',
            sourceValues: { Title: 'Buyer', Company: 'Acme' },
            targetValues: { Title: 'Head of purchasing', Company: 'Acme' },
            targetLastModified: '2026-09-23T11:00:00.000Z',
          },
        });
      }
      await page.getByTestId('tab-conflicts').click();
      await page.getByTestId('conflict-list-panel').waitFor({ timeout: 10_000 });
      await page.getByTestId('data-table').locator('[data-testid^="table-row-"]').first().click();
      await page.getByTestId('conflict-resolution-panel').waitFor({ timeout: 10_000 });
      await page.getByTestId('pick-source-Title').click();

      await expectReadable(page, theme);
    });

    test('DataOps template editor over a rule whose method cannot run here', async ({ page }) => {
      await openPanel(bridge, page, 'dataops', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('dataops-page').waitFor({ timeout: 10_000 });
      await bridge.waitForMessage('dataops:anonymization-templates', { timeout: 10_000 });
      await answerAll(
        page,
        'dataops:anonymization-templates',
        'dataops:anonymization-templates:response',
        {
          templates: [
            {
              id: 'tpl-scrub',
              name: 'Sandbox Data Scrub',
              description: 'Mask all PII for safe development use.',
              complianceFramework: 'custom',
              rules: [
                {
                  fieldPattern: 'Account.Website',
                  ruleType: 'constant',
                  description: '',
                  config: { constantValue: 'https://example.com' },
                },
                { fieldPattern: 'Contact.FirstName', ruleType: 'fake', description: '' },
              ],
            },
          ],
        },
      );
      await page.getByTestId('page-tab-anonymize').click();
      await page.getByTestId('template-select').selectOption('tpl-scrub');
      await page.getByTestId('create-template-btn').click();
      // A name taken and a method that needs a value: both reasons are on screen.
      await page.getByTestId('template-name-input').fill('Sandbox Data Scrub');
      await expect(page.getByTestId('template-name-taken')).toBeVisible();
      await expect(page.getByTestId('template-rule-0')).toContainText('needs a setting');

      await expectReadable(page, theme);
    });

    test('DataOps template the user saved, with its delete', async ({ page }) => {
      await openPanel(bridge, page, 'dataops', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('dataops-page').waitFor({ timeout: 10_000 });
      await bridge.waitForMessage('dataops:anonymization-templates', { timeout: 10_000 });
      await answerAll(
        page,
        'dataops:anonymization-templates',
        'dataops:anonymization-templates:response',
        {
          templates: [
            {
              id: 'tpl-saved-1',
              name: 'Support desk',
              description: '',
              complianceFramework: 'custom',
              rules: [{ fieldPattern: 'Case.SuppliedEmail', ruleType: 'nullify', description: '' }],
              saved: true,
            },
          ],
        },
      );
      await page.getByTestId('page-tab-anonymize').click();
      await page.getByTestId('template-select').selectOption('tpl-saved-1');
      await page.getByTestId('delete-template-btn').click();
      await expect(page.getByTestId('confirm-delete-template-btn')).toBeVisible();

      await expectReadable(page, theme);
    });

    test('Monitor predictions tile at every urgency', async ({ page }) => {
      await openPanel(bridge, page, 'monitor', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await bridge.waitForMessage('monitor:refresh', { timeout: 10_000 });
      const trend = (limitName: string, predictedTimeToLimit: number): Record<string, unknown> => ({
        limitName,
        direction: 'up',
        changePercent: 12,
        predictedTimeToLimit,
        sparklineData: [40, 45, 52],
        timestamps: ['2026-03-13T10:30:00Z', '2026-03-13T10:45:00Z', '2026-03-13T11:00:00Z'],
      });
      await answerAll(page, 'monitor:refresh', 'monitor:data', {
        healthScore: 85,
        healthReport: null,
        jobs: [],
        limits: [
          { name: 'DailyApiRequests', max: 100000, remaining: 10000, usedPercent: 90 },
          { name: 'DataStorageMB', max: 5120, remaining: 1024, usedPercent: 80 },
          { name: 'FileStorageMB', max: 5120, remaining: 3072, usedPercent: 40 },
        ],
        orgInfo: null,
        // Under 2 hours, under 12 and beyond: the three urgencies the tile colours.
        trends: {
          DailyApiRequests: trend('DailyApiRequests', 1),
          DataStorageMB: trend('DataStorageMB', 6),
          FileStorageMB: trend('FileStorageMB', 48),
        },
        lastUpdated: '2026-03-13T11:05:00Z',
      });
      const tile = page.getByTestId('predictions-tile');
      await tile.waitFor({ state: 'visible', timeout: 10_000 });
      await tile.scrollIntoViewIfNeeded();
      await expect(tile.getByTestId('prediction-time-FileStorageMB')).toHaveText('2d 0h');

      await expectReadable(page, theme);
    });

    test('Autopilot graph controls while a run is in progress', async ({ page }) => {
      await openPanel(bridge, page, 'autopilot', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('step1-connect').waitFor({ state: 'visible', timeout: 10_000 });
      await page.getByTestId('source-org-org-src-1').click();
      await page.getByTestId('target-org-org-tgt-1').click();
      await page.getByTestId('seed-wizard-next').click();
      await bridge.respondToNext('autopilot:scan-schema', 'autopilot:schema-result', {
        graph: MOCK_GRAPH,
      });
      await page.getByTestId('step2-objects').waitFor({ state: 'visible', timeout: 5000 });
      await page.getByTestId('seed-wizard-next').click();
      await page.getByTestId('step3-compliance').waitFor({ state: 'visible', timeout: 5000 });
      await page.getByTestId('seed-wizard-next').click();
      await bridge.respondToNext('autopilot:generate-plan', 'autopilot:plan-ready', {
        plan: MOCK_PLAN,
        graph: MOCK_GRAPH,
      });
      await page.getByTestId('execute-button').click();
      // `autopilot:execute` is left unanswered: the run stays in flight on the graph.
      await bridge.waitForMessage('autopilot:execute', { timeout: 10_000 });
      // The minimap is shown from the start, so its toggle is drawn pressed.
      await page.getByTestId('minimap-toggle-btn').waitFor({ state: 'visible', timeout: 10_000 });

      await expectReadable(page, theme);
    });

    test('Seed relations, a row planning its children beside one that plans none', async ({
      page,
    }) => {
      await openSeedRelations(bridge, page, theme);

      await expectReadable(page, theme, '[data-testid="seed-relations"]');
    });

    test('Autopilot node detail saying why records were refused', async ({ page }) => {
      await openPanel(bridge, page, 'autopilot', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('step1-connect').waitFor({ state: 'visible', timeout: 10_000 });
      await page.getByTestId('source-org-org-src-1').click();
      await page.getByTestId('target-org-org-tgt-1').click();
      await page.getByTestId('seed-wizard-next').click();
      await bridge.respondToNext('autopilot:scan-schema', 'autopilot:schema-result', {
        graph: MOCK_GRAPH,
      });
      await page.getByTestId('step2-objects').waitFor({ state: 'visible', timeout: 5000 });
      await page.getByTestId('seed-wizard-next').click();
      await page.getByTestId('step3-compliance').waitFor({ state: 'visible', timeout: 5000 });
      await page.getByTestId('seed-wizard-next').click();
      await bridge.respondToNext('autopilot:generate-plan', 'autopilot:plan-ready', {
        plan: MOCK_PLAN,
        graph: MOCK_GRAPH,
      });
      await page.getByTestId('execute-button').click();
      await bridge.waitForMessage('autopilot:execute', { timeout: 10_000 });
      // A node as the handler settles it: written, linked, refused by code and
      // fields, left to the platform, and the statuses given back once its
      // children were in.
      await bridge.stream([
        {
          type: 'autopilot:node-progress',
          payload: {
            nodeId: 'Contact',
            objectName: 'Contact',
            status: 'completed',
            wave: 1,
            recordCount: 1180,
            failureCount: 20,
            linkedCount: 3,
            leftToThePlatform: 4,
            refusals: [
              {
                statusCode: 'REQUIRED_FIELD_MISSING',
                fields: ['LastName'],
                count: 12,
                message: 'Required fields are missing: [LastName]',
              },
              {
                statusCode: 'INVALID_CROSS_REFERENCE_KEY',
                fields: [],
                count: 8,
                message: 'invalid cross reference id',
              },
            ],
            statusesApplied: 2,
            statusRefusals: [
              {
                statusCode: 'FIELD_INTEGRITY_EXCEPTION',
                fields: ['Status'],
                count: 1,
                message: 'Cannot activate a record without its products',
              },
            ],
          },
        },
      ]);
      await page.evaluate(() => {
        const store = (window as unknown as Record<string, unknown>).__AUTOPILOT_STORE__ as
          | { getState: () => { selectNode: (name: string) => void } }
          | undefined;
        store?.getState().selectNode('Contact');
      });
      await page.getByTestId('control-tab-node').click();
      await page.getByTestId('node-status-refusals').waitFor({ state: 'visible', timeout: 10_000 });
      await page
        .getByTestId('node-left-to-the-platform')
        .waitFor({ state: 'visible', timeout: 10_000 });

      await expectReadable(page, theme);
    });

    test('Seed execute step of a run that skipped configure, with its rules and a relation', async ({
      page,
    }) => {
      await openSeedExecuteSkipped(bridge, page, theme);

      await expectReadable(page, theme, '[data-testid="seed-step-execute-content"]');
    });

    test('CSV drop zone while a file is dragged over it', async ({ page }) => {
      await openCsvImport(bridge, page, theme);
      const dropArea = page.getByTestId('drop-area');
      const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
      await dropArea.dispatchEvent('dragover', { dataTransfer });
      await expect(dropArea).toHaveClass(/bg-status-info/);

      await expectReadable(page, theme);
    });

    test('Organizations JWT sign-in form, with its key file hint', async ({ page }) => {
      await openJwtForm(bridge, page, theme);

      await expectReadable(page, theme, '[data-testid="org-inline-form"]');
    });

    test('Organizations device sign-in showing its code while it waits', async ({ page }) => {
      await openDeviceCode(bridge, page, theme);
      // The code replaced the form whose button asked for it: focus is on the code.
      await expect(page.getByRole('status').filter({ hasText: 'AB12CD34' })).toBeFocused();

      await expectReadable(page, theme, '[data-testid="org-device-code"]');
    });

    test('Frozen dataset extraction form with its placeholders', async ({ page }) => {
      await openPanel(bridge, page, 'frozen', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('frozen-extract-tab').waitFor({ state: 'visible', timeout: 10_000 });
      await page.getByTestId('frozen-axis-add').click();
      await page.getByTestId('frozen-edge-add').click();
      await expect(
        page.getByTestId('frozen-extract-tab').locator('input[placeholder]'),
      ).toHaveCount(8);

      await expectReadable(page, theme);
    });

    test('Frozen dataset load report naming what the load did not send', async ({ page }) => {
      await openPanel(bridge, page, 'frozen', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('frozen-extract-tab').waitFor({ state: 'visible', timeout: 10_000 });
      // A frozen dataset to load: the run is offered once the status names one.
      await answerAll(page, 'frozen:status', 'frozen:status:response', {
        status: FROZEN_STATUS_WITH_DATASET,
      });
      await page.getByTestId('page-tab-load').click();
      await expect(page.getByTestId('frozen-load-run')).toBeEnabled({ timeout: 10_000 });
      await page.getByTestId('frozen-load-run').click();
      await bridge.waitForMessage('frozen:load', { timeout: 10_000 });
      // An object the target takes no insert of, and feed items the dataset
      // cannot type, beside the lines every report carries.
      await answerAll(page, 'frozen:load', 'frozen:load:response', {
        report: FROZEN_LOAD_REPORT_WITH_LEFT_OUT,
      });
      await page
        .getByTestId('frozen-report-excluded')
        .waitFor({ state: 'visible', timeout: 10_000 });
      await page
        .getByTestId('frozen-report-untyped-feed-items')
        .waitFor({ state: 'visible', timeout: 10_000 });

      await expectReadable(page, theme);
    });

    test('CSV validation panel listing an error', async ({ page }) => {
      await openCsvImport(bridge, page, theme);
      // The file first: columns are mapped when the object's fields arrive.
      await page.getByTestId('file-input').setInputFiles({
        name: 'accounts.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from('Name,NumberOfEmployees\nAcme,twelve\nGlobex,40\n'),
      });
      await page.getByTestId('csv-preview').waitFor({ state: 'visible', timeout: 10_000 });
      await page.getByTestId('csv-object-selector').selectOption('Account');
      await bridge.waitForMessage('seed:describe-object', { timeout: 10_000 });
      await answerAll(page, 'seed:describe-object', 'seed:describe-object:response', {
        fields: [
          {
            apiName: 'Name',
            label: 'Account Name',
            type: 'string',
            required: true,
            defaultValue: null,
            unique: false,
            externalId: false,
            maxLength: 255,
          },
          {
            apiName: 'NumberOfEmployees',
            label: 'Employees',
            type: 'int',
            required: false,
            defaultValue: null,
            unique: false,
            externalId: false,
          },
        ],
      });
      await expect(page.getByTestId('csv-next-button')).toBeEnabled({ timeout: 10_000 });
      await page.getByTestId('csv-next-button').click();
      await page.getByTestId('csv-step-map').waitFor({ state: 'visible', timeout: 10_000 });
      await expect(page.getByTestId('csv-next-button')).toBeEnabled({ timeout: 10_000 });
      await page.getByTestId('csv-next-button').click();
      await bridge.waitForMessage('seed:csv:validate', { timeout: 10_000 });
      await answerAll(page, 'seed:csv:validate', 'seed:csv:validate:response', {
        valid: false,
        errors: [
          {
            row: 2,
            column: 'NumberOfEmployees',
            field: 'NumberOfEmployees',
            errorType: 'type_mismatch',
            message: 'Expected a whole number',
            value: 'twelve',
          },
        ],
        warningCount: 0,
      });
      await expect(page.getByText('twelve', { exact: true })).toBeVisible({ timeout: 10_000 });

      await expectReadable(page, theme);
    });

    test('DataOps quality scan results, with every note a scan can carry', async ({ page }) => {
      await openPanel(bridge, page, 'dataops', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('dataops-page').waitFor({ timeout: 10_000 });
      await bridge.waitForMessage('backup:list', { timeout: 10_000 });
      await answerAll(page, 'backup:list', 'backup:list:result', { backups: [] });
      await answerAll(
        page,
        'dataops:anonymization-templates',
        'dataops:anonymization-templates:response',
        { templates: [] },
      );
      await page.getByTestId('page-tab-quality').click();
      await bridge.waitForMessage('seed:describe-global', { timeout: 10_000 });
      await answerAll(page, 'seed:describe-global', 'seed:describe-global:response', {
        objects: [
          { apiName: 'Account', label: 'Account' },
          { apiName: 'Contact', label: 'Contact' },
        ],
      });
      await page.getByTestId('quality-object-option-Contact').check();
      await page.getByTestId('quality-object-option-Account').check();
      await page.getByTestId('quality-scan-btn').click();
      await bridge.waitForMessage('dataops:quality-scan', { timeout: 10_000 });
      // One object with every section a scan can fill — a required field left
      // empty, a search that reached its limit, fields of each kind not counted,
      // a refused check — and one the org would not describe.
      await answerAll(page, 'dataops:quality-scan', 'dataops:quality-scan:response', {
        orgId: DEV_SANDBOX.id,
        staleDays: 365,
        scannedAt: '2026-09-01T10:00:00.000Z',
        bounds: { duplicateGroupLimit: 2000, duplicateSample: 20, singleFieldQueries: 20 },
        objects: [
          {
            status: 'scanned',
            objectApiName: 'Contact',
            label: 'Contact',
            totalRecords: 4200,
            fields: [
              { fieldApiName: 'Fax', label: 'Fax', filled: 0, required: false },
              { fieldApiName: 'Title', label: 'Title', filled: 900, required: false },
              { fieldApiName: 'LastName', label: 'Last Name', filled: 4100, required: true },
              { fieldApiName: 'Email', label: 'Email', filled: 4150, required: false },
            ],
            unmeasured: [
              { fieldApiName: 'Description', label: 'Description', reason: 'not-countable' },
              { fieldApiName: 'Interests__c', label: 'Interests', reason: 'query-budget' },
              { fieldApiName: 'Region__c', label: 'Region', reason: 'refused' },
            ],
            duplicates: {
              keyField: 'Email',
              keyLabel: 'Email',
              groups: [
                { value: 'shared@example.com', count: 4 },
                { value: 'twice@example.com', count: 2 },
              ],
              groupCount: 2000,
              recordCount: 4006,
              truncated: true,
            },
            stale: { days: 365, records: 1300 },
            keyFields: [
              { fieldApiName: 'Email', label: 'Email' },
              { fieldApiName: 'Title', label: 'Title' },
            ],
            errors: [
              {
                check: 'fill',
                message: 'QUERY_TIMEOUT: Your query request was running for too long.',
              },
            ],
          },
          {
            status: 'failed',
            objectApiName: 'Account',
            message: 'INVALID_TYPE: sObject type is not supported.',
          },
        ],
      });
      const contact = page.getByTestId('quality-object-Contact');
      await contact.waitFor({ state: 'visible', timeout: 10_000 });
      await expect(contact.getByTestId('quality-duplicates-truncated')).toBeVisible();
      await contact.getByTestId('quality-all-fields').locator('summary').click();
      await expect(contact.getByTestId('quality-all-fields-table')).toBeVisible();

      await expectReadable(page, theme);
    });

    test('DataOps compliance: an inventory, a request found, its erasure reviewed, and the log', async ({
      page,
    }) => {
      await openPanel(bridge, page, 'dataops', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('dataops-page').waitFor({ timeout: 10_000 });
      await bridge.waitForMessage('backup:list', { timeout: 10_000 });
      await answerAll(page, 'backup:list', 'backup:list:result', { backups: [] });
      await answerAll(
        page,
        'dataops:anonymization-templates',
        'dataops:anonymization-templates:response',
        { templates: [] },
      );
      await page.getByTestId('page-tab-gdpr').click();
      await bridge.waitForMessage('seed:describe-global', { timeout: 10_000 });
      await answerAll(page, 'seed:describe-global', 'seed:describe-global:response', {
        objects: [
          { apiName: 'Contact', label: 'Contact' },
          { apiName: 'Case', label: 'Case' },
        ],
      });
      await page.getByTestId('compliance-object-option-Contact').check();
      await page.getByTestId('compliance-object-option-Case').check();
      await page.getByTestId('inventory-run-btn').click();
      await bridge.waitForMessage('dataops:pii-inventory', { timeout: 10_000 });
      // Every note an inventory can carry: a field found from its values, one
      // empty in the sample, a sample the org refused, an object it refused.
      await answerAll(page, 'dataops:pii-inventory', 'dataops:pii-inventory:response', {
        orgId: DEV_SANDBOX.id,
        scannedAt: '2026-09-23T10:00:00.000Z',
        sampleSize: 200,
        objects: [
          {
            status: 'scanned',
            objectApiName: 'Contact',
            label: 'Contact',
            sampled: 18,
            fields: [
              {
                fieldApiName: 'Email',
                label: 'Email',
                classification: 'PII',
                detectedBy: 'name',
                pattern: 'email',
                filled: 17,
                searchedFor: 'email',
              },
              {
                fieldApiName: 'Notes__c',
                label: 'Notes',
                classification: 'PII',
                detectedBy: 'content',
                pattern: 'email_content',
                filled: 12,
                matched: 3,
              },
              {
                fieldApiName: 'Fax',
                label: 'Fax',
                classification: 'PII',
                detectedBy: 'type',
                pattern: 'phone_type',
                filled: 0,
                searchedFor: 'phone',
              },
            ],
            nameField: { fieldApiName: 'Name', label: 'Full Name' },
          },
          {
            status: 'scanned',
            objectApiName: 'Case',
            label: 'Case',
            sampled: 0,
            fields: [],
            nameField: null,
            sampleError: 'QUERY_TIMEOUT: Your query request was running for too long.',
          },
          {
            status: 'failed',
            objectApiName: 'Nope__c',
            message: 'INVALID_TYPE: sObject type is not supported.',
          },
        ],
      });
      await expect(page.getByTestId('inventory-field-Fax')).toBeVisible({ timeout: 10_000 });

      await page.getByLabel('Email address').fill('jane.doe@example.com');
      await page.getByTestId('dsr-search-btn').click();
      await bridge.waitForMessage('dataops:dsr:search', { timeout: 10_000 });
      await answerAll(page, 'dataops:dsr:search', 'dataops:dsr:search:response', {
        requestId: '5b0a9b8c-3333-4000-8000-000000000000',
        orgId: DEV_SANDBOX.id,
        searchedAt: '2026-09-23T10:01:00.000Z',
        limit: 200,
        objects: [
          {
            status: 'searched',
            objectApiName: 'Contact',
            label: 'Contact',
            counted: 350,
            records: [
              { id: '003000000000001AAA', name: 'Jane Doe', matchedBy: ['Email'] },
              { id: '003000000000002AAA', name: null, matchedBy: ['Email'] },
            ],
            truncated: true,
            searched: [{ fieldApiName: 'Email', label: 'Email', kind: 'email' }],
          },
        ],
      });
      await expect(page.getByTestId('dsr-object-truncated')).toBeVisible({ timeout: 10_000 });
      await page.getByTestId('dsr-review-btn').click();
      await bridge.waitForMessage('dataops:dsr:erase', { timeout: 10_000 });
      await answerAll(page, 'dataops:dsr:erase', 'dataops:dsr:erase:response', {
        requestId: '5b0a9b8c-3333-4000-8000-000000000000',
        mode: 'anonymize',
        dryRun: true,
        plan: [
          {
            objectApiName: 'Contact',
            label: 'Contact',
            records: 2,
            fields: [
              { fieldApiName: 'Email', label: 'Email', method: 'fake' },
              { fieldApiName: 'Fax', label: 'Fax', method: 'nullify' },
            ],
            kept: [{ fieldApiName: 'Birthdate', label: 'Birthdate' }],
          },
        ],
      });
      await expect(page.getByTestId('removal-plan-kept')).toBeVisible({ timeout: 10_000 });
      await answerAll(page, 'dataops:dsr:log', 'dataops:dsr:log:response', {
        entries: [
          {
            requestId: '5b0a9b8c-3333-4000-8000-000000000000',
            orgId: DEV_SANDBOX.id,
            openedAt: '2026-09-23T10:01:00.000Z',
            events: [
              {
                kind: 'searched',
                at: '2026-09-23T10:01:00.000Z',
                searchedBy: ['email'],
                objects: [{ objectApiName: 'Contact', found: 2, truncated: true }],
              },
              {
                kind: 'erased',
                at: '2026-09-23T10:02:00.000Z',
                mode: 'delete',
                outcome: 'stopped',
                operationId: 'op-1',
                objects: [],
              },
            ],
          },
        ],
      });
      await expect(page.getByTestId('dsr-log-entries')).toBeVisible({ timeout: 10_000 });

      await expectReadable(page, theme);
    });

    test('DataOps cleanup: every recommendation, a delete reviewed, and what the org refused', async ({
      page,
    }) => {
      await openPanel(bridge, page, 'dataops', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('dataops-page').waitFor({ timeout: 10_000 });
      await bridge.waitForMessage('backup:list', { timeout: 10_000 });
      await answerAll(page, 'backup:list', 'backup:list:result', { backups: [] });
      await answerAll(
        page,
        'dataops:anonymization-templates',
        'dataops:anonymization-templates:response',
        { templates: [] },
      );
      await page.getByTestId('page-tab-cleanup').click();
      await bridge.waitForMessage('seed:describe-global', { timeout: 10_000 });
      await answerAll(page, 'seed:describe-global', 'seed:describe-global:response', {
        objects: [{ apiName: 'Contact', label: 'Contact' }],
      });
      await page.getByTestId('cleanup-object-option-Contact').check();
      await page.getByTestId('cleanup-scan-btn').click();
      await bridge.waitForMessage('dataops:cleanup:scan', { timeout: 10_000 });
      await answerAll(page, 'dataops:cleanup:scan', 'dataops:cleanup:scan:response', {
        orgId: DEV_SANDBOX.id,
        staleDays: 365,
        scannedAt: '2026-09-23T10:00:00.000Z',
        orphanThreshold: 0.9,
        bounds: { duplicateGroupLimit: 2000, duplicateSample: 20, singleFieldQueries: 20 },
        objects: [
          {
            status: 'scanned',
            objectApiName: 'Contact',
            label: 'Contact',
            totalRecords: 4200,
            stale: { days: 365, records: 1300 },
            orphans: [
              {
                fieldApiName: 'AccountId',
                label: 'Account ID',
                referenceTo: 'Account',
                filled: 4150,
                empty: 50,
              },
            ],
            duplicates: {
              keyField: 'Email',
              keyLabel: 'Email',
              groups: [{ value: 'shared@example.com', count: 4 }],
              groupCount: 2000,
              recordCount: 4006,
              truncated: true,
            },
            keyFields: [
              { fieldApiName: 'Email', label: 'Email' },
              { fieldApiName: 'Phone', label: 'Business Phone' },
            ],
            errors: [
              {
                check: 'fill',
                message: 'QUERY_TIMEOUT: Your query request was running for too long.',
              },
            ],
          },
          {
            status: 'failed',
            objectApiName: 'Nope__c',
            message: 'INVALID_TYPE: sObject type is not supported.',
          },
        ],
      });
      await page.getByTestId('cleanup-stale-delete').click();
      await bridge.waitForMessage('dataops:cleanup:delete', { timeout: 10_000 });
      await answerAll(page, 'dataops:cleanup:delete', 'dataops:cleanup:delete:response', {
        objectApiName: 'Contact',
        dryRun: true,
        plan: {
          objectApiName: 'Contact',
          label: 'Contact',
          records: 1000,
          related: [{ objectApiName: 'Task', label: 'Task', records: 1200 }],
          uncounted: ['Actionable List Member'],
        },
        truncated: true,
      });
      await expect(page.getByTestId('cleanup-review-truncated')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('removal-plan-uncounted')).toBeVisible();

      await expectReadable(page, theme);
    });

    test('Analytics chart tooltips, on the Reports charts the panel does not feed yet', async ({
      page,
    }) => {
      await bridge.setup(page);
      await paintHostTheme(page, theme);
      await page.goto('/e2e/harness/unwired-reports.html');
      for (const chart of ['ops-chart', 'error-chart']) {
        const surface = page.getByTestId(chart).locator('.recharts-surface');
        await surface.scrollIntoViewIfNeeded();
        const box = await surface.boundingBox();
        if (!box) throw new Error(`${chart} has no box`);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await expect(page.getByTestId(chart).locator('.recharts-default-tooltip')).toBeVisible();

        await expectReadable(page, theme, `[data-testid="${chart}"]`);
      }
    });

    test('Lineage legend and edge labels, on every kind of node the Reports graph draws', async ({
      page,
    }) => {
      await bridge.setup(page);
      await paintHostTheme(page, theme);
      await page.goto('/e2e/harness/unwired-reports.html');
      const lineage = page.getByTestId('lineage-graph');
      await lineage.scrollIntoViewIfNeeded();
      await expect(lineage.locator('.react-flow__edge-text')).toHaveCount(3, { timeout: 10_000 });

      await expectReadable(page, theme, '[data-testid="lineage-graph"]');
    });
  });
}
