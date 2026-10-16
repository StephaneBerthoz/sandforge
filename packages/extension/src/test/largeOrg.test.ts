import { describe, it, expect } from 'vitest';
import {
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
