import { describe, it, expect } from 'vitest';

import { DependencyGraphBuilder, type GraphObjectDescribe } from './DependencyGraphBuilder.js';

/** Helper: create a simple describe with optional reference fields. */
function makeDescribe(
  name: string,
  refs: Array<{
    fieldName: string;
    referenceTo: string[];
    nillable?: boolean;
    relationshipName?: string | null;
  }> = [],
): GraphObjectDescribe {
  return {
    name,
    fields: [
      // Always add an Id field
      {
        name: 'Id',
        type: 'id',
        nillable: false,
        referenceTo: [],
        relationshipName: null,
      },
      // Always add a Name field
      {
        name: 'Name',
        type: 'string',
        nillable: false,
        referenceTo: [],
        relationshipName: null,
      },
      // Add reference fields
      ...refs.map((r) => ({
        name: r.fieldName,
        type: 'reference',
        nillable: r.nillable ?? true,
        referenceTo: r.referenceTo,
        relationshipName: r.relationshipName ?? null,
      })),
    ],
  };
}

describe('DependencyGraphBuilder', () => {
  const builder = new DependencyGraphBuilder();

  it('should handle empty graph — 0 objects', () => {
    const describes = new Map<string, GraphObjectDescribe>();
    const recordCounts = new Map<string, number>();

    const graph = builder.build(describes, recordCounts);

    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
    expect(graph.cycles).toHaveLength(0);
    expect(graph.stats).toEqual({
      totalObjects: 0,
      totalRelationships: 0,
      cycleCount: 0,
      maxDepth: 0,
      totalRecords: 0,
      totalEstimatedApiCalls: 0,
    });
  });

  it('should handle single object — 1 node at level 0', () => {
    const describes = new Map<string, GraphObjectDescribe>([['Account', makeDescribe('Account')]]);
    const recordCounts = new Map([['Account', 100]]);

    const graph = builder.build(describes, recordCounts);

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].objectApiName).toBe('Account');
    expect(graph.nodes[0].level).toBe(0);
    expect(graph.nodes[0].insertOrder).toBe(0);
    expect(graph.nodes[0].recordCount).toBe(100);
    expect(graph.edges).toHaveLength(0);
    expect(graph.cycles).toHaveLength(0);
  });

  it('should handle linear chain — A -> B -> C with correct levels', () => {
    // C depends on B, B depends on A
    // Edges: A->B (B.AccountId references A), B->C (C.ParentId references B)
    const describes = new Map<string, GraphObjectDescribe>([
      ['Account', makeDescribe('Account')],
      ['Contact', makeDescribe('Contact', [{ fieldName: 'AccountId', referenceTo: ['Account'] }])],
      ['Case', makeDescribe('Case', [{ fieldName: 'ContactId', referenceTo: ['Contact'] }])],
    ]);
    const recordCounts = new Map([
      ['Account', 10],
      ['Contact', 20],
      ['Case', 30],
    ]);

    const graph = builder.build(describes, recordCounts);

    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toHaveLength(2);

    // Account should be at level 0, Contact at level 1, Case at level 2
    const accountNode = graph.nodes.find((n) => n.objectApiName === 'Account');
    const contactNode = graph.nodes.find((n) => n.objectApiName === 'Contact');
    const caseNode = graph.nodes.find((n) => n.objectApiName === 'Case');

    expect(accountNode?.level).toBe(0);
    expect(contactNode?.level).toBe(1);
    expect(caseNode?.level).toBe(2);

    // Insertion order: Account first, then Contact, then Case
    expect(accountNode!.insertOrder).toBeLessThan(contactNode!.insertOrder);
    expect(contactNode!.insertOrder).toBeLessThan(caseNode!.insertOrder);

    expect(graph.stats.maxDepth).toBe(2);
  });

  it('should detect self-referencing object — two_pass strategy', () => {
    const describes = new Map<string, GraphObjectDescribe>([
      ['Account', makeDescribe('Account', [{ fieldName: 'ParentId', referenceTo: ['Account'] }])],
    ]);
    const recordCounts = new Map([['Account', 50]]);

    const graph = builder.build(describes, recordCounts);

    expect(graph.nodes).toHaveLength(1);
    // Self-reference edge
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].relationshipType).toBe('hierarchical');
    expect(graph.edges[0].from).toBe('Account');
    expect(graph.edges[0].to).toBe('Account');

    // Cycle detected with two_pass strategy
    expect(graph.cycles).toHaveLength(1);
    expect(graph.cycles[0].strategy).toBe('two_pass');
    expect(graph.cycles[0].objects).toEqual(['Account']);
    expect(graph.cycles[0].description).toContain('Account');
    expect(graph.cycles[0].description).toContain('self-lookup');
  });

  it('should detect mutual cycle — A <-> B with nullable_lookup', () => {
    // A references B (nullable), B references A (nullable)
    const describes = new Map<string, GraphObjectDescribe>([
      [
        'ObjectA',
        makeDescribe('ObjectA', [
          { fieldName: 'ObjectBId', referenceTo: ['ObjectB'], nillable: true },
        ]),
      ],
      [
        'ObjectB',
        makeDescribe('ObjectB', [
          { fieldName: 'ObjectAId', referenceTo: ['ObjectA'], nillable: true },
        ]),
      ],
    ]);
    const recordCounts = new Map([
      ['ObjectA', 10],
      ['ObjectB', 10],
    ]);

    const graph = builder.build(describes, recordCounts);

    expect(graph.cycles.length).toBeGreaterThanOrEqual(1);
    const mutualCycle = graph.cycles.find((c) => c.objects.length === 2);
    expect(mutualCycle).toBeDefined();
    expect(mutualCycle!.strategy).toBe('nullable_lookup');
    expect(mutualCycle!.objects).toContain('ObjectA');
    expect(mutualCycle!.objects).toContain('ObjectB');
  });

  it('should detect complex cycle — A -> B -> C -> A with upsert_external_id', () => {
    // Circular: A references C, B references A, C references B
    const describes = new Map<string, GraphObjectDescribe>([
      [
        'ObjA',
        makeDescribe('ObjA', [{ fieldName: 'ObjCId', referenceTo: ['ObjC'], nillable: true }]),
      ],
      [
        'ObjB',
        makeDescribe('ObjB', [{ fieldName: 'ObjAId', referenceTo: ['ObjA'], nillable: true }]),
      ],
      [
        'ObjC',
        makeDescribe('ObjC', [{ fieldName: 'ObjBId', referenceTo: ['ObjB'], nillable: true }]),
      ],
    ]);
    const recordCounts = new Map([
      ['ObjA', 5],
      ['ObjB', 5],
      ['ObjC', 5],
    ]);

    const graph = builder.build(describes, recordCounts);

    const complexCycle = graph.cycles.find((c) => c.objects.length === 3);
    expect(complexCycle).toBeDefined();
    expect(complexCycle!.strategy).toBe('upsert_external_id');
    expect(complexCycle!.objects).toContain('ObjA');
    expect(complexCycle!.objects).toContain('ObjB');
    expect(complexCycle!.objects).toContain('ObjC');
  });

  it('should detect polymorphic lookup — multiple referenceTo creates polymorphic edges', () => {
    const describes = new Map<string, GraphObjectDescribe>([
      ['Account', makeDescribe('Account')],
      ['Opportunity', makeDescribe('Opportunity')],
      [
        'Task',
        makeDescribe('Task', [
          {
            fieldName: 'WhatId',
            referenceTo: ['Account', 'Opportunity'],
            nillable: true,
          },
        ]),
      ],
    ]);
    const recordCounts = new Map([
      ['Account', 10],
      ['Opportunity', 10],
      ['Task', 30],
    ]);

    const graph = builder.build(describes, recordCounts);

    // Should create 2 polymorphic edges
    const polyEdges = graph.edges.filter((e) => e.relationshipType === 'polymorphic');
    expect(polyEdges).toHaveLength(2);
    expect(polyEdges.every((e) => e.to === 'Task')).toBe(true);
    expect(polyEdges.every((e) => e.fieldApiName === 'WhatId')).toBe(true);

    const froms = polyEdges.map((e) => e.from).sort();
    expect(froms).toEqual(['Account', 'Opportunity']);
  });

  it('should detect master-detail — required=true when nillable=false', () => {
    const describes = new Map<string, GraphObjectDescribe>([
      ['Account', makeDescribe('Account')],
      [
        'Contact',
        makeDescribe('Contact', [
          {
            fieldName: 'AccountId',
            referenceTo: ['Account'],
            nillable: false,
          },
        ]),
      ],
    ]);
    const recordCounts = new Map([
      ['Account', 10],
      ['Contact', 20],
    ]);

    const graph = builder.build(describes, recordCounts);

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].relationshipType).toBe('master_detail');
    expect(graph.edges[0].required).toBe(true);
    expect(graph.edges[0].from).toBe('Account');
    expect(graph.edges[0].to).toBe('Contact');
  });

  it('should handle mixed graph — some in cycles, some not', () => {
    // Linear: User -> Case
    // Cycle: Account <-> Contact (mutual references)
    const describes = new Map<string, GraphObjectDescribe>([
      ['User', makeDescribe('User')],
      [
        'Case',
        makeDescribe('Case', [{ fieldName: 'OwnerId', referenceTo: ['User'], nillable: true }]),
      ],
      [
        'Account',
        makeDescribe('Account', [
          {
            fieldName: 'PrimaryContactId',
            referenceTo: ['Contact'],
            nillable: true,
          },
        ]),
      ],
      [
        'Contact',
        makeDescribe('Contact', [
          { fieldName: 'AccountId', referenceTo: ['Account'], nillable: true },
        ]),
      ],
    ]);
    const recordCounts = new Map([
      ['User', 5],
      ['Case', 30],
      ['Account', 50],
      ['Contact', 100],
    ]);

    const graph = builder.build(describes, recordCounts);

    expect(graph.nodes).toHaveLength(4);
    expect(graph.stats.totalObjects).toBe(4);

    // User should be at level 0
    const userNode = graph.nodes.find((n) => n.objectApiName === 'User');
    expect(userNode?.level).toBe(0);

    // Case depends on User
    const caseNode = graph.nodes.find((n) => n.objectApiName === 'Case');
    expect(caseNode!.insertOrder).toBeGreaterThan(userNode!.insertOrder);

    // Cycle between Account and Contact should be detected
    const mutualCycle = graph.cycles.find(
      (c) => c.objects.includes('Account') && c.objects.includes('Contact'),
    );
    expect(mutualCycle).toBeDefined();
  });

  it('should compute estimatedApiCalls = ceil(recordCount / batchSize)', () => {
    const describes = new Map<string, GraphObjectDescribe>([
      ['Account', makeDescribe('Account')],
      ['Contact', makeDescribe('Contact')],
      ['Lead', makeDescribe('Lead')],
    ]);
    const recordCounts = new Map([
      ['Account', 0],
      ['Contact', 1],
      ['Lead', 500],
    ]);

    const graph = builder.build(describes, recordCounts, 200);

    const accountNode = graph.nodes.find((n) => n.objectApiName === 'Account');
    const contactNode = graph.nodes.find((n) => n.objectApiName === 'Contact');
    const leadNode = graph.nodes.find((n) => n.objectApiName === 'Lead');

    // 0 records -> 0 API calls
    expect(accountNode?.estimatedApiCalls).toBe(0);
    // 1 record / 200 batch = ceil(0.005) = 1
    expect(contactNode?.estimatedApiCalls).toBe(1);
    // 500 records / 200 batch = ceil(2.5) = 3
    expect(leadNode?.estimatedApiCalls).toBe(3);

    expect(graph.stats.totalRecords).toBe(501);
    expect(graph.stats.totalEstimatedApiCalls).toBe(4);
  });

  it('should complete 50 objects in under 100ms', () => {
    const describes = new Map<string, GraphObjectDescribe>();
    const recordCounts = new Map<string, number>();
    const objectNames: string[] = [];

    // Create 50 objects with a chain of dependencies
    for (let i = 0; i < 50; i++) {
      const name = `Object${String(i).padStart(3, '0')}`;
      objectNames.push(name);
      const refs =
        i > 0
          ? [
              {
                fieldName: `Parent${i}Id`,
                referenceTo: [objectNames[i - 1]],
                nillable: true,
              },
            ]
          : [];
      describes.set(name, makeDescribe(name, refs));
      recordCounts.set(name, i * 100);
    }

    const start = performance.now();
    const graph = builder.build(describes, recordCounts);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(100);
    expect(graph.nodes).toHaveLength(50);
    expect(graph.stats.totalObjects).toBe(50);
    expect(graph.stats.maxDepth).toBe(49);
  });

  it('should set correct default values on nodes', () => {
    const describes = new Map<string, GraphObjectDescribe>([['Account', makeDescribe('Account')]]);
    const recordCounts = new Map([['Account', 42]]);

    const graph = builder.build(describes, recordCounts);
    const node = graph.nodes[0];

    expect(node.status).toBe('pending');
    expect(node.progress).toBe(0);
    expect(node.piiFields).toEqual([]);
    expect(node.anonymizationRules).toEqual([]);
    expect(node.successCount).toBe(0);
    expect(node.failureCount).toBe(0);
    expect(node.errors).toEqual([]);
    expect(node.elapsedMs).toBe(0);
    expect(node.apiCallsUsed).toBe(0);
  });

  it('should ignore references to objects not in the graph', () => {
    // Contact references Account, but Account is not in the describes
    const describes = new Map<string, GraphObjectDescribe>([
      ['Contact', makeDescribe('Contact', [{ fieldName: 'AccountId', referenceTo: ['Account'] }])],
    ]);
    const recordCounts = new Map([['Contact', 10]]);

    const graph = builder.build(describes, recordCounts);

    expect(graph.nodes).toHaveLength(1);
    // Edge should be ignored since Account is not in the graph
    expect(graph.edges).toHaveLength(0);
  });

  it('should handle missing record count as 0', () => {
    const describes = new Map<string, GraphObjectDescribe>([['Account', makeDescribe('Account')]]);
    // No record count for Account
    const recordCounts = new Map<string, number>();

    const graph = builder.build(describes, recordCounts);

    expect(graph.nodes[0].recordCount).toBe(0);
    expect(graph.nodes[0].estimatedApiCalls).toBe(0);
  });
});
