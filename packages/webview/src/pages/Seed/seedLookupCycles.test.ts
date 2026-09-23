import { describe, it, expect } from 'vitest';
import type { SeedRelation } from '@sandforge/shared';
import { lookupsClosingACycle } from './seedLookupCycles';
import type { RunLookup } from './seedLookupCycles';

/** An optional lookup of `object` taking its ids from `target`. */
function optional(object: string, field: string, target: string): RunLookup {
  return { objectApiName: object, fieldApiName: field, target, required: false };
}

/** A required lookup of `object` taking its ids from `target`. */
function required(object: string, field: string, target: string): RunLookup {
  return { objectApiName: object, fieldApiName: field, target, required: true };
}

/** A relation drawing `child`'s parents from the `parent` records this run writes. */
function fromRun(child: string, lookupField: string, parent: string): SeedRelation {
  return {
    childObject: child,
    lookupField,
    parentObject: parent,
    parents: { kind: 'generated' },
    distribution: { mode: 'perParent', count: 2 },
  };
}

describe('lookupsClosingACycle', () => {
  const accountToContact = optional('Account', 'Key_Contact__c', 'Contact');
  const contactToAccount = optional('Contact', 'AccountId', 'Account');

  it('leaves out a custom lookup that points back at an object whose standard lookup points at it', () => {
    // A sandbox whose accounts carried such a lookup refused every wizard run
    // holding Account and Contact as a circular dependency.
    const leftOut = lookupsClosingACycle(
      ['Account', 'Contact'],
      [accountToContact, contactToAccount],
      [],
    );

    expect([...leftOut]).toEqual(['Account.Key_Contact__c']);
  });

  it('keeps the standard lookup whatever order the objects were picked in', () => {
    const leftOut = lookupsClosingACycle(
      ['Contact', 'Account'],
      [contactToAccount, accountToContact],
      [],
    );

    expect([...leftOut]).toEqual(['Account.Key_Contact__c']);
  });

  it('between two custom lookups, keeps the one pointing at the object picked earlier', () => {
    const leftOut = lookupsClosingACycle(
      ['Invoice__c', 'Payment__c'],
      [
        optional('Invoice__c', 'Last_Payment__c', 'Payment__c'),
        optional('Payment__c', 'Invoice__c', 'Invoice__c'),
      ],
      [],
    );

    expect([...leftOut]).toEqual(['Invoice__c.Last_Payment__c']);
  });

  it('gives way to the parents a relation draws from the run, standard lookup or not', () => {
    const leftOut = lookupsClosingACycle(
      ['Account', 'Contact'],
      [contactToAccount],
      [fromRun('Account', 'Key_Contact__c', 'Contact')],
    );

    expect([...leftOut]).toEqual(['Contact.AccountId']);
  });

  it('sends a required lookup even when it closes a loop, so the run is refused before it writes', () => {
    const leftOut = lookupsClosingACycle(
      ['Invoice__c', 'Payment__c'],
      [
        required('Invoice__c', 'Payment__c', 'Payment__c'),
        required('Payment__c', 'Invoice__c', 'Invoice__c'),
      ],
      [],
    );

    expect(leftOut.size).toBe(0);
  });

  it('leaves out the one lookup that closes a loop through three objects', () => {
    const leftOut = lookupsClosingACycle(
      ['A__c', 'B__c', 'C__c'],
      [
        optional('B__c', 'A__c', 'A__c'),
        optional('C__c', 'B__c', 'B__c'),
        optional('A__c', 'C__c', 'C__c'),
      ],
      [],
    );

    expect([...leftOut]).toEqual(['A__c.C__c']);
  });

  it('leaves out nothing when every lookup points the same way', () => {
    const leftOut = lookupsClosingACycle(
      ['Account', 'Contact', 'Opportunity'],
      [
        optional('Opportunity', 'AccountId', 'Account'),
        optional('Opportunity', 'ContactId', 'Contact'),
      ],
      [fromRun('Contact', 'AccountId', 'Account')],
    );

    expect(leftOut.size).toBe(0);
  });
});
