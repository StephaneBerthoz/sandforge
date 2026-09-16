import { describe, it, expect } from 'vitest';
import { describedFieldRule } from '@sandforge/shared';
import type { SeedObjectConfig, SeedTemplate } from '@sandforge/shared';
import { SeedValidator } from './SeedValidator';

/** A createable field as `seed:describe-object` reports it to the wizard. */
interface DescribedField {
  fieldApiName: string;
  type: string;
  picklistValues: string[];
  referenceTo: string[];
  length: number;
}

function field(
  fieldApiName: string,
  type: string,
  extra: Partial<DescribedField> = {},
): DescribedField {
  return { fieldApiName, type, picklistValues: [], referenceTo: [], length: 0, ...extra };
}

/** The object as the wizard sends it when nobody changed a rule. */
function wizardObject(
  objectApiName: string,
  fields: DescribedField[],
  insertOrder: number,
): SeedObjectConfig {
  return {
    objectApiName,
    recordCount: 10,
    batchSize: 200,
    insertOrder,
    excludedFields: [],
    fieldRules: fields.map((f) => ({
      fieldApiName: f.fieldApiName,
      fieldType: f.type,
      ...describedFieldRule(f),
    })),
  };
}

describe('SeedValidator on a template the wizard builds', () => {
  it('accepts every rule the wizard sets before any edit', () => {
    const template: SeedTemplate = {
      id: 'wizard-run',
      name: 'seed-from-ui',
      description: 'Seed from SandForge UI',
      version: 1,
      strategy: 'faker',
      objects: [
        wizardObject(
          'Account',
          [
            field('Name', 'string', { length: 255 }),
            field('Phone', 'phone', { length: 40 }),
            field('Website', 'url', { length: 255 }),
            field('AnnualRevenue', 'currency'),
            field('NumberOfEmployees', 'int'),
            field('Rating', 'picklist', { picklistValues: ['Hot', 'Warm', 'Cold'], length: 255 }),
            field('Description', 'textarea', { length: 32000 }),
            field('Active__c', 'boolean'),
          ],
          0,
        ),
        wizardObject(
          'Contact',
          [
            field('FirstName', 'string', { length: 40 }),
            field('LastName', 'string', { length: 80 }),
            field('Email', 'email', { length: 80 }),
            field('Birthdate', 'date'),
            field('AccountId', 'reference', { referenceTo: ['Account'], length: 18 }),
          ],
          1,
        ),
      ],
      tags: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };

    const result = new SeedValidator().validate(template);

    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
