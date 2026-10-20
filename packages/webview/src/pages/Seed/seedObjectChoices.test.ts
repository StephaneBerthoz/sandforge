import { describe, it, expect } from 'vitest';
import { objectsToList, parentSuggestions } from './seedObjectChoices';
import type { SeedObjectInfo } from './Step2_SelectObjects';

const object = (apiName: string, label = apiName): SeedObjectInfo => ({
  apiName,
  label,
  recordCount: 0,
  dependencies: [],
});

/** The order describe-global gives, which is not the order a seed wants. */
const ORG_OBJECTS = [
  object('AcceptedEventRelation', 'Accepted Event Relation'),
  object('Invoice__c', 'Invoice'),
  object('Opportunity'),
  object('Account'),
  object('Contact'),
  object('WorkOrder', 'Work Order'),
];

describe('objectsToList', () => {
  it('pins the common objects the org has at the top, in their own order, then the rest as the org gave them', () => {
    const { common, others } = objectsToList(ORG_OBJECTS, '');

    expect(common.map((o) => o.apiName)).toEqual(['Account', 'Contact', 'Opportunity']);
    expect(others.map((o) => o.apiName)).toEqual([
      'AcceptedEventRelation',
      'Invoice__c',
      'WorkOrder',
    ]);
  });

  it('finds an object by its API name or its label, whatever the case', () => {
    expect(objectsToList(ORG_OBJECTS, 'invoice').others.map((o) => o.apiName)).toEqual([
      'Invoice__c',
    ]);
    expect(objectsToList(ORG_OBJECTS, 'work order').others.map((o) => o.apiName)).toEqual([
      'WorkOrder',
    ]);
    expect(objectsToList(ORG_OBJECTS, '  OPPORT ').common.map((o) => o.apiName)).toEqual([
      'Opportunity',
    ]);
  });

  it('lists nothing for a search nothing matches', () => {
    expect(objectsToList(ORG_OBJECTS, 'zzz')).toEqual({ common: [], others: [] });
  });
});

describe('parentSuggestions', () => {
  const available = new Set(['Account', 'Contact', 'Opportunity', 'Case', 'Product2']);

  it('offers the account of a contact ticked without it', () => {
    expect(parentSuggestions(['Contact'], available)).toEqual([
      { child: 'Contact', parent: 'Account' },
    ]);
  });

  it('offers each parent once, under the first object ticked that names it', () => {
    expect(parentSuggestions(['Case', 'Opportunity'], available)).toEqual([
      { child: 'Case', parent: 'Account' },
      { child: 'Case', parent: 'Contact' },
    ]);
  });

  it('offers no parent the run already seeds', () => {
    expect(parentSuggestions(['Contact', 'Account'], available)).toEqual([]);
  });

  it('offers no parent the org does not let the user create', () => {
    expect(parentSuggestions(['OrderItem'], available)).toEqual([]);
    expect(parentSuggestions(['OpportunityLineItem'], available)).toEqual([
      { child: 'OpportunityLineItem', parent: 'Opportunity' },
    ]);
    expect(parentSuggestions(['Contact'], new Set(['Contact']))).toEqual([]);
  });

  it('offers nothing for an object whose parents it does not know', () => {
    expect(parentSuggestions(['Invoice__c', 'Account'], available)).toEqual([]);
  });
});
