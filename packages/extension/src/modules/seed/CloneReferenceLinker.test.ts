import { describe, it, expect } from 'vitest';
import { CloneReferenceLinker } from './CloneReferenceLinker.js';
import type { AutopilotEdge, RelationshipType } from '@sandforge/shared';
import type { DescribeSObjectResultLike } from './CloneReferenceLinker.js';

function edge(from: string, to: string, field: string, required = false): AutopilotEdge {
  return {
    from,
    to,
    fieldApiName: field,
    relationshipType: 'lookup' as RelationshipType,
    required,
  };
}

/** The edges as `Child.Field->Parent`, the way a clone preview lists its lookups. */
function lookups(edges: AutopilotEdge[]): string[] {
  return edges.map((e) => `${e.to}.${e.fieldApiName}->${e.from}`);
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

    it('writes a cycle of lookups the records may leave empty, by name when nothing else decides', () => {
      // A -> B -> C -> A, every lookup optional: the second pass fills the
      // one that points forward. It used to stop the clone.
      const edges = [edge('A', 'B', 'AId'), edge('B', 'C', 'BId'), edge('C', 'A', 'CId')];

      expect(linker.resolveInsertOrder(['C', 'B', 'A'], edges)).toEqual(['A', 'B', 'C']);
    });

    it('writes first the object a lookup of the cycle cannot go in without', () => {
      // An account's key contact may be left empty and a contact's account may
      // not: the accounts go first. The other way round, the contacts do,
      // whatever their names say.
      const contactNeedsItsAccount = [
        edge('Contact', 'Account', 'Key_Contact__c'),
        edge('Account', 'Contact', 'AccountId', true),
      ];
      const accountNeedsItsContact = [
        edge('Contact', 'Account', 'Key_Contact__c', true),
        edge('Account', 'Contact', 'AccountId'),
      ];

      expect(linker.resolveInsertOrder(['Contact', 'Account'], contactNeedsItsAccount)).toEqual([
        'Account',
        'Contact',
      ]);
      expect(linker.resolveInsertOrder(['Account', 'Contact'], accountNeedsItsContact)).toEqual([
        'Contact',
        'Account',
      ]);
    });

    it('writes what hangs from a cycle after the cycle', () => {
      const edges = [
        edge('Contact', 'Account', 'Key_Contact__c'),
        edge('Account', 'Contact', 'AccountId'),
        edge('Contact', 'Case', 'ContactId', true),
        edge('Account', 'Opportunity', 'AccountId'),
      ];

      expect(
        linker.resolveInsertOrder(['Opportunity', 'Case', 'Contact', 'Account'], edges),
      ).toEqual(['Account', 'Contact', 'Case', 'Opportunity']);
    });

    it('throws on a cycle of lookups that must all be set at insert, naming them', () => {
      const edges = [
        edge('A', 'B', 'AId', true),
        edge('B', 'C', 'BId', true),
        edge('C', 'A', 'CId', true),
        edge('A', 'D', 'AId'),
      ];

      expect(() => linker.resolveInsertOrder(['A', 'B', 'C', 'D'], edges)).toThrow(
        'Cycle detected among objects: A, B, C. B.AId, C.BId and A.CId must be set when the ' +
          'record is created, so no object of the cycle can be written first.',
      );
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

  describe('lookupsFilledAfter', () => {
    it('leaves to the second pass a lookup of a cycle that points forward, and one at its own object', () => {
      const edges = [
        edge('Contact', 'Account', 'Key_Contact__c'),
        edge('Account', 'Contact', 'AccountId'),
        edge('Account', 'Account', 'ParentId'),
        edge('Contact', 'Case', 'ContactId'),
      ];
      const order = linker.resolveInsertOrder(['Case', 'Contact', 'Account'], edges);

      expect(order).toEqual(['Account', 'Contact', 'Case']);
      expect(lookups(linker.lookupsFilledAfter(order, edges))).toEqual([
        'Account.Key_Contact__c->Contact',
        'Account.ParentId->Account',
      ]);
    });

    it('never leaves to the second pass a lookup that must be set at insert', () => {
      // One the record may not leave empty, or one an update cannot set: the
      // second pass could not fill it. A self-reference of that kind goes as
      // it was read.
      const edges = [edge('Account', 'Account', 'ParentId', true), edge('B', 'A', 'BId', true)];

      expect(linker.lookupsFilledAfter(['A', 'B', 'Account'], edges)).toEqual([]);
    });

    it('leaves out a lookup at an object outside the order', () => {
      const edges = [edge('User', 'Account', 'OwnerId'), edge('Contact', 'Account', 'Key__c')];

      expect(linker.lookupsFilledAfter(['Account'], edges)).toEqual([]);
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

    it('marks required a lookup the record may not leave empty, one the platform requires, and one an update cannot set', () => {
      const describes = new Map<string, DescribeSObjectResultLike>([
        [
          'OpportunityLineItem',
          {
            fields: [
              // The describe calls it nullable; an insert without it is refused.
              {
                name: 'PricebookEntryId',
                type: 'reference',
                referenceTo: ['PricebookEntry'],
                nillable: true,
                createable: true,
                updateable: false,
              },
              {
                name: 'OpportunityId',
                type: 'reference',
                referenceTo: ['Opportunity'],
                nillable: false,
                createable: true,
                updateable: false,
              },
            ],
          },
        ],
        [
          'Opportunity',
          {
            fields: [
              {
                name: 'Key_Line__c',
                type: 'reference',
                referenceTo: ['OpportunityLineItem'],
                nillable: true,
                createable: true,
                updateable: false,
              },
              {
                name: 'ContactId',
                type: 'reference',
                referenceTo: ['Contact'],
                nillable: true,
                createable: true,
                updateable: true,
              },
            ],
          },
        ],
        ['PricebookEntry', { fields: [] }],
        ['Contact', { fields: [] }],
      ]);

      const edges = linker.buildEdgesFromDescribe(
        ['OpportunityLineItem', 'Opportunity', 'PricebookEntry', 'Contact'],
        describes,
      );

      expect(edges.map((e) => [`${e.to}.${e.fieldApiName}`, e.required])).toEqual([
        ['OpportunityLineItem.PricebookEntryId', true],
        ['OpportunityLineItem.OpportunityId', true],
        ['Opportunity.Key_Line__c', true],
        ['Opportunity.ContactId', false],
      ]);
    });

    it("breaks an account's key contact against a contact's account: accounts first, what points forward filled after", () => {
      // The describes a real source gave: every lookup of the two may be left
      // empty and set by an update. The clone's preview stopped on "Cycle
      // detected among objects: Account, Contact".
      const lookup = (name: string, referenceTo: string) => ({
        name,
        type: 'reference',
        referenceTo: [referenceTo],
        nillable: true,
        createable: true,
        updateable: true,
      });
      const describes = new Map<string, DescribeSObjectResultLike>([
        [
          'Account',
          {
            fields: [
              lookup('ParentId', 'Account'),
              lookup('Key_Contact__c', 'Contact'),
              {
                name: 'MasterRecordId',
                type: 'reference',
                referenceTo: ['Account'],
                nillable: true,
                createable: false,
                updateable: false,
              },
            ],
          },
        ],
        ['Contact', { fields: [lookup('AccountId', 'Account'), lookup('ReportsToId', 'Contact')] }],
      ]);
      const objects = ['Contact', 'Account'];

      const edges = linker.buildEdgesFromDescribe(objects, describes);
      const order = linker.resolveInsertOrder(objects, edges);

      expect(order).toEqual(['Account', 'Contact']);
      expect(lookups(linker.lookupsFilledAfter(order, edges))).toEqual([
        'Contact.ReportsToId->Contact',
        'Account.ParentId->Account',
        'Account.Key_Contact__c->Contact',
      ]);
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
      // An order, not a lookup: nothing for the second pass to fill.
      expect(linker.lookupsFilledAfter(linker.resolveInsertOrder(objects, edges), edges)).toEqual(
        [],
      );
    });

    describe('a cycle through the emails-before-tasks order', () => {
      /**
       * An email with a lookup of its own at a task, besides the task it
       * names, and the rest as the org describes them: the order puts the
       * emails first, the lookup puts the task first, and the two make a
       * cycle. With `sourceEmail`, the task points back at an email through a
       * lookup of its own, which it may not leave empty.
       */
      function emailsWithAFollowUpTask(followUp: {
        nillable: boolean;
        sourceEmail?: boolean;
      }): Map<string, DescribeSObjectResultLike> {
        const sourceEmail = {
          name: 'Source_Email__c',
          type: 'reference',
          referenceTo: ['EmailMessage'],
          nillable: false,
          createable: true,
          updateable: true,
        };
        return new Map<string, DescribeSObjectResultLike>([
          ['Case', { fields: [] }],
          [
            'Task',
            {
              fields: [
                {
                  name: 'WhatId',
                  type: 'reference',
                  referenceTo: ['Case'],
                  nillable: true,
                  createable: true,
                  updateable: true,
                },
                ...(followUp.sourceEmail ? [sourceEmail] : []),
              ],
            },
          ],
          [
            'EmailMessage',
            {
              fields: [
                {
                  name: 'ParentId',
                  type: 'reference',
                  referenceTo: ['Case'],
                  nillable: true,
                  createable: true,
                  updateable: true,
                },
                {
                  name: 'ActivityId',
                  type: 'reference',
                  referenceTo: ['Task'],
                  nillable: true,
                  createable: true,
                  updateable: false,
                },
                {
                  name: 'Follow_Up_Task__c',
                  type: 'reference',
                  referenceTo: ['Task'],
                  nillable: followUp.nillable,
                  createable: true,
                  updateable: true,
                },
              ],
            },
          ],
        ]);
      }
      const objects = ['Task', 'EmailMessage', 'Case'];

      it('keeps the emails first, and leaves the lookup that closes the cycle to the second pass', () => {
        const edges = linker.buildEdgesFromDescribe(
          objects,
          emailsWithAFollowUpTask({ nillable: true }),
        );

        const order = linker.resolveInsertOrder(objects, edges);

        expect(order).toEqual(['Case', 'EmailMessage', 'Task']);
        expect(lookups(linker.lookupsFilledAfter(order, edges))).toEqual([
          'EmailMessage.Follow_Up_Task__c->Task',
        ]);
      });

      it('does not take it for a cycle no order breaks when the lookup must be set at insert: the task goes first', () => {
        // The order is the clone's choice, the lookup the platform's rule.
        // Counted as a lookup, the order stopped the clone on a cycle the
        // tasks-first order writes.
        const edges = linker.buildEdgesFromDescribe(
          objects,
          emailsWithAFollowUpTask({ nillable: false }),
        );

        const order = linker.resolveInsertOrder(objects, edges);

        expect(order).toEqual(['Case', 'Task', 'EmailMessage']);
        expect(linker.lookupsFilledAfter(order, edges)).toEqual([]);
      });

      it('stops at a cycle of lookups that must be set at insert, naming the lookups and not the order', () => {
        const edges = linker.buildEdgesFromDescribe(
          objects,
          emailsWithAFollowUpTask({ nillable: false, sourceEmail: true }),
        );

        expect(() => linker.resolveInsertOrder(objects, edges)).toThrow(
          new Error(
            'Cycle detected among objects: EmailMessage, Task. Task.Source_Email__c and ' +
              'EmailMessage.Follow_Up_Task__c must be set when the record is created, so no ' +
              'object of the cycle can be written first.',
          ),
        );
      });
    });
  });
});
