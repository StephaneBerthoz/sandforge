import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MockBridge, checkAccessibility, formatViolations } from './helpers';
import { MOCK_ORGS, QA_SANDBOX } from './fixtures';
import { VSCODE_DEFAULT_STYLES } from './fixtures/vscode-default-styles';
import { hostColours, vscodeTheme } from '../src/styles/testing/vscodeThemes';

/**
 * What a user knows of taking a Sync run back, on the History tab: a run a
 * closed window stopped, listed with what it created and its removal; the
 * confirmation that names the org and what goes; and, where Production Guard
 * allows no delete, why nothing is offered. Scanned with axe under VS Code's
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

/** A run a closed window stopped: a file and two accounts created in the QA sandbox. */
const STOPPED = {
  runId: 'run-stopped',
  configId: 'cfg-1',
  configName: 'Nightly accounts',
  sourceOrgId: 'org-src-1',
  targetOrgId: QA_SANDBOX.id,
  startedAt: '2026-10-14T08:00:00.000Z',
  created: 3,
  left: [
    { objectApiName: 'ContentDocument', count: 1 },
    { objectApiName: 'Account', count: 2 },
  ],
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

/** Open the Sync panel on its History tab, the orgs seeded, nothing in the history. */
async function openHistory(page: Page, theme: Theme): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await paintHostTheme(page, theme);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'sync';
  });
  await page.goto('/');
  await bridge.seedOrgs(MOCK_ORGS);
  await expect(page.getByTestId('sync-page')).toBeVisible();
  await page.getByTestId('tab-history').click();
  await answerAll(bridge, 'sync:history:list', 'sync:history:list:response', { entries: [] });
  return bridge;
}

for (const theme of THEMES) {
  test.describe(`taking a Sync run back (${theme})`, () => {
    test('lists a run a closed window stopped with what it created, confirms its removal, and passes axe', async ({
      page,
    }) => {
      const bridge = await openHistory(page, theme);
      await answerAll(bridge, 'sync:removal:list', 'sync:removal:list:response', {
        runs: [STOPPED],
      });
      await answerAll(bridge, 'sync:removal:info', 'sync:removal:info:response', {
        info: STOPPED,
      });

      const card = page.getByTestId('sync-unfinished-removal-run-stopped');
      await expect(card).toContainText('3 records and files created in');
      const listed = await checkAccessibility(page);
      expect(listed.violations.length, formatViolations(listed.violations)).toBe(0);

      await card.getByTestId('sync-removal-remove').click();
      await expect(page.getByTestId('forge-removal-plan')).toContainText('ContentDocument: 1 file');
      const confirming = await checkAccessibility(page);
      expect(confirming.violations.length, formatViolations(confirming.violations)).toBe(0);

      await page.getByTestId('danger-input').fill(QA_SANDBOX.alias);
      await page.getByTestId('danger-confirm-btn').click();
      const removal = await bridge.waitForMessage('sync:remove', { timeout: 10_000 });
      expect(removal.payload).toEqual({ runId: 'run-stopped' });
    });

    test('offers nothing where Production Guard allows no delete, says why, and passes axe', async ({
      page,
    }) => {
      const bridge = await openHistory(page, theme);
      await answerAll(bridge, 'sync:removal:list', 'sync:removal:list:response', {
        runs: [STOPPED],
      });
      await answerAll(bridge, 'sync:removal:info', 'sync:removal:info:response', {
        info: {
          ...STOPPED,
          refusal: {
            code: 'GUARD_BLOCKED',
            message: `delete is not allowed on production org ${QA_SANDBOX.id}`,
          },
        },
      });

      const card = page.getByTestId('sync-unfinished-removal-run-stopped');
      await expect(card.getByTestId('sync-removal-refused')).toContainText(
        'Production Guard allows no delete',
      );
      await expect(card.getByTestId('sync-removal-remove')).toHaveCount(0);
      const refused = await checkAccessibility(page);
      expect(refused.violations.length, formatViolations(refused.violations)).toBe(0);
    });
  });
}
