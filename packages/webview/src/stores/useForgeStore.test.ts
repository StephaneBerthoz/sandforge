import { describe, it, expect, beforeEach } from 'vitest';
import { useForgeStore } from './useForgeStore';
import type {
  ForgeConfig,
  ForgeGraph,
  ForgeGraphNode,
  ForgeExecutionResult,
  ForgePlan,
} from './useForgeStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockNode(overrides: Partial<ForgeGraphNode> = {}): ForgeGraphNode {
  return {
    objectApiName: 'Account',
    recordCount: 100,
    fieldCount: 20,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 0,
    estimatedSizeMB: 0,
    estimatedApiCalls: 0,
    batchStrategy: 'auto',
    ...overrides,
  };
}

function createMockGraph(nodes?: ForgeGraphNode[]): ForgeGraph {
  return {
    nodes: nodes ?? [
      createMockNode({ objectApiName: 'Account' }),
      createMockNode({ objectApiName: 'Contact', level: 1 }),
    ],
    edges: [],
    totalRecords: 200,
    estimatedSizeMB: 3.5,
    estimatedDurationSeconds: 30,
  };
}

function createMockConfig(overrides: Partial<ForgeConfig> = {}): ForgeConfig {
  return {
    inputMode: 'record',
    depth: 'direct',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    anonymizePII: false,
    skipEmpty: false,
    batchSize: 'auto',
    ...overrides,
  };
}

function createMockResult(overrides: Partial<ForgeExecutionResult> = {}): ForgeExecutionResult {
  return {
    forgeId: 'exec-001',
    status: 'success',
    graph: createMockGraph(),
    duration: 5000,
    timestamp: new Date().toISOString(),
    idRemapCount: 10,
    ...overrides,
  };
}

function createMockPlan(): ForgePlan {
  return {
    waves: [
      {
        order: 0,
        objectApiNames: ['Account'],
        totalRecords: 100,
        estimatedDurationSeconds: 1,
        estimatedApiCalls: 1,
      },
    ],
    totalRecords: 100,
    totalApiCalls: 1,
    estimatedDurationSeconds: 1,
    cycleResolutions: [],
  };
}

function getState(): ReturnType<typeof useForgeStore.getState> {
  return useForgeStore.getState();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useForgeStore', () => {
  beforeEach(() => {
    getState().reset();
  });

  it('should have correct initial defaults', () => {
    const state = getState();
    expect(state.phase).toBe('input');
    expect(state.config).toBeNull();
    expect(state.graph).toBeNull();
    expect(state.result).toBeNull();
    expect(state.templates).toEqual([]);
    expect(state.history).toEqual([]);
  });

  it('should update config via setConfig', () => {
    const config = createMockConfig();
    getState().setConfig(config);
    expect(getState().config).toEqual(config);
  });

  it('should clear stale artifacts when setConfig is called', () => {
    // Set up stale state from a previous run
    getState().setPlan(createMockPlan());
    getState().setComplianceReport({
      id: 'rpt-stale',
    } as unknown as import('@sandforge/shared').ComplianceReport);
    getState().setMetadataDiffs([
      {
        objectApiName: 'Account',
        fieldApiName: 'Custom__c',
        issue: 'missing',
        severity: 'error',
        details: '',
      },
    ]);
    getState().setResult(createMockResult());
    getState().setGraph(createMockGraph());

    // Now set a new config
    const newConfig = createMockConfig({ recordId: '001NEW' });
    getState().setConfig(newConfig);

    // Stale artifacts should be cleared
    expect(getState().plan).toBeNull();
    expect(getState().complianceReport).toBeNull();
    expect(getState().metadataDiffs).toEqual([]);
    expect(getState().result).toBeNull();

    // Config should be updated
    expect(getState().config).toEqual(newConfig);

    // Graph, templates, and history should NOT be cleared
    expect(getState().graph).not.toBeNull();
  });

  it('should update graph via setGraph', () => {
    const graph = createMockGraph();
    getState().setGraph(graph);
    expect(getState().graph).toEqual(graph);
    expect(getState().graph?.nodes).toHaveLength(2);
  });

  it('should transition phase via setPhase', () => {
    getState().setPhase('discovery');
    expect(getState().phase).toBe('discovery');

    getState().setPhase('review');
    expect(getState().phase).toBe('review');

    getState().setPhase('execution');
    expect(getState().phase).toBe('execution');

    getState().setPhase('results');
    expect(getState().phase).toBe('results');
  });

  it('should update a specific node status via updateNodeStatus', () => {
    getState().setGraph(createMockGraph());

    getState().updateNodeStatus('Contact', 'running', 50);

    const contactNode = getState().graph?.nodes.find((n) => n.objectApiName === 'Contact');
    const accountNode = getState().graph?.nodes.find((n) => n.objectApiName === 'Account');

    expect(contactNode?.status).toBe('running');
    expect(contactNode?.progress).toBe(50);
    expect(accountNode?.status).toBe('idle');
    expect(accountNode?.progress).toBe(0);
  });

  it('should keep existing progress when updateNodeStatus is called without progress', () => {
    getState().setGraph(createMockGraph());
    getState().updateNodeStatus('Account', 'running', 30);
    getState().updateNodeStatus('Account', 'done');

    const accountNode = getState().graph?.nodes.find((n) => n.objectApiName === 'Account');
    expect(accountNode?.status).toBe('done');
    expect(accountNode?.progress).toBe(30);
  });

  it('should not modify state when updateNodeStatus is called with null graph', () => {
    getState().updateNodeStatus('Account', 'running');
    expect(getState().graph).toBeNull();
  });

  it('should toggle node included flag via toggleNodeIncluded', () => {
    getState().setGraph(createMockGraph());

    getState().toggleNodeIncluded('Contact');
    const contactOff = getState().graph?.nodes.find((n) => n.objectApiName === 'Contact');
    expect(contactOff?.included).toBe(false);

    getState().toggleNodeIncluded('Contact');
    const contactOn = getState().graph?.nodes.find((n) => n.objectApiName === 'Contact');
    expect(contactOn?.included).toBe(true);
  });

  it('should not modify other nodes when toggling included', () => {
    getState().setGraph(createMockGraph());
    getState().toggleNodeIncluded('Contact');

    const accountNode = getState().graph?.nodes.find((n) => n.objectApiName === 'Account');
    expect(accountNode?.included).toBe(true);
  });

  it('should not modify state when toggleNodeIncluded is called with null graph', () => {
    getState().toggleNodeIncluded('Account');
    expect(getState().graph).toBeNull();
  });

  it('should add a field to anonymizeFields via toggleAnonymizeField', () => {
    getState().setGraph(createMockGraph());

    getState().toggleAnonymizeField('Account', 'Email');
    const node = getState().graph?.nodes.find((n) => n.objectApiName === 'Account');
    expect(node?.anonymizeFields).toEqual(['Email']);
  });

  it('should remove a field from anonymizeFields via toggleAnonymizeField', () => {
    const graph = createMockGraph([
      createMockNode({ objectApiName: 'Account', anonymizeFields: ['Email', 'Phone'] }),
      createMockNode({ objectApiName: 'Contact' }),
    ]);
    getState().setGraph(graph);

    getState().toggleAnonymizeField('Account', 'Email');
    const node = getState().graph?.nodes.find((n) => n.objectApiName === 'Account');
    expect(node?.anonymizeFields).toEqual(['Phone']);
  });

  it('should not modify other nodes when toggling anonymizeField', () => {
    getState().setGraph(createMockGraph());
    getState().toggleAnonymizeField('Account', 'Email');

    const contactNode = getState().graph?.nodes.find((n) => n.objectApiName === 'Contact');
    expect(contactNode?.anonymizeFields).toEqual([]);
  });

  it('should not modify state when toggleAnonymizeField is called with null graph', () => {
    getState().toggleAnonymizeField('Account', 'Email');
    expect(getState().graph).toBeNull();
  });

  it('should set result and prepend to history via setResult', () => {
    const result = createMockResult();
    getState().setResult(result);

    expect(getState().result).toEqual(result);
    expect(getState().history).toHaveLength(1);
    expect(getState().history[0]).toEqual(result);
  });

  it('should prepend newer results to history', () => {
    const result1 = createMockResult({ forgeId: 'exec-001' });
    const result2 = createMockResult({ forgeId: 'exec-002' });

    getState().setResult(result1);
    getState().setResult(result2);

    expect(getState().history).toHaveLength(2);
    expect(getState().history[0].forgeId).toBe('exec-002');
    expect(getState().history[1].forgeId).toBe('exec-001');
  });

  it('should cap history at 50 entries', () => {
    for (let i = 0; i < 55; i++) {
      getState().setResult(createMockResult({ forgeId: `exec-${String(i).padStart(3, '0')}` }));
    }

    expect(getState().history).toHaveLength(50);
    expect(getState().history[0].forgeId).toBe('exec-054');
  });

  it('should reset config, graph, result, and phase to initial values', () => {
    getState().setConfig(createMockConfig());
    getState().setGraph(createMockGraph());
    getState().setPhase('execution');
    getState().setResult(createMockResult());

    getState().reset();

    const state = getState();
    expect(state.phase).toBe('input');
    expect(state.config).toBeNull();
    expect(state.graph).toBeNull();
    expect(state.result).toBeNull();
    expect(state.templates).toEqual([]);
    expect(state.history).toEqual([]);
  });

  // Review phase state tests

  it('should have correct initial review phase defaults', () => {
    const state = getState();
    expect(state.plan).toBeNull();
    expect(state.complianceReport).toBeNull();
    expect(state.metadataDiffs).toEqual([]);
    expect(state.anonymizationRules.email).toBe('fake');
    expect(state.anonymizationRules.phone).toBe('mask');
    expect(state.anonymizationRules.ssn_id).toBe('redact');
  });

  it('should set plan via setPlan', () => {
    const plan = createMockPlan();
    getState().setPlan(plan);
    expect(getState().plan).toEqual(plan);
  });

  it('should set compliance report via setComplianceReport', () => {
    const report = {
      id: 'rpt-1',
      framework: 'gdpr',
    } as unknown as import('@sandforge/shared').ComplianceReport;
    getState().setComplianceReport(report);
    expect(getState().complianceReport).toEqual(report);
  });

  it('should clear compliance report when set to null', () => {
    const report = { id: 'rpt-1' } as unknown as import('@sandforge/shared').ComplianceReport;
    getState().setComplianceReport(report);
    getState().setComplianceReport(null);
    expect(getState().complianceReport).toBeNull();
  });

  it('should set metadata diffs via setMetadataDiffs', () => {
    const diffs = [
      {
        objectApiName: 'Account',
        fieldApiName: 'Custom__c',
        issue: 'missing' as const,
        severity: 'error' as const,
        details: 'missing field',
      },
    ];
    getState().setMetadataDiffs(diffs);
    expect(getState().metadataDiffs).toHaveLength(1);
    expect(getState().metadataDiffs[0].issue).toBe('missing');
  });

  it('should update anonymization rule for a category', () => {
    getState().setAnonymizationRule('email', 'hash');
    expect(getState().anonymizationRules.email).toBe('hash');
    // Other categories unchanged
    expect(getState().anonymizationRules.phone).toBe('mask');
  });

  it('should update node batch strategy', () => {
    getState().setGraph(createMockGraph());
    getState().updateNodeBatchStrategy('Account', 'bulk');
    const node = getState().graph?.nodes.find((n) => n.objectApiName === 'Account');
    expect(node?.batchStrategy).toBe('bulk');
  });

  it('should not modify other nodes when updating batch strategy', () => {
    getState().setGraph(createMockGraph());
    getState().updateNodeBatchStrategy('Account', 'bulk');
    const contactNode = getState().graph?.nodes.find((n) => n.objectApiName === 'Contact');
    expect(contactNode?.batchStrategy).toBe('auto');
  });

  it('should reset review phase state on reset', () => {
    getState().setPlan(createMockPlan());
    getState().setAnonymizationRule('email', 'hash');
    getState().setMetadataDiffs([
      { objectApiName: 'A', fieldApiName: 'B', issue: 'missing', severity: 'error', details: '' },
    ]);
    getState().reset();

    const state = getState();
    expect(state.plan).toBeNull();
    expect(state.complianceReport).toBeNull();
    expect(state.metadataDiffs).toEqual([]);
    expect(state.anonymizationRules.email).toBe('fake');
  });

  describe('addTemplate', () => {
    it('should add a new template', () => {
      const { addTemplate } = getState();
      const template = {
        id: 'tpl-001',
        name: 'Test Template',
        description: 'A test',
        config: {
          inputMode: 'record' as const,
          depth: 'direct' as const,
          anonymizePII: false,
          skipEmpty: false,
          batchSize: 'auto' as const,
        },
        objectCount: 5,
        recordCount: 100,
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      };
      addTemplate(template);
      expect(getState().templates).toHaveLength(1);
      expect(getState().templates[0].name).toBe('Test Template');
    });
  });

  describe('updateTemplate', () => {
    it('should update template name and description', () => {
      const { addTemplate, updateTemplate } = getState();
      addTemplate({
        id: 'tpl-002',
        name: 'Old Name',
        description: 'Old desc',
        config: {
          inputMode: 'record' as const,
          depth: 'direct' as const,
          anonymizePII: false,
          skipEmpty: false,
          batchSize: 'auto' as const,
        },
        objectCount: 3,
        recordCount: 50,
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      });
      updateTemplate('tpl-002', { name: 'New Name', description: 'New desc' });
      const tpl = getState().templates.find((t) => t.id === 'tpl-002');
      expect(tpl?.name).toBe('New Name');
      expect(tpl?.description).toBe('New desc');
    });

    it('should not modify other templates', () => {
      const templates = getState().templates;
      const otherTemplates = templates.filter((t) => t.id !== 'tpl-002');
      otherTemplates.forEach((t) => {
        expect(t.name).not.toBe('New Name');
      });
    });
  });

  describe('addLog / clearLogs', () => {
    it('should add a log entry', () => {
      const { addLog } = useForgeStore.getState();
      addLog({ id: 'log-1', timestamp: Date.now(), level: 'info', message: 'Test log' });
      expect(useForgeStore.getState().logs).toHaveLength(1);
      expect(useForgeStore.getState().logs[0].message).toBe('Test log');
    });

    it('should clear all log entries', () => {
      const { addLog, clearLogs } = useForgeStore.getState();
      addLog({ id: 'log-1', timestamp: Date.now(), level: 'info', message: 'Test' });
      addLog({ id: 'log-2', timestamp: Date.now(), level: 'error', message: 'Error' });
      clearLogs();
      expect(useForgeStore.getState().logs).toHaveLength(0);
    });
  });

  describe('forgeAgain', () => {
    it('should clear result/graph/plan but preserve config', () => {
      const store = useForgeStore.getState();
      // Set up state
      store.setConfig({
        inputMode: 'record',
        recordId: '001xxx',
        depth: 'direct',
        sourceOrgId: 'org-1',
        targetOrgId: 'org-2',
        anonymizePII: false,
        skipEmpty: false,
        batchSize: 'auto',
      });
      store.setGraph({
        nodes: [],
        edges: [],
        totalRecords: 0,
        estimatedSizeMB: 0,
        estimatedDurationSeconds: 0,
      });
      store.setResult({
        forgeId: 'f1',
        status: 'success',
        graph: {
          nodes: [],
          edges: [],
          totalRecords: 0,
          estimatedSizeMB: 0,
          estimatedDurationSeconds: 0,
        },
        duration: 1000,
        timestamp: '2026-01-01',
        idRemapCount: 5,
      });
      store.addLog({ id: 'log-1', timestamp: Date.now(), level: 'info', message: 'test' });

      // Call forgeAgain
      useForgeStore.getState().forgeAgain();
      const state = useForgeStore.getState();

      expect(state.phase).toBe('input');
      expect(state.config).not.toBeNull(); // Config preserved
      expect(state.graph).toBeNull();
      expect(state.result).toBeNull();
      expect(state.plan).toBeNull();
      expect(state.logs).toHaveLength(0);
    });
  });
});
