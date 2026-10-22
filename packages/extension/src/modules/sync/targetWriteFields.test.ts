import { describe, it, expect } from 'vitest';
import { targetAccessOf, targetWriteFieldsOf } from './targetWriteFields.js';

describe('targetWriteFieldsOf', () => {
  it('reads the writable fields, the lookups among them and the record types from one describe', () => {
    const fields = targetWriteFieldsOf({
      fields: [
        { name: 'Id', createable: false, type: 'id' },
        { name: 'Name', createable: true, type: 'string' },
        { name: 'ParentId', createable: true, type: 'reference' },
        { name: 'CreatedById', createable: false, type: 'reference' },
        { name: 'RecordTypeId', createable: true, type: 'reference' },
      ],
      recordTypeInfos: [
        {
          active: true,
          available: false,
          defaultRecordTypeMapping: false,
          developerName: 'Partner',
          master: false,
          name: 'Partner',
          recordTypeId: '012Fk00000RtDeFIAV',
          urls: {},
        },
      ],
    });

    expect([...fields.creatable].sort()).toEqual(['Name', 'ParentId', 'RecordTypeId']);
    expect([...fields.references].sort()).toEqual(['ParentId', 'RecordTypeId']);
    expect(fields.recordTypes?.map((r) => [r.developerName, r.available])).toEqual([
      ['Partner', false],
    ]);
  });

  it('reads no record type from a describe that carries none', () => {
    expect(
      targetWriteFieldsOf({ fields: [{ name: 'Name', createable: true }] }).recordTypes,
    ).toEqual([]);
  });

  it('says of the account whether the target has person accounts, and of no other object', () => {
    const withPersons = targetWriteFieldsOf({
      name: 'Account',
      fields: [
        { name: 'Name', createable: true, type: 'string' },
        { name: 'PersonContactId', createable: false, type: 'reference' },
      ],
    });
    const without = targetWriteFieldsOf({
      name: 'Account',
      fields: [{ name: 'Name', createable: true, type: 'string' }],
    });
    const contact = targetWriteFieldsOf({
      name: 'Contact',
      fields: [{ name: 'LastName', createable: true, type: 'string' }],
    });

    expect(withPersons.personAccounts).toBe(true);
    expect(without.personAccounts).toBe(false);
    expect(contact.personAccounts).toBeUndefined();
  });

  it('keeps what a simulation checks a row against: what is required, how long, how many places', () => {
    const fields = targetWriteFieldsOf({
      name: 'Account',
      fields: [
        {
          name: 'Region__c',
          createable: true,
          type: 'string',
          nillable: false,
          defaultedOnCreate: false,
          length: 20,
        },
        { name: 'Score__c', createable: true, type: 'double', precision: 4, scale: 1 },
        { name: 'ParentId', createable: true, type: 'reference', referenceTo: ['Account'] },
      ],
    }).fields;

    expect(fields).toEqual([
      {
        name: 'Region__c',
        queryable: true,
        createable: true,
        isReference: false,
        type: 'string',
        length: 20,
        nillable: false,
        defaultedOnCreate: false,
      },
      {
        name: 'Score__c',
        queryable: true,
        createable: true,
        isReference: false,
        type: 'double',
        precision: 4,
        scale: 1,
      },
      {
        name: 'ParentId',
        queryable: true,
        createable: true,
        isReference: true,
        type: 'reference',
        referenceTo: ['Account'],
      },
    ]);
  });
});

describe('targetAccessOf', () => {
  const described = (access: { createable?: boolean; updateable?: boolean }) => async () =>
    targetWriteFieldsOf({
      name: 'Case',
      ...access,
      fields: [{ name: 'Subject', createable: true }],
    });

  it('reads from the describe whether the user may create and edit the object at all', () => {
    expect(targetWriteFieldsOf({ createable: false, updateable: true, fields: [] })).toMatchObject({
      objectCreateable: false,
      objectUpdateable: true,
    });
  });

  it('refuses an insert or an upsert of an object the user may not create, and an update or an upsert of one it may not edit', async () => {
    expect(await targetAccessOf(described({ createable: false }), 'Case', 'insert')).toMatchObject({
      refused: { why: 'notCreateable' },
    });
    expect(await targetAccessOf(described({ createable: false }), 'Case', 'upsert')).toMatchObject({
      refused: { why: 'notCreateable' },
    });
    expect(await targetAccessOf(described({ updateable: false }), 'Case', 'update')).toMatchObject({
      refused: { why: 'notUpdateable' },
    });
    expect(
      await targetAccessOf(described({ createable: false }), 'Case', 'update'),
    ).not.toHaveProperty('refused');
    expect(await targetAccessOf(described({}), 'Case', 'upsert')).not.toHaveProperty('refused');
  });

  it('tells an object the target has not, or hides, from a describe that failed for another reason', async () => {
    const notFound = Object.assign(new Error('The requested resource does not exist'), {
      errorCode: 'NOT_FOUND',
    });
    expect(
      await targetAccessOf(() => Promise.reject(notFound), 'Invoice__c', 'insert'),
    ).toMatchObject({
      refused: { why: 'notInTarget' },
    });
    expect(
      await targetAccessOf(() => Promise.reject(new Error('socket hang up')), 'Case', 'insert'),
    ).toMatchObject({
      refused: { why: 'unread', message: expect.stringContaining('socket hang up') as unknown },
    });
  });

  it('refuses no delete: it sends ids alone', async () => {
    expect(await targetAccessOf(() => Promise.reject(new Error('down')), 'Case', 'delete')).toEqual(
      {
        notAsked: true,
      },
    );
  });
});
