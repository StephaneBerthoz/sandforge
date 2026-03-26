import { describe, it, expect } from 'vitest';
import { SmartFieldGenerator } from './SmartFieldGenerator';
import type { SeedFieldInfo } from '@sandforge/shared';

function makeField(overrides: Partial<SeedFieldInfo> = {}): SeedFieldInfo {
  return {
    apiName: 'TestField__c',
    label: 'Test Field',
    type: 'string',
    required: false,
    defaultValue: null,
    unique: false,
    externalId: false,
    ...overrides,
  };
}

describe('SmartFieldGenerator', () => {
  const generator = new SmartFieldGenerator();

  it('should return configs for all fields', () => {
    const fields = [
      makeField({ apiName: 'Name', label: 'Name', type: 'string' }),
      makeField({ apiName: 'Email', label: 'Email', type: 'email' }),
    ];
    const configs = generator.suggestConfigs(fields);
    expect(configs).toHaveLength(2);
  });

  it('should suggest null mode for system fields', () => {
    const field = makeField({ apiName: 'Id', label: 'Record ID', type: 'id' });
    const config = generator.suggestForField(field);
    expect(config.generationMode).toBe('null');
  });

  it('should suggest null for CreatedDate', () => {
    const field = makeField({ apiName: 'CreatedDate', label: 'Created Date', type: 'datetime' });
    const config = generator.suggestForField(field);
    expect(config.generationMode).toBe('null');
  });

  it('should suggest picklist_random for picklist fields', () => {
    const field = makeField({
      apiName: 'Status__c',
      label: 'Status',
      type: 'picklist',
      picklistValues: ['New', 'Open', 'Closed'],
    });
    const config = generator.suggestForField(field);
    expect(config.generationMode).toBe('picklist_random');
    expect(config.constraints.picklistValues).toEqual(['New', 'Open', 'Closed']);
  });

  it('should suggest null for reference/lookup fields', () => {
    const field = makeField({
      apiName: 'AccountId',
      label: 'Account',
      type: 'reference',
      referenceTo: 'Account',
    });
    const config = generator.suggestForField(field);
    expect(config.generationMode).toBe('null');
  });

  it('should suggest auto for boolean fields', () => {
    const field = makeField({ apiName: 'IsActive__c', label: 'Is Active', type: 'boolean' });
    const config = generator.suggestForField(field);
    expect(config.generationMode).toBe('auto');
  });

  it('should suggest sequence for unique fields', () => {
    const field = makeField({
      apiName: 'ExternalId__c',
      label: 'External ID',
      type: 'string',
      unique: true,
    });
    const config = generator.suggestForField(field);
    expect(config.generationMode).toBe('sequence');
    expect(config.sequencePattern).toContain('ExternalId__c');
  });

  it('should suggest sequence for externalId fields', () => {
    const field = makeField({
      apiName: 'ExtKey__c',
      label: 'Ext Key',
      type: 'string',
      externalId: true,
    });
    const config = generator.suggestForField(field);
    expect(config.generationMode).toBe('sequence');
  });

  it('should suggest faker pastDate for BirthDate (contextual range)', () => {
    const field = makeField({ apiName: 'BirthDate', label: 'Birth Date', type: 'date' });
    const config = generator.suggestForField(field);
    expect(config.generationMode).toBe('faker');
    expect(config.fakerMethod).toBe('pastDate');
  });

  it('should suggest auto for numeric fields', () => {
    const field = makeField({ apiName: 'Amount__c', label: 'Amount', type: 'currency' });
    const config = generator.suggestForField(field);
    expect(config.generationMode).toBe('auto');
  });

  it('should suggest faker email for email type', () => {
    const field = makeField({ apiName: 'Email', label: 'Email', type: 'email' });
    const config = generator.suggestForField(field);
    expect(config.generationMode).toBe('faker');
    expect(config.fakerMethod).toBe('email');
  });

  it('should suggest faker phone for phone type', () => {
    const field = makeField({ apiName: 'Phone', label: 'Phone', type: 'phone' });
    const config = generator.suggestForField(field);
    expect(config.generationMode).toBe('faker');
    expect(config.fakerMethod).toBe('phone');
  });

  it('should suggest faker url for url type', () => {
    const field = makeField({ apiName: 'Website', label: 'Website', type: 'url' });
    const config = generator.suggestForField(field);
    expect(config.generationMode).toBe('faker');
    expect(config.fakerMethod).toBe('url');
  });

  it('should match firstName pattern from field name', () => {
    const field = makeField({ apiName: 'FirstName', label: 'First Name', type: 'string' });
    const config = generator.suggestForField(field);
    expect(config.generationMode).toBe('faker');
    expect(config.fakerMethod).toBe('firstName');
  });

  it('should match lastName pattern from field name', () => {
    const field = makeField({ apiName: 'LastName', label: 'Last Name', type: 'string' });
    const config = generator.suggestForField(field);
    expect(config.generationMode).toBe('faker');
    expect(config.fakerMethod).toBe('lastName');
  });

  it('should match email pattern from field name', () => {
    const field = makeField({ apiName: 'PersonalEmail__c', label: 'Personal Email', type: 'string' });
    const config = generator.suggestForField(field);
    expect(config.generationMode).toBe('faker');
    expect(config.fakerMethod).toBe('email');
  });

  it('should match company pattern from field name', () => {
    const field = makeField({ apiName: 'CompanyName__c', label: 'Company Name', type: 'string' });
    const config = generator.suggestForField(field);
    expect(config.generationMode).toBe('faker');
    expect(config.fakerMethod).toBe('company');
  });

  it('should suggest sentence for short text fields', () => {
    const field = makeField({
      apiName: 'ShortDesc__c',
      label: 'Short Description',
      type: 'string',
      maxLength: 50,
    });
    const config = generator.suggestForField(field);
    expect(config.generationMode).toBe('faker');
    expect(config.fakerMethod).toBe('sentence');
  });

  it('should suggest paragraph for long text fields', () => {
    const field = makeField({
      apiName: 'LongDesc__c',
      label: 'Long Description',
      type: 'string',
      maxLength: 5000,
    });
    const config = generator.suggestForField(field);
    expect(config.generationMode).toBe('faker');
    expect(config.fakerMethod).toBe('paragraph');
  });

  it('should match description pattern', () => {
    const field = makeField({ apiName: 'Description', label: 'Description', type: 'textarea' });
    const config = generator.suggestForField(field);
    expect(config.generationMode).toBe('faker');
    expect(config.fakerMethod).toBe('paragraph');
  });

  it('should include required constraint', () => {
    const field = makeField({ apiName: 'Name', label: 'Name', type: 'string', required: true });
    const config = generator.suggestForField(field);
    expect(config.constraints.required).toBe(true);
  });

  it('should include maxLength constraint', () => {
    const field = makeField({ apiName: 'Code__c', label: 'Code', type: 'string', maxLength: 10 });
    const config = generator.suggestForField(field);
    expect(config.constraints.maxLength).toBe(10);
  });

  it('should handle multipicklist fields', () => {
    const field = makeField({
      apiName: 'Interests__c',
      label: 'Interests',
      type: 'multipicklist',
      picklistValues: ['Sports', 'Music', 'Art'],
    });
    const config = generator.suggestForField(field);
    expect(config.generationMode).toBe('picklist_random');
  });

  it('should fallback to auto for unknown types', () => {
    const field = makeField({ apiName: 'Custom__c', label: 'Custom', type: 'encryptedstring' });
    const config = generator.suggestForField(field);
    expect(config.generationMode).toBe('auto');
  });

  it('should populate fieldName and fieldType', () => {
    const field = makeField({ apiName: 'MyField__c', label: 'My Field', type: 'double' });
    const config = generator.suggestForField(field);
    expect(config.fieldName).toBe('MyField__c');
    expect(config.fieldType).toBe('double');
  });

  // -- New tests for contextual ranges and geo-coherence --

  describe('contextual ranges', () => {
    it('should set min=5000, max=500000 for Opportunity.Amount currency field', () => {
      const field = makeField({ apiName: 'Amount', label: 'Amount', type: 'currency' });
      const config = generator.suggestForField(field, 'Opportunity');
      expect(config.generationMode).toBe('auto');
      expect(config.constraints.min).toBe(5000);
      expect(config.constraints.max).toBe(500000);
    });

    it('should set futureDate for Opportunity.CloseDate', () => {
      const field = makeField({ apiName: 'CloseDate', label: 'Close Date', type: 'date' });
      const config = generator.suggestForField(field, 'Opportunity');
      expect(config.generationMode).toBe('faker');
      expect(config.fakerMethod).toBe('futureDate');
      expect(config.constraints.min).toBeGreaterThan(0);
    });

    it('should set pastDate for Contact.Birthdate', () => {
      const field = makeField({ apiName: 'Birthdate', label: 'Birthdate', type: 'date' });
      const config = generator.suggestForField(field, 'Contact');
      expect(config.generationMode).toBe('faker');
      expect(config.fakerMethod).toBe('pastDate');
      expect(config.constraints.max).toBeLessThan(0);
    });

    it('should set min=0, max=100 for percent fields', () => {
      const field = makeField({ apiName: 'Probability', label: 'Probability', type: 'percent' });
      const config = generator.suggestForField(field);
      expect(config.generationMode).toBe('auto');
      expect(config.constraints.min).toBe(0);
      expect(config.constraints.max).toBe(100);
    });

    it('should pass objectApiName through suggestConfigs', () => {
      const fields = [
        makeField({ apiName: 'Amount', label: 'Amount', type: 'currency' }),
      ];
      const configs = generator.suggestConfigs(fields, 'Opportunity');
      expect(configs[0].constraints.min).toBe(5000);
      expect(configs[0].constraints.max).toBe(500000);
    });

    it('should fall back to default ranges when no objectApiName', () => {
      const field = makeField({ apiName: 'Amount', label: 'Amount', type: 'currency' });
      const config = generator.suggestForField(field);
      // Amount pattern match: min=100, max=100000
      expect(config.constraints.min).toBe(100);
      expect(config.constraints.max).toBe(100000);
    });
  });

  describe('state pattern recognition', () => {
    it('should recognize State field name', () => {
      const field = makeField({ apiName: 'State', label: 'State', type: 'string' });
      const config = generator.suggestForField(field);
      expect(config.generationMode).toBe('faker');
      expect(config.fakerMethod).toBe('state');
    });

    it('should recognize BillingState field name', () => {
      const field = makeField({ apiName: 'BillingState', label: 'Billing State', type: 'string' });
      const config = generator.suggestForField(field);
      expect(config.generationMode).toBe('faker');
      expect(config.fakerMethod).toBe('state');
    });

    it('should recognize ShippingState field name', () => {
      const field = makeField({ apiName: 'ShippingState', label: 'Shipping State', type: 'string' });
      const config = generator.suggestForField(field);
      expect(config.generationMode).toBe('faker');
      expect(config.fakerMethod).toBe('state');
    });

    it('should recognize Province field name', () => {
      const field = makeField({ apiName: 'Province', label: 'Province', type: 'string' });
      const config = generator.suggestForField(field);
      expect(config.generationMode).toBe('faker');
      expect(config.fakerMethod).toBe('state');
    });
  });
});
