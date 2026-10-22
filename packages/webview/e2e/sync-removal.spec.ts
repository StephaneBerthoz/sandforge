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

    test('lists a run that only wrote over records, confirms what goes back, says what went back, and passes axe', async ({
      page,
    }) => {
      const OVER = {
        ...STOPPED,
        runId: 'run-over',
        created: 0,
        left: [],
        overwritten: 3,
        putBack: [{ objectApiName: 'Account', count: 3 }],
      };
      const bridge = await openHistory(page, theme);
      await answerAll(bridge, 'sync:removal:list', 'sync:removal:list:response', {
        runs: [OVER],
      });
      await answerAll(bridge, 'sync:removal:info', 'sync:removal:info:response', {
        info: OVER,
      });

      const card = page.getByTestId('sync-unfinished-removal-run-over');
      await expect(card.getByTestId('sync-removal-overwritten')).toContainText(
        `3 records of ${QA_SANDBOX.alias} written over`,
      );
      const listed = await checkAccessibility(page);
      expect(listed.violations.length, formatViolations(listed.violations)).toBe(0);

      await card.getByTestId('sync-removal-remove').click();
      await expect(page.getByTestId('sync-removal-put-back-Account')).toContainText(
        'Account: 3 records to be given back their values from before the run',
      );
      const confirming = await checkAccessibility(page);
      expect(confirming.violations.length, formatViolations(confirming.violations)).toBe(0);

      await page.getByTestId('danger-input').fill(QA_SANDBOX.alias);
      await page.getByTestId('danger-confirm-btn').click();
      const removal = await bridge.waitForMessage('sync:remove', { timeout: 10_000 });
      expect(removal.payload).toEqual({ runId: 'run-over' });
      for (const request of await bridge.getMessages('sync:remove')) {
        await bridge.respond(
          'sync:remove:response',
          {
            result: {
              runId: 'run-over',
              status: 'partial',
              includeChanged: false,
              finishedAt: '2026-10-14T09:00:00.000Z',
              objects: [],
              restored: [
                {
                  objectApiName: 'Account',
                  planned: 3,
                  restored: 2,
                  keptChanged: 1,
                  alreadyGone: 0,
                  refused: 0,
                  notKept: 0,
                  reasons: [],
                },
              ],
            },
            operationId: String(request.id),
          },
          String(request.id),
        );
      }
      await expect(card.getByTestId('sync-removal-restored-Account')).toContainText(
        'changed since the run, left as they are: 1',
      );
      const restored = await checkAccessibility(page);
      expect(restored.violations.length, formatViolations(restored.violations)).toBe(0);
    });

    test('lists what the target runs as a run that deleted is taken back, the trigger after an undelete among it, and passes axe', async ({
      page,
    }) => {
      const DELETED = {
        ...STOPPED,
        runId: 'run-deleted',
        created: 2,
        left: [{ objectApiName: 'Account', count: 2 }],
        deleted: 1,
        bringBack: [{ objectApiName: 'Case', count: 1 }],
      };
      const bridge = await openHistory(page, theme);
      await answerAll(bridge, 'sync:removal:list', 'sync:removal:list:response', {
        runs: [DELETED],
      });
      await answerAll(bridge, 'sync:removal:info', 'sync:removal:info:response', {
        info: DELETED,
      });

      const card = page.getByTestId('sync-unfinished-removal-run-deleted');
      await card.getByTestId('sync-removal-remove').click();
      await answerAll(bridge, 'sync:remove:automation', 'sync:remove:automation:response', {
        runId: 'run-deleted',
        automation: {
          objectsRead: ['Case', 'Account'],
          objects: [
            {
              objectApiName: 'Case',
              flows: [],
              triggers: [{ name: 'CaseRestore', events: ['afterUndelete'] }],
            },
            {
              objectApiName: 'Account',
              flows: [],
              triggers: [{ name: 'AccountGuard', events: ['beforeDelete'] }],
            },
          ],
          unread: [],
          conditionsNotRead: 0,
          conditionsBound: 25,
          requests: 6,
        },
        steps: { bringBack: ['Case'], giveBack: [], setToDraft: [], delete: ['Account'] },
      });
      await expect(page.getByTestId('sync-removal-automation-bringBack-Case')).toContainText(
        'CaseRestore · after undelete, as the removal brings it back from the recycle bin',
      );
      await expect(page.getByTestId('sync-removal-automation-delete-Account')).toContainText(
        'AccountGuard · before delete',
      );
      const confirming = await checkAccessibility(page);
      expect(confirming.violations.length, formatViolations(confirming.violations)).toBe(0);
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
