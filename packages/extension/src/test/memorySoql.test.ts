import { describe, it, expect } from 'vitest';
import { parseSoql, selectFrom, type SoqlRow } from './memorySoql';

const A1 = '001000000000001AAA';
const A2 = '001000000000002AAA';
const A3 = '001000000000003AAA';

const ROWS: SoqlRow[] = [
  { Id: A1, Name: 'Acme', Rating: 3, SystemModstamp: '2026-10-20T18:59:03.000Z', IsDeleted: false },
  {
    Id: A2,
    Name: 'Globex',
    Rating: null,
    SystemModstamp: '2026-10-20T18:59:04.000Z',
    IsDeleted: true,
  },
  { Id: A3, Name: null, Rating: 1, SystemModstamp: '2026-10-20T18:59:05.000Z', IsDeleted: false },
];

const ids = (soql: string): unknown[] => selectFrom(ROWS, parseSoql(soql)).map((row) => row.Id);

describe('parseSoql and selectFrom', () => {
  it('reads the columns, a WHERE clause under AND, OR and parentheses, the order and the limit', () => {
    const statement = parseSoql(
      "SELECT Id, Name FROM Account WHERE (Name = 'Acme' OR Rating = 1) AND IsDeleted = false " +
        'ORDER BY Rating DESC LIMIT 5',
    );

    expect(statement).toMatchObject({
      object: 'Account',
      columns: ['Id', 'Name'],
      orderBy: [{ field: 'Rating', descending: true }],
      limit: 5,
    });
    expect(selectFrom(ROWS, statement).map((row) => row.Id)).toEqual([A1, A3]);
    expect(ids('SELECT Id FROM Account LIMIT 2')).toEqual([A1, A2]);
  });

  it('reads COUNT() as a statement of no columns', () => {
    expect(parseSoql('SELECT COUNT() FROM Account WHERE IsDeleted = true').columns).toBeNull();
    expect(ids('SELECT COUNT() FROM Account WHERE IsDeleted = true')).toEqual([A2]);
  });

  it('compares an id by its first fifteen characters, given either length', () => {
    expect(ids(`SELECT Id FROM Account WHERE Id IN ('${A1.slice(0, 15)}', '${A3}')`)).toEqual([
      A1,
      A3,
    ]);
    expect(ids(`SELECT Id FROM Account WHERE Id = '${A2.slice(0, 15)}'`)).toEqual([A2]);
    expect(ids(`SELECT Id FROM Account WHERE Id NOT IN ('${A2.slice(0, 15)}')`)).toEqual([A1, A3]);
  });

  it('drops the milliseconds of a date-time literal and honours its offset, so < and >= split the rows exactly', () => {
    // Half a second past 18:59:04 counts as 18:59:04 itself: the row stamped
    // then is at or after it, not before.
    expect(ids('SELECT Id FROM Account WHERE SystemModstamp < 2026-10-20T18:59:04.500Z')).toEqual([
      A1,
    ]);
    expect(ids('SELECT Id FROM Account WHERE SystemModstamp >= 2026-10-20T18:59:04.500Z')).toEqual([
      A2,
      A3,
    ]);
    expect(ids('SELECT Id FROM Account WHERE SystemModstamp < 2026-10-20T20:59:04+02:00')).toEqual([
      A1,
    ]);
    expect(ids('SELECT Id FROM Account WHERE SystemModstamp <= 2026-10-20T18:59:03.999Z')).toEqual([
      A1,
    ]);
  });

  it('keeps empty values under != and leaves them out of < and >', () => {
    expect(ids("SELECT Id FROM Account WHERE Name != 'Acme'")).toEqual([A2, A3]);
    expect(ids('SELECT Id FROM Account WHERE Rating > 0')).toEqual([A1, A3]);
    expect(ids('SELECT Id FROM Account WHERE Rating = null')).toEqual([A2]);
    expect(ids('SELECT Id FROM Account WHERE Name <> null')).toEqual([A1, A2]);
  });

  it('orders empty values first going up and last going down, dates as instants', () => {
    expect(ids('SELECT Id FROM Account ORDER BY Rating')).toEqual([A2, A3, A1]);
    expect(ids('SELECT Id FROM Account ORDER BY Rating DESC')).toEqual([A1, A3, A2]);
    const dated: SoqlRow[] = [
      { Id: A1, At: '2026-10-20T18:59:05.000+02:00' },
      { Id: A2, At: '2026-10-20T17:59:04.000Z' },
    ];
    expect(
      selectFrom(dated, parseSoql('SELECT Id FROM Account ORDER BY At DESC LIMIT 1'))[0].Id,
    ).toBe(A2);
  });

  it('refuses a statement it cannot read rather than select nothing', () => {
    for (const soql of [
      "SELECT Id FROM Account WHERE Name LIKE 'A%'",
      'SELECT Owner.Name FROM Account',
      'SELECT Id FROM Account GROUP BY Name',
      "SELECT Id FROM Account WHERE (Name = 'Acme'",
      'SELECT Id FROM Account WHERE IsDeleted > true',
      'SELECT Id FROM Account WHERE Name < null',
      'SELECT Id FROM Account LIMIT many',
    ]) {
      expect(() => parseSoql(soql), soql).toThrow();
    }
  });
});
