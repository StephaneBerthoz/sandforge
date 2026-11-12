import { describe, it, expect } from 'vitest';
import { targetAccessOf, targetWriteFieldsOf, withFieldsOfItsQuery } from './targetWriteFields.js';
import type { SyncObjectConfig } from '@sandforge/shared';

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

  it('reads the fields an upsert may match on from what the describe says of each, in lower case', () => {
    const { upsertKeys } = targetWriteFieldsOf({
      fields: [
        { name: 'Id', idLookup: true, externalId: false },
        { name: 'Name', idLookup: false, externalId: false },
        { name: 'Legacy_Key__c', idLookup: true, externalId: true },
      ],
    });

    expect([...(upsertKeys ?? [])].sort()).toEqual(['id', 'legacy_key__c']);
    expect(targetWriteFieldsOf({ fields: [{ name: 'Name' }] })).not.toHaveProperty('upsertKeys');
  });

  it('reads the key of an upsert in any case, and no key as the Id, as the org does', async () => {
    const keyed = async () =>
      targetWriteFieldsOf({
        fields: [
          { name: 'Id', idLookup: true },
          { name: 'Legacy_Key__c', externalId: true, idLookup: true },
        ],
      });

    for (const key of ['legacy_key__C', 'Legacy_Key__c', 'ID', undefined, '  ']) {
      expect(await targetAccessOf(keyed, 'Case', 'upsert', key)).not.toHaveProperty('refused');
    }
  });

  it('refuses an upsert on a field the target matches none on, once it may write the object at all', async () => {
    const keyed = async () =>
      targetWriteFieldsOf({
        createable: false,
        fields: [{ name: 'Name', idLookup: false }],
      });

    expect(await targetAccessOf(keyed, 'Case', 'upsert', 'Name')).toMatchObject({
      refused: { why: 'notCreateable' },
    });
    expect(
      await targetAccessOf(
        async () => ({ ...(await keyed()), objectCreateable: true }),
        'Case',
        'upsert',
        'Name',
      ),
    ).toMatchObject({ refused: { why: 'notAKey', key: 'Name' } });
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

describe('withFieldsOfItsQuery', () => {
  const target = targetWriteFieldsOf({
    fields: ['Name', 'Phone', 'Industry', 'Ext__c', 'BillingCity', 'ShippingCity', 'OwnerId'].map(
      (name) => ({ name, createable: true, type: 'string' }),
    ),
  });
  const account = (operation: SyncObjectConfig['operation'], query?: string): SyncObjectConfig => ({
    objectApiName: 'Account',
    operation,
    ...(query !== undefined ? { query } : {}),
    fieldMappings: [],
    transformRules: [],
    excludedFields: ['Phone'],
    addOnFields: [],
    batchSize: 200,
    insertOrder: 0,
  });

  it('leaves out every field the target takes that the query does not select', () => {
    const written = withFieldsOfItsQuery(account('insert', 'SELECT Id, Name FROM Account'), target);

    expect(written.excludedFields).toEqual([
      'Phone',
      'Industry',
      'Ext__c',
      'BillingCity',
      'ShippingCity',
      'OwnerId',
    ]);
  });

  it('keeps the field an upsert matches on, and the source field of a mapping', () => {
    const written = withFieldsOfItsQuery(
      {
        ...account('upsert', 'SELECT Name FROM Account'),
        externalIdField: 'Ext__c',
        fieldMappings: [
          { sourceField: 'BillingCity', targetField: 'ShippingCity', type: 'rename' },
          { sourceField: 'Retail', targetField: 'Industry', type: 'constant' },
        ],
      },
      target,
    );

    expect(written.excludedFields).toEqual(['Phone', 'Industry', 'ShippingCity', 'OwnerId']);
  });

  it.each([
    ['no query', account('insert')],
    ['a query of Id alone', account('insert', 'SELECT Id FROM Account')],
    ['a query of SFDMU’s all', account('upsert', 'SELECT all FROM Account')],
    ['a keyword', account('update', 'SELECT Name, custom_true FROM Account')],
    ['a delete', account('delete', 'SELECT Id, Name FROM Account')],
  ])('changes nothing of an object with %s', (_label, objectConfig) => {
    expect(withFieldsOfItsQuery(objectConfig, target)).toBe(objectConfig);
  });
});
