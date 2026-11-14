import { describe, expect, it } from 'vitest';

import { FORGE_ROOTS_MAX } from './forge-run-gate.js';
import {
  SOQL_ROOT_REFUSED_CLAUSES,
  isRecordScoped,
  soqlOrderBySchema,
  soqlRootFilter,
  soqlRootIssueWords,
  soqlRootQuery,
  soqlRootQueryIssue,
  soqlWhereFragmentSchema,
  type SoqlRootIssue,
} from './soqlRoot.js';

/**
 * SOQL mode filters the object after FROM with the query's WHERE clause, and
 * nothing else.
 *
 * The clause travels as that object's entry in `objectSoqlFilters`, which the
 * executor appends to the object's query. Related objects are not narrowed to
 * the records it matches: they are read from their whole tables, so the run
 * stays bounded by a per-object cap.
 */
describe('soqlRootFilter', () => {
  it('reads the object after FROM and the WHERE clause', () => {
    expect(soqlRootFilter("SELECT Id, Name FROM Account WHERE Industry = 'X'")).toEqual({
      objectApiName: 'Account',
      where: "Industry = 'X'",
    });
  });

  it('reads keywords regardless of casing', () => {
    expect(soqlRootFilter("select id from account where name = 'x'")).toEqual({
      objectApiName: 'account',
      where: "name = 'x'",
    });
  });

  it('has no filter for a query with no WHERE clause', () => {
    expect(soqlRootFilter('SELECT Id, Name FROM Account')).toEqual({
      objectApiName: 'Account',
      where: null,
    });
  });

  it('does not read a field or object merely containing the letters as WHERE', () => {
    expect(soqlRootFilter('SELECT Somewhere__c FROM Anywhere__c')).toEqual({
      objectApiName: 'Anywhere__c',
      where: null,
    });
  });

  it('ends the filter where the next clause starts', () => {
    const base = "SELECT Id FROM Account WHERE Industry = 'X' AND Rating = 'Hot'";
    for (const tail of [
      ' ORDER BY Name',
      ' LIMIT 10',
      ' OFFSET 5',
      ' GROUP BY Industry',
      ' WITH SECURITY_ENFORCED',
      ' FOR VIEW',
      ' UPDATE TRACKING',
    ]) {
      expect(soqlRootFilter(`${base}${tail}`)?.where).toBe("Industry = 'X' AND Rating = 'Hot'");
    }
  });

  it('skips the FROM and WHERE of a subquery in the select list', () => {
    expect(
      soqlRootFilter(
        "SELECT Id, (SELECT Id FROM Contacts WHERE Email != null) FROM Account WHERE Name LIKE 'A%'",
      ),
    ).toEqual({ objectApiName: 'Account', where: "Name LIKE 'A%'" });
  });

  it('keeps a semi-join and quoted keywords inside the filter', () => {
    const where =
      "Id IN (SELECT AccountId FROM Contact WHERE LastName = 'x') AND Name = 'it\\'s ORDER BY LIMIT'";
    expect(soqlRootFilter(`SELECT Id FROM Account WHERE ${where} LIMIT 5`)).toEqual({
      objectApiName: 'Account',
      where,
    });
  });

  it('gives nothing for a query with no FROM object', () => {
    expect(soqlRootFilter('SELECT Id')).toBeNull();
    expect(soqlRootFilter('')).toBeNull();
  });

  it('has no filter for an empty WHERE', () => {
    expect(soqlRootFilter('SELECT Id FROM Account WHERE LIMIT 5')?.where).toBeNull();
  });

  it("drops the object's alias from the filter, which is sent without one", () => {
    expect(
      soqlRootFilter("SELECT a.Name FROM Account a WHERE a.Industry = 'X' AND A.Owner.Name = 'Y'"),
    ).toEqual({ objectApiName: 'Account', where: "Industry = 'X' AND Owner.Name = 'Y'" });
  });

  it('leaves a quoted value, a nested field and a subquery untouched by the alias', () => {
    const query =
      "SELECT Id FROM Contact a WHERE Name = 'a.b' AND Owner.a.x = 1 AND Id IN (SELECT a.Id FROM Case)";
    expect(soqlRootFilter(query)?.where).toBe(
      "Name = 'a.b' AND Owner.a.x = 1 AND Id IN (SELECT a.Id FROM Case)",
    );
  });

  it('rewrites an alias declared over a relationship to the path it stands for', () => {
    expect(soqlRootFilter("SELECT Id FROM Contact c, c.Account a WHERE a.Name = 'X'")).toEqual({
      objectApiName: 'Contact',
      where: "Account.Name = 'X'",
    });
  });

  it('leaves a quoted value alone when it reads like a relationship alias path', () => {
    expect(
      soqlRootFilter("SELECT Id FROM Contact c, c.Account a WHERE c.Description = 'a.Name'")?.where,
    ).toBe("Description = 'a.Name'");
  });

  it('marks a relationship entry that no alias resolves', () => {
    const root = soqlRootFilter("SELECT Id FROM Contact c, x.Account a WHERE a.Name = 'X'");
    expect(root?.unresolvedAlias).toBe(true);
  });

  it('leaves the same entry unmarked when there is no clause to rewrite', () => {
    // No WHERE clause means no filter travels, so the aliases are read by
    // nothing: the query reads Contact and is accepted as it stands.
    expect(soqlRootFilter('SELECT Id FROM Contact c, x.Account a ORDER BY Name')).toEqual({
      objectApiName: 'Contact',
      where: null,
    });
  });

  it('does not read USING SCOPE as an alias', () => {
    expect(soqlRootFilter("SELECT Id FROM Account USING SCOPE mine WHERE Name = 'x'")).toEqual({
      objectApiName: 'Account',
      where: "Name = 'x'",
    });
  });
});

/**
 * A clone from the records a query chooses reads them by its own statement:
 * the query's WHERE, ORDER BY and LIMIT, and nothing else of it.
 */
describe('soqlRootQuery', () => {
  it('reads the ORDER BY and the LIMIT beside the WHERE, each without its keywords', () => {
    expect(
      soqlRootQuery(
        "SELECT Id, Name FROM Account WHERE Industry = 'Energy' ORDER BY CreatedDate DESC NULLS LAST, Id LIMIT 50",
      ),
    ).toEqual({
      objectApiName: 'Account',
      where: "Industry = 'Energy'",
      orderBy: 'CreatedDate DESC NULLS LAST, Id',
      limit: 50,
      refused: [],
    });
  });

  it('reads a query with none of them as choosing every record of its object', () => {
    expect(soqlRootQuery('SELECT Id FROM Contact')).toEqual({
      objectApiName: 'Contact',
      where: null,
      orderBy: null,
      limit: null,
      refused: [],
    });
  });

  it('writes the aliases of its FROM out of the ORDER BY, as of the WHERE', () => {
    // The roots' statement names the object without an alias: an alias left
    // in the ORDER BY would reach the org as a field the object does not have.
    expect(
      soqlRootQuery(
        "SELECT Id FROM Contact c, c.Account a WHERE a.Industry = 'X' ORDER BY a.Name, c.CreatedDate DESC",
      ),
    ).toMatchObject({ where: "Account.Industry = 'X'", orderBy: 'Account.Name, CreatedDate DESC' });
  });

  it('marks an alias nothing traces when the ORDER BY alone would carry it', () => {
    // soqlRootFilter leaves this one unmarked: it sends no WHERE. The roots'
    // statement sends the ORDER BY.
    expect(
      soqlRootQuery('SELECT Id FROM Contact c, x.Account a ORDER BY a.Name')?.unresolvedAlias,
    ).toBe(true);
    expect(soqlRootQuery('SELECT Id FROM Contact c, x.Account a')?.unresolvedAlias).toBeUndefined();
  });

  it('reads a LIMIT that is no whole number as such, never as none', () => {
    expect(soqlRootQuery('SELECT Id FROM Account LIMIT :howMany')?.limit).toBeNaN();
    expect(soqlRootQuery('SELECT Id FROM Account LIMIT')?.limit).toBeNaN();
    expect(soqlRootQuery('SELECT Id FROM Account LIMIT 0')?.limit).toBe(0);
  });

  it('names each clause that changes the rows it returns, in the order it gives them', () => {
    const cases: Array<[string, string[]]> = [
      ['SELECT Industry FROM Account GROUP BY Industry', ['GROUP BY']],
      [
        'SELECT Industry FROM Account GROUP BY Industry HAVING COUNT(Id) > 1',
        ['GROUP BY', 'HAVING'],
      ],
      ['SELECT Id FROM Account LIMIT 10 OFFSET 20', ['OFFSET']],
      ['SELECT Id FROM Account LIMIT 10 FOR UPDATE', ['FOR']],
      ['SELECT Id FROM Account FOR VIEW', ['FOR']],
      ['SELECT Id FROM Account WITH SECURITY_ENFORCED', ['WITH']],
      ["SELECT Id FROM Account USING SCOPE mine WHERE Name = 'x'", ['USING SCOPE']],
      ['SELECT Id FROM KnowledgeArticleVersion UPDATE VIEWSTAT', ['UPDATE']],
      ['SELECT COUNT() FROM Account', ['aggregate']],
      [
        'SELECT MAX(CreatedDate), Industry FROM Account GROUP BY Industry',
        ['aggregate', 'GROUP BY'],
      ],
    ];
    for (const [query, refused] of cases)
      expect(soqlRootQuery(query)?.refused, query).toEqual(refused);
  });

  it('reads no aggregate in a subquery, a field named like one, or a quoted word', () => {
    for (const query of [
      'SELECT Id, (SELECT COUNT() FROM Contacts) FROM Account',
      'SELECT Id, Max__c, Sum FROM Account',
      "SELECT Id FROM Account WHERE Name = 'COUNT(x) GROUP BY y'",
    ]) {
      expect(soqlRootQuery(query)?.refused, query).toEqual([]);
    }
  });
});

describe('soqlRootQueryIssue', () => {
  it('accepts a query that chooses records by its WHERE, ORDER BY and LIMIT, a semi-join among them', () => {
    expect(
      soqlRootQueryIssue(
        'SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Opportunity WHERE IsClosed = false) ORDER BY CreatedDate DESC LIMIT 200',
      ),
    ).toBeUndefined();
    expect(soqlRootQueryIssue('SELECT Id FROM Contact')).toBeUndefined();
    expect(soqlRootQueryIssue(`SELECT Id FROM Contact LIMIT ${FORGE_ROOTS_MAX}`)).toBeUndefined();
  });

  it('says what of the query is wrong, one issue at a time', () => {
    const cases: Array<[string, SoqlRootIssue]> = [
      ['SELECT Id', { kind: 'noObject' }],
      ['SELECT Id FROM 1Account', { kind: 'object', objectApiName: '1Account' }],
      ['SELECT Id FROM Account LIMIT 5 OFFSET 5', { kind: 'refused', clause: 'OFFSET' }],
      ["SELECT Id FROM Contact c, x.Account a WHERE a.Name = 'X'", { kind: 'alias' }],
      ["SELECT Id FROM Account WHERE Name LIKE '%--%'", { kind: 'where' }],
      [`SELECT Id FROM Account WHERE Name = '${'x'.repeat(510)}'`, { kind: 'where' }],
      ['SELECT Id FROM Account ORDER BY CALENDAR_YEAR(CreatedDate)', { kind: 'orderBy' }],
      ["SELECT Id FROM Account ORDER BY Name = 'x'", { kind: 'orderBy' }],
      ['SELECT Id FROM Account LIMIT 0', { kind: 'limit' }],
      [`SELECT Id FROM Account LIMIT ${FORGE_ROOTS_MAX + 1}`, { kind: 'limit' }],
      ['SELECT Id FROM Account LIMIT :n', { kind: 'limit' }],
    ];
    for (const [query, issue] of cases) expect(soqlRootQueryIssue(query), query).toEqual(issue);
  });

  it('gives each issue words that name the way out', () => {
    const issues: SoqlRootIssue[] = [
      { kind: 'noObject' },
      { kind: 'object', objectApiName: '1Account' },
      ...SOQL_ROOT_REFUSED_CLAUSES.map((clause) => ({ kind: 'refused' as const, clause })),
      { kind: 'alias' },
      { kind: 'where' },
      { kind: 'orderBy' },
      { kind: 'limit' },
    ];
    for (const issue of issues) {
      const words = soqlRootIssueWords(issue);
      expect(words, issue.kind).toMatch(/: /);
      expect(words.length, issue.kind).toBeGreaterThan(40);
    }
    expect(soqlRootIssueWords({ kind: 'refused', clause: 'OFFSET' })).toContain(
      'choose the records by WHERE, ORDER BY and LIMIT',
    );
    expect(soqlRootIssueWords({ kind: 'limit' })).toContain('from 1 to 2,000');
  });
});

describe('the rules a clone from a query holds its clauses to', () => {
  it('takes an ORDER BY of field paths, each with its direction and its nulls', () => {
    for (const orderBy of [
      'Id',
      'CreatedDate DESC',
      'Account.Owner.Name ASC NULLS FIRST, Id desc nulls last',
    ]) {
      expect(soqlOrderBySchema.safeParse(orderBy).success, orderBy).toBe(true);
    }
    for (const orderBy of [
      '',
      'Name; DELETE',
      'CreatedDate DESC LIMIT 5',
      "Name = 'x'",
      `Name, ${'x'.repeat(200)}`,
      'Id DESC NULLS',
    ]) {
      expect(soqlOrderBySchema.safeParse(orderBy).success, orderBy).toBe(false);
    }
  });

  it('takes a WHERE as an object filter is taken, and refuses what would end the statement', () => {
    expect(soqlWhereFragmentSchema.safeParse("Industry = 'Energy'").success).toBe(true);
    for (const where of ['', "Name = 'x';", 'Name = null --', 'Name /* x */ = null']) {
      expect(soqlWhereFragmentSchema.safeParse(where).success, where).toBe(false);
    }
  });
});

describe('isRecordScoped', () => {
  it('reads a clone of one record, and of the records a query chooses, as scoped', () => {
    expect(isRecordScoped({ inputMode: 'record', recordId: '001000000000001AAA' })).toBe(true);
    expect(
      isRecordScoped({
        inputMode: 'soql',
        soqlQuery: 'SELECT Id FROM Account',
        queryScope: 'records',
      }),
    ).toBe(true);
  });

  it('reads a query of tables, one from before the scope was said, and every other run as not', () => {
    // A run, a journal or a template from before 1.81.0 holds no scope, and
    // read whole tables: it is read so still.
    expect(isRecordScoped({ inputMode: 'soql', soqlQuery: 'SELECT Id FROM Account' })).toBe(false);
    expect(
      isRecordScoped({
        inputMode: 'soql',
        soqlQuery: 'SELECT Id FROM Account',
        queryScope: 'tables',
      }),
    ).toBe(false);
    expect(isRecordScoped({ inputMode: 'soql', queryScope: 'records' })).toBe(false);
    expect(isRecordScoped({ inputMode: 'record' })).toBe(false);
    expect(isRecordScoped({ inputMode: 'template' })).toBe(false);
    expect(isRecordScoped({ inputMode: 'org' })).toBe(false);
    expect(isRecordScoped(null)).toBe(false);
    expect(isRecordScoped(undefined)).toBe(false);
  });
});
