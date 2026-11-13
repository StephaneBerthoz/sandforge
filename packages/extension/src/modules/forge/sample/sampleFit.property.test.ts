/**
 * Properties of a sample of the whole org, on orgs drawn at random from a
 * seed: objects that point at each other, at themselves and round cycles,
 * lookups a record cannot be written without, master-details, lookups that
 * may name two objects, records that name a record the source does not
 * hold, records outside their object's filter, record types the run holds
 * back, and records that a hundred others name.
 *
 * Each property runs a fixed number of orgs from a fixed seed: a failure
 * names the seed of the org it failed on, and runs again the same.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  drawFakeSample,
  emptiedOf,
  fakeId,
  lookup,
  orphansOf,
  seeded,
  type FakeObject,
  type FakeRecord,
  type FakeSampleOptions,
} from '../../../test/sampleSource';
import type { SampleField } from './sampleLinks';
import type { SampleCut } from './sampleFit';

const KB = 1024;
const RUNS = { seed: 20261113, numRuns: 60 };

/** A record type the run holds back: see `recordTypeVerdict` below. */
const CLOSED_TYPE = '012000000000009AAA';

/** An org drawn from `seed`: see the file's header. */
function randomOrg(seed: number): FakeObject[] {
  const random = seeded(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const count = 2 + Math.floor(random() * 5);
  const names = Array.from({ length: count }, (_, i) => `Obj${i}__c`);
  const prefixes = names.map((_, i) => `a${String(i).padStart(2, '0')}`);
  const sizes = names.map(() => Math.floor(random() * 30));
  const fields = names.map((name) => {
    const own: SampleField[] = [];
    const lookups = Math.floor(random() * 4);
    for (let f = 0; f < lookups; f++) {
      const targets = random() < 0.2 ? [pick(names), pick(names)] : [pick(names)];
      const unique = [...new Set(targets)];
      const isRequired = random() < 0.3 && !unique.includes(name);
      own.push(
        lookup(`L${f}__c`, unique, {
          nillable: !isRequired,
          isMasterDetail: isRequired && unique.length === 1 && random() < 0.3,
        }),
      );
    }
    if (random() < 0.1) own.push(lookup('OwnerId', 'User', { nillable: false }));
    return own;
  });
  return names.map((name, i) => {
    const records: FakeRecord[] = Array.from({ length: sizes[i] }, (_, n) => {
      const refs: Record<string, string | null> = {};
      for (const field of fields[i]) {
        if (field.referenceTo[0] === 'User') {
          refs[field.name] = fakeId('005', 1);
          continue;
        }
        const filled = field.nillable === false || random() < 0.6;
        if (!filled) {
          refs[field.name] = null;
          continue;
        }
        const target = names.indexOf(pick(field.referenceTo));
        const size = sizes[target];
        // Some name a record the source does not hold; many name the same one.
        const at =
          random() < 0.05 || size === 0
            ? 900 + n
            : random() < 0.3
              ? 0
              : Math.floor(random() * size);
        refs[field.name] = fakeId(prefixes[target], at);
      }
      return {
        id: fakeId(prefixes[i], n),
        refs,
        createdAt: Math.floor(random() * 1_000),
        ...(random() < 0.05 ? { filteredOut: true } : {}),
        ...(random() < 0.05 ? { recordTypeId: CLOSED_TYPE } : {}),
      };
    });
    return { name, keyPrefix: prefixes[i], fields: fields[i], records };
  });
}

/** How each property draws: drawn from the seed of the run too. */
function optionsOf(seed: number): FakeSampleOptions {
  const random = seeded(seed * 31 + 7);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  return {
    bytes: pick([4, 12, 30, 80, 400]) * KB,
    wholeRoom: pick([0, 0, 60 * KB, 1_000 * KB]),
    roomBytes: pick([40, 400, 4_000]) * KB,
    seed: pick([1, 2, 3]),
    draw: pick(['uniform', 'recent'] as const),
    floor: pick([0, 1, 2]),
    closure: {
      parents: pick(['all', 'required'] as const),
      children: pick([1, 3, 100] as const),
      recordTypeVerdict: (_object, recordType) =>
        recordType === CLOSED_TYPE ? 'heldBack' : undefined,
    },
  };
}

/** The ids of a sample, every object's, as one set of `object:id`. */
function idsOf(cut: SampleCut): Set<string> {
  return new Set(
    [...cut.ids].flatMap(([objectApiName, ids]) => ids.map((id) => `${objectApiName}:${id}`)),
  );
}

describe('a sample of the whole org, on orgs drawn at random', () => {
  it('holds every record a record of it cannot be written without, and says every other lookup it leaves empty', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1_000_000 }), async (seed) => {
        const objects = randomOrg(seed);
        const { source, links, cut } = await drawFakeSample(objects, optionsOf(seed));
        if (cut.kind !== 'sample') return;
        const orphans = orphansOf(source, links, cut);
        expect(orphans.filter((orphan) => orphan.required)).toEqual([]);
        expect(emptiedOf(orphans)).toEqual(cut.leftEmpty);
      }),
      RUNS,
    );
  });

  it('never takes more than the bytes it may, nor more records than --max-total', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 60 }),
        async (seed, maxTotal) => {
          const options = { ...optionsOf(seed), maxTotal };
          const { cut } = await drawFakeSample(randomOrg(seed), options);
          if (cut.kind !== 'sample') return;
          expect(cut.storageBytes).toBeLessThanOrEqual(options.bytes);
          expect(cut.written).toBeLessThanOrEqual(maxTotal);
        },
      ),
      RUNS,
    );
  });

  it('keeps of a smaller budget a part of what a larger one keeps, the room the same', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 2, max: 60 }),
        fc.integer({ min: 1, max: 200 }),
        async (seed, smallKB, moreKB) => {
          const objects = randomOrg(seed);
          const options = optionsOf(seed);
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

  it('draws the same plan from the same seed, whatever order the source answers in', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 2, max: 50 }),
        async (seed, order) => {
          const objects = randomOrg(seed);
          const options = optionsOf(seed);
          const first = await drawFakeSample(objects, { ...options, order: 1 });
          const again = await drawFakeSample(objects, { ...options, order });
          expect(
            JSON.stringify(again.cut, (_key, value: unknown) =>
              value instanceof Map ? [...value] : value,
            ),
          ).toBe(
            JSON.stringify(first.cut, (_key, value: unknown) =>
              value instanceof Map ? [...value] : value,
            ),
          );
        },
      ),
      RUNS,
    );
  });
});
