import { describe, it, expect } from 'vitest';
import { ForgePlanGenerator } from './ForgePlanGenerator.js';
import type { ForgeGraph, ForgeGraphNode, ForgeGraphEdge } from '@sandforge/shared';

function makeNode(overrides: Partial<ForgeGraphNode> & { objectApiName: string }): ForgeGraphNode {
  return {
    recordCount: 100,
    fieldCount: 10,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 8,
    estimatedSizeMB: 1,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
    ...overrides,
  };
}

function makeGraph(nodes: ForgeGraphNode[], edges: ForgeGraphEdge[] = []): ForgeGraph {
  return {
    nodes,
    edges,
    totalRecords: nodes.reduce((s, n) => s + n.recordCount, 0),
    estimatedSizeMB: nodes.reduce((s, n) => s + n.estimatedSizeMB, 0),
    estimatedDurationSeconds: 0,
  };
}

describe('ForgePlanGenerator', () => {
  const generator = new ForgePlanGenerator({ avgSecondsPerApiCall: 0.5 });

  describe('wave grouping', () => {
    it('should return empty plan for empty graph', () => {
      const graph = makeGraph([]);
      const plan = generator.generate(graph);

      expect(plan.waves).toEqual([]);
      expect(plan.totalRecords).toBe(0);
      expect(plan.totalApiCalls).toBe(0);
      expect(plan.estimatedDurationSeconds).toBe(0);
      expect(plan.cycleResolutions).toEqual([]);
    });

    it('should create single wave for single object', () => {
      const graph = makeGraph([makeNode({ objectApiName: 'Account', level: 0, recordCount: 50 })]);
      const plan = generator.generate(graph);

      expect(plan.waves).toHaveLength(1);
      expect(plan.waves[0].order).toBe(0);
      expect(plan.waves[0].objectApiNames).toEqual(['Account']);
      expect(plan.waves[0].totalRecords).toBe(50);
    });

    it('should group same-level objects into one wave', () => {
      const graph = makeGraph([
        makeNode({ objectApiName: 'Account', level: 0, recordCount: 50 }),
        makeNode({ objectApiName: 'Product2', level: 0, recordCount: 30 }),
      ]);
      const plan = generator.generate(graph);

      expect(plan.waves).toHaveLength(1);
      expect(plan.waves[0].objectApiNames).toContain('Account');
      expect(plan.waves[0].objectApiNames).toContain('Product2');
      expect(plan.waves[0].totalRecords).toBe(80);
    });

    it('should create separate waves for parent/child (different levels)', () => {
      const graph = makeGraph(
        [
          makeNode({ objectApiName: 'Account', level: 0, recordCount: 100 }),
          makeNode({ objectApiName: 'Contact', level: 1, recordCount: 200 }),
        ],
        [
          {
            sourceObject: 'Account',
            targetObject: 'Contact',
            relationshipName: 'Contacts',
            type: 'lookup',
          },
        ],
      );
      const plan = generator.generate(graph);

      expect(plan.waves).toHaveLength(2);
      expect(plan.waves[0].objectApiNames).toEqual(['Account']);
      expect(plan.waves[1].objectApiNames).toEqual(['Contact']);
      expect(plan.waves[0].order).toBe(0);
      expect(plan.waves[1].order).toBe(1);
    });

    it('should handle complex 3-level graph', () => {
      const graph = makeGraph(
        [
          makeNode({ objectApiName: 'Account', level: 0, recordCount: 100 }),
          makeNode({ objectApiName: 'Product2', level: 0, recordCount: 50 }),
          makeNode({ objectApiName: 'Contact', level: 1, recordCount: 200 }),
          makeNode({ objectApiName: 'Opportunity', level: 1, recordCount: 150 }),
          makeNode({ objectApiName: 'OpportunityLineItem', level: 2, recordCount: 300 }),
        ],
        [
          {
            sourceObject: 'Account',
            targetObject: 'Contact',
            relationshipName: 'Contacts',
            type: 'lookup',
          },
          {
            sourceObject: 'Account',
            targetObject: 'Opportunity',
            relationshipName: 'Opportunities',
            type: 'lookup',
          },
          {
            sourceObject: 'Opportunity',
            targetObject: 'OpportunityLineItem',
            relationshipName: 'OpportunityLineItems',
            type: 'master-detail',
          },
        ],
      );
      const plan = generator.generate(graph);

      expect(plan.waves).toHaveLength(3);
      expect(plan.waves[0].objectApiNames).toContain('Account');
      expect(plan.waves[0].objectApiNames).toContain('Product2');
      expect(plan.waves[1].objectApiNames).toContain('Contact');
      expect(plan.waves[1].objectApiNames).toContain('Opportunity');
      expect(plan.waves[2].objectApiNames).toEqual(['OpportunityLineItem']);
      expect(plan.totalRecords).toBe(800);
    });
  });

  describe('excluded nodes', () => {
    it('should skip excluded nodes', () => {
      const graph = makeGraph([
        makeNode({ objectApiName: 'Account', level: 0, included: true, recordCount: 100 }),
        makeNode({ objectApiName: 'Contact', level: 1, included: false, recordCount: 200 }),
      ]);
      const plan = generator.generate(graph);

      expect(plan.waves).toHaveLength(1);
      expect(plan.totalRecords).toBe(100);
    });

    it('should return empty plan when all nodes excluded', () => {
      const graph = makeGraph([makeNode({ objectApiName: 'Account', level: 0, included: false })]);
      const plan = generator.generate(graph);

      expect(plan.waves).toEqual([]);
      expect(plan.totalRecords).toBe(0);
    });
  });

  describe('API call estimation', () => {
    it('should estimate API calls based on batch strategy for REST (<=200)', () => {
      const graph = makeGraph([
        makeNode({ objectApiName: 'Account', level: 0, recordCount: 100, batchStrategy: 'auto' }),
      ]);
      const plan = generator.generate(graph);

      // 100 records, auto -> REST (<=200), batchSize=200, batchCount=1
      expect(plan.totalApiCalls).toBe(1);
    });

    it('should estimate API calls for bulk strategy', () => {
      const graph = makeGraph([
        makeNode({ objectApiName: 'Account', level: 0, recordCount: 500, batchStrategy: 'auto' }),
      ]);
      const plan = generator.generate(graph);

      // 500 records, auto -> bulk (>200), batchSize=10000, batchCount=1
      expect(plan.totalApiCalls).toBe(1);
    });

    it('should estimate API calls for explicit REST with many records', () => {
      const graph = makeGraph([
        makeNode({ objectApiName: 'Account', level: 0, recordCount: 600, batchStrategy: 'rest' }),
      ]);
      const plan = generator.generate(graph);

      // 600 records, REST, batchSize=200, batchCount=3
      expect(plan.totalApiCalls).toBe(3);
    });
  });

  describe('duration estimation', () => {
    it('should estimate duration based on max API calls per wave', () => {
      const gen = new ForgePlanGenerator({ avgSecondsPerApiCall: 1 });
      const graph = makeGraph([
        makeNode({ objectApiName: 'Account', level: 0, recordCount: 100, batchStrategy: 'rest' }),
        makeNode({ objectApiName: 'Product2', level: 0, recordCount: 400, batchStrategy: 'rest' }),
      ]);
      const plan = gen.generate(graph);

      // Account: 1 batch, Product2: 2 batches
      // Wave duration = max(1, 2) * 1.0 = 2.0s
      expect(plan.waves[0].estimatedDurationSeconds).toBe(2);
    });

    it('should sum duration across waves', () => {
      const gen = new ForgePlanGenerator({ avgSecondsPerApiCall: 1 });
      const graph = makeGraph(
        [
          makeNode({ objectApiName: 'Account', level: 0, recordCount: 100, batchStrategy: 'rest' }),
          makeNode({ objectApiName: 'Contact', level: 1, recordCount: 100, batchStrategy: 'rest' }),
        ],
        [
          {
            sourceObject: 'Account',
            targetObject: 'Contact',
            relationshipName: 'Contacts',
            type: 'lookup',
          },
        ],
      );
      const plan = gen.generate(graph);

      // Wave 0: 1 batch * 1s = 1s, Wave 1: 1 batch * 1s = 1s
      expect(plan.estimatedDurationSeconds).toBe(2);
    });
  });

  describe('cycle detection', () => {
    it('should return empty resolutions for acyclic graph', () => {
      const graph = makeGraph(
        [
          makeNode({ objectApiName: 'Account', level: 0 }),
          makeNode({ objectApiName: 'Contact', level: 1 }),
        ],
        [
          {
            sourceObject: 'Account',
            targetObject: 'Contact',
            relationshipName: 'Contacts',
            type: 'lookup',
          },
        ],
      );
      const plan = generator.generate(graph);

      expect(plan.cycleResolutions).toEqual([]);
    });

    it('should detect A->B->A cycle', () => {
      const graph = makeGraph(
        [
          makeNode({ objectApiName: 'Account', level: 0 }),
          makeNode({ objectApiName: 'Contact', level: 0 }),
        ],
        [
          {
            sourceObject: 'Account',
            targetObject: 'Contact',
            relationshipName: 'Contacts',
            type: 'lookup',
          },
          {
            sourceObject: 'Contact',
            targetObject: 'Account',
            relationshipName: 'Account',
            type: 'lookup',
          },
        ],
      );
      const plan = generator.generate(graph);

      expect(plan.cycleResolutions).toHaveLength(1);
      expect(plan.cycleResolutions[0].objects).toContain('Account');
      expect(plan.cycleResolutions[0].objects).toContain('Contact');
    });

    it('should use nullable_lookup strategy when cycle has lookup edges', () => {
      const graph = makeGraph(
        [makeNode({ objectApiName: 'A', level: 0 }), makeNode({ objectApiName: 'B', level: 0 })],
        [
          { sourceObject: 'A', targetObject: 'B', relationshipName: 'Bs', type: 'lookup' },
          { sourceObject: 'B', targetObject: 'A', relationshipName: 'As', type: 'lookup' },
        ],
      );
      const plan = generator.generate(graph);

      expect(plan.cycleResolutions[0].strategy).toBe('nullable_lookup');
    });

    it('should use two_pass strategy when cycle has only master-detail edges', () => {
      const graph = makeGraph(
        [makeNode({ objectApiName: 'A', level: 0 }), makeNode({ objectApiName: 'B', level: 0 })],
        [
          { sourceObject: 'A', targetObject: 'B', relationshipName: 'Bs', type: 'master-detail' },
          { sourceObject: 'B', targetObject: 'A', relationshipName: 'As', type: 'master-detail' },
        ],
      );
      const plan = generator.generate(graph);

      expect(plan.cycleResolutions[0].strategy).toBe('two_pass');
    });
  });
});
