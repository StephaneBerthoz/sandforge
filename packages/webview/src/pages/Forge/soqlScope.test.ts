import { describe, it, expect } from 'vitest';

import { newestQueryOf } from './forgeUtils';

/**
 * A query of the SOQL tab chooses the records the run clones, each with what
 * the clone of that record copies: the extension reads them by a statement
 * of its own from the query's object, WHERE, ORDER BY and LIMIT, and refuses
 * a run whose query chooses more than it takes with no LIMIT holding it.
 * The way through the page offers writes the newest of them into the query,
 * where the user sees it. The query is read by the parser shared with the
 * extension and the command line, whose tests sit beside it
 * (`@sandforge/shared`, `utils/soqlRoot.test.ts`).
 */
describe('newestQueryOf', () => {
  it('orders a query with no order of its own by the date its records were made, newest first, then by their ids, and holds it to the most', () => {
    // By the date alone, records made in the same second came back in an
    // order that changed with the WHERE, and the LIMIT kept others.
    expect(newestQueryOf("SELECT Id FROM Account WHERE Industry = 'Energy'", 200)).toBe(
      "SELECT Id FROM Account WHERE Industry = 'Energy' ORDER BY CreatedDate DESC, Id DESC LIMIT 200",
    );
  });

  it('keeps the order a query gives, and takes the first of them in it', () => {
    expect(newestQueryOf('SELECT Id FROM Case ORDER BY Priority, Id  ', 50)).toBe(
      'SELECT Id FROM Case ORDER BY Priority, Id LIMIT 50',
    );
  });

  it('offers nothing for a query that has a LIMIT already, or names no object', () => {
    expect(newestQueryOf('SELECT Id FROM Account LIMIT 5000', 200)).toBeUndefined();
    expect(newestQueryOf('not a query', 200)).toBeUndefined();
    expect(newestQueryOf('', 200)).toBeUndefined();
  });
});
