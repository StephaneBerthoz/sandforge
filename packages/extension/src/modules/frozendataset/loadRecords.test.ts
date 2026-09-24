import { describe, expect, it } from 'vitest';

import { loadCreatedRecords, loadRecordsInfo } from './loadRecords.js';
import type { RecordedLoad } from './SasReferenceIdMappingStore.js';

/** A fake record id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

/**
 * A load that matched the standard price book, inserted an account and two
 * contacts, created a placeholder account and inserted a price.
 */
function recordedLoad(overrides: Partial<RecordedLoad> = {}): RecordedLoad {
  return {
    orgId: 'org-dev',
    mapping: new Map([
      ['Pricebook2-000001', id('01s', 1)],
      ['placeholder:Account:Contact.AccountId', id('001', 9)],
      ['Account-000001', id('001', 1)],
      ['Contact-000001', id('003', 1)],
      ['Contact-000002', id('003', 2)],
      ['PricebookEntry-000001', id('01u', 1)],
    ]),
    created: [
      { objectApiName: 'Account', referenceIds: ['placeholder:Account:Contact.AccountId'] },
      { objectApiName: 'Account', referenceIds: ['Account-000001'] },
      { objectApiName: 'Contact', referenceIds: ['Contact-000001', 'Contact-000002'] },
      { objectApiName: 'PricebookEntry', referenceIds: ['PricebookEntry-000001'] },
    ],
    startedAt: '2026-09-24T10:00:00.000Z',
    endedAt: '2026-09-24T10:02:00.000Z',
    removalStamps: {},
    removalSpans: [],
    ...overrides,
  };
}

describe('loadCreatedRecords', () => {
  it('takes what the load created, the object it wrote last first, and never the book it matched', () => {
    expect(loadCreatedRecords(recordedLoad())).toEqual([
      { objectApiName: 'PricebookEntry', ids: [id('01u', 1)] },
      { objectApiName: 'Contact', ids: [id('003', 2), id('003', 1)] },
      // The placeholder and the account, one object taken once.
      { objectApiName: 'Account', ids: [id('001', 1), id('001', 9)] },
    ]);
  });

  it('leaves a record a linked key names, whatever key lists it as created', () => {
    const load = recordedLoad();
    // A selling model the target held, reached by a second key that claims it.
    const mapping = new Map(load.mapping);
    mapping.set('ProductSellingModel-000001', id('0jP', 1));
    mapping.set('ProductSellingModel-000002', id('0jP', 1));

    const plan = loadCreatedRecords({
      mapping,
      created: [
        ...(load.created ?? []),
        { objectApiName: 'ProductSellingModel', referenceIds: ['ProductSellingModel-000002'] },
      ],
    });

    expect(plan.map((o) => o.objectApiName)).not.toContain('ProductSellingModel');
  });

  it('leaves out what the file cannot be trusted with: an id that is no record id, an object no query can name', () => {
    const plan = loadCreatedRecords({
      mapping: new Map([
        ['Account-000001', 'not-an-id'],
        ['Contact-000001', id('003', 1)],
        ['Weird-000001', id('a00', 1)],
      ]),
      created: [
        { objectApiName: 'Account', referenceIds: ['Account-000001'] },
        { objectApiName: 'Contact', referenceIds: ['Contact-000001', 'Contact-000404'] },
        { objectApiName: 'Bad Name; DELETE', referenceIds: ['Weird-000001'] },
      ],
    });

    expect(plan).toEqual([{ objectApiName: 'Contact', ids: [id('003', 1)] }]);
  });

  it('takes nothing from a mapping written before loads kept what they created', () => {
    expect(loadCreatedRecords(recordedLoad({ created: undefined }))).toEqual([]);
  });
});

describe('loadRecordsInfo', () => {
  it('counts per object what a removal takes, and the linked records it leaves', () => {
    expect(loadRecordsInfo(recordedLoad())).toEqual({
      orgId: 'org-dev',
      loadedAt: '2026-09-24T10:02:00.000Z',
      created: [
        { objectApiName: 'PricebookEntry', count: 1 },
        { objectApiName: 'Contact', count: 2 },
        { objectApiName: 'Account', count: 2 },
      ],
      linked: 1,
      recorded: true,
    });
  });

  it('says a mapping written before loads kept what they created cannot tell', () => {
    expect(loadRecordsInfo(recordedLoad({ created: undefined }))).toMatchObject({
      created: [],
      linked: 0,
      recorded: false,
    });
  });

  it('carries the mark of a removal', () => {
    const removal = {
      removedAt: '2026-09-24T11:00:00.000Z',
      deleted: 5,
      alreadyGone: 0,
      kept: 0,
      refused: 0,
    };

    expect(loadRecordsInfo(recordedLoad({ removal })).removed).toEqual(removal);
  });
});
