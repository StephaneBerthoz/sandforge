import { describe, it, expect } from 'vitest';

import { soqlHasWhereClause, SOQL_UNSCOPED_RECORD_CAP } from './forgeUtils';

/**
 * SOQL mode discards the user's filter.
 *
 * `parseObjectFromSOQL` (GraphDiscoveryService) returns only the object name
 * after FROM; the WHERE clause is never stored or sent. And ForgeOrchestrator
 * gates record-scoping on `inputMode === 'record'`, so a SOQL run takes the
 * unscoped path: whole tables, for the named object AND every related object
 * the graph discovered.
 *
 * Until the filter is honoured, two things must hold — the user is told, and
 * the blast radius is bounded.
 */
describe('SOQL unscoped-mode guards', () => {
  describe('soqlHasWhereClause', () => {
    it('detects a WHERE clause regardless of casing', () => {
      expect(soqlHasWhereClause("SELECT Id FROM Account WHERE Name = 'x'")).toBe(true);
      expect(soqlHasWhereClause("select id from account where name = 'x'")).toBe(true);
    });

    it('is false for a query with no filter', () => {
      expect(soqlHasWhereClause('SELECT Id, Name FROM Account')).toBe(false);
    });

    it('does not fire on a field or object merely containing the letters', () => {
      // `Somewhere__c` must not read as a WHERE clause.
      expect(soqlHasWhereClause('SELECT Somewhere__c FROM Anywhere__c')).toBe(false);
    });
  });

  it('caps SOQL runs low enough to bound a full-table clone', () => {
    // The cap is what stands between an unfiltered run and pulling an entire
    // org across every object in the graph.
    expect(SOQL_UNSCOPED_RECORD_CAP).toBeGreaterThan(0);
    expect(SOQL_UNSCOPED_RECORD_CAP).toBeLessThanOrEqual(500);
  });
});
