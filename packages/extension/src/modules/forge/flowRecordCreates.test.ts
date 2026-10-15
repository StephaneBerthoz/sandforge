import { describe, expect, it } from 'vitest';

import { recordCreatesOf } from './flowRecordCreates.js';

describe('recordCreatesOf', () => {
  it('names the object an element that sets the new record’s fields creates', () => {
    expect(
      recordCreatesOf({
        recordCreates: [
          { name: 'Create_Task', object: 'Task', inputAssignments: [] },
          { name: 'Create_Asset', object: 'Asset' },
        ],
      }),
    ).toEqual(['Task', 'Asset']);
  });

  it('reads the object of the variable an element creates the record of, a collection’s too', () => {
    expect(
      recordCreatesOf({
        variables: [
          { name: 'newRisk', dataType: 'SObject', objectType: 'Insured_Risk__c' },
          { name: 'Notes', dataType: 'SObject', objectType: 'Note', isCollection: true },
        ],
        recordCreates: [
          { name: 'Create_Risk', inputReference: 'NewRisk' },
          { name: 'Create_Notes', inputReference: 'notes' },
        ],
      }),
    ).toEqual(['Insured_Risk__c', 'Note']);
  });

  it('names each object once, whatever its case', () => {
    expect(
      recordCreatesOf({
        recordCreates: [
          { name: 'A', object: 'Task' },
          { name: 'B', object: 'task' },
        ],
      }),
    ).toEqual(['Task']);
  });

  it('names nothing for an element whose object cannot be told, or metadata without such elements', () => {
    expect(
      recordCreatesOf({
        recordCreates: [{ name: 'A', inputReference: 'unknownVariable' }, { name: 'B' }],
      }),
    ).toEqual([]);
    expect(recordCreatesOf({ actionCalls: [] })).toEqual([]);
    expect(recordCreatesOf(null)).toEqual([]);
    expect(recordCreatesOf('not metadata')).toEqual([]);
  });

  it('refuses a name that is not an API name', () => {
    expect(recordCreatesOf({ recordCreates: [{ name: 'A', object: "Task' OR Id != '" }] })).toEqual(
      [],
    );
  });
});
