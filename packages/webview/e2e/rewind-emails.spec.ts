import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MockBridge, checkAccessibility, formatViolations } from './helpers';
import { MOCK_ORGS } from './fixtures';
import {
  CHECKPOINT_ORG,
  beforeRunCheckpoint,
  daysFromNow,
  listEntry,
  plainPreview,
  previewKeepingOutside,
  previewThatSends,
  readyCheckpoint,
} from './fixtures/checkpoints';
import { VSCODE_DEFAULT_STYLES } from './fixtures/vscode-default-styles';
import { sendExtensionMessage } from './mocks/vscode-api';
import { hostColours, vscodeTheme } from '../src/styles/testing/vscodeThemes';

/**
 * The emails a rewind's writes make the org send, as the pages that start one
 * ask for them: the Checkpoints preview, where an org on All email — or one
 * that would not say — asks for their own box beside the automation's, which
 * never stands for it, and the list's chip of a checkpoint a run took first;
 * and the Automation page's Rewind step, whose acceptance of them is off
 * until ticked. Scanned with axe in the rendered page, under VS Code's
 * default light and dark themes, painted as the host paints a webview.
 */
const THEMES = ['Light 2026', 'Dark 2026'] as const;
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

/** Every request of `type` the page posted, unwrapped from the protocol envelope. */
async function outgoing(page: Page, type: string): Promise<Record<string, unknown>[]> {
  return page.evaluate((requestType) => {
    const posted = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
    return posted
      .map((m) => ((m as Record<string, unknown>).payload ?? m) as Record<string, unknown>)
      .filter((m) => m.type === requestType);
  }, type);
}

/** Answer every request of a type once one was sent: StrictMode can send one twice. */
async function answerAll(
  page: Page,
  requestType: string,
  responseType: string,
  payload: object,
): Promise<void> {
  await expect
    .poll(async () => (await outgoing(page, requestType)).length, { timeout: 10_000 })
    .toBeGreaterThan(0);
  for (const request of await outgoing(page, requestType)) {
    const correlationId = String(request.id);
    await sendExtensionMessage(page, {
      type: responseType,
      id: `resp-${correlationId}`,
      correlationId,
      payload,
    });
  }
}

/** Open a module of the panel under a host theme, the orgs connected. */
async function openModule(page: Page, theme: Theme, module: string): Promise<void> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await paintHostTheme(page, theme);
  await page.addInitScript((id: string) => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = id;
  }, module);
  await page.goto('/');
  await bridge.seedOrgs(MOCK_ORGS);
}

/** The page as it is painted now passes axe. */
async function expectAxeClean(page: Page): Promise<void> {
  const results = await checkAccessibility(page);
  expect(results.violations.length, formatViolations(results.violations)).toBe(0);
}

/** Open the Checkpoints page on the dev sandbox, list the run's checkpoint, and preview a rewind to it. */
async function previewSending(
  page: Page,
  theme: Theme,
  reading: Parameters<typeof previewThatSends>[1],
): Promise<void> {
  await openModule(page, theme, 'checkpoint');
  await expect(page.getByTestId('checkpoint-page')).toBeVisible();
  const checkpoint = beforeRunCheckpoint();
  await answerAll(page, 'checkpoint:list', 'checkpoint:list:response', {
    checkpoints: [listEntry(checkpoint)],
  });
  await expect(page.getByTestId(`checkpoint-row-before-run-${checkpoint.checkpointId}`)).toHaveText(
    'Before Forge run',
  );
  await page.getByTestId(`checkpoint-rewind-${checkpoint.checkpointId}`).click();
  await answerAll(
    page,
    'checkpoint:preview',
    'checkpoint:preview:response',
    previewThatSends(checkpoint.checkpointId, reading),
  );
  await expect(page.getByTestId('checkpoint-preview-emails-out')).toBeVisible();
}

for (const theme of THEMES) {
  test.describe(`The emails of a rewind (${theme})`, () => {
    test.describe.configure({ timeout: 120_000 });

    test('the list names the run a checkpoint was taken before, and passes axe', async ({
      page,
    }) => {
      await openModule(page, theme, 'checkpoint');
      await answerAll(page, 'checkpoint:list', 'checkpoint:list:response', {
        checkpoints: [listEntry(beforeRunCheckpoint())],
      });
      await expect(page.getByTestId('checkpoint-row-before-run-ck-before-forge')).toHaveText(
        'Before Forge run',
      );
      await expectAxeClean(page);
    });

    test('on All email, the preview says who sends and where, holds Rewind until their own box is ticked, sends acceptEmails, and passes axe', async ({
      page,
    }) => {
      await previewSending(page, theme, { level: 'all' });

      await expect(page.getByTestId('checkpoint-preview-deliverability-reading')).toHaveText(
        `${ORG} delivers every email its automation sends (Setup > Deliverability: All email), ` +
          'and what still runs as the rewind writes may send some: Flow “Contact Welcome Email” ' +
          'on Contact and Flow “Account Gone Alert” on Account.',
      );
      await expect(page.getByTestId('checkpoint-preview-deliverability-addresses')).toContainText(
        'never put under .invalid',
      );
      await expectAxeClean(page);

      // The automation's box lets what fires run, and never lets the emails out.
      await page.getByTestId('checkpoint-preview-accept-automation').check();
      await expect(page.getByTestId('checkpoint-preview-rewind')).toBeDisabled();
      await expect(page.getByTestId('checkpoint-preview-needs-box-emails')).toHaveText(
        `Let ${ORG} send these emails`,
      );
      await page.getByTestId('checkpoint-preview-needs-box-emails').click();
      await expect(page.getByTestId('checkpoint-preview-accept-emails')).toBeFocused();
      await page.keyboard.press('Space');
      await expect(page.getByTestId('checkpoint-preview-rewind')).toBeEnabled();

      await page.getByTestId('checkpoint-preview-rewind').click();
      await page.getByTestId('danger-input').fill(ORG);
      await page.getByTestId('danger-confirm-btn').click();
      await expect.poll(async () => (await outgoing(page, 'checkpoint:rewind')).length).toBe(1);
      const [rewind] = await outgoing(page, 'checkpoint:rewind');
      expect(rewind.payload).toEqual(
        expect.objectContaining({ acceptAutomation: true, acceptEmails: true }),
      );
    });

    test('muted, what tests the bypass sends nothing: only the alert is asked about, and passes axe', async ({
      page,
    }) => {
      await previewSending(page, theme, { level: 'all' });
      await page.getByTestId('checkpoint-preview-automation-mute-toggle').check();
      await expect(page.getByTestId('checkpoint-preview-reading-again')).toBeVisible();
      await expect(page.getByTestId('checkpoint-preview-rewind')).toBeDisabled();
      await expect
        .poll(async () => (await outgoing(page, 'checkpoint:preview')).at(-1)?.payload)
        .toEqual(expect.objectContaining({ muteAutomation: true }));
      await answerAll(
        page,
        'checkpoint:preview',
        'checkpoint:preview:response',
        previewThatSends(beforeRunCheckpoint().checkpointId, { level: 'all' }),
      );
      await expect(page.getByTestId('checkpoint-preview-reading-again')).toHaveCount(0);

      const reading = page.getByTestId('checkpoint-preview-deliverability-reading');
      await expect(reading).toContainText('Flow “Account Gone Alert” on Account');
      await expect(reading).not.toContainText('Contact Welcome Email');
      await expect(page.getByTestId('checkpoint-preview-accept-emails')).toBeVisible();
      await expectAxeClean(page);
    });

    test('on System email only or No access, one line says none goes out and no box is offered, and passes axe', async ({
      page,
    }) => {
      await previewSending(page, theme, { level: 'withheld' });

      await expect(page.getByTestId('checkpoint-preview-deliverability-withheld')).toContainText(
        `${ORG} delivers none of the emails`,
      );
      await expect(page.getByTestId('checkpoint-preview-accept-emails')).toHaveCount(0);
      await expectAxeClean(page);
    });

    test('an undo offers their box unticked, is refused without it and says the box is the way, asks again unticked, and passes axe', async ({
      page,
    }) => {
      await openModule(page, theme, 'checkpoint');
      const checkpoint = beforeRunCheckpoint();
      const rewound = {
        ...checkpoint,
        lastRewind: {
          rewindId: 'rw-last',
          endedAt: daysFromNow(-1),
          undoUntil: daysFromNow(14),
        },
      };
      await answerAll(page, 'checkpoint:list', 'checkpoint:list:response', {
        checkpoints: [
          listEntry(rewound, { undo: { rewindId: 'rw-last', until: daysFromNow(14) } }),
        ],
      });

      await page.getByTestId(`checkpoint-undo-${checkpoint.checkpointId}`).click();
      await expect(page.getByTestId('checkpoint-undo-accept-emails')).not.toBeChecked();
      await expectAxeClean(page);
      await page.getByTestId('checkpoint-undo-accept-automation').check();
      await page.getByTestId('danger-input').fill(ORG);
      await page.getByTestId('danger-confirm-btn').click();

      await expect.poll(async () => (await outgoing(page, 'checkpoint:undo')).length).toBe(1);
      const [first] = await outgoing(page, 'checkpoint:undo');
      // The page says it is the page: a refusal then names its box, not a flag.
      expect(first.payload).toEqual(
        expect.objectContaining({ acceptAutomation: true, fromPage: true }),
      );
      expect(first.payload).not.toHaveProperty('acceptEmails');
      await sendExtensionMessage(page, {
        type: 'checkpoint:error',
        id: 'undo-refused',
        correlationId: String(first.id),
        payload: {
          message: `${ORG} delivers every email its automation sends. Nothing was written. Tick the box for these emails in the undo's confirmation to undo all the same.`,
          code: 'EMAILS_DELIVERED',
          retryable: false,
        },
      });
      await expect(page.getByTestId('error-hint')).toContainText(
        'tick the box that lets the org send them',
      );
      await expectAxeClean(page);

      await page.getByTestId('checkpoint-run-undo-again').click();
      await expect(page.getByTestId('checkpoint-undo-accept-emails')).not.toBeChecked();
      await page.getByTestId('checkpoint-undo-accept-emails').check();
      await page.getByTestId('danger-input').fill(ORG);
      await page.getByTestId('danger-confirm-btn').click();
      await expect.poll(async () => (await outgoing(page, 'checkpoint:undo')).length).toBe(2);
      const [, second] = await outgoing(page, 'checkpoint:undo');
      expect(second.payload).toEqual(expect.objectContaining({ acceptEmails: true }));
    });

    test('in a checkpoint of picked objects, counts the emails of the rewind that keeps what records outside hang from until their box is ticked, then those of the one that deletes it, and passes axe', async ({
      page,
    }) => {
      // The page counted every email of a rewind that deletes the account a
      // case outside the checkpoint hangs from, its box unticked, where that
      // rewind keeps the account and the command line counted fewer.
      await openModule(page, theme, 'checkpoint');
      const checkpoint = beforeRunCheckpoint();
      await answerAll(page, 'checkpoint:list', 'checkpoint:list:response', {
        checkpoints: [listEntry(checkpoint)],
      });
      await page.getByTestId(`checkpoint-rewind-${checkpoint.checkpointId}`).click();
      await answerAll(
        page,
        'checkpoint:preview',
        'checkpoint:preview:response',
        previewKeepingOutside(checkpoint.checkpointId),
      );

      const box = page.getByTestId('checkpoint-preview-accept-outside');
      const emails = page.getByTestId('checkpoint-preview-emails-SingleEmail');
      await expect(box).not.toBeChecked();
      await expect(emails).toHaveText(
        `Single emails: about 1 sent by ${ORG}'s automation as the rewind writes (Account changed), 15 of 15 left today.`,
      );
      await expectAxeClean(page);

      await box.check();
      await expect(emails).toHaveText(
        `Single emails: about 2 sent by ${ORG}'s automation as the rewind writes (Account changed and Account gone), 15 of 15 left today.`,
      );
      await expectAxeClean(page);

      await box.uncheck();
      await expect(emails).toContainText('about 1 sent');
    });

    test('the Rewind step limited to some objects asks its preview whether its deletions take along what of the others hangs from them, and passes axe', async ({
      page,
    }) => {
      // Asked without it, the preview counted the emails, the automation and
      // the refusal of a rewind that keeps those records, where the step's
      // rewind deletes them. A step names its checkpoint by an id of the
      // store's shape.
      const checkpoint = readyCheckpoint({
        checkpointId: 'ck-20261029-020000-abcd',
        name: 'Nightly baseline',
        scope: { mode: 'picked', leftOut: [] },
      });
      const pipeline = {
        id: 'p-reset',
        name: 'Nightly reset',
        description: '',
        version: 1,
        steps: [
          {
            id: 'step-r',
            name: 'Reset',
            type: 'rewind',
            config: {
              orgId: CHECKPOINT_ORG.id,
              checkpointId: checkpoint.checkpointId,
              maxRecords: 200,
              objects: ['Contact'],
              acceptOutside: true,
            },
            continueOnError: false,
          },
        ],
        triggers: [],
        variables: [],
        tags: [],
        createdAt: '2026-10-29T00:00:00.000Z',
        updatedAt: '2026-10-29T00:00:00.000Z',
      };
      await openModule(page, theme, 'automation');
      await answerAll(page, 'pipeline:list', 'pipeline:list:response', {
        pipelines: [pipeline],
        triggers: [],
      });
      await answerAll(page, 'pipeline:sync-configs', 'pipeline:sync-configs:response', {
        configs: [],
      });
      await answerAll(page, 'pipeline:history', 'pipeline:history:response', { history: [] });
      await answerAll(page, 'pipeline:templates', 'pipeline:templates:response', {
        templates: [],
      });
      await page.getByTestId('saved-pipeline-p-reset').click();
      await answerAll(page, 'pipeline:rewind-steps', 'pipeline:rewind-steps:response', {
        pipelineId: 'p-reset',
        steps: [{ stepId: 'step-r', checkpointId: checkpoint.checkpointId, valid: true }],
      });
      // The step's own list of checkpoints, asked once it is opened.
      const listed = (await outgoing(page, 'checkpoint:list')).length;
      await page.getByTestId('canvas-step-step-r').click();
      await expect
        .poll(async () => (await outgoing(page, 'checkpoint:list')).length, { timeout: 10_000 })
        .toBeGreaterThan(listed);
      await answerAll(page, 'checkpoint:list', 'checkpoint:list:response', {
        checkpoints: [listEntry(checkpoint)],
      });
      await page.getByTestId('rewind-confirm').click();

      await expect
        .poll(async () => (await outgoing(page, 'checkpoint:preview')).length, { timeout: 10_000 })
        .toBeGreaterThan(0);
      const [asked] = await outgoing(page, 'checkpoint:preview');
      expect(asked.payload).toEqual({
        checkpointId: checkpoint.checkpointId,
        objects: ['Contact'],
        acceptOutside: true,
      });
      await answerAll(
        page,
        'checkpoint:preview',
        'checkpoint:preview:response',
        plainPreview(checkpoint.checkpointId, 'pv-step'),
      );
      await expect(page.getByTestId('rewind-step-confirm')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Limited to Contact' })).toBeVisible();
      await expectAxeClean(page);
    });

    test('the Rewind step accepts the emails off by default, saved once ticked, and passes axe', async ({
      page,
    }) => {
      await openModule(page, theme, 'automation');
      await answerAll(page, 'pipeline:list', 'pipeline:list:response', {
        pipelines: [],
        triggers: [],
      });
      await answerAll(page, 'pipeline:sync-configs', 'pipeline:sync-configs:response', {
        configs: [],
      });
      await answerAll(page, 'pipeline:history', 'pipeline:history:response', { history: [] });
      await answerAll(page, 'pipeline:templates', 'pipeline:templates:response', {
        templates: [],
      });
      await page.getByTestId('create-pipeline-btn').click();
      await page.getByTestId('palette-rewind').click();
      await page.locator('[data-testid^="canvas-step-"]').first().click();
      await page.getByTestId('config-orgId').selectOption(CHECKPOINT_ORG.id);
      const checkpoint = beforeRunCheckpoint();
      await answerAll(page, 'checkpoint:list', 'checkpoint:list:response', {
        checkpoints: [listEntry(checkpoint)],
      });
      await page.getByTestId('config-checkpointId').selectOption(checkpoint.checkpointId);
      await page.getByTestId('config-maxRecords').fill('200');

      await page.getByTestId('rewind-acceptances').locator('summary').click();
      const box = page.getByTestId('config-acceptEmails');
      await expect(box).not.toBeChecked();
      await expect(page.getByTestId('rewind-acceptances')).toContainText(
        'Run even if the org delivers the emails its flows, processes or workflow rules send as it writes (All email), or would not say whether it does',
      );
      await expectAxeClean(page);

      await box.check();
      await expect(page.getByTestId('rewind-acceptances-count')).toHaveText('1 ticked');
      await page.getByTestId('save-pipeline-btn').click();
      await expect.poll(async () => (await outgoing(page, 'pipeline:save')).length).toBe(1);
      const [save] = await outgoing(page, 'pipeline:save');
      const steps = (save.payload as { config: { steps: Array<Record<string, unknown>> } }).config
        .steps;
      expect(steps[0]?.config).toEqual(expect.objectContaining({ acceptEmails: true }));
    });
  });
}
