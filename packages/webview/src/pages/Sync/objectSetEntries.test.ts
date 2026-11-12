import { describe, expect, it } from 'vitest';
import { configObjects, objectSetEntryOf } from './objectSetEntries';

describe('configObjects', () => {
  it('keeps the objects that name their object, and reads no list as none', () => {
    expect(
      configObjects({ objects: [{ objectApiName: 'Account' }, { operation: 'insert' }, null, 7] }),
    ).toEqual([{ objectApiName: 'Account' }]);
    expect(configObjects({ objects: 'Account' })).toEqual([]);
    expect(configObjects({})).toEqual([]);
  });
});

describe('objectSetEntryOf', () => {
  it('shows an object with its operation, key, batch size and filter, a delete as one', () => {
    expect(
      objectSetEntryOf({
        objectApiName: 'Case',
        operation: 'delete',
        externalIdField: 'Legacy_Key__c',
        batchSize: 50,
        where: "Status = 'Closed'",
      }),
    ).toEqual({
      objectApiName: 'Case',
      operation: 'delete',
      externalIdField: 'Legacy_Key__c',
      batchSize: 50,
      where: "Status = 'Closed'",
    });
  });

  it('shows what an object does not say as the editor starts a row', () => {
    expect(objectSetEntryOf({ objectApiName: 'Account' })).toEqual({
      objectApiName: 'Account',
      operation: 'insert',
      externalIdField: '',
      batchSize: 200,
      where: '',
    });
  });
});
