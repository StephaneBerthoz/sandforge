import { describe, it, expect } from 'vitest';
import {
  resolveMentionedObjects,
  MAX_DESCRIBED_OBJECTS,
  type SObjectCatalogEntry,
} from './mentionedObjects.js';

const CATALOG: SObjectCatalogEntry[] = [
  { name: 'Account', label: 'Account', labelPlural: 'Accounts', queryable: true },
  { name: 'Contact', label: 'Contact', labelPlural: 'Contacts', queryable: true },
  { name: 'Opportunity', label: 'Opportunity', labelPlural: 'Opportunities', queryable: true },
  {
    name: 'OpportunityLineItem',
    label: 'Opportunity Product',
    labelPlural: 'Opportunity Products',
    queryable: true,
  },
  { name: 'Case', label: 'Case', labelPlural: 'Cases', queryable: true },
  { name: 'Invoice__c', label: 'Invoice', labelPlural: 'Invoices', queryable: true },
  { name: 'Lead', label: 'Lead', labelPlural: 'Leads', queryable: true },
  { name: 'AccountHistory', label: 'Account History', queryable: false },
];

describe('resolveMentionedObjects', () => {
  it('matches an API name', () => {
    expect(resolveMentionedObjects('SELECT from Account please', CATALOG)).toEqual(['Account']);
  });

  it('matches an English plural the catalog does not spell out', () => {
    const noPlurals = CATALOG.map(({ labelPlural: _drop, ...rest }) => rest);
    expect(resolveMentionedObjects('list the opportunities', noPlurals)).toEqual(['Opportunity']);
  });

  it('matches a custom object by its API name suffix', () => {
    expect(resolveMentionedObjects('all Invoice__c rows', CATALOG)).toEqual(['Invoice__c']);
  });

  it('matches a custom object by its label', () => {
    expect(resolveMentionedObjects('every invoice over 1000', CATALOG)).toEqual(['Invoice__c']);
  });

  it('prefers the longest label phrase over its first word', () => {
    expect(resolveMentionedObjects('show the opportunity products', CATALOG)).toEqual([
      'OpportunityLineItem',
    ]);
  });

  it('keeps the order the request names them in', () => {
    expect(resolveMentionedObjects('contacts and their accounts', CATALOG)).toEqual([
      'Contact',
      'Account',
    ]);
  });

  it('deduplicates a repeated mention', () => {
    expect(resolveMentionedObjects('accounts, and more accounts, Account', CATALOG)).toEqual([
      'Account',
    ]);
  });

  it('ignores objects that cannot appear in a FROM clause', () => {
    expect(resolveMentionedObjects('the account history', CATALOG)).toEqual(['Account']);
  });

  it('returns nothing when the request names no object', () => {
    expect(resolveMentionedObjects('everything changed since last week', CATALOG)).toEqual([]);
  });

  it('caps the number of objects so a request cannot fan out into describes', () => {
    const many = 'account contact opportunity case lead invoice';
    expect(resolveMentionedObjects(many, CATALOG).length).toBe(MAX_DESCRIBED_OBJECTS);
    expect(resolveMentionedObjects(many, CATALOG, 2)).toEqual(['Account', 'Contact']);
  });

  it('returns nothing for a non-positive limit', () => {
    expect(resolveMentionedObjects('accounts', CATALOG, 0)).toEqual([]);
  });

  it('is case and separator insensitive', () => {
    expect(resolveMentionedObjects('OPPORTUNITY-LINE-ITEM records', CATALOG)).toEqual([
      'OpportunityLineItem',
    ]);
  });

  it('gives an ambiguous label to the first catalog entry that claims it', () => {
    const ambiguous: SObjectCatalogEntry[] = [
      { name: 'Case', label: 'Case', queryable: true },
      { name: 'pkg__Case__c', label: 'Case', queryable: true },
    ];
    expect(resolveMentionedObjects('open cases', ambiguous)).toEqual(['Case']);
    // The loser stays reachable by its API name, which is never ambiguous.
    expect(resolveMentionedObjects('pkg__Case__c rows', ambiguous)).toEqual(['pkg__Case__c']);
  });
});
