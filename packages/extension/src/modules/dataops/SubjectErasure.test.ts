import { describe, it, expect, vi } from 'vitest';

import { PIIDetector } from '../../core/precheck/PIIDetector.js';
import { AnonymizationEngine } from './AnonymizationEngine.js';
import { prepareErasure, runErasure } from './SubjectErasure.js';

/** A contact describe the connected user may edit and delete. */
const contactDescribe = {
  name: 'Contact',
  label: 'Contact',
  queryable: true,
  updateable: true,
  deletable: true,
  fields: [
    { name: 'Id', label: 'Contact ID', type: 'id', updateable: false },
    { name: 'Name', label: 'Full Name', type: 'string', nameField: true, updateable: false },
    { name: 'FirstName', label: 'First Name', type: 'string', updateable: true, nillable: true },
    { name: 'LastName', label: 'Last Name', type: 'string', updateable: true, nillable: false },
    { name: 'Email', label: 'Email', type: 'email', updateable: true, nillable: true },
    {
      name: 'AssistantPhone',
      label: 'Asst. Phone',
      type: 'phone',
      updateable: true,
      nillable: true,
    },
    { name: 'Title', label: 'Title', type: 'string', updateable: true, nillable: true },
  ],
  childRelationships: [
    { childSObject: 'Task', field: 'WhoId', cascadeDelete: true },
    { childSObject: 'ContactHistory', field: 'ContactId', cascadeDelete: true },
    { childSObject: 'Case', field: 'ContactId', cascadeDelete: false },
  ],
};

/** Two contacts found by a search, one with an assistant's number and one without. */
const found = [
  {
    Id: '003000000000001AAA',
    FirstName: 'Jane',
    LastName: 'Doe',
    Email: 'jane@example.com',
    AssistantPhone: '+33 1 00 00 00 01',
    Title: 'Buyer',
  },
  {
    Id: '003000000000002AAA',
    FirstName: null,
    LastName: 'Doe',
    Email: 'jane.doe@example.com',
    AssistantPhone: null,
    Title: null,
  },
];

function org(describe: unknown = contactDescribe) {
  const update = vi.fn(async (_name: string, records: Array<Record<string, unknown>>) =>
    records.map((r) => ({ success: true, id: r.Id })),
  );
  const destroy = vi.fn(
    async (_name: string, ids: string[]): Promise<unknown[]> =>
      ids.map((id) => ({ success: true, id })),
  );
  const query = vi.fn(async (soql: string) => {
    if (soql.startsWith('SELECT COUNT() FROM Task')) return { totalSize: 3, records: [] };
    if (soql.startsWith('SELECT COUNT()')) return { totalSize: 0, records: [] };
    return { totalSize: found.length, records: found };
  });
  return {
    describe: vi.fn(async () => describe),
    describeGlobal: vi.fn(async () => ({
      sobjects: [
        { name: 'Task', label: 'Task', queryable: true, createable: true, layoutable: true },
        { name: 'ContactHistory', label: 'Contact History', queryable: true, createable: false },
      ],
    })),
    query,
    update,
    destroy,
  };
}

const targets = [{ objectApiName: 'Contact', ids: ['003000000000001AAA', '003000000000002AAA'] }];

describe('prepareErasure', () => {
  it('plans to overwrite the fields holding personal data, and the name through its parts', async () => {
    const [contact] = await prepareErasure(org(), new PIIDetector(), 'anonymize', targets);

    expect(contact.plan).toMatchObject({ objectApiName: 'Contact', records: 2, kept: [] });
    expect(contact.plan.fields).toEqual(
      expect.arrayContaining([
        { fieldApiName: 'Email', label: 'Email', method: 'fake' },
        { fieldApiName: 'AssistantPhone', label: 'Asst. Phone', method: 'nullify' },
        { fieldApiName: 'FirstName', label: 'First Name', method: 'fake' },
        { fieldApiName: 'LastName', label: 'Last Name', method: 'fake' },
      ]),
    );
    // A title is no one's personal data by name, type or value.
    expect(contact.plan.fields?.map((f) => f.fieldApiName)).not.toContain('Title');
  });

  it('plans a delete with what the org deletes along with it, from the objects people work with', async () => {
    const conn = org();

    const [contact] = await prepareErasure(conn, new PIIDetector(), 'delete', targets);

    expect(contact.plan).toMatchObject({
      records: 2,
      related: [{ objectApiName: 'Task', label: 'Task', records: 3 }],
      uncounted: [],
    });
    // The history the org keeps for itself is not counted, nor a lookup that does not cascade.
    const counted = conn.query.mock.calls.map(([soql]) => soql);
    expect(counted.some((soql) => soql.includes('ContactHistory'))).toBe(false);
    expect(counted.some((soql) => soql.includes('FROM Case'))).toBe(false);
  });

  it('refuses an object the connected user may not edit, and writes nothing to it', async () => {
    const conn = org({ ...contactDescribe, updateable: false });

    const prepared = await prepareErasure(conn, new PIIDetector(), 'anonymize', targets);
    await runErasure(conn, new AnonymizationEngine(undefined, 'k'), prepared);

    expect(prepared[0].plan.refused).toBe('The connected user may not edit Contact records.');
    expect(conn.update).not.toHaveBeenCalled();
  });

  it('refuses a delete the connected user may not make', async () => {
    const conn = org({ ...contactDescribe, deletable: false });

    const [contact] = await prepareErasure(conn, new PIIDetector(), 'delete', targets);

    expect(contact.plan.refused).toBe('The connected user may not delete Contact records.');
  });
});

describe('runErasure', () => {
  it('overwrites only the fields that held something, and sends nothing else back', async () => {
    const conn = org();
    const prepared = await prepareErasure(conn, new PIIDetector(), 'anonymize', targets);

    const [result] = await runErasure(conn, new AnonymizationEngine(undefined, 'k'), prepared);

    expect(result.counts).toMatchObject({ done: 2, failed: 0 });
    const [, sent] = conn.update.mock.calls[0];
    const [first, second] = sent;
    expect(Object.keys(first).sort()).toEqual(
      ['AssistantPhone', 'Email', 'FirstName', 'Id', 'LastName'].sort(),
    );
    expect(first.Email).not.toBe('jane@example.com');
    expect(first.AssistantPhone).toBeNull();
    expect(first.Title).toBeUndefined();
    // An empty first name stays empty: a made-up one would be data the record never had.
    expect(Object.keys(second).sort()).toEqual(['Email', 'Id', 'LastName']);
  });

  it('deletes the records found, and counts what the org refuses', async () => {
    const conn = org();
    conn.destroy.mockImplementationOnce(async (_name: string, ids: string[]) => [
      { success: true, id: ids[0] },
      { success: false, errors: [{ message: 'DELETE_FAILED: associated with cases' }] },
    ]);
    const prepared = await prepareErasure(conn, new PIIDetector(), 'delete', targets);

    const [result] = await runErasure(conn, new AnonymizationEngine(undefined, 'k'), prepared);

    expect(conn.destroy).toHaveBeenCalledWith('Contact', targets[0].ids);
    expect(result.counts).toEqual({
      done: 1,
      failed: 1,
      errors: [{ objectApiName: 'Contact', message: 'DELETE_FAILED: associated with cases' }],
    });
  });
});
