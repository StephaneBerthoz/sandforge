import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  forgeRunGateStopOf,
  isForgeRunGateCode,
  type ForgeRunGateCode,
  type WholeOrgSample,
} from '@sandforge/shared';

import {
  SAMPLE_CANNOT_FIT,
  SAMPLE_PLAN_GONE,
  SAMPLE_PLAN_MISMATCH,
  SAMPLE_STORAGE_UNREAD,
  SAMPLE_TOO_LARGE,
  isForgeRunGateError,
  leftOutLines,
  sampleGateErrorOf,
  sampleGateStopOf,
  wholeOrgDryRunOf,
  writePlanOf,
  type LimitsTransport,
  type WholeOrgGraph,
} from './ForgeRunGate.js';
import { SampleRefusedError, type SampleRefusalCode } from './sample/sampleDrawing.js';
import { SamplePlanError } from './sample/samplePlanStore.js';

const MB = 1024 * 1024;

/**
 * A sample drawn against a Developer Edition with 5 MB left: 80 % of what is
 * left past the half MB kept for rounding, 3.6 MB, of which it takes 3.5.
 */
function sampleOf(over: Partial<WholeOrgSample> = {}): WholeOrgSample {
  return {
    seed: 1,
    draw: 'uniform',
    floor: 1,
    parents: 'all',
    children: 100,
    share: 0.0041,
    budget: {
      bytes: Math.floor(0.8 * 4.5 * MB),
      remainingMB: 5,
      maxMB: 5,
      share: 0.8,
      roundingMB: 0.5,
      limitedBy: 'storage',
    },
    rows: 1_812,
    storageBytes: 3.5 * MB,
    objects: [
      {
        objectApiName: 'Account',
        sourceRows: 18_400,
        kept: 712,
        roots: 500,
        below: 0,
        asParents: 212,
      },
      {
        objectApiName: 'Contact',
        sourceRows: 40_000,
        kept: 1_100,
        roots: 0,
        below: 1_100,
        asParents: 0,
        childrenCut: [{ field: 'AccountId', rows: 30 }],
      },
    ],
    whole: [],
    heavyRoots: [],
    dropped: [{ objectApiName: 'Contact', rows: 4, reason: 'outsideFilter' }],
    leftEmpty: [],
    noRecordDrawn: [{ objectApiName: 'Lead', sourceRows: 9_000 }],
    planRequests: { source: 61 },
    plan: {
      path: '/storage/forge-samples/abc',
      sha256: 'a'.repeat(64),
      drawnAt: '2026-11-14T14:02:00.000Z',
      drawnBy: 'dryRun',
    },
    ...over,
  };
}

/** What `/limits` of a target with `remainingMB` of 5 MB left say. */
function storageOf(remainingMB: number) {
  return { maxMB: 5, remainingMB };
}

describe('the rows a clone of the whole org leaves out for a lookup outside its filter', () => {
  it('counts them apart from the rows it writes, and says them', () => {
    const plan = writePlanOf([
      {
        objectApiName: 'Contact',
        rows: [],
        counted: { rows: 40 },
        leftOut: { outsideFilter: 6 },
      },
    ]);

    expect(plan.totalRows).toBe(40);
    expect(plan.leftOut).toEqual({
      writtenBefore: 0,
      heldBack: [],
      outsideFilter: [{ objectApiName: 'Contact', rows: 6 }],
    });
    expect(leftOutLines(plan.leftOut)).toEqual([
      "  not counted: Contact, 6 record(s) left aside: a lookup they may not leave empty names a record outside its object's filter, which the run does not copy",
    ]);
  });
});

describe('the gate of a sample of the whole org, against what the target has left now', () => {
  it('lets through a sample whose target has as much room as it was fitted to, or more', () => {
    const sample = sampleOf();

    expect(sampleGateStopOf({ sample, storage: storageOf(5), target: 'DEV' })).toBeUndefined();
    expect(sampleGateStopOf({ sample, storage: storageOf(5.2), target: 'DEV' })).toBeUndefined();
  });

  // The Simulate drew it against 5 MB left; the target filled meanwhile. Cut
  // to what is left, the run would not be the sample the user simulated:
  // refused, nothing written, and told to draw it again.
  it('refuses a sample whose target has less room than it was fitted to, telling it to simulate again', () => {
    const stop = sampleGateStopOf({ sample: sampleOf(), storage: storageOf(4), target: 'DEV' });

    expect(stop).toMatchObject({
      code: 'STORAGE_EXCEEDED',
      storage: { estimateMB: 3.5, remainingMB: 4 },
      sample: { fittedMB: 3.6, holdsMB: 2.8 },
    });
    expect(stop?.message).toBe(
      'The sample was fitted to 3.6 MB of the data storage DEV had left (5 MB), and DEV now ' +
        'says 4 MB left, which holds 2.8 MB of a sample: the sample takes about 3.5 MB. Simulate ' +
        'again — run the dry run again — to draw a sample that fits: a run never cuts its sample ' +
        'short. Nothing was written.',
    );
  });

  it('holds a sample fitted within the MB asked to the room the target has left for them', () => {
    const within = sampleOf({
      storageBytes: 0.9 * MB,
      budget: { ...sampleOf().budget, bytes: MB, withinMB: 1, limitedBy: 'within' },
    });

    // 80 % of 1.5 MB past the rounding holds 1.2 MB, more than the 1 MB asked.
    expect(
      sampleGateStopOf({ sample: within, storage: storageOf(2), target: 'DEV' }),
    ).toBeUndefined();
    // 80 % of 1 MB holds 0.8 MB, less than the sample's 0.9.
    expect(
      sampleGateStopOf({ sample: within, storage: storageOf(1.5), target: 'DEV' }),
    ).toMatchObject({ code: 'STORAGE_EXCEEDED', sample: { fittedMB: 1, holdsMB: 0.8 } });
  });

  it('refuses a sample fitted to the storage when the target no longer says it, nothing else bounding it', () => {
    const stop = sampleGateStopOf({
      sample: sampleOf(),
      storage: { unread: 'INSUFFICIENT_ACCESS' },
      target: 'DEV',
    });

    expect(stop).toMatchObject({ code: SAMPLE_STORAGE_UNREAD });
    expect(stop?.message).toBe(
      'The data storage DEV has left could not be read (INSUFFICIENT_ACCESS), and a sample is ' +
        'fitted to it: there is nothing to hold it to. Give the most it may take ' +
        '(--fit-within <MB>) or the most records (--max-total <n>), or run it again once the ' +
        'org answers. Nothing was written.',
    );
    // Held to the records asked, it is held to something: the gate's own
    // check of the storage says the storage could not be read.
    const bounded = sampleOf({ budget: { ...sampleOf().budget, maxTotal: 10_000 } });
    expect(
      sampleGateStopOf({
        sample: bounded,
        storage: { unread: 'INSUFFICIENT_ACCESS' },
        target: 'DEV',
      }),
    ).toBeUndefined();
  });

  it('holds a sample drawn against no storage to nothing of it, the records asked bounding it', () => {
    const records = sampleOf({
      budget: { bytes: 20 * MB, maxTotal: 10_000, limitedBy: 'maxTotal' },
    });

    expect(
      sampleGateStopOf({ sample: records, storage: storageOf(0.1), target: 'DEV' }),
    ).toBeUndefined();
  });
});

describe('a plan a run resumes or replays, refused with nothing written', () => {
  it('refuses a resume whose plan is gone or changed, as gone: its records cannot be taken up', () => {
    for (const refusal of ['gone', 'changed', 'otherSha'] as const) {
      const error = sampleGateErrorOf(new SamplePlanError(refusal, 'x'), 'resume');
      expect(error?.code).toBe(SAMPLE_PLAN_GONE);
      expect(error?.stop?.sample).toEqual({ plan: refusal });
      expect(error?.message).toMatch(/--resume.*Nothing was written\.$/);
    }
  });

  it('refuses a plan given to replay that is of another org, setup or plan, and a path that holds none', () => {
    const of = (refusal: 'gone' | 'changed' | 'otherOrg' | 'otherSetup' | 'otherSha') =>
      sampleGateErrorOf(new SamplePlanError(refusal, 'x'), 'replay');

    expect(of('otherOrg')?.code).toBe(SAMPLE_PLAN_MISMATCH);
    expect(of('otherOrg')?.message).toMatch(/drawn of another org than the source/);
    expect(of('otherSetup')?.code).toBe(SAMPLE_PLAN_MISMATCH);
    expect(of('otherSetup')?.message).toMatch(/drawn for another setup/);
    expect(of('changed')?.code).toBe(SAMPLE_PLAN_MISMATCH);
    expect(of('otherSha')?.code).toBe(SAMPLE_PLAN_MISMATCH);
    expect(of('gone')?.code).toBe(SAMPLE_PLAN_GONE);
    expect(of('gone')?.message).toMatch(/^No plan of a sample is at the path given to --fit-plan/);
    for (const refusal of ['gone', 'changed', 'otherOrg', 'otherSetup', 'otherSha'] as const) {
      expect(of(refusal)?.message).toMatch(/--fit-plan.*Nothing was written\.$/);
    }
  });

  it('is nothing for any other error', () => {
    // A refusal of the executor under a code the gate does not know is none of its stops.
    expect(
      sampleGateErrorOf(new SampleRefusedError('SAMPLE_LOST' as SampleRefusalCode, 'x'), 'draw'),
    ).toBeUndefined();
    expect(sampleGateErrorOf(new Error('INVALID_SESSION_ID'), 'draw')).toBeUndefined();
    expect(sampleGateErrorOf(undefined, 'resume')).toBeUndefined();
  });

  // What the executor's refusal says for the page besides its words, held to
  // what a stop may say: kept on the error, as the page reads it back.
  it('keeps what a refusal of the executor names for the page, and drops what no stop may say', () => {
    const refused = Object.assign(
      new SampleRefusedError('SAMPLE_CANNOT_FIT', 'No sample of the whole org fits.', [
        { objectApiName: 'Case', rows: 2_000, storageBytes: 4 * MB },
      ]),
      { sample: { needMB: 7.5, budgetMB: 3.6, heaviest: ['Case', 'Pricebook2'] } },
    );
    expect(forgeRunGateStopOf(sampleGateErrorOf(refused, 'draw')?.stop)).toEqual({
      code: SAMPLE_CANNOT_FIT,
      sample: { needMB: 7.5, budgetMB: 3.6, heaviest: ['Case', 'Pricebook2'] },
    });

    const tooLarge = Object.assign(
      new SampleRefusedError('SAMPLE_TOO_LARGE', 'Drawing the sample read too many records.'),
      { sample: { rows: 1_000_001, most: 1_000_000 } },
    );
    expect(sampleGateErrorOf(tooLarge, 'draw')?.stop).toEqual({
      code: SAMPLE_TOO_LARGE,
      sample: { rows: 1_000_001, most: 1_000_000 },
    });

    const forged = Object.assign(new SampleRefusedError('SAMPLE_TOO_LARGE', 'x'), {
      sample: { rows: -3 },
    });
    expect(sampleGateErrorOf(forged, 'draw')?.stop).toEqual({ code: SAMPLE_TOO_LARGE });
  });
});

/*
 * The executor refuses a sample as it draws it or takes up its plan under
 * codes of its own error (`SampleRefusedError`), which the page and the
 * command line read as the gate's: the same strings, each of them. A code
 * renamed or added on either side breaks the typecheck of the record below,
 * and the run of the test.
 */
describe('the refusals the executor raises as it draws a sample or takes up its plan', () => {
  const REFUSALS: Record<SampleRefusalCode, true> = {
    SAMPLE_TOO_LARGE: true,
    SAMPLE_CANNOT_FIT: true,
    SAMPLE_PLAN_GONE: true,
    SAMPLE_PLAN_MISMATCH: true,
  };

  it('names each by one of the gate’s codes, the same string', () => {
    expectTypeOf<SampleRefusalCode>().toExtend<ForgeRunGateCode>();
    expect(Object.keys(REFUSALS).sort()).toEqual(
      [SAMPLE_CANNOT_FIT, SAMPLE_PLAN_GONE, SAMPLE_PLAN_MISMATCH, SAMPLE_TOO_LARGE].sort(),
    );
    for (const code of Object.keys(REFUSALS)) expect(isForgeRunGateCode(code)).toBe(true);
  });

  it('turns each into the gate’s stop under its code, its words kept, whatever was being done', () => {
    for (const code of Object.keys(REFUSALS) as SampleRefusalCode[]) {
      for (const use of ['draw', 'replay', 'resume'] as const) {
        const error = sampleGateErrorOf(new SampleRefusedError(code, `Refused: ${code}.`), use);
        expect(isForgeRunGateError(error)).toBe(true);
        expect(error?.code).toBe(code);
        expect(error?.message).toBe(`Refused: ${code}.`);
        expect(forgeRunGateStopOf(error?.stop)?.code).toBe(code);
      }
    }
  });

  it('names the heaviest objects of a sample that cannot fit, as the page reads them', () => {
    const error = sampleGateErrorOf(
      new SampleRefusedError('SAMPLE_CANNOT_FIT', 'No sample of the whole org fits.', [
        { objectApiName: 'Case', rows: 2_000, storageBytes: 4 * MB },
        { objectApiName: 'Pricebook2', rows: 1_200, storageBytes: 2.4 * MB, whole: true },
      ]),
      'draw',
    );

    expect(forgeRunGateStopOf(error?.stop)).toEqual({
      code: SAMPLE_CANNOT_FIT,
      sample: { heaviest: ['Case', 'Pricebook2'] },
    });
  });

  it('is told by its name, thrown through another copy of the module', () => {
    const named = Object.assign(new Error('The plan is gone.'), {
      name: 'SampleRefusedError',
      code: 'SAMPLE_PLAN_GONE',
    });

    expect(sampleGateErrorOf(named, 'resume')?.code).toBe(SAMPLE_PLAN_GONE);
  });
});

/** A read of the limits that answers `answer`, and refuses anything else a dry run might send. */
function readOnlyOrg(answer: unknown): LimitsTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    request: async ({ method, url }: { method: string; url: string }) => {
      calls.push(`${method} ${url}`);
      if (method !== 'GET' || url !== '/limits') {
        throw new Error(`a dry run writes nothing, and it sent ${method} ${url}`);
      }
      return answer;
    },
  };
}

describe('the dry run of a sample of the whole org, stopped at its gate', () => {
  const graph: WholeOrgGraph = {
    nodes: [
      { objectApiName: 'Account', included: true, piiFields: [], anonymizeFields: [] },
      { objectApiName: 'Contact', included: true, piiFields: [], anonymizeFields: [] },
    ],
  };
  /*
   * What the plan hands the gate: 712 accounts, 10 of them person accounts;
   * 1,100 contacts, the 10 of the person accounts written by the platform
   * with them, and 4 left aside for an account outside the accounts' filter.
   */
  const objects = [
    { objectApiName: 'Account', rows: [], counted: { rows: 712, personAccounts: 10 } },
    {
      objectApiName: 'Contact',
      rows: [],
      counted: { rows: 1_090 },
      leftOut: { byThePlatform: 10, outsideFilter: 4 },
    },
  ];
  const limits = (remainingMB: number) => ({
    DataStorageMB: { Max: 5, Remaining: remainingMB },
    DailyApiRequests: { Max: 15_000, Remaining: 14_000 },
    DailyBulkApiBatches: { Max: 15_000, Remaining: 15_000 },
  });
  const sourceLimits = { DailyApiRequests: { Max: 15_000, Remaining: 14_000 } };

  it('counts on the plan, says what it drew before the rest, and reads nothing but the limits', async () => {
    const target = readOnlyOrg(limits(5));
    const source = readOnlyOrg(sourceLimits);
    const sample = sampleOf();

    const dry = await wholeOrgDryRunOf({
      objects,
      measures: {},
      graph,
      anonymizePII: true,
      sample,
      target: { org: 'DEV', limits: target },
      source: { org: 'PROD', limits: source },
    });

    expect(dry.sample).toEqual(sample);
    expect(dry.wouldInsert).toEqual([
      { objectApiName: 'Contact', rows: 1_090, jobs: 0, byRest: 1_090 },
      { objectApiName: 'Account', rows: 712, jobs: 0, byRest: 712 },
    ]);
    expect(dry.totalRows).toBe(1_802);
    // 702 business accounts at 2 KB and 10 person accounts at 4 KB, 1,090
    // contacts at 2 KB: the person accounts' contacts take none of their own.
    expect(dry.storage).toMatchObject({ verdict: 'fits', remainingMB: 5 });
    expect(dry.storage.estimateMB).toBeCloseTo((702 * 2 + 10 * 4 + 1_090 * 2) / 1024);
    expect(dry.leftOut.rows).toEqual({
      writtenBefore: 0,
      heldBack: [],
      byThePlatform: [{ objectApiName: 'Contact', rows: 10 }],
      outsideFilter: [{ objectApiName: 'Contact', rows: 4 }],
    });
    expect(dry.wouldBeRefused).toEqual([]);
    expect(target.calls).toEqual(['GET /limits']);
    expect(source.calls).toEqual(['GET /limits']);
  });

  it('names among the refusals a target that has less room than the sample was fitted to, once', async () => {
    const dry = await wholeOrgDryRunOf({
      objects,
      measures: {},
      graph,
      anonymizePII: true,
      sample: sampleOf({ storageBytes: 3.5 * MB }),
      target: { org: 'DEV', limits: readOnlyOrg(limits(3)) },
      source: { org: 'PROD', limits: readOnlyOrg(sourceLimits) },
    });

    expect(dry.wouldBeRefused.map(({ code, sample }) => ({ code, sample }))).toEqual([
      { code: 'STORAGE_EXCEEDED', sample: { fittedMB: 3.6, holdsMB: 2 } },
    ]);
    expect(dry.wouldBeRefused[0]?.message).toMatch(/Simulate again/);
  });

  it('says no sample for a clone of every record', async () => {
    const dry = await wholeOrgDryRunOf({
      objects,
      measures: {},
      graph,
      anonymizePII: true,
      target: { org: 'DEV', limits: readOnlyOrg(limits(5)) },
      source: { org: 'PROD', limits: readOnlyOrg(sourceLimits) },
    });

    expect(dry).not.toHaveProperty('sample');
  });
});
