import { describe, expect, it } from 'vitest';
import {
  isMasterDetailLookup,
  type CascadingRelation,
  type MasterDetailField,
} from './masterDetail';

/*
 * The lookups as a describe of a Developer Edition org gives them: each
 * child's field (`nillable`, `cascadeDelete` read as `isMasterDetail`, the
 * objects it names) and its parent's list of its children (`cascadeDelete`).
 * No standard field there said `cascadeDelete true`; the parents' lists did.
 */

function field(
  name: string,
  referenceTo: string | string[],
  nillable: boolean,
  isMasterDetail = false,
): MasterDetailField {
  return {
    name,
    referenceTo: Array.isArray(referenceTo) ? referenceTo : [referenceTo],
    nillable,
    isMasterDetail,
  };
}

function cascades(childSObject: string, name: string, isCascadeDelete = true): CascadingRelation {
  return { childSObject, field: name, isCascadeDelete };
}

describe('isMasterDetailLookup', () => {
  it.each([
    ['OpportunityLineItem', 'OpportunityId', 'Opportunity'],
    ['CaseComment', 'ParentId', 'Case'],
    ['OrderItem', 'OrderId', 'Order'],
    ['QuoteLineItem', 'QuoteId', 'Quote'],
    ['OpportunityContactRole', 'OpportunityId', 'Opportunity'],
    ['PricebookEntry', 'Pricebook2Id', 'Pricebook2'],
  ])(
    'reads %s.%s as a detail of %s: its field says no cascade, its master’s list of its children does',
    (child, name, parent) => {
      const own = field(name, parent, false);
      expect(isMasterDetailLookup(child, own, [cascades(child, name)])).toBe(true);
      // The field alone, as a clone of the whole org read it.
      expect(isMasterDetailLookup(child, own, undefined)).toBe(false);
    },
  );

  it.each([
    ['Contact', 'AccountId', 'Account'],
    ['Opportunity', 'AccountId', 'Account'],
    ['Asset', 'AccountId', 'Account'],
    ['Task', 'WhatId', 'Account'],
  ])(
    'keeps %s.%s a lookup: %s deletes it in cascade, and it may be left empty',
    (child, name, parent) => {
      expect(isMasterDetailLookup(child, field(name, parent, true), [cascades(child, name)])).toBe(
        false,
      );
    },
  );

  it('keeps a lookup that may name several objects a lookup, required and cascading as it is', () => {
    const parentOfAFeedItem = field('ParentId', ['Account', 'Case', 'Opportunity'], false);
    expect(
      isMasterDetailLookup('FeedItem', parentOfAFeedItem, [cascades('FeedItem', 'ParentId')]),
    ).toBe(false);
  });

  it('keeps a required lookup whose parent restricts the delete rather than cascade a lookup', () => {
    // A product of an order stays while an order item names its price.
    expect(
      isMasterDetailLookup('OrderItem', field('PricebookEntryId', 'PricebookEntry', false), [
        cascades('OrderItem', 'PricebookEntryId', false),
      ]),
    ).toBe(false);
  });

  it('reads a master-detail its own field says, the parent undescribed', () => {
    expect(
      isMasterDetailLookup('Line__c', field('Invoice__c', 'Invoice__c', false, true), undefined),
    ).toBe(true);
  });

  it('reads no master-detail of a lookup that may be left empty, whatever its field says of the cascade', () => {
    expect(
      isMasterDetailLookup('Line__c', field('Invoice__c', 'Invoice__c', true, true), [
        cascades('Line__c', 'Invoice__c'),
      ]),
    ).toBe(false);
  });

  it('reads the relation of this child through this field only', () => {
    const own = field('OpportunityId', 'Opportunity', false);
    expect(
      isMasterDetailLookup('OpportunityLineItem', own, [
        cascades('OpportunityContactRole', 'OpportunityId'),
        cascades('OpportunityLineItem', 'Other__c'),
      ]),
    ).toBe(false);
  });
});
