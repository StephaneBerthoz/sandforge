import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  RootDraw,
  compareIds,
  compareRoots,
  idKey,
  rankOf,
  recentRankOf,
  rootsTheBudgetHolds,
} from './sampleRank';

const ACCOUNT_A = '001000000000001AAA';
const ACCOUNT_B = '001000000000002AAA';

describe('rankOf', () => {
  it('reads the first 53 bits of SHA-256 of the seed and the fifteen characters, over 2^53', () => {
    const digest = createHash('sha256')
      .update(`7:${ACCOUNT_A.slice(0, 15)}`)
      .digest();
    const bits = (BigInt(digest.readUInt32BE(0)) << 21n) | BigInt(digest.readUInt32BE(4) >>> 11);
    expect(rankOf(7, ACCOUNT_A)).toBe(Number(bits) / 2 ** 53);
  });

  it('ranks the same record the same, read in fifteen characters or eighteen', () => {
    expect(rankOf(1, ACCOUNT_A)).toBe(rankOf(1, ACCOUNT_A.slice(0, 15)));
    expect(rankOf(1, ACCOUNT_A)).not.toBe(rankOf(1, ACCOUNT_B));
  });

  it('ranks the same id otherwise under another seed, and always within [0, 1)', () => {
    expect(rankOf(1, ACCOUNT_A)).not.toBe(rankOf(2, ACCOUNT_A));
    for (let n = 0; n < 500; n++) {
      const rank = rankOf(n % 7, `003${String(n).padStart(12, '0')}`);
      expect(rank).toBeGreaterThanOrEqual(0);
      expect(rank).toBeLessThan(1);
    }
  });

  it('spreads the ranks of a thousand ids over the interval, about a tenth in each tenth', () => {
    const tenths = new Array<number>(10).fill(0);
    for (let n = 0; n < 1000; n++)
      tenths[Math.floor(rankOf(1, `003${String(n).padStart(12, '0')}`) * 10)]++;
    for (const count of tenths) {
      expect(count).toBeGreaterThan(60);
      expect(count).toBeLessThan(140);
    }
  });
});

describe('compareIds and idKey', () => {
  it('orders ids by their fifteen characters, code unit by code unit, the case told apart', () => {
    expect(idKey('001000000000001AAA')).toBe('001000000000001');
    expect(compareIds('001000000000001AAA', '001000000000001')).toBe(0);
    expect(compareIds('00100000000000A', '00100000000000a')).toBeLessThan(0);
    expect(compareIds('00100000000000b', '00100000000000a')).toBeGreaterThan(0);
  });
});

describe('recentRankOf', () => {
  it('ranks the root a draw by recency reads first 0, and the others by their place over the roots counted', () => {
    expect(recentRankOf(0, 10)).toBe(0);
    expect(recentRankOf(5, 10)).toBe(0.5);
  });

  it('keeps a rank below 1 when the source holds more roots than were counted', () => {
    expect(recentRankOf(12, 10)).toBeLessThan(1);
  });
});

describe('rootsTheBudgetHolds', () => {
  it('holds a root per kilobyte of the budget, a root being a record of at least 1 KB', () => {
    expect(rootsTheBudgetHolds(10 * 1024)).toBe(10);
    expect(rootsTheBudgetHolds(10 * 1024 + 1023)).toBe(10);
  });

  it('holds no more roots than the records --max-total asks', () => {
    expect(rootsTheBudgetHolds(10 * 1024, 4)).toBe(4);
  });

  it('holds one root of a budget of nothing, so that its refusal can say what the smallest sample takes', () => {
    expect(rootsTheBudgetHolds(0)).toBe(1);
    expect(rootsTheBudgetHolds(-5)).toBe(1);
    expect(rootsTheBudgetHolds(512)).toBe(1);
  });
});

describe('RootDraw', () => {
  it('keeps the roots of smallest rank across every object, in rank, object then id order', () => {
    const draw = new RootDraw(3, 0);
    draw.offer('Contact', '003000000000001', 0.5);
    draw.offer('Account', '001000000000001', 0.2);
    draw.offer('Account', '001000000000002', 0.9);
    draw.offer('Case', '500000000000001', 0.2);
    draw.offer('Contact', '003000000000002', 0.1);
    expect(draw.drawn().map((r) => [r.objectApiName, r.rank])).toEqual([
      ['Contact', 0.1],
      ['Account', 0.2],
      ['Case', 0.2],
    ]);
    expect(draw.beyond).toBe(0.5);
  });

  it('keeps every root offered, and says none was let go, when the budget holds them all', () => {
    const draw = new RootDraw(10, 0);
    draw.offer('Account', ACCOUNT_A, 0.4);
    draw.offer('Account', ACCOUNT_B, 0.3);
    expect(draw.drawn()).toHaveLength(2);
    expect(draw.beyond).toBe(Infinity);
  });

  it('gives each object its floor at rank 0, the roots of smallest rank, even past the budget', () => {
    const draw = new RootDraw(1, 1);
    draw.offer('Account', ACCOUNT_A, 0.7);
    draw.offer('Account', ACCOUNT_B, 0.6);
    draw.offer('Lead', '00Q000000000001', 0.05);
    draw.offer('Case', '500000000000001', 0.9);
    const drawn = draw.drawn();
    expect(drawn).toEqual([
      { objectApiName: 'Account', id: ACCOUNT_B, rank: 0 },
      { objectApiName: 'Case', id: '500000000000001', rank: 0 },
      { objectApiName: 'Lead', id: '00Q000000000001', rank: 0 },
    ]);
  });

  it('keeps a root once when it is both in the budget and the floor of its object', () => {
    const draw = new RootDraw(5, 2);
    draw.offer('Account', ACCOUNT_A, 0.1);
    draw.offer('Account', ACCOUNT_B, 0.2);
    draw.offer('Account', '001000000000003', 0.3);
    expect(draw.drawn().map((r) => r.rank)).toEqual([0, 0, 0.3]);
  });

  it('draws the same roots whatever order they are offered in', () => {
    const offers: Array<[string, string, number]> = [];
    for (let n = 0; n < 200; n++) {
      offers.push([
        n % 3 === 0 ? 'Account' : 'Contact',
        `00${n % 3}${String(n).padStart(12, '0')}`,
        rankOf(3, String(n)),
      ]);
    }
    const forward = new RootDraw(40, 1);
    for (const [o, id, rank] of offers) forward.offer(o, id, rank);
    const backward = new RootDraw(40, 1);
    for (const [o, id, rank] of [...offers].reverse()) backward.offer(o, id, rank);
    expect(backward.drawn()).toEqual(forward.drawn());
    expect(backward.beyond).toBe(forward.beyond);
  });

  it('tells a draw by recency to read on while its floor is not filled or a root could still enter', () => {
    const draw = new RootDraw(2, 1);
    expect(draw.keeps('Account', 0.9)).toBe(true);
    draw.offer('Account', ACCOUNT_A, 0.1);
    draw.offer('Account', ACCOUNT_B, 0.2);
    expect(draw.keeps('Account', 0.3)).toBe(false);
    expect(draw.keeps('Account', 0.15)).toBe(true);
    expect(draw.keeps('Contact', 0.95)).toBe(true);
  });

  it('keeps only the floors when the budget holds no root, and says where it let roots go', () => {
    const draw = new RootDraw(0, 1);
    draw.offer('Account', ACCOUNT_A, 0.4);
    draw.offer('Account', ACCOUNT_B, 0.3);
    expect(draw.drawn()).toEqual([{ objectApiName: 'Account', id: ACCOUNT_B, rank: 0 }]);
    // The floor is kept: the root let go is the other one.
    expect(draw.beyond).toBe(0.4);
  });

  it('never counts as let go a root its object keeps as its floor, the first of a draw by recency at rank 0', () => {
    const draw = new RootDraw(1, 1);
    draw.offer('Account', ACCOUNT_A, 0);
    draw.offer('Contact', '003000000000001', 0);
    draw.offer('Contact', '003000000000002', 0.5);
    expect(draw.drawn().map((r) => r.id)).toEqual([ACCOUNT_A, '003000000000001']);
    expect(draw.beyond).toBe(0.5);
  });

  it('counts a root as let go once its object keeps a smaller one as its floor', () => {
    const draw = new RootDraw(0, 1);
    draw.offer('Account', ACCOUNT_A, 0.2);
    expect(draw.beyond).toBe(Infinity);
    draw.offer('Account', ACCOUNT_B, 0.1);
    expect(draw.beyond).toBe(0.2);
  });
});

describe('compareRoots', () => {
  it('orders roots by rank, then object, then id', () => {
    const roots = [
      { objectApiName: 'Contact', id: '003000000000001', rank: 0.2 },
      { objectApiName: 'Account', id: '001000000000002', rank: 0.2 },
      { objectApiName: 'Account', id: '001000000000001', rank: 0.2 },
      { objectApiName: 'Case', id: '500000000000001', rank: 0.1 },
    ];
    expect([...roots].sort(compareRoots).map((r) => r.id)).toEqual([
      '500000000000001',
      '001000000000001',
      '001000000000002',
      '003000000000001',
    ]);
  });
});
