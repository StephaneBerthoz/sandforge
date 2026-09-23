import { describe, it, expect } from 'vitest';
import { describedLookups } from './describedLookups.js';

describe('describedLookups', () => {
  it('keeps the lookups of a describe, with where they point and when they may be set', () => {
    const lookups = describedLookups([
      { name: 'Id', type: 'id', referenceTo: [], createable: false, updateable: false },
      {
        name: 'OwnerId',
        type: 'reference',
        referenceTo: ['Group', 'User'],
        createable: true,
        updateable: true,
      },
      {
        name: 'OpportunityId',
        type: 'reference',
        referenceTo: ['Opportunity'],
        createable: true,
        updateable: false,
      },
      { name: 'Name', type: 'string', referenceTo: [], createable: true, updateable: true },
    ]);

    expect(lookups).toEqual([
      { name: 'OwnerId', referenceTo: ['Group', 'User'], createable: true, updateable: true },
      { name: 'OpportunityId', referenceTo: ['Opportunity'], createable: true, updateable: false },
    ]);
  });

  it('reads a flag the describe leaves out as not settable', () => {
    expect(describedLookups([{ name: 'AccountId', referenceTo: ['Account'] }])).toEqual([
      { name: 'AccountId', referenceTo: ['Account'], createable: false, updateable: false },
    ]);
  });

  it('leaves out an entry of the wrong shape, and reads anything but a list as none', () => {
    expect(describedLookups([{ referenceTo: ['Account'] }, 'AccountId', null])).toEqual([]);
    expect(describedLookups(undefined)).toEqual([]);
  });
});
