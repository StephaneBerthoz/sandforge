import { test, expect, type Page } from '@playwright/test';
import { MockBridge, checkAccessibility, formatViolations } from './helpers';
import { MOCK_ORGS } from './fixtures';
import { VSCODE_DEFAULT_STYLES } from './fixtures/vscode-default-styles';
import { sendExtensionMessage } from './mocks/vscode-api';
import { hostColours, vscodeTheme } from '../src/styles/testing/vscodeThemes';

/**
 * Fit to storage, on Autopilot's review: what the plan comes to against the
 * target before Run, the panel that asks for a fit, what the fit kept and
 * Undo fit; and a run refused for its storage, said in figures with the fit
 * that opens from there. Scanned with axe in VS Code's default light and dark
 * themes, painted as the host paints a webview, its default stylesheet first:
 * contrast is what the page renders.
 *
 * A plan of a client sandbox's accounts and contacts came to 64.5 MB for the
 * 22 MB it had left: the review said nothing of it, and the run was refused at
 * Run with "narrow the selection", which a table copied whole cannot be.
 */
const THEMES = ['Light 2026', 'Dark 2026'] as const;
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

/** Answer every pending request of a type: StrictMode can send one twice. */
async function respondToAll(
  page: Page,
  requestType: string,
  responseType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  for (const request of await outgoing(page, requestType)) {
    const correlationId = request.id as string;
    await sendExtensionMessage(page, {
      type: responseType,
      id: `resp-${correlationId}`,
      correlationId,
      payload,
    });
  }
}

/** The two objects of the plan, as the source's global describe lists them. */
const LISTING = [
  { apiName: 'Account', label: 'Account', custom: false },
  { apiName: 'Contact', label: 'Contact', custom: false },
];

function node(objectApiName: string, recordCount: number, insertOrder: number) {
  return {
    objectApiName,
    recordCount,
    estimatedApiCalls: Math.ceil(recordCount / 200),
    piiFields: [],
    anonymizationRules: [],
    status: 'pending',
    progress: 0,
    insertOrder,
    level: insertOrder,
    successCount: 0,
    failureCount: 0,
    errors: [],
    elapsedMs: 0,
    apiCallsUsed: 0,
  };
}

/** The graph of the plan: the accounts, then their contacts. */
const GRAPH = {
  nodes: [node('Account', 12_935, 0), node('Contact', 20_045, 1)],
  edges: [],
  cycles: [],
  stats: {
    totalObjects: 2,
    totalRelationships: 1,
    cycleCount: 0,
    maxDepth: 1,
    totalRecords: 32_980,
    totalEstimatedApiCalls: 166,
  },
};

const SCOPE = {
  maxDepth: 5,
  maxObjects: 50,
  selected: ['Account', 'Contact'],
  parents: [{ objectApiName: 'Region__c', records: 2 }],
  leftEmpty: [],
  standardNeeded: [],
};

/** The plan as made: both tables whole. */
const PLAN = {
  waves: [
    { order: 0, objects: ['Region__c'], dependsOn: [] },
    { order: 1, objects: ['Account'], dependsOn: [0] },
    { order: 2, objects: ['Contact'], dependsOn: [1] },
  ],
  totalRecords: 32_982,
  estimatedDurationSec: 600,
  estimatedApiCalls: 166,
  complianceFramework: 'none',
  anonymizationSummary: {
    totalPiiFields: 0,
    totalFieldsToAnonymize: 0,
    methodBreakdown: {},
    objectsWithPii: [],
  },
  cycleResolutions: [],
  scope: SCOPE,
};

/** What it comes to against QASandbox: 64.5 MB for the 22 it has left. */
const REFUSED = {
  records: 32_982,
  estimateMB: 64.5,
  remainingMB: 22,
  maxMB: 200,
  verdict: 'exceeds',
  apiRequests: { estimate: 166, remaining: 14_000, max: 15_000, verdict: 'fits' },
};

/**
 * What the extension's fit kept, as its engine reports a fit of that plan:
 * a quarter of the accounts spread over the table, the contacts of the
 * accounts kept, a self-reference and a key contact left empty, an Apex
 * trigger it cannot count.
 */
const FIT_REPORT = {
  mode: { share: true },
  heldBy: 'storage',
  budget: {
    budgetMB: 16.4,
    remainingMB: 22,
    maxMB: 200,
    share: 0.8,
    roundingMB: 0.5,
    limitedBy: 'storage',
    automationMB: 0,
    notCounted: [{ objectApiName: 'Account', kind: 'trigger', name: 'AccountTrigger' }],
  },
  share: 0.26,
  objects: [
    {
      objectApiName: 'Account',
      inSource: 12_935,
      kept: 3_371,
      cutSpread: 9_564,
      cutWithParent: [],
    },
    {
      objectApiName: 'Contact',
      inSource: 20_045,
      kept: 5_213,
      cutSpread: 222,
      cutWithParent: [{ field: 'AccountId', parent: 'Account', count: 14_610 }],
    },
  ],
  emptied: [
    { objectApiName: 'Account', field: 'ParentId', count: 41, why: 'selfReference' },
    { objectApiName: 'Account', field: 'Primary_Contact__c', count: 37, why: 'owed' },
  ],
  parents: [{ objectApiName: 'Region__c', records: 1 }],
  records: 8_585,
  estimateMB: 16.7,
  requestsRead: 19,
};

const FITTED_PLAN = {
  ...PLAN,
  totalRecords: 8_585,
  scope: { ...SCOPE, parents: [{ objectApiName: 'Region__c', records: 1 }], fitted: FIT_REPORT },
};

const FITTED_GATE = {
  ...REFUSED,
  records: 8_585,
  estimateMB: 16.7,
  verdict: 'fits',
};

/** The Autopilot review of the accounts and contacts, a plan QASandbox would refuse. */
async function reviewOfARefusedPlan(page: Page, theme: Theme): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await paintHostTheme(page, theme);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'autopilot';
  });
  await page.goto('/');
  await bridge.seedOrgs(MOCK_ORGS);
  await page.getByTestId('source-org-org-src-1').click();
  await page.getByTestId('target-org-org-tgt-1').click();
  await page.getByTestId('seed-wizard-next').click();
  await bridge.waitForMessage('autopilot:list-objects', { timeout: 10_000 });
  await respondToAll(page, 'autopilot:list-objects', 'autopilot:objects-listed', {
    objects: LISTING,
  });
  await page.getByTestId('step2-objects').waitFor({ state: 'visible', timeout: 10_000 });
  await page.getByTestId('select-all-checkbox').check();
  await page.getByTestId('seed-wizard-next').click();
  await expect
    .poll(async () => (await outgoing(page, 'autopilot:scan-schema')).length, { timeout: 10_000 })
    .toBeGreaterThan(0);
  await respondToAll(page, 'autopilot:scan-schema', 'autopilot:schema-result', { graph: GRAPH });
  await bridge.waitForMessage('autopilot:generate-plan', { timeout: 10_000 });
  await respondToAll(page, 'autopilot:generate-plan', 'autopilot:plan-ready', {
    plan: PLAN,
    graph: GRAPH,
    writeGate: REFUSED,
  });
  await page.getByTestId('step4-review').waitFor({ state: 'visible', timeout: 10_000 });
  return bridge;
}

/** Fit the plan by share from the panel, and answer with the plan the fit kept. */
async function fitByShare(
  page: Page,
  bridge: MockBridge,
  plan: Record<string, unknown> = FITTED_PLAN,
): Promise<void> {
  await page.getByRole('button', { name: 'Fit to storage…' }).click();
  await page.getByRole('button', { name: 'Fit the plan' }).click();
  await bridge.waitForMessage('autopilot:fit-plan', { timeout: 10_000 });
  await respondToAll(page, 'autopilot:fit-plan', 'autopilot:plan-ready', {
    plan,
    graph: GRAPH,
    writeGate: FITTED_GATE,
  });
}

for (const theme of THEMES) {
  test.describe(`Autopilot's fit to storage (${theme})`, () => {
    test('says before Run that the plan would be refused, and its panel passes axe', async ({
      page,
    }) => {
      await reviewOfARefusedPlan(page, theme);

      const storage = page.getByRole('region', { name: 'Data storage' });
      await expect(storage.getByTestId('step4-fit-plan-storage')).toHaveText(
        '64.5 MB to write, and QASandbox has 22 MB left of 200 MB: a run would be refused.',
      );
      await storage.getByRole('button', { name: 'Fit to storage…' }).click();
      const panel = page.getByRole('group', { name: 'Fit the plan to what QASandbox has left' });
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('heading')).toBeFocused();
      await panel.getByRole('radio', { name: 'At most so many records of each object' }).check();
      await expect(
        panel.getByRole('textbox', { name: 'At most this many Contact records' }),
      ).toBeVisible();

      const results = await checkAccessibility(page);
      expect(results.violations.length, formatViolations(results.violations)).toBe(0);
    });

    test('says what the fit kept, object by object, and passes axe', async ({ page }) => {
      const bridge = await reviewOfARefusedPlan(page, theme);
      await fitByShare(page, bridge);

      const report = page.getByRole('region', { name: 'Fitted to QASandbox' });
      await expect(report).toBeVisible();
      await expect(report.getByRole('heading', { name: 'Fitted to QASandbox' })).toBeFocused();
      await expect(report.getByTestId('step4-fit-report-share')).toHaveText(
        'The largest share of every object that fits: 26%.',
      );
      await expect(report.getByTestId('step4-fit-report-object-Contact')).toContainText(
        'With their Account (AccountId): 14,610',
      );
      await expect(report.getByTestId('step4-fit-report-emptied')).toContainText(
        'Account.ParentId (41): the record of its own object it names was cut',
      );
      await expect(page.getByTestId('stat-records')).toContainText('8,585');

      const results = await checkAccessibility(page);
      expect(results.violations.length, formatViolations(results.violations)).toBe(0);
    });
  });
}

test('fits from the review with what the run is set to do, and Undo fit gives the plan back', async ({
  page,
}) => {
  const bridge = await reviewOfARefusedPlan(page, 'Dark 2026');
  await page.getByTestId('step4-mute-toggle').check();
  await fitByShare(page, bridge, {
    ...FITTED_PLAN,
    scope: { ...FITTED_PLAN.scope, fitted: { ...FIT_REPORT, countedMuted: true } },
  });

  const [fit] = await outgoing(page, 'autopilot:fit-plan');
  expect(fit.payload).toEqual({ mode: { share: true }, muteAutomation: true });
  await expect(page.getByTestId('step4-fit-report-room')).toHaveText(
    'Nothing is kept for the flows of QASandbox: none of those that still run creates records under these, and the mute keeps the others quiet.',
  );

  await page.getByRole('button', { name: 'Undo fit' }).click();
  await bridge.waitForMessage('autopilot:fit-undo', { timeout: 10_000 });
  await respondToAll(page, 'autopilot:fit-undo', 'autopilot:plan-ready', {
    plan: PLAN,
    graph: GRAPH,
    writeGate: REFUSED,
  });
  await expect(page.getByRole('region', { name: 'Fitted to QASandbox' })).toHaveCount(0);
  await expect(page.getByTestId('stat-records')).toContainText('32,982');
});

test('says a run refused for its storage in figures, with the fit that opens from there', async ({
  page,
}) => {
  const bridge = await reviewOfARefusedPlan(page, 'Light 2026');
  await page.getByTestId('execute-button').click();
  const run = await bridge.waitForMessage('autopilot:execute', { timeout: 10_000 });
  await sendExtensionMessage(page, {
    type: 'autopilot:error',
    id: 'refusal-1',
    correlationId: String(run.id),
    payload: {
      message: 'The records to write take about 64.5 MB of data storage…',
      code: 'AUTOPILOT_STORAGE_EXCEEDED',
      retryable: false,
      org: 'QASandbox',
      estimateMB: 64.5,
      remainingMB: 21,
      maxMB: 200,
      writeGate: { ...REFUSED, remainingMB: 21 },
    },
  });

  await expect(page.getByTestId('autopilot-execute-error')).toContainText(
    'its records take about 64.5 MB of data storage, and QASandbox has 21 MB left of 200 MB. Fit the plan to storage',
  );
  await expect(page.getByTestId('step4-fit-plan-storage')).toContainText('21 MB left of 200 MB');
  await expect(page.getByRole('button', { name: 'Fit to storage…' })).toBeVisible();

  const results = await checkAccessibility(page);
  expect(results.violations.length, formatViolations(results.violations)).toBe(0);
});
