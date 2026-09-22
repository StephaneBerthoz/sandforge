/**
 * Property-based tests for DiffEngine.
 *
 * Fresh `DiffEngine` per property body, so no state bleeds across runs. Each
 * property explicitly sets `numRuns: 100`.
 */
import * as fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import { DiffEngine } from './DiffEngine';
import { componentMapArb, metadataComponentTypeArb } from '../../test/arbitraries';

describe('DiffEngine — property-based', () => {
  it('identity: diff(m, m, type) produces only unchanged items', () => {
    fc.assert(
      fc.property(componentMapArb, metadataComponentTypeArb, (m, type) => {
        const engine = new DiffEngine();
        const snapshot = new Map(m);
        const result = engine.diff(m, m, type);

        // Every item is unchanged.
        for (const item of result) {
          expect(item.status).toBe('unchanged');
        }
        // diff does not mutate its inputs (identity invariant on m).
        expect([...m.entries()]).toEqual([...snapshot.entries()]);
        // And result length equals the map size.
        expect(result.length).toBe(m.size);
      }),
      { numRuns: 100 },
    );
  });

  it('count invariant: result length equals union of source + target keys', () => {
    fc.assert(
      fc.property(
        componentMapArb,
        componentMapArb,
        metadataComponentTypeArb,
        (source, target, type) => {
          const engine = new DiffEngine();
          const result = engine.diff(source, target, type);
          const unionKeys = new Set([...source.keys(), ...target.keys()]);
          expect(result.length).toBe(unionKeys.size);
          // Every result key must be in the union.
          const resultKeys = new Set(result.map((i) => i.fullName));
          expect(resultKeys).toEqual(unionKeys);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('commutativity up to swap: diff(a,b) vs diff(b,a) mirror added <-> removed', () => {
    fc.assert(
      fc.property(componentMapArb, componentMapArb, metadataComponentTypeArb, (a, b, type) => {
        const engine = new DiffEngine();
        const forward = engine.diff(a, b, type);
        const backward = engine.diff(b, a, type);

        const flip = (s: string): string =>
          s === 'added' ? 'removed' : s === 'removed' ? 'added' : s;

        const pairs = (items: typeof forward): string[] =>
          items.map((i) => `${i.fullName}::${i.status}`).sort((x, y) => x.localeCompare(y));

        const flippedBackward = pairs(
          backward.map((i) => ({ ...i, status: flip(i.status) as typeof i.status })),
        );
        expect(pairs(forward)).toEqual(flippedBackward);
      }),
      { numRuns: 100 },
    );
  });

  it('not read: a key both hold that was not read is not_compared, never modified nor unchanged', () => {
    fc.assert(
      fc.property(componentMapArb, componentMapArb, metadataComponentTypeArb, (a, b, type) => {
        const engine = new DiffEngine();
        const inBoth = [...a.keys()].filter((key) => b.has(key));
        const notRead = new Map(inBoth.map((key) => [key, 'over_budget' as const]));
        for (const item of engine.diff(a, b, type, notRead)) {
          expect(item.status).not.toBe('modified');
          expect(item.status).not.toBe('unchanged');
          if (notRead.has(item.fullName)) expect(item.status).toBe('not_compared');
        }
      }),
      { numRuns: 100 },
    );
  });

  it('disjoint keys: source-only keys are removed, target-only keys are added', () => {
    fc.assert(
      fc.property(componentMapArb, componentMapArb, metadataComponentTypeArb, (a, b, type) => {
        const engine = new DiffEngine();
        const result = engine.diff(a, b, type);
        for (const item of result) {
          const inSource = a.has(item.fullName);
          const inTarget = b.has(item.fullName);
          if (inSource && !inTarget) {
            expect(item.status).toBe('removed');
          } else if (!inSource && inTarget) {
            expect(item.status).toBe('added');
          } else if (inSource && inTarget) {
            const sourceVal = a.get(item.fullName);
            const targetVal = b.get(item.fullName);
            expect(item.status).toBe(sourceVal === targetVal ? 'unchanged' : 'modified');
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
