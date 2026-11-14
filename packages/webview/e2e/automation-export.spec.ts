import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MockBridge, checkAccessibility, formatViolations } from './helpers';
import { themeContrastShortfalls } from './helpers/theme-contrast';
import { answerOnceAsked, openModule, requestIds, sentPayloads } from './helpers/refusalStates';
import { sendExtensionMessage } from './mocks/vscode-api';
import { VSCODE_DEFAULT_STYLES } from './fixtures/vscode-default-styles';
import { hostColours, vscodeTheme } from '../src/styles/testing/vscodeThemes';

/**
 * Export…, Dry run, and a pipeline a launcher starts, on the Automation page:
 * what the page asks the extension and in which order, then each state
 * scanned on the four themes the page scans run on, with the contrast of what
 * it paints held to the bar.
 */

const SCANNED_THEMES = ['Light 2026', 'Dark 2026', 'Light Modern', 'Dark Modern'] as const;
type ScannedTheme = (typeof SCANNED_THEMES)[number];

const DIGEST = `sha256:${'c'.repeat(64)}`;

/** The pipeline as saved: a schedule, an Approval, a Rewind, a step it refuses. */
const SAVED = {
  id: 'pipe-1',
  name: 'Nightly reset',
  description: '',
  version: 2,
  steps: [
    { id: 's-cmp', name: 'Diff', type: 'delay', config: { seconds: 1 }, continueOnError: false },
  ],
  triggers: [
    {
      id: 'tr-s',
      type: 'schedule',
      enabled: true,
      config: { cron: '0 2 * * *', timezone: 'Europe/Paris' },
    },
  ],
  variables: [],
  tags: [],
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

/** What the extension answers `pipeline:export` with for {@link SAVED}. */
const EXPORTED = {
  exported: true,
  pipelineId: 'pipe-1',
  fileName: 'nightly-reset.sandforge-pipeline.json',
  text: '{"sandforgePipeline":1}',
  digest: DIGEST,
  schedule: { cron: '0 2 * * *', timezone: 'Europe/Paris' },
  steps: [
    { stepId: 's-cmp', name: 'Diff', type: 'compare', fate: 'runs', notes: [] },
    {
      stepId: 's-gate',
      name: 'Gate',
      type: 'approval',
      fate: 'asks',
      notes: ['APPROVAL_NEEDS_PERSON'],
    },
    {
      stepId: 's-rw',
      name: 'Back',
      type: 'rewind',
      fate: 'asks',
      notes: ['REWIND_NEEDS_CONFIRMATION', 'REWIND_CHECKPOINT_ELSEWHERE'],
    },
    {
      stepId: 's-del',
      name: 'Purge',
      type: 'delete',
      fate: 'refused',
      notes: ['STEP_REFUSED'],
      refusal: 'Step "Purge" is a Delete step, which a pipeline never runs.',
    },
  ],
  orgs: [
    {
      key: 'org-t',
      alias: 'UAT',
      kind: 'sandbox',
      staging: true,
      cliHolds: false,
      writtenBy: ['Back'],
      readBy: ['Diff'],
    },
    {
      key: 'org-s',
      name: 'Source Org',
      kind: 'scratch',
      staging: false,
      cliHolds: true,
      writtenBy: [],
      readBy: ['Diff'],
    },
  ],
  variables: [
    { name: 'TOKEN', type: 'secret', required: true, valued: false, env: 'SANDFORGE_VAR_TOKEN' },
  ],
  launchers: {
    cron: {
      runner: 'cron',
      fileName: 'nightly-reset.sh',
      text: '#!/usr/bin/env bash',
      schedule: {
        kind: 'line',
        text: '0 1 * * * /bin/bash /path/to/nightly-reset.sh',
        timezone: 'UTC',
        offsetMinutes: -60,
        offsetChanges: [{ at: Date.parse('2027-03-28T01:00:00.000Z'), offsetMinutes: -120 }],
      },
    },
    taskScheduler: {
      runner: 'taskScheduler',
      fileName: 'nightly-reset.ps1',
      text: '',
      schedule: { kind: 'manual', reason: 'Create the task in Task Scheduler by hand.' },
    },
    githubActions: { runner: 'githubActions', fileName: 'nightly-reset.yml', text: '' },
  },
  notes: [],
  problems: ['Step "Purge" is a Delete step, which a pipeline never runs.'],
};

const OUTSIDE = {
  since: '2026-11-20T08:00:00.000Z',
  runner: 'cron',
  file: 'nightly-reset.sandforge-pipeline.json',
  digest: DIGEST,
};

/** Paint the host theme's colours and VS Code's default stylesheet before first paint. */
async function paintHostTheme(page: Page, theme: ScannedTheme): Promise<void> {
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

/** Every axe rule, and the contrast of what is painted inside `within`, held to the bar. */
async function expectReadable(page: Page, theme: ScannedTheme, within: string): Promise<void> {
  const results = await checkAccessibility(page);
  expect(results.violations.length, formatViolations(results.violations)).toBe(0);
  const measured = results.passes
    .filter((rule) => rule.id === 'color-contrast')
    .flatMap((rule) => rule.nodes)
    .map((node) => node.target[0])
    .map((target) => (typeof target === 'string' ? target : target[target.length - 1]));
  const inside = await page.evaluate(
    ({ selectors, container }) =>
      selectors.filter((selector) => document.querySelector(selector)?.closest(container) != null)
        .length,
    { selectors: measured, container: within },
  );
  expect(inside, `axe measured no text inside ${within}`).toBeGreaterThan(0);
  const shortfalls = await themeContrastShortfalls(page, vscodeTheme(theme));
  expect(shortfalls, shortfalls.join('\n')).toEqual([]);
}

/** The Automation page, `saved` listed, opened on it. */
async function openSaved(
  page: Page,
  saved: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const bridge = new MockBridge();
  await openModule(bridge, page, 'automation');
  await answerOnceAsked(page, 'pipeline:list', 'pipeline:list:response', {
    pipelines: [saved],
    triggers: [],
    ...extra,
  });
  await page.getByTestId(`saved-pipeline-${String(saved.id)}`).click();
}

/** Press Export… and answer the export with `outcome`. */
async function exportWith(page: Page, outcome: Record<string, unknown>): Promise<void> {
  await page.getByRole('button', { name: 'Export…' }).click();
  await answerOnceAsked(page, 'pipeline:export', 'pipeline:export:response', outcome);
}

test.describe('Export… on the Automation page', () => {
  test('saves the file, then the launcher beside it, then the pipeline with its schedule off', async ({
    page,
  }) => {
    await openSaved(page, SAVED);
    await exportWith(page, EXPORTED);
    expect(await sentPayloads(page, 'pipeline:export')).toContainEqual({ pipelineId: 'pipe-1' });

    await page.getByRole('radio', { name: 'bash, started by cron' }).check();
    await expect(page.getByTestId('export-hand-over')).toBeChecked();
    await page.getByTestId('export-save').click();

    await answerOnceAsked(page, 'file:save', 'file:save:response', {
      status: 'saved',
      path: '/home/me/pipelines/nightly-reset.sandforge-pipeline.json',
    });
    // The launcher is asked for once the file is saved, and the schedule is
    // handed over once the launcher is.
    await expect.poll(async () => (await requestIds(page, 'file:save')).length).toBe(2);
    const [, launcherId] = await requestIds(page, 'file:save');
    expect((await sentPayloads(page, 'file:save'))[1]).toMatchObject({
      suggestedName: 'nightly-reset.sh',
      extensions: ['sh'],
    });
    expect(await requestIds(page, 'pipeline:save')).toEqual([]);
    await sendExtensionMessage(page, {
      type: 'file:save:response',
      id: `resp-${launcherId}`,
      correlationId: launcherId,
      payload: { status: 'saved', path: '/home/me/pipelines/nightly-reset.sh' },
    });

    await expect.poll(async () => (await requestIds(page, 'pipeline:save')).length).toBe(1);
    const [handOver] = await sentPayloads(page, 'pipeline:save');
    expect(handOver).toMatchObject({
      id: 'pipe-1',
      config: {
        triggers: [{ id: 'tr-s', enabled: false }],
        runsOutside: { runner: 'cron', file: OUTSIDE.file, digest: DIGEST },
      },
    });
  });
});

for (const theme of SCANNED_THEMES) {
  test.describe(`axe-core WCAG 2.1 AA — ${theme} — Automation export, dry run and launcher`, () => {
    test.describe.configure({ timeout: 60_000 });

    test.beforeEach(async ({ page }) => {
      await paintHostTheme(page, theme);
    });

    test('the export dialog: steps, orgs, variables, a launcher chosen, the locks, and the saves', async ({
      page,
    }) => {
      await openSaved(page, SAVED);
      await expect(page.getByTestId('export-save-first')).toHaveCount(0);
      await exportWith(page, EXPORTED);
      await page.getByRole('radio', { name: 'bash, started by cron' }).check();
      await expect(page.getByTestId('export-launcher-line')).toBeVisible();
      await expectReadable(page, theme, '[data-testid="export-dialog"]');

      await page.getByRole('radio', { name: 'PowerShell, started by Task Scheduler' }).check();
      await expect(page.getByTestId('export-launcher-manual')).toBeVisible();
      await page.getByTestId('export-save').click();
      await answerOnceAsked(page, 'file:save', 'file:save:response', { status: 'cancelled' });
      await expect(page.getByTestId('export-stopped')).toBeVisible();
      await page.getByTestId('export-stopped').scrollIntoViewIfNeeded();
      await expectReadable(page, theme, '[data-testid="export-outcome"]');
    });

    test('an export refused, with the reader’s words and the extension’s', async ({ page }) => {
      await openSaved(page, SAVED);
      await exportWith(page, {
        exported: false,
        pipelineId: 'pipe-1',
        code: 'FILE_INVALID',
        message: 'The pipeline file would not read: 1 issue.',
        issues: [{ path: 'settings.sync.maxRecordsPerObject', message: 'Too big' }],
      });
      await expect(page.getByTestId('export-refused')).toBeVisible();
      await expectReadable(page, theme, '[data-testid="export-refused"]');
    });

    test('Export… held for a save, and the result of a dry run above the canvas', async ({
      page,
    }) => {
      await openSaved(page, SAVED);
      await page.getByLabel('Pipeline name').fill('Nightly reset edited');
      await expect(page.getByTestId('export-save-first')).toBeVisible();
      await expectReadable(page, theme, '[data-testid="pipeline-identity"]');

      await page.getByRole('button', { name: 'Dry run' }).click();
      await answerOnceAsked(page, 'pipeline:execute', 'pipeline:run:response', {
        pipelineId: 'pipe-1',
        pipelineName: 'Nightly reset edited',
        status: 'failed',
        dryRun: true,
        stepResults: [
          {
            stepId: 's-cmp',
            stepName: 'Diff',
            stepType: 'delay',
            status: 'failed',
            error: 'Delay "Diff" would be refused: the org has 2 MB left.',
          },
        ],
      });
      await expect(page.getByTestId('dry-run-result')).toBeVisible();
      // Its end is said in a notification, which floats over the page: read
      // as one, then put away, the page under it is read uncovered.
      const toasts = page.getByTestId('floating-toasts');
      await expect(toasts).toContainText('The dry run of “Nightly reset edited” stops where');
      const covered = await themeContrastShortfalls(
        page,
        vscodeTheme(theme),
        '[data-testid="floating-toasts"]',
      );
      expect(covered, covered.join('\n')).toEqual([]);
      await toasts.getByRole('button', { name: 'Dismiss' }).first().click();
      await expect(toasts.getByText('The dry run of')).toHaveCount(0);
      await page.getByTestId('dry-run-result').scrollIntoViewIfNeeded();
      await expectReadable(page, theme, '[data-testid="dry-run-result"]');
    });

    test('a pipeline a launcher starts: its stale file, its Triggers, and History', async ({
      page,
    }) => {
      const handedOver = {
        ...SAVED,
        triggers: [{ ...SAVED.triggers[0], enabled: false }],
        runsOutside: OUTSIDE,
      };
      await openSaved(page, handedOver, { outside: [{ pipelineId: 'pipe-1', matches: false }] });
      await answerOnceAsked(page, 'pipeline:history', 'pipeline:history:response', {
        history: [
          {
            runId: 'cli-1',
            pipelineId: 'pipe-1',
            pipelineName: 'Nightly reset',
            status: 'completed',
            triggeredBy: 'schedule',
            startTime: '2026-11-21T01:00:00.000Z',
            duration: 42_000,
            stepCount: 1,
            errorCount: 0,
            ranFrom: 'commandLine',
            steps: [
              {
                stepName: 'Gate',
                stepType: 'approval',
                status: 'completed',
                approval: {
                  decision: 'approved',
                  via: 'commandLine',
                  at: '2026-11-21T01:00:05.000Z',
                },
              },
            ],
          },
          {
            runId: 'missed-1',
            pipelineId: 'pipe-1',
            pipelineName: 'Nightly reset',
            status: 'missed',
            triggeredBy: 'schedule',
            startTime: '2026-11-19T01:00:00.000Z',
            duration: 0,
            stepCount: 0,
            errorCount: 0,
            missed: { reason: 'closed', count: 1 },
          },
        ],
      });
      await expect(page.getByTestId('pipeline-outside-stale')).toBeVisible();
      await expectReadable(page, theme, '[data-testid="pipeline-outside-stale"]');

      await page.getByRole('tab', { name: 'Triggers' }).click();
      await expect(page.getByTestId('trigger-outside')).toBeVisible();
      await expectReadable(page, theme, '[data-testid="trigger-outside"]');
      await page.getByTestId('trigger-outside-resume').click();
      await expect(page.getByTestId('trigger-resumed')).toBeVisible();
      await expectReadable(page, theme, '[data-testid="trigger-resumed"]');

      await page.getByRole('tab', { name: 'History' }).click();
      await expect(page.getByTestId('history-command-line-cli-1')).toBeVisible();
      await expect(page.getByTestId('history-missed-export-missed-1')).toBeVisible();
      await expectReadable(page, theme, '[data-testid="pipeline-history"]');
    });
  });
}
