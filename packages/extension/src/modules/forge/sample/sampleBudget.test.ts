import { describe, expect, it } from 'vitest';
import type { ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import { sampleBudgetPreviewOf, sampleBudgetTermsOf } from './sampleBudget.js';

const MB = 1024 * 1024;

function node(objectApiName: string, recordCount: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount,
    fieldCount: 3,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 2,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
  };
}

/**
 * A whole org: 4 000 accounts, 30 regions they name, 6 000 contacts that
 * cannot be written without their account, 8 000 cases that may name one, a
 * catalog of 20 products.
 */
function graph(): ForgeGraph {
  return {
    nodes: [
      node('Account', 4_000),
      node('Region__c', 30),
      node('Contact', 6_000),
      node('Product2', 20),
      node('BusinessHours', 2),
      node('Case', 8_000),
    ],
    edges: [
      {
        sourceObject: 'Region__c',
        targetObject: 'Account',
        relationshipName: 'Accounts',
        type: 'lookup',
      },
      {
        sourceObject: 'Account',
        targetObject: 'Contact',
        relationshipName: 'Contacts',
        type: 'lookup',
        required: true,
      },
      {
        sourceObject: 'Account',
        targetObject: 'Case',
        relationshipName: 'Cases',
        type: 'lookup',
      },
    ],
    totalRecords: 18_052,
    estimatedSizeMB: 20,
    estimatedDurationSeconds: 60,
  };
}

describe('sampleBudgetTermsOf', () => {
  it('lets a sample take 80 % of what the target has left past half a MB, as a fit does', () => {
    const terms = sampleBudgetTermsOf({ storage: { maxMB: 5, remainingMB: 4.5 } });

    expect(terms?.budget).toEqual({
      bytes: Math.floor(0.8 * 4 * MB),
      remainingMB: 4.5,
      maxMB: 5,
      share: 0.8,
      roundingMB: 0.5,
      limitedBy: 'storage',
    });
    expect(terms?.bytesLimit).toBe('storage');
    expect(terms?.roomBytes).toBe(Math.floor(0.8 * 4 * MB));
    expect(terms?.automationBytes).toBeUndefined();
  });

  it('holds it to the MB asked when fewer, the room of the target still its storage’s', () => {
    // The objects copied whole and the roots set aside are chosen against
    // the target's room: drawn against the MB asked, a smaller bound would
    // copy fewer objects whole, and its sample would not sit in the larger's.
    const terms = sampleBudgetTermsOf({ storage: { maxMB: 200, remainingMB: 150 }, withinMB: 3 });

    expect(terms?.budget).toMatchObject({ bytes: 3 * MB, withinMB: 3, limitedBy: 'within' });
    expect(terms?.bytesLimit).toBe('within');
    expect(terms?.roomBytes).toBe(Math.floor(0.8 * 149.5 * MB));
  });

  it('holds it to the MB asked alone when the target would not say its storage, and to nothing without them', () => {
    const unread = { unread: 'INSUFFICIENT_ACCESS: limits' };

    expect(sampleBudgetTermsOf({ storage: unread, withinMB: 2 })).toMatchObject({
      budget: { bytes: 2 * MB, withinMB: 2, limitedBy: 'within' },
      bytesLimit: 'within',
      roomBytes: 2 * MB,
    });
    expect(sampleBudgetTermsOf({ storage: unread })).toBeUndefined();
  });

  it('takes off, under each record of an object, what the automation that still runs creates under it', () => {
    const terms = sampleBudgetTermsOf({
      storage: { maxMB: 5, remainingMB: 4.5 },
      automation: [
        { objectApiName: 'Contact', bytes: 2048 },
        { objectApiName: 'Contact', bytes: 1024 },
        { objectApiName: 'Account', bytes: 8192 },
      ],
    });

    expect(terms?.automationBytes?.('Contact')).toBe(3072);
    expect(terms?.automationBytes?.('Account')).toBe(8192);
    expect(terms?.automationBytes?.('Case')).toBe(0);
  });
});

describe('sampleBudgetPreviewOf', () => {
  const storage = { maxMB: 5, remainingMB: 4.5 };
  const source = { max: 100_000, remaining: 90_000 };

  it('says what every record takes against what the target has left, and what a sample may take', () => {
    const preview = sampleBudgetPreviewOf({ graph: graph(), options: undefined, storage, source });

    // 18 052 records of 2 KB: about 35 MB for 4.5 MB left.
    expect(preview.wholeOrg).toMatchObject({ verdict: 'exceeds', remainingMB: 4.5, maxMB: 5 });
    expect(preview.wholeOrg.estimateMB).toBeCloseTo((18_052 * 2048) / MB, 5);
    expect(preview.budget).toMatchObject({ bytes: Math.floor(0.8 * 4 * MB), limitedBy: 'storage' });
  });

  it('names the objects a sample copies whole of itself, and why, never those asked', () => {
    const preview = sampleBudgetPreviewOf({
      graph: graph(),
      options: { whole: ['Contact'] },
      storage,
      source,
    });

    expect(preview.whole).toEqual([
      { objectApiName: 'BusinessHours', why: 'referenceData' },
      { objectApiName: 'Product2', why: 'catalog' },
      { objectApiName: 'Region__c', why: 'smallParent' },
    ]);
  });

  it('prices drawing it at a count and the pages of every root spread over the org, a tenth of what the source has left past which it is refused', () => {
    const spread = sampleBudgetPreviewOf({ graph: graph(), options: {}, storage, source });

    // A count of each drawn object's roots; the pages of the ids of the
    // accounts' and the cases', 2 and 4. A contact cannot go without its
    // account: none is a root, and none is read.
    expect(spread.planReads.source).toMatchObject({
      verdict: 'fits',
      estimate: 1 + 2 + 1 + 1 + 4,
      remaining: 90_000,
    });
    expect(spread.planReads.seconds).toBe(9);

    const poor = sampleBudgetPreviewOf({
      graph: graph(),
      options: {},
      storage,
      source: { max: 100_000, remaining: 60 },
    });
    expect(poor.planReads.source.verdict).toBe('exceeds');
  });

  it('prices a draw of the most recent at the newest the budget holds, fewer pages than every root', () => {
    // 3.2 MB hold 3 276 roots of 1 KB: two pages of the 8 000 cases, not four.
    const recent = sampleBudgetPreviewOf({
      graph: graph(),
      options: { draw: 'recent' },
      storage,
      source,
    });

    expect(recent.planReads.source.estimate).toBe(1 + 2 + 1 + 1 + 2);
  });

  it('says no budget when the target would not say its storage and no MB is asked, and the draw is not priced past what the source would not say', () => {
    const preview = sampleBudgetPreviewOf({
      graph: graph(),
      options: {},
      storage: { unread: 'INSUFFICIENT_ACCESS' },
      source: { unread: 'timed out' },
    });

    expect(preview).not.toHaveProperty('budget');
    expect(preview.wholeOrg.verdict).toBe('unread');
    expect(preview.planReads.source).toMatchObject({ verdict: 'unread', unread: 'timed out' });
  });

  it('leaves out of every record the objects the user left out', () => {
    const preview = sampleBudgetPreviewOf({
      graph: graph(),
      options: {},
      excludedObjects: ['Contact'],
      storage,
      source,
    });

    expect(preview.wholeOrg.estimateMB).toBeCloseTo((12_052 * 2048) / MB, 5);
  });
});
