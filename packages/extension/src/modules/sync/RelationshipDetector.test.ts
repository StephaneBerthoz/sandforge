import { describe, it, expect } from 'vitest';
import { RelationshipDetector } from './RelationshipDetector.js';
import type { DescribeFieldInfo } from './RelationshipDetector.js';

describe('RelationshipDetector', () => {
  const detector = new RelationshipDetector();

  const opportunityFields: DescribeFieldInfo[] = [
    { name: 'Id', type: 'id', referenceTo: [], relationshipName: null },
    { name: 'Name', type: 'string', referenceTo: [], relationshipName: null },
    { name: 'AccountId', type: 'reference', referenceTo: ['Account'], relationshipName: 'Account' },
    {
      name: 'OwnerId',
      type: 'reference',
      referenceTo: ['User', 'Group'],
      relationshipName: 'Owner',
    },
    { name: 'Amount', type: 'currency', referenceTo: [], relationshipName: null },
  ];

  it('detects Account as parent of Opportunity via AccountId field', () => {
    const suggestions = detector.detect(
      'Opportunity',
      opportunityFields,
      [],
      ['Account', 'User', 'Group'],
    );

    const accountSugg = suggestions.find((s) => s.parentObject === 'Account');
    expect(accountSugg).toBeDefined();
    expect(accountSugg?.lookupField).toBe('AccountId');
    expect(accountSugg?.childObject).toBe('Opportunity');
    expect(accountSugg?.suggestedInsertOrder).toBe(0);
  });

  it('skips self-references', () => {
    const accountFields: DescribeFieldInfo[] = [
      { name: 'ParentId', type: 'reference', referenceTo: ['Account'], relationshipName: 'Parent' },
    ];

    const suggestions = detector.detect('Account', accountFields, [], ['Account']);

    expect(suggestions).toHaveLength(0);
  });

  it('skips already-selected parent objects', () => {
    const suggestions = detector.detect(
      'Opportunity',
      opportunityFields,
      ['Account'],
      ['Account', 'User', 'Group'],
    );

    const accountSugg = suggestions.find((s) => s.parentObject === 'Account');
    expect(accountSugg).toBeUndefined();
  });

  it('returns empty for objects with no reference fields', () => {
    const fields: DescribeFieldInfo[] = [
      { name: 'Id', type: 'id', referenceTo: [], relationshipName: null },
      { name: 'Name', type: 'string', referenceTo: [], relationshipName: null },
      { name: 'Email', type: 'email', referenceTo: [], relationshipName: null },
    ];

    const suggestions = detector.detect('Lead', fields, [], ['Account', 'Contact']);
    expect(suggestions).toHaveLength(0);
  });

  it('skips unavailable parent objects', () => {
    const suggestions = detector.detect(
      'Opportunity',
      opportunityFields,
      [],
      [], // No objects available
    );

    expect(suggestions).toHaveLength(0);
  });

  it('detects multiple parent suggestions from polymorphic fields', () => {
    const suggestions = detector.detect(
      'Opportunity',
      opportunityFields,
      [],
      ['Account', 'User', 'Group'],
    );

    // AccountId -> Account, OwnerId -> User and Group
    expect(suggestions.length).toBeGreaterThanOrEqual(3);
  });
});
