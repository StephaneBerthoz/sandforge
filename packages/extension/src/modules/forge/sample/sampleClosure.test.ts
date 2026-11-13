import { describe, expect, it } from 'vitest';
import {
  FakeSampleSource,
  fakeId,
  lookup,
  masterDetail,
  required,
  type FakeObject,
} from '../../../test/sampleSource';
import { countedStorageBytes } from '../ForgeRunGate';
import {
  SampleCancelled,
  SampleClosure,
  SampleTooLarge,
  type SampleClosureOptions,
} from './sampleClosure';
import { sampleLinksOf } from './sampleLinks';

const A = (n: number) => fakeId('001', n);
const C = (n: number) => fakeId('003', n);
const O = (n: number) => fakeId('006', n);
const K = (n: number) => fakeId('500', n);
const R = (n: number) => fakeId('00K', n);
const G = (n: number) => fakeId('701', n);
const T = (n: number) => fakeId('00T', n);

/** Accounts, contacts, campaigns, opportunities and their roles, cases and tasks. */
function sales(records: Partial<Record<string, FakeObject['records']>>): FakeObject[] {
  return [
    {
      name: 'Account',
      keyPrefix: '001',
      fields: [lookup('ParentId', 'Account')],
      records: records.Account ?? [],
    },
    { name: 'Campaign', keyPrefix: '701', fields: [], records: records.Campaign ?? [] },
    {
      name: 'Contact',
      keyPrefix: '003',
      fields: [lookup('AccountId', 'Account')],
      records: records.Contact ?? [],
    },
    {
      name: 'Opportunity',
      keyPrefix: '006',
      fields: [lookup('AccountId', 'Account'), lookup('CampaignId', 'Campaign')],
      records: records.Opportunity ?? [],
    },
    {
      name: 'OpportunityContactRole',
      keyPrefix: '00K',
      fields: [required('OpportunityId', 'Opportunity'), required('ContactId', 'Contact')],
      records: records.OpportunityContactRole ?? [],
    },
    {
      name: 'Case',
      keyPrefix: '500',
      fields: [lookup('AccountId', 'Account'), lookup('ContactId', 'Contact')],
      records: records.Case ?? [],
    },
    {
      name: 'Task',
      keyPrefix: '00T',
      fields: [lookup('WhatId', ['Account', 'Opportunity'])],
      records: records.Task ?? [],
    },
  ];
}

/**
 * The closure of `roots` over `objects`, each root ranked by its place. No
 * room is given: nothing is copied whole of itself, each object is drawn.
 */
async function closed(
  objects: FakeObject[],
  roots: Array<[string, string]>,
  options: Partial<SampleClosureOptions> & {
    excluded?: Map<string, string | null>;
    order?: number;
    pastTheCap?: boolean;
    uncounted?: boolean;
  } = {},
) {
  const source = new FakeSampleSource(objects, {
    order: options.order ?? 1,
    pastTheCap: options.pastTheCap,
    uncounted: options.uncounted,
  });
  const links = sampleLinksOf({
    objects: source.inputs(),
    roomBytes: 0,
    wholeBytes: (name, rows) => countedStorageBytes(name, { rows }),
    ...(options.excluded ? { excluded: options.excluded } : {}),
  });
  const closure = new SampleClosure(links, source, { parents: 'all', children: 100, ...options });
  await closure.openWhole();
  const drawn = roots.map(([objectApiName, id], index) => ({
    objectApiName,
    id,
    rank: (index + 1) / 100,
  }));
  await closure.addRoots(drawn, 0);
  const thresholds = closure.thresholds();
  const at = (objectApiName: string, id: string) => closure.rowOf(objectApiName, id);
  const thresholdOf = (objectApiName: string, id: string) => {
    const row = at(objectApiName, id);
    return row === undefined ? undefined : thresholds.threshold[row];
  };
  const deadOf = (objectApiName: string, id: string) => {
    const row = at(objectApiName, id);
    return row === undefined ? undefined : closure.dead[row];
  };
  const wentDownFrom = (id: string) =>
    source.calls.some((call) => call.kind === 'children' && call.ids.includes(id));
  return { source, links, closure, thresholds, at, thresholdOf, deadOf, wentDownFrom };
}

describe('SampleClosure: up', () => {
  it('reads up the record a record cannot be written without, and none of the records under it', async () => {
    const run = await closed(
      sales({
        Account: [{ id: A(1) }, { id: A(2) }],
        Contact: [
          { id: C(9), refs: { AccountId: A(2) } },
          { id: C(10), refs: { AccountId: A(2) } },
        ],
        Opportunity: [{ id: O(1), refs: { AccountId: A(1) } }],
        OpportunityContactRole: [{ id: R(1), refs: { OpportunityId: O(1), ContactId: C(9) } }],
        Case: [{ id: K(1), refs: { ContactId: C(9) } }],
      }),
      [['Account', A(1)]],
    );
    // The role comes under its opportunity, and its contact comes up with it.
    expect(run.thresholdOf('OpportunityContactRole', R(1))).toBe(0);
    expect(run.thresholdOf('Contact', C(9))).toBe(0);
    // The contact read up brings nothing under it: neither its case nor its account's other contacts.
    expect(run.at('Case', K(1))).toBeUndefined();
    expect(run.at('Contact', C(10))).toBeUndefined();
    expect(run.wentDownFrom(C(9))).toBe(false);
    // Its own account is a record its optional lookup names: copied, without its children.
    expect(run.thresholdOf('Account', A(2))).toBe(0);
    expect(run.wentDownFrom(A(2))).toBe(false);
  });

  it("copies the record an optional lookup names with parents 'all', without its children, and leaves it out with 'required'", async () => {
    const objects = sales({
      Account: [{ id: A(1) }, { id: A(3) }],
      Campaign: [{ id: G(1) }],
      Opportunity: [
        { id: O(1), refs: { AccountId: A(1), CampaignId: G(1) } },
        { id: O(2), refs: { AccountId: A(3), CampaignId: G(1) } },
      ],
    });
    const all = await closed(objects, [['Account', A(1)]]);
    expect(all.thresholdOf('Campaign', G(1))).toBe(0);
    expect(all.at('Opportunity', O(2))).toBeUndefined();
    expect(all.wentDownFrom(G(1))).toBe(false);

    const onlyRequired = await closed(objects, [['Account', A(1)]], { parents: 'required' });
    expect(onlyRequired.at('Campaign', G(1))).toBeUndefined();
    expect(onlyRequired.thresholdOf('Opportunity', O(1))).toBe(0);
  });

  it('reads up a whole hierarchy of parents with parents all, each copied without its children', async () => {
    const run = await closed(
      sales({
        Account: [
          { id: A(1), refs: { ParentId: A(2) } },
          { id: A(2), refs: { ParentId: A(3) } },
          { id: A(3) },
        ],
        Contact: [{ id: C(3), refs: { AccountId: A(3) } }],
      }),
      [['Account', A(1)]],
    );
    expect(run.thresholdOf('Account', A(3))).toBe(0);
    expect(run.at('Contact', C(3))).toBeUndefined();
  });
});

describe('SampleClosure: down', () => {
  const fiveContacts = sales({
    Account: [{ id: A(1) }],
    Contact: [1, 2, 3, 4, 5].map((n) => ({ id: C(n), refs: { AccountId: A(1) } })),
  });

  it('takes at most the cap of the records under a record per relation, the last by id, and counts those left', async () => {
    const run = await closed(fiveContacts, [['Account', A(1)]], { children: 2 });
    expect([1, 2, 3, 4, 5].map((n) => run.at('Contact', C(n)) !== undefined)).toEqual([
      false,
      false,
      false,
      true,
      true,
    ]);
    expect(run.closure.cut.get('Contact.AccountId')?.get(run.at('Account', A(1))!)).toBe(3);
  });

  it('counts the records left by the cap from the list when the source could not count them', async () => {
    const run = await closed(fiveContacts, [['Account', A(1)]], { children: 2, uncounted: true });
    expect([1, 2, 3, 4, 5].filter((n) => run.at('Contact', C(n)) !== undefined)).toEqual([4, 5]);
    expect(run.closure.cut.get('Contact.AccountId')?.get(run.at('Account', A(1))!)).toBe(3);
  });

  it('holds to the cap when the source gives more than it, as a direct read of a list does', async () => {
    const run = await closed(fiveContacts, [['Account', A(1)]], { children: 2, pastTheCap: true });
    const kept = [1, 2, 3, 4, 5].filter((n) => run.at('Contact', C(n)) !== undefined);
    expect(kept).toEqual([4, 5]);
  });

  it('takes every record under a master-detail, past the cap', async () => {
    const objects: FakeObject[] = [
      { name: 'Opportunity', keyPrefix: '006', fields: [], records: [{ id: O(1) }] },
      {
        name: 'OpportunityLineItem',
        keyPrefix: '00k',
        fields: [masterDetail('OpportunityId', 'Opportunity')],
        records: [1, 2, 3, 4, 5].map((n) => ({
          id: fakeId('00k', n),
          refs: { OpportunityId: O(1) },
        })),
      },
    ];
    const run = await closed(objects, [['Opportunity', O(1)]], { children: 2 });
    expect(
      [1, 2, 3, 4, 5].every((n) => run.at('OpportunityLineItem', fakeId('00k', n)) !== undefined),
    ).toBe(true);
    expect(run.closure.cut.size).toBe(0);
  });

  it('goes down from what it reached under a root, and gives each the least threshold of what it came under', async () => {
    const run = await closed(
      sales({
        Account: [{ id: A(1) }, { id: A(2) }],
        Campaign: [{ id: G(1) }],
        Opportunity: [{ id: O(1), refs: { AccountId: A(2), CampaignId: G(1) } }],
        Task: [{ id: T(1), refs: { WhatId: O(1) } }],
      }),
      [
        ['Account', A(1)],
        ['Campaign', G(1)],
        ['Account', A(2)],
      ],
    );
    // Under the campaign (index 1) and under its account (index 2): the campaign's, the smaller.
    expect(run.thresholdOf('Opportunity', O(1))).toBe(1);
    expect(run.thresholdOf('Task', T(1))).toBe(1);
  });

  it('asks the records under records of several objects through one lookup in one list of ids', async () => {
    const run = await closed(
      sales({
        Account: [{ id: A(1) }],
        Opportunity: [{ id: O(9) }],
        Task: [
          { id: T(1), refs: { WhatId: A(1) } },
          { id: T(2), refs: { WhatId: O(9) } },
        ],
      }),
      [
        ['Account', A(1)],
        ['Opportunity', O(9)],
      ],
    );
    const tasks = run.source.calls.filter(
      (call) => call.kind === 'children' && call.objectApiName === 'Task',
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].ids).toEqual([A(1), O(9)]);
    expect(run.thresholdOf('Task', T(1))).toBe(0);
    expect(run.thresholdOf('Task', T(2))).toBe(1);
  });
});

describe('SampleClosure: records that die', () => {
  it('lets a record die whose required parent the source does not hold, is outside its filter, or of an object left out', async () => {
    const objects: FakeObject[] = [
      ...sales({
        Account: [{ id: A(1) }],
        Contact: [
          { id: C(1), refs: { AccountId: A(1) } },
          { id: C(8), refs: { AccountId: A(1) }, filteredOut: true },
        ],
        Opportunity: [{ id: O(1), refs: { AccountId: A(1) } }],
        OpportunityContactRole: [
          { id: R(1), refs: { OpportunityId: O(1), ContactId: C(1) } },
          { id: R(2), refs: { OpportunityId: O(1), ContactId: C(404) } },
          { id: R(3), refs: { OpportunityId: O(1), ContactId: C(8) } },
        ],
        Case: [{ id: K(1), refs: { AccountId: A(1), ContactId: C(8) } }],
      }),
      {
        name: 'Visit__c',
        keyPrefix: 'a01',
        fields: [lookup('Account__c', 'Account'), required('Asset__c', 'Asset')],
        records: [{ id: fakeId('a01', 1), refs: { Account__c: A(1), Asset__c: fakeId('02i', 1) } }],
      },
    ];
    const run = await closed(objects, [['Account', A(1)]], {
      excluded: new Map([['Asset', '02i']]),
    });
    expect(run.deadOf('OpportunityContactRole', R(1))).toBeUndefined();
    expect(run.deadOf('OpportunityContactRole', R(2))).toBe('noParentInSource');
    expect(run.deadOf('OpportunityContactRole', R(3))).toBe('outsideFilter');
    expect(run.deadOf('Visit__c', fakeId('a01', 1))).toBe('excludedObject');
    // An optional lookup at a record outside the filter leaves the case as it is.
    expect(run.deadOf('Case', K(1))).toBeUndefined();
    expect(run.closure.out[run.at('Contact', C(8))!]).toBe(true);
  });

  it('lets a record die whose required parent a read of an earlier batch already found missing', async () => {
    const source = new FakeSampleSource(
      sales({
        Account: [{ id: A(1) }, { id: A(2) }],
        Opportunity: [
          { id: O(1), refs: { AccountId: A(1) } },
          { id: O(2), refs: { AccountId: A(2) } },
        ],
        OpportunityContactRole: [
          { id: R(1), refs: { OpportunityId: O(1), ContactId: C(404) } },
          { id: R(2), refs: { OpportunityId: O(2), ContactId: C(404) } },
        ],
      }),
    );
    const links = sampleLinksOf({
      objects: source.inputs(),
      roomBytes: 0,
      wholeBytes: (name, rows) => countedStorageBytes(name, { rows }),
    });
    const closure = new SampleClosure(links, source, { parents: 'all', children: 100 });
    await closure.openWhole();
    await closure.addRoots([{ objectApiName: 'Account', id: A(1), rank: 0.1 }], 0);
    await closure.addRoots([{ objectApiName: 'Account', id: A(2), rank: 0.2 }], 1);
    expect(closure.dead[closure.rowOf('OpportunityContactRole', R(1))!]).toBe('noParentInSource');
    expect(closure.dead[closure.rowOf('OpportunityContactRole', R(2))!]).toBe('noParentInSource');
  });

  it('lets a record die for its own record type, and with it every record that cannot be written without it', async () => {
    const objects: FakeObject[] = [
      { name: 'Top__c', keyPrefix: 'a02', fields: [], records: [{ id: fakeId('a02', 1) }] },
      {
        name: 'Mid__c',
        keyPrefix: 'a03',
        fields: [lookup('Top__c', 'Top__c')],
        records: [
          {
            id: fakeId('a03', 1),
            refs: { Top__c: fakeId('a02', 1) },
            recordTypeId: '012000000000001AAA',
          },
          {
            id: fakeId('a03', 2),
            refs: { Top__c: fakeId('a02', 1) },
            recordTypeId: '012000000000002AAA',
          },
        ],
      },
      {
        name: 'Leaf__c',
        keyPrefix: 'a04',
        fields: [lookup('Top__c', 'Top__c'), required('Mid__c', 'Mid__c')],
        records: [
          { id: fakeId('a04', 1), refs: { Top__c: fakeId('a02', 1), Mid__c: fakeId('a03', 1) } },
        ],
      },
    ];
    const run = await closed(objects, [['Top__c', fakeId('a02', 1)]], {
      recordTypeVerdict: (_object, recordType) =>
        recordType.startsWith('012000000000001')
          ? 'heldBack'
          : recordType.startsWith('012000000000002')
            ? 'recordTypeNotInTarget'
            : undefined,
    });
    expect(run.deadOf('Mid__c', fakeId('a03', 1))).toBe('heldBack');
    expect(run.deadOf('Mid__c', fakeId('a03', 2))).toBe('recordTypeNotInTarget');
    expect(run.deadOf('Leaf__c', fakeId('a04', 1))).toBe('withoutParent');
  });

  it('goes down from no record that dies: a root held back brings none of its records', async () => {
    const run = await closed(
      sales({
        Account: [{ id: A(1), recordTypeId: '012000000000001AAA' }],
        Contact: [{ id: C(1), refs: { AccountId: A(1) } }],
      }),
      [['Account', A(1)]],
      { recordTypeVerdict: () => 'heldBack' },
    );
    expect(run.deadOf('Account', A(1))).toBe('heldBack');
    expect(run.at('Contact', C(1))).toBeUndefined();
    expect(run.wentDownFrom(A(1))).toBe(false);
    // It keeps the threshold it would have entered at, so that what it costs is said.
    expect(run.thresholdOf('Account', A(1))).toBe(0);
  });
});

describe('SampleClosure: person accounts', () => {
  it("reads up the account of a person account's contact read up, even with parents 'required'", async () => {
    const run = await closed(
      sales({
        Account: [{ id: A(1) }, { id: A(5) }, { id: A(7), personAccount: true }],
        Contact: [
          { id: C(7), refs: { AccountId: A(7) }, personAccount: true },
          { id: C(5), refs: { AccountId: A(5) } },
        ],
        Opportunity: [{ id: O(1), refs: { AccountId: A(1) } }],
        OpportunityContactRole: [
          { id: R(1), refs: { OpportunityId: O(1), ContactId: C(7) } },
          { id: R(2), refs: { OpportunityId: O(1), ContactId: C(5) } },
        ],
      }),
      [['Account', A(1)]],
      { parents: 'required' },
    );
    expect(run.thresholdOf('Contact', C(7))).toBe(0);
    expect(run.thresholdOf('Account', A(7))).toBe(0);
    // A business contact's account is an optional parent: left out with 'required'.
    expect(run.thresholdOf('Contact', C(5))).toBe(0);
    expect(run.at('Account', A(5))).toBeUndefined();
  });
});

describe('SampleClosure: the catalog read as it is named', () => {
  const PB = (n: number) => fakeId('01u', n);
  const catalog = (also: { standard: string | null }): FakeObject[] => [
    { name: 'Opportunity', keyPrefix: '006', fields: [], records: [{ id: O(1) }] },
    { name: 'Product2', keyPrefix: '01t', fields: [], records: [{ id: fakeId('01t', 1) }] },
    {
      name: 'Pricebook2',
      keyPrefix: '01s',
      fields: [],
      records: [{ id: fakeId('01s', 1), matched: true }, { id: fakeId('01s', 2) }],
    },
    {
      name: 'PricebookEntry',
      keyPrefix: '01u',
      fields: [required('Product2Id', 'Product2'), required('Pricebook2Id', 'Pricebook2')],
      records: [
        { id: PB(1), refs: { Product2Id: fakeId('01t', 1), Pricebook2Id: fakeId('01s', 1) } },
        {
          id: PB(2),
          refs: { Product2Id: fakeId('01t', 1), Pricebook2Id: fakeId('01s', 2) },
          also: [{ objectApiName: 'PricebookEntry', id: also.standard }],
        },
      ],
    },
    {
      name: 'OpportunityLineItem',
      keyPrefix: '00k',
      fields: [
        masterDetail('OpportunityId', 'Opportunity'),
        lookup('PricebookEntryId', 'PricebookEntry'),
      ],
      records: [{ id: fakeId('00k', 1), refs: { OpportunityId: O(1), PricebookEntryId: PB(2) } }],
    },
  ];

  it("reads up a custom price's standard price with it, the line's price being one it cannot be written without", async () => {
    const run = await closed(catalog({ standard: PB(1) }), [['Opportunity', O(1)]]);
    expect(run.links.classes.get('PricebookEntry')).toEqual({ kind: 'drawn', rooted: false });
    expect(run.thresholdOf('PricebookEntry', PB(2))).toBe(0);
    expect(run.thresholdOf('PricebookEntry', PB(1))).toBe(0);
    expect(run.thresholdOf('Pricebook2', fakeId('01s', 1))).toBe(0);
  });

  it('lets a custom price die whose product has no standard price in the source, and the lines priced from it', async () => {
    const run = await closed(catalog({ standard: null }), [['Opportunity', O(1)]]);
    expect(run.deadOf('PricebookEntry', PB(2))).toBe('noParentInSource');
    expect(run.deadOf('OpportunityLineItem', fakeId('00k', 1))).toBe('withoutParent');
  });
});

describe('SampleClosure: thresholds', () => {
  it('gives the records of an object copied whole -1, and their parents read up -1 too', async () => {
    const source = new FakeSampleSource([
      { name: 'Account', keyPrefix: '001', fields: [], records: [{ id: A(1) }, { id: A(2) }] },
      {
        name: 'Region__c',
        keyPrefix: 'a05',
        fields: [required('Owner__c', 'Account')],
        records: [{ id: fakeId('a05', 1), refs: { Owner__c: A(2) } }],
      },
    ]);
    const links = sampleLinksOf({
      objects: source.inputs(),
      roomBytes: 0,
      whole: ['Region__c'],
      wholeBytes: (name, rows) => countedStorageBytes(name, { rows }),
    });
    const closure = new SampleClosure(links, source, { parents: 'all', children: 100 });
    await closure.openWhole();
    const { threshold } = closure.thresholds();
    expect(threshold[closure.rowOf('Region__c', fakeId('a05', 1))!]).toBe(-1);
    expect(threshold[closure.rowOf('Account', A(2))!]).toBe(-1);
    expect(closure.rowOf('Account', A(1))).toBeUndefined();
  });

  it('reads whole an object copied whole that a lookup names, and lets a record die that names one it does not hold', async () => {
    const REG = (n: number) => fakeId('a05', n);
    const source = new FakeSampleSource([
      {
        name: 'Region__c',
        keyPrefix: 'a05',
        fields: [],
        records: [{ id: REG(1) }, { id: REG(2), filteredOut: true }],
      },
      {
        name: 'Account',
        keyPrefix: '001',
        fields: [required('Region__c', 'Region__c'), lookup('Other__c', 'Region__c')],
        records: [
          { id: A(1), refs: { Region__c: REG(1) } },
          { id: A(2), refs: { Region__c: REG(404) } },
          { id: A(3), refs: { Region__c: REG(2) } },
          { id: A(4), refs: { Region__c: REG(1), Other__c: REG(404) } },
        ],
      },
    ]);
    const links = sampleLinksOf({
      objects: source.inputs(),
      roomBytes: 0,
      whole: ['Region__c'],
      wholeBytes: (name, rows) => countedStorageBytes(name, { rows }),
    });
    const closure = new SampleClosure(links, source, { parents: 'all', children: 100 });
    await closure.openWhole();
    await closure.addRoots(
      [1, 2, 3, 4].map((n) => ({ objectApiName: 'Account', id: A(n), rank: n / 10 })),
      0,
    );
    expect(closure.wasReadWhole('Region__c')).toBe(true);
    expect(closure.dead[closure.rowOf('Account', A(1))!]).toBeUndefined();
    expect(closure.dead[closure.rowOf('Account', A(2))!]).toBe('noParentInSource');
    expect(closure.dead[closure.rowOf('Account', A(3))!]).toBe('outsideFilter');
    // An optional lookup at a record the source does not hold leaves the account as it is.
    expect(closure.dead[closure.rowOf('Account', A(4))!]).toBeUndefined();
  });

  it('names the relation a record came in by, the first by name when two bring it as early, whatever the order', async () => {
    // The case comes under the contact and under the opportunity, both under
    // the account: the contact is gone down from first, and its relation
    // still is not the one named.
    const objects: FakeObject[] = [
      { name: 'Account', keyPrefix: '001', fields: [], records: [{ id: A(1) }] },
      {
        name: 'Contact',
        keyPrefix: '003',
        fields: [lookup('AccountId', 'Account')],
        records: [{ id: C(1), refs: { AccountId: A(1) } }],
      },
      {
        name: 'Opportunity',
        keyPrefix: '006',
        fields: [lookup('AccountId', 'Account')],
        records: [{ id: O(1), refs: { AccountId: A(1) } }],
      },
      {
        name: 'Case',
        keyPrefix: '500',
        fields: [lookup('Opportunity__c', 'Opportunity'), lookup('ZContact__c', 'Contact')],
        records: [{ id: K(1), refs: { Opportunity__c: O(1), ZContact__c: C(1) } }],
      },
    ];
    for (const order of [1, 2, 3]) {
      const run = await closed(objects, [['Account', A(1)]], { order });
      expect(run.thresholds.via[run.at('Case', K(1))!]).toBe('Case.Opportunity__c');
    }
  });

  it('finds the same thresholds whatever order the source answers in', async () => {
    const objects = sales({
      Account: [1, 2, 3].map((n) => ({ id: A(n), refs: { ParentId: n < 3 ? A(n + 1) : null } })),
      Contact: [1, 2, 3, 4].map((n) => ({ id: C(n), refs: { AccountId: A((n % 3) + 1) } })),
      Opportunity: [1, 2, 3].map((n) => ({ id: O(n), refs: { AccountId: A(n) } })),
      OpportunityContactRole: [1, 2, 3].map((n) => ({
        id: R(n),
        refs: { OpportunityId: O(n), ContactId: C(n + 1) },
      })),
    });
    const roots: Array<[string, string]> = [
      ['Account', A(2)],
      ['Account', A(1)],
    ];
    const seen = new Set<string>();
    for (const order of [1, 2, 3, 4, 5]) {
      const run = await closed(objects, roots, { order });
      const said = [
        ...run.source.objects.flatMap((o) =>
          o.records.map((r) => `${o.name}:${r.id}:${run.thresholdOf(o.name, r.id)}`),
        ),
      ];
      seen.add(said.join('|'));
    }
    expect(seen.size).toBe(1);
  });
});

describe('SampleClosure: bounds', () => {
  it('stops past the records it may hold at once, and says so', async () => {
    const objects = sales({
      Account: [{ id: A(1) }],
      Contact: [1, 2, 3, 4, 5].map((n) => ({ id: C(n), refs: { AccountId: A(1) } })),
    });
    await expect(closed(objects, [['Account', A(1)]], { maxRows: 3 })).rejects.toBeInstanceOf(
      SampleTooLarge,
    );
  });

  it('stops before its next read once cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      closed(sales({ Account: [{ id: A(1) }] }), [['Account', A(1)]], {
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(SampleCancelled);
  });
});
