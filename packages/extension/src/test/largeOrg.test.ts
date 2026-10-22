import { describe, it, expect } from 'vitest';
import {
  accountFieldName,
  answerQuery,
  countingConnection,
  customObjectName,
  describeOf,
  fakeId,
  largeOrg,
} from './largeOrg';

describe('largeOrg', () => {
  it('holds six hundred custom objects beside the standard ones', () => {
    const org = largeOrg();

    expect([...org.objects.values()].filter((o) => o.custom).length).toBe(601);
    expect(org.objects.has(customObjectName(600))).toBe(true);
    expect(org.objects.get('Case')?.custom).toBe(false);
  });

  it('counts a table whole as the org would, and by its WHERE the rows it lists', () => {
    const org = largeOrg();

    expect(answerQuery(org, 'SELECT COUNT() FROM PostalCode__c').totalSize).toBe(61_635);
    expect(
      answerQuery(
        org,
        `SELECT COUNT() FROM PostalCode__c WHERE Id = '${fakeId(org, 'PostalCode__c', 1)}'`,
      ).totalSize,
    ).toBe(1);
    expect(answerQuery(org, 'SELECT COUNT() FROM Lead').totalSize).toBe(30);
  });

  it('reads rows by id, by equality and by grouped value, a date bound held', () => {
    const org = largeOrg({ cases: 4 });
    const ids = [fakeId(org, 'Case', 1), fakeId(org, 'Case', 3)];

    expect(
      answerQuery(
        org,
        `SELECT Id FROM Case WHERE Id IN ('${ids.join("', '")}') AND CreatedDate <= 2026-10-16T00:00:00.000Z`,
      ).records.map((r) => r.Id),
    ).toEqual(ids);
    expect(
      answerQuery(org, "SELECT Id FROM Case WHERE Origin = 'Web' ORDER BY Id ASC LIMIT 3").records,
    ).toHaveLength(1);
    expect(
      answerQuery(org, 'SELECT Origin axisValue FROM Case GROUP BY Origin LIMIT 2').records,
    ).toEqual([{ axisValue: 'Phone' }, { axisValue: 'Web' }]);
  });

  it('lists the children of an object off every other object’s lookups', () => {
    const org = largeOrg();

    const children = describeOf(org, 'Case').childRelationships.map((c) => c.childSObject);
    expect(children).toContain(customObjectName(4));
    expect(children).not.toContain(customObjectName(5));
  });

  it('answers the fields a read names, and nothing more', () => {
    const org = largeOrg();

    const [row] = answerQuery(org, 'SELECT Id, Name FROM Account LIMIT 1').records;
    expect(row).toEqual({ Id: fakeId(org, 'Account', 1), Name: 'Account 1' });
  });

  it('gives a wide account its custom fields, and refuses a read naming them all as an org refuses a URI too long', async () => {
    const org = largeOrg({ wideAccount: 900 });
    const { conn } = countingConnection(org);
    const fields = describeOf(org, 'Account').fields.map((f) => f.name);

    expect(fields).toContain(accountFieldName(900));
    expect(org.rows.Account?.[19]?.[accountFieldName(900)]).toBe('A20-900');
    await expect(conn.query(`SELECT ${fields.join(', ')} FROM Account`)).rejects.toMatchObject({
      errorCode: 'ERROR_HTTP_431',
    });
  });

  it('counts every call its connection answers', async () => {
    const { conn, calls, total } = countingConnection(largeOrg());

    await conn.describeGlobal();
    await conn.describe('Account');
    await conn.query('SELECT COUNT() FROM Account');

    expect(calls).toMatchObject({ describes: ['Account'], describeGlobals: 1 });
    expect(calls.queries).toEqual(['SELECT COUNT() FROM Account']);
    expect(total()).toBe(3);
  });
});
