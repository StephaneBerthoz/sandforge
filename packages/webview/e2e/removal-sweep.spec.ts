import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MockBridge, checkAccessibility, formatViolations } from './helpers';
import { MOCK_ORGS, QA_SANDBOX } from './fixtures';
import { VSCODE_DEFAULT_STYLES } from './fixtures/vscode-default-styles';
import { hostColours, vscodeTheme } from '../src/styles/testing/vscodeThemes';

/**
 * What the four confirmations of a removal say of its sweep, on the rendered
 * page: Forge's, Sync's, Seed's and Frozen's. Each says on its button what it
 * does and how much; once the sweep is ticked, what it takes with no more
 * asked, how the extension classed what it found, the two ticks that take what
 * it keeps — the second refused in the extension's words — and what stays and
 * why. A removal that left records for what the automation made names it and
 * proposes the sweep. Scanned with axe under VS Code's two default themes,
 * painted as the host paints a webview.
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

/** Why the extension refuses what is tied to nothing, in its words. */
const UNTIED_REFUSAL =
  'Another run of this machine wrote to the target in this run’s window: what is tied to ' +
  'nothing of this run may be theirs, and is left. The runs of another machine, or of a CI, in ' +
  'the same window are not seen.';

/** What a sweep told the run's ties lists: every class, and what it could not look at. */
const LISTING = {
  window: { from: '2026-10-15T08:59:59.000Z', to: '2026-10-15T09:03:00.000Z' },
  looked: ['Contact', 'Account', 'Task', 'FeedItem', 'Asset'],
  found: [
    {
      objectApiName: 'Task',
      count: 7,
      names: ['Welcome call', 'Follow up'],
      classes: { made: 3, sameSave: 2, madeOver: 1, late: 2, untied: 1, changed: 1 },
    },
    {
      objectApiName: 'Asset',
      count: 1,
      names: ['Insured risk'],
      classes: { made: 1, madeOver: 0, late: 0, untied: 0 },
    },
  ],
  unread: [{ objectApiName: 'EmailMessage', reason: 'It keeps no creator.' }],
  automationGaps: { flowsNotRead: 1, triggers: 1 },
  handWork: [{ objectApiName: 'Opportunity', count: 1 }],
  late: [{ objectApiName: 'Task', count: 2 }],
  untied: { objects: [{ objectApiName: 'Task', count: 1 }] },
  notLooked: ['Custom_Child__c'],
};

/** The same, what is tied to nothing refused. */
const REFUSED_LISTING = { ...LISTING, untied: { ...LISTING.untied, refusal: UNTIED_REFUSAL } };

/** An outcome that kept records for tasks the automation likely made. */
const HELD_OBJECT = {
  objectApiName: 'Contact',
  planned: 2,
  deleted: 0,
  alreadyGone: 0,
  keptChanged: 0,
  keptDependents: 2,
  refused: 0,
  heldBy: ['Task'],
  heldByAutomation: 2,
  automationHolders: ['Task'],
  unchecked: [],
  reasons: [],
};

/** Answer every pending request of a type: a development build mounts the panel twice. */
async function answerAll(
  bridge: MockBridge,
  requestType: string,
  responseType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await bridge.waitForMessage(requestType, { timeout: 10_000 });
  for (const request of await bridge.getMessages(requestType)) {
    await bridge.respond(responseType, payload, String(request.id));
  }
}

/** Open a panel, the orgs seeded. */
async function openPanel(page: Page, theme: Theme, module: string): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await paintHostTheme(page, theme);
  await page.addInitScript((name: string) => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = name;
  }, module);
  await page.goto('/');
  await bridge.seedOrgs(MOCK_ORGS);
  return bridge;
}

/** A Forge run in the history: two contacts created in the QA sandbox. */
const FORGE_RUN = {
  forgeId: 'forge-sweep',
  status: 'success',
  graph: { nodes: [], edges: [], totalRecords: 0, estimatedSizeMB: 0, estimatedDurationSeconds: 0 },
  duration: 12_000,
  timestamp: '2026-10-15T09:02:00.000Z',
  targetOrgId: QA_SANDBOX.id,
  idRemapCount: 2,
  createdCount: 2,
  idRemapTable: {
    a00000000000001SRC: 'a00000000000001AAA',
    a00000000000002SRC: 'a00000000000002AAA',
  },
  idRemapExisting: [],
  idRemapCreated: [
    { objectApiName: 'Contact', sourceIds: ['a00000000000001SRC', 'a00000000000002SRC'] },
  ],
};

/** A Sync run a closed window stopped: two contacts created in the QA sandbox. */
const SYNC_RUN = {
  runId: 'run-sweep',
  configId: 'cfg-1',
  configName: 'Nightly contacts',
  sourceOrgId: 'org-src-1',
  targetOrgId: QA_SANDBOX.id,
  startedAt: '2026-10-15T09:00:00.000Z',
  created: 2,
  left: [{ objectApiName: 'Contact', count: 2 }],
};

/** A seed kept on this machine: two contacts created in the QA sandbox. */
const SEED_RUN = {
  runId: 'op-sweep',
  targetOrgId: QA_SANDBOX.id,
  startedAt: '2026-10-15T09:00:00.000Z',
  endedAt: '2026-10-15T09:01:00.000Z',
  created: 2,
  left: [{ objectApiName: 'Contact', count: 2 }],
};

/** The last load into the QA sandbox: two contacts it created. */
const LOAD_RECORDS = {
  orgId: QA_SANDBOX.id,
  loadedAt: '2026-10-15T09:01:00.000Z',
  created: [{ objectApiName: 'Contact', count: 2 }],
  linked: 0,
  recorded: true,
};

/** A frozen dataset, and that load. */
const FROZEN_STATUS = {
  configured: true,
  sasDir: '/home/qa/.sandforge-sas',
  datasetDir: '/home/qa/.sandforge-sas/dataset',
  salt: { present: true, fingerprint: 'abc123def456' },
  mockDetectionConfigured: true,
  selection: null,
  manifest: {
    version: '1.0.0',
    status: 'frozen',
    frozenAt: '2026-10-15T08:00:00.000Z',
    source: { orgId: 'org-src-1', decisionDate: '2026-10-15T07:00:00.000Z' },
    saltFingerprint: 'abc123def456',
    rulesVersion: '1.0.0',
    volumetry: { budgetMax: 100, measured: { Contact: 2 }, measuredAt: '2026-10-15' },
    controls: {
      nonReidentification: { passed: true, checks: [], author: 'qa', checkedAt: '2026-10-15' },
      dryRunLoad: null,
      author: 'qa',
      date: '2026-10-15',
    },
  },
  lastLoad: { status: 'completed', orgId: QA_SANDBOX.id, at: LOAD_RECORDS.loadedAt },
  lastLoads: [{ status: 'completed', orgId: QA_SANDBOX.id, at: LOAD_RECORDS.loadedAt }],
  lastVerifies: [],
  loadRecords: [LOAD_RECORDS],
};

/** One of the four confirmations: how to reach it, what it reads, and how it is told what it did. */
interface Confirmation {
  name: string;
  /** Open its page and click its removal. */
  open: (page: Page, theme: Theme) => Promise<MockBridge>;
  /** The test id of its sweep's tick. */
  toggle: string;
  /** The read of its sweep's list, and the answer that names the run. */
  sweep: { request: string; response: string; of: Record<string, unknown> };
  /** The removal it sends, and how a result of it is answered. */
  removal: { request: string; response: string; of: Record<string, unknown> };
  /** What a request says of the run, beside what is ticked. */
  asked: Record<string, unknown>;
  /**
   * The read of what fires on what the sweep takes, which the confirmation
   * waits for before it can be confirmed, when it has one.
   */
  automation?: { request: string; response: string; of: Record<string, unknown> };
}

const CONFIRMATIONS: readonly Confirmation[] = [
  {
    name: 'a Forge run',
    open: async (page, theme) => {
      const bridge = await openPanel(page, theme, 'forge');
      await page.waitForSelector('[data-testid="forge-page"]', { timeout: 10_000 });
      await answerAll(bridge, 'forge:history:list', 'forge:history:list:response', {
        history: [FORGE_RUN],
        olderRuns: [],
      });
      await page.getByTestId('forge-history-remove-forge-sweep').click();
      return bridge;
    },
    toggle: 'forge-removal-sweep-toggle',
    sweep: {
      request: 'forge:undo-sweep:request',
      response: 'forge:undo-sweep:response',
      of: { forgeId: 'forge-sweep' },
    },
    removal: {
      request: 'forge:undo',
      response: 'forge:undo:response',
      of: { forgeId: 'forge-sweep' },
    },
    asked: { forgeId: 'forge-sweep', includeChanged: false },
  },
  {
    name: 'a Sync run',
    open: async (page, theme) => {
      const bridge = await openPanel(page, theme, 'sync');
      await expect(page.getByTestId('sync-page')).toBeVisible();
      await page.getByTestId('tab-history').click();
      await answerAll(bridge, 'sync:history:list', 'sync:history:list:response', { entries: [] });
      await answerAll(bridge, 'sync:removal:list', 'sync:removal:list:response', {
        runs: [SYNC_RUN],
      });
      await answerAll(bridge, 'sync:removal:info', 'sync:removal:info:response', {
        info: SYNC_RUN,
      });
      await page.getByTestId('sync-removal-remove').click();
      return bridge;
    },
    toggle: 'sync-removal-sweep-toggle',
    sweep: {
      request: 'sync:remove:sweep',
      response: 'sync:remove:sweep:response',
      of: { runId: 'run-sweep' },
    },
    removal: {
      request: 'sync:remove',
      response: 'sync:remove:response',
      of: { runId: 'run-sweep' },
    },
    asked: { runId: 'run-sweep' },
  },
  {
    name: 'a Seed run',
    open: async (page, theme) => {
      const bridge = await openPanel(page, theme, 'seed');
      await answerAll(bridge, 'seed:removal:list', 'seed:removal:list:response', {
        runs: [SEED_RUN],
      });
      await page.getByTestId('seed-run-history-toggle-op-sweep').click();
      await answerAll(bridge, 'seed:removal:info', 'seed:removal:info:response', {
        info: SEED_RUN,
      });
      await page.getByTestId('seed-removal-remove').click();
      return bridge;
    },
    toggle: 'seed-removal-sweep-toggle',
    sweep: {
      request: 'seed:remove:sweep',
      response: 'seed:remove:sweep:response',
      of: { runId: 'op-sweep' },
    },
    removal: {
      request: 'seed:remove',
      response: 'seed:remove:response',
      of: { runId: 'op-sweep' },
    },
    asked: { runId: 'op-sweep' },
  },
  {
    name: 'a Frozen load',
    open: async (page, theme) => {
      const bridge = await openPanel(page, theme, 'frozen');
      await page.waitForSelector('[data-testid="frozen-page"]', { timeout: 10_000 });
      await answerAll(bridge, 'frozen:status', 'frozen:status:response', {
        status: FROZEN_STATUS,
      });
      await page.getByTestId('page-tab-load').click();
      await page.getByTestId('frozen-load-target').click();
      await page.getByTestId(`frozen-load-target-option-${QA_SANDBOX.id}`).click();
      await page.getByTestId('frozen-removal').waitFor({ timeout: 10_000 });
      await page.getByTestId('frozen-removal-remove').click();
      return bridge;
    },
    toggle: 'frozen-removal-sweep-toggle',
    sweep: {
      request: 'frozen:remove:sweep',
      response: 'frozen:remove:sweep:response',
      of: { loadedAt: LOAD_RECORDS.loadedAt },
    },
    removal: {
      request: 'frozen:remove',
      response: 'frozen:remove:response',
      of: {},
    },
    asked: { targetOrgId: QA_SANDBOX.id, loadedAt: LOAD_RECORDS.loadedAt },
    automation: {
      request: 'frozen:remove:automation',
      response: 'frozen:remove:automation:response',
      of: { loadedAt: LOAD_RECORDS.loadedAt },
    },
  },
];

/** Tick the sweep and answer its read with `listing`. */
async function readSweep(
  page: Page,
  bridge: MockBridge,
  confirmation: Confirmation,
  listing: Record<string, unknown>,
): Promise<void> {
  await page.getByTestId(confirmation.toggle).check();
  await answerAll(bridge, confirmation.sweep.request, confirmation.sweep.response, {
    ...confirmation.sweep.of,
    listing,
  });
  await expect(page.getByTestId('forge-sweep-takes')).toBeVisible();
}

/** Scan the page with axe and fail on a violation, naming it. */
async function expectNoViolation(page: Page): Promise<void> {
  const results = await checkAccessibility(page);
  expect(results.violations.length, formatViolations(results.violations)).toBe(0);
}

for (const theme of THEMES) {
  for (const confirmation of CONFIRMATIONS) {
    test.describe(`the sweep of ${confirmation.name} (${theme})`, () => {
      test('says what it does, what it takes, what it keeps and what stays, and passes axe', async ({
        page,
      }) => {
        const bridge = await confirmation.open(page, theme);
        const button = page.getByTestId('danger-confirm-btn');
        await expect(button).toHaveText('Remove 2 records');
        await expect(page.getByTestId(confirmation.toggle)).not.toBeChecked();
        expect(await bridge.getMessages(confirmation.sweep.request)).toEqual([]);

        await readSweep(page, bridge, confirmation, LISTING);

        await expect(button).toHaveText('Remove 2 records and what the sweep takes');
        await expect(page.getByTestId('forge-sweep-takes')).toHaveText(
          'With no more asked, the sweep takes 5 records it ties to the run.',
        );
        const classes = page.getByTestId('forge-sweep-classes-Task');
        await expect(classes).toContainText('3 made for the run');
        await expect(classes).toContainText('2 came late, kept unless asked');
        await expect(classes).toContainText('1 tied to nothing of the run, kept unless asked');
        await expect(page.getByTestId('forge-sweep-late-tick')).not.toBeChecked();
        await expect(page.getByTestId('forge-sweep-untied-tick')).not.toBeChecked();
        await page.getByTestId('forge-sweep-stays').locator('summary').click();
        await expect(page.getByTestId('forge-sweep-stays')).toContainText('What left the org');
        await expectNoViolation(page);
      });

      test('sends the two ticks with the removal once they are ticked', async ({ page }) => {
        const bridge = await confirmation.open(page, theme);
        await readSweep(page, bridge, confirmation, LISTING);

        await page.getByTestId('forge-sweep-late-tick').check();
        await page.getByTestId('forge-sweep-untied-tick').check();
        if (confirmation.automation) {
          // Nothing fires, read on what the removal and its sweep delete.
          await answerAll(
            bridge,
            confirmation.automation.request,
            confirmation.automation.response,
            {
              ...confirmation.automation.of,
              automation: { objectsRead: ['Contact', 'Task', 'Asset'], objects: [], unread: [] },
              steps: { setToDraft: [], delete: ['Contact', 'Task', 'Asset'] },
            },
          );
        }
        await expectNoViolation(page);
        await page.getByTestId('danger-input').fill(QA_SANDBOX.alias);
        await page.getByTestId('danger-confirm-btn').click();

        const removal = await bridge.waitForMessage(confirmation.removal.request, {
          timeout: 10_000,
        });
        expect(removal.payload).toEqual({
          ...confirmation.asked,
          sweep: true,
          sweepLate: true,
          sweepUntied: true,
        });
      });

      test('refuses what is tied to nothing in the extension’s words, and passes axe', async ({
        page,
      }) => {
        const bridge = await confirmation.open(page, theme);
        await readSweep(page, bridge, confirmation, REFUSED_LISTING);

        await expect(page.getByTestId('forge-sweep-untied-tick')).toBeDisabled();
        await expect(page.getByTestId('forge-sweep-untied-refused')).toContainText(UNTIED_REFUSAL);
        await expectNoViolation(page);
      });

      test('names what the automation made once a removal left records, proposes the sweep, and passes axe', async ({
        page,
      }) => {
        const bridge = await confirmation.open(page, theme);
        await page.getByTestId('danger-input').fill(QA_SANDBOX.alias);
        await page.getByTestId('danger-confirm-btn').click();
        await answerAll(bridge, confirmation.removal.request, confirmation.removal.response, {
          result: {
            ...confirmation.removal.of,
            status: 'partial',
            includeChanged: false,
            finishedAt: '2026-10-15T10:00:00.000Z',
            objects: [HELD_OBJECT],
          },
          operationId: 'removal-1',
        });

        await expect(page.getByTestId('forge-removal-held-by-automation')).toContainText(
          'likely by the target',
        );
        const takeBack = page.getByTestId('forge-removal-take-back-made');
        await expect(takeBack).toBeVisible();
        await expectNoViolation(page);

        await takeBack.click();
        await expect(page.getByTestId(confirmation.toggle)).toBeChecked();
        await bridge.waitForMessage(confirmation.sweep.request, { timeout: 10_000 });
      });

      test('keeps its field and its button in reach in a low window', async ({ page }) => {
        await page.setViewportSize({ width: 900, height: 420 });
        const bridge = await confirmation.open(page, theme);
        await readSweep(page, bridge, confirmation, LISTING);

        const button = page.getByTestId('danger-confirm-btn');
        await button.scrollIntoViewIfNeeded();
        await expect(button).toBeInViewport();
      });
    });
  }
}
