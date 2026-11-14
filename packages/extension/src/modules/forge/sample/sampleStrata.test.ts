import { describe, expect, it } from 'vitest';
import { RootDraw, rankOf } from './sampleRank';
import {
  STRATA_VALUES_LISTED,
  StratifiedRoots,
  strataTakesOf,
  stratumKeyOf,
  stratumRankOf,
  type StratifiedRootsInput,
} from './sampleStrata';

/** An account id numbered `n`. */
const account = (n: number) => `001${String(n).padStart(12, '0')}AAA`;

/** How many of a stratum of `roots` are ranked `share` at most. */
function keptAt(share: number, roots: number): number {
  let kept = 0;
  for (let i = 0; i < roots; i++) if (stratumRankOf(i, roots) <= share) kept++;
  return kept;
}

/** A stratified draw of Account by `Kind`, a picklist. */
function stratified(
  strata: StratifiedRootsInput['strata'],
  extra: Partial<StratifiedRootsInput> = {},
): StratifiedRoots {
  return new StratifiedRoots({
    objectApiName: 'Account',
    field: 'Kind',
    strata,
    draw: 'uniform',
    seed: 1,
    floor: 1,
    ...extra,
  });
}

describe('stratumRankOf', () => {
  it('ranks the root at place i of a stratum of N at (i + ½)/N', () => {
    expect(stratumRankOf(0, 4)).toBe(0.125);
    expect(stratumRankOf(3, 4)).toBe(0.875);
    expect(stratumRankOf(0, 1)).toBe(0.5);
  });

  it('keeps of each stratum, at a share p, exactly round(p·N) of its roots', () => {
    for (const roots of [1, 2, 3, 7, 10, 41, 300, 1_650]) {
      for (const share of [0.001, 0.05, 0.137, 0.25, 0.41, 0.5, 0.73, 0.999]) {
        expect(keptAt(share, roots)).toBe(Math.round(share * roots));
      }
    }
  });

  it('ranks no root of a stratum at 0, so that a draw with no floor lets a rare one wait its share', () => {
    expect(stratumRankOf(0, 1)).toBeGreaterThan(0);
    expect(stratumRankOf(0, 1_000_000)).toBeGreaterThan(0);
  });

  it('keeps a rank below 1 when the stratum holds more roots than were counted', () => {
    expect(stratumRankOf(12, 10)).toBeLessThan(1);
  });
});

describe('strataTakesOf', () => {
  it('reads of a stratum of N among ΣN in S strata min(N, ⌈(most + S)·N/ΣN⌉ + 1 + floor)', () => {
    expect(strataTakesOf([900, 100], 50, 1)).toEqual([Math.ceil((52 * 900) / 1000) + 2, 8]);
    expect(strataTakesOf([3, 1_000_000], 400, 0)).toEqual([
      2,
      Math.ceil((402 * 1e6) / 1_000_003) + 1,
    ]);
  });

  it('never reads more of a stratum than it holds, nor any of one counted empty', () => {
    expect(strataTakesOf([2, 5, 0], 1_000, 3)).toEqual([2, 5, 0]);
  });

  it('reads all the budget keeps of the largest stratum when the small ones are too rare to enter at the share it reaches', () => {
    // At the share 18 roots reach, each stratum of one root, ranked ½,
    // keeps none: the 18 come of the 37, past their part of 18·37/42.
    const roots = [37, 1, 1, 1, 1, 1];
    const draw = new RootDraw(18, 0);
    roots.forEach((count, stratum) => {
      for (let i = 0; i < count; i++) {
        draw.offer('Account', account(stratum * 100 + i), stratumRankOf(i, count), `=${stratum}`);
      }
    });
    const ofTheLargest = draw.drawn().filter((root) => root.id < account(100)).length;
    expect(ofTheLargest).toBe(18);
    expect(strataTakesOf(roots, 18, 0)[0]).toBeGreaterThanOrEqual(18);
  });
});

describe('stratumKeyOf', () => {
  it('tells a checkbox from a text of the same words, and none from both', () => {
    expect(stratumKeyOf(true)).not.toBe(stratumKeyOf('true'));
    expect(stratumKeyOf(false)).not.toBe(stratumKeyOf(true));
    expect(stratumKeyOf(null)).not.toBe(stratumKeyOf('none'));
    expect(stratumKeyOf('Hot')).toBe(stratumKeyOf('Hot'));
  });
});

describe('StratifiedRoots, spread over the org', () => {
  const ids = Array.from({ length: 40 }, (_, n) => account(n));
  const kindOf = (n: number) => (n % 4 === 0 ? 'Small' : 'Large');

  it('keeps of each stratum its smallest by rank then id, ranked over the roots scanned, whatever order they come in', () => {
    const forward = stratified([
      { value: 'Small', roots: 10, take: 4 },
      { value: 'Large', roots: 30, take: 6 },
    ]);
    ids.forEach((id, n) => forward.scanned(id, kindOf(n)));
    const backward = stratified([
      { value: 'Large', roots: 30, take: 6 },
      { value: 'Small', roots: 10, take: 4 },
    ]);
    [...ids].reverse().forEach((id) => backward.scanned(id, kindOf(ids.indexOf(id))));
    const sorted = (s: StratifiedRoots) =>
      s.ranked().sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : 1));
    expect(sorted(backward)).toEqual(sorted(forward));

    const small = ids
      .filter((_, n) => kindOf(n) === 'Small')
      .sort((a, b) => rankOf(1, a) - rankOf(1, b))
      .slice(0, 4);
    expect(
      forward
        .ranked()
        .filter((root) => root.stratum === '=Small')
        .map((root) => [root.id, root.rank]),
    ).toEqual(small.map((id, i) => [id, (i + 0.5) / 10]));
  });

  it('says the rank of the first root a stratum left past its heap, and none once every root fits', () => {
    const cut = stratified([
      { value: 'Small', roots: 10, take: 4 },
      { value: 'Large', roots: 30, take: 30 },
    ]);
    ids.forEach((id, n) => cut.scanned(id, kindOf(n)));
    expect(cut.firstUnread).toBe(stratumRankOf(4, 10));

    const whole = stratified([
      { value: 'Small', roots: 10, take: 10 },
      { value: 'Large', roots: 30, take: 30 },
    ]);
    ids.forEach((id, n) => whole.scanned(id, kindOf(n)));
    expect(whole.firstUnread).toBe(Infinity);
  });

  it('ranks over the roots scanned, not those counted, and reads a value the count did not give as a stratum of one', () => {
    const roots = stratified([{ value: 'Large', roots: 2, take: 3 }], { floor: 0 });
    roots.scanned(account(1), 'Large');
    roots.scanned(account(2), 'Large');
    roots.scanned(account(3), 'Large');
    for (let n = 4; n < 8; n++) roots.scanned(account(n), 'New');
    const large = roots.ranked().filter((root) => root.stratum === '=Large');
    expect(large.map((root) => root.rank)).toEqual([0.5 / 3, 1.5 / 3, 2.5 / 3]);
    expect(roots.ranked().filter((root) => root.stratum === '=New')).toHaveLength(2);
    expect(roots.firstUnread).toBe(stratumRankOf(2, 4));
  });
});

describe('StratifiedRoots, by date', () => {
  it('ranks the roots of each value in the order they were read, over the roots counted', () => {
    const roots = stratified(
      [
        { value: 'Business', roots: 40, take: 3 },
        { value: null, roots: 1, take: 1 },
      ],
      { draw: 'oldest' },
    );
    expect(roots.reads()).toEqual([
      { value: 'Business', key: '=Business', roots: 40, take: 3 },
      { value: null, key: 'none', roots: 1, take: 1 },
    ]);
    roots.read('Business', [account(9), account(2)]);
    roots.read('Business', [account(5)]);
    roots.read(null, [account(7)]);
    expect(roots.ranked()).toEqual([
      { id: account(9), rank: 0.5 / 40, stratum: '=Business' },
      { id: account(2), rank: 1.5 / 40, stratum: '=Business' },
      { id: account(5), rank: 2.5 / 40, stratum: '=Business' },
      { id: account(7), rank: 0.5, stratum: 'none' },
    ]);
    // Business stopped at its take, short of its forty.
    expect(roots.firstUnread).toBe(stratumRankOf(3, 40));
  });

  it('says no root unread of a stratum whose read gave fewer than it asked, or every root counted', () => {
    const roots = stratified(
      [
        { value: 'Business', roots: 40, take: 3 },
        { value: 'Person', roots: 2, take: 2 },
      ],
      { draw: 'recent' },
    );
    roots.read('Business', [account(1), account(2)]);
    roots.read('Person', [account(3), account(4)]);
    expect(roots.firstUnread).toBe(Infinity);
  });

  it('refuses a value the count did not give: nothing reads it', () => {
    const roots = stratified([{ value: 'Business', roots: 4, take: 4 }], { draw: 'recent' });
    expect(() => roots.read('Other', [account(1)])).toThrow('was not counted with that value');
  });
});

describe('StratifiedRoots through a draw', () => {
  it('keeps of each stratum round(p·N) roots at a share p, and with a floor of one at least one', () => {
    const sizes = [1, 3, 9, 27, 200];
    const draw = new RootDraw(1_000, 1);
    sizes.forEach((size, stratum) => {
      for (let i = 0; i < size; i++) {
        draw.offer('Account', account(stratum * 1_000 + i), stratumRankOf(i, size), `=${stratum}`);
      }
    });
    const drawn = draw.drawn();
    for (const share of [0.01, 0.1, 0.3, 0.6]) {
      sizes.forEach((size, stratum) => {
        const kept = drawn.filter(
          (root) =>
            root.rank <= share &&
            root.id >= account(stratum * 1_000) &&
            root.id < account((stratum + 1) * 1_000),
        ).length;
        expect(kept).toBe(Math.max(1, Math.round(share * size)));
      });
    }
  });

  it('keeps of a stratum of 3 among a million at least one with a floor of one, and round(p·3) with none', () => {
    for (const floor of [1, 0]) {
      const counts = [
        { value: 'Rare', roots: 3 },
        { value: 'Common', roots: 1_000_000 },
      ];
      const most = 400;
      const takes = strataTakesOf(
        counts.map((count) => count.roots),
        most,
        floor,
      );
      const roots = stratified(
        counts.map((count, index) => ({ ...count, take: takes[index] })),
        { draw: 'recent', floor },
      );
      roots.read('Rare', [account(1), account(2), account(3)].slice(0, takes[0]));
      roots.read(
        'Common',
        Array.from({ length: takes[1] }, (_, n) => account(1_000 + n)),
      );
      const draw = new RootDraw(most, floor);
      for (const root of roots.ranked()) draw.offer('Account', root.id, root.rank, root.stratum);
      const drawn = draw.drawn();
      const share = Math.max(...drawn.map((root) => root.rank));
      const rare = drawn.filter((root) => root.id <= account(3)).length;
      expect(rare).toBe(floor === 1 ? 1 : Math.round(share * 3));
      expect(rare).toBe(floor);
    }
  });

  it('enters none of two thousand strata of one root at rank 0 with no floor, and holds the draw to its budget', () => {
    const counts = Array.from({ length: 2_000 }, (_, n) => ({
      value: `005${String(n).padStart(12, '0')}`,
      roots: 1,
    }));
    const takes = strataTakesOf(
      counts.map((count) => count.roots),
      10,
      0,
    );
    const roots = new StratifiedRoots({
      objectApiName: 'Account',
      field: 'OwnerId',
      strata: counts.map((count, index) => ({ ...count, take: takes[index] })),
      draw: 'uniform',
      seed: 1,
      floor: 0,
    });
    counts.forEach((count, n) => roots.scanned(account(n), count.value));
    const none = new RootDraw(10, 0);
    for (const root of roots.ranked()) none.offer('Account', root.id, root.rank, root.stratum);
    expect(none.drawn().filter((root) => root.rank === 0)).toEqual([]);
    expect(none.drawn()).toHaveLength(10);

    const floored = new RootDraw(10, 1);
    for (const root of roots.ranked()) floored.offer('Account', root.id, root.rank, root.stratum);
    expect(floored.drawn().filter((root) => root.rank === 0)).toHaveLength(2_000);
  });
});

describe('StratifiedRoots.report', () => {
  it('says each value with its roots and those kept, the most roots first, a label where one is given', () => {
    const roots = stratified(
      [
        { value: '012000000000001AAA', roots: 2, take: 2 },
        { value: '012000000000002AAA', roots: 5, take: 2 },
        { value: null, roots: 1, take: 1 },
      ],
      { draw: 'recent', field: 'RecordTypeId' },
    );
    roots.read('012000000000001AAA', [account(1), account(2)]);
    roots.read('012000000000002AAA', [account(3), account(4)]);
    roots.read(null, [account(5)]);
    const kept = new Set([account(1), account(3), account(5)]);
    expect(
      roots.report(
        (id) => kept.has(id),
        (value) => (value === '012000000000001AAA' ? 'Business' : undefined),
      ),
    ).toEqual({
      objectApiName: 'Account',
      field: 'RecordTypeId',
      values: [
        { value: '012000000000002AAA', roots: 5, kept: 1 },
        { value: '012000000000001AAA', label: 'Business', roots: 2, kept: 1 },
        { value: null, roots: 1, kept: 1 },
      ],
    });
  });

  it('lists the fifty values of the most roots and counts the others', () => {
    const counts = Array.from({ length: 70 }, (_, n) => ({
      value: `Value${String(n).padStart(2, '0')}`,
      roots: n + 1,
      take: 1,
    }));
    const report = stratified(counts, { draw: 'recent' }).report(() => false);
    expect(report.values).toHaveLength(STRATA_VALUES_LISTED);
    expect(report.values[0]).toEqual({ value: 'Value69', roots: 70, kept: 0 });
    expect(report.values[STRATA_VALUES_LISTED - 1]).toEqual({
      value: 'Value20',
      roots: 21,
      kept: 0,
    });
    expect(report.more).toBe(20);
  });
});
