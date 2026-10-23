import { describe, it, expect } from 'vitest';
import {
  MAX_SELECT_URI_CHARS,
  MAX_STATEMENT_URI_CHARS,
  columnGroups,
  firstColumns,
  idsPerStatement,
  pagesColumnsApart,
  readColumnsApart,
  readOtherColumns,
  readOtherColumnsAtOneStamp,
  uriLength,
  wideStatement,
  type WideStatement,
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

  it('carries the columns it is given in every group, after the id, and names each other field once', () => {
    const fields = ['Id', 'Name', 'SystemModstamp', ...wideFields(900).slice(2)];
    const groups = columnGroups(fields, ['Id', 'SystemModstamp']);

    expect(groups.length).toBeGreaterThan(1);
    for (const group of groups) {
      expect(group.slice(0, 2)).toEqual(['Id', 'SystemModstamp']);
      expect(uriLength(group.join(', '))).toBeLessThanOrEqual(MAX_SELECT_URI_CHARS);
    }
    const named = groups.flatMap((group) => group.slice(2));
    expect(named).toEqual(fields.filter((field) => field !== 'Id' && field !== 'SystemModstamp'));
  });

  it('puts the id first whatever columns it carries, and keeps a list that fits as written', () => {
    const groups = columnGroups(wideFields(900), ['SystemModstamp']);
    expect(groups.every((group) => group[0] === 'Id' && group[1] === 'SystemModstamp')).toBe(true);
    expect(columnGroups(['Name', 'Id'], ['Id', 'SystemModstamp'])).toEqual([['Name', 'Id']]);
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
    expect(wide?.firstGroup).toEqual(firstColumns(fields));
    expect(wide?.others.flat()).not.toContain('Name');
  });

  it('names the columns it carries in its first statement and in every other group', () => {
    const fields = ['Id', 'SystemModstamp', ...wideFields(900).slice(1)];
    const wide = wideStatement(`SELECT ${fields.join(', ')} FROM Account`, [
      'Id',
      'SystemModstamp',
    ]);

    expect(wide?.first.startsWith('SELECT Id, SystemModstamp, Name, ')).toBe(true);
    for (const group of [wide?.firstGroup ?? [], ...(wide?.others ?? [])]) {
      expect(group.slice(0, 2)).toEqual(['Id', 'SystemModstamp']);
    }
  });
});

/** How many ids each statement of `sent` reading `group` of `objectApiName` by id named, in order. */
function idsByStatement(
  sent: readonly string[],
  objectApiName: string,
  group: readonly string[],
): number[] {
  const prefix = `SELECT ${group.join(', ')} FROM ${objectApiName} WHERE `;
  return sent
    .filter((statement) => statement.startsWith(prefix) && statement.includes('Id IN ('))
    .map((statement) => [...statement.matchAll(/'[^']+'/g)].length);
}

describe('idsPerStatement', () => {
  it('names as many ids as each read of a group by id names a statement: 500 for a short group, fewer for one whose columns take half the URI', async () => {
    const fields = wideFields(900);
    const org = fakeOrg(rowsOf(fields, 1_200));
    const wide = wideStatement(`SELECT ${fields.join(', ')} FROM Account`);
    if (!wide) throw new Error('Not split');

    await readOtherColumns(await org.read(wide.first), wide, org.read);

    const per = wide.others.map((group) => idsPerStatement('Account', group));
    for (const [at, group] of wide.others.entries()) {
      const sent = idsByStatement(org.sent, 'Account', group);
      expect(sent[0]).toBe(per[at]);
      expect(sent).toHaveLength(Math.ceil(1_200 / per[at]));
      expect(sent.reduce((total, ids) => total + ids, 0)).toBe(1_200);
    }
    // A group of columns that fill their half of the URI leaves room for
    // fewer ids than the 500 a statement names at most.
    expect(Math.min(...per)).toBeLessThan(500);
    expect(idsPerStatement('Account', ['Id', 'Name'])).toBe(500);
  });

  it('counts the term each read by id keeps its rows to beside their ids', async () => {
    const fields = ['Id', 'SystemModstamp', ...wideFields(900).slice(1)];
    const rows = Array.from({ length: 700 }, (_, n) => ({
      ...Object.fromEntries(fields.map((field) => [field, 'v1'])),
      Id: idOf(n + 1),
      SystemModstamp: '2026-10-22T10:00:00.000+0000',
    }));
    const org = stampedOrg(rows);
    const wide = wideStatement(`SELECT ${fields.join(', ')} FROM Account`, [
      'Id',
      'SystemModstamp',
    ]);
    if (!wide) throw new Error('Not split');

    await readOtherColumnsAtOneStamp(await org.read(wide.first), wide, org.read, {
      stamp: 'SystemModstamp',
      idsWhere: 'IsDeleted = false',
    });

    for (const group of wide.others) {
      const per = idsPerStatement('Account', group, 'IsDeleted = false');
      const sent = idsByStatement(org.sent, 'Account', group);
      expect(sent[0]).toBe(Math.min(per, 700));
      expect(sent).toHaveLength(Math.ceil(700 / per));
      expect(per).toBeLessThanOrEqual(idsPerStatement('Account', group));
    }
  });
});

/**
 * An org holding the rows of one wide object, each at its stamp, which
 * answers the statements of a read in column groups: the first as written,
 * the others by id. A delete takes a row out of the live rows and stamps it;
 * a read that goes through the recycle bin (`throughBin`) still answers for
 * it unless the statement keeps to `IsDeleted = false`.
 */
function stampedOrg(rows: Array<Record<string, unknown>>, options: { throughBin?: boolean } = {}) {
  const held = new Map<string, Record<string, unknown>>(
    rows.map((row) => [String(row.Id), { ...row, IsDeleted: false }]),
  );
  const sent: string[] = [];
  /** Called before each statement is answered: what a test writes to the org from. */
  const hooks: { before: (statement: string) => void } = { before: () => undefined };
  const read = async (soql: string): Promise<Array<Record<string, unknown>>> => {
    hooks.before(soql);
    sent.push(soql);
    const parts = /^SELECT (.+?) FROM \w+(?: WHERE (.+))?$/.exec(soql);
    if (!parts) throw new Error(`Not a statement the fake reads: ${soql}`);
    const [, select, where = ''] = parts;
    const byId = where.includes('Id IN (');
    const ids = byId ? new Set([...where.matchAll(/'([^']+)'/g)].map((m) => m[1])) : undefined;
    const liveOnly = !byId || options.throughBin !== true || where.startsWith('IsDeleted = false');
    return [...held.values()]
      .filter((row) => (!ids || ids.has(String(row.Id))) && (!liveOnly || !row.IsDeleted))
      .map((row) => Object.fromEntries(select.split(', ').map((field) => [field, row[field]])));
  };
  /** Write `value` into every custom field of a row, as one save does, stamped `stamp`. */
  const write = (id: string, value: string, stamp: string): void => {
    const row = held.get(id);
    if (!row) throw new Error(`No row ${id}`);
    for (const field of Object.keys(row)) if (field.endsWith('__c')) row[field] = value;
    row.SystemModstamp = stamp;
  };
  /** Delete a row, its stamp moved to `stamp`. */
  const remove = (id: string, stamp: string): void => {
    const row = held.get(id);
    if (!row) throw new Error(`No row ${id}`);
    row.IsDeleted = true;
    row.SystemModstamp = stamp;
  };
  return { read, sent, hooks, write, remove };
}

describe('readOtherColumnsAtOneStamp', () => {
  const fields = ['Id', 'SystemModstamp', ...wideFields(900).slice(1)];
  const soql = `SELECT ${fields.join(', ')} FROM Account`;
  const carried = ['Id', 'SystemModstamp'];
  const first = '2026-10-22T10:00:00.000+0000';
  const later = '2026-10-22T10:00:07.000+0000';

  /** `count` rows, each custom field `v1`, stamped `first`. */
  function rowsAtFirst(count: number): Array<Record<string, unknown>> {
    return Array.from({ length: count }, (_, n) => ({
      ...Object.fromEntries(fields.map((field) => [field, 'v1'])),
      Id: idOf(n + 1),
      Name: `Account ${n + 1}`,
      SystemModstamp: first,
    }));
  }

  /** The values a row holds in its custom fields, each once. */
  function customValues(row: Record<string, unknown> | undefined): unknown[] {
    return [
      ...new Set(
        Object.entries(row ?? {})
          .filter(([field]) => field.endsWith('__c'))
          .map(([, value]) => value),
      ),
    ];
  }

  /** The statement split into groups, every group carrying the stamp. */
  function split(): WideStatement {
    const wide = wideStatement(soql, carried);
    if (!wide) throw new Error('Not split');
    return wide;
  }

  /** Call `act` before the first read by id: between the first group and the others. */
  function beforeTheOthers(org: ReturnType<typeof stampedOrg>, act: () => void): void {
    let done = false;
    org.hooks.before = (statement) => {
      if (done || !statement.includes('Id IN (')) return;
      done = true;
      act();
    };
  }

  it('merges every group of rows whose stamps agree, as a read of the groups merges them', async () => {
    const org = stampedOrg(rowsAtFirst(30));
    const wide = split();

    const rows = await readOtherColumnsAtOneStamp(await org.read(wide.first), wide, org.read, {
      stamp: 'SystemModstamp',
    });

    expect(rows).toHaveLength(30);
    expect(Object.keys(rows[29])).toHaveLength(fields.length);
    expect(rows[29]['Customer_Field_0899__c']).toBe('v1');
    // The first statement, then one read by id for each other group.
    expect(org.sent).toHaveLength(1 + wide.others.length);
  });

  it('reads again a row written between two of its groups, and holds every column of it as that write left it', async () => {
    const org = stampedOrg(rowsAtFirst(3));
    const wide = split();
    beforeTheOthers(org, () => org.write(idOf(2), 'v2', later));
    const firstRows = await org.read(wide.first);

    const rows = await readOtherColumnsAtOneStamp(firstRows, wide, org.read, {
      stamp: 'SystemModstamp',
    });

    expect(rows.map((row) => row.Id)).toEqual([idOf(1), idOf(2), idOf(3)]);
    expect(customValues(rows[1])).toEqual(['v2']);
    expect(rows[1].SystemModstamp).toBe(later);
    expect(customValues(rows[0])).toEqual(['v1']);
  });

  it('is needed: merged as they were read, the groups of that row hold the values of two writes', async () => {
    const org = stampedOrg(rowsAtFirst(3));
    const wide = split();
    beforeTheOthers(org, () => org.write(idOf(2), 'v2', later));

    const rows = await readOtherColumns(await org.read(wide.first), wide, org.read);

    expect(customValues(rows[1]).sort()).toEqual(['v1', 'v2']);
  });

  it('drops a row a later group no longer finds: deleted while it was read', async () => {
    const org = stampedOrg(rowsAtFirst(3));
    const wide = split();
    beforeTheOthers(org, () => org.remove(idOf(3), later));

    const rows = await readOtherColumnsAtOneStamp(await org.read(wide.first), wide, org.read, {
      stamp: 'SystemModstamp',
    });

    expect(rows.map((row) => row.Id)).toEqual([idOf(1), idOf(2)]);
  });

  it('drops a row written between its groups and deleted before it is read again', async () => {
    const org = stampedOrg(rowsAtFirst(3));
    const wide = split();
    let reads = 0;
    org.hooks.before = (statement) => {
      if (!statement.includes('Id IN (')) return;
      reads += 1;
      if (reads === 1) org.write(idOf(1), 'v2', later);
      if (reads === wide.others.length + 1) org.remove(idOf(1), later);
    };

    const rows = await readOtherColumnsAtOneStamp(await org.read(wide.first), wide, org.read, {
      stamp: 'SystemModstamp',
    });

    expect(rows.map((row) => row.Id)).toEqual([idOf(2), idOf(3)]);
  });

  it('keeps each read by id to the live rows it is told to, so a row deleted between groups is not found in the recycle bin', async () => {
    const org = stampedOrg(rowsAtFirst(3), { throughBin: true });
    const wide = split();
    beforeTheOthers(org, () => org.remove(idOf(3), later));

    const rows = await readOtherColumnsAtOneStamp(await org.read(wide.first), wide, org.read, {
      stamp: 'SystemModstamp',
      idsWhere: 'IsDeleted = false',
    });

    expect(rows.map((row) => row.Id)).toEqual([idOf(1), idOf(2)]);
    for (const statement of org.sent.slice(1)) {
      expect(statement).toMatch(/ WHERE IsDeleted = false AND Id IN \(/);
      expect(uriLength(statement)).toBeLessThanOrEqual(MAX_STATEMENT_URI_CHARS);
    }
  });

  it('is told to: through the recycle bin, a read by id alone finds the deleted row and keeps it', async () => {
    const org = stampedOrg(rowsAtFirst(3), { throughBin: true });
    const wide = split();
    beforeTheOthers(org, () => org.remove(idOf(3), later));

    const rows = await readOtherColumnsAtOneStamp(await org.read(wide.first), wide, org.read, {
      stamp: 'SystemModstamp',
    });

    expect(rows.map((row) => row.Id)).toContain(idOf(3));
  });

  it('fails rather than hold a row that is written between its groups on every read', async () => {
    const org = stampedOrg(rowsAtFirst(3));
    const wide = split();
    let second = 0;
    // Each read of the second group finds the row written again since.
    org.hooks.before = (statement) => {
      if (!statement.includes('Id IN (') || !statement.includes(wide.others[0][2])) return;
      second += 1;
      org.write(idOf(2), `v${second + 1}`, `2026-10-22T10:00:${String(10 + second)}.000+0000`);
    };

    await expect(
      readOtherColumnsAtOneStamp(await org.read(wide.first), wide, org.read, {
        stamp: 'SystemModstamp',
        rereads: 2,
      }),
    ).rejects.toThrow(
      '1 record(s) of Account were written between two reads of their columns 3 times in a row',
    );
    // Read, then read again twice: three reads of the second group, none more.
    expect(second).toBe(3);
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

  it('holds each row to one write when told its stamp: a row written between two of its groups is read again, every group carrying the stamp', async () => {
    const fields = ['Id', 'Name', ...wideFields(900).slice(2)];
    const at = '2026-10-22T10:00:00.000+0000';
    const org = stampedOrg(
      Array.from({ length: 3 }, (_, n) => ({
        ...Object.fromEntries(fields.map((field) => [field, 'v1'])),
        Id: idOf(n + 1),
        Name: `Account ${n + 1}`,
        SystemModstamp: at,
      })),
    );
    let written = false;
    org.hooks.before = (statement) => {
      if (written || !statement.includes('Id IN (')) return;
      written = true;
      org.write(idOf(2), 'v2', '2026-10-22T10:00:07.000+0000');
    };

    const rows = await readColumnsApart(`SELECT ${fields.join(', ')} FROM Account`, org.read, {
      stamp: 'SystemModstamp',
    });

    const values = Object.entries(rows[1])
      .filter(([field]) => field.endsWith('__c'))
      .map(([, value]) => value);
    expect(new Set(values)).toEqual(new Set(['v2']));
    expect(rows[1].SystemModstamp).toBe('2026-10-22T10:00:07.000+0000');
    for (const statement of org.sent) {
      expect(statement).toMatch(/^SELECT Id, SystemModstamp, /);
      expect(uriLength(statement)).toBeLessThanOrEqual(MAX_STATEMENT_URI_CHARS);
    }
  });

  it('sends a statement whose fields fit once, as written, when told a stamp too', async () => {
    const org = fakeOrg(rowsOf(['Id', 'Name'], 3));

    const rows = await readColumnsApart('SELECT Id, Name FROM Account', org.read, {
      stamp: 'SystemModstamp',
    });

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
