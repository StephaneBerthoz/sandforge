import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MockBridge, checkAccessibility, formatViolations } from './helpers';
import { themeContrastShortfalls } from './helpers/theme-contrast';
import { DEV_SANDBOX, MOCK_ORGS, QA_SANDBOX, type MockOrg } from './fixtures';
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

/** The German catalogue, as the extension answers `i18n:locale` with it. */
const DE_BUNDLE = JSON.parse(
  readFileSync(new URL('../src/i18n/locales/de.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

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
 * `graph.nodes` directly for the run's view, so the `{ graph: { objects: [...] } }`
 * shape the shared fixtures still hand out renders nothing at all.
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

/** The objects of {@link MOCK_GRAPH}, as `autopilot:objects-listed` lists them: no count. */
const MOCK_LISTING = MOCK_GRAPH.nodes.map(({ objectApiName }) => ({
  apiName: objectApiName,
  label: objectApiName,
  custom: false,
}));

/** An object of the source the target does not have: listed, said so, and not to be picked. */
const MISSING_IN_TARGET = {
  apiName: 'Shipment__c',
  label: 'Shipment',
  custom: true,
  missingInTarget: true,
};

/**
 * From the Autopilot object step to the plan: every listed object picked,
 * Next, and the scan of the selection answered with {@link MOCK_GRAPH} — which
 * asks for the plan at once, there being no compliance step between them.
 */
async function pickAutopilotObjectsAndScan(bridge: MockBridge, page: Page): Promise<void> {
  await page.getByTestId('select-all-checkbox').check();
  await page.getByTestId('seed-wizard-next').click();
  await bridge.respondToNext('autopilot:scan-schema', 'autopilot:schema-result', {
    graph: MOCK_GRAPH,
  });
  await bridge.waitForMessage('autopilot:generate-plan', { timeout: 5000 });
}

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
 * What verifying that run found: a contact in the recycle bin and one out of
 * sight, a case whose lookup points at another account than the run set, and
 * the account changed since the run.
 */
const FORGE_VERIFICATION = {
  verdict: 'partial',
  verifiedAt: '2026-09-23T09:00:00.000Z',
  attempts: 2,
  objects: [
    {
      objectApiName: 'Contact',
      expected: 2,
      present: 0,
      deleted: 1,
      notVisible: 1,
      changed: 0,
      changedRecords: [],
      deletedIds: [fakeId('003', 1)],
      notVisibleIds: [fakeId('003', 2)],
      linksChecked: 0,
      linksBroken: 0,
      brokenLinks: [],
    },
    {
      objectApiName: 'Case',
      expected: 1,
      present: 1,
      deleted: 0,
      notVisible: 0,
      changed: 0,
      changedRecords: [],
      deletedIds: [],
      notVisibleIds: [],
      linksChecked: 1,
      linksBroken: 1,
      brokenLinks: [
        {
          recordId: fakeId('500', 1),
          field: 'AccountId',
          expected: fakeId('001', 1),
          found: fakeId('001', 7),
        },
      ],
    },
    {
      objectApiName: 'Account',
      expected: 1,
      present: 1,
      deleted: 0,
      notVisible: 0,
      changed: 1,
      changedRecords: [{ recordId: fakeId('001', 1), modifiedAt: '2026-09-22T10:00:00.000+0000' }],
      deletedIds: [],
      notVisibleIds: [],
      linksChecked: 0,
      linksBroken: 0,
      brokenLinks: [],
    },
  ],
};

/**
 * The Frozen page's status once a load into the QA sandbox created an order
 * with its items, a contact and a technical placeholder, and linked the
 * standard price book and a selling model the sandbox already held.
 */
const FROZEN_LAST_LOAD_RECORDS = {
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
};

const FROZEN_STATUS_AFTER_LOAD = {
  configured: true,
  sasDir: '/home/dev/.sandforge-sas',
  datasetDir: '/home/dev/.sandforge-sas/dataset',
  salt: { present: true, fingerprint: 'abc123def456' },
  mockDetectionConfigured: true,
  selection: null,
  manifest: null,
  lastLoad: { status: 'completed', orgId: QA_SANDBOX.id, at: '2026-09-24T10:05:00.000Z' },
  lastLoads: [{ status: 'completed', orgId: QA_SANDBOX.id, at: '2026-09-24T10:05:00.000Z' }],
  lastVerifies: [],
  loadRecords: [FROZEN_LAST_LOAD_RECORDS],
};

/** What removing that load's records did: the Forge removal's outcomes, on a load. */
const FROZEN_REMOVAL_RESULT = {
  status: 'partial',
  includeChanged: false,
  finishedAt: '2026-09-24T11:00:00.000Z',
  objects: [
    ...FORGE_REMOVAL_RESULT.objects,
    // An order deleted with the file the org attached to it, which stays.
    {
      objectApiName: 'Order',
      planned: 1,
      deleted: 1,
      alreadyGone: 0,
      keptChanged: 0,
      keptDependents: 0,
      refused: 0,
      heldBy: [],
      unchecked: [],
      reasons: [],
      filesLeft: { count: 1, names: ['Confirmation-0001.pdf'] },
    },
  ],
};

/**
 * The removable run once that removal left part of its records in the org —
 * the contact changed since the run, the case the org refused and the account
 * the contact hangs from — which its entry offers to remove next.
 */
const FORGE_PARTLY_REMOVED_RUN = {
  ...FORGE_REMOVABLE_RUN,
  undo: {
    removedAt: FORGE_REMOVAL_RESULT.finishedAt,
    deleted: 1,
    alreadyGone: 0,
    kept: 2,
    refused: 1,
  },
  removalLeft: [fakeId('003', 1), fakeId('500', 1), fakeId('001', 1)],
};

/** What the removal of those three records did: each deleted, where the first left off. */
const FORGE_REMOVAL_OF_WHAT_WAS_LEFT = {
  ...FORGE_REMOVAL_RESULT,
  status: 'success',
  includeChanged: true,
  finishedAt: '2026-09-24T10:00:00.000Z',
  leftBy: FORGE_REMOVAL_RESULT.finishedAt,
  objects: FORGE_REMOVAL_RESULT.objects.map((object) => ({
    ...object,
    planned: 1,
    deleted: 1,
    keptChanged: 0,
    keptDependents: 0,
    refused: 0,
    heldBy: [],
    reasons: [],
  })),
};

/** The last load once a removal left part of its records in the org: its orders and their items. */
const FROZEN_STATUS_PARTLY_REMOVED = {
  ...FROZEN_STATUS_AFTER_LOAD,
  loadRecords: [
    {
      ...FROZEN_LAST_LOAD_RECORDS,
      created: [
        { objectApiName: 'OrderItem', count: 6 },
        { objectApiName: 'Order', count: 2 },
        { objectApiName: 'Account', count: 1 },
      ],
      removed: {
        removedAt: FROZEN_REMOVAL_RESULT.finishedAt,
        deleted: 29,
        alreadyGone: 0,
        kept: 3,
        refused: 6,
      },
    },
  ],
};

/**
 * A page of the audit trail as `reports:audit` answers it: a partial clone the
 * guard asked about, with an object it skipped before counting its records,
 * how it was set up and the user it wrote as, and a restore the guard refused.
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
        {
          objectApiName: 'Account',
          created: 3,
          updated: 0,
          deleted: 0,
          failed: 1,
          writtenWithoutFields: 1,
        },
        { objectApiName: 'Contact', created: 0, updated: 0, deleted: 0, failed: 0, upserted: 12 },
        {
          objectApiName: 'Contract',
          created: 0,
          updated: 0,
          deleted: 0,
          failed: 0,
          skipped: 'uncounted',
        },
      ],
      userId: 'sha256:0123456789ab',
      context: {
        anonymized: true,
        contactPoints: 'neutralized',
        reviewSkipped: true,
        simulatedMinutesBefore: 6,
        firedOnInsert: { flow: 2, trigger: 1, process: 0, workflowRule: 0, unread: [] },
        confirmed: ['automation', 'volume'],
        decisions: [{ kind: 'map_value', count: 2, rows: 9 }],
      },
      details: {},
      timestamp: '2026-09-12T10:00:00.000Z',
    },
    {
      id: 'audit-removal',
      action: 'cleanup_delete',
      module: 'frozen',
      orgId: '00D000000000001AAA',
      orgAlias: QA_SANDBOX.alias,
      operationId: 'op-3',
      outcome: 'success',
      guard: 'allowed',
      objects: [
        { objectApiName: 'OrderItem', created: 0, updated: 0, deleted: 6, failed: 0 },
        { objectApiName: 'Order', created: 0, updated: 0, deleted: 2, failed: 0 },
      ],
      leftBy: '2026-09-11T11:00:00.000Z',
      details: {},
      timestamp: '2026-09-11T12:00:00.000Z',
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
    modules: ['dataops', 'forge', 'frozen'],
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
/**
 * What a reload into the QA sandbox would do: accounts found by their keys,
 * the standard price book found in the catalog, contacts with a field and a
 * picklist value the target refuses, an error log it takes no insert of, and
 * what the purge would take of the two loads before it.
 */
const FROZEN_RELOAD_PLAN = {
  orgId: QA_SANDBOX.id,
  mode: { pilot: false, reload: true },
  plannedAt: '2026-10-09T10:00:00.000Z',
  perObject: [
    {
      objectApiName: 'Account',
      fromFiles: 3,
      toInsert: 1,
      reusedByKeys: 2,
      reusedFromCatalog: 0,
      fieldsDropped: 0,
      picklistsRewritten: 0,
      notSent: 0,
      toPurge: 4,
      toDeactivate: 0,
    },
    {
      objectApiName: 'Contact',
      fromFiles: 5,
      toInsert: 5,
      reusedByKeys: 0,
      reusedFromCatalog: 0,
      fieldsDropped: 1,
      picklistsRewritten: 2,
      notSent: 0,
      toPurge: 7,
      toDeactivate: 0,
      // What a preview cannot evaluate, listed beside the plan.
      validationRules: [
        { name: 'Trap_Email_Required', message: 'Email is required.', field: 'Email' },
        { name: 'Trap_Phone_Format', message: 'Phone must be written +33 X XX XX XX XX.' },
      ],
      // Named apart: no insert meets a rule that refuses only a change.
      validationRulesOnChange: ['Trap_Lead_Source_Locked'],
    },
    {
      objectApiName: 'ErrorLog__c',
      fromFiles: 1,
      toInsert: 0,
      reusedByKeys: 0,
      reusedFromCatalog: 0,
      fieldsDropped: 0,
      picklistsRewritten: 0,
      notSent: 1,
      toPurge: 0,
      toDeactivate: 0,
    },
  ],
  excludedObjects: [
    {
      objectApiName: 'ErrorLog__c',
      reason: 'Not createable in target org: 1 record of the dataset not loaded',
    },
  ],
  removals: [
    { objectApiName: 'Contact', field: 'Legacy__c', reason: 'not-in-target', affectedRecords: 5 },
  ],
  placeholders: [
    {
      objectApiName: 'Contact',
      field: 'Owner__c',
      placeholderObjectApiName: 'Owner__c',
      placeholderName: 'SANDFORGE-OWNER',
      affectedRecords: 5,
      // A placeholder goes in with its name alone, and one refused stops the load.
      validationRules: [{ name: 'Code_Required', message: 'A code is required.' }],
    },
  ],
  requiredDefaults: [
    { objectApiName: 'Account', field: 'Rating', affectedRecords: 1 },
    {
      objectApiName: 'BusinessHours',
      field: 'Name',
      affectedRecords: 2,
      perRecord: 'name',
      example: 'Frozen hours 1',
    },
  ],
  recordTypeIssues: 0,
  personContacts: 0,
  earlierLoads: 2,
  keptByThePlatform: { BusinessHours: 1 },
};

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
  lastLoads: [],
  lastVerifies: [],
};

/**
 * A pilot load's report: one object the target takes no insert of, contacts
 * the target refused, feed items a dataset extracted before their type was
 * kept could not load, the links it could not make after its inserts, and an
 * account the target took once written again without the fields it refused.
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
      objectApiName: 'Account',
      fromFiles: 1,
      inserted: 1,
      reused: 0,
      skippedDuplicates: [],
      failed: [],
      writtenWithoutFields: {
        rows: 1,
        fields: [
          {
            field: 'Rating__c',
            refusedBy: 'restricted-picklist',
            reason:
              'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value for restricted picklist field: Hot',
            rows: 1,
            replacedWith: 'Warm',
          },
          {
            field: 'Phone',
            refusedBy: 'validation-rule',
            reason: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone must be written +33…',
            rows: 1,
          },
        ],
      },
    },
    {
      objectApiName: 'Opportunity',
      fromFiles: 1,
      inserted: 1,
      reused: 0,
      skippedDuplicates: [],
      failed: [],
    },
    {
      objectApiName: 'Contact',
      fromFiles: 3,
      inserted: 0,
      reused: 0,
      skippedDuplicates: [],
      failed: ['Contact-000001', 'Contact-000002', 'Contact-000003'].map((referenceId) => ({
        objectApiName: 'Contact',
        referenceId,
        errors: [
          referenceId === 'Contact-000003'
            ? 'INVALID_EMAIL_ADDRESS: Email: invalid email address'
            : 'REQUIRED_FIELD_MISSING: Required fields are missing: [LastName]',
        ],
      })),
    },
    {
      objectApiName: 'RevenueTransactionErrorLog',
      fromFiles: 1,
      inserted: 0,
      reused: 0,
      skippedDuplicates: [],
      failed: [
        {
          objectApiName: 'RevenueTransactionErrorLog',
          referenceId: 'RevenueTransactionErrorLog-000001',
          errors: ['Not createable in target org: the running user may not insert it'],
        },
      ],
    },
  ],
  pass2: {
    resolved: 1,
    unresolved: [
      // A lookup left empty on the opportunity: the contact it names was refused.
      {
        objectApiName: 'Opportunity',
        referenceId: 'Opportunity-000001',
        field: 'ContactId',
        cause: 'target-not-loaded',
        detail: 'referenced record Contact-000002 was not loaded (skipped, failed or excluded)',
      },
      // One of a refused contact: it went with the contact.
      {
        objectApiName: 'Contact',
        referenceId: 'Contact-000001',
        field: 'ReportsToId',
        cause: 'record-not-loaded',
        detail: 'child record was not loaded (see perObject failures/skips)',
      },
    ],
  },
  personContact: {
    restored: 0,
    unresolved: [
      // The person account went in, and its contact was refused.
      {
        accountReferenceId: 'Account-000001',
        contactReferenceId: 'Contact-000003',
        cause: 'target-not-loaded',
        detail: 'contact Contact-000003 was not loaded (skipped, failed or excluded)',
      },
    ],
  },
  statuses: { restored: 0, refused: [] },
  purge: { deleted: {}, deactivated: {}, failures: [] },
  untypedFeedItems: [
    { objectApiName: 'FeedItem', count: 2, note: '2 feed items left out' },
    { objectApiName: 'FeedComment', count: 1, note: '1 left out' },
  ],
  heldForExcludedParents: [
    { objectApiName: 'InsurancePolicyParticipant', count: 2, note: '2 left out' },
  ],
  mappingPath: '/home/qa/.sandforge-sas/referenceid-mapping.json',
  contractPath: '/home/qa/.sandforge-sas/counting-contract.json',
};

/**
 * A reload's report: what its purge took of the earlier loads — deleted, or
 * deactivated — what it left in place of a load recorded before loads kept
 * what they created, and what the target would not let it purge, by why.
 */
const FROZEN_RELOAD_REPORT_WITH_PURGE = {
  status: 'completed-with-errors',
  orgId: QA_SANDBOX.id,
  mode: { pilot: false, reload: true },
  startedAt: '2026-09-21T11:00:00.000Z',
  durationMs: 9_000,
  alignment: { excludedObjects: [], removals: [], adjustments: [], recordTypeIssues: [] },
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
  purge: {
    deleted: { Contact: 2, Account: 1 },
    deactivated: { Product2: 1 },
    failures: [
      ...['500000000000001AAA', '500000000000002AAA'].map((recordId) => ({
        objectApiName: 'Case',
        recordId,
        errors: ['DELETE_FAILED: Your attempt to delete this record failed'],
      })),
      {
        objectApiName: 'Order',
        recordId: '801000000000001AAA',
        errors: [
          'Status set to Draft for the purge, and left there: Activated could not be given back — INVALID_STATUS',
        ],
      },
    ],
    leftUnrecorded: { Account: 3 },
  },
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
/** A compliance report as the extension answers it: one personal field written as it is. */
const FORGE_COMPLIANCE_REPORT = {
  id: 'rpt-axe',
  framework: 'gdpr',
  generatedAt: '2026-10-01T10:00:00.000Z',
  sourceOrgId: 'org-src-1',
  targetOrgId: 'org-tgt-1',
  totalFieldsScanned: 24,
  piiFieldsDetected: 3,
  piiFieldsAnonymized: 2,
  entries: [],
  objectSummaries: [],
  overallStatus: 'partial',
  checksumSha256: 'a'.repeat(64),
};

/**
 * A pipeline an older release saved with a webhook trigger, which the panel no
 * longer adds and which starts nothing.
 */
const PIPELINE_WITH_A_WEBHOOK_TRIGGER = {
  id: 'pipe-webhook',
  name: 'Refresh QA on a webhook',
  description: '',
  version: 1,
  steps: [
    { id: 'step-w', name: 'Wait', type: 'delay', config: { seconds: 0 }, continueOnError: false },
  ],
  triggers: [{ id: 'trig-webhook', type: 'webhook', enabled: true, config: {} }],
  variables: [],
  tags: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

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

/**
 * Create a conversation on the AI page and confirm it as the host does,
 * naming the request that asked for it: the conversation takes the place of
 * the entry the page made for that request.
 */
async function createConversation(
  bridge: MockBridge,
  page: Page,
  id: string,
  title: string,
): Promise<void> {
  await page.getByTestId('new-conversation-btn').click();
  const [request] = (await bridge.getMessages('ai:conversation:create')).slice(-1);
  await bridge.respond(
    'ai:conversation:created',
    { conversation: { id, title, createdAt: new Date().toISOString() } },
    String(request?.id),
  );
  await page.getByTestId(`conversation-item-${id}`).waitFor({ state: 'visible', timeout: 5000 });
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
  // The card shows the load into the target the tab has selected: the org
  // the records name, which the panel did not select first.
  const [records] = (status.loadRecords as Array<{ orgId: string }> | undefined) ?? [];
  if (records) {
    await page.getByTestId('frozen-load-target').click();
    await page.getByTestId(`frozen-load-target-option-${records.orgId}`).click();
  }
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
 * What the target holds against that account and its contacts, as a
 * simulation finds it: a picklist value refused, a field only the target
 * requires, a text longer than its field, and a rule that refuses nothing.
 */
const FORGE_GAPS = [
  {
    id: 'picklist_value_refused|Account|Type||Prospect',
    kind: 'picklist_value_refused',
    severity: 'blocking',
    source: 'simulation',
    objectApiName: 'Account',
    field: 'Type',
    value: 'Prospect',
    rows: 1,
    detail: { allowedValues: ['Customer', 'Partner'] },
    decisions: ['map_value', 'leave_empty', 'exclude_object', 'ignore'],
    defaultDecision: 'map_value',
  },
  {
    id: 'required_field_missing|Contact|Region__c||',
    kind: 'required_field_missing',
    severity: 'blocking',
    source: 'simulation',
    objectApiName: 'Contact',
    field: 'Region__c',
    rows: 2,
    decisions: ['set_default', 'exclude_object'],
  },
  {
    id: 'value_too_long|Account|Description||',
    kind: 'value_too_long',
    severity: 'warning',
    source: 'simulation',
    objectApiName: 'Account',
    field: 'Description',
    rows: 1,
    detail: { maxLength: 255 },
    decisions: ['truncate', 'ignore'],
  },
  {
    id: 'validation_rule|Account|Phone||Phone_Format',
    kind: 'validation_rule',
    severity: 'warning',
    source: 'simulation',
    objectApiName: 'Account',
    field: 'Phone',
    value: 'Phone_Format',
    rows: 0,
    // A bypass the user does not hold: the permission set that holds it, and
    // the command that assigns it, with its copy button.
    detail: {
      message: 'The phone needs a country code.',
      bypasses: ['$Permission.Phone_Bypass'],
      assign: ['Phone_Bypass=Data_Load,Integration'],
    },
    decisions: ['leave_empty', 'ignore'],
  },
];

/**
 * What a target runs on that account and its contacts, as the extension reads
 * it at Review: a flow after a contact is created that a custom permission
 * keeps quiet, which sends an email and runs again after commit, one whose
 * start condition names a permission otherwise, one whose condition the read
 * left past its bound, a process that sends a text message, a workflow rule
 * left unread, a trigger, a flow before a delete, duplicate rules, a lead's
 * assignment rule, and start conditions the org refused.
 */
const FORGE_TARGET_AUTOMATION = {
  objectsRead: ['Account', 'Contact'],
  objects: [
    {
      objectApiName: 'Account',
      flows: [
        {
          apiName: 'Account_Guard',
          label: 'Account guard',
          timing: 'beforeDelete',
          startsOn: 'delete',
          condition: 'notRead',
          permissions: [],
        },
      ],
      triggers: [{ name: 'AccountTrigger', events: ['beforeInsert', 'afterUpdate'] }],
      duplicateRules: [{ name: 'Account names', developerName: 'Account_Names' }],
    },
    {
      objectApiName: 'Contact',
      flows: [
        {
          apiName: 'Contact_Welcome_Email',
          label: 'Contact welcome email',
          timing: 'afterSave',
          startsOn: 'create',
          condition: 'read',
          permissions: [{ name: 'Load_Data', bypass: true }],
          messages: [{ kind: 'email', name: 'Welcome email' }],
          paths: [{ kind: 'async' }, { kind: 'scheduled', offset: 2, unit: 'Days' }],
        },
        {
          apiName: 'Contact_Sync',
          label: 'Contact sync',
          timing: 'afterSave',
          startsOn: 'createAndUpdate',
          condition: 'unreadable',
          permissions: [],
        },
        {
          apiName: 'Contact_Priority',
          label: 'Contact priority',
          timing: 'beforeSave',
          startsOn: 'create',
          condition: 'read',
          permissions: [{ name: 'Run_Priority', bypass: false }],
        },
      ],
      triggers: [],
      processes: [
        {
          apiName: 'Contact_Routing',
          label: 'Contact routing',
          timing: 'afterSave',
          startsOn: 'createAndUpdate',
          condition: 'read',
          permissions: [],
          messages: [{ kind: 'sms', name: 'Send SMS', guessed: true }],
        },
      ],
      workflowRules: [
        {
          apiName: 'Contact rule',
          label: 'Contact rule',
          timing: 'afterSave',
          startsOn: 'createAndUpdate',
          condition: 'notRead',
          permissions: [],
        },
      ],
    },
    {
      objectApiName: 'Lead',
      flows: [],
      triggers: [],
      assignmentRules: [{ name: 'Lead routing' }],
    },
  ],
  unread: [{ part: 'conditions', reason: 'INSUFFICIENT_ACCESS: insufficient access rights' }],
  conditionsNotRead: 1,
  conditionsBound: 25,
  requests: 6,
};

/**
 * More objects than `auto` draws as a graph, so both screens list them: an
 * account and thirty objects under it — one left out, one whose size was
 * never measured, one discovery could not read, and personal fields on some.
 */
const FORGE_WIDE_GRAPH = {
  ...FORGE_RUN_GRAPH,
  nodes: [
    FORGE_RUN_GRAPH.nodes[0],
    ...Array.from({ length: 30 }, (_, i) => ({
      ...FORGE_RUN_GRAPH.nodes[0],
      objectApiName: `Related${String(i + 1)}__c`,
      recordCount: i + 1,
      level: 1,
      included: i !== 2,
      ...(i === 3 ? { fieldCount: 0, createableFieldCount: 0 } : {}),
      ...(i === 4 ? { errors: ['INSUFFICIENT_ACCESS: cannot count this object'] } : {}),
      ...(i % 5 === 0 ? { piiFields: ['Email__c'], anonymizeFields: ['Email__c'] } : {}),
    })),
  ],
  totalRecords: 466,
};

/**
 * Start a Forge run of that graph from the SOQL tab, up to its execution
 * screen, and give back the id of its `forge:execute` request: what the
 * extension correlates the run's progress and its answer to.
 */
async function startForgeRun(
  bridge: MockBridge,
  page: Page,
  theme: ScannedTheme,
  graph: Record<string, unknown> = FORGE_TWO_NODE_GRAPH,
): Promise<string> {
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
  const request = await bridge.waitForMessage('forge:execute', { timeout: 10_000 });
  return String(request.id);
}

/** The extension saying where the run stands on one object, in the line it wrote when it did. */
async function forgeProgress(
  page: Page,
  request: string,
  objectName: string,
  status: 'done' | 'error' | 'stopped',
  message?: string,
): Promise<void> {
  await sendExtensionMessage(page, {
    type: 'forge:progress',
    id: `progress-${objectName}`,
    correlationId: request,
    payload: { objectName, status, progress: 100, ...(message ? { message } : {}) },
  });
}

/** The Forge discovery of that graph, from the SOQL tab, as it first shows it. */
async function discoverForgeGraph(
  bridge: MockBridge,
  page: Page,
  theme: ScannedTheme,
  graph: Record<string, unknown> = FORGE_TWO_NODE_GRAPH,
): Promise<void> {
  await navigateToModule(bridge, page, 'forge', 'forge-page', { theme, orgs: true });
  await page.getByTestId('forge-tab-soql').click();
  await page.getByTestId('forge-input-soql').fill(FORGE_AI_DRAFT);
  await page.getByTestId('forge-target-org').click();
  await page.getByTestId(`forge-target-org-option-${QA_SANDBOX.id}`).click();
  await page.getByTestId('forge-discover-btn').click();
  await page.waitForSelector('[data-testid="forge-discovery-loading"]', { timeout: 10_000 });
  await answerAll(page, 'forge:discover', 'forge:discover:response', { graph });
  await page.getByTestId('forge-discovery').waitFor({ timeout: 10_000 });
}

/** The test id of the Forge graph's pane. */
const FORGE_GRAPH = 'live-graph';

/** The test id of the Autopilot graph's pane. */
const AUTOPILOT_GRAPH = 'autopilot-graph';

/** React Flow's minimap, as drawn on a graph's pane. */
const MINIMAP = '.react-flow__minimap';

/** How React Flow places the graph drawn in the pane `graph`: its viewport's transform. */
async function graphTransform(page: Page, graph: string): Promise<string> {
  return page
    .getByTestId(graph)
    .locator('.react-flow__viewport')
    .evaluate((element) => (element as HTMLElement).style.transform);
}

/**
 * Wait until React Flow has fitted the graph of the pane `graph`: the
 * viewport holds still between two reads, and has left where React Flow
 * starts it.
 */
async function graphFitted(page: Page, graph: string): Promise<void> {
  let last: string | null = null;
  await expect
    .poll(
      async () => {
        const now = await graphTransform(page, graph);
        const still = now === last && now !== 'translate(0px, 0px) scale(1)';
        last = now;
        return still;
      },
      { intervals: [250], timeout: 10_000 },
    )
    .toBe(true);
}

/**
 * The height of the pane `graph`, as Chromium lays it out. The Forge graph's
 * wrapper gave it a minimum and no height, so the pane took the height of the
 * panel beside it: 52px on discovery at 1280×720, under a minimap of 150.
 */
async function graphPaneHeight(page: Page, graph: string): Promise<number> {
  const box = await page.getByTestId(graph).boundingBox();
  return box?.height ?? 0;
}

/**
 * The objects of the graph of the pane `graph` that `overlay` — the minimap,
 * or a legend or controls drawn on the pane — is drawn over, as Chromium lays
 * them out: each box cut to the pane, which hides what is drawn past its
 * edges.
 */
async function nodesUnder(page: Page, graph: string, overlay: string): Promise<string[]> {
  return page.evaluate(
    ({ testId, selector }) => {
      const pane = document.querySelector(`[data-testid="${testId}"]`);
      const drawnOver = pane?.querySelector(selector);
      if (!pane || !drawnOver) return [`no ${testId}, or nothing in it at ${selector}`];
      const paneBox = pane.getBoundingClientRect();
      const inPane = (element: Element) => {
        const box = element.getBoundingClientRect();
        return {
          left: Math.max(box.left, paneBox.left),
          top: Math.max(box.top, paneBox.top),
          right: Math.min(box.right, paneBox.right),
          bottom: Math.min(box.bottom, paneBox.bottom),
        };
      };
      const over = inPane(drawnOver);
      return [...pane.querySelectorAll('.react-flow__node')]
        .filter((node) => {
          const box = inPane(node);
          return (
            box.left < over.right &&
            over.left < box.right &&
            box.top < over.bottom &&
            over.top < box.bottom
          );
        })
        .map((node) => node.getAttribute('data-id') ?? '');
    },
    { testId: graph, selector: overlay },
  );
}

/**
 * How far the dots of the background of the pane `graph` stand out from what
 * lies under them, as a contrast ratio of the colours Chromium paints: the
 * dot's fill composited over the backgrounds of the pane and of everything it
 * sits in. axe does not look at them: they are decoration, and no text.
 */
async function backgroundDotsContrast(page: Page, graph: string): Promise<number> {
  return page.getByTestId(graph).evaluate((pane) => {
    type Rgba = [number, number, number, number];
    const parse = (text: string): Rgba => {
      const parts =
        /rgba?\(([^)]+)\)/
          .exec(text)?.[1]
          ?.split(/[\s,/]+/)
          .filter(Boolean) ?? [];
      const [r = 0, g = 0, b = 0] = parts.slice(0, 3).map(Number);
      return [r, g, b, parts[3] === undefined ? 1 : Number(parts[3])];
    };
    const over = (top: Rgba, under: Rgba): Rgba => [
      top[0] * top[3] + under[0] * (1 - top[3]),
      top[1] * top[3] + under[1] * (1 - top[3]),
      top[2] * top[3] + under[2] * (1 - top[3]),
      1,
    ];
    const luminance = ([r, g, b]: Rgba): number => {
      const channel = (value: number): number => {
        const s = value / 255;
        return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const dot = pane.querySelector('.react-flow__background-pattern.dots');
    if (!dot) throw new Error('the pane draws no background dots');
    // The backgrounds from the page down to the background's own layer.
    const layers: Rgba[] = [];
    for (let at: Element | null = dot.closest('svg'); at; at = at.parentElement) {
      layers.unshift(parse(getComputedStyle(at).backgroundColor));
    }
    const under = layers.reduce<Rgba>((below, layer) => over(layer, below), [255, 255, 255, 1]);
    const drawn = over(parse(getComputedStyle(dot).fill), under);
    const [light, dark] = [luminance(drawn), luminance(under)].sort((a, b) => b - a);
    return (light + 0.05) / (dark + 0.05);
  });
}

/** What the Autopilot graph's pane draws over its graph: the minimap, the legend and the controls. */
const AUTOPILOT_GRAPH_OVERLAYS = [
  MINIMAP,
  '[data-testid="graph-legend"]',
  '[data-testid="graph-controls"]',
] as const;

/** Each overlay of the Autopilot graph, with the objects it is drawn over. */
async function autopilotNodesUnderItsOverlays(page: Page): Promise<Record<string, string[]>> {
  const under: Record<string, string[]> = {};
  for (const overlay of AUTOPILOT_GRAPH_OVERLAYS) {
    under[overlay] = await nodesUnder(page, AUTOPILOT_GRAPH, overlay);
  }
  return under;
}

/** The Autopilot run of the two objects of its mock graph, under way: its execute left unanswered. */
async function startAutopilotRun(
  bridge: MockBridge,
  page: Page,
  theme: ScannedTheme,
): Promise<void> {
  await navigateToModule(bridge, page, 'autopilot', 'autopilot-page', { theme, orgs: true });
  await page.getByTestId('source-org-org-src-1').click();
  await page.getByTestId('target-org-org-tgt-1').click();
  await page.getByTestId('seed-wizard-next').click();
  await bridge.respondToNext('autopilot:list-objects', 'autopilot:objects-listed', {
    objects: MOCK_LISTING,
  });
  await page.getByTestId('step2-objects').waitFor({ state: 'visible', timeout: 5000 });
  await pickAutopilotObjectsAndScan(bridge, page);
  await bridge.respondToNext('autopilot:generate-plan', 'autopilot:plan-ready', {
    plan: MOCK_PLAN,
    graph: MOCK_GRAPH,
  });
  await page.getByTestId('execute-button').click();
  await bridge.waitForMessage('autopilot:execute', { timeout: 10_000 });
  await page.getByTestId(AUTOPILOT_GRAPH).waitFor({ timeout: 10_000 });
}

/**
 * The Forge page with its recent runs listed: one run whose records can be
 * removed — all it created, or what a removal left of them.
 */
async function openForgeHistory(
  bridge: MockBridge,
  page: Page,
  theme: ScannedTheme,
  run: typeof FORGE_REMOVABLE_RUN = FORGE_REMOVABLE_RUN,
): Promise<void> {
  await navigateToModule(bridge, page, 'forge', 'forge-page', { theme, orgs: true });
  await bridge.waitForMessage('forge:history:list', { timeout: 10_000 });
  await answerAll(page, 'forge:history:list', 'forge:history:list:response', {
    history: [run],
  });
  await page.getByTestId(`forge-history-remove-${run.forgeId}`).waitFor({ timeout: 10_000 });
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

    test('Organizations disconnect asking whether the org’s backups on this machine go with it', async ({
      page,
    }) => {
      await navigateToModule(bridge, page, 'orgs', 'org-manager-page', { theme, orgs: true });
      await page.getByText('Disconnect').first().click();
      await bridge.waitForMessage('backup:list', { timeout: 10_000 });
      await answerAll(page, 'backup:list', 'backup:list:result', {
        backups: [{ operationId: 'bk-1' }, { operationId: 'bk-2' }],
      });
      await expect(page.getByTestId('disconnect-delete-backups')).toBeVisible();

      const results = await checkAccessibility(page);
      expectNoViolations(results);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="danger-title"]'),
      ).toBeGreaterThan(0);
    });

    test('Forge page', async ({ page }) => {
      await navigateToModule(bridge, page, 'forge', 'forge-page', { theme, orgs: true });
      const results = await checkAccessibility(page);
      expectNoViolations(results);
    });

    test('Forge custom depth, capped at what discovery accepts, with the reason under it', async ({
      page,
    }) => {
      await navigateToModule(bridge, page, 'forge', 'forge-page', { theme, orgs: true });
      await page.getByTestId('forge-depth-custom').click();
      // The field went up to 20, and discovery refused anything past 10.
      const input = page.getByTestId('forge-depth-custom-input');
      await input.fill('15');
      await expect(input).toHaveValue('10');
      await expect(page.getByTestId('forge-depth-custom-hint')).toContainText('Up to 10 levels');
      expectNoViolations(await checkAccessibility(page));

      // 0 and decimals were passed on, and discovery refused them.
      await input.fill('2.5');
      await expect(input).toHaveAttribute('aria-invalid', 'true');
      await expect(page.getByTestId('forge-depth-custom-error')).toHaveText(
        'Enter a whole number from 1 to 10.',
      );
      const refused = await checkAccessibility(page);
      expectNoViolations(refused);
      expect(
        await contrastMeasuredIn(page, refused, '[data-testid="forge-depth-custom-error"]'),
      ).toBeGreaterThan(0);
      await input.blur();
      await expect(input).toHaveValue('10');
      await expect(page.getByTestId('forge-depth-custom-error')).toHaveCount(0);
    });

    test('Forge options keeping emails and phone numbers as they are, and the warning it gives', async ({
      page,
    }) => {
      await navigateToModule(bridge, page, 'forge', 'forge-page', { theme, orgs: true });
      const toggle = page.getByTestId('forge-keep-contact-points-toggle');
      await expect(toggle).not.toBeChecked();
      expectNoViolations(await checkAccessibility(page));

      await toggle.check({ force: true });
      await page.waitForSelector('[data-testid="forge-keep-contact-points-warning"]', {
        timeout: 10_000,
      });
      const results = await checkAccessibility(page);
      expectNoViolations(results);
      expect(
        await contrastMeasuredIn(
          page,
          results,
          '[data-testid="forge-keep-contact-points-warning"]',
        ),
      ).toBeGreaterThan(0);
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

    test('Forge Template tab exporting a template, and refusing a file that holds none', async ({
      page,
    }) => {
      await navigateToModule(bridge, page, 'forge', 'forge-page', { theme, orgs: true });
      await bridge.waitForMessage('forge:templates:list', { timeout: 10_000 });
      await answerAll(page, 'forge:templates:list', 'forge:templates:list:response', {
        templates: [FORGE_SAVED_TEMPLATE],
      });
      await page.getByTestId('forge-tab-template').click();
      await page.getByTestId(`forge-template-export-${FORGE_SAVED_TEMPLATE.id}`).click();
      const saved = await bridge.waitForMessage('file:save', { timeout: 10_000 });
      expect(JSON.parse((saved.payload as { content: string }).content)).toEqual(
        FORGE_SAVED_TEMPLATE,
      );

      await page.getByTestId('forge-template-import-file').setInputFiles({
        name: 'not-a-template.json',
        mimeType: 'application/json',
        buffer: Buffer.from('{"id":"tpl-x"}'),
      });
      await expect(page.getByTestId('forge-template-import-refused')).toHaveText(
        'This file is not a SandForge template: name is missing or not valid.',
      );
      const refused = await checkAccessibility(page);
      expectNoViolations(refused);
      expect(
        await contrastMeasuredIn(page, refused, '[data-testid="forge-template-import-refused"]'),
      ).toBeGreaterThan(0);
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

    for (const [name, contactPoints] of [
      [
        'the emails and phone numbers the run neutralized',
        {
          neutralized: true,
          fields: [
            { objectApiName: 'Account', field: 'Phone', kind: 'phone', values: 1 },
            { objectApiName: 'Account', field: 'Billing_Email__c', kind: 'email', values: 1 },
          ],
          values: 2,
        },
      ],
      [
        'that the run kept the emails and phone numbers as read',
        { neutralized: false, fields: [], values: 0 },
      ],
    ] as const) {
      test(`Forge results saying ${name}`, async ({ page }) => {
        await startForgeRun(bridge, page, theme, FORGE_RUN_GRAPH);
        await answerAll(page, 'forge:execute', 'forge:execute:response', {
          result: {
            forgeId: 'forge-run-contact-points',
            status: 'success',
            graph: FORGE_RUN_GRAPH,
            duration: 2_000,
            timestamp: '2026-09-01T08:00:00.000Z',
            idRemapCount: 1,
            createdCount: 1,
            readByObject: [{ objectApiName: 'Account', read: 1 }],
            contactPoints,
          },
        });
        await page.waitForSelector('[data-testid="forge-results-contact-points"]', {
          timeout: 10_000,
        });
        const results = await checkAccessibility(page);
        expectNoViolations(results);
        expect(
          await contrastMeasuredIn(page, results, '[data-testid="forge-results-contact-points"]'),
        ).toBeGreaterThan(0);
      });
    }

    test('Forge results of a stopped run, offering to take it up where it stopped', async ({
      page,
    }) => {
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
          forgeId: 'forge-run-stopped',
          status: 'partial',
          cancelled: true,
          resumable: true,
          graph: FORGE_RUN_GRAPH,
          duration: 2_000,
          timestamp: '2026-09-01T08:00:00.000Z',
          idRemapCount: 1,
          createdCount: 1,
          readByObject: [{ objectApiName: 'Account', read: 1 }],
          errors: [],
        },
      });
      await page.waitForSelector('[data-testid="forge-resume"]', { timeout: 10_000 });
      await expect(page.getByTestId('forge-resume-hint')).toBeVisible();
      const results = await checkAccessibility(page);
      expectNoViolations(results);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="forge-resume-hint"]'),
      ).toBeGreaterThan(0);
    });

    test('Forge results of a run whose ids are in its journal, saying where they are and saving its Id map from there', async ({
      page,
    }) => {
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
          forgeId: 'forge-run-journal',
          status: 'success',
          graph: FORGE_RUN_GRAPH,
          duration: 2_000,
          timestamp: '2026-09-01T08:00:00.000Z',
          idRemapCount: 60_000,
          idRemapTable: {},
          idRemapExisting: [],
          idRemapCreated: [],
          idRemapByObject: [{ objectApiName: 'Account', created: 60_000, linked: 0 }],
          createdCount: 60_000,
          remapInJournal: true,
          journalId: 'forge-run-1',
          journalPart: 0,
          readByObject: [{ objectApiName: 'Account', read: 60_000 }],
          errors: [],
        },
      });
      await page.waitForSelector('[data-testid="forge-id-mapping-journal"]', { timeout: 10_000 });
      await expect(page.getByTestId('forge-save-id-map-journal')).toBeVisible();
      const results = await checkAccessibility(page);
      expectNoViolations(results);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="forge-id-mapping-journal"]'),
      ).toBeGreaterThan(0);
    });

    test('Forge recent runs saying the journal of a run is gone, and offering it no removal', async ({
      page,
    }) => {
      await navigateToModule(bridge, page, 'forge', 'forge-page', { theme, orgs: true });
      await bridge.waitForMessage('forge:history:list', { timeout: 10_000 });
      await answerAll(page, 'forge:history:list', 'forge:history:list:response', {
        history: [
          {
            ...FORGE_REMOVABLE_RUN,
            forgeId: 'forge-run-journal-gone',
            idRemapTable: {},
            idRemapExisting: [],
            idRemapCreated: [],
            idRemapByObject: [{ objectApiName: 'Account', created: 60_000, linked: 0 }],
            createdCount: 60_000,
            remapInJournal: true,
            journalId: 'forge-run-1',
            journalPart: 0,
            journalGone: true,
          },
        ],
      });
      await page
        .getByTestId('forge-history-journal-gone-forge-run-journal-gone')
        .waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('forge-history-remove-forge-run-journal-gone')).toHaveCount(0);
      const results = await checkAccessibility(page);
      expectNoViolations(results);
      expect(
        await contrastMeasuredIn(
          page,
          results,
          '[data-testid="forge-history-journal-gone-forge-run-journal-gone"]',
        ),
      ).toBeGreaterThan(0);
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

      // Cancelled at the gate, the retry wrote nothing: back to the results it
      // was started from, which still offer it, with why it stopped.
      await sendExtensionMessage(page, {
        type: 'forge:execute:error',
        id: 'err-forge-retry-gate',
        correlationId: String(runs[1].id),
        payload: {
          message: 'Forge execution was cancelled at the confirmation of what the target org runs.',
          code: 'AUTOMATION_DECLINED',
          retryable: true,
          gate: { code: 'AUTOMATION_DECLINED' },
        },
      });
      await page.getByTestId('forge-run-gate-notice').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('forge-results')).toBeVisible();
      await expect(page.getByTestId('forge-retry-failed')).toBeVisible();
      const stopped = await checkAccessibility(page);
      expectNoViolations(stopped);
      expect(
        await contrastMeasuredIn(page, stopped, '[data-testid="forge-run-gate-notice"]'),
      ).toBeGreaterThan(0);
    });

    test('Forge results acting on the run: opening a record, retrying, removing its records', async ({
      page,
    }) => {
      await startForgeRun(bridge, page, theme, FORGE_RUN_GRAPH);
      const acted = { ...FORGE_REMOVABLE_RUN, forgeId: 'forge-run-acted' };
      await answerAll(page, 'forge:execute', 'forge:execute:response', {
        result: {
          ...acted,
          readByObject: [{ objectApiName: 'Account', read: 1 }],
          errors: [
            {
              objectApiName: 'Invoice__c',
              stage: 'scope',
              failedCount: 0,
              attemptedCount: 0,
              skipped: true,
              samples: [
                {
                  recordSummary: '(node-level skip)',
                  messages: ['Object is not createable on target org'],
                },
              ],
            },
            {
              objectApiName: 'Contact',
              stage: 'insert',
              failedCount: 1,
              attemptedCount: 3,
              samples: [
                {
                  recordSummary: 'LastName=Doe',
                  messages: ['REQUIRED_FIELD_MISSING: Required fields are missing: [AccountId]'],
                },
              ],
            },
          ],
        },
      });
      await page.waitForSelector('[data-testid="forge-results"]', { timeout: 10_000 });
      await expect(page.getByTestId('forge-id-mapping-open').first()).toBeVisible();
      await expect(page.getByTestId('forge-save-id-map')).toBeVisible();
      await expect(page.getByTestId('forge-retry-parents')).toBeVisible();
      await expect(page.getByTestId('forge-results-remove')).toBeVisible();
      expectNoViolations(await checkAccessibility(page));

      await page.getByTestId('forge-id-mapping-open').first().click();
      await bridge.waitForMessage('forge:open-record', { timeout: 10_000 });
      await answerAll(page, 'forge:open-record', 'forge:open-record:response', {
        status: 'error',
        message: 'VS Code did not open the page.',
      });
      await expect(page.getByTestId('forge-id-mapping-open-status')).toContainText(
        'VS Code did not open the page.',
      );
      expectNoViolations(await checkAccessibility(page));

      await page.getByTestId('forge-results-remove').click();
      await page
        .getByRole('dialog', { name: `Remove this run's records from ${QA_SANDBOX.alias}` })
        .waitFor({ state: 'visible', timeout: 5000 });
      expectNoViolations(await checkAccessibility(page));

      await page.getByTestId('danger-input').fill(QA_SANDBOX.alias);
      await page.getByTestId('danger-confirm-btn').click();
      await bridge.waitForMessage('forge:undo', { timeout: 10_000 });
      // The results read the run back from the history once the removal has
      // answered, a render later, and offer nothing until that read answers.
      // The form asked for the history as the page opened: waiting for "a"
      // history read returned that one at once, and under load the results'
      // own read was posted after every read there was had been answered.
      const historyReads = (await bridge.getMessages('forge:history:list')).length;
      await answerAll(page, 'forge:undo', 'forge:undo:response', {
        result: { ...FORGE_REMOVAL_RESULT, forgeId: acted.forgeId },
        operationId: 'forge-undo-1',
      });
      await expect
        .poll(async () => (await bridge.getMessages('forge:history:list')).length)
        .toBeGreaterThan(historyReads);
      await answerAll(page, 'forge:history:list', 'forge:history:list:response', {
        history: [{ ...FORGE_PARTLY_REMOVED_RUN, forgeId: acted.forgeId }],
      });
      await expect(page.getByTestId('forge-results-remove')).toHaveText(
        "Remove what is left of this run's records",
      );
      await expect(page.getByTestId('forge-removal-result')).toBeVisible();
      await expect(page.getByTestId('forge-retry-failed')).toHaveCount(0);
      expectNoViolations(await checkAccessibility(page));
    });

    test('Forge results saying what Records per object stopped, opening the record cloned, a removal under way with its Stop, and what it did not look for', async ({
      page,
    }) => {
      await startForgeRun(bridge, page, theme, FORGE_RUN_GRAPH);
      const capped = { ...FORGE_REMOVABLE_RUN, forgeId: 'forge-run-capped' };
      await answerAll(page, 'forge:execute', 'forge:execute:response', {
        result: {
          ...capped,
          readByObject: [{ objectApiName: 'Account', read: 1 }],
          cappedObjects: { perObject: 100, objects: ['Case', 'Contact'] },
        },
      });
      await page.waitForSelector('[data-testid="forge-results"]', { timeout: 10_000 });
      await expect(page.getByTestId('forge-results-capped')).toContainText(
        'Stopped at 100 per object: Case, Contact.',
      );
      await expect(page.getByTestId('forge-results-open-root-btn')).toHaveText(
        `Open the Account cloned in ${QA_SANDBOX.alias}`,
      );
      const shown = await checkAccessibility(page);
      expectNoViolations(shown);
      expect(
        await contrastMeasuredIn(page, shown, '[data-testid="forge-results-capped"]'),
      ).toBeGreaterThan(0);

      await page.getByTestId('forge-results-remove').click();
      await page
        .getByRole('dialog', { name: `Remove this run's records from ${QA_SANDBOX.alias}` })
        .waitFor({ state: 'visible', timeout: 5000 });
      await page.getByTestId('danger-input').fill(QA_SANDBOX.alias);
      await page.getByTestId('danger-confirm-btn').click();
      const removal = await bridge.waitForMessage('forge:undo', { timeout: 10_000 });
      await expect(page.getByTestId('forge-results-removing-stop')).toBeVisible();
      expectNoViolations(await checkAccessibility(page));

      // The removal runs under the request's id, which the Stop names.
      await page.getByTestId('forge-results-removing-stop').click();
      const abort = await bridge.waitForMessage('execution:abort', { timeout: 10_000 });
      expect(abort.payload).toEqual({ operationId: removal.id });
      await expect(page.getByTestId('forge-results-removing')).toContainText('Stopping');
      expectNoViolations(await checkAccessibility(page));

      await answerAll(page, 'forge:undo', 'forge:undo:response', {
        result: {
          ...FORGE_REMOVAL_RESULT,
          forgeId: capped.forgeId,
          status: 'cancelled',
          mayHaveBeenWritten: 3,
          notLookedFor: { notJournaled: 2, callsAfterRemoval: 1 },
        },
        operationId: String(removal.id),
      });
      await expect(page.getByTestId('forge-removal-not-journaled')).toBeVisible();
      await expect(page.getByTestId('forge-removal-calls-not-looked-for')).toBeVisible();
      const said = await checkAccessibility(page);
      expectNoViolations(said);
      expect(
        await contrastMeasuredIn(page, said, '[data-testid="forge-removal-calls-not-looked-for"]'),
      ).toBeGreaterThan(0);
      expect(
        await contrastMeasuredIn(page, said, '[data-testid="forge-removal-not-journaled"]'),
      ).toBeGreaterThan(0);
    });

    test('Forge Review of one record’s graph: its counts the source tables’, the gaps no decision answers beside Execute and its question, and anonymization turned on from its tab', async ({
      page,
    }) => {
      await navigateToModule(bridge, page, 'forge', 'forge-page', { theme, orgs: true });
      await page.getByTestId('forge-input-record').fill(fakeId('001', 1));
      await expect(page.getByTestId('forge-record-limit-smart-hint')).toContainText('no cap');
      await page.getByTestId('forge-target-org').click();
      await page.getByTestId(`forge-target-org-option-${QA_SANDBOX.id}`).click();
      await page.getByTestId('forge-discover-btn').click();
      await page.waitForSelector('[data-testid="forge-discovery-loading"]', { timeout: 10_000 });
      await answerAll(page, 'forge:discover', 'forge:discover:response', {
        graph: {
          ...FORGE_TWO_NODE_GRAPH,
          nodes: FORGE_TWO_NODE_GRAPH.nodes.map((node) =>
            node.objectApiName === 'Contact' ? { ...node, piiFields: ['Email'] } : node,
          ),
        },
      });
      await expect(page.getByTestId('stat-source-tables')).toBeVisible();
      const discovered = await checkAccessibility(page);
      expectNoViolations(discovered);
      expect(
        await contrastMeasuredIn(page, discovered, '[data-testid="stat-source-tables"]'),
      ).toBeGreaterThan(0);

      await page.getByTestId('forge-execute-btn').click();
      await page.getByTestId('forge-review').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('forge-preview-source-tables')).toBeVisible();
      await page.evaluate(
        async ({ gaps, storeModule }) => {
          const store = (await import(storeModule)) as {
            useForgeStore: { getState: () => { setGaps: (...args: unknown[]) => void } };
          };
          store.useForgeStore.getState().setGaps('simulation', gaps, []);
        },
        { gaps: [FORGE_GAPS[1]], storeModule: '/src/stores/useForgeStore.ts' },
      );
      await expect(page.getByTestId('forge-gaps-undecided')).toContainText(
        '1 gap will refuse rows',
      );
      const undecided = await checkAccessibility(page);
      expectNoViolations(undecided);
      expect(
        await contrastMeasuredIn(page, undecided, '[data-testid="forge-gaps-undecided"]'),
      ).toBeGreaterThan(0);

      await page.getByTestId('execute-button').click();
      await page
        .getByRole('dialog', { name: '1 gap will refuse rows' })
        .waitFor({ state: 'visible', timeout: 5000 });
      expectNoViolations(await checkAccessibility(page));
      await page.getByTestId('forge-gaps-ask-decide').click();
      await expect(page.getByTestId('tab-gaps')).toHaveAttribute('aria-selected', 'true');
      expect(await bridge.getMessages('forge:execute')).toHaveLength(0);

      await page.getByTestId('tab-anonymization').click();
      await expect(page.getByTestId('anonymization-off')).toBeVisible();
      expectNoViolations(await checkAccessibility(page));
      await page.getByTestId('anonymization-switch').check();
      await expect(page.getByTestId('anonymization-preset-select')).toBeVisible();
      expectNoViolations(await checkAccessibility(page));
    });

    test('Forge results verifying what the run wrote: asked, read, and the verdict with what it found', async ({
      page,
    }) => {
      await startForgeRun(bridge, page, theme, FORGE_RUN_GRAPH);
      const written = { ...FORGE_REMOVABLE_RUN, forgeId: 'forge-run-verified' };
      await answerAll(page, 'forge:execute', 'forge:execute:response', { result: written });
      await page.waitForSelector('[data-testid="forge-results"]', { timeout: 10_000 });
      await expect(page.getByTestId('forge-results-verify-run')).toHaveText(
        'Verify what this run wrote',
      );
      expectNoViolations(await checkAccessibility(page));

      await page.getByTestId('forge-results-verify-run').click();
      const asked = await bridge.waitForMessage('forge:verify:request', { timeout: 10_000 });
      expect(asked.payload).toEqual({ forgeId: written.forgeId });
      await expect(page.getByTestId('forge-results-verifying')).toBeVisible();
      expectNoViolations(await checkAccessibility(page));

      await answerAll(page, 'forge:verify:request', 'forge:verify:response', {
        verification: FORGE_VERIFICATION,
      });
      await page.getByTestId('forge-verification').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('forge-verification-changed')).toBeVisible();
      const partial = await checkAccessibility(page);
      expectNoViolations(partial);
      expect(
        await contrastMeasuredIn(page, partial, '[data-testid="forge-verification"]'),
      ).toBeGreaterThan(0);

      // Verified, said in the colour of success.
      await page.getByTestId('forge-results-verify-run').click();
      await expect(page.getByTestId('forge-results-verifying')).toBeVisible();
      await answerAll(page, 'forge:verify:request', 'forge:verify:response', {
        verification: {
          ...FORGE_VERIFICATION,
          verdict: 'verified',
          objects: [FORGE_VERIFICATION.objects[2]],
        },
      });
      await expect(page.getByTestId('forge-verification-verdict')).toContainText('Verified');
      const verified = await checkAccessibility(page);
      expectNoViolations(verified);
      expect(
        await contrastMeasuredIn(page, verified, '[data-testid="forge-verification-verdict"]'),
      ).toBeGreaterThan(0);
    });

    test('Forge results telling the notes of the run from its errors, each with what it means', async ({
      page,
    }) => {
      const request = await startForgeRun(bridge, page, theme);
      await forgeProgress(page, request, 'Account', 'done');
      await forgeProgress(page, request, 'Contact', 'error');
      // As 1.40.2 reports them: refused rows and an object the target lacks
      // among the failures; a lookup left empty because its record is not in
      // the clone, and contacts sent on their own, which count no failure.
      await sendExtensionMessage(page, {
        type: 'forge:execute:response',
        id: 'resp-forge-notes',
        correlationId: request,
        payload: {
          result: {
            forgeId: 'forge-run-notes',
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
              {
                objectApiName: 'Visit__c',
                stage: 'scope',
                failedCount: 0,
                attemptedCount: 0,
                skipped: true,
                samples: [
                  {
                    recordSummary: '(node-level skip)',
                    messages: [
                      'Object is not in the target org, or the user the run writes as cannot see it: none of its records can be written there',
                    ],
                  },
                ],
              },
              {
                objectApiName: 'Account',
                stage: 'scope',
                failedCount: 0,
                attemptedCount: 0,
                samples: [
                  {
                    recordSummary: 'ParentId → Account (1 record)',
                    messages: [
                      'Written with the lookup empty: the Account record it points at is not in the clone.',
                    ],
                  },
                ],
              },
              {
                objectApiName: 'Contact',
                stage: 'scope',
                failedCount: 0,
                attemptedCount: 0,
                samples: [
                  {
                    recordSummary: 'IsPersonAccount=true (1 record)',
                    messages: [
                      'Sent as contacts of their own: the target has no person accounts, and wrote no contact with it.',
                    ],
                  },
                ],
              },
            ],
          },
          operationId: 'forge-execute-1',
        },
      });
      const notes = page.getByTestId('forge-notes-panel');
      await notes.waitFor({ timeout: 10_000 });
      const errors = page.getByTestId('forge-errors-panel');
      await expect(errors.getByTestId('forge-errors-row')).toHaveCount(2);
      await expect(notes.getByTestId('forge-notes-row')).toHaveCount(2);
      await expect(notes.getByTestId('error-hint')).toHaveCount(1);
      // The object skipped whole opened, with the hint that says why.
      await errors
        .getByTestId('forge-errors-row')
        .filter({ hasText: 'Visit__c' })
        .getByRole('button')
        .click();
      await expect(errors.getByTestId('error-hint')).toHaveCount(1);

      const results = await checkAccessibility(page);
      expectNoViolations(results);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="forge-notes-panel"]'),
      ).toBeGreaterThan(0);
      expect(
        await contrastMeasuredIn(
          page,
          results,
          '[data-testid="forge-notes-panel"] [data-testid="error-hint"]',
        ),
      ).toBeGreaterThan(0);
      expect(
        await contrastMeasuredIn(
          page,
          results,
          '[data-testid="forge-errors-panel"] [data-testid="error-hint"]',
        ),
      ).toBeGreaterThan(0);
    });

    test('Forge run an error stopped after it wrote, then the results of what it wrote', async ({
      page,
    }) => {
      const request = await startForgeRun(bridge, page, theme);
      await forgeProgress(page, request, 'Account', 'done');
      // The error carries the run as the history keeps it: it had created
      // the account before its session expired.
      await sendExtensionMessage(page, {
        type: 'forge:execute:error',
        id: 'err-forge-stopped',
        correlationId: request,
        payload: {
          message: 'INVALID_SESSION_ID: Session expired or invalid',
          code: 'EXECUTE_ERROR',
          retryable: true,
          result: {
            forgeId: 'forge-run-stopped',
            status: 'failure',
            graph: FORGE_TWO_NODE_GRAPH,
            duration: 2_000,
            timestamp: '2026-09-01T08:00:00.000Z',
            idRemapCount: 1,
            createdCount: 1,
            idRemapTable: { [fakeId('001', 1, 'SRC')]: fakeId('001', 1) },
            idRemapCreated: [{ objectApiName: 'Account', sourceIds: [fakeId('001', 1, 'SRC')] }],
            readByObject: [{ objectApiName: 'Account', read: 1 }],
            failedReads: [],
          },
        },
      });

      await page.getByTestId('forge-execution-error-written').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('forge-execution-status')).toHaveText('STOPPED');
      const stopped = await checkAccessibility(page);
      expectNoViolations(stopped);
      expect(
        await contrastMeasuredIn(page, stopped, '[data-testid="forge-execution-error"]'),
      ).toBeGreaterThan(0);

      await page.getByTestId('forge-execution-see-stopped').click();
      await page.getByTestId('forge-results-stopped').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('forge-id-mapping-row')).toHaveCount(1);
      const results = await checkAccessibility(page);
      expectNoViolations(results);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="forge-results-stopped"]'),
      ).toBeGreaterThan(0);
    });

    test('Forge run an error stopped, said with what it means, what to do and its row in the guide, on the run and in its results', async ({
      page,
    }) => {
      const request = await startForgeRun(bridge, page, theme);
      await forgeProgress(page, request, 'Account', 'done');
      // The org's API requests ran out once the account was written: the
      // contacts' call was refused, and so was the run's next request.
      const limit = 'REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.';
      await sendExtensionMessage(page, {
        type: 'forge:execute:error',
        id: 'err-forge-request-limit',
        correlationId: request,
        payload: {
          message: limit,
          code: 'EXECUTE_ERROR',
          retryable: true,
          result: {
            forgeId: 'forge-run-request-limit',
            status: 'partial',
            graph: FORGE_TWO_NODE_GRAPH,
            duration: 2_000,
            timestamp: '2026-09-01T08:00:00.000Z',
            idRemapCount: 1,
            createdCount: 1,
            idRemapTable: { [fakeId('001', 1, 'SRC')]: fakeId('001', 1) },
            idRemapCreated: [{ objectApiName: 'Account', sourceIds: [fakeId('001', 1, 'SRC')] }],
            readByObject: [
              { objectApiName: 'Account', read: 1 },
              { objectApiName: 'Contact', read: 2 },
            ],
            failedReads: [],
            errors: [
              {
                objectApiName: 'Contact',
                stage: 'insert',
                failedCount: 2,
                attemptedCount: 2,
                samples: [
                  { recordSummary: 'Contact batch 1/1: 2 records not written', messages: [limit] },
                ],
              },
            ],
          },
        },
      });

      const alert = page.getByTestId('forge-execution-error');
      const guide = alert.getByRole('link', { name: 'REQUEST_LIMIT_EXCEEDED in the Forge guide' });
      await guide.waitFor({ timeout: 10_000 });
      await expect(guide).toHaveAttribute(
        'href',
        /\/docs\/forge-quickstart\.md#error-request-limit-exceeded$/,
      );
      // The screen comes scrolled to where Review's Execute was, and the
      // alert above the fold is clipped: axe measures nothing it cannot see.
      const runHint = alert.getByTestId('error-hint');
      await runHint.scrollIntoViewIfNeeded();
      const stopped = await checkAccessibility(page);
      expectNoViolations(stopped);
      expect(
        await contrastMeasuredIn(
          page,
          stopped,
          '[data-testid="forge-execution-error"] [data-testid="error-hint"]',
        ),
      ).toBeGreaterThan(0);
      expect(
        await contrastMeasuredIn(
          page,
          stopped,
          '[data-testid="forge-execution-error"] [data-testid="error-hint-link"]',
        ),
      ).toBeGreaterThan(0);

      // The results of what it wrote say it again, and so does the hint of
      // the rows the refused call took down.
      await page.getByTestId('forge-execution-see-stopped').click();
      const banner = page.getByTestId('forge-results-stopped');
      const bannerGuide = banner.getByTestId('error-hint-link');
      await bannerGuide.waitFor({ timeout: 10_000 });
      await bannerGuide.scrollIntoViewIfNeeded();
      const results = await checkAccessibility(page);
      expectNoViolations(results);
      expect(
        await contrastMeasuredIn(
          page,
          results,
          '[data-testid="forge-results-stopped"] [data-testid="error-hint"]',
        ),
      ).toBeGreaterThan(0);
      expect(
        await contrastMeasuredIn(
          page,
          results,
          '[data-testid="forge-results-stopped"] [data-testid="error-hint-link"]',
        ),
      ).toBeGreaterThan(0);

      const errors = page.getByTestId('forge-errors-panel');
      await errors.getByTestId('forge-errors-row').getByRole('button').click();
      const rowGuide = errors.getByTestId('error-hint-link');
      await expect(rowGuide).toHaveCount(1);
      await rowGuide.scrollIntoViewIfNeeded();
      const opened = await checkAccessibility(page);
      expectNoViolations(opened);
      expect(
        await contrastMeasuredIn(
          page,
          opened,
          '[data-testid="forge-errors-panel"] [data-testid="error-hint-link"]',
        ),
      ).toBeGreaterThan(0);
    });

    test('Forge run an error stopped before it wrote, and the way back to its Review', async ({
      page,
    }) => {
      const request = await startForgeRun(bridge, page, theme);
      await sendExtensionMessage(page, {
        type: 'forge:execute:error',
        id: 'err-forge-declined',
        correlationId: request,
        payload: {
          message: 'Operation cancelled by user (production confirmation declined).',
          code: 'GUARD_DECLINED',
          retryable: true,
        },
      });

      await page.getByTestId('forge-execution-back-to-review').waitFor({ timeout: 10_000 });
      const stopped = await checkAccessibility(page);
      expectNoViolations(stopped);
      expect(
        await contrastMeasuredIn(page, stopped, '[data-testid="forge-execution-error"]'),
      ).toBeGreaterThan(0);

      await page.getByTestId('forge-execution-back-to-review').click();
      await page.getByTestId('forge-review').waitFor({ timeout: 10_000 });
    });

    test('Forge abort question: nothing to type, Keep running focused', async ({ page }) => {
      await startForgeRun(bridge, page, theme);
      await page.getByTestId('forge-abort-button').click();

      await expectPlainStopQuestion(page, 'Abort');
      await expectReadable(page, theme);
      await page.getByRole('button', { name: 'Stop the run' }).click();
      await bridge.waitForMessage('forge:abort', { timeout: 10_000 });
    });

    test('Forge run the user aborts, stopping until it answers, then the rest of it to write', async ({
      page,
    }) => {
      const request = await startForgeRun(bridge, page, theme);
      await forgeProgress(page, request, 'Account', 'done');
      await page.getByTestId('forge-abort-button').click();
      await page.getByTestId('danger-confirm-btn').click();
      await bridge.waitForMessage('forge:abort', { timeout: 10_000 });

      // The screen stays, saying the run is stopping: it went to the input
      // screen, and the answer carrying what the run wrote reached none.
      await page.getByTestId('forge-execution-stopping').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('forge-execution-status')).toHaveText('STOPPING...');
      const stopping = await checkAccessibility(page);
      expectNoViolations(stopping);
      expect(
        await contrastMeasuredIn(page, stopping, '[data-testid="forge-execution-stopping"]'),
      ).toBeGreaterThan(0);

      await sendExtensionMessage(page, {
        type: 'forge:execute:error',
        id: 'err-forge-cancelled',
        correlationId: request,
        payload: {
          message:
            'Forge execution was aborted by user request. Remaining objects were not processed.',
          code: 'RUN_CANCELLED',
          retryable: true,
          result: {
            forgeId: 'forge-run-cancelled',
            status: 'partial',
            cancelled: true,
            graph: FORGE_TWO_NODE_GRAPH,
            duration: 2_000,
            timestamp: '2026-09-01T08:00:00.000Z',
            idRemapCount: 1,
            createdCount: 1,
            idRemapTable: { [fakeId('001', 1, 'SRC')]: fakeId('001', 1) },
            idRemapCreated: [{ objectApiName: 'Account', sourceIds: [fakeId('001', 1, 'SRC')] }],
            readByObject: [{ objectApiName: 'Account', read: 1 }],
            failedReads: [],
          },
        },
      });
      await page.getByTestId('forge-execution-see-stopped').click();

      // Dated as stopped, and what it never reached offered to write.
      await page.getByTestId('forge-retry-failed-hint').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('forge-results-timestamp')).toContainText('Stopped');
      await expect(page.getByTestId('forge-retry-failed')).toHaveText('Write the rest');
      const results = await checkAccessibility(page);
      expectNoViolations(results);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="forge-retry-failed-hint"]'),
      ).toBeGreaterThan(0);
    });

    test('Forge run a cancel stops while an object is written, that object drawn stopped on the graph and in the results', async ({
      page,
    }) => {
      const request = await startForgeRun(bridge, page, theme);
      await page.getByTestId('forge-abort-button').click();
      await page.getByTestId('danger-confirm-btn').click();
      await bridge.waitForMessage('forge:abort', { timeout: 10_000 });

      // The accounts were being written when the abort came: one went, the
      // other two were never sent, and the contacts were never reached. The
      // node ended done, drawn as a node written whole.
      await forgeProgress(
        page,
        request,
        'Account',
        'stopped',
        'Stopped Account: 1 succeeded, 0 failed, 2 not sent',
      );
      await sendExtensionMessage(page, {
        type: 'forge:execute:error',
        id: 'err-forge-stopped-mid-write',
        correlationId: request,
        payload: {
          message:
            'Forge execution was aborted by user request. No further batches will be processed.',
          code: 'RUN_CANCELLED',
          retryable: true,
          result: {
            forgeId: 'forge-run-stopped-mid-write',
            status: 'partial',
            cancelled: true,
            graph: FORGE_TWO_NODE_GRAPH,
            duration: 2_000,
            timestamp: '2026-09-01T08:00:00.000Z',
            idRemapCount: 1,
            createdCount: 1,
            idRemapTable: { [fakeId('001', 1, 'SRC')]: fakeId('001', 1) },
            idRemapCreated: [{ objectApiName: 'Account', sourceIds: [fakeId('001', 1, 'SRC')] }],
            readByObject: [{ objectApiName: 'Account', read: 3 }],
            failedReads: [],
          },
        },
      });

      // Drawn stopped, in words beside its mark, and counted on a tile of its own.
      await page.getByTestId('forge-execution-error-written').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('forge-execution-status')).toHaveText('STOPPED');
      await expect(
        page
          .getByTestId('progress-node')
          .filter({ hasText: 'Account' })
          .getByTestId('node-stopped'),
      ).toHaveText('Stopped before its end');
      await expect(
        page.getByTestId('kpi-card').filter({ hasText: 'Stopped' }).getByTestId('kpi-value'),
      ).toHaveText('1');
      const stopped = await checkAccessibility(page);
      expectNoViolations(stopped);
      // axe leaves every text on the graph's nodes incomplete, overlapped by
      // the layers React Flow draws over them: the words of the stopped node
      // are measured as Chromium paints them, against the bar or the theme's
      // own contrast for their colour.
      const overlapped = stopped.incomplete
        .filter((rule) => rule.id === 'color-contrast')
        .flatMap((rule) => rule.nodes)
        .filter((node) => node.html.includes('data-testid="node-stopped"'));
      expect(overlapped).toHaveLength(1);
      const shortfalls = await themeContrastShortfalls(
        page,
        vscodeTheme(theme),
        '[data-testid="node-stopped"]',
      );
      expect(shortfalls, shortfalls.join('\n')).toEqual([]);

      // Said as the user's cancel, in the neutral colour, not as an error.
      await expect(page.getByTestId('forge-execution-error')).toHaveAttribute('role', 'status');
      await page.getByTestId('forge-execution-see-stopped').click();
      await page.getByTestId('forge-results-stopped').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('forge-results-stopped-message')).toHaveText(
        'You cancelled the run before its end.',
      );
      // In words: the badge printed the code itself.
      await expect(page.getByTestId('forge-results-status-stopped')).toHaveText('Stopped');
      const results = await checkAccessibility(page);
      expectNoViolations(results);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="forge-results-status-stopped"]'),
      ).toBeGreaterThan(0);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="forge-results-stopped-message"]'),
      ).toBeGreaterThan(0);
    });

    test('Forge graph fitted clear of its minimap, from discovery to the run', async ({ page }) => {
      // At 1280×720 the minimap was drawn over the contact, the graph fitted
      // to the whole of a pane whose right side the minimap takes.
      await discoverForgeGraph(bridge, page, theme);
      await graphFitted(page, FORGE_GRAPH);
      expect(await graphPaneHeight(page, FORGE_GRAPH)).toBeGreaterThanOrEqual(350);
      expect(await nodesUnder(page, FORGE_GRAPH, MINIMAP)).toEqual([]);
      expectNoViolations(await checkAccessibility(page));

      await page.getByTestId('forge-execute-btn').click();
      await page.getByTestId('forge-review').waitFor({ timeout: 10_000 });
      await graphFitted(page, FORGE_GRAPH);
      expect(await graphPaneHeight(page, FORGE_GRAPH)).toBeGreaterThanOrEqual(350);
      expect(await nodesUnder(page, FORGE_GRAPH, MINIMAP)).toEqual([]);
      expectNoViolations(await checkAccessibility(page));

      await page.getByTestId('execute-button').click();
      await page.getByTestId('forge-execution').waitFor({ timeout: 10_000 });
      await graphFitted(page, FORGE_GRAPH);
      expect(await graphPaneHeight(page, FORGE_GRAPH)).toBeGreaterThanOrEqual(300);
      expect(await nodesUnder(page, FORGE_GRAPH, MINIMAP)).toEqual([]);
      expectNoViolations(await checkAccessibility(page));
    });

    test('Forge graph drawing its background dots apart from its pane', async ({ page }) => {
      // A white at 5%: on a light theme's white pane the grid was not drawn at all.
      await discoverForgeGraph(bridge, page, theme);
      await graphFitted(page, FORGE_GRAPH);
      expect(await backgroundDotsContrast(page, FORGE_GRAPH)).toBeGreaterThan(1.15);
      expectNoViolations(await checkAccessibility(page));
    });

    test('Forge discovery naming each object’s status in words, in its table and its detail', async ({
      page,
    }) => {
      await discoverForgeGraph(bridge, page, theme);

      // The column and the badge printed the code itself: "idle".
      await page.getByTestId('forge-view-table').click();
      await expect(page.getByTestId('forge-table-status-Account')).toHaveText('Not started');
      await page.getByTestId('forge-table-select-Account').click();
      await expect(page.getByTestId('node-status-badge')).toHaveText('Not started');
      const discovery = await checkAccessibility(page);
      expectNoViolations(discovery);
      expect(
        await contrastMeasuredIn(page, discovery, '[data-testid="forge-table-status-Account"]'),
      ).toBeGreaterThan(0);
      expect(
        await contrastMeasuredIn(page, discovery, '[data-testid="node-status-badge"]'),
      ).toBeGreaterThan(0);
    });

    test('Forge discovery previewing the emails and phone numbers a run writes with anonymization off', async ({
      page,
    }) => {
      await discoverForgeGraph(bridge, page, theme, {
        ...FORGE_TWO_NODE_GRAPH,
        nodes: [
          FORGE_TWO_NODE_GRAPH.nodes[0],
          { ...FORGE_TWO_NODE_GRAPH.nodes[1], piiFields: ['Email', 'Phone'] },
        ],
      });

      // It showed u***@***.com and +1-***-****, and only for fields anonymized.
      await page.getByTestId('forge-view-table').click();
      await page.getByTestId('forge-table-select-Contact').click();
      await expect(page.getByTestId('anonymization-preview-title')).toHaveText(
        'Emails and phone numbers, as the run writes them',
      );
      await expect(page.getByTestId('anonymization-preview-Email')).toContainText(
        'john.doe@acme.com.invalid',
      );
      await expect(page.getByTestId('anonymization-preview-Phone')).toContainText('+33 6 39 98');
      const preview = await checkAccessibility(page);
      expectNoViolations(preview);
      expect(
        await contrastMeasuredIn(page, preview, '[data-testid="anonymization-preview"]'),
      ).toBeGreaterThan(0);
    });

    test('Forge discovery listing a graph wider than auto draws, in a table from the start', async ({
      page,
    }) => {
      // Drawn as a graph, a discovery of hundreds of objects was heavy and
      // unreadable, and it started on the graph every time.
      await discoverForgeGraph(bridge, page, theme, FORGE_WIDE_GRAPH);

      await expect(page.getByTestId('forge-table-view')).toBeVisible();
      await expect(page.getByTestId(FORGE_GRAPH)).toHaveCount(0);
      await expect(page.getByTestId('forge-view-table')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('forge-table-row')).toHaveCount(FORGE_WIDE_GRAPH.nodes.length);
      const discovery = await checkAccessibility(page);
      expectNoViolations(discovery);
      expect(
        await contrastMeasuredIn(page, discovery, '[data-testid="forge-table-view"]'),
      ).toBeGreaterThan(0);
    });

    test('Forge run listed in a table, each row following its object as the run goes', async ({
      page,
    }) => {
      const request = await startForgeRun(bridge, page, theme, FORGE_WIDE_GRAPH);
      await sendExtensionMessage(page, {
        type: 'forge:progress',
        id: 'progress-running',
        correlationId: request,
        payload: { objectName: 'Related1__c', status: 'running', progress: 40 },
      });
      await forgeProgress(page, request, 'Account', 'done');
      await forgeProgress(
        page,
        request,
        'Related2__c',
        'error',
        'Related2__c: REQUIRED_FIELD_MISSING',
      );

      const table = page.getByTestId('forge-execution-table');
      await expect(table).toBeVisible();
      await expect(page.getByTestId(FORGE_GRAPH)).toHaveCount(0);
      await expect(page.getByTestId('forge-execution-status-Account')).toHaveText('Done');
      await expect(page.getByTestId('forge-execution-status-Related2__c')).toHaveText('Failed');
      await expect(table.getByRole('progressbar', { name: 'Related1__c' })).toHaveAttribute(
        'aria-valuenow',
        '40',
      );
      await expect(page.getByTestId('forge-execution-records-Related4__c')).toHaveText(
        'Size not measured yet',
      );
      const run = await checkAccessibility(page);
      expectNoViolations(run);
      expect(
        await contrastMeasuredIn(page, run, '[data-testid="forge-execution-table"]'),
      ).toBeGreaterThan(0);

      // The switch draws the graph instead, and the table comes back with it.
      await page.getByTestId('forge-view-graph').click();
      await expect(page.getByTestId(FORGE_GRAPH)).toBeVisible();
      await page.getByTestId('forge-view-table').click();
      await expect(table).toBeVisible();
    });

    test('Forge Clone directly, from what it skips to the run it starts without Review', async ({
      page,
    }) => {
      await navigateToModule(bridge, page, 'forge', 'forge-page', { theme, orgs: true });
      await page.getByTestId('forge-tab-soql').click();
      await page.getByTestId('forge-input-soql').fill(FORGE_AI_DRAFT);
      await page.getByTestId('forge-target-org').click();
      await page.getByTestId(`forge-target-org-option-${QA_SANDBOX.id}`).click();

      // Said where the path is chosen: no metadata diff on it.
      await expect(page.getByTestId('forge-clone-directly-hint')).toContainText('metadata diff');
      const input = await checkAccessibility(page);
      expectNoViolations(input);
      expect(
        await contrastMeasuredIn(page, input, '[data-testid="forge-clone-directly-hint"]'),
      ).toBeGreaterThan(0);

      await page.getByTestId('forge-clone-directly-btn').click();
      await page.getByTestId('forge-discovery-direct').waitFor({ timeout: 10_000 });
      const discovering = await checkAccessibility(page);
      expectNoViolations(discovering);
      expect(
        await contrastMeasuredIn(page, discovering, '[data-testid="forge-discovery-direct"]'),
      ).toBeGreaterThan(0);

      await answerAll(page, 'forge:discover', 'forge:discover:response', {
        graph: FORGE_TWO_NODE_GRAPH,
      });
      await page.getByTestId('forge-execution-review-skipped').waitFor({ timeout: 10_000 });
      await bridge.waitForMessage('forge:execute', { timeout: 10_000 });
      await expect(page.getByTestId('forge-review')).toHaveCount(0);
      expect(await bridge.getMessages('forge:metadata-diff:request')).toEqual([]);
      expect(await bridge.getMessages('forge:automation:request')).toEqual([]);
      const run = await checkAccessibility(page);
      expectNoViolations(run);
      expect(
        await contrastMeasuredIn(page, run, '[data-testid="forge-execution-review-skipped"]'),
      ).toBeGreaterThan(0);
    });

    test('Forge Clone directly whose page is left, its run started meanwhile, and the page back on it', async ({
      page,
    }) => {
      await navigateToModule(bridge, page, 'forge', 'forge-page', { theme, orgs: true });
      await page.getByTestId('forge-tab-soql').click();
      await page.getByTestId('forge-input-soql').fill(FORGE_AI_DRAFT);
      await page.getByTestId('forge-target-org').click();
      await page.getByTestId(`forge-target-org-option-${QA_SANDBOX.id}`).click();
      await page.getByTestId('forge-clone-directly-btn').click();
      await page.getByTestId('forge-discovery-direct').waitFor({ timeout: 10_000 });

      // To another page of the panel, as the G then L shortcut takes it: Help.
      const shortcut = async (key: string): Promise<void> => {
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.keyboard.press('g');
        await page.keyboard.press(key);
      };
      await shortcut('l');
      await page.getByTestId('help-page').waitFor({ timeout: 10_000 });

      // The discovery answers with no Forge screen open: the run starts.
      await answerAll(page, 'forge:discover', 'forge:discover:response', {
        graph: FORGE_TWO_NODE_GRAPH,
      });
      await bridge.waitForMessage('forge:execute', { timeout: 10_000 });

      await shortcut('f');
      await page.getByTestId('forge-execution-review-skipped').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('forge-discovery-loading')).toHaveCount(0);
      expectNoViolations(await checkAccessibility(page));
    });

    test('Forge Review listing a graph wider than auto draws, each box including its own object', async ({
      page,
    }) => {
      await discoverForgeGraph(bridge, page, theme, FORGE_WIDE_GRAPH);
      await page.getByTestId('forge-execute-btn').click();
      await page.getByTestId('forge-review').waitFor({ timeout: 10_000 });

      // Review drew the graph whatever its size.
      const table = page.getByTestId('forge-review').getByTestId('forge-table-view');
      await expect(table).toBeVisible();
      await expect(page.getByTestId(FORGE_GRAPH)).toHaveCount(0);
      await expect(page.getByTestId('forge-view-table')).toHaveAttribute('aria-pressed', 'true');
      // Laid over its panel, the table scrolls there rather than stretching Review.
      expect(await table.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
        true,
      );
      // Nothing to open beside it: the names are text.
      await expect(table.getByRole('button', { name: 'Related1__c' })).toHaveCount(0);

      await page.getByTestId('forge-table-include-Related1__c').click();
      await expect(page.getByTestId('forge-table-include-Related1__c')).not.toBeChecked();
      const review = await checkAccessibility(page);
      expectNoViolations(review);
      expect(
        await contrastMeasuredIn(
          page,
          review,
          '[data-testid="forge-review"] [data-testid="forge-table-view"]',
        ),
      ).toBeGreaterThan(0);
    });

    test('Forge run whose abort goes unanswered, then the way back to the start and the run in Recent runs', async ({
      page,
    }) => {
      // A clock the test can set: the screen waits a minute for the answer.
      await page.clock.install();
      const request = await startForgeRun(bridge, page, theme);
      await forgeProgress(page, request, 'Account', 'done');
      await page.getByTestId('forge-abort-button').click();
      await page.getByTestId('danger-confirm-btn').click();
      await bridge.waitForMessage('forge:abort', { timeout: 10_000 });
      await page.getByTestId('forge-execution-stopping').waitFor({ timeout: 10_000 });

      // No answer comes, and the page is left and come back to a minute on:
      // STOPPING... had no way out until the panel was closed. The date moves
      // on alone. Moved with it, `performance.now` runs ahead of the timeline
      // the page's animations are timed on, and a screen's exit never ends.
      await page.clock.setSystemTime((await page.evaluate(() => Date.now())) + 61_000);
      await page.keyboard.press('g');
      await page.keyboard.press('e');
      await page.getByTestId('settings-page').waitFor({ timeout: 10_000 });
      await page.keyboard.press('g');
      await page.keyboard.press('f');
      await page.getByTestId('forge-execution-stop-unanswered').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('forge-execution-status')).toHaveText('STOPPING...');
      const unanswered = await checkAccessibility(page);
      expectNoViolations(unanswered);
      expect(
        await contrastMeasuredIn(
          page,
          unanswered,
          '[data-testid="forge-execution-stop-unanswered"]',
        ),
      ).toBeGreaterThan(0);

      await page.getByTestId('forge-execution-leave').click();
      await page.getByTestId('forge-input').waitFor({ timeout: 10_000 });

      // The run answers after all: the page stays where it is, and reads the
      // recent runs again, where the run is now kept.
      const historyReads = (await bridge.getMessages('forge:history:list')).length;
      const lateRun = {
        forgeId: 'forge-run-late',
        status: 'partial',
        cancelled: true,
        graph: FORGE_TWO_NODE_GRAPH,
        duration: 70_000,
        timestamp: '2026-09-01T08:01:10.000Z',
        idRemapCount: 1,
        createdCount: 1,
        idRemapTable: { [fakeId('001', 1, 'SRC')]: fakeId('001', 1) },
        idRemapCreated: [{ objectApiName: 'Account', sourceIds: [fakeId('001', 1, 'SRC')] }],
        readByObject: [{ objectApiName: 'Account', read: 1 }],
        failedReads: [],
      };
      await sendExtensionMessage(page, {
        type: 'forge:execute:error',
        id: 'err-forge-late',
        correlationId: request,
        payload: {
          message:
            'Forge execution was aborted by user request. Remaining objects were not processed.',
          code: 'RUN_CANCELLED',
          retryable: true,
          result: lateRun,
        },
      });
      await expect
        .poll(async () => (await bridge.getMessages('forge:history:list')).length)
        .toBeGreaterThan(historyReads);
      await answerAll(page, 'forge:history:list', 'forge:history:list:response', {
        history: [{ ...lateRun, targetOrgId: QA_SANDBOX.id, config: FORGE_REMOVABLE_RUN.config }],
      });
      await page.getByTestId('forge-history-entry-forge-run-late').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('forge-execution')).toHaveCount(0);
      const back = await checkAccessibility(page);
      expectNoViolations(back);
    });

    test('Forge Review saying what an object left out costs, and the run marking it the user’s', async ({
      page,
    }) => {
      /** An account's contacts, which cannot be written without it, and the account left to uncheck. */
      const graph = {
        ...FORGE_TWO_NODE_GRAPH,
        edges: [
          {
            sourceObject: 'Account',
            targetObject: 'Contact',
            relationshipName: 'Contacts',
            type: 'lookup',
            required: true,
          },
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
      await page.getByTestId('forge-view-table').click();
      await page.getByTestId('forge-table-include-Account').click();
      await page.getByTestId('forge-execute-btn').click();

      await page.getByTestId('forge-left-out-cost').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('forge-left-out-cost-row')).toHaveText(
        'Contact: records that need a record of Account are not written, unless the target already holds it.',
      );
      const review = await checkAccessibility(page);
      expectNoViolations(review);
      expect(
        await contrastMeasuredIn(page, review, '[data-testid="forge-left-out-cost"]'),
      ).toBeGreaterThan(0);

      await page.getByTestId('execute-button').click();
      const run = await bridge.waitForMessage('forge:execute', { timeout: 10_000 });
      const nodes = (run.payload as { graph: { nodes: Array<Record<string, unknown>> } }).graph
        .nodes;
      expect(nodes.find((n) => n.objectApiName === 'Account')).toMatchObject({
        included: false,
        leftOutByUser: true,
      });
    });

    test('Forge Review saying what the target runs as the run writes, and the permission that keeps a flow quiet', async ({
      page,
    }) => {
      await discoverForgeGraph(bridge, page, theme);
      await page.getByTestId('forge-execute-btn').click();
      await page.getByTestId('forge-review').waitFor({ timeout: 10_000 });
      // Read as Review opens, with the metadata diff, for the graph's objects.
      const request = await bridge.waitForMessage('forge:automation:request', { timeout: 10_000 });
      expect((request.payload as { targetOrgId: string }).targetOrgId).toBe(QA_SANDBOX.id);

      await page.getByTestId('tab-automation').click();
      await page.getByTestId('automation-loading').waitFor({ timeout: 10_000 });
      const reading = await checkAccessibility(page);
      expectNoViolations(reading);
      expect(
        await contrastMeasuredIn(page, reading, '[data-testid="review-automation-tab"]'),
      ).toBeGreaterThan(0);

      await answerAll(page, 'forge:automation:request', 'forge:automation:response', {
        automation: FORGE_TARGET_AUTOMATION,
      });
      await page.getByTestId('automation-object-Contact').waitFor({ timeout: 10_000 });
      // Counted on the tab: the trigger before an account is inserted, and
      // the three flows, the workflow rule and the process of a contact's insert.
      await expect(page.getByTestId('tab-automation')).toHaveText('Automation6');
      await expect(page.getByTestId('automation-bypass')).toHaveText(
        'Assign the custom permission Load_Data to the user the run writes as in the target org, and the flows whose start condition excludes it stay quiet.',
      );
      // What reaches people is marked where it fires: the flow's email at a
      // contact's insert, the process's text message at its insert and update.
      await expect(page.getByTestId('automation-sends-messages')).toHaveCount(3);
      await expect(page.getByTestId('automation-Lead-rules')).toContainText(
        'Not applied: the run keeps the owner it sets',
      );
      const read = await checkAccessibility(page);
      expectNoViolations(read);
      expect(
        await contrastMeasuredIn(page, read, '[data-testid="review-automation-tab"]'),
      ).toBeGreaterThan(5);
      // The run's choice to let the rule apply, made beside it.
      await page.getByTestId('automation-Lead-apply-assignment').check();
      await expect(page.getByTestId('automation-Lead-rules')).toContainText(
        'Applied: this run asks the target org to apply it',
      );
      const applied = await checkAccessibility(page);
      expectNoViolations(applied);
      expect(
        await contrastMeasuredIn(page, applied, '[data-testid="automation-Lead-rules"]'),
      ).toBeGreaterThan(0);
      // The notes at the foot of the tab, scrolled to: what the read could not
      // read is said in the warning colour.
      await page.getByTestId('automation-cost').scrollIntoViewIfNeeded();
      const foot = await checkAccessibility(page);
      expectNoViolations(foot);
      expect(
        await contrastMeasuredIn(page, foot, '[data-testid="automation-unread-conditions"]'),
      ).toBeGreaterThan(0);
    });

    test('Forge Review offering the permission set that keeps a flow quiet, and the command that assigns it', async ({
      page,
    }) => {
      await discoverForgeGraph(bridge, page, theme);
      await page.getByTestId('forge-execute-btn').click();
      await page.getByTestId('forge-review').waitFor({ timeout: 10_000 });
      await bridge.waitForMessage('forge:automation:request', { timeout: 10_000 });
      await page.getByTestId('tab-automation').click();
      await answerAll(page, 'forge:automation:request', 'forge:automation:response', {
        automation: {
          ...FORGE_TARGET_AUTOMATION,
          bypassGrants: [
            {
              permission: 'Load_Data',
              permissionSets: [
                { name: 'Data_Load', label: 'Data load', grants: 1 },
                { name: 'Integration_User', label: 'Integration user', grants: 120 },
              ],
            },
          ],
        },
      });
      const assistant = page.getByTestId('bypass-assistant');
      await assistant.waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('bypass-assistant-command')).toHaveText(
        `sf org assign permset --name Data_Load --target-org ${QA_SANDBOX.alias} --on-behalf-of ${QA_SANDBOX.username}`,
      );
      await expect(
        page.getByRole('button', { name: 'Copy the command that assigns Data_Load' }),
      ).toBeVisible();
      await expect(assistant).toContainText('Integration_User holds it too.');
      const read = await checkAccessibility(page);
      expectNoViolations(read);
      expect(
        await contrastMeasuredIn(page, read, '[data-testid="bypass-assistant"]'),
      ).toBeGreaterThan(0);

      // The command run, the target is read again from the tab, and the
      // bypass shows as held where it showed as not held.
      const automationReads = (await bridge.getMessages('forge:automation:request')).length;
      await page.getByTestId('bypass-assistant-read-again').click();
      await expect
        .poll(async () => (await bridge.getMessages('forge:automation:request')).length)
        .toBeGreaterThan(automationReads);
      await expect(page.getByTestId('automation-read-again')).toHaveText('Reading again…');
      expectNoViolations(await checkAccessibility(page));
      await answerAll(page, 'forge:automation:request', 'forge:automation:response', {
        automation: {
          ...FORGE_TARGET_AUTOMATION,
          objects: FORGE_TARGET_AUTOMATION.objects.map((object) => ({
            ...object,
            flows: object.flows.map((flow) => ({
              ...flow,
              permissions: flow.permissions.map((permission) =>
                permission.name === 'Load_Data' ? { ...permission, held: true } : permission,
              ),
            })),
          })),
        },
      });
      await page.getByTestId('automation-bypass-held').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('bypass-assistant')).toHaveCount(0);
      const held = await checkAccessibility(page);
      expectNoViolations(held);
      expect(
        await contrastMeasuredIn(page, held, '[data-testid="automation-read-again"]'),
      ).toBeGreaterThan(0);
    });

    test('Forge Review saying what it read from the target’s metadata against the rows, and what the target would not give', async ({
      page,
    }) => {
      await discoverForgeGraph(bridge, page, theme);
      await page.getByTestId('forge-execute-btn').click();
      await page.getByTestId('forge-review').waitFor({ timeout: 10_000 });
      // Asked as Review opens, with the automation, under the run's config.
      const request = await bridge.waitForMessage('forge:gaps:request', { timeout: 10_000 });
      expect((request.payload as { config: { targetOrgId: string } }).config.targetOrgId).toBe(
        QA_SANDBOX.id,
      );
      await expect(page.getByTestId('forge-gaps-read')).toHaveText(
        'Reading what the target org holds against the rows…',
      );
      const reading = await checkAccessibility(page);
      expectNoViolations(reading);
      expect(
        await contrastMeasuredIn(page, reading, '[data-testid="forge-gaps-read"]'),
      ).toBeGreaterThan(0);

      await answerAll(page, 'forge:gaps:request', 'forge:gaps:response', {
        gaps: {
          gaps: [
            {
              id: 'required_field_missing|Contact|Region__c||',
              kind: 'required_field_missing',
              severity: 'blocking',
              source: 'metadata',
              objectApiName: 'Contact',
              field: 'Region__c',
              rows: 0,
              detail: { type: 'picklist', reason: 'notInSource' },
              decisions: ['set_default', 'exclude_object'],
            },
            {
              id: 'validation_rule|Contact|Phone||Phone_Format',
              kind: 'validation_rule',
              severity: 'warning',
              source: 'metadata',
              objectApiName: 'Contact',
              field: 'Phone',
              rows: 0,
              detail: {
                rule: 'Phone_Format',
                message: 'Use the international format',
                formula: 'notRead',
                bypasses: ['$Permission.Phone_Bypass'],
                assign: ['Phone_Bypass=Data_Load'],
              },
              decisions: ['leave_empty', 'ignore'],
              defaultDecision: 'leave_empty',
            },
          ],
          unread: [{ part: 'apiBudget', reason: 'INSUFFICIENT_ACCESS: Manage Users' }],
          requests: 9,
        },
      });
      await expect(page.getByTestId('forge-gaps-read-found')).toHaveText(
        "2 gaps read from the target org's metadata. 1 of them refuses rows. Read in 9 requests to the target org.",
      );
      await expect(page.getByTestId('forge-gaps-read-unread')).toContainText(
        'The daily API requests left could not be read: INSUFFICIENT_ACCESS: Manage Users',
      );
      const read = await checkAccessibility(page);
      expectNoViolations(read);
      expect(
        await contrastMeasuredIn(page, read, '[data-testid="forge-gaps-read"]'),
      ).toBeGreaterThan(2);

      // The command the Gaps tab copied run, the target is read again from
      // the rule's bypass assistant, and the rule shows as kept quiet.
      await page.getByTestId('tab-gaps').click();
      const rule = page.getByTestId('gap-validation_rule|Contact|Phone||Phone_Format');
      await expect(rule.getByTestId('bypass-assistant-command')).toHaveText(
        `sf org assign permset --name Data_Load --target-org ${QA_SANDBOX.alias} --on-behalf-of ${QA_SANDBOX.username}`,
      );
      const gapReads = (await bridge.getMessages('forge:gaps:request')).length;
      await rule.getByTestId('bypass-assistant-read-again').click();
      await expect
        .poll(async () => (await bridge.getMessages('forge:gaps:request')).length)
        .toBeGreaterThan(gapReads);
      await expect(rule.getByTestId('bypass-assistant-read-again')).toHaveText('Reading again…');
      const rereading = await checkAccessibility(page);
      expectNoViolations(rereading);
      expect(
        await contrastMeasuredIn(page, rereading, '[data-testid="bypass-assistant"]'),
      ).toBeGreaterThan(0);
      await answerAll(page, 'forge:gaps:request', 'forge:gaps:response', {
        gaps: {
          gaps: [
            {
              id: 'validation_rule|Contact|Phone||Phone_Format',
              kind: 'validation_rule',
              severity: 'info',
              source: 'metadata',
              objectApiName: 'Contact',
              field: 'Phone',
              rows: 0,
              detail: {
                rule: 'Phone_Format',
                message: 'Use the international format',
                bypasses: ['$Permission.Phone_Bypass'],
                heldBypasses: ['Phone_Bypass'],
              },
              decisions: ['ignore'],
            },
          ],
          unread: [],
          requests: 4,
        },
      });
      await page.getByTestId('gaps-severity-info').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('bypass-assistant')).toHaveCount(0);
      expectNoViolations(await checkAccessibility(page));
    });

    test('Forge Review compliance while it is analyzed, after a refusal with its retry, then the report', async ({
      page,
    }) => {
      await discoverForgeGraph(bridge, page, theme);
      await page.getByTestId('forge-execute-btn').click();
      await page.getByTestId('forge-review').waitFor({ timeout: 10_000 });
      await page.getByTestId('tab-compliance').click();
      await page.getByTestId('framework-select').selectOption('gdpr');
      const request = await bridge.waitForMessage('forge:compliance:request', { timeout: 10_000 });
      // The report is asked on the run as it stands, its methods included.
      expect(
        (request.payload as { anonymizationRules?: Record<string, string> }).anonymizationRules,
      ).toMatchObject({ email: expect.any(String) });
      await page.getByTestId('compliance-loading').waitFor({ state: 'visible', timeout: 5000 });
      expectNoViolations(await checkAccessibility(page));

      // The tab never listened for the error, and read "Analyzing compliance..." for good.
      await answerAll(page, 'forge:compliance:request', 'forge:compliance:error', {
        message: 'Compliance service not configured',
        code: 'NOT_INITIALIZED',
        retryable: false,
      });
      await expect(page.getByTestId('compliance-error-message')).toContainText(
        'The compliance report could not be made: Compliance service not configured',
      );
      await expect(page.getByTestId('compliance-loading')).toHaveCount(0);
      expectNoViolations(await checkAccessibility(page));

      await page.getByTestId('compliance-retry').click();
      await expect(page.getByTestId('compliance-loading')).toBeVisible();
      // Every request sent so far is answered; the first one is no longer awaited.
      await answerAll(page, 'forge:compliance:request', 'forge:compliance:response', {
        report: FORGE_COMPLIANCE_REPORT,
      });
      // In words, as the language says it: the badge printed the code, "PARTIAL".
      await expect(page.getByTestId('compliance-status')).toHaveText('Partial');
      expectNoViolations(await checkAccessibility(page));
    });

    test('Forge Review gaps before any read, then with gaps, then with their decisions', async ({
      page,
    }) => {
      await discoverForgeGraph(bridge, page, theme);
      await page.getByTestId('forge-execute-btn').click();
      await page.getByTestId('forge-review').waitFor({ timeout: 10_000 });
      await page.getByTestId('tab-gaps').click();
      await page.getByTestId('gaps-not-read').waitFor({ timeout: 10_000 });
      const empty = await checkAccessibility(page);
      expectNoViolations(empty);
      expect(
        await contrastMeasuredIn(page, empty, '[data-testid="review-gaps-tab"]'),
      ).toBeGreaterThan(0);

      // The reads come from the simulation, the rehearsal and the target's
      // metadata, each through its own channel: the store is fed here as each
      // of them feeds it.
      // The dev server serves the panel's own module under its path: the
      // import is the store the panel holds, not a copy of it.
      await page.evaluate(
        async ({ gaps, storeModule }) => {
          const store = (await import(storeModule)) as {
            useForgeStore: { getState: () => { setGaps: (...args: unknown[]) => void } };
          };
          store.useForgeStore
            .getState()
            .setGaps('simulation', gaps, [{ part: 'currencies', reason: 'INSUFFICIENT_ACCESS' }]);
        },
        { gaps: FORGE_GAPS, storeModule: '/src/stores/useForgeStore.ts' },
      );
      await page.getByTestId('gaps-severity-blocking').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('tab-gaps')).toHaveText('Gaps2');
      // The rule's bypass, under it: checked with the rest of the tab.
      await expect(
        page.getByTestId(`gap-${FORGE_GAPS[3].id}`).getByTestId('bypass-assistant-Phone_Bypass'),
      ).toContainText('Data_Load is the smallest permission set');
      const listed = await checkAccessibility(page);
      expectNoViolations(listed);
      expect(
        await contrastMeasuredIn(page, listed, '[data-testid="review-gaps-tab"]'),
      ).toBeGreaterThan(10);

      const refused = page.getByTestId(`gap-${FORGE_GAPS[0].id}`);
      await refused.getByTestId('gap-map-value').selectOption('Customer');
      await expect(refused.getByTestId('gap-decided')).toHaveText('Decided: written as “Customer”');
      await page.getByTestId(`gap-${FORGE_GAPS[2].id}`).getByTestId('gap-truncate').click();
      await page.getByTestId(`gap-${FORGE_GAPS[1].id}`).getByTestId('gap-exclude-object').click();
      await expect(page.getByTestId('tab-gaps')).toHaveText('Gaps');
      await expect(page.getByTestId('gaps-kept-decisions')).toContainText(
        'Contact: left out of the run',
      );
      await page.getByTestId('review-save-template-open').click();
      await page.getByTestId('review-save-template-form').waitFor();
      const decided = await checkAccessibility(page);
      expectNoViolations(decided);
      expect(
        await contrastMeasuredIn(page, decided, '[data-testid="review-gaps-tab"]'),
      ).toBeGreaterThan(5);

      // The decisions are the run's: Execute sends them with its config.
      await page.getByTestId('execute-button').click();
      const run = await bridge.waitForMessage('forge:execute', { timeout: 10_000 });
      expect((run.payload as { config: Record<string, unknown> }).config).toMatchObject({
        picklistValueMappings: [
          { object: 'Account', field: 'Type', from: 'Prospect', to: 'Customer' },
        ],
        truncateFields: [{ object: 'Account', field: 'Description' }],
        excludedObjects: ['Contact'],
      });
    });

    test('Forge Review searching its graph, then the controls of the run with a filter refused', async ({
      page,
    }) => {
      await discoverForgeGraph(bridge, page, theme);
      await page.getByTestId('forge-execute-btn').click();
      await page.getByTestId('forge-review').waitFor({ timeout: 10_000 });

      // The search marks the object it matches on the graph, and offers to
      // leave out the branch it heads.
      await page.getByTestId('review-graph-search-input').fill('cont');
      await expect(page.getByTestId('review-graph-search-count')).toHaveText(
        '1 object matches, marked in the graph.',
      );
      await expect(
        page.locator('[data-testid="progress-node"][data-highlighted="true"]'),
      ).toHaveCount(1);
      const searched = await checkAccessibility(page);
      expectNoViolations(searched);
      expect(
        await contrastMeasuredIn(page, searched, '[data-testid="review-graph-search"]'),
      ).toBeGreaterThan(2);

      await page.getByTestId('tab-controls').click();
      await page.getByTestId('review-controls-tab').waitFor({ timeout: 10_000 });
      await answerAll(page, 'forge:users:request', 'forge:users:response', {
        orgId: QA_SANDBOX.id,
        users: [{ id: '005000000000101AAA', name: 'Ada Admin', username: 'ada@example.invalid' }],
        truncated: false,
      });
      await page.getByTestId('controls-object').selectOption('Contact');
      await answerAll(page, 'sync:describe-fields', 'sync:describe-fields:response', {
        objectApiName: 'Contact',
        sourceFields: [
          { apiName: 'Email', label: 'Email', type: 'email' },
          { apiName: 'Fax', label: 'Fax', type: 'phone' },
          { apiName: 'Region__c', label: 'Region', type: 'string' },
        ],
        targetFields: [{ apiName: 'Area__c', label: 'Area', type: 'string' }],
      });
      await page.getByTestId('controls-field-Fax').check();
      await page.getByTestId('controls-filter-where').fill('Email != null -- all');
      await page.getByTestId('controls-filter-apply').click();
      await page.getByTestId('controls-filter-refused').waitFor();
      const refused = await checkAccessibility(page);
      expectNoViolations(refused);
      expect(
        await contrastMeasuredIn(page, refused, '[data-testid="review-controls-tab"]'),
      ).toBeGreaterThan(5);

      await page.getByTestId('controls-filter-where').fill('Email != null');
      await page.getByTestId('controls-filter-apply').click();
      await page.getByTestId('controls-owner-source').fill('005000000000001AAA');
      await page.getByTestId('controls-owner-target').selectOption('005000000000101AAA');
      await page.getByTestId('controls-owner-add').click();
      await expect(page.getByTestId('controls-said')).toHaveText('Kept with the run.');
      const kept = await checkAccessibility(page);
      expectNoViolations(kept);

      // What the controls set is the run's: Execute sends it with its config.
      await page.getByTestId('execute-button').click();
      const run = await bridge.waitForMessage('forge:execute', { timeout: 10_000 });
      expect((run.payload as { config: Record<string, unknown> }).config).toMatchObject({
        fieldExclusions: { Contact: ['Fax'] },
        objectSoqlFilters: { Account: "Industry = 'Energy'", Contact: 'Email != null' },
        ownerMappings: { '005000000000001AAA': '005000000000101AAA' },
      });
    });

    test('Forge Review of a starter template, saying its record counts come with discovery', async ({
      page,
    }) => {
      await navigateToModule(bridge, page, 'forge', 'forge-page', { theme, orgs: true });
      await page.getByTestId('forge-tab-template').click();
      await page.getByTestId('forge-template-builtin-builtin:account-360').click();
      await page.getByTestId('forge-template-record-id').fill(fakeId('001', 1));
      await page.getByTestId('forge-target-org').click();
      await page.getByTestId(`forge-target-org-option-${QA_SANDBOX.id}`).click();
      await page.getByTestId('forge-quick-start-template-btn').click();

      // No discovery counted the template's tables: each is cloned, none is
      // an empty table, and the card says where the counts come from.
      await page.getByTestId('forge-preview-not-counted').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('forge-preview-clone')).toContainText(
        '4 objects · records not counted',
      );
      await expect(page.getByTestId('forge-preview-skipped-empty')).toHaveText('Skipped (empty)0');
      // The plan the extension makes of that graph reckons from its zeros:
      // the Plan tab says the records are not counted, and no call or
      // duration reckoned from them.
      await answerAll(page, 'forge:plan:request', 'forge:plan:response', {
        plan: {
          waves: [
            {
              order: 0,
              objectApiNames: ['Account', 'Contact', 'Opportunity', 'Case'],
              totalRecords: 0,
              estimatedDurationSeconds: 0,
              estimatedApiCalls: 0,
            },
          ],
          totalRecords: 0,
          totalApiCalls: 0,
          estimatedDurationSeconds: 0,
          cycleResolutions: [],
        },
      });
      await expect(page.getByTestId('review-plan-summary')).toHaveText('records not counted');
      await expect(page.getByTestId('wave-0')).not.toContainText('API call');
      const review = await checkAccessibility(page);
      expectNoViolations(review);
      expect(
        await contrastMeasuredIn(page, review, '[data-testid="forge-preview-not-counted"]'),
      ).toBeGreaterThan(0);
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
          picklistValuesChanged: [
            {
              objectApiName: 'Quote',
              field: 'Status',
              reason: 'record-type',
              values: ['Presented'],
              rows: 1,
              recordType: 'Retail',
              replacedBy: 'Draft',
              replacement: 'default',
            },
          ],
          currenciesReplaced: [
            {
              objectApiName: 'Quote',
              from: 'GBP',
              to: 'USD',
              chosenBy: 'corporate',
              rows: 1,
              fields: ['Discount__c'],
            },
            // A price that followed its lines into their record's currency,
            // and an opportunity whose dated rates could not be confirmed.
            {
              objectApiName: 'PricebookEntry',
              from: 'GBP',
              to: 'EUR',
              chosenBy: 'lines',
              rows: 2,
              fields: ['UnitPrice'],
              atTargetRate: true,
            },
            {
              objectApiName: 'Opportunity',
              from: 'GBP',
              to: 'USD',
              chosenBy: 'corporate',
              rows: 1,
              fields: ['Amount'],
              datedUnconfirmed: 'CloseDate',
            },
          ],
          writtenWithoutFields: [
            {
              objectApiName: 'Contact',
              rows: 1,
              fields: [
                {
                  field: 'Phone',
                  refusedBy: 'validation-rule',
                  reason:
                    'FIELD_CUSTOM_VALIDATION_EXCEPTION: Enter the phone in international format',
                  rows: 1,
                },
              ],
            },
            {
              objectApiName: 'Quote',
              rows: 2,
              fields: [
                {
                  field: 'Rating__c',
                  refusedBy: 'restricted-picklist',
                  reason:
                    'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value for restricted picklist field: Yes',
                  rows: 2,
                },
              ],
            },
          ],
        },
      });
      await page.waitForSelector('[data-testid="forge-results-files"]', { timeout: 10_000 });
      await page.waitForSelector('[data-testid="forge-results-file-content"]', {
        timeout: 10_000,
      });
      await page.waitForSelector('[data-testid="forge-results-picklists"]', { timeout: 10_000 });
      await page.waitForSelector('[data-testid="forge-results-currencies"]', { timeout: 10_000 });
      await page.waitForSelector('[data-testid="forge-results-written-without"]', {
        timeout: 10_000,
      });
      // The price that followed its lines and the rates that could not be
      // confirmed are scanned with the rest.
      await expect(page.locator('[data-testid="forge-results-currencies-row"]')).toHaveCount(3);
      await expect(
        page.locator('[data-testid="forge-results-currencies"]', {
          hasText: 'the dated rates of CloseDate could not be confirmed',
        }),
      ).toHaveCount(1);
      const results = await checkAccessibility(page);
      expectNoViolations(results);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="forge-results-file-content"]'),
      ).toBeGreaterThan(0);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="forge-results-picklists"]'),
      ).toBeGreaterThan(0);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="forge-results-currencies"]'),
      ).toBeGreaterThan(0);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="forge-results-written-without"]'),
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

    test('Seed Clone while its preview is prepared, saying so', async ({ page }) => {
      await navigateToModule(bridge, page, 'seed', 'seed-page', { theme, orgs: true });
      await page.getByTestId('mode-card-clone').click();
      await page.getByTestId('clone-source-select').selectOption(QA_SANDBOX.id);
      await bridge.waitForMessage('seed:clone:describe-source', { timeout: 10_000 });
      await answerAll(page, 'seed:clone:describe-source', 'seed:clone:describe-source:response', {
        objects: [{ apiName: 'Account', label: 'Account', recordCount: -1 }],
      });
      await page.getByTestId('clone-wizard-next').click();
      await page.getByTestId('clone-obj-check-Account').check();
      await page.getByTestId('clone-wizard-next').click();
      // Never answered: the preview stays on its way.
      await page.waitForSelector('[data-testid="clone-preview-loading"]', { timeout: 10_000 });
      const results = await checkAccessibility(page);
      expectNoViolations(results);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="clone-preview-loading"]'),
      ).toBeGreaterThan(0);
    });

    /** The Seed Clone wizard at its preview of accounts and contacts, their lookups both ways. */
    async function previewAccountsAndContacts(page: Page): Promise<void> {
      await navigateToModule(bridge, page, 'seed', 'seed-page', { theme, orgs: true });
      await page.getByTestId('mode-card-clone').click();
      await page.getByTestId('clone-source-select').selectOption(QA_SANDBOX.id);
      await bridge.waitForMessage('seed:clone:describe-source', { timeout: 10_000 });
      await answerAll(page, 'seed:clone:describe-source', 'seed:clone:describe-source:response', {
        objects: [
          { apiName: 'Account', label: 'Account', recordCount: -1 },
          { apiName: 'Contact', label: 'Contact', recordCount: -1 },
        ],
      });
      await page.getByTestId('clone-wizard-next').click();
      await page.getByTestId('clone-obj-check-Account').check();
      await page.getByTestId('clone-obj-check-Contact').check();
      await page.getByTestId('clone-wizard-next').click();
      await bridge.waitForMessage('seed:clone:preview', { timeout: 10_000 });
      await answerAll(page, 'seed:clone:preview', 'seed:clone:preview:response', {
        objects: [
          {
            objectApiName: 'Account',
            recordCount: 16,
            sampleRecords: [{ Name: 'Acme' }],
            relationships: [
              { field: 'ParentId', referenceTo: 'Account' },
              { field: 'Key_Contact__c', referenceTo: 'Contact' },
            ],
          },
          {
            objectApiName: 'Contact',
            recordCount: 18,
            sampleRecords: [{ LastName: 'Doe' }],
            relationships: [{ field: 'AccountId', referenceTo: 'Account' }],
          },
        ],
        insertOrder: ['Account', 'Contact'],
        filledAfterInsert: [
          { objectApiName: 'Account', field: 'ParentId', referenceTo: 'Account' },
          { objectApiName: 'Account', field: 'Key_Contact__c', referenceTo: 'Contact' },
        ],
        sourceOnlyLookups: [
          { objectApiName: 'Contact', field: 'Legacy_Account__c', referenceTo: 'Account' },
        ],
        targetOnlyRequiredLookups: [
          { objectApiName: 'Contact', field: 'Region__c', referenceTo: 'Region__c' },
        ],
      });
      await page.waitForSelector('[data-testid="clone-preview-filled-after"]', {
        timeout: 10_000,
      });
    }

    test('Seed Clone preview naming the lookups a second pass fills in, those only the source has, and those the target requires that the source lacks', async ({
      page,
    }) => {
      await previewAccountsAndContacts(page);
      const results = await checkAccessibility(page);
      expectNoViolations(results);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="clone-preview-filled-after"]'),
      ).toBeGreaterThan(0);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="clone-preview-source-only"]'),
      ).toBeGreaterThan(0);
      expect(
        await contrastMeasuredIn(
          page,
          results,
          '[data-testid="clone-preview-target-only-required"]',
        ),
      ).toBeGreaterThan(0);
    });

    test('Seed Clone preview set aside once another org is selected after it, saying why', async ({
      page,
    }) => {
      await previewAccountsAndContacts(page);
      // Selected in the sidebar after the preview: the run would have gone there.
      await sendExtensionMessage(page, {
        type: 'org:selected',
        id: 'host-org-selected',
        payload: { orgId: QA_SANDBOX.id },
      });
      await page.waitForSelector('[data-testid="clone-error"]', { timeout: 10_000 });
      const results = await checkAccessibility(page);
      expectNoViolations(results);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="clone-error"]'),
      ).toBeGreaterThan(0);
    });

    test('Seed Clone while it runs', async ({ page }) => {
      await previewAccountsAndContacts(page);
      await page.getByTestId('clone-preview-execute').click();
      await page.waitForSelector('[data-testid="clone-executing"]', { timeout: 10_000 });
      const results = await checkAccessibility(page);
      expectNoViolations(results);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="clone-executing"]'),
      ).toBeGreaterThan(0);
    });

    test('Seed Clone results saying what the second pass left empty, which fields the target lacks, and the owners it does not hold', async ({
      page,
    }) => {
      await previewAccountsAndContacts(page);
      await page.getByTestId('clone-preview-execute').click();
      await bridge.waitForMessage('seed:clone:execute', { timeout: 10_000 });
      await answerAll(page, 'seed:clone:execute', 'seed:clone:execute:response', {
        status: 'success',
        totalSourceRecords: 34,
        totalInserted: 34,
        totalFailed: 0,
        durationMs: 4200,
        secondPass: {
          owed: 3,
          filled: 2,
          samples: [
            {
              record: `Account source=${fakeId('001', 7)} target=${fakeId('001', 8)} Key_Contact__c=<source ${fakeId('003', 9)}>`,
              messages: [
                `Cycle FK 'Key_Contact__c' could not be resolved — referenced parent (source ${fakeId('003', 9)}) was not cloned`,
              ],
            },
          ],
        },
        objectResults: [
          {
            objectApiName: 'Account',
            sourceCount: 16,
            insertedCount: 16,
            failedCount: 0,
            fieldsNotInTarget: ['Legacy__c', 'Region__c'],
            idMappings: [{ sourceId: fakeId('001', 7), targetId: fakeId('001', 8) }],
            errors: [],
          },
          {
            objectApiName: 'Contact',
            sourceCount: 18,
            insertedCount: 18,
            failedCount: 0,
            lookupsNotCarried: [{ field: 'OwnerId', records: 18 }],
            idMappings: [{ sourceId: fakeId('003', 1), targetId: fakeId('003', 2) }],
            errors: [],
          },
        ],
      });
      await page.waitForSelector('[data-testid="clone-results-second-pass"]', {
        timeout: 10_000,
      });
      await expect(page.getByTestId('clone-results-lookups-not-carried')).toContainText(
        'Contact — OwnerId on 18 records',
      );
      const results = await checkAccessibility(page);
      expectNoViolations(results);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="clone-results-second-pass"]'),
      ).toBeGreaterThan(0);
      expect(
        await contrastMeasuredIn(
          page,
          results,
          '[data-testid="clone-results-fields-not-in-target"]',
        ),
      ).toBeGreaterThan(0);
      expect(
        await contrastMeasuredIn(
          page,
          results,
          '[data-testid="clone-results-lookups-not-carried"]',
        ),
      ).toBeGreaterThan(0);
    });

    test('Seed Clone results of a clone cancelled before its second pass', async ({ page }) => {
      await previewAccountsAndContacts(page);
      await page.getByTestId('clone-preview-execute').click();
      await bridge.waitForMessage('seed:clone:execute', { timeout: 10_000 });
      await answerAll(page, 'seed:clone:execute', 'seed:clone:execute:response', {
        status: 'partial',
        cancelled: true,
        totalSourceRecords: 16,
        totalInserted: 16,
        totalFailed: 0,
        durationMs: 2100,
        secondPass: {
          owed: 2,
          filled: 0,
          cancelledBefore: true,
          samples: [
            {
              record: 'Account: 2 lookups not sent',
              messages: ['The run was cancelled before they were filled in: they stay empty.'],
            },
          ],
        },
        objectResults: [
          {
            objectApiName: 'Account',
            sourceCount: 16,
            insertedCount: 16,
            failedCount: 0,
            idMappings: [{ sourceId: fakeId('001', 7), targetId: fakeId('001', 8) }],
            errors: [],
          },
        ],
      });
      await page.waitForSelector('[data-testid="clone-results-cancelled"]', { timeout: 10_000 });
      const results = await checkAccessibility(page);
      expectNoViolations(results);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="clone-results-cancelled"]'),
      ).toBeGreaterThan(0);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="clone-results-second-pass"]'),
      ).toBeGreaterThan(0);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="clone-results-summary"]'),
      ).toBeGreaterThan(0);
    });

    test('Seed Clone preview neutralizing emails and phone numbers, then keeping them, with the warning it gives', async ({
      page,
    }) => {
      await previewAccountsAndContacts(page);
      await expect(page.getByTestId('clone-preview-contact-points')).toBeVisible();
      let results = await checkAccessibility(page);
      expectNoViolations(results);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="clone-preview-contact-points"]'),
      ).toBeGreaterThan(0);

      await page.getByTestId('clone-keep-contact-points').check();
      await expect(page.getByTestId('clone-keep-contact-points-warning')).toBeVisible();
      results = await checkAccessibility(page);
      expectNoViolations(results);
      expect(
        await contrastMeasuredIn(
          page,
          results,
          '[data-testid="clone-keep-contact-points-warning"]',
        ),
      ).toBeGreaterThan(0);
    });

    for (const contactPoints of [
      {
        neutralized: true,
        fields: [
          { objectApiName: 'Contact', field: 'Email', kind: 'email', values: 18 },
          { objectApiName: 'Contact', field: 'Phone', kind: 'phone', values: 12 },
        ],
        values: 30,
      },
      { neutralized: false, fields: [], values: 0 },
    ]) {
      test(`Seed Clone results saying the emails and phone numbers were ${contactPoints.neutralized ? 'neutralized' : 'kept as read'}`, async ({
        page,
      }) => {
        await previewAccountsAndContacts(page);
        await page.getByTestId('clone-preview-execute').click();
        await bridge.waitForMessage('seed:clone:execute', { timeout: 10_000 });
        await answerAll(page, 'seed:clone:execute', 'seed:clone:execute:response', {
          status: 'success',
          totalSourceRecords: 18,
          totalInserted: 18,
          totalFailed: 0,
          durationMs: 1800,
          contactPoints,
          objectResults: [
            {
              objectApiName: 'Contact',
              sourceCount: 18,
              insertedCount: 18,
              failedCount: 0,
              idMappings: [{ sourceId: fakeId('003', 1), targetId: fakeId('003', 2) }],
              errors: [],
            },
          ],
        });
        await page.waitForSelector('[data-testid="forge-results-contact-points"]', {
          timeout: 10_000,
        });
        const results = await checkAccessibility(page);
        expectNoViolations(results);
        expect(
          await contrastMeasuredIn(page, results, '[data-testid="forge-results-contact-points"]'),
        ).toBeGreaterThan(0);
      });
    }

    test('Seed Clone with no org selected, saying on both steps why it cannot preview', async ({
      page,
    }) => {
      // Neither org connected: nothing is selected, so the clone has no target.
      await navigateToModule(bridge, page, 'seed', 'panel-app', { theme });
      await bridge.seedOrgs(MOCK_ORGS.map((org) => ({ ...org, status: 'expired' })));
      await page.getByTestId('mode-card-clone').click();
      await page.waitForSelector('[data-testid="clone-no-target"]', { timeout: 10_000 });
      const atSource = await checkAccessibility(page);
      expectNoViolations(atSource);
      expect(
        await contrastMeasuredIn(page, atSource, '[data-testid="clone-no-target"]'),
      ).toBeGreaterThan(0);

      await page.getByTestId('clone-source-select').selectOption(DEV_SANDBOX.id);
      await bridge.waitForMessage('seed:clone:describe-source', { timeout: 10_000 });
      await answerAll(page, 'seed:clone:describe-source', 'seed:clone:describe-source:response', {
        objects: [{ apiName: 'Account', label: 'Account', recordCount: -1 }],
      });
      await page.getByTestId('clone-wizard-next').click();
      await page.getByTestId('clone-obj-check-Account').check();
      await page.waitForSelector('[data-testid="clone-needs-both-orgs"]', { timeout: 10_000 });
      const results = await checkAccessibility(page);
      expectNoViolations(results);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="clone-needs-both-orgs"]'),
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

    test('Migration page editing an imported config: an object left out, an upsert with no key', async ({
      page,
    }) => {
      /** A config as the SFDMU importer converts it, its org ids placeholders the run replaces. */
      const imported = {
        id: 'cfg-sfdmu',
        name: 'SFDMU Import',
        sourceOrgId: 'imported-source',
        targetOrgId: 'imported-target',
        direction: 'source_to_target',
        mode: 'full',
        objects: [
          {
            objectApiName: 'Account',
            operation: 'upsert',
            externalIdField: 'External_Id__c',
            fieldMappings: [],
            transformRules: [],
            excludedFields: ['CreatedDate'],
            addOnFields: [],
            batchSize: 200,
            insertOrder: 1,
          },
          {
            objectApiName: 'Contact',
            operation: 'insert',
            fieldMappings: [],
            transformRules: [],
            excludedFields: [],
            addOnFields: [],
            batchSize: 200,
            insertOrder: 2,
          },
        ],
        conflictStrategy: 'source_wins',
        enableRollback: false,
        createdAt: '2026-09-01T08:00:00.000Z',
        updatedAt: '2026-09-01T08:00:00.000Z',
      };
      await navigateToModule(bridge, page, 'migration', 'migration-page', { theme, orgs: true });
      expectNoViolations(await checkAccessibility(page));

      await page.getByTestId('migration-path-input').fill('/home/qa/sfdmu/export.json');
      await page.getByTestId('migration-import-btn').click();
      await bridge.waitForMessage('migration:import-sfdmu', { timeout: 10_000 });
      await answerAll(page, 'migration:import-sfdmu', 'migration:import-sfdmu:response', {
        success: true,
        detectedFormat: 'sfdmu',
        config: imported,
      });
      await page.getByTestId('migration-edit').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('object-entry-Contact')).toBeVisible();
      expectNoViolations(await checkAccessibility(page));

      // The contact left out, and offered back; the accounts upserted with no key.
      await page.getByTestId('remove-obj-Contact').click();
      await expect(page.getByTestId('object-entry-Contact')).toHaveCount(0);
      await page.getByLabel('External ID — Account').fill('');
      await page.getByTestId('migration-edit-problem').waitFor({ timeout: 10_000 });
      const edited = await checkAccessibility(page);
      expectNoViolations(edited);
      expect(
        await contrastMeasuredIn(page, edited, '[data-testid="migration-edit-problem"]'),
      ).toBeGreaterThan(0);
    });

    test('Migration page saving an import as a Sync configuration: refused, then saved', async ({
      page,
    }) => {
      await navigateToModule(bridge, page, 'migration', 'migration-page', { theme, orgs: true });
      await page.getByTestId('migration-path-input').fill('/home/qa/sfdmu/export.json');
      await page.getByTestId('migration-import-btn').click();
      await bridge.waitForMessage('migration:import-sfdmu', { timeout: 10_000 });
      await answerAll(page, 'migration:import-sfdmu', 'migration:import-sfdmu:response', {
        success: true,
        detectedFormat: 'sfdmu',
        config: {
          id: 'cfg-sfdmu',
          name: 'SFDMU Import',
          sourceOrgId: 'imported-source',
          targetOrgId: 'imported-target',
          direction: 'source_to_target',
          mode: 'full',
          objects: [
            {
              objectApiName: 'Account',
              operation: 'insert',
              fieldMappings: [],
              transformRules: [],
              excludedFields: [],
              addOnFields: [],
              batchSize: 200,
              insertOrder: 1,
            },
          ],
          conflictStrategy: 'source_wins',
          enableRollback: false,
        },
      });
      await page.getByTestId('migration-save-sync').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('migration-save-sync-btn')).toBeDisabled();

      await page.getByTestId('migration-run-source').selectOption(DEV_SANDBOX.id);
      await page.getByTestId('migration-run-target').selectOption(QA_SANDBOX.id);
      await page.getByTestId('migration-save-sync-name').fill('Nightly accounts');
      await page.getByTestId('migration-save-sync-btn').click();
      const asked = await bridge.waitForMessage('migration:save-sync-config', { timeout: 10_000 });
      expect(asked.payload).toMatchObject({
        name: 'Nightly accounts',
        config: { sourceOrgId: DEV_SANDBOX.id, targetOrgId: QA_SANDBOX.id },
      });

      // The host refuses a name another saved configuration has.
      await answerAll(page, 'migration:save-sync-config', 'migration:save-sync-config:response', {
        success: false,
        code: 'DUPLICATE_NAME',
      });
      await expect(page.getByTestId('migration-save-sync-error')).toContainText(
        'already named “Nightly accounts”',
      );
      const refused = await checkAccessibility(page);
      expectNoViolations(refused);
      expect(
        await contrastMeasuredIn(page, refused, '[data-testid="migration-save-sync-error"]'),
      ).toBeGreaterThan(0);

      await page.getByTestId('migration-save-sync-name').fill('Nightly accounts 2');
      await page.getByTestId('migration-save-sync-btn').click();
      await answerAll(page, 'migration:save-sync-config', 'migration:save-sync-config:response', {
        success: true,
        id: 'cfg-saved',
        name: 'Nightly accounts 2',
      });
      await expect(page.getByTestId('migration-save-sync-saved')).toContainText(
        '“Nightly accounts 2”',
      );
      const saved = await checkAccessibility(page);
      expectNoViolations(saved);
      expect(
        await contrastMeasuredIn(page, saved, '[data-testid="migration-save-sync-saved"]'),
      ).toBeGreaterThan(0);
    });

    test('Reports page', async ({ page }) => {
      await navigateToModule(bridge, page, 'reports', 'reports-page', { theme });
      // Nothing has answered yet: each tab says it is loading. All four said
      // "Coming soon" until the host answered, about features it already had.
      await expect(page.getByRole('tab')).toHaveCount(4);
      await expect(page.getByTestId('reports-executions-loading')).toBeVisible();
      await expect(page.getByTestId('reports-page')).not.toContainText('Coming soon');
      const results = await checkAccessibility(page);
      expectNoViolations(results);
    });

    test('Reports audit trail and lineage, with runs recorded', async ({ page }) => {
      await navigateToModule(bridge, page, 'reports', 'reports-page', { theme });
      await answerAll(page, 'reports:audit', 'reports:audit:response', REPORTS_AUDIT);
      await answerAll(page, 'reports:lineage', 'reports:lineage:response', REPORTS_LINEAGE);

      await page.getByRole('tab', { name: 'Audit Trail' }).click();
      await page.waitForSelector('[data-testid="audit-audit-forge"]', { timeout: 10_000 });
      // The skipped object's row is scanned with the rest of the entry, and
      // so are the records written without a field the target refused.
      await expect(page.getByTestId('audit-audit-forge')).toContainText(
        'Contract skipped, record count unknown',
      );
      await expect(page.getByTestId('audit-audit-forge')).toContainText(
        '1 written without a field the target refused',
      );
      // So is the line a removal of what an earlier one left carries.
      await expect(page.getByTestId('audit-left-by-audit-removal')).toBeVisible();
      // And how the clone was set up, with its export buttons.
      await expect(page.getByTestId('audit-context-audit-forge')).toContainText(
        'Review skipped · Simulated 6 min before',
      );
      await expect(page.getByTestId('audit-export-csv')).toBeEnabled();
      expectNoViolations(await checkAccessibility(page));

      // The export asks for every entry the filters match, then saves them.
      await page.getByTestId('audit-export-csv').click();
      const exportRequest = await postedMessage(page, 'reports:audit', (m) => m.limit === 2000);
      await sendExtensionMessage(page, {
        type: 'reports:audit:response',
        id: `resp-${exportRequest.id}`,
        correlationId: exportRequest.id,
        payload: {
          ...REPORTS_AUDIT,
          entries: [
            ...REPORTS_AUDIT.entries,
            { ...REPORTS_AUDIT.entries[2], id: 'audit-formula', orgAlias: '=1+1' },
          ],
        },
      });
      const saved = await postedMessage(page, 'file:save');
      const content = String(saved.payload.content);
      expect(saved.payload.suggestedName).toMatch(/^sandforge-audit-trail-.*\.csv$/);
      expect(content.split('\n')).toHaveLength(5);
      expect(content).toContain('"sha256:0123456789ab"');
      expect(content).toContain(`"'=1+1"`);
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

    test('Reports whose read failed, saying so on Executions and Analytics, with a retry', async ({
      page,
    }) => {
      await navigateToModule(bridge, page, 'reports', 'reports-page', { theme });
      // The Executions tab said "No reports generated yet", and Analytics was gone.
      await answerAll(page, 'reports:list', 'reports:error', {
        message: 'timed out',
        code: 'UNKNOWN',
        retryable: true,
      });
      await expect(page.getByTestId('reports-executions-error-message')).toContainText(
        'The reports could not be read: timed out',
      );
      await expect(page.getByTestId('reports-executions-error-retry')).toBeVisible();
      await expect(page.getByTestId('reports-page')).not.toContainText('No reports generated yet');
      const executions = await checkAccessibility(page);
      expectNoViolations(executions);
      expect(
        await contrastMeasuredIn(page, executions, '[data-testid="reports-executions-error"]'),
      ).toBeGreaterThan(0);

      await page.getByRole('tab', { name: 'Analytics' }).click();
      await expect(page.getByTestId('reports-analytics-error-message')).toContainText(
        'The analytics could not be loaded',
      );
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

    test('Help on Forge, naming Clone directly and the Graph/Table choice', async ({ page }) => {
      await navigateToModule(bridge, page, 'help', 'help-page', { theme });
      await page.getByTestId('help-section-forge').getByRole('button').click();

      const content = page.locator('#help-content-forge');
      await expect(content).toContainText('Clone directly');
      await expect(content).toContainText('Graph View / Table View');
      const results = await checkAccessibility(page);
      expectNoViolations(results);
      expect(await contrastMeasuredIn(page, results, '#help-content-forge')).toBeGreaterThan(0);
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
          // A clone that stopped part way, offered to be taken up where it stopped.
          run('op-forge-stopped', 'forge', 'failed', {
            error: 'Forge execution finished with a failure status.',
            resumeRun: 'forge-run-stopped',
          }),
          // A sync running and one paused: the runs Live Operations can pause.
          run('op-sync', 'sync', 'running', { pausable: true }),
          run('op-sync-paused', 'sync', 'paused', { pausable: true }),
        ],
      });
      await page.getByTestId('live-op-op-frozen').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('cancel-op-forge')).toBeVisible();
      await expect(page.getByTestId('pause-op-sync')).toBeVisible();
      await expect(page.getByTestId('resume-op-sync-paused')).toBeVisible();
      await expect(page.getByTestId('pause-op-forge')).toHaveCount(0);
      await expect(page.getByTestId('resume-run-op-forge-stopped')).toBeVisible();
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

      // Each slice of the donut painted in the theme's hue of the dot on its
      // row: a slice took its class from a Recharts `Cell`, which Recharts 3
      // deprecates, and is drawn through the Pie's shape instead.
      await expect(
        page.getByTestId('storage-donut-chart').locator('path.recharts-sector'),
      ).toHaveCount(3);
      const painted = await page.evaluate(() => {
        const slices = document.querySelectorAll(
          '[data-testid="storage-donut-chart"] path.recharts-sector',
        );
        const dots = ['ObjectPermissions', 'FieldPermissions', 'LoginHistory'].map((name) =>
          document.querySelector(`[data-testid="storage-row-${name}"] > span`),
        );
        return {
          slices: [...slices].map((slice) => getComputedStyle(slice).fill),
          dots: dots.map((dot) => (dot ? getComputedStyle(dot).backgroundColor : '')),
        };
      });
      expect(painted.slices).toEqual(painted.dots);
      expect(new Set(painted.slices).size).toBe(3);
      // Not the grey Recharts fills a slice with when nothing else does.
      expect(painted.slices).not.toContain('rgb(128, 128, 128)');

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

    test('Automation schedule and sandbox refresh triggers saying what they will do, and a saved webhook trigger why it starts nothing', async ({
      page,
    }) => {
      await navigateToModule(bridge, page, 'automation', 'automation-page', { theme, orgs: true });
      // The panel adds no webhook trigger; a pipeline an older release saved
      // can hold one, and its card says why it starts nothing.
      await answerAll(page, 'pipeline:list', 'pipeline:list:response', {
        pipelines: [PIPELINE_WITH_A_WEBHOOK_TRIGGER],
        triggers: [],
      });
      await page.getByTestId(`saved-pipeline-${PIPELINE_WITH_A_WEBHOOK_TRIGGER.id}`).click();
      await page.getByRole('tab', { name: 'Triggers' }).click();
      for (const type of ['schedule', 'sandbox_refresh']) {
        await page.getByTestId('trigger-type-select').selectOption(type);
        await page.getByTestId('add-trigger-btn').click();
      }
      await page
        .locator('[data-testid^="trigger-soon-reason-"]')
        .first()
        .waitFor({ state: 'visible', timeout: 5000 });
      await expect(page.getByTestId('trigger-config')).not.toContainText('Coming soon');
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

    // ── The first five minutes: one org, or none ──────────────────────────

    test('Side panel with no org: the card that connects the first one', async ({ page }) => {
      await openPanel(bridge, page, 'sidepanel', theme);
      await page.getByTestId('sidepanel-root').waitFor({ timeout: 10_000 });
      await bridge.stream([
        { type: 'org:list:response', payload: { orgs: [], selectedOrgId: null } },
        { type: 'sidebar:cliOrgs', payload: { count: 3 } },
      ]);
      const card = page.getByTestId('sidepanel-first-org');
      await expect(card).toContainText('Import up to 3 orgs from the Salesforce CLI');
      await expect(page.getByTestId('sidepanel-metrics')).toHaveCount(0);

      await expectReadable(page, theme);
    });

    test('Side panel with one Developer Edition: the Seed hero, and Advanced open', async ({
      page,
    }) => {
      await openPanel(bridge, page, 'sidepanel', theme);
      await page.getByTestId('sidepanel-root').waitFor({ timeout: 10_000 });
      await bridge.stream([
        {
          type: 'org:list:response',
          payload: {
            orgs: [{ ...DEV_SANDBOX, orgType: 'Developer' }],
            selectedOrgId: DEV_SANDBOX.id,
          },
        },
      ]);
      const hero = page.getByTestId('sidepanel-seed-hero');
      await expect(hero).toContainText('Fill with demo data');
      await expect(page.getByTestId('sidepanel-seed-hero-alias')).toHaveText(DEV_SANDBOX.alias);
      await expect(hero).toHaveAttribute('title', `Fill ${DEV_SANDBOX.alias} with demo data`);
      await page.getByTestId('sidepanel-advanced-toggle').click();
      await expect(page.getByTestId('sidepanel-nav-compare')).toBeVisible();

      await expectReadable(page, theme);
    });

    test.describe('in German, in a sidebar column about 125 pixels wide', () => {
      test.use({ locale: 'de-DE', viewport: { width: 215, height: 900 } });

      test('Side panel with one scratch org: the fill verb whole, each module name wrapped, none cut', async ({
        page,
      }) => {
        // "Mit Demodaten füllen: <alias>" truncated to one line, and
        // "Eingefrorenes Dataset", 134 pixels, read "Eingefrorenes Dat…".
        const alias = 'test-abcdefghijklmnop@example.com';
        await openPanel(bridge, page, 'sidepanel', theme);
        await bridge.respondToNext(
          'i18n:locale',
          'i18n:locale:response',
          { lng: 'de', bundle: DE_BUNDLE },
          { timeout: 10_000 },
        );
        await page.getByTestId('sidepanel-root').waitFor({ timeout: 10_000 });
        await bridge.stream([
          {
            type: 'org:list:response',
            payload: {
              orgs: [{ ...DEV_SANDBOX, alias, orgType: 'Scratch' }],
              selectedOrgId: DEV_SANDBOX.id,
            },
          },
        ]);
        await page.getByTestId('sidepanel-advanced-toggle').click();

        const hero = page.getByTestId('sidepanel-seed-hero');
        const verb = hero.getByText('Mit Demodaten füllen', { exact: true });
        await expect(verb).toBeVisible();
        await expect(hero).toHaveAttribute('title', `Mit Demodaten füllen: ${alias}`);
        const frozen = page.getByTestId('sidepanel-nav-frozen').getByText('Eingefrorenes Dataset');
        const names = [
          verb,
          frozen,
          page.getByTestId('sidepanel-nav-automation').getByText('Automatisierung'),
          page.getByTestId('sidepanel-nav-orgs').getByText('Organisationen'),
        ];
        for (const name of names) {
          const box = await name.evaluate((el) => ({
            text: el.textContent,
            cut: el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight,
          }));
          expect(box).toEqual({ text: box.text, cut: false });
        }
        // Wider than the column on one line, the name takes two; in fonts that
        // set it narrower, as a CI runner's do, one. Never more, never cut.
        const { lines, wider } = await frozen.evaluate((el) => {
          const lines =
            el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight);
          const range = document.createRange();
          range.selectNodeContents(el);
          const words = [...range.getClientRects()].reduce((sum, rect) => sum + rect.width, 0);
          return { lines: Math.round(lines), wider: words > el.clientWidth + 0.5 };
        });
        expect(lines).toBe(wider ? 2 : 1);

        await expectReadable(page, theme);
      });
    });

    test('Organizations before a click: the CLI that does not answer, and More methods open', async ({
      page,
    }) => {
      await openPanel(bridge, page, 'orgs', theme);
      await bridge.seedOrgs([]);
      await bridge.waitForMessage('org:cli-status', { timeout: 10_000 });
      await answerAll(page, 'org:cli-status', 'org:cli-status:response', {
        available: false,
        orgCount: 0,
      });
      await expect(page.getByTestId('org-cli-missing')).toBeVisible({ timeout: 10_000 });
      await page.getByTestId('org-auth-more').click();
      await expect(page.getByTestId('org-auth-jwt')).toBeVisible();

      await expectReadable(page, theme);
    });

    test('Organizations after an import that found no org: the browser sign-in opened', async ({
      page,
    }) => {
      await openPanel(bridge, page, 'orgs', theme);
      await bridge.seedOrgs([]);
      await page.getByTestId('org-auth-sfdx_import').click();
      const request = await bridge.waitForMessage('org:connect', { timeout: 10_000 });
      await sendExtensionMessage(page, {
        type: 'org:error',
        id: 'err-no-cli-orgs',
        correlationId: String(request.id),
        payload: {
          message: 'The Salesforce CLI holds no connected org yet.',
          code: 'NO_CLI_ORGS',
          retryable: false,
        },
      });
      await expect(page.getByTestId('org-inline-form')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('org-connect-error')).toContainText('OAuth (Web)');

      await expectReadable(page, theme);
    });

    test('Organizations after the first org connects: what to do with it', async ({ page }) => {
      await openPanel(bridge, page, 'orgs', theme);
      await bridge.seedOrgs([]);
      await page.getByTestId('org-auth-oauth_web').click();
      await page.getByTestId('org-inline-connect').click();
      const request = await bridge.waitForMessage('org:connect', { timeout: 10_000 });
      const developer = { ...DEV_SANDBOX, orgType: 'Developer' };
      await sendExtensionMessage(page, {
        type: 'org:list:response',
        id: 'list-after-connect',
        payload: { orgs: [developer] },
      });
      await sendExtensionMessage(page, {
        type: 'org:statusChanged',
        id: 'connected',
        correlationId: String(request.id),
        payload: { orgId: developer.id, status: 'connected' },
      });
      const card = page.getByTestId('org-connected-next');
      await expect(card).toContainText(`${DEV_SANDBOX.alias} is connected`, { timeout: 10_000 });
      await expect(page.getByTestId('org-connected-next-fill')).toBeVisible();

      await expectReadable(page, theme);
    });

    test('Forge with one org: the way to Seed', async ({ page }) => {
      await openPanel(bridge, page, 'forge', theme);
      await bridge.seedOrgs([DEV_SANDBOX]);
      await expect(page.getByTestId('forge-seed-instead')).toBeVisible({ timeout: 10_000 });

      await expectReadable(page, theme);
    });

    test('Sync with one org: the way to Seed under its empty state', async ({ page }) => {
      await openPanel(bridge, page, 'sync', theme);
      await bridge.seedOrgs([DEV_SANDBOX]);
      await expect(page.getByTestId('empty-tour-link')).toContainText(
        'Only one org? Generate realistic data with Seed',
        { timeout: 10_000 },
      );

      await expectReadable(page, theme);
    });

    test('Autopilot with one org: the way to Seed on its first step', async ({ page }) => {
      await openPanel(bridge, page, 'autopilot', theme);
      await bridge.seedOrgs([DEV_SANDBOX]);
      await expect(page.getByTestId('autopilot-seed-instead')).toBeVisible({ timeout: 10_000 });

      await expectReadable(page, theme);
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

      // Select orgs and advance to Step 2. `next` fires `autopilot:list-objects`
      // through useBridgeMutation, which drops any response whose
      // `correlationId` is not the request's id — hence respondToNext rather
      // than a bare respond on the result channel.
      await page.getByTestId('source-org-org-src-1').click();
      await page.getByTestId('target-org-org-tgt-1').click();
      await page.getByTestId('seed-wizard-next').click();
      // With an object the target lacks: its row says so, and the count of
      // the objects shown is offered.
      await bridge.respondToNext('autopilot:list-objects', 'autopilot:objects-listed', {
        objects: [...MOCK_LISTING, MISSING_IN_TARGET],
      });

      await page.getByTestId('step2-objects').waitFor({ state: 'visible', timeout: 5000 });
      await page.getByTestId('object-Shipment__c-missing').waitFor({ state: 'visible' });
      await page.getByTestId('count-shown-button').waitFor({ state: 'visible' });
      const step2 = await checkAccessibility(page);
      expectNoViolations(step2);

      // Nothing is picked for the user: every listed object is picked, the
      // selection scanned, and its plan asked for at once.
      await pickAutopilotObjectsAndScan(bridge, page);

      // Step 3: Review — the plan's numbers, the neutralization of emails and
      // phone numbers, and the framework behind its disclosure, opened.
      await bridge.respondToNext('autopilot:generate-plan', 'autopilot:plan-ready', {
        plan: MOCK_PLAN,
        graph: MOCK_GRAPH,
      });
      await page.getByTestId('step4-review').waitFor({ state: 'visible', timeout: 5000 });
      const review = await checkAccessibility(page);
      expectNoViolations(review);
      await page.getByTestId('step4-compliance-advanced').locator('summary').click();
      await page.getByTestId('compliance-picker').waitFor({ state: 'visible', timeout: 5000 });
      const advanced = await checkAccessibility(page);
      expectNoViolations(advanced);
    });

    test('Autopilot wizard while its scan runs, then while its plan is built, saying so', async ({
      page,
    }) => {
      await navigateToModule(bridge, page, 'autopilot', 'autopilot-page', { theme, orgs: true });
      await page.getByTestId('source-org-org-src-1').click();
      await page.getByTestId('target-org-org-tgt-1').click();
      await page.getByTestId('seed-wizard-next').click();
      // Not answered yet: the scan stays under way while the page is scanned.
      await page.getByTestId('autopilot-scan-loading').waitFor({ timeout: 5000 });
      const scanning = await checkAccessibility(page);
      expectNoViolations(scanning);
      expect(
        await contrastMeasuredIn(page, scanning, '[data-testid="autopilot-scan-loading"]'),
      ).toBeGreaterThan(0);

      await bridge.respondToNext('autopilot:list-objects', 'autopilot:objects-listed', {
        objects: MOCK_LISTING,
      });
      await page.getByTestId('step2-objects').waitFor({ state: 'visible', timeout: 5000 });
      await pickAutopilotObjectsAndScan(bridge, page);
      await page.getByTestId('autopilot-plan-loading').waitFor({ timeout: 5000 });
      const planning = await checkAccessibility(page);
      expectNoViolations(planning);
      expect(
        await contrastMeasuredIn(page, planning, '[data-testid="autopilot-plan-loading"]'),
      ).toBeGreaterThan(0);
    });

    test('Autopilot review given back with the keyboard when the Production Guard refuses the run', async ({
      page,
    }) => {
      await navigateToModule(bridge, page, 'autopilot', 'autopilot-page', { theme, orgs: true });
      await page.getByTestId('source-org-org-src-1').click();
      await page.getByTestId('target-org-org-tgt-1').click();
      await page.getByTestId('seed-wizard-next').click();
      await bridge.respondToNext('autopilot:list-objects', 'autopilot:objects-listed', {
        objects: MOCK_LISTING,
      });
      await page.getByTestId('step2-objects').waitFor({ state: 'visible', timeout: 5000 });
      await pickAutopilotObjectsAndScan(bridge, page);
      await bridge.respondToNext('autopilot:generate-plan', 'autopilot:plan-ready', {
        plan: MOCK_PLAN,
        graph: MOCK_GRAPH,
      });
      await page.getByTestId('execute-button').focus();
      await page.keyboard.press('Enter');
      await bridge.respondToNext('autopilot:execute', 'autopilot:error', {
        message: 'Operation blocked by Production Guard: production org',
        code: 'EXECUTE_ERROR',
        retryable: false,
      });

      const error = page.getByTestId('autopilot-execute-error');
      await error.waitFor({ state: 'visible', timeout: 5000 });
      await expect(page.getByRole('group', { name: 'Review Plan', exact: true })).toBeFocused();
      const refused = await checkAccessibility(page);
      expectNoViolations(refused);
      expect(
        await contrastMeasuredIn(page, refused, '[data-testid="autopilot-execute-error"]'),
      ).toBeGreaterThan(0);
    });

    test('Autopilot review saying what the plan copies, the lookups it leaves empty, and the personal data no rule covers', async ({
      page,
    }) => {
      await navigateToModule(bridge, page, 'autopilot', 'autopilot-page', { theme, orgs: true });
      await page.getByTestId('source-org-org-src-1').click();
      await page.getByTestId('target-org-org-tgt-1').click();
      await page.getByTestId('seed-wizard-next').click();
      await bridge.respondToNext('autopilot:list-objects', 'autopilot:objects-listed', {
        objects: MOCK_LISTING,
      });
      await page.getByTestId('step2-objects').waitFor({ state: 'visible', timeout: 5000 });
      await pickAutopilotObjectsAndScan(bridge, page);
      await bridge.respondToNext('autopilot:generate-plan', 'autopilot:plan-ready', {
        plan: {
          ...MOCK_PLAN,
          anonymizationSummary: {
            ...MOCK_PLAN.anonymizationSummary,
            notCovered: [{ objectApiName: 'Contact', missing: ['phone'] }],
          },
          scope: {
            maxDepth: 5,
            maxObjects: 50,
            selected: ['Contact'],
            parents: [{ objectApiName: 'Account', records: 12 }],
            leftEmpty: [
              {
                objectApiName: 'Account',
                fieldApiName: 'OperatingHoursId',
                target: 'OperatingHours',
                reason: 'standard',
              },
              {
                objectApiName: 'Account',
                fieldApiName: 'Region__c',
                target: 'Region__c',
                reason: 'objects',
                required: true,
              },
            ],
            standardNeeded: [{ objectApiName: 'Account', neededBy: 'Contact.AccountId' }],
            followedByDefault: [{ objectApiName: 'Account', referencedBy: ['Contact.AccountId'] }],
            currencies: { notInTarget: ['GBP'], writtenIn: 'USD', objects: ['Account'] },
          },
        },
        graph: MOCK_GRAPH,
      });
      await page.getByTestId('step4-scope').waitFor({ state: 'visible', timeout: 5000 });
      const review = await checkAccessibility(page);
      expectNoViolations(review);
      for (const testId of [
        'step4-scope',
        'step4-scope-currencies',
        'step4-scope-followed-by-default',
        'step4-not-covered',
      ]) {
        expect(await contrastMeasuredIn(page, review, `[data-testid="${testId}"]`)).toBeGreaterThan(
          0,
        );
      }
    });

    test('Autopilot graph fitted clear of its minimap, legend and controls, on the run and from its fit button', async ({
      page,
    }) => {
      // At 1280×720 the contact lay under a corner of the minimap and one of
      // the legend: the graph was fitted to the whole of a pane the two stand
      // on, along its bottom.
      const clear = Object.fromEntries(AUTOPILOT_GRAPH_OVERLAYS.map((overlay) => [overlay, []]));
      await startAutopilotRun(bridge, page, theme);
      await graphFitted(page, AUTOPILOT_GRAPH);
      // A height of its own, 683px at 1280×720, where the Forge graph's pane
      // took that of the panel beside it.
      expect(await graphPaneHeight(page, AUTOPILOT_GRAPH)).toBeGreaterThanOrEqual(350);
      expect(await autopilotNodesUnderItsOverlays(page)).toEqual(clear);
      expectNoViolations(await checkAccessibility(page));

      // The fit button fits it the same way.
      await page.getByTestId('zoom-out-btn').click();
      await graphFitted(page, AUTOPILOT_GRAPH);
      const zoomedOut = await graphTransform(page, AUTOPILOT_GRAPH);
      await page.getByTestId('fit-view-btn').click();
      await expect.poll(() => graphTransform(page, AUTOPILOT_GRAPH)).not.toBe(zoomedOut);
      await graphFitted(page, AUTOPILOT_GRAPH);
      expect(await autopilotNodesUnderItsOverlays(page)).toEqual(clear);
    });

    test('AI chat after conversation creation', async ({ page }) => {
      await navigateToModule(bridge, page, 'ai', 'ai-chat-panel', { theme, ai: true });

      await createConversation(bridge, page, 'axe-conv', 'Axe Test');

      // Scan with conversation active
      const results = await checkAccessibility(page);
      expectNoViolations(results);
    });

    test('AI page saying what it sends and keeps, with Delete all conversations asked', async ({
      page,
    }) => {
      await navigateToModule(bridge, page, 'ai', 'ai-chat-panel', { theme, ai: true });
      await createConversation(bridge, page, 'axe-conv-del', 'To delete');
      await page.getByTestId('delete-all-conversations-btn').click();
      await expect(page.getByTestId('delete-all-conversations-confirm')).toBeVisible();

      const results = await checkAccessibility(page);
      expectNoViolations(results);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="ai-privacy-note"]'),
      ).toBeGreaterThan(0);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="delete-all-conversations"]'),
      ).toBeGreaterThan(0);
    });

    test('AI chat with assistant response', async ({ page }) => {
      await navigateToModule(bridge, page, 'ai', 'ai-chat-panel', { theme, ai: true });

      await createConversation(bridge, page, 'axe-conv-2', 'Chat');

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

      // Its last step, which suggests a start for the selected org and has no
      // "Don't show again" box any more.
      for (let step = 0; step < 4; step++) {
        await dialog.getByRole('button', { name: 'Next' }).click();
      }
      await dialog.getByTestId('welcome-step-4').waitFor({ state: 'visible', timeout: 5000 });
      await expect(dialog.getByTestId('dont-show-again')).toHaveCount(0);
      expectNoViolations(await checkAccessibility(page));
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
      // palette, which offers only the steps a pipeline runs, are all on
      // screen for the scan.
      await expect(page.getByTestId('step-palette').getByRole('button')).toHaveCount(8);
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

    test('Automation step panel of an Approval, a Condition and a Sync step', async ({ page }) => {
      await navigateToModule(bridge, page, 'automation', 'automation-page', { theme, orgs: true });
      await bridge.waitForMessage('pipeline:sync-configs', { timeout: 10_000 });
      await answerAll(page, 'pipeline:sync-configs', 'pipeline:sync-configs:response', {
        configs: [
          {
            id: 'cfg-1',
            name: 'Dev to QA',
            valid: true,
            sourceOrgId: DEV_SANDBOX.id,
            targetOrgId: QA_SANDBOX.id,
            guard: 'asks',
          },
        ],
      });
      await page.getByTestId('create-pipeline-btn').click();
      // The wait and message of an Approval, the test and threshold of a
      // Condition, the saved configuration of a Sync, each in the side panel.
      await page.getByTestId('palette-approval').click();
      await page.locator('[data-testid^="canvas-step-"]').last().click();
      await page.getByTestId('config-timeoutMinutes').waitFor({ state: 'visible', timeout: 5000 });
      expectNoViolations(await checkAccessibility(page));

      await page.getByTestId('palette-condition').click();
      await page.locator('[data-testid^="canvas-step-"]').last().click();
      await page.getByTestId('config-condition-kind').selectOption('compareDifferences');
      await page.getByTestId('config-condition-threshold').waitFor({ state: 'visible' });
      expectNoViolations(await checkAccessibility(page));

      await page.getByTestId('palette-sync').click();
      await page.locator('[data-testid^="canvas-step-"]').last().click();
      await page.getByTestId('config-configId').selectOption('cfg-1');
      expectNoViolations(await checkAccessibility(page));
    });

    test('Automation run waiting for an Approval, answered beside the step', async ({ page }) => {
      await navigateToModule(bridge, page, 'automation', 'automation-page', { theme, orgs: true });
      await page.getByTestId('create-pipeline-btn').click();
      await page.getByTestId('palette-approval').click();
      await page.getByTestId('run-pipeline-btn').click();
      const request = await bridge.waitForMessage('pipeline:execute');
      const stepId = (request.payload as { pipeline: { steps: Array<{ id: string }> } }).pipeline
        .steps[0].id;
      await sendExtensionMessage(page, {
        type: 'pipeline:step',
        id: 'approval-waiting',
        payload: {
          operationId: request.id,
          stepId,
          status: 'running',
          approval: {
            message: 'Read the comparison first.',
            expiresAt: '2026-10-13T09:00:00.000Z',
          },
        },
      });
      await page.getByTestId(`exec-approve-${stepId}`).waitFor({ state: 'visible', timeout: 5000 });

      expectNoViolations(await checkAccessibility(page));
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

    test('Forge recent runs offering to take a stopped run up where it stopped', async ({
      page,
    }) => {
      const stopped = {
        ...FORGE_REMOVABLE_RUN,
        forgeId: 'forge-run-stopped',
        cancelled: true,
        resumable: true,
        sourceOrgId: DEV_SANDBOX.id,
      };
      await openForgeHistory(bridge, page, theme, stopped);
      await expect(page.getByTestId('forge-history-resume-forge-run-stopped')).toBeVisible();

      expectNoViolations(await checkAccessibility(page));
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
      // Reading what the target runs as the records go, then what it found.
      await expect(dialog.getByTestId('forge-removal-automation-loading')).toBeVisible();
      expectNoViolations(await checkAccessibility(page));
      await bridge.waitForMessage('forge:undo-automation:request', { timeout: 10_000 });
      await answerAll(page, 'forge:undo-automation:request', 'forge:undo-automation:response', {
        forgeId: FORGE_REMOVABLE_RUN.forgeId,
        automation: {
          objectsRead: ['Contact', 'Account'],
          objects: [
            {
              objectApiName: 'Account',
              flows: [],
              triggers: [{ name: 'AccountCleanup', events: ['beforeDelete', 'afterDelete'] }],
            },
            {
              objectApiName: 'Contact',
              flows: [
                {
                  apiName: 'Contact_Gone',
                  label: 'Contact gone',
                  timing: 'beforeSave',
                  startsOn: 'delete',
                  condition: 'read',
                  permissions: [{ name: 'Skip_Delete', bypass: true, held: false }],
                },
              ],
              triggers: [],
            },
          ],
          unread: [],
          conditionsNotRead: 0,
          conditionsBound: 25,
          bypassGrants: [
            {
              permission: 'Skip_Delete',
              permissionSets: [{ name: 'Delete_Quietly', label: 'Delete quietly', grants: 1 }],
            },
          ],
          requests: 7,
        },
        drafted: [],
      });
      await expect(dialog.getByTestId('forge-removal-automation-delete-Account')).toHaveText(
        'Account: Apex trigger: AccountCleanup · before and after delete',
      );
      await expect(dialog.getByTestId('bypass-assistant-command')).toBeVisible();

      const results = await checkAccessibility(page);
      expectNoViolations(results);

      // The command run, the target is read again from the confirmation, and
      // the delete flow the bypass keeps quiet is no longer listed.
      const automationReads = (await bridge.getMessages('forge:undo-automation:request')).length;
      await dialog.getByTestId('bypass-assistant-read-again').click();
      await expect
        .poll(async () => (await bridge.getMessages('forge:undo-automation:request')).length)
        .toBeGreaterThan(automationReads);
      await expect(dialog.getByTestId('bypass-assistant-read-again')).toHaveText('Reading again…');
      await expect(dialog.getByTestId('forge-removal-automation-delete-Contact')).toBeVisible();
      expectNoViolations(await checkAccessibility(page));
      await answerAll(page, 'forge:undo-automation:request', 'forge:undo-automation:response', {
        forgeId: FORGE_REMOVABLE_RUN.forgeId,
        automation: {
          objectsRead: ['Contact', 'Account'],
          objects: [
            {
              objectApiName: 'Account',
              flows: [],
              triggers: [{ name: 'AccountCleanup', events: ['beforeDelete', 'afterDelete'] }],
            },
            {
              objectApiName: 'Contact',
              flows: [
                {
                  apiName: 'Contact_Gone',
                  label: 'Contact gone',
                  timing: 'beforeSave',
                  startsOn: 'delete',
                  condition: 'read',
                  permissions: [{ name: 'Skip_Delete', bypass: true, held: true }],
                },
              ],
              triggers: [],
            },
          ],
          unread: [],
          conditionsNotRead: 0,
          conditionsBound: 25,
          bypassGrants: [],
          requests: 6,
        },
        drafted: [],
      });
      await expect(dialog.getByTestId('forge-removal-automation-delete-Contact')).toHaveCount(0);
      await expect(dialog.getByTestId('bypass-assistant')).toHaveCount(0);
      expectNoViolations(await checkAccessibility(page));
    });

    test('Forge run removal result, per object, with what the org refused', async ({ page }) => {
      await openForgeHistory(bridge, page, theme);
      await page.getByTestId(`forge-history-remove-${FORGE_REMOVABLE_RUN.forgeId}`).click();
      await page.getByTestId('danger-input').fill(QA_SANDBOX.alias);
      await page.getByTestId('danger-confirm-btn').click();
      await bridge.waitForMessage('forge:undo', { timeout: 10_000 });
      // Under way, under the run, with its Stop.
      await expect(page.getByTestId('forge-history-removing-stop')).toBeVisible();
      expectNoViolations(await checkAccessibility(page));
      await answerAll(page, 'forge:undo', 'forge:undo:response', {
        result: FORGE_REMOVAL_RESULT,
        operationId: 'forge-undo-1',
      });
      await page.getByTestId('forge-removal-result').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('forge-removal-unchecked')).toBeVisible();

      const results = await checkAccessibility(page);
      expectNoViolations(results);
    });

    test('Forge run removal confirmation with the sweep ticked, listing what it would take', async ({
      page,
    }) => {
      await openForgeHistory(bridge, page, theme);
      await page.getByTestId(`forge-history-remove-${FORGE_REMOVABLE_RUN.forgeId}`).click();
      const dialog = page.getByRole('dialog', {
        name: `Remove this run's records from ${QA_SANDBOX.alias}`,
      });
      await dialog.waitFor({ state: 'visible', timeout: 5000 });
      await dialog.getByTestId('forge-removal-sweep-toggle').check();
      await expect(dialog.getByTestId('forge-sweep-loading')).toBeVisible();
      expectNoViolations(await checkAccessibility(page));
      await bridge.waitForMessage('forge:undo-sweep:request', { timeout: 10_000 });
      await answerAll(page, 'forge:undo-sweep:request', 'forge:undo-sweep:response', {
        forgeId: FORGE_REMOVABLE_RUN.forgeId,
        listing: {
          window: { from: '2026-09-20T09:59:59Z', to: '2026-09-20T10:06:00Z' },
          looked: ['Contact', 'Account', 'Task', 'FeedItem', 'ContentDocumentLink', 'Asset'],
          found: [
            { objectApiName: 'Task', count: 35, names: ['Welcome call', 'Follow up', 'Check'] },
            { objectApiName: 'Asset', count: 66, names: ['Insured risk'] },
            { objectApiName: 'FeedItem', count: 10_000, names: [], overBound: true },
          ],
          unread: [
            {
              objectApiName: 'ContentDocumentLink',
              reason: 'It keeps no creator or creation date.',
            },
          ],
          automationGaps: { flowsNotRead: 2, triggers: 1 },
          handWork: [],
        },
      });
      await expect(dialog.getByTestId('forge-sweep-found-Task')).toBeVisible();
      await dialog.getByTestId('forge-sweep-found-Task').locator('summary').click();
      await expect(dialog.getByText('Welcome call, Follow up, Check, …')).toBeVisible();
      expectNoViolations(await checkAccessibility(page));
    });

    test('Forge run removal result followed by what the sweep did', async ({ page }) => {
      await openForgeHistory(bridge, page, theme);
      await page.getByTestId(`forge-history-remove-${FORGE_REMOVABLE_RUN.forgeId}`).click();
      await page.getByTestId('forge-removal-sweep-toggle').check();
      await page.getByTestId('danger-input').fill(QA_SANDBOX.alias);
      await page.getByTestId('danger-confirm-btn').click();
      await bridge.waitForMessage('forge:undo', { timeout: 10_000 });
      await answerAll(page, 'forge:undo', 'forge:undo:response', {
        result: {
          ...FORGE_REMOVAL_RESULT,
          sweep: {
            status: 'refused',
            refusal:
              'The run’s user created records in the run’s window that neither the run nor the target’s automation writes (Opportunity: 2): hand work, likely.',
            objects: [],
            unread: [],
            handWork: [{ objectApiName: 'Opportunity', count: 2 }],
          },
        },
        operationId: 'forge-undo-1',
      });
      await page.getByTestId('forge-sweep-result').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('forge-sweep-hand-work-Opportunity')).toBeVisible();

      expectNoViolations(await checkAccessibility(page));
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

    test('Frozen load removal confirmation with a sweep ticked, listing what it would take', async ({
      page,
    }) => {
      await openFrozenLastLoad(bridge, page, theme);
      await page.getByTestId('frozen-removal-remove').click();
      await page.getByTestId('frozen-removal-sweep-toggle').check();
      await bridge.waitForMessage('frozen:remove:sweep', { timeout: 10_000 });
      await answerAll(page, 'frozen:remove:sweep', 'frozen:remove:sweep:response', {
        loadedAt: FROZEN_LAST_LOAD_RECORDS.loadedAt,
        listing: {
          window: { from: '2026-09-24T09:59:59Z', to: '2026-09-24T10:06:01Z' },
          looked: ['Contact', 'Account', 'Task', 'FeedItem'],
          found: [
            { objectApiName: 'Task', count: 3, names: ['Follow-up'], overBound: false },
            { objectApiName: 'FeedItem', count: 2, names: [], overBound: false },
          ],
          unread: [],
          handWork: [],
        },
      });
      await page.getByTestId('forge-sweep-found-Task').waitFor({ timeout: 10_000 });

      expectNoViolations(await checkAccessibility(page));
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
      await expect(page.getByTestId('forge-removal-files-Order')).toBeVisible();

      const results = await checkAccessibility(page);
      expectNoViolations(results);
    });

    test('Frozen load removal under way, stopped from its card, with what it stopped at', async ({
      page,
    }) => {
      await openFrozenLastLoad(bridge, page, theme);
      await page.getByTestId('frozen-removal-remove').click();
      await page.getByTestId('danger-input').fill(QA_SANDBOX.alias);
      await page.getByTestId('danger-confirm-btn').click();
      const removal = await bridge.waitForMessage('frozen:remove', { timeout: 10_000 });
      await expect(page.getByTestId('frozen-removal-cancel')).toHaveText('Stop the removal');
      expectNoViolations(await checkAccessibility(page));

      await page.getByTestId('frozen-removal-cancel').click();
      const abort = await bridge.waitForMessage('execution:abort', { timeout: 10_000 });
      expect(abort.payload).toEqual({ operationId: removal.id });
      await answerAll(page, 'execution:abort', 'execution:abort:response', {
        success: true,
        operationId: removal.id,
      });
      await expect(page.getByTestId('frozen-removal-removing')).toContainText('Stopping:');
      await expect(page.getByTestId('frozen-removal-cancel')).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      const stopping = await checkAccessibility(page);
      expectNoViolations(stopping);
      expect(
        await contrastMeasuredIn(page, stopping, '[data-testid="frozen-removal"]'),
      ).toBeGreaterThan(0);

      await answerAll(page, 'frozen:remove', 'frozen:remove:response', {
        result: {
          status: 'cancelled',
          includeChanged: false,
          finishedAt: '2026-09-24T11:00:00.000Z',
          objects: [
            {
              objectApiName: 'OrderItem',
              planned: 24,
              deleted: 24,
              alreadyGone: 0,
              keptChanged: 0,
              keptDependents: 0,
              refused: 0,
              heldBy: [],
              unchecked: [],
              reasons: [],
            },
          ],
        },
        operationId: removal.id,
      });
      await expect(page.getByTestId('forge-removal-result')).toContainText(
        'Stopped before the end',
      );
      await expect(page.getByTestId('frozen-removal-cancel')).toHaveCount(0);
      expectNoViolations(await checkAccessibility(page));
    });

    test('Frozen Load tab offering Verify only for a target a load went into', async ({ page }) => {
      await navigateToModule(bridge, page, 'frozen', 'frozen-page', { theme, orgs: true });
      await bridge.waitForMessage('frozen:status', { timeout: 10_000 });
      await answerAll(page, 'frozen:status', 'frozen:status:response', {
        status: FROZEN_STATUS_AFTER_LOAD,
      });
      await page.getByTestId('page-tab-load').click();
      // The panel selected another org than the one the load went into.
      await expect(page.getByTestId('frozen-verify-no-load')).toContainText(
        'is recorded: load the dataset into it before verifying it.',
      );
      await expect(page.getByTestId('frozen-verify-run')).toHaveAttribute('aria-disabled', 'true');
      const none = await checkAccessibility(page);
      expectNoViolations(none);
      expect(
        await contrastMeasuredIn(page, none, '[data-testid="frozen-verify-no-load"]'),
      ).toBeGreaterThan(0);

      await page.getByTestId('frozen-load-target').click();
      await page.getByTestId(`frozen-load-target-option-${QA_SANDBOX.id}`).click();
      await expect(page.getByTestId('frozen-verify-no-load')).toHaveCount(0);
      await expect(page.getByTestId('frozen-verify-run')).not.toHaveAttribute('aria-disabled');
      expectNoViolations(await checkAccessibility(page));
    });

    test('Frozen last load whose records were removed', async ({ page }) => {
      await openFrozenLastLoad(bridge, page, theme, {
        ...FROZEN_STATUS_AFTER_LOAD,
        loadRecords: [
          {
            ...FROZEN_LAST_LOAD_RECORDS,
            created: [],
            removed: {
              removedAt: '2026-09-24T11:00:00.000Z',
              deleted: 36,
              alreadyGone: 1,
              kept: 1,
              refused: 0,
            },
            // What the platform does not delete, kept by every removal and said.
            keptByThePlatform: [{ objectApiName: 'BusinessHours', count: 1 }],
          },
        ],
      });
      await expect(page.getByTestId('forge-removal-mark')).toBeVisible();
      await expect(page.getByTestId('frozen-removal-kept')).toBeVisible();

      expectNoViolations(await checkAccessibility(page));
    });

    test('Frozen last load recorded before loads kept what they created', async ({ page }) => {
      await openFrozenLastLoad(bridge, page, theme, {
        ...FROZEN_STATUS_AFTER_LOAD,
        loadRecords: [{ ...FROZEN_LAST_LOAD_RECORDS, created: [], linked: 0, recorded: false }],
      });
      await expect(page.getByTestId('frozen-removal-not-recorded')).toBeVisible();

      expectNoViolations(await checkAccessibility(page));
    });

    test('Frozen load before the last one, offered once the last one was removed', async ({
      page,
    }) => {
      await openFrozenLastLoad(bridge, page, theme, {
        ...FROZEN_STATUS_AFTER_LOAD,
        loadRecords: [{ ...FROZEN_LAST_LOAD_RECORDS, earlier: true }],
      });
      await expect(page.getByTestId('frozen-removal-earlier')).toBeVisible();
      await expect(page.getByTestId('frozen-removal-remove')).toBeVisible();

      expectNoViolations(await checkAccessibility(page));
    });

    test('Forge run a removal left records of, offering and confirming the removal of what is left', async ({
      page,
    }) => {
      await openForgeHistory(bridge, page, theme, FORGE_PARTLY_REMOVED_RUN);
      await expect(page.getByTestId('forge-removal-mark')).toBeVisible();
      await expect(
        page.getByTestId(`forge-history-remove-${FORGE_PARTLY_REMOVED_RUN.forgeId}`),
      ).toHaveText("Remove what is left of this run's records");
      expectNoViolations(await checkAccessibility(page));

      await page.getByTestId(`forge-history-remove-${FORGE_PARTLY_REMOVED_RUN.forgeId}`).click();
      const dialog = page.getByRole('dialog', {
        name: `Remove this run's records from ${QA_SANDBOX.alias}`,
      });
      await dialog.waitFor({ state: 'visible', timeout: 5000 });
      await expect(dialog.getByTestId('forge-removal-left-by')).toBeVisible();
      expectNoViolations(await checkAccessibility(page));
    });

    test('Forge removal of what an earlier one left, with its result', async ({ page }) => {
      await openForgeHistory(bridge, page, theme, FORGE_PARTLY_REMOVED_RUN);
      await page.getByTestId(`forge-history-remove-${FORGE_PARTLY_REMOVED_RUN.forgeId}`).click();
      await page.getByTestId('danger-input').fill(QA_SANDBOX.alias);
      await page.getByTestId('danger-confirm-btn').click();
      await bridge.waitForMessage('forge:undo', { timeout: 10_000 });
      await answerAll(page, 'forge:undo', 'forge:undo:response', {
        result: FORGE_REMOVAL_OF_WHAT_WAS_LEFT,
        operationId: 'forge-undo-2',
      });
      await page.getByTestId('forge-removal-result-left-by').waitFor({ timeout: 10_000 });

      expectNoViolations(await checkAccessibility(page));
    });

    test('Frozen last load a removal left records of, offering and confirming the removal of what is left', async ({
      page,
    }) => {
      await openFrozenLastLoad(bridge, page, theme, FROZEN_STATUS_PARTLY_REMOVED);
      await expect(page.getByTestId('forge-removal-mark')).toBeVisible();
      await expect(page.getByTestId('frozen-removal-remove')).toHaveText(
        "Remove what is left of this load's records",
      );
      expectNoViolations(await checkAccessibility(page));

      await page.getByTestId('frozen-removal-remove').click();
      const dialog = page.getByRole('dialog', {
        name: `Remove this load's records from ${QA_SANDBOX.alias}`,
      });
      await dialog.waitFor({ state: 'visible', timeout: 5000 });
      await expect(dialog.getByTestId('forge-removal-left-by')).toBeVisible();
      expectNoViolations(await checkAccessibility(page));
    });

    test('Frozen removal of what an earlier one left, with its result', async ({ page }) => {
      await openFrozenLastLoad(bridge, page, theme, FROZEN_STATUS_PARTLY_REMOVED);
      await page.getByTestId('frozen-removal-remove').click();
      await page.getByTestId('danger-input').fill(QA_SANDBOX.alias);
      await page.getByTestId('danger-confirm-btn').click();
      await bridge.waitForMessage('frozen:remove', { timeout: 10_000 });
      await answerAll(page, 'frozen:remove', 'frozen:remove:response', {
        result: {
          ...FROZEN_REMOVAL_RESULT,
          status: 'success',
          includeChanged: true,
          finishedAt: '2026-09-24T12:00:00.000Z',
          leftBy: FROZEN_REMOVAL_RESULT.finishedAt,
          objects: FORGE_REMOVAL_OF_WHAT_WAS_LEFT.objects,
        },
        operationId: 'frozen-remove-2',
      });
      await page.getByTestId('forge-removal-result-left-by').waitFor({ timeout: 10_000 });

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

    test('Settings AI tab with a key stored and AI on: what is sent, its switches, and the removal of the key asked', async ({
      page,
    }) => {
      await navigateToModule(bridge, page, 'settings', 'settings-page', { theme });
      await page.locator('#tab-ai').click();
      await bridge.waitForMessage('ai:status', { timeout: 10_000 });
      await answerAll(page, 'ai:status', 'ai:status:response', {
        enabled: true,
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        hasKey: true,
        errorResolution: true,
      });
      await expect(page.getByTestId('ai-error-resolution-toggle')).toBeChecked();
      await page.getByTestId('ai-remove-key-btn').click();
      await expect(page.getByTestId('ai-remove-key-question')).toBeVisible();

      const results = await checkAccessibility(page);
      expectNoViolations(results);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="ai-what-is-sent"]'),
      ).toBeGreaterThan(0);
      expect(
        await contrastMeasuredIn(page, results, '[data-testid="ai-key-actions"]'),
      ).toBeGreaterThan(0);
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

/**
 * Open the Sync panel on a saved draft at its Execute step: a bidirectional
 * upsert of accounts between the two sandboxes, ready to simulate or run.
 */
/**
 * Save the configuration on the Sync page's execute step, back on its Review
 * step, and come back: a configuration that copies files is run, and
 * simulated, once it is saved, and Run waits for the save until then.
 */
async function saveSyncConfigFromExecuteStep(bridge: MockBridge, page: Page): Promise<void> {
  await page.getByTestId('sync-wizard-back').click();
  await page.getByTestId('sync-save-config').click();
  const request = await bridge.waitForMessage('sync:config:save');
  const config = (request.payload as { config: { id: string } }).config;
  await bridge.respond(
    'sync:config:save:response',
    { success: true, id: config.id },
    String(request.id),
  );
  await page.getByTestId('sync-config-saved').waitFor({ timeout: 10_000 });
  await page.getByTestId('sync-wizard-next').click();
  await page.getByTestId('sync-step-execute').waitFor({ timeout: 10_000 });
}

async function openSyncExecuteStep(
  bridge: MockBridge,
  page: Page,
  theme: StateTheme,
  draft: Record<string, unknown> = {},
  ready = 'sync-step-execute',
): Promise<void> {
  await bridge.setup(page);
  await paintHostTheme(page, theme);
  await page.addInitScript(
    (args: { source: string; target: string; draft: Record<string, unknown> }) => {
      const host = window as unknown as {
        acquireVsCodeApi: () => { setState: (state: unknown) => void };
        __SANDFORGE_MODULE__?: string;
      };
      host.acquireVsCodeApi().setState({
        syncDraft: {
          currentStep: 4,
          direction: 'bidirectional',
          mode: 'full',
          conflictStrategy: 'target_wins',
          sourceOrgId: args.source,
          targetOrgId: args.target,
          objectEntries: [
            {
              objectApiName: 'Account',
              operation: 'upsert',
              externalIdField: 'Legacy_Key__c',
              batchSize: 200,
              where: '',
            },
          ],
          mappingsByObject: {},
          transforms: [],
          ...args.draft,
        },
      });
      host.__SANDFORGE_MODULE__ = 'sync';
    },
    { source: DEV_SANDBOX.id, target: QA_SANDBOX.id, draft },
  );
  await page.goto('/');
  await bridge.seedOrgs(MOCK_ORGS);
  await page.getByTestId(ready).first().waitFor({ timeout: 10_000 });
}

/** Open the Org Manager's JWT form, with its key file hint and placeholders on screen. */
async function openJwtForm(bridge: MockBridge, page: Page, theme: StateTheme): Promise<void> {
  await openPanel(bridge, page, 'orgs', theme);
  await page.getByTestId('org-manager-page').waitFor({ timeout: 10_000 });
  // JWT is under More methods: it needs a connected app of the user's own.
  await page.getByTestId('org-auth-more').click();
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
  await page.getByTestId('org-auth-more').click();
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
 * target holds, and one it could not read. Into the QA sandbox, or into the
 * target given.
 */
async function openDeployTab(
  bridge: MockBridge,
  page: Page,
  theme: StateTheme,
  target: MockOrg = QA_SANDBOX,
): Promise<void> {
  await openPanel(bridge, page, 'compare', theme);
  await bridge.seedOrgs([DEV_SANDBOX, target]);
  await page.getByTestId('compare-page').waitFor({ timeout: 10_000 });
  await page.getByLabel('Source Org').selectOption(DEV_SANDBOX.id);
  await page.getByLabel('Target Org').selectOption(target.id);
  await page.getByTestId('cat-ApexClass').click();
  await page.getByTestId('run-compare-btn').click();
  await bridge.waitForMessage('compare:execute', { timeout: 10_000 });
  await answerAll(page, 'compare:execute', 'compare:execute:response', {
    configId: '4f1a2b3c-0000-4000-8000-000000000004',
    sourceOrgId: DEV_SANDBOX.id,
    targetOrgId: target.id,
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
      // A person account's names, which an org with person accounts lists on Account.
      {
        fieldApiName: 'FirstName',
        label: 'First Name',
        type: 'string',
        required: false,
        picklistValues: [],
        referenceTo: [],
        length: 40,
      },
      {
        fieldApiName: 'LastName',
        label: 'Last Name',
        type: 'string',
        required: false,
        picklistValues: [],
        referenceTo: [],
        length: 80,
      },
    ],
    // The record types the wizard offers, a person account's marked.
    recordTypes: [
      {
        recordTypeId: '012000000000001AAA',
        developerName: 'PersonAccount',
        label: 'Person Account',
        person: true,
        isDefault: false,
      },
      {
        recordTypeId: '012000000000002AAA',
        developerName: 'Customer',
        label: 'Customer',
        person: false,
        isDefault: true,
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
 * The latest message of `type` the page posted to the host whose payload
 * `matches`, waited for: the page posts it on a click, a render later.
 */
async function postedMessage(
  page: Page,
  type: string,
  matches: (payload: Record<string, unknown>) => boolean = () => true,
): Promise<{ id: string; payload: Record<string, unknown> }> {
  const read = () =>
    page.evaluate((wanted) => {
      const posted = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
      return posted
        .map((m) => ((m as Record<string, unknown>).payload ?? m) as Record<string, unknown>)
        .filter((m) => m.type === wanted)
        .map((m) => ({ id: String(m.id), payload: (m.payload ?? {}) as Record<string, unknown> }));
    }, type);
  await expect.poll(async () => (await read()).some((m) => matches(m.payload))).toBe(true);
  const found = (await read()).filter((m) => matches(m.payload)).pop();
  if (!found) throw new Error(`no '${type}' message was posted`);
  return found;
}

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
  await openSeedConfigure(bridge, page, theme);
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
 * Open the Seed wizard's configure step with Account and Contact selected,
 * both described.
 */
async function openSeedConfigure(bridge: MockBridge, page: Page, theme: StateTheme): Promise<void> {
  await openPanel(bridge, page, 'seed', theme);
  await bridge.seedOrgs(MOCK_ORGS);
  await page.getByTestId('mode-card-generate').click();
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
}

/**
 * Open the Seed wizard's execute step as a run of Account and Contact reaches
 * it: the configure step skipped, both objects described, the banner saying
 * the run uses the default rules, and a relation added on the step itself.
 */
/** What the host answers to the run `openSeedExecuteSkipped` starts: the ids posted are capped. */
const SEED_RUN_RESULT = {
  templateId: 'tpl-axe',
  operationId: 'op-axe',
  status: 'partial',
  objectResults: [
    {
      objectApiName: 'Account',
      recordsCreated: 100,
      recordsFailed: 0,
      createdIds: ['001000000000001AAA', '001000000000002AAA'],
      errors: [],
      truncated: true,
    },
    {
      objectApiName: 'Contact',
      recordsCreated: 290,
      recordsFailed: 10,
      createdIds: [],
      errors: ['REQUIRED_FIELD_MISSING: LastName'],
    },
  ],
  totalRecordsCreated: 390,
  totalRecordsFailed: 10,
  duration: 4200,
  timestamp: '2026-10-01T10:00:00.000Z',
};

async function openSeedExecuteSkipped(
  bridge: MockBridge,
  page: Page,
  theme: StateTheme,
): Promise<void> {
  await openPanel(bridge, page, 'seed', theme);
  await bridge.seedOrgs(MOCK_ORGS);
  await page.getByTestId('mode-card-generate').click();
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

/**
 * Open the Seed page on its start, the saved templates answered: the gallery,
 * the recommended template first, the other ways to seed under it.
 */
async function openSeedStart(bridge: MockBridge, page: Page, theme: StateTheme): Promise<void> {
  await openPanel(bridge, page, 'seed', theme);
  await bridge.seedOrgs(MOCK_ORGS);
  await bridge.waitForMessage('seed:template:list', { timeout: 10_000 });
  await answerAll(page, 'seed:template:list', 'seed:template:list:response', { templates: [] });
  await bridge.waitForMessage('seed:removal:list', { timeout: 10_000 });
  await answerAll(page, 'seed:removal:list', 'seed:removal:list:response', { runs: [] });
  await page
    .getByTestId('template-card-prebuilt-minimal-demo')
    .waitFor({ state: 'visible', timeout: 10_000 });
}

/** The Quick Seed confirmation of the small demo: its counts, and the org selected in the panel. */
async function openQuickSeedConfirm(
  bridge: MockBridge,
  page: Page,
  theme: StateTheme,
): Promise<void> {
  await openSeedStart(bridge, page, theme);
  await page
    .getByTestId('template-card-prebuilt-minimal-demo')
    .getByTestId('btn-use-template')
    .click();
  await page.getByTestId('quick-seed-confirm').waitFor({ state: 'visible', timeout: 10_000 });
}

/**
 * What `seed:automation` answers for an org whose contacts each make it send
 * three single emails — a workflow rule and a flow, both quiet for a holder
 * of a bypass the user lacks — beside a flow that opens a task, with fifteen
 * left today: past them, the confirmation holds Start.
 */
function contactAutomationAnswer(asked: {
  orgId: string;
  objects: string[];
}): Record<string, unknown> {
  const bypasses = [{ name: 'Trap_Bypass_Flow', held: false }];
  const entry = (over: Record<string, unknown>) => ({
    kind: 'flow',
    when: 'after',
    emails: 0,
    messages: [],
    creates: [],
    afterCommit: false,
    bypasses: [],
    keptQuiet: false,
    unread: false,
    ...over,
  });
  return {
    orgId: asked.orgId,
    objects: asked.objects,
    preview: {
      org: 'DevSandbox',
      objectsRead: asked.objects,
      objects: [
        {
          objectApiName: 'Contact',
          entries: [
            entry({ kind: 'workflowRule', name: 'Contact_Welcome', emails: 1, bypasses }),
            entry({ name: 'Follow Up Task', creates: ['Task'] }),
            entry({
              name: 'Welcome Email',
              emails: 2,
              afterCommit: true,
              bypasses,
              messages: ['notification'],
            }),
          ],
        },
      ],
      emailsPerRecord: [
        {
          objectApiName: 'Contact',
          limit: 'DailyWorkflowEmails',
          perRecord: 1,
          sentBy: ['Contact_Welcome'],
        },
        {
          objectApiName: 'Contact',
          limit: 'SingleEmail',
          perRecord: 3,
          sentBy: ['Contact_Welcome', 'Welcome Email'],
        },
      ],
      limits: {
        SingleEmail: { max: 15, remaining: 15 },
        DailyWorkflowEmails: { max: 8040, remaining: 8040 },
      },
      alertsAsSingle: true,
      bypasses: [{ permission: 'Trap_Bypass_Flow', permissionSet: 'Trap_Bypass' }],
      bypassesHeld: [],
      unread: [{ part: 'triggers', reason: 'INSUFFICIENT_ACCESS' }],
      blinded: true,
      conditionsNotRead: 1,
    },
  };
}

/** The Quick Seed of the small demo running, the progress it reported, its Cancel offered. */
async function openQuickSeedRunning(
  bridge: MockBridge,
  page: Page,
  theme: StateTheme,
): Promise<string> {
  await openQuickSeedConfirm(bridge, page, theme);
  await page.getByTestId('btn-quick-seed-start').click();
  const request = await bridge.waitForMessage('seed:execute', { timeout: 10_000 });
  const operationId = String(request.id);
  await bridge.stream([
    {
      type: 'operation:progress',
      payload: {
        operationId,
        percentage: 30,
        processedRecords: 105,
        totalRecords: 350,
        currentStep: 'Insert Contact',
      },
    },
  ]);
  await page.getByTestId('btn-quick-seed-cancel').waitFor({ state: 'visible', timeout: 10_000 });
  return operationId;
}

/**
 * The Seed wizard's run of accounts and contacts, under way: its execute
 * unanswered, the progress it reported, its Cancel offered.
 */
async function openSeedWizardRunning(
  bridge: MockBridge,
  page: Page,
  theme: StateTheme,
): Promise<void> {
  await openPanel(bridge, page, 'seed', theme);
  await bridge.seedOrgs(MOCK_ORGS);
  await page.getByTestId('mode-card-generate').click();
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
  await page.getByTestId('seed-wizard-next').click();
  await page.getByTestId('seed-wizard-finish').click();
  const request = await bridge.waitForMessage('seed:execute', { timeout: 10_000 });
  await bridge.stream([
    {
      type: 'operation:progress',
      payload: {
        operationId: String(request.id),
        percentage: 40,
        processedRecords: 40,
        totalRecords: 100,
        currentStep: 'Insert Account',
      },
    },
  ]);
  await page.getByTestId('seed-wizard-cancel').waitFor({ state: 'visible', timeout: 10_000 });
}

/**
 * A run's stop question, as stopping one's own run asks it: nothing to type —
 * it asked to type "Cancel", the label of the button beside it that stops
 * nothing — and the focus on the button that keeps the run going.
 */
async function expectPlainStopQuestion(page: Page, title = 'Cancel run'): Promise<void> {
  const dialog = page.getByRole('dialog', { name: title });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await expect(dialog.getByTestId('danger-input')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Stop the run' })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Keep running' })).toBeFocused();
}

/** What the run of the small demo answers: accounts created, contacts refused for two reasons. */
function quickSeedResult(operationId: string): Record<string, unknown> {
  return {
    templateId: 'prebuilt-minimal-demo',
    operationId,
    status: 'partial',
    objectResults: [
      {
        objectApiName: 'Account',
        recordsCreated: 50,
        recordsFailed: 0,
        createdIds: ['001000000000001AAA', '001000000000002AAA'],
        errors: [],
      },
      {
        objectApiName: 'Contact',
        recordsCreated: 40,
        recordsFailed: 60,
        createdIds: [],
        errors: [
          ...Array.from(
            { length: 55 },
            () =>
              'FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone must be written +33 X XX XX XX XX. [Phone]',
          ),
          ...Array.from(
            { length: 5 },
            () => 'REQUIRED_FIELD_MISSING: Required fields are missing: [LastName]',
          ),
        ],
      },
    ],
    totalRecordsCreated: 90,
    totalRecordsFailed: 60,
    duration: 3_000,
    timestamp: '2026-10-01T10:00:00.000Z',
  };
}

/**
 * Open the Seed wizard's select step with a contact ticked: the common objects
 * pinned above the others, the contact's account offered, the persona folded.
 */
async function openSeedSelectWithSuggestion(
  bridge: MockBridge,
  page: Page,
  theme: StateTheme,
): Promise<void> {
  await openPanel(bridge, page, 'seed', theme);
  await bridge.seedOrgs(MOCK_ORGS);
  await page.getByTestId('mode-card-generate').click();
  await page.getByTestId('org-selector').selectOption(DEV_SANDBOX.id);
  await bridge.waitForMessage('seed:describe-global', { timeout: 10_000 });
  await answerAll(page, 'seed:describe-global', 'seed:describe-global:response', {
    objects: ['AcceptedEventRelation', 'Invoice__c', 'Opportunity', 'Account', 'Contact'].map(
      (apiName) => ({ apiName, label: apiName, recordCount: 0, dependencies: [] }),
    ),
  });
  await page.getByTestId('obj-Contact').click();
  await page
    .getByTestId('seed-parent-suggestion-Account')
    .waitFor({ state: 'visible', timeout: 10_000 });
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

    test('Compare deploy tab refusing a production target, naming the orgs it deploys to', async ({
      page,
    }) => {
      await openDeployTab(bridge, page, theme, {
        ...QA_SANDBOX,
        id: 'org-prod-1',
        alias: 'Production',
        orgType: 'Production',
      });
      await expect(page.getByTestId('deploy-target-refused')).toContainText(
        'a sandbox, a scratch org or a Developer Edition org',
      );

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
      // Neutralized unless unticked, as on a Sync run, with what it covers.
      await expect(page.getByTestId('cdc-contact-points-toggle')).toBeChecked();
      await expect(page.getByTestId('cdc-contact-points-hint')).toBeVisible();
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

    test('Sync results of a simulation, with conflicts, a refused record and why', async ({
      page,
    }) => {
      await openSyncExecuteStep(bridge, page, theme);
      await page.getByTestId('sync-simulate').click();
      await bridge.respondToNext('sync:simulate', 'sync:simulate:response', {
        configId: 'cfg-axe',
        operationId: 'sim-axe',
        direction: 'bidirectional',
        conflictStrategy: 'target_wins',
        objects: [
          {
            objectApiName: 'Account',
            operation: 'upsert',
            read: 12,
            insert: 4,
            update: 7,
            delete: 0,
            skipped: 2,
            refused: 1,
            conflicts: 3,
            conflictFields: ['Phone', 'Name'],
            notes: [
              '2 tracked changes left out: the platform writes them itself',
              '1 record(s) carry no value in Legacy_Key__c: an upsert matches on it, and the target refuses a record without one.',
            ],
          },
        ],
        duration: 840,
        timestamp: '2026-10-06T09:00:00.000Z',
      });
      await page.getByTestId('sync-simulation-results').waitFor({ timeout: 10_000 });

      await expectReadable(page, theme);
    });

    test('Sync first step in delta mode, deletions on, with an object a delta run cannot write', async ({
      page,
    }) => {
      await openSyncExecuteStep(
        bridge,
        page,
        theme,
        {
          currentStep: 0,
          mode: 'delta',
          propagateDeletes: true,
          objectEntries: [
            {
              objectApiName: 'Account',
              operation: 'upsert',
              externalIdField: 'Legacy_Key__c',
              batchSize: 200,
              where: '',
            },
            {
              objectApiName: 'Contact',
              operation: 'insert',
              externalIdField: '',
              batchSize: 200,
              where: '',
            },
          ],
        },
        'sync-delta-settings',
      );
      await page.getByTestId('sync-delta-blockers').waitFor({ timeout: 10_000 });

      await expectReadable(page, theme);
    });

    test('Sync results of a delta run, with a deletion carried and one refused', async ({
      page,
    }) => {
      await openSyncExecuteStep(bridge, page, theme, { mode: 'delta', propagateDeletes: true });
      await page.getByTestId('sync-run').click();
      await bridge.respondToNext('sync:execute', 'sync:execute:response', {
        configId: 'cfg-axe',
        operationId: 'run-axe',
        status: 'partial',
        objectResults: [
          {
            objectApiName: 'Account',
            operation: 'upsert',
            processed: 3,
            success: 3,
            failed: 0,
            skipped: 0,
            conflictCount: 0,
            errors: ['ENTITY_IS_LOCKED: locked'],
            delta: {
              read: 'delta',
              since: '2026-10-13T09:00:00.000Z',
              changed: 3,
              deletionsChecked: true,
              deleted: 1,
              deleteFailed: 1,
            },
          },
        ],
        totalProcessed: 3,
        totalSuccess: 3,
        totalFailed: 0,
        totalSkipped: 0,
        duration: 900,
        timestamp: '2026-10-13T10:00:00.000Z',
      });
      await page.getByTestId('sync-result-delta-Account').waitFor({ timeout: 10_000 });

      await expectReadable(page, theme);
    });

    test('Sync results of prices read in a currency the target lacks, said apart from the refusals', async ({
      page,
    }) => {
      await openSyncExecuteStep(bridge, page, theme);
      await page.getByTestId('sync-run').click();
      await bridge.respondToNext('sync:execute', 'sync:execute:response', {
        configId: 'cfg-axe',
        operationId: 'run-axe',
        status: 'success',
        objectResults: [
          {
            // The standard price book matched: a line beside the price books,
            // not a refusal among them.
            objectApiName: 'Pricebook2',
            operation: 'insert',
            processed: 1,
            success: 1,
            failed: 0,
            skipped: 0,
            conflictCount: 0,
            errors: [],
            standardPricebookMatched: true,
          },
          {
            objectApiName: 'PricebookEntry',
            operation: 'insert',
            processed: 2,
            success: 2,
            failed: 0,
            skipped: 0,
            conflictCount: 0,
            errors: [],
            currenciesReplaced: [
              {
                objectApiName: 'PricebookEntry',
                from: 'GBP',
                to: 'USD',
                chosenBy: 'corporate',
                rows: 1,
                fields: ['UnitPrice'],
              },
            ],
            pricesSettled: [
              { from: 'GBP', to: 'USD', how: 'replaced', forLines: false, prices: 2 },
              { from: 'GBP', to: 'EUR', how: 'converted', forLines: true, prices: 1 },
            ],
          },
        ],
        totalProcessed: 2,
        totalSuccess: 2,
        totalFailed: 0,
        totalSkipped: 0,
        duration: 900,
        timestamp: '2026-10-13T10:00:00.000Z',
      });
      await page.getByTestId('results-price-currencies').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('results-price-currencies-row')).toHaveCount(2);
      await expect(page.getByTestId('sync-result-pricebook-Pricebook2')).toHaveText(
        "Standard price book: matched to the target org's, never written.",
      );
      await expect(page.getByTestId('sync-result-errors-Pricebook2')).toHaveCount(0);

      await expectReadable(page, theme);
    });

    test('Quick Sync results of prices read in a currency the target lacks, said as the Sync tab says them', async ({
      page,
    }) => {
      await bridge.setup(page);
      await paintHostTheme(page, theme);
      await page.addInitScript(
        (args: { source: string; target: string }) => {
          const host = window as unknown as {
            acquireVsCodeApi: () => { setState: (state: unknown) => void };
            __SANDFORGE_MODULE__?: string;
          };
          // The flow on its preview, as a reader who picked the orgs and the
          // object left it.
          host.acquireVsCodeApi().setState({
            quickSyncDraft: {
              sourceOrgId: args.source,
              targetOrgId: args.target,
              selectedObjects: ['PricebookEntry'],
              parentObjects: [],
            },
            quickSyncStep: 'preview',
            quickSyncPreview: {
              objects: [
                {
                  objectApiName: 'PricebookEntry',
                  recordCount: 2,
                  estimatedApiCalls: 1,
                  isParentDependency: false,
                },
              ],
              totalRecords: 2,
              totalApiCalls: 1,
              estimatedDurationSec: 1,
            },
          });
          host.__SANDFORGE_MODULE__ = 'sync';
        },
        { source: DEV_SANDBOX.id, target: QA_SANDBOX.id },
      );
      await page.goto('/');
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('quick-sync-start-btn').click();
      await page.getByTestId('quick-sync-go-btn').click();
      await bridge.respondToNext('quicksync:execute', 'quicksync:execute:response', {
        syncConfig: { id: 'cfg-quick-axe' },
        objectCount: 1,
      });
      await bridge.respondToNext('sync:execute', 'sync:execute:response', {
        configId: 'cfg-quick-axe',
        operationId: 'run-quick-axe',
        status: 'success',
        objectResults: [
          {
            objectApiName: 'PricebookEntry',
            operation: 'insert',
            processed: 2,
            success: 2,
            failed: 0,
            skipped: 0,
            conflictCount: 0,
            errors: [],
            currenciesReplaced: [
              {
                objectApiName: 'PricebookEntry',
                from: 'GBP',
                to: 'USD',
                chosenBy: 'corporate',
                rows: 1,
                fields: ['UnitPrice'],
              },
            ],
            pricesSettled: [
              { from: 'GBP', to: 'USD', how: 'replaced', forLines: false, prices: 2 },
              { from: 'GBP', to: 'EUR', how: 'converted', forLines: true, prices: 1 },
            ],
          },
        ],
        totalProcessed: 2,
        totalSuccess: 2,
        totalFailed: 0,
        totalSkipped: 0,
        duration: 900,
        timestamp: '2026-10-13T10:00:00.000Z',
      });
      await page.getByTestId('quick-sync-results').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('forge-results-currencies')).toBeVisible();
      await expect(page.getByTestId('results-price-currencies-row')).toHaveCount(2);
      await expect(page.getByTestId('quick-sync-result-errors-PricebookEntry')).toHaveCount(0);

      await expectReadable(page, theme);
    });

    test('Sync first step asking what to do when the target already holds the record, once an object finds one', async ({
      page,
    }) => {
      await openSyncExecuteStep(bridge, page, theme, { currentStep: 0 }, 'sync-held-records');
      await expect(page.getByLabel('Direction')).toHaveCount(0);
      await expect(page.getByLabel('When the target already holds the record')).toHaveValue(
        'target_wins',
      );

      await expectReadable(page, theme);
    });

    test('Sync results saying the emails and phone numbers neutralized, and the rows linked or written without their owner, apart from the refusals', async ({
      page,
    }) => {
      await openSyncExecuteStep(bridge, page, theme);
      await page.getByTestId('sync-run').click();
      await bridge.respondToNext('sync:execute', 'sync:execute:response', {
        configId: 'cfg-axe',
        operationId: 'run-axe',
        status: 'success',
        objectResults: [
          {
            objectApiName: 'Contact',
            operation: 'upsert',
            processed: 13,
            success: 12,
            failed: 0,
            skipped: 1,
            conflictCount: 0,
            errors: [],
            linkedToExisting: {
              records: 1,
              refusal: 'DUPLICATE_VALUE: duplicate value found: Legacy_Key__c',
            },
            lookupsLeftOut: [{ records: 12, fields: ['OwnerId'], reason: 'ownerRefusedEarlier' }],
          },
        ],
        totalProcessed: 13,
        totalSuccess: 12,
        totalFailed: 0,
        totalSkipped: 1,
        duration: 900,
        timestamp: '2026-10-21T10:00:00.000Z',
        contactPoints: {
          neutralized: true,
          fields: [
            { objectApiName: 'Contact', field: 'Email', kind: 'email', values: 12 },
            { objectApiName: 'Contact', field: 'Phone', kind: 'phone', values: 9 },
          ],
          values: 21,
        },
      });
      await page.getByTestId('sync-result-written-Contact').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('forge-results-contact-points-row')).toHaveCount(2);
      await expect(page.getByTestId('sync-result-written-Contact-ownerRefusedEarlier')).toHaveText(
        '12 records written without OwnerId from the start: the target org refused the same ' +
          'owner earlier in this run, a user it does not have.',
      );
      await expect(page.getByTestId('sync-result-errors-Contact')).toHaveCount(0);

      await expectReadable(page, theme);
    });

    test('Sync results saying the records written again without a field the target refused, and the lookups a cycle set later or left, apart from the refusals', async ({
      page,
    }) => {
      await openSyncExecuteStep(bridge, page, theme);
      await page.getByTestId('sync-run').click();
      await bridge.respondToNext('sync:execute', 'sync:execute:response', {
        configId: 'cfg-axe',
        operationId: 'run-axe-cycle',
        status: 'success',
        objectResults: [
          {
            objectApiName: 'Account',
            operation: 'insert',
            processed: 4,
            success: 4,
            failed: 0,
            skipped: 0,
            conflictCount: 0,
            errors: [],
            lookupsSetAfter: { records: 2, fields: ['Primary_Contact__c'], after: ['Contact'] },
            lookupsLeftOut: [
              { records: 1, fields: ['Primary_Contact__c'], reason: 'parentRefused' },
              {
                records: 1,
                fields: ['ParentId'],
                reason: 'notSet',
                refusal: 'FIELD_INTEGRITY_EXCEPTION: parent loop',
              },
            ],
          },
          {
            objectApiName: 'Contact',
            operation: 'insert',
            processed: 3,
            success: 3,
            failed: 0,
            skipped: 0,
            conflictCount: 0,
            errors: [],
            writtenWithoutFields: {
              rows: 2,
              fields: [
                {
                  field: 'Phone',
                  refusedBy: 'validation-rule',
                  reason:
                    'FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone must be written +33 X XX XX XX XX.',
                  rows: 2,
                },
              ],
            },
          },
        ],
        totalProcessed: 7,
        totalSuccess: 7,
        totalFailed: 0,
        totalSkipped: 0,
        duration: 900,
        timestamp: '2026-10-21T10:00:00.000Z',
      });
      await page.getByTestId('sync-result-written-Account').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('sync-result-written-Account-setAfter')).toBeVisible();
      await expect(page.getByTestId('sync-result-written-Account-notSet')).toContainText(
        'FIELD_INTEGRITY_EXCEPTION: parent loop',
      );
      await expect(
        page.getByTestId('sync-result-written-Contact-withoutFields-Phone'),
      ).toContainText('a validation rule refused it');
      await expect(page.getByTestId('sync-result-errors-Account')).toHaveCount(0);
      await expect(page.getByTestId('sync-result-errors-Contact')).toHaveCount(0);

      await expectReadable(page, theme);
    });

    test('Sync run removal confirmation with the sweep ticked, listing what the target’s automation created', async ({
      page,
    }) => {
      await openSyncExecuteStep(bridge, page, theme);
      await page.getByTestId('sync-run').click();
      await bridge.respondToNext('sync:execute', 'sync:execute:response', {
        configId: 'cfg-axe',
        operationId: 'run-axe-sweep',
        status: 'success',
        objectResults: [
          {
            objectApiName: 'Contact',
            operation: 'insert',
            processed: 2,
            success: 2,
            failed: 0,
            skipped: 0,
            conflictCount: 0,
            errors: [],
          },
        ],
        totalProcessed: 2,
        totalSuccess: 2,
        totalFailed: 0,
        totalSkipped: 0,
        duration: 900,
        timestamp: '2026-10-21T10:00:00.000Z',
        created: {
          runId: 'run-axe-sweep',
          objects: [{ objectApiName: 'Contact', count: 2 }],
          files: 0,
        },
      });
      // Every request answered: a development build mounts the card twice.
      await bridge.waitForMessage('sync:removal:info', { timeout: 10_000 });
      await answerAll(page, 'sync:removal:info', 'sync:removal:info:response', {
        info: {
          runId: 'run-axe-sweep',
          configId: 'cfg-axe',
          configName: 'Contacts',
          sourceOrgId: DEV_SANDBOX.id,
          targetOrgId: QA_SANDBOX.id,
          startedAt: '2026-10-21T09:59:59.000Z',
          endedAt: '2026-10-21T10:00:00.000Z',
          created: 2,
          left: [{ objectApiName: 'Contact', count: 2 }],
        },
      });
      const removal = page.getByTestId('sync-result-removal');
      await removal.getByTestId('sync-removal-remove').click();
      await page.getByTestId('sync-removal-sweep-toggle').check();
      await bridge.waitForMessage('sync:remove:sweep', { timeout: 10_000 });
      await answerAll(page, 'sync:remove:sweep', 'sync:remove:sweep:response', {
        runId: 'run-axe-sweep',
        listing: {
          window: { from: '2026-10-21T09:59:58Z', to: '2026-10-21T10:01:00Z' },
          looked: ['Contact', 'Task', 'FeedItem'],
          found: [{ objectApiName: 'Task', count: 2, names: ['Follow up'], overBound: false }],
          unread: [],
          handWork: [],
        },
      });
      await page.getByTestId('forge-sweep-found-Task').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('sync-removal-sweep')).toContainText('Follow up');

      await expectReadable(page, theme);
    });

    test('Quick Sync results offering to remove what the run created and the way to its history entry, then that entry', async ({
      page,
    }) => {
      await bridge.setup(page);
      await paintHostTheme(page, theme);
      await page.addInitScript(
        (args: { source: string; target: string }) => {
          const host = window as unknown as {
            acquireVsCodeApi: () => { setState: (state: unknown) => void };
            __SANDFORGE_MODULE__?: string;
          };
          host.acquireVsCodeApi().setState({
            quickSyncDraft: {
              sourceOrgId: args.source,
              targetOrgId: args.target,
              selectedObjects: ['Contact'],
              parentObjects: [],
            },
            quickSyncStep: 'preview',
            quickSyncPreview: {
              objects: [
                {
                  objectApiName: 'Contact',
                  recordCount: 13,
                  estimatedApiCalls: 1,
                  isParentDependency: false,
                },
              ],
              totalRecords: 13,
              totalApiCalls: 1,
              estimatedDurationSec: 1,
            },
          });
          host.__SANDFORGE_MODULE__ = 'sync';
        },
        { source: DEV_SANDBOX.id, target: QA_SANDBOX.id },
      );
      await page.goto('/');
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('quick-sync-start-btn').click();
      await page.getByTestId('quick-sync-go-btn').click();
      await bridge.respondToNext('quicksync:execute', 'quicksync:execute:response', {
        syncConfig: { id: 'cfg-quick-axe' },
        objectCount: 1,
      });
      const result = {
        configId: 'cfg-quick-axe',
        operationId: 'run-quick-axe',
        status: 'success',
        objectResults: [
          {
            objectApiName: 'Contact',
            operation: 'insert',
            processed: 13,
            success: 12,
            failed: 0,
            skipped: 1,
            conflictCount: 0,
            errors: [],
            linkedToExisting: { records: 1 },
            lookupsLeftOut: [{ records: 12, fields: ['OwnerId'], reason: 'notInTarget' }],
          },
        ],
        totalProcessed: 13,
        totalSuccess: 12,
        totalFailed: 0,
        totalSkipped: 1,
        duration: 900,
        timestamp: '2026-10-21T10:00:00.000Z',
        created: {
          runId: 'run-quick-axe',
          objects: [{ objectApiName: 'Contact', count: 12 }],
          files: 0,
        },
        contactPoints: {
          neutralized: true,
          fields: [{ objectApiName: 'Contact', field: 'Email', kind: 'email', values: 12 }],
          values: 12,
        },
      };
      await bridge.respondToNext('sync:execute', 'sync:execute:response', result);
      const removalInfo = {
        info: {
          runId: 'run-quick-axe',
          configId: 'cfg-quick-axe',
          configName: 'Quick Sync',
          sourceOrgId: DEV_SANDBOX.id,
          targetOrgId: QA_SANDBOX.id,
          startedAt: '2026-10-21T09:59:59.000Z',
          endedAt: '2026-10-21T10:00:00.000Z',
          created: 12,
          left: [{ objectApiName: 'Contact', count: 12 }],
        },
      };
      // Every request answered: a development build mounts the card twice.
      await bridge.waitForMessage('sync:removal:info', { timeout: 10_000 });
      await answerAll(page, 'sync:removal:info', 'sync:removal:info:response', removalInfo);
      const removal = page.getByTestId('quick-sync-result-removal');
      await removal.getByTestId('sync-removal-remove').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('quick-sync-again-inserts')).toBeVisible();
      await expect(page.getByTestId('quick-sync-result-written-Contact')).toBeVisible();
      await expect(page.getByTestId('quick-sync-result-errors-Contact')).toHaveCount(0);

      await expectReadable(page, theme);

      // The run's entry on the History tab, opened from the results.
      const askedBefore = (await bridge.getMessages('sync:removal:info')).length;
      await page.getByTestId('quick-sync-open-history').click();
      await bridge.respondToNext('sync:history:list', 'sync:history:list:response', {
        entries: [
          {
            id: 'h-quick-axe',
            configSnapshot: {
              id: 'cfg-quick-axe',
              name: 'Quick Sync',
              description: 'Auto-generated by Quick Sync',
              sourceOrgId: DEV_SANDBOX.id,
              targetOrgId: QA_SANDBOX.id,
              direction: 'source_to_target',
              mode: 'full',
              conflictStrategy: 'source_wins',
              objects: [
                {
                  objectApiName: 'Contact',
                  operation: 'insert',
                  fieldMappings: [],
                  transformRules: [],
                  excludedFields: [],
                  addOnFields: [],
                  batchSize: 200,
                  insertOrder: 1,
                },
              ],
              enableRollback: false,
              createdAt: '2026-10-21T09:59:59.000Z',
              updatedAt: '2026-10-21T09:59:59.000Z',
            },
            result,
            startTime: '2026-10-21T09:59:59.000Z',
            endTime: '2026-10-21T10:00:00.000Z',
            triggeredBy: 'manual',
          },
        ],
      });
      await page.getByTestId('sync-history-detail').waitFor({ timeout: 10_000 });
      await expect
        .poll(async () => (await bridge.getMessages('sync:removal:info')).length)
        .toBeGreaterThan(askedBefore);
      await answerAll(page, 'sync:removal:info', 'sync:removal:info:response', removalInfo);
      await page
        .getByTestId('history-removal')
        .getByTestId('sync-removal-remove')
        .waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('history-written-Contact')).toBeVisible();

      await expectReadable(page, theme);
    });

    test('Sync history detail of a run whose price books matched the standard one, apart from the refusals', async ({
      page,
    }) => {
      const result = {
        configId: 'cfg-axe',
        operationId: 'run-axe',
        status: 'partial',
        objectResults: [
          {
            objectApiName: 'Pricebook2',
            operation: 'insert',
            processed: 1,
            success: 1,
            failed: 0,
            skipped: 0,
            conflictCount: 0,
            errors: [],
            standardPricebookMatched: true,
          },
          {
            objectApiName: 'PricebookEntry',
            operation: 'insert',
            processed: 2,
            success: 1,
            failed: 1,
            skipped: 0,
            conflictCount: 0,
            errors: ['STANDARD_PRICE_NOT_DEFINED: No standard price defined for this product'],
          },
        ],
        totalProcessed: 3,
        totalSuccess: 2,
        totalFailed: 1,
        totalSkipped: 0,
        duration: 900,
        timestamp: '2026-10-13T10:00:00.000Z',
      };
      const entry = {
        id: 'h-axe',
        configSnapshot: {
          id: 'cfg-axe',
          name: 'Catalog',
          sourceOrgId: DEV_SANDBOX.id,
          targetOrgId: QA_SANDBOX.id,
          direction: 'source_to_target',
          mode: 'full',
          conflictStrategy: 'source_wins',
          objects: [],
          enableRollback: false,
          createdAt: '2026-10-13T09:00:00.000Z',
          updatedAt: '2026-10-13T09:00:00.000Z',
        },
        result,
        startTime: '2026-10-13T09:59:59.000Z',
        endTime: '2026-10-13T10:00:00.000Z',
        triggeredBy: 'manual',
      };
      await openSyncExecuteStep(bridge, page, theme);
      await page.getByTestId('tab-history').click();
      await bridge.respondToNext('sync:history:list', 'sync:history:list:response', {
        entries: [entry],
      });
      await page.getByTestId('table-row-0').click();
      await bridge.respondToNext('sync:history:detail', 'sync:history:detail:response', {
        entry,
      });
      await expect(page.getByTestId('history-pricebook-Pricebook2')).toHaveText(
        "Standard price book: matched to the target org's, never written.",
      );
      await expect(page.getByTestId('sync-history-errors-Pricebook2')).toHaveCount(0);

      await expectReadable(page, theme);
    });

    test('Sync review listing each object in the order the run writes it, a delete among them, of a configuration not saved', async ({
      page,
    }) => {
      await openSyncExecuteStep(
        bridge,
        page,
        theme,
        {
          currentStep: 3,
          direction: 'source_to_target',
          conflictStrategy: 'source_wins',
          objectEntries: [
            {
              objectApiName: 'Case',
              operation: 'insert',
              externalIdField: '',
              batchSize: 200,
              where: '',
            },
            {
              objectApiName: 'Contact',
              operation: 'upsert',
              externalIdField: 'Legacy_Key__c',
              batchSize: 200,
              where: '',
            },
            {
              objectApiName: 'Lead',
              operation: 'delete',
              externalIdField: '',
              batchSize: 200,
              where: '',
            },
          ],
        },
        'sync-step-review',
      );
      await bridge.waitForMessage('sync:write-order', { timeout: 10_000 });
      await answerAll(page, 'sync:write-order', 'sync:write-order:response', {
        order: {
          objects: ['Contact', 'Case', 'Lead'],
          moved: [{ objectApiName: 'Case', after: 'Contact', field: 'ContactId' }],
          cycles: [],
        },
      });
      await expect(page.getByTestId('sync-review-object-Case')).toContainText(
        'Written after Contact, which its ContactId names.',
      );
      await expect(page.getByTestId('sync-review-inserts')).toBeVisible();

      await expectReadable(page, theme);
    });

    test('Sync results of a simulation measured before its first write, past the daily emails, with records an earlier run copied', async ({
      page,
    }) => {
      await openSyncExecuteStep(bridge, page, theme);
      await page.getByTestId('sync-simulate').click();
      await bridge.respondToNext('sync:simulate', 'sync:simulate:response', {
        configId: 'cfg-axe',
        operationId: 'sim-axe',
        direction: 'source_to_target',
        conflictStrategy: 'source_wins',
        objects: [
          {
            objectApiName: 'Account',
            operation: 'insert',
            read: 5,
            insert: 3,
            update: 0,
            delete: 0,
            skipped: 2,
            refused: 0,
            conflicts: 0,
            conflictFields: [],
            notes: [],
            alreadyCopied: 2,
          },
          {
            objectApiName: 'Contact',
            operation: 'insert',
            read: 30,
            insert: 30,
            update: 0,
            delete: 0,
            skipped: 0,
            refused: 0,
            conflicts: 0,
            conflictFields: [],
            notes: [],
          },
        ],
        duration: 840,
        timestamp: '2026-10-21T09:00:00.000Z',
        writeOrder: {
          objects: ['Account', 'Contact'],
          moved: [{ objectApiName: 'Contact', after: 'Account', field: 'AccountId' }],
          cycles: [],
        },
        writeCheck: {
          objects: [
            { objectApiName: 'Contact', rows: 30 },
            { objectApiName: 'Account', rows: 3 },
          ],
          total: 33,
          alreadyCopied: 2,
          storage: { verdict: 'near', estimateMB: 0.07, maxMB: 5, remainingMB: 0.08 },
          emails: [
            {
              limit: 'SingleEmail',
              emails: 90,
              verdict: 'exceeds',
              remaining: 15,
              max: 15,
              alertsCounted: true,
              objects: [{ objectApiName: 'Contact', perRecord: 3 }],
            },
          ],
          verdict: 'asks',
        },
      });
      await page.getByTestId('sync-write-check').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('sync-simulation-copied-Account')).toBeVisible();

      await expectReadable(page, theme);
    });

    test('Sync results of a run that left records an earlier run of its configuration copied', async ({
      page,
    }) => {
      await openSyncExecuteStep(bridge, page, theme);
      await page.getByTestId('sync-run').click();
      await bridge.respondToNext('sync:execute', 'sync:execute:response', {
        configId: 'cfg-axe',
        operationId: 'run-axe',
        status: 'success',
        objectResults: [
          {
            objectApiName: 'Account',
            operation: 'upsert',
            processed: 1,
            success: 1,
            failed: 0,
            skipped: 2,
            conflictCount: 0,
            errors: [],
            alreadyCopied: 2,
          },
        ],
        totalProcessed: 1,
        totalSuccess: 1,
        totalFailed: 0,
        totalSkipped: 2,
        duration: 900,
        timestamp: '2026-10-21T10:00:00.000Z',
      });
      await page.getByTestId('sync-result-copied-Account').waitFor({ timeout: 10_000 });

      await expectReadable(page, theme);
    });

    test('Quick Sync preview saying what the last sync between the two orgs left in the target', async ({
      page,
    }) => {
      await bridge.setup(page);
      await paintHostTheme(page, theme);
      await page.addInitScript(
        (args: { source: string; target: string }) => {
          const host = window as unknown as {
            acquireVsCodeApi: () => { setState: (state: unknown) => void };
            __SANDFORGE_MODULE__?: string;
          };
          host.acquireVsCodeApi().setState({
            quickSyncDraft: {
              sourceOrgId: args.source,
              targetOrgId: args.target,
              selectedObjects: ['Contact'],
              parentObjects: ['Account'],
            },
            quickSyncStep: 'preview',
            quickSyncPreview: {
              objects: [
                {
                  objectApiName: 'Account',
                  recordCount: 2,
                  estimatedApiCalls: 1,
                  isParentDependency: true,
                },
                {
                  objectApiName: 'Contact',
                  recordCount: 30,
                  estimatedApiCalls: 1,
                  isParentDependency: false,
                },
              ],
              totalRecords: 32,
              totalApiCalls: 2,
              estimatedDurationSec: 2,
            },
          });
          host.__SANDFORGE_MODULE__ = 'sync';
        },
        { source: DEV_SANDBOX.id, target: QA_SANDBOX.id },
      );
      await page.goto('/');
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('quick-sync-start-btn').click();
      await bridge.waitForMessage('sync:earlier-copies', { timeout: 10_000 });
      await answerAll(page, 'sync:earlier-copies', 'sync:earlier-copies:response', {
        copies: {
          leftAsIs: false,
          run: {
            runId: 'run-axe',
            configName: 'Quick Sync',
            startedAt: '2026-10-14T08:00:00.000Z',
          },
          objects: [
            { objectApiName: 'Account', count: 2 },
            { objectApiName: 'Contact', count: 30 },
          ],
        },
      });
      await page.getByTestId('quick-sync-earlier-copies').waitFor({ timeout: 10_000 });

      await expectReadable(page, theme);
    });

    test('Sync history detail saying, before Run again, what the last run between the orgs left', async ({
      page,
    }) => {
      const result = {
        configId: 'cfg-axe-unsaved',
        operationId: 'run-axe',
        status: 'success',
        objectResults: [
          {
            objectApiName: 'Account',
            operation: 'insert',
            processed: 3,
            success: 3,
            failed: 0,
            skipped: 2,
            conflictCount: 0,
            errors: [],
            alreadyCopied: 2,
          },
        ],
        totalProcessed: 3,
        totalSuccess: 3,
        totalFailed: 0,
        totalSkipped: 2,
        duration: 900,
        timestamp: '2026-10-21T10:00:00.000Z',
      };
      const entry = {
        id: 'h-axe-copies',
        configSnapshot: {
          id: 'cfg-axe-unsaved',
          name: 'Accounts',
          sourceOrgId: DEV_SANDBOX.id,
          targetOrgId: QA_SANDBOX.id,
          direction: 'source_to_target',
          mode: 'full',
          conflictStrategy: 'source_wins',
          objects: [
            {
              objectApiName: 'Account',
              operation: 'insert',
              fieldMappings: [],
              transformRules: [],
              excludedFields: [],
              addOnFields: [],
              batchSize: 200,
              insertOrder: 0,
            },
          ],
          enableRollback: false,
          createdAt: '2026-10-21T09:00:00.000Z',
          updatedAt: '2026-10-21T09:00:00.000Z',
        },
        result,
        startTime: '2026-10-21T09:59:59.000Z',
        endTime: '2026-10-21T10:00:00.000Z',
        triggeredBy: 'manual',
      };
      await openSyncExecuteStep(bridge, page, theme);
      await page.getByTestId('tab-history').click();
      await bridge.respondToNext('sync:history:list', 'sync:history:list:response', {
        entries: [entry],
      });
      await page.getByTestId('table-row-0').click();
      await bridge.respondToNext('sync:history:detail', 'sync:history:detail:response', {
        entry,
      });
      await bridge.waitForMessage('sync:earlier-copies', { timeout: 10_000 });
      await answerAll(page, 'sync:earlier-copies', 'sync:earlier-copies:response', {
        copies: {
          leftAsIs: false,
          run: { runId: 'run-axe', configName: 'Accounts', startedAt: '2026-10-21T09:59:59.000Z' },
          objects: [{ objectApiName: 'Account', count: 3 }],
          unread: 'INVALID_SESSION_ID',
        },
      });
      await page.getByTestId('history-earlier-copies').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('history-copied-Account')).toBeVisible();

      await expectReadable(page, theme);
    });

    test('Sync first step copying files, with its two caps', async ({ page }) => {
      await openSyncExecuteStep(
        bridge,
        page,
        theme,
        { currentStep: 0, files: { maxFileSizeMB: 10, maxRunMB: 100 } },
        'sync-files-settings',
      );
      await page.getByTestId('sync-files-max-run').waitFor({ timeout: 10_000 });

      await expectReadable(page, theme);
    });

    test('Sync results of a run that copied files, some skipped past the caps and one failed', async ({
      page,
    }) => {
      // Not saved: the step says so, and Run waits for the save.
      await openSyncExecuteStep(bridge, page, theme, {
        files: { maxFileSizeMB: 10, maxRunMB: 100 },
      });
      await page.getByTestId('sync-files-needs-save').waitFor({ timeout: 10_000 });
      await expect(page.getByTestId('sync-run')).toBeDisabled();
      await expectReadable(page, theme);
      await saveSyncConfigFromExecuteStep(bridge, page);
      await page.getByTestId('sync-run').click();
      await bridge.respondToNext('sync:execute', 'sync:execute:response', {
        configId: 'cfg-axe',
        operationId: 'run-axe',
        status: 'partial',
        objectResults: [
          {
            objectApiName: 'Account',
            operation: 'upsert',
            processed: 3,
            success: 3,
            failed: 0,
            skipped: 0,
            conflictCount: 0,
            errors: ['ContentDocument: Report (4 B): STORAGE_LIMIT_EXCEEDED'],
            files: {
              copied: 2,
              versions: 1,
              bytes: 1_258_291,
              links: 1,
              unchanged: 1,
              tooLarge: 1,
              pastRunCap: 2,
              external: 0,
              recordNotWritten: 1,
              failed: 1,
            },
          },
        ],
        totalProcessed: 3,
        totalSuccess: 3,
        totalFailed: 0,
        totalSkipped: 0,
        duration: 900,
        timestamp: '2026-10-13T10:00:00.000Z',
      });
      await page.getByTestId('sync-result-files-Account').waitFor({ timeout: 10_000 });

      await expectReadable(page, theme);
    });

    test('Sync simulation whose files would not fit in the target', async ({ page }) => {
      await openSyncExecuteStep(bridge, page, theme, {
        files: { maxFileSizeMB: 10, maxRunMB: 100 },
      });
      await saveSyncConfigFromExecuteStep(bridge, page);
      await page.getByTestId('sync-simulate').click();
      await bridge.respondToNext('sync:simulate', 'sync:simulate:response', {
        configId: 'cfg-axe',
        operationId: 'sim-axe',
        direction: 'bidirectional',
        conflictStrategy: 'target_wins',
        objects: [
          {
            objectApiName: 'Account',
            operation: 'upsert',
            read: 3,
            insert: 3,
            update: 0,
            delete: 0,
            skipped: 0,
            refused: 0,
            conflicts: 0,
            conflictFields: [],
            notes: [],
            files: {
              copied: 3,
              versions: 0,
              bytes: 3 * 1_048_576,
              links: 0,
              unchanged: 0,
              tooLarge: 0,
              pastRunCap: 0,
              external: 0,
              recordNotWritten: 0,
              failed: 0,
            },
          },
        ],
        files: { remainingBytes: 1_048_576, plannedBytes: 3 * 1_048_576, shortfall: 'no room' },
        duration: 900,
        timestamp: '2026-10-13T10:00:00.000Z',
      });
      await page.getByTestId('sync-simulation-files-storage').waitFor({ timeout: 10_000 });

      await expectReadable(page, theme);
    });

    test('Sync run paused from its page, with Resume and Cancel', async ({ page }) => {
      await openSyncExecuteStep(bridge, page, theme);
      await page.getByTestId('sync-run').click();
      const run = await bridge.waitForMessage('sync:execute', { timeout: 10_000 });
      await page.getByTestId('sync-pause').click();
      await bridge.respondToNext('sync:pause', 'sync:pause:response', {
        success: true,
        operationId: run.id,
        paused: true,
      });
      await page.getByTestId('sync-resume').waitFor({ timeout: 10_000 });

      await expectReadable(page, theme);
    });

    test('DataOps template editor over a Constant and a Truncate, with their settings', async ({
      page,
    }) => {
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
                {
                  fieldPattern: 'Contact.MailingPostalCode',
                  ruleType: 'truncate',
                  description: '',
                  config: { truncateLength: 3, truncateKeep: 'first' },
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
      // Each setting carried over from the template it starts from.
      await expect(page.getByTestId('template-rule-constant-0')).toHaveValue('https://example.com');
      await expect(page.getByTestId('template-rule-truncate-length-1')).toHaveValue('3');
      // A name taken and a Constant with no value: both reasons are on screen.
      await page.getByTestId('template-name-input').fill('Sandbox Data Scrub');
      await page.getByTestId('template-rule-constant-0').fill('');
      await expect(page.getByTestId('template-name-taken')).toBeVisible();
      await expect(page.getByTestId('template-rule-0')).toContainText('needs the value it writes');

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
      // Preview beside Apply, live: one sat there disabled, under "Coming soon".
      await expect(page.getByTestId('apply-btn')).toBeVisible();
      await expect(page.getByTestId('preview-btn')).toBeEnabled();
      await expect(page.getByTestId('anonymize-panel')).not.toContainText('Coming soon');
      await page.getByTestId('delete-template-btn').click();
      await expect(page.getByTestId('confirm-delete-template-btn')).toBeVisible();

      await expectReadable(page, theme);
    });

    test('DataOps backups a cap stopped short, on Backup, Restore and in the restore check', async ({
      page,
    }) => {
      await openPanel(bridge, page, 'dataops', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('dataops-page').waitFor({ timeout: 10_000 });
      await bridge.waitForMessage('backup:list', { timeout: 10_000 });
      await answerAll(page, 'backup:list', 'backup:list:result', {
        backups: [
          {
            operationId: 'bk-cap',
            orgId: MOCK_ORGS[0].id,
            timestamp: '2026-10-01T10:00:00.000Z',
            totalRecords: 1_000,
            totalSize: 0,
            status: 'completed',
            partial: true,
            objectResults: [
              {
                objectApiName: 'Contact',
                recordCount: 700,
                orgCount: 1_234,
                truncated: true,
                stoppedAt: 'cap',
              },
              {
                objectApiName: 'Lead',
                recordCount: 300,
                orgCount: 900,
                truncated: true,
                stoppedAt: 'failure',
              },
            ],
          },
        ],
      });
      await bridge.waitForMessage('dataops:anonymization-templates', { timeout: 10_000 });
      await answerAll(
        page,
        'dataops:anonymization-templates',
        'dataops:anonymization-templates:response',
        {
          templates: [
            {
              id: 'tpl-gdpr',
              name: 'GDPR Standard',
              description: 'Mask the people.',
              complianceFramework: 'gdpr',
              rules: [
                { fieldPattern: 'Contact.Email', ruleType: 'hash', description: '' },
                { fieldPattern: 'Lead.Email', ruleType: 'hash', description: '' },
              ],
            },
          ],
        },
      );
      await expect(page.getByTestId('backup-partial-bk-cap')).toContainText('stopped at the cap');
      await expectReadable(page, theme);

      await page.getByTestId('page-tab-restore').click();
      await expect(page.getByTestId('restore-partial-bk-cap')).toContainText('the read failed');
      await expect(page.getByTestId('restore-partial-badge-bk-cap')).toHaveText('Partial');
      // The choice to write every row back, and what the last restore wrote
      // and found unchanged.
      await expect(page.getByTestId('restore-rewrite-all')).toBeVisible();
      await page.getByTestId('restore-backup-bk-cap').getByRole('button').first().click();
      await page.getByTestId('restore-btn-bk-cap').click();
      await bridge.waitForMessage('dataops:rollback', { timeout: 10_000 });
      await answerAll(page, 'dataops:rollback', 'dataops:rollback:response', {
        operationId: 'bk-cap',
        status: 'success',
        message: "Rollback completed: 3 records restored; 997 already held the backup's values",
        totalRestored: 3,
        totalFailed: 0,
        totalUnchanged: 997,
      });
      await expect(page.getByTestId('restore-result')).toContainText('997');
      await expectReadable(page, theme);

      await page.getByTestId('page-tab-anonymize').click();
      await page.getByTestId('template-select').selectOption('tpl-gdpr');
      await bridge.waitForMessage('dataops:anonymize:coverage', { timeout: 10_000 });
      await answerAll(page, 'dataops:anonymize:coverage', 'dataops:anonymize:coverage:response', {
        templateId: 'tpl-gdpr',
        backup: { operationId: 'bk-cap', timestamp: '2026-10-01T10:00:00.000Z' },
        objects: [
          {
            objectApiName: 'Contact',
            count: 1_234,
            backedUp: 700,
            truncated: true,
            stoppedAt: 'cap',
          },
          {
            objectApiName: 'Lead',
            count: 900,
            backedUp: 300,
            truncated: true,
            stoppedAt: 'failure',
          },
        ],
      });
      await expect(page.getByTestId('restore-coverage-cap')).toBeVisible();
      await expectReadable(page, theme);
    });

    test('DataOps Anonymize preview, each original beside its masked value', async ({ page }) => {
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
              id: 'tpl-gdpr',
              name: 'GDPR Standard',
              description: 'Mask the people.',
              complianceFramework: 'gdpr',
              rules: [
                { fieldPattern: 'Contact.Email', ruleType: 'hash', description: '' },
                { fieldPattern: 'Contact.Phone', ruleType: 'mask', description: '' },
                { fieldPattern: 'Lead.Email', ruleType: 'hash', description: '' },
              ],
            },
          ],
        },
      );
      await page.getByTestId('page-tab-anonymize').click();
      await page.getByTestId('template-select').selectOption('tpl-gdpr');
      await page.getByTestId('preview-btn').click();
      await bridge.waitForMessage('dataops:anonymize:preview', { timeout: 10_000 });
      await answerAll(page, 'dataops:anonymize:preview', 'dataops:anonymize:preview:response', {
        templateId: 'tpl-gdpr',
        objects: [
          {
            objectApiName: 'Contact',
            fields: ['Email', 'Phone'],
            rows: [
              {
                id: '003000000000001',
                before: { Email: 'ada@example.org', Phone: '+1 415 555 0142' },
                after: {
                  Email: 'sha256-0123456789abcdef0123456789abcdef@example.invalid',
                  Phone: '***********0142',
                },
              },
              {
                id: '003000000000002',
                before: { Email: null, Phone: '+1 415 555 0199' },
                after: { Email: null, Phone: '***********0199' },
              },
            ],
          },
          { objectApiName: 'Lead', fields: [], rows: [], error: 'INVALID_TYPE: Lead' },
        ],
        fieldsNotFound: [{ objectApiName: 'Contact', fieldApiName: 'Loyalty__c' }],
      });
      await expect(page.getByTestId('preview-object-Contact')).toContainText('ada@example.org');
      await expect(page.getByTestId('preview-object-Lead')).toContainText('Not read');
      await expect(page.getByTestId('preview-fields-not-found')).toContainText('Loyalty__c');

      await expectReadable(page, theme);
    });

    test('DataOps Restore deleting a backup, and every backup of the org, each asked first', async ({
      page,
    }) => {
      await openPanel(bridge, page, 'dataops', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('dataops-page').waitFor({ timeout: 10_000 });
      await bridge.waitForMessage('backup:list', { timeout: 10_000 });
      await answerAll(page, 'backup:list', 'backup:list:result', {
        backups: [
          {
            operationId: 'bk-1',
            orgId: MOCK_ORGS[0].id,
            timestamp: '2026-10-01T10:00:00.000Z',
            totalRecords: 120,
            totalSize: 0,
            status: 'completed',
            objectResults: [{ objectApiName: 'Contact', recordCount: 120, truncated: false }],
          },
          {
            operationId: 'bk-2',
            orgId: MOCK_ORGS[0].id,
            timestamp: '2026-10-02T10:00:00.000Z',
            totalRecords: 80,
            totalSize: 0,
            status: 'completed',
            objectResults: [{ objectApiName: 'Lead', recordCount: 80, truncated: false }],
          },
        ],
      });
      await answerAll(
        page,
        'dataops:anonymization-templates',
        'dataops:anonymization-templates:response',
        { templates: [] },
      );
      await page.getByTestId('page-tab-restore').click();
      await page.getByTestId('restore-backup-bk-1').getByRole('button').first().click();
      await page.getByTestId('delete-backup-btn-bk-1').click();
      await expect(page.getByTestId('delete-backup-question')).toBeVisible();
      await expectReadable(page, theme);

      await page.getByTestId('delete-backup-cancel').click();
      await page.getByTestId('delete-all-backups-btn').click();
      await expect(page.getByTestId('delete-backup-question')).toContainText('2 backups');
      await expectReadable(page, theme);
    });

    test('DataOps Anonymize saying what a restore of the latest backup brings back', async ({
      page,
    }) => {
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
              id: 'tpl-gdpr',
              name: 'GDPR Standard',
              description: 'Mask the people.',
              complianceFramework: 'gdpr',
              rules: [
                { fieldPattern: 'Contact.Email', ruleType: 'hash', description: '' },
                { fieldPattern: 'Lead.Email', ruleType: 'hash', description: '' },
                { fieldPattern: 'Account.Phone', ruleType: 'mask', description: '' },
              ],
            },
          ],
        },
      );
      await page.getByTestId('page-tab-anonymize').click();
      await page.getByTestId('template-select').selectOption('tpl-gdpr');
      await bridge.waitForMessage('dataops:anonymize:coverage', { timeout: 10_000 });
      await answerAll(page, 'dataops:anonymize:coverage', 'dataops:anonymize:coverage:response', {
        templateId: 'tpl-gdpr',
        backup: { operationId: 'bk-1', timestamp: '2026-10-01T10:00:00.000Z' },
        objects: [
          { objectApiName: 'Contact', count: 30000, backedUp: 2000, truncated: true },
          { objectApiName: 'Lead', count: null, backedUp: 0, truncated: false },
          { objectApiName: 'Account', count: 120, backedUp: 120, truncated: false },
        ],
      });
      await expect(page.getByTestId('restore-coverage-shortfall')).toContainText('Contact');
      await expect(page.getByTestId('restore-coverage-Lead')).toContainText('Not counted');

      await expectReadable(page, theme);
    });

    test('DataOps Anonymize offering to resume a run, and a confirmation naming what no restore brings back', async ({
      page,
    }) => {
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
              id: 'tpl-gdpr',
              name: 'GDPR Standard',
              description: 'Mask the people.',
              complianceFramework: 'gdpr',
              rules: [
                { fieldPattern: 'Contact.Email', ruleType: 'hash', description: '' },
                { fieldPattern: 'Lead.Email', ruleType: 'hash', description: '' },
              ],
            },
          ],
        },
      );
      await page.getByTestId('page-tab-anonymize').click();
      await page.getByTestId('template-select').selectOption('tpl-gdpr');
      await bridge.waitForMessage('dataops:anonymize:coverage', { timeout: 10_000 });
      await answerAll(page, 'dataops:anonymize:coverage', 'dataops:anonymize:coverage:response', {
        templateId: 'tpl-gdpr',
        backup: { operationId: 'bk-1', timestamp: '2026-10-01T10:00:00.000Z' },
        objects: [
          { objectApiName: 'Contact', count: 1220, backedUp: 500, truncated: true },
          { objectApiName: 'Lead', count: null, backedUp: 0, truncated: false },
        ],
        checkpoint: { id: 'run-1', savedAt: '2026-10-09T10:00:00.000Z' },
      });
      await expect(page.getByTestId('resume-btn')).toBeVisible();
      await expect(page.getByTestId('resume-hint')).toContainText('stopped before the end');
      await expectReadable(page, theme);

      await page.getByTestId('resume-btn').click();
      await expect(page.getByTestId('confirm-unrestorable')).toContainText('Contact: 720 records');
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
      await bridge.respondToNext('autopilot:list-objects', 'autopilot:objects-listed', {
        objects: MOCK_LISTING,
      });
      await page.getByTestId('step2-objects').waitFor({ state: 'visible', timeout: 5000 });
      await pickAutopilotObjectsAndScan(bridge, page);
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
      await bridge.respondToNext('autopilot:list-objects', 'autopilot:objects-listed', {
        objects: MOCK_LISTING,
      });
      await page.getByTestId('step2-objects').waitFor({ state: 'visible', timeout: 5000 });
      await pickAutopilotObjectsAndScan(bridge, page);
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
          { getState: () => { selectNode: (name: string) => void } } | undefined;
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

    test('Seed record types of the accounts, a person type and a business one refused together', async ({
      page,
    }) => {
      await openSeedExecuteSkipped(bridge, page, theme);
      await page.getByTestId('seed-record-type-Account-PersonAccount').check();
      await page.getByTestId('seed-record-type-Account-Customer').check();
      await page.getByTestId('seed-record-types-mixed-Account').waitFor({ timeout: 10_000 });

      await expectReadable(page, theme, '[data-testid="seed-record-types"]');

      await page.getByTestId('seed-record-type-Account-Customer').uncheck();
      await page.getByTestId('seed-record-types-person-Account').waitFor({ timeout: 10_000 });
      await expectReadable(page, theme, '[data-testid="seed-record-types"]');
    });

    test("Seed configure step, an account's fields for the person account type chosen", async ({
      page,
    }) => {
      await openSeedConfigure(bridge, page, theme);
      await page.getByTestId('seed-record-type-Account-PersonAccount').check();
      const fields = page.getByTestId('step-configure-fields');
      await fields.getByTestId('field-Account-LastName').waitFor({ timeout: 10_000 });
      await expect(fields.getByTestId('field-Account-Name')).toHaveCount(0);

      await expectReadable(page, theme, '[data-testid="seed-step-configure-content"]');
    });

    test('Seed earlier seeds, one opened onto its removal', async ({ page }) => {
      await openPanel(bridge, page, 'seed', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await bridge.waitForMessage('seed:removal:list', { timeout: 10_000 });
      await answerAll(page, 'seed:removal:list', 'seed:removal:list:response', {
        runs: [
          {
            runId: 'op-axe-2',
            targetOrgId: 'org-src-1',
            startedAt: '2026-10-02T09:59:00.000Z',
            endedAt: '2026-10-02T10:00:00.000Z',
            // Its window closed before it ended: listed as partial.
            unfinished: true,
            created: 12,
            left: [{ objectApiName: 'Contact', count: 12 }],
          },
          {
            runId: 'op-axe-1',
            targetOrgId: 'org-src-1',
            startedAt: '2026-10-01T09:59:00.000Z',
            endedAt: '2026-10-01T10:00:00.000Z',
            created: 3,
            left: [],
            removed: {
              removedAt: '2026-10-01T11:00:00.000Z',
              deleted: 3,
              alreadyGone: 0,
              kept: 0,
              refused: 0,
            },
          },
        ],
      });
      await page.getByTestId('seed-run-history-toggle-op-axe-2').click();
      await bridge.waitForMessage('seed:removal:info', { timeout: 10_000 });
      await answerAll(page, 'seed:removal:info', 'seed:removal:info:response', {
        info: {
          runId: 'op-axe-2',
          targetOrgId: 'org-src-1',
          startedAt: '2026-10-02T09:59:00.000Z',
          endedAt: '2026-10-02T10:00:00.000Z',
          created: 12,
          left: [{ objectApiName: 'Contact', count: 12 }],
        },
      });
      await page.getByTestId('seed-removal-remove').waitFor({ timeout: 10_000 });
      await page.getByTestId('seed-run-history-unfinished-op-axe-2').waitFor({ timeout: 10_000 });

      await expectReadable(page, theme, '[data-testid="seed-run-history"]');
    });

    test('Seed results of a run, and the CSV of them the host saves', async ({ page }) => {
      await openSeedExecuteSkipped(bridge, page, theme);
      await page.getByTestId('seed-wizard-next').click();
      await page.getByTestId('seed-wizard-finish').click();
      await bridge.waitForMessage('seed:execute', { timeout: 10_000 });
      await answerAll(page, 'seed:execute', 'seed:execute:response', SEED_RUN_RESULT);
      await page.getByTestId('seed-step-results-content').waitFor({ timeout: 10_000 });
      // What the run created, offered for removal beside its results.
      await bridge.waitForMessage('seed:removal:info', { timeout: 10_000 });
      await answerAll(page, 'seed:removal:info', 'seed:removal:info:response', {
        info: {
          runId: 'op-axe',
          targetOrgId: 'org-src-1',
          startedAt: '2026-10-01T09:59:00.000Z',
          endedAt: '2026-10-01T10:00:00.000Z',
          created: 390,
          left: [
            { objectApiName: 'Contact', count: 290 },
            { objectApiName: 'Account', count: 100 },
          ],
        },
      });
      await page.getByTestId('seed-removal-remove').waitFor({ timeout: 10_000 });

      // The button had no handler.
      await page.getByTestId('btn-export-csv').click();
      const saved = await bridge.waitForMessage('file:save', { timeout: 10_000 });
      const lines = (saved.payload as { content: string }).content.split('\n');
      expect(lines[0]).toBe(
        '"Object","Requested","Created","Failed","Created IDs","Created IDs not listed"',
      );
      expect(lines[1]).toBe(
        '"Account","100","100","0","001000000000001AAA 001000000000002AAA","98"',
      );

      await expectReadable(page, theme, '[data-testid="seed-step-results-content"]');
    });

    test('Seed start: the template gallery first, the CRM starter marked, the other ways under it', async ({
      page,
    }) => {
      await openSeedStart(bridge, page, theme);
      await page.getByTestId('template-recommended').waitFor({ timeout: 10_000 });

      await expectReadable(page, theme, '[data-testid="seed-page"]');
    });

    test('Seed Quick Seed confirmation: the counts, the org preselected, one Start', async ({
      page,
    }) => {
      await openQuickSeedConfirm(bridge, page, theme);

      await expectReadable(page, theme, '[data-testid="quick-seed-confirm"]');
    });

    test('Seed Quick Seed confirmation saying what the org runs, the emails past what it has left, Start held', async ({
      page,
    }) => {
      await openQuickSeedConfirm(bridge, page, theme);
      const asked = await bridge.waitForMessage('seed:automation', { timeout: 10_000 });
      await answerAll(
        page,
        'seed:automation',
        'seed:automation:response',
        contactAutomationAnswer(asked.payload as { orgId: string; objects: string[] }),
      );
      await page
        .getByTestId('seed-automation-refused-SingleEmail')
        .waitFor({ state: 'visible', timeout: 10_000 });

      await expectReadable(page, theme, '[data-testid="quick-seed-confirm"]');
    });

    test('Seed Quick Seed confirmation whose org automation could not be read, Start not held', async ({
      page,
    }) => {
      await openQuickSeedConfirm(bridge, page, theme);
      await bridge.waitForMessage('seed:automation', { timeout: 10_000 });
      await answerAll(page, 'seed:automation', 'seed:automation:error', {
        message: 'INVALID_SESSION_ID',
        code: 'UNKNOWN',
        retryable: true,
      });
      await page
        .getByTestId('seed-automation-unread')
        .waitFor({ state: 'visible', timeout: 10_000 });

      await expectReadable(page, theme, '[data-testid="quick-seed-confirm"]');
    });

    test('Seed Quick Seed running, with its Cancel', async ({ page }) => {
      await openQuickSeedRunning(bridge, page, theme);

      await expectReadable(page, theme, '[data-testid="quick-seed-executing"]');
    });

    test('Seed Quick Seed stop question: nothing to type, Keep running focused', async ({
      page,
    }) => {
      const operationId = await openQuickSeedRunning(bridge, page, theme);
      await page.getByTestId('btn-quick-seed-cancel').click();

      await expectPlainStopQuestion(page);
      await expectReadable(page, theme);
      await page.getByRole('button', { name: 'Stop the run' }).click();
      const abort = await bridge.waitForMessage('execution:abort', { timeout: 10_000 });
      expect(abort.payload).toEqual({ operationId });
    });

    test('Seed wizard stop question: nothing to type, Keep running focused', async ({ page }) => {
      await openSeedWizardRunning(bridge, page, theme);
      await page.getByTestId('seed-wizard-cancel').click();

      await expectPlainStopQuestion(page);
      await expectReadable(page, theme);
      // Kept going from the keyboard: Enter on the focused button closes it.
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(await bridge.getMessages('execution:abort')).toEqual([]);
    });

    test('Sync run stop question: nothing to type, Keep running focused', async ({ page }) => {
      await openSyncExecuteStep(bridge, page, theme);
      await page.getByTestId('sync-run').click();
      const run = await bridge.waitForMessage('sync:execute', { timeout: 10_000 });
      await page.getByTestId('sync-cancel').click();

      await expectPlainStopQuestion(page);
      await expectReadable(page, theme);
      // Stopped from the keyboard: Tab to Stop the run, Enter.
      await page.keyboard.press('Tab');
      await expect(page.getByRole('button', { name: 'Stop the run' })).toBeFocused();
      await page.keyboard.press('Enter');
      const abort = await bridge.waitForMessage('execution:abort', { timeout: 10_000 });
      expect(abort.payload).toEqual({ operationId: run.id });
    });

    test('Sync tabs walked from the keyboard, each tab’s panel named by it', async ({ page }) => {
      // The bar had the arrows of the tab pattern and no tabpanel.
      await openPanel(bridge, page, 'sync', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('tab-sync').focus();
      await expect(page.getByRole('tabpanel', { name: 'Sync' })).toBeVisible();

      await page.keyboard.press('ArrowRight');
      const history = page.getByTestId('tab-history');
      await expect(history).toBeFocused();
      const panel = page.getByRole('tabpanel', { name: 'History' });
      await expect(panel).toBeVisible();
      await expect(history).toHaveAttribute(
        'aria-controls',
        (await panel.getAttribute('id')) ?? '',
      );

      await expectReadable(page, theme);
    });

    test('Monitor skeleton headed by the org it watches, before its first read', async ({
      page,
    }) => {
      // Headed by nothing, the page left a page change's focus on main until
      // the read answered.
      await openPanel(bridge, page, 'monitor', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await bridge.waitForMessage('monitor:refresh', { timeout: 10_000 });
      const skeleton = page.getByTestId('monitor-loading');
      await skeleton.waitFor({ timeout: 10_000 });
      await expect(skeleton.getByRole('heading', { level: 1 })).toHaveText(DEV_SANDBOX.alias);

      await expectReadable(page, theme);
    });

    test('Seed Quick Seed results: refusals grouped by reason, a created account to open', async ({
      page,
    }) => {
      const operationId = await openQuickSeedRunning(bridge, page, theme);
      await answerAll(page, 'seed:execute', 'seed:execute:response', quickSeedResult(operationId));
      await page.getByTestId('seed-result-errors-Contact').waitFor({ timeout: 10_000 });
      await answerAll(page, 'seed:removal:info', 'seed:removal:info:response', { info: null });
      await page.getByTestId('btn-seed-open-record').waitFor({ timeout: 10_000 });

      await expectReadable(page, theme, '[data-testid="quick-seed-results"]');
    });

    test('A page heading handed the focus by the call to action that opened its page', async ({
      page,
    }) => {
      await openPanel(bridge, page, 'forge', theme);
      await bridge.seedOrgs([]);
      await page.getByTestId('empty-action-button').focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { level: 1, name: 'Organizations' })).toBeFocused();

      await expectReadable(page, theme);
    });

    test('Quick Sync running: a bar that is busy with no figure, beside its Pause and Cancel', async ({
      page,
    }) => {
      await bridge.setup(page);
      await paintHostTheme(page, theme);
      await page.addInitScript(
        (args: { source: string; target: string }) => {
          const host = window as unknown as {
            acquireVsCodeApi: () => { setState: (state: unknown) => void };
            __SANDFORGE_MODULE__?: string;
          };
          host.acquireVsCodeApi().setState({
            quickSyncDraft: {
              sourceOrgId: args.source,
              targetOrgId: args.target,
              selectedObjects: ['Contact'],
              parentObjects: [],
            },
            quickSyncStep: 'preview',
            quickSyncPreview: {
              objects: [
                {
                  objectApiName: 'Contact',
                  recordCount: 30,
                  estimatedApiCalls: 1,
                  isParentDependency: false,
                },
              ],
              totalRecords: 30,
              totalApiCalls: 1,
              estimatedDurationSec: 2,
            },
          });
          host.__SANDFORGE_MODULE__ = 'sync';
        },
        { source: DEV_SANDBOX.id, target: QA_SANDBOX.id },
      );
      await page.goto('/');
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('quick-sync-start-btn').click();
      await page.getByTestId('quick-sync-go-btn').click();
      const bar = page.getByTestId('quick-sync-executing').getByRole('progressbar');
      await expect(bar).toBeVisible();
      await expect(bar).not.toHaveAttribute('aria-valuenow');
      await expect(page.getByTestId('quick-sync-status')).toHaveText('Syncing...');

      await expectReadable(page, theme, '[data-testid="quick-sync-flow"]');
    });

    test('Forge target picker open from the keyboard, the current org marked and focused', async ({
      page,
    }) => {
      await openPanel(bridge, page, 'forge', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('forge-page').waitFor({ timeout: 10_000 });
      await page.getByTestId('forge-target-org').click();
      await page.getByTestId(`forge-target-org-option-${QA_SANDBOX.id}`).click();
      await page.getByTestId('forge-target-org').focus();
      await page.keyboard.press('ArrowDown');
      const current = page.getByTestId(`forge-target-org-option-${QA_SANDBOX.id}`);
      await expect(current).toBeFocused();
      await expect(current).toHaveAttribute('aria-current', 'true');

      await expectReadable(page, theme, '[data-testid="forge-target-org-panel"]');
    });

    test('A notification error reached with Alt+N, its Dismiss focused', async ({ page }) => {
      await openPanel(bridge, page, 'home', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('home-page').waitFor({ timeout: 10_000 });
      await sendExtensionMessage(page, {
        type: 'notification',
        id: 'axe-toast',
        payload: { level: 'error', title: 'Sync failed', message: 'The session expired.' },
      });
      await page.keyboard.press('Alt+n');
      await expect(
        page.getByTestId('floating-toasts').getByRole('button', { name: 'Dismiss' }),
      ).toBeFocused();

      await expectReadable(page, theme, '[data-testid="floating-toasts"]');
    });

    test('Seed persona preview open over the gallery, its close button focused', async ({
      page,
    }) => {
      await openPanel(bridge, page, 'seed', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('mode-card-generate').click();
      await page.getByTestId('seed-persona-choice').locator('summary').click();
      await bridge.waitForMessage('seed:list-personas', { timeout: 10_000 });
      await answerAll(page, 'seed:list-personas', 'seed:list-personas:response', {
        personas: [
          {
            id: 'axe-insurer',
            name: 'Insurer',
            description: 'Policies and claims',
            industry: 'Insurance',
            locale: 'en-US',
            dataPatterns: {
              Name: { fieldType: 'string', generator: 'faker', examples: ['Acme Mutual'] },
              Premium__c: { fieldType: 'currency', generator: 'range', examples: ['450'] },
            },
          },
        ],
      });
      await page.getByTestId('persona-preview-axe-insurer').click();
      const dialog = page.getByRole('dialog', { name: 'Persona Preview' });
      await expect(dialog).toHaveAttribute('aria-modal', 'true');
      await expect(page.getByTestId('preview-close-btn')).toBeFocused();

      await expectReadable(page, theme, '[data-testid="persona-preview-popover"]');
    });

    test('Forge discovery waiting, its counters said and its phase focused', async ({ page }) => {
      await openPanel(bridge, page, 'forge', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('forge-page').waitFor({ timeout: 10_000 });
      await page.getByTestId('forge-tab-soql').click();
      await page.getByTestId('forge-input-soql').fill('SELECT Id FROM Account');
      await page.getByTestId('forge-target-org').click();
      await page.getByTestId(`forge-target-org-option-${QA_SANDBOX.id}`).click();
      await page.getByTestId('forge-discover-btn').focus();
      await page.keyboard.press('Enter');
      const discover = await bridge.waitForMessage('forge:discover', { timeout: 10_000 });
      await page.getByTestId('forge-discovery-loading').waitFor({ timeout: 10_000 });
      await sendExtensionMessage(page, {
        type: 'forge:discover:progress',
        id: 'axe-progress',
        timestamp: Date.now(),
        correlationId: String(discover.id),
        payload: {
          phase: 'object',
          objectApiName: 'Account',
          discoveredCount: 42,
          queueRemaining: 7,
        },
      });
      await expect(page.getByTestId('forge-discovery-progress')).toBeVisible();
      await expect(page.getByRole('group', { name: 'Graph discovery' })).toBeFocused();

      await expectReadable(page, theme, '[data-testid="forge-page"]');
    });

    test('Autopilot node picked with Enter: its details open, Skip naming it', async ({ page }) => {
      await openPanel(bridge, page, 'autopilot', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('step1-connect').waitFor({ state: 'visible', timeout: 10_000 });
      await page.getByTestId('source-org-org-src-1').click();
      await page.getByTestId('target-org-org-tgt-1').click();
      await page.getByTestId('seed-wizard-next').click();
      await bridge.respondToNext('autopilot:list-objects', 'autopilot:objects-listed', {
        objects: MOCK_LISTING,
      });
      await page.getByTestId('step2-objects').waitFor({ state: 'visible', timeout: 5000 });
      await pickAutopilotObjectsAndScan(bridge, page);
      await bridge.respondToNext('autopilot:generate-plan', 'autopilot:plan-ready', {
        plan: MOCK_PLAN,
        graph: MOCK_GRAPH,
      });
      await page.getByTestId('execute-button').click();
      await bridge.waitForMessage('autopilot:execute', { timeout: 10_000 });
      // Drawn hidden until React Flow has measured it, and not focusable till then.
      const account = page.getByTestId('rf__node-Account');
      await account.waitFor({ state: 'visible', timeout: 10_000 });
      await account.focus();
      await expect(account).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('control-skip')).toHaveText('Skip Account');

      await expectReadable(page, theme);
    });

    test("Seed select step: the common objects pinned, a contact's account offered, the persona an option", async ({
      page,
    }) => {
      await openSeedSelectWithSuggestion(bridge, page, theme);

      await expectReadable(page, theme, '[data-testid="seed-page"]');
    });

    test('AI chat saying where a question awaits its answer, then where the answer went', async ({
      page,
    }) => {
      await openPanel(bridge, page, 'ai', theme);
      await bridge.respondToNext('ai:status', 'ai:status:response', { enabled: true });
      await page.getByTestId('ai-chat-panel').waitFor({ timeout: 10_000 });
      for (const [id, title] of [
        ['axe-cases', 'Cases'],
        ['axe-leads', 'Leads'],
      ]) {
        await createConversation(bridge, page, id, title);
        if (id === 'axe-cases') {
          await page.getByTestId('chat-input').fill('Which object holds cases?');
          await page.getByTestId('send-btn').click();
        }
      }
      // Leads opened while the question in Cases waits: its composer is locked,
      // and its thread says which conversation the wait is for.
      await page.getByTestId('ai-waiting-elsewhere').waitFor({ state: 'visible', timeout: 5000 });
      await expectReadable(page, theme, '[data-testid="ai-chat-panel"]');

      await bridge.respond('ai:chat:response', {
        conversationId: 'axe-cases',
        message: {
          id: 'msg-axe-cases',
          role: 'assistant',
          content: 'Case',
          timestamp: new Date().toISOString(),
        },
      });
      await page.getByTestId('ai-answered-elsewhere').waitFor({ state: 'visible', timeout: 5000 });
      await expectReadable(page, theme, '[data-testid="ai-chat-panel"]');
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
      // An object the target takes no insert of, records it refused, grouped
      // by why, and feed items the dataset cannot type, beside the lines
      // every report carries.
      await answerAll(page, 'frozen:load', 'frozen:load:response', {
        report: FROZEN_LOAD_REPORT_WITH_LEFT_OUT,
      });
      await page
        .getByTestId('frozen-report-excluded')
        .waitFor({ state: 'visible', timeout: 10_000 });
      await expect(page.getByTestId('frozen-report-failures').locator('tbody tr')).toHaveCount(3, {
        timeout: 10_000,
      });
      await page
        .getByTestId('frozen-report-untyped-feed-items')
        .waitFor({ state: 'visible', timeout: 10_000 });
      // The records it left out for a parent excludedObjects leaves out.
      await page
        .getByTestId('frozen-report-held-for-excluded')
        .waitFor({ state: 'visible', timeout: 10_000 });
      // The links it could not make: the lookups left empty, per object, and
      // the one that went with a contact the target refused.
      await expect(page.getByTestId('frozen-report-unresolved').locator('tbody tr')).toHaveCount(
        2,
        { timeout: 10_000 },
      );
      await page
        .getByTestId('frozen-report-unresolved-lost')
        .waitFor({ state: 'visible', timeout: 10_000 });
      // The fields the target refused records on, which went in written again.
      await expect(
        page.getByTestId('frozen-report-written-without-fields').locator('tbody tr'),
      ).toHaveCount(2, { timeout: 10_000 });

      await expectReadable(page, theme);
    });

    test('Frozen dataset reload report naming what its purge took, left and could not take', async ({
      page,
    }) => {
      await openPanel(bridge, page, 'frozen', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('frozen-extract-tab').waitFor({ state: 'visible', timeout: 10_000 });
      await answerAll(page, 'frozen:status', 'frozen:status:response', {
        status: FROZEN_STATUS_WITH_DATASET,
      });
      await page.getByTestId('page-tab-load').click();
      await expect(page.getByTestId('frozen-load-run')).toBeEnabled({ timeout: 10_000 });
      await page.getByTestId('frozen-load-reload').check();
      await page.getByTestId('frozen-load-run').click();
      await bridge.waitForMessage('frozen:load', { timeout: 10_000 });
      // Per object, what the purge deleted and deactivated; what it left of a
      // load that did not say what it created; and its refusals, grouped by why.
      await answerAll(page, 'frozen:load', 'frozen:load:response', {
        report: FROZEN_RELOAD_REPORT_WITH_PURGE,
      });
      const purge = page.getByTestId('frozen-report-purge');
      await expect(purge.locator('table').first().locator('tbody tr')).toHaveCount(3, {
        timeout: 10_000,
      });
      await expect(
        page.getByTestId('frozen-report-purge-failures').locator('tbody tr'),
      ).toHaveCount(2, { timeout: 10_000 });
      await page
        .getByTestId('frozen-report-purge-left')
        .waitFor({ state: 'visible', timeout: 10_000 });

      await expectReadable(page, theme);
    });

    test('Frozen dataset load a cancel stopped, marking apart the object it cut short', async ({
      page,
    }) => {
      await openPanel(bridge, page, 'frozen', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('frozen-extract-tab').waitFor({ state: 'visible', timeout: 10_000 });
      await answerAll(page, 'frozen:status', 'frozen:status:response', {
        status: FROZEN_STATUS_WITH_DATASET,
      });
      await page.getByTestId('page-tab-load').click();
      await expect(page.getByTestId('frozen-load-run')).toBeEnabled({ timeout: 10_000 });
      await page.getByTestId('frozen-load-run').click();
      await bridge.waitForMessage('frozen:load', { timeout: 10_000 });
      // A line of each mark: an object written whole, one the target refused
      // a row of, one still going, and the one the cancel cut short.
      for (const line of [
        {
          phase: 'insert',
          objectName: 'Account',
          status: 'done',
          progress: 40,
          message: 'Account: 3 inserted, 0 reused, 0 duplicates skipped, 0 failed',
        },
        {
          phase: 'insert',
          objectName: 'Opportunity',
          status: 'error',
          progress: 50,
          message: 'Opportunity: 1 inserted, 0 reused, 0 duplicates skipped, 1 failed',
        },
        {
          phase: 'insert',
          objectName: 'Contact',
          status: 'started',
          progress: 60,
          message: 'Inserting Contact',
        },
        {
          phase: 'insert',
          objectName: 'Contact',
          status: 'stopped',
          progress: 60,
          message:
            'Contact: 200 inserted, 0 reused, 0 duplicates skipped, 0 failed, ' +
            '99 not inserted: the load was cancelled first',
        },
      ]) {
        await answerAll(page, 'frozen:load', 'frozen:load:progress', line);
      }
      await answerAll(page, 'frozen:load', 'frozen:load:error', {
        message:
          'The load was cancelled after it had created 204 record(s) (Account: 3, ' +
          'Opportunity: 1, Contact: 200). What it created is kept in the mapping: a removal ' +
          'takes it back, and a reload purges it or finds it again.',
        code: 'LOAD_CANCELLED',
        retryable: false,
      });
      const lines = page.getByTestId('frozen-load-progress').locator('li');
      await expect(lines).toHaveCount(4, { timeout: 10_000 });
      await expect(lines.last().locator('span').first()).toHaveClass(/bg-status-warning/);
      await page.getByTestId('frozen-error').waitFor({ state: 'visible', timeout: 10_000 });

      await expectReadable(page, theme);
    });

    test('Frozen dataset load running, with its Cancel and the note once it is asked', async ({
      page,
    }) => {
      await openPanel(bridge, page, 'frozen', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('frozen-extract-tab').waitFor({ state: 'visible', timeout: 10_000 });
      await answerAll(page, 'frozen:status', 'frozen:status:response', {
        status: FROZEN_STATUS_WITH_DATASET,
      });
      await page.getByTestId('page-tab-load').click();
      await expect(page.getByTestId('frozen-load-run')).toBeEnabled({ timeout: 10_000 });
      await page.getByTestId('frozen-load-run').click();
      await bridge.waitForMessage('frozen:load', { timeout: 10_000 });
      await page.getByTestId('frozen-load-cancel').waitFor({ state: 'visible', timeout: 10_000 });
      await expectReadable(page, theme);

      await page.getByTestId('frozen-load-cancel').click();
      await bridge.waitForMessage('execution:abort', { timeout: 10_000 });
      await page.getByTestId('frozen-load-stopping').waitFor({ state: 'visible', timeout: 10_000 });

      await expectReadable(page, theme);
    });

    test('Frozen dataset preview of a reload, per object, with nothing written', async ({
      page,
    }) => {
      await openPanel(bridge, page, 'frozen', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('frozen-extract-tab').waitFor({ state: 'visible', timeout: 10_000 });
      await answerAll(page, 'frozen:status', 'frozen:status:response', {
        status: FROZEN_STATUS_WITH_DATASET,
      });
      await page.getByTestId('page-tab-load').click();
      await expect(page.getByTestId('frozen-load-preview')).toBeEnabled({ timeout: 10_000 });
      await page.getByTestId('frozen-load-reload').check();
      await page.getByTestId('frozen-load-preview').click();
      await bridge.waitForMessage('frozen:load:preview', { timeout: 10_000 });
      await answerAll(page, 'frozen:load:preview', 'frozen:load:preview:response', {
        plan: FROZEN_RELOAD_PLAN,
      });
      await expect(page.getByTestId('frozen-preview').locator('tbody tr')).toHaveCount(3, {
        timeout: 10_000,
      });
      await page
        .getByTestId('frozen-preview-excluded')
        .waitFor({ state: 'visible', timeout: 10_000 });
      // The target's validation rules and the defaults numbered per record, read too.
      await page
        .getByTestId('frozen-preview-rules-Contact')
        .waitFor({ state: 'visible', timeout: 10_000 });
      await page
        .getByTestId('frozen-preview-rules-on-change-Contact')
        .waitFor({ state: 'visible', timeout: 10_000 });
      await page
        .getByTestId('frozen-preview-placeholder-rules-Owner__c')
        .waitFor({ state: 'visible', timeout: 10_000 });
      await page
        .getByTestId('frozen-preview-defaults-per-record')
        .waitFor({ state: 'visible', timeout: 10_000 });

      await expectReadable(page, theme);
    });

    test('Frozen dataset extraction naming what it holds and cannot load as it is', async ({
      page,
    }) => {
      await openPanel(bridge, page, 'frozen', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('frozen-extract-tab').waitFor({ state: 'visible', timeout: 10_000 });
      await expect(page.getByTestId('frozen-select-run')).toBeEnabled({ timeout: 10_000 });
      await page.getByTestId('frozen-select-run').click();
      await bridge.waitForMessage('frozen:select', { timeout: 10_000 });
      await answerAll(page, 'frozen:select', 'frozen:select:response', {
        selection: {
          combinations: [{ combinationKey: 'stage=Won', axisValues: { stage: 'Won' } }],
          uncovered: [],
          volumetry: { measured: { Opportunity: 1 }, total: 1, budgetMax: 2500 },
          selectedAt: '2026-09-20T09:00:00.000Z',
          selectionPath: '/home/qa/.sandforge-sas/selection.json',
          graph: { objects: 50, truncated: true, maxNodes: 50 },
        },
      });
      await expect(page.getByTestId('frozen-extract-run')).toBeEnabled({ timeout: 10_000 });
      await page.getByTestId('frozen-extract-run').click();
      await bridge.waitForMessage('frozen:extract', { timeout: 10_000 });
      // Cut at the cap, with records the platform writes itself left out and
      // records that need an object the configuration excludes.
      await answerAll(page, 'frozen:extract', 'frozen:extract:response', {
        datasetDir: '/home/qa/.sandforge-sas/dataset',
        files: ['manifest.json'],
        recordCount: 9,
        manifest: {
          ...FROZEN_STATUS_WITH_DATASET.manifest,
          coverage: {
            objects: 50,
            truncated: true,
            maxNodes: 50,
            unboundedObjects: [],
            filesLeftOut: [],
            leftToThePlatform: [
              {
                objectApiName: 'FeedItem',
                count: 1,
                note: '1 tracked change left out: the platform writes them itself',
              },
            ],
            exclusionCosts: [
              {
                objectApiName: 'OpportunityLineItem',
                excludedObject: 'PricebookEntry',
                count: 3,
                note: '3 OpportunityLineItem records cannot be loaded without their price',
              },
              {
                objectApiName: 'Order',
                excludedObject: 'PricebookEntry',
                count: 2,
                note: '2 Order records past Draft will be loaded as drafts and stay so',
              },
            ],
          },
        },
      });
      await expect(page.getByTestId('frozen-extract-coverage')).toContainText(
        'OpportunityLineItem (3) → PricebookEntry',
        { timeout: 10_000 },
      );

      await expectReadable(page, theme);
    });

    test('Frozen selection saying the step it is at, then where it stopped and what it kept', async ({
      page,
    }) => {
      await openPanel(bridge, page, 'frozen', theme);
      await bridge.seedOrgs(MOCK_ORGS);
      await page.getByTestId('frozen-extract-tab').waitFor({ state: 'visible', timeout: 10_000 });
      await expect(page.getByTestId('frozen-select-run')).toBeEnabled({ timeout: 10_000 });
      await page.getByTestId('frozen-select-run').click();
      const request = await bridge.waitForMessage('frozen:select', { timeout: 10_000 });
      await bridge.respond(
        'frozen:select:progress',
        { phase: 'candidate', combinationKey: 'origin=Email', candidate: 2, candidates: 3 },
        request.id as string,
      );
      await page.getByTestId('frozen-select-progress').waitFor({ timeout: 10_000 });
      await expectReadable(page, theme);

      await bridge.respond(
        'frozen:select:response',
        {
          selection: {
            combinations: [{ combinationKey: 'origin=Chat', axisValues: { origin: 'Chat' } }],
            uncovered: [],
            volumetry: { measured: { Case: 3 }, total: 3, budgetMax: 400, summed: true },
            selectedAt: '2026-10-16T09:00:00.000Z',
            selectionPath: '/home/qa/.sandforge-sas/selection.json',
            stopped: {
              reason: 'timeout',
              during: 'combination',
              combinationKey: 'origin=Email',
              candidate: 2,
              candidates: 3,
              notProbed: ['origin=Phone', 'origin=Web'],
            },
          },
        },
        request.id as string,
      );
      await page.getByTestId('frozen-selection-stopped').waitFor({ timeout: 10_000 });
      await page.getByTestId('frozen-selection-summed').waitFor({ timeout: 10_000 });
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

    test('DataOps compliance after an erasure, offering to delete the backups taken before it', async ({
      page,
    }) => {
      const requestId = '5b0a9b8c-4444-4000-8000-000000000000';
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
        objects: [{ apiName: 'Contact', label: 'Contact' }],
      });
      await page.getByTestId('compliance-object-option-Contact').check();
      await page.getByTestId('inventory-run-btn').click();
      await bridge.waitForMessage('dataops:pii-inventory', { timeout: 10_000 });
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
            ],
            nameField: { fieldApiName: 'Name', label: 'Full Name' },
          },
        ],
      });
      await page.getByLabel('Email address').fill('jane.doe@example.com');
      await page.getByTestId('dsr-search-btn').click();
      await bridge.waitForMessage('dataops:dsr:search', { timeout: 10_000 });
      await answerAll(page, 'dataops:dsr:search', 'dataops:dsr:search:response', {
        requestId,
        orgId: DEV_SANDBOX.id,
        searchedAt: '2026-09-23T10:01:00.000Z',
        limit: 200,
        objects: [
          {
            status: 'searched',
            objectApiName: 'Contact',
            label: 'Contact',
            counted: 1,
            records: [{ id: '003000000000001AAA', name: 'Jane Doe', matchedBy: ['Email'] }],
            truncated: false,
            searched: [{ fieldApiName: 'Email', label: 'Email', kind: 'email' }],
          },
        ],
      });
      await page.getByTestId('dsr-review-btn').click();
      await bridge.waitForMessage('dataops:dsr:erase', { timeout: 10_000 });
      await answerAll(page, 'dataops:dsr:erase', 'dataops:dsr:erase:response', {
        requestId,
        mode: 'anonymize',
        dryRun: true,
        plan: [
          {
            objectApiName: 'Contact',
            label: 'Contact',
            records: 1,
            fields: [{ fieldApiName: 'Email', label: 'Email', method: 'fake' }],
            kept: [],
          },
        ],
      });
      await page.getByTestId('dsr-erase-btn').click();
      await page.getByTestId('danger-input').fill('erase');
      const reviews = (await bridge.getMessages('dataops:dsr:erase')).length;
      await page.getByTestId('danger-confirm-btn').click();
      await expect
        .poll(async () => (await bridge.getMessages('dataops:dsr:erase')).length)
        .toBeGreaterThan(reviews);
      const [erasure] = (await bridge.getMessages('dataops:dsr:erase')).slice(-1);
      await sendExtensionMessage(page, {
        type: 'dataops:dsr:erase:response',
        id: 'resp-erasure',
        correlationId: String(erasure?.id),
        payload: {
          requestId,
          mode: 'anonymize',
          dryRun: false,
          plan: [],
          outcome: {
            status: 'success',
            done: 1,
            failed: 0,
            objects: [{ objectApiName: 'Contact', done: 1, failed: 0 }],
            errors: [],
          },
        },
      });
      await expect(page.getByTestId('removal-outcome')).toBeVisible({ timeout: 10_000 });
      await expect
        .poll(async () => (await bridge.getMessages('backup:list')).length)
        .toBeGreaterThan(1);
      const [listing] = (await bridge.getMessages('backup:list')).slice(-1);
      await sendExtensionMessage(page, {
        type: 'backup:list:result',
        id: 'resp-listing',
        correlationId: String(listing?.id),
        payload: {
          backups: [
            {
              operationId: 'bk-before',
              orgId: DEV_SANDBOX.id,
              timestamp: '2026-09-20T10:00:00.000Z',
              totalRecords: 120,
              totalSize: 0,
              status: 'completed',
              objectResults: [{ objectApiName: 'Contact', recordCount: 120, truncated: false }],
            },
          ],
        },
      });
      await expect(page.getByTestId('dsr-backups-before')).toBeVisible({ timeout: 10_000 });
      await expectReadable(page, theme);
      await page.getByTestId('dsr-backups-delete').click();
      await expect(page.getByTestId('dsr-backups-delete-confirm')).toBeVisible();
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
