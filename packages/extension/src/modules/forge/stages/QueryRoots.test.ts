import { describe, expect, it } from 'vitest';
import { FORGE_ROOTS_MAX, FORGE_ROOTS_READ_TOTAL } from '@sandforge/shared';
import type { RootPlan } from '../roots/rootPlanStore.js';
import {
  ROOTS_READING_FALLBACK,
  noRootsStop,
  rootPlanRefusal,
  rootsCapOf,
  rootsExceededStop,
  rootsQueryIssue,
  rootsQueryOf,
  rootsQueryWithLimit,
  rootsReadBoundStop,
  rootsReadTotalOf,
  rootsReadingBound,
  rootsReadingStop,
  rootsSha256,
  rootsStatement,
  rootsStorageStop,
  rootsThatFit,
  sameRootsQuery,
  sortedRootIds,
} from './QueryRoots.js';

const id = (n: number, prefix = '001'): string => `${prefix}S${String(n).padStart(11, '0')}AAA`;

describe('the statement that reads the roots', () => {
  it('reads their ids under the WHERE and the object’s filter, by Id when no order is given, one past the most it takes', () => {
    expect(rootsStatement('Account', { where: "Industry = 'Energy'" }, "Name != 'X'", 200)).toBe(
      "SELECT Id FROM Account WHERE (Industry = 'Energy') AND (Name != 'X') ORDER BY Id LIMIT 201",
    );
    expect(rootsStatement('Account', {}, undefined, 200)).toBe(
      'SELECT Id FROM Account ORDER BY Id LIMIT 201',
    );
  });

  it('keeps the query’s order and LIMIT when the run takes that many, and reads one past the most otherwise', () => {
    expect(rootsStatement('Case', { orderBy: 'CreatedDate DESC', limit: 50 }, undefined, 200)).toBe(
      'SELECT Id FROM Case ORDER BY CreatedDate DESC LIMIT 50',
    );
    expect(rootsStatement('Case', { limit: 500 }, undefined, 200)).toBe(
      'SELECT Id FROM Case ORDER BY Id LIMIT 201',
    );
  });

  it('refuses an object name that is none before it builds anything', () => {
    expect(() => rootsStatement('Account; DELETE', {}, undefined, 1)).toThrow(/Invalid Salesforce/);
  });
});

describe('a query as the roots are read from it', () => {
  it('takes its WHERE, ORDER BY and LIMIT, the aliases written out', () => {
    expect(
      rootsQueryOf(
        "SELECT a.Id FROM Account a WHERE a.Industry = 'Energy' ORDER BY a.CreatedDate DESC LIMIT 50",
      ),
    ).toEqual({
      objectApiName: 'Account',
      query: { where: "Industry = 'Energy'", orderBy: 'CreatedDate DESC', limit: 50 },
    });
  });

  it('says why a query cannot choose them', () => {
    expect(rootsQueryOf('SELECT COUNT() FROM Account')).toEqual({
      issue: { kind: 'refused', clause: 'aggregate' },
    });
    expect(rootsQueryOf('SELECT Id FROM Account LIMIT 2001')).toEqual({ issue: { kind: 'limit' } });
  });

  it('holds parts given another way to the same rules', () => {
    expect(rootsQueryIssue({ where: 'Name = 1 -- x' })).toEqual({ kind: 'where' });
    expect(rootsQueryIssue({ orderBy: 'Name; DELETE' })).toEqual({ kind: 'orderBy' });
    expect(rootsQueryIssue({ limit: 0 })).toEqual({ kind: 'limit' });
    expect(rootsQueryIssue({ limit: FORGE_ROOTS_MAX + 1 })).toEqual({ kind: 'limit' });
    expect(rootsQueryIssue({ where: "Name = 'A'", orderBy: 'Name', limit: 5 })).toBeUndefined();
  });

  it('compares two queries whatever their spaces, an absent order reading as Id', () => {
    expect(sameRootsQuery({ where: "Name  =  'A'" }, { where: "Name = 'A'", orderBy: 'Id' })).toBe(
      true,
    );
    expect(sameRootsQuery({ where: "Name = 'A'" }, { where: "Name = 'B'" })).toBe(false);
    expect(sameRootsQuery({ limit: 5 }, {})).toBe(false);
  });
});

describe('the bounds of a run from roots', () => {
  it('holds the cap to 1 … the most of all', () => {
    expect(rootsCapOf(undefined, 200)).toBe(200);
    expect(rootsCapOf(0, 200)).toBe(1);
    expect(rootsCapOf(5_000, 200)).toBe(FORGE_ROOTS_MAX);
    expect(rootsCapOf(37.9, 200)).toBe(37);
  });

  it('reads a tenth of what the source has left, or 2 000 when it would not say', () => {
    expect(rootsReadingBound(30)).toBe(3);
    expect(rootsReadingBound(5)).toBe(1);
    expect(rootsReadingBound(undefined)).toBe(ROOTS_READING_FALLBACK);
  });

  it('holds 50 000 records unless told fewer', () => {
    expect(rootsReadTotalOf(undefined)).toBe(FORGE_ROOTS_READ_TOTAL);
    expect(rootsReadTotalOf(300)).toBe(300);
    expect(rootsReadTotalOf(0)).toBe(FORGE_ROOTS_READ_TOTAL);
  });
});

describe('the ids of the roots', () => {
  it('keeps each record once, whatever the length of its id, sorted, and takes the SHA-256 of that', () => {
    expect(sortedRootIds([id(2), id(1), id(2).slice(0, 15)])).toEqual([id(1), id(2)]);
    expect(rootsSha256([id(2), id(1)])).toBe(rootsSha256([id(1), id(2), id(1)]));
    expect(rootsSha256([id(1)])).not.toBe(rootsSha256([id(2)]));
  });
});

describe('a plan of roots given to a run', () => {
  const plan: RootPlan = {
    version: 1,
    sourceOrgId: 'src',
    fingerprint: '',
    objectApiName: 'Account',
    query: { where: "Industry = 'Energy'" },
    from: 'query',
    readAt: '2026-11-14T10:00:00.000Z',
    ids: [id(1), id(2)],
    sha256: rootsSha256([id(1), id(2)]),
  };
  const ours = {
    sourceOrgId: 'src',
    objectApiName: 'Account',
    query: { where: "Industry = 'Energy'" },
  };

  it('is the run’s when read of its source, of its object, by its query', () => {
    expect(rootPlanRefusal(plan, ours)).toBeUndefined();
  });

  it('is refused read of another org, by another query or of other ids, or changed since', () => {
    expect(rootPlanRefusal(plan, { ...ours, sourceOrgId: 'other' })).toBe('otherOrg');
    expect(rootPlanRefusal(plan, { ...ours, objectApiName: 'Contact' })).toBe('otherQuery');
    expect(rootPlanRefusal(plan, { ...ours, query: { where: "Industry = 'Retail'" } })).toBe(
      'otherQuery',
    );
    expect(
      rootPlanRefusal(
        { ...plan, from: 'records', query: undefined },
        {
          sourceOrgId: 'src',
          objectApiName: 'Account',
          ids: [id(3)],
        },
      ),
    ).toBe('otherQuery');
    expect(rootPlanRefusal({ ...plan, ids: [id(1)] }, ours)).toBe('changed');
  });
});

describe('fewer roots, as a refusal of a run’s volume offers them', () => {
  it('counts the roots that fit at what each takes on average, fewer than all of them', () => {
    // 41 accounts, 1 241 records, against --max-total 100.
    expect(rootsThatFit(41, 1_241, 100)).toBe(3);
    // 41 accounts taking 4.77 MB, against 4 MB left.
    expect(rootsThatFit(41, 4.77, 4)).toBe(34);
    // Room for every one of them is no refusal: one fewer at most.
    expect(rootsThatFit(10, 50, 1_000)).toBe(9);
  });

  it('counts none when one root alone takes more than the room, or nothing is weighed', () => {
    expect(rootsThatFit(2, 102, 20)).toBe(0);
    expect(rootsThatFit(0, 10, 10)).toBe(0);
    expect(rootsThatFit(5, 0, 10)).toBe(0);
    expect(rootsThatFit(5, 10, 0)).toBe(0);
    expect(rootsThatFit(5, Number.NaN, 10)).toBe(0);
  });

  it('writes out the query that takes that many: its WHERE, its own order or the newest first, to the LIMIT', () => {
    expect(rootsQueryWithLimit('Account', {}, 3)).toBe(
      'SELECT Id FROM Account ORDER BY CreatedDate DESC, Id DESC LIMIT 3',
    );
    expect(
      rootsQueryWithLimit(
        'Account',
        { where: "Industry = 'Energy'", orderBy: 'Name ASC', limit: 50 },
        12,
      ),
    ).toBe("SELECT Id FROM Account WHERE Industry = 'Energy' ORDER BY Name ASC LIMIT 12");
    expect(() => rootsQueryWithLimit('Account; DELETE', {}, 1)).toThrow(/Invalid Salesforce/);
  });
});

describe('the refusal of a clone from records for the storage its records take', () => {
  const exceeds = {
    verdict: 'exceeds' as const,
    estimateMB: 4.77,
    maxMB: 5,
    remainingMB: 4,
    automationMB: 2.35,
  };

  it('names how many of its roots fit and the LIMIT that takes them, never fewer records per object', () => {
    const stop = rootsStorageStop(exceeds, 'TGT', { objectApiName: 'Account', count: 41 });
    expect(stop).toMatchObject({
      code: 'STORAGE_EXCEEDED',
      storage: { estimateMB: 4.77, remainingMB: 4 },
      roots: { objectApiName: 'Account', fits: 34 },
    });
    expect(stop?.message).toContain(
      "about 2.35 MB of it for what the target's automation creates under them, and TGT has 4 " +
        'MB left of 5 MB: about 34 of the 41 Account records the query chooses fit',
    );
    expect(stop?.message).toContain('a LIMIT of 34 in the query');
    expect(stop?.message).toContain('ORDER BY CreatedDate DESC, Id DESC');
    expect(stop?.message).not.toContain('records per object');
  });

  it('names no LIMIT when one of its roots alone takes more, and nothing when the records fit', () => {
    const one = rootsStorageStop({ ...exceeds, estimateMB: 9 }, 'TGT', {
      objectApiName: 'Account',
      count: 2,
    });
    expect(one?.roots).toEqual({ objectApiName: 'Account' });
    expect(one?.message).toContain('takes more than that by itself');
    expect(one?.message).not.toContain('LIMIT');
    expect(
      rootsStorageStop({ ...exceeds, verdict: 'near' }, 'TGT', {
        objectApiName: 'Account',
        count: 41,
      }),
    ).toBeUndefined();
  });
});

describe('the refusals of a run from roots', () => {
  it('give the ways through a query that chooses too many, in words a terminal runs', () => {
    const stop = rootsExceededStop('Account', 200, 'query');
    expect(stop).toMatchObject({
      code: 'ROOTS_EXCEEDED',
      roots: { objectApiName: 'Account', cap: 200 },
    });
    // By their creation date and then by their ids: records loaded in the
    // same second came back by the date alone in an order that changed with
    // the WHERE.
    expect(stop.message).toContain('ORDER BY CreatedDate DESC, Id DESC LIMIT 200');
    expect(stop.message).toContain('--max-roots');
    expect(stop.message).toContain('2,000');
  });

  it('give a query that orders its records the LIMIT alone, and one past the most its LIMIT lowered', () => {
    // Run for real, a query that read ORDER BY CreatedDate DESC, Id DESC
    // was told to add ORDER BY CreatedDate DESC, Id DESC LIMIT 10.
    const ordered = rootsExceededStop('Account', 10, 'query', {
      orderBy: 'CreatedDate DESC, Id DESC',
    });
    expect(ordered.message).toContain('Give the query LIMIT 10 to clone the first 10 of its order');
    expect(ordered.message).not.toContain('ORDER BY');
    expect(ordered.roots).toEqual({ objectApiName: 'Account', cap: 10, ordered: true });

    const limited = rootsExceededStop('Account', 10, 'query', { limit: 500 });
    expect(limited.message).toContain(
      'Give the query ORDER BY CreatedDate DESC, Id DESC LIMIT 10 in place of its LIMIT 500',
    );
    expect(limited.roots).toEqual({ objectApiName: 'Account', cap: 10 });
  });

  it('give the count to run when a query chooses none', () => {
    expect(noRootsStop('Case', { where: "Status = 'New'" }, 200).message).toContain(
      `sf data query -q "SELECT COUNT() FROM Case WHERE Status = 'New'"`,
    );
  });

  it('name the objects read when the records pass the bound, the last one last', () => {
    const stop = rootsReadBoundStop(37, 100, [
      { objectApiName: 'Account', rows: 37 },
      { objectApiName: 'Case', rows: 80 },
    ]);
    expect(stop.readBound).toEqual({
      bound: 100,
      of: 'roots',
      objects: [
        { objectApiName: 'Account', rows: 37 },
        { objectApiName: 'Case', rows: 80 },
      ],
    });
    expect(stop.message).toContain('Case came to 80 after 2 objects');
  });

  it('say the requests sent and those to come when the read passes the source’s share', () => {
    const stop = rootsReadingStop({
      roots: 3,
      bound: 3,
      sent: 2,
      next: 2,
      objectApiName: 'Case',
      sourceRequestsLeft: 30,
    });
    expect(stop.api).toEqual({
      kind: 'requests',
      org: 'source',
      estimate: 4,
      remaining: 30,
      reading: { bound: 3 },
    });
    expect(
      rootsReadingStop({
        roots: 3,
        bound: 2_000,
        sent: 2_000,
        next: 1,
        objectApiName: 'Case',
        sourceRequestsLeft: undefined,
      }).message,
    ).toContain('the source would not say what it has left today');
  });
});
