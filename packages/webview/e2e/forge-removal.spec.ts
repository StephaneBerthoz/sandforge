import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MockBridge, checkAccessibility, formatViolations } from './helpers';
import { QA_SANDBOX } from './fixtures';
import { VSCODE_DEFAULT_STYLES } from './fixtures/vscode-default-styles';
import { sendExtensionMessage } from './mocks/vscode-api';
import { hostColours, vscodeTheme } from '../src/styles/testing/vscodeThemes';

/**
 * What a user knows of taking a run back: the runs past the history's twenty
 * whose records are still in the org, listed under the older runs with the
 * same removal, and, before a run, what may refuse a removal of its records
 * on Review's Automation tab. Scanned with axe under VS Code's default themes
 * and the two they replaced, painted as the host paints a webview.
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

/** An account, as a Forge discovery answers with it. */
const GRAPH = {
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

/** The plan kept of a run the history dropped: a contact and its account, one left by a removal. */
const OLDER_RUN = {
  forgeId: 'forge-older',
  targetOrgId: QA_SANDBOX.id,
  timestamp: '2026-08-01T09:00:00.000Z',
  duration: 12_000,
  status: 'partial',
  cancelled: true,
  objects: [
    { objectApiName: 'Contact', ids: ['003000000000002AAA', '003000000000001AAA'] },
    { objectApiName: 'Account', ids: ['001000000000001AAA'] },
  ],
  linked: 1,
  undo: {
    removedAt: '2026-09-23T10:00:00.000Z',
    deleted: 2,
    alreadyGone: 0,
    kept: 0,
    refused: 0,
    notVisible: 1,
  },
  removalLeft: ['003000000000002AAA'],
};

/** What the target runs on the run's objects: a flow before a delete, a package trigger, orders. */
const AUTOMATION = {
  objectsRead: ['Account', 'Order'],
  objects: [
    {
      objectApiName: 'Account',
      flows: [
        {
          apiName: 'Account_Guard',
          label: 'Account guard',
          timing: 'beforeDelete',
          startsOn: 'delete',
          condition: 'read',
          permissions: [],
        },
      ],
      triggers: [{ name: 'pkg.AccountAudit', events: ['afterDelete'] }],
    },
  ],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 3,
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

/** Open the Forge page with the orgs seeded. */
async function openForge(page: Page, theme: Theme): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await paintHostTheme(page, theme);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'forge';
  });
  await page.goto('/');
  await bridge.seedOrgs();
  await page.waitForSelector('[data-testid="forge-page"]', { timeout: 10_000 });
  return bridge;
}

for (const theme of THEMES) {
  test.describe(`taking a Forge run back (${theme})`, () => {
    test('lists an older run with what is left to remove, confirms its removal, and passes axe', async ({
      page,
    }) => {
      const bridge = await openForge(page, theme);
      await bridge.waitForMessage('forge:history:list', { timeout: 10_000 });
      await answerAll(page, 'forge:history:list', 'forge:history:list:response', {
        history: [],
        olderRuns: [OLDER_RUN],
      });

      const older = page.getByTestId('forge-history-older-forge-older');
      await expect(older).toContainText('1 record to remove from');
      await expect(page.getByTestId('forge-removal-mark')).toContainText(
        '1 not visible to this user',
      );
      const listed = await checkAccessibility(page);
      expect(listed.violations.length, formatViolations(listed.violations)).toBe(0);

      await page.getByTestId('forge-history-remove-forge-older').click();
      await expect(page.getByTestId('forge-removal-plan')).toContainText('Contact: 1 record');
      const confirming = await checkAccessibility(page);
      expect(confirming.violations.length, formatViolations(confirming.violations)).toBe(0);
    });

    test("says on Review's Automation tab what may refuse a removal of the run, and passes axe", async ({
      page,
    }) => {
      await openForge(page, theme);
      await page.getByTestId('forge-tab-soql').click();
      await page.getByTestId('forge-input-soql').fill('SELECT Id FROM Account');
      await page.getByTestId('forge-target-org').click();
      await page.getByTestId(`forge-target-org-option-${QA_SANDBOX.id}`).click();
      await page.getByTestId('forge-discover-btn').click();
      await page.waitForSelector('[data-testid="forge-discovery-loading"]', { timeout: 10_000 });
      await answerAll(page, 'forge:discover', 'forge:discover:response', { graph: GRAPH });
      await page.getByTestId('forge-execute-btn').click();
      await page.waitForSelector('[data-testid="forge-review"]', { timeout: 10_000 });
      await sendExtensionMessage(page, {
        type: 'forge:automation:response',
        id: 'automation-1',
        payload: { automation: AUTOMATION },
      });
      await page.getByTestId('tab-automation').click();

      const said = page.getByTestId('automation-removal');
      await expect(said).toContainText('Account guard');
      await expect(said).toContainText('installed by a managed package');
      await expect(said).toContainText('Order: once activated');
      const results = await checkAccessibility(page);
      expect(results.violations.length, formatViolations(results.violations)).toBe(0);
    });
  });
}
