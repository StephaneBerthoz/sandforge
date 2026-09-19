import { describe, it, expect } from 'vitest';
import {
  PLATFORM_REQUIRED_FIELDS,
  isPlatformRequiredField,
  isRequiredLookup,
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

describe('PLATFORM_REQUIRED_FIELDS', () => {
  it('covers the three objects priced through a price book entry', () => {
    expect(Object.keys(PLATFORM_REQUIRED_FIELDS).sort()).toEqual([
      'OpportunityLineItem',
      'OrderItem',
      'QuoteLineItem',
    ]);
  });
});
