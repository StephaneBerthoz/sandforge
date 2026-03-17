import { describe, it, expect } from 'vitest';

import { seedConfigSchema, seedObjectConfigSchema, fieldRuleSchema } from './seed-config.schema.js';

describe('seedConfigSchema', () => {
  function createValidSeedConfig(): Record<string, unknown> {
    return {
      name: 'Account & Contact Seed',
      strategy: 'faker',
      objects: [
        {
          objectApiName: 'Account',
          recordCount: 100,
          fieldRules: [
            {
              fieldApiName: 'Name',
              ruleType: 'faker',
              config: { fakerMethod: 'company.name', fakerLocale: 'en' },
            },
          ],
          excludedFields: ['Fax'],
          insertOrder: 0,
        },
      ],
    };
  }

  it('should parse a valid seed config with defaults', () => {
    const result = seedConfigSchema.parse(createValidSeedConfig());

    expect(result.name).toBe('Account & Contact Seed');
    expect(result.description).toBe('');
    expect(result.strategy).toBe('faker');
    expect(result.objects).toHaveLength(1);
    expect(result.tags).toEqual([]);
    expect(result.aiPersona).toBeUndefined();
  });

  it('should apply batchSize default of 200', () => {
    const result = seedConfigSchema.parse(createValidSeedConfig());

    expect(result.objects[0].batchSize).toBe(200);
  });

  it('should preserve explicit values over defaults', () => {
    const input = {
      ...createValidSeedConfig(),
      description: 'Custom description',
      tags: ['demo', 'test'],
      objects: [
        {
          objectApiName: 'Account',
          recordCount: 100,
          fieldRules: [
            {
              fieldApiName: 'Name',
              ruleType: 'faker',
              config: { fakerMethod: 'company.name' },
            },
          ],
          excludedFields: ['Fax'],
          insertOrder: 0,
          batchSize: 500,
        },
      ],
    };

    const result = seedConfigSchema.parse(input);

    expect(result.description).toBe('Custom description');
    expect(result.tags).toEqual(['demo', 'test']);
    expect(result.objects[0].batchSize).toBe(500);
  });

  it('should accept all valid strategies', () => {
    const strategies = ['ai', 'faker', 'template', 'csv_import', 'clone'] as const;

    for (const strategy of strategies) {
      const result = seedConfigSchema.parse({ ...createValidSeedConfig(), strategy });

      expect(result.strategy).toBe(strategy);
    }
  });

  it('should accept aiPersona with AI strategy', () => {
    const input = {
      ...createValidSeedConfig(),
      strategy: 'ai',
      aiPersona: 'B2B SaaS selling project management tools',
    };

    const result = seedConfigSchema.parse(input);

    expect(result.aiPersona).toBe('B2B SaaS selling project management tools');
  });

  it('should reject empty name', () => {
    expect(() => seedConfigSchema.parse({ ...createValidSeedConfig(), name: '' })).toThrow();
  });

  it('should reject name exceeding 255 characters', () => {
    expect(() => seedConfigSchema.parse({ ...createValidSeedConfig(), name: 'x'.repeat(256) })).toThrow();
  });

  it('should reject invalid strategy', () => {
    expect(() => seedConfigSchema.parse({ ...createValidSeedConfig(), strategy: 'invalid' })).toThrow();
  });

  it('should reject empty objects array', () => {
    expect(() => seedConfigSchema.parse({ ...createValidSeedConfig(), objects: [] })).toThrow();
  });

  it('should reject missing required fields', () => {
    expect(() => seedConfigSchema.parse({})).toThrow();
    expect(() => seedConfigSchema.parse({ name: 'Test' })).toThrow();
    expect(() => seedConfigSchema.parse({ name: 'Test', strategy: 'faker' })).toThrow();
  });
});

describe('seedObjectConfigSchema', () => {
  it('should parse a valid object config', () => {
    const result = seedObjectConfigSchema.parse({
      objectApiName: 'Account',
      recordCount: 100,
      fieldRules: [],
      excludedFields: [],
      insertOrder: 0,
    });

    expect(result.objectApiName).toBe('Account');
    expect(result.recordCount).toBe(100);
    expect(result.batchSize).toBe(200);
  });

  it('should reject non-positive recordCount', () => {
    expect(() =>
      seedObjectConfigSchema.parse({
        objectApiName: 'Account',
        recordCount: 0,
        fieldRules: [],
        excludedFields: [],
        insertOrder: 0,
      }),
    ).toThrow();
  });

  it('should reject negative recordCount', () => {
    expect(() =>
      seedObjectConfigSchema.parse({
        objectApiName: 'Account',
        recordCount: -5,
        fieldRules: [],
        excludedFields: [],
        insertOrder: 0,
      }),
    ).toThrow();
  });

  it('should reject batchSize exceeding 10000', () => {
    expect(() =>
      seedObjectConfigSchema.parse({
        objectApiName: 'Account',
        recordCount: 10,
        fieldRules: [],
        excludedFields: [],
        insertOrder: 0,
        batchSize: 10001,
      }),
    ).toThrow();
  });

  it('should reject negative insertOrder', () => {
    expect(() =>
      seedObjectConfigSchema.parse({
        objectApiName: 'Account',
        recordCount: 10,
        fieldRules: [],
        excludedFields: [],
        insertOrder: -1,
      }),
    ).toThrow();
  });

  it('should reject empty objectApiName', () => {
    expect(() =>
      seedObjectConfigSchema.parse({
        objectApiName: '',
        recordCount: 10,
        fieldRules: [],
        excludedFields: [],
        insertOrder: 0,
      }),
    ).toThrow();
  });
});

describe('fieldRuleSchema', () => {
  it('should parse a valid faker field rule', () => {
    const result = fieldRuleSchema.parse({
      fieldApiName: 'Name',
      ruleType: 'faker',
      config: { fakerMethod: 'company.name' },
    });

    expect(result.fieldApiName).toBe('Name');
    expect(result.ruleType).toBe('faker');
    expect(result.config.fakerMethod).toBe('company.name');
  });

  it('should accept all valid rule types', () => {
    const ruleTypes = [
      'static', 'random', 'sequence', 'formula', 'reference',
      'picklist_random', 'ai_generate', 'faker', 'regex', 'from_csv',
    ] as const;

    for (const ruleType of ruleTypes) {
      const result = fieldRuleSchema.parse({
        fieldApiName: 'TestField',
        ruleType,
        config: {},
      });

      expect(result.ruleType).toBe(ruleType);
    }
  });

  it('should reject empty fieldApiName', () => {
    expect(() =>
      fieldRuleSchema.parse({
        fieldApiName: '',
        ruleType: 'static',
        config: {},
      }),
    ).toThrow();
  });

  it('should reject invalid ruleType', () => {
    expect(() =>
      fieldRuleSchema.parse({
        fieldApiName: 'Name',
        ruleType: 'invalid_type',
        config: {},
      }),
    ).toThrow();
  });

  it('should accept config with multiple optional fields', () => {
    const result = fieldRuleSchema.parse({
      fieldApiName: 'Revenue',
      ruleType: 'random',
      config: {
        minValue: 1000,
        maxValue: 999999,
      },
    });

    expect(result.config.minValue).toBe(1000);
    expect(result.config.maxValue).toBe(999999);
  });

  it('should accept static value as boolean', () => {
    const result = fieldRuleSchema.parse({
      fieldApiName: 'IsActive',
      ruleType: 'static',
      config: { staticValue: true },
    });

    expect(result.config.staticValue).toBe(true);
  });
});
