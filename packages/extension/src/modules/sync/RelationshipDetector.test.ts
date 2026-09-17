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

  it('keeps the syncable targets of a polymorphic field and drops the rest', () => {
    const suggestions = detector.detect(
      'Opportunity',
      opportunityFields,
      [],
      ['Account', 'User', 'Group'],
    );

    // This test used to require all three — `OwnerId -> User` and
    // `OwnerId -> Group` included — and so asked the detector to suggest
    // parents a sync cannot create. Only `AccountId -> Account` is a parent a
    // run can actually write.
    expect(suggestions.map((s) => s.parentObject)).toEqual(['Account']);
  });
});

describe('parents a sync cannot write are not offered', () => {
  it('leaves User out, even though the org reports it createable', () => {
    // `Account.OwnerId` points at `User`. Suggesting it sent the user into a
    // run that tried to create users — a licence and a unique username each.
    const detector = new RelationshipDetector();
    const suggestions = detector.detect(
      'Account',
      [{ name: 'OwnerId', type: 'reference', referenceTo: ['User'], relationshipName: 'Owner' }],
      [],
      ['User', 'Contact'],
    );
    expect(suggestions.map((s) => s.parentObject)).not.toContain('User');
  });

  it('still offers a parent a sync can write', () => {
    const detector = new RelationshipDetector();
    const suggestions = detector.detect(
      'Contact',
      [
        {
          name: 'AccountId',
          type: 'reference',
          referenceTo: ['Account'],
          relationshipName: 'Account',
        },
      ],
      [],
      ['Account'],
    );
    expect(suggestions.map((s) => s.parentObject)).toEqual(['Account']);
  });
});
