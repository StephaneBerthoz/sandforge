import { describe, it, expect } from 'vitest';

import {
  syncConfigSchema,
  syncObjectConfigSchema,
  fieldMappingSchema,
  transformRuleSchema,
} from './sync-config.schema.js';

const VALID_UUID_A = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const VALID_UUID_B = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

describe('syncConfigSchema', () => {
  function createValidSyncConfig(): Record<string, unknown> {
    return {
      name: 'Account Sync',
      sourceOrgId: VALID_UUID_A,
      targetOrgId: VALID_UUID_B,
      direction: 'source_to_target',
      mode: 'full',
      objects: [
        {
          objectApiName: 'Account',
          operation: 'upsert',
          fieldMappings: [{ sourceField: 'Name', targetField: 'Name', type: 'direct' }],
          transformRules: [],
          excludedFields: [],
        },
      ],
      conflictStrategy: 'source_wins',
    };
  }

  it('should parse a valid sync config with defaults', () => {
    const result = syncConfigSchema.parse(createValidSyncConfig());

    expect(result.name).toBe('Account Sync');
    expect(result.description).toBe('');
    expect(result.sourceOrgId).toBe(VALID_UUID_A);
    expect(result.targetOrgId).toBe(VALID_UUID_B);
    expect(result.direction).toBe('source_to_target');
    expect(result.mode).toBe('full');
    expect(result.enableRollback).toBe(false);
    expect(result.dryRun).toBe(false);
  });

  it('should apply object batchSize default of 200', () => {
    const result = syncConfigSchema.parse(createValidSyncConfig());

    expect(result.objects[0].batchSize).toBe(200);
  });

  it('should accept explicit optional values', () => {
    const result = syncConfigSchema.parse({
      ...createValidSyncConfig(),
      description: 'Full account sync',
      enableRollback: true,
      dryRun: true,
    });

    expect(result.description).toBe('Full account sync');
    expect(result.enableRollback).toBe(true);
    expect(result.dryRun).toBe(true);
  });

  it('should not carry script fields', () => {
    const result = syncConfigSchema.parse({
      ...createValidSyncConfig(),
      preScript: 'System.debug("pre");',
      postScript: 'System.debug("post");',
    }) as Record<string, unknown>;

    expect(result.preScript).toBeUndefined();
    expect(result.postScript).toBeUndefined();
  });

  it('should accept all valid directions', () => {
    const directions = ['source_to_target', 'target_to_source', 'bidirectional'] as const;

    for (const direction of directions) {
      const result = syncConfigSchema.parse({ ...createValidSyncConfig(), direction });

      expect(result.direction).toBe(direction);
    }
  });

  it('should accept all valid modes', () => {
    const modes = ['full', 'incremental', 'delta', 'cdc'] as const;

    for (const mode of modes) {
      const result = syncConfigSchema.parse({ ...createValidSyncConfig(), mode });

      expect(result.mode).toBe(mode);
    }
  });

  it('should accept all valid conflict strategies', () => {
    const strategies = ['source_wins', 'target_wins', 'newest_wins', 'manual', 'merge'] as const;

    for (const conflictStrategy of strategies) {
      const result = syncConfigSchema.parse({ ...createValidSyncConfig(), conflictStrategy });

      expect(result.conflictStrategy).toBe(conflictStrategy);
    }
  });

  it('should reject non-UUID sourceOrgId', () => {
    expect(() =>
      syncConfigSchema.parse({ ...createValidSyncConfig(), sourceOrgId: 'not-a-uuid' }),
    ).toThrow();
  });

  it('should reject non-UUID targetOrgId', () => {
    expect(() =>
      syncConfigSchema.parse({ ...createValidSyncConfig(), targetOrgId: 'not-a-uuid' }),
    ).toThrow();
  });

  it('should reject empty name', () => {
    expect(() => syncConfigSchema.parse({ ...createValidSyncConfig(), name: '' })).toThrow();
  });

  it('should reject empty objects array', () => {
    expect(() => syncConfigSchema.parse({ ...createValidSyncConfig(), objects: [] })).toThrow();
  });

  it('should reject missing required fields', () => {
    expect(() => syncConfigSchema.parse({})).toThrow();
    expect(() => syncConfigSchema.parse({ name: 'Test' })).toThrow();
  });

  it('should reject invalid direction', () => {
    expect(() =>
      syncConfigSchema.parse({ ...createValidSyncConfig(), direction: 'left_to_right' }),
    ).toThrow();
  });
});

describe('syncObjectConfigSchema', () => {
  it('should parse a valid object config', () => {
    const result = syncObjectConfigSchema.parse({
      objectApiName: 'Contact',
      operation: 'insert',
      fieldMappings: [],
      transformRules: [],
      excludedFields: ['Fax'],
    });

    expect(result.objectApiName).toBe('Contact');
    expect(result.operation).toBe('insert');
    expect(result.batchSize).toBe(200);
    expect(result.externalIdField).toBeUndefined();
  });

  it('should accept externalIdField for upsert', () => {
    const result = syncObjectConfigSchema.parse({
      objectApiName: 'Account',
      externalIdField: 'External_Id__c',
      operation: 'upsert',
      fieldMappings: [],
      transformRules: [],
      excludedFields: [],
    });

    expect(result.externalIdField).toBe('External_Id__c');
  });

  it('should accept all valid operations', () => {
    const operations = ['insert', 'update', 'upsert', 'delete'] as const;

    for (const operation of operations) {
      const result = syncObjectConfigSchema.parse({
        objectApiName: 'Account',
        operation,
        fieldMappings: [],
        transformRules: [],
        excludedFields: [],
      });

      expect(result.operation).toBe(operation);
    }
  });

  it('should reject empty objectApiName', () => {
    expect(() =>
      syncObjectConfigSchema.parse({
        objectApiName: '',
        operation: 'insert',
        fieldMappings: [],
        transformRules: [],
        excludedFields: [],
      }),
    ).toThrow();
  });
});

describe('fieldMappingSchema', () => {
  it('should parse a direct field mapping', () => {
    const result = fieldMappingSchema.parse({
      sourceField: 'Name',
      targetField: 'Name',
      type: 'direct',
    });

    expect(result.sourceField).toBe('Name');
    expect(result.targetField).toBe('Name');
    expect(result.type).toBe('direct');
    expect(result.transformRules).toBeUndefined();
  });

  it('should accept a mapping with transform rules', () => {
    const result = fieldMappingSchema.parse({
      sourceField: 'Name',
      targetField: 'Account_Name__c',
      type: 'transform',
      transformRules: [
        { type: 'uppercase', config: {} },
        { type: 'truncate', config: { length: 100 } },
      ],
    });

    expect(result.transformRules).toHaveLength(2);
  });

  it('should reject empty sourceField', () => {
    expect(() =>
      fieldMappingSchema.parse({
        sourceField: '',
        targetField: 'Name',
        type: 'direct',
      }),
    ).toThrow();
  });

  it('should reject invalid mapping type', () => {
    expect(() =>
      fieldMappingSchema.parse({
        sourceField: 'Name',
        targetField: 'Name',
        type: 'invalid',
      }),
    ).toThrow();
  });
});

describe('transformRuleSchema', () => {
  it('should parse a simple transform rule', () => {
    const result = transformRuleSchema.parse({
      type: 'uppercase',
      config: {},
    });

    expect(result.type).toBe('uppercase');
  });

  it('should parse a truncate rule with config', () => {
    const result = transformRuleSchema.parse({
      type: 'truncate',
      config: { length: 255 },
    });

    expect(result.config.length).toBe(255);
  });

  it('should parse a replace rule', () => {
    const result = transformRuleSchema.parse({
      type: 'replace',
      config: { search: 'old', replace: 'new' },
    });

    expect(result.config.search).toBe('old');
    expect(result.config.replace).toBe('new');
  });

  it('should parse a map_value rule with valueMap', () => {
    const result = transformRuleSchema.parse({
      type: 'map_value',
      config: { valueMap: { A: 'Alpha', B: 'Beta' } },
    });

    expect(result.config.valueMap).toEqual({ A: 'Alpha', B: 'Beta' });
  });

  it('should reject invalid transform type', () => {
    expect(() =>
      transformRuleSchema.parse({
        type: 'nonexistent',
        config: {},
      }),
    ).toThrow();
  });
});
