import { describe, it, expect, vi } from 'vitest';
import type { SubjectSearchObjectResult } from '@sandforge/shared';

import { phoneLikePattern, phoneTail, searchSubject } from './SubjectSearch.js';

/** A contact describe with one email, two phones and its name. */
const contactDescribe = {
  name: 'Contact',
  label: 'Contact',
  queryable: true,
  fields: [
    { name: 'Id', label: 'Contact ID', type: 'id', filterable: true },
    { name: 'Name', label: 'Full Name', type: 'string', nameField: true, filterable: true },
    { name: 'Email', label: 'Email', type: 'email', filterable: true },
    { name: 'Phone', label: 'Business Phone', type: 'phone', filterable: true },
    { name: 'MobilePhone', label: 'Mobile', type: 'phone', filterable: true },
  ],
};

/** An object that holds nothing a person is found by. */
const productDescribe = {
  name: 'Product2',
  label: 'Product',
  queryable: true,
  fields: [{ name: 'ProductCode', label: 'Product Code', type: 'string', filterable: true }],
};

function org(records: unknown[], counted = records.length) {
  const query = vi.fn(async (soql: string) => {
    if (soql.startsWith('SELECT COUNT()')) return { totalSize: counted, records: [] };
    return { totalSize: records.length, records };
  });
  const describe = vi.fn(async (name: string) =>
    name === 'Product2' ? productDescribe : contactDescribe,
  );
  return { describe, query };
}

describe('searchSubject', () => {
  it('counts first, and reads nothing from an object that holds none of it', async () => {
    const conn = org([], 0);

    const [contact] = await searchSubject(conn, {
      objects: ['Contact'],
      identifiers: { email: 'jane@example.com' },
      limit: 200,
    });

    expect(conn.query).toHaveBeenCalledTimes(1);
    expect(conn.query.mock.calls[0][0]).toBe(
      "SELECT COUNT() FROM Contact WHERE Email = 'jane@example.com'",
    );
    expect(contact).toMatchObject({ status: 'searched', counted: 0, records: [] });
  });

  it('lists what it found, with the fields each record matched on', async () => {
    const conn = org([
      { Id: '003000000000001AAA', Name: 'Jane Doe', Email: 'JANE@example.com', Phone: null },
      { Id: '003000000000002AAA', Name: 'Jane Doe', Email: 'other@example.com', Phone: null },
    ]);

    const [contact] = (await searchSubject(conn, {
      objects: ['Contact'],
      identifiers: { email: 'jane@example.com', name: 'jane doe' },
      limit: 200,
    })) as SubjectSearchObjectResult[];

    expect(conn.query.mock.calls[1][0]).toBe(
      "SELECT Id, Name, Email FROM Contact WHERE Email = 'jane@example.com' OR Name = 'jane doe' " +
        'ORDER BY Id LIMIT 200',
    );
    expect(contact.records).toEqual([
      { id: '003000000000001AAA', name: 'Jane Doe', matchedBy: ['Email', 'Name'] },
      { id: '003000000000002AAA', name: 'Jane Doe', matchedBy: ['Name'] },
    ]);
    expect(contact.searched.map((s) => `${s.fieldApiName}:${s.kind}`)).toEqual([
      'Email:email',
      'Name:name',
    ]);
  });

  it('finds a number however it was typed, and leaves out what only holds its digits apart', async () => {
    const conn = org([
      { Id: '003000000000001AAA', Name: 'A', Phone: '+33 1 23 45 67 89', MobilePhone: null },
      { Id: '003000000000002AAA', Name: 'B', Phone: null, MobilePhone: '01.23.45.67.89' },
      // Every digit, in order, with others between: what the pattern lets through.
      { Id: '003000000000003AAA', Name: 'C', Phone: '2 0 3 4 5 6 7 8 9 9', MobilePhone: null },
    ]);

    const [contact] = (await searchSubject(conn, {
      objects: ['Contact'],
      identifiers: { phone: '0123456789' },
      limit: 200,
    })) as SubjectSearchObjectResult[];

    expect(conn.query.mock.calls[0][0]).toBe(
      "SELECT COUNT() FROM Contact WHERE Phone LIKE '%2%3%4%5%6%7%8%9%' OR " +
        "MobilePhone LIKE '%2%3%4%5%6%7%8%9%'",
    );
    expect(contact.counted).toBe(3);
    expect(contact.records.map((r) => r.id)).toEqual(['003000000000001AAA', '003000000000002AAA']);
  });

  it('writes a quote in a name so the query stays one condition', async () => {
    const conn = org([], 0);

    await searchSubject(conn, {
      objects: ['Contact'],
      identifiers: { name: "Jane O'Hara' OR Name != '" },
      limit: 200,
    });

    expect(conn.query.mock.calls[0][0]).toBe(
      "SELECT COUNT() FROM Contact WHERE Name = 'Jane O\\'Hara\\' OR Name != \\''",
    );
  });

  it('says when more records matched than it lists', async () => {
    const conn = org([{ Id: '003000000000001AAA', Name: 'A', Email: 'jane@example.com' }], 350);

    const [contact] = (await searchSubject(conn, {
      objects: ['Contact'],
      identifiers: { email: 'jane@example.com' },
      limit: 1,
    })) as SubjectSearchObjectResult[];

    expect(contact).toMatchObject({ counted: 350, truncated: true });
  });

  it('skips an object that has no field to look in for what it was given', async () => {
    const conn = org([]);

    const [product] = await searchSubject(conn, {
      objects: ['Product2'],
      identifiers: { email: 'jane@example.com' },
      limit: 200,
    });

    expect(product).toEqual({ status: 'skipped', objectApiName: 'Product2', label: 'Product' });
    expect(conn.query).not.toHaveBeenCalled();
  });

  it('fails one object the org refuses, and searches the others', async () => {
    const conn = org([], 0);
    conn.describe.mockImplementationOnce(async () => {
      throw new Error('INVALID_TYPE: sObject type is not supported.');
    });

    const results = await searchSubject(conn, {
      objects: ['Nope__c', 'Contact'],
      identifiers: { email: 'jane@example.com' },
      limit: 200,
    });

    expect(results.map((r) => r.status)).toEqual(['failed', 'searched']);
  });

  it('takes what was searched for out of a refusal that quotes the query', async () => {
    const conn = org([]);
    conn.query.mockImplementationOnce(async () => {
      throw new Error(
        "INVALID_FIELD: FROM Contact WHERE Email = 'Jane@Example.com' ^ ERROR at Row:1:Column:30",
      );
    });

    const [contact] = await searchSubject(conn, {
      objects: ['Contact'],
      identifiers: { email: 'jane@example.com' },
      limit: 200,
    });

    expect(contact).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(contact)).not.toMatch(/jane@example\.com/i);
  });

  it('compares the last digits of a number, with anything between them', () => {
    expect(phoneTail('+33 (0)1 23 45 67 89')).toBe('23456789');
    expect(phoneTail('123-4567')).toBe('1234567');
    expect(phoneLikePattern('123')).toBe('%1%2%3%');
  });
});
