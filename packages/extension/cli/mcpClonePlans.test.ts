import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SAMPLE_PLAN_MAX_AGE_MS,
  SamplePlan,
  SamplePlanError,
  dryRunPlanDirOf,
  keepSamplePlan,
  type WholeOrgSampleDrawn,
} from '../src/modules/forge/sample/samplePlanStore.js';
import {
  PLAN_ID,
  addClonePlanRun,
  clonePlanRunLine,
  dryRunPlanOf,
  endClonePlanRun,
  keepClonePlan,
  markClonePlanDead,
  openClonePlan,
  plansDirOf,
  readClonePlan,
  runArgsOf,
  sweepClonePlans,
  type DryRunPlan,
} from './mcpClonePlans.js';
import { stampedId } from './mcpRuns.js';

/*
 * The plans of the MCP server's clone of a whole org: the receipt a dry run
 * that would go leaves, the copy of the plan of ids a sample drew, held to
 * the SHA-256 the dry run gave, the line of the run that writes it and of
 * the resume that takes it up, and what its runs make of it.
 */

const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

/** What a small sample drew. */
const DRAWN: WholeOrgSampleDrawn = {
  seed: 1,
  draw: 'uniform',
  floor: 1,
  parents: 'all',
  children: 100,
  share: 0.5,
  budget: { bytes: 3_700_000, remainingMB: 5, maxMB: 5, limitedBy: 'storage' },
  rows: 3,
  storageBytes: 6_144,
  objects: [
    { objectApiName: 'Account', sourceRows: 4, kept: 2, roots: 2, below: 0, asParents: 0 },
    { objectApiName: 'Contact', sourceRows: 2, kept: 1, roots: 0, below: 1, asParents: 0 },
  ],
  whole: [],
  heavyRoots: [],
  dropped: [],
  leftEmpty: [],
  noRecordDrawn: [],
  planRequests: { source: 3 },
};

const DRAWN_AT = new Date('2026-11-14T18:40:00.000Z');
const NOW = new Date('2026-11-14T19:00:12.000Z');

/** The line of the dry run of a sample, as the server runs it. */
const SAMPLE_DRY_RUN = [
  '--depth',
  'all',
  '--source',
  'SRC',
  '--target',
  'TGT',
  '--fit',
  'share',
  '--fit-within',
  '1.5',
  '--max-total',
  '10000',
  '--skip-preflight',
  '--dry-run',
  '--json',
];

/** The line of the dry run of every record. */
const WHOLE_DRY_RUN = [
  '--depth',
  'all',
  '--source',
  'SRC',
  '--target',
  'TGT',
  '--max-total',
  '500',
  '--skip-preflight',
  '--dry-run',
  '--json',
];

let journalDir: string;

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-plans-'));
});

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true });
});

/** A plan of ids a dry run drew, where a dry run keeps it. */
async function drawnPlan(): Promise<SamplePlan> {
  return keepSamplePlan(dryRunPlanDirOf(journalDir, 'f00d'), {
    sourceOrgId: 'SRC',
    fingerprint: 'f00d',
    drawnAt: DRAWN_AT,
    drawnBy: 'dryRun',
    sample: DRAWN,
    ids: [
      { objectApiName: 'Account', ids: [fakeId('001', 2), fakeId('001', 1)] },
      { objectApiName: 'Contact', ids: [fakeId('003', 1)] },
    ],
  });
}

/** The --json answer of a dry run of a sample, as the clone script prints it. */
function sampleAnswer(plan: SamplePlan, over: Record<string, unknown> = {}) {
  return {
    tool: 'sandforge-clone',
    version: 1,
    source: 'SRC',
    target: 'TGT',
    dryRun: true,
    writePlan: { totalRows: 3, storageBytes: 6_144, objects: [] },
    wholeOrg: {
      sample: { seed: 1, plan: { ...plan.place } },
      totalRows: 3,
      question: 'Write a sample of SRC: 3 record(s) of 2 object(s) …?',
    },
    elapsedMs: 900,
    ...over,
  };
}

/** The --json answer of a dry run of every record. */
function wholeAnswer(over: Record<string, unknown> = {}) {
  return {
    tool: 'sandforge-clone',
    dryRun: true,
    writePlan: { totalRows: 420, storageBytes: 900_000, objects: [] },
    wholeOrg: { totalRows: 420, question: 'Write 420 record(s) of 9 object(s) of SRC into TGT …?' },
    ...over,
  };
}

/** Keep the plan of a dry run of a sample. */
async function keptSample(now: Date = NOW) {
  const plan = await drawnPlan();
  const planned = dryRunPlanOf(sampleAnswer(plan)) as DryRunPlan;
  const receipt = await keepClonePlan(
    journalDir,
    {
      source: 'SRC',
      target: 'TGT',
      dryRunArgs: SAMPLE_DRY_RUN,
      planned,
      accepted: ['acceptAutomation'],
    },
    now,
  );
  return { plan, receipt };
}

/** Keep the plan of a dry run of every record. */
async function keptWhole(now: Date = NOW) {
  return keepClonePlan(
    journalDir,
    {
      source: 'SRC',
      target: 'TGT',
      dryRunArgs: WHOLE_DRY_RUN,
      planned: dryRunPlanOf(wholeAnswer()) as DryRunPlan,
      accepted: [],
    },
    now,
  );
}

describe('what a dry run planned', () => {
  it('reads the plan of ids of a sample, the count of its gate and the question of its run', async () => {
    const plan = await drawnPlan();

    expect(dryRunPlanOf(sampleAnswer(plan))).toEqual({
      mode: 'sample',
      totalRows: 3,
      sample: { path: plan.dir, sha256: plan.sha256, drawnAt: DRAWN_AT.toISOString() },
      question: 'Write a sample of SRC: 3 record(s) of 2 object(s) …?',
    });
    expect(dryRunPlanOf(wholeAnswer())).toEqual({
      mode: 'whole',
      totalRows: 420,
      question: 'Write 420 record(s) of 9 object(s) of SRC into TGT …?',
    });
  });

  it('reads no plan of a dry run that would be refused, of a run, of nothing to write, or of anything else', () => {
    expect(
      dryRunPlanOf(
        wholeAnswer({ wouldBeRefused: ['more than'], wouldBeRefusedCodes: ['MAX_TOTAL_EXCEEDED'] }),
      ),
    ).toBeUndefined();
    expect(dryRunPlanOf(wholeAnswer({ dryRun: false }))).toBeUndefined();
    expect(dryRunPlanOf(wholeAnswer({ writePlan: { totalRows: 0 } }))).toBeUndefined();
    expect(dryRunPlanOf(wholeAnswer({ wholeOrg: undefined }))).toBeUndefined();
    expect(dryRunPlanOf(wholeAnswer({ tool: 'sandforge-seed' }))).toBeUndefined();
    expect(dryRunPlanOf(undefined)).toBeUndefined();
    expect(dryRunPlanOf('{}')).toBeUndefined();
  });

  it('makes the line of its run of the line of its dry run, which wrote nothing', () => {
    expect(runArgsOf(SAMPLE_DRY_RUN)).toEqual(SAMPLE_DRY_RUN.slice(0, -2));
  });
});

describe('the plan of a sample', () => {
  it('keeps a receipt and a copy of the plan of ids the dry run drew, held to its SHA-256, its owner’s alone', async () => {
    const { plan, receipt } = await keptSample();

    expect(receipt.id).toMatch(PLAN_ID);
    expect(receipt.id).toMatch(/^co-20261114-190012-/);
    expect(receipt).toMatchObject({
      version: 1,
      createdAt: NOW.toISOString(),
      source: 'SRC',
      target: 'TGT',
      args: SAMPLE_DRY_RUN.slice(0, -2),
      mode: 'sample',
      totalRows: 3,
      question: 'Write a sample of SRC: 3 record(s) of 2 object(s) …?',
      accepted: ['acceptAutomation'],
      runs: [],
    });
    // Its day runs from when its plan was drawn, earlier than the receipt.
    expect(receipt.expiresAt).toBe(
      new Date(DRAWN_AT.getTime() + SAMPLE_PLAN_MAX_AGE_MS).toISOString(),
    );
    const copy = join(plansDirOf(journalDir), receipt.id, 'sample');
    expect(receipt.sample).toEqual({
      dir: copy,
      sha256: plan.sha256,
      drawnAt: DRAWN_AT.toISOString(),
    });
    expect((await SamplePlan.open(copy, { sha256: plan.sha256 })).count).toBe(3);
    expect(await readClonePlan(journalDir, receipt.id)).toEqual(receipt);
    if (process.platform !== 'win32') {
      expect((await stat(plansDirOf(journalDir))).mode & 0o777).toBe(0o700);
      expect((await stat(join(plansDirOf(journalDir), `${receipt.id}.json`))).mode & 0o777).toBe(
        0o600,
      );
    }
  });

  it('keeps the plan shown when the next dry run of the same setup draws another in its place', async () => {
    const { plan, receipt } = await keptSample();

    await keepSamplePlan(plan.dir, {
      sourceOrgId: 'SRC',
      fingerprint: 'f00d',
      drawnAt: new Date('2026-11-14T19:05:00.000Z'),
      drawnBy: 'dryRun',
      sample: DRAWN,
      ids: [{ objectApiName: 'Account', ids: [fakeId('001', 9)] }],
    });

    const copy = await SamplePlan.open(String(receipt.sample?.dir), { sha256: plan.sha256 });
    expect(copy.count).toBe(3);
  });

  it('keeps no receipt of a plan that is no longer the one the dry run gave', async () => {
    const plan = await drawnPlan();
    const planned = dryRunPlanOf(sampleAnswer(plan)) as DryRunPlan;
    const other = { ...planned, sample: { ...planned.sample!, sha256: '0'.repeat(64) } };

    await expect(
      keepClonePlan(journalDir, {
        source: 'SRC',
        target: 'TGT',
        dryRunArgs: SAMPLE_DRY_RUN,
        planned: other,
        accepted: [],
      }),
    ).rejects.toBeInstanceOf(SamplePlanError);
    expect(await readdir(plansDirOf(journalDir))).toEqual([]);
  });
});

describe('the plan of every record', () => {
  it('keeps the count of its gate and a day from when it was made', async () => {
    const receipt = await keptWhole();

    expect(receipt).toMatchObject({ mode: 'whole', totalRows: 420 });
    expect(receipt).not.toHaveProperty('sample');
    expect(receipt.expiresAt).toBe(new Date(NOW.getTime() + SAMPLE_PLAN_MAX_AGE_MS).toISOString());
  });

  it('keeps how long its dry run said its writes take, which a run of it is followed against', async () => {
    const planned = dryRunPlanOf(
      wholeAnswer({ wholeOrg: { totalRows: 420, durationSeconds: 75 } }),
    ) as DryRunPlan;
    const receipt = await keepClonePlan(
      journalDir,
      { source: 'SRC', target: 'TGT', dryRunArgs: WHOLE_DRY_RUN, planned, accepted: [] },
      NOW,
    );

    expect(planned.durationSeconds).toBe(75);
    expect((await readClonePlan(journalDir, receipt.id))?.durationSeconds).toBe(75);
    // A time that does not read as one leaves the plan without it, not unkept.
    expect(
      dryRunPlanOf(wholeAnswer({ wholeOrg: { totalRows: 420, durationSeconds: 'soon' } })),
    ).toEqual({ mode: 'whole', totalRows: 420 });
  });
});

describe('the line of a run of a plan', () => {
  it('writes the copy of a sample’s plan, its dry run’s --max-total kept, answered, its summary kept', async () => {
    const { receipt } = await keptSample();

    expect(clonePlanRunLine(receipt, { summary: '/runs/mr-1.json' })).toEqual([
      ...SAMPLE_DRY_RUN.slice(0, -2),
      '--fit-plan',
      String(receipt.sample?.dir),
      '--yes',
      '--summary',
      '/runs/mr-1.json',
      '--json',
    ]);
  });

  it('holds a run of every record to the count of its plan, in place of its dry run’s --max-total', async () => {
    const receipt = await keptWhole();

    const line = clonePlanRunLine(receipt, { summary: '/runs/mr-1.json' });

    expect(line).toEqual([
      '--depth',
      'all',
      '--source',
      'SRC',
      '--target',
      'TGT',
      '--skip-preflight',
      '--max-total',
      '420',
      '--yes',
      '--summary',
      '/runs/mr-1.json',
      '--json',
    ]);
    expect(line).not.toContain('--dry-run');
  });

  it('takes the journal up in a resume, the plan its journal names, not the copy', async () => {
    const { receipt } = await keptSample();
    const whole = await keptWhole();

    const line = clonePlanRunLine(receipt, {
      summary: '/runs/mr-2.json',
      resume: '/runs/j.ndjson',
    });

    expect(line).not.toContain('--fit-plan');
    expect(line.slice(-6)).toEqual([
      '--resume',
      '/runs/j.ndjson',
      '--yes',
      '--summary',
      '/runs/mr-2.json',
      '--json',
    ]);
    expect(
      clonePlanRunLine(whole, { summary: '/runs/mr-3.json', resume: '/runs/j.ndjson' }),
    ).toContain('420');
  });
});

describe('a plan as a run of it finds it', () => {
  /** A run of `id` started now, its summary under the journal folder. */
  async function started(id: string, over: { resume?: boolean } = {}) {
    const handle = stampedId('mr', NOW);
    const summary = join(journalDir, `${handle}.json`);
    await addClonePlanRun(journalDir, id, {
      run: handle,
      startedAt: NOW.toISOString(),
      summary,
      resume: over.resume ?? false,
    });
    return { handle, summary };
  }

  it('is ready to write until its day is over, and gone after, unknown before it is kept', async () => {
    const receipt = await keptWhole();
    const dayOn = new Date(Date.parse(receipt.expiresAt));

    expect(await openClonePlan(journalDir, receipt.id, NOW)).toEqual({ state: 'ready', receipt });
    expect(await openClonePlan(journalDir, receipt.id, dayOn)).toMatchObject({
      state: 'gone',
      why: 'expired',
    });
    expect(await openClonePlan(journalDir, stampedId('co', NOW), NOW)).toEqual({
      state: 'gone',
      why: 'unknown',
    });
    expect(await openClonePlan(journalDir, '../../escape', NOW)).toEqual({
      state: 'gone',
      why: 'unknown',
    });
  });

  it('is written from the start of its first run, before the run says anything of itself', async () => {
    const receipt = await keptWhole();
    const { handle } = await started(receipt.id);

    const opened = await openClonePlan(journalDir, receipt.id, NOW);

    expect(opened).toMatchObject({ state: 'written', run: { run: handle } });
    expect(opened).not.toHaveProperty('journal');
  });

  it('is written once a run of it kept its journal, which its resume takes up, as long as that journal is there', async () => {
    const receipt = await keptWhole();
    const { handle } = await started(receipt.id);
    const journal = join(journalDir, 'forge-runs', 'run.ndjson');
    await mkdir(join(journalDir, 'forge-runs'), { recursive: true });
    await writeFile(journal, '');

    await endClonePlanRun(journalDir, receipt.id, handle, { code: 130, journal });

    expect(await openClonePlan(journalDir, receipt.id, NOW)).toMatchObject({
      state: 'written',
      journal,
      run: { run: handle, ended: { code: 130, wrote: true, journal } },
    });
    // Written, it is not past its day: a resume takes it up the day after.
    expect(
      await openClonePlan(journalDir, receipt.id, new Date(Date.parse(receipt.expiresAt) + 1)),
    ).toMatchObject({ state: 'written', journal });

    await rm(journal);
    expect(await openClonePlan(journalDir, receipt.id, NOW)).toMatchObject({
      state: 'gone',
      why: 'journalGone',
    });
  });

  it('is ready again when its run wrote nothing — refused at its gate, its journal not kept', async () => {
    const receipt = await keptWhole();
    const { handle } = await started(receipt.id);

    await endClonePlanRun(journalDir, receipt.id, handle, {
      code: 1,
      journal: join(journalDir, 'forge-runs', 'never-kept.ndjson'),
    });

    expect(await openClonePlan(journalDir, receipt.id, NOW)).toMatchObject({ state: 'ready' });
    expect((await readClonePlan(journalDir, receipt.id))?.runs[0]?.ended).toEqual({
      code: 1,
      wrote: false,
      journal: join(journalDir, 'forge-runs', 'never-kept.ndjson'),
    });
  });

  it('is read from the summary of a run whose end no server saw: written, its journal, or nothing', async () => {
    const receipt = await keptWhole();
    const { summary } = await started(receipt.id);
    const journal = join(journalDir, 'run.ndjson');

    // Stopped with its server, part way: its summary names its journal.
    await writeFile(journal, '');
    await writeFile(summary, JSON.stringify({ interrupted: true, journal, result: {} }));
    expect(await openClonePlan(journalDir, receipt.id, NOW)).toMatchObject({
      state: 'written',
      journal,
    });

    // Its journal gone, records written by its count: gone, never ready again.
    await rm(journal);
    await writeFile(
      summary,
      JSON.stringify({ interrupted: true, journal, result: { successCount: 2 } }),
    );
    expect(await openClonePlan(journalDir, receipt.id, NOW)).toMatchObject({
      state: 'gone',
      why: 'journalGone',
    });

    // Nothing written and its journal not kept: the plan is still to write.
    await writeFile(summary, JSON.stringify({ interrupted: true, journal, result: {} }));
    expect(await openClonePlan(journalDir, receipt.id, NOW)).toMatchObject({ state: 'ready' });
  });

  it('is gone once marked dead by a run refused for a change since it was planned, unless a run of it wrote', async () => {
    const receipt = await keptWhole();

    await markClonePlanDead(journalDir, receipt.id, 'MAX_TOTAL_EXCEEDED', NOW);

    expect(await openClonePlan(journalDir, receipt.id, NOW)).toMatchObject({
      state: 'gone',
      why: 'dead',
      receipt: { dead: { code: 'MAX_TOTAL_EXCEEDED', at: NOW.toISOString() } },
    });
    await started(receipt.id, { resume: true });
    expect(await openClonePlan(journalDir, receipt.id, NOW)).toMatchObject({ state: 'written' });
  });

  it('changes no receipt that is not there', async () => {
    expect(await markClonePlanDead(journalDir, stampedId('co', NOW), 'X')).toBeUndefined();
    expect(await readdir(journalDir)).toEqual([]);
  });
});

describe('cleaning up', () => {
  it('removes, with its copy, a plan past its day that no run wrote, and one whose last journal is gone', async () => {
    const dayOn = new Date(DRAWN_AT.getTime() + SAMPLE_PLAN_MAX_AGE_MS);
    const { receipt: unwritten } = await keptSample();
    const written = await keptWhole();
    const journalGone = await keptWhole();
    const ready = await keptWhole(dayOn);
    const journal = join(journalDir, 'kept.ndjson');
    await writeFile(journal, '');
    for (const [id, kept] of [
      [written.id, journal],
      [journalGone.id, join(journalDir, 'gone.ndjson')],
    ] as const) {
      const handle = stampedId('mr', NOW);
      await addClonePlanRun(journalDir, id, {
        run: handle,
        startedAt: NOW.toISOString(),
        summary: join(journalDir, `${handle}.json`),
        resume: false,
      });
      await writeFile(
        join(journalDir, `${handle}.json`),
        JSON.stringify({ journal: kept, result: { successCount: 1 } }),
      );
    }

    expect(await sweepClonePlans(journalDir, dayOn)).toBe(2);

    const left = await readdir(plansDirOf(journalDir));
    expect(left.sort()).toEqual([`${ready.id}.json`, `${written.id}.json`].sort());
    expect(left).not.toContain(unwritten.id);
  });

  it('keeps a dead plan until its day is over, saying why, and a plan a run under way holds', async () => {
    const dead = await keptWhole();
    const held = await keptWhole();
    await markClonePlanDead(journalDir, dead.id, 'SAMPLE_PLAN_MISMATCH', NOW);
    const dayOn = new Date(Date.parse(dead.expiresAt));

    expect(await sweepClonePlans(journalDir, NOW)).toBe(0);
    expect(await sweepClonePlans(journalDir, dayOn, (id) => id === held.id)).toBe(1);
    expect(await readdir(plansDirOf(journalDir))).toEqual([`${held.id}.json`]);
  });

  it('removes what a write left half done a day ago or more, and a receipt that does not read', async () => {
    // On the machine's clock: what a file was last written at is read on it.
    const now = new Date();
    const receipt = await keptWhole(now);
    const root = plansDirOf(journalDir);
    const half = join(root, `${receipt.id}.json.1234-abcd.tmp`);
    const broken = stampedId('co', NOW);
    const orphan = stampedId('co', NOW);
    await writeFile(half, '{');
    await writeFile(join(root, `${broken}.json`), '{"version":');
    await mkdir(join(root, orphan, 'sample'), { recursive: true });
    expect(await sweepClonePlans(journalDir, now)).toBe(0);

    const dayAgo = new Date(now.getTime() - SAMPLE_PLAN_MAX_AGE_MS - 1_000);
    for (const path of [half, join(root, `${broken}.json`), join(root, orphan)]) {
      await utimes(path, dayAgo, dayAgo);
    }
    expect(await sweepClonePlans(journalDir, now)).toBe(3);
    expect(await readdir(root)).toEqual([`${receipt.id}.json`]);
    expect(JSON.parse(await readFile(join(root, `${receipt.id}.json`), 'utf8'))).toMatchObject({
      id: receipt.id,
    });
    await rm(root, { recursive: true });
    expect(await sweepClonePlans(journalDir, now)).toBe(0);
  });
});
