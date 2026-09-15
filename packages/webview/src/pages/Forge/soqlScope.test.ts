import { describe, it, expect } from 'vitest';

import {
  soqlFilterRefused,
  soqlObjectFilters,
  soqlRootFilter,
  SOQL_UNSCOPED_RECORD_CAP,
} from './forgeUtils';

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

  it('does not read USING SCOPE as an alias', () => {
    expect(soqlRootFilter("SELECT Id FROM Account USING SCOPE mine WHERE Name = 'x'")).toEqual({
      objectApiName: 'Account',
      where: "Name = 'x'",
    });
  });
});

describe('soqlFilterRefused', () => {
  const query = (where: string) => `SELECT Id FROM Account WHERE ${where}`;

  it('accepts a clause the run can apply, and a query with no clause', () => {
    expect(soqlFilterRefused(query("Industry = 'X'"))).toBe(false);
    expect(soqlFilterRefused(query(`Name = '${'x'.repeat(500)}'`))).toBe(false);
    expect(soqlFilterRefused('SELECT Id FROM Account')).toBe(false);
    expect(soqlFilterRefused('')).toBe(false);
  });

  it('refuses a clause the run would reject: too long, comment markers, trailing semicolon', () => {
    expect(soqlFilterRefused(query(`Name = '${'x'.repeat(510)}'`))).toBe(true);
    expect(soqlFilterRefused(query("Name LIKE '%--%'"))).toBe(true);
    expect(soqlFilterRefused(query("Name = 'x' /* note */"))).toBe(true);
    expect(soqlFilterRefused(query("Name = 'x';"))).toBe(true);
  });

  it('judges the clause alone, not the name of the object it filters', () => {
    expect(soqlFilterRefused('SELECT Id FROM 1Account WHERE Name = null')).toBe(false);
  });
});

describe('soqlObjectFilters', () => {
  it("puts the WHERE clause under the root object's name", () => {
    expect(soqlObjectFilters("SELECT Id FROM Account WHERE Industry = 'X' LIMIT 10")).toEqual({
      Account: "Industry = 'X'",
    });
  });

  it('is undefined when there is nothing to filter', () => {
    expect(soqlObjectFilters('SELECT Id FROM Account')).toBeUndefined();
    expect(soqlObjectFilters('not a query')).toBeUndefined();
  });
});

it('caps SOQL runs low enough to bound the whole-table reads of related objects', () => {
  expect(SOQL_UNSCOPED_RECORD_CAP).toBeGreaterThan(0);
  expect(SOQL_UNSCOPED_RECORD_CAP).toBeLessThanOrEqual(500);
});
