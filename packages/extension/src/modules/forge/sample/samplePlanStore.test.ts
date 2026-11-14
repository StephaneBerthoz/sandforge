import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SAMPLE_PLAN_MAX_AGE_MS,
  SamplePlan,
  SamplePlanError,
  adoptSamplePlan,
  copySamplePlan,
  copySamplePlanTo,
  dryRunPlanDirOf,
  giveBackSamplePlan,
  keepSamplePlan,
  lastDryRunPlan,
  removeSamplePlan,
  runPlanDirOf,
  samplesDirOf,
  sweepSamplePlans,
  type SamplePlanToKeep,
  type WholeOrgSampleDrawn,
} from './samplePlanStore.js';
import { compareIds } from './sampleRank.js';

/*
 * The plan of a sample on disk: its ids, in their own order, and what was
 * drawn, refused when it is no longer as it was written; its owner's alone
 * where the platform keeps POSIX modes.
 */

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

/** What a small sample drew. */
const DRAWN: WholeOrgSampleDrawn = {
  seed: 1,
  draw: 'uniform',
  floor: 1,
  parents: 'all',
  children: 100,
  share: 0.004,
  budget: {
    bytes: 3_700_000,
    remainingMB: 5,
    maxMB: 5,
    share: 0.8,
    roundingMB: 0.5,
    limitedBy: 'storage',
  },
  rows: 5,
  storageBytes: 10_240,
  objects: [
    { objectApiName: 'Account', sourceRows: 900, kept: 2, roots: 2, below: 0, asParents: 0 },
    {
      objectApiName: 'Contact',
      sourceRows: 4_000,
      kept: 3,
      roots: 0,
      below: 3,
      asParents: 0,
      childrenCut: [{ field: 'AccountId', rows: 12 }],
    },
  ],
  whole: [{ objectApiName: 'Region__c', why: 'smallParent' }],
  heavyRoots: [
    {
      objectApiName: 'Account',
      id: fakeId('001', 77),
      rows: 3_100,
      relation: { objectApiName: 'Task', field: 'WhatId' },
    },
  ],
  dropped: [{ objectApiName: 'Contact', rows: 1, reason: 'outsideFilter' }],
  leftEmpty: [],
  noRecordDrawn: [{ objectApiName: 'Case', sourceRows: 40 }],
  planRequests: { source: 31 },
};

const SOURCE = 'source-org';
const FINGERPRINT = 'f00d';

/** A plan of two accounts and three contacts, given out of their order. */
function planOf(overrides: Partial<SamplePlanToKeep> = {}): SamplePlanToKeep {
  return {
    sourceOrgId: SOURCE,
    fingerprint: FINGERPRINT,
    drawnAt: new Date('2026-11-13T14:02:00.000Z'),
    drawnBy: 'dryRun',
    sample: DRAWN,
    ids: [
      { objectApiName: 'Contact', ids: [fakeId('003', 9), fakeId('003', 2), fakeId('003', 5)] },
      { objectApiName: 'Account', ids: [fakeId('001', 4), fakeId('001', 1)] },
    ],
    ...overrides,
  };
}

/** Every id of an object of `plan`, from `after`. */
async function idsOf(plan: SamplePlan, object: string, after?: string): Promise<string[]> {
  const ids: string[] = [];
  for await (const page of plan.ids(object, { after, size: 2 })) ids.push(...page);
  return ids;
}

/** Why opening the plan in `dir` was refused, or undefined when it was not. */
async function refusalOf(
  dir: string,
  expected?: Parameters<typeof SamplePlan.open>[1],
): Promise<string | undefined> {
  try {
    await SamplePlan.open(dir, expected);
    return undefined;
  } catch (error) {
    if (error instanceof SamplePlanError) return error.refusal;
    throw error;
  }
}

let storage: string;

beforeEach(async () => {
  storage = await mkdtemp(join(tmpdir(), 'sample-plan-'));
});

afterEach(async () => {
  await rm(storage, { recursive: true, force: true });
});

describe('the plan of a sample', () => {
  it('keeps each object’s ids in their order, each once, and reads them back a page at a time', async () => {
    const dir = dryRunPlanDirOf(storage, FINGERPRINT);
    const plan = await keepSamplePlan(
      dir,
      planOf({
        ids: [
          {
            objectApiName: 'Contact',
            // The same record given twice, once at each length.
            ids: [
              fakeId('003', 9),
              fakeId('003', 2),
              fakeId('003', 5),
              fakeId('003', 2).slice(0, 15),
            ],
          },
        ],
      }),
    );

    expect(plan.dir).toBe(join(storage, 'forge-samples', FINGERPRINT));
    expect(await idsOf(plan, 'Contact')).toEqual([
      fakeId('003', 2),
      fakeId('003', 5),
      fakeId('003', 9),
    ]);
    expect(plan.countOf('Contact')).toBe(3);
    expect(plan.countOf('Account')).toBe(0);
    expect(plan.manifest.sample).toEqual(DRAWN);
    expect(plan.manifest.newestByIds).toBeUndefined();
    expect(plan.place).toEqual({
      path: dir,
      sha256: plan.sha256,
      drawnAt: '2026-11-13T14:02:00.000Z',
      drawnBy: 'dryRun',
    });
  });

  it('says which objects’ newest were read in the order of their ids, having no creation date the org orders by', async () => {
    const plan = await keepSamplePlan(
      dryRunPlanDirOf(storage, FINGERPRINT),
      planOf({ sample: { ...DRAWN, draw: 'recent' }, newestByIds: ['Region__c'] }),
    );

    expect((await SamplePlan.open(plan.dir)).manifest.newestByIds).toEqual(['Region__c']);
  });

  it('keeps the masters a sample keeps part of the details of, and what its automation creates, for the run that takes it up to say', async () => {
    const said: WholeOrgSampleDrawn = {
      ...DRAWN,
      budget: { ...DRAWN.budget, automationMB: 1.65 },
      partialMasters: [
        {
          objectApiName: 'Opportunity',
          details: 'OpportunityLineItem',
          field: 'OpportunityId',
          kept: 3,
          sourceRows: 4,
        },
      ],
    };
    const plan = await keepSamplePlan(
      dryRunPlanDirOf(storage, FINGERPRINT),
      planOf({ sample: said }),
    );

    const { sample } = (await SamplePlan.open(plan.dir)).manifest;
    expect(sample.partialMasters).toEqual(said.partialMasters);
    expect(sample.budget.automationMB).toBe(1.65);
  });

  it('opens again a plan the roots set aside held, every other root kept', async () => {
    const aside: WholeOrgSampleDrawn = {
      ...DRAWN,
      share: 1,
      budget: { ...DRAWN.budget, limitedBy: 'heavyRoots' },
    };
    const plan = await keepSamplePlan(
      dryRunPlanDirOf(storage, FINGERPRINT),
      planOf({ sample: aside }),
    );

    expect((await SamplePlan.open(plan.dir)).manifest.sample.budget.limitedBy).toBe('heavyRoots');
  });

  it('keeps how the roots were chosen, a sample its draw held, and the objects whose oldest were read by their ids', async () => {
    const chosen: WholeOrgSampleDrawn = {
      ...DRAWN,
      draw: 'oldest',
      share: 1,
      budget: { ...DRAWN.budget, limitedBy: 'draw' },
      objects: [
        { ...DRAWN.objects[0], rootsInTheSource: 900, rootsInTheDraw: 2 },
        DRAWN.objects[1],
      ],
      noRecordDrawn: [{ objectApiName: 'Case', sourceRows: 40, noRootInTheDraw: true }],
      roots: {
        window: {
          field: 'CreatedDate',
          from: '2026-08-15T09:30:00Z',
          lastDays: 90,
        },
        notWindowed: ['Region__c'],
        where: [{ objectApiName: 'Account', where: "BillingCountry = 'France'" }],
        strata: [
          {
            objectApiName: 'Account',
            field: 'RecordTypeId',
            values: [
              { value: '012000000000BUSAAA', label: 'Business', roots: 850, kept: 1 },
              { value: null, roots: 50, kept: 1 },
            ],
          },
        ],
      },
      oldestByIds: ['Lead'],
    };
    const plan = await keepSamplePlan(
      dryRunPlanDirOf(storage, FINGERPRINT),
      planOf({ sample: chosen, oldestByIds: ['Lead'] }),
    );

    const { manifest } = await SamplePlan.open(plan.dir);
    expect(manifest.sample).toEqual(chosen);
    expect(manifest.oldestByIds).toEqual(['Lead']);
  });

  it('reads the plan of a sample a 1.80 drew, before its roots could be chosen, as one that chose none', async () => {
    const kept = await keepSamplePlan(dryRunPlanDirOf(storage, FINGERPRINT), planOf());
    // The manifest as 1.80 wrote it, key for key: no window, filter,
    // stratum, roots counted apart nor oldest.
    const written = {
      version: 1,
      sourceOrgId: SOURCE,
      fingerprint: FINGERPRINT,
      drawnAt: '2026-11-13T14:02:00.000Z',
      drawnBy: 'dryRun',
      sha256: kept.sha256,
      objects: kept.manifest.objects,
      sample: {
        seed: 1,
        draw: 'recent',
        floor: 1,
        parents: 'all',
        children: 100,
        share: 0.004,
        budget: {
          bytes: 3_700_000,
          remainingMB: 5,
          maxMB: 5,
          share: 0.8,
          roundingMB: 0.5,
          limitedBy: 'storage',
        },
        rows: 5,
        storageBytes: 10_240,
        objects: [
          { objectApiName: 'Account', sourceRows: 900, kept: 2, roots: 2, below: 0, asParents: 0 },
          {
            objectApiName: 'Contact',
            sourceRows: 4_000,
            kept: 3,
            roots: 0,
            below: 3,
            asParents: 0,
          },
        ],
        whole: [],
        heavyRoots: [],
        dropped: [],
        leftEmpty: [],
        noRecordDrawn: [{ objectApiName: 'Case', sourceRows: 40 }],
        planRequests: { source: 31 },
        newestByIds: ['Region__c'],
      },
      newestByIds: ['Region__c'],
      counts: { personAccounts: {}, byThePlatform: [] },
    };
    await writeFile(join(kept.dir, 'sample.json'), `${JSON.stringify(written)}\n`);

    const { manifest } = await SamplePlan.open(kept.dir, { sha256: kept.sha256 });
    expect(manifest.sample.draw).toBe('recent');
    expect(manifest.sample.roots).toBeUndefined();
    expect(manifest.sample.oldestByIds).toBeUndefined();
    expect(manifest.sample.objects[0]).not.toHaveProperty('rootsInTheDraw');
    expect(manifest.oldestByIds).toBeUndefined();
  });

  it('gives the ids after the last one a run wrote, whether or not it is the plan’s', async () => {
    const plan = await keepSamplePlan(dryRunPlanDirOf(storage, FINGERPRINT), planOf());

    expect(await idsOf(plan, 'Contact', fakeId('003', 2))).toEqual([
      fakeId('003', 5),
      fakeId('003', 9),
    ]);
    expect(await idsOf(plan, 'Contact', fakeId('003', 6))).toEqual([fakeId('003', 9)]);
    expect(await idsOf(plan, 'Contact', fakeId('003', 9))).toEqual([]);
  });

  it('has the SHA-256 of its ids alone: the same ids in another order, drawn at another time, the same; another id, another', async () => {
    const first = await keepSamplePlan(dryRunPlanDirOf(storage, 'a1'), planOf());
    const again = await keepSamplePlan(
      dryRunPlanDirOf(storage, 'a2'),
      planOf({
        drawnAt: new Date('2026-11-14T09:00:00.000Z'),
        ids: [
          { objectApiName: 'Account', ids: [fakeId('001', 1), fakeId('001', 4)] },
          { objectApiName: 'Contact', ids: [fakeId('003', 5), fakeId('003', 9), fakeId('003', 2)] },
        ],
      }),
    );
    const other = await keepSamplePlan(
      dryRunPlanDirOf(storage, 'a3'),
      planOf({ ids: [{ objectApiName: 'Account', ids: [fakeId('001', 1), fakeId('001', 5)] }] }),
    );

    expect(again.sha256).toBe(first.sha256);
    expect(other.sha256).not.toBe(first.sha256);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is its owner’s alone, its folder and every file of it', async () => {
    const plan = await keepSamplePlan(dryRunPlanDirOf(storage, FINGERPRINT), planOf());

    // Windows keeps no POSIX mode: the plan is under the user's own profile there.
    if (process.platform === 'win32') return;
    expect((await stat(plan.dir)).mode & 0o777).toBe(0o700);
    expect((await stat(samplesDirOf(storage))).mode & 0o077).toBe(0);
    const files = await readdir(plan.dir);
    expect(files.sort()).toEqual(['Account.ids', 'Contact.ids', 'sample.json', 'spool.json']);
    for (const name of files) {
      expect((await stat(join(plan.dir, name))).mode & 0o777, name).toBe(0o600);
    }
  });

  it('refuses a plan whose ids changed since it was written, and one whose manifest no longer reads', async () => {
    const dir = dryRunPlanDirOf(storage, FINGERPRINT);
    await keepSamplePlan(dir, planOf());
    const contacts = join(dir, 'Contact.ids');
    const written = await readFile(contacts, 'utf8');

    // One id for another: the count is the same, the ids are not.
    await writeFile(contacts, written.replace(fakeId('003', 5), fakeId('003', 6)));
    expect(await refusalOf(dir)).toBe('changed');

    await writeFile(contacts, written);
    expect(await refusalOf(dir)).toBeUndefined();
    await appendFile(contacts, `${fakeId('003', 11)}\n`);
    expect(await refusalOf(dir)).toBe('changed');

    await writeFile(contacts, written);
    await writeFile(join(dir, 'sample.json'), '{"version":1}');
    expect(await refusalOf(dir)).toBe('changed');
  });

  it('says a plan gone when its folder is not there, and refuses one of another org, setup or SHA-256', async () => {
    const dir = dryRunPlanDirOf(storage, FINGERPRINT);
    const plan = await keepSamplePlan(dir, planOf());

    expect(await refusalOf(dir, { sourceOrgId: 'another-org' })).toBe('otherOrg');
    expect(await refusalOf(dir, { fingerprint: 'beef' })).toBe('otherSetup');
    expect(await refusalOf(dir, { sha256: '0'.repeat(64) })).toBe('otherSha');
    expect(
      await refusalOf(dir, { sourceOrgId: SOURCE, fingerprint: FINGERPRINT, sha256: plan.sha256 }),
    ).toBeUndefined();

    await removeSamplePlan(dir);
    expect(await refusalOf(dir)).toBe('gone');
  });

  it('puts a new plan in the place of the last one of the same setup, whole', async () => {
    const dir = dryRunPlanDirOf(storage, FINGERPRINT);
    await keepSamplePlan(dir, planOf());
    const second = await keepSamplePlan(
      dir,
      planOf({ ids: [{ objectApiName: 'Account', ids: [fakeId('001', 8)] }] }),
    );

    expect(await readdir(dir)).toEqual(expect.not.arrayContaining(['Contact.ids']));
    expect(await idsOf(second, 'Account')).toEqual([fakeId('001', 8)]);
    expect(await readdir(samplesDirOf(storage))).toEqual([FINGERPRINT]);
  });

  it('leaves no folder behind when a plan cannot be kept, and the last one as it was', async () => {
    const dir = dryRunPlanDirOf(storage, FINGERPRINT);
    const first = await keepSamplePlan(dir, planOf());

    await expect(
      keepSamplePlan(dir, planOf({ ids: [{ objectApiName: 'Account', ids: ['not-an-id'] }] })),
    ).rejects.toThrow(RangeError);

    expect(await readdir(samplesDirOf(storage))).toEqual([FINGERPRINT]);
    expect((await SamplePlan.open(dir)).sha256).toBe(first.sha256);
  });

  it('refuses a fingerprint that is no name of a folder', () => {
    expect(() => dryRunPlanDirOf(storage, '../runs')).toThrow(SamplePlanError);
  });
});

describe('the plan a run takes up', () => {
  it('takes up the last dry run’s plan of the same setup while it is less than a day old', async () => {
    const drawnAt = new Date('2026-11-13T14:02:00.000Z');
    await keepSamplePlan(dryRunPlanDirOf(storage, FINGERPRINT), planOf({ drawnAt }));
    const later = (ms: number): Date => new Date(drawnAt.getTime() + ms);

    const fresh = await lastDryRunPlan(storage, FINGERPRINT, later(SAMPLE_PLAN_MAX_AGE_MS - 1));
    const stale = await lastDryRunPlan(storage, FINGERPRINT, later(SAMPLE_PLAN_MAX_AGE_MS));
    const none = await lastDryRunPlan(storage, 'beef', later(1));

    expect(fresh).toBeInstanceOf(SamplePlan);
    expect(stale).toBe('tooOld');
    expect(none).toBeUndefined();
  });

  it('moves the plan beside the run’s journal before the run writes, where no other run takes it up', async () => {
    const plan = await keepSamplePlan(dryRunPlanDirOf(storage, FINGERPRINT), planOf());

    const adopted = await adoptSamplePlan(plan, storage, 'run:2026-11-13/1');

    expect(adopted.dir).toBe(runPlanDirOf(storage, 'run:2026-11-13/1'));
    expect(adopted.dir).toBe(join(storage, 'forge-runs', 'run_2026-11-13_1.sample'));
    expect(adopted.sha256).toBe(plan.sha256);
    expect(await idsOf(adopted, 'Account')).toEqual([fakeId('001', 1), fakeId('001', 4)]);
    expect(await lastDryRunPlan(storage, FINGERPRINT, new Date('2026-11-13T15:00:00Z'))).toBe(
      undefined,
    );
    if (process.platform !== 'win32') {
      expect((await stat(adopted.dir)).mode & 0o777).toBe(0o700);
    }
  });

  it('puts a plan a run took up back where it was given, unless that folder holds a plan drawn since', async () => {
    const given = dryRunPlanDirOf(storage, FINGERPRINT);
    const plan = await keepSamplePlan(given, planOf());
    await adoptSamplePlan(plan, storage, 'run-1');

    expect(await giveBackSamplePlan(storage, 'run-1', given)).toBe(true);
    const back = await lastDryRunPlan(storage, FINGERPRINT, new Date('2026-11-13T15:00:00Z'));
    expect(back instanceof SamplePlan && back.sha256).toBe(plan.sha256);
    // Nothing left beside the run's journal: nothing to put back twice.
    expect(await giveBackSamplePlan(storage, 'run-1', given)).toBe(false);

    // A simulation drew another meanwhile: it is the last of its setup.
    await adoptSamplePlan(await SamplePlan.open(given), storage, 'run-2');
    await keepSamplePlan(given, planOf({ drawnAt: new Date('2026-11-13T14:30:00.000Z') }));
    expect(await giveBackSamplePlan(storage, 'run-2', given)).toBe(false);
  });

  it('copies the plan of a run beside the journal of the run that retries it, and leaves the run’s own', async () => {
    const plan = await adoptSamplePlan(
      await keepSamplePlan(dryRunPlanDirOf(storage, FINGERPRINT), planOf()),
      storage,
      'run-1',
    );

    const copy = await copySamplePlan(plan, storage, 'retry-1');

    expect(copy.dir).toBe(runPlanDirOf(storage, 'retry-1'));
    expect(copy.sha256).toBe(plan.sha256);
    expect(await idsOf(copy, 'Account')).toEqual(await idsOf(plan, 'Account'));
    expect((await SamplePlan.open(plan.dir)).sha256).toBe(plan.sha256);
    if (process.platform !== 'win32') {
      expect((await stat(copy.dir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(copy.dir, 'sample.json'))).mode & 0o777).toBe(0o600);
    }
  });

  it('copies the plan a dry run drew to a folder of its own, held to the SHA-256 it was shown with, its owner’s alone', async () => {
    const drawn = await keepSamplePlan(dryRunPlanDirOf(storage, FINGERPRINT), planOf());
    const dest = join(storage, 'mcp-plans', 'co-1', 'sample');

    const copy = await copySamplePlanTo(drawn.dir, dest, drawn.sha256);

    expect(copy.dir).toBe(dest);
    expect(copy.sha256).toBe(drawn.sha256);
    expect(copy.manifest).toEqual(drawn.manifest);
    expect(await idsOf(copy, 'Contact')).toEqual(await idsOf(drawn, 'Contact'));
    // The dry run's own stays where the run after it may take it up.
    expect((await SamplePlan.open(drawn.dir)).sha256).toBe(drawn.sha256);
    // The next dry run of the same setup replaces that one; the copy stays the one shown.
    await keepSamplePlan(
      drawn.dir,
      planOf({ ids: [{ objectApiName: 'Account', ids: [fakeId('001', 8)] }] }),
    );
    expect((await SamplePlan.open(dest, { sha256: drawn.sha256 })).count).toBe(5);
    if (process.platform !== 'win32') {
      expect((await stat(dest)).mode & 0o777).toBe(0o700);
      for (const name of await readdir(dest)) {
        expect((await stat(join(dest, name))).mode & 0o777, name).toBe(0o600);
      }
    }
  });

  it('copies nothing of a plan that is no longer the one of the SHA-256 given, changed or gone', async () => {
    const drawn = await keepSamplePlan(dryRunPlanDirOf(storage, FINGERPRINT), planOf());
    const dest = join(storage, 'mcp-plans', 'co-2', 'sample');
    const refusal = async (dir: string, sha256: string): Promise<string | undefined> => {
      try {
        await copySamplePlanTo(dir, dest, sha256);
        return undefined;
      } catch (error) {
        if (error instanceof SamplePlanError) return error.refusal;
        throw error;
      }
    };

    // Drawn again since the plan was shown: another plan in the same folder.
    expect(await refusal(drawn.dir, '0'.repeat(64))).toBe('otherSha');
    const contacts = join(drawn.dir, 'Contact.ids');
    const written = await readFile(contacts, 'utf8');
    await writeFile(contacts, written.replace(fakeId('003', 5), fakeId('003', 6)));
    expect(await refusal(drawn.dir, drawn.sha256)).toBe('changed');
    await rm(drawn.dir, { recursive: true });
    expect(await refusal(drawn.dir, drawn.sha256)).toBe('gone');
    expect(await stat(dest).catch(() => undefined)).toBeUndefined();
  });

  it('sweeps the dry runs’ plans a day old and the folders a keep left half written, and keeps the others', async () => {
    const now = new Date('2026-11-14T15:00:00.000Z');
    await keepSamplePlan(
      dryRunPlanDirOf(storage, 'old'),
      planOf({ drawnAt: new Date(now.getTime() - SAMPLE_PLAN_MAX_AGE_MS) }),
    );
    await keepSamplePlan(
      dryRunPlanDirOf(storage, 'new'),
      planOf({ drawnAt: new Date(now.getTime() - 60_000) }),
    );
    const half = join(samplesDirOf(storage), 'new.1234-abcd.tmp');
    await keepSamplePlan(half, planOf());
    await rm(join(half, 'sample.json'));
    const dayAgo = new Date(now.getTime() - SAMPLE_PLAN_MAX_AGE_MS - 1_000);
    await utimes(half, dayAgo, dayAgo);

    expect(await sweepSamplePlans(storage, now)).toBe(2);
    expect(await readdir(samplesDirOf(storage))).toEqual(['new']);
    expect(await sweepSamplePlans(join(storage, 'nowhere'), now)).toBe(0);
  });
});

describe('the order of a plan’s ids', () => {
  it('puts ids in the order of their keys, digits before capitals before small letters, either length alike', () => {
    const ids = ['001000000000abcAAA', '001000000000ABC', '0010000000000aa', '001000000000999AAA'];

    expect([...ids].sort(compareIds)).toEqual([
      '0010000000000aa',
      '001000000000999AAA',
      '001000000000ABC',
      '001000000000abcAAA',
    ]);
    expect(compareIds('001000000000ABCxyz', '001000000000ABC')).toBe(0);
  });
});
