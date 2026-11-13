import { describe, expect, it } from 'vitest';
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
});
