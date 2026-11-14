/**
 * Properties of the draws of a sample of the whole org that choose its
 * roots — spread over the org, the newest or the oldest first, held to a
 * window of dates and to a filter on the roots of some objects, stratified
 * by a picklist or a checkbox — on orgs drawn at random from a seed, as
 * `sampleFit.property.test.ts` draws them: objects that point at each other
 * and at themselves, lookups a record cannot be written without, records
 * outside their object's filter.
 *
 * Each property runs a fixed number of orgs from a fixed seed: a failure
 * names the seed of the org it failed on, and runs again the same.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  byDateOf,
  drawFakeSample,
  emptiedOf,
  fakeId,
  inTheDraw,
  lookup,
  orphansOf,
  required,
  seeded,
  type FakeObject,
  type FakeRecord,
  type FakeSampleOptions,
} from '../../../test/sampleSource';
import { isRootRow, type SampleField, type SampleLinks } from './sampleLinks';
import type { SampleCut } from './sampleFit';
import { compareIds, idKey, rankOf, recentRankOf } from './sampleRank';
import { stratumRankOf } from './sampleStrata';

const KB = 1024;
const RUNS = { seed: 20261114, numRuns: 60 };

/** The values of a picklist drawn skewed: a common one, rarer ones, one of a few records, and none. */
const KINDS: ReadonlyArray<[string | null, number]> = [
  ['Common', 0.55],
  ['Usual', 0.2],
  ['Rare', 0.1],
  ['Scarce', 0.04],
  [null, 0.11],
];

/** An org drawn from `seed`: see the file's header. */
function randomOrg(seed: number): FakeObject[] {
  const random = seeded(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const kind = (): string | null => {
    let at = random();
    for (const [value, weight] of KINDS) {
      if (at < weight) return value;
      at -= weight;
    }
    return null;
  };
  const count = 2 + Math.floor(random() * 4);
  const names = Array.from({ length: count }, (_, i) => `Obj${i}__c`);
  const prefixes = names.map((_, i) => `a${String(i).padStart(2, '0')}`);
  const sizes = names.map(() => Math.floor(random() * 60));
  const fields = names.map((name) => {
    const own: SampleField[] = [];
    const lookups = Math.floor(random() * 3);
    for (let f = 0; f < lookups; f++) {
      const target = pick(names);
      const isRequired = random() < 0.25 && target !== name;
      own.push(lookup(`L${f}__c`, target, { nillable: !isRequired }));
    }
    return own;
  });
  return names.map((name, i) => {
    const records: FakeRecord[] = Array.from({ length: sizes[i] }, (_, n) => {
      const refs: Record<string, string | null> = {};
      for (const field of fields[i]) {
        const filled = field.nillable === false || random() < 0.5;
        const target = names.indexOf(field.referenceTo[0]);
        refs[field.name] =
          filled && sizes[target] > 0
            ? fakeId(prefixes[target], Math.floor(random() * sizes[target]))
            : null;
      }
      const createdAt = Math.floor(random() * 1_000);
      return {
        id: fakeId(prefixes[i], n),
        refs,
        createdAt,
        modifiedAt: createdAt + Math.floor(random() * 300),
        values: {
          Kind: kind(),
          Flag: random() < 0.3,
          Region: pick(['North', 'South', 'East']),
        },
        ...(random() < 0.04 ? { filteredOut: true } : {}),
      };
    });
    return { name, keyPrefix: prefixes[i], fields: fields[i], records };
  });
}

/** How each property draws, drawn from the seed of the run too, against the org's objects. */
function optionsOf(seed: number, objects: readonly FakeObject[]): FakeSampleOptions {
  const random = seeded(seed * 31 + 7);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const rootWhere: Record<string, (record: FakeRecord) => boolean> = {};
  const strata: Record<string, string> = {};
  for (const object of objects) {
    if (random() < 0.3) rootWhere[object.name] = (record) => record.values?.Region !== 'South';
    if (random() < 0.6) strata[object.name] = pick(['Kind', 'Kind', 'Flag']);
  }
  const from = random() < 0.6 ? Math.floor(random() * 600) : undefined;
  const to = random() < 0.6 ? 400 + Math.floor(random() * 700) : undefined;
  return {
    bytes: pick([4, 12, 30, 80, 400]) * KB,
    wholeRoom: pick([0, 0, 60 * KB]),
    roomBytes: pick([40, 400, 4_000]) * KB,
    seed: pick([1, 2, 3]),
    draw: pick(['uniform', 'recent', 'oldest'] as const),
    floor: pick([0, 1, 2]),
    ...(random() < 0.5
      ? {
          window: {
            field: pick(['CreatedDate', 'LastModifiedDate'] as const),
            ...(from !== undefined ? { from } : {}),
            ...(to !== undefined ? { to } : {}),
          },
        }
      : {}),
    rootWhere,
    strata,
    closure: {
      parents: pick(['all', 'required'] as const),
      children: pick([1, 3, 100] as const),
    },
  };
}

/** The ids of a sample, every object's, as one set of `object:id`. */
function idsOf(cut: SampleCut): Set<string> {
  return new Set(
    [...cut.ids].flatMap(([objectApiName, ids]) => ids.map((id) => `${objectApiName}:${id}`)),
  );
}

/** A cut as one text, its maps listed: two equal cuts give the same. */
function textOf(cut: unknown): string {
  return JSON.stringify(cut, (_key, value: unknown) => (value instanceof Map ? [...value] : value));
}

/** A root of the draw the reads left unread, with the rank every root read would have given it. */
interface UnreadRoot {
  objectApiName: string;
  id: string;
  rank: number;
  stratified: boolean;
}

/**
 * The roots in the draw that no read handed to it, each ranked as a read of
 * every root ranks it: in its stratum, (i + ½)/N, by its rank spread over
 * the org then its id, or by date; otherwise its rank spread over the org, or
 * its place by date over the roots.
 */
function unreadRootsOf(
  objects: readonly FakeObject[],
  links: SampleLinks,
  options: FakeSampleOptions,
  read: ReadonlyMap<string, ReadonlySet<string>>,
): UnreadRoot[] {
  const seed = options.seed ?? 1;
  const draw = options.draw ?? 'uniform';
  const unread: UnreadRoot[] = [];
  for (const object of objects) {
    const kind = links.classes.get(object.name);
    if (kind?.kind !== 'drawn' || !kind.rooted) continue;
    const roots = object.records.filter(
      (record) =>
        !record.filteredOut &&
        isRootRow(links, object.name, record.refs ?? {}) &&
        inTheDraw(object.name, record, options),
    );
    const order =
      draw === 'uniform'
        ? (a: FakeRecord, b: FakeRecord) =>
            rankOf(seed, a.id) - rankOf(seed, b.id) || compareIds(a.id, b.id)
        : byDateOf(draw);
    const field = options.strata?.[object.name];
    const ranked: Array<{ id: string; rank: number }> = [];
    if (field !== undefined) {
      const strata = new Map<string, FakeRecord[]>();
      for (const record of roots) {
        const key = JSON.stringify(record.values?.[field] ?? null);
        strata.set(key, [...(strata.get(key) ?? []), record]);
      }
      for (const members of strata.values()) {
        members
          .sort(order)
          .forEach((record, i) =>
            ranked.push({ id: record.id, rank: stratumRankOf(i, members.length) }),
          );
      }
    } else if (draw === 'uniform') {
      for (const record of roots) ranked.push({ id: record.id, rank: rankOf(seed, record.id) });
    } else {
      [...roots]
        .sort(order)
        .forEach((record, i) =>
          ranked.push({ id: record.id, rank: recentRankOf(i, roots.length) }),
        );
    }
    const readOf = read.get(object.name) ?? new Set<string>();
    for (const root of ranked) {
      if (readOf.has(idKey(root.id))) continue;
      unread.push({ objectApiName: object.name, ...root, stratified: field !== undefined });
    }
  }
  return unread;
}

describe('the draws that choose the roots of a sample, on orgs drawn at random', () => {
  it('holds every record a record of it cannot be written without, and says every other lookup it leaves empty', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1_000_000 }), async (seed) => {
        const objects = randomOrg(seed);
        const { source, links, cut } = await drawFakeSample(objects, optionsOf(seed, objects));
        if (cut.kind !== 'sample') return;
        const orphans = orphansOf(source, links, cut);
        expect(orphans.filter((orphan) => orphan.required)).toEqual([]);
        expect(emptiedOf(orphans)).toEqual(cut.leftEmpty);
      }),
      RUNS,
    );
  });

  it('keeps of a smaller budget a part of what a larger one keeps, the draw the same', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 2, max: 60 }),
        fc.integer({ min: 1, max: 200 }),
        async (seed, smallKB, moreKB) => {
          const objects = randomOrg(seed);
          const options = optionsOf(seed, objects);
          const small = await drawFakeSample(objects, { ...options, bytes: smallKB * KB });
          const large = await drawFakeSample(objects, {
            ...options,
            bytes: (smallKB + moreKB) * KB,
          });
          if (small.cut.kind !== 'sample' || large.cut.kind !== 'sample') return;
          const larger = idsOf(large.cut);
          for (const id of idsOf(small.cut)) expect(larger.has(id)).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it('draws the same plan whatever order the source answers and its roots are scanned in', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 2, max: 50 }),
        async (seed, order) => {
          const objects = randomOrg(seed);
          const options = optionsOf(seed, objects);
          const first = await drawFakeSample(objects, { ...options, order: 1 });
          const again = await drawFakeSample(objects, { ...options, order });
          expect(textOf(again.cut)).toBe(textOf(first.cut));
        },
      ),
      RUNS,
    );
  });

  it('draws its roots among those in the window and chosen by the filter on the roots alone', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1_000_000 }), async (seed) => {
        const objects = randomOrg(seed);
        const options = optionsOf(seed, objects);
        const { source, draw, cut } = await drawFakeSample(objects, options);
        if (cut.kind !== 'sample') return;
        for (const root of draw.roots) {
          const record = source.record(root.objectApiName, root.id);
          expect(record).toBeDefined();
          if (record) expect(inTheDraw(root.objectApiName, record, options)).toBe(true);
        }
      }),
      RUNS,
    );
  });

  it('ranks every root it holds, and its share, below every root of the draw it left unread', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1_000_000 }), async (seed) => {
        const objects = randomOrg(seed);
        const options = optionsOf(seed, objects);
        const { links, draw, cut } = await drawFakeSample(objects, options);
        // What a cut may keep: the roots below the rank one was let go or left unread at.
        const held = draw.roots.filter((root) => root.rank < draw.beyond);
        const last = Math.max(-Infinity, ...held.map((root) => root.rank));
        for (const root of unreadRootsOf(objects, links, options, draw.read)) {
          const unread = `${root.objectApiName} ${root.id} unread at ${root.rank}`;
          expect(last, unread).toBeLessThan(root.rank);
          if (cut.kind === 'sample') expect(cut.share, unread).toBeLessThan(root.rank);
        }
      }),
      RUNS,
    );
  });

  it('reads enough of each stratum that every root read gives the same sample', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1_000_000 }), async (seed) => {
        const objects = randomOrg(seed);
        const options = optionsOf(seed, objects);
        const taken = await drawFakeSample(objects, options);
        const every = await drawFakeSample(objects, { ...options, readEveryRoot: true });
        expect(textOf(taken.cut)).toBe(textOf(every.cut));
      }),
      RUNS,
    );
  });
});

describe('a filter on the roots, against the same condition as a filter of the object', () => {
  const A = (n: number) => fakeId('001', n);
  const C = (n: number) => fakeId('003', n);
  const country = (value: string) => ({ Country: value });
  const objects = (outsideTheFilter: boolean): FakeObject[] => [
    {
      name: 'Account',
      keyPrefix: '001',
      fields: [lookup('ParentId', 'Account')],
      records: [
        { id: A(1), refs: { ParentId: A(3) }, values: country('France') },
        {
          id: A(2),
          refs: { ParentId: null },
          values: country('Germany'),
          ...(outsideTheFilter ? { filteredOut: true } : {}),
        },
        {
          id: A(3),
          refs: { ParentId: null },
          values: country('Germany'),
          ...(outsideTheFilter ? { filteredOut: true } : {}),
        },
        { id: A(4), refs: { ParentId: null }, values: country('France') },
      ],
    },
    {
      name: 'Contact',
      keyPrefix: '003',
      fields: [required('AccountId', 'Account')],
      records: [
        { id: C(1), refs: { AccountId: A(1) }, values: { MailingCountry: 'Germany' } },
        { id: C(2), refs: { AccountId: A(2) }, values: { MailingCountry: 'Germany' } },
      ],
    },
  ];
  const france = (record: FakeRecord) => record.values?.Country === 'France';

  it('draws among the roots it chooses, and keeps under and above them what it does not choose, no lookup left empty for it', async () => {
    const { cut } = await drawFakeSample(objects(false), {
      bytes: 400 * KB,
      rootWhere: { Account: france },
    });
    if (cut.kind !== 'sample') throw new Error('The sample did not fit.');
    expect(cut.ids.get('Account')?.slice().sort()).toEqual([A(1), A(3), A(4)]);
    // A contact of a French account, whatever its own country.
    expect(cut.ids.get('Contact')).toEqual([C(1)]);
    expect(cut.leftEmpty).toEqual([]);
  });

  it('leaves the foreign parent out as a filter of the object does, its lookup written empty', async () => {
    const { cut } = await drawFakeSample(objects(true), { bytes: 400 * KB });
    if (cut.kind !== 'sample') throw new Error('The sample did not fit.');
    expect(cut.ids.get('Account')?.slice().sort()).toEqual([A(1), A(4)]);
    expect(cut.leftEmpty).toEqual([{ objectApiName: 'Account', field: 'ParentId', rows: 1 }]);
  });
});

describe('a draw by date that stops short of an object’s roots', () => {
  it('never says every root is in the sample', async () => {
    const leads: FakeObject = {
      name: 'Lead',
      keyPrefix: '00Q',
      fields: [],
      records: Array.from({ length: 100 }, (_, n) => ({ id: fakeId('00Q', n), createdAt: n })),
    };
    for (const draw of ['recent', 'oldest'] as const) {
      const { cut } = await drawFakeSample([leads], {
        bytes: 400 * KB,
        maxTotal: 10,
        draw,
        floor: 0,
      });
      if (cut.kind !== 'sample') throw new Error('The sample did not fit.');
      expect(cut.ids.get('Lead')).toHaveLength(10);
      expect(cut.limitedBy).toBe('maxTotal');
      expect(cut.share).toBeLessThan(1);
    }
  });
});
