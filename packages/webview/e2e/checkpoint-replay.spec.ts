import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type {
  CheckpointListEntry,
  CheckpointReplaySummary,
  FrozenLoadPlanInfo,
  FrozenLoadReportInfo,
  FrozenRemovalResult,
  FrozenReplayInfo,
  OrgCheckpoint,
} from '@sandforge/shared';
import { MockBridge, checkAccessibility, formatViolations } from './helpers';
import { themeContrastShortfalls } from './helpers/theme-contrast';
import { MOCK_ORGS } from './fixtures';
import { CHECKPOINT_ORG, daysFromNow, listEntry, readyCheckpoint } from './fixtures/checkpoints';
import { VSCODE_DEFAULT_STYLES } from './fixtures/vscode-default-styles';
import { hostColours, vscodeTheme } from '../src/styles/testing/vscodeThemes';

/**
 * A checkpoint replayed in another org, drawn in Chromium the way the host
 * draws a webview: the row of a checkpoint of the sandbox before its refresh,
 * which rewinds nothing and replays elsewhere; the replay's view on that
 * sandbox; a simulation refused for real data, and the box that lifts it; the
 * plan, with what the org runs as the replay writes; the replay under way;
 * what it did; and its removal, confirmed by the org's name, named by the
 * checkpoint's replays.
 *
 * Every state is scanned with axe under VS Code's default themes, Light 2026
 * and Dark 2026, and the two they replaced, with the stylesheet VS Code
 * prepends to every webview, and held to the theme's own contrast.
 */
const THEMES = ['Light 2026', 'Dark 2026', 'Light Modern', 'Dark Modern'] as const;
type Theme = (typeof THEMES)[number];

/** The sandbox the checkpoint was of, as the page names it: refreshed since. */
const ORG = CHECKPOINT_ORG.alias;

/** The checkpoint's org as its take read it: a Partial Copy, by its data storage. */
const SOURCE_ORGANIZATION = '00Dxx0000001234AAA';

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
 * The extension's side of the bridge, as the spec plays it: each request the
 * page sends is answered once, correlated to it. A development build mounts
 * the panel twice, so a query can be asked twice; both are answered.
 */
class Extension {
  private readonly answered = new Set<string>();

  constructor(readonly bridge: MockBridge) {}

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

  /** Every request of `type` the page sent, answered or not. */
  async sent(type: string): Promise<Record<string, unknown>[]> {
    return this.bridge.getMessages(type);
  }
}

/** Open Checkpoints on the dev sandbox, its checkpoints listed. */
async function openCheckpoints(
  page: Page,
  theme: Theme,
  checkpoints: CheckpointListEntry[],
): Promise<Extension> {
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
  await host.answer('checkpoint:list', { checkpoints });
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

/** The page as painted passes axe and the theme's own contrast; with `opened`, axe measured text in it. */
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

/** A checkpoint of a Partial Copy sandbox, taken before its refresh. */
function partialCopyCheckpoint(): OrgCheckpoint {
  const base = readyCheckpoint({ checkpointId: 'ck-refreshed', name: 'Before the refresh' });
  return { ...base, org: { ...base.org, dataStorageMaxMB: 5120 } };
}

/** The checkpoint as the list reads it, of the sandbox before its refresh, with its replays. */
function refreshedEntry(replays?: CheckpointListEntry['replays']): CheckpointListEntry {
  return listEntry(partialCopyCheckpoint(), {
    valid: false,
    why: 'refreshed',
    refreshedAt: daysFromNow(-1),
    ...(replays ? { replays } : {}),
  });
}

/** What the replay says beside its plan and its report. */
function replayInfo(): FrozenReplayInfo {
  const summary: CheckpointReplaySummary = {
    records: { toCreate: 2412, linkedById: 0, linkedByKey: 0, refusedBeforeWrite: 12 },
    owners: {
      kept: 0,
      toRunningUser: 2412,
      reasons: { notInTarget: 2412, inactive: 0, queueMissing: 0 },
    },
    recordTypes: [{ object: 'Account', recordType: 'Retail', outcome: 'default', records: 400 }],
    notReplayed: [],
    lookupsEmptied: [{ field: 'Case.AssetId', records: 30, reason: 'objectNotHeld' }],
    refused: [{ object: 'OpportunityLineItem', records: 12, reason: 'inactiveCurrency' }],
    fieldsNotInTarget: [],
    currencies: { refused: [{ code: 'GBP', records: 12 }] },
    masked: { fields: ['Contact.Email', 'Contact.LastName'], unmaskedFreeText: ['Case.Subject'] },
    contactPoints: 'neutralized',
    degraded: ['recordTypes', 'users', 'queues', 'standardPricebook'],
    auditDates: 'new',
  };
  return {
    checkpoint: {
      checkpointId: 'ck-refreshed',
      name: 'Before the refresh',
      organizationId: SOURCE_ORGANIZATION,
      takenAt: daysFromNow(-2),
      tier: 'sandbox',
      annex: false,
    },
    target: { organizationId: '00Dxx0000009999AAA', name: ORG },
    choices: {
      owners: 'same',
      customSettings: false,
      mask: true,
      contactPoints: 'neutralized',
      objects: [],
      excluded: [],
      link: [],
    },
    summary,
    filesLeft: [],
    storage: { estimateMB: 4.8, remainingMB: 180, maxMB: 200 },
    requests: 6,
  };
}

/** One object of the plan. */
function planned(objectApiName: string, toInsert: number): FrozenLoadPlanInfo['perObject'][number] {
  return {
    objectApiName,
    fromFiles: toInsert,
    toInsert,
    reusedByKeys: 0,
    reusedFromCatalog: 0,
    fieldsDropped: 0,
    picklistsRewritten: 0,
    notSent: 0,
    toPurge: 0,
    toDeactivate: 0,
  };
}

/** What the simulation answers: the replay's plan, and what the org runs as it writes. */
function planAnswer(): { plan: FrozenLoadPlanInfo; replay: FrozenReplayInfo } {
  return {
    plan: {
      orgId: CHECKPOINT_ORG.id,
      mode: { pilot: false, reload: false },
      plannedAt: daysFromNow(0),
      perObject: [
        planned('Account', 400),
        planned('Contact', 2012),
        { ...planned('OpportunityLineItem', 0), notSent: 12 },
      ],
      excludedObjects: [],
      removals: [],
      placeholders: [],
      requiredDefaults: [],
      recordTypeIssues: 0,
      personContacts: 0,
      earlierLoads: 0,
      automation: {
        firing: [
          { objectApiName: 'Contact', kind: 'flow', name: 'Contact welcome', writes: ['insert'] },
        ],
        accepted: false,
        refused: { code: 'AUTOMATION_NOT_ACCEPTED', message: 'host words' },
      },
    },
    replay: replayInfo(),
  };
}

/** One object of the report. */
function wrote(objectApiName: string, inserted: number): FrozenLoadReportInfo['perObject'][number] {
  return {
    objectApiName,
    fromFiles: inserted,
    inserted,
    reused: 0,
    skippedDuplicates: [],
    failed: [],
  };
}

/** What the replay answers once it wrote all it was to. */
function reportAnswer(): { report: FrozenLoadReportInfo; replay: FrozenReplayInfo } {
  return {
    report: {
      status: 'completed',
      orgId: CHECKPOINT_ORG.id,
      mode: { pilot: false, reload: false },
      startedAt: daysFromNow(0),
      durationMs: 42_000,
      alignment: { excludedObjects: [], removals: [], adjustments: [], recordTypeIssues: [] },
      placeholders: [],
      requiredDefaults: [],
      perObject: [wrote('Account', 400), wrote('Contact', 2012)],
      pass2: { resolved: 0, unresolved: [] },
      personContact: { restored: 0, unresolved: [] },
      purge: { deleted: {}, deactivated: {}, failures: [] },
      mappingPath: 'mapping',
      contractPath: 'contract',
    },
    replay: replayInfo(),
  };
}

/** The replay into the refreshed sandbox, as the list read again names it. */
function inPlace(loadedAt: string): CheckpointListEntry['replays'] {
  return [
    {
      target: { organizationId: '00Dxx0000009999AAA', name: ORG, orgId: CHECKPOINT_ORG.id },
      replayedAt: loadedAt,
      inPlace: 2412,
      records: {
        orgId: CHECKPOINT_ORG.id,
        loadedAt,
        created: [
          { objectApiName: 'Contact', count: 2012 },
          { objectApiName: 'Account', count: 400 },
        ],
        linked: 0,
        recorded: true,
      },
    },
  ];
}

/** What the removal of the replay did: every record it created gone. */
const REMOVED: FrozenRemovalResult = {
  status: 'success',
  includeChanged: false,
  finishedAt: daysFromNow(0),
  objects: [
    {
      objectApiName: 'Contact',
      planned: 2012,
      deleted: 2012,
      alreadyGone: 0,
      keptChanged: 0,
      keptDependents: 0,
      refused: 0,
      heldBy: [],
      unchecked: [],
      reasons: [],
    },
    {
      objectApiName: 'Account',
      planned: 400,
      deleted: 400,
      alreadyGone: 0,
      keptChanged: 0,
      keptDependents: 0,
      refused: 0,
      heldBy: [],
      unchecked: [],
      reasons: [],
    },
  ],
};

for (const theme of THEMES) {
  test.describe(`Checkpoint replay (${theme})`, () => {
    test.describe.configure({ timeout: 120_000 });

    test('replays a checkpoint of the sandbox before its refresh into it: the simulation, a refusal for real data and its box, the replay, its result and its removal', async ({
      page,
    }) => {
      const host = await openCheckpoints(page, theme, [refreshedEntry()]);
      await expect(page.getByTestId('checkpoint-elsewhere-ck-refreshed')).toHaveText(
        'It no longer brings its org back, and it replays in another org: its records are created there again, with new Ids.',
      );
      await expect(page.getByTestId('checkpoint-rewind-ck-refreshed')).toHaveCount(0);
      await expectReadable(page, theme, '[data-testid="checkpoint-list"]');

      await page.getByTestId('checkpoint-replay-ck-refreshed').click();
      await expect(
        page.getByRole('heading', { name: 'Replay “Before the refresh” in another org' }),
      ).toBeFocused();
      await expect(page.getByTestId('checkpoint-replay-refreshed')).toContainText(
        `${ORG} is the sandbox this checkpoint was taken of, refreshed on`,
      );
      // Masking is ticked for a Partial Copy's checkpoint, and Replay waits for a simulation.
      await expect(page.getByTestId('checkpoint-replay-mask')).toBeChecked();
      await expect(page.getByTestId('checkpoint-replay-run')).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      await expectReadable(page, theme, '[data-testid="checkpoint-replay"]');

      // Unmasked, the extension refuses it, and the refusal names the box.
      await page.getByTestId('checkpoint-replay-mask').uncheck();
      await page.getByTestId('checkpoint-replay-simulate').click();
      const refusedAsk = await host.answer(
        'frozen:load:preview',
        {
          code: 'REPLAY_REAL_DATA',
          message: 'host words',
          retryable: false,
          params: { checkpoint: 'Before the refresh', target: ORG, why: 'storage', mb: 5120 },
        },
        'frozen:load:preview:error',
      );
      expect(refusedAsk.payload).toMatchObject({
        targetOrgId: CHECKPOINT_ORG.id,
        replay: {
          organizationId: SOURCE_ORGANIZATION,
          checkpointId: 'ck-refreshed',
          choices: { mask: false },
        },
      });
      await expect(page.getByTestId('checkpoint-replay-refused')).toContainText(
        'goes into another org masked only, and nothing was written. Tick Mask personal data, then simulate again.',
      );
      await expectReadable(page, theme, '[data-testid="checkpoint-replay-refused"]');

      // Masked, the simulation says what the replay does and does not.
      await page.getByTestId('checkpoint-replay-mask').check();
      await page.getByTestId('checkpoint-replay-simulate').click();
      await host.answer('frozen:load:preview', planAnswer());
      await expect(page.getByTestId('checkpoint-replay-plan-line-records')).toHaveText(
        `Creates copies of 2,412 of its records in ${ORG}, parents first, with new Ids; nothing ${ORG} holds is changed or deleted.`,
      );
      await expect(page.getByTestId('checkpoint-replay-plan-line-currency-GBP')).toContainText(
        'GBP (12)',
      );
      await expect(page.getByTestId('checkpoint-replay-plan-automation-verdict')).toContainText(
        'A replay would be refused',
      );
      await expect(page.getByTestId('checkpoint-replay-plan')).not.toContainText(/dataset/i);
      await expectReadable(page, theme, '[data-testid="checkpoint-replay-plan"]');

      // The box the plan names, then the replay, held to the count simulated.
      await page.getByTestId('checkpoint-replay-accept-automation').check();
      await page.getByTestId('checkpoint-replay-run').click();
      const replay = await host.asked('frozen:load');
      expect(replay.payload).toEqual({
        targetOrgId: CHECKPOINT_ORG.id,
        replay: {
          organizationId: SOURCE_ORGANIZATION,
          checkpointId: 'ck-refreshed',
          choices: {
            owners: 'same',
            customSettings: false,
            mask: true,
            contactPoints: 'neutralized',
            objects: [],
            excluded: [],
            link: [],
          },
        },
        acceptAutomation: true,
        maxRecords: 2412,
      });
      await host.bridge.respond(
        'frozen:load:progress',
        { phase: 'insert', objectName: 'Contact', status: 'started', progress: 55, message: 'x' },
        String(replay.id),
      );
      await expect(page.getByTestId('checkpoint-replay-running')).toContainText(
        `Replaying into ${ORG}: Contact…`,
      );
      await expectReadable(page, theme, '[data-testid="checkpoint-replay-running"]');

      const loadedAt = daysFromNow(0);
      await host.answer('frozen:load', reportAnswer());
      await expect(page.getByTestId('checkpoint-replay-result-status')).toHaveText(
        'The replay wrote what it was to.',
      );
      // The list read again names the replay, and its removal.
      await host.answer('checkpoint:list', { checkpoints: [refreshedEntry(inPlace(loadedAt))] });
      await expect(page.getByTestId('checkpoint-replay-replays-00Dxx0000009999AAA')).toContainText(
        '2,412 records still there.',
      );
      await expect(page.getByRole('heading', { name: 'Last replay' })).toBeVisible();
      await expectReadable(page, theme, '[data-testid="checkpoint-replay-result"]');

      // Removed by the org's name typed, from the mapping of the checkpoint's replays.
      await page.getByTestId('frozen-removal-remove').click();
      await expect(page.getByTestId('danger-title')).toHaveText(`Remove this replay from ${ORG}`);
      await host.answer('frozen:remove:automation', {
        loadedAt,
        automation: { objectsRead: ['Contact', 'Account'], objects: [], unread: [] },
        steps: { setToDraft: [], delete: ['Contact', 'Account'] },
      });
      await expectReadable(page, theme, '[role="dialog"]');
      await page.getByTestId('danger-input').fill(ORG);
      await page.getByTestId('danger-confirm-btn').click();
      const removal = await host.asked('frozen:remove');
      expect(removal.payload).toEqual({
        targetOrgId: CHECKPOINT_ORG.id,
        loadedAt,
        replay: { organizationId: SOURCE_ORGANIZATION, checkpointId: 'ck-refreshed' },
      });
      await host.answer('frozen:remove', { result: REMOVED, operationId: 'op-remove-1' });
      await expect(page.getByTestId('frozen-removal-error')).toHaveCount(0);
      expect(await host.sent('frozen:remove')).toHaveLength(1);
    });
  });
}
