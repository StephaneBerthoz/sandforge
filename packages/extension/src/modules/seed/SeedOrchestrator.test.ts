import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SeedOrchestrator } from './SeedOrchestrator';
import type { SeedOrchestratorDependencies, InsertFn } from './SeedOrchestrator';
import { SeedValidator } from './SeedValidator';
import { SeedGrappeAdapter } from './SeedGrappeAdapter';
import { FieldMapper } from './FieldMapper';
import type { FieldMapperDependencies } from './FieldMapper';
import { FakerFallback } from './FakerFallback';
import { ReferenceLinker } from './ReferenceLinker';
import type { SeedRelation, SeedTemplate } from '@sandforge/shared';

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

/**
 * The deps given, with the partitioned path switched on for any run: a seed
 * large enough for `sandforge.grappe.autoActivateThreshold` takes it.
 */
function partitionedDeps(
  deps: SeedOrchestratorDependencies,
  grappeSize = 2000,
): SeedOrchestratorDependencies {
  return {
    ...deps,
    grappeAdapter: new SeedGrappeAdapter(() => 'gid', grappeSize),
    grappeConfig: {
      enabled: true,
      autoActivateThreshold: 1,
      grappeSize,
    } as SeedOrchestratorDependencies['grappeConfig'],
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

  it('does not write children of an object that wrote none on the partitioned path either', async () => {
    // A seed past the grappe threshold took a loop of its own, which wrote
    // the contacts of accounts that had all been refused.
    const insert = vi.fn(async (_orgId: string, objectApiName: string) =>
      objectApiName === 'Account'
        ? { successIds: [], errors: ['No such column', 'No such column'] }
        : { successIds: ['003A', '003B'], errors: [] },
    );
    const orchestrator = new SeedOrchestrator(partitionedDeps({ ...createMockDeps(), insert }));

    const result = await orchestrator.execute(accountThenContact() as never, 'org');

    expect(insert.mock.calls.map((call) => call[1])).toEqual(['Account']);
    const contact = result.objectResults.find((r) => r.objectApiName === 'Contact');
    expect(contact?.recordsCreated).toBe(0);
    expect(contact?.errors).toEqual([
      'Skipped: Account wrote no records, so there is nothing for Contact to point at.',
    ]);
    expect(result.status).toBe('failure');
  });

  it('counts the partitions of a skipped object, so the run reaches every partition', async () => {
    // The partitions are planned before the run, one set per object. A skipped
    // object used none of its own, and the last partition the run reported
    // stood at half: the Grappe view never reached 100%.
    const insert = vi.fn(async () => ({ successIds: [], errors: ['refused', 'refused'] }));
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const orchestrator = new SeedOrchestrator(
      partitionedDeps({
        ...createMockDeps(),
        insert,
        onGrappeEvent: (event) => events.push(event),
      }),
    );

    await orchestrator.execute(accountThenContact() as never, 'org');

    const started = events.find((e) => e.type === 'grappe:started');
    const progress = events.filter((e) => e.type === 'grappe:partitionProgress');
    expect(progress).toHaveLength(Number(started?.payload.totalPartitions));
    expect(progress.map((e) => e.payload.percentage)).toEqual([50, 100]);
  });

  it('writes the children when the parent wrote something on the partitioned path', async () => {
    const insert = vi.fn<InsertFn>(async () => ({ successIds: ['001A', '001B'], errors: [] }));
    const orchestrator = new SeedOrchestrator(partitionedDeps({ ...createMockDeps(), insert }));

    const result = await orchestrator.execute(accountThenContact() as never, 'org');

    expect(insert.mock.calls.map((call) => call[1])).toEqual(['Account', 'Contact']);
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

  it('writes the records without the field on the partitioned path too, and says which one it dropped', async () => {
    // The partitioned path sent the field, and the org refused every record
    // of the object with "No such column".
    const mapFields = vi.fn().mockResolvedValue([{ Name: 'Acme' }, { Name: 'Globex' }]);
    const orchestrator = new SeedOrchestrator(
      partitionedDeps({
        ...createMockDeps(),
        fieldMapper: { mapFields } as never,
        describeCreateableFields: async () => new Set(['Name']),
      }),
    );

    const result = await orchestrator.execute(oneObject([nameRule, missingRule]) as never, 'org');

    expect(
      mapFields.mock.calls[0][0].fieldRules.map((r: { fieldApiName: string }) => r.fieldApiName),
    ).toEqual(['Name']);
    expect(result.objectResults[0].recordsCreated).toBe(2);
    expect(result.objectResults[0].errors).toEqual([
      'Written without AnnualRevenue: this org does not have that field.',
    ]);
  });

  it('skips an object on the partitioned path too when the org has none of the fields it names', async () => {
    const insert = vi.fn();
    const orchestrator = new SeedOrchestrator(
      partitionedDeps({
        ...createMockDeps(),
        insert: insert as never,
        describeCreateableFields: async () => new Set(['SomethingElse']),
      }),
    );

    const result = await orchestrator.execute(oneObject([missingRule]) as never, 'org');

    expect(insert).not.toHaveBeenCalled();
    expect(result.objectResults[0].recordsCreated).toBe(0);
    expect(result.objectResults[0].errors).toEqual([
      'Skipped: this org has none of the fields the template names (AnnualRevenue).',
    ]);
  });
});

describe('SeedOrchestrator — relations', () => {
  /** Accounts and contacts, contacts listed first, the relation given. */
  function accountsAndContacts(
    relation: SeedRelation,
    counts: { accounts: number; contacts: number },
  ): SeedTemplate {
    return createTemplate({
      objects: [
        {
          objectApiName: 'Contact',
          recordCount: counts.contacts,
          fieldRules: [
            { fieldApiName: 'LastName', ruleType: 'static', config: { staticValue: 'Doe' } },
            {
              fieldApiName: 'AccountId',
              ruleType: 'reference',
              config: { referenceObject: 'Account', referenceField: 'Id' },
            },
          ],
          excludedFields: [],
          insertOrder: 0,
          batchSize: 200,
        },
        {
          objectApiName: 'Account',
          recordCount: counts.accounts,
          fieldRules: [{ fieldApiName: 'Name', ruleType: 'static', config: { staticValue: 'A' } }],
          excludedFields: [],
          insertOrder: 1,
          batchSize: 200,
        },
      ],
      relations: [relation],
    });
  }

  /** Contacts spread over accounts the way the relation's two last parts say. */
  function contactsUnder(
    parents: SeedRelation['parents'],
    distribution: SeedRelation['distribution'] = { mode: 'perParent', count: 3 },
  ): SeedRelation {
    return {
      childObject: 'Contact',
      lookupField: 'AccountId',
      parentObject: 'Account',
      parents,
      distribution,
    };
  }

  /**
   * An org that answers each insert with one id per record, `001…` for the
   * accounts and `003…` for the contacts, and keeps what it was sent.
   */
  function recordingOrg() {
    const sent: Array<{ objectApiName: string; records: Record<string, unknown>[] }> = [];
    const insert = vi.fn<InsertFn>(async (_orgId, objectApiName, records) => {
      sent.push({ objectApiName, records });
      const prefix = objectApiName === 'Account' ? '001' : '003';
      return {
        successIds: records.map((_, i) => `${prefix}${String.fromCharCode(65 + i)}`),
        errors: [],
      };
    });
    const contacts = (): Record<string, unknown>[] =>
      sent.find((call) => call.objectApiName === 'Contact')?.records ?? [];
    return { insert, sent, contacts };
  }

  /** The real validator, linker and field mapper, so the relation runs as it would. */
  function orchestratorWith(overrides: Partial<SeedOrchestratorDependencies>): SeedOrchestrator {
    return new SeedOrchestrator({
      ...createMockDeps(),
      validator: new SeedValidator(),
      referenceLinker: new ReferenceLinker(),
      fieldMapper: new FieldMapper({
        aiGenerator: { generate: vi.fn().mockResolvedValue([]) } as never,
        fakerFallback: new FakerFallback(),
      }),
      ...overrides,
    });
  }

  it('writes the accounts first and points each contact at an account the insert returned', async () => {
    const org = recordingOrg();

    const result = await orchestratorWith({ insert: org.insert }).execute(
      accountsAndContacts(contactsUnder({ kind: 'generated' }), { accounts: 2, contacts: 6 }),
      'org-1',
    );

    expect(org.sent.map((call) => call.objectApiName)).toEqual(['Account', 'Contact']);
    expect(org.contacts().map((record) => record['AccountId'])).toEqual([
      '001A',
      '001A',
      '001A',
      '001B',
      '001B',
      '001B',
    ]);
    expect(org.contacts().every((record) => record['LastName'] === 'Doe')).toBe(true);
    expect(result.status).toBe('success');
  });

  it('fills the lookup from the relation, not from a random pick of its reference rule', async () => {
    // Three per account is 3 and 3; a random pick over two accounts almost
    // never lands that way twelve times over.
    const org = recordingOrg();

    await orchestratorWith({ insert: org.insert }).execute(
      accountsAndContacts(contactsUnder({ kind: 'generated' }, { mode: 'perParent', count: 6 }), {
        accounts: 2,
        contacts: 12,
      }),
      'org-1',
    );

    const perAccount = new Map<unknown, number>();
    for (const record of org.contacts()) {
      perAccount.set(record['AccountId'], (perAccount.get(record['AccountId']) ?? 0) + 1);
    }
    expect([...perAccount.entries()]).toEqual([
      ['001A', 6],
      ['001B', 6],
    ]);
  });

  it('gives the children only to the parents the org accepted', async () => {
    const insert = vi.fn<InsertFn>(async (_orgId, objectApiName, records) =>
      objectApiName === 'Account'
        ? { successIds: ['001A'], errors: ['DUPLICATES_DETECTED'] }
        : { successIds: records.map((_, i) => `003${i}`), errors: [] },
    );

    const result = await orchestratorWith({ insert }).execute(
      accountsAndContacts(contactsUnder({ kind: 'generated' }), { accounts: 2, contacts: 6 }),
      'org-1',
    );

    const contacts = insert.mock.calls.find((call) => call[1] === 'Contact')?.[2] ?? [];
    expect(contacts.map((record) => record['AccountId'])).toEqual(['001A', '001A', '001A']);
    expect(result.objectResults.find((r) => r.objectApiName === 'Contact')?.recordsCreated).toBe(3);
  });

  it('writes no child when the parents it draws from wrote none', async () => {
    const insert = vi.fn<InsertFn>(async () => ({ successIds: [], errors: ['No such column'] }));

    const result = await orchestratorWith({ insert }).execute(
      accountsAndContacts(contactsUnder({ kind: 'generated' }), { accounts: 2, contacts: 6 }),
      'org-1',
    );

    expect(insert.mock.calls.map((call) => call[1])).toEqual(['Account']);
    const contact = result.objectResults.find((r) => r.objectApiName === 'Contact');
    expect(contact?.recordsCreated).toBe(0);
    expect(contact?.errors[0]).toContain('Account wrote no records');
  });

  it('draws the parents from the org with the filter and the bound of the relation', async () => {
    const org = recordingOrg();
    const readExistingParentIds = vi.fn(async () => ['001X', '001Y']);
    const template = accountsAndContacts(
      contactsUnder(
        { kind: 'existing', where: "Industry = 'Energy'", limit: 10 },
        {
          mode: 'perParent',
          count: 2,
        },
      ),
      { accounts: 1, contacts: 20 },
    );
    template.objects = template.objects.filter((o) => o.objectApiName === 'Contact');

    const result = await orchestratorWith({ insert: org.insert, readExistingParentIds }).execute(
      template,
      'org-1',
    );

    expect(readExistingParentIds).toHaveBeenCalledWith('Account', "Industry = 'Energy'", 10);
    expect(org.contacts().map((record) => record['AccountId'])).toEqual([
      '001X',
      '001X',
      '001Y',
      '001Y',
    ]);
    expect(result.objectResults[0].recordsCreated).toBe(4);
  });

  it('writes no child when no record of the org matches the filter, and says which filter', async () => {
    const org = recordingOrg();
    const template = accountsAndContacts(
      contactsUnder({ kind: 'existing', where: "Industry = 'Mining'", limit: 10 }),
      { accounts: 1, contacts: 30 },
    );
    template.objects = template.objects.filter((o) => o.objectApiName === 'Contact');

    const result = await orchestratorWith({
      insert: org.insert,
      readExistingParentIds: async () => [],
    }).execute(template, 'org-1');

    expect(org.insert).not.toHaveBeenCalled();
    expect(result.objectResults[0].errors[0]).toContain(`"Industry = 'Mining'"`);
  });

  it('calls a run whose relation wrote no child partial, not a success', async () => {
    // Nothing failed, and nothing was written for Contact: counting failures
    // alone read "Seed Complete".
    const org = recordingOrg();
    const template = accountsAndContacts(
      contactsUnder({ kind: 'existing', where: "Industry = 'Mining'", limit: 10 }),
      { accounts: 2, contacts: 30 },
    );

    const result = await orchestratorWith({
      insert: org.insert,
      readExistingParentIds: async () => [],
    }).execute(template, 'org-1');

    expect(result.totalRecordsCreated).toBe(2);
    expect(result.totalRecordsFailed).toBe(0);
    expect(result.status).toBe('partial');
  });

  it('calls a run that skipped its only object a failure', async () => {
    const template = accountsAndContacts(
      contactsUnder({ kind: 'existing', where: "Industry = 'Mining'", limit: 10 }),
      { accounts: 1, contacts: 30 },
    );
    template.objects = template.objects.filter((o) => o.objectApiName === 'Contact');

    const result = await orchestratorWith({
      insert: recordingOrg().insert,
      readExistingParentIds: async () => [],
    }).execute(template, 'org-1');

    expect(result.status).toBe('failure');
  });

  it('writes no child when the parents cannot be read, and says why', async () => {
    const org = recordingOrg();
    const template = accountsAndContacts(contactsUnder({ kind: 'existing', limit: 10 }), {
      accounts: 1,
      contacts: 30,
    });

    const result = await orchestratorWith({
      insert: org.insert,
      readExistingParentIds: async () => {
        throw new Error("No such column 'Industri' on entity 'Account'");
      },
    }).execute(template, 'org-1');

    const contact = result.objectResults.find((r) => r.objectApiName === 'Contact');
    expect(contact?.recordsCreated).toBe(0);
    expect(contact?.errors[0]).toContain('Industri');
    expect(org.sent.map((call) => call.objectApiName)).toEqual(['Account']);
  });

  it('writes no child when the run has no way to read the org', async () => {
    const org = recordingOrg();
    const template = accountsAndContacts(contactsUnder({ kind: 'existing', limit: 10 }), {
      accounts: 1,
      contacts: 30,
    });

    const result = await orchestratorWith({ insert: org.insert }).execute(template, 'org-1');

    expect(result.objectResults.find((r) => r.objectApiName === 'Contact')?.errors[0]).toContain(
      'cannot read the Account records already in the org',
    );
  });

  it('stops at the record count of the child, and says the relation would have written more', async () => {
    // The count is what the plan and the production guard confirmed.
    const org = recordingOrg();

    const result = await orchestratorWith({ insert: org.insert }).execute(
      accountsAndContacts(contactsUnder({ kind: 'generated' }), { accounts: 2, contacts: 4 }),
      'org-1',
    );

    expect(org.contacts().map((record) => record['AccountId'])).toEqual([
      '001A',
      '001A',
      '001A',
      '001B',
    ]);
    const contact = result.objectResults.find((r) => r.objectApiName === 'Contact');
    expect(contact?.recordsFailed).toBe(0);
    expect(contact?.errors).toEqual([
      'Stopped at 4 Contact records, the most the template asks for: the relation spreads 6 over 2 Account records.',
    ]);
  });

  it('draws each parent a number of children inside the range', async () => {
    const org = recordingOrg();
    const draws = [0, 0.99];
    let at = 0;

    await orchestratorWith({ insert: org.insert, random: () => draws[at++] }).execute(
      accountsAndContacts(contactsUnder({ kind: 'generated' }, { mode: 'range', min: 1, max: 4 }), {
        accounts: 2,
        contacts: 8,
      }),
      'org-1',
    );

    expect(org.contacts().map((record) => record['AccountId'])).toEqual([
      '001A',
      '001B',
      '001B',
      '001B',
      '001B',
    ]);
  });

  it('gives a child to every other parent at half a child per parent', async () => {
    const org = recordingOrg();

    await orchestratorWith({ insert: org.insert }).execute(
      accountsAndContacts(contactsUnder({ kind: 'generated' }, { mode: 'ratio', ratio: 0.5 }), {
        accounts: 4,
        contacts: 2,
      }),
      'org-1',
    );

    expect(org.contacts().map((record) => record['AccountId'])).toEqual(['001B', '001D']);
  });

  it('writes records whose only field is the lookup the relation fills', async () => {
    const org = recordingOrg();
    const template = accountsAndContacts(contactsUnder({ kind: 'generated' }), {
      accounts: 1,
      contacts: 3,
    });
    template.objects[0].fieldRules = [];

    await orchestratorWith({ insert: org.insert }).execute(template, 'org-1');

    expect(org.contacts()).toEqual([
      { AccountId: '001A' },
      { AccountId: '001A' },
      { AccountId: '001A' },
    ]);
  });

  it('writes no child when the org does not let a seed write the lookup', async () => {
    const org = recordingOrg();

    const result = await orchestratorWith({
      insert: org.insert,
      describeCreateableFields: async (objectApiName) =>
        new Set(objectApiName === 'Account' ? ['Name'] : ['LastName']),
    }).execute(
      accountsAndContacts(contactsUnder({ kind: 'generated' }), { accounts: 1, contacts: 3 }),
      'org-1',
    );

    expect(org.sent.map((call) => call.objectApiName)).toEqual(['Account']);
    expect(result.objectResults.find((r) => r.objectApiName === 'Contact')?.errors[0]).toContain(
      'Contact.AccountId',
    );
  });

  it('honours the relation on the partitioned path too', async () => {
    const org = recordingOrg();

    await orchestratorWith({
      insert: org.insert,
      grappeAdapter: new SeedGrappeAdapter(() => 'gid'),
      grappeConfig: {
        enabled: true,
        autoActivateThreshold: 1,
        grappeSize: 2000,
      } as SeedOrchestratorDependencies['grappeConfig'],
    }).execute(
      accountsAndContacts(contactsUnder({ kind: 'generated' }, { mode: 'perParent', count: 2 }), {
        accounts: 2,
        contacts: 4,
      }),
      'org-1',
    );

    expect(org.sent.map((call) => call.objectApiName)).toEqual(['Account', 'Contact']);
    expect(org.contacts().map((record) => record['AccountId'])).toEqual([
      '001A',
      '001A',
      '001B',
      '001B',
    ]);
  });
});

describe('SeedOrchestrator — a cancel stops the run', () => {
  /** Account, then Contact, then Case: two records each. */
  function threeObjects(): SeedTemplate {
    return createTemplate({
      objects: ['Account', 'Contact', 'Case'].map((objectApiName, insertOrder) => ({
        objectApiName,
        recordCount: 2,
        fieldRules: [],
        excludedFields: [],
        insertOrder,
        batchSize: 200,
      })),
    });
  }

  it('inserts no object after the cancel, and answers with the ones it reached', async () => {
    // The Seed page's Cancel promises to stop the seed, and nothing but an
    // insert of more than ten thousand records looked at it.
    const stop = new AbortController();
    const deps = createMockDeps();
    const insert = vi.fn<InsertFn>(async () => {
      stop.abort();
      return { successIds: ['001A', '001B'], errors: [] };
    });

    const result = await new SeedOrchestrator({ ...deps, insert, signal: stop.signal }).execute(
      threeObjects(),
      'org-1',
    );

    expect(insert.mock.calls.map((call) => call[1])).toEqual(['Account']);
    expect(result.cancelled).toBe(true);
    expect(result.objectResults.map((r) => r.objectApiName)).toEqual(['Account']);
    expect(result.totalRecordsCreated).toBe(2);
    // What it reached was written, and the run is still not a success.
    expect(result.status).toBe('partial');
  });

  it('inserts nothing of an object whose records were being generated when the cancel came', async () => {
    const stop = new AbortController();
    const deps = createMockDeps();
    vi.mocked(deps.fieldMapper.mapFields).mockImplementation(async () => {
      stop.abort();
      return [{ Name: 'Record 1' }, { Name: 'Record 2' }];
    });

    const result = await new SeedOrchestrator({ ...deps, signal: stop.signal }).execute(
      threeObjects(),
      'org-1',
    );

    expect(deps.insert).not.toHaveBeenCalled();
    expect(result).toMatchObject({ cancelled: true, objectResults: [], totalRecordsCreated: 0 });
  });

  it('ends cancelled when the insert of its last object was stopped partway', async () => {
    // An upload the cancel stopped wrote nothing and the run went on: on its
    // last object, the seed ended a success.
    const deps = createMockDeps();
    const insert = vi.fn<InsertFn>(async () => ({ successIds: [], errors: [], stopped: true }));

    const result = await new SeedOrchestrator({ ...deps, insert }).execute(
      createTemplate(),
      'org-1',
    );

    expect(result.cancelled).toBe(true);
    expect(result.status).not.toBe('success');
  });

  it('keeps the partitions written before the cancel, and inserts no other', async () => {
    const stop = new AbortController();
    const deps = partitionedDeps(createMockDeps(), 1);
    const events: string[] = [];
    const insert = vi.fn<InsertFn>(async () => {
      stop.abort();
      return { successIds: ['001A'], errors: [] };
    });

    const result = await new SeedOrchestrator({
      ...deps,
      insert,
      signal: stop.signal,
      onGrappeEvent: (event) => events.push(event.type),
    }).execute(threeObjects(), 'org-1');

    // Two partitions of one record planned for Account: only the first went.
    expect(insert).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ cancelled: true, status: 'partial', totalRecordsCreated: 1 });
    expect(result.objectResults.map((r) => r.objectApiName)).toEqual(['Account']);
    // The Grappe view is told the run is over.
    expect(events.at(-1)).toBe('grappe:completed');
  });

  it('still fails with its error when an insert throws while the cancel is pending', async () => {
    const stop = new AbortController();
    const deps = createMockDeps();
    const insert = vi.fn<InsertFn>(async () => {
      stop.abort();
      throw new Error('INVALID_SESSION_ID: Session expired or invalid');
    });

    await expect(
      new SeedOrchestrator({ ...deps, insert, signal: stop.signal }).execute(
        threeObjects(),
        'org-1',
      ),
    ).rejects.toThrow('INVALID_SESSION_ID: Session expired or invalid');
  });
});
