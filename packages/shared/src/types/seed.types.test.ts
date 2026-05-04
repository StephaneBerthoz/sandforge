import { describe, it, expect } from 'vitest';

import type {
  SeedTemplate,
  SeedObjectConfig,
  SeedExecutionResult,
  FieldRule,
  SeedObjectResult,
} from './seed.types.js';

describe('SeedTemplate', () => {
  function createTemplate(overrides: Partial<SeedTemplate> = {}): SeedTemplate {
    return {
      id: 'tpl-uuid-001',
      name: 'Account & Contact Seed',
      description: 'Seeds 100 accounts with 3 contacts each',
      version: 1,
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
          excludedFields: ['Fax', 'Sic'],
          insertOrder: 1,
          batchSize: 200,
        },
      ],
      tags: ['demo', 'accounts'],
      createdAt: '2026-02-20T08:00:00.000Z',
      updatedAt: '2026-02-20T08:00:00.000Z',
      ...overrides,
    };
  }

  it('should create a template with all required fields', () => {
    const template = createTemplate();

    expect(template.id).toBe('tpl-uuid-001');
    expect(template.name).toBe('Account & Contact Seed');
    expect(template.version).toBe(1);
    expect(template.strategy).toBe('faker');
    expect(template.objects).toHaveLength(1);
    expect(template.tags).toEqual(['demo', 'accounts']);
    expect(template.aiPersona).toBeUndefined();
  });

  it('should support AI strategy with an aiPersona', () => {
    const template = createTemplate({
      strategy: 'ai',
      aiPersona: 'A B2B SaaS company selling project management tools to mid-market enterprises',
      tags: ['ai', 'b2b'],
    });

    expect(template.strategy).toBe('ai');
    expect(template.aiPersona).toBeDefined();
    expect(template.aiPersona).toContain('B2B SaaS');
    expect(template.tags).toContain('ai');
  });

  it('should support multiple objects with correct insert ordering', () => {
    const contactConfig: SeedObjectConfig = {
      objectApiName: 'Contact',
      recordCount: 300,
      fieldRules: [
        {
          fieldApiName: 'FirstName',
          ruleType: 'faker',
          config: { fakerMethod: 'person.firstName' },
        },
        {
          fieldApiName: 'LastName',
          ruleType: 'faker',
          config: { fakerMethod: 'person.lastName' },
        },
        {
          fieldApiName: 'AccountId',
          ruleType: 'reference',
          config: {
            referenceObject: 'Account',
            referenceField: 'Id',
          },
        },
      ],
      excludedFields: [],
      insertOrder: 2,
      batchSize: 200,
    };

    const template = createTemplate({
      objects: [createTemplate().objects[0], contactConfig],
    });

    expect(template.objects).toHaveLength(2);
    expect(template.objects[0].insertOrder).toBe(1);
    expect(template.objects[1].insertOrder).toBe(2);
    expect(template.objects[1].objectApiName).toBe('Contact');
  });
});

describe('SeedObjectConfig', () => {
  it('should define per-object seed configuration with field rules', () => {
    const fieldRules: FieldRule[] = [
      {
        fieldApiName: 'Name',
        ruleType: 'sequence',
        config: {
          sequenceStart: 1,
          sequenceStep: 1,
          sequencePrefix: 'Account-',
        },
      },
      {
        fieldApiName: 'Industry',
        ruleType: 'picklist_random',
        config: {
          picklistValues: ['Technology', 'Finance', 'Healthcare', 'Retail'],
        },
      },
      {
        fieldApiName: 'AnnualRevenue',
        ruleType: 'random',
        config: { minValue: 100000, maxValue: 50000000 },
      },
    ];

    const config: SeedObjectConfig = {
      objectApiName: 'Account',
      recordCount: 500,
      fieldRules,
      excludedFields: ['Fax', 'Sic', 'TickerSymbol'],
      insertOrder: 1,
      batchSize: 200,
    };

    expect(config.objectApiName).toBe('Account');
    expect(config.recordCount).toBe(500);
    expect(config.fieldRules).toHaveLength(3);
    expect(config.excludedFields).toContain('Fax');
    expect(config.insertOrder).toBe(1);
    expect(config.batchSize).toBe(200);
    expect(config.recordTypeId).toBeUndefined();
  });

  it('should support recordTypeId and regex field rules', () => {
    const config: SeedObjectConfig = {
      objectApiName: 'Case',
      recordCount: 50,
      recordTypeId: '012xx0000004567',
      fieldRules: [
        {
          fieldApiName: 'CaseNumber',
          ruleType: 'regex',
          config: { regexPattern: 'CASE-[0-9]{6}' },
        },
        {
          fieldApiName: 'Status',
          ruleType: 'static',
          config: { staticValue: 'New' },
        },
      ],
      excludedFields: [],
      insertOrder: 3,
      batchSize: 100,
    };

    expect(config.recordTypeId).toBe('012xx0000004567');
    expect(config.fieldRules[0].ruleType).toBe('regex');
    expect(config.fieldRules[0].config.regexPattern).toBe('CASE-[0-9]{6}');
    expect(config.fieldRules[1].config.staticValue).toBe('New');
  });
});

describe('SeedExecutionResult', () => {
  it('should represent a successful seed execution', () => {
    const objectResults: SeedObjectResult[] = [
      {
        objectApiName: 'Account',
        recordsCreated: 100,
        recordsFailed: 0,
        createdIds: ['001xx000001AAAA', '001xx000001BBBB'],
        errors: [],
      },
      {
        objectApiName: 'Contact',
        recordsCreated: 300,
        recordsFailed: 0,
        createdIds: ['003xx000001AAAA', '003xx000001BBBB'],
        errors: [],
      },
    ];

    const result: SeedExecutionResult = {
      templateId: 'tpl-uuid-001',
      operationId: 'op-uuid-seed-001',
      status: 'success',
      objectResults,
      totalRecordsCreated: 400,
      totalRecordsFailed: 0,
      duration: 25000,
      timestamp: '2026-02-20T10:05:00.000Z',
    };

    expect(result.templateId).toBe('tpl-uuid-001');
    expect(result.operationId).toBe('op-uuid-seed-001');
    expect(result.status).toBe('success');
    expect(result.objectResults).toHaveLength(2);
    expect(result.totalRecordsCreated).toBe(400);
    expect(result.totalRecordsFailed).toBe(0);
    expect(result.duration).toBe(25000);
  });

  it('should represent a partial failure with errors on one object', () => {
    const result: SeedExecutionResult = {
      templateId: 'tpl-uuid-002',
      operationId: 'op-uuid-seed-002',
      status: 'partial',
      objectResults: [
        {
          objectApiName: 'Account',
          recordsCreated: 100,
          recordsFailed: 0,
          createdIds: ['001xx000001AAAA'],
          errors: [],
        },
        {
          objectApiName: 'Contact',
          recordsCreated: 280,
          recordsFailed: 20,
          createdIds: ['003xx000001AAAA'],
          errors: [
            'REQUIRED_FIELD_MISSING: Required fields are missing: [LastName]',
            'FIELD_CUSTOM_VALIDATION_EXCEPTION: Email domain not allowed',
          ],
        },
      ],
      totalRecordsCreated: 380,
      totalRecordsFailed: 20,
      duration: 30000,
      timestamp: '2026-02-20T10:10:00.000Z',
    };

    expect(result.status).toBe('partial');
    expect(result.totalRecordsFailed).toBe(20);
    expect(result.objectResults[1].errors).toHaveLength(2);
    expect(result.objectResults[1].errors[0]).toContain('REQUIRED_FIELD_MISSING');
  });

  it('should represent a complete failure', () => {
    const result: SeedExecutionResult = {
      templateId: 'tpl-uuid-003',
      operationId: 'op-uuid-seed-003',
      status: 'failure',
      objectResults: [
        {
          objectApiName: 'Account',
          recordsCreated: 0,
          recordsFailed: 100,
          createdIds: [],
          errors: ['INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY'],
        },
      ],
      totalRecordsCreated: 0,
      totalRecordsFailed: 100,
      duration: 5000,
      timestamp: '2026-02-20T10:15:00.000Z',
    };

    expect(result.status).toBe('failure');
    expect(result.totalRecordsCreated).toBe(0);
    expect(result.totalRecordsFailed).toBe(100);
    expect(result.objectResults[0].createdIds).toEqual([]);
  });
});
