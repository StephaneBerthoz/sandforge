import { describe, expect, it } from 'vitest';
import type { WholeOrgSample } from '@sandforge/shared';
import {
  WholeOrgDryRunStop,
  carriedOf,
  isWholeOrgDryRunStop,
  pricedOfTheDryRun,
  wholeOrgConfirmationOf,
} from './wholeOrgRun.js';
import type { WholeOrgBoundary } from './ForgeExecutor.js';
import { writePlanOf, type WholeOrgDryRun, type WholeOrgGraph } from './ForgeRunGate.js';

describe('what narrows a clone of the whole org', () => {
  it('names each object read through a filter, left out, held back or copied without fields, in order', () => {
    expect(
      carriedOf({
        objectSoqlFilters: { Case: "Status = 'Open'", Account: 'Rating != null' },
        excludedObjects: ['Task', 'Event', 'Task'],
        skippedRows: [
          { object: 'Lead', gapId: 'g1' },
          { object: 'Lead', gapId: 'g2' },
        ] as never,
        fieldExclusions: { Contact: ['Birthdate'], Opportunity: [] },
      }),
    ).toEqual({
      filters: ['Account', 'Case'],
      excluded: ['Event', 'Task'],
      heldBack: ['Lead'],
      fieldsLeftOut: ['Contact'],
    });
  });

  it('is nothing when nothing narrows it', () => {
    expect(carriedOf({ fieldExclusions: { Contact: [] } })).toBeUndefined();
  });

  // A sample copies part of every object: it narrows the run whatever else
  // does, said with each option as it applies — those left out at their
  // default —, the objects copied whole once each, and never the path of a
  // plan, which names nothing the run copies.
  it('names a sample among what narrows it, each option as it applies, and no plan', () => {
    expect(
      carriedOf({
        sample: {
          withinMB: 3,
          seed: 7,
          whole: ['Region__c', 'Country__c', 'Region__c'],
          plan: '/tmp/p',
        },
      }),
    ).toEqual({
      filters: [],
      excluded: [],
      heldBack: [],
      fieldsLeftOut: [],
      sample: {
        withinMB: 3,
        seed: 7,
        draw: 'uniform',
        parents: 'all',
        children: 100,
        floor: 1,
        whole: ['Country__c', 'Region__c'],
      },
    });
  });
});

describe('the stop of a dry run of the whole org at its gate', () => {
  it('carries what the dry run said, and is told by its class or by its name', () => {
    const dryRun = { totalRows: 3 } as WholeOrgDryRun;
    const stop = new WholeOrgDryRunStop(dryRun);

    expect(stop.dryRun).toBe(dryRun);
    expect(isWholeOrgDryRunStop(stop)).toBe(true);
    // Through another copy of the module, a bundle's, by its name and what it holds.
    const named = Object.assign(new Error('x'), { name: 'WholeOrgDryRunStop', dryRun });
    expect(isWholeOrgDryRunStop(named)).toBe(true);
    expect(isWholeOrgDryRunStop(new Error('WholeOrgDryRunStop'))).toBe(false);
  });
});

describe('the question of a clone of the whole org', () => {
  const graph: WholeOrgGraph = {
    nodes: [
      {
        objectApiName: 'Case',
        included: true,
        piiFields: ['SuppliedEmail', 'SuppliedPhone'],
        anonymizeFields: ['SuppliedEmail'],
      },
      { objectApiName: 'ns__Policy__c', included: true, piiFields: [], anonymizeFields: [] },
    ],
    leftOut: [{ objectApiName: 'User', reason: 'setup' }],
  };
  const plan = writePlanOf([
    { objectApiName: 'Case', rows: [], counted: { rows: 12_000 } },
    { objectApiName: 'ns__Policy__c', rows: [], counted: { rows: 300 } },
  ]);
  const measures: WholeOrgBoundary = {
    writes: [
      { objectApiName: 'Case', rows: 12_000, jobs: 2, jobRows: 12_000, restRows: 0 },
      { objectApiName: 'ns__Policy__c', rows: 300, jobs: 0, jobRows: 0, restRows: 300 },
    ],
    sourceReads: 8,
    contactPointsBlanked: 40,
  };
  const dry = {
    targetRequests: { verdict: 'fits', estimate: 40, remaining: 90_000, max: 100_000 },
    sourceRequests: { verdict: 'near', estimate: 8, remaining: 80, max: 1_000 },
    bulkBatches: { verdict: 'fits', estimate: 2, remaining: 15_000, max: 15_000 },
    durationSeconds: 300,
  } as WholeOrgDryRun;

  it('says, from what its dry run priced, the requests, jobs, managed packages, phones written empty and personal fields copied as they are', () => {
    const question = wholeOrgConfirmationOf({
      run: { source: 'SRC', graph, anonymizePII: true },
      measures,
      plan,
      budget: pricedOfTheDryRun(dry),
    });

    expect(question).toEqual({
      source: 'SRC',
      leftOut: 1,
      targetApi: { estimate: 40, remaining: 90_000, max: 100_000 },
      sourceApi: { estimate: 8, remaining: 80, max: 1_000, near: true },
      bulk: {
        jobs: 2,
        jobRows: 12_000,
        restRows: 300,
        batches: { estimate: 2, remaining: 15_000, max: 15_000 },
      },
      durationSeconds: 300,
      restObjects: ['ns__Policy__c'],
      managedPackages: ['ns__Policy__c'],
      contactPointsBlanked: 40,
      personalAsIs: [{ objectApiName: 'Case', fields: ['SuppliedPhone'] }],
    });
  });

  it('says what an org would not tell of an allowance, and no jobs for a run that sends none', () => {
    const question = wholeOrgConfirmationOf({
      run: {
        source: 'SRC',
        graph,
        anonymizePII: false,
        carried: { filters: ['Case'], excluded: [], heldBack: [], fieldsLeftOut: [] },
      },
      measures: { ...measures, writes: measures.writes.map((w) => ({ ...w, jobs: 0 })) },
      plan,
      budget: pricedOfTheDryRun({
        ...dry,
        targetRequests: { verdict: 'unread', estimate: 40, unread: 'refused' },
      }),
    });

    expect(question.targetApi).toEqual({ estimate: 40, unread: 'refused' });
    expect(question).not.toHaveProperty('bulk');
    expect(question.carried).toEqual({
      filters: ['Case'],
      excluded: [],
      heldBack: [],
      fieldsLeftOut: [],
    });
    expect(question.personalAsIs).toEqual([
      { objectApiName: 'Case', fields: ['SuppliedEmail', 'SuppliedPhone'] },
    ]);
  });

  // "Copy a sample of SRC into TGT: 1 812 records of 37 objects (of
  // 1 284 330), 3.5 MB of the 3.6 MB budget; seed 1, 0.41 % of the roots;
  // drawn at 14:02 by the simulation."
  it('says of a sample what it keeps of the source, the storage of its budget, its seed, draw and share, what held it, and how old its plan is', () => {
    const MB = 1024 * 1024;
    const sample: WholeOrgSample = {
      seed: 1,
      draw: 'uniform',
      floor: 1,
      parents: 'required',
      children: 100,
      share: 0.0041,
      budget: { bytes: 3.6 * MB, remainingMB: 5, maxMB: 5, share: 0.8, limitedBy: 'storage' },
      rows: 1_812,
      storageBytes: 3.5 * MB,
      objects: [
        {
          objectApiName: 'Case',
          sourceRows: 1_200_000,
          kept: 1_100,
          roots: 0,
          below: 1_100,
          asParents: 0,
        },
        {
          objectApiName: 'Account',
          sourceRows: 18_400,
          kept: 712,
          roots: 500,
          below: 0,
          asParents: 212,
        },
      ],
      whole: [],
      heavyRoots: [
        {
          objectApiName: 'Account',
          id: '001000000000001AAA',
          rows: 900,
          relation: { objectApiName: 'Case', field: 'AccountId' },
        },
      ],
      dropped: [],
      leftEmpty: [
        { objectApiName: 'Case', field: 'ContactId', rows: 40 },
        { objectApiName: 'Case', field: 'AssetId', rows: 2 },
      ],
      noRecordDrawn: [{ objectApiName: 'Lead', sourceRows: 65_930 }],
      planRequests: { source: 61 },
      plan: {
        path: '/storage/forge-samples/abc',
        sha256: 'b'.repeat(64),
        drawnAt: '2026-11-14T14:02:00.000Z',
        drawnBy: 'dryRun',
      },
    };

    const question = wholeOrgConfirmationOf({
      run: { source: 'SRC', graph, anonymizePII: true },
      measures,
      plan,
      budget: pricedOfTheDryRun(dry),
      sample,
      now: Date.parse('2026-11-14T14:09:30.000Z'),
    });

    expect(question.sample).toEqual({
      rows: 1_812,
      objects: 2,
      sourceRows: 1_284_330,
      storageMB: 3.5,
      budgetMB: 3.6,
      seed: 1,
      draw: 'uniform',
      share: 0.0041,
      limitedBy: 'storage',
      parents: 'required',
      children: 100,
      drawnAt: '2026-11-14T14:02:00.000Z',
      drawnBy: 'dryRun',
      minutesBefore: 8,
      leftEmpty: 42,
      heavyRoots: 1,
      noRecordDrawn: 1,
    });
    // No id and no path: the question is put in a modal, and kept nowhere.
    expect(JSON.stringify(question)).not.toMatch(/001000000000001AAA|forge-samples/);
    // Drawn by the run itself, with the reason it did not take up the
    // simulation's: said, and no age.
    const own = wholeOrgConfirmationOf({
      run: { source: 'SRC', graph, anonymizePII: true },
      measures,
      plan,
      budget: pricedOfTheDryRun(dry),
      sample: { ...sample, plan: { ...sample.plan, drawnBy: 'run', drawnAgain: 'tooOld' } },
      now: Date.parse('2026-11-14T14:09:30.000Z'),
    });
    expect(own.sample).toMatchObject({ drawnBy: 'run', drawnAgain: 'tooOld' });
    expect(own.sample).not.toHaveProperty('minutesBefore');
    expect(own.sample).not.toHaveProperty('newestByIds');
  });

  // The most recent records of an object with no creation date the org
  // sorts by were drawn in the order of their ids, which follow the making
  // of records within a load only: the question says which objects.
  it('says of a draw by recency the objects whose newest were read by their ids', () => {
    const MB = 1024 * 1024;
    const question = wholeOrgConfirmationOf({
      run: { source: 'SRC', graph, anonymizePII: true },
      measures,
      plan,
      budget: pricedOfTheDryRun(dry),
      sample: {
        seed: 1,
        draw: 'recent',
        floor: 1,
        parents: 'all',
        children: 100,
        share: 0.5,
        budget: { bytes: MB, limitedBy: 'maxTotal', maxTotal: 500 },
        rows: 500,
        storageBytes: 0.9 * MB,
        objects: [],
        whole: [],
        heavyRoots: [],
        dropped: [],
        leftEmpty: [],
        noRecordDrawn: [],
        planRequests: { source: 3 },
        newestByIds: ['Region__c', 'Widget__c'],
        plan: {
          path: '/p',
          sha256: 'e'.repeat(64),
          drawnAt: '2026-11-14T14:02:00.000Z',
          drawnBy: 'run',
        },
      },
    });

    expect(question.sample?.newestByIds).toEqual(['Region__c', 'Widget__c']);
  });

  it('says no sample of a clone of every record', () => {
    expect(
      wholeOrgConfirmationOf({
        run: { source: 'SRC', graph, anonymizePII: true },
        measures,
        plan,
        budget: pricedOfTheDryRun(dry),
      }),
    ).not.toHaveProperty('sample');
  });
});
