/**
 * Property-based tests for IdRemapper.
 *
 * Fresh `IdRemapper` per property body, so no state bleeds across runs. Each
 * property explicitly sets `numRuns: 100`.
 */
import * as fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import { IdRemapper } from './IdRemapper';

/** Salesforce-shaped record Id: 15 or 18 alphanumeric characters. */
const sfIdArb = fc.oneof(
  fc.stringMatching(/^[a-zA-Z0-9]{15}$/),
  fc.stringMatching(/^[a-zA-Z0-9]{18}$/),
);

/** Source -> target pairs with distinct source Ids. */
const mappingArb = fc.uniqueArray(fc.tuple(sfIdArb, sfIdArb), {
  selector: ([source]) => source,
  maxLength: 50,
});

describe('IdRemapper — property-based', () => {
  it('every mapped source Id resolves to its target, and count equals the mappings', () => {
    fc.assert(
      fc.property(mappingArb, (pairs) => {
        const remapper = new IdRemapper();
        for (const [source, target] of pairs) remapper.add(source, target);

        for (const [source, target] of pairs) {
          expect(remapper.get(source)).toBe(target);
        }
        expect(remapper.count).toBe(pairs.length);
      }),
      { numRuns: 100 },
    );
  });

  it('remapRecord rewrites mapped lookups only and never mutates its input', () => {
    fc.assert(
      fc.property(
        mappingArb,
        fc.dictionary(fc.stringMatching(/^[A-Z][A-Za-z0-9_]{0,20}$/), sfIdArb, { maxKeys: 10 }),
        (pairs, record) => {
          const remapper = new IdRemapper();
          for (const [source, target] of pairs) remapper.add(source, target);
          const lookups = Object.keys(record);
          const snapshot = { ...record };

          const out = remapper.remapRecord(record, lookups);

          expect(record).toEqual(snapshot);
          for (const field of lookups) {
            const mapped = remapper.get(snapshot[field]);
            expect(out[field]).toBe(mapped ?? snapshot[field]);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('toJSON then fromJSON restores exactly the same mappings', () => {
    fc.assert(
      fc.property(mappingArb, (pairs) => {
        const remapper = new IdRemapper();
        for (const [source, target] of pairs) remapper.add(source, target);

        const restored = IdRemapper.fromJSON(remapper.toJSON());

        expect(restored.count).toBe(remapper.count);
        expect(restored.toJSON()).toEqual(remapper.toJSON());
      }),
      { numRuns: 100 },
    );
  });

  it('every row of the table was created, found in the target, or written over — only one of them', () => {
    /** How a row was registered: created, found (with its object or without), or written over. */
    const registrationArb = fc.array(
      fc.tuple(
        fc.constantFrom('created', 'linked', 'found', 'updated'),
        sfIdArb,
        sfIdArb,
        fc.constantFrom('Account', 'Contact', 'Case'),
      ),
      { maxLength: 60 },
    );
    fc.assert(
      fc.property(registrationArb, (registrations) => {
        const remapper = new IdRemapper();
        for (const [kind, source, target, object] of registrations) {
          if (kind === 'created') remapper.add(source, target, object);
          else if (kind === 'linked') remapper.addExisting(source, target, object);
          else if (kind === 'found') remapper.addExisting(source, target);
          else remapper.addUpdated(source, target, object);
        }

        const existing = new Set(remapper.existingSourceIds());
        const updated = new Set(remapper.updatedSourceIds());
        const created = remapper.createdByObject().flatMap((o) => o.sourceIds);
        const rows = Object.keys(remapper.toJSON());
        expect([...existing].filter((id) => updated.has(id))).toEqual([]);
        expect(rows.filter((id) => !existing.has(id) && !updated.has(id)).sort()).toEqual(
          [...created].sort(),
        );
      }),
      { numRuns: 100 },
    );
  });

  it('a later mapping for the same source Id wins', () => {
    fc.assert(
      fc.property(sfIdArb, sfIdArb, sfIdArb, (source, first, second) => {
        const remapper = new IdRemapper();
        remapper.add(source, first);
        remapper.add(source, second);

        expect(remapper.get(source)).toBe(second);
        expect(remapper.count).toBe(1);
      }),
      { numRuns: 100 },
    );
  });
});
