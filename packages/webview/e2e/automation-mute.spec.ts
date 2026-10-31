import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type {
  CheckpointListEntry,
  CheckpointPreviewResponse,
  ForgeTargetAutomation,
  MutedAutomation,
} from '@sandforge/shared';
import { MockBridge, checkAccessibility, formatViolations } from './helpers';
import { themeContrastShortfalls } from './helpers/theme-contrast';
import { MOCK_ORGS } from './fixtures';
import {
  CHECKPOINT_ORG,
  listEntry,
  plainPreview,
  readyCheckpoint,
  rewindResult,
} from './fixtures/checkpoints';
import { VSCODE_DEFAULT_STYLES } from './fixtures/vscode-default-styles';
import { hostColours, vscodeTheme } from '../src/styles/testing/vscodeThemes';

/**
 * The box that mutes the target's automation for one run, and what the run
 * says it muted, drawn in Chromium the way the host draws a webview: on a
 * rewind's preview, where the box is planned from what the preview read, and
 * on an undo's confirmation, where nothing of the org is read and the box says
 * it is read as the undo starts; the rewind's result, and the undo's refusal
 * the org gave. Checkpoint & Rewind is the page that carries all three: the
 * box and the result are the same components on every page that offers them.
 *
 * Every state is scanned with axe under VS Code's default themes, Light 2026
 * and Dark 2026, and the two they replaced, with the stylesheet VS Code
 * prepends to every webview, and held to the theme's own contrast for what
 * axe does not measure; a scan of a state just opened shows that axe measured
 * text inside it.
 */
const THEMES = ['Light 2026', 'Dark 2026', 'Light Modern', 'Dark Modern'] as const;
type Theme = (typeof THEMES)[number];

/** The org the checkpoint is of, as the page names it. */
const ORG = CHECKPOINT_ORG.alias;

/** The checkpoint rewound to. */
const CHECKPOINT = readyCheckpoint({ checkpointId: 'ck-mute', name: 'Before UAT' });

/**
 * What the org runs as the rewind writes: a flow on a contact's update a set of
 * the org silences, and a trigger before an account's delete nothing silences.
 */
const AUTOMATION: ForgeTargetAutomation = {
  objectsRead: ['Contact', 'Account'],
  objects: [
    {
      objectApiName: 'Contact',
      flows: [
        {
          apiName: 'Contact_Touch',
          label: 'Contact touch',
          timing: 'afterSave',
          startsOn: 'update',
          condition: 'read',
          permissions: [{ name: 'Skip_Touch', bypass: true, held: false }],
        },
      ],
      triggers: [],
    },
    {
      objectApiName: 'Account',
      flows: [],
      triggers: [{ name: 'AccountGone', events: ['beforeDelete'] }],
    },
  ],
  // The set holding the flow's bypass grants a validation rule's too: what it lifts beside.
  bypassGrants: [
    {
      permission: 'Skip_Touch',
      permissionSets: [
        {
          name: 'Touch_Bypass',
          label: 'Touch bypass',
          grants: 2,
          customPermissions: ['Skip_Touch', 'Skip_VR'],
        },
      ],
    },
  ],
  validationRuleBypasses: [
    { objectApiName: 'Contact', name: 'Email_Required', permissions: ['Skip_VR'] },
  ],
  // One rule's formula the read could not take: whether the set lifts it is said unknown.
  validationRulesNotRead: 1,
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 3,
};

/** The plain preview of Accounts and Contacts, with the automation above. */
function previewWithAutomation(): CheckpointPreviewResponse['payload'] {
  return { ...plainPreview(CHECKPOINT.checkpointId, 'pv-mute'), automation: AUTOMATION };
}

/** What the rewind muted, as the lease said it once the rewind ended. */
const MUTED: MutedAutomation = {
  state: 'muted',
  assigned: ['Touch_Bypass'],
  held: [],
  permissions: ['Skip_Touch'],
  silenced: [
    { objectApiName: 'Contact', kind: 'flow', name: 'Contact touch', permission: 'Skip_Touch' },
  ],
  stillRan: [{ objectApiName: 'Account', kind: 'trigger', name: 'AccountGone', why: 'noBypass' }],
  alsoLifted: [
    {
      objectApiName: 'Contact',
      kind: 'validationRule',
      name: 'Email_Required',
      permission: 'Skip_VR',
      permissionSet: 'Touch_Bypass',
    },
  ],
  liftsUnread: [{ part: 'grants', permissionSet: 'Touch_Extra' }],
  released: true,
};

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
 * page sends is answered once, correlated to it; a development build mounts
 * the panel twice, so a query can be asked twice, and both are answered.
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

  /** Answer every request of `type` not answered yet: the latest is returned. */
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

  /** Answer the list reads asked since the last answer, if any. */
  async relist(checkpoints: CheckpointListEntry[]): Promise<void> {
    for (const request of await this.pending('checkpoint:list')) {
      this.answered.add(String(request.id));
      await this.bridge.respond('checkpoint:list:response', { checkpoints }, String(request.id));
    }
  }
}

/** Open the Checkpoints page on the dev sandbox under a host theme, its checkpoint listed. */
async function openCheckpoints(page: Page, theme: Theme): Promise<Extension> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await paintHostTheme(page, theme);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'checkpoint';
  });
  await page.goto('/');
  await bridge.seedOrgs(MOCK_ORGS);
  const host = new Extension(bridge);
  await expect(page.getByTestId('checkpoint-page')).toBeVisible();
  await host.answer('checkpoint:list', { checkpoints: [listEntry(CHECKPOINT)] });
  return host;
}

/** How many texts inside `container` axe measured the contrast of. */
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

/** The page as painted now passes axe, axe measured text in `opened`, and the theme's contrast holds. */
async function expectReadable(page: Page, theme: Theme, opened: string): Promise<void> {
  const results = await checkAccessibility(page);
  expect(results.violations.length, formatViolations(results.violations)).toBe(0);
  expect(
    await contrastMeasuredIn(page, results, opened),
    `axe measured no text inside ${opened}`,
  ).toBeGreaterThan(0);
  const shortfalls = await themeContrastShortfalls(page, vscodeTheme(theme));
  expect(shortfalls, shortfalls.join('\n')).toEqual([]);
}

/** Type `text` in the typed confirmation, and press its Confirm. */
async function confirmTyped(page: Page, text: string): Promise<void> {
  await page.getByTestId('danger-input').fill(text);
  await expect(page.getByTestId('danger-confirm-btn')).toBeEnabled();
  await page.getByTestId('danger-confirm-btn').click();
}

for (const theme of THEMES) {
  test.describe(`Muting the target's automation (${theme})`, () => {
    test.describe.configure({ timeout: 120_000 });

    test('offers no box on a preview whose automation nothing silences', async ({ page }) => {
      const host = await openCheckpoints(page, theme);
      await page.getByTestId(`checkpoint-rewind-${CHECKPOINT.checkpointId}`).click();
      await host.answer('checkpoint:preview', plainPreview(CHECKPOINT.checkpointId, 'pv-plain'));
      await expect(page.getByTestId('checkpoint-preview-automation-none')).toBeVisible();
      await expect(page.getByTestId('checkpoint-preview-automation-mute')).toHaveCount(0);
    });

    test('mutes a rewind from its preview, says what it muted, and words the undo’s refused mute', async ({
      page,
    }) => {
      const host = await openCheckpoints(page, theme);
      await page.getByTestId(`checkpoint-rewind-${CHECKPOINT.checkpointId}`).click();
      await host.answer('checkpoint:preview', previewWithAutomation());

      // The box, off, beside what the rewind fires.
      const box = page.getByTestId('checkpoint-preview-automation-mute');
      const toggle = page.getByRole('checkbox', {
        name: "Mute the target's automation for this run — through its own bypass",
      });
      await expect(toggle).not.toBeChecked();
      await expect(page.getByTestId('checkpoint-preview-automation-mute-assigns')).toHaveText(
        `Assigns the permission set Touch_Bypass to the user the run writes as in ${ORG}, for this run alone, and takes it back as the run ends.`,
      );
      await expect(
        page.getByTestId('checkpoint-preview-automation-mute-silenced-Contact'),
      ).toHaveText('Contact: Flow: Contact touch · bypass Skip_Touch');
      await expect(
        page.getByTestId('checkpoint-preview-automation-mute-still-runs-Account'),
      ).toHaveText('Account: Apex trigger: AccountGone · nothing in it tests a bypass');
      // What the set lifts beside the flow it silences: the validation rule its other permission keeps quiet.
      const lifts = page.getByTestId('checkpoint-preview-automation-mute-also-lifts');
      await expect(
        page.getByTestId('checkpoint-preview-automation-mute-also-lifts-Contact'),
      ).toHaveText('Contact: Validation rule: Email_Required · Skip_VR, in Touch_Bypass');
      await expect(
        lifts.getByText(
          "Not every validation rule could be read: whether the sets lift more isn't known.",
        ),
      ).toBeVisible();
      await expectReadable(
        page,
        theme,
        '[data-testid="checkpoint-preview-automation-mute-also-lifts"]',
      );

      // Ticked, the rewind asks acceptance only for the trigger that still runs.
      await toggle.check();
      await expect(box).toBeVisible();
      await page.getByTestId('checkpoint-preview-accept-automation').check();
      await expectReadable(page, theme, '[data-testid="checkpoint-preview-automation-mute"]');
      await page.getByTestId('checkpoint-preview-rewind').click();
      await confirmTyped(page, ORG);
      const rewind = await host.asked('checkpoint:rewind');
      expect(rewind.payload).toEqual({
        checkpointId: CHECKPOINT.checkpointId,
        previewId: 'pv-mute',
        acceptAutomation: true,
        acceptNoUndo: false,
        acceptRecreate: false,
        acceptOutside: false,
        acceptUnseen: false,
        muteAutomation: true,
      });

      // The result says what was muted, what still ran, and that it was taken back.
      await host.answer('checkpoint:rewind', {
        result: rewindResult(CHECKPOINT.checkpointId, { mutedAutomation: MUTED }),
        operationId: rewind.id,
      });
      await expect(page.getByTestId('checkpoint-result-muted-said')).toHaveText(
        `Touch_Bypass was assigned to the user the run wrote as in ${ORG}, for the run alone.`,
      );
      await expect(page.getByTestId('checkpoint-result-muted-released')).toHaveText(
        'Taken back as the run ended.',
      );
      await expect(page.getByTestId('checkpoint-result-muted-still-ran-Account')).toHaveText(
        'Account: Apex trigger: AccountGone · nothing in it tests a bypass',
      );
      await expect(page.getByTestId('checkpoint-result-muted-also-lifted-Contact')).toHaveText(
        'Contact: Validation rule: Email_Required · Skip_VR, in Touch_Bypass',
      );
      await expect(
        page
          .getByTestId('checkpoint-result-muted-also-lifted')
          .getByText("What Touch_Extra grants couldn't be read: what else it lifts isn't known."),
      ).toBeVisible();
      await expectReadable(page, theme, '[data-testid="checkpoint-result-muted-also-lifted"]');

      // Its undo reads nothing of the org: the box says what it silences is read as it starts.
      // Tall enough for the whole confirmation: its body scrolls under its
      // buttons in a short window, and axe measures nothing it overlaps.
      await page.setViewportSize({ width: 1280, height: 1400 });
      await page.getByTestId('checkpoint-result-undo-open').click();
      await expect(page.getByTestId('checkpoint-undo-mute-at-start')).toContainText(
        `What it silences is read from ${ORG} as the run starts`,
      );
      await expect(page.getByTestId('checkpoint-undo-mute-toggle')).not.toBeChecked();
      await expectReadable(page, theme, '[data-testid="checkpoint-undo-mute"]');
      await page.getByTestId('checkpoint-undo-mute-toggle').check();
      await confirmTyped(page, ORG);
      const undo = await host.asked('checkpoint:undo');
      expect(undo.payload).toEqual({
        checkpointId: CHECKPOINT.checkpointId,
        rewindId: 'rw-new',
        acceptAutomation: false,
        muteAutomation: true,
      });

      // The org refused the mute: said in the panel's language, the host's reason kept.
      await host.answer(
        'checkpoint:undo',
        {
          message:
            'The target is a production org: its automation is never muted there. Nothing was written.',
          code: 'MUTE',
          retryable: false,
        },
        'checkpoint:error',
      );
      await expect(page.getByTestId('checkpoint-run-error')).toContainText(
        "The org's automation couldn't be muted, so nothing was written: The target is a production org",
      );
      await expectReadable(page, theme, '[data-testid="checkpoint-run-error"]');
      await host.relist([listEntry(CHECKPOINT)]);
    });
  });
}
