import { describe, expect, it } from 'vitest';
import { countedStorageBytes } from '../modules/forge/ForgeRunGate';
import { sampleLinksOf } from '../modules/forge/sample/sampleLinks';
import {
  FakeSampleSource,
  drawRootsOf,
  emptiedOf,
  fakeId,
  lookup,
  orphansOf,
  required,
  seeded,
  type FakeDrawOptions,
  type FakeObject,
} from './sampleSource';

const A = (n: number) => fakeId('001', n);
const C = (n: number) => fakeId('003', n);

const objects: FakeObject[] = [
  {
    name: 'Account',
    keyPrefix: '001',
    fields: [],
    records: [
      { id: A(1), createdAt: 1 },
      { id: A(2), createdAt: 3 },
      { id: A(3), createdAt: 2, filteredOut: true },
    ],
  },
  {
    name: 'Contact',
    keyPrefix: '003',
    fields: [required('AccountId', 'Account'), lookup('ReportsToId', 'Contact')],
    records: [
      { id: C(1), refs: { AccountId: A(1) } },
      { id: C(2), refs: { AccountId: A(1), ReportsToId: C(1) } },
      { id: C(3), refs: { AccountId: A(1) } },
      { id: C(4), refs: { AccountId: A(3) } },
    ],
  },
];

describe('FakeSampleSource', () => {
  it('reads by id under no filter, marks a record outside it, and gives back nothing of an id it does not hold', async () => {
    const source = new FakeSampleSource(objects);
    const rows = await source.rows('Account', [A(1), A(3), A(404)]);
    expect([...rows].sort((a, b) => (a.id < b.id ? -1 : 1))).toEqual([
      { id: A(1), refs: {} },
      { id: A(3), refs: {}, outsideFilter: true },
    ]);
  });

  it('refuses an object it does not hold, as an org does', async () => {
    await expect(new FakeSampleSource(objects).rows('Lead', [A(1)])).rejects.toThrow(
      'INVALID_TYPE',
    );
  });

  it('reads the records under a relation under the filter, the last by id within the cap, with how many each has', async () => {
    const source = new FakeSampleSource(objects);
    const relation = {
      objectApiName: 'Contact',
      field: 'AccountId',
      parents: ['Account'],
      masterDetail: false,
    };
    const answer = await source.children(relation, [A(1), A(3)], 2);
    expect(answer.rows.map((r) => r.id).sort()).toEqual([C(2), C(3), C(4)]);
    expect([...(answer.counts ?? [])]).toEqual([
      [A(1).slice(0, 15), 3],
      [A(3).slice(0, 15), 1],
    ]);
    const listed = await new FakeSampleSource(objects, { uncounted: true }).children(
      relation,
      [A(1)],
      2,
    );
    expect(listed.rows).toHaveLength(3);
    expect(listed.counts).toBeUndefined();
  });

  it('answers in an order of its own, the same for the same seed', async () => {
    const ids = [C(1), C(2), C(3), C(4)];
    const order = async (seed: number) =>
      (await new FakeSampleSource(objects, { order: seed }).rows('Contact', ids)).map((r) => r.id);
    expect(await order(5)).toEqual(await order(5));
    const orders = new Set<string>();
    for (let seed = 1; seed < 20; seed++) orders.add((await order(seed)).join());
    expect(orders.size).toBeGreaterThan(1);
    expect(seeded(3)()).toBe(seeded(3)());
  });
});

describe('drawRootsOf', () => {
  it('reads a draw by recency in the order of creation, the latest first, whatever the ids', () => {
    const source = new FakeSampleSource(objects);
    const links = sampleLinksOf({
      objects: source.inputs(),
      roomBytes: 0,
      wholeBytes: (name, rows) => countedStorageBytes(name, { rows }),
    });
    const draw = drawRootsOf(source, links, { bytes: 1024, floor: 0, draw: 'recent' });
    expect(draw.roots).toEqual([{ objectApiName: 'Account', id: A(2), rank: 0 }]);
  });

  it('reads a draw of the oldest the first created first, and holds the share below the next it left unread', () => {
    const source = new FakeSampleSource(objects);
    const links = sampleLinksOf({
      objects: source.inputs(),
      roomBytes: 0,
      wholeBytes: (name, rows) => countedStorageBytes(name, { rows }),
    });
    const draw = drawRootsOf(source, links, { bytes: 1024, floor: 0, draw: 'oldest' });
    expect(draw.roots).toEqual([{ objectApiName: 'Account', id: A(1), rank: 0 }]);
    expect(draw.read.get('Account')).toEqual(new Set([A(1).slice(0, 15)]));
    expect(draw.beyond).toBe(0.5);
  });

  it('draws only among the roots in the window and chosen by the filter on the roots', () => {
    const accounts: FakeObject = {
      name: 'Account',
      keyPrefix: '001',
      fields: [],
      records: [1, 2, 3, 4, 5].map((n) => ({
        id: A(n),
        createdAt: n * 10,
        modifiedAt: 100 - n,
        values: { Country: n % 2 === 0 ? 'France' : 'Spain' },
      })),
    };
    const source = new FakeSampleSource([accounts]);
    const links = sampleLinksOf({
      objects: source.inputs(),
      roomBytes: 0,
      wholeBytes: (name, rows) => countedStorageBytes(name, { rows }),
    });
    const ids = (options: Partial<FakeDrawOptions>) =>
      drawRootsOf(source, links, { bytes: 100 * 1024, floor: 0, ...options })
        .roots.map((root) => root.id)
        .sort();
    expect(ids({ window: { field: 'CreatedDate', from: 20, to: 40 } })).toEqual([A(2), A(3)]);
    expect(ids({ window: { field: 'LastModifiedDate', from: 97 } })).toEqual([A(1), A(2), A(3)]);
    expect(ids({ rootWhere: { Account: (r) => r.values?.Country === 'France' } })).toEqual([
      A(2),
      A(4),
    ]);
    expect(
      ids({
        window: { field: 'CreatedDate', to: 30 },
        rootWhere: { Account: (r) => r.values?.Country === 'France' },
      }),
    ).toEqual([A(2)]);
  });

  it('draws a stratified object by stratum, the floor of each value kept at rank 0', () => {
    const accounts: FakeObject = {
      name: 'Account',
      keyPrefix: '001',
      fields: [],
      records: Array.from({ length: 20 }, (_, n) => ({
        id: A(n + 1),
        createdAt: n,
        values: { Kind: n < 2 ? 'Rare' : 'Common' },
      })),
    };
    const source = new FakeSampleSource([accounts]);
    const links = sampleLinksOf({
      objects: source.inputs(),
      roomBytes: 0,
      wholeBytes: (name, rows) => countedStorageBytes(name, { rows }),
    });
    const draw = drawRootsOf(source, links, {
      bytes: 3 * 1024,
      floor: 1,
      draw: 'recent',
      strata: { Account: 'Kind' },
    });
    const atZero = draw.roots.filter((root) => root.rank === 0).map((root) => root.id);
    // The newest of each value: the second rare one, the last common one.
    expect(atZero.sort()).toEqual([A(2), A(20)]);
    expect(draw.strata.get('Account')?.field).toBe('Kind');
  });
});

describe('orphansOf', () => {
  const source = new FakeSampleSource(objects);
  const links = sampleLinksOf({
    objects: source.inputs(),
    roomBytes: 0,
    wholeBytes: (name, rows) => countedStorageBytes(name, { rows }),
  });

  it('finds none in a plan that holds every record its records name', () => {
    expect(
      orphansOf(source, links, {
        ids: new Map([
          ['Account', [A(1)]],
          ['Contact', [C(1), C(2)]],
        ]),
      }),
    ).toEqual([]);
  });

  it('finds the record a plan holds without its required parent, and the optional lookup it does not hold', () => {
    const orphans = orphansOf(source, links, { ids: new Map([['Contact', [C(2)]]]) });
    expect(orphans).toEqual([
      { objectApiName: 'Contact', id: C(2), field: 'AccountId', names: A(1), required: true },
      { objectApiName: 'Contact', id: C(2), field: 'ReportsToId', names: C(1), required: false },
    ]);
    expect(emptiedOf(orphans)).toEqual([
      { objectApiName: 'Contact', field: 'AccountId', rows: 1 },
      { objectApiName: 'Contact', field: 'ReportsToId', rows: 1 },
    ]);
  });

  it('holds every record of an object copied whole the plan lists no id of, under its filter', () => {
    const whole = sampleLinksOf({
      objects: source.inputs(),
      roomBytes: 0,
      whole: ['Account'],
      wholeBytes: (name, rows) => countedStorageBytes(name, { rows }),
    });
    const orphans = orphansOf(source, whole, { ids: new Map([['Contact', [C(1), C(4)]]]) });
    expect(orphans).toEqual([
      { objectApiName: 'Contact', id: C(4), field: 'AccountId', names: A(3), required: true },
    ]);
  });
});
