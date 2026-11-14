import { describe, it, expect } from 'vitest';

import {
  soqlFilterRefused,
  soqlObjectFilters,
  soqlObjectNameRefused,
  SOQL_UNSCOPED_RECORD_CAP,
} from './forgeUtils';

/**
 * SOQL mode filters the object after FROM with the query's WHERE clause, and
 * nothing else.
 *
 * The clause travels as that object's entry in `objectSoqlFilters`, which the
 * executor appends to the object's query. Related objects are not narrowed to
 * the records it matches: they are read from their whole tables, so the run
 * stays bounded by a per-object cap. The query is read by the parser shared
 * with the extension and the command line, whose tests sit beside it
 * (`@sandforge/shared`, `utils/soqlRoot.test.ts`).
 */
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

  it('refuses a FROM clause whose relationship alias leads nowhere, and accepts one that resolves', () => {
    expect(soqlFilterRefused("SELECT Id FROM Contact c, x.Account a WHERE a.Name = 'X'")).toBe(
      true,
    );
    expect(soqlFilterRefused("SELECT Id FROM Contact c, c.Account a WHERE a.Name = 'X'")).toBe(
      false,
    );
  });

  it('accepts an alias that leads nowhere when the query carries no clause', () => {
    expect(soqlFilterRefused('SELECT Id FROM Contact c, x.Account a')).toBe(false);
  });
});

describe('soqlObjectNameRefused', () => {
  it('refuses a name the extension would reject at discovery, which the clause check lets through', () => {
    // Same query as above: the clause is fine, the object name is not, and
    // Discover was refused by the extension with nothing said in the form.
    expect(soqlObjectNameRefused('SELECT Id FROM 1Account WHERE Name = null')).toBe(true);
    expect(soqlFilterRefused('SELECT Id FROM 1Account WHERE Name = null')).toBe(false);
  });

  it('accepts a name the extension accepts as a filter key', () => {
    expect(soqlObjectNameRefused("SELECT Id FROM Account WHERE Industry = 'X'")).toBe(false);
    expect(soqlObjectNameRefused('SELECT Id FROM My_Object__c')).toBe(false);
  });

  it('says nothing about a query with no filter to send', () => {
    // Without a WHERE clause nothing goes into objectSoqlFilters, so the key
    // rule never applies and the form has no refusal to make.
    expect(soqlObjectNameRefused('SELECT Id FROM 1Account')).toBe(false);
    expect(soqlObjectNameRefused('not a query')).toBe(false);
    expect(soqlObjectNameRefused('')).toBe(false);
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
