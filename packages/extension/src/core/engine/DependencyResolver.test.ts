import { describe, it, expect, beforeEach } from 'vitest';
import { DependencyResolver } from './DependencyResolver';
import type { DependencyEdge } from './DependencyResolver';

function createEdge(
  source: string,
  target: string,
  overrides?: Partial<DependencyEdge>,
): DependencyEdge {
  return {
    source,
    target,
    fieldApiName: `${target}Id`,
    type: 'lookup',
    required: false,
    cascadeDelete: false,
    ...overrides,
  };
}

describe('DependencyResolver', () => {
  let resolver: DependencyResolver;

  beforeEach(() => {
    resolver = new DependencyResolver();
  });

  describe('addObject', () => {
    it('should register a single object', () => {
      resolver.addObject('Account');
      expect(resolver.objectCount).toBe(1);
    });

    it('should not duplicate the same object', () => {
      resolver.addObject('Account');
      resolver.addObject('Account');
      expect(resolver.objectCount).toBe(1);
    });
  });

  describe('addDependency', () => {
    it('should register both source and target objects', () => {
      resolver.addDependency(createEdge('Contact', 'Account'));
      expect(resolver.objectCount).toBe(2);
      expect(resolver.edgeCount).toBe(1);
    });

    it('should accept multiple edges', () => {
      resolver.addDependency(createEdge('Contact', 'Account'));
      resolver.addDependency(createEdge('Opportunity', 'Account'));
      expect(resolver.edgeCount).toBe(2);
      expect(resolver.objectCount).toBe(3);
    });
  });

  describe('resolve with single object', () => {
    it('should place a single object in topological order', () => {
      resolver.addObject('Account');
      const result = resolver.resolve();

      expect(result.topologicalOrder).toEqual(['Account']);
      expect(result.hasCycles).toBe(false);
      expect(result.layers).toEqual([['Account']]);
    });
  });

  describe('resolve with linear chain', () => {
    it('should sort A -> B -> C so C comes first', () => {
      resolver.addDependency(createEdge('Contact', 'Account'));
      resolver.addDependency(createEdge('Case', 'Contact'));

      const result = resolver.resolve();

      const accountIdx = result.topologicalOrder.indexOf('Account');
      const contactIdx = result.topologicalOrder.indexOf('Contact');
      const caseIdx = result.topologicalOrder.indexOf('Case');

      expect(accountIdx).toBeLessThan(contactIdx);
      expect(contactIdx).toBeLessThan(caseIdx);
      expect(result.hasCycles).toBe(false);
    });

    it('should produce correct layers for a chain', () => {
      resolver.addDependency(createEdge('Contact', 'Account'));
      resolver.addDependency(createEdge('Case', 'Contact'));

      const result = resolver.resolve();

      expect(result.layers.length).toBe(3);
      expect(result.layers[0]).toContain('Account');
      expect(result.layers[1]).toContain('Contact');
      expect(result.layers[2]).toContain('Case');
    });
  });

  describe('resolve with parallel objects', () => {
    it('should place independent objects in the same layer', () => {
      resolver.addDependency(createEdge('Contact', 'Account'));
      resolver.addDependency(createEdge('Opportunity', 'Account'));

      const result = resolver.resolve();

      expect(result.layers[0]).toContain('Account');
      const dependentLayer = result.layers[1];
      expect(dependentLayer).toContain('Contact');
      expect(dependentLayer).toContain('Opportunity');
    });

    it('should sort objects alphabetically within the same layer', () => {
      resolver.addObject('Zebra');
      resolver.addObject('Alpha');
      resolver.addObject('Mango');

      const result = resolver.resolve();

      expect(result.topologicalOrder).toEqual(['Alpha', 'Mango', 'Zebra']);
    });
  });

  describe('self-reference handling', () => {
    it('should skip self-referencing edges', () => {
      resolver.addDependency(
        createEdge('Account', 'Account', {
          fieldApiName: 'ParentId',
          type: 'hierarchical',
        }),
      );

      const result = resolver.resolve();

      expect(result.topologicalOrder).toEqual(['Account']);
      expect(result.hasCycles).toBe(false);
      expect(result.layers).toEqual([['Account']]);
    });
  });

  describe('cycle detection', () => {
    it('should detect a cycle between two objects', () => {
      resolver.addDependency(createEdge('A', 'B'));
      resolver.addDependency(createEdge('B', 'A'));

      const result = resolver.resolve();

      expect(result.hasCycles).toBe(true);
      expect(result.cycles.length).toBe(1);
      expect(result.cycles[0]).toContain('A');
      expect(result.cycles[0]).toContain('B');
    });

    it('should still include cycled objects in topological order', () => {
      resolver.addDependency(createEdge('A', 'B'));
      resolver.addDependency(createEdge('B', 'A'));
      resolver.addObject('C');

      const result = resolver.resolve();

      expect(result.topologicalOrder).toContain('A');
      expect(result.topologicalOrder).toContain('B');
      expect(result.topologicalOrder).toContain('C');
      expect(result.topologicalOrder.indexOf('C')).toBeLessThan(
        result.topologicalOrder.indexOf('A'),
      );
    });

    it('should produce separate cycle arrays for independent cycles', () => {
      // Two independent cycles: A<->B and C<->D
      resolver.addDependency(createEdge('A', 'B'));
      resolver.addDependency(createEdge('B', 'A'));
      resolver.addDependency(createEdge('C', 'D'));
      resolver.addDependency(createEdge('D', 'C'));

      const result = resolver.resolve();

      expect(result.hasCycles).toBe(true);
      expect(result.cycles.length).toBe(2);
      // Each cycle should contain 2 nodes
      const cycleSets = result.cycles.map((c) => c.sort().join(','));
      expect(cycleSets).toContain('A,B');
      expect(cycleSets).toContain('C,D');
    });

    it('should detect a three-node cycle', () => {
      resolver.addDependency(createEdge('A', 'B'));
      resolver.addDependency(createEdge('B', 'C'));
      resolver.addDependency(createEdge('C', 'A'));

      const result = resolver.resolve();

      expect(result.hasCycles).toBe(true);
      expect(result.cycles[0].length).toBe(3);
    });
  });

  describe('clear', () => {
    it('should remove all objects and edges', () => {
      resolver.addDependency(createEdge('Contact', 'Account'));
      resolver.clear();

      expect(resolver.objectCount).toBe(0);
      expect(resolver.edgeCount).toBe(0);
    });
  });

  describe('resolved graph structure', () => {
    it('should return sorted objects list', () => {
      resolver.addObject('Zebra');
      resolver.addObject('Alpha');

      const result = resolver.resolve();
      expect(result.objects).toEqual(['Alpha', 'Zebra']);
    });

    it('should return a copy of edges', () => {
      const edge = createEdge('Contact', 'Account');
      resolver.addDependency(edge);

      const result = resolver.resolve();
      expect(result.edges).toHaveLength(1);
      expect(result.edges[0]).toEqual(edge);
    });
  });
});
