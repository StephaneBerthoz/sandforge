import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MockBridge, checkAccessibility, formatViolations } from './helpers';
import { DEV_SANDBOX, QA_SANDBOX } from './fixtures';
import { VSCODE_DEFAULT_STYLES } from './fixtures/vscode-default-styles';
import { themeContrastShortfalls } from './helpers/theme-contrast';
import { sendExtensionMessage } from './mocks/vscode-api';
import { hostColours, vscodeTheme } from '../src/styles/testing/vscodeThemes';

/**
 * Forge's Review as a panel draws it: the run in a sentence, its parts as rows
 * that open in place, the column of the run beside them, and the ribbon of the
 * two orgs. What a unit test cannot see is held here: where Execute stands on
 * the screen, what a narrow panel does to the page, what the keyboard reaches,
 * and what each theme paints.
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

/** An object of the graph, as a Forge discovery answers with it. */
function node(objectApiName: string, recordCount: number, level: number, piiFields: string[] = []) {
  return {
    objectApiName,
    recordCount,
    fieldCount: 50,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields,
    anonymizeFields: [],
    level,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 40,
    estimatedSizeMB: 0.01,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
  };
}

const GRAPH = {
  nodes: [
    node('Account', 1, 0),
    node('Contact', 3, 1, ['Email', 'Phone', 'LastName']),
    node('Opportunity', 2, 1),
    node('Case', 2, 1),
  ],
  edges: [
    {
      sourceObject: 'Contact',
      targetObject: 'Account',
      relationshipName: 'Account',
      type: 'lookup',
      required: false,
    },
  ],
  totalRecords: 8,
  estimatedSizeMB: 0.1,
  estimatedDurationSeconds: 4,
};

/** A run of fifty objects, each under the one before. */
const FIFTY_OBJECTS = {
  ...GRAPH,
  nodes: Array.from({ length: 50 }, (_, index) =>
    node(`Object${String(index)}__c`, 1, Math.floor(index / 5)),
  ),
  edges: [],
  totalRecords: 50,
};

const PLAN = {
  waves: [
    {
      order: 0,
      objectApiNames: ['Account'],
      estimatedApiCalls: 1,
      estimatedDurationSeconds: 0.5,
    },
    {
      order: 1,
      objectApiNames: ['Contact', 'Opportunity', 'Case'],
      estimatedApiCalls: 3,
      estimatedDurationSeconds: 1.5,
    },
  ],
  totalRecords: 8,
  totalApiCalls: 4,
  estimatedDurationSeconds: 2,
  cycleResolutions: [],
};

/** A field only the target requires: three contacts would be refused. */
const REFUSING_GAP = {
  id: 'required_field_missing|Contact|Region__c||',
  kind: 'required_field_missing',
  severity: 'blocking',
  source: 'metadata',
  objectApiName: 'Contact',
  field: 'Region__c',
  rows: 3,
  decisions: ['set_default', 'exclude_object'],
};

/** A flow the target runs on a contact's insert, which a permission set keeps quiet. */
const AUTOMATION = {
  objectsRead: ['Account', 'Contact', 'Opportunity', 'Case'],
  objects: [
    {
      objectApiName: 'Contact',
      flows: [
        {
          apiName: 'Contact_Welcome',
          label: 'Contact welcome',
          timing: 'afterSave',
          startsOn: 'create',
          condition: 'read',
          permissions: [{ name: 'Load_Data', bypass: true, held: false }],
        },
      ],
      triggers: [],
    },
  ],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 4,
  bypassGrants: [
    {
      permission: 'Load_Data',
      permissionSets: [{ name: 'Data_Load', label: 'Data load', grants: 1 }],
    },
  ],
};

/** Answer every pending request of a type: StrictMode can send one twice. */
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

/** What opening Review is given. */
interface ReviewOptions {
  /** The host's theme; null for none, which leaves the design system's fallbacks. */
  theme?: Theme | null;
  graph?: Record<string, unknown>;
  gaps?: readonly Record<string, unknown>[];
  orgs?: readonly unknown[];
}

/** Open Review of a run, every read answered. */
async function openReview(page: Page, options: ReviewOptions = {}): Promise<MockBridge> {
  const { theme = 'Dark 2026', graph = GRAPH, gaps = [], orgs } = options;
  const bridge = new MockBridge();
  await bridge.setup(page);
  if (theme !== null) await paintHostTheme(page, theme);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'forge';
  });
  await page.goto('/');
  await bridge.seedOrgs(orgs);
  await page.waitForSelector('[data-testid="forge-page"]', { timeout: 10_000 });
  await page.getByTestId('forge-tab-soql').click();
  await page.getByTestId('forge-input-soql').fill('SELECT Id FROM Account');
  await page.getByTestId('forge-target-org').click();
  await page.getByTestId(`forge-target-org-option-${QA_SANDBOX.id}`).click();
  await page.getByTestId('forge-discover-btn').click();
  await page.waitForSelector('[data-testid="forge-discovery-loading"]', { timeout: 10_000 });
  await answerAll(page, 'forge:discover', 'forge:discover:response', { graph });
  await page.getByTestId('forge-execute-btn').click();
  await page.getByTestId('forge-review').waitFor({ timeout: 10_000 });
  await bridge.waitForMessage('forge:automation:request', { timeout: 10_000 });
  await bridge.waitForMessage('forge:gaps:request', { timeout: 10_000 });
  await sendExtensionMessage(page, {
    type: 'forge:plan:response',
    id: 'plan-1',
    payload: { plan: PLAN },
  });
  await answerAll(page, 'forge:metadata-diff:request', 'forge:metadata-diff:response', {
    diffs: [],
  });
  await answerAll(page, 'forge:automation:request', 'forge:automation:response', {
    automation: AUTOMATION,
  });
  await answerAll(page, 'forge:gaps:request', 'forge:gaps:response', {
    gaps: { gaps, unread: [], requests: 5 },
  });
  await expect(page.getByTestId('review-row-metadata-state')).toHaveText('Ready');
  await expect(page.getByTestId('review-row-automation-state')).toHaveText('To read');
  return bridge;
}

/**
 * Whether the element `testId` is whole inside the window and the topmost
 * thing at its centre: in sight and clickable without scrolling.
 */
async function inSight(page: Page, testId: string): Promise<boolean> {
  return page.getByTestId(testId).evaluate((element) => {
    const box = element.getBoundingClientRect();
    if (box.top < 0 || box.bottom > window.innerHeight) return false;
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit !== null && element.contains(hit);
  });
}

/** Scroll the panel to `top`, in pixels. */
async function scrollPanelTo(page: Page, top: number): Promise<void> {
  await page.getByTestId('panel-app').evaluate((panel, to) => {
    panel.scrollTop = to;
  }, top);
}

/** Open every row and Controls, and what the rows and the column fold. */
async function openEveryRow(page: Page): Promise<void> {
  for (const row of ['plan', 'anonymization', 'compliance', 'metadata', 'automation', 'controls']) {
    await page.getByTestId(`tab-${row}`).click();
    await expect(page.getByTestId(`tab-${row}`)).toHaveAttribute('aria-expanded', 'true');
  }
  if ((await page.getByTestId('tab-gaps').getAttribute('aria-expanded')) === 'false') {
    await page.getByTestId('tab-gaps').click();
  }
  // Folded, their words are measured by no one: axe skips what is not drawn.
  for (const fold of ['gaps-admin-list', 'automation-mute-more', 'forge-files-more']) {
    const details = page.getByTestId(fold);
    if ((await details.count()) === 0) continue;
    await details.locator('summary').first().click();
    await expect(details).toHaveAttribute('open', '');
  }
}

/** How far the panel's content runs past its right edge. */
async function sidewaysOverflow(page: Page): Promise<number> {
  return page.getByTestId('panel-app').evaluate((panel) => panel.scrollWidth - panel.clientWidth);
}

test.describe('Forge Review on a wide panel', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('has Execute in sight as it opens, under the header, the ribbon and the How to', async ({
    page,
  }) => {
    // A column held in view as one block starts where the page puts it, and a
    // height of its own ran it past the fold: Execute could not be seen until
    // the page was scrolled.
    await openReview(page, { gaps: [REFUSING_GAP] });
    expect(await inSight(page, 'execute-button')).toBe(true);
    expect(await inSight(page, 'simulate-button')).toBe(true);
    expect(await inSight(page, 'rehearse-button')).toBe(true);
  });

  test('keeps the column in sight as the rows scroll under it', async ({ page }) => {
    await openReview(page, { gaps: [REFUSING_GAP] });
    await page.getByTestId('tab-plan').click();
    await page.getByTestId('review-graph-box').scrollIntoViewIfNeeded();
    await scrollPanelTo(page, 900);

    expect(await inSight(page, 'execute-button')).toBe(true);
    expect(await inSight(page, 'controls-checkpoint-first-toggle')).toBe(true);
    // The rows have moved under it: this is the page scrolled, not a short page.
    expect(await inSight(page, 'review-sentence')).toBe(false);
  });

  test('sets the column beside the rows', async ({ page }) => {
    await openReview(page);
    const rows = await page.getByTestId('review-tabs').boundingBox();
    const column = await page.getByTestId('review-run-column').boundingBox();
    expect(column!.x).toBeGreaterThanOrEqual(rows!.x + rows!.width);
  });

  test('leaves a control reached by Tab clear of the actions held at the foot', async ({
    page,
  }) => {
    await openReview(page, { gaps: [REFUSING_GAP] });
    await page.getByTestId('tab-controls').focus();
    expect(await inSight(page, 'tab-controls')).toBe(true);
  });

  test('gives a run of fifty objects a graph it can draw whole', async ({ page }) => {
    await openReview(page, { graph: FIFTY_OBJECTS });
    await page.getByTestId('tab-plan').click();
    // Past 25 objects the view starts on the table, the graph a click away.
    await page.getByTestId('forge-view-graph').click();
    await expect(page.locator('.react-flow__node')).toHaveCount(50, { timeout: 10_000 });
    const box = await page.getByTestId('review-graph-box').boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(420);
  });
});

test.describe('Forge Review on a 1280 by 800 panel', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('keeps every row in sight with the Gaps row open on a gap', async ({ page }) => {
    // Opened on a single gap, the row was 420 pixels high: Plan to
    // Automation went under the fold.
    await openReview(page, { gaps: [REFUSING_GAP] });
    await expect(page.getByTestId('tab-gaps')).toHaveAttribute('aria-expanded', 'true');
    for (const row of ['gaps', 'plan', 'anonymization', 'compliance', 'metadata', 'automation']) {
      expect(await inSight(page, `tab-${row}`), row).toBe(true);
    }
    // The gap and its decision, before what serves less.
    expect(await inSight(page, 'gap-default-value')).toBe(true);
  });

  test('keeps Controls in sight in the column, the mute folded, Execute under it', async ({
    page,
  }) => {
    // At 800 pixels high Controls went under the fold of the column's own
    // scroll, under the mute's fourteen lines.
    await openReview(page, { gaps: [REFUSING_GAP] });
    await page.getByTestId('automation-mute').waitFor();
    expect(await inSight(page, 'tab-controls')).toBe(true);
    expect(await inSight(page, 'review-row-controls-summary')).toBe(true);
    expect(await inSight(page, 'execute-button')).toBe(true);
    await expect(page.getByTestId('automation-mute-assigns')).toBeHidden();

    await page.getByTestId('automation-mute-more-summary').click();
    await expect(page.getByTestId('automation-mute-assigns')).toBeVisible();
    expect(await inSight(page, 'execute-button')).toBe(true);
  });

  test('names the two orgs over the How to, and the run under it', async ({ page }) => {
    // Under the How to, the ribbon came some 210 pixels before the sentence.
    await openReview(page);
    const ribbon = await page.getByTestId('org-ribbon').boundingBox();
    const howTo = await page.getByTestId('how-to-forge').boundingBox();
    const sentence = await page.getByTestId('review-sentence').boundingBox();
    expect(ribbon!.y + ribbon!.height).toBeLessThanOrEqual(howTo!.y);
    expect(howTo!.y + howTo!.height).toBeLessThanOrEqual(sentence!.y);
  });
});

test.describe('Forge Review on a narrow panel', () => {
  test.use({ viewport: { width: 360, height: 640 } });

  test('runs past nothing, every row open', async ({ page }) => {
    await openReview(page, { gaps: [REFUSING_GAP] });
    await openEveryRow(page);
    await page.getByTestId('review-graph-search-input').fill('o');
    expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);
  });

  test('opens the Plan row on the table, the graph a click away in a box inside the panel', async ({
    page,
  }) => {
    // At this width the fit left the minimap its strip and stopped at React
    // Flow's smallest zoom: the nodes opened outside the box, all but one, the
    // minimap taking most of what was left. Under `auto` the table opens.
    await openReview(page);
    await page.getByTestId('tab-plan').click();
    await expect(page.getByTestId('forge-table-view')).toBeVisible();
    await expect(page.getByTestId('forge-view-table')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.react-flow__node')).toHaveCount(0);

    await page.getByTestId('forge-view-graph').click();
    await expect(page.locator('.react-flow__node')).toHaveCount(4, { timeout: 10_000 });
    const box = await page.getByTestId('review-graph-box').boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(360);
    expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);
  });

  test('stacks the ribbon, the source over the target', async ({ page }) => {
    await openReview(page);
    const source = await page.getByTestId('org-ribbon-source').boundingBox();
    const target = await page.getByTestId('org-ribbon-target').boundingBox();
    expect(target!.y).toBeGreaterThanOrEqual(source!.y + source!.height);
    expect(target!.x).toBe(source!.x);
  });

  test('puts the column under the rows, and holds Execute at the foot of the panel', async ({
    page,
  }) => {
    await openReview(page, { gaps: [REFUSING_GAP] });
    const rows = await page.getByTestId('review-tabs').boundingBox();
    const simulate = await page.getByTestId('simulate-button').boundingBox();
    expect(simulate!.y).toBeGreaterThanOrEqual(rows!.y + rows!.height);

    // However long the rows run, Execute is one press away.
    expect(await inSight(page, 'execute-button')).toBe(true);
    await openEveryRow(page);
    await scrollPanelTo(page, 400);
    expect(await inSight(page, 'execute-button')).toBe(true);
  });

  test('goes to the Gaps row from under Execute, however far the page has scrolled', async ({
    page,
  }) => {
    await openReview(page, { gaps: [REFUSING_GAP] });
    await page.getByTestId('tab-gaps').click();
    await page.getByTestId('tab-plan').click();
    await scrollPanelTo(page, 1200);

    await page.getByTestId('forge-gaps-decide').click();

    await expect(page.getByTestId('tab-gaps')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('tab-gaps')).toBeFocused();
    expect(await inSight(page, 'tab-gaps')).toBe(true);
  });
});

test.describe('Forge Review by keyboard', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('opens and closes a row with Enter and with Space, with the focus shown', async ({
    page,
  }) => {
    await openReview(page);
    const plan = page.getByTestId('tab-plan');
    await plan.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(plan).toBeFocused();
    const outline = await plan.evaluate((element) => {
      const style = getComputedStyle(element);
      return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    expect(outline.style).not.toBe('none');
    expect(outline.width).toBeGreaterThan(0);

    await page.keyboard.press('Enter');
    await expect(plan).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Space');
    await expect(plan).toHaveAttribute('aria-expanded', 'false');
  });

  test('walks the rows one Tab stop each, and enters only the rows that are open', async ({
    page,
  }) => {
    await openReview(page);
    await page.getByTestId('tab-gaps').focus();
    const walked: Array<string | null> = [];
    for (let stop = 0; stop < 5; stop += 1) {
      await page.keyboard.press('Tab');
      walked.push(await page.evaluate(() => document.activeElement?.id ?? null));
    }
    expect(walked).toEqual([
      'tab-plan',
      'tab-anonymization',
      'tab-compliance',
      'tab-metadata',
      'tab-automation',
    ]);

    await page.getByTestId('tab-compliance').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('framework-select')).toBeFocused();
  });

  test('turns the chevron without a transition when the system asks for less motion', async ({
    page,
  }) => {
    await openReview(page);
    const chevron = page.getByTestId('tab-plan').locator('svg').first();
    const duration = await chevron.evaluate(
      (element) => getComputedStyle(element).transitionDuration,
    );
    expect(parseFloat(duration)).toBeLessThan(0.001);
  });
});

test.describe('Forge Review under no host theme', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('passes axe on the fallback colours: the ribbon, a production org in it, the rows and the column', async ({
    page,
  }) => {
    // Sync's specs paint no theme, and caught the ribbon at 4.2:1 on the
    // fallbacks that the four themes below all passed.
    const live = { ...DEV_SANDBOX, orgType: 'Production', alias: 'LiveOrg' };
    await openReview(page, { theme: null, orgs: [live, QA_SANDBOX] });
    const results = await checkAccessibility(page);
    expect(results.violations.length, formatViolations(results.violations)).toBe(0);
  });
});

for (const theme of THEMES) {
  test.describe(`Forge Review — ${theme}`, () => {
    test.use({ viewport: { width: 1280, height: 900 } });
    test.describe.configure({ timeout: 60_000 });

    test('passes axe, every row open, each text measured', async ({ page }) => {
      await openReview(page, { theme, gaps: [REFUSING_GAP] });
      const closed = await checkAccessibility(page);
      expect(closed.violations.length, formatViolations(closed.violations)).toBe(0);

      await openEveryRow(page);
      const open = await checkAccessibility(page);
      expect(open.violations.length, formatViolations(open.violations)).toBe(0);

      // Each text measured whole: a panel tall enough that nothing sits under
      // the actions, the graph closed, whose own contrast is held elsewhere.
      await page.getByTestId('tab-plan').click();
      await page.setViewportSize({ width: 1280, height: 2600 });
      const shortfalls = await themeContrastShortfalls(page, vscodeTheme(theme));
      expect(shortfalls, shortfalls.join('\n')).toEqual([]);
    });

    test('tells a production org at a glance, and passes axe', async ({ page }) => {
      const live = {
        ...DEV_SANDBOX,
        orgType: 'Production',
        alias: 'LiveOrg',
      };
      await openReview(page, { theme, orgs: [live, QA_SANDBOX] });
      const source = page.getByTestId('org-ribbon-source');
      await expect(source).toHaveAttribute('data-production', 'true');
      await expect(source).toContainText('Production org');
      await expect(source.locator('svg')).toBeVisible();

      const results = await checkAccessibility(page);
      expect(results.violations.length, formatViolations(results.violations)).toBe(0);
      const shortfalls = await themeContrastShortfalls(
        page,
        vscodeTheme(theme),
        '[data-testid="org-ribbon"]',
      );
      expect(shortfalls, shortfalls.join('\n')).toEqual([]);
    });
  });
}
