import { describe, it, expect } from 'vitest';

import {
  leftOutAsEmptyTable,
  leftOutByTheUser,
  objectsBeyondTheGraph,
} from './forge-graph-nodes.js';

describe('leftOutAsEmptyTable', () => {
  it('holds for a node discovery left out because it counted no row', () => {
    expect(
      leftOutAsEmptyTable({ included: false, recordCount: 0, status: 'idle', errors: [] }),
    ).toBe(true);
  });

  it('holds for such a node once the run reported it skipped', () => {
    expect(
      leftOutAsEmptyTable({ included: false, recordCount: 0, status: 'skipped', errors: [] }),
    ).toBe(true);
  });

  it('does not hold for a node left out because its count or its describe failed', () => {
    // Discovery counts such a node 0, as it counts an empty table.
    const countFailed = {
      included: false,
      recordCount: 0,
      status: 'error' as const,
      errors: ['Record count unavailable: INVALID_TYPE_FOR_OPERATION'],
    };
    expect(leftOutAsEmptyTable(countFailed)).toBe(false);
  });

  it('does not hold for a node whose count failed once the run reported it skipped', () => {
    // The Forge page takes the run's status: the error is all that is left
    // to tell it from an empty table.
    const skipped = {
      included: false,
      recordCount: 0,
      status: 'skipped' as const,
      errors: ['Record count unavailable: EXTERNAL_OBJECT_EXCEPTION'],
    };
    expect(leftOutAsEmptyTable(skipped)).toBe(false);
  });

  it('does not hold for a table with rows, left out or not', () => {
    expect(
      leftOutAsEmptyTable({ included: false, recordCount: 9, status: 'idle', errors: [] }),
    ).toBe(false);
    expect(
      leftOutAsEmptyTable({ included: true, recordCount: 9, status: 'idle', errors: [] }),
    ).toBe(false);
  });

  it('does not hold for an empty table the run reads all the same', () => {
    // A run asked not to skip empty objects reads each of them.
    expect(
      leftOutAsEmptyTable({ included: true, recordCount: 0, status: 'idle', errors: [] }),
    ).toBe(false);
  });

  it('does not hold for a node the user left out, whatever it counts', () => {
    // A starter template's graph counts every table 0 until the run reads it:
    // a table unchecked there read as one discovery had found empty.
    expect(
      leftOutAsEmptyTable({
        included: false,
        leftOutByUser: true,
        recordCount: 0,
        status: 'idle',
        errors: [],
      }),
    ).toBe(false);
  });

  it('does not hold for a node whose count nobody took, however it was left out', () => {
    // A starter template's graph skips discovery: its zero is a placeholder,
    // and the table may hold rows.
    expect(
      leftOutAsEmptyTable({
        included: false,
        recordCount: 0,
        recordCountUnknown: true,
        status: 'idle',
        errors: [],
      }),
    ).toBe(false);
  });
});

describe('leftOutByTheUser', () => {
  it('holds for a node the user unchecked', () => {
    expect(leftOutByTheUser({ included: false, leftOutByUser: true, errors: [] })).toBe(true);
  });

  it('does not hold for a node discovery left out, empty or not', () => {
    expect(leftOutByTheUser({ included: false, errors: [] })).toBe(false);
    expect(leftOutByTheUser({ included: false, leftOutByUser: false, errors: [] })).toBe(false);
  });

  it('does not hold for a node discovery could not describe or count, unchecked again or not', () => {
    // The run could not read it either way: its error says why, and nothing is
    // held back in its name.
    expect(
      leftOutByTheUser({
        included: false,
        leftOutByUser: true,
        errors: ['Describe unavailable: INSUFFICIENT_ACCESS'],
      }),
    ).toBe(false);
  });

  it('does not hold for a node the run reads', () => {
    expect(leftOutByTheUser({ included: true, leftOutByUser: true, errors: [] })).toBe(false);
  });
});

describe('objectsBeyondTheGraph', () => {
  const graph = [{ objectApiName: 'Opportunity' }, { objectApiName: 'OpportunityLineItem' }];

  it('names the objects the run read, could not read or wrote that the graph has no node of', () => {
    expect(
      objectsBeyondTheGraph(
        {
          readByObject: [
            { objectApiName: 'Opportunity', read: 1 },
            { objectApiName: 'PricebookEntry', read: 3 },
            { objectApiName: 'ProductSellingModelOption', read: 2 },
          ],
          failedReads: ['Product2'],
          idRemapByObject: [
            { objectApiName: 'Opportunity', created: 1, linked: 0 },
            { objectApiName: 'Account', created: 0, linked: 1 },
          ],
          idRemapCreated: [{ objectApiName: 'PricebookEntry', sourceIds: ['01uFAKE000000001'] }],
        },
        graph,
      ),
    ).toEqual(['PricebookEntry', 'ProductSellingModelOption', 'Product2', 'Account']);
  });

  it('names each object once, whichever part of the result names it', () => {
    expect(
      objectsBeyondTheGraph(
        {
          readByObject: [{ objectApiName: 'Pricebook2', read: 1 }],
          idRemapByObject: [{ objectApiName: 'Pricebook2', created: 1, linked: 0 }],
          idRemapCreated: [{ objectApiName: 'Pricebook2', sourceIds: ['01sFAKE000000001'] }],
        },
        graph,
      ),
    ).toEqual(['Pricebook2']);
  });

  it('names none for a run that stayed within its graph, or recorded before it said so', () => {
    expect(
      objectsBeyondTheGraph({ readByObject: [{ objectApiName: 'Opportunity', read: 1 }] }, graph),
    ).toEqual([]);
    expect(objectsBeyondTheGraph({}, graph)).toEqual([]);
  });
});
