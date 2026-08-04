import { describe, it, expect } from 'vitest';
import { ExecutionPlanGenerator } from './ExecutionPlanGenerator.js';
import type {
  AutopilotGraph,
  AutopilotNode,
  AutopilotEdge,
  AnonymizationSummary,
  ComplianceFrameworkType,
  CycleResolution,
  GraphStats,
} from '@sandforge/shared';

/** Helper to create a minimal AutopilotNode */
function makeNode(objectApiName: string, overrides: Partial<AutopilotNode> = {}): AutopilotNode {
  return {
    objectApiName,
    recordCount: 100,
    estimatedApiCalls: 1,
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

/** Helper to create a minimal AutopilotEdge */
function makeEdge(from: string, to: string, overrides: Partial<AutopilotEdge> = {}): AutopilotEdge {
  return {
    from,
    to,
    fieldApiName: `${from}Id`,
    relationshipType: 'lookup',
    required: false,
    ...overrides,
  };
}

/** Helper to create a minimal GraphStats */
function makeStats(overrides: Partial<GraphStats> = {}): GraphStats {
  return {
    totalObjects: 0,
    totalRelationships: 0,
    cycleCount: 0,
    maxDepth: 0,
    totalRecords: 0,
    totalEstimatedApiCalls: 0,
    ...overrides,
  };
}

/** Helper to create a minimal AnonymizationSummary */
function makeSummary(overrides: Partial<AnonymizationSummary> = {}): AnonymizationSummary {
  return {
    totalPiiFields: 0,
    totalFieldsToAnonymize: 0,
    methodBreakdown: {
      fake: 0,
      mask: 0,
      hash: 0,
      nullify: 0,
      redact: 0,
      shuffle: 0,
      truncate: 0,
      preserve_format: 0,
      age_band: 0,
      generalize: 0,
      constant: 0,
    },
    objectsWithPii: [],
    ...overrides,
  };
}

/** Helper to build a graph from nodes, edges, and optional cycles */
function makeGraph(
  nodes: AutopilotNode[],
  edges: AutopilotEdge[] = [],
  cycles: CycleResolution[] = [],
): AutopilotGraph {
  const totalRecords = nodes.reduce((sum, n) => sum + n.recordCount, 0);
  const totalEstimatedApiCalls = nodes.reduce((sum, n) => sum + n.estimatedApiCalls, 0);
  const maxDepth = nodes.length > 0 ? Math.max(...nodes.map((n) => n.level)) : 0;

  return {
    nodes,
    edges,
    cycles,
    stats: makeStats({
      totalObjects: nodes.length,
      totalRelationships: edges.length,
      cycleCount: cycles.length,
      maxDepth,
      totalRecords,
      totalEstimatedApiCalls,
    }),
  };
}

describe('ExecutionPlanGenerator', () => {
  const generator = new ExecutionPlanGenerator();
  const framework: ComplianceFrameworkType = 'gdpr';
  const summary = makeSummary();

  it('should return empty waves and 0 totals for an empty graph', () => {
    const graph = makeGraph([]);
    const plan = generator.generate(graph, framework, summary);

    expect(plan.waves).toEqual([]);
    expect(plan.totalRecords).toBe(0);
    expect(plan.estimatedDurationSec).toBe(0);
    expect(plan.estimatedApiCalls).toBe(0);
  });

  it('should produce 1 wave with 1 object for a single-object graph', () => {
    const graph = makeGraph([
      makeNode('Account', { insertOrder: 0, level: 0, recordCount: 50, estimatedApiCalls: 2 }),
    ]);
    const plan = generator.generate(graph, framework, summary);

    expect(plan.waves).toHaveLength(1);
    expect(plan.waves[0].order).toBe(0);
    expect(plan.waves[0].objects).toEqual(['Account']);
    expect(plan.waves[0].dependsOn).toEqual([]);
    expect(plan.totalRecords).toBe(50);
  });

  it('should produce 3 sequential waves for a linear chain A -> B -> C', () => {
    const nodes = [
      makeNode('Account', { insertOrder: 0, level: 0, estimatedApiCalls: 3 }),
      makeNode('Contact', { insertOrder: 1, level: 1, estimatedApiCalls: 5 }),
      makeNode('Case', { insertOrder: 2, level: 2, estimatedApiCalls: 2 }),
    ];
    const edges = [makeEdge('Account', 'Contact'), makeEdge('Contact', 'Case')];
    const graph = makeGraph(nodes, edges);
    const plan = generator.generate(graph, framework, summary);

    expect(plan.waves).toHaveLength(3);

    // Wave 0: Account, no dependencies
    expect(plan.waves[0].objects).toEqual(['Account']);
    expect(plan.waves[0].dependsOn).toEqual([]);

    // Wave 1: Contact, depends on wave 0
    expect(plan.waves[1].objects).toEqual(['Contact']);
    expect(plan.waves[1].dependsOn).toEqual([0]);

    // Wave 2: Case, depends on wave 1
    expect(plan.waves[2].objects).toEqual(['Case']);
    expect(plan.waves[2].dependsOn).toEqual([1]);
  });

  it('should group two independent objects into 1 wave (parallel)', () => {
    const nodes = [
      makeNode('Account', { insertOrder: 0, level: 0, estimatedApiCalls: 3 }),
      makeNode('Product2', { insertOrder: 1, level: 0, estimatedApiCalls: 2 }),
    ];
    const graph = makeGraph(nodes);
    const plan = generator.generate(graph, framework, summary);

    expect(plan.waves).toHaveLength(1);
    expect(plan.waves[0].objects).toContain('Account');
    expect(plan.waves[0].objects).toContain('Product2');
    expect(plan.waves[0].dependsOn).toEqual([]);
  });

  it('should handle diamond pattern A->B, A->C, B->D, C->D correctly', () => {
    const nodes = [
      makeNode('A', { insertOrder: 0, level: 0, estimatedApiCalls: 1 }),
      makeNode('B', { insertOrder: 1, level: 1, estimatedApiCalls: 2 }),
      makeNode('C', { insertOrder: 2, level: 1, estimatedApiCalls: 3 }),
      makeNode('D', { insertOrder: 3, level: 2, estimatedApiCalls: 1 }),
    ];
    const edges = [makeEdge('A', 'B'), makeEdge('A', 'C'), makeEdge('B', 'D'), makeEdge('C', 'D')];
    const graph = makeGraph(nodes, edges);
    const plan = generator.generate(graph, framework, summary);

    expect(plan.waves).toHaveLength(3);

    // Wave 0: A (root)
    expect(plan.waves[0].objects).toEqual(['A']);
    expect(plan.waves[0].dependsOn).toEqual([]);

    // Wave 1: B and C (parallel, both depend on wave 0)
    expect(plan.waves[1].objects).toContain('B');
    expect(plan.waves[1].objects).toContain('C');
    expect(plan.waves[1].dependsOn).toEqual([0]);

    // Wave 2: D (depends on wave 1 which contains B and C)
    expect(plan.waves[2].objects).toEqual(['D']);
    expect(plan.waves[2].dependsOn).toEqual([1]);
  });

  it('should estimate duration as sum of max API calls per wave * avgSecondsPerApiCall', () => {
    // Wave 0: A(3 calls), B(5 calls) -> max = 5
    // Wave 1: C(2 calls) -> max = 2
    // Total duration = (5 + 2) * 0.5 = 3.5
    const nodes = [
      makeNode('A', { insertOrder: 0, level: 0, estimatedApiCalls: 3 }),
      makeNode('B', { insertOrder: 1, level: 0, estimatedApiCalls: 5 }),
      makeNode('C', { insertOrder: 2, level: 1, estimatedApiCalls: 2 }),
    ];
    const edges = [makeEdge('A', 'C')];
    const graph = makeGraph(nodes, edges);
    const plan = generator.generate(graph, framework, summary);

    expect(plan.estimatedDurationSec).toBe(3.5);
  });

  it('should pass through cycle resolutions from the graph', () => {
    const cycleResolutions: CycleResolution[] = [
      {
        objects: ['Account', 'Contact'],
        strategy: 'two_pass',
        description: 'Break Account <-> Contact cycle with two-pass insert',
      },
    ];
    const graph = makeGraph(
      [makeNode('Account', { insertOrder: 0, level: 0 })],
      [],
      cycleResolutions,
    );
    const plan = generator.generate(graph, framework, summary);

    expect(plan.cycleResolutions).toEqual(cycleResolutions);
    expect(plan.cycleResolutions).toHaveLength(1);
    expect(plan.cycleResolutions[0].strategy).toBe('two_pass');
  });

  it('should respect custom avgSecondsPerApiCall', () => {
    const customGenerator = new ExecutionPlanGenerator({
      avgSecondsPerApiCall: 1.0,
    });
    const nodes = [makeNode('Account', { insertOrder: 0, level: 0, estimatedApiCalls: 4 })];
    const graph = makeGraph(nodes);
    const plan = customGenerator.generate(graph, framework, summary);

    // 4 calls * 1.0 sec = 4.0
    expect(plan.estimatedDurationSec).toBe(4.0);
  });

  it('should pass through the compliance framework in the plan', () => {
    const graph = makeGraph([makeNode('Account', { insertOrder: 0, level: 0 })]);

    const hipaaplan = generator.generate(graph, 'hipaa', summary);
    expect(hipaaplan.complianceFramework).toBe('hipaa');

    const ccpaPlan = generator.generate(graph, 'ccpa', summary);
    expect(ccpaPlan.complianceFramework).toBe('ccpa');

    const nonePlan = generator.generate(graph, 'none', summary);
    expect(nonePlan.complianceFramework).toBe('none');
  });

  it('should handle a large graph with 20 objects across multiple levels', () => {
    // Build a graph: 5 roots (level 0), 5 at level 1, 5 at level 2, 5 at level 3
    const nodes: AutopilotNode[] = [];
    const edges: AutopilotEdge[] = [];

    for (let level = 0; level < 4; level++) {
      for (let i = 0; i < 5; i++) {
        const idx = level * 5 + i;
        nodes.push(
          makeNode(`Object${idx}`, {
            insertOrder: idx,
            level,
            recordCount: 100,
            estimatedApiCalls: 2,
          }),
        );

        // Each non-root object depends on corresponding object in previous level
        if (level > 0) {
          const parentIdx = (level - 1) * 5 + i;
          edges.push(makeEdge(`Object${parentIdx}`, `Object${idx}`));
        }
      }
    }

    const graph = makeGraph(nodes, edges);
    const plan = generator.generate(graph, framework, summary);

    expect(plan.waves).toHaveLength(4);
    expect(plan.waves[0].objects).toHaveLength(5);
    expect(plan.waves[1].objects).toHaveLength(5);
    expect(plan.waves[2].objects).toHaveLength(5);
    expect(plan.waves[3].objects).toHaveLength(5);
    expect(plan.totalRecords).toBe(2000);

    // Wave 0 has no dependencies
    expect(plan.waves[0].dependsOn).toEqual([]);
    // Wave 1 depends on wave 0
    expect(plan.waves[1].dependsOn).toEqual([0]);
    // Wave 2 depends on wave 1
    expect(plan.waves[2].dependsOn).toEqual([1]);
    // Wave 3 depends on wave 2
    expect(plan.waves[3].dependsOn).toEqual([2]);

    // Duration: 4 waves, each with max 2 API calls -> 4 * 2 * 0.5 = 4.0
    expect(plan.estimatedDurationSec).toBe(4.0);
  });
});
