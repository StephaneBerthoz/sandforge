import { test } from '@playwright/test';
import path from 'path';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'url';

import {
  RECOVERY_PREPARATION_IDS,
  RECOVERY_REASON_STATUS,
  RECOVERY_STEP_IDS,
  recoveryProgressOf,
  recoveryStatusSchema,
  recoveryUsersListSchema,
  usersPlanAnswerSchema,
} from '@sandforge/shared';
import type {
  CheckpointListEntry,
  CheckpointPreviewResponse,
  RecoveryReason,
  RecoveryStatus,
  RecoveryStepId,
} from '@sandforge/shared';
import { MockBridge } from './helpers';
import { encodeGif, type GifFrame } from './helpers/gifEncoder';
import { readPng } from './helpers/readPng';
import { MOCK_ORGS } from './fixtures';
import { diffObject, listEntry, readyCheckpoint, USERS } from './fixtures/checkpoints';
import { RECOVERY_ORG } from './fixtures/recovery';
import { VSCODE_DEFAULT_STYLES } from './fixtures/vscode-default-styles';
import { sendExtensionMessage } from './mocks/vscode-api';
import { hostColours, vscodeTheme } from '../src/styles/testing/vscodeThemes';

/**
 * Marketplace screenshot generator.
 *
 * Excluded from the regular E2E suite. Regenerate on demand:
 *
 *   SCREENSHOTS=1 npx playwright test screenshots.spec.ts
 *
 * Output lands in assets/screenshots/ at the repo root — the stills, and
 * `forge-flow.gif`, the animation the listing opens on — and
 * `scripts/check-screenshots.mjs` fails the release if what ships no longer
 * matches what this file produces.
 *
 * Each shot boots one module panel directly (`__SANDFORGE_MODULE__`) because
 * that is how the extension opens them — there has been no in-app navigation
 * sidebar since 1.8.0. The previous version of this file clicked through that
 * sidebar, which is why the shipped screenshots showed a UI that no longer
 * exists.
 *
 * One caveat for whoever runs the command above: `seed.png` does not reproduce
 * byte for byte. Sixteen consecutive runs of the unmodified generator produced
 * seven distinct files, all differing only in a few pixels of corner
 * antialiasing on the template gallery's container — the block lands on a
 * fractional offset when the machine is loaded. It is a real gap in this
 * generator, unrelated to the Monitor work below and not yet chased down; until
 * it is, a `seed.png` that comes back changed after a regeneration that touched
 * nothing is noise, and `git checkout` on it is the right answer.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCREENSHOT_DIR = path.resolve(__dirname, '../../../assets/screenshots');
const VIEWPORT = { width: 1280, height: 800 };

/**
 * The launcher's width: VS Code opens its sidebar about this wide, and the
 * launcher is laid out for it — at the panel's 1280 it is a column of buttons
 * across an empty screen.
 */
const LAUNCHER_WIDTH = 300;

/**
 * Review's width. Its six tabs, three of them with a count, need about 545
 * pixels, and the tab panel is 40 % of the page: at 1280 the Gaps tab ran past
 * the panel's border, and selecting it scrolled the whole page sideways. 1440
 * is an editor beside the sidebar on a 1920 screen.
 */
const REVIEW_WIDTH = 1440;

/**
 * The instant every shot is taken at.
 *
 * Monitor reads the wall clock for its header's "Data read … ago", its trend
 * axis and the jobs it marks recent, so every regeneration caught other words
 * and monitor.png came back byte-different from an unchanged UI — a permanent
 * line in every diff carrying no information, on the one gate meant to notice
 * when the pictures stop matching the product.
 *
 * The instant is the afternoon of the day MOCK_HEALTH's jobs were created, so
 * the dashboard reads as one moment: jobs started earlier today, still running.
 * It sits five days after the 2026 Pacific DST switch — far enough from the
 * boundary that the countdown does not depend on which tzdata a machine ships.
 */
const FIXED_NOW = new Date('2026-03-13T18:31:23Z');

/**
 * Answer "what time is it now" from FIXED_NOW, and change nothing else.
 *
 * `page.clock.setFixedTime` is the documented tool and it does pin the clock.
 * It is not, however, the narrow instrument its one-line description suggests:
 * the first `page.clock` call of any kind installs the whole fake-timer
 * machinery, which also replaces `setTimeout`, `setInterval`, `performance.now`
 * and `requestAnimationFrame` (playwright-core's `clockSource`, `addTimer`,
 * type `AnimationFrame`). Frame callbacks then arrive from a sync timer rather
 * than from the compositor. Everything a screenshot generator is still fighting
 * at this point is animation-frame timing, so widening the intervention to the
 * frame loop in order to answer a question about `Date` is the wrong trade.
 *
 * Subclassing `Date` touches exactly the surface those reads use.
 * `Date.parse`, `Date.UTC` and every instance method are inherited untouched,
 * and `new Date(iso)` — the jobs table, the backup list — still parses what it
 * is given. Only the no-argument forms are answered from the fixture.
 */
async function freezeClock(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript((millis: number) => {
    const RealDate = Date;
    class FixedDate extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) {
          super(millis);
        } else {
          super(...(args as [number]));
        }
      }
      static now(): number {
        return millis;
      }
    }
    (globalThis as unknown as Record<string, unknown>).Date = FixedDate;
  }, FIXED_NOW.getTime());
}

/**
 * Where the run records which generator produced these images.
 *
 * The staleness check used to read git history, and git cannot answer the
 * question: a regeneration that produces byte-identical images — the best case,
 * meaning the UI did not move — commits nothing, so the images keep their old
 * commit and the gate calls the freshest possible output stale. It said so
 * twice, and a gate that cries wolf is one people stop reading.
 *
 * So the generator states it instead. This file holds a hash of the generator's
 * own source, normalised past the changes a formatter may make, written on
 * every run whether the images changed or not.
 */
const STAMP_FILE = path.resolve(SCREENSHOT_DIR, '.generated-from');

/** Hash of this file's source, ignoring formatting. */
function generatorFingerprint(): string {
  const source = readFileSync(__filename, 'utf8')
    .replace(/'/g, '"')
    .replace(/,(\s*[)\]}])/g, '$1')
    .replace(/\s+/g, '');
  return createHash('sha256').update(source).digest('hex').slice(0, 16);
}

/**
 * Paint the panel as VS Code paints it under Light 2026, the theme a new
 * install opens on: the host's colours on `<html>`, and the stylesheet it
 * prepends to every webview.
 */
async function paintLightHost(page: import('@playwright/test').Page): Promise<void> {
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
    { colours: hostColours(vscodeTheme('Light 2026')), defaultStyles: VSCODE_DEFAULT_STYLES },
  );
}

/** Boot the app straight into one module panel, orgs already connected. */
async function openModule(
  page: import('@playwright/test').Page,
  moduleId: string,
): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  // Before goto: the clock has to be in place for the first render, not just
  // for the ticks after it.
  await freezeClock(page);
  await paintLightHost(page);
  await page.addInitScript((id) => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = id;
  }, moduleId);
  await page.goto('/');
  await bridge.seedOrgs(MOCK_ORGS);
  return bridge;
}

/**
 * Answer *every* pending request of a type, not just the first.
 *
 * React StrictMode mounts effects twice in dev, so a panel can have two
 * in-flight queries of the same type with different ids; answering only the
 * first leaves the live one hanging and the panel stuck on its skeleton.
 */
async function respondToAll(
  page: import('@playwright/test').Page,
  requestType: string,
  responseType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const ids = await page.evaluate((type) => {
    const msgs = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
    return msgs
      .map((m) => {
        const e = m as Record<string, unknown>;
        return (e.payload as Record<string, unknown> | undefined) ?? e;
      })
      .filter((m) => m.type === type)
      .map((m) => m.id as string);
  }, requestType);

  for (const correlationId of ids) {
    await sendExtensionMessage(page, {
      type: responseType,
      id: `resp-${correlationId}`,
      correlationId,
      payload,
    });
  }
}

/**
 * Shrink the viewport to the height the panel actually renders, then shoot.
 *
 * A fixed 1280x800 spent between 10% and 29% of every image on empty
 * background, and the Marketplace scales the whole thing down to fit its
 * carousel — so the padding is paid for twice: once in dead pixels, once in
 * the legibility of what is left.
 *
 * The obvious measurement is wrong. `main.scrollHeight` is clamped to the
 * element's own `clientHeight` when the element is the scroll container, so it
 * answers 800 for content that ends at 570. The panel's first child is not a
 * scroll container and reports its real height.
 *
 * Recharts restarts its 1500 ms entry animation on resize, so the second
 * settle is not belt-and-braces — without it Monitor shoots mid-animation.
 *
 * Some shots need more than the design viewport. A Forge run's results end
 * on what can be done with the run — verify it, remove what it wrote — below
 * everything it reports, and Review's rows run past the viewport: cut at 800
 * pixels, both pictures lost their foot. Those shots grow to `maxHeight`, the
 * panel still the measure. The launcher is no
 * module panel: it fills the sidebar's height whatever it holds, so what it
 * holds is measured, by where its last block ends. The width is whatever the
 * test set.
 *
 * A page longer than any picture of it ends on a block of its own: `foot`
 * names it, and the shot stops where the block after it starts, so the cut
 * falls between two blocks and through none. Back into service runs to some
 * 2,300 pixels with its users open; a picture of all of it, scaled down to the
 * carousel, could not be read.
 *
 * Every shot starts at the top of its panel. Playwright scrolls each control
 * into view to click it, and a panel taller than its shot kept that scroll:
 * Sync, once its delta and file options grew the page past its ceiling, came
 * out without its title, scrolled to the object rows its last click added.
 * A panel that outgrows its ceiling now loses its foot, not its head.
 */
async function shoot(
  page: import('@playwright/test').Page,
  name: string,
  options: { maxHeight?: number; launcher?: boolean; foot?: string } = {},
): Promise<void> {
  const maxHeight = options.maxHeight ?? VIEWPORT.height;
  const height = await page.evaluate(
    ({ launcher, foot }) => {
      if (launcher) {
        const root = document.querySelector('[data-testid="sidepanel-root"]');
        const last = root?.lastElementChild as HTMLElement | null | undefined;
        return last ? Math.ceil(last.getBoundingClientRect().bottom) : 0;
      }
      const panel = document.querySelector('[data-testid="panel-app"]');
      if (foot) {
        panel?.scrollTo(0, 0);
        const block = document.querySelector(foot);
        if (!block) return 0;
        const next = block.nextElementSibling;
        // The last block of its list keeps the panel's own padding under it.
        return next
          ? Math.floor(next.getBoundingClientRect().top)
          : Math.ceil(block.getBoundingClientRect().bottom + 16);
      }
      const content = panel?.firstElementChild as HTMLElement | null | undefined;
      return content ? Math.ceil(content.getBoundingClientRect().height) : 0;
    },
    { launcher: options.launcher === true, foot: options.foot ?? null },
  );

  // Never grow past the shot's ceiling, and keep a floor so a panel that
  // measures oddly still produces a usable image rather than a sliver.
  const { width, height: current } = page.viewportSize() ?? VIEWPORT;
  if (height > 0 && Math.min(height, maxHeight) !== current) {
    await page.setViewportSize({ width, height: Math.max(Math.min(height, maxHeight), 360) });
    await settle(page);
  }
  await page.evaluate(() => document.querySelector('[data-testid="panel-app"]')?.scrollTo(0, 0));

  // `animations: 'disabled'` cancels infinite CSS animations back to their
  // first frame instead of catching whichever frame the capture landed on.
  // Monitor's "connected" dot carries `animate-pulse`, and a frozen clock does
  // not cover it — the pulse is CSS, driven by the compositor rather than by
  // `Date.now()`. With the clock pinned and this option removed, four
  // consecutive monitor runs produced four different files, differing in
  // exactly the ten-by-ten pixels of that dot and nowhere else.
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png`, animations: 'disabled' });
  stampGenerator();
}

/** Record that this version of the generator produced what is on disk. */
function stampGenerator(): void {
  writeFileSync(STAMP_FILE, `${generatorFingerprint()}\n`);
}

/**
 * Let entry animations and layout settle before capturing.
 *
 * Long enough to outlast Recharts' 1500ms default entry animation — a shorter
 * wait catches the donut mid-sweep as a partial off-centre arc.
 */
async function settle(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForTimeout(2500);
}

const MOCK_HEALTH = {
  healthScore: 85,
  healthReport: null,
  jobs: [
    {
      id: 'job-1',
      jobType: 'BulkQuery',
      status: 'InProgress',
      objectType: 'Account',
      createdBy: 'admin@sandbox.com',
      createdDate: '2026-03-13T10:00:00Z',
      totalRecords: 5000,
      processedRecords: 2500,
      failedRecords: 0,
    },
    {
      id: 'job-2',
      jobType: 'BulkUpsert',
      status: 'Completed',
      objectType: 'Contact',
      createdBy: 'admin@sandbox.com',
      createdDate: '2026-03-13T09:00:00Z',
      totalRecords: 1200,
      processedRecords: 1200,
      failedRecords: 3,
    },
    {
      id: 'job-3',
      jobType: 'BulkDelete',
      status: 'InProgress',
      objectType: 'Lead',
      createdBy: 'dev@sandbox.com',
      createdDate: '2026-03-13T11:00:00Z',
      totalRecords: 800,
      processedRecords: 400,
      failedRecords: 0,
    },
  ],
  limits: [
    { name: 'DailyApiRequests', max: 100000, remaining: 45000, usedPercent: 55 },
    { name: 'DataStorageMB', max: 5120, remaining: 3072, usedPercent: 40 },
    { name: 'DailyBulkApiRequests', max: 15000, remaining: 14500, usedPercent: 3.3 },
    { name: 'ConcurrentAsyncGetReportInstances', max: 200, remaining: 195, usedPercent: 2.5 },
    { name: 'DailyStreamingApiEvents', max: 200000, remaining: 180000, usedPercent: 10 },
    { name: 'FileStorageMB', max: 10240, remaining: 8192, usedPercent: 20 },
  ],
  orgInfo: {
    orgId: '00D000000000001',
    name: 'DevSandbox',
    edition: 'Enterprise',
    instanceName: 'CS42',
    apiVersion: '60.0',
    userCount: 25,
    customObjectCount: 45,
    apexClassCount: 120,
    flowCount: 30,
    isHyperforce: false,
  },
  trends: {},
  alerts: [],
  activeAlertsCount: 2,
};

/**
 * The dev sandbox's backups, the day before FIXED_NOW and the day before
 * that: Masking says when the latest was taken, and a date past the frozen
 * clock would picture a backup from the future. The latest holds every row
 * of the objects GDPR Standard masks, as MOCK_STORAGE counts them.
 */
const MOCK_BACKUPS = {
  backups: [
    {
      operationId: 'op-2026-03-12-1',
      orgId: 'org-src-1',
      timestamp: '2026-03-12T09:14:00Z',
      totalRecords: 2500,
      totalSize: 3_706_000,
      status: 'completed',
      objectResults: [
        { objectApiName: 'Account', recordCount: 500 },
        { objectApiName: 'Contact', recordCount: 1200 },
        { objectApiName: 'Lead', recordCount: 800 },
      ],
    },
    {
      operationId: 'op-2026-03-11-2',
      orgId: 'org-src-1',
      timestamp: '2026-03-11T17:02:00Z',
      totalRecords: 1250,
      totalSize: 1_940_000,
      status: 'completed',
      objectResults: [
        { objectApiName: 'Lead', recordCount: 800 },
        { objectApiName: 'Case', recordCount: 450 },
      ],
    },
  ],
};

/** A masking rule: its `Object.Field`, its method, and what it does. */
const maskingRule = (fieldPattern: string, ruleType: string, description: string) => ({
  fieldPattern,
  ruleType,
  description,
});

/**
 * Masking templates, as `dataops:anonymization-templates:response` lists the
 * ones that ship: GDPR Standard with its rules as it ships them, and two
 * others the picker offers beside it. Answered with none, the tab DataOps
 * opens on showed "No templates available", which no install ever shows.
 */
const MOCK_MASKING_TEMPLATES = {
  templates: [
    {
      id: 'tpl-gdpr-standard',
      name: 'GDPR Standard',
      description:
        'Standard GDPR compliance: anonymize personal data fields across common Salesforce objects.',
      complianceFramework: 'gdpr',
      rules: [
        maskingRule('Contact.FirstName', 'fake', 'Replace with fake first name.'),
        maskingRule('Contact.LastName', 'fake', 'Replace with fake last name.'),
        maskingRule('Contact.Email', 'fake', 'Replace with fake email address.'),
        {
          ...maskingRule('Contact.Phone', 'mask', 'Mask phone number (keep last 4 digits).'),
          config: { maskKeepLast: 4 },
        },
        maskingRule('Contact.MailingStreet', 'fake', 'Replace with fake street address.'),
        maskingRule('Contact.MailingCity', 'fake', 'Replace with fake city.'),
        maskingRule('Contact.MailingPostalCode', 'mask', 'Mask postal code.'),
        maskingRule('Lead.FirstName', 'fake', 'Replace with fake first name.'),
        maskingRule('Lead.LastName', 'fake', 'Replace with fake last name.'),
        maskingRule('Lead.Email', 'fake', 'Replace with fake email address.'),
        maskingRule('Lead.Phone', 'mask', 'Mask phone number.'),
        maskingRule('Lead.Street', 'fake', 'Replace with fake street address.'),
        maskingRule('Account.BillingStreet', 'fake', 'Replace with fake address.'),
        maskingRule('Account.Phone', 'mask', 'Mask phone number.'),
      ],
    },
    {
      id: 'tpl-ccpa-california',
      name: 'CCPA California',
      description:
        'CCPA compliance: anonymize consumer personal information per California privacy regulations.',
      complianceFramework: 'ccpa',
      rules: [maskingRule('Contact.Email', 'hash', 'Hash email for pseudonymization.')],
    },
    {
      id: 'tpl-sandbox-scrub',
      name: 'Sandbox Data Scrub',
      description: 'General-purpose sandbox data scrubbing: mask all PII for safe development use.',
      complianceFramework: 'custom',
      rules: [maskingRule('Contact.FirstName', 'fake', 'Fake first name.')],
    },
  ],
};

/**
 * What a restore of the latest backup can bring back of what GDPR Standard
 * masks, as `dataops:anonymize:coverage` answers it: every row of each
 * object, said before Apply masks them for good.
 */
const MOCK_MASKING_COVERAGE = {
  templateId: 'tpl-gdpr-standard',
  backup: {
    operationId: MOCK_BACKUPS.backups[0].operationId,
    timestamp: MOCK_BACKUPS.backups[0].timestamp,
  },
  objects: MOCK_BACKUPS.backups[0].objectResults.map(({ objectApiName, recordCount }) => ({
    objectApiName,
    count: recordCount,
    backedUp: recordCount,
    truncated: false,
  })),
};

const MOCK_STORAGE = {
  success: true,
  totalRecords: 3250,
  objects: [
    { objectName: 'Contact', label: 'Contact', recordCount: 1200 },
    { objectName: 'Lead', label: 'Lead', recordCount: 800 },
    { objectName: 'Account', label: 'Account', recordCount: 500 },
    { objectName: 'Case', label: 'Case', recordCount: 450 },
    { objectName: 'Opportunity', label: 'Opportunity', recordCount: 300 },
  ],
};

/**
 * Saved templates, as `seed:template:list:response` returns them.
 *
 * The gallery merges these with the three pre-built templates the extension
 * ships, so answering `{ templates: [] }` would still fill — but it would
 * picture a product nobody has ever used, and the saved half of the gallery
 * (the half a team actually builds) would never appear in the listing.
 */
const MOCK_SEED_TEMPLATES = {
  templates: [
    {
      id: 'tpl-uat-refresh',
      name: 'UAT refresh set',
      description:
        'Accounts, their contacts and a spread of open opportunities — what the UAT sandbox needs back after every refresh.',
      tags: ['uat', 'shared'],
      updatedAt: '2026-08-28T14:20:00Z',
      objectCount: 4,
      totalRecords: 1450,
    },
    {
      id: 'tpl-support-bench',
      name: 'Support console bench',
      description:
        'Cases across every status with the contacts behind them, so the Service Console has something to open.',
      tags: ['service'],
      updatedAt: '2026-09-02T08:05:00Z',
      objectCount: 3,
      totalRecords: 900,
    },
  ],
};

/**
 * Objects a `sync:describe-global` answers with — API names only, per the
 * contract. Long enough that the "Add Object" picker reads like a real org's
 * describe rather than a fixture with room for three.
 */
const MOCK_SYNC_OBJECTS = {
  objects: [
    'Account',
    'Asset',
    'Campaign',
    'CampaignMember',
    'Case',
    'Contact',
    'Contract',
    'Event',
    'Lead',
    'Opportunity',
    'OpportunityLineItem',
    'Order',
    'Pricebook2',
    'PricebookEntry',
    'Product2',
    'Quote',
    'Task',
  ],
};

/** A day, in milliseconds. */
const DAY_MS = 86_400_000;

/**
 * The instant `days` from FIXED_NOW.
 *
 * The checkpoint fixtures date from the moment a spec runs, since the page
 * says each checkpoint's age and expiry from now. These shots run under a
 * clock frozen at FIXED_NOW, against which a checkpoint dated from the real
 * now reads as taken months ahead: every date the shots hand the page is set
 * from here instead.
 */
const fromFixedNow = (days: number): string =>
  new Date(FIXED_NOW.getTime() + days * DAY_MS).toISOString();

/**
 * The checkpoint the rewind shot previews: what people work on in the dev
 * sandbox, taken two days ago before a UAT session, kept four weeks.
 */
const BEFORE_UAT = readyCheckpoint({
  readFrom: fromFixedNow(-2),
  takenAt: fromFixedNow(-2),
  expiresAt: fromFixedNow(28),
});

/**
 * The checkpoints of the dev sandbox, as `checkpoint:list` answers for it:
 * the one taken before UAT; one taken before a demo, about to expire, with
 * Keep; and a clean baseline kept until it is deleted, rewound to yesterday,
 * whose rewind can still be undone — older than the recycle bin keeps
 * records, which its line says, as the extension says it of any checkpoint
 * that old.
 */
const MOCK_CHECKPOINTS: CheckpointListEntry[] = [
  listEntry(BEFORE_UAT),
  listEntry(
    readyCheckpoint({
      checkpointId: 'ck-before-demo',
      name: 'Before demo',
      readFrom: fromFixedNow(-12),
      takenAt: fromFixedNow(-12),
      expiresAt: fromFixedNow(2),
    }),
    { expiresSoon: true },
  ),
  listEntry(
    readyCheckpoint({
      checkpointId: 'ck-clean-baseline',
      name: 'Clean baseline',
      readFrom: fromFixedNow(-20),
      takenAt: fromFixedNow(-20),
      expiresAt: null,
      lastRewind: { rewindId: 'rw-last', endedAt: fromFixedNow(-1), undoUntil: fromFixedNow(14) },
    }),
    { binReachSince: fromFixedNow(-15), undo: { rewindId: 'rw-last', until: fromFixedNow(14) } },
  ),
];

/**
 * What a rewind of the dev sandbox to "Before UAT" would do, as
 * `checkpoint:preview` answers it, object by object: the contacts and
 * accounts the session added deleted, the records it changed given their
 * values back, and the few it deleted brought back from the recycle bin,
 * with who last changed each. The org runs nothing as the rewind writes,
 * and nothing is beyond a rewind: Rewind is offered as it stands.
 */
const MOCK_REWIND_PREVIEW: CheckpointPreviewResponse['payload'] = {
  diff: {
    checkpointId: BEFORE_UAT.checkpointId,
    previewId: 'pv-before-uat',
    readAt: fromFixedNow(0),
    objects: [
      diffObject('Contact', {
        toDelete: { createdSince: 5, broughtBackSince: 0, comesBackWithParent: 0 },
        toGiveBack: { records: 7, fields: 11, clearedLookups: 0 },
        toBringBack: { inBin: 2, withParent: 0, deletedWhileTaken: 0 },
        lastChangedBy: { [USERS.alice]: 9, [USERS.integration]: 5 },
      }),
      diffObject('Case', {
        toGiveBack: { records: 12, fields: 12, clearedLookups: 0 },
        lastChangedBy: { [USERS.integration]: 12 },
      }),
      diffObject('Account', {
        toDelete: { createdSince: 3, broughtBackSince: 0, comesBackWithParent: 0 },
        toGiveBack: { records: 4, fields: 9, clearedLookups: 0 },
        toBringBack: { inBin: 1, withParent: 0, deletedWhileTaken: 0 },
        lastChangedBy: { [USERS.alice]: 8 },
      }),
    ],
    undoCannot: [],
    unread: [],
    userNames: { [USERS.alice]: 'Alice Martin', [USERS.integration]: 'Integration User' },
    activeLastHour: [],
    access: { kind: 'org' },
  },
  automation: {
    objectsRead: ['Contact', 'Case', 'Account'],
    objects: [],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 25,
    requests: 3,
  },
  estimate: { records: 34, apiRequests: 120, apiRequestsLeft: 14_900, seconds: 38, bytes: 0 },
};

/** Boot the Checkpoints page on the dev sandbox, its checkpoints listed. */
async function openCheckpoints(page: import('@playwright/test').Page): Promise<MockBridge> {
  const bridge = await openModule(page, 'checkpoint');
  await page.waitForSelector('[data-testid="checkpoint-page"]');
  await bridge.waitForMessage('checkpoint:list', { timeout: 10_000 });
  await respondToAll(page, 'checkpoint:list', 'checkpoint:list:response', {
    checkpoints: MOCK_CHECKPOINTS,
  });
  await page.waitForSelector(`[data-testid="checkpoint-row-${BEFORE_UAT.checkpointId}"]`);
  return bridge;
}

/** The instant `hours` from FIXED_NOW: the recovery's steps were done this afternoon. */
const hoursFromFixedNow = (hours: number): string =>
  new Date(FIXED_NOW.getTime() + hours * 3_600_000).toISOString();

/** The dev sandbox's Organization Id before its refresh, and after: placeholders, `xx` pod. */
const ORG_ID_BEFORE = '00Dxx0000001XyZ';
const ORG_ID_AFTER = '00Dxx0000002AbC';

/**
 * Where each step of the dev sandbox's recovery stands, this afternoon: the
 * refresh noticed this morning, the copy masked and the checkpoint of before
 * replayed, the deliverability checked in Setup; the users still to bring
 * back; no frozen dataset kept on this machine, so nothing to reload.
 */
const RECOVERY_STEPS: Record<RecoveryStepId, { reason: RecoveryReason; at?: string }> = {
  refresh: { reason: 'refreshDetected' },
  users: { reason: 'toDo' },
  masking: { reason: 'ranAfterRefresh', at: hoursFromFixedNow(-3) },
  replay: { reason: 'ranAfterRefresh', at: hoursFromFixedNow(-2) },
  frozen: { reason: 'noManifest' },
  testersCheckpoint: { reason: 'toDo' },
  deliverability: { reason: 'markedDone', at: hoursFromFixedNow(-1) },
  scheduledJobs: { reason: 'toDo' },
  endpoints: { reason: 'toDo' },
  handoff: { reason: 'toDo' },
};

/**
 * The dev sandbox, a Partial Copy, refreshed this morning, as
 * `recovery:status` answers for it: the steps above, the checkpoint taken of
 * it a week before and the inventory of its jobs kept then, the objects its
 * last masking addressed. Parsed by the contract's schema, so the shot draws
 * only a state the extension can send.
 */
const RECOVERY_STATUS: RecoveryStatus = (() => {
  const steps = RECOVERY_STEP_IDS.map((id) => ({
    id,
    status: RECOVERY_REASON_STATUS[RECOVERY_STEPS[id].reason],
    ...RECOVERY_STEPS[id],
  }));
  return recoveryStatusSchema.parse({
    orgId: RECOVERY_ORG.id,
    alias: RECOVERY_ORG.alias,
    tier: 'development',
    sandboxType: 'Partial',
    myDomainHost: 'example--dev.sandbox.my.salesforce.com',
    organizationId: ORG_ID_AFTER,
    refresh: {
      detectedAt: hoursFromFixedNow(-6),
      evidence: 'connection',
      previousOrganizationId: ORG_ID_BEFORE,
      organizationId: ORG_ID_AFTER,
      cachesForgotten: true,
    },
    checkpointBefore: {
      checkpointId: 'ck-20260306-183123-a1b2',
      name: 'Before refresh',
      takenAt: fromFixedNow(-7),
    },
    inventoryBefore: { savedAt: fromFixedNow(-7), organizationId: ORG_ID_BEFORE, jobs: 6 },
    maskObjects: { objects: ['Contact', 'Lead', 'Account'], from: 'org' },
    beforeNextRefresh: RECOVERY_PREPARATION_IDS.map((id) => ({
      id,
      status: 'todo',
      reason: 'toDo',
    })),
    steps,
    ...recoveryProgressOf(steps),
  });
})();

/** A user of the dev sandbox the refresh left to bring back. */
const recoveryUser = (
  n: number,
  name: string,
  username: string,
  facts: { active?: boolean; frozen?: boolean; profile: string },
) => ({
  username,
  userId: `005xx00000100${String(n).padStart(2, '0')}AAA`,
  name,
  address: 'invalid' as const,
  active: facts.active ?? true,
  frozen: facts.frozen ?? false,
  profile: facts.profile,
});

/**
 * The users the refresh left with their address under `.invalid`, as
 * `recovery:users:list` reads them: three testers, one of them deactivated
 * and frozen, and the integration user, which nobody brings back by hand.
 */
const RECOVERY_USERS = recoveryUsersListSchema.parse({
  orgId: RECOVERY_ORG.id,
  users: [
    recoveryUser(1, 'Ana Lopes', 'ana.lopes@example.com.dev', { profile: 'Standard User' }),
    recoveryUser(2, 'Bo Martin', 'bo.martin@example.com.dev', {
      active: false,
      frozen: true,
      profile: 'Standard User',
    }),
    recoveryUser(3, 'Carla Diaz', 'carla.diaz@example.com.dev', { profile: 'Marketing User' }),
    recoveryUser(4, 'Integration User', 'integration@example.com.dev', {
      profile: 'System Administrator',
    }),
  ],
});

/** The three testers the shot brings back. */
const RECOVERY_TESTERS = RECOVERY_USERS.users.slice(0, 3);

/**
 * What a simulation of the three testers answers: each address asked back,
 * which Salesforce confirms by an email to its owner, and the tester left
 * inactive and frozen activated and unfrozen, taking the last Salesforce
 * license but one. The emails to people are asked to be accepted for the run.
 */
const RECOVERY_PLAN = usersPlanAnswerSchema.parse({
  org: {
    organizationId: ORG_ID_AFTER,
    kind: 'sandbox',
    alias: RECOVERY_ORG.alias,
    username: 'admin@example.com.dev',
  },
  users: RECOVERY_TESTERS.map((user) => ({
    username: user.username,
    userId: user.userId,
    address: 'invalid',
    changes: [
      { what: 'email', to: 'awaiting' },
      ...(user.active ? [] : [{ what: 'active', from: false, to: true }]),
      ...(user.frozen ? [{ what: 'frozen', from: true, to: false }] : []),
    ],
    emailsToPeople: 1,
  })),
  licenses: [{ name: 'Salesforce', total: 20, used: 18, toUse: 1 }],
  emailsToPeople: RECOVERY_TESTERS.length,
  apiRequests: 7,
  refusals: [
    {
      code: 'USERS_EMAILS_NOT_ACCEPTED',
      message: `Salesforce would email ${RECOVERY_TESTERS.length} people`,
    },
  ],
});

/** One object of a Forge graph, as discovery answers with it. */
function forgeNode(
  objectApiName: string,
  recordCount: number,
  level: number,
  piiFields: string[] = [],
): Record<string, unknown> {
  return {
    objectApiName,
    recordCount,
    fieldCount: 50,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields,
    anonymizeFields: piiFields,
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

/**
 * An account and what hangs from it, as a Forge discovery answers with it:
 * the graph the Review, simulation and results shots share. Its counts are of
 * the rows a record-scoped clone reads, and the results' read counts repeat
 * them, so every screen of the journey adds up to the same eight records.
 */
const MOCK_FORGE_GRAPH = {
  nodes: [
    forgeNode('Account', 1, 0, ['Phone']),
    forgeNode('Contact', 3, 1, ['Email', 'Phone']),
    forgeNode('Opportunity', 2, 1),
    forgeNode('Case', 2, 1),
  ],
  edges: [
    {
      sourceObject: 'Account',
      targetObject: 'Contact',
      relationshipName: 'Contacts',
      type: 'lookup',
    },
    {
      sourceObject: 'Account',
      targetObject: 'Opportunity',
      relationshipName: 'Opportunities',
      type: 'lookup',
    },
    { sourceObject: 'Account', targetObject: 'Case', relationshipName: 'Cases', type: 'lookup' },
  ],
  totalRecords: 8,
  estimatedSizeMB: 0.02,
  estimatedDurationSeconds: 4,
};

/** The query the Forge shots start from: one account, by name. */
const MOCK_FORGE_SOQL = "SELECT Id FROM Account WHERE Name = 'Acme Corporation'";

/** The rows the run reads, per object: the graph's counts. */
const MOCK_FORGE_READ = [
  { objectApiName: 'Account', read: 1 },
  { objectApiName: 'Contact', read: 3 },
  { objectApiName: 'Opportunity', read: 2 },
  { objectApiName: 'Case', read: 2 },
];

/**
 * What the target org runs on those records, as Review reads it: a flow that
 * emails a contact once it is created, which a custom permission keeps quiet,
 * and an Apex trigger on the account. Two things fire on insert, the count the
 * Automation tab carries.
 */
const MOCK_FORGE_AUTOMATION = {
  objectsRead: ['Account', 'Contact', 'Opportunity', 'Case'],
  objects: [
    {
      objectApiName: 'Account',
      flows: [],
      triggers: [{ name: 'AccountTrigger', events: ['beforeInsert', 'afterUpdate'] }],
    },
    {
      objectApiName: 'Contact',
      flows: [
        {
          apiName: 'Contact_Welcome_Email',
          label: 'Contact welcome email',
          timing: 'afterSave',
          startsOn: 'create',
          condition: 'read',
          permissions: [{ name: 'Load_Data', bypass: true }],
          messages: [{ kind: 'email', name: 'Welcome email' }],
        },
      ],
      triggers: [],
    },
    { objectApiName: 'Opportunity', flows: [], triggers: [] },
    { objectApiName: 'Case', flows: [], triggers: [] },
  ],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 6,
};

/**
 * What the target's metadata holds against the rows, as Review reads it when
 * it opens: a validation rule on the contact's phone, which refuses nothing
 * until a row breaks it.
 */
const MOCK_FORGE_METADATA_GAPS = {
  gaps: [
    {
      id: 'validation_rule|Contact|Phone||Phone_Format',
      kind: 'validation_rule',
      severity: 'warning',
      source: 'metadata',
      objectApiName: 'Contact',
      field: 'Phone',
      rows: 0,
      detail: {
        rule: 'Phone_Format',
        message: 'Use the international format',
        formula: 'read',
      },
      decisions: ['leave_empty', 'ignore'],
      defaultDecision: 'leave_empty',
    },
  ],
  unread: [],
  requests: 7,
};

/**
 * What the simulation finds the target would refuse or change in those rows:
 * an account type its record type refuses, a field only the target requires,
 * and a description longer than the target's field.
 */
const MOCK_FORGE_SIMULATION_GAPS = [
  {
    id: 'picklist_value_refused|Account|Type||Prospect',
    kind: 'picklist_value_refused',
    severity: 'blocking',
    source: 'simulation',
    objectApiName: 'Account',
    field: 'Type',
    value: 'Prospect',
    rows: 1,
    detail: { allowedValues: ['Customer', 'Partner'] },
    decisions: ['map_value', 'leave_empty', 'exclude_object', 'ignore'],
    defaultDecision: 'map_value',
  },
  {
    id: 'required_field_missing|Contact|Region__c||',
    kind: 'required_field_missing',
    severity: 'blocking',
    source: 'simulation',
    objectApiName: 'Contact',
    field: 'Region__c',
    rows: 3,
    decisions: ['set_default', 'exclude_object', 'ignore'],
  },
  {
    id: 'value_too_long|Account|Description||',
    kind: 'value_too_long',
    severity: 'warning',
    source: 'simulation',
    objectApiName: 'Account',
    field: 'Description',
    rows: 1,
    detail: { length: 255, longest: 412 },
    decisions: ['truncate', 'exclude_object', 'ignore'],
  },
];

/**
 * What a run neutralized on its way to the target: the account's phone, and
 * the contacts' emails and phones. A simulation counts what it would.
 */
const MOCK_FORGE_CONTACT_POINTS = {
  neutralized: true,
  fields: [
    { objectApiName: 'Account', field: 'Phone', kind: 'phone', values: 1 },
    { objectApiName: 'Contact', field: 'Email', kind: 'email', values: 3 },
    { objectApiName: 'Contact', field: 'Phone', kind: 'phone', values: 3 },
  ],
  values: 7,
};

/**
 * A simulation of the graph, as `forge:execute` answers it: every row read
 * goes through the write stage and would be inserted, nothing is created, and
 * no id is remapped — a simulation keeps none of the ids it hands out.
 */
const MOCK_FORGE_SIMULATION = {
  forgeId: 'forge-simulated',
  status: 'success',
  graph: MOCK_FORGE_GRAPH,
  duration: 4200,
  timestamp: '2026-03-13T18:20:00.000Z',
  idRemapCount: 0,
  idRemapTable: {},
  idRemapExisting: [],
  createdCount: 0,
  linkedExistingCount: 0,
  existingRecords: [],
  idRemapByObject: [],
  idRemapCreated: [],
  readByObject: MOCK_FORGE_READ,
  failedReads: [],
  errors: [],
  truncatedObjects: [],
  contactPoints: MOCK_FORGE_CONTACT_POINTS,
  apiCalls: 9,
  dryRun: true,
  wouldInsertCount: 8,
  gaps: MOCK_FORGE_SIMULATION_GAPS,
};

/** A fake record id: the object's prefix, then a counter, then `SRC` for the source's. */
const fakeForgeId = (prefix: string, n: number, source = false): string =>
  `${prefix}${String(n).padStart(12, '0')}${source ? 'SRC' : 'AAA'}`;

/** The source → target ids of the eight records the real run created. */
const MOCK_FORGE_REMAPS: Array<[string, string, number]> = [
  ['Account', '001', 1],
  ['Contact', '003', 3],
  ['Opportunity', '006', 2],
  ['Case', '500', 2],
];

/**
 * The run of the same graph once its gaps are decided, as `forge:execute`
 * answers it: the eight records created in the target, each id remapped, the
 * contact points neutralized.
 */
const MOCK_FORGE_RUN = {
  forgeId: 'forge-run-1',
  status: 'success',
  graph: MOCK_FORGE_GRAPH,
  timestamp: '2026-03-13T18:25:00.000Z',
  duration: 6800,
  idRemapCount: 8,
  idRemapTable: Object.fromEntries(
    MOCK_FORGE_REMAPS.flatMap(([, prefix, count]) =>
      Array.from({ length: count }, (_, i) => [
        fakeForgeId(prefix, i + 1, true),
        fakeForgeId(prefix, i + 1),
      ]),
    ),
  ),
  idRemapExisting: [],
  createdCount: 8,
  linkedExistingCount: 0,
  existingRecords: [],
  idRemapCreated: MOCK_FORGE_REMAPS.map(([objectApiName, prefix, count]) => ({
    objectApiName,
    sourceIds: Array.from({ length: count }, (_, i) => fakeForgeId(prefix, i + 1, true)),
  })),
  readByObject: MOCK_FORGE_READ,
  failedReads: [],
  errors: [],
  truncatedObjects: [],
  contactPoints: MOCK_FORGE_CONTACT_POINTS,
  apiCalls: 14,
  targetOrgId: 'org-tgt-1',
  sourceOrgId: 'org-src-1',
};

/** Boot Forge, discover the graph from the SOQL tab, and stop on Review with what it reads answered. */
async function openForgeReview(page: import('@playwright/test').Page): Promise<MockBridge> {
  const bridge = await openModule(page, 'forge');
  await page.waitForSelector('[data-testid="forge-page"]');
  await page.getByTestId('forge-tab-soql').click();
  await page.getByTestId('forge-input-soql').fill(MOCK_FORGE_SOQL);
  // Personal data anonymized, as a clone between two sandboxes should run.
  // The checkbox is visually hidden behind its label's lock icon.
  await page.getByTestId('forge-anonymize-toggle').check({ force: true });
  await page.getByTestId('forge-target-org').click();
  await page.getByTestId('forge-target-org-option-org-tgt-1').click();
  await page.getByTestId('forge-discover-btn').click();
  await page.waitForSelector('[data-testid="forge-discovery-loading"]');
  await respondToAll(page, 'forge:discover', 'forge:discover:response', {
    graph: MOCK_FORGE_GRAPH,
  });
  await page.getByTestId('forge-execute-btn').click();
  await page.waitForSelector('[data-testid="forge-review"]');
  await answerReviewReads(page, 1);
  return bridge;
}

/** Wait until the panel has sent `count` requests of a type, enveloped as it sends them. */
async function waitForRequests(
  page: import('@playwright/test').Page,
  requestType: string,
  count: number,
): Promise<void> {
  await page.waitForFunction(
    ({ type, expected }) =>
      ((window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? []).filter(
        (m) =>
          ((m as Record<string, unknown>).payload as Record<string, unknown> | undefined)?.type ===
          type,
      ).length >= expected,
    { type: requestType, expected: count },
    { timeout: 10_000 },
  );
}

/**
 * Answer what Review reads of the target as it opens — the schema diff, what
 * the target runs, what its metadata holds against the rows. Unanswered, the
 * shot shows three reads in progress, and a Gaps tab with nothing read.
 *
 * Review reads again each time it opens, and keeps only the answer to its
 * last read of the gaps: `opening` says which time this is, and the answers
 * wait for that read.
 */
async function answerReviewReads(
  page: import('@playwright/test').Page,
  opening: number,
): Promise<void> {
  await waitForRequests(page, 'forge:gaps:request', opening);
  // The plan the extension makes of the graph, or the Plan row reads
  // "Working…" in every shot of the review.
  await sendExtensionMessage(page, {
    type: 'forge:plan:response',
    id: `plan-${opening}`,
    payload: { plan: REVIEW_PLAN },
  });
  await respondToAll(page, 'forge:metadata-diff:request', 'forge:metadata-diff:response', {
    diffs: [],
  });
  await respondToAll(page, 'forge:automation:request', 'forge:automation:response', {
    automation: MOCK_FORGE_AUTOMATION,
  });
  await respondToAll(page, 'forge:gaps:request', 'forge:gaps:response', {
    gaps: MOCK_FORGE_METADATA_GAPS,
  });
}

/** The plan of the review's graph: 8 records of 4 objects, in two waves. */
const REVIEW_PLAN = {
  waves: [
    { order: 0, objectApiNames: ['Account'], estimatedApiCalls: 1, estimatedDurationSeconds: 0.5 },
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

/** Have the extension say each object of the graph is done: the results table reads its status. */
async function finishEveryObject(
  page: import('@playwright/test').Page,
  correlationId: string,
): Promise<void> {
  for (const { objectApiName } of MOCK_FORGE_READ) {
    await sendExtensionMessage(page, {
      type: 'forge:progress',
      id: `progress-${objectApiName}`,
      correlationId,
      payload: { objectName: objectApiName, status: 'done', progress: 100 },
    });
  }
}

/**
 * Run Review's Execute up to its execution screen: the run's request id,
 * which its progress and its answer are correlated to.
 */
async function startRun(
  page: import('@playwright/test').Page,
  bridge: MockBridge,
): Promise<string> {
  await page.getByTestId('execute-button').click();
  await page.waitForSelector('[data-testid="forge-execution"]');
  // The simulation was the first `forge:execute`; the run is the second.
  await waitForRequests(page, 'forge:execute', 2);
  return String(((await bridge.getMessages('forge:execute')).at(-1) ?? {}).id);
}

/** Have the extension say the run is half way: the account written, its contacts going in. */
async function runHalfWay(page: import('@playwright/test').Page, run: string): Promise<void> {
  for (const [objectName, status, progress] of [
    ['Account', 'done', 100],
    ['Contact', 'running', 60],
  ] as const) {
    await sendExtensionMessage(page, {
      type: 'forge:progress',
      id: `progress-${objectName}-${progress}`,
      correlationId: run,
      payload: { objectName, status, progress },
    });
  }
}

/** Finish the run `startRun` began, and wait for its results down to the removal they offer. */
async function finishRun(page: import('@playwright/test').Page, run: string): Promise<void> {
  await finishEveryObject(page, run);
  await sendExtensionMessage(page, {
    type: 'forge:execute:response',
    id: 'resp-run',
    correlationId: run,
    payload: { result: MOCK_FORGE_RUN, operationId: 'forge-execute-1' },
  });
  await page.waitForSelector('[data-testid="forge-results-remove"]');
}

/** Run Review's Simulate up to its results. */
async function simulateFromReview(
  page: import('@playwright/test').Page,
  bridge: MockBridge,
): Promise<void> {
  await page.getByTestId('simulate-button').click();
  await page.waitForSelector('[data-testid="forge-execution"]');
  const request = await bridge.waitForMessage('forge:execute', { timeout: 10_000 });
  await finishEveryObject(page, String(request.id));
  await sendExtensionMessage(page, {
    type: 'forge:execute:response',
    id: 'resp-simulation',
    correlationId: String(request.id),
    payload: { result: MOCK_FORGE_SIMULATION, operationId: 'forge-simulation-1' },
  });
  await page.waitForSelector('[data-testid="forge-results-simulation"]');
}

/** Enter a record id on Forge's Record tab, and answer its preview with the account. */
async function previewRecord(
  page: import('@playwright/test').Page,
  bridge: MockBridge,
  recordId: string,
): Promise<void> {
  await page.getByTestId('forge-input-record').fill(recordId);
  await page.getByTestId('forge-preview-btn').click();
  // Typing into the input invalidates the in-flight preview and schedules a
  // debounced one; answer after that fires, or the response reads as stale.
  await bridge.waitForMessage('forge:preview', { timeout: 10_000 });
  await page.waitForTimeout(1200);
  await respondToAll(page, 'forge:preview', 'forge:preview:response', {
    objectApiName: 'Account',
    objectLabel: 'Account',
    recordId,
    fields: [
      { name: 'Name', value: 'Acme Corporation' },
      { name: 'Industry', value: 'Technology' },
      { name: 'Type', value: 'Enterprise' },
      { name: 'Website', value: 'https://acme.com' },
      { name: 'Phone', value: '+1 (555) 123-4567' },
    ],
    // The page says "Root record · Account · 68 fields" from totalFieldCount;
    // the two estimates still travel in the response and are shown nowhere.
    estimatedRecordCount: 500,
    totalFieldCount: 68,
    estimatedSize: 0.5,
  });
  await page.waitForSelector('[data-testid="forge-record-preview"]');
}

/** Decide the simulation's three gaps in Review's Gaps row, which they opened, as a user would. */
async function decideSimulationGaps(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForSelector('[data-testid="gaps-severity-blocking"]');
  await page
    .getByTestId(`gap-${MOCK_FORGE_SIMULATION_GAPS[0].id}`)
    .getByTestId('gap-map-value')
    .selectOption('Customer');
  const region = page.getByTestId(`gap-${MOCK_FORGE_SIMULATION_GAPS[1].id}`);
  await region.getByTestId('gap-default-value').fill('EMEA');
  await region.getByTestId('gap-set-default').click();
  // Under the gaps that refuse rows, those that may are folded.
  await page.getByTestId('gaps-severity-warning-more').locator('summary').click();
  await page
    .getByTestId(`gap-${MOCK_FORGE_SIMULATION_GAPS[2].id}`)
    .getByTestId('gap-truncate')
    .click();
}

/** Drop the focus the last click left, which a still would show as a ring. */
async function blurFocus(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/**
 * The animation the listing opens on, and how long each of its screens stays.
 *
 * It replaces a hand-made one that went on showing a navigation sidebar for
 * months after the sidebar was gone. Drawn here, from the same mocked bridge
 * and fixtures as the stills, it is redrawn whenever they are, and the
 * staleness check that covers them covers it.
 *
 * A user reads a screen they have never seen in about two seconds, a little
 * more for the first, which says what the animation is about, and for the
 * last, before it starts over. Every frame is one viewport of the same size:
 * a GIF has one screen size for all its frames, and a frame scaled to fit
 * would blur the text it exists to show.
 */
const FLOW_FIRST_MS = 3500;
const FLOW_FRAME_MS = 2300;
const FLOW_LAST_MS = 4500;

/**
 * A screenshot of the viewport, as a frame of the animation: the screen from
 * its top, as a user arriving on it sees it.
 *
 * Playwright scrolls each control into view to click it, and the panel keeps
 * that scroll from one screen to the next: the results of a run started from
 * the foot of Review opened scrolled past their title.
 */
async function flowFrame(
  page: import('@playwright/test').Page,
  delayMs: number,
): Promise<GifFrame> {
  await page.evaluate(() => document.querySelector('[data-testid="panel-app"]')?.scrollTo(0, 0));
  await settle(page);
  const png = await page.screenshot({ animations: 'disabled' });
  return { ...readPng(png), delayMs };
}

test.describe('Marketplace Screenshots', () => {
  test.skip(!process.env.SCREENSHOTS, 'Screenshots are generated on demand (set SCREENSHOTS=1)');

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
  });

  test('home', async ({ page }) => {
    const bridge = await openModule(page, 'home');
    // Org health fabricates no zeros: it reads the same monitor:refresh round
    // trip Monitor does, and holds its skeletons until it answers.
    await bridge.waitForMessage('monitor:refresh', { timeout: 10_000 });
    await respondToAll(page, 'monitor:refresh', 'monitor:data', MOCK_HEALTH);
    // The KPI row waits for the page's own read of the org list, apart from
    // the read the panel makes as it boots: unanswered, it stayed grey slabs.
    await respondToAll(page, 'org:list', 'org:list:response', { orgs: MOCK_ORGS });
    // The Checkpoints tile says nothing until the org's checkpoints are listed.
    await bridge.waitForMessage('checkpoint:list', { timeout: 10_000 });
    await respondToAll(page, 'checkpoint:list', 'checkpoint:list:response', {
      checkpoints: MOCK_CHECKPOINTS,
    });
    // What the panel has seen run, as the extension announces each run, its
    // start then its end, in its own words: a Seed of the UAT refresh
    // template, then the clone of the account the Forge shots follow. The
    // tile lists them, and the week's count follows.
    await bridge.stream([
      {
        type: 'operation:started',
        payload: { operationId: 'op-seed-1', module: 'seed', description: 'Seed data generation' },
      },
      {
        type: 'operation:completed',
        payload: {
          operationId: 'op-seed-1',
          result: {
            status: 'success',
            totalRecords: MOCK_SEED_TEMPLATES.templates[0].totalRecords,
          },
        },
      },
      {
        type: 'operation:started',
        payload: {
          operationId: 'op-forge-1',
          module: 'forge',
          description: 'Executing forge operation',
        },
      },
      {
        type: 'operation:completed',
        payload: { operationId: 'op-forge-1', result: { status: MOCK_FORGE_RUN.status } },
      },
    ]);
    await page.waitForSelector('[data-testid="home-page"]');
    await page.waitForSelector('[data-testid="home-kpi-row"]');
    // Home asks each sandbox where its recovery stands; neither answers a
    // refresh, so the hero is the launcher's for two orgs connected: Forge.
    // The launcher's shot has the refreshed sandbox.
    await page.waitForSelector('[data-testid="forge-hero-card"]');
    await page.waitForSelector('[data-testid="checkpoint-tile-latest"]');
    await page.getByTestId('recent-op-item').nth(1).waitFor();
    await blurFocus(page);
    await settle(page);
    // All modules, the five groups of the launcher, ends below the design
    // viewport's 800 pixels: cut there, the picture ended in the middle of
    // its modules.
    await shoot(page, 'home', { maxHeight: 1400 });
  });

  test('forge', async ({ page }) => {
    const bridge = await openModule(page, 'forge');
    await page.waitForSelector('[data-testid="forge-page"]');

    // Pick a target org so Discover Graph is enabled — an unconfigured form
    // with a greyed-out button is a poor first impression.
    await page.getByTestId('forge-target-org').click();
    await page.getByTestId('forge-target-org-option-org-tgt-1').click();

    await previewRecord(page, bridge, '001000000000001AAA');
    await settle(page);
    await shoot(page, 'forge');
  });

  test('monitor', async ({ page }) => {
    const bridge = await openModule(page, 'monitor');
    // Every refresh the page sent, not the first: answered once, the second
    // left the dashboard on its skeleton (the page asks again as it mounts).
    await bridge.waitForMessage('monitor:refresh', { timeout: 10_000 });
    await respondToAll(page, 'monitor:refresh', 'monitor:data', MOCK_HEALTH);
    // Without this the storage panel stays on its loading skeleton and the
    // shot shows a 200px grey slab in the middle of the dashboard.
    await bridge.waitForMessage('monitor:storage', { timeout: 10_000 });
    await respondToAll(page, 'monitor:storage', 'monitor:storage:response', MOCK_STORAGE);
    // The dev sandbox was refreshed this morning, as the launcher and Back
    // into service have it: the band that leads the dashboard for a week
    // after a refresh, with the way back into service. A sandbox has no
    // refresh history of its own to list.
    await bridge.waitForMessage('monitor:sandbox-refresh', { timeout: 10_000 });
    const refresh = RECOVERY_STATUS.refresh;
    await respondToAll(page, 'monitor:sandbox-refresh', 'monitor:sandbox-refresh:response', {
      success: true,
      supported: false,
      refreshes: [],
      inProgress: false,
      detected: refresh
        ? [
            {
              detectedAt: refresh.detectedAt,
              evidence: refresh.evidence,
              previousOrganizationId: refresh.previousOrganizationId,
              organizationId: refresh.organizationId,
            },
          ]
        : [],
    });
    await page.waitForSelector('[data-testid="monitor-page"]');
    await page.waitForSelector('[data-testid="monitor-after-refresh"]');
    await page.waitForSelector('[data-testid="storage-donut-chart"]');
    await settle(page);
    // The dashboard runs on below the records by object, which the design
    // viewport cut through their legend: it ends where the trends begin.
    await shoot(page, 'monitor', { foot: '[data-testid="storage-panel"]', maxHeight: 1200 });
  });

  test('seed', async ({ page }) => {
    const bridge = await openModule(page, 'seed');
    await page.waitForSelector('[data-testid="seed-page"]');

    // Seed lands on its template gallery, the product's promise ("fill an
    // empty dev org"), with the other ways to seed under it.
    // Unanswered, the gallery renders three grey 180px slabs instead of cards.
    await bridge.waitForMessage('seed:template:list', { timeout: 10_000 });
    await respondToAll(
      page,
      'seed:template:list',
      'seed:template:list:response',
      MOCK_SEED_TEMPLATES,
    );

    await page.waitForSelector('[data-testid="template-card-tpl-uat-refresh"]');
    await page.waitForSelector('[data-testid="seed-mode-selector"]');
    await settle(page);
    await shoot(page, 'seed');
  });

  test('sync', async ({ page }) => {
    const bridge = await openModule(page, 'sync');
    await page.waitForSelector('[data-testid="sync-page"]');

    // Source and target both matter: the object editor is not rendered at all
    // until a source is picked, and the header's pair of orgs, copied from
    // and written into — the one image that says "between two orgs" — needs
    // the target too.
    await page.getByLabel('Source', { exact: true }).selectOption('org-src-1');
    await page.getByLabel('Target', { exact: true }).selectOption('org-tgt-1');

    // Without this the editor sits on `sync-objects-skeleton`.
    await bridge.waitForMessage('sync:describe-global', { timeout: 10_000 });
    await respondToAll(
      page,
      'sync:describe-global',
      'sync:describe-global:response',
      MOCK_SYNC_OBJECTS,
    );

    // An answered describe still leaves "No objects configured" on screen —
    // the object set is the user's, not the org's. Configure three.
    for (const objectApiName of ['Account', 'Contact', 'Opportunity']) {
      await page.getByTestId('add-object-row').locator('select').selectOption(objectApiName);
      await page.getByTestId('add-object-btn').click();
    }

    // One filtered row: three rows of untouched defaults photograph as a form
    // nobody filled in, and the WHERE fragment is the field that says the sync
    // moves a slice rather than the whole object. `WHERE` itself is not typed —
    // SyncOpsHandler appends the keyword to the fragment, so a value starting
    // with it would picture SOQL the product never builds. Keep the
    // fragment short and blur it: a filled input that still holds focus shoots
    // with a focus ring and scrolled left, so the first characters are cut and
    // the clause reads as truncated rather than typed.
    const accountWhere = page.getByLabel('WHERE clause — Account');
    await accountWhere.fill("Type = 'Customer'");
    await accountWhere.blur();

    await page.waitForSelector('[data-testid="object-entry-Opportunity"]');
    await settle(page);
    // The delta, neutralization and file options sit below the object rows,
    // and Back and Next below them: at the design viewport's 800 pixels the
    // picture ended in the middle of the options.
    await shoot(page, 'sync', { maxHeight: 1200 });
  });

  test('dataops', async ({ page }) => {
    const bridge = await openModule(page, 'dataops');
    // The backups count on their tab's label, beside Masking.
    await bridge.waitForMessage('backup:list', { timeout: 10_000 });
    await respondToAll(page, 'backup:list', 'backup:list:result', MOCK_BACKUPS);
    // DataOps opens on Masking, whose body stays a skeleton until the
    // templates are listed.
    await bridge.waitForMessage('dataops:anonymization-templates', { timeout: 10_000 });
    await respondToAll(
      page,
      'dataops:anonymization-templates',
      'dataops:anonymization-templates:response',
      MOCK_MASKING_TEMPLATES,
    );
    await page.waitForSelector('[data-testid="dataops-page"]');
    // GDPR Standard picked: its rules, and what the latest backup can bring
    // back of what they mask, above Preview and Apply.
    await page.getByTestId('template-select').selectOption('tpl-gdpr-standard');
    await bridge.waitForMessage('dataops:anonymize:coverage', { timeout: 10_000 });
    await respondToAll(
      page,
      'dataops:anonymize:coverage',
      'dataops:anonymize:coverage:response',
      MOCK_MASKING_COVERAGE,
    );
    await page.waitForSelector('[data-testid="restore-coverage"]');
    await blurFocus(page);
    await settle(page);
    await shoot(page, 'dataops');
  });

  test('launcher', async ({ page }) => {
    // The sidebar's width before the first paint: the launcher lays itself
    // out once, and goes compact below 650 pixels of height.
    await page.setViewportSize({ width: LAUNCHER_WIDTH, height: VIEWPORT.height });
    const bridge = new MockBridge();
    await bridge.setup(page);
    await freezeClock(page);
    await paintLightHost(page);
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'sidepanel';
    });
    await page.goto('/');
    await page.waitForSelector('[data-testid="sidepanel-root"]');

    // The launcher speaks to the extension without the bridge's envelope: it
    // asks for its orgs, and the answer is a raw broadcast. Without it the
    // org switcher reads empty and the hero waits. The dev sandbox selected:
    // the one refreshed.
    await page.waitForFunction(() =>
      ((window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? []).some(
        (m) => (m as Record<string, unknown>).type === 'sidebar:requestOrgs',
      ),
    );
    await sendExtensionMessage(page, {
      type: 'org:list:response',
      payload: { orgs: MOCK_ORGS, selectedOrgId: RECOVERY_ORG.id },
    });
    // Its refresh, told on the launcher's own channel: the hero leads with
    // bringing it back into service, n of N steps done, as the Back into
    // service shot has them.
    await sendExtensionMessage(page, {
      type: 'sidebar:afterRefresh',
      payload: [
        {
          orgId: RECOVERY_ORG.id,
          alias: RECOVERY_ORG.alias,
          detectedAt: RECOVERY_STATUS.refresh?.detectedAt,
          done: RECOVERY_STATUS.done,
          total: RECOVERY_STATUS.total,
        },
      ],
    });
    // The line under Checkpoints: the checkpoint taken before the refresh,
    // which the recovery replays.
    await page.waitForFunction(() =>
      ((window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? []).some(
        (m) => (m as Record<string, unknown>).type === 'sidebar:requestLastCheckpoint',
      ),
    );
    await sendExtensionMessage(page, {
      type: 'sidebar:lastCheckpoint',
      payload: { orgId: RECOVERY_ORG.id, checkpoint: RECOVERY_STATUS.checkpointBefore },
    });
    // A Forge run finished: the last operation the launcher shows at its foot.
    await bridge.stream([
      {
        type: 'operation:started',
        payload: { operationId: 'op-forge-1', module: 'forge', description: 'Forge execution' },
      },
      { type: 'operation:completed', payload: { operationId: 'op-forge-1', result: {} } },
    ]);

    await page.waitForSelector('[data-testid="brand-mark"]');
    await page.waitForSelector('[data-testid="sidepanel-after-refresh-hero"]');
    await page.waitForSelector('[data-testid="sidepanel-last-checkpoint"]');
    await page.waitForSelector('[data-testid="sidepanel-last-op"]');
    await settle(page);
    await shoot(page, 'launcher', { launcher: true, maxHeight: 1000 });
  });

  test('checkpoints', async ({ page }) => {
    await openCheckpoints(page);
    await settle(page);
    await shoot(page, 'checkpoints');
  });

  test('checkpoint-rewind', async ({ page }) => {
    const bridge = await openCheckpoints(page);
    await page.getByTestId(`checkpoint-rewind-${BEFORE_UAT.checkpointId}`).click();
    await bridge.waitForMessage('checkpoint:preview', { timeout: 10_000 });
    await respondToAll(
      page,
      'checkpoint:preview',
      'checkpoint:preview:response',
      MOCK_REWIND_PREVIEW,
    );
    await page.waitForSelector('[data-testid="checkpoint-preview-table"]');
    // The preview's heading takes the keyboard as it opens.
    await blurFocus(page);
    await settle(page);
    await shoot(page, 'checkpoint-rewind', { maxHeight: 1400 });
  });

  test('recovery', async ({ page }) => {
    const bridge = await openModule(page, 'recovery');
    await page.waitForSelector('[data-testid="recovery-page"]');
    await bridge.waitForMessage('recovery:status', { timeout: 10_000 });
    await respondToAll(page, 'recovery:status', 'recovery:status:response', {
      status: RECOVERY_STATUS,
    });
    await page.waitForSelector('[data-testid="recovery-steps"]');

    // The users step open, the three testers chosen and simulated: what the
    // run would change of each, the license it takes, and the emails to them
    // accepted, which Apply waits for.
    await page.getByTestId('recovery-users-toggle').click();
    await bridge.waitForMessage('recovery:users:list', { timeout: 10_000 });
    await respondToAll(page, 'recovery:users:list', 'recovery:users:list:response', RECOVERY_USERS);
    for (const user of RECOVERY_TESTERS) {
      await page.getByTestId(`recovery-user-${user.username}`).check();
    }
    await page.getByTestId('recovery-users-simulate').click();
    await bridge.waitForMessage('recovery:users:plan', { timeout: 10_000 });
    await respondToAll(page, 'recovery:users:plan', 'recovery:users:plan:response', {
      orgId: RECOVERY_ORG.id,
      plan: RECOVERY_PLAN,
    });
    await page.getByTestId('recovery-users-acceptUserEmails').getByRole('checkbox').check();
    await page.waitForSelector('[data-testid="recovery-users-apply"]:enabled');
    await blurFocus(page);
    await settle(page);
    // It ends on the fifth step, the steps done, to do and that do not apply
    // all shown above it: the five after it and what to keep before the next
    // refresh are rows of the same kind.
    await shoot(page, 'recovery', {
      foot: '[data-testid="recovery-steps"] > li:nth-child(5)',
      maxHeight: 1400,
    });
  });

  test('forge-simulation', async ({ page }) => {
    const bridge = await openForgeReview(page);
    await simulateFromReview(page, bridge);
    await settle(page);
    // Its actions take two rows, under the steps above the orgs: they end
    // past 900 pixels, where Save as template fell off the foot.
    await shoot(page, 'forge-simulation', { maxHeight: 1000 });
  });

  test('forge-review', async ({ page }) => {
    await page.setViewportSize({ width: REVIEW_WIDTH, height: VIEWPORT.height });
    const bridge = await openForgeReview(page);
    await simulateFromReview(page, bridge);

    // Back to Review, where the simulation's gaps are decided: Review reads
    // the target again as it opens.
    await page.getByTestId('forge-results-simulation-review').click();
    await page.waitForSelector('[data-testid="forge-review"]');
    await answerReviewReads(page, 2);

    // Two gaps decided, one left open: the row counts the gap that still
    // refuses rows, and the shot shows both a decision and the choices.
    await page.waitForSelector('[data-testid="gaps-severity-blocking"]');
    await page
      .getByTestId(`gap-${MOCK_FORGE_SIMULATION_GAPS[0].id}`)
      .getByTestId('gap-map-value')
      .selectOption('Customer');
    await page.getByTestId('gaps-severity-warning-more').locator('summary').click();
    await page
      .getByTestId(`gap-${MOCK_FORGE_SIMULATION_GAPS[2].id}`)
      .getByTestId('gap-truncate')
      .click();
    await page.getByTestId('gap-decided').nth(1).waitFor();
    // The last click leaves its button focused, ringed in the shot.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    // The Gaps row scrolls within itself since it holds a screen's worth of
    // gaps: the clicks above left it on the last ones, past the gap that
    // still refuses rows.
    await page.getByTestId('review-gaps-scroll').evaluate((el) => el.scrollTo(0, 0));
    await settle(page);
    // Rehearse, Simulate and Execute stand in the column beside Review's rows,
    // which end a little past 800 pixels: the ceiling leaves room for a row
    // opened.
    await shoot(page, 'forge-review', { maxHeight: 1700 });
  });

  test('forge-results', async ({ page }) => {
    const bridge = await openForgeReview(page);
    await simulateFromReview(page, bridge);
    await page.getByTestId('forge-results-simulation-review').click();
    await page.waitForSelector('[data-testid="forge-review"]');
    await answerReviewReads(page, 2);

    // Every gap that refuses rows decided, then the run for real.
    await decideSimulationGaps(page);
    const run = await startRun(page, bridge);
    await finishRun(page, run);
    await settle(page);
    // Next steps, the offer to take a checkpoint of the target among them,
    // then Export and Save as template: at 1400 pixels the last fell off the
    // foot.
    await shoot(page, 'forge-results', { maxHeight: 1500 });
  });

  test('forge-flow', async ({ page }) => {
    // Eight screens, each given time to settle, run past the default timeout.
    test.setTimeout(180_000);
    const frames: GifFrame[] = [];

    // A record id pasted on the Record tab, the target picked, personal data
    // anonymized, and the record's preview beside them.
    const bridge = await openModule(page, 'forge');
    await page.waitForSelector('[data-testid="forge-page"]');
    await page.getByTestId('forge-target-org').click();
    await page.getByTestId('forge-target-org-option-org-tgt-1').click();
    await page.getByTestId('forge-anonymize-toggle').check({ force: true });
    // The account whose clone the run's results map, by the id they give it.
    await previewRecord(page, bridge, fakeForgeId('001', 1, true));
    await blurFocus(page);
    frames.push(await flowFrame(page, FLOW_FIRST_MS));

    // The graph discovery finds from it, the account's detail open.
    await page.getByTestId('forge-discover-btn').click();
    await page.waitForSelector('[data-testid="forge-discovery-loading"]');
    await respondToAll(page, 'forge:discover', 'forge:discover:response', {
      graph: MOCK_FORGE_GRAPH,
    });
    await page
      .getByTestId('progress-node-select')
      .filter({ hasText: /^Account$/ })
      .click();
    await blurFocus(page);
    frames.push(await flowFrame(page, FLOW_FRAME_MS));

    // Review: what the target org runs as the records go in.
    await page.getByTestId('forge-execute-btn').click();
    await page.waitForSelector('[data-testid="forge-review"]');
    await answerReviewReads(page, 1);
    await page.getByTestId('tab-automation').click();
    await blurFocus(page);
    frames.push(await flowFrame(page, FLOW_FRAME_MS));

    // A simulation: nothing written, three gaps found.
    await simulateFromReview(page, bridge);
    frames.push(await flowFrame(page, FLOW_FRAME_MS));

    // Back on Review, every gap that refuses rows decided. The Gaps row
    // scrolls within itself, and the clicks left it on the last gaps: back to
    // its first, the decisions of the gaps that refused rows. Scrolled to put
    // the rows at the top, the panel had room for 43 pixels, enough to cut
    // the title in half and show no more.
    await page.getByTestId('forge-results-simulation-review').click();
    await page.waitForSelector('[data-testid="forge-review"]');
    await answerReviewReads(page, 2);
    await decideSimulationGaps(page);
    await blurFocus(page);
    await page.getByTestId('review-gaps-scroll').evaluate((el) => el.scrollTo(0, 0));
    frames.push(await flowFrame(page, FLOW_FRAME_MS));

    // The run for real, half way.
    const run = await startRun(page, bridge);
    await runHalfWay(page, run);
    frames.push(await flowFrame(page, FLOW_FRAME_MS));

    // Its results.
    await finishRun(page, run);
    frames.push(await flowFrame(page, FLOW_FRAME_MS));

    // And the way back: what removing the run would take out of the target,
    // with what the target runs as the records go, read as it opens.
    await page.getByTestId('forge-results-remove').click();
    await page.waitForSelector('[data-testid="forge-removal-plan"]');
    await waitForRequests(page, 'forge:undo-automation:request', 1);
    await respondToAll(page, 'forge:undo-automation:request', 'forge:undo-automation:response', {
      forgeId: MOCK_FORGE_RUN.forgeId,
      automation: MOCK_FORGE_AUTOMATION,
      drafted: [],
    });
    await page.waitForSelector('[data-testid="forge-removal-automation-none"]');
    frames.push(await flowFrame(page, FLOW_LAST_MS));

    writeFileSync(path.resolve(SCREENSHOT_DIR, 'forge-flow.gif'), encodeGif(frames));
    stampGenerator();
  });
});
