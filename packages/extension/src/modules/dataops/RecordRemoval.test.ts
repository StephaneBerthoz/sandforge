import { describe, it, expect, vi } from 'vitest';

import type { DescribedObject } from './DataQualityScanner.js';
import {
  countRelated,
  deleteRecords,
  idLists,
  isRecordId,
  readRecordsById,
  RECORDS_PER_CALL,
  RELATED_COUNT_LIMIT,
  removalOutcome,
  updateRecords,
  workedObjects,
  writeStatus,
} from './RecordRemoval.js';

/** Ids that look like a contact's. */
function contactIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `003${String(i).padStart(12, '0')}AAA`);
}

const account: DescribedObject = {
  name: 'Account',
  label: 'Account',
  fields: [],
  childRelationships: [
    { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
    { childSObject: 'Opportunity', field: 'AccountId', cascadeDelete: true },
    { childSObject: 'AccountHistory', field: 'AccountId', cascadeDelete: true },
    { childSObject: 'Case', field: 'AccountId', cascadeDelete: false },
    { childSObject: 'Partner', field: 'AccountFromId', cascadeDelete: true },
    { childSObject: 'Partner', field: 'AccountToId', cascadeDelete: true },
  ],
};

const worked = new Map([
  ['Contact', 'Contact'],
  ['Opportunity', 'Opportunity'],
  ['Case', 'Case'],
  ['Partner', 'Partner'],
]);

describe('record removal', () => {
  it('tells a record Id from anything else before it reaches a query', () => {
    expect(isRecordId('003000000000001AAA')).toBe(true);
    expect(isRecordId('003000000000001')).toBe(true);
    expect(isRecordId("003' OR Id != '")).toBe(false);
    expect(isRecordId(42)).toBe(false);
  });

  it('names Ids in lists the org takes', () => {
    const lists = idLists(contactIds(RECORDS_PER_CALL + 1));

    expect(lists).toHaveLength(2);
    expect(lists[1]).toBe(`'003${String(RECORDS_PER_CALL).padStart(12, '0')}AAA'`);
  });

  it('counts only the objects people work with: not the history the org keeps', async () => {
    const answer = await workedObjects({
      describeGlobal: async () => ({
        sobjects: [
          {
            name: 'Contact',
            label: 'Contact',
            queryable: true,
            createable: true,
            layoutable: true,
          },
          { name: 'ContactHistory', label: 'Contact History', queryable: true, createable: false },
          { name: 'ContactShare', label: 'Contact Share', queryable: true, createable: true },
        ],
      }),
    });

    expect([...answer.keys()]).toEqual(['Contact']);
  });

  it('counts, per object, the records the org deletes along with the ones deleted', async () => {
    const query = vi.fn(async (soql: string) => ({
      totalSize: soql.includes('FROM Contact') ? 4 : soql.includes('AccountToId') ? 1 : 0,
      records: [],
    }));

    const result = await countRelated({ query }, account, contactIds(2), worked);

    expect(result.related).toEqual([
      { objectApiName: 'Contact', label: 'Contact', records: 4 },
      { objectApiName: 'Partner', label: 'Partner', records: 1 },
    ]);
    // No cascade to Case, and the history is not worked with: neither is asked.
    const asked = query.mock.calls.map(([soql]) => soql);
    expect(asked.some((soql) => soql.includes('FROM Case'))).toBe(false);
    expect(asked.some((soql) => soql.includes('AccountHistory'))).toBe(false);
  });

  it('names the related objects it could not count rather than count them as none', async () => {
    const query = vi.fn(async (soql: string) => {
      if (soql.includes('FROM Opportunity')) throw new Error('MALFORMED_QUERY');
      return { totalSize: 0, records: [] };
    });

    const result = await countRelated({ query }, account, contactIds(1), worked);

    expect(result.uncounted).toEqual(['Opportunity']);
  });

  it('stops counting past its limit and names what it left', async () => {
    const many: DescribedObject = {
      ...account,
      childRelationships: Array.from({ length: RELATED_COUNT_LIMIT + 1 }, (_, i) => ({
        childSObject: `Child${i}__c`,
        field: 'Parent__c',
        cascadeDelete: true,
      })),
    };
    const everything = new Map(
      Array.from({ length: RELATED_COUNT_LIMIT + 1 }, (_, i) => [`Child${i}__c`, `Child ${i}`]),
    );
    const query = vi.fn(async () => ({ totalSize: 0, records: [] }));

    const result = await countRelated({ query }, many, contactIds(1), everything);

    expect(query).toHaveBeenCalledTimes(RELATED_COUNT_LIMIT);
    expect(result.uncounted).toEqual([`Child ${RELATED_COUNT_LIMIT}`]);
  });

  it('reads records by Id without the attributes the API adds', async () => {
    const query = vi.fn(async (_soql: string) => ({
      totalSize: 1,
      records: [{ attributes: { type: 'Contact' }, Id: '003000000000001AAA', Email: 'a@b.co' }],
    }));

    const records = await readRecordsById({ query }, 'Contact', ['Email'], ['003000000000001AAA']);

    expect(query.mock.calls[0][0]).toBe(
      "SELECT Id, Email FROM Contact WHERE Id IN ('003000000000001AAA')",
    );
    expect(records).toEqual([{ Id: '003000000000001AAA', Email: 'a@b.co' }]);
  });

  it('names fewer records per query for a wide object, so the query stays short', async () => {
    const query = vi.fn(async () => ({ totalSize: 0, records: [] }));
    const fields = Array.from({ length: 150 }, (_, i) => `F${i}__c`);

    await readRecordsById({ query }, 'Contact', fields, contactIds(RECORDS_PER_CALL));

    expect(query).toHaveBeenCalledTimes(4);
  });

  it('deletes in calls the org takes and counts every refusal', async () => {
    const destroy = vi.fn(async (_name: string, ids: string[]) =>
      ids.map((id, i) =>
        i === 0
          ? { success: false, errors: [{ message: 'ENTITY_IS_DELETED' }] }
          : { success: true, id },
      ),
    );

    const counts = await deleteRecords({ destroy }, 'Contact', contactIds(RECORDS_PER_CALL + 2));

    expect(destroy).toHaveBeenCalledTimes(2);
    expect(counts.done).toBe(RECORDS_PER_CALL);
    expect(counts.failed).toBe(2);
    expect(counts.errors[0]).toEqual({ objectApiName: 'Contact', message: 'ENTITY_IS_DELETED' });
  });

  it('counts a call the org refuses whole as refused records, and goes on', async () => {
    const update = vi
      .fn()
      .mockRejectedValueOnce(new Error('REQUEST_LIMIT_EXCEEDED'))
      .mockImplementation(async (_n: string, records: Array<{ Id: string }>) =>
        records.map((r) => ({ success: true, id: r.Id })),
      );
    const records = contactIds(RECORDS_PER_CALL + 1).map((Id) => ({ Id, Email: null }));

    const counts = await updateRecords({ update }, 'Contact', records);

    expect(counts).toMatchObject({ done: 1, failed: RECORDS_PER_CALL });
    expect(counts.errors).toEqual([
      { objectApiName: 'Contact', message: 'REQUEST_LIMIT_EXCEEDED' },
    ]);
  });

  it('calls a write that partly landed partial, and sums the objects', () => {
    expect(writeStatus(3, 0)).toBe('success');
    expect(writeStatus(3, 1)).toBe('partial');
    expect(writeStatus(0, 1)).toBe('failure');
    expect(
      removalOutcome([
        { objectApiName: 'Contact', counts: { done: 2, failed: 0, errors: [] } },
        {
          objectApiName: 'Lead',
          counts: { done: 0, failed: 1, errors: [{ objectApiName: 'Lead', message: 'X' }] },
        },
      ]),
    ).toEqual({
      status: 'partial',
      done: 2,
      failed: 1,
      objects: [
        { objectApiName: 'Contact', done: 2, failed: 0 },
        { objectApiName: 'Lead', done: 0, failed: 1 },
      ],
      errors: [{ objectApiName: 'Lead', message: 'X' }],
    });
  });
});
