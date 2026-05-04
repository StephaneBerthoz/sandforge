import { describe, it, expect } from 'vitest';
import { CloneReferenceLinker } from './CloneReferenceLinker.js';
import type { AutopilotEdge, RelationshipType } from '@sandforge/shared';
import type { DescribeSObjectResultLike } from './CloneReferenceLinker.js';

function edge(from: string, to: string, field: string): AutopilotEdge {
  return {
    from,
    to,
    fieldApiName: field,
    relationshipType: 'lookup' as RelationshipType,
    required: false,
  };
}

describe('CloneReferenceLinker', () => {
  const linker = new CloneReferenceLinker();

  describe('resolveInsertOrder', () => {
    it('sorts a linear chain correctly (parent before child)', () => {
      // Account -> Contact -> Case (Contact.AccountId -> Account, Case.ContactId -> Contact)
      const edges = [edge('Account', 'Contact', 'AccountId'), edge('Contact', 'Case', 'ContactId')];
      const result = linker.resolveInsertOrder(['Case', 'Contact', 'Account'], edges);
      expect(result.indexOf('Account')).toBeLessThan(result.indexOf('Contact'));
      expect(result.indexOf('Contact')).toBeLessThan(result.indexOf('Case'));
    });

    it('ignores self-referential edges for ordering', () => {
      // Account.ParentId -> Account (self-ref)
      const edges = [edge('Account', 'Account', 'ParentId')];
      const result = linker.resolveInsertOrder(['Account'], edges);
      expect(result).toEqual(['Account']);
    });

    it('throws on cycle detection', () => {
      // A -> B -> C -> A (cycle)
      const edges = [edge('A', 'B', 'AId'), edge('B', 'C', 'BId'), edge('C', 'A', 'CId')];
      expect(() => linker.resolveInsertOrder(['A', 'B', 'C'], edges)).toThrow('Cycle detected');
    });

    it('returns empty array for empty input', () => {
      const result = linker.resolveInsertOrder([], []);
      expect(result).toEqual([]);
    });

    it('handles independent objects with no edges', () => {
      const result = linker.resolveInsertOrder(['Account', 'Product2', 'Lead'], []);
      expect(result).toHaveLength(3);
      expect(new Set(result)).toEqual(new Set(['Account', 'Product2', 'Lead']));
    });
  });

  describe('detectSelfReferentialEdges', () => {
    it('returns self-referential edges only', () => {
      const edges = [
        edge('Account', 'Account', 'ParentId'),
        edge('Account', 'Contact', 'AccountId'),
      ];
      const selfRefs = linker.detectSelfReferentialEdges(edges);
      expect(selfRefs).toHaveLength(1);
      expect(selfRefs[0].fieldApiName).toBe('ParentId');
    });

    it('returns empty array when no self-refs exist', () => {
      const edges = [edge('Account', 'Contact', 'AccountId')];
      expect(linker.detectSelfReferentialEdges(edges)).toEqual([]);
    });
  });

  describe('buildEdgesFromDescribe', () => {
    it('creates edges for reference fields pointing to objects in the set', () => {
      const describes = new Map<string, DescribeSObjectResultLike>([
        [
          'Contact',
          {
            fields: [
              { name: 'AccountId', type: 'reference', referenceTo: ['Account'] },
              { name: 'Name', type: 'string' },
            ],
          },
        ],
        [
          'Account',
          {
            fields: [
              { name: 'ParentId', type: 'reference', referenceTo: ['Account'] },
              { name: 'Name', type: 'string' },
            ],
          },
        ],
      ]);

      const edges = linker.buildEdgesFromDescribe(['Account', 'Contact'], describes);
      expect(edges).toHaveLength(2);

      const contactEdge = edges.find((e) => e.to === 'Contact');
      expect(contactEdge).toBeDefined();
      expect(contactEdge!.from).toBe('Account');
      expect(contactEdge!.fieldApiName).toBe('AccountId');

      const selfEdge = edges.find((e) => e.from === 'Account' && e.to === 'Account');
      expect(selfEdge).toBeDefined();
    });

    it('ignores reference fields pointing to objects outside the set', () => {
      const describes = new Map<string, DescribeSObjectResultLike>([
        [
          'Contact',
          {
            fields: [
              { name: 'AccountId', type: 'reference', referenceTo: ['Account'] },
              { name: 'OwnerId', type: 'reference', referenceTo: ['User'] },
            ],
          },
        ],
      ]);

      // Only Contact in the set, Account not included
      const edges = linker.buildEdgesFromDescribe(['Contact'], describes);
      expect(edges).toHaveLength(0);
    });

    it('returns empty array for empty input', () => {
      const edges = linker.buildEdgesFromDescribe([], new Map());
      expect(edges).toEqual([]);
    });
  });
});
