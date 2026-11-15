import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MockBridge, checkAccessibility, formatViolations, sendExtensionMessage } from './helpers';
import { MOCK_ORGS } from './fixtures';
import { VSCODE_DEFAULT_STYLES } from './fixtures/vscode-default-styles';
import { hostColours, vscodeTheme } from '../src/styles/testing/vscodeThemes';

/**
 * DataOps past what one backup holds of an object, in slices: the coverage's
 * plan, the confirmation that asks for the slices before it arms, the run's
 * slice and phase as it goes, what it left once it ends; a run left open,
 * which holds Apply and is resumed or given up; a set in Restore, restored
 * whole or a slice at a time; a backup in slices. The extension's side is
 * played as the bridge carries it, and each state is scanned with axe under
 * VS Code's default themes and the two they replaced, painted as the host
 * paints a webview.
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

/** Every outgoing message of a type, unwrapped from the post envelope. */
async function outgoing(page: Page, type: string): Promise<Record<string, unknown>[]> {
  return page.evaluate((msgType) => {
    const msgs = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
    return msgs
      .map((m) => {
        const e = m as Record<string, unknown>;
        return (e.payload as Record<string, unknown> | undefined) ?? e;
      })
      .filter((m) => m.type === msgType) as Record<string, unknown>[];
  }, type);
}

/** Answer every pending request of a type: a development build mounts each query twice. */
async function answerAll(
  page: Page,
  requestType: string,
  responseType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await expect
    .poll(async () => (await outgoing(page, requestType)).length, { timeout: 10_000 })
    .toBeGreaterThan(0);
  for (const request of await outgoing(page, requestType)) {
    await sendExtensionMessage(page, {
      type: responseType,
      id: `resp-${String(request.id)}`,
      correlationId: String(request.id),
      payload,
    });
  }
}

/** What the org runs as a masking or a restore writes, as the extension answers: nothing. */
const NOTHING_FIRES = {
  act: 'masking',
  objects: [],
  steps: {},
  automation: {
    objectsRead: [],
    objects: [],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 0,
    requests: 0,
  },
  lines: [],
  emails: [],
  emailsAsk: false,
  refusals: [],
};

/** Answer the open confirmation's read of what the org runs. */
async function nothingFires(page: Page): Promise<void> {
  await answerAll(page, 'dataops:automation', 'dataops:automation:response', NOTHING_FIRES);
}

/** Scan the page with axe, and fail on any violation. */
async function passesAxe(page: Page): Promise<void> {
  const results = await checkAccessibility(page);
  expect(results.violations.length, formatViolations(results.violations)).toBe(0);
}

const TEMPLATES = [
  {
    id: 'tpl-gdpr',
    name: 'GDPR Compliance',
    description: 'Anonymize all PII fields for GDPR compliance',
    complianceFramework: 'gdpr',
    rules: [{ fieldPattern: 'Contact.Email', ruleType: 'hash', description: 'Hash the email.' }],
  },
];

/** The coverage of an org whose contacts hold more rows than one backup does. */
const PAST_ONE_BACKUP = {
  templateId: 'tpl-gdpr',
  objects: [
    {
      objectApiName: 'Contact',
      count: 3_002,
      backedUp: 0,
      truncated: false,
      slicePlan: { objectApiName: 'Contact', size: 1_000, slices: 4 },
    },
  ],
  plan: {
    requests: 40,
    parts: { snapshots: 6, updates: 17, reads: 17 },
    bulkBatches: 0,
    diskBytes: 1_258_291,
    diskFree: 412 * 1024 ** 3,
    seconds: 190,
    apiBudget: { verdict: 'fits', remaining: 4_861_233, max: 5_000_000 },
  },
};

/** One slice as a run's end and a listing say it. */
function slice(index: number, state: string, over: Record<string, unknown> = {}) {
  return {
    index,
    objectApiName: 'Contact',
    snapshotId: `set-1-s000${index}`,
    rows: state === 'pending' ? 0 : 1_000,
    masked: state === 'masked' ? 1_000 : 0,
    refused: 0,
    deletedSince: 0,
    nothingToMask: 0,
    state,
    ...over,
  };
}

/** A set of slices of the org, as `backup:list` gives it. */
const SET = {
  setId: 'set-1',
  orgId: 'org-src-1',
  kind: 'masking',
  state: 'done',
  startedAt: '2026-11-14T08:00:00.000Z',
  lastActivityAt: '2026-11-14T09:00:00.000Z',
  size: 1_000,
  totalRecords: 3_002,
  templateId: 'tpl-gdpr',
  slices: [
    slice(1, 'masked'),
    slice(2, 'masked'),
    slice(3, 'masked'),
    slice(4, 'masked', { rows: 2, masked: 2 }),
  ],
};

/** Boot DataOps painted in `theme`, its backups and templates answered. */
async function openDataOps(
  page: Page,
  theme: Theme,
  list: Record<string, unknown> = { backups: [] },
): Promise<void> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await paintHostTheme(page, theme);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'dataops';
  });
  await page.goto('/');
  await bridge.seedOrgs(MOCK_ORGS);
  await answerAll(page, 'backup:list', 'backup:list:result', list);
  await answerAll(
    page,
    'dataops:anonymization-templates',
    'dataops:anonymization-templates:response',
    { templates: TEMPLATES },
  );
  await expect(page.getByTestId('backup-panel')).toBeVisible({ timeout: 10_000 });
}

/** Open the Anonymize tab on the template, the coverage answering `coverage`. */
async function pickTemplate(page: Page, coverage: Record<string, unknown>): Promise<void> {
  await page.getByTestId('page-tab-anonymize').click();
  await page.getByTestId('template-select').selectOption('tpl-gdpr');
  await answerAll(
    page,
    'dataops:anonymize:coverage',
    'dataops:anonymize:coverage:response',
    coverage,
  );
}

for (const theme of THEMES) {
  test.describe(`DataOps in slices (${theme})`, () => {
    test('Apply asks for the slices with the plan, says the slice as it goes and what the run left, each passing axe', async ({
      page,
    }) => {
      await openDataOps(page, theme);
      await pickTemplate(page, PAST_ONE_BACKUP);
      await expect(page.getByTestId('restore-coverage-slices-Contact')).toHaveText('4 slices');
      await expect(page.getByTestId('coverage-slice-plan-bulk')).toBeVisible();
      await passesAxe(page);

      await page.getByTestId('apply-btn').click();
      await page.getByTestId('danger-input').fill('DevSandbox');
      await nothingFires(page);
      await expect(page.getByTestId('confirm-slices-toggle')).not.toBeChecked();
      await expect(page.getByTestId('danger-held')).toContainText('Tick “Mask in slices”');
      await expect(page.getByTestId('danger-confirm-btn')).toBeDisabled();
      await expect(page.getByTestId('confirm-slices-lock')).toContainText(
        'a restore from the command line or from another window is not held off',
      );
      await passesAxe(page);

      await page.getByTestId('confirm-slices-toggle').check();
      await expect(page.getByTestId('danger-held')).toHaveCount(0);
      await page.getByTestId('danger-confirm-btn').click();
      const [run] = await outgoing(page, 'dataops:anonymize');
      expect(run.payload).toMatchObject({
        templateId: 'tpl-gdpr',
        snapshot: true,
        slices: true,
        fromPage: true,
      });

      await sendExtensionMessage(page, {
        type: 'operation:progress',
        id: 'progress-1',
        payload: {
          operationId: String(run.id),
          percentage: 30,
          processedRecords: 1_000,
          totalRecords: 3_002,
          currentStep: 'Backing up Contact slice 2 of about 4',
        },
      });
      await expect(page.getByTestId('anonymize-progress-step')).toHaveText(
        'Backing up Contact, slice 2 of about 4',
      );
      await passesAxe(page);

      await sendExtensionMessage(page, {
        type: 'dataops:anonymize:response',
        id: 'resp-run',
        correlationId: String(run.id),
        payload: {
          templateId: 'tpl-gdpr',
          status: 'partial',
          recordsProcessed: 2_000,
          recordsFailed: 0,
          recordsNotMasked: 1_002,
          objects: [],
          message: 'Stopped between slices.',
          errors: [],
          slices: {
            setId: 'set-1',
            size: 1_000,
            state: 'open',
            objects: [
              {
                objectApiName: 'Contact',
                slices: [slice(1, 'masked'), slice(2, 'masked'), slice(3, 'pending')],
              },
            ],
            lateRecords: 1,
            requestsSpent: 40,
            stoppedOnBudget: true,
            slicesLeft: true,
          },
        },
      });
      await expect(page.getByTestId('anonymize-slices-table')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('anonymize-slices-late')).toBeVisible();
      await expect(page.getByTestId('anonymize-open-set')).toBeVisible();
      await passesAxe(page);
    });

    test('a run left open holds Apply with its reason, and is given up only once asked, each passing axe', async ({
      page,
    }) => {
      await openDataOps(page, theme);
      await pickTemplate(page, {
        ...PAST_ONE_BACKUP,
        checkpoint: { id: 'ck-1', savedAt: '2026-11-14T10:00:00.000Z' },
        sliceSet: {
          setId: 'set-1',
          savedAt: '2026-11-14T10:00:00.000Z',
          done: 2,
          total: 4,
          state: 'open',
          size: 1_000,
        },
      });

      const apply = page.getByTestId('apply-btn');
      await expect(apply).toHaveAttribute('aria-disabled', 'true');
      await expect(apply).toHaveAccessibleDescription(
        /2 of 4 slices of up to 1,000 records masked/,
      );
      await expect(page.getByTestId('resume-btn')).toHaveText('Resume the run in slices');
      await passesAxe(page);

      await page.getByTestId('abandon-btn').click();
      await expect(page.getByTestId('danger-title')).toHaveText(
        'Abandon the run in slices of “GDPR Compliance” on DevSandbox?',
      );
      await passesAxe(page);
      await page.getByTestId('danger-confirm-btn').click();
      await expect
        .poll(async () =>
          (await outgoing(page, 'dataops:anonymize')).map(
            (m) => m.payload as Record<string, unknown>,
          ),
        )
        .toEqual([
          expect.objectContaining({ templateId: 'tpl-gdpr', abandon: true, fromPage: true }),
        ]);
    });

    test('Restore lists a set, opens its slices and restores one, each passing axe', async ({
      page,
    }) => {
      await openDataOps(page, theme, { backups: [], sets: [SET] });
      await page.getByTestId('page-tab-restore').click();
      await expect(page.getByTestId('restore-set-set-1')).toBeVisible();
      await page.getByTestId('restore-set-set-1-toggle').click();
      await expect(page.getByTestId('restore-set-set-1-slices')).toBeVisible();
      await passesAxe(page);

      await page.getByTestId('restore-set-set-1-slices-2-restore').click();
      await expect(page.getByTestId('danger-title')).toHaveText(
        /^Restore slice 2 of the set of .+ into DevSandbox\?$/,
      );
      await nothingFires(page);
      await expect(page.getByTestId('danger-held')).toHaveCount(0);
      await passesAxe(page);
      await page.getByTestId('danger-confirm-btn').click();
      const [restore] = await outgoing(page, 'dataops:rollback');
      expect(restore.payload).toMatchObject({ operationId: 'set-1', slices: [2], fromPage: true });
    });

    test('Restore badges a backup in slices that stopped part way as partial, says it, and passes axe', async ({
      page,
    }) => {
      const stopped = {
        ...SET,
        setId: 'set-2',
        kind: 'backup',
        state: 'partial',
        totalRecords: 2_000,
        slices: [slice(1, 'snapshotted', { masked: 0 }), slice(2, 'snapshotted', { masked: 0 })],
      };
      await openDataOps(page, theme, { backups: [], sets: [stopped] });
      await page.getByTestId('page-tab-restore').click();
      await expect(page.getByTestId('restore-set-set-2-state')).toHaveText('Partial');
      await expect(page.getByTestId('restore-set-set-2-partial')).toHaveText(
        'Stopped before every record was backed up: no run takes it up. Its slices restore as they are; a new backup in slices takes every record again.',
      );
      await expect(page.getByTestId('restore-set-set-2-all')).toBeEnabled();
      await passesAxe(page);
    });

    test('Backup offers slices for an object the last backup stopped at the cap for, and passes axe', async ({
      page,
    }) => {
      await openDataOps(page, theme, {
        backups: [
          {
            operationId: 'op-cap',
            orgId: 'org-src-1',
            timestamp: '2026-11-14T08:00:00.000Z',
            totalRecords: 1_000,
            totalSize: 0,
            status: 'completed',
            partial: true,
            objectResults: [
              {
                objectApiName: 'Contact',
                recordCount: 1_000,
                orgCount: 3_002,
                truncated: true,
                stoppedAt: 'cap',
              },
            ],
          },
        ],
      });
      await answerAll(page, 'backup:objects', 'backup:objects:response', { objects: ['Contact'] });
      const box = page.getByTestId('backup-slices-toggle');
      await expect(box).not.toBeChecked();
      await passesAxe(page);

      await box.check();
      await page.getByTestId('create-backup-btn').click();
      const [backup] = await outgoing(page, 'backup:execute');
      expect(backup.payload).toMatchObject({ objects: ['Contact'], slices: true });
    });
  });
}
