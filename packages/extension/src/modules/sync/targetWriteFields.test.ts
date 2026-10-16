import { describe, it, expect } from 'vitest';
import { targetWriteFieldsOf } from './targetWriteFields.js';

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
