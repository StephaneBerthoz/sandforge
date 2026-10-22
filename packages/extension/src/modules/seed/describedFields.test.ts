import { describe, it, expect, vi } from 'vitest';
import { describedFieldsOf, type SeedDescribe } from './describedFields';

const ACCOUNT: SeedDescribe = {
  fields: [
    { name: 'Name', type: 'string', createable: true },
    { name: 'Id', type: 'id', createable: false },
    {
      name: 'Type',
      type: 'picklist',
      createable: true,
      picklistValues: [
        { value: 'Prospect', active: true },
        { value: 'Retired', active: false },
        { value: 'Customer - Direct', active: true },
      ],
    },
    { name: 'Tags__c', type: 'multipicklist', createable: true, picklistValues: [{ value: 'A' }] },
    { name: 'Rating', type: 'picklist', createable: true, picklistValues: [] },
    { name: 'Subject', type: 'combobox', createable: true, picklistValues: [{ value: 'Call' }] },
  ],
};

describe('describedFieldsOf', () => {
  it('reads the fields a write takes, and the active values of each picklist', async () => {
    const fields = describedFieldsOf(async () => ACCOUNT);
    expect([...(await fields.createable('Account'))]).toEqual([
      'Name',
      'Type',
      'Tags__c',
      'Rating',
      'Subject',
    ]);
    expect(Object.fromEntries(await fields.picklistValues('Account'))).toEqual({
      Type: ['Prospect', 'Customer - Direct'],
      Tags__c: ['A'],
    });
  });

  it('reads every field the describe lists, settable or not', async () => {
    const fields = describedFieldsOf(async () => ACCOUNT);
    expect([...(await fields.visible('Account'))]).toEqual([
      'Name',
      'Id',
      'Type',
      'Tags__c',
      'Rating',
      'Subject',
    ]);
  });

  it('reads the fields the org refuses a record without, lookups and defaulted fields apart', async () => {
    const fields = describedFieldsOf(async () => ({
      fields: [
        { name: 'Name', type: 'string', createable: true, nillable: false, length: 255 },
        { name: 'Region__c', type: 'string', createable: true, nillable: false, length: 40 },
        {
          name: 'Tier__c',
          type: 'picklist',
          createable: true,
          nillable: false,
          picklistValues: [{ value: 'Gold' }],
        },
        {
          name: 'Score__c',
          type: 'double',
          createable: true,
          nillable: false,
          precision: 4,
          scale: 2,
        },
        {
          name: 'IsActive__c',
          type: 'boolean',
          createable: true,
          nillable: false,
          defaultedOnCreate: true,
        },
        {
          name: 'OwnerId',
          type: 'reference',
          createable: true,
          nillable: false,
          referenceTo: ['User'],
        },
        { name: 'Site', type: 'string', createable: true, nillable: true },
        { name: 'Id', type: 'id', createable: false, nillable: false },
      ],
    }));
    expect(await fields.required('Account')).toEqual([
      expect.objectContaining({
        fieldApiName: 'Name',
        type: 'string',
        length: 255,
        required: true,
      }),
      expect.objectContaining({ fieldApiName: 'Region__c', length: 40, objectApiName: 'Account' }),
      expect.objectContaining({ fieldApiName: 'Tier__c', picklistValues: ['Gold'] }),
      expect.objectContaining({ fieldApiName: 'Score__c', integerDigits: 2 }),
    ]);
  });

  it('describes each object once for the run', async () => {
    const describe = vi.fn(async (_objectApiName: string) => ACCOUNT);
    const fields = describedFieldsOf(describe);
    await fields.createable('Account');
    await fields.picklistValues('Account');
    await fields.createable('Contact');
    expect(describe.mock.calls.map(([name]) => name)).toEqual(['Account', 'Contact']);
  });

  it('fails each read of an object its describe fails for', async () => {
    const fields = describedFieldsOf(async () => Promise.reject(new Error('NOT_FOUND')));
    await expect(fields.createable('Knowledge__kav')).rejects.toThrow('NOT_FOUND');
    await expect(fields.picklistValues('Knowledge__kav')).rejects.toThrow('NOT_FOUND');
  });
});
