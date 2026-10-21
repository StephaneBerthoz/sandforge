import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MockBridge, checkAccessibility, formatViolations, sendExtensionMessage } from './helpers';
import { MOCK_ORGS, QA_SANDBOX } from './fixtures';
import { VSCODE_DEFAULT_STYLES } from './fixtures/vscode-default-styles';
import { hostColours, vscodeTheme } from '../src/styles/testing/vscodeThemes';

/**
 * What a user sees of a run that writes to an org, and of stopping it: Live
 * Operations as the extension pushes it; the Cancel of a backup, a restore, a
 * masking run, a CSV import and a clone; the masking run's snapshot; a seed
 * still writing, and the CSV imports and clones Earlier seeds keeps beside
 * the seeds; a Sync run cut during a call; before Autopilot writes, that
 * SandForge cannot take it back; and the removal a CSV import and a clone
 * offer of what they wrote. Each state is scanned with axe under VS Code's
 * default themes and the two they replaced, painted as the host paints a
 * webview.
 */
const THEMES = ['Light 2026', 'Dark 2026', 'Light Modern', 'Dark Modern'] as const;
type Theme = (typeof THEMES)[number];

/** Paint the host theme before first paint, and prepend VS Code's default webview stylesheet. */
async function paintHostTheme(page: Page, theme: Theme): Promise<void> {
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
      if (document.documentElement) paint();
      else document.addEventListener('DOMContentLoaded', paint);
      if (document.head) prependDefaultStyles();
      else document.addEventListener('DOMContentLoaded', prependDefaultStyles);
    },
    { colours: hostColours(vscodeTheme(theme)), defaultStyles: VSCODE_DEFAULT_STYLES },
  );
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

/** Answer every pending request of a type: a development build mounts each query twice. */
async function answerAll(
  page: Page,
  requestType: string,
  responseType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await expect
    .poll(async () => (await outgoing(page, requestType)).length, { timeout: 10_000 })
    .toBeGreaterThan(0);
  for (const request of await outgoing(page, requestType)) {
    await sendExtensionMessage(page, {
      type: responseType,
      id: `resp-${String(request.id)}`,
      correlationId: String(request.id),
      payload,
    });
  }
}

/** Boot a module's panel, painted in `theme`, the orgs connected. */
async function openModule(page: Page, module: string, theme: Theme): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await paintHostTheme(page, theme);
  await page.addInitScript((name) => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = name;
  }, module);
  await page.goto('/');
  await bridge.seedOrgs(MOCK_ORGS);
  return bridge;
}

/** Scan the page with axe, and fail on any violation. */
async function passesAxe(page: Page): Promise<void> {
  const results = await checkAccessibility(page);
  expect(results.violations.length, formatViolations(results.violations)).toBe(0);
}

/** A live operation as the extension lists it. */
function operation(over: Record<string, unknown>): Record<string, unknown> {
  return {
    operationId: 'op-1',
    module: 'dataops',
    description: 'Backup 2 object(s)',
    status: 'running',
    percentage: 40,
    processedRecords: 1,
    totalRecords: 2,
    currentStep: 'Reading Contact (800 of 2000 records)',
    startedAt: new Date().toISOString(),
    elapsedMs: 12_000,
    recordsPerSecond: 0,
    ...over,
  };
}

const TEMPLATES = [
  {
    id: 'tpl-gdpr',
    name: 'GDPR Compliance',
    description: 'Anonymize all PII fields for GDPR compliance',
    complianceFramework: 'gdpr',
    rules: [{ fieldPattern: 'Contact.Email', ruleType: 'hash', description: 'Hash the email.' }],
  },
];

/** A backup the Restore tab lists. */
const BACKUP = {
  operationId: 'op-backup-1',
  orgId: 'org-src-1',
  timestamp: '2026-10-20T08:00:00.000Z',
  totalRecords: 42,
  totalSize: 1024,
  status: 'completed',
  objectResults: [{ objectApiName: 'Contact', recordCount: 42 }],
};

/** Open DataOps with its backups and templates answered. */
async function openDataOps(page: Page, theme: Theme): Promise<MockBridge> {
  const bridge = await openModule(page, 'dataops', theme);
  await answerAll(page, 'backup:list', 'backup:list:result', { backups: [BACKUP] });
  await answerAll(
    page,
    'dataops:anonymization-templates',
    'dataops:anonymization-templates:response',
    { templates: TEMPLATES },
  );
  await expect(page.getByTestId('backup-panel')).toBeVisible({ timeout: 10_000 });
  return bridge;
}

/** Open the Anonymize tab on the GDPR template. */
async function pickTemplate(page: Page): Promise<void> {
  await page.getByTestId('page-tab-anonymize').click();
  await page.getByTestId('template-select').selectOption('tpl-gdpr');
}

/** The objects the mocked listing and scan of Autopilot give. */
const AUTOPILOT_OBJECTS = [
  { apiName: 'Account', recordCount: 500 },
  { apiName: 'Contact', recordCount: 1200 },
];

/** An Autopilot graph as `autopilot:schema-result` and `autopilot:plan-ready` carry one. */
function autopilotGraph(): Record<string, unknown> {
  return {
    nodes: AUTOPILOT_OBJECTS.map((obj, i) => ({
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
      totalObjects: AUTOPILOT_OBJECTS.length,
      totalRelationships: 0,
      cycleCount: 0,
      maxDepth: 0,
      totalRecords: 1700,
      totalEstimatedApiCalls: 9,
    },
  };
}

for (const theme of THEMES) {
  test.describe(`stopping a run, and what a run cannot take back (${theme})`, () => {
    test('Live Operations lists the runs the extension pushes, by their modules, and passes axe', async ({
      page,
    }) => {
      await openModule(page, 'monitor', theme);
      await answerAll(page, 'monitor:refresh', 'monitor:data', {
        healthScore: 85,
        healthReport: null,
        jobs: [],
        limits: [{ name: 'DailyApiRequests', max: 100000, remaining: 45000, usedPercent: 55 }],
        orgInfo: null,
        trends: {},
        lastUpdated: '2026-10-21T08:00:00Z',
      });
      await page.getByTestId('monitor-page').waitFor({ state: 'visible', timeout: 10_000 });

      // A run started after the Monitor opened: pushed, never asked for.
      await sendExtensionMessage(page, {
        type: 'monitor:live-operations:changed',
        id: 'push-1',
        payload: {
          operations: [
            operation({
              operationId: 'op-autopilot',
              module: 'autopilot',
              description: 'Autopilot run',
            }),
            operation({ operationId: 'op-backup', module: 'dataops' }),
            operation({
              operationId: 'op-pipeline',
              module: 'automation',
              description: 'Pipeline: Nightly refresh',
              status: 'paused',
            }),
          ],
        },
      });

      await expect(page.getByTestId('cancel-op-autopilot')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('cancel-op-backup')).toBeVisible();
      await passesAxe(page);
    });

    test('a backup offers its Cancel while it reads, sends it by its id, and passes axe', async ({
      page,
    }) => {
      await openDataOps(page, theme);
      await page.getByTestId('create-backup-btn').click();
      const [backup] = await outgoing(page, 'backup:execute');

      await page.getByTestId('backup-stop').click();
      await expect
        .poll(async () => (await outgoing(page, 'execution:abort')).map((m) => m.payload))
        .toContainEqual({ operationId: backup.id });
      await expect(page.getByTestId('backup-stop-stopping')).toBeVisible();
      await passesAxe(page);
    });

    test('a restore offers its Cancel while it writes, and passes axe', async ({ page }) => {
      await openDataOps(page, theme);
      await page.getByTestId('page-tab-restore').click();
      await page.getByTestId('restore-backup-op-backup-1').locator('[role="button"]').click();
      await page.getByTestId('restore-btn-op-backup-1').click();

      await expect(page.getByTestId('restore-stop')).toBeVisible({ timeout: 10_000 });
      await passesAxe(page);
    });

    test('Apply keeps the values first unless unticked, its run offers Cancel, and both pass axe', async ({
      page,
    }) => {
      await openDataOps(page, theme);
      await pickTemplate(page);
      await page.getByTestId('apply-btn').click();

      await expect(page.getByTestId('confirm-keep-values-toggle')).toBeChecked();
      await passesAxe(page);

      await page.getByTestId('danger-input').fill('Anonymize');
      await page.getByTestId('danger-confirm-btn').click();
      const [run] = await outgoing(page, 'dataops:anonymize');
      expect(run.payload).toMatchObject({ templateId: 'tpl-gdpr', snapshot: true });
      await expect(page.getByTestId('anonymize-stop')).toBeVisible();
      await passesAxe(page);
    });

    test('a masking run refused for its snapshot says how to go on, one that took it points to it, and both pass axe', async ({
      page,
    }) => {
      await openDataOps(page, theme);
      await pickTemplate(page);
      await page.getByTestId('apply-btn').click();
      await page.getByTestId('danger-input').fill('Anonymize');
      await page.getByTestId('danger-confirm-btn').click();
      const [refused] = await outgoing(page, 'dataops:anonymize');
      await sendExtensionMessage(page, {
        type: 'dataops:error',
        id: 'err-1',
        correlationId: String(refused.id),
        payload: {
          message: 'No snapshot was taken, so nothing was masked: the org refused the read.',
          code: 'SNAPSHOT_NOT_TAKEN',
        },
      });
      await expect(page.getByTestId('anonymize-snapshot-refused')).toBeVisible({ timeout: 10_000 });
      await passesAxe(page);

      await page.getByTestId('apply-btn').click();
      await page.getByTestId('danger-input').fill('Anonymize');
      await page.getByTestId('danger-confirm-btn').click();
      await expect.poll(async () => (await outgoing(page, 'dataops:anonymize')).length).toBe(2);
      const ran = (await outgoing(page, 'dataops:anonymize'))[1];
      await sendExtensionMessage(page, {
        type: 'dataops:anonymize:response',
        id: 'resp-ran',
        correlationId: String(ran.id),
        payload: {
          templateId: 'tpl-gdpr',
          status: 'success',
          recordsProcessed: 42,
          recordsFailed: 0,
          recordsNotMasked: 0,
          objects: [],
          message: 'Anonymization completed: 42 records processed.',
          errors: [],
          fieldsNotFound: [],
          snapshot: { operationId: `${String(ran.id)}-snapshot`, totalRecords: 42 },
        },
      });
      await expect(page.getByTestId('anonymize-snapshot-taken')).toContainText(
        'kept in a backup of 42 records',
      );
      await passesAxe(page);
    });

    test('Earlier seeds lists a seed still writing as running, and a CSV import and a clone by their way, and passes axe', async ({
      page,
    }) => {
      await openModule(page, 'seed', theme);
      const kept = (runId: string, over: Record<string, unknown>): Record<string, unknown> => ({
        runId,
        targetOrgId: 'org-src-1',
        startedAt: '2026-10-21T08:00:00.000Z',
        endedAt: '2026-10-21T08:00:30.000Z',
        created: 2,
        left: [{ objectApiName: 'Account', count: 2 }],
        ...over,
      });
      await answerAll(page, 'seed:removal:list', 'seed:removal:list:response', {
        runs: [
          kept('op-writing', {
            running: true,
            created: 200,
            left: [{ objectApiName: 'Account', count: 200 }],
            refusal: { code: 'RUNNING', message: 'The seed is still writing.' },
          }),
          kept('op-csv', { origin: 'csv' }),
          kept('op-clone', { origin: 'clone', sourceOrgId: QA_SANDBOX.id }),
        ],
      });

      await expect(page.getByTestId('seed-run-history-running-op-writing')).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByTestId('seed-run-history-origin-op-csv')).toHaveText('CSV Upload');
      await expect(page.getByTestId('seed-run-history-origin-op-clone')).toHaveText(
        'Clone from Org',
      );
      // The cards no longer say their runs cannot be removed: Earlier seeds takes them back.
      await expect(page.getByTestId('mode-card-csv-not-removable')).toHaveCount(0);
      await expect(page.getByTestId('mode-card-clone-not-removable')).toHaveCount(0);
      await passesAxe(page);
    });

    test('Sync names the call a run had under way when its window closed, and passes axe', async ({
      page,
    }) => {
      await openModule(page, 'sync', theme);
      await expect(page.getByTestId('sync-page')).toBeVisible();
      await page.getByTestId('tab-history').click();
      await answerAll(page, 'sync:history:list', 'sync:history:list:response', { entries: [] });
      const stopped = {
        runId: 'run-cut',
        configId: 'cfg-1',
        configName: 'Nightly contacts',
        sourceOrgId: 'org-src-1',
        targetOrgId: QA_SANDBOX.id,
        startedAt: '2026-10-21T08:00:00.000Z',
        inFlight: { objectApiName: 'Contact', rows: 12_000 },
        created: 3,
        left: [{ objectApiName: 'Account', count: 3 }],
      };
      await answerAll(page, 'sync:removal:list', 'sync:removal:list:response', { runs: [stopped] });
      await answerAll(page, 'sync:removal:info', 'sync:removal:info:response', { info: stopped });

      await expect(page.getByTestId('sync-unfinished-in-flight-run-cut')).toContainText(
        '12,000 Contact rows',
      );
      await passesAxe(page);
    });

    test('a CSV import offers Cancel while it writes, reads cancelled once stopped, offers the removal of what it wrote, and passes axe', async ({
      page,
    }) => {
      await openModule(page, 'seed', theme);
      await page.getByTestId('mode-card-csv').click();
      // The file first: its headers are what the describe's fields are mapped to.
      await page
        .getByTestId('file-drop-zone')
        .locator('input[type="file"]')
        .setInputFiles({
          name: 'accounts.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from('Name\nAcme\nGlobex\n'),
        });
      await expect(page.getByTestId('csv-preview')).toBeVisible({ timeout: 10_000 });
      await page.getByTestId('csv-org-selector').selectOption('org-src-1');
      await answerAll(page, 'seed:describe-global', 'seed:describe-global:response', {
        objects: [{ apiName: 'Account', label: 'Account' }],
      });
      await page.getByTestId('csv-object-selector').selectOption('Account');
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
        ],
      });
      await page.getByTestId('csv-next-button').click();
      await page.getByTestId('csv-next-button').click();
      await answerAll(page, 'seed:csv:validate', 'seed:csv:validate:response', {
        valid: true,
        errors: [],
        warningCount: 0,
      });

      await expect(page.getByTestId('execute-button')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('csv-no-way-back')).toHaveCount(0);
      await passesAxe(page);

      await page.getByTestId('execute-button').click();
      await expect(page.getByTestId('csv-stop')).toBeVisible();
      await expect(page.getByTestId('csv-cancel-button')).toHaveCount(0);
      await expect(page.getByTestId('back-to-modes')).toHaveCount(0);
      await page.getByTestId('csv-stop').click();
      await expect(page.getByTestId('csv-stopping')).toBeVisible();
      await passesAxe(page);

      const csvRequest = (await outgoing(page, 'seed:csv:execute')).at(-1);
      await answerAll(page, 'seed:csv:execute', 'seed:csv:execute:response', {
        insertedCount: 1,
        failedCount: 0,
        errors: [],
        cancelled: true,
        runId: String(csvRequest?.id),
      });
      await expect(page.getByTestId('csv-cancelled')).toBeVisible({ timeout: 10_000 });
      // What the import wrote before the stop, kept as a seed's is, and offered back.
      await answerAll(page, 'seed:removal:info', 'seed:removal:info:response', {
        info: {
          runId: String(csvRequest?.id),
          origin: 'csv',
          targetOrgId: 'org-src-1',
          startedAt: '2026-10-21T08:00:00.000Z',
          endedAt: '2026-10-21T08:00:30.000Z',
          created: 1,
          left: [{ objectApiName: 'Account', count: 1 }],
        },
      });
      await expect(page.getByTestId('seed-removal-remove')).toBeVisible({ timeout: 10_000 });
      await passesAxe(page);
    });

    test('the Autopilot review says, before Execute, that the run cannot be taken back, and passes axe', async ({
      page,
    }) => {
      await openModule(page, 'autopilot', theme);
      await page.getByTestId('source-org-org-src-1').click();
      await page.getByTestId('target-org-org-tgt-1').click();
      await page.getByTestId('seed-wizard-next').click();
      await answerAll(page, 'autopilot:list-objects', 'autopilot:objects-listed', {
        objects: AUTOPILOT_OBJECTS.map(({ apiName }) => ({
          apiName,
          label: apiName,
          custom: false,
        })),
      });
      await page.getByTestId('select-all-checkbox').check();
      await page.getByTestId('seed-wizard-next').click();
      await answerAll(page, 'autopilot:scan-schema', 'autopilot:schema-result', {
        graph: autopilotGraph(),
      });
      await answerAll(page, 'autopilot:generate-plan', 'autopilot:plan-ready', {
        plan: {
          waves: [
            { order: 0, objects: ['Account'], dependsOn: [] },
            { order: 1, objects: ['Contact'], dependsOn: [0] },
          ],
          totalRecords: 1700,
          estimatedDurationSec: 120,
          estimatedApiCalls: 9,
          complianceFramework: 'gdpr',
          anonymizationSummary: {
            totalPiiFields: 0,
            totalFieldsToAnonymize: 0,
            methodBreakdown: {},
            objectsWithPii: [],
          },
          cycleResolutions: [],
        },
        graph: autopilotGraph(),
      });

      await expect(page.getByTestId('step4-no-way-back')).toBeVisible({ timeout: 10_000 });
      await passesAxe(page);
    });

    test('a clone offers Cancel while it writes, then the removal of what it created, and passes axe', async ({
      page,
    }) => {
      await openModule(page, 'seed', theme);
      await page.getByTestId('mode-card-clone').click();
      await page.getByTestId('clone-source-select').selectOption(QA_SANDBOX.id);
      await answerAll(page, 'seed:clone:describe-source', 'seed:clone:describe-source:response', {
        objects: [{ apiName: 'Account', label: 'Account', recordCount: 3 }],
      });
      await page.getByTestId('clone-wizard-next').click();
      await page.getByTestId('clone-obj-check-Account').click();
      await page.getByTestId('clone-wizard-next').click();
      await answerAll(page, 'seed:clone:preview', 'seed:clone:preview:response', {
        objects: [
          { objectApiName: 'Account', recordCount: 3, sampleRecords: [], relationships: [] },
        ],
        insertOrder: ['Account'],
      });

      await expect(page.getByTestId('clone-preview-execute')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('clone-no-way-back')).toHaveCount(0);
      await passesAxe(page);

      await page.getByTestId('clone-preview-execute').click();
      await expect(page.getByTestId('clone-stop')).toBeVisible();
      await expect(page.getByTestId('back-to-modes')).toHaveCount(0);
      await page.getByTestId('clone-stop').click();
      await expect(page.getByTestId('clone-stopping')).toBeVisible();
      await passesAxe(page);

      // Stopped once it had written: what it created is kept as a seed's is, and offered back.
      const cloneRequest = (await outgoing(page, 'seed:clone:execute')).at(-1);
      await answerAll(page, 'seed:clone:execute', 'seed:clone:execute:response', {
        status: 'partial',
        cancelled: true,
        objectResults: [
          {
            objectApiName: 'Account',
            sourceCount: 3,
            insertedCount: 2,
            failedCount: 0,
            idMappings: [],
            errors: [],
          },
        ],
        totalSourceRecords: 3,
        totalInserted: 2,
        totalFailed: 0,
        durationMs: 1200,
        runId: String(cloneRequest?.id),
      });
      await answerAll(page, 'seed:removal:info', 'seed:removal:info:response', {
        info: {
          runId: String(cloneRequest?.id),
          origin: 'clone',
          sourceOrgId: QA_SANDBOX.id,
          targetOrgId: 'org-src-1',
          startedAt: '2026-10-21T08:00:00.000Z',
          endedAt: '2026-10-21T08:00:30.000Z',
          created: 2,
          left: [{ objectApiName: 'Account', count: 2 }],
        },
      });
      await expect(page.getByTestId('clone-results-cancelled')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('seed-removal-remove')).toBeVisible({ timeout: 10_000 });
      await passesAxe(page);
    });
  });
}
