import { describe, it, expect } from 'vitest';
import type { SyncObjectConfig } from '@sandforge/shared';
import { lookupsOf, orderSyncObjects, type WriteLookup } from './syncWriteOrder.js';
import { targetWriteFieldsOf } from './targetWriteFields.js';

const object = (
  objectApiName: string,
  insertOrder: number,
  overrides: Partial<SyncObjectConfig> = {},
): SyncObjectConfig => ({
  objectApiName,
  operation: 'insert',
  fieldMappings: [],
  transformRules: [],
  excludedFields: [],
  addOnFields: [],
  batchSize: 200,
  insertOrder,
  ...overrides,
});

const lookup = (field: string, ...referenceTo: string[]): WriteLookup => ({ field, referenceTo });

describe('orderSyncObjects', () => {
  it('writes the parent a lookup names before the object added before it', () => {
    // Added in the list's alphabetical order: Account, Case, Contact.
    const { ordered, order } = orderSyncObjects(
      [object('Account', 0), object('Case', 1), object('Contact', 2)],
      new Map([
        ['Case', [lookup('AccountId', 'Account'), lookup('ContactId', 'Contact')]],
        ['Contact', [lookup('AccountId', 'Account')]],
      ]),
    );

    expect(ordered.map((o) => o.objectApiName)).toEqual(['Account', 'Contact', 'Case']);
    expect(order.objects).toEqual(['Account', 'Contact', 'Case']);
    expect(order.moved).toEqual([{ objectApiName: 'Case', after: 'Contact', field: 'ContactId' }]);
    expect(order.cycles).toEqual([]);
  });

  it('keeps the order of the configuration where no lookup decides', () => {
    const { order } = orderSyncObjects(
      [object('Lead', 0), object('Product2', 1), object('Account', 2)],
      new Map(),
    );

    expect(order.objects).toEqual(['Lead', 'Product2', 'Account']);
    expect(order.moved).toEqual([]);
  });

  it('reads the order from insertOrder, whatever order the objects come in', () => {
    const { order } = orderSyncObjects(
      [object('Contact', 1), object('Account', 0)],
      new Map([['Contact', [lookup('AccountId', 'Account')]]]),
    );

    expect(order.objects).toEqual(['Account', 'Contact']);
    expect(order.moved).toEqual([]);
  });

  it('writes the objects of a cycle in the order listed, after the parents outside it', () => {
    // Account and Contact name each other; Opportunity names the account,
    // and the pricebook comes first for no lookup at all.
    const { order } = orderSyncObjects(
      [
        object('Opportunity', 0),
        object('Contact', 1),
        object('Account', 2),
        object('Pricebook2', 3),
      ],
      new Map([
        ['Opportunity', [lookup('AccountId', 'Account')]],
        ['Contact', [lookup('AccountId', 'Account')]],
        ['Account', [lookup('Primary_Contact__c', 'Contact')]],
      ]),
    );

    expect(order.objects).toEqual(['Contact', 'Account', 'Opportunity', 'Pricebook2']);
    expect(order.cycles).toEqual([['Contact', 'Account']]);
    expect(order.moved).toEqual([
      { objectApiName: 'Opportunity', after: 'Account', field: 'AccountId' },
    ]);
  });

  it('ignores a lookup of an object at itself, which its write sets on a second pass', () => {
    const { order } = orderSyncObjects(
      [object('Account', 0), object('Contact', 1)],
      new Map([
        ['Account', [lookup('ParentId', 'Account')]],
        ['Contact', [lookup('AccountId', 'Account'), lookup('ReportsToId', 'Contact')]],
      ]),
    );

    expect(order.objects).toEqual(['Account', 'Contact']);
    expect(order.cycles).toEqual([]);
  });

  it('follows a lookup that may name several objects to each the run writes', () => {
    const { order } = orderSyncObjects(
      [object('Task', 0), object('Lead', 1), object('Opportunity', 2)],
      new Map([
        ['Task', [lookup('WhoId', 'Contact', 'Lead'), lookup('WhatId', 'Account', 'Opportunity')]],
      ]),
    );

    expect(order.objects).toEqual(['Lead', 'Opportunity', 'Task']);
    expect(order.moved).toEqual([{ objectApiName: 'Task', after: 'Opportunity', field: 'WhatId' }]);
  });

  it('orders neither by nor around an object the run deletes', () => {
    const { order } = orderSyncObjects(
      [object('Contact', 0), object('Account', 1, { operation: 'delete' })],
      new Map([['Contact', [lookup('AccountId', 'Account')]]]),
    );

    expect(order.objects).toEqual(['Contact', 'Account']);
    expect(order.moved).toEqual([]);
  });
});

describe('lookupsOf', () => {
  const target = targetWriteFieldsOf({
    name: 'Case',
    fields: [
      { name: 'Id', createable: false, type: 'id' },
      { name: 'Subject', createable: true, type: 'string' },
      { name: 'AccountId', createable: true, type: 'reference', referenceTo: ['Account'] },
      { name: 'ContactId', createable: true, type: 'reference', referenceTo: ['Contact'] },
      { name: 'RecordTypeId', createable: true, type: 'reference', referenceTo: ['RecordType'] },
      { name: 'MasterRecordId', createable: false, type: 'reference', referenceTo: ['Case'] },
    ],
  });

  it('names every lookup the running user may write when the object maps nothing', () => {
    expect(lookupsOf(object('Case', 0), target)).toEqual([
      lookup('AccountId', 'Account'),
      lookup('ContactId', 'Contact'),
    ]);
  });

  it('names only the lookups its mappings and add-ons write when it has any', () => {
    const mapped = object('Case', 0, {
      fieldMappings: [
        { sourceField: 'Subject', targetField: 'Subject', type: 'direct' },
        { sourceField: 'AccountId', targetField: 'AccountId', type: 'exclude' },
      ],
      addOnFields: [{ fieldApiName: 'ContactId', value: '', overwriteExisting: true }],
    });

    expect(lookupsOf(mapped, target)).toEqual([lookup('ContactId', 'Contact')]);
  });

  it('names none for a delete, which writes no field', () => {
    expect(lookupsOf(object('Case', 0, { operation: 'delete' }), target)).toEqual([]);
  });
});
