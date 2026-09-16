import { describe, it, expect } from 'vitest';
import {
  FAKER_METHOD_BY_FIELD_TYPE,
  FAKER_METHOD_BY_FIELD_NAME,
  defaultFakerMethod,
  describedFieldRule,
} from './faker-field-defaults.js';
import { SUPPORTED_FAKER_METHODS } from './faker-methods.js';

const SUPPORTED = new Set<string>(SUPPORTED_FAKER_METHODS);

function described(
  fieldApiName: string,
  type: string,
  extra: Partial<Parameters<typeof describedFieldRule>[0]> = {},
): Parameters<typeof describedFieldRule>[0] {
  return { fieldApiName, type, picklistValues: [], referenceTo: [], length: 0, ...extra };
}

describe('faker field defaults', () => {
  it('names only methods the generator implements', () => {
    for (const method of Object.values(FAKER_METHOD_BY_FIELD_TYPE)) {
      expect(SUPPORTED.has(method)).toBe(true);
    }
    for (const { method } of FAKER_METHOD_BY_FIELD_NAME) {
      expect(SUPPORTED.has(method)).toBe(true);
    }
    expect(SUPPORTED.has(defaultFakerMethod('string', 'Description__c') ?? '')).toBe(true);
  });

  it('picks a method from the field type', () => {
    expect(defaultFakerMethod('email', 'Email')).toBe('email');
    expect(defaultFakerMethod('phone', 'Phone')).toBe('phone');
    expect(defaultFakerMethod('url', 'Website')).toBe('url');
    expect(defaultFakerMethod('date', 'Birthdate')).toBe('pastDate');
    expect(defaultFakerMethod('datetime', 'Closed__c')).toBe('pastDate');
    expect(defaultFakerMethod('currency', 'AnnualRevenue')).toBe('integer');
    expect(defaultFakerMethod('double', 'Score__c')).toBe('integer');
  });

  it('reads the field name of a text field', () => {
    expect(defaultFakerMethod('string', 'FirstName')).toBe('firstName');
    expect(defaultFakerMethod('string', 'LastName')).toBe('lastName');
    expect(defaultFakerMethod('string', 'Name')).toBe('name');
    expect(defaultFakerMethod('string', 'Contact_Name__c')).toBe('name');
    expect(defaultFakerMethod('textarea', 'Description')).toBe('sentence');
  });

  it('names no method for a type no generator fills sensibly', () => {
    expect(defaultFakerMethod('boolean', 'IsActive__c')).toBeUndefined();
    expect(defaultFakerMethod('id', 'Id')).toBeUndefined();
    expect(defaultFakerMethod('base64', 'Body')).toBeUndefined();
  });

  describe('describedFieldRule', () => {
    it('gives a text field a faker rule with a method and the field length', () => {
      expect(describedFieldRule(described('Name', 'string', { length: 80 }))).toEqual({
        ruleType: 'faker',
        config: { fakerMethod: 'name', maxLength: 80 },
      });
    });

    it('gives a picklist its values, and a lookup its target', () => {
      expect(
        describedFieldRule(described('Rating', 'picklist', { picklistValues: ['Hot', 'Cold'] })),
      ).toEqual({ ruleType: 'picklist_random', config: { picklistValues: ['Hot', 'Cold'] } });
      expect(
        describedFieldRule(described('AccountId', 'reference', { referenceTo: ['Account'] })),
      ).toEqual({
        ruleType: 'reference',
        config: { referenceObject: 'Account', referenceField: 'Id' },
      });
    });

    it('never builds a faker rule without a method', () => {
      expect(describedFieldRule(described('IsActive__c', 'boolean'))).toEqual({
        ruleType: 'static',
        config: { staticValue: false },
      });
      expect(describedFieldRule(described('Body', 'base64'))).toEqual({
        ruleType: 'static',
        config: {},
      });
      expect(describedFieldRule(described('Tier__c', 'picklist'))).toEqual({
        ruleType: 'static',
        config: {},
      });
    });
  });
});
