import { describe, it, expect } from 'vitest';

import {
  forgeInputModeSchema,
  forgeDepthSchema,
  forgeNodeStatusSchema,
  forgeEdgeTypeSchema,
  forgeBatchStrategySchema,
  forgeAnonymizationCategorySchema,
  forgeAnonymizationRulesSchema,
  forgeCycleStrategySchema,
  forgeConfigSchema,
  forgeGraphNodeSchema,
  forgeGraphEdgeSchema,
  forgeGraphSchema,
  forgeTemplateSchema,
  forgeWaveSchema,
  forgeCycleResolutionSchema,
  forgePlanSchema,
  forgeCheckpointSchema,
  forgeFileCopyOptionSchema,
} from './forge.schema.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createValidForgeConfig(): Record<string, unknown> {
  return {
    inputMode: 'record',
    recordId: '001xx000003DGbY',
    depth: 'full',
    sourceOrgId: 'org-source-123',
    targetOrgId: 'org-target-456',
    anonymizePII: true,
    skipEmpty: false,
    batchSize: 'auto',
  };
}

function createValidForgeGraphNode(): Record<string, unknown> {
  return {
    objectApiName: 'Account',
    recordCount: 100,
    fieldCount: 30,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: ['Email'],
    anonymizeFields: ['Email'],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 20,
    estimatedSizeMB: 0.1,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
  };
}

function createValidForgeGraphEdge(): Record<string, unknown> {
  return {
    sourceObject: 'Account',
    targetObject: 'Contact',
    relationshipName: 'Contacts',
    type: 'master-detail',
  };
}

function createValidForgeGraph(): Record<string, unknown> {
  return {
    nodes: [createValidForgeGraphNode()],
    edges: [createValidForgeGraphEdge()],
    totalRecords: 100,
    estimatedSizeMB: 1.5,
    estimatedDurationSeconds: 60,
  };
}

function createValidForgeTemplate(): Record<string, unknown> {
  return {
    id: 'tpl-001',
    name: 'Full Account Hierarchy',
    description: 'Copies Account with all child objects',
    config: {
      inputMode: 'record',
      depth: 'full',
      anonymizePII: true,
      skipEmpty: true,
      batchSize: 'auto',
    },
    objectCount: 5,
    recordCount: 1200,
    createdAt: '2026-01-15T08:00:00.000Z',
    lastUsedAt: '2026-03-07T09:00:00.000Z',
  };
}

// ─── Enum Schema Tests ───────────────────────────────────────────────────────

describe('forgeInputModeSchema', () => {
  it('should accept all valid input modes', () => {
    const modes = ['record', 'soql', 'template', 'ai'];
    for (const mode of modes) {
      expect(forgeInputModeSchema.parse(mode)).toBe(mode);
    }
  });

  it('should reject invalid input mode', () => {
    expect(() => forgeInputModeSchema.parse('csv')).toThrow();
  });
});

describe('forgeDepthSchema', () => {
  it('should accept all valid depths', () => {
    const depths = ['direct', 'full', 'custom'];
    for (const depth of depths) {
      expect(forgeDepthSchema.parse(depth)).toBe(depth);
    }
  });

  it('should reject invalid depth', () => {
    expect(() => forgeDepthSchema.parse('deep')).toThrow();
  });
});

describe('forgeNodeStatusSchema', () => {
  it('should accept all valid statuses', () => {
    const statuses = ['idle', 'scanning', 'running', 'done', 'error', 'skipped'];
    for (const status of statuses) {
      expect(forgeNodeStatusSchema.parse(status)).toBe(status);
    }
  });

  it('should reject invalid status', () => {
    expect(() => forgeNodeStatusSchema.parse('pending')).toThrow();
  });
});

describe('forgeEdgeTypeSchema', () => {
  it('should accept all valid edge types', () => {
    const types = ['master-detail', 'lookup'];
    for (const t of types) {
      expect(forgeEdgeTypeSchema.parse(t)).toBe(t);
    }
  });

  it('should reject invalid edge type', () => {
    expect(() => forgeEdgeTypeSchema.parse('hierarchical')).toThrow();
  });
});

// ─── Config Schema Tests ─────────────────────────────────────────────────────

describe('forgeConfigSchema', () => {
  it('should parse valid config with auto batchSize', () => {
    const result = forgeConfigSchema.parse(createValidForgeConfig());
    expect(result.inputMode).toBe('record');
    expect(result.batchSize).toBe('auto');
    expect(result.anonymizePII).toBe(true);
  });

  it('should parse valid config with numeric batchSize', () => {
    const result = forgeConfigSchema.parse({ ...createValidForgeConfig(), batchSize: 200 });
    expect(result.batchSize).toBe(200);
  });

  it('should parse config with optional fields omitted', () => {
    const config = {
      inputMode: 'soql',
      soqlQuery: 'SELECT Id FROM Account',
      depth: 'direct',
      sourceOrgId: 'org-1',
      targetOrgId: 'org-2',
      anonymizePII: false,
      skipEmpty: true,
      batchSize: 'auto',
    };
    const result = forgeConfigSchema.parse(config);
    expect(result.recordId).toBeUndefined();
    expect(result.customDepth).toBeUndefined();
  });

  it('should reject empty sourceOrgId', () => {
    expect(() =>
      forgeConfigSchema.parse({ ...createValidForgeConfig(), sourceOrgId: '' }),
    ).toThrow();
  });

  it('should reject empty targetOrgId', () => {
    expect(() =>
      forgeConfigSchema.parse({ ...createValidForgeConfig(), targetOrgId: '' }),
    ).toThrow();
  });

  it('should reject invalid inputMode', () => {
    expect(() =>
      forgeConfigSchema.parse({ ...createValidForgeConfig(), inputMode: 'csv' }),
    ).toThrow();
  });

  it('should reject invalid depth', () => {
    expect(() => forgeConfigSchema.parse({ ...createValidForgeConfig(), depth: 'deep' })).toThrow();
  });

  it('should reject zero batchSize number', () => {
    expect(() => forgeConfigSchema.parse({ ...createValidForgeConfig(), batchSize: 0 })).toThrow();
  });

  it('should reject negative batchSize number', () => {
    expect(() =>
      forgeConfigSchema.parse({ ...createValidForgeConfig(), batchSize: -10 }),
    ).toThrow();
  });

  it('should reject non-integer customDepth', () => {
    expect(() =>
      forgeConfigSchema.parse({ ...createValidForgeConfig(), customDepth: 2.5 }),
    ).toThrow();
  });
});

// ─── Node Schema Tests ───────────────────────────────────────────────────────

describe('forgeGraphNodeSchema', () => {
  it('should parse valid node', () => {
    const result = forgeGraphNodeSchema.parse(createValidForgeGraphNode());
    expect(result.objectApiName).toBe('Account');
    expect(result.status).toBe('idle');
  });

  it('should reject progress > 100', () => {
    expect(() =>
      forgeGraphNodeSchema.parse({ ...createValidForgeGraphNode(), progress: 150 }),
    ).toThrow();
  });

  it('should reject progress < 0', () => {
    expect(() =>
      forgeGraphNodeSchema.parse({ ...createValidForgeGraphNode(), progress: -1 }),
    ).toThrow();
  });

  it('should reject negative recordCount', () => {
    expect(() =>
      forgeGraphNodeSchema.parse({ ...createValidForgeGraphNode(), recordCount: -5 }),
    ).toThrow();
  });

  it('should reject negative fieldCount', () => {
    expect(() =>
      forgeGraphNodeSchema.parse({ ...createValidForgeGraphNode(), fieldCount: -1 }),
    ).toThrow();
  });

  it('should reject empty objectApiName', () => {
    expect(() =>
      forgeGraphNodeSchema.parse({ ...createValidForgeGraphNode(), objectApiName: '' }),
    ).toThrow();
  });

  it('should reject invalid status', () => {
    expect(() =>
      forgeGraphNodeSchema.parse({ ...createValidForgeGraphNode(), status: 'pending' }),
    ).toThrow();
  });

  it('should reject missing required fields', () => {
    expect(() => forgeGraphNodeSchema.parse({ objectApiName: 'Account' })).toThrow();
  });

  it('keeps that the user left a node out, which the run holds back rows for', () => {
    // Dropped by the parse, a node unchecked on the page reached the run as
    // one discovery left out, and its dependents were sent to be refused.
    const leftOut = { ...createValidForgeGraphNode(), included: false, leftOutByUser: true };
    expect(forgeGraphNodeSchema.parse(leftOut).leftOutByUser).toBe(true);
    expect(forgeGraphNodeSchema.parse(createValidForgeGraphNode()).leftOutByUser).toBeUndefined();
    expect(() => forgeGraphNodeSchema.parse({ ...leftOut, leftOutByUser: 'yes' })).toThrow();
  });
});

// ─── Edge Schema Tests ───────────────────────────────────────────────────────

describe('forgeGraphEdgeSchema', () => {
  it('should parse valid edge', () => {
    const result = forgeGraphEdgeSchema.parse(createValidForgeGraphEdge());
    expect(result.sourceObject).toBe('Account');
    expect(result.type).toBe('master-detail');
  });

  it('should accept lookup type', () => {
    const result = forgeGraphEdgeSchema.parse({ ...createValidForgeGraphEdge(), type: 'lookup' });
    expect(result.type).toBe('lookup');
  });

  it('should reject empty sourceObject', () => {
    expect(() =>
      forgeGraphEdgeSchema.parse({ ...createValidForgeGraphEdge(), sourceObject: '' }),
    ).toThrow();
  });

  it('should reject empty targetObject', () => {
    expect(() =>
      forgeGraphEdgeSchema.parse({ ...createValidForgeGraphEdge(), targetObject: '' }),
    ).toThrow();
  });

  it('should reject empty relationshipName', () => {
    expect(() =>
      forgeGraphEdgeSchema.parse({ ...createValidForgeGraphEdge(), relationshipName: '' }),
    ).toThrow();
  });

  it('should reject invalid type', () => {
    expect(() =>
      forgeGraphEdgeSchema.parse({ ...createValidForgeGraphEdge(), type: 'hierarchical' }),
    ).toThrow();
  });
});

// ─── Graph Schema Tests ──────────────────────────────────────────────────────

describe('forgeGraphSchema', () => {
  it('should parse valid graph', () => {
    const result = forgeGraphSchema.parse(createValidForgeGraph());
    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toHaveLength(1);
    expect(result.totalRecords).toBe(100);
  });

  it('should parse graph with empty nodes and edges', () => {
    const graph = {
      nodes: [],
      edges: [],
      totalRecords: 0,
      estimatedSizeMB: 0,
      estimatedDurationSeconds: 0,
    };
    const result = forgeGraphSchema.parse(graph);
    expect(result.nodes).toHaveLength(0);
  });

  it('should reject negative totalRecords', () => {
    expect(() =>
      forgeGraphSchema.parse({ ...createValidForgeGraph(), totalRecords: -1 }),
    ).toThrow();
  });

  it('should reject negative estimatedSizeMB', () => {
    expect(() =>
      forgeGraphSchema.parse({ ...createValidForgeGraph(), estimatedSizeMB: -0.5 }),
    ).toThrow();
  });

  it('should reject negative estimatedDurationSeconds', () => {
    expect(() =>
      forgeGraphSchema.parse({ ...createValidForgeGraph(), estimatedDurationSeconds: -10 }),
    ).toThrow();
  });

  it('should reject invalid nested node', () => {
    const graph = {
      nodes: [{ objectApiName: '' }],
      edges: [],
      totalRecords: 0,
      estimatedSizeMB: 0,
      estimatedDurationSeconds: 0,
    };
    expect(() => forgeGraphSchema.parse(graph)).toThrow();
  });
});

// ─── Template Schema Tests ───────────────────────────────────────────────────

describe('forgeTemplateSchema', () => {
  it('should parse valid template', () => {
    const result = forgeTemplateSchema.parse(createValidForgeTemplate());
    expect(result.id).toBe('tpl-001');
    expect(result.name).toBe('Full Account Hierarchy');
    expect(result.config.inputMode).toBe('record');
  });

  it('should not require sourceOrgId/targetOrgId in template config', () => {
    const template = createValidForgeTemplate();
    const result = forgeTemplateSchema.parse(template);
    expect(result.config).not.toHaveProperty('sourceOrgId');
    expect(result.config).not.toHaveProperty('targetOrgId');
  });

  it('should reject empty id', () => {
    expect(() => forgeTemplateSchema.parse({ ...createValidForgeTemplate(), id: '' })).toThrow();
  });

  it('should reject empty name', () => {
    expect(() => forgeTemplateSchema.parse({ ...createValidForgeTemplate(), name: '' })).toThrow();
  });

  it('should reject negative objectCount', () => {
    expect(() =>
      forgeTemplateSchema.parse({ ...createValidForgeTemplate(), objectCount: -1 }),
    ).toThrow();
  });

  it('should reject negative recordCount', () => {
    expect(() =>
      forgeTemplateSchema.parse({ ...createValidForgeTemplate(), recordCount: -1 }),
    ).toThrow();
  });

  it('should reject empty createdAt', () => {
    expect(() =>
      forgeTemplateSchema.parse({ ...createValidForgeTemplate(), createdAt: '' }),
    ).toThrow();
  });

  it('should reject empty lastUsedAt', () => {
    expect(() =>
      forgeTemplateSchema.parse({ ...createValidForgeTemplate(), lastUsedAt: '' }),
    ).toThrow();
  });

  it('should allow empty description', () => {
    const result = forgeTemplateSchema.parse({
      ...createValidForgeTemplate(),
      description: '',
    });
    expect(result.description).toBe('');
  });

  it('keeps the target org and the anonymization a run was saved with', () => {
    const result = forgeTemplateSchema.parse({
      ...createValidForgeTemplate(),
      targetOrgId: 'org-target',
      anonymization: {
        presetId: 'preset:gdpr-default',
        rules: { email: 'hash', phone: 'mask' },
      },
    });
    expect(result.targetOrgId).toBe('org-target');
    expect(result.anonymization).toEqual({
      presetId: 'preset:gdpr-default',
      rules: { email: 'hash', phone: 'mask' },
    });
  });

  it('refuses a method no anonymizer knows, or a category the panel has no row for', () => {
    const withRules = (rules: Record<string, string>) => ({
      ...createValidForgeTemplate(),
      anonymization: { rules },
    });
    expect(forgeTemplateSchema.safeParse(withRules({ email: 'scramble' })).success).toBe(false);
    expect(forgeTemplateSchema.safeParse(withRules({ biometric: 'hash' })).success).toBe(false);
  });

  it('still reads a template saved before the target org and anonymization were kept', () => {
    const result = forgeTemplateSchema.parse(createValidForgeTemplate());
    expect(result.targetOrgId).toBeUndefined();
    expect(result.anonymization).toBeUndefined();
  });
});

// ─── Forge v2 Enum Schema Tests ─────────────────────────────────────────────

describe('forgeBatchStrategySchema', () => {
  it('should accept all valid batch strategies', () => {
    const strategies = ['rest', 'bulk', 'auto'];
    for (const s of strategies) {
      expect(forgeBatchStrategySchema.parse(s)).toBe(s);
    }
  });

  it('should reject invalid batch strategy', () => {
    expect(() => forgeBatchStrategySchema.parse('stream')).toThrow();
  });
});

describe('forgeAnonymizationCategorySchema', () => {
  it('should accept all valid categories', () => {
    const categories = ['email', 'phone', 'name', 'address', 'ssn_id', 'financial', 'other'];
    for (const c of categories) {
      expect(forgeAnonymizationCategorySchema.parse(c)).toBe(c);
    }
  });

  it('should reject invalid category', () => {
    expect(() => forgeAnonymizationCategorySchema.parse('biometric')).toThrow();
  });
});

describe('forgeAnonymizationRulesSchema', () => {
  it('accepts a method for some of the categories', () => {
    expect(forgeAnonymizationRulesSchema.parse({ email: 'hash', phone: 'redact' })).toEqual({
      email: 'hash',
      phone: 'redact',
    });
  });

  it('refuses a method it does not know, and a category it does not know', () => {
    expect(forgeAnonymizationRulesSchema.safeParse({ email: 'encrypt' }).success).toBe(false);
    expect(forgeAnonymizationRulesSchema.safeParse({ biometric: 'hash' }).success).toBe(false);
  });
});

describe('forgeCycleStrategySchema', () => {
  it('should accept all valid cycle strategies', () => {
    const strategies = ['two_pass', 'upsert_external_id', 'nullable_lookup', 'unbreakable'];
    for (const s of strategies) {
      expect(forgeCycleStrategySchema.parse(s)).toBe(s);
    }
  });

  it('should reject invalid cycle strategy', () => {
    expect(() => forgeCycleStrategySchema.parse('delete_and_retry')).toThrow();
  });
});

// ─── Forge v2 Object Schema Tests ───────────────────────────────────────────

describe('forgeWaveSchema', () => {
  it('should parse valid wave', () => {
    const result = forgeWaveSchema.parse({
      order: 0,
      objectApiNames: ['Account', 'Contact'],
      totalRecords: 500,
      estimatedDurationSeconds: 30,
      estimatedApiCalls: 3,
    });
    expect(result.order).toBe(0);
    expect(result.objectApiNames).toHaveLength(2);
  });

  it('should reject negative order', () => {
    expect(() =>
      forgeWaveSchema.parse({
        order: -1,
        objectApiNames: [],
        totalRecords: 0,
        estimatedDurationSeconds: 0,
        estimatedApiCalls: 0,
      }),
    ).toThrow();
  });
});

describe('forgeCycleResolutionSchema', () => {
  it('should parse valid cycle resolution', () => {
    const result = forgeCycleResolutionSchema.parse({
      objects: ['Account', 'Contact'],
      strategy: 'two_pass',
      description: 'Break cycle via two-pass',
    });
    expect(result.strategy).toBe('two_pass');
  });

  it('should reject invalid strategy', () => {
    expect(() =>
      forgeCycleResolutionSchema.parse({ objects: [], strategy: 'invalid', description: '' }),
    ).toThrow();
  });
});

describe('forgePlanSchema', () => {
  it('should parse valid plan', () => {
    const result = forgePlanSchema.parse({
      waves: [
        {
          order: 0,
          objectApiNames: ['Account'],
          totalRecords: 10,
          estimatedDurationSeconds: 5,
          estimatedApiCalls: 1,
        },
      ],
      totalRecords: 10,
      totalApiCalls: 1,
      estimatedDurationSeconds: 5,
      cycleResolutions: [],
    });
    expect(result.waves).toHaveLength(1);
    expect(result.totalRecords).toBe(10);
  });

  it('should reject negative totalApiCalls', () => {
    expect(() =>
      forgePlanSchema.parse({
        waves: [],
        totalRecords: 0,
        totalApiCalls: -1,
        estimatedDurationSeconds: 0,
        cycleResolutions: [],
      }),
    ).toThrow();
  });
});

describe('forgeCheckpointSchema', () => {
  it('should parse valid checkpoint', () => {
    const result = forgeCheckpointSchema.parse({
      forgeId: 'forge-001',
      config: {
        inputMode: 'record',
        // 15-char strict Salesforce ID — forgeConfigSchema enforces the regex
        recordId: '001000000000123',
        depth: 'full',
        sourceOrgId: 'src',
        targetOrgId: 'tgt',
        anonymizePII: false,
        skipEmpty: false,
        batchSize: 'auto',
      },
      graph: {
        nodes: [],
        edges: [],
        totalRecords: 0,
        estimatedSizeMB: 0,
        estimatedDurationSeconds: 0,
      },
      plan: {
        waves: [],
        totalRecords: 0,
        totalApiCalls: 0,
        estimatedDurationSeconds: 0,
        cycleResolutions: [],
      },
      currentWaveIndex: 0,
      currentObjectIndex: 0,
      currentBatchIndex: 0,
      remapperState: { '001OLD': '001NEW' },
      completedObjects: ['Account'],
      timestamp: '2026-03-11T00:00:00.000Z',
    });
    expect(result.forgeId).toBe('forge-001');
    expect(result.remapperState['001OLD']).toBe('001NEW');
  });

  it('should reject negative currentWaveIndex', () => {
    expect(() =>
      forgeCheckpointSchema.parse({
        forgeId: 'x',
        config: {
          inputMode: 'record',
          recordId: 'x',
          depth: 'direct',
          sourceOrgId: 'a',
          targetOrgId: 'b',
          anonymizePII: false,
          skipEmpty: false,
          batchSize: 'auto',
        },
        graph: {
          nodes: [],
          edges: [],
          totalRecords: 0,
          estimatedSizeMB: 0,
          estimatedDurationSeconds: 0,
        },
        plan: {
          waves: [],
          totalRecords: 0,
          totalApiCalls: 0,
          estimatedDurationSeconds: 0,
          cycleResolutions: [],
        },
        currentWaveIndex: -1,
        currentObjectIndex: 0,
        currentBatchIndex: 0,
        remapperState: {},
        completedObjects: [],
        timestamp: 'x',
      }),
    ).toThrow();
  });
});

describe('forgeFileCopyOptionSchema', () => {
  it('takes a whole number of megabytes from one to what one call carries', () => {
    expect(
      forgeFileCopyOptionSchema.safeParse({ maxFileSizeMB: 10, acceptedAsIs: false }).success,
    ).toBe(true);
    expect(
      forgeFileCopyOptionSchema.safeParse({ maxFileSizeMB: 35, acceptedAsIs: true }).success,
    ).toBe(true);
  });

  it('refuses a size the API would not take in one call, and one that is not a size', () => {
    for (const maxFileSizeMB of [0, 36, 2.5, -1]) {
      expect(
        forgeFileCopyOptionSchema.safeParse({ maxFileSizeMB, acceptedAsIs: false }).success,
      ).toBe(false);
    }
  });

  it('needs the acceptance said either way', () => {
    expect(forgeFileCopyOptionSchema.safeParse({ maxFileSizeMB: 10 }).success).toBe(false);
  });
});
