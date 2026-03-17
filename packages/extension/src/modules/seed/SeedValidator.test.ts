import { describe, it, expect } from 'vitest';
import { SeedValidator } from './SeedValidator';
import type { SeedTemplate } from '@sandforge/shared';

function createValidTemplate(overrides?: Partial<SeedTemplate>): SeedTemplate {
  return {
    id: 'tpl-1',
    name: 'Valid Template',
    description: 'A valid seed template',
    version: 1,
    strategy: 'faker',
    objects: [
      {
        objectApiName: 'Account',
        recordCount: 10,
        fieldRules: [
          { fieldApiName: 'Name', ruleType: 'static', config: { staticValue: 'Test' } },
        ],
        excludedFields: [],
        insertOrder: 0,
        batchSize: 200,
      },
    ],
    tags: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('SeedValidator', () => {
  let validator: SeedValidator;

  beforeEach(() => {
    validator = new SeedValidator();
  });

  describe('validate', () => {
    it('should pass for a valid template', () => {
      const result = validator.validate(createValidTemplate());
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should fail when template name is empty', () => {
      const template = createValidTemplate({ name: '' });
      const result = validator.validate(template);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes('name'))).toBe(true);
    });

    it('should fail when template name is whitespace only', () => {
      const template = createValidTemplate({ name: '   ' });
      const result = validator.validate(template);
      expect(result.valid).toBe(false);
    });

    it('should fail when objects array is empty', () => {
      const template = createValidTemplate({ objects: [] });
      const result = validator.validate(template);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes('at least one object'))).toBe(true);
    });

    it('should fail when record count is zero or negative', () => {
      const template = createValidTemplate({
        objects: [{
          objectApiName: 'Account',
          recordCount: 0,
          fieldRules: [],
          excludedFields: [],
          insertOrder: 0,
          batchSize: 200,
        }],
      });
      const result = validator.validate(template);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes('positive'))).toBe(true);
    });

    it('should warn when record count exceeds 100,000', () => {
      const template = createValidTemplate({
        objects: [{
          objectApiName: 'Account',
          recordCount: 150000,
          fieldRules: [],
          excludedFields: [],
          insertOrder: 0,
          batchSize: 200,
        }],
      });
      const result = validator.validate(template);
      expect(result.warnings.some((w) => w.message.includes('grappe'))).toBe(true);
    });

    it('should fail when batch size is zero', () => {
      const template = createValidTemplate({
        objects: [{
          objectApiName: 'Account',
          recordCount: 10,
          fieldRules: [],
          excludedFields: [],
          insertOrder: 0,
          batchSize: 0,
        }],
      });
      const result = validator.validate(template);
      expect(result.valid).toBe(false);
    });

    it('should fail when reference target is missing from template', () => {
      const template = createValidTemplate({
        objects: [{
          objectApiName: 'Contact',
          recordCount: 10,
          fieldRules: [{
            fieldApiName: 'AccountId',
            ruleType: 'reference',
            config: { referenceObject: 'Account' },
          }],
          excludedFields: [],
          insertOrder: 0,
          batchSize: 200,
        }],
      });
      const result = validator.validate(template);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes('not in the template'))).toBe(true);
    });

    it('should pass when reference target exists in template', () => {
      const template = createValidTemplate({
        objects: [
          {
            objectApiName: 'Account',
            recordCount: 10,
            fieldRules: [],
            excludedFields: [],
            insertOrder: 0,
            batchSize: 200,
          },
          {
            objectApiName: 'Contact',
            recordCount: 10,
            fieldRules: [{
              fieldApiName: 'AccountId',
              ruleType: 'reference',
              config: { referenceObject: 'Account' },
            }],
            excludedFields: [],
            insertOrder: 1,
            batchSize: 200,
          },
        ],
      });
      const result = validator.validate(template);
      expect(result.valid).toBe(true);
    });

    it('should detect circular dependencies', () => {
      const template = createValidTemplate({
        objects: [
          {
            objectApiName: 'A',
            recordCount: 10,
            fieldRules: [{ fieldApiName: 'BId', ruleType: 'reference', config: { referenceObject: 'B' } }],
            excludedFields: [],
            insertOrder: 0,
            batchSize: 200,
          },
          {
            objectApiName: 'B',
            recordCount: 10,
            fieldRules: [{ fieldApiName: 'AId', ruleType: 'reference', config: { referenceObject: 'A' } }],
            excludedFields: [],
            insertOrder: 1,
            batchSize: 200,
          },
        ],
      });
      const result = validator.validate(template);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes('Circular'))).toBe(true);
    });

    it('should fail when reference rule lacks referenceObject', () => {
      const template = createValidTemplate({
        objects: [{
          objectApiName: 'Contact',
          recordCount: 10,
          fieldRules: [{ fieldApiName: 'AccountId', ruleType: 'reference', config: {} }],
          excludedFields: [],
          insertOrder: 0,
          batchSize: 200,
        }],
      });
      const result = validator.validate(template);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes('referenceObject'))).toBe(true);
    });

    it('should fail when picklist rule has no values', () => {
      const template = createValidTemplate({
        objects: [{
          objectApiName: 'Account',
          recordCount: 10,
          fieldRules: [{ fieldApiName: 'Status', ruleType: 'picklist_random', config: {} }],
          excludedFields: [],
          insertOrder: 0,
          batchSize: 200,
        }],
      });
      const result = validator.validate(template);
      expect(result.valid).toBe(false);
    });

    it('should fail when faker rule has no fakerMethod', () => {
      const template = createValidTemplate({
        objects: [{
          objectApiName: 'Account',
          recordCount: 10,
          fieldRules: [{ fieldApiName: 'Email', ruleType: 'faker', config: {} }],
          excludedFields: [],
          insertOrder: 0,
          batchSize: 200,
        }],
      });
      const result = validator.validate(template);
      expect(result.valid).toBe(false);
    });

    it('should fail when regex rule has no pattern', () => {
      const template = createValidTemplate({
        objects: [{
          objectApiName: 'Account',
          recordCount: 10,
          fieldRules: [{ fieldApiName: 'Code', ruleType: 'regex', config: {} }],
          excludedFields: [],
          insertOrder: 0,
          batchSize: 200,
        }],
      });
      const result = validator.validate(template);
      expect(result.valid).toBe(false);
    });

    it('should fail when from_csv rule has no csvColumn', () => {
      const template = createValidTemplate({
        objects: [{
          objectApiName: 'Account',
          recordCount: 10,
          fieldRules: [{ fieldApiName: 'Data', ruleType: 'from_csv', config: {} }],
          excludedFields: [],
          insertOrder: 0,
          batchSize: 200,
        }],
      });
      const result = validator.validate(template);
      expect(result.valid).toBe(false);
    });

    it('should fail when object API name is empty', () => {
      const template = createValidTemplate({
        objects: [{
          objectApiName: '',
          recordCount: 10,
          fieldRules: [],
          excludedFields: [],
          insertOrder: 0,
          batchSize: 200,
        }],
      });
      const result = validator.validate(template);
      expect(result.valid).toBe(false);
    });
  });
});
