import { describe, it, expect, beforeEach } from 'vitest';
import { DataLineageTracker } from './DataLineageTracker';

describe('DataLineageTracker', () => {
  let tracker: DataLineageTracker;

  beforeEach(() => {
    tracker = new DataLineageTracker();
  });

  describe('startTracking', () => {
    it('should register an operation for tracking', () => {
      tracker.startTracking('op-001');

      const ops = tracker.listOperations();
      expect(ops).toContain('op-001');
    });

    it('should allow tracking multiple operations', () => {
      tracker.startTracking('op-001');
      tracker.startTracking('op-002');
      tracker.startTracking('op-003');

      expect(tracker.listOperations()).toHaveLength(3);
    });

    it('should reset an operation if startTracking is called again', () => {
      tracker.startTracking('op-001');
      tracker.addNode('op-001', {
        type: 'source',
        label: 'Account',
      });

      tracker.startTracking('op-001');

      const lineage = tracker.getLineage('op-001');
      expect(lineage?.nodes).toHaveLength(0);
    });
  });

  describe('addNode', () => {
    it('should add a node and return a generated id', () => {
      tracker.startTracking('op-001');

      const nodeId = tracker.addNode('op-001', {
        type: 'source',
        label: 'Account',
        objectApiName: 'Account',
      });

      expect(nodeId).toBeDefined();
      expect(typeof nodeId).toBe('string');
    });

    it('should generate unique ids for each node', () => {
      tracker.startTracking('op-001');

      const id1 = tracker.addNode('op-001', {
        type: 'source',
        label: 'Account',
      });
      const id2 = tracker.addNode('op-001', {
        type: 'destination',
        label: 'Account Copy',
      });

      expect(id1).not.toBe(id2);
    });

    it('should store the node in the lineage graph', () => {
      tracker.startTracking('op-001');

      tracker.addNode('op-001', {
        type: 'source',
        label: 'Account',
        objectApiName: 'Account',
        orgId: 'org-prod',
      });

      const lineage = tracker.getLineage('op-001');
      expect(lineage?.nodes).toHaveLength(1);
      expect(lineage?.nodes[0].type).toBe('source');
      expect(lineage?.nodes[0].label).toBe('Account');
      expect(lineage?.nodes[0].objectApiName).toBe('Account');
      expect(lineage?.nodes[0].orgId).toBe('org-prod');
    });

    it('should throw if the operation is not being tracked', () => {
      expect(() => tracker.addNode('nonexistent', { type: 'source', label: 'Test' })).toThrow(
        'Operation "nonexistent" is not being tracked',
      );
    });
  });

  describe('addEdge', () => {
    it('should add an edge to the lineage graph', () => {
      tracker.startTracking('op-001');

      const sourceId = tracker.addNode('op-001', {
        type: 'source',
        label: 'Account',
      });
      const destId = tracker.addNode('op-001', {
        type: 'destination',
        label: 'Account Copy',
      });

      tracker.addEdge('op-001', {
        sourceId,
        targetId: destId,
        label: 'copy',
        recordCount: 150,
      });

      const lineage = tracker.getLineage('op-001');
      expect(lineage?.edges).toHaveLength(1);
      expect(lineage?.edges[0].sourceId).toBe(sourceId);
      expect(lineage?.edges[0].targetId).toBe(destId);
      expect(lineage?.edges[0].label).toBe('copy');
      expect(lineage?.edges[0].recordCount).toBe(150);
    });

    it('should allow multiple edges', () => {
      tracker.startTracking('op-001');

      const src = tracker.addNode('op-001', {
        type: 'source',
        label: 'Source',
      });
      const transform = tracker.addNode('op-001', {
        type: 'transform',
        label: 'Transform',
      });
      const dest = tracker.addNode('op-001', {
        type: 'destination',
        label: 'Dest',
      });

      tracker.addEdge('op-001', { sourceId: src, targetId: transform });
      tracker.addEdge('op-001', { sourceId: transform, targetId: dest });

      const lineage = tracker.getLineage('op-001');
      expect(lineage?.edges).toHaveLength(2);
    });

    it('should throw if the operation is not being tracked', () => {
      expect(() =>
        tracker.addEdge('nonexistent', {
          sourceId: 'a',
          targetId: 'b',
        }),
      ).toThrow('Operation "nonexistent" is not being tracked');
    });
  });

  describe('getLineage', () => {
    it('should return undefined for a non-tracked operation', () => {
      expect(tracker.getLineage('nonexistent')).toBeUndefined();
    });

    it('should return a complete lineage graph', () => {
      tracker.startTracking('op-001');

      const srcId = tracker.addNode('op-001', {
        type: 'source',
        label: 'Account',
      });
      const destId = tracker.addNode('op-001', {
        type: 'destination',
        label: 'Account Copy',
      });
      tracker.addEdge('op-001', { sourceId: srcId, targetId: destId });

      const lineage = tracker.getLineage('op-001');

      expect(lineage).toBeDefined();
      expect(lineage?.operationId).toBe('op-001');
      expect(lineage?.nodes).toHaveLength(2);
      expect(lineage?.edges).toHaveLength(1);
      expect(lineage?.generatedAt).toBeDefined();
    });

    it('should return a defensive copy of nodes and edges', () => {
      tracker.startTracking('op-001');
      tracker.addNode('op-001', { type: 'source', label: 'A' });

      const lineage1 = tracker.getLineage('op-001');
      lineage1?.nodes.push({
        id: 'fake',
        type: 'destination',
        label: 'Fake',
      });

      const lineage2 = tracker.getLineage('op-001');
      expect(lineage2?.nodes).toHaveLength(1);
    });

    it('should return an empty graph for a tracked but empty operation', () => {
      tracker.startTracking('op-empty');

      const lineage = tracker.getLineage('op-empty');
      expect(lineage?.nodes).toHaveLength(0);
      expect(lineage?.edges).toHaveLength(0);
    });
  });

  describe('listOperations', () => {
    it('should return empty array when no operations are tracked', () => {
      expect(tracker.listOperations()).toHaveLength(0);
    });

    it('should list all tracked operation IDs', () => {
      tracker.startTracking('op-001');
      tracker.startTracking('op-002');

      const ops = tracker.listOperations();
      expect(ops).toContain('op-001');
      expect(ops).toContain('op-002');
      expect(ops).toHaveLength(2);
    });
  });

  describe('clear', () => {
    it('should clear a specific operation when operationId is provided', () => {
      tracker.startTracking('op-001');
      tracker.startTracking('op-002');
      tracker.addNode('op-001', { type: 'source', label: 'A' });

      tracker.clear('op-001');

      expect(tracker.getLineage('op-001')).toBeUndefined();
      expect(tracker.getLineage('op-002')).toBeDefined();
      expect(tracker.listOperations()).toHaveLength(1);
    });

    it('should clear all operations when no operationId is provided', () => {
      tracker.startTracking('op-001');
      tracker.startTracking('op-002');

      tracker.clear();

      expect(tracker.listOperations()).toHaveLength(0);
      expect(tracker.getLineage('op-001')).toBeUndefined();
      expect(tracker.getLineage('op-002')).toBeUndefined();
    });

    it('should not throw when clearing a non-existent operation', () => {
      expect(() => tracker.clear('nonexistent')).not.toThrow();
    });

    it('should allow re-tracking after clearing', () => {
      tracker.startTracking('op-001');
      tracker.addNode('op-001', { type: 'source', label: 'Old' });
      tracker.clear('op-001');

      tracker.startTracking('op-001');
      tracker.addNode('op-001', { type: 'source', label: 'New' });

      const lineage = tracker.getLineage('op-001');
      expect(lineage?.nodes).toHaveLength(1);
      expect(lineage?.nodes[0].label).toBe('New');
    });
  });
});
