import { readFileSync } from 'node:fs';
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

/**
 * The same read on the trap org's shape: the one set that holds the flow's
 * bypass grants as well the permission two validation rules of Contact test,
 * every grant and rule read. Assigned for the flow, it lets through the
 * contacts both rules refuse.
 */
const LIFTING_AUTOMATION = {
  ...AUTOMATION,
  bypassGrants: [
    {
      permission: 'Load_Data',
      permissionSets: [
        {
          name: 'Data_Load',
          label: 'Data load',
          grants: 2,
          customPermissions: ['Load_Data', 'Skip_Rules'],
        },
      ],
    },
  ],
  validationRuleBypasses: [
    { objectApiName: 'Contact', name: 'Email_Required', permissions: ['Skip_Rules'] },
    { objectApiName: 'Contact', name: 'Phone_Format', permissions: ['Skip_Rules'] },
  ],
  validationRulesNotRead: 0,
};

/** The same set lifting a third rule of Contact: the folded line names three. */
const THREE_LIFTS_AUTOMATION = {
  ...LIFTING_AUTOMATION,
  validationRuleBypasses: [
    ...LIFTING_AUTOMATION.validationRuleBypasses,
    { objectApiName: 'Contact', name: 'Mailing_Country_Valid', permissions: ['Skip_Rules'] },
  ],
};

/**
 * A validation rule of Contact the set of {@link LIFTING_AUTOMATION} lifts:
 * the metadata read names the set that holds its bypass.
 */
const LIFTED_RULE_GAP = {
  id: 'validation_rule|Contact|Email||Email_Required',
  kind: 'validation_rule',
  severity: 'warning',
  source: 'metadata',
  objectApiName: 'Contact',
  field: 'Email',
  value: 'Email_Required',
  rows: 0,
  detail: {
    rule: 'Email_Required',
    message: 'An email is required.',
    formula: 'read',
    bypasses: ['$Permission.Skip_Rules'],
    assign: ['Skip_Rules=Data_Load'],
  },
  decisions: ['leave_empty', 'ignore'],
  defaultDecision: 'leave_empty',
};

/**
 * What the metadata read of the trap org gave a clone of one contact: eleven
 * gaps, one of them refusing rows — a field only the target requires, which
 * opens the Gaps row on its default value —, five that may refuse or change
 * rows, two of them validation rules the set of {@link LIFTING_AUTOMATION}
 * lifts, and five that refuse nothing. On it, Metadata and Automation went
 * under the fold of a 1280 by 800 panel.
 */
const ELEVEN_GAPS: readonly Record<string, unknown>[] = [
  {
    id: 'required_field_missing|Account|Region_Only__c||',
    kind: 'required_field_missing',
    severity: 'blocking',
    source: 'metadata',
    objectApiName: 'Account',
    field: 'Region_Only__c',
    rows: 0,
    detail: { type: 'string', reason: 'notInSource' },
    decisions: ['set_default', 'exclude_object'],
  },
  {
    id: 'lookup_filter|Contact|Preferred_Account__c||',
    kind: 'lookup_filter',
    severity: 'warning',
    source: 'metadata',
    objectApiName: 'Contact',
    field: 'Preferred_Account__c',
    rows: 0,
    detail: { referenceTo: ['Account'], optional: true, filterOptional: false },
    decisions: ['leave_empty', 'ignore'],
    defaultDecision: 'leave_empty',
  },
  LIFTED_RULE_GAP,
  {
    ...LIFTED_RULE_GAP,
    id: 'validation_rule|Contact|Phone||Phone_Format',
    field: 'Phone',
    value: 'Phone_Format',
    detail: {
      ...LIFTED_RULE_GAP.detail,
      rule: 'Phone_Format',
      message: 'A phone is +1 then ten digits.',
    },
  },
  {
    id: 'validation_rule|Contact|LeadSource||Lead_Source_Locked',
    kind: 'validation_rule',
    severity: 'warning',
    source: 'metadata',
    objectApiName: 'Contact',
    field: 'LeadSource',
    value: 'Lead_Source_Locked',
    rows: 0,
    detail: {
      rule: 'Lead_Source_Locked',
      message: 'The lead source cannot change once set.',
      formula: 'read',
    },
    decisions: ['leave_empty', 'ignore'],
    defaultDecision: 'leave_empty',
  },
  {
    id: 'duplicate_rule|Lead|||Lead_Block',
    kind: 'duplicate_rule',
    severity: 'warning',
    source: 'metadata',
    objectApiName: 'Lead',
    rows: 0,
    detail: { rule: 'Lead Block', developerName: 'Lead_Block', action: 'block' },
    decisions: ['ignore', 'exclude_object'],
  },
  ...['Account', 'Account', 'Contact', 'Lead'].map((object, index) => ({
    id: `duplicate_rule|${object}|||Alert_${String(index)}`,
    kind: 'duplicate_rule',
    severity: 'info',
    source: 'metadata',
    objectApiName: object,
    rows: 0,
    detail: {
      rule: `Alert ${String(index)}`,
      developerName: `Alert_${String(index)}`,
      action: 'allow',
      alert: true,
      report: true,
    },
    decisions: ['ignore'],
    defaultDecision: 'ignore',
  })),
  {
    id: 'api_budget|Contact|||',
    kind: 'api_budget',
    severity: 'info',
    source: 'metadata',
    objectApiName: 'Contact',
    rows: 0,
    detail: {
      calls: 56,
      writes: 47,
      reads: 9,
      estimate: 'atMost',
      max: 15000,
      remaining: 10312,
    },
    decisions: ['ignore'],
  },
];

/** The languages Review is drawn in besides English. */
const LANGUAGES = ['fr', 'de', 'es', 'pt-BR', 'ja'] as const;
type Language = (typeof LANGUAGES)[number];

/**
 * The bundle the extension answers a language's request with: the very file
 * the build copies for it.
 */
function bundleOf(language: Language): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`../src/i18n/locales/${language}.json`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
}

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
  /** The read of the target's automation: a flow a permission set keeps quiet unless given. */
  automation?: Record<string, unknown>;
  /** The editor's display language, English when not said: the host answers with its bundle. */
  language?: Language;
}

/** Open Review of a run, every read answered. */
async function openReview(page: Page, options: ReviewOptions = {}): Promise<MockBridge> {
  const {
    theme = 'Dark 2026',
    graph = GRAPH,
    gaps = [],
    orgs,
    automation = AUTOMATION,
    language,
  } = options;
  const bridge = new MockBridge();
  await bridge.setup(page);
  if (theme !== null) await paintHostTheme(page, theme);
  await page.addInitScript((editorLanguage) => {
    const panel = window as unknown as Record<string, unknown>;
    panel.__SANDFORGE_MODULE__ = 'forge';
    if (editorLanguage) panel.__SANDFORGE_EDITOR_LANGUAGE__ = editorLanguage;
  }, language ?? '');
  await page.goto('/');
  if (language) {
    await bridge.respondToNext(
      'i18n:locale',
      'i18n:locale:response',
      { lng: language, bundle: bundleOf(language) },
      { timeout: 10_000 },
    );
    await expect(page.locator('html')).toHaveAttribute('lang', language);
  }
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
    automation,
  });
  await answerAll(page, 'forge:gaps:request', 'forge:gaps:response', {
    gaps: { gaps, unread: [], requests: 5 },
  });
  if (language) {
    await expect(page.getByTestId('review-row-metadata-state')).toHaveAttribute(
      'data-state',
      'ready',
    );
    await expect(page.getByTestId('review-row-automation-state')).toHaveAttribute(
      'data-state',
      'toRead',
    );
  } else {
    await expect(page.getByTestId('review-row-metadata-state')).toHaveText('Ready');
    await expect(page.getByTestId('review-row-automation-state')).toHaveText('To read');
  }
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

/**
 * The description Chromium itself gives the element `testId`, read from its
 * accessibility tree. Playwright's own reckoning reads the inside of a closed
 * `<details>` into it, which Chromium leaves out: by Playwright's, a box
 * described by a folded paragraph was described; by Chromium's, by nothing.
 */
async function describedByChromium(page: Page, testId: string): Promise<string> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Accessibility.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: `[data-testid="${testId}"]`,
    });
    const { nodes } = await cdp.send('Accessibility.getPartialAXTree', {
      nodeId,
      fetchRelatives: false,
    });
    const description: unknown = nodes[0]?.description?.value;
    return typeof description === 'string' ? description : '';
  } finally {
    await cdp.detach();
  }
}

/** What the rule of a 1280 by 800 panel keeps in sight: every row of Review, Controls and Execute. */
const IN_SIGHT_AT_800 = [
  'tab-gaps',
  'tab-plan',
  'tab-anonymization',
  'tab-compliance',
  'tab-metadata',
  'tab-automation',
  'tab-controls',
  'review-row-controls-summary',
  'execute-button',
] as const;

/** Those of {@link IN_SIGHT_AT_800} out of sight, none when the rule holds. */
async function outOfSight(page: Page): Promise<string[]> {
  const out: string[] = [];
  for (const testId of IN_SIGHT_AT_800) {
    if (!(await inSight(page, testId))) out.push(testId);
  }
  return out;
}

/**
 * The pixels between the foot of the column — Rehearse, Simulate, Execute —
 * and the Controls row above it: under nothing, Controls lies whole above it.
 */
async function roomOverTheFoot(page: Page): Promise<number> {
  const controls = (await page.getByTestId('review-row-controls').boundingBox())!;
  const foot = (await page.getByTestId('review-run-foot').boundingBox())!;
  return Math.floor(foot.y - (controls.y + controls.height));
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

  test('names on the folded mute the rules its set lifts beside, to the eye and to a screen reader, Controls in sight', async ({
    page,
  }) => {
    // On the trap org's shape the line said only what the mute silences: the
    // two rules it lets the contacts past sat in the closed disclosure, and
    // Chromium described the box by that line alone.
    await openReview(page, { gaps: [REFUSING_GAP], automation: LIFTING_AUTOMATION });
    const line = page.getByTestId('automation-mute-more-summary');
    await expect(line).toHaveText(
      'Also lifts Validation rule: Email_Required and Validation rule: Phone_Format',
    );
    await expect(page.getByTestId('automation-mute-more')).not.toHaveAttribute('open', '');
    expect(await inSight(page, 'automation-mute-more-summary')).toBe(true);
    // The line first, then what the fold holds.
    expect(await describedByChromium(page, 'automation-mute-toggle')).toMatch(
      /^Also lifts Validation rule: Email_Required and Validation rule: Phone_Format Assigns the permission set Data_Load/,
    );
    // Said in two lines, as the line it replaces: the column still holds.
    expect(await inSight(page, 'review-row-controls-summary')).toBe(true);
    expect(await inSight(page, 'execute-button')).toBe(true);

    await line.click();
    await expect(page.getByTestId('automation-mute-also-lifts-Contact').first()).toHaveText(
      'Contact: Validation rule: Email_Required · Skip_Rules, in Data_Load',
    );
  });

  test('keeps Controls in sight once the mute is ticked over a gap that refuses rows undecided', async ({
    page,
  }) => {
    // Ticked, the mute was said in two lines under Execute, beside the gaps
    // left to decide: the foot of the column grew over Controls.
    await openReview(page, { gaps: [REFUSING_GAP] });
    await page.getByTestId('automation-mute-toggle').check();
    await expect(page.getByTestId('forge-mute-execute-hint')).toHaveCount(1);
    await expect(page.getByTestId('forge-gaps-undecided')).toBeVisible();

    expect(await inSight(page, 'automation-mute-toggle')).toBe(true);
    expect(await inSight(page, 'tab-controls')).toBe(true);
    expect(await inSight(page, 'review-row-controls-summary')).toBe(true);
    expect(await inSight(page, 'forge-gaps-decide')).toBe(true);
    expect(await inSight(page, 'execute-button')).toBe(true);
    // The box ticked stands above it: Execute still says, to a screen reader, that it mutes.
    expect(await describedByChromium(page, 'execute-button')).toContain(
      "Execute mutes the target's automation, as ticked above.",
    );
  });

  test('names three rules lifted on the folded mute, Controls in sight ticked or not', async ({
    page,
  }) => {
    await openReview(page, { gaps: [REFUSING_GAP], automation: THREE_LIFTS_AUTOMATION });
    const line = page.getByTestId('automation-mute-more-summary');
    await expect(line).toHaveText(
      'Also lifts Validation rule: Email_Required, Validation rule: Phone_Format and Validation rule: Mailing_Country_Valid',
    );
    for (const ticked of [false, true]) {
      await page.getByTestId('automation-mute-toggle').setChecked(ticked);
      await expect(page.getByTestId('forge-mute-execute-hint')).toHaveCount(ticked ? 1 : 0);
      for (const testId of [
        'automation-mute-more-summary',
        'tab-controls',
        'review-row-controls-summary',
        'execute-button',
      ]) {
        expect(await inSight(page, testId), `${testId}, ticked: ${String(ticked)}`).toBe(true);
      }
      expect(await roomOverTheFoot(page), `ticked: ${String(ticked)}`).toBeGreaterThanOrEqual(0);
    }
  });

  test('keeps Controls whole over the foot however many rules the folded mute names', async ({
    page,
  }) => {
    // Among the boxes, Controls stood one pixel over the foot of the column
    // with three rules on the line: a word more, or a font a pixel taller,
    // put it under. The boxes now scroll above it, and eight rules move it not.
    const eight = {
      ...LIFTING_AUTOMATION,
      validationRuleBypasses: Array.from({ length: 8 }, (_, index) => ({
        objectApiName: 'Contact',
        name: `Contact_Rule_${String(index + 1)}`,
        permissions: ['Skip_Rules'],
      })),
    };
    await openReview(page, { gaps: [REFUSING_GAP], automation: eight });
    await expect(page.getByTestId('automation-mute-more-summary')).toContainText(
      'Validation rule: Contact_Rule_8',
    );
    for (const ticked of [false, true]) {
      await page.getByTestId('automation-mute-toggle').setChecked(ticked);
      expect(await outOfSight(page), `ticked: ${String(ticked)}`).toEqual([]);
      expect(await roomOverTheFoot(page), `ticked: ${String(ticked)}`).toBeGreaterThanOrEqual(0);
      // Ticked, the box is scrolled into the column's view, and Checkpoint
      // first, above it, stays.
      expect(await inSight(page, 'controls-checkpoint-first-toggle')).toBe(true);
    }
  });

  test('keeps every row, Controls and Execute in sight on the eleven gaps of the trap org, the mute ticked or not', async ({
    page,
  }) => {
    // On the reads of the trap org the Gaps row opened on the field it
    // requires, and pushed Metadata and Automation under the fold.
    await openReview(page, { gaps: ELEVEN_GAPS, automation: LIFTING_AUTOMATION });
    await expect(page.getByTestId('tab-gaps')).toHaveAttribute('aria-expanded', 'true');
    for (const ticked of [false, true]) {
      await page.getByTestId('automation-mute-toggle').setChecked(ticked);
      await expect(page.getByTestId('forge-mute-execute-hint')).toHaveCount(ticked ? 1 : 0);
      expect(await outOfSight(page), `ticked: ${String(ticked)}`).toEqual([]);
      // The gap to decide, and its decision, first in the row.
      expect(await inSight(page, 'gap-default-value')).toBe(true);
      expect(await inSight(page, 'controls-checkpoint-first-toggle')).toBe(true);
    }
    // The rest of the row a scroll away inside it, and its end reached so.
    const list = page.getByTestId('review-gaps-scroll');
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    expect(await inSight(page, 'gaps-admin-copy')).toBe(true);
    expect(await outOfSight(page)).toEqual([]);
  });

  test('says on the Gaps row a rule the ticked mute lifts, no row moved, Execute in sight', async ({
    page,
  }) => {
    // The clone's lines said the mute lifts the rule; the Gaps tab said it may
    // refuse the contacts, the field left empty, under the command that
    // assigns the set the mute assigns itself.
    await openReview(page, {
      gaps: [REFUSING_GAP, LIFTED_RULE_GAP],
      automation: LIFTING_AUTOMATION,
    });
    const rule = page.getByTestId(`gap-${LIFTED_RULE_GAP.id}`);
    const rows = ['gaps', 'plan', 'anonymization', 'compliance', 'metadata', 'automation'];
    /** Where each row stands. */
    const layout = async (): Promise<number[]> => {
      const tops: number[] = [];
      for (const testId of rows.map((row) => `tab-${row}`)) {
        tops.push(Math.round((await page.getByTestId(testId).boundingBox())!.y));
      }
      return tops;
    };
    const before = await layout();
    const warnings = page.getByTestId('gaps-severity-warning-more');
    await warnings.locator('summary').click();
    await expect(rule.getByTestId('gap-default')).toHaveText(
      'If nothing is decided: the field is left empty.',
    );
    await expect(rule.getByTestId('gap-lifted')).toHaveCount(0);
    const unticked = (await rule.boundingBox())!.height;
    await warnings.locator('summary').click();
    const admin = page.getByTestId('gaps-admin-text');
    await expect(admin).toContainText('Turn off validation rule Email_Required');

    await page.getByTestId('automation-mute-toggle').check();
    // Lifted, the rule asks nothing of the target's admin: the field it requires still does.
    await expect(admin).not.toContainText('Email_Required');
    await expect(admin).toContainText('Region__c: make it optional');
    // Among the gaps that refuse nothing, folded as the row opens: no row of
    // Review moves, and Execute stays in sight.
    await expect(page.getByTestId('gaps-severity-warning')).toHaveCount(0);
    await expect(page.getByTestId('gaps-severity-info-more')).not.toHaveAttribute('open', '');
    expect(await layout()).toEqual(before);
    expect(await inSight(page, 'execute-button')).toBe(true);

    await page.getByTestId('gaps-severity-info-more').locator('summary').click();
    await expect(rule.getByTestId('gap-lifted')).toHaveText(
      'The mute lifts it (Skip_Rules, in Data_Load).',
    );
    await expect(rule.getByTestId('gap-default')).toHaveCount(0);
    await expect(rule.getByTestId('bypass-assistant')).toHaveCount(0);
    // The Gaps row holds what the window has room for, the rows under it in
    // sight, and scrolls within: the group opened is a scroll of it away.
    expect(await layout()).toEqual(before);
    await rule.getByTestId('gap-lifted').scrollIntoViewIfNeeded();
    expect(await inSight(page, 'gap-lifted')).toBe(true);
    expect(await outOfSight(page)).toEqual([]);
    // Its line stands where the command stood: the gap takes no more room.
    expect((await rule.boundingBox())!.height).toBeLessThanOrEqual(unticked);
  });

  test('pushes no row further down once the mute ticked lifts the rule the Gaps row shows', async ({
    page,
  }) => {
    await openReview(page, { gaps: [LIFTED_RULE_GAP], automation: LIFTING_AUTOMATION });
    await page.getByTestId('tab-gaps').click();
    await expect(page.getByTestId('bypass-assistant')).toBeVisible();
    const rows = ['plan', 'anonymization', 'compliance', 'metadata', 'automation'];
    const tops = async (): Promise<number[]> => {
      const at: number[] = [];
      for (const row of rows) {
        at.push(Math.round((await page.getByTestId(`tab-${row}`).boundingBox())!.y));
      }
      return at;
    };
    const unticked = await tops();

    await page.getByTestId('automation-mute-toggle').check();
    await expect(page.getByTestId('gap-lifted')).toHaveText(
      'The mute lifts it (Skip_Rules, in Data_Load).',
    );
    const ticked = await tops();
    for (const [index, row] of rows.entries()) {
      expect(ticked[index], row).toBeLessThanOrEqual(unticked[index]);
    }
    expect(await inSight(page, 'gap-lifted')).toBe(true);
    expect(await inSight(page, 'review-row-controls-summary')).toBe(true);
    expect(await inSight(page, 'execute-button')).toBe(true);
  });

  test('describes each box of the column by what ticking it does, its fold closed or open', async ({
    page,
  }) => {
    // Chromium leaves the inside of a closed disclosure out of a description,
    // whether the box points at it or at what holds it: folded, the mute was
    // described by its line alone, Checkpoint first by what it holds, and the
    // box of the files by nothing.
    await openReview(page, { gaps: [REFUSING_GAP], automation: LIFTING_AUTOMATION });
    await page.getByTestId('automation-mute').waitFor();
    /** What each box is described by, as Chromium says it. */
    const described = async (): Promise<Record<string, string>> => ({
      mute: await describedByChromium(page, 'automation-mute-toggle'),
      checkpoint: await describedByChromium(page, 'controls-checkpoint-first-toggle'),
      files: await describedByChromium(page, 'forge-files-toggle'),
    });
    const closed = await described();
    expect(closed.mute).toMatch(
      /^Also lifts Validation rule: Email_Required and Validation rule: Phone_Format/,
    );
    for (const said of [
      'Assigns the permission set Data_Load to the user the run writes as',
      'Silenced for the run:',
      'Flow: Contact welcome · bypass Load_Data',
      'Validation rule: Email_Required · Skip_Rules, in Data_Load',
      'Nothing is deactivated and no other user is touched.',
    ]) {
      expect(closed.mute, said).toContain(said);
    }
    expect(closed.checkpoint).toMatch(/^Before its first write, the run takes a checkpoint of /);
    for (const said of [
      'Never in it: Chatter posts',
      'on this machine, unencrypted',
      'A checkpoint refused, or that could not be taken, refuses the run',
    ]) {
      expect(closed.checkpoint, said).toContain(said);
    }
    expect(closed.files).toMatch(/^Salesforce Files, the latest version of each/);

    // Opened, each says the same, once.
    for (const fold of [
      'automation-mute-more',
      'controls-checkpoint-first-more',
      'forge-files-more',
    ]) {
      await page.getByTestId(fold).locator('summary').first().click();
      await expect(page.getByTestId(fold)).toHaveAttribute('open', '');
    }
    const open = await described();
    expect(open.files).toBe(closed.files);
    expect(open.mute.split('Silenced for the run:')).toHaveLength(2);
    expect(open.checkpoint.split('Never in it:')).toHaveLength(2);
    for (const said of ['Assigns the permission set Data_Load', 'Never in it: Chatter posts']) {
      expect(`${open.mute} ${open.checkpoint}`, said).toContain(said);
    }
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

for (const language of LANGUAGES) {
  test.describe(`Forge Review on a 1280 by 800 panel, in ${language}`, () => {
    // The rule was measured in English alone: a longer word wraps a row's
    // summary, or the folded line of the mute, onto one more line.
    test.use({ viewport: { width: 1280, height: 800 } });

    test('keeps every row, Controls and Execute in sight, the mute naming three lifts, ticked or not', async ({
      page,
    }) => {
      await openReview(page, {
        language,
        gaps: [REFUSING_GAP],
        automation: THREE_LIFTS_AUTOMATION,
      });
      for (const ticked of [false, true]) {
        await page.getByTestId('automation-mute-toggle').setChecked(ticked);
        await expect(page.getByTestId('forge-mute-execute-hint')).toHaveCount(ticked ? 1 : 0);
        expect(await outOfSight(page), `ticked: ${String(ticked)}`).toEqual([]);
        expect(await inSight(page, 'gap-default-value')).toBe(true);
        expect(await inSight(page, 'controls-checkpoint-first-toggle')).toBe(true);
        expect(await roomOverTheFoot(page), `ticked: ${String(ticked)}`).toBeGreaterThanOrEqual(0);
      }
    });

    test('keeps every row, Controls and Execute in sight on the eleven gaps of the trap org', async ({
      page,
    }) => {
      await openReview(page, { language, gaps: ELEVEN_GAPS, automation: LIFTING_AUTOMATION });
      await expect(page.getByTestId('tab-gaps')).toHaveAttribute('aria-expanded', 'true');
      for (const ticked of [false, true]) {
        await page.getByTestId('automation-mute-toggle').setChecked(ticked);
        await expect(page.getByTestId('forge-mute-execute-hint')).toHaveCount(ticked ? 1 : 0);
        expect(await outOfSight(page), `ticked: ${String(ticked)}`).toEqual([]);
        expect(await inSight(page, 'gap-default-value')).toBe(true);
      }
    });
  });
}

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

  test('says under Execute that it mutes, the box ticked out of sight', async ({ page }) => {
    // The column under the rows, the box is a panel's height from Execute.
    await openReview(page, { gaps: [REFUSING_GAP] });
    await page.getByTestId('automation-mute-toggle').check();
    await scrollPanelTo(page, 0);

    expect(await inSight(page, 'automation-mute-toggle')).toBe(false);
    await expect(page.getByTestId('forge-mute-execute-hint')).toHaveText(
      "Execute mutes the target's automation, as ticked above.",
    );
    expect(await inSight(page, 'forge-mute-execute-hint')).toBe(true);
    const hint = await page.getByTestId('forge-mute-execute-hint').boundingBox();
    expect(hint!.height).toBeGreaterThan(10);
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
