import { describe, expect, it } from 'vitest';

import { MOST_WIRE_CHARS, SampleSourceOrg } from './sampleSourceOrg.js';

/*
 * The source org the reads of a sample are tried against refuses what a real
 * org refuses: a test of the reads that passes here passes for what the org
 * would answer, not for what a lenient fixture lets through.
 */

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

/** An org of a few accounts and their contacts, one of each deleted. */
function salesOrg(): SampleSourceOrg {
  const org = new SampleSourceOrg();
  org.columns.set('Account', ['Id', 'Name', 'ParentId', 'IsDeleted']);
  org.columns.set('Contact', ['Id', 'AccountId', 'ReportsToId', 'IsDeleted']);
  for (let n = 1; n <= 5; n++) {
    org.add('Account', { Id: fakeId('001', n), Name: `A${n}`, ParentId: null, IsDeleted: n === 5 });
    org.add('Contact', {
      Id: fakeId('003', n),
      AccountId: fakeId('001', n),
      ReportsToId: null,
      IsDeleted: false,
    });
  }
  return org;
}

/** The error a statement is refused with, or undefined when it is answered. */
async function refusal(org: SampleSourceOrg, soql: string): Promise<Error | undefined> {
  try {
    await org.query(soql);
    return undefined;
  } catch (error) {
    return error as Error;
  }
}

describe('the source org of a sample', () => {
  it('refuses a column its describe does not list, wherever the statement names it', async () => {
    const org = salesOrg();
    for (const soql of [
      'SELECT Id, IsPersonAccount FROM Account',
      'SELECT Id FROM Account WHERE IsPersonAccount = true',
      'SELECT Id FROM Account ORDER BY CreatedDate DESC',
      'SELECT IsPersonAccount, COUNT(Id) n FROM Account GROUP BY IsPersonAccount',
    ]) {
      const error = await refusal(org, soql);
      expect(error, soql).toMatchObject({ errorCode: 'INVALID_FIELD' });
      expect(error?.message).toMatch(/^No such column '\w+' on entity 'Account'/);
    }
    expect(
      await refusal(org, 'SELECT Id, Name FROM Account WHERE ParentId = null'),
    ).toBeUndefined();
  });

  it('refuses a statement whose request line passes what the org holds on the wire, each quote sent as %27, and answers one just under it', async () => {
    const org = salesOrg();
    const head = 'SELECT Id FROM Account WHERE Id IN (';
    const ids = (count: number): string =>
      Array.from({ length: count }, (_, n) => `'${fakeId('001', n)}'`).join(', ');
    // As the request goes: the query's path, then the statement, its quotes encoded too.
    const wire = (soql: string): number =>
      '/services/data/v66.0/query?q='.length + encodeURIComponent(soql).replace(/'/g, '%27').length;
    let count = 1;
    while (wire(`${head}${ids(count + 1)})`) <= MOST_WIRE_CHARS) count++;
    // Thirty characters an id on the wire: four more than without its quotes encoded.
    expect(wire(`${head}${ids(count + 1)})`) - wire(`${head}${ids(count)})`)).toBe(30);
    expect(await refusal(org, `${head}${ids(count)})`)).toBeUndefined();
    expect(await refusal(org, `${head}${ids(count + 1)})`)).toMatchObject({
      errorCode: 'ERROR_HTTP_431',
    });
    // Under the bound counted with plain quotes, over it as sent.
    const plain = (soql: string): number => 29 + encodeURIComponent(soql).length;
    expect(plain(`${head}${ids(count + 20)})`)).toBeLessThanOrEqual(MOST_WIRE_CHARS);
    expect(await refusal(org, `${head}${ids(count + 20)})`)).toMatchObject({
      errorCode: 'ERROR_HTTP_431',
    });
  });

  it('refuses a third semi-join, and one an OR applies to, in the words of the org', async () => {
    const org = salesOrg();
    const third = await refusal(
      org,
      'SELECT COUNT() FROM Contact WHERE AccountId IN (SELECT Id FROM Account) ' +
        'AND ReportsToId NOT IN (SELECT Id FROM Contact) AND Id IN (SELECT Id FROM Contact)',
    );
    expect(third).toMatchObject({ errorCode: 'EXCEEDED_MAX_SEMIJOIN_SUBSELECTS' });
    expect(third?.message).toBe('Maximum 2 semi join sub-selects are allowed');
    const beside = await refusal(
      org,
      'SELECT COUNT() FROM Contact WHERE AccountId IN (SELECT Id FROM Account) OR ReportsToId = null',
    );
    expect(beside).toMatchObject({ errorCode: 'MALFORMED_QUERY' });
    expect(beside?.message).toBe("Semi join sub-selects are not allowed with the 'OR' operator");
    // In parentheses an OR is part of, theirs or around them: the words of a nested one.
    for (const soql of [
      "SELECT Id FROM Account WHERE (Id IN (SELECT AccountId FROM Contact) AND Name != 'x') OR Name = 'y'",
      "SELECT Id FROM Account WHERE Name != 'x' AND (Id IN (SELECT AccountId FROM Contact) OR Name = 'y')",
    ]) {
      const nested = await refusal(org, soql);
      expect(nested, soql).toMatchObject({ errorCode: 'MALFORMED_QUERY' });
      expect(nested?.message).toBe(
        'Semi join sub-selects are only allowed at the top level WHERE expressions and not in ' +
          'nested WHERE expressions.',
      );
    }
  });

  it('takes an OR beside a semi-join of the top level, as a scratch org took the page after a date and an id', async () => {
    const org = salesOrg();
    const after = `(Name > 'A2' OR (Name = 'A2' AND Id > '${fakeId('001', 2)}'))`;
    for (const [soql, accounts] of [
      [
        `SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Contact) AND ${after} ORDER BY Name ASC, Id ASC LIMIT 2`,
        [3, 4],
      ],
      // Two semi-joins, one of them a NOT IN, and the same OR.
      [
        `SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Contact) AND Id NOT IN (SELECT ReportsToId FROM Contact) AND ${after} ORDER BY Name ASC, Id ASC`,
        [3, 4],
      ],
      // An OR within the semi-join's own WHERE.
      [
        "SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Contact WHERE Id = 'none' OR ReportsToId = null) AND Name != 'A1'",
        [2, 3, 4],
      ],
      // The semi-join alone in parentheses.
      [
        'SELECT Id FROM Account WHERE (Id IN (SELECT AccountId FROM Contact)) AND ParentId = null',
        [1, 2, 3, 4],
      ],
    ] as const) {
      const answer = await org.query(soql);
      expect(
        answer.records.map((row) => row['Id']),
        soql,
      ).toEqual(accounts.map((n) => fakeId('001', n)));
    }
  });

  it('reads two semi-joins as the lists their statements select', async () => {
    const org = salesOrg();
    const answer = await org.query(
      "SELECT Id FROM Contact WHERE AccountId IN (SELECT Id FROM Account WHERE Name = 'A2') " +
        'AND Id NOT IN (SELECT ReportsToId FROM Contact)',
    );
    expect(answer.records.map((row) => row['Id'])).toEqual([fakeId('003', 2)]);
  });

  it('refuses an offset past 2 000, and answers one of 2 000', async () => {
    const org = salesOrg();
    const page = await org.query('SELECT Id FROM Account ORDER BY Id LIMIT 2 OFFSET 1');
    expect(page.records.map((row) => row['Id'])).toEqual([fakeId('001', 2), fakeId('001', 3)]);
    expect(await refusal(org, 'SELECT Id FROM Account ORDER BY Id LIMIT 10 OFFSET 2000')).toBe(
      undefined,
    );
    expect(
      await refusal(org, 'SELECT Id FROM Account ORDER BY Id LIMIT 10 OFFSET 2001'),
    ).toMatchObject({ errorCode: 'NUMBER_OUTSIDE_VALID_RANGE' });
  });

  it('runs past its time a lookup held to null on an object it is told is slow, a count too', async () => {
    const org = salesOrg();
    org.slow.add('Contact');
    for (const soql of [
      'SELECT Id FROM Contact WHERE AccountId = null',
      'SELECT COUNT() FROM Contact WHERE ReportsToId = null AND IsDeleted = false',
    ]) {
      expect(await refusal(org, soql), soql).toMatchObject({ errorCode: 'QUERY_TIMEOUT' });
    }
    // A read without it is answered, as is one of an object it is not told of.
    expect(await refusal(org, 'SELECT Id, AccountId FROM Contact')).toBeUndefined();
    expect(await refusal(org, 'SELECT Id FROM Account WHERE ParentId = null')).toBeUndefined();
  });

  it('leaves the deleted rows out of a query and answers them through queryAll', async () => {
    const org = salesOrg();
    expect((await org.query('SELECT COUNT() FROM Account')).totalSize).toBe(4);
    expect((await org.queryAll('SELECT COUNT() FROM Account')).totalSize).toBe(5);
    expect(
      (await org.queryAll('SELECT COUNT() FROM Account WHERE IsDeleted = false')).totalSize,
    ).toBe(4);
  });

  it('refuses to count a feed item’s ids by parent, in the words a scratch org refused them in', async () => {
    const org = salesOrg();
    org.add('FeedItem', { Id: fakeId('0D5', 1), ParentId: fakeId('001', 1), IsDeleted: false });

    const error = await refusal(
      org,
      `SELECT ParentId, COUNT(Id) n FROM FeedItem WHERE ParentId IN ('${fakeId('001', 1)}') GROUP BY ParentId`,
    );

    expect(error).toMatchObject({ errorCode: 'MALFORMED_QUERY' });
    expect(error?.message).toBe('field Id does not support aggregate operator COUNT');
  });

  it('refuses to group by a field it cannot group by, in the words a scratch org refused its accounts’ description in', async () => {
    const org = salesOrg();
    org.columns.set('Account', ['Id', 'Name', 'ParentId', 'Description', 'IsDeleted']);

    const error = await refusal(
      org,
      'SELECT Description, COUNT(Id) n FROM Account WHERE ParentId = null GROUP BY Description',
    );

    expect(error).toMatchObject({ errorCode: 'MALFORMED_QUERY' });
    expect(error?.message).toBe("field 'Description' can not be grouped in a query call");
  });

  it('answers the rows of no value as one group, the field null, as a scratch org grouped its accounts of no record type', async () => {
    const org = salesOrg();
    org.columns.set('Account', ['Id', 'Name', 'ParentId', 'RecordTypeId', 'IsDeleted']);
    org.add('Account', { Id: fakeId('001', 6), RecordTypeId: fakeId('012', 1), IsDeleted: false });
    org.add('Account', { Id: fakeId('001', 7), RecordTypeId: null, IsDeleted: false });

    const answer = await org.query(
      'SELECT RecordTypeId, COUNT(Id) n FROM Account GROUP BY RecordTypeId',
    );

    // Four accounts that hold no record type at all, and one that holds it empty.
    expect(answer.records).toEqual([
      { RecordTypeId: null, n: 5 },
      { RecordTypeId: fakeId('012', 1), n: 1 },
    ]);
  });

  it('refuses a date alone compared to a date-time field, in the words a scratch org refused it in', async () => {
    const org = salesOrg();
    org.columns.set('Account', ['Id', 'Name', 'ParentId', 'CreatedDate', 'IsDeleted']);

    const error = await refusal(org, 'SELECT COUNT() FROM Account WHERE CreatedDate >= 2026-11-13');

    expect(error).toMatchObject({ errorCode: 'INVALID_FIELD' });
    expect(error?.message).toBe(
      "value of filter criterion for field 'CreatedDate' must be of type dateTime and should " +
        'not be enclosed in quotes',
    );
    expect(
      await refusal(org, 'SELECT COUNT() FROM Account WHERE CreatedDate >= 2026-11-13T00:00:00Z'),
    ).toBeUndefined();
  });

  it('runs past its time a statement that compares the date of the last change, of an object it is told is slow on it', async () => {
    const org = salesOrg();
    org.columns.set('Account', ['Id', 'Name', 'ParentId', 'LastModifiedDate', 'IsDeleted']);
    org.slowOnModified.add('Account');

    expect(
      await refusal(
        org,
        'SELECT COUNT() FROM Account WHERE LastModifiedDate >= 2026-11-13T00:00:00Z',
      ),
    ).toMatchObject({ errorCode: 'QUERY_TIMEOUT' });
    // A read that only selects it is answered, as is a field held to null.
    expect(await refusal(org, 'SELECT Id, LastModifiedDate FROM Account')).toBeUndefined();
    expect(await refusal(org, 'SELECT Id FROM Account WHERE ParentId = null')).toBeUndefined();
  });

  it('counts the children of each parent a statement groups them by', async () => {
    const org = salesOrg();
    org.add('Contact', { Id: fakeId('003', 9), AccountId: fakeId('001', 1), IsDeleted: false });
    const answer = await org.query(
      `SELECT AccountId, COUNT(Id) n FROM Contact WHERE AccountId IN ('${fakeId('001', 1)}', '${fakeId('001', 2)}') GROUP BY AccountId`,
    );
    expect(answer.records).toEqual([
      { AccountId: fakeId('001', 1), n: 2 },
      { AccountId: fakeId('001', 2), n: 1 },
    ]);
  });

  it('answers a cursor a page at a time and counts every request, each next page one', async () => {
    const org = salesOrg();
    org.pageSize = 2;
    const pages: number[] = [];
    for await (const page of org.source().pages('SELECT Id FROM Contact')) pages.push(page.length);
    expect(pages).toEqual([2, 2, 1]);
    expect(org.requests).toBe(3);
    expect(await org.source().count('SELECT COUNT() FROM Contact')).toBe(5);
    expect(org.requests).toBe(4);
  });
});
