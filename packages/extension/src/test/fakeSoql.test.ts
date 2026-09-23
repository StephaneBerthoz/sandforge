import { describe, expect, it } from 'vitest';
import { selectRows, type FakeRow } from './fakeSoql.js';

const tables: Record<string, FakeRow[]> = {
  Contact: [
    { Id: '003A', AccountId: '001A', OwnerId: '005A' },
    { Id: '003B', AccountId: '001A', OwnerId: '005B' },
    { Id: '003C', AccountId: '001C', OwnerId: '005A' },
  ],
  Pricebook2: [
    { Id: '01sS', IsStandard: true },
    { Id: '01sC', IsStandard: false },
  ],
};

const ids = (soql: string): unknown[] => selectRows(tables, soql).map((row) => row['Id']);

describe('selectRows', () => {
  it('selects the rows an IN list or an equality names', () => {
    expect(ids("SELECT Id FROM Contact WHERE AccountId IN ('001A', '001X')")).toEqual([
      '003A',
      '003B',
    ]);
    expect(ids("SELECT Id FROM Contact WHERE Id = '003C'")).toEqual(['003C']);
  });

  it('binds AND tighter than OR, and reads parentheses', () => {
    expect(
      ids(
        "SELECT Id FROM Contact WHERE Id IN ('003C') OR AccountId IN ('001A') AND OwnerId = '005B'",
      ),
    ).toEqual(['003B', '003C']);
    expect(
      ids(
        "SELECT Id FROM Contact WHERE (Id IN ('003C') OR AccountId IN ('001A')) AND (OwnerId IN ('005A'))",
      ),
    ).toEqual(['003A', '003C']);
  });

  it('reads a bare literal and stops at the LIMIT', () => {
    expect(ids('SELECT Id FROM Pricebook2 WHERE IsStandard = true LIMIT 1')).toEqual(['01sS']);
    expect(ids("SELECT Id FROM Contact WHERE OwnerId = '005A' LIMIT 1")).toEqual(['003A']);
  });

  it('matches a quote escaped inside a value', () => {
    const quoted = { Contact: [{ Id: "003'Q", AccountId: '001A' }] };
    expect(selectRows(quoted, "SELECT Id FROM Contact WHERE Id = '003\\'Q'")).toHaveLength(1);
  });

  it('returns copies, so a caller changing a row leaves the org as it was', () => {
    const [row] = selectRows(tables, "SELECT Id FROM Contact WHERE Id = '003A'");
    row['OwnerId'] = 'changed';
    expect(tables['Contact'][0]['OwnerId']).toBe('005A');
  });

  it('refuses a statement it cannot read rather than selecting nothing', () => {
    expect(() => selectRows(tables, 'SELECT Id FROM Contact')).toThrow(/fake org reads/);
    expect(() => selectRows(tables, "SELECT Id FROM Contact WHERE Name LIKE 'A%'")).toThrow(
      /Unsupported operator LIKE/,
    );
    expect(() => selectRows(tables, "SELECT Id FROM Contact WHERE (Id = '003A'")).toThrow(
      /ends too early/,
    );
  });
});
