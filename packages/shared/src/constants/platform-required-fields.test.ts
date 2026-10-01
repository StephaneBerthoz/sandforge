import { describe, it, expect } from 'vitest';
import {
  PLATFORM_REQUIRED_FIELDS,
  isInsertOnlyField,
  isPlatformRequiredField,
  isRequiredLookup,
  isSettableField,
} from './platform-required-fields.js';

describe('isPlatformRequiredField', () => {
  it('knows the field an opportunity line cannot be written without', () => {
    expect(isPlatformRequiredField('OpportunityLineItem', 'PricebookEntryId')).toBe(true);
  });

  it('says nothing about other fields of the same object', () => {
    expect(isPlatformRequiredField('OpportunityLineItem', 'Description')).toBe(false);
  });

  it('says nothing about objects it has no rule for', () => {
    expect(isPlatformRequiredField('Account', 'PricebookEntryId')).toBe(false);
  });

  it('is not fooled by a key that is not its own', () => {
    // Object.freeze on a plain record still inherits from Object.prototype.
    expect(isPlatformRequiredField('toString', 'anything')).toBe(false);
    expect(isPlatformRequiredField('constructor', 'anything')).toBe(false);
  });
});

describe('isRequiredLookup', () => {
  it('believes the describe when it says the field is not nullable', () => {
    expect(isRequiredLookup('PricebookEntry', 'Product2Id', false)).toBe(true);
  });

  it('overrides the describe where the platform is stricter than it', () => {
    // Measured against a live org: the describe reads nillable true and the
    // insert is refused without it.
    expect(isRequiredLookup('OpportunityLineItem', 'PricebookEntryId', true)).toBe(true);
  });

  it('reads an unknown nillable as nullable', () => {
    expect(isRequiredLookup('Account', 'ParentId', undefined)).toBe(false);
  });

  it('leaves an ordinary nullable lookup alone', () => {
    expect(isRequiredLookup('Contact', 'AccountId', true)).toBe(false);
  });
});

describe('isSettableField', () => {
  it('says a field neither an insert nor an update can set is not one a copy writes', () => {
    // A person account's PersonContactId, as the describe gives it.
    expect(isSettableField({ createable: false, updateable: false })).toBe(false);
  });

  it('says a field an insert or an update can set is one a copy writes', () => {
    expect(isSettableField({ createable: true, updateable: false })).toBe(true);
    // An opportunity's synced quote is set by an update only: the second pass's.
    expect(isSettableField({ createable: false, updateable: true })).toBe(true);
  });

  it('reads a flag the describe does not give as settable', () => {
    expect(isSettableField({ createable: false })).toBe(true);
    expect(isSettableField({})).toBe(true);
  });
});

describe('isInsertOnlyField', () => {
  it('says a field an insert sets and an update cannot is one only an insert sets', () => {
    // An email's case, or a master-detail whose parent cannot be changed.
    expect(isInsertOnlyField({ createable: true, updateable: false })).toBe(true);
  });

  it('says a field an update can set, or that no write sets, is not', () => {
    expect(isInsertOnlyField({ createable: true, updateable: true })).toBe(false);
    expect(isInsertOnlyField({ createable: false, updateable: true })).toBe(false);
    // A person account's PersonContactId: the platform's to fill.
    expect(isInsertOnlyField({ createable: false, updateable: false })).toBe(false);
  });

  it('reads an updateable flag the describe does not give as one an update can set', () => {
    expect(isInsertOnlyField({ createable: true })).toBe(false);
    expect(isInsertOnlyField({})).toBe(false);
  });
});

describe('PLATFORM_REQUIRED_FIELDS', () => {
  it('covers the three objects priced through a price book entry', () => {
    expect(Object.keys(PLATFORM_REQUIRED_FIELDS).sort()).toEqual([
      'OpportunityLineItem',
      'OrderItem',
      'QuoteLineItem',
    ]);
  });
});
