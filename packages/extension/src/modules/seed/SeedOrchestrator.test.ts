import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SeedOrchestrator } from './SeedOrchestrator';
import type { SeedOrchestratorDependencies, InsertFn } from './SeedOrchestrator';
import { SeedValidator } from './SeedValidator';
import { SeedGrappeAdapter } from './SeedGrappeAdapter';
import { FieldMapper } from './FieldMapper';
import type { FieldMapperDependencies } from './FieldMapper';
import { FakerFallback } from './FakerFallback';
import type { SeedTemplate } from '@sandforge/shared';

function createMockDeps(): SeedOrchestratorDependencies {
  return {
    validator: {
      validate: vi.fn().mockReturnValue({ valid: true, errors: [], warnings: [] }),
    } as unknown as SeedOrchestratorDependencies['validator'],
    planBuilder: {
      build: vi.fn().mockReturnValue({
        objects: [],
        totalRecords: 0,
        estimatedApiCalls: 0,
        estimatedDuration: 0,
        grappeRecommended: false,
      }),
    } as unknown as SeedOrchestratorDependencies['planBuilder'],
    fieldMapper: {
      mapFields: vi.fn().mockResolvedValue([{ Name: 'Record 1' }, { Name: 'Record 2' }]),
    } as unknown as SeedOrchestratorDependencies['fieldMapper'],
    referenceLinker: {
      resolveInsertOrder: vi.fn((objects: SeedTemplate['objects']) => objects),
    } as unknown as SeedOrchestratorDependencies['referenceLinker'],
    insert: vi.fn<InsertFn>().mockResolvedValue({
      successIds: ['001A', '001B'],
      errors: [],
    }),
    generateId: vi.fn().mockReturnValue('op-123'),
    now: vi.fn().mockReturnValue('2026-01-15T10:00:00Z'),
  };
}

function createTemplate(overrides?: Partial<SeedTemplate>): SeedTemplate {
  return {
    id: 'tpl-1',
    name: 'Test Template',
    description: '',
    version: 1,
    strategy: 'faker',
    objects: [
      {
        objectApiName: 'Account',
        recordCount: 2,
        fieldRules: [{ fieldApiName: 'Name', ruleType: 'static', config: { staticValue: 'Test' } }],
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

describe('SeedOrchestrator', () => {
  let orchestrator: SeedOrchestrator;
  let deps: SeedOrchestratorDependencies;

  beforeEach(() => {
    deps = createMockDeps();
    orchestrator = new SeedOrchestrator(deps);
  });

  describe('execute', () => {
    it('should validate the template before execution', async () => {
      await orchestrator.execute(createTemplate(), 'org-1');
      expect(deps.validator.validate).toHaveBeenCalledTimes(1);
    });

    it('should return failure when validation fails', async () => {
      vi.mocked(deps.validator.validate).mockReturnValue({
        valid: false,
        errors: [{ field: 'name', message: 'Name is required' }],
        warnings: [],
      });

      const result = await orchestrator.execute(createTemplate(), 'org-1');

      expect(result.status).toBe('failure');
      expect(result.objectResults[0].errors).toContain('Name is required');
    });

    it('names the AI fields that received generated sentences in the object result', async () => {
      const refusingAi = {
        generate: vi.fn().mockResolvedValue([]),
      } as unknown as FieldMapperDependencies['aiGenerator'];
      deps.fieldMapper = new FieldMapper({
        aiGenerator: refusingAi,
        fakerFallback: new FakerFallback(),
      });
      const template = createTemplate();
      template.objects[0].fieldRules = [
        { fieldApiName: 'Description', ruleType: 'ai_generate', config: { aiPrompt: 'About' } },
        { fieldApiName: 'Name', ruleType: 'static', config: { staticValue: 'Test' } },
      ];

      const result = await new SeedOrchestrator(deps).execute(template, 'org-1');

      expect(result.objectResults[0].aiFallback).toEqual({
        fields: ['Description'],
        reason: 'no-answer',
      });
    });

    it('adds no AI fallback to an object whose rules name no AI field', async () => {
      const result = await orchestrator.execute(createTemplate(), 'org-1');

      expect(result.objectResults[0].aiFallback).toBeUndefined();
    });

    it('names the AI fields that received generated sentences on the partitioned path too', async () => {
      const refusingAi = {
        generate: vi.fn().mockResolvedValue([]),
      } as unknown as FieldMapperDependencies['aiGenerator'];
      const template = createTemplate();
      template.objects[0].fieldRules = [
        { fieldApiName: 'Description', ruleType: 'ai_generate', config: { aiPrompt: 'About' } },
        { fieldApiName: 'Name', ruleType: 'static', config: { staticValue: 'Test' } },
      ];
      const partitioned = new SeedOrchestrator({
        ...deps,
        fieldMapper: new FieldMapper({
          aiGenerator: refusingAi,
          fakerFallback: new FakerFallback(),
        }),
        grappeAdapter: new SeedGrappeAdapter(() => 'gid'),
        grappeConfig: {
          enabled: true,
          autoActivateThreshold: 1,
          grappeSize: 2000,
        } as SeedOrchestratorDependencies['grappeConfig'],
      });

      const result = await partitioned.execute(template, 'org-1');

      expect(result.objectResults[0].aiFallback).toEqual({
        fields: ['Description'],
        reason: 'no-answer',
      });
    });

    it('should resolve insert order via referenceLinker', async () => {
      await orchestrator.execute(createTemplate(), 'org-1');
      expect(deps.referenceLinker.resolveInsertOrder).toHaveBeenCalledTimes(1);
    });

    it('should generate data via fieldMapper for each object', async () => {
      await orchestrator.execute(createTemplate(), 'org-1');
      expect(deps.fieldMapper.mapFields).toHaveBeenCalledTimes(1);
    });

    it('should insert generated records', async () => {
      await orchestrator.execute(createTemplate(), 'org-1');
      expect(deps.insert).toHaveBeenCalledWith(
        'org-1',
        'Account',
        [{ Name: 'Record 1' }, { Name: 'Record 2' }],
        200,
      );
    });

    it('should return success status when all inserts succeed', async () => {
      const result = await orchestrator.execute(createTemplate(), 'org-1');

      expect(result.status).toBe('success');
      expect(result.totalRecordsCreated).toBe(2);
      expect(result.totalRecordsFailed).toBe(0);
    });

    it('should return partial status when some records fail', async () => {
      vi.mocked(deps.insert).mockResolvedValue({
        successIds: ['001A'],
        errors: ['Insert failed for record 2'],
      });

      const result = await orchestrator.execute(createTemplate(), 'org-1');

      expect(result.status).toBe('partial');
      expect(result.totalRecordsCreated).toBe(1);
      expect(result.totalRecordsFailed).toBe(1);
    });

    it('should return failure status when all records fail', async () => {
      vi.mocked(deps.insert).mockResolvedValue({
        successIds: [],
        errors: ['Error 1', 'Error 2'],
      });

      const result = await orchestrator.execute(createTemplate(), 'org-1');

      expect(result.status).toBe('failure');
      expect(result.totalRecordsCreated).toBe(0);
    });

    it('should pass existing IDs to fieldMapper for dependent objects', async () => {
      const template = createTemplate({
        objects: [
          {
            objectApiName: 'Account',
            recordCount: 1,
            fieldRules: [],
            excludedFields: [],
            insertOrder: 0,
            batchSize: 200,
          },
          {
            objectApiName: 'Contact',
            recordCount: 1,
            fieldRules: [
              {
                fieldApiName: 'AccountId',
                ruleType: 'reference',
                config: { referenceObject: 'Account' },
              },
            ],
            excludedFields: [],
            insertOrder: 1,
            batchSize: 200,
          },
        ],
      });

      await orchestrator.execute(template, 'org-1');

      const secondCall = vi.mocked(deps.fieldMapper.mapFields).mock.calls[1];
      const existingIds = secondCall[1] as Map<string, string[]>;
      expect(existingIds.get('Account')).toEqual(['001A', '001B']);
    });

    it('should include operation ID and template ID in result', async () => {
      const result = await orchestrator.execute(createTemplate(), 'org-1');

      expect(result.operationId).toBe('op-123');
      expect(result.templateId).toBe('tpl-1');
    });

    it('should include duration in result', async () => {
      const result = await orchestrator.execute(createTemplate(), 'org-1');
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should include timestamp in result', async () => {
      const result = await orchestrator.execute(createTemplate(), 'org-1');
      expect(result.timestamp).toBe('2026-01-15T10:00:00Z');
    });

    it('should handle multiple objects in dependency order', async () => {
      const template = createTemplate({
        objects: [
          {
            objectApiName: 'Account',
            recordCount: 1,
            fieldRules: [],
            excludedFields: [],
            insertOrder: 0,
            batchSize: 200,
          },
          {
            objectApiName: 'Contact',
            recordCount: 1,
            fieldRules: [],
            excludedFields: [],
            insertOrder: 1,
            batchSize: 200,
          },
        ],
      });

      const result = await orchestrator.execute(template, 'org-1');
      expect(result.objectResults).toHaveLength(2);
    });

    it('writes nothing when a faker method on the second object is not implemented', async () => {
      const guarded = new SeedOrchestrator({ ...deps, validator: new SeedValidator() });
      const template = createTemplate({
        objects: [
          {
            objectApiName: 'Account',
            recordCount: 2,
            fieldRules: [
              { fieldApiName: 'Name', ruleType: 'faker', config: { fakerMethod: 'company' } },
            ],
            excludedFields: [],
            insertOrder: 0,
            batchSize: 200,
          },
          {
            objectApiName: 'Contact',
            recordCount: 2,
            fieldRules: [
              {
                fieldApiName: 'Pet__c',
                ruleType: 'faker',
                config: { fakerMethod: 'animal.petName' },
              },
            ],
            excludedFields: [],
            insertOrder: 1,
            batchSize: 200,
          },
        ],
      });

      const result = await guarded.execute(template, 'org-1');

      expect(result.status).toBe('failure');
      expect(result.objectResults[0].errors[0]).toContain('"animal.petName"');
      expect(deps.fieldMapper.mapFields).not.toHaveBeenCalled();
      expect(deps.insert).not.toHaveBeenCalled();
    });

    it('reports progress before each object, counting the records already written', async () => {
      const onProgress = vi.fn();
      const reporting = new SeedOrchestrator({ ...deps, onProgress });
      const template = createTemplate({
        objects: [
          {
            objectApiName: 'Account',
            recordCount: 2,
            fieldRules: [],
            excludedFields: [],
            insertOrder: 0,
            batchSize: 200,
          },
          {
            objectApiName: 'Contact',
            recordCount: 6,
            fieldRules: [],
            excludedFields: [],
            insertOrder: 1,
            batchSize: 200,
          },
        ],
      });

      await reporting.execute(template, 'org-1');

      expect(onProgress.mock.calls.map((call) => call[0])).toEqual([
        { objectApiName: 'Account', processedRecords: 0, totalRecords: 8, percentage: 0 },
        { objectApiName: 'Contact', processedRecords: 2, totalRecords: 8, percentage: 25 },
      ]);
    });

    it('reports progress before each object on the partitioned path too', async () => {
      const onProgress = vi.fn();
      const reporting = new SeedOrchestrator({
        ...deps,
        onProgress,
        grappeAdapter: new SeedGrappeAdapter(() => 'gid'),
        grappeConfig: {
          enabled: true,
          autoActivateThreshold: 1,
          grappeSize: 2000,
        } as SeedOrchestratorDependencies['grappeConfig'],
      });

      await reporting.execute(createTemplate(), 'org-1');

      expect(onProgress).toHaveBeenCalledWith({
        objectApiName: 'Account',
        processedRecords: 0,
        totalRecords: 2,
        percentage: 0,
      });
    });

    it('reports progress before each partition of one object, counting its records already written', async () => {
      const onProgress = vi.fn();
      vi.mocked(deps.insert).mockResolvedValue({ successIds: ['001A'], errors: [] });
      const reporting = new SeedOrchestrator({
        ...deps,
        onProgress,
        grappeAdapter: new SeedGrappeAdapter(() => 'gid', 1),
        grappeConfig: {
          enabled: true,
          autoActivateThreshold: 1,
          grappeSize: 1,
        } as SeedOrchestratorDependencies['grappeConfig'],
      });

      await reporting.execute(createTemplate(), 'org-1');

      expect(onProgress.mock.calls.map((call) => call[0])).toEqual([
        { objectApiName: 'Account', processedRecords: 0, totalRecords: 2, percentage: 0 },
        { objectApiName: 'Account', processedRecords: 1, totalRecords: 2, percentage: 50 },
      ]);
    });
  });

  describe('preview', () => {
    it('should delegate to planBuilder', () => {
      const template = createTemplate();
      orchestrator.preview(template);
      expect(deps.planBuilder.build).toHaveBeenCalledWith(template);
    });

    it('should return the data plan', () => {
      const plan = orchestrator.preview(createTemplate());
      expect(plan).toHaveProperty('totalRecords');
      expect(plan).toHaveProperty('estimatedApiCalls');
    });

    it('should not call validator or insert', () => {
      orchestrator.preview(createTemplate());
      expect(deps.validator.validate).not.toHaveBeenCalled();
      expect(deps.insert).not.toHaveBeenCalled();
    });
  });
});

describe('SeedOrchestrator — a parent that wrote nothing', () => {
  /** A template of Account then Contact, the Contact pointing at the Account. */
  function accountThenContact() {
    return {
      id: 'tpl',
      name: 'two objects',
      description: '',
      version: 1,
      strategy: 'faker' as const,
      tags: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      objects: [
        {
          objectApiName: 'Account',
          recordCount: 2,
          fieldRules: [
            {
              fieldApiName: 'Name',
              ruleType: 'faker' as const,
              config: { fakerMethod: 'company.name' },
            },
          ],
          excludedFields: [],
          insertOrder: 0,
          batchSize: 200,
        },
        {
          objectApiName: 'Contact',
          recordCount: 2,
          fieldRules: [
            {
              fieldApiName: 'AccountId',
              ruleType: 'reference' as const,
              config: { referenceObject: 'Account' },
            },
          ],
          excludedFields: [],
          insertOrder: 1,
          batchSize: 200,
        },
      ],
    };
  }

  it('does not write children of an object that wrote none', async () => {
    // Against a real org one missing field cost all fifty accounts, and the
    // run went on to write a hundred contacts and two hundred opportunities,
    // every one attached to nothing.
    const insert = vi.fn(async (_orgId: string, objectApiName: string) =>
      objectApiName === 'Account'
        ? { successIds: [], errors: ['No such column'] }
        : { successIds: ['003A', '003B'], errors: [] },
    );
    const orchestrator = new SeedOrchestrator({ ...createMockDeps(), insert });

    const result = await orchestrator.execute(accountThenContact() as never, 'org');

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][1]).toBe('Account');
    const contact = result.objectResults.find((r) => r.objectApiName === 'Contact');
    expect(contact?.recordsCreated).toBe(0);
    expect(contact?.errors[0]).toContain('Account');
  });

  it('writes the children when the parent wrote something', async () => {
    const insert = vi.fn(async () => ({ successIds: ['001A', '001B'], errors: [] }));
    const orchestrator = new SeedOrchestrator({ ...createMockDeps(), insert });

    const result = await orchestrator.execute(accountThenContact() as never, 'org');

    expect(insert).toHaveBeenCalledTimes(2);
    expect(result.objectResults.every((r) => r.recordsCreated === 2)).toBe(true);
  });
});

describe('SeedOrchestrator — a field the org does not have', () => {
  function oneObject(rules: Array<{ fieldApiName: string; ruleType: 'faker'; config: object }>) {
    return {
      id: 'tpl',
      name: 'one object',
      description: '',
      version: 1,
      strategy: 'faker' as const,
      tags: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      objects: [
        {
          objectApiName: 'Account',
          recordCount: 2,
          fieldRules: rules,
          excludedFields: [],
          insertOrder: 0,
          batchSize: 200,
        },
      ],
    };
  }

  const nameRule = {
    fieldApiName: 'Name',
    ruleType: 'faker' as const,
    config: { fakerMethod: 'company.name' },
  };
  const missingRule = {
    fieldApiName: 'AnnualRevenue',
    ruleType: 'faker' as const,
    config: { fakerMethod: 'number' },
  };

  it('writes the records without the field, and says which one it dropped', async () => {
    // A real org did not expose AnnualRevenue and every record of the object
    // was refused with "No such column".
    const mapFields = vi.fn().mockResolvedValue([{ Name: 'Acme' }, { Name: 'Globex' }]);
    const orchestrator = new SeedOrchestrator({
      ...createMockDeps(),
      fieldMapper: { mapFields } as never,
      describeCreateableFields: async () => new Set(['Name']),
    });

    const result = await orchestrator.execute(oneObject([nameRule, missingRule]) as never, 'org');

    expect(
      mapFields.mock.calls[0][0].fieldRules.map((r: { fieldApiName: string }) => r.fieldApiName),
    ).toEqual(['Name']);
    expect(result.objectResults[0].recordsCreated).toBe(2);
    expect(result.objectResults[0].errors.join(' ')).toContain('AnnualRevenue');
  });

  it('skips an object when the org has none of the fields it names', async () => {
    const insert = vi.fn();
    const orchestrator = new SeedOrchestrator({
      ...createMockDeps(),
      insert: insert as never,
      describeCreateableFields: async () => new Set(['SomethingElse']),
    });

    const result = await orchestrator.execute(oneObject([missingRule]) as never, 'org');

    expect(insert).not.toHaveBeenCalled();
    expect(result.objectResults[0].recordsCreated).toBe(0);
    expect(result.objectResults[0].errors[0]).toContain('AnnualRevenue');
  });

  it('carries on when nothing can describe the org', async () => {
    const orchestrator = new SeedOrchestrator({
      ...createMockDeps(),
      describeCreateableFields: async () => {
        throw new Error('no describe today');
      },
    });

    const result = await orchestrator.execute(oneObject([nameRule]) as never, 'org');
    expect(result.objectResults[0].recordsCreated).toBe(2);
  });
});
