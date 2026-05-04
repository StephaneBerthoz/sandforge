import { describe, it, expect } from 'vitest';
import { ObjectGraph } from './ObjectGraph';
import type { GraphEdge } from './ObjectGraph';

function createEdge(
  overrides: Partial<GraphEdge> & Pick<GraphEdge, 'source' | 'target'>,
): GraphEdge {
  return {
    fieldName: `${overrides.target}Id`,
    type: 'lookup',
    required: false,
    cascadeDelete: false,
    ...overrides,
  };
}

describe('ObjectGraph', () => {
  it('should add nodes and track counts', () => {
    const graph = new ObjectGraph();
    graph.addNode('Account');
    graph.addNode('Contact');
    graph.addNode('Opportunity');

    expect(graph.nodeCount).toBe(3);
    expect(graph.edgeCount).toBe(0);
    expect(graph.getNodes()).toHaveLength(3);
  });

  it('should not duplicate nodes when adding the same name', () => {
    const graph = new ObjectGraph();
    graph.addNode('Account');
    graph.addNode('Account');

    expect(graph.nodeCount).toBe(1);
  });

  it('should add edges and update degree counts', () => {
    const graph = new ObjectGraph();
    graph.addEdge(createEdge({ source: 'Contact', target: 'Account' }));

    const nodes = graph.getNodes();
    const contact = nodes.find((n) => n.objectName === 'Contact');
    const account = nodes.find((n) => n.objectName === 'Account');

    expect(contact?.outDegree).toBe(1);
    expect(contact?.inDegree).toBe(0);
    expect(account?.inDegree).toBe(1);
    expect(account?.outDegree).toBe(0);
    expect(graph.edgeCount).toBe(1);
  });

  it('should return dependencies and dependents', () => {
    const graph = new ObjectGraph();
    graph.addEdge(createEdge({ source: 'Contact', target: 'Account' }));
    graph.addEdge(createEdge({ source: 'Opportunity', target: 'Account' }));

    expect(graph.getDependencies('Contact')).toEqual(['Account']);
    expect(graph.getDependencies('Account')).toEqual([]);
    expect(graph.getDependents('Account')).toContain('Contact');
    expect(graph.getDependents('Account')).toContain('Opportunity');
  });

  it('should return empty arrays for unknown nodes', () => {
    const graph = new ObjectGraph();
    expect(graph.getDependencies('Unknown')).toEqual([]);
    expect(graph.getDependents('Unknown')).toEqual([]);
  });

  it('should perform topological sort on a DAG', () => {
    const graph = new ObjectGraph();
    // Account has no deps, Contact depends on Account, Opportunity depends on Account
    graph.addEdge(createEdge({ source: 'Contact', target: 'Account' }));
    graph.addEdge(createEdge({ source: 'Opportunity', target: 'Account' }));
    graph.addEdge(createEdge({ source: 'OpportunityContactRole', target: 'Contact' }));
    graph.addEdge(createEdge({ source: 'OpportunityContactRole', target: 'Opportunity' }));

    const sorted = graph.topologicalSort();

    expect(sorted).toBeDefined();
    expect(sorted).toHaveLength(4);

    // Account must come before Contact and Opportunity
    const accountIdx = sorted!.indexOf('Account');
    const contactIdx = sorted!.indexOf('Contact');
    const oppIdx = sorted!.indexOf('Opportunity');
    const ocrIdx = sorted!.indexOf('OpportunityContactRole');

    expect(accountIdx).toBeLessThan(contactIdx);
    expect(accountIdx).toBeLessThan(oppIdx);
    expect(contactIdx).toBeLessThan(ocrIdx);
    expect(oppIdx).toBeLessThan(ocrIdx);
  });

  it('should return undefined for topological sort when cycles exist', () => {
    const graph = new ObjectGraph();
    graph.addEdge(createEdge({ source: 'A', target: 'B' }));
    graph.addEdge(createEdge({ source: 'B', target: 'C' }));
    graph.addEdge(createEdge({ source: 'C', target: 'A' }));

    const sorted = graph.topologicalSort();

    expect(sorted).toBeUndefined();
  });

  it('should detect cycles', () => {
    const graph = new ObjectGraph();
    graph.addEdge(createEdge({ source: 'A', target: 'B' }));
    graph.addEdge(createEdge({ source: 'B', target: 'C' }));
    graph.addEdge(createEdge({ source: 'C', target: 'A' }));

    const cycles = graph.detectCycles();

    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0].objects).toContain('A');
    expect(cycles[0].objects).toContain('B');
    expect(cycles[0].objects).toContain('C');
  });

  it('should identify breakable edges in cycles (prefer non-required)', () => {
    const graph = new ObjectGraph();
    graph.addEdge(createEdge({ source: 'A', target: 'B', required: true, type: 'master_detail' }));
    graph.addEdge(createEdge({ source: 'B', target: 'C', required: false, type: 'lookup' }));
    graph.addEdge(createEdge({ source: 'C', target: 'A', required: true, type: 'master_detail' }));

    const cycles = graph.detectCycles();

    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0].breakableAt).toBe('B');
  });

  it('should detect no cycles in a DAG', () => {
    const graph = new ObjectGraph();
    graph.addEdge(createEdge({ source: 'Contact', target: 'Account' }));
    graph.addEdge(createEdge({ source: 'Opportunity', target: 'Account' }));

    const cycles = graph.detectCycles();

    expect(cycles).toHaveLength(0);
  });

  it('should compute layers for parallel execution', () => {
    const graph = new ObjectGraph();
    graph.addEdge(createEdge({ source: 'Contact', target: 'Account' }));
    graph.addEdge(createEdge({ source: 'Opportunity', target: 'Account' }));
    graph.addEdge(createEdge({ source: 'OpportunityContactRole', target: 'Contact' }));
    graph.addEdge(createEdge({ source: 'OpportunityContactRole', target: 'Opportunity' }));

    const layers = graph.computeLayers();

    expect(layers.length).toBeGreaterThanOrEqual(3);
    // First layer should contain Account (no dependencies)
    expect(layers[0]).toContain('Account');
    // Second layer should contain Contact and Opportunity
    expect(layers[1]).toContain('Contact');
    expect(layers[1]).toContain('Opportunity');
    // Third layer should contain OpportunityContactRole
    expect(layers[2]).toContain('OpportunityContactRole');
  });

  it('should return empty layers when cycles exist', () => {
    const graph = new ObjectGraph();
    graph.addEdge(createEdge({ source: 'A', target: 'B' }));
    graph.addEdge(createEdge({ source: 'B', target: 'A' }));

    const layers = graph.computeLayers();

    expect(layers).toEqual([]);
  });

  it('should handle self-reference edges', () => {
    const graph = new ObjectGraph();
    graph.addNode('Account');
    graph.addEdge(
      createEdge({
        source: 'Account',
        target: 'Account',
        type: 'self_reference',
        fieldName: 'ParentId',
      }),
    );

    expect(graph.nodeCount).toBe(1);
    expect(graph.edgeCount).toBe(1);
    expect(graph.getDependencies('Account')).toEqual(['Account']);
    expect(graph.getDependents('Account')).toEqual(['Account']);
  });

  it('should not duplicate adjacency entries for multiple edges between same nodes', () => {
    const graph = new ObjectGraph();
    graph.addEdge(createEdge({ source: 'Contact', target: 'Account', fieldName: 'AccountId' }));
    graph.addEdge(
      createEdge({ source: 'Contact', target: 'Account', fieldName: 'ReportsToAccountId' }),
    );

    // Two edge records stored
    expect(graph.edgeCount).toBe(2);
    // But adjacency list should not have duplicates
    expect(graph.getDependencies('Contact')).toEqual(['Account']);
  });

  it('should clear the graph completely', () => {
    const graph = new ObjectGraph();
    graph.addEdge(createEdge({ source: 'Contact', target: 'Account' }));
    graph.addEdge(createEdge({ source: 'Opportunity', target: 'Account' }));

    graph.clear();

    expect(graph.nodeCount).toBe(0);
    expect(graph.edgeCount).toBe(0);
    expect(graph.getNodes()).toEqual([]);
    expect(graph.getEdges()).toEqual([]);
  });

  it('should return copies of edges array', () => {
    const graph = new ObjectGraph();
    graph.addEdge(createEdge({ source: 'Contact', target: 'Account' }));

    const edges = graph.getEdges();
    edges.push(createEdge({ source: 'Fake', target: 'Fake' }));

    expect(graph.edgeCount).toBe(1);
  });
});
