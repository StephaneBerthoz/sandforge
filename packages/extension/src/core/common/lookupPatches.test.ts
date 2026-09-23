import { describe, it, expect } from 'vitest';
import { LookupPatchSet } from './lookupPatches.js';

describe('LookupPatchSet', () => {
  it('gathers the lookups one record owes into a single update', () => {
    const owed = new LookupPatchSet();

    owed.add({ objectApiName: 'Account', recordId: '001A', fieldName: 'ParentId', value: '001B' });
    owed.add({
      objectApiName: 'Account',
      recordId: '001A',
      fieldName: 'KeyContact__c',
      value: '003C',
    });

    expect(owed.updates()).toEqual([
      ['Account', [{ Id: '001A', ParentId: '001B', KeyContact__c: '003C' }]],
    ]);
  });

  it('keeps each object apart, and the records in the order they were owed', () => {
    const owed = new LookupPatchSet();

    owed.add({ objectApiName: 'Contact', recordId: '003B', fieldName: 'AccountId', value: '001A' });
    owed.add({ objectApiName: 'Account', recordId: '001A', fieldName: 'ParentId', value: '001P' });
    owed.add({ objectApiName: 'Contact', recordId: '003A', fieldName: 'AccountId', value: '001A' });

    expect(owed.updates()).toEqual([
      [
        'Contact',
        [
          { Id: '003B', AccountId: '001A' },
          { Id: '003A', AccountId: '001A' },
        ],
      ],
      ['Account', [{ Id: '001A', ParentId: '001P' }]],
    ]);
  });

  it('keeps the first value of a field owed two different ones, and says which it kept', () => {
    const owed = new LookupPatchSet();
    owed.add({ objectApiName: 'Task', recordId: '00TA', fieldName: 'WhatId', value: '001A' });

    const second = owed.add({
      objectApiName: 'Task',
      recordId: '00TA',
      fieldName: 'WhatId',
      value: '006B',
    });

    expect(second).toEqual({ taken: false, kept: '001A' });
    expect(owed.updates()).toEqual([['Task', [{ Id: '00TA', WhatId: '001A' }]]]);
  });

  it('takes the same value owed twice without calling it a conflict', () => {
    const owed = new LookupPatchSet();
    const patch = { objectApiName: 'Task', recordId: '00TA', fieldName: 'WhatId', value: '001A' };
    owed.add(patch);

    expect(owed.add(patch)).toEqual({ taken: true });
  });
});
