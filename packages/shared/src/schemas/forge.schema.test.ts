import { describe, it, expect } from 'vitest';

import {
  forgeInputModeSchema,
  forgeDepthSchema,
  forgeNodeStatusSchema,
  forgeEdgeTypeSchema,
  forgeExecutionStatusSchema,
  forgeBatchStrategySchema,
  forgeAnonymizationCategorySchema,
  forgeCycleStrategySchema,
  forgeConfigSchema,
  forgeGraphNodeSchema,
  forgeGraphEdgeSchema,
  forgeGraphSchema,
  forgeExecutionResultSchema,
  forgeTemplateSchema,
  forgeWaveSchema,
  forgeCycleResolutionSchema,
  forgePlanSchema,
  forgeCheckpointSchema,
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

function createValidForgeExecutionResult(): Record<string, unknown> {
  return {
    forgeId: 'forge-001',
    status: 'success',
    graph: createValidForgeGraph(),
    duration: 58000,
    timestamp: '2026-03-07T10:00:00.000Z',
    idRemapCount: 100,
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

describe('forgeExecutionStatusSchema', () => {
  it('should accept all valid execution statuses', () => {
    const statuses = ['success', 'partial', 'failure'];
    for (const s of statuses) {
      expect(forgeExecutionStatusSchema.parse(s)).toBe(s);
    }
  });

  it('should reject invalid execution status', () => {
    expect(() => forgeExecutionStatusSchema.parse('timeout')).toThrow();
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

// ─── Execution Result Schema Tests ───────────────────────────────────────────

describe('forgeExecutionResultSchema', () => {
  it('should parse valid execution result', () => {
    const result = forgeExecutionResultSchema.parse(createValidForgeExecutionResult());
    expect(result.forgeId).toBe('forge-001');
    expect(result.status).toBe('success');
    expect(result.idRemapCount).toBe(100);
  });

  it('should accept partial status', () => {
    const result = forgeExecutionResultSchema.parse({
      ...createValidForgeExecutionResult(),
      status: 'partial',
    });
    expect(result.status).toBe('partial');
  });

  it('should accept failure status', () => {
    const result = forgeExecutionResultSchema.parse({
      ...createValidForgeExecutionResult(),
      status: 'failure',
    });
    expect(result.status).toBe('failure');
  });

  it('should reject empty forgeId', () => {
    expect(() =>
      forgeExecutionResultSchema.parse({ ...createValidForgeExecutionResult(), forgeId: '' }),
    ).toThrow();
  });

  it('should reject invalid status', () => {
    expect(() =>
      forgeExecutionResultSchema.parse({ ...createValidForgeExecutionResult(), status: 'timeout' }),
    ).toThrow();
  });

  it('should reject negative duration', () => {
    expect(() =>
      forgeExecutionResultSchema.parse({ ...createValidForgeExecutionResult(), duration: -100 }),
    ).toThrow();
  });

  it('should reject negative idRemapCount', () => {
    expect(() =>
      forgeExecutionResultSchema.parse({ ...createValidForgeExecutionResult(), idRemapCount: -1 }),
    ).toThrow();
  });

  it('should reject empty timestamp', () => {
    expect(() =>
      forgeExecutionResultSchema.parse({ ...createValidForgeExecutionResult(), timestamp: '' }),
    ).toThrow();
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

describe('forgeCycleStrategySchema', () => {
  it('should accept all valid cycle strategies', () => {
    const strategies = ['two_pass', 'upsert_external_id', 'nullable_lookup'];
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
        recordId: '001AP00000j2CEg',
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
