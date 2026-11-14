import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import type { MockBridge } from './MockBridge';
import { sendExtensionMessage } from '../mocks/vscode-api';
import { MOCK_ORGS, QA_SANDBOX } from '../fixtures';
import {
  AUTOPILOT_GRAPH,
  AUTOPILOT_PLAN,
  CLONE_PREVIEW,
  CLONE_SOURCE_OBJECTS,
  CSV_STORAGE_REFUSAL,
  FORGE_RUN_DONE,
  FROZEN_STATUS_TO_LOAD,
  FROZEN_STORAGE_REFUSAL,
  LIVE_OPERATIONS_WITH_A_STOPPED_CLONE,
  METADATA_DIFFS,
  OBJECT_NOT_IN_TARGET_REFUSAL,
  QUICK_SYNC_SUGGESTIONS,
  SFDMU_IMPORT_DELETING_FIRST,
  SYNC_STORAGE_REFUSAL,
  cleanupScan,
  cloneStorageFailure,
  forgeGraph,
  simulationWithUnwritable,
} from '../fixtures/refusals';

/**
 * The panel driven to each refusal and to what it offers, the extension's
 * side played as the bridge carries it. The specs that check what each way
 * out does and the scans that check what it paints reach the same state the
 * same way: a scan of a state the behaviour test never reached proves
 * nothing of it.
 */

/** The ids of the requests of `type` the page posted, in order. */
export async function requestIds(page: Page, type: string): Promise<string[]> {
  return page.evaluate((wanted) => {
    const posted = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
    return posted
      .map((m) => ((m as Record<string, unknown>).payload ?? m) as Record<string, unknown>)
      .filter((m) => m.type === wanted)
      .map((m) => String(m.id));
  }, type);
}

/** The payloads of the requests of `type` the page posted, in order. */
export async function sentPayloads(page: Page, type: string): Promise<Record<string, unknown>[]> {
  return page.evaluate((wanted) => {
    const posted = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
    return posted
      .map((m) => ((m as Record<string, unknown>).payload ?? m) as Record<string, unknown>)
      .filter((m) => m.type === wanted)
      .map((m) => (m.payload ?? {}) as Record<string, unknown>);
  }, type);
}

/** Answer every request of a type the page posted so far: StrictMode can send one twice. */
export async function answerAll(
  page: Page,
  requestType: string,
  responseType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  for (const correlationId of await requestIds(page, requestType)) {
    await sendExtensionMessage(page, {
      type: responseType,
      id: `resp-${correlationId}`,
      correlationId,
      payload,
    });
  }
}

/** Once the page has asked for `requestType`, answer every such request. */
export async function answerOnceAsked(
  page: Page,
  requestType: string,
  responseType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await expect.poll(() => requestIds(page, requestType), { timeout: 10_000 }).not.toEqual([]);
  await answerAll(page, requestType, responseType, payload);
}

/** What the panel is opened with. */
export interface OpenOptions {
  /** What the webview kept of the module between visits, as `setState` holds it. */
  state?: Record<string, unknown>;
  /** The orgs connected; the two sandboxes when not said. */
  orgs?: readonly unknown[];
  /** The editor's display language, English when not said: the host answers with its bundle. */
  language?: 'fr' | 'de' | 'es' | 'pt-BR' | 'ja';
}

/** A catalogue of the panel, as the extension answers `i18n:locale` with it. */
function bundleOf(language: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`../../src/i18n/locales/${language}.json`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
}

/**
 * Open the panel on `module` as the extension does, `state` kept from a
 * visit before, in the editor's `language`, and answer the list of orgs:
 * the first is selected.
 */
export async function openModule(
  bridge: MockBridge,
  page: Page,
  module: string,
  options: OpenOptions = {},
): Promise<void> {
  await bridge.setup(page);
  await page.addInitScript(
    (args: { id: string; state: Record<string, unknown> | null; language: string | null }) => {
      const host = window as unknown as {
        acquireVsCodeApi: () => { getState: () => unknown; setState: (state: unknown) => void };
        __SANDFORGE_MODULE__?: string;
        __SANDFORGE_EDITOR_LANGUAGE__?: string;
      };
      if (args.state) {
        const api = host.acquireVsCodeApi();
        const kept = (api.getState() ?? {}) as Record<string, unknown>;
        api.setState({ ...kept, ...args.state });
      }
      if (args.language) host.__SANDFORGE_EDITOR_LANGUAGE__ = args.language;
      host.__SANDFORGE_MODULE__ = args.id;
    },
    { id: module, state: options.state ?? null, language: options.language ?? null },
  );
  await page.goto('/');
  if (options.language) {
    await bridge.respondToNext(
      'i18n:locale',
      'i18n:locale:response',
      { lng: options.language, bundle: bundleOf(options.language) },
      { timeout: 10_000 },
    );
    await expect(page.locator('html')).toHaveAttribute('lang', options.language);
  }
  await bridge.seedOrgs(options.orgs ?? MOCK_ORGS);
}

/**
 * Go from Quick Sync's preview, and have the extension refuse the run with
 * `refusal` on `sync:error`, as its run gate does.
 */
export async function refuseQuickSync(
  bridge: MockBridge,
  page: Page,
  refusal: Record<string, unknown> = SYNC_STORAGE_REFUSAL,
): Promise<void> {
  await page.getByTestId('quick-sync-start-btn').click();
  await page.getByTestId('quick-sync-go-btn').click();
  await bridge.respondToNext(
    'quicksync:execute',
    'quicksync:execute:response',
    { syncConfig: { id: 'cfg-quick-refused' }, objectCount: 2 },
    { timeout: 10_000 },
  );
  const run = await bridge.waitForMessage('sync:execute', { timeout: 10_000 });
  await sendExtensionMessage(page, {
    type: 'sync:error',
    id: 'err-quick-refused',
    correlationId: String(run.id),
    payload: refusal,
  });
}

/** Open Quick Sync on its objects step and answer the source's suggestions. */
export async function openQuickSyncObjects(page: Page): Promise<void> {
  await page.getByTestId('quick-sync-start-btn').click();
  await page.getByTestId('quick-sync-object-step').waitFor({ timeout: 10_000 });
  await answerOnceAsked(
    page,
    'quicksync:suggest-objects',
    'quicksync:suggest-objects:response',
    QUICK_SYNC_SUGGESTIONS,
  );
  await page.getByTestId('suggestion-chip-Case').waitFor({ timeout: 10_000 });
}

/** Simulate the Sync wizard's draft: its write check finds the target cannot take Invoice__c. */
export async function simulateUnwritable(
  bridge: MockBridge,
  page: Page,
  why: 'notInTarget' | 'notCreateable',
): Promise<void> {
  await page.getByTestId('sync-simulate').click();
  const request = await bridge.waitForMessage('sync:simulate', { timeout: 10_000 });
  await bridge.respond('sync:simulate:response', simulationWithUnwritable(why), String(request.id));
  await page.getByTestId('sync-write-check').waitFor({ timeout: 10_000 });
}

/** Import an SFDMU export on the Migration page whose deleteOldData emptied two objects first. */
export async function importDeletingFirst(bridge: MockBridge, page: Page): Promise<void> {
  await page.getByTestId('migration-path-input').fill('/home/qa/sfdmu/export.json');
  await page.getByTestId('migration-import-btn').click();
  await bridge.waitForMessage('migration:import-sfdmu', { timeout: 10_000 });
  await answerAll(
    page,
    'migration:import-sfdmu',
    'migration:import-sfdmu:response',
    SFDMU_IMPORT_DELETING_FIRST,
  );
  await page.getByTestId('migration-empty-first').waitFor({ timeout: 10_000 });
}

/**
 * Seed Clone from the QA sandbox into the panel's org, `objects` ticked, up
 * to the request of its preview: its id is returned.
 */
export async function askClonePreview(
  bridge: MockBridge,
  page: Page,
  objects: readonly string[] = ['Account', 'Contact'],
): Promise<string> {
  await page.getByTestId('mode-card-clone').click();
  await page.getByTestId('clone-source-select').selectOption(QA_SANDBOX.id);
  await bridge.waitForMessage('seed:clone:describe-source', { timeout: 10_000 });
  await answerAll(
    page,
    'seed:clone:describe-source',
    'seed:clone:describe-source:response',
    CLONE_SOURCE_OBJECTS,
  );
  await page.getByTestId('clone-wizard-next').click();
  for (const object of objects) await page.getByTestId(`clone-obj-check-${object}`).check();
  const before = (await requestIds(page, 'seed:clone:preview')).length;
  await page.getByTestId('clone-wizard-next').click();
  await expect
    .poll(async () => (await requestIds(page, 'seed:clone:preview')).length)
    .toBeGreaterThan(before);
  return (await requestIds(page, 'seed:clone:preview')).at(-1) ?? '';
}

/** Run a Seed Clone from its preview, and have the extension refuse it for its storage. */
export async function refuseCloneForStorage(bridge: MockBridge, page: Page): Promise<void> {
  await askClonePreview(bridge, page);
  await answerAll(page, 'seed:clone:preview', 'seed:clone:preview:response', CLONE_PREVIEW);
  await page.getByTestId('clone-preview-execute').click();
  const run = await bridge.waitForMessage('seed:clone:execute', { timeout: 10_000 });
  await bridge.stream([{ type: 'operation:failed', payload: cloneStorageFailure(String(run.id)) }]);
  await page.getByTestId('clone-error').waitFor({ timeout: 10_000 });
}

/** Ask a Seed Clone's preview of an object the target does not show, refused under its code. */
export async function refuseClonePreviewForMissingObject(
  bridge: MockBridge,
  page: Page,
): Promise<void> {
  const preview = await askClonePreview(bridge, page, ['Account', 'Invoice__c']);
  await sendExtensionMessage(page, {
    type: 'seed:clone:error',
    id: 'err-not-in-target',
    correlationId: preview,
    payload: OBJECT_NOT_IN_TARGET_REFUSAL,
  });
  await page.getByTestId('clone-error').waitFor({ timeout: 10_000 });
}

/**
 * Import three accounts from a CSV file into the QA sandbox, up to its
 * Execute, and have the extension refuse the import for its storage.
 */
export async function refuseCsvForStorage(bridge: MockBridge, page: Page): Promise<void> {
  await page.getByTestId('mode-card-csv').click();
  await page
    .getByTestId('file-drop-zone')
    .locator('input[type="file"]')
    .setInputFiles({
      name: 'accounts.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('Name\nAcme\nGlobex\nInitech\n'),
    });
  await expect(page.getByTestId('csv-preview')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('csv-org-selector').selectOption(QA_SANDBOX.id);
  await answerOnceAsked(page, 'seed:describe-global', 'seed:describe-global:response', {
    objects: [{ apiName: 'Account', label: 'Account' }],
  });
  await page.getByTestId('csv-object-selector').selectOption('Account');
  await answerOnceAsked(page, 'seed:describe-object', 'seed:describe-object:response', {
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
    ],
  });
  await expect(page.getByTestId('csv-next-button')).toBeEnabled({ timeout: 10_000 });
  await page.getByTestId('csv-next-button').click();
  await page.getByTestId('csv-step-map').waitFor({ timeout: 10_000 });
  await page.getByTestId('csv-next-button').click();
  await answerOnceAsked(page, 'seed:csv:validate', 'seed:csv:validate:response', {
    valid: true,
    errors: [],
    warningCount: 0,
  });
  await page.getByTestId('execute-button').click();
  const run = await bridge.waitForMessage('seed:csv:execute', { timeout: 10_000 });
  await sendExtensionMessage(page, {
    type: 'seed:csv:error',
    id: 'err-csv-storage',
    correlationId: String(run.id),
    payload: CSV_STORAGE_REFUSAL,
  });
  await page.getByTestId('csv-error').waitFor({ timeout: 10_000 });
}

/** Load the frozen dataset into the QA sandbox, and have the extension refuse it for its storage. */
export async function refuseFrozenLoadForStorage(bridge: MockBridge, page: Page): Promise<void> {
  await page.getByTestId('frozen-extract-tab').waitFor({ state: 'visible', timeout: 10_000 });
  await answerOnceAsked(page, 'frozen:status', 'frozen:status:response', {
    status: FROZEN_STATUS_TO_LOAD,
  });
  await page.getByTestId('page-tab-load').click();
  await page.getByTestId('frozen-load-target').click();
  await page.getByTestId(`frozen-load-target-option-${QA_SANDBOX.id}`).click();
  await expect(page.getByTestId('frozen-load-run')).toBeEnabled({ timeout: 10_000 });
  await page.getByTestId('frozen-load-run').click();
  const load = await bridge.waitForMessage('frozen:load', { timeout: 10_000 });
  await sendExtensionMessage(page, {
    type: 'frozen:load:error',
    id: 'err-frozen-storage',
    correlationId: String(load.id),
    payload: FROZEN_STORAGE_REFUSAL,
  });
  await page.getByTestId('frozen-error').waitFor({ timeout: 10_000 });
}

/** Scan `objects` on DataOps → Cleanup, each answered as the scan finds it. */
export async function scanCleanup(
  bridge: MockBridge,
  page: Page,
  objects: Array<Record<string, unknown>>,
): Promise<void> {
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
  const names = objects.map((object) => String(object.objectApiName));
  await answerOnceAsked(page, 'seed:describe-global', 'seed:describe-global:response', {
    objects: names.map((name) => ({ apiName: name, label: name })),
  });
  for (const name of names) await page.getByTestId(`cleanup-object-option-${name}`).check();
  await page.getByTestId('cleanup-scan-btn').click();
  await answerOnceAsked(
    page,
    'dataops:cleanup:scan',
    'dataops:cleanup:scan:response',
    cleanupScan(objects),
  );
  await page.getByTestId(`cleanup-object-${names[0]}`).waitFor({ timeout: 10_000 });
}

/** Open the Automation page's Marketplace tab, its reads at mount answered, on `templates`. */
export async function openMarketplace(
  page: Page,
  templates: readonly Record<string, unknown>[],
): Promise<void> {
  await answerOnceAsked(page, 'pipeline:list', 'pipeline:list:response', {
    pipelines: [],
    triggers: [],
  });
  await answerAll(page, 'pipeline:sync-configs', 'pipeline:sync-configs:response', {
    configs: [],
  });
  await answerAll(page, 'pipeline:history', 'pipeline:history:response', { history: [] });
  await answerAll(page, 'pipeline:templates', 'pipeline:templates:response', { templates: [] });
  await page.getByTestId('page-tab-marketplace').click();
  await answerOnceAsked(page, 'marketplace:list', 'marketplace:list:response', {
    success: true,
    templates,
  });
  await expect(page.getByTestId('marketplace-loading')).toHaveCount(0);
}

/** Pick the QA sandbox as Forge's target. */
export async function pickForgeTarget(page: Page): Promise<void> {
  await page.getByTestId('forge-target-org').click();
  await page.getByTestId(`forge-target-org-option-${QA_SANDBOX.id}`).click();
}

/** Discover `graph` from a query on Forge's SOQL tab, into the QA sandbox. */
export async function discoverFromQuery(
  page: Page,
  graph: Record<string, unknown> = forgeGraph(),
): Promise<void> {
  await page.getByTestId('forge-page').waitFor({ timeout: 10_000 });
  await page.getByTestId('forge-tab-soql').click();
  await page
    .getByTestId('forge-input-soql')
    .fill("SELECT Id FROM Account WHERE Industry = 'Energy'");
  await pickForgeTarget(page);
  await page.getByTestId('forge-discover-btn').click();
  await page.waitForSelector('[data-testid="forge-discovery-loading"]', { timeout: 10_000 });
  await answerAll(page, 'forge:discover', 'forge:discover:response', { graph });
  await page.getByTestId('forge-discovery').waitFor({ timeout: 10_000 });
}

/** Open Forge's Review of that discovery, every read of it answered, the metadata with `diffs`. */
export async function openForgeReview(
  bridge: MockBridge,
  page: Page,
  diffs: readonly Record<string, unknown>[] = METADATA_DIFFS,
): Promise<void> {
  await discoverFromQuery(page);
  await page.getByTestId('forge-execute-btn').click();
  await page.getByTestId('forge-review').waitFor({ timeout: 10_000 });
  await bridge.waitForMessage('forge:metadata-diff:request', { timeout: 10_000 });
  await answerAll(page, 'forge:metadata-diff:request', 'forge:metadata-diff:response', {
    diffs,
  });
  // Nothing the target runs as the records go in.
  await answerOnceAsked(page, 'forge:automation:request', 'forge:automation:response', {
    automation: {
      objectsRead: ['Account', 'Contact', 'Opportunity', 'Case'],
      objects: [],
      unread: [],
      conditionsNotRead: 0,
      conditionsBound: 25,
      requests: 4,
      bypassGrants: [],
    },
  });
  await answerOnceAsked(page, 'forge:gaps:request', 'forge:gaps:response', {
    gaps: { gaps: [], unread: [], requests: 5 },
  });
}

/** Open the Forge page on ALL, the two sandboxes picked. */
export async function pickWholeOrg(page: Page): Promise<void> {
  await page.getByTestId('forge-page').waitFor({ timeout: 10_000 });
  await page.getByTestId('forge-source-org').click();
  await page.getByTestId(`forge-source-org-option-${MOCK_ORGS[0].id}`).click();
  await pickForgeTarget(page);
  await page.getByTestId('forge-depth-all').click();
}

/**
 * Discover the whole org, every record or a sample of it, up to Review:
 * what the target holds and has left answered.
 */
export async function openWholeOrgReview(
  page: Page,
  graph: object,
  budget: object,
  sampled: boolean,
): Promise<void> {
  await pickWholeOrg(page);
  if (sampled) await page.getByTestId('forge-record-limit').selectOption('sample');
  await page.getByTestId('forge-discover-btn').click();
  await page.waitForSelector('[data-testid="forge-discovery-loading"]', { timeout: 10_000 });
  await answerAll(page, 'forge:discover', 'forge:discover:response', { graph });
  await expect(page.getByTestId('forge-discovery-summary')).toBeVisible();
  await page.getByTestId('forge-execute-btn').click();
  await expect(page.getByTestId('forge-review')).toBeVisible();
  await answerOnceAsked(page, 'forge:target-records:request', 'forge:target-records:response', {
    targetOrgId: QA_SANDBOX.id,
    objects: [],
  });
  await answerSampleBudget(page, budget);
}

/** Answer every `forge:sample-budget:request` so far with what the target has left. */
export async function answerSampleBudget(page: Page, budget: object): Promise<void> {
  await answerOnceAsked(page, 'forge:sample-budget:request', 'forge:sample-budget:response', {
    targetOrgId: QA_SANDBOX.id,
    budget,
  });
}

/** Start the run from Review; the id of the request it sent. */
export async function startForgeRun(page: Page): Promise<string> {
  const before = (await requestIds(page, 'forge:execute')).length;
  await page.getByTestId('execute-button').click();
  await page.waitForSelector('[data-testid="forge-execution"]', { timeout: 10_000 });
  await expect.poll(async () => (await requestIds(page, 'forge:execute')).length).toBe(before + 1);
  return (await requestIds(page, 'forge:execute')).at(-1) ?? '';
}

/** Stop the run `run` at its gate with `gate`, as the extension refuses it. */
export async function stopAtTheGate(
  page: Page,
  run: string,
  gate: Record<string, unknown>,
): Promise<void> {
  await sendExtensionMessage(page, {
    type: 'forge:execute:error',
    id: 'gate-stop',
    correlationId: run,
    payload: {
      message: 'The host says it in English.',
      code: gate.code,
      retryable: true,
      gate,
    },
  });
  await page.getByTestId('forge-run-gate-notice').waitFor({ timeout: 10_000 });
}

/** Open Monitor, its data read, Live Operations listing a stopped clone it offers to take up. */
export async function openMonitorWithAStoppedClone(bridge: MockBridge, page: Page): Promise<void> {
  await bridge.waitForMessage('monitor:refresh', { timeout: 10_000 });
  await answerAll(page, 'monitor:refresh', 'monitor:data', {
    healthScore: 85,
    healthReport: null,
    jobs: [],
    limits: [],
    trends: {},
    lastUpdated: '2026-11-14T11:05:00Z',
  });
  await page.getByTestId('monitor-page').waitFor({ state: 'visible', timeout: 10_000 });
  await answerOnceAsked(
    page,
    'monitor:live-operations',
    'monitor:live-operations:response',
    LIVE_OPERATIONS_WITH_A_STOPPED_CLONE,
  );
  await page.getByTestId('resume-run-op-forge-stopped').waitFor({ timeout: 10_000 });
}

/** Take up the stopped clone from Live Operations, and have the extension refuse it with `refusal`. */
export async function refuseResume(
  bridge: MockBridge,
  page: Page,
  refusal: Record<string, unknown>,
): Promise<void> {
  await page.getByTestId('resume-run-op-forge-stopped').click();
  const resume = await bridge.waitForMessage('forge:resume-run', { timeout: 10_000 });
  await sendExtensionMessage(page, {
    type: 'forge:execute:error',
    id: 'err-resume',
    correlationId: String(resume.id),
    payload: refusal,
  });
}

/** Run Quick Sync from its preview, and have the extension answer the run with `result`. */
export async function runQuickSync(
  bridge: MockBridge,
  page: Page,
  result: Record<string, unknown>,
): Promise<void> {
  await page.getByTestId('quick-sync-start-btn').click();
  await page.getByTestId('quick-sync-go-btn').click();
  await bridge.respondToNext(
    'quicksync:execute',
    'quicksync:execute:response',
    { syncConfig: { id: 'cfg-quick-run' }, objectCount: 1 },
    { timeout: 10_000 },
  );
  await bridge.respondToNext('sync:execute', 'sync:execute:response', result, {
    timeout: 10_000,
  });
  await page.getByTestId('quick-sync-results').waitFor({ timeout: 10_000 });
}

/** Run the Sync wizard's draft from its execute step, the run answered with `result`. */
export async function runSyncDraft(
  bridge: MockBridge,
  page: Page,
  result: Record<string, unknown>,
): Promise<void> {
  await page.getByTestId('sync-run').click();
  await bridge.respondToNext('sync:execute', 'sync:execute:response', result, {
    timeout: 10_000,
  });
  await page.getByTestId('sync-step-results').waitFor({ timeout: 10_000 });
}

/** Open the run `entry` from the Sync page's History. */
export async function openSyncHistoryEntry(
  bridge: MockBridge,
  page: Page,
  entry: Record<string, unknown>,
): Promise<void> {
  await page.getByTestId('tab-history').click();
  await bridge.respondToNext(
    'sync:history:list',
    'sync:history:list:response',
    { entries: [entry] },
    { timeout: 10_000 },
  );
  await page.getByTestId('table-row-0').click();
  await bridge.respondToNext(
    'sync:history:detail',
    'sync:history:detail:response',
    { entry },
    { timeout: 10_000 },
  );
}

/** Simulate the Sync wizard's draft, the simulation answered with `simulation`. */
export async function simulateSyncDraft(
  bridge: MockBridge,
  page: Page,
  simulation: Record<string, unknown>,
): Promise<void> {
  await page.getByTestId('sync-simulate').click();
  const request = await bridge.waitForMessage('sync:simulate', { timeout: 10_000 });
  await bridge.respond('sync:simulate:response', simulation, String(request.id));
  await page.getByTestId('sync-simulation-results').waitFor({ timeout: 10_000 });
}

/**
 * Run a Forge clone from a query to its results, then verify what it wrote:
 * the verification answered with `verification`.
 */
export async function verifyForgeRun(
  page: Page,
  verification: Record<string, unknown>,
): Promise<void> {
  await discoverFromQuery(page);
  await page.getByTestId('forge-execute-btn').click();
  await page.getByTestId('forge-review').waitFor({ timeout: 10_000 });
  const run = await startForgeRun(page);
  await sendExtensionMessage(page, {
    type: 'forge:execute:response',
    id: 'run-done',
    correlationId: run,
    payload: { result: FORGE_RUN_DONE },
  });
  await page.getByTestId('forge-results').waitFor({ timeout: 10_000 });
  await page.getByTestId('forge-results-verify-run').click();
  await answerOnceAsked(page, 'forge:verify:request', 'forge:verify:response', { verification });
  await page.getByTestId('forge-verification').waitFor({ timeout: 10_000 });
}

/**
 * Run Autopilot from the dev sandbox into the QA sandbox, its two objects
 * planned, have the extension settle a node with `progress`, and open that
 * node's detail.
 */
export async function openAutopilotNode(
  bridge: MockBridge,
  page: Page,
  progress: Record<string, unknown>,
): Promise<void> {
  await page.getByTestId('step1-connect').waitFor({ state: 'visible', timeout: 10_000 });
  await page.getByTestId(`source-org-${MOCK_ORGS[0].id}`).click();
  await page.getByTestId(`target-org-${QA_SANDBOX.id}`).click();
  await page.getByTestId('seed-wizard-next').click();
  await bridge.respondToNext(
    'autopilot:list-objects',
    'autopilot:objects-listed',
    {
      objects: AUTOPILOT_GRAPH.nodes.map(({ objectApiName }) => ({
        apiName: objectApiName,
        label: objectApiName,
        custom: false,
      })),
    },
    { timeout: 10_000 },
  );
  await page.getByTestId('step2-objects').waitFor({ state: 'visible', timeout: 10_000 });
  await page.getByTestId('select-all-checkbox').check();
  await page.getByTestId('seed-wizard-next').click();
  await bridge.respondToNext(
    'autopilot:scan-schema',
    'autopilot:schema-result',
    { graph: AUTOPILOT_GRAPH },
    { timeout: 10_000 },
  );
  await bridge.respondToNext(
    'autopilot:generate-plan',
    'autopilot:plan-ready',
    { plan: AUTOPILOT_PLAN, graph: AUTOPILOT_GRAPH },
    { timeout: 10_000 },
  );
  await page.getByTestId('execute-button').click();
  await bridge.waitForMessage('autopilot:execute', { timeout: 10_000 });
  await bridge.stream([{ type: 'autopilot:node-progress', payload: progress }]);
  const node = String(progress.objectName);
  await page.evaluate((name) => {
    const store = (window as unknown as Record<string, unknown>).__AUTOPILOT_STORE__ as
      { getState: () => { selectNode: (selected: string) => void } } | undefined;
    store?.getState().selectNode(name);
  }, node);
  await page.getByTestId('control-tab-node').click();
}
