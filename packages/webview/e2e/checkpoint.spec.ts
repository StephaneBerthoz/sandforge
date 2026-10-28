import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { CheckpointListEntry, OrgCheckpoint } from '@sandforge/shared';
import { MockBridge, checkAccessibility, formatViolations } from './helpers';
import { themeContrastShortfalls } from './helpers/theme-contrast';
import { MOCK_ORGS, type MockOrg } from './fixtures';
import {
  CHECKPOINT_ORG,
  daysFromNow,
  deletedObject,
  everyListLine,
  listEntry,
  nothingToRewind,
  nothingToWrite,
  partialOfEveryReason,
  plainPreview,
  previewOfEverything,
  previewWithFiles,
  readyCheckpoint,
  restoredObject,
  rewindResult,
  scopeAnswer,
  undoResult,
  USERS,
} from './fixtures/checkpoints';
import { VSCODE_DEFAULT_STYLES } from './fixtures/vscode-default-styles';
import { hostColours, vscodeTheme } from '../src/styles/testing/vscodeThemes';

/**
 * What a user reads of Checkpoint & Rewind, drawn in Chromium the way the host
 * draws a webview: an org with no checkpoint and a production org; a take,
 * what it costs before it runs, refused, under way with Stop, stopped and
 * kept; the list and every line it says beneath a checkpoint; the preview of
 * a rewind, every part of it, and an org with nothing to rewind; the rewind
 * confirmed by typing the org's name, its phases with Stop, and every way it
 * ends; Undo, confirmed, under way and ended; the fields a checkpoint stops
 * comparing; the checkpoints a disconnection offers to delete; and the Home
 * tile.
 *
 * Every state is scanned with axe under VS Code's default themes, Light 2026
 * and Dark 2026, and the two they replaced, with the stylesheet VS Code
 * prepends to every webview: contrast converges only on the page as it is
 * painted. Each scan is also held to the theme's own contrast for what axe
 * does not measure (placeholders, symbols, text it leaves incomplete), and a
 * scan of a state just opened shows that axe measured text inside it. A
 * dialog gives the keyboard back to the button that opened it.
 */
const THEMES = ['Light 2026', 'Dark 2026', 'Light Modern', 'Dark Modern'] as const;
type Theme = (typeof THEMES)[number];

/** The org the checkpoints are of, as the page names it. */
const ORG = CHECKPOINT_ORG.alias;

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

/**
 * The extension's side of the bridge, as a spec plays it: each request the
 * page sends is answered once, on its response channel or the domain's error
 * channel, correlated to it. A development build mounts the panel twice, so
 * a query can be asked twice; both are answered.
 */
class Extension {
  private readonly answered = new Set<string>();

  constructor(readonly bridge: MockBridge) {}

  /** The requests of `type` nothing answered yet, oldest first. */
  private async pending(type: string): Promise<Record<string, unknown>[]> {
    return (await this.bridge.getMessages(type)).filter(
      (message) => !this.answered.has(String(message.id)),
    );
  }

  /** The latest request of `type` nothing answered yet, once the page sent one. */
  async asked(type: string): Promise<Record<string, unknown>> {
    await expect
      .poll(async () => (await this.pending(type)).length, {
        message: `the page sent no ${type} left to answer`,
        timeout: 10_000,
      })
      .toBeGreaterThan(0);
    const requests = await this.pending(type);
    return requests[requests.length - 1];
  }

  /** Answer every request of `type` not answered yet, once there is one: the latest is returned. */
  async answer(
    type: string,
    payload: object,
    responseType = `${type}:response`,
  ): Promise<Record<string, unknown>> {
    const latest = await this.asked(type);
    for (const request of await this.pending(type)) {
      this.answered.add(String(request.id));
      await this.bridge.respond(
        responseType,
        payload as Record<string, unknown>,
        String(request.id),
      );
    }
    return latest;
  }

  /** Refuse every request of `type` not answered yet, on the checkpoint domain's error channel. */
  async refuse(type: string, code: string, message: string): Promise<Record<string, unknown>> {
    return this.answer(type, { message, code, retryable: false }, 'checkpoint:error');
  }

  /** Answer the list reads the page has asked since the last answer, if any: a list read again. */
  async relist(checkpoints: CheckpointListEntry[]): Promise<void> {
    for (const request of await this.pending('checkpoint:list')) {
      this.answered.add(String(request.id));
      await this.bridge.respond('checkpoint:list:response', { checkpoints }, String(request.id));
    }
  }

  /** What a take, a rewind or an undo under way reports, under the id of the request that started it. */
  async progress(
    operationId: string,
    processedRecords: number,
    totalRecords: number,
    currentStep: string,
  ): Promise<void> {
    await this.bridge.stream([
      {
        type: 'operation:progress',
        payload: {
          operationId,
          percentage: Math.round((processedRecords / totalRecords) * 100),
          processedRecords,
          totalRecords,
          currentStep,
        },
      },
    ]);
  }

  /** Every request of `type` the page sent, answered or not. */
  async sent(type: string): Promise<Record<string, unknown>[]> {
    return this.bridge.getMessages(type);
  }
}

/** Open a module of the panel under a host theme, the orgs connected. */
async function openPanel(
  page: Page,
  theme: Theme,
  module: string,
  orgs: readonly MockOrg[] = MOCK_ORGS,
): Promise<Extension> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await paintHostTheme(page, theme);
  await page.addInitScript((id: string) => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = id;
  }, module);
  await page.goto('/');
  await bridge.seedOrgs(orgs);
  return new Extension(bridge);
}

/** Open the Checkpoints page on the dev sandbox, its checkpoints listed. */
async function openCheckpoints(
  page: Page,
  theme: Theme,
  checkpoints: CheckpointListEntry[],
): Promise<Extension> {
  const host = await openPanel(page, theme, 'checkpoint');
  await expect(page.getByTestId('checkpoint-page')).toBeVisible();
  const listed = await host.answer('checkpoint:list', { checkpoints });
  expect(listed.payload).toEqual({ orgId: CHECKPOINT_ORG.id });
  return host;
}

/**
 * How many texts inside `container` axe measured the contrast of: a clean
 * scan says nothing of a surface axe did not look at, which lands in
 * `incomplete`.
 */
async function contrastMeasuredIn(
  page: Page,
  results: Awaited<ReturnType<typeof checkAccessibility>>,
  container: string,
): Promise<number> {
  const selectors = results.passes
    .filter((rule) => rule.id === 'color-contrast')
    .flatMap((rule) => rule.nodes)
    .map((node) => node.target[0])
    .map((target) => (typeof target === 'string' ? target : target[target.length - 1]));
  return page.evaluate(
    ({ selectors: all, container: within }) =>
      all.filter((selector) => document.querySelector(selector)?.closest(within) != null).length,
    { selectors, container },
  );
}

/**
 * The page as it is painted now passes axe, and falls short of the theme's
 * own contrast nowhere; with `opened`, axe measured text inside it.
 */
async function expectReadable(page: Page, theme: Theme, opened?: string): Promise<void> {
  const results = await checkAccessibility(page);
  expect(results.violations.length, formatViolations(results.violations)).toBe(0);
  if (opened !== undefined) {
    expect(
      await contrastMeasuredIn(page, results, opened),
      `axe measured no text inside ${opened}`,
    ).toBeGreaterThan(0);
  }
  const shortfalls = await themeContrastShortfalls(page, vscodeTheme(theme));
  expect(shortfalls, shortfalls.join('\n')).toEqual([]);
}

/** Type `text` in the typed confirmation, and press its Confirm. */
async function confirmTyped(page: Page, text: string): Promise<void> {
  await page.getByTestId('danger-input').fill(text);
  await expect(page.getByTestId('danger-confirm-btn')).toBeEnabled();
  await page.getByTestId('danger-confirm-btn').click();
}

/**
 * Open the preview of `checkpoint` from its row, answer it with a plain
 * rewind of Accounts and Contacts, and confirm the rewind: the request it
 * sent is returned.
 */
async function rewindFromPreview(
  page: Page,
  host: Extension,
  checkpoint: OrgCheckpoint,
  previewId: string,
): Promise<Record<string, unknown>> {
  await host.answer('checkpoint:preview', plainPreview(checkpoint.checkpointId, previewId));
  await page.getByTestId('checkpoint-preview-rewind').click();
  await confirmTyped(page, ORG);
  const rewind = await host.asked('checkpoint:rewind');
  expect(rewind.payload).toEqual({
    checkpointId: checkpoint.checkpointId,
    previewId,
    acceptAutomation: false,
    acceptNoUndo: false,
    acceptRecreate: false,
    acceptOutside: false,
  });
  return rewind;
}

for (const theme of THEMES) {
  test.describe(`Checkpoint & Rewind (${theme})`, () => {
    test.describe.configure({ timeout: 120_000 });

    test('says an org has no checkpoint yet, then takes one: what it keeps and costs, its run with Stop, a stopped take, and one kept that moved while it was taken', async ({
      page,
    }) => {
      const host = await openCheckpoints(page, theme, []);
      await expect(
        page.getByRole('heading', { name: `No checkpoint of ${ORG} yet` }),
      ).toBeVisible();
      await expectReadable(page, theme, '[data-testid="checkpoint-page"]');

      await page.getByRole('button', { name: 'Take a checkpoint' }).click();
      await expect(
        page.getByRole('heading', { name: `Take a checkpoint of ${ORG}` }),
      ).toBeFocused();
      await expect(page.getByTestId('checkpoint-scope-reading')).toHaveText(
        `Reading what ${ORG} holds…`,
      );
      const scope = await host.answer('checkpoint:scope', scopeAnswer());
      expect(scope.payload).toEqual({ orgId: CHECKPOINT_ORG.id, mode: 'everything' });
      await expect(page.getByTestId('checkpoint-scope-summary')).toHaveText(
        '5 objects · about 2,424 records',
      );
      await expect(page.getByTestId('checkpoint-cost')).toContainText(
        'about 250 API requests of the 14,997 left today',
      );
      await expect(page.getByTestId('checkpoint-with-parent')).toHaveText(
        'Deleted records of OpportunityLineItem come back only with their parent record.',
      );
      await expect(page.getByTestId('checkpoint-encrypted')).toContainText(
        `Contact.SSN__c is encrypted and ${CHECKPOINT_ORG.username} cannot view encrypted data`,
      );
      await expect(page.getByTestId('checkpoint-hidden')).toContainText(
        `2 fields are hidden from ${CHECKPOINT_ORG.username} by field-level security`,
      );
      await page.getByTestId('checkpoint-see-objects').locator('summary').click();
      await page.getByTestId('checkpoint-left-out').locator('summary').click();
      await expect(page.getByTestId('checkpoint-scope-facts')).toContainText(
        '1 belongs to the vlocity_cmt package',
      );
      await expect(page.getByTestId('checkpoint-left-out')).toContainText(
        'FeedItem — Chatter posts are left out.',
      );
      await expectReadable(page, theme, '[data-testid="checkpoint-before-it-runs"]');

      // A baseline is kept until it is deleted, and its cost says so.
      await page.getByTestId('checkpoint-chip-clean-baseline').click();
      await expect(page.getByTestId('checkpoint-take-name')).toHaveValue('Clean baseline');
      await expect(page.getByTestId('checkpoint-take-keep')).toBeChecked();
      await expect(page.getByTestId('checkpoint-cost')).toContainText('kept until you delete it');

      await page.getByTestId('checkpoint-scope-picked').check();
      await expect(page.getByTestId('checkpoint-picked')).toHaveText(
        'Pick the objects the checkpoint keeps.',
      );
      await page.getByTestId('checkpoint-pick-Account').check();
      const picked = await host.answer(
        'checkpoint:scope',
        scopeAnswer({
          mode: 'picked',
          objects: [scopeAnswer().objects[0]],
          estimate: {
            records: 400,
            apiRequests: 12,
            apiRequestsLeft: 14_997,
            seconds: 8,
            bytes: 400_000,
          },
        }),
      );
      expect(picked.payload).toEqual({
        orgId: CHECKPOINT_ORG.id,
        mode: 'picked',
        objects: ['Account'],
      });
      await expect(page.getByTestId('checkpoint-picked')).toHaveText('1 object picked');
      await expect(page.getByTestId('checkpoint-cost')).toContainText(
        'about 12 API requests of the 14,997 left today',
      );
      await expectReadable(page, theme, '[data-testid="checkpoint-object-list"]');

      await page.getByTestId('checkpoint-take-start').click();
      const take = await host.asked('checkpoint:take');
      expect(take.payload).toEqual({
        orgId: CHECKPOINT_ORG.id,
        name: 'Clean baseline',
        mode: 'picked',
        objects: ['Account'],
        keepDays: 0,
      });
      await expect(page.getByRole('heading', { name: 'Taking “Clean baseline”' })).toBeFocused();
      await host.progress(String(take.id), 120, 400, 'Reading Account (1 of 1)');
      await expect(page.getByTestId('checkpoint-take-step')).toHaveText(
        'Reading Account (1 of 1) — 120 / 400',
      );
      await expectReadable(page, theme, '[data-testid="checkpoint-take-run"]');

      await page.getByTestId('checkpoint-take-stop').click();
      const abort = await host.answer(
        'execution:abort',
        { success: true, operationId: take.id },
        'execution:abort:response',
      );
      expect(abort.payload).toEqual({ operationId: take.id });
      await expect(page.getByText('Stopping: a stopped take is not kept.')).toBeVisible();
      await expect(page.getByTestId('checkpoint-take-stop')).toBeDisabled();
      await expectReadable(page, theme);

      await host.refuse('checkpoint:take', 'CANCELLED', 'The take was stopped.');
      await expect(page.getByTestId('checkpoint-take-stopped')).toHaveText(
        'Stopped: nothing was kept.',
      );
      await expectReadable(page, theme, '[data-testid="checkpoint-take"]');

      await page.getByTestId('checkpoint-take-start').click();
      const again = await host.asked('checkpoint:take');
      const taken = readyCheckpoint({
        checkpointId: 'ck-clean-baseline',
        name: 'Clean baseline',
        scope: { mode: 'picked', leftOut: [] },
        movedWhileTaken: { changed: 2, deleted: 1, created: 0 },
        expiresAt: null,
      });
      await host.answer('checkpoint:take', { checkpoint: taken, operationId: again.id });
      await expect(page.getByTestId('checkpoint-taken')).toContainText(
        '“Clean baseline” taken — 2,454 records in 4 objects',
      );
      await expect(page.getByTestId('checkpoint-moved')).toHaveText(
        '3 records changed while it was being taken; a rewind treats them as changed since.',
      );
      await expectReadable(page, theme, '[data-testid="checkpoint-take-result"]');

      await page.getByTestId('checkpoint-take-done').click();
      await host.relist([listEntry(taken)]);
      await expect(page.getByTestId('checkpoint-row-ck-clean-baseline')).toContainText(
        'Kept until I delete it',
      );
    });

    test('refuses a take before it reads a record, says why, and holds its button', async ({
      page,
    }) => {
      const host = await openCheckpoints(page, theme, []);
      await page.getByRole('button', { name: 'Take a checkpoint' }).click();
      await host.answer(
        'checkpoint:scope',
        scopeAnswer({
          refusal: {
            code: 'API_BUDGET',
            message: `This take needs about 250 API requests; ${ORG} has 120 left today.`,
          },
        }),
      );
      await expect(page.getByTestId('checkpoint-refusal')).toHaveText(
        `This take needs about 250 API requests; ${ORG} has 120 left today.`,
      );
      await expect(page.getByTestId('checkpoint-take-start')).toBeDisabled();
      await expectReadable(page, theme, '[data-testid="checkpoint-before-it-runs"]');
      expect(await host.sent('checkpoint:take')).toEqual([]);
    });

    test('says the refusal alone of a take refused before its scope is read', async ({ page }) => {
      const host = await openCheckpoints(page, theme, []);
      await page.getByRole('button', { name: 'Take a checkpoint' }).click();
      await host.answer(
        'checkpoint:scope',
        scopeAnswer({
          objects: [],
          leftOut: [],
          estimate: { records: 0, apiRequests: 0, apiRequestsLeft: 0, seconds: 0, bytes: 0 },
          refusal: {
            code: 'PERMISSIONS',
            message: 'A checkpoint needs a user with View All Data and Modify All Data.',
          },
        }),
      );
      await expect(page.getByTestId('checkpoint-refusal')).toHaveText(
        'A checkpoint needs a user with View All Data and Modify All Data.',
      );
      await expect(page.getByTestId('checkpoint-cost')).toHaveCount(0);
      await expect(page.getByTestId('checkpoint-scope-summary')).toHaveCount(0);
      await expect(page.getByTestId('checkpoint-take-start')).toBeDisabled();
      await expectReadable(page, theme, '[data-testid="checkpoint-before-it-runs"]');
      expect(await host.sent('checkpoint:take')).toEqual([]);
    });

    test('offers nothing on a production org, says why, and reads no checkpoint of it', async ({
      page,
    }) => {
      const production: MockOrg = {
        id: 'org-prod-1',
        alias: 'ProdOrg',
        username: 'admin@prod.example.com',
        instanceUrl: 'https://prod.example.com',
        orgType: 'Production',
        status: 'connected',
        tags: [],
      };
      const host = await openPanel(page, theme, 'checkpoint', [production]);
      await expect(page.getByTestId('checkpoint-production')).toHaveText(
        'Checkpoints are for sandboxes, scratch orgs and Developer Edition orgs: SandForge never takes a checkpoint of, or rewinds, a production org.',
      );
      await expect(page.getByRole('button', { name: 'Take a checkpoint' })).toHaveCount(0);
      await expectReadable(page, theme, '[data-testid="checkpoint-page"]');
      expect(await host.sent('checkpoint:list')).toEqual([]);
    });

    test('lists every line a checkpoint can carry, and each dialog of the list gives the keyboard back to the button that opened it', async ({
      page,
    }) => {
      const host = await openCheckpoints(page, theme, everyListLine());
      await expect(page.getByTestId('checkpoint-expires-ck-expiring')).toContainText('Expires in');
      await expect(page.getByTestId('checkpoint-keep-now-ck-expiring')).toHaveText('Keep');
      await expect(page.getByTestId('checkpoint-bin-reach-ck-rewound')).toContainText(
        'cannot come back with their Id: the recycle bin keeps them 15 days, less if it fills.',
      );
      await expect(page.getByTestId('checkpoint-rewound-ck-rewound')).toContainText(
        'sooner if the recycle bin fills.',
      );
      await expect(page.getByTestId('checkpoint-keep-ck-rewound')).toBeChecked();
      await expect(page.getByTestId('checkpoint-why-ck-refreshed')).toContainText(
        `${ORG} was refreshed on`,
      );
      await expect(page.getByTestId('checkpoint-rewind-ck-refreshed')).toHaveCount(0);
      await expect(page.getByTestId('checkpoint-why-ck-damaged')).toHaveText(
        'Its file cannot be read: this checkpoint can only be deleted.',
      );
      await expectReadable(page, theme, '[data-testid="checkpoint-list"]');

      // Stop comparing fields…: the fields the checkpoint compares, none of its stamps.
      const stopComparing = page.getByTestId('checkpoint-stop-comparing-ck-expiring');
      await stopComparing.click();
      const fields = page.getByTestId('checkpoint-stop-comparing-fields');
      await expect(fields.getByRole('checkbox')).toHaveCount(7);
      await page.getByTestId('checkpoint-stop-comparing-Case.Last_Touched__c').check();
      await expect(page.getByTestId('checkpoint-stop-comparing-count')).toHaveText(
        '1 field not compared',
      );
      await expectReadable(page, theme, 'dialog[open]');
      await page.getByTestId('checkpoint-stop-comparing-cancel').click();
      await expect(fields).toHaveCount(0);
      await expect(stopComparing).toBeFocused();
      expect(await host.sent('checkpoint:ignore-fields')).toEqual([]);

      // Rename: a blank name is refused before anything is sent.
      const rename = page.getByTestId('checkpoint-rename-ck-expiring');
      await rename.click();
      await page.getByTestId('checkpoint-rename-input').fill(' ');
      await expect(
        page.getByText('A name is one line of text, of 120 characters at most.'),
      ).toBeVisible();
      await expect(page.getByTestId('checkpoint-rename-save')).toBeDisabled();
      await expectReadable(page, theme, 'dialog[open]');
      await page.getByTestId('checkpoint-rename-cancel').click();
      await expect(page.getByTestId('checkpoint-rename-input')).toHaveCount(0);
      await expect(rename).toBeFocused();

      // Delete: a plain question, naming the Undo it takes with it.
      const remove = page.getByTestId('checkpoint-delete-ck-rewound');
      await remove.click();
      await expect(page.getByTestId('danger-title')).toHaveText('Delete “Clean baseline”?');
      await expect(page.getByRole('dialog')).toContainText('can no longer be undone');
      await expectReadable(page, theme, '[role="dialog"]');
      await page.getByTestId('danger-dismiss-btn').click();
      await expect(page.getByTestId('danger-title')).toHaveCount(0);
      await expect(remove).toBeFocused();
      expect(await host.sent('checkpoint:delete')).toEqual([]);

      // Undo this rewind: typed, its automation box unticked, Confirm held until the name is typed.
      const undo = page.getByTestId('checkpoint-undo-ck-rewound');
      await undo.click();
      await expect(page.getByTestId('danger-title')).toHaveText(`Undo the last rewind of ${ORG}?`);
      await expect(page.getByTestId('checkpoint-undo-accept-automation')).not.toBeChecked();
      await expect(page.getByTestId('danger-confirm-btn')).toBeDisabled();
      await page.getByTestId('danger-input').fill(ORG.toLowerCase());
      await expect(page.getByTestId('danger-confirm-btn')).toBeDisabled();
      await expectReadable(page, theme, '[role="dialog"]');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('danger-title')).toHaveCount(0);
      await expect(undo).toBeFocused();
      expect(await host.sent('checkpoint:undo')).toEqual([]);
    });

    test('previews a rewind with every part a preview says, holds Rewind until each box is ticked, and rewinds once the org’s name is typed: its phases with Stop, then where a stop left the org', async ({
      page,
    }) => {
      const checkpoint = readyCheckpoint({
        checkpointId: 'ck-picked',
        scope: { mode: 'picked', leftOut: [] },
        ignoredFields: ['Case.Last_Touched__c'],
      });
      const host = await openCheckpoints(page, theme, [listEntry(checkpoint)]);
      await page.getByTestId('checkpoint-rewind-ck-picked').click();
      await expect(
        page.getByRole('heading', { name: `Rewind ${ORG} to “Before UAT”` }),
      ).toBeFocused();
      await expect(page.getByTestId('checkpoint-preview-reading')).toHaveText(
        `Reading what changed in ${ORG} since “Before UAT”: nothing is written.`,
      );
      await expectReadable(page, theme, '[data-testid="checkpoint-preview"]');

      const asked = await host.answer('checkpoint:preview', previewOfEverything('ck-picked'));
      expect(asked.payload).toEqual({ checkpointId: 'ck-picked' });
      await expect(page.getByTestId('checkpoint-preview-number-delete')).toHaveText('14 to delete');
      await expect(page.getByTestId('checkpoint-preview-number-give-back')).toHaveText(
        '18 to give back',
      );
      await expect(page.getByTestId('checkpoint-preview-number-bring-back')).toHaveText(
        '4 to bring back',
      );
      await expect(page.getByTestId('checkpoint-preview-number-recreate')).toHaveText(
        '2 to make again',
      );
      await expect(page.getByTestId('checkpoint-preview-last-changed')).toHaveText(
        `Last changed by: Integration User 16 · Alice Martin 11 · ${USERS.unnamed} 2`,
      );
      await expect(page.getByTestId('checkpoint-preview-active')).toContainText('Alice Martin');
      await expect(page.getByTestId('checkpoint-preview-shared-user')).toContainText(
        CHECKPOINT_ORG.username,
      );
      await expect(page.getByTestId('checkpoint-preview-row-Contact')).toHaveText(
        ['Contact', '8', '2', '1', '2', '3'].join(''),
      );
      await expect(page.getByTestId('checkpoint-preview-recreate-Contact')).toHaveText(
        '2 Contact records deleted since that the recycle bin no longer gives back.',
      );
      await expect(page.getByTestId('checkpoint-preview-details')).toContainText(
        'Contact: 1 record deleted while the checkpoint was taken comes back with the values it had then.',
      );
      await expect(page.getByTestId('checkpoint-preview-details')).toContainText(
        'Account: 1 record the checkpoint does not hold, deleted since, took records of the checkpoint along: Salesforce gives those back with it only, so it comes back for a moment, then goes back to the recycle bin with what came back with it.',
      );
      await expect(page.getByTestId('checkpoint-preview-unread')).toContainText('Asset');
      for (const line of [
        'goneForGood',
        'deletedWithCreatedParent',
        'deletedWithParentOutside',
        'convertedLead',
        'activatedContract',
        'removed-Case.Region__c',
        'added',
        'changed',
        'computed',
        'left',
        'metadata',
      ]) {
        await expect(page.getByTestId(`checkpoint-preview-cannot-${line}`)).toBeVisible();
      }
      await expect(
        page.getByTestId('checkpoint-preview-undo-cannot-OpportunityLineItem'),
      ).toHaveText(
        '3 OpportunityLineItem records this rewind deletes: Salesforce undeletes them only with their parent record, which stays.',
      );
      await expect(page.getByTestId('checkpoint-preview-outside-Account-Opportunity')).toHaveText(
        '50 Opportunity records created under 3 Account records the rewind deletes',
      );
      await expect(page.getByTestId('checkpoint-preview-outside-otherwise')).toBeVisible();
      await expect(page.getByTestId('checkpoint-preview-not-compared')).toHaveText(
        'Not compared (you chose): Case.Last_Touched__c',
      );
      await expect(page.getByTestId('checkpoint-preview-automation')).toContainText(
        'AccountRestore',
      );
      await expect(page.getByTestId('checkpoint-preview-automation')).toContainText('CaseTouch');
      await expect(page.getByTestId('checkpoint-preview-refusal')).toContainText('CaseTouch');
      const rewind = page.getByTestId('checkpoint-preview-rewind');
      await expect(rewind).toHaveText(`Rewind ${ORG}…`);
      await expect(rewind).toBeDisabled();
      await expectReadable(page, theme, '[data-testid="checkpoint-preview-cannot"]');

      await page.getByTestId('checkpoint-preview-accept-no-undo').check();
      await page.getByTestId('checkpoint-preview-accept-outside').check();
      await expect(rewind).toBeDisabled();
      await page.getByTestId('checkpoint-preview-accept-automation').check();
      await expect(rewind).toBeDisabled();
      await page.getByTestId('checkpoint-preview-accept-recreate').check();
      await expect(rewind).toBeEnabled();
      await expectReadable(page, theme, '[data-testid="checkpoint-preview-recreate"]');
      await expect(page.getByTestId('checkpoint-preview-outside-otherwise')).toHaveCount(0);
      await expectReadable(page, theme, '[data-testid="checkpoint-preview-outside"]');

      // The typed confirmation: held until the org's name is typed as it is, Cancel gives the keyboard back.
      await rewind.click();
      await expect(page.getByTestId('danger-title')).toHaveText(`Rewind ${ORG} to “Before UAT”?`);
      await expect(page.getByRole('dialog')).toContainText(
        'it deletes the 14 records added since, gives 18 records their values from then back, brings back 4 records from the recycle bin, makes 2 records the recycle bin no longer holds again, with new Ids and brings back for a moment 1 record that had taken records of the checkpoint along, then deletes it again, whoever made these changes.',
      );
      await expect(page.getByTestId('danger-confirm-btn')).toBeDisabled();
      await page.getByTestId('danger-input').fill(ORG.slice(0, -1));
      await expect(page.getByTestId('danger-confirm-btn')).toBeDisabled();
      await expectReadable(page, theme, '[role="dialog"]');
      await page.getByTestId('danger-dismiss-btn').click();
      await expect(page.getByTestId('danger-title')).toHaveCount(0);
      await expect(rewind).toBeFocused();
      expect(await host.sent('checkpoint:rewind')).toEqual([]);

      await rewind.click();
      await expect(page.getByTestId('danger-input')).toHaveValue('');
      await confirmTyped(page, ORG);
      const started = await host.asked('checkpoint:rewind');
      expect(started.payload).toEqual({
        checkpointId: 'ck-picked',
        previewId: 'pv-everything',
        acceptAutomation: true,
        acceptNoUndo: true,
        acceptRecreate: true,
        acceptOutside: true,
      });

      await expect(
        page.getByRole('heading', { name: `Rewind of ${ORG} to “Before UAT”` }),
      ).toBeFocused();
      await expect(page.getByTestId('checkpoint-run-phases').getByRole('listitem')).toHaveText([
        'Bring back 4 records deleted since',
        'Make again 2 records the recycle bin no longer holds, with new Ids',
        'Give 18 records their values back',
        'Delete 14 records added since, children first',
        `Check: read ${ORG} again`,
      ]);
      await host.progress(String(started.id), 6, 18, 'Giving back Case (2 of 4)');
      await expect(page.getByTestId('checkpoint-run-step')).toHaveText(
        'Giving back Case (2 of 4) — 6 / 18',
      );
      await expectReadable(page, theme, '[data-testid="checkpoint-run-running"]');

      await page.getByTestId('checkpoint-run-stop').click();
      const abort = await host.answer(
        'execution:abort',
        { success: true, operationId: started.id },
        'execution:abort:response',
      );
      expect(abort.payload).toEqual({ operationId: started.id });
      await expect(page.getByText(`Stopping before its next call to ${ORG}…`)).toBeVisible();
      await expectReadable(page, theme);

      await host.answer('checkpoint:rewind', {
        result: rewindResult('ck-picked', {
          status: 'cancelled',
          carriers: [{ objectApiName: 'Account', count: 1 }],
        }),
        operationId: started.id,
      });
      await expect(page.getByTestId('checkpoint-result-headline')).toHaveText(
        `Stopped part way: ${ORG} is between “Before UAT” and now. Rewind again to finish: it takes up from what still differs. Undo still returns ${ORG} to how it was before the rewind.`,
      );
      await expect(page.getByTestId('checkpoint-result-carriers-stopped')).toHaveText(
        `Stopped before the rewind was through: what of them it had not deleted again yet is still in ${ORG}. Rewind again deletes it, with what came back with it.`,
      );
      await expect(page.getByTestId('checkpoint-result-rewind-again')).toBeVisible();
      await expectReadable(page, theme, '[data-testid="checkpoint-result"]');
    });

    test('says what a take keeps of files and cannot see without Query All Files, previews what a rewind does to the files and their links, and says what it did to them', async ({
      page,
    }) => {
      const checkpoint = readyCheckpoint({
        checkpointId: 'ck-files',
        scope: { mode: 'picked', leftOut: [] },
        files: { documents: 6, links: 9, anchored: 5 },
      });
      const host = await openCheckpoints(page, theme, [listEntry(checkpoint)]);

      // Before it runs: the files it keeps, the objects of files added to
      // those picked, and what its user cannot see of other users' files.
      await page.getByRole('button', { name: 'Take a checkpoint' }).click();
      await host.answer(
        'checkpoint:scope',
        scopeAnswer({ files: { held: true, queryAllFiles: false, addedToPicked: [] } }),
      );
      await expect(page.getByTestId('checkpoint-files-held')).toContainText(
        'it keeps which files are attached to the records it holds',
      );
      await expect(page.getByTestId('checkpoint-files-blind-spot')).toContainText(
        `${CHECKPOINT_ORG.username} doesn't have Query All Files`,
      );
      await expectReadable(page, theme, '[data-testid="checkpoint-before-it-runs"]');
      await page.getByTestId('checkpoint-scope-picked').check();
      await page.getByTestId('checkpoint-pick-Account').check();
      await host.answer(
        'checkpoint:scope',
        scopeAnswer({
          mode: 'picked',
          objects: [scopeAnswer().objects[0]],
          files: {
            held: true,
            queryAllFiles: false,
            addedToPicked: ['ContentDocument', 'Attachment'],
          },
        }),
      );
      await expect(page.getByTestId('checkpoint-files-added')).toHaveText(
        'ContentDocument and Attachment are added to the objects you picked: without them, a rewind would leave the files attached since as they are.',
      );
      await expectReadable(page, theme, '[data-testid="checkpoint-before-it-runs"]');
      await page.getByTestId('checkpoint-take-cancel').click();

      // The preview: the files in the table, their links and what it leaves.
      await page.getByTestId('checkpoint-rewind-ck-files').click();
      await host.answer('checkpoint:preview', previewWithFiles('ck-files'));
      const files = page.getByTestId('checkpoint-preview-files');
      await expect(files.getByRole('heading')).toHaveText('Files and their links');
      await expect(files.getByRole('listitem')).toHaveText([
        '1 link added since between a file and a record that both stay: removed. The file stays, no longer attached to that record.',
        '1 link removed since between a file and a record that both stay: put back, under a new Id — Salesforce keeps no removed link in the recycle bin.',
        "1 link whose sharing changed since gets it back: who sees the file from the record, and with what access. A link to an account keeps its access, which Salesforce doesn't let change: only who sees the file is given back.",
        "Kept: 2 files added since, as no record of this checkpoint links to them — a user's own, a library's.",
        'Left in the recycle bin: 1 file deleted since, as no record of this checkpoint linked to it.',
        `Bringing back 1 file from the recycle bin takes 12 MB of file storage again; ${ORG} has 40 MB left.`,
        'Undo would bring back the files this rewind deletes, taking 3 MB of file storage again.',
        `${CHECKPOINT_ORG.username} doesn't have Query All Files: the files of other users that no record of this checkpoint is attached to aren't seen, nor counted here.`,
      ]);
      await expect(page.getByTestId('checkpoint-preview-row-ContentDocument')).toHaveText(
        ['ContentDocument', '2', '1', '1', '1'].join(''),
      );
      await expect(page.getByTestId('checkpoint-preview-cannot-newFileVersion')).toContainText(
        '1 file got a new version since',
      );
      await expect(
        page.getByTestId('checkpoint-preview-outside-ContentDocument-ContentDocumentLink'),
      ).toHaveText(
        '1 file the rewind deletes is attached outside the checkpoint too — to a library, a group or a record of another object — by 2 links: deleting it removes it from there as well.',
      );
      await expectReadable(page, theme, '[data-testid="checkpoint-preview-files"]');
      await expectReadable(page, theme, '[data-testid="checkpoint-preview-outside"]');

      // The rewind: the links are a step of their own.
      await page.getByTestId('checkpoint-preview-rewind').click();
      await expect(page.getByRole('dialog')).toContainText(
        'puts 3 links between files and records back as they were',
      );
      await confirmTyped(page, ORG);
      const started = await host.asked('checkpoint:rewind');
      await expect(page.getByTestId('checkpoint-run-phase-links')).toHaveText(
        'Put 3 links between files and records back as they were',
      );
      await expectReadable(page, theme, '[data-testid="checkpoint-run-running"]');

      await host.answer('checkpoint:rewind', {
        result: rewindResult('ck-files', {
          status: 'partial',
          deleted: [
            deletedObject('Account', {
              planned: 1,
              deleted: 1,
              filesLeft: { count: 1, names: ['Signed contract.pdf'] },
            }),
          ],
          files: { unlinked: 1, relinked: 1, linksUpdated: 0, linksRefused: 1 },
          residual: [
            {
              objectApiName: 'ContentDocumentLink',
              reason: 'kept',
              count: 1,
              ids: [],
              message:
                "Its sharing type stays as it is: Salesforce doesn't change the sharing type of a file's link to an account.",
            },
          ],
        }),
        operationId: started.id,
      });
      await expect(page.getByTestId('checkpoint-result-files').getByRole('listitem')).toHaveText([
        '1 link added since removed: its file stays',
        '1 link removed since put back, under a new Id',
        `1 link ${ORG} refused to write`,
      ]);
      await expect(page.getByTestId('forge-removal-files-Account')).toHaveText(
        `1 file attached to them stays in ${ORG}: the checkpoint holds it, or it is attached to a record outside the checkpoint too: Signed contract.pdf`,
      );
      await expectReadable(page, theme, '[data-testid="checkpoint-result-files"]');
    });

    test('offers the org’s custom settings folded, none ticked, each with its kind and rows, and asks the scope and the take with those ticked', async ({
      page,
    }) => {
      const host = await openCheckpoints(page, theme, []);
      await page.getByRole('button', { name: 'Take a checkpoint' }).click();
      const offered = [
        {
          objectApiName: 'App_Switches__c',
          label: 'Switches',
          kind: 'hierarchy' as const,
          records: 3,
        },
        { objectApiName: 'Endpoints__c', label: 'Endpoints', kind: 'list' as const, records: 2 },
      ];
      await host.answer('checkpoint:scope', scopeAnswer({ customSettings: offered }));

      const settings = page.getByTestId('checkpoint-custom-settings');
      await expect(settings).not.toHaveAttribute('open', '');
      await settings.getByText('Custom settings (2)').click();
      await expect(page.getByTestId('checkpoint-custom-setting-Endpoints__c')).not.toBeChecked();
      await expect(page.getByTestId('checkpoint-custom-setting-list')).toContainText('Hierarchy');
      await expectReadable(page, theme, '[data-testid="checkpoint-custom-settings"]');

      await page.getByTestId('checkpoint-custom-setting-Endpoints__c').check();
      await expect(page.getByTestId('checkpoint-left-out-always')).toHaveText(
        'Left out: users, permissions, setup, Chatter, history and log objects, the documents of the Documents tab.',
      );
      const scope = await host.answer('checkpoint:scope', scopeAnswer({ customSettings: offered }));
      expect(scope.payload).toEqual({
        orgId: CHECKPOINT_ORG.id,
        mode: 'everything',
        customSettings: ['Endpoints__c'],
      });
      await page.getByTestId('checkpoint-take-start').click();
      const take = await host.asked('checkpoint:take');
      expect(take.payload).toMatchObject({ mode: 'everything', customSettings: ['Endpoints__c'] });
    });

    test('says an org holds its checkpoint’s state, gives the keyboard back to Rewind… on Back, and says a preview with nothing a rewind could write, after one that could not be read', async ({
      page,
    }) => {
      const held = readyCheckpoint({ checkpointId: 'ck-held' });
      const lost = readyCheckpoint({ checkpointId: 'ck-lost', name: 'Before demo' });
      const host = await openCheckpoints(page, theme, [listEntry(held), listEntry(lost)]);

      const rewindHeld = page.getByTestId('checkpoint-rewind-ck-held');
      await rewindHeld.click();
      await host.answer('checkpoint:preview', nothingToRewind('ck-held'));
      await expect(page.getByTestId('checkpoint-preview-nothing')).toHaveText(
        `${ORG} is as it was at “Before UAT” among the objects and fields it holds: nothing to rewind.`,
      );
      await expect(page.getByTestId('checkpoint-preview-rewind')).toHaveCount(0);
      await expect(page.getByTestId('checkpoint-preview-details')).toContainText(
        'Contact: 3 records touched since hold their checkpoint values: nothing to give back.',
      );
      await expectReadable(page, theme, '[data-testid="checkpoint-preview"]');
      await page.getByTestId('checkpoint-preview-back').click();
      await expect(rewindHeld).toBeFocused();

      await page.getByTestId('checkpoint-rewind-ck-lost').click();
      await host.refuse('checkpoint:preview', 'REQUEST_TIMEOUT', `${ORG} did not answer in time.`);
      await expect(page.getByTestId('checkpoint-preview-error')).toContainText(
        `${ORG} did not answer in time.`,
      );
      await expectReadable(page, theme, '[data-testid="checkpoint-preview"]');
      await page.getByTestId('checkpoint-preview-retry').click();
      await host.answer('checkpoint:preview', nothingToWrite('ck-lost'));
      await expect(page.getByTestId('checkpoint-preview-nothing')).toHaveText(
        'Nothing to rewind: what still differs is named below, and a rewind cannot put it back.',
      );
      await expect(page.getByTestId('checkpoint-preview-cannot-goneForGood')).toContainText(
        '4 records deleted since cannot come back: the recycle bin no longer holds them',
      );
      await expectReadable(page, theme, '[data-testid="checkpoint-preview-cannot"]');
    });

    test('says every way a rewind ends: partial by every reason with its three parts and Stop comparing, unstable, ended early, stopped before it answered, and refused', async ({
      page,
    }) => {
      const checkpoint = readyCheckpoint();
      const id = checkpoint.checkpointId;
      const host = await openCheckpoints(page, theme, [listEntry(checkpoint)]);
      await page.getByTestId(`checkpoint-rewind-${id}`).click();

      // Partial, every reason a record still differs named, each part of the run with what it left.
      let started = await rewindFromPreview(page, host, checkpoint, 'pv-1');
      await host.answer('checkpoint:rewind', {
        result: partialOfEveryReason(id),
        operationId: started.id,
      });
      await expect(page.getByTestId('checkpoint-result-headline')).toHaveText(
        `${ORG} is back at “Before UAT”, except 21 records:`,
      );
      await expect(page.getByTestId('checkpoint-result-residual').getByRole('heading')).toHaveText([
        'Kept by your automation',
        'Changed during the rewind by someone else',
        'Changed since the preview',
        'No longer in the recycle bin',
        `Refused by ${ORG}`,
        'Kept on purpose',
        'Gone for good',
      ]);
      await expect(
        page.getByTestId('checkpoint-result-residual-changedDuringRewind-Account'),
      ).toHaveText('Account: 1 record changed by Alice Martin, left as they made it');
      await expect(page.getByTestId('checkpoint-result-residual-kept-Contact')).toHaveText(
        'Contact: 1 record the rewind kept' + 'A Case the checkpoint holds still looks up to it.',
      );
      await expect(page.getByTestId('checkpoint-result-residual-notInBin-Account')).toHaveText(
        'Account: 2 records Salesforce still lists as deleted but will not bring back — emptied from the recycle bin, or kept there for good: rewind again with Make them again, with new Ids ticked to make them again, with new Ids',
      );
      await expect(page.getByTestId('checkpoint-result-undeleted-Account')).toHaveText(
        'Account: 1 of 2 brought back, with their Ids · no longer in the recycle bin, gone for good: 1',
      );
      await expect(page.getByTestId('checkpoint-result-restored-Account')).toHaveText(
        'Account: 3 of 4 given their checkpoint values back · changed by someone else during the rewind, left as they made them: 1',
      );
      await expect(page.getByTestId('forge-removal-result-Contact')).toContainText('4 deleted');
      await expect(page.getByTestId('checkpoint-result-undo-cannot')).toContainText(
        'Undo could not bring back 3 OpportunityLineItem records this rewind deleted',
      );
      await expectReadable(page, theme, '[data-testid="checkpoint-result"]');

      // Stop comparing these fields…: Cancel gives the keyboard back, Save says what is no longer compared.
      const stopComparing = page.getByTestId('checkpoint-result-stop-comparing');
      await stopComparing.click();
      const fields = page.getByTestId('checkpoint-stop-comparing-fields');
      await expect(fields.getByRole('checkbox')).toHaveCount(2);
      await expectReadable(page, theme, 'dialog[open]');
      await page.getByTestId('checkpoint-stop-comparing-cancel').click();
      await expect(fields).toHaveCount(0);
      await expect(stopComparing).toBeFocused();
      await stopComparing.click();
      await page.getByTestId('checkpoint-stop-comparing-Case.Last_Touched__c').check();
      await page.getByTestId('checkpoint-stop-comparing-save').click();
      const ignored = await host.answer('checkpoint:ignore-fields', {
        checkpoint: { ...checkpoint, ignoredFields: ['Case.Last_Touched__c'] },
      });
      expect(ignored.payload).toEqual({ checkpointId: id, fields: ['Case.Last_Touched__c'] });
      await expect(page.getByTestId('checkpoint-result-stopped-comparing')).toHaveText(
        `Not compared from now on: Case.Last_Touched__c. Rewind again to read ${ORG} without them.`,
      );
      await expectReadable(page, theme, '[data-testid="checkpoint-result"]');

      // Unstable: who kept writing, by name.
      await page.getByTestId('checkpoint-result-rewind-again').click();
      await host.relist([listEntry(checkpoint)]);
      started = await rewindFromPreview(page, host, checkpoint, 'pv-2');
      await host.answer('checkpoint:rewind', {
        result: rewindResult(id, {
          status: 'unstable',
          restored: [restoredObject('Account', { planned: 4, restored: 2, keptChanged: 2 })],
          residual: [
            {
              objectApiName: 'Account',
              reason: 'changedDuringRewind',
              by: USERS.alice,
              count: 2,
              ids: [],
            },
          ],
        }),
        operationId: started.id,
      });
      await expect(page.getByTestId('checkpoint-result-headline')).toHaveText(
        `Someone kept writing to ${ORG} during the rewind: Alice Martin changed 2 records, left as they made them. Rewind again once they have stopped.`,
      );
      await expectReadable(page, theme, '[data-testid="checkpoint-result"]');

      // Ended before it was through.
      await page.getByTestId('checkpoint-result-rewind-again').click();
      started = await rewindFromPreview(page, host, checkpoint, 'pv-3');
      await host.answer('checkpoint:rewind', {
        result: rewindResult(id, { status: 'failure' }),
        operationId: started.id,
      });
      await expect(page.getByTestId('checkpoint-result-headline')).toHaveText(
        `The rewind of ${ORG} to “Before UAT” ended before it was through: what it did is listed below. Rewind again to take up from what still differs.`,
      );
      await expectReadable(page, theme, '[data-testid="checkpoint-result"]');

      // Stopped before it answered with a result.
      await page.getByTestId('checkpoint-result-rewind-again').click();
      await rewindFromPreview(page, host, checkpoint, 'pv-4');
      await host.refuse('checkpoint:rewind', 'CANCELLED', 'The rewind was stopped.');
      await expect(page.getByTestId('checkpoint-run-stopped')).toHaveText(
        `Stopped part way: ${ORG} is between “Before UAT” and now. Rewind again to finish: it takes up from what still differs.`,
      );
      await expectReadable(page, theme, '[data-testid="checkpoint-run"]');

      // Refused before it wrote, in the extension's words.
      await page.getByTestId('checkpoint-run-rewind-again').click();
      await rewindFromPreview(page, host, checkpoint, 'pv-5');
      await host.refuse(
        'checkpoint:rewind',
        'RUN_WRITING',
        `A SandForge run is writing to ${ORG}: rewind once it has ended.`,
      );
      await expect(page.getByTestId('checkpoint-run-error')).toContainText(
        `A SandForge run is writing to ${ORG}: rewind once it has ended.`,
      );
      await expectReadable(page, theme, '[data-testid="checkpoint-run"]');
      await page.getByTestId('checkpoint-run-done').click();
      await host.relist([listEntry(checkpoint)]);
      await expect(page.getByTestId(`checkpoint-rewind-${id}`)).toBeFocused();
    });

    test('says a rewind put the org back with Undo, then every way its undo ends: confirmed, under way with Stop, stopped, partial, refused and asked again, done, and ended early', async ({
      page,
    }) => {
      const checkpoint = readyCheckpoint();
      const id = checkpoint.checkpointId;
      const host = await openCheckpoints(page, theme, [listEntry(checkpoint)]);
      await page.getByTestId(`checkpoint-rewind-${id}`).click();
      const started = await rewindFromPreview(page, host, checkpoint, 'pv-1');
      await host.answer('checkpoint:rewind', {
        result: rewindResult(id, {
          undo: {
            until: daysFromNow(15),
            cannot: [{ objectApiName: 'OpportunityLineItem', count: 3 }],
          },
          carriers: [{ objectApiName: 'Account', count: 1 }],
        }),
        operationId: started.id,
      });
      await expect(page.getByTestId('checkpoint-result-headline')).toHaveText(
        `${ORG} is back at “Before UAT”. Read again: nothing differs among the objects and fields it holds.`,
      );
      await expect(page.getByTestId('checkpoint-result-carriers')).toHaveText(
        `Brought back for a moment from the recycle bin of ${ORG}, to bring back the records of the checkpoint they had taken along` +
          'Account: 1 record the checkpoint does not hold' +
          'Deleted again once those records were back, with what came back with them: in the recycle bin, as before the rewind.',
      );
      await expect(page.getByTestId('checkpoint-result-undo')).toContainText(
        'This rewind can be undone until',
      );
      await expect(page.getByTestId('checkpoint-result-rewind-again')).toHaveCount(0);
      await expectReadable(page, theme, '[data-testid="checkpoint-result"]');

      // Undo the rewind just made: what Undo could not bring back is said in its confirmation.
      await page.getByTestId('checkpoint-result-undo-open').click();
      await expect(page.getByTestId('checkpoint-undo-cannot')).toContainText(
        'Undo could not bring back 3 OpportunityLineItem records this rewind deleted',
      );
      await expectReadable(page, theme, '[role="dialog"]');
      await confirmTyped(page, ORG);
      let undo = await host.asked('checkpoint:undo');
      expect(undo.payload).toEqual({
        checkpointId: id,
        rewindId: 'rw-new',
        acceptAutomation: false,
      });
      await expect(
        page.getByRole('heading', { name: `Undo of the last rewind of ${ORG}` }),
      ).toBeFocused();
      await expect(page.getByTestId('checkpoint-run-phases')).toHaveCount(0);
      await host.progress(String(undo.id), 2, 5, 'Bringing back Contact');
      await expect(page.getByTestId('checkpoint-run-stop')).toHaveText('Stop the undo');
      await expectReadable(page, theme, '[data-testid="checkpoint-run-running"]');
      await page.getByTestId('checkpoint-run-stop').click();
      await host.answer(
        'execution:abort',
        { success: true, operationId: undo.id },
        'execution:abort:response',
      );
      await expect(page.getByText(`Stopping before its next call to ${ORG}…`)).toBeVisible();
      await host.answer('checkpoint:undo', {
        result: undoResult(id, { rewindId: 'rw-new', status: 'cancelled' }),
        operationId: undo.id,
      });
      await expect(page.getByTestId('checkpoint-result-headline')).toHaveText(
        'Stopped part way: undo the rewind again from the list of checkpoints to finish; it takes up from where it stopped.',
      );
      await expectReadable(page, theme, '[data-testid="checkpoint-result"]');

      // From the list's line: partial, what changed since the rewind left as it is now.
      const listed = listEntry(
        readyCheckpoint({ lastRewind: { rewindId: 'rw-last', endedAt: daysFromNow(0) } }),
        { undo: { rewindId: 'rw-last', until: daysFromNow(15) } },
      );
      await page.getByTestId('checkpoint-result-done').click();
      await host.relist([listed]);
      const undoFromList = page.getByTestId(`checkpoint-undo-${id}`);
      await undoFromList.click();
      await confirmTyped(page, ORG);
      undo = await host.asked('checkpoint:undo');
      expect(undo.payload).toEqual({
        checkpointId: id,
        rewindId: 'rw-last',
        acceptAutomation: false,
      });
      await host.answer('checkpoint:undo', {
        result: undoResult(id, {
          status: 'partial',
          restored: [restoredObject('Account', { planned: 4, restored: 2, keptChanged: 2 })],
        }),
        operationId: undo.id,
      });
      await expect(page.getByTestId('checkpoint-result-headline')).toHaveText(
        `${ORG} is back as it was before its last rewind, except 2 records changed since the rewind, left as they are now.`,
      );
      await expect(page.getByTestId('checkpoint-result-undeleted')).toContainText(
        `What the rewind deleted, brought back from the recycle bin of ${ORG}`,
      );
      await expect(page.getByTestId('checkpoint-result-restored')).toContainText(
        `What the rewind wrote over, given back its values from before in ${ORG}`,
      );
      await expect(page.getByTestId('checkpoint-result-undo-open')).toHaveCount(0);
      await expectReadable(page, theme, '[data-testid="checkpoint-result"]');

      // Refused for the automation the org runs, asked again with its box, then done.
      await page.getByTestId('checkpoint-result-done').click();
      await host.relist([listed]);
      await undoFromList.click();
      await confirmTyped(page, ORG);
      await host.refuse(
        'checkpoint:undo',
        'AUTOMATION',
        `Undoing brings back 5 Contacts: trigger ContactRestore runs after each undelete. Undo refused.`,
      );
      await expect(page.getByTestId('checkpoint-run-error')).toContainText('Undo refused.');
      await expectReadable(page, theme, '[data-testid="checkpoint-run"]');
      await page.getByTestId('checkpoint-run-undo-again').click();
      await page.getByTestId('checkpoint-undo-accept-automation').check();
      await confirmTyped(page, ORG);
      undo = await host.asked('checkpoint:undo');
      expect(undo.payload).toEqual({
        checkpointId: id,
        rewindId: 'rw-last',
        acceptAutomation: true,
      });
      // The rewind had made one account again, the bin no longer giving it back.
      await host.answer('checkpoint:undo', {
        result: undoResult(id, {
          remade: [{ objectApiName: 'Account', count: 1 }],
          carriedAlone: [{ objectApiName: 'Contact', count: 2 }],
        }),
        operationId: undo.id,
      });
      await expect(page.getByTestId('checkpoint-result-headline')).toHaveText(
        `${ORG} is back as it was before its last rewind.`,
      );
      await expect(page.getByTestId('checkpoint-result-remade')).toHaveText(
        `Deleted again in ${ORG}: 1 record the rewind made again, with what went with it`,
      );
      await expect(page.getByTestId('checkpoint-result-carried-alone-Contact')).toHaveText(
        `Back in the recycle bin of ${ORG} on their own: 2 Contact records that had gone there with a record the rewind brought back for a moment, which stays there. They come back alone, under the parent the checkpoint gave them.`,
      );
      await expectReadable(page, theme, '[data-testid="checkpoint-result"]');

      // Ended before it was through.
      await page.getByTestId('checkpoint-result-done').click();
      await host.relist([listed]);
      await undoFromList.click();
      await confirmTyped(page, ORG);
      undo = await host.asked('checkpoint:undo');
      await host.answer('checkpoint:undo', {
        result: undoResult(id, { status: 'failure' }),
        operationId: undo.id,
      });
      await expect(page.getByTestId('checkpoint-result-headline')).toHaveText(
        `The undo of the last rewind of ${ORG} ended before it was through: what it did is listed below.`,
      );
      await expectReadable(page, theme, '[data-testid="checkpoint-result"]');
    });

    test('offers to delete the org’s checkpoints with it as it is disconnected, unticked, and deletes every one once ticked', async ({
      page,
    }) => {
      const host = await openPanel(page, theme, 'orgs');
      await expect(page.getByTestId('org-manager-page')).toBeVisible();
      await page.getByText('Disconnect').first().click();
      await host.answer(
        'backup:list',
        { backups: [{ operationId: 'bk-1' }] },
        'backup:list:result',
      );
      const listed = await host.answer('checkpoint:list', { checkpoints: everyListLine() });
      expect(listed.payload).toEqual({ orgId: CHECKPOINT_ORG.id });
      const box = page.getByTestId('disconnect-delete-checkpoints');
      await expect(box).not.toBeChecked();
      await expect(page.getByRole('dialog')).toContainText(
        "Also delete this org's 4 checkpoints kept on this machine, which hold its records' values unencrypted, and the Undo of their rewinds",
      );
      await expectReadable(page, theme, '[role="dialog"]');

      await box.check();
      await confirmTyped(page, 'Disconnect');
      const deleted = await host.asked('checkpoint:delete');
      expect(deleted.payload).toEqual({
        checkpointIds: ['ck-expiring', 'ck-rewound', 'ck-refreshed', 'ck-damaged'],
      });
    });

    test('Home offers a checkpoint of the org before a test session, and its Take opens the take', async ({
      page,
    }) => {
      const host = await openPanel(page, theme, 'home');
      await expect(page.getByTestId('home-page')).toBeVisible();
      await host.answer('checkpoint:list', { checkpoints: [] });
      await expect(page.getByTestId('checkpoint-tile-none')).toHaveText(
        `Take a checkpoint of ${ORG} before your next test session`,
      );
      await expectReadable(page, theme, '[data-testid="checkpoint-tile"]');

      await page.getByTestId('checkpoint-tile-take').click();
      await expect(page.getByTestId('checkpoint-page')).toBeVisible();
      await host.relist([]);
      await expect(page.getByTestId('checkpoint-take')).toBeVisible();
      await host.answer('checkpoint:scope', scopeAnswer());
      await expect(page.getByTestId('checkpoint-cost')).toBeVisible();
    });

    test('Home names the org’s last checkpoint and one about to expire, keeps it from there, and its Rewind… opens the preview', async ({
      page,
    }) => {
      const latest = readyCheckpoint({ expiresAt: daysFromNow(2) });
      const expiring = listEntry(latest, { expiresSoon: true });
      const host = await openPanel(page, theme, 'home');
      await expect(page.getByTestId('home-page')).toBeVisible();
      await host.answer('checkpoint:list', { checkpoints: [expiring] });
      await expect(page.getByTestId('checkpoint-tile-latest')).toContainText(
        'Last checkpoint: “Before UAT”, 2 days ago',
      );
      await expect(page.getByTestId('checkpoint-tile-expiring')).toContainText(
        '“Before UAT” expires in 2 days',
      );
      await expectReadable(page, theme, '[data-testid="checkpoint-tile"]');

      await page.getByTestId('checkpoint-tile-keep').click();
      const kept = await host.answer('checkpoint:keep', {
        checkpoint: { ...latest, expiresAt: null },
      });
      expect(kept.payload).toEqual({ checkpointId: latest.checkpointId, keep: true });
      await host.answer('checkpoint:list', {
        checkpoints: [listEntry({ ...latest, expiresAt: null })],
      });
      await expect(page.getByTestId('checkpoint-tile-expiring')).toHaveCount(0);

      await page.getByTestId('checkpoint-tile-rewind').click();
      await expect(page.getByTestId('checkpoint-page')).toBeVisible();
      await host.relist([listEntry({ ...latest, expiresAt: null })]);
      const preview = await host.answer(
        'checkpoint:preview',
        plainPreview(latest.checkpointId, 'pv-home'),
      );
      expect(preview.payload).toEqual({ checkpointId: latest.checkpointId });
      await expect(page.getByTestId('checkpoint-preview-number-delete')).toHaveText('8 to delete');
    });
  });
}
