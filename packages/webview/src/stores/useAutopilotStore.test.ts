import { describe, it, expect, beforeEach } from 'vitest';
import { useAutopilotStore } from './useAutopilotStore';
import type { AutopilotGraph, AutopilotNode } from '@sandforge/shared';

function createMockNode(overrides: Partial<AutopilotNode> = {}): AutopilotNode {
  return {
    objectApiName: 'Account',
    recordCount: 100,
    estimatedApiCalls: 10,
    piiFields: [],
    anonymizationRules: [],
    status: 'pending',
    progress: 0,
    insertOrder: 0,
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    elapsedMs: 0,
    apiCallsUsed: 0,
    ...overrides,
  };
}

function createMockGraph(nodes: AutopilotNode[] = []): AutopilotGraph {
  return {
    nodes:
      nodes.length > 0
        ? nodes
        : [
            createMockNode({ objectApiName: 'Account' }),
            createMockNode({ objectApiName: 'Contact', insertOrder: 1, level: 1 }),
            createMockNode({ objectApiName: 'Opportunity', insertOrder: 2, level: 1 }),
          ],
    edges: [],
    cycles: [],
    stats: {
      totalObjects: nodes.length > 0 ? nodes.length : 3,
      totalRelationships: 0,
      cycleCount: 0,
      maxDepth: 1,
      totalRecords: 300,
      totalEstimatedApiCalls: 30,
    },
  };
}

function getState(): ReturnType<typeof useAutopilotStore.getState> {
  return useAutopilotStore.getState();
}

describe('useAutopilotStore', () => {
  beforeEach(() => {
    getState().reset();
  });

  it('should have correct initial defaults', () => {
    const state = getState();
    expect(state.step).toBe('connect');
    expect(state.sourceOrgId).toBeNull();
    expect(state.targetOrgId).toBeNull();
    expect(state.selectedObjects).toEqual([]);
    expect(state.complianceFramework).toBe('none');
    expect(state.graph).toBeNull();
    expect(state.plan).toBeNull();
    expect(state.rules).toEqual([]);
    expect(state.executionStatus).toBe('idle');
    expect(state.selectedNodeName).toBeNull();
    expect(state.liveStats).toEqual({
      recordsProcessed: 0,
      recordsTotal: 0,
      apiCallsUsed: 0,
      apiCallsEstimated: 0,
      elapsedMs: 0,
      currentWave: 0,
      totalWaves: 0,
    });
    expect(state.errors).toEqual([]);
  });

  it('should change step via setStep', () => {
    getState().setStep('objects');
    expect(getState().step).toBe('objects');

    getState().setStep('executing');
    expect(getState().step).toBe('executing');
  });

  it('should update source and target org IDs', () => {
    getState().setSourceOrg('org-source-001');
    expect(getState().sourceOrgId).toBe('org-source-001');

    getState().setTargetOrg('org-target-002');
    expect(getState().targetOrgId).toBe('org-target-002');

    getState().setSourceOrg(null);
    expect(getState().sourceOrgId).toBeNull();

    getState().setTargetOrg(null);
    expect(getState().targetOrgId).toBeNull();
  });

  it('should toggle objects in selection', () => {
    getState().toggleObject('Account');
    expect(getState().selectedObjects).toEqual(['Account']);

    getState().toggleObject('Contact');
    expect(getState().selectedObjects).toEqual(['Account', 'Contact']);

    getState().toggleObject('Account');
    expect(getState().selectedObjects).toEqual(['Contact']);

    getState().toggleObject('Contact');
    expect(getState().selectedObjects).toEqual([]);
  });

  it('should store graph via setGraph', () => {
    const graph = createMockGraph();
    getState().setGraph(graph);
    expect(getState().graph).toEqual(graph);
    expect(getState().graph?.nodes).toHaveLength(3);

    getState().setGraph(null);
    expect(getState().graph).toBeNull();
  });

  it('should update correct node status in graph', () => {
    const graph = createMockGraph();
    getState().setGraph(graph);

    getState().updateNodeStatus('Contact', 'extracting', 25);

    const updatedGraph = getState().graph;
    const contactNode = updatedGraph?.nodes.find((n) => n.objectApiName === 'Contact');
    const accountNode = updatedGraph?.nodes.find((n) => n.objectApiName === 'Account');

    expect(contactNode?.status).toBe('extracting');
    expect(contactNode?.progress).toBe(25);
    expect(accountNode?.status).toBe('pending');
    expect(accountNode?.progress).toBe(0);
  });

  it('should update node status without progress when not provided', () => {
    const graph = createMockGraph();
    getState().setGraph(graph);

    getState().updateNodeStatus('Account', 'completed');

    const accountNode = getState().graph?.nodes.find((n) => n.objectApiName === 'Account');
    expect(accountNode?.status).toBe('completed');
    expect(accountNode?.progress).toBe(0);
  });

  it('should update node progress and recordsProcessed', () => {
    const graph = createMockGraph();
    getState().setGraph(graph);

    getState().updateNodeProgress('Opportunity', 60, 42);

    const oppNode = getState().graph?.nodes.find((n) => n.objectApiName === 'Opportunity');
    expect(oppNode?.progress).toBe(60);
    expect(oppNode?.successCount).toBe(42);
  });

  it('should merge partial live stats updates', () => {
    getState().updateLiveStats({ recordsProcessed: 50, recordsTotal: 200 });
    expect(getState().liveStats.recordsProcessed).toBe(50);
    expect(getState().liveStats.recordsTotal).toBe(200);
    expect(getState().liveStats.apiCallsUsed).toBe(0);

    getState().updateLiveStats({ apiCallsUsed: 10, currentWave: 2 });
    expect(getState().liveStats.recordsProcessed).toBe(50);
    expect(getState().liveStats.apiCallsUsed).toBe(10);
    expect(getState().liveStats.currentWave).toBe(2);
  });

  it('should reset all state to initial values', () => {
    getState().setStep('executing');
    getState().setSourceOrg('org-001');
    getState().setTargetOrg('org-002');
    getState().setSelectedObjects(['Account', 'Contact']);
    getState().setComplianceFramework('gdpr');
    getState().setGraph(createMockGraph());
    getState().setExecutionStatus('executing');
    getState().addError('something went wrong');
    getState().updateLiveStats({ recordsProcessed: 100 });

    getState().reset();

    const state = getState();
    expect(state.step).toBe('connect');
    expect(state.sourceOrgId).toBeNull();
    expect(state.targetOrgId).toBeNull();
    expect(state.selectedObjects).toEqual([]);
    expect(state.complianceFramework).toBe('none');
    expect(state.graph).toBeNull();
    expect(state.plan).toBeNull();
    expect(state.rules).toEqual([]);
    expect(state.executionStatus).toBe('idle');
    expect(state.selectedNodeName).toBeNull();
    expect(state.liveStats.recordsProcessed).toBe(0);
    expect(state.errors).toEqual([]);
  });

  it('should return the selected node via selectedNode()', () => {
    const graph = createMockGraph();
    getState().setGraph(graph);
    getState().selectNode('Contact');

    const node = getState().selectedNode();
    expect(node).toBeDefined();
    expect(node?.objectApiName).toBe('Contact');
  });

  it('should return undefined from selectedNode() when no node selected', () => {
    getState().setGraph(createMockGraph());
    expect(getState().selectedNode()).toBeUndefined();
  });

  it('should return undefined from selectedNode() when graph is null', () => {
    getState().selectNode('Account');
    expect(getState().selectedNode()).toBeUndefined();
  });

  it('should count completed nodes', () => {
    const graph = createMockGraph([
      createMockNode({ objectApiName: 'Account', status: 'completed' }),
      createMockNode({ objectApiName: 'Contact', status: 'completed' }),
      createMockNode({ objectApiName: 'Opportunity', status: 'extracting' }),
      createMockNode({ objectApiName: 'Case', status: 'failed' }),
    ]);
    getState().setGraph(graph);

    expect(getState().completedCount()).toBe(2);
  });

  it('should count failed nodes', () => {
    const graph = createMockGraph([
      createMockNode({ objectApiName: 'Account', status: 'completed' }),
      createMockNode({ objectApiName: 'Contact', status: 'failed' }),
      createMockNode({ objectApiName: 'Opportunity', status: 'failed' }),
    ]);
    getState().setGraph(graph);

    expect(getState().failedCount()).toBe(2);
  });

  it('should return 0 for completedCount/failedCount when graph is null', () => {
    expect(getState().completedCount()).toBe(0);
    expect(getState().failedCount()).toBe(0);
  });

  it('should compute correct overall progress percentage', () => {
    const graph = createMockGraph([
      createMockNode({ objectApiName: 'Account', progress: 100 }),
      createMockNode({ objectApiName: 'Contact', progress: 50 }),
      createMockNode({ objectApiName: 'Opportunity', progress: 0 }),
    ]);
    getState().setGraph(graph);

    expect(getState().overallProgress()).toBe(50);
  });

  it('should return 0 for overallProgress when graph is null', () => {
    expect(getState().overallProgress()).toBe(0);
  });

  it('should return 0 for overallProgress when graph has no nodes', () => {
    getState().setGraph(createMockGraph([]));
    expect(getState().overallProgress()).toBe(0);
  });

  it('should accumulate errors via addError', () => {
    getState().addError('Error 1');
    getState().addError('Error 2');
    expect(getState().errors).toEqual(['Error 1', 'Error 2']);
  });

  it('should not modify graph when updateNodeStatus is called with null graph', () => {
    getState().updateNodeStatus('Account', 'completed');
    expect(getState().graph).toBeNull();
  });

  it('should not modify graph when updateNodeProgress is called with null graph', () => {
    getState().updateNodeProgress('Account', 50, 25);
    expect(getState().graph).toBeNull();
  });
});
