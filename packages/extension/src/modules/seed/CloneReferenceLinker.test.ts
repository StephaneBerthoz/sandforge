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

    it('orders a feed before its comments: the best comment is set by the platform, never by a clone', () => {
      // The describes the source gave for a feed and its comments. A feed item
      // points at its best comment through a lookup no record is created with,
      // and a comment at its feed item through one it may not leave empty.
      // Counted both ways, the clone's preview stopped on a cycle.
      const describes = new Map<string, DescribeSObjectResultLike>([
        [
          'FeedItem',
          {
            fields: [
              { name: 'Id', type: 'id', createable: false },
              {
                name: 'BestCommentId',
                type: 'reference',
                referenceTo: ['FeedComment'],
                nillable: true,
                createable: false,
              },
              {
                name: 'ParentId',
                type: 'reference',
                referenceTo: ['Account', 'Opportunity'],
                nillable: false,
                createable: true,
              },
            ],
          },
        ],
        [
          'FeedComment',
          {
            fields: [
              {
                name: 'FeedItemId',
                type: 'reference',
                referenceTo: ['FeedItem'],
                nillable: false,
                createable: true,
              },
            ],
          },
        ],
      ]);
      const objects = ['FeedComment', 'FeedItem'];

      const edges = linker.buildEdgesFromDescribe(objects, describes);

      expect(edges.map((e) => `${e.from}->${e.to} ${e.fieldApiName}`)).toEqual([
        'FeedItem->FeedComment FeedItemId',
      ]);
      expect(linker.resolveInsertOrder(objects, edges)).toEqual(['FeedItem', 'FeedComment']);
    });

    it('still orders by a lookup whose describe does not say whether it is createable', () => {
      const describes = new Map<string, DescribeSObjectResultLike>([
        [
          'Contact',
          { fields: [{ name: 'AccountId', type: 'reference', referenceTo: ['Account'] }] },
        ],
        ['Account', { fields: [] }],
      ]);
      const edges = linker.buildEdgesFromDescribe(['Contact', 'Account'], describes);
      expect(linker.resolveInsertOrder(['Contact', 'Account'], edges)).toEqual([
        'Account',
        'Contact',
      ]);
    });

    it('puts the emails before the tasks, whatever lookup names the task', () => {
      // An email names its task, which put the tasks first: the platform then
      // wrote a task of its own with each email related to a record, beside
      // the one the clone had written.
      const describes = new Map<string, DescribeSObjectResultLike>([
        ['Case', { fields: [] }],
        [
          'Task',
          { fields: [{ name: 'WhatId', type: 'reference', referenceTo: ['Case', 'Account'] }] },
        ],
        [
          'EmailMessage',
          {
            fields: [
              { name: 'ParentId', type: 'reference', referenceTo: ['Case'] },
              { name: 'ActivityId', type: 'reference', referenceTo: ['Task'] },
            ],
          },
        ],
      ]);
      const objects = ['Task', 'EmailMessage', 'Case'];

      const edges = linker.buildEdgesFromDescribe(objects, describes);

      expect(edges.some((e) => e.from === 'Task' && e.to === 'EmailMessage')).toBe(false);
      expect(edges).toContainEqual({
        from: 'EmailMessage',
        to: 'Task',
        fieldApiName: 'EmailMessageBeforeTask',
        relationshipType: 'lookup',
        required: true,
      });
      expect(linker.resolveInsertOrder(objects, edges)).toEqual(['Case', 'EmailMessage', 'Task']);
    });
  });
});
