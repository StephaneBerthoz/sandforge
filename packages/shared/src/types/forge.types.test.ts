import { describe, it, expect } from 'vitest';
import type {
  ForgeInputMode,
  ForgeDepth,
  ForgeNodeStatus,
  ForgeConfig,
  ForgeGraphNode,
  ForgeGraphEdge,
  ForgeGraph,
  ForgeExecutionResult,
  ForgeTemplate,
  ForgeAnonymizationCategory,
  ForgeBatchStrategy,
  ForgeCycleStrategy,
  ForgeWave,
  ForgePlan,
  ForgeCycleResolution,
  ForgeCheckpoint,
} from './forge.types.js';

describe('forge.types', () => {
  it('should support all ForgeInputMode values', () => {
    const modes: ForgeInputMode[] = ['record', 'soql', 'template', 'ai'];
    expect(modes).toHaveLength(4);
  });

  it('should support all ForgeDepth values', () => {
    const depths: ForgeDepth[] = ['direct', 'full', 'custom'];
    expect(depths).toHaveLength(3);
  });

  it('should support all ForgeNodeStatus values', () => {
    const statuses: ForgeNodeStatus[] = ['idle', 'scanning', 'running', 'done', 'error', 'skipped'];
    expect(statuses).toHaveLength(6);
  });

  it('should compile ForgeConfig with all required fields', () => {
    const config: ForgeConfig = {
      inputMode: 'record',
      recordId: '001xx000003DGbY',
      depth: 'full',
      sourceOrgId: 'org-source',
      targetOrgId: 'org-target',
      anonymizePII: true,
      skipEmpty: false,
      batchSize: 'auto',
    };
    expect(config.inputMode).toBe('record');
    expect(config.batchSize).toBe('auto');
  });

  it('should compile ForgeConfig with numeric batchSize', () => {
    const config: ForgeConfig = {
      inputMode: 'soql',
      soqlQuery: 'SELECT Id FROM Account',
      depth: 'direct',
      sourceOrgId: 'org-1',
      targetOrgId: 'org-2',
      anonymizePII: false,
      skipEmpty: true,
      batchSize: 200,
    };
    expect(config.batchSize).toBe(200);
  });

  it('should compile ForgeConfig with optional fields', () => {
    const config: ForgeConfig = {
      inputMode: 'ai',
      aiPrompt: 'Generate test data for Account',
      depth: 'custom',
      customDepth: 3,
      sourceOrgId: 'org-a',
      targetOrgId: 'org-b',
      anonymizePII: true,
      skipEmpty: false,
      batchSize: 'auto',
    };
    expect(config.customDepth).toBe(3);
    expect(config.aiPrompt).toBeDefined();
  });

  it('should compile ForgeGraphNode with all required fields', () => {
    const node: ForgeGraphNode = {
      objectApiName: 'Account',
      recordCount: 150,
      fieldCount: 42,
      status: 'idle',
      progress: 0,
      included: true,
      piiFields: ['Email', 'Phone'],
      anonymizeFields: ['Email'],
      level: 0,
      successCount: 0,
      failureCount: 0,
      errors: [],
      createableFieldCount: 0,
      estimatedSizeMB: 0,
      estimatedApiCalls: 0,
      batchStrategy: 'auto',
    };
    expect(node.objectApiName).toBe('Account');
    expect(node.piiFields).toHaveLength(2);
  });

  it('should compile ForgeGraphEdge', () => {
    const edge: ForgeGraphEdge = {
      sourceObject: 'Account',
      targetObject: 'Contact',
      relationshipName: 'Contacts',
      type: 'master-detail',
    };
    expect(edge.sourceObject).toBe('Account');
    expect(edge.type).toBe('master-detail');
  });

  it('should compile ForgeGraph', () => {
    const graph: ForgeGraph = {
      nodes: [],
      edges: [],
      totalRecords: 0,
      estimatedSizeMB: 0,
      estimatedDurationSeconds: 0,
    };
    expect(graph.nodes).toHaveLength(0);
    expect(graph.estimatedSizeMB).toBe(0);
  });

  it('should compile ForgeExecutionResult', () => {
    const result: ForgeExecutionResult = {
      forgeId: 'forge-001',
      status: 'success',
      graph: {
        nodes: [],
        edges: [],
        totalRecords: 500,
        estimatedSizeMB: 2.5,
        estimatedDurationSeconds: 120,
      },
      duration: 118000,
      timestamp: '2026-03-07T10:00:00.000Z',
      idRemapCount: 500,
    };
    expect(result.forgeId).toBe('forge-001');
    expect(result.status).toBe('success');
    expect(result.idRemapCount).toBe(500);
  });

  it('should compile ForgeExecutionResult with partial status', () => {
    const result: ForgeExecutionResult = {
      forgeId: 'forge-002',
      status: 'partial',
      graph: {
        nodes: [],
        edges: [],
        totalRecords: 100,
        estimatedSizeMB: 0.5,
        estimatedDurationSeconds: 30,
      },
      duration: 25000,
      timestamp: '2026-03-07T11:00:00.000Z',
      idRemapCount: 80,
    };
    expect(result.status).toBe('partial');
  });

  it('should compile ForgeTemplate', () => {
    const template: ForgeTemplate = {
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
    expect(template.id).toBe('tpl-001');
    expect(template.config.inputMode).toBe('record');
    expect(template.objectCount).toBe(5);
  });

  it('should support all ForgeAnonymizationCategory values', () => {
    const categories: ForgeAnonymizationCategory[] = ['email', 'phone', 'name', 'address', 'ssn_id', 'financial', 'other'];
    expect(categories).toHaveLength(7);
  });

  it('should support all ForgeBatchStrategy values', () => {
    const strategies: ForgeBatchStrategy[] = ['rest', 'bulk', 'auto'];
    expect(strategies).toHaveLength(3);
  });

  it('should support all ForgeCycleStrategy values', () => {
    const strategies: ForgeCycleStrategy[] = ['two_pass', 'upsert_external_id', 'nullable_lookup'];
    expect(strategies).toHaveLength(3);
  });

  it('should compile ForgeWave', () => {
    const wave: ForgeWave = {
      order: 0,
      objectApiNames: ['Account', 'Contact'],
      totalRecords: 500,
      estimatedDurationSeconds: 30,
      estimatedApiCalls: 3,
    };
    expect(wave.order).toBe(0);
    expect(wave.objectApiNames).toHaveLength(2);
  });

  it('should compile ForgeCycleResolution', () => {
    const resolution: ForgeCycleResolution = {
      objects: ['Account', 'Contact'],
      strategy: 'two_pass',
      description: 'Break cycle with two-pass insert',
    };
    expect(resolution.strategy).toBe('two_pass');
  });

  it('should compile ForgePlan', () => {
    const plan: ForgePlan = {
      waves: [],
      totalRecords: 0,
      totalApiCalls: 0,
      estimatedDurationSeconds: 0,
      cycleResolutions: [],
    };
    expect(plan.waves).toHaveLength(0);
  });

  it('should compile ForgeCheckpoint', () => {
    const checkpoint: ForgeCheckpoint = {
      forgeId: 'forge-001',
      config: {
        inputMode: 'record',
        recordId: '001xx000003DGbY',
        depth: 'full',
        sourceOrgId: 'org-source',
        targetOrgId: 'org-target',
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
      remapperState: {},
      completedObjects: [],
      timestamp: '2026-03-11T00:00:00.000Z',
    };
    expect(checkpoint.forgeId).toBe('forge-001');
  });
});
