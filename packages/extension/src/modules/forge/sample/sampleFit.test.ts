import { describe, expect, it } from 'vitest';
import {
  cascadesTo,
  drawFakeSample,
  emptiedOf,
  fakeId,
  lookup,
  masterDetail,
  orphansOf,
  required,
  type FakeObject,
  type FakeRecord,
} from '../../../test/sampleSource';
import { type drawTheSample, type SampleCut } from './sampleFit';
import { idKey } from './sampleRank';

const KB = 1024;
const A = (n: number) => fakeId('001', n);
const C = (n: number) => fakeId('003', n);
const O = (n: number) => fakeId('006', n);
const K = (n: number) => fakeId('500', n);
const R = (n: number) => fakeId('00K', n);

const sampleOf = drawFakeSample;

function sampled(cut: Awaited<ReturnType<typeof drawTheSample>>): SampleCut {
  if (cut.kind !== 'sample') throw new Error(`no sample: ${JSON.stringify(cut)}`);
  return cut;
}

/** `accounts` accounts, each with `contacts` contacts. */
function accountsAndContacts(accounts: number, contacts: number): FakeObject[] {
  return [
    {
      name: 'Account',
      keyPrefix: '001',
      fields: [],
      records: Array.from({ length: accounts }, (_, n) => ({ id: A(n + 1) })),
    },
    {
      name: 'Contact',
      keyPrefix: '003',
      fields: [lookup('AccountId', 'Account')],
      records: Array.from({ length: accounts * contacts }, (_, n) => ({
        id: C(n + 1),
        refs: { AccountId: A(Math.floor(n / contacts) + 1) },
      })),
    },
  ];
}

const idsOf = (cut: SampleCut, objectApiName: string) => cut.ids.get(objectApiName) ?? [];

describe('drawTheSample: the cut', () => {
  it('keeps the largest share that fits the bytes, every account kept with its contacts, and says the storage held it', async () => {
    const { cut } = await sampleOf(accountsAndContacts(300, 2), { bytes: 100 * KB });
    const sample = sampled(cut);
    expect(sample.limitedBy).toBe('storage');
    expect(sample.storageBytes).toBeLessThanOrEqual(100 * KB);
    // Each account weighs 6 KB with its two contacts: one more would not fit.
    expect(sample.storageBytes).toBeGreaterThan(100 * KB - 6 * KB);
    const accounts = new Set(idsOf(sample, 'Account').map(idKey));
    expect(idsOf(sample, 'Contact')).toHaveLength(accounts.size * 2);
    expect(sample.objects).toEqual([
      {
        objectApiName: 'Contact',
        sourceRows: 600,
        kept: accounts.size * 2,
        roots: 0,
        below: accounts.size * 2,
        asParents: 0,
      },
      {
        objectApiName: 'Account',
        sourceRows: 300,
        kept: accounts.size,
        roots: accounts.size,
        below: 0,
        asParents: 0,
      },
    ]);
    expect(sample.share).toBeGreaterThan(0);
    expect(sample.share).toBeLessThan(0.1);
    expect(sample.wholeOrgFits).toBe(false);
  });

  it('holds the records to --max-total and says it held them', async () => {
    const sample = sampled(
      (await sampleOf(accountsAndContacts(300, 2), { bytes: 10_000 * KB, maxTotal: 30 })).cut,
    );
    expect(sample.limitedBy).toBe('maxTotal');
    expect(sample.written).toBeLessThanOrEqual(30);
    expect(sample.written).toBeGreaterThan(30 - 3);
  });

  it('holds the records to the bounds on requests the caller prices, and names the one that held them', async () => {
    const sample = sampled(
      (
        await sampleOf(accountsAndContacts(300, 2), {
          bytes: 10_000 * KB,
          requests: (written) =>
            (written.get('Contact') ?? 0) > 40 ? 'targetRequests' : undefined,
        })
      ).cut,
    );
    expect(sample.limitedBy).toBe('targetRequests');
    expect(idsOf(sample, 'Contact').length).toBeLessThanOrEqual(40);
    expect(idsOf(sample, 'Contact').length).toBeGreaterThan(36);
  });

  it('says the MB asked held the sample when they are what gives the bytes', async () => {
    const sample = sampled(
      (await sampleOf(accountsAndContacts(300, 2), { bytes: 60 * KB, bytesLimit: 'within' })).cut,
    );
    expect(sample.limitedBy).toBe('within');
  });

  it('keeps every root when the whole org fits, and says copying all of it is the better run', async () => {
    const sample = sampled(
      (await sampleOf(accountsAndContacts(20, 2), { bytes: 10_000 * KB })).cut,
    );
    expect(sample.limitedBy).toBe('whole');
    expect(sample.share).toBe(1);
    expect(sample.wholeOrgFits).toBe(true);
    expect(sample.rows).toBe(60);
  });

  it('cuts at a root of its own: the same seed and source keep the same records, read in any order', async () => {
    const seen = new Set<string>();
    for (const order of [1, 2, 3, 4]) {
      const sample = sampled(
        (await sampleOf(accountsAndContacts(300, 2), { bytes: 100 * KB, order })).cut,
      );
      seen.add(JSON.stringify([...sample.ids]));
    }
    expect(seen.size).toBe(1);
    const other = sampled(
      (await sampleOf(accountsAndContacts(300, 2), { bytes: 100 * KB, seed: 2 })).cut,
    );
    expect(JSON.stringify([...other.ids])).not.toBe([...seen][0]);
  });

  it('keeps, drawn by recency, the roots created last, whatever their ids say', async () => {
    const objects = accountsAndContacts(300, 2).map((o) =>
      o.name === 'Account'
        ? { ...o, records: o.records.map((r, n) => ({ ...r, createdAt: 300 - n })) }
        : o,
    );
    const sample = sampled((await sampleOf(objects, { bytes: 60 * KB, draw: 'recent' })).cut);
    // Created in the reverse of their ids: the ten kept are the ten smallest ids.
    expect(idsOf(sample, 'Account')).toEqual(Array.from({ length: 10 }, (_, n) => A(n + 1)));
  });

  // Run for real into a Developer Edition, a sample counted the tasks a flow
  // opens under its contacts and said them nowhere: its line said "about 3.6
  // MB" and its gate "1.95 MB".
  it('says apart, of what it takes, what the target’s automation creates under the records it inserts', async () => {
    const { cut } = await sampleOf(accountsAndContacts(300, 2), {
      bytes: 100 * KB,
      automationBytes: (objectApiName) => (objectApiName === 'Contact' ? 2 * KB : 0),
    });
    const sample = sampled(cut);
    const contacts = idsOf(sample, 'Contact').length;
    expect(contacts).toBeGreaterThan(0);
    expect(sample.automationBytes).toBe(contacts * 2 * KB);
    expect(sample.storageBytes).toBe(sample.rows * 2 * KB + sample.automationBytes);

    const quiet = sampled((await sampleOf(accountsAndContacts(300, 2), { bytes: 100 * KB })).cut);
    expect(quiet.automationBytes).toBe(0);
  });

  // Run for real on a whole org: Opportunity, a small parent, was copied
  // whole, and 3 of its 4 line items were drawn as roots. Each opportunity's
  // amount came to the lines written, and neither the dry run nor the run
  // said so: the line's OpportunityId says no cascade, and only the
  // opportunity's list of its children says it, as here. An account's list
  // says it of its contacts too, which may be left without an account: no
  // details of it.
  it('names a master copied whole that keeps part of its details, what it sums of them counting those written alone', async () => {
    const objects: FakeObject[] = [
      {
        name: 'Account',
        keyPrefix: '001',
        fields: [],
        childRelationships: [cascadesTo('Contact', 'AccountId')],
        records: [{ id: A(1) }],
      },
      {
        name: 'Contact',
        keyPrefix: '003',
        fields: [lookup('AccountId', 'Account')],
        records: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ id: C(n), refs: { AccountId: A(1) } })),
      },
      {
        name: 'Opportunity',
        keyPrefix: '006',
        fields: [],
        childRelationships: [cascadesTo('OpportunityLineItem', 'OpportunityId')],
        records: [1, 2].map((n) => ({ id: O(n) })),
      },
      {
        name: 'OpportunityLineItem',
        keyPrefix: '00k',
        fields: [required('OpportunityId', 'Opportunity')],
        records: [1, 2, 3, 4].map((n) => ({
          id: fakeId('00k', n),
          refs: { OpportunityId: O(n <= 2 ? 1 : 2) },
        })),
      },
    ];
    const whole = ['Account', 'Opportunity'];

    const part = sampled((await sampleOf(objects, { bytes: 22 * KB, whole })).cut);
    expect(idsOf(part, 'OpportunityLineItem')).toHaveLength(2);
    // Six of the account's eight contacts, said of no master: no account sums its contacts.
    expect(idsOf(part, 'Contact')).toHaveLength(6);
    expect(part.partialMasters).toEqual([
      {
        objectApiName: 'Opportunity',
        details: 'OpportunityLineItem',
        field: 'OpportunityId',
        kept: 2,
        sourceRows: 4,
      },
    ]);

    // Every line kept: nothing to say.
    const all = sampled((await sampleOf(objects, { bytes: 30 * KB, whole })).cut);
    expect(idsOf(all, 'OpportunityLineItem')).toHaveLength(4);
    expect(all.partialMasters).toEqual([]);
  });

  it('takes every line under an opportunity it draws, past the cap, and cuts the contacts under an account to it', async () => {
    const objects: FakeObject[] = [
      {
        name: 'Account',
        keyPrefix: '001',
        fields: [],
        childRelationships: [cascadesTo('Contact', 'AccountId')],
        records: [{ id: A(1) }],
      },
      {
        name: 'Contact',
        keyPrefix: '003',
        fields: [lookup('AccountId', 'Account')],
        records: Array.from({ length: 150 }, (_, n) => ({
          id: C(n + 1),
          refs: { AccountId: A(1) },
        })),
      },
      {
        name: 'Opportunity',
        keyPrefix: '006',
        fields: [],
        childRelationships: [cascadesTo('OpportunityLineItem', 'OpportunityId')],
        records: [{ id: O(1) }],
      },
      {
        name: 'OpportunityLineItem',
        keyPrefix: '00k',
        fields: [required('OpportunityId', 'Opportunity')],
        records: Array.from({ length: 150 }, (_, n) => ({
          id: fakeId('00k', n + 1),
          refs: { OpportunityId: O(1) },
        })),
      },
    ];

    const sample = sampled((await sampleOf(objects, { bytes: 2_000 * KB })).cut);

    // A detail comes with its master, every one: the opportunity's amount is the lines'.
    expect(sample.objects.find((o) => o.objectApiName === 'OpportunityLineItem')).toEqual({
      objectApiName: 'OpportunityLineItem',
      sourceRows: 150,
      kept: 150,
      roots: 0,
      below: 150,
      asParents: 0,
    });
    // A lookup's children are cut to the cap, its parent deleting them all the same.
    expect(sample.objects.find((o) => o.objectApiName === 'Contact')).toMatchObject({
      kept: 100,
      childrenCut: [{ field: 'AccountId', rows: 50 }],
    });
    expect(sample.partialMasters).toEqual([]);
  });

  it('names a master drawn whose records come in as a parent, their details only as far as the sample drew them', async () => {
    // Each line names its invoice, its master, and its item: an item
    // drawn brings its lines, and they bring in their invoices as parents,
    // without the invoices' other lines.
    const objects: FakeObject[] = [
      {
        name: 'Item__c',
        keyPrefix: 'a03',
        fields: [],
        records: Array.from({ length: 30 }, (_, n) => ({ id: fakeId('a03', n + 1) })),
      },
      {
        name: 'Invoice__c',
        keyPrefix: 'a01',
        fields: [],
        records: Array.from({ length: 30 }, (_, n) => ({ id: fakeId('a01', n + 1) })),
      },
      {
        name: 'Line__c',
        keyPrefix: 'a02',
        fields: [masterDetail('Invoice__c', 'Invoice__c'), required('Item__c', 'Item__c')],
        records: Array.from({ length: 90 }, (_, n) => ({
          id: fakeId('a02', n + 1),
          refs: {
            Invoice__c: fakeId('a01', (n % 30) + 1),
            Item__c: fakeId('a03', Math.floor(n / 3) + 1),
          },
        })),
      },
    ];

    const part = sampled((await sampleOf(objects, { bytes: 60 * KB })).cut);
    const invoices = part.objects.find((object) => object.objectApiName === 'Invoice__c');
    expect(invoices?.asParents).toBeGreaterThan(0);
    expect(part.partialMasters).toEqual([
      {
        objectApiName: 'Invoice__c',
        details: 'Line__c',
        field: 'Invoice__c',
        asParents: invoices?.asParents,
      },
    ]);
  });

  it('keeps of a smaller budget a part of what a larger one keeps', async () => {
    const small = sampled(
      (await sampleOf(accountsAndContacts(300, 2), { bytes: 60 * KB, roomBytes: 1_000 * KB })).cut,
    );
    const large = sampled(
      (await sampleOf(accountsAndContacts(300, 2), { bytes: 200 * KB, roomBytes: 1_000 * KB })).cut,
    );
    for (const [objectApiName, ids] of small.ids) {
      const larger = new Set(idsOf(large, objectApiName));
      for (const id of ids) expect(larger.has(id)).toBe(true);
    }
    expect(small.rows).toBeLessThan(large.rows);
  });

  it('sets aside the same roots whatever the bound, so that a smaller bound keeps a part of what a larger one keeps', async () => {
    // The account created last brings four contacts, 10 KB; the others none.
    // Judged against a bound of 95 KB rather than the room, it would be set
    // aside there and not under 100 KB, and the smaller bound, freed of it,
    // would keep accounts the larger one does not.
    const objects: FakeObject[] = [
      {
        name: 'Account',
        keyPrefix: '001',
        fields: [],
        records: Array.from({ length: 101 }, (_, n) => ({
          id: A(n + 1),
          createdAt: n === 0 ? 1_000 : 500 - n,
        })),
      },
      {
        name: 'Contact',
        keyPrefix: '003',
        fields: [lookup('AccountId', 'Account')],
        records: [1, 2, 3, 4].map((n) => ({ id: C(n), refs: { AccountId: A(1) } })),
      },
    ];
    const options = { draw: 'recent' as const, roomBytes: 100 * KB };
    const small = sampled((await sampleOf(objects, { ...options, bytes: 95 * KB })).cut);
    const large = sampled((await sampleOf(objects, { ...options, bytes: 100 * KB })).cut);
    expect(small.heavyRoots).toEqual([]);
    const larger = new Set(idsOf(large, 'Account'));
    expect(idsOf(small, 'Account').every((id) => larger.has(id))).toBe(true);
    expect(idsOf(small, 'Account')).toContain(A(1));
  });

  it('reads no more batches of roots than the cut needs', async () => {
    const { source, draw } = await sampleOf(accountsAndContacts(2_000, 1), { bytes: 40 * KB });
    const rootReads = source.calls.filter(
      (c) => c.kind === 'rows' && c.objectApiName === 'Account',
    );
    expect(draw.roots.length).toBe(40);
    // 40 roots fit in the first batch: read once.
    expect(rootReads).toHaveLength(1);
    const big = await sampleOf(accountsAndContacts(2_000, 1), { bytes: 1_000 * KB });
    const read = big.source.calls
      .filter((c) => c.kind === 'rows' && c.objectApiName === 'Account')
      .reduce((sum, c) => sum + c.ids.length, 0);
    // 1 000 roots drawn, about 250 accounts of 4 KB kept: the first batch of 256 already passes, and is the last read.
    expect(read).toBe(256);
    expect(sampled(big.cut).limitedBy).toBe('storage');
  });
});

describe('drawTheSample: what cannot fit', () => {
  it('cuts nothing when the objects copied whole alone pass the bytes, and names the heaviest', async () => {
    const objects: FakeObject[] = [
      ...accountsAndContacts(50, 1),
      {
        name: 'Big__c',
        keyPrefix: 'a01',
        fields: [],
        records: Array.from({ length: 200 }, (_, n) => ({ id: fakeId('a01', n) })),
      },
    ];
    const { cut } = await sampleOf(objects, { bytes: 100 * KB, whole: ['Big__c'] });
    expect(cut).toEqual({
      kind: 'cannotFit',
      limitedBy: 'storage',
      rows: 200 + 1 + 1,
      storageBytes: 400 * KB + 2 * KB + 2 * KB,
      heaviest: [
        { objectApiName: 'Big__c', rows: 200, storageBytes: 400 * KB, whole: true },
        { objectApiName: 'Account', rows: 1, storageBytes: 2 * KB },
        { objectApiName: 'Contact', rows: 1, storageBytes: 2 * KB },
      ],
    });
  });

  it('refuses, rather than keep nothing, when the budget holds no root but the floors, drawn by recency', async () => {
    const { cut } = await sampleOf(accountsAndContacts(10, 1), {
      bytes: 512,
      floor: 1,
      draw: 'recent',
      roomBytes: 1_000 * KB,
    });
    expect(cut).toMatchObject({ kind: 'cannotFit', rows: 2, storageBytes: 4 * KB });
  });

  it('cuts nothing when the floor of each object alone passes the bytes', async () => {
    const { cut } = await sampleOf(accountsAndContacts(50, 1), {
      bytes: 3 * KB,
      floor: 1,
      roomBytes: 1_000 * KB,
    });
    expect(cut.kind).toBe('cannotFit');
  });

  it('refuses, without floors, when not one root fits with what it brings, rather than keep nothing', async () => {
    const { cut } = await sampleOf(accountsAndContacts(50, 1), {
      bytes: 3 * KB,
      floor: 0,
      roomBytes: 1_000 * KB,
    });
    // The smallest sample that keeps a drawn record: one account with its contact.
    expect(cut).toEqual({
      kind: 'cannotFit',
      limitedBy: 'storage',
      noRoot: true,
      rows: 2,
      storageBytes: 4 * KB,
      heaviest: [
        { objectApiName: 'Account', rows: 1, storageBytes: 2 * KB },
        { objectApiName: 'Contact', rows: 1, storageBytes: 2 * KB },
      ],
    });
  });

  it('refuses a budget of nothing, with floors or without, rather than keep nothing', async () => {
    for (const floor of [1, 0]) {
      const { cut } = await sampleOf(accountsAndContacts(50, 1), { bytes: 0, roomBytes: 0, floor });
      expect(cut).toMatchObject({ kind: 'cannotFit', rows: 2, storageBytes: 4 * KB });
    }
  });

  it('refuses a budget smaller than what any root brings, as a target with 0.502 MB left gives', async () => {
    // 80 % of what is left past the 0.5 MB kept for rounding: 1 677 bytes.
    const bytes = Math.floor(0.8 * 0.002 * 1024 * KB);
    for (const floor of [1, 0]) {
      const { cut } = await sampleOf(accountsAndContacts(50, 1), {
        bytes,
        roomBytes: bytes,
        floor,
      });
      expect(cut).toMatchObject({ kind: 'cannotFit', rows: 2, storageBytes: 4 * KB });
    }
  });
});

describe('drawTheSample: heavy roots', () => {
  /** One account with fifteen contacts: 32 KB, more than a tenth of a room of 100 KB. */
  const oneHub: FakeObject[] = [
    { name: 'Account', keyPrefix: '001', fields: [], records: [{ id: A(1) }] },
    {
      name: 'Contact',
      keyPrefix: '003',
      fields: [lookup('AccountId', 'Account')],
      records: Array.from({ length: 15 }, (_, n) => ({ id: C(n + 1), refs: { AccountId: A(1) } })),
    },
  ];

  it('keeps the first root of the draw, heavy as it is, when every root is', async () => {
    // Twenty accounts of five contacts each: 12 KB, past a tenth of 100 KB.
    const objects: FakeObject[] = [
      {
        name: 'Account',
        keyPrefix: '001',
        fields: [],
        records: Array.from({ length: 20 }, (_, n) => ({ id: A(n + 1) })),
      },
      {
        name: 'Contact',
        keyPrefix: '003',
        fields: [lookup('AccountId', 'Account')],
        records: Array.from({ length: 100 }, (_, n) => ({
          id: C(n + 1),
          refs: { AccountId: A(Math.floor(n / 5) + 1) },
        })),
      },
    ];
    const sample = sampled(
      (await sampleOf(objects, { bytes: 100 * KB, roomBytes: 100 * KB, floor: 0 })).cut,
    );
    expect(idsOf(sample, 'Account')).toHaveLength(1);
    expect(idsOf(sample, 'Contact')).toHaveLength(5);
    expect(sample.heavyRoots).toHaveLength(19);
  });

  it('never sets aside the root its object keeps as its floor: it goes in when it fits', async () => {
    const sample = sampled((await sampleOf(oneHub, { bytes: 100 * KB, roomBytes: 100 * KB })).cut);
    expect(sample.heavyRoots).toEqual([]);
    expect(idsOf(sample, 'Account')).toEqual([A(1)]);
    expect(idsOf(sample, 'Contact')).toHaveLength(15);
  });

  it('refuses, naming it, the root its object keeps as its floor when it does not fit, rather than let it go', async () => {
    const { cut } = await sampleOf(oneHub, { bytes: 20 * KB, roomBytes: 20 * KB });
    expect(cut).toEqual({
      kind: 'cannotFit',
      limitedBy: 'storage',
      rows: 16,
      storageBytes: 32 * KB,
      heaviest: [
        { objectApiName: 'Contact', rows: 15, storageBytes: 30 * KB },
        { objectApiName: 'Account', rows: 1, storageBytes: 2 * KB },
      ],
    });
  });

  /** Accounts with a contact each, the one created second to last with sixty. */
  function withAHub(): FakeObject[] {
    const records: FakeRecord[] = [];
    for (let n = 1; n <= 100; n++) records.push({ id: C(n), refs: { AccountId: A(n) } });
    for (let n = 101; n <= 160; n++) records.push({ id: C(n), refs: { AccountId: A(100) } });
    return [
      {
        name: 'Account',
        keyPrefix: '001',
        fields: [],
        // The account created last is the first root of a draw by recency, never set aside.
        records: Array.from({ length: 100 }, (_, n) => ({
          id: A(n + 1),
          createdAt: n === 98 ? 101 : n + 1,
        })),
      },
      { name: 'Contact', keyPrefix: '003', fields: [lookup('AccountId', 'Account')], records },
    ];
  }

  it('sets aside a root that would bring in more than a tenth of the room by itself, and names it with what swells it', async () => {
    const sample = sampled(
      (await sampleOf(withAHub(), { bytes: 200 * KB, roomBytes: 200 * KB, draw: 'recent' })).cut,
    );
    expect(sample.heavyRoots).toEqual([
      {
        objectApiName: 'Account',
        id: A(100),
        rows: 62,
        relation: { objectApiName: 'Contact', field: 'AccountId' },
      },
    ]);
    expect(idsOf(sample, 'Account')).not.toContain(A(100));
    expect(idsOf(sample, 'Contact').some((id) => id === C(150))).toBe(false);
  });

  it('says the roots set aside held it when every other root fits, never that the whole org fits', async () => {
    // A tenth of 500 KB is 50 KB: the hub's 124 KB go aside, and the 99
    // other accounts with their contacts, 396 KB, all fit.
    const sample = sampled(
      (await sampleOf(withAHub(), { bytes: 500 * KB, roomBytes: 500 * KB, draw: 'recent' })).cut,
    );
    expect(sample.limitedBy).toBe('heavyRoots');
    // Every root drawn but those set aside, said apart.
    expect(sample.share).toBe(1);
    expect(sample.heavyRoots.map((root) => root.id)).toEqual([A(100)]);
    expect(idsOf(sample, 'Account')).toHaveLength(99);

    // The same draw with room for the hub: nothing set aside, the whole org
    // kept, its 520 KB within 600.
    const whole = sampled(
      (await sampleOf(withAHub(), { bytes: 600 * KB, roomBytes: 2_000 * KB, draw: 'recent' })).cut,
    );
    expect(whole.heavyRoots).toEqual([]);
    expect(whole.limitedBy).toBe('whole');
  });

  it('keeps the same root when the room holds ten times what it brings', async () => {
    const sample = sampled(
      (await sampleOf(withAHub(), { bytes: 200 * KB, roomBytes: 2_000 * KB, draw: 'recent' })).cut,
    );
    expect(sample.heavyRoots).toEqual([]);
    expect(idsOf(sample, 'Account')).toContain(A(100));
  });
});

describe('drawTheSample: what it says', () => {
  it('counts the records the cap left under the records it went down from', async () => {
    const records: FakeRecord[] = Array.from({ length: 150 }, (_, n) => ({
      id: C(n + 1),
      refs: { AccountId: A(1) },
    }));
    const objects: FakeObject[] = [
      { name: 'Account', keyPrefix: '001', fields: [], records: [{ id: A(1) }] },
      { name: 'Contact', keyPrefix: '003', fields: [lookup('AccountId', 'Account')], records },
    ];
    const sample = sampled((await sampleOf(objects, { bytes: 1_000 * KB })).cut);
    expect(sample.objects.find((o) => o.objectApiName === 'Contact')).toMatchObject({
      kept: 100,
      childrenCut: [{ field: 'AccountId', rows: 50 }],
    });
  });

  it('says the records left out and why, and the lookups written empty', async () => {
    const objects: FakeObject[] = [
      {
        name: 'Account',
        keyPrefix: '001',
        fields: [lookup('ParentId', 'Account')],
        records: [
          { id: A(1) },
          { id: A(2), recordTypeId: '012000000000001AAA' },
          { id: A(3), refs: { ParentId: A(2) } },
        ],
      },
      {
        name: 'Contact',
        keyPrefix: '003',
        fields: [required('AccountId', 'Account')],
        records: [{ id: C(1), refs: { AccountId: A(2) } }],
      },
    ];
    const sample = sampled(
      (
        await sampleOf(objects, {
          bytes: 1_000 * KB,
          closure: { recordTypeVerdict: () => 'heldBack' },
        })
      ).cut,
    );
    expect(sample.dropped).toEqual([{ objectApiName: 'Account', rows: 1, reason: 'heldBack' }]);
    expect(sample.leftEmpty).toEqual([{ objectApiName: 'Account', field: 'ParentId', rows: 1 }]);
    expect(idsOf(sample, 'Account')).toEqual([A(1), A(3)]);
  });

  it('says apart the objects of which it keeps no record, never as empty', async () => {
    const objects: FakeObject[] = [
      ...accountsAndContacts(300, 1),
      {
        name: 'Lead',
        keyPrefix: '00Q',
        fields: [],
        records: Array.from({ length: 3 }, (_, n) => ({ id: fakeId('00Q', n) })),
      },
    ];
    const sample = sampled((await sampleOf(objects, { bytes: 4 * KB, floor: 0 })).cut);
    expect(sample.rows).toBeGreaterThan(0);
    expect(sample.noRecordDrawn.map((o) => o.objectApiName)).toContain('Lead');
  });

  it('weighs a person account 4 KB and its contact nothing, counts both, and sends only the account', async () => {
    const objects: FakeObject[] = [
      {
        name: 'Account',
        keyPrefix: '001',
        fields: [],
        records: [{ id: A(1), personAccount: true }],
      },
      {
        name: 'Contact',
        keyPrefix: '003',
        fields: [lookup('AccountId', 'Account')],
        records: [{ id: C(1), personAccount: true, refs: { AccountId: A(1) } }],
      },
    ];
    const sample = sampled((await sampleOf(objects, { bytes: 1_000 * KB })).cut);
    expect(sample.storageBytes).toBe(4 * KB);
    expect(sample.written).toBe(1);
    expect([...sample.personAccounts]).toEqual([
      ['Account', 1],
      ['Contact', 1],
    ]);
  });

  it('keeps the standard price book in the plan, linked, never counted', async () => {
    const objects: FakeObject[] = [
      {
        name: 'Pricebook2',
        keyPrefix: '01s',
        fields: [],
        records: [{ id: fakeId('01s', 1), matched: true }],
      },
      { name: 'Product2', keyPrefix: '01t', fields: [], records: [{ id: fakeId('01t', 1) }] },
      {
        name: 'PricebookEntry',
        keyPrefix: '01u',
        fields: [required('Pricebook2Id', 'Pricebook2'), required('Product2Id', 'Product2')],
        records: [
          {
            id: fakeId('01u', 1),
            refs: { Pricebook2Id: fakeId('01s', 1), Product2Id: fakeId('01t', 1) },
          },
        ],
      },
      { name: 'Account', keyPrefix: '001', fields: [], records: [{ id: A(1) }] },
      {
        name: 'Asset',
        keyPrefix: '02i',
        fields: [lookup('AccountId', 'Account'), lookup('Price__c', 'PricebookEntry')],
        records: [{ id: fakeId('02i', 1), refs: { AccountId: A(1), Price__c: fakeId('01u', 1) } }],
      },
    ];
    const sample = sampled((await sampleOf(objects, { bytes: 1_000 * KB })).cut);
    expect(idsOf(sample, 'Pricebook2')).toEqual([fakeId('01s', 1)]);
    expect(sample.objects.some((o) => o.objectApiName === 'Pricebook2')).toBe(false);
    // Account, asset, price and product: four records of 2 KB.
    expect(sample.storageBytes).toBe(8 * KB);
  });

  it('counts every record of an object copied whole and not read at its count, reference data at nothing', async () => {
    const objects: FakeObject[] = [
      ...accountsAndContacts(10, 1),
      {
        name: 'BusinessHours',
        keyPrefix: '01m',
        fields: [],
        records: [{ id: fakeId('01m', 1) }, { id: fakeId('01m', 2) }],
      },
      {
        name: 'Region__c',
        keyPrefix: 'a05',
        fields: [],
        records: Array.from({ length: 30 }, (_, n) => ({ id: fakeId('a05', n) })),
      },
    ];
    const sample = sampled(
      (
        await sampleOf(objects, {
          bytes: 1_000 * KB,
          whole: ['Region__c'],
          referenceData: ['BusinessHours'],
        })
      ).cut,
    );
    expect(sample.objects.find((o) => o.objectApiName === 'Region__c')).toMatchObject({
      kept: 30,
      whole: true,
    });
    expect(sample.objects.find((o) => o.objectApiName === 'BusinessHours')).toMatchObject({
      kept: 2,
      whole: true,
    });
    expect(sample.storageBytes).toBe((30 + 20) * 2 * KB);
    expect(sample.written).toBe(50);
    expect(sample.ids.has('Region__c')).toBe(false);
  });
});

describe('drawTheSample: the records the platform writes with the run', () => {
  it('counts once the role the platform writes with an opportunity and its contact, the plan holding it', async () => {
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
        fields: [lookup('AccountId', 'Account'), lookup('ContactId', 'Contact')],
        records: [{ id: O(1), refs: { AccountId: A(1), ContactId: C(1) } }],
      },
      {
        name: 'OpportunityContactRole',
        keyPrefix: '00K',
        fields: [required('OpportunityId', 'Opportunity'), required('ContactId', 'Contact')],
        records: [{ id: R(1), refs: { OpportunityId: O(1), ContactId: C(1) } }],
      },
    ];
    const sample = sampled((await sampleOf(objects, { bytes: 1_000 * KB })).cut);
    expect(idsOf(sample, 'OpportunityContactRole')).toEqual([R(1)]);
    expect(sample.byThePlatform).toEqual([
      { objectApiName: 'OpportunityContactRole', inPlan: 1, beyond: 0 },
    ]);
    // The account, the contact, the opportunity, and the role, which nobody sends.
    expect(sample.storageBytes).toBe(4 * 2 * KB);
    expect(sample.written).toBe(3);
  });

  it('counts the role the platform writes with an opportunity copied as a parent, which the plan does not hold', async () => {
    // The account created last is the root of the share kept; the case under
    // it names an opportunity of the other account, copied as a parent with
    // its contact.
    const objects: FakeObject[] = [
      {
        name: 'Account',
        keyPrefix: '001',
        fields: [],
        records: [
          { id: A(1), createdAt: 1 },
          { id: A(2), createdAt: 2 },
        ],
      },
      {
        name: 'Contact',
        keyPrefix: '003',
        fields: [lookup('AccountId', 'Account')],
        records: [
          { id: C(1), refs: { AccountId: A(2) } },
          { id: C(9), refs: { AccountId: A(1) } },
        ],
      },
      {
        name: 'Opportunity',
        keyPrefix: '006',
        fields: [lookup('AccountId', 'Account'), lookup('ContactId', 'Contact')],
        records: [
          { id: O(1), refs: { AccountId: A(1), ContactId: C(1) } },
          { id: O(2), refs: { ContactId: C(1) } },
        ],
      },
      {
        name: 'OpportunityContactRole',
        keyPrefix: '00K',
        fields: [required('OpportunityId', 'Opportunity'), required('ContactId', 'Contact')],
        records: [
          { id: R(1), refs: { OpportunityId: O(1), ContactId: C(1) } },
          { id: R(2), refs: { OpportunityId: O(2), ContactId: C(1) } },
        ],
      },
      {
        name: 'Case',
        keyPrefix: '500',
        fields: [lookup('AccountId', 'Account'), lookup('Opportunity__c', 'Opportunity')],
        records: [{ id: K(1), refs: { AccountId: A(2), Opportunity__c: O(1) } }],
      },
    ];
    const sample = sampled(
      (
        await sampleOf(objects, {
          bytes: 1_000 * KB,
          maxTotal: 6,
          floor: 0,
          draw: 'recent',
          closure: { children: 1 },
        })
      ).cut,
    );
    expect(idsOf(sample, 'Opportunity')).toEqual([O(1), O(2)]);
    expect(sample.objects.find((o) => o.objectApiName === 'Opportunity')).toMatchObject({
      below: 1,
      asParents: 1,
    });
    expect(idsOf(sample, 'OpportunityContactRole')).toEqual([R(2)]);
    expect(sample.byThePlatform).toEqual([
      { objectApiName: 'OpportunityContactRole', inPlan: 1, beyond: 1 },
    ]);
    // Two accounts, the contact, two opportunities and the case; and the two roles the platform writes.
    expect(sample.written).toBe(6);
    expect(sample.storageBytes).toBe(8 * 2 * KB);
  });

  it("counts the direct relation the platform writes with a contact and its account, but none with a person account's contact", async () => {
    const objects: FakeObject[] = [
      {
        name: 'Account',
        keyPrefix: '001',
        fields: [],
        records: [{ id: A(1) }, { id: A(2), personAccount: true }],
      },
      {
        name: 'Contact',
        keyPrefix: '003',
        fields: [lookup('AccountId', 'Account')],
        records: [
          { id: C(1), refs: { AccountId: A(1) } },
          { id: C(2), refs: { AccountId: A(2) }, personAccount: true },
        ],
      },
      {
        name: 'AccountContactRelation',
        keyPrefix: '07k',
        fields: [required('AccountId', 'Account'), required('ContactId', 'Contact')],
        records: [{ id: fakeId('07k', 1), refs: { AccountId: A(1), ContactId: C(1) } }],
      },
    ];
    const sample = sampled((await sampleOf(objects, { bytes: 1_000 * KB })).cut);
    expect(sample.byThePlatform).toEqual([
      { objectApiName: 'AccountContactRelation', inPlan: 1, beyond: 0 },
    ]);
    // A business account, its contact and their relation; a person account with its contact.
    expect(sample.storageBytes).toBe(3 * 2 * KB + 4 * KB);
  });
});

describe('drawTheSample: no orphan', () => {
  it('holds every record a record of the plan names, but for the lookups it says it leaves empty', async () => {
    const objects: FakeObject[] = [
      ...accountsAndContacts(80, 2),
      {
        name: 'Case',
        keyPrefix: '500',
        fields: [lookup('AccountId', 'Account'), lookup('ContactId', 'Contact')],
        records: Array.from({ length: 200 }, (_, n) => ({
          id: K(n + 1),
          refs: { AccountId: A((n % 80) + 1), ContactId: C(((n * 7) % 160) + 1) },
        })),
      },
    ];
    for (const parents of ['all', 'required'] as const) {
      const { source, links, cut } = await sampleOf(objects, {
        bytes: 120 * KB,
        closure: { parents },
      });
      const sample = sampled(cut);
      const orphans = orphansOf(source, links, sample);
      expect(orphans.filter((o) => o.required)).toEqual([]);
      expect(emptiedOf(orphans)).toEqual(sample.leftEmpty);
      if (parents === 'all') expect(sample.leftEmpty).toEqual([]);
      else expect(sample.leftEmpty.length).toBeGreaterThan(0);
    }
  });
});
