import { describe, it, expect } from 'vitest';
import {
  MAX_SELECT_URI_CHARS,
  MAX_STATEMENT_URI_CHARS,
  columnGroups,
  firstColumns,
  pagesColumnsApart,
  readColumnsApart,
  uriLength,
  wideStatement,
} from './wideRead';

/** `count` custom fields, named as long as an org's usually are. */
function wideFields(count: number): string[] {
  return [
    'Id',
    'Name',
    ...Array.from({ length: count }, (_, i) => `Customer_Field_${String(i).padStart(4, '0')}__c`),
  ];
}

/** An id of the fake object, the `n`-th. */
function idOf(n: number): string {
  return `001${String(n).padStart(12, '0')}AAA`;
}

/**
 * An org holding `rows` of one object, which answers a statement as
 * Salesforce does: refused past the URI an org accepts, the fields it names
 * and nothing more, `Id IN (...)` and `LIMIT` honoured.
 */
function fakeOrg(rows: Array<Record<string, unknown>>) {
  const sent: string[] = [];
  const read = async (soql: string): Promise<Array<Record<string, unknown>>> => {
    sent.push(soql);
    if (uriLength(soql) > 15_400) {
      throw Object.assign(new Error('URI Too Long'), { errorCode: 'ERROR_HTTP_414' });
    }
    const parts = /^SELECT (.+?) FROM \w+(?: WHERE (.+?))?(?: LIMIT (\d+))?$/.exec(soql);
    if (!parts) throw new Error(`Not a statement the fake reads: ${soql}`);
    const [, select, where, limit] = parts;
    const fields = select.split(', ');
    const ids = where?.startsWith('Id IN (')
      ? new Set([...where.matchAll(/'([^']+)'/g)].map((m) => m[1]))
      : undefined;
    const matched = rows.filter(
      (row) => (!ids || ids.has(String(row.Id))) && (!where || ids || row.Name !== 'skip'),
    );
    const bounded = limit ? matched.slice(0, Number(limit)) : matched;
    return bounded.map((row) => ({
      attributes: { type: 'Account' },
      ...Object.fromEntries(fields.map((field) => [field, row[field] ?? null])),
    }));
  };
  return { read, sent };
}

/** `count` rows naming every one of `fields`. */
function rowsOf(fields: readonly string[], count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, n) => ({
    ...Object.fromEntries(fields.map((field) => [field, `${field}-${n}`])),
    Id: idOf(n + 1),
    Name: n % 10 === 9 ? 'skip' : `Account ${n + 1}`,
  }));
}

describe('columnGroups', () => {
  it('keeps a select list that fits one query as it is written', () => {
    const fields = ['Name', 'Id', 'Phone'];
    expect(columnGroups(fields)).toEqual([['Name', 'Id', 'Phone']]);
    expect(firstColumns(fields)).toEqual(['Name', 'Id', 'Phone']);
  });

  it('splits nine hundred fields into groups that each fit, the id first in every one, each other field once', () => {
    const fields = wideFields(900);
    const groups = columnGroups(fields);

    expect(groups.length).toBeGreaterThan(1);
    for (const group of groups) {
      expect(group[0]).toBe('Id');
      expect(uriLength(group.join(', '))).toBeLessThanOrEqual(MAX_SELECT_URI_CHARS);
    }
    const named = groups.flatMap((group) => group.slice(1));
    expect(named).toEqual(fields.filter((field) => field !== 'Id'));
  });
});

describe('wideStatement', () => {
  it('sends a statement whose fields fit as it is written', () => {
    expect(wideStatement("SELECT Id, Name FROM Account WHERE Id = '001'")).toBeUndefined();
  });

  it('never splits what is not a list of field names', () => {
    const many = wideFields(900).join(', ');
    expect(wideStatement('SELECT FIELDS(ALL) FROM Account LIMIT 200')).toBeUndefined();
    expect(wideStatement('SELECT COUNT() FROM Account')).toBeUndefined();
    expect(wideStatement(`SELECT ${many}, (SELECT Id FROM Contacts) FROM Account`)).toBeUndefined();
    expect(wideStatement(`SELECT ${many}, toLabel(Type) FROM Account`)).toBeUndefined();
  });

  it('keeps the WHERE, the order and the LIMIT on the first statement, naming its first group', () => {
    const fields = wideFields(900);
    const rest = " WHERE Name != 'skip' ORDER BY Id LIMIT 51";
    const wide = wideStatement(`SELECT ${fields.join(', ')} FROM Account${rest}`);

    expect(wide?.objectApiName).toBe('Account');
    expect(wide?.first).toBe(`SELECT ${firstColumns(fields).join(', ')} FROM Account${rest}`);
    expect(wide?.others.flat()).not.toContain('Name');
  });
});

describe('readColumnsApart', () => {
  it('reads a statement of nine hundred fields that no single query could carry, every row with every field', async () => {
    const fields = wideFields(900);
    const org = fakeOrg(rowsOf(fields, 600));
    const soql = `SELECT ${fields.join(', ')} FROM Account`;
    // Sent whole, the org refuses it, as it refused Forge's root read.
    await expect(org.read(soql)).rejects.toThrow('URI Too Long');
    org.sent.length = 0;

    const rows = await readColumnsApart(soql, org.read);

    expect(rows).toHaveLength(600);
    for (const statement of org.sent) {
      expect(uriLength(statement)).toBeLessThanOrEqual(MAX_STATEMENT_URI_CHARS);
    }
    expect(rows[0]['Customer_Field_0899__c']).toBe('Customer_Field_0899__c-0');
    expect(rows[599]['Customer_Field_0000__c']).toBe('Customer_Field_0000__c-599');
    expect(Object.keys(rows[0]).filter((key) => key !== 'attributes')).toHaveLength(fields.length);
    expect(rows.map((row) => row.Id)).toEqual(rowsOf(fields, 600).map((row) => row.Id));
  });

  it('takes the rows of the first statement, its filter and LIMIT, and reads the others by their ids alone', async () => {
    const fields = wideFields(900);
    const org = fakeOrg(rowsOf(fields, 100));
    const soql = `SELECT ${fields.join(', ')} FROM Account WHERE Name != 'skip' LIMIT 20`;

    const rows = await readColumnsApart(soql, org.read);

    expect(rows).toHaveLength(20);
    expect(rows.every((row) => row.Name !== 'skip')).toBe(true);
    expect(org.sent[0]).toMatch(/WHERE Name != 'skip' LIMIT 20$/);
    for (const statement of org.sent.slice(1)) {
      expect(statement).toMatch(/ WHERE Id IN \('[^)]+\)$/);
    }
  });

  it('sends a statement whose fields fit once, as written', async () => {
    const org = fakeOrg(rowsOf(['Id', 'Name'], 3));

    const rows = await readColumnsApart('SELECT Id, Name FROM Account', org.read);

    expect(rows).toHaveLength(3);
    expect(org.sent).toEqual(['SELECT Id, Name FROM Account']);
  });

  it('keeps the fields of a related record read through two groups', async () => {
    const fields = ['Id', 'Owner.Name', ...wideFields(900).slice(2), 'Owner.Email'];
    const read = async (soql: string): Promise<Array<Record<string, unknown>>> => {
      const owner: Record<string, unknown> = {};
      if (soql.includes('Owner.Name')) owner.Name = 'Alex';
      if (soql.includes('Owner.Email')) owner.Email = 'alex@example.invalid';
      return [{ Id: idOf(1), Owner: owner }];
    };

    const rows = await readColumnsApart(`SELECT ${fields.join(', ')} FROM Account`, read);

    expect(rows[0].Owner).toEqual({ Name: 'Alex', Email: 'alex@example.invalid' });
  });
});

describe('pagesColumnsApart', () => {
  it('gives each page of a wide statement every field before handing it on', async () => {
    const fields = wideFields(900);
    const org = fakeOrg(rowsOf(fields, 30));
    const soql = `SELECT ${fields.join(', ')} FROM Account`;
    const pages = async function* (statement: string) {
      const rows = await org.read(statement);
      for (let at = 0; at < rows.length; at += 10) yield rows.slice(at, at + 10);
    };

    const seen: Array<Array<Record<string, unknown>>> = [];
    for await (const page of pagesColumnsApart(soql, pages, org.read)) seen.push(page);

    expect(seen.map((page) => page.length)).toEqual([10, 10, 10]);
    expect(seen[2][9]['Customer_Field_0899__c']).toBe('Customer_Field_0899__c-29');
    for (const statement of org.sent) {
      expect(uriLength(statement)).toBeLessThanOrEqual(MAX_STATEMENT_URI_CHARS);
    }
  });
});
