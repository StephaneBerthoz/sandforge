import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MockBridge, checkAccessibility, formatViolations } from './helpers';
import { QA_SANDBOX } from './fixtures';
import { VSCODE_DEFAULT_STYLES } from './fixtures/vscode-default-styles';
import { sendExtensionMessage } from './mocks/vscode-api';
import { hostColours, vscodeTheme } from '../src/styles/testing/vscodeThemes';

/**
 * A clone from the records a query chooses, from the SOQL tab: before
 * Discover the page asks what the query chooses, says how many, and when it
 * chooses more than a run takes offers the newest of them, written into the
 * query where the user sees it, and the setting; the run goes as the records
 * the query chooses, its WHERE filtering no read; Review says so; the
 * results of its simulation say the roots it would write, what reading what
 * they reach sent the source, and how each object's records came in.
 * Scanned with axe under VS Code's default themes and the two they replaced,
 * painted as the host paints a webview.
 */
const THEMES = ['Light 2026', 'Dark 2026', 'Light Modern', 'Dark Modern'] as const;
type Theme = (typeof THEMES)[number];

const ENERGY = "SELECT Id FROM Account WHERE Industry = 'Energy'";
const NEWEST = `${ENERGY} ORDER BY CreatedDate DESC, Id DESC LIMIT 200`;

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

/** A node of the graph, as a Forge discovery answers with it. */
function node(objectApiName: string, level: number, recordCount: number) {
  return {
    objectApiName,
    recordCount,
    fieldCount: 20,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 15,
    estimatedSizeMB: 0.01,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
  };
}

/** Accounts and the cases under them, as discovery counts their source tables. */
const GRAPH = {
  nodes: [node('Account', 0, 1_200), node('Case', 1, 48_000)],
  edges: [
    { sourceObject: 'Account', targetObject: 'Case', relationshipName: 'Cases', type: 'lookup' },
  ],
  totalRecords: 49_200,
  estimatedSizeMB: 49,
  estimatedDurationSeconds: 120,
};

/** What a simulation of the 37 newest Energy accounts answers. */
const SIMULATION = {
  forgeId: 'forge-simulated-roots',
  status: 'success',
  graph: GRAPH,
  duration: 900,
  timestamp: '2026-11-14T10:00:00.000Z',
  idRemapCount: 0,
  idRemapTable: {},
  createdCount: 0,
  dryRun: true,
  wouldInsertCount: 161,
  readByObject: [
    { objectApiName: 'Account', read: 41, origin: { roots: 37, under: 0, named: 4 } },
    {
      objectApiName: 'Case',
      read: 120,
      origin: { roots: 0, under: 120, named: 0 },
      readUnder: ['Account'],
    },
  ],
  failedReads: [],
  errors: [],
  truncatedObjects: [],
  roots: {
    objectApiName: 'Account',
    from: 'query',
    query: { where: "Industry = 'Energy'", orderBy: 'CreatedDate DESC', limit: 200 },
    cap: 200,
    asked: 37,
    read: 37,
    gone: [],
    written: 37,
    linked: 0,
    failed: [],
    sha256: 'a'.repeat(64),
    readAt: '2026-11-14T10:00:00.000Z',
  },
  reads: { source: 84 },
};

/** The ids of the requests of a type the page has sent, in order. */
async function requestIds(page: Page, type: string): Promise<string[]> {
  return page.evaluate((wanted) => {
    const posted = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
    return posted
      .map((m) => ((m as Record<string, unknown>).payload ?? m) as Record<string, unknown>)
      .filter((m) => m.type === wanted)
      .map((m) => String(m.id));
  }, type);
}

/** The payloads of the requests of a type the page has sent, in order. */
async function payloadsOf(page: Page, type: string): Promise<Array<Record<string, unknown>>> {
  return page.evaluate((wanted) => {
    const posted = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
    return posted
      .map((m) => ((m as Record<string, unknown>).payload ?? m) as Record<string, unknown>)
      .filter((m) => m.type === wanted)
      .map((m) => (m.payload ?? {}) as Record<string, unknown>);
  }, type);
}

/** Answer every pending request of a type: StrictMode can send one twice. */
async function answerAll(
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

/** Wait for the page to ask what `query` chooses, and answer it. */
async function answerRoots(
  page: Page,
  query: string,
  answer: { chosen: number; more: boolean },
): Promise<void> {
  await expect
    .poll(async () => (await payloadsOf(page, 'forge:previewRoots')).at(-1)?.['soqlQuery'], {
      timeout: 10_000,
    })
    .toBe(query);
  await answerAll(page, 'forge:previewRoots', 'forge:previewRoots:response', {
    sourceOrgId: 'org-src-1',
    soqlQuery: query,
    objectApiName: 'Account',
    cap: 200,
    requests: 1,
    ...answer,
  });
}

/** Open Forge on the SOQL tab, its query typed, the QA sandbox its target. */
async function typeTheQuery(page: Page, theme: Theme): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await paintHostTheme(page, theme);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'forge';
  });
  await page.goto('/');
  await bridge.seedOrgs();
  await page.waitForSelector('[data-testid="forge-page"]', { timeout: 10_000 });
  await page.getByTestId('forge-tab-soql').click();
  await page.getByTestId('forge-input-soql').fill(ENERGY);
  await page.getByTestId('forge-target-org').click();
  await page.getByTestId(`forge-target-org-option-${QA_SANDBOX.id}`).click();
  return bridge;
}

test.describe('a clone from the records a query chooses', () => {
  test('says how many the query chooses before Discover, writes the newest into the query past the most, and discovers them as records', async ({
    page,
  }) => {
    const bridge = await typeTheQuery(page, 'Dark 2026');

    await expect(page.getByTestId('forge-roots-info')).toHaveText(
      'Your query chooses the Account records to clone: what is linked to them comes with them, as for the clone of one record. Other Account records come only as parents they name.',
    );
    await answerRoots(page, ENERGY, { chosen: 200, more: true });
    await expect(page.getByTestId('forge-roots-said')).toHaveText(
      'The query chooses more than the 200 Account records a run clones, and no LIMIT holds it to that: the run would be refused before it read anything else. Take the newest, narrow its WHERE, or raise the setting.',
    );
    // Discover waits: the run would be refused for them once discovery, the
    // target's automation and its gaps had been read.
    await expect(page.getByTestId('forge-discover-btn')).toBeDisabled();
    await expect(page.getByTestId('forge-discover-hint')).toHaveText(
      'Take fewer of the records the query chooses to discover the graph: a run would be refused for them',
    );

    await page.getByTestId('forge-roots-setting').click();
    const opened = await bridge.waitForMessage('workbench:open-setting', { timeout: 10_000 });
    expect(opened.payload).toEqual({ setting: 'sandforge.forge.maxRoots' });

    await page.getByTestId('forge-roots-newest').click();
    await expect(page.getByTestId('forge-input-soql')).toHaveValue(NEWEST);
    await answerRoots(page, NEWEST, { chosen: 37, more: false });
    await expect(page.getByTestId('forge-roots-said')).toHaveText(
      'The query chooses 37 Account records of the source org: the run clones each, with what it reaches (200 at most).',
    );

    await page.getByTestId('forge-discover-btn').click();
    const discover = await bridge.waitForMessage('forge:discover', { timeout: 10_000 });
    const config = (discover.payload as { config: Record<string, unknown> }).config;
    expect(config).toMatchObject({
      inputMode: 'soql',
      soqlQuery: NEWEST,
      queryScope: 'records',
      maxRoots: 200,
    });
    expect(config['objectSoqlFilters']).toBeUndefined();
    expect(config['maxRecordsPerObject']).toBeUndefined();
  });

  test('keeps Discover off for a query that cannot choose records, and says why', async ({
    page,
  }) => {
    await typeTheQuery(page, 'Light 2026');
    await page
      .getByTestId('forge-input-soql')
      .fill('SELECT Industry FROM Account GROUP BY Industry');

    await expect(page.getByTestId('forge-roots-issue')).toHaveText(
      'The query’s GROUP BY changes the records it returns, and the clone would read others than it shows: take it out, and choose the records by WHERE, ORDER BY and LIMIT.',
    );
    await expect(page.getByTestId('forge-discover-btn')).toBeDisabled();
    await expect(page.getByTestId('forge-discover-hint')).toHaveText(
      'Correct the query to discover the graph: it chooses the records to clone',
    );
    expect(await requestIds(page, 'forge:previewRoots')).toEqual([]);
  });
});

for (const theme of THEMES) {
  test.describe(`a clone from the records a query chooses (${theme})`, () => {
    test('the SOQL tab, its query choosing more than a run takes, passes axe', async ({ page }) => {
      await typeTheQuery(page, theme);
      await answerRoots(page, ENERGY, { chosen: 200, more: true });
      await expect(page.getByTestId('forge-roots-newest')).toBeVisible();

      const results = await checkAccessibility(page);
      expect(results.violations.length, formatViolations(results.violations)).toBe(0);
    });

    test('Review names the records the query chooses, and the results of its simulation say what it did of them; both pass axe', async ({
      page,
    }) => {
      const bridge = await typeTheQuery(page, theme);
      await answerRoots(page, ENERGY, { chosen: 37, more: false });
      await page.getByTestId('forge-discover-btn').click();
      await page.waitForSelector('[data-testid="forge-discovery-loading"]', { timeout: 10_000 });
      await answerAll(page, 'forge:discover', 'forge:discover:response', { graph: GRAPH });
      await expect(page.getByTestId('stat-source-tables')).toHaveText(
        'The clone reads only what the records its query chooses reach: these counts are of the source tables, not of what it will write.',
      );
      await page.getByTestId('forge-execute-btn').click();
      await page.waitForSelector('[data-testid="forge-review"]', { timeout: 10_000 });
      await expect(page.getByTestId('forge-review')).toContainText(
        'Copy up to 200 Account records and what they reach, from',
      );
      const review = await checkAccessibility(page);
      expect(review.violations.length, formatViolations(review.violations)).toBe(0);

      await page.getByTestId('simulate-button').click();
      await page.waitForSelector('[data-testid="forge-execution"]', { timeout: 10_000 });
      const request = await bridge.waitForMessage('forge:execute', { timeout: 10_000 });
      await sendExtensionMessage(page, {
        type: 'forge:execute:response',
        id: 'simulated-roots',
        correlationId: String(request.id),
        payload: { result: SIMULATION, operationId: 'forge-execute-1' },
      });

      await expect(page.getByTestId('forge-roots-result-written')).toHaveText(
        '37 of 37 would be written; nothing was written.',
      );
      await expect(page.getByTestId('forge-roots-result-reads')).toContainText('84 requests');
      await expect(page.getByTestId('forge-roots-result-objects')).toContainText(
        'Case: 120 read, 120 under the clone’s records. Read under Account',
      );
      const results = await checkAccessibility(page);
      expect(results.violations.length, formatViolations(results.violations)).toBe(0);
    });
  });
}
