import { describe, it, expect, expectTypeOf } from 'vitest';
import type { z } from 'zod';

import type { SeedRelation, SeedRow } from '../types/seed.types.js';
import {
  checkSeedKeyedRows,
  seedConfigSchema,
  seedKeyedRowsIssues,
  seedObjectConfigSchema,
  seedRowSchema,
  seedRowsSchema,
  fieldRuleSchema,
  seedRelationSchema,
} from './seed-config.schema.js';
import { SEED_MAX_RECORDS_PER_OBJECT } from '../constants/defaults.js';
import { SEED_ROW_LIMITS } from '../utils/seed-relations.js';

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
    expect(() =>
      seedConfigSchema.parse({ ...createValidSeedConfig(), name: 'x'.repeat(256) }),
    ).toThrow();
  });

  it('should reject invalid strategy', () => {
    expect(() =>
      seedConfigSchema.parse({ ...createValidSeedConfig(), strategy: 'invalid' }),
    ).toThrow();
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

  it('keeps an object a template marks optional', () => {
    // Dropped by the parse, a template file's optional object made its run partial.
    const result = seedObjectConfigSchema.parse({
      objectApiName: 'Knowledge__kav',
      recordCount: 10,
      fieldRules: [],
      excludedFields: [],
      insertOrder: 0,
      optional: true,
    });
    expect(result.optional).toBe(true);
  });

  it('takes as many records of an object as the host does, and refuses one more', () => {
    // Past it, the run was refused only once sent, as a payload the host did
    // not take.
    const config = (recordCount: number) => ({
      objectApiName: 'Account',
      recordCount,
      fieldRules: [],
      excludedFields: [],
      insertOrder: 0,
    });

    expect(SEED_MAX_RECORDS_PER_OBJECT).toBe(1_000_000);
    expect(seedObjectConfigSchema.parse(config(SEED_MAX_RECORDS_PER_OBJECT)).recordCount).toBe(
      SEED_MAX_RECORDS_PER_OBJECT,
    );
    expect(seedObjectConfigSchema.safeParse(config(SEED_MAX_RECORDS_PER_OBJECT + 1)).success).toBe(
      false,
    );
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
      'static',
      'random',
      'sequence',
      'formula',
      'reference',
      'picklist_random',
      'ai_generate',
      'faker',
      'regex',
      'from_csv',
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

  it('drops the persona-side prompt key and keeps aiPrompt, the only key the model is given', () => {
    const result = fieldRuleSchema.parse({
      fieldApiName: 'Review_Text__c',
      ruleType: 'ai_generate',
      config: { prompt: 'persona wording', aiPrompt: 'a' },
    });

    expect(result.config).toEqual({ aiPrompt: 'a' });
  });

  it('keeps the field type a rule carries, so the run can check the rule against it', () => {
    const result = fieldRuleSchema.parse({
      fieldApiName: 'Amount__c',
      fieldType: 'currency',
      ruleType: 'ai_generate',
      config: { aiPrompt: 'a' },
    });

    expect(result.fieldType).toBe('currency');
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

describe('seedRelationSchema', () => {
  /** Three contacts per account this run writes, with the parts given replaced. */
  function relation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      childObject: 'Contact',
      lookupField: 'AccountId',
      parentObject: 'Account',
      parents: { kind: 'generated' },
      distribution: { mode: 'perParent', count: 3 },
      ...overrides,
    };
  }

  it('reads what the declared SeedRelation type describes, and nothing else', () => {
    // The webview builds a SeedRelation and the bridge parses it with this
    // schema: the two have to describe the same shape.
    expectTypeOf<z.infer<typeof seedRelationSchema>>().toEqualTypeOf<SeedRelation>();
  });

  it('accepts each way of spreading children over parents', () => {
    for (const distribution of [
      { mode: 'perParent', count: 3 },
      { mode: 'range', min: 0, max: 4 },
      { mode: 'ratio', ratio: 0.5 },
      { mode: 'byKey' },
    ]) {
      expect(seedRelationSchema.parse(relation({ distribution })).distribution).toEqual(
        distribution,
      );
    }
  });

  it('accepts parents already in the org, filtered, with the most to read', () => {
    const parents = { kind: 'existing', where: "Industry = 'Energy'", limit: 10 };
    expect(seedRelationSchema.parse(relation({ parents })).parents).toEqual(parents);
  });

  it('refuses parents from the org without a bound on how many are read', () => {
    expect(() => seedRelationSchema.parse(relation({ parents: { kind: 'existing' } }))).toThrow();
    expect(() =>
      seedRelationSchema.parse(relation({ parents: { kind: 'existing', limit: 2001 } })),
    ).toThrow();
  });

  it('accepts parents named by their ids, 15 or 18 characters, in the order given', () => {
    const parents = { kind: 'records', ids: ['001000000000002AAA', '001000000000001'] };
    expect(seedRelationSchema.parse(relation({ parents })).parents).toEqual(parents);
  });

  it('refuses parents named by ids that are not record ids, none, or more than existing parents may be', () => {
    const records = (ids: string[]) => relation({ parents: { kind: 'records', ids } });
    expect(() => seedRelationSchema.parse(records([]))).toThrow();
    expect(() => seedRelationSchema.parse(records(['001000000000001AA']))).toThrow(
      /15 or 18 letters and digits/,
    );
    expect(() => seedRelationSchema.parse(records(["001000000000001' OR Id != '"]))).toThrow();
    const bound = Array.from(
      { length: 2001 },
      (_, n) => `001${String(n + 1).padStart(12, '0')}AAA`,
    );
    expect(() => seedRelationSchema.parse(records(bound))).toThrow();
    expect(seedRelationSchema.parse(records(bound.slice(0, 2000))).parents).toMatchObject({
      kind: 'records',
    });
  });

  it('refuses a parent named twice, its 15 characters and its 18 being one record', () => {
    expect(() =>
      seedRelationSchema.parse(
        relation({ parents: { kind: 'records', ids: ['001000000000001AAA', '001000000000001'] } }),
      ),
    ).toThrow(/given once/);
  });

  it('refuses a range that starts above its end', () => {
    expect(() =>
      seedRelationSchema.parse(relation({ distribution: { mode: 'range', min: 5, max: 2 } })),
    ).toThrow(/cannot start above its end/);
  });

  it('refuses a parent that receives no child, or a fraction of one', () => {
    expect(() =>
      seedRelationSchema.parse(relation({ distribution: { mode: 'perParent', count: 0 } })),
    ).toThrow();
    expect(() =>
      seedRelationSchema.parse(relation({ distribution: { mode: 'perParent', count: 1.5 } })),
    ).toThrow();
    expect(() =>
      seedRelationSchema.parse(relation({ distribution: { mode: 'ratio', ratio: 0 } })),
    ).toThrow();
  });

  it('refuses a way of spreading it does not know', () => {
    expect(() =>
      seedRelationSchema.parse(relation({ distribution: { mode: 'weighted', weight: 2 } })),
    ).toThrow();
  });

  it('is carried by the seed config, and left out when a config has none', () => {
    const base = {
      name: 'Accounts and contacts',
      strategy: 'faker',
      objects: [
        {
          objectApiName: 'Contact',
          recordCount: 15,
          fieldRules: [],
          excludedFields: [],
          insertOrder: 1,
        },
      ],
    };
    expect(seedConfigSchema.parse({ ...base, relations: [relation()] }).relations).toHaveLength(1);
    expect(seedConfigSchema.parse(base).relations).toBeUndefined();
  });
});

describe('rows and relations by key', () => {
  /** The template schema as the bridge applies it: its shape, then its rows across objects. */
  const keyedSchema = seedConfigSchema.superRefine(checkSeedKeyedRows);

  function rowsObject(objectApiName: string, rows: unknown[], insertOrder = 0) {
    return {
      objectApiName,
      recordCount: rows.length,
      fieldRules: [],
      excludedFields: [],
      insertOrder,
      rows,
    };
  }

  /** Two accounts, and a contact under each by key, with the contacts' rows given replaced. */
  function keyed(contacts?: unknown[]): Record<string, unknown> {
    return {
      name: 'Keyed',
      strategy: 'template',
      objects: [
        rowsObject('Account', [
          { key: 'a1', values: { Name: 'Acme' } },
          { key: 'a2', values: { Name: 'Globex', NumberOfEmployees: 40, IsPartner: false } },
        ]),
        rowsObject(
          'Contact',
          contacts ?? [
            { key: 'c1', parentKey: 'a1', values: { LastName: 'One', Phone: null } },
            { key: 'c2', parentKey: 'a2', values: { LastName: 'Two' } },
          ],
          1,
        ),
      ],
      relations: [
        {
          childObject: 'Contact',
          lookupField: 'AccountId',
          parentObject: 'Account',
          parents: { kind: 'generated' },
          distribution: { mode: 'byKey' },
        },
      ],
    };
  }

  const messages = (input: unknown) => {
    const parsed = keyedSchema.safeParse(input);
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
  };

  it('reads what the declared SeedRow type describes', () => {
    expectTypeOf<z.infer<typeof seedRowSchema>>().toEqualTypeOf<SeedRow>();
  });

  it('accepts rows placed under the rows of their parent by key, their values as given', () => {
    const parsed = keyedSchema.parse(keyed());
    expect(parsed.objects[1].rows?.[0]).toEqual({
      key: 'c1',
      parentKey: 'a1',
      values: { LastName: 'One', Phone: null },
    });
  });

  it('refuses a key given to two rows of one object', () => {
    const parsed = seedRowsSchema.safeParse([
      { key: 'c1', values: {} },
      { key: 'c1', values: {} },
    ]);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]).toMatchObject({
      path: [1, 'key'],
      message: 'The key "c1" names more than one row: each row is named once',
    });
  });

  it('refuses a value no field takes, and a key longer than a result can name', () => {
    expect(seedRowSchema.safeParse({ key: 'k', values: { Tags: ['a'] } }).success).toBe(false);
    expect(
      seedRowSchema.safeParse({ key: 'k'.repeat(SEED_ROW_LIMITS.maxKeyLength + 1), values: {} })
        .success,
    ).toBe(false);
    expect(
      seedRowSchema.safeParse({
        key: 'k',
        values: { Body__c: 'x'.repeat(SEED_ROW_LIMITS.maxTextLength + 1) },
      }).success,
    ).toBe(false);
  });

  it('refuses a row placed under a parent row no row is, and says where it is', () => {
    const parsed = keyedSchema.safeParse(
      keyed([{ key: 'c1', parentKey: 'a9', values: { LastName: 'One' } }]),
    );
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({
        path: ['objects', 1, 'rows', 0, 'parentKey'],
        message: 'Contact row "c1" is placed under Account "a9", which no Account row is',
      }),
    ]);
  });

  it('refuses an object whose count is not its rows’', () => {
    const input = keyed();
    (input.objects as Array<{ recordCount: number }>)[0].recordCount = 5;
    expect(messages(input)).toEqual([
      'Account gives 2 row(s) and asks for 5 record(s): an object with rows writes one record per row',
    ]);
  });

  it('refuses a parent key no relation places by, and a relation by key over the org’s own parents', () => {
    expect(messages({ ...keyed(), relations: [] })).toEqual([
      'Contact row "c1" names a parent row, and no relation places Contact by key',
      'Contact row "c2" names a parent row, and no relation places Contact by key',
    ]);
    const input = keyed();
    (input.relations as Array<{ parents: unknown }>)[0].parents = { kind: 'existing', limit: 5 };
    expect(messages(input)).toContain(
      'The relation on Contact places by key, which only the Account rows this run writes have',
    );
  });

  it('leaves a template without rows as it was', () => {
    const input = {
      name: 'Plain',
      strategy: 'faker',
      objects: [
        {
          objectApiName: 'Account',
          recordCount: 10,
          fieldRules: [{ fieldApiName: 'Name', ruleType: 'faker', config: { fakerMethod: 'x' } }],
          excludedFields: [],
          insertOrder: 0,
        },
      ],
    };
    expect(messages(input)).toEqual([]);
    expect(seedKeyedRowsIssues(seedConfigSchema.parse(input))).toEqual([]);
  });
});
