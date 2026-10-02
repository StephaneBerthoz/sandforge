import { describe, expect, it } from 'vitest';

import {
  loadCreatedRecords,
  loadRecordsInfo,
  loadRecordsLeft,
  loadToRemove,
} from './loadRecords.js';
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
  it("counts no person account's contact as kept when it goes with an account the load created, and one whose account it linked as linked", () => {
    const load = recordedLoad();
    const mapping = new Map(load.mapping);
    // The contact the platform wrote with the account the load inserted.
    mapping.set('Contact-000003', id('003', 3));
    // An account a reload found by its keys, and the contact written with it.
    mapping.set('Account-000002', id('001', 2));
    mapping.set('Contact-000004', id('003', 4));
    const withContacts = {
      ...load,
      mapping,
      personContacts: { 'Contact-000003': 'Account-000001', 'Contact-000004': 'Account-000002' },
    };

    // The book, the account found and its contact stay; the inserted
    // account's contact goes with it.
    expect(loadRecordsInfo(withContacts).linked).toBe(3);
    // And no removal names either contact.
    expect(loadCreatedRecords(withContacts)).toEqual(loadCreatedRecords(load));
  });

  it('counts as kept neither the direct relation of a contact the load created nor the task the platform wrote with its email, and one of a contact it linked as linked', () => {
    /** A record's key, as an extraction writes it: its object, then its number on six digits. */
    const ref = (objectApiName: string, n = 1): string =>
      `${objectApiName}-${String(n).padStart(6, '0')}`;
    const TASK_KEY = ref('Task');
    const load = recordedLoad();
    const mapping = new Map(load.mapping);
    // The direct relation the platform wrote with an inserted contact, and
    // the task it wrote with an inserted email.
    mapping.set('EmailMessage-000001', id('02s', 1));
    mapping.set('AccountContactRelation-000001', id('07k', 1));
    mapping.set(TASK_KEY, id('00T', 1));
    // A contact a reload found by its keys, and its direct relation.
    mapping.set('Contact-000009', id('003', 9));
    mapping.set('AccountContactRelation-000009', id('07k', 9));
    // A person account's contact, linked, and its direct relation: both go
    // with the account the load created.
    mapping.set('Contact-000003', id('003', 3));
    mapping.set('AccountContactRelation-000003', id('07k', 3));
    const withTheirRecords: RecordedLoad = {
      ...load,
      mapping,
      created: [
        ...(load.created ?? []),
        { objectApiName: 'EmailMessage', referenceIds: ['EmailMessage-000001'] },
      ],
      personContacts: { 'Contact-000003': 'Account-000001' },
      withTheirRecord: {
        'AccountContactRelation-000001': 'Contact-000001',
        [TASK_KEY]: 'EmailMessage-000001',
        'AccountContactRelation-000009': 'Contact-000009',
        'AccountContactRelation-000003': 'Contact-000003',
      },
    };

    // The book, the contact found and its relation stay; the rest goes with
    // what the load created.
    expect(loadRecordsInfo(withTheirRecords).linked).toBe(3);
    // And no removal names any of them.
    expect(loadCreatedRecords(withTheirRecords).flatMap(({ ids }) => ids)).toEqual([
      id('02s', 1),
      ...loadCreatedRecords(load).flatMap(({ ids }) => ids),
    ]);
  });

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

  it('counts what a removal left, with its mark, and nothing once one took all', () => {
    const partial = {
      removedAt: '2026-09-24T11:00:00.000Z',
      deleted: 3,
      alreadyGone: 0,
      kept: 2,
      refused: 0,
    };
    // The mapping forgot what went: the placeholder account and a contact stay.
    const left = recordedLoad({
      removal: partial,
      created: [
        { objectApiName: 'Account', referenceIds: ['placeholder:Account:Contact.AccountId'] },
        { objectApiName: 'Contact', referenceIds: ['Contact-000001'] },
      ],
    });

    expect(loadRecordsInfo(left)).toMatchObject({
      created: [
        { objectApiName: 'Contact', count: 1 },
        { objectApiName: 'Account', count: 1 },
      ],
      removed: partial,
    });
    expect(loadRecordsInfo({ ...left, removal: { ...partial, kept: 0 } }).created).toEqual([]);
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

  it('says a load is one before the last', () => {
    expect(loadRecordsInfo(recordedLoad({ earlier: true })).earlier).toBe(true);
    expect(loadRecordsInfo(recordedLoad())).not.toHaveProperty('earlier');
  });
});

describe('loadToRemove', () => {
  const removal = {
    removedAt: '2026-09-24T11:00:00.000Z',
    deleted: 5,
    alreadyGone: 0,
    kept: 0,
    refused: 0,
  };
  const earlierLoad = recordedLoad({ endedAt: '2026-09-23T10:02:00.000Z', earlier: true });

  it('takes the last load while its records are still to take', () => {
    expect(loadToRemove([recordedLoad(), earlierLoad])?.endedAt).toBe('2026-09-24T10:02:00.000Z');
  });

  it('takes the load before it once the last one was removed, or created nothing', () => {
    expect(loadToRemove([recordedLoad({ removal }), earlierLoad])).toBe(earlierLoad);
    expect(loadToRemove([recordedLoad({ created: [] }), earlierLoad])).toBe(earlierLoad);
  });

  it('takes the last load again while a removal of it left records in the org', () => {
    // Its orders kept for the files the org linked to them since, and what
    // hangs from them: the load before it waits until those went.
    const last = recordedLoad({ removal: { ...removal, kept: 2 } });

    expect(loadToRemove([last, earlierLoad])).toBe(last);
  });

  it('never offers a load that does not say what it created, and falls back to the last one', () => {
    const last = recordedLoad({ removal });
    expect(loadToRemove([last, recordedLoad({ created: undefined, earlier: true })])).toBe(last);
  });

  it('has no load before the first one', () => {
    expect(loadToRemove([])).toBeUndefined();
  });
});

describe('loadRecordsLeft', () => {
  const removal = {
    removedAt: '2026-09-24T11:00:00.000Z',
    deleted: 3,
    alreadyGone: 0,
    kept: 0,
    refused: 0,
  };

  it('takes what the mapping still says the load created while a removal left some, or none ran', () => {
    expect(loadRecordsLeft(recordedLoad())).toEqual(loadCreatedRecords(recordedLoad()));
    expect(loadRecordsLeft(recordedLoad({ removal: { ...removal, refused: 1 } }))).toEqual(
      loadCreatedRecords(recordedLoad()),
    );
  });

  it('takes nothing once a removal left none of the records in the org', () => {
    expect(loadRecordsLeft(recordedLoad({ removal }))).toEqual([]);
  });
});
