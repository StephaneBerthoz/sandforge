import { describe, it, expect } from 'vitest';
import { ScopedSoqlBuilder } from './ScopedSoqlBuilder.js';
import type { ScopableField } from './ScopedSoqlBuilder.js';
import { RecordScopeCache } from './RecordScopeCache.js';
import type { ForgeGraphEdge, ForgeGraphNode } from '@sandforge/shared';
import { selectRows, type FakeRow } from '../../test/fakeSoql.js';

function makeNode(objectApiName: string, level = 0): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 0,
    fieldCount: 0,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 0,
    estimatedSizeMB: 0,
    estimatedApiCalls: 0,
    batchStrategy: 'auto',
  };
}

function lookup(name: string, target: string): ScopableField {
  return { name, type: 'reference', referenceTo: [target] };
}

function polymorphic(name: string, targets: string[]): ScopableField {
  return { name, type: 'reference', referenceTo: targets };
}

const ROOT_ID = '500XX00000000001AAA';

describe('ScopedSoqlBuilder', () => {
  describe('scopes too large for one query', () => {
    /** Characters a statement costs once jsforce puts it in the query URI. */
    const uriLength = (soql: string): number => encodeURIComponent(soql).length;
    const ids = (prefix: string, count: number): string[] =>
      Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(15, '0')}`);

    it('splits 1,300 cached ids into 3 statements that each fit a query URI', () => {
      // A scoped query travels over GET, so the whole statement has to fit
      // the request URI. A single IN list of 1,300 Ids does not; three do.
      const builder = new ScopedSoqlBuilder();
      const cache = new RecordScopeCache();
      const contactIds = ids('003', 1300);
      cache.add('Contact', contactIds);

      const result = builder.build({
        node: makeNode('Contact', 1),
        fields: [],
        selectFields: ['Id', 'LastName'],
        edges: [],
        cache,
        rootObjectApiName: 'Case',
        rootRecordId: ROOT_ID,
      });

      expect(result.scope).toBe('self-cached');
      expect(result.scopeIdCount).toBe(1300);
      expect(result.statements).toHaveLength(3);
      for (const soql of result.statements) {
        expect(soql.length).toBeLessThan(16_000);
        expect(uriLength(soql)).toBeLessThan(16_000);
        expect(soql.startsWith('SELECT Id, LastName FROM Contact WHERE Id IN (')).toBe(true);
      }
      const queried = result.statements.flatMap((soql) => soql.match(/003\d{15}/g) ?? []);
      expect(queried).toHaveLength(1300);
      expect(new Set(queried)).toEqual(new Set(contactIds));
    });

    it('never lets 3 FK fields over 600 parent ids exceed the limit', () => {
      // The parent list is repeated once per FK field. Capping the list alone
      // still built a 3 x 600 statement no org accepts.
      const builder = new ScopedSoqlBuilder();
      const cache = new RecordScopeCache();
      const accountIds = ids('001', 600);
      cache.add('Account', accountIds);
      const fkFields = ['AccountId', 'BillingAccount__c', 'ShippingAccount__c'];

      const result = builder.build({
        node: makeNode('Contact', 1),
        fields: fkFields.map((name) => lookup(name, 'Account')),
        selectFields: ['Id', ...fkFields],
        edges: [
          {
            sourceObject: 'Account',
            targetObject: 'Contact',
            relationshipName: 'Contacts',
            type: 'lookup',
          },
        ],
        cache,
        rootObjectApiName: 'Case',
        rootRecordId: ROOT_ID,
      });

      expect(result.statements.length).toBeGreaterThan(1);
      for (const soql of result.statements) {
        expect(uriLength(soql)).toBeLessThan(16_000);
      }
      // Every (field, parent id) pair is asked for exactly once.
      const pairs: string[] = [];
      for (const soql of result.statements) {
        for (const clause of soql.slice(soql.indexOf(' WHERE ') + 7).split(' OR ')) {
          const [field, list] = clause.split(' IN ');
          for (const id of list.match(/001\d{15}/g) ?? []) pairs.push(`${field}:${id}`);
        }
      }
      expect(pairs).toHaveLength(1800);
      expect(new Set(pairs).size).toBe(1800);
    });

    describe('a wide field list, where the URI fills before the Id cap', () => {
      // 200 names of 25 characters take about 6,200 URI characters before the
      // WHERE, so a statement runs out of URI well before it holds 500 Ids.
      const wideFields = Array.from(
        { length: 200 },
        (_, i) => `Custom_Field_Name_${String(i).padStart(4, '0')}__c`,
      );

      it('keeps 600 cached ids under the URI limit and asks for each once', () => {
        const builder = new ScopedSoqlBuilder();
        const cache = new RecordScopeCache();
        const contactIds = ids('003', 600);
        cache.add('Contact', contactIds);

        const result = builder.build({
          node: makeNode('Contact', 1),
          fields: [],
          selectFields: wideFields,
          edges: [],
          cache,
          rootObjectApiName: 'Case',
          rootRecordId: ROOT_ID,
        });

        expect(result.scope).toBe('self-cached');
        expect(result.statements.length).toBeGreaterThan(1);
        const perStatement = result.statements.map((soql) => soql.match(/003\d{15}/g) ?? []);
        for (const [i, soql] of result.statements.entries()) {
          expect(uriLength(soql)).toBeLessThan(16_000);
          expect(perStatement[i].length).toBeLessThan(500);
        }
        const queried = perStatement.flat();
        expect(queried).toHaveLength(600);
        expect(new Set(queried)).toEqual(new Set(contactIds));
      });

      it('keeps 3 FK fields over 600 parent ids under the URI limit and asks for each pair once', () => {
        const builder = new ScopedSoqlBuilder();
        const cache = new RecordScopeCache();
        cache.add('Account', ids('001', 600));
        const fkFields = ['AccountId', 'BillingAccount__c', 'ShippingAccount__c'];

        const result = builder.build({
          node: makeNode('Contact', 1),
          fields: fkFields.map((name) => lookup(name, 'Account')),
          selectFields: [...fkFields, ...wideFields],
          edges: [
            {
              sourceObject: 'Account',
              targetObject: 'Contact',
              relationshipName: 'Contacts',
              type: 'lookup',
            },
          ],
          cache,
          rootObjectApiName: 'Case',
          rootRecordId: ROOT_ID,
        });

        expect(result.scope).toBe('parent-fk');
        expect(result.statements.length).toBeGreaterThan(1);
        const pairs: string[] = [];
        for (const soql of result.statements) {
          expect(uriLength(soql)).toBeLessThan(16_000);
          let idsInStatement = 0;
          for (const clause of soql.slice(soql.indexOf(' WHERE ') + 7).split(' OR ')) {
            const [field, list] = clause.split(' IN ');
            for (const id of list.match(/001\d{15}/g) ?? []) {
              pairs.push(`${field}:${id}`);
              idsInStatement++;
            }
          }
          expect(idsInStatement).toBeLessThan(500);
        }
        expect(pairs).toHaveLength(1800);
        expect(new Set(pairs).size).toBe(1800);
      });
    });

    it('carries the extra filter on every statement', () => {
      const builder = new ScopedSoqlBuilder();
      const cache = new RecordScopeCache();
      cache.add('Account', ids('001', 1200));

      const result = builder.build({
        node: makeNode('Contact', 1),
        fields: [lookup('AccountId', 'Account')],
        selectFields: ['Id'],
        edges: [
          {
            sourceObject: 'Account',
            targetObject: 'Contact',
            relationshipName: 'Contacts',
            type: 'lookup',
          },
        ],
        cache,
        rootObjectApiName: 'Case',
        rootRecordId: ROOT_ID,
        extraWhere: "Status__c = 'Open'",
      });

      expect(result.statements.length).toBeGreaterThan(1);
      for (const soql of result.statements) {
        expect(soql).toMatch(/WHERE \(AccountId IN \([^)]*\)\) AND \(Status__c = 'Open'\)$/);
      }
    });

    it('refuses a field list so long that no Id fits beside it, and names the object', () => {
      const builder = new ScopedSoqlBuilder();
      const cache = new RecordScopeCache();
      cache.add('Contact', ids('003', 2));
      const selectFields = Array.from(
        { length: 700 },
        (_, i) => `Very_Long_Custom_Field_${String(i).padStart(4, '0')}__c`,
      );

      expect(() =>
        builder.build({
          node: makeNode('Contact', 1),
          fields: [],
          selectFields,
          edges: [],
          cache,
          rootObjectApiName: 'Case',
          rootRecordId: ROOT_ID,
        }),
      ).toThrow(/Contact/);
    });
  });

  describe('root', () => {
    it('emits WHERE Id = ? for the root object', () => {
      const builder = new ScopedSoqlBuilder();
      const cache = new RecordScopeCache();
      const result = builder.build({
        node: makeNode('Case'),
        fields: [],
        selectFields: ['Id', 'CaseNumber', 'AccountId'],
        edges: [],
        cache,
        rootObjectApiName: 'Case',
        rootRecordId: ROOT_ID,
      });

      expect(result.scoped).toBe(true);
      expect(result.scope).toBe('root');
      expect(result.statements[0]).toBe(
        `SELECT Id, CaseNumber, AccountId FROM Case WHERE Id = '${ROOT_ID}'`,
      );
      expect(result.scopeIdCount).toBe(1);
      expect(result.byIdCount).toBe(0);
    });

    it('escapes single quotes in the root record id', () => {
      const builder = new ScopedSoqlBuilder();
      const result = builder.build({
        node: makeNode('Case'),
        fields: [],
        selectFields: ['Id'],
        edges: [],
        cache: new RecordScopeCache(),
        rootObjectApiName: 'Case',
        rootRecordId: "1' OR Id != '",
      });

      expect(result.statements[0]).toContain("WHERE Id = '1\\' OR Id != \\''");
    });
  });

  describe('parent-fk', () => {
    it('uses cached parent IDs to scope a child via lookup field', () => {
      const builder = new ScopedSoqlBuilder();
      const cache = new RecordScopeCache();
      cache.add('Account', ['001AAA', '001BBB']);

      const edges: ForgeGraphEdge[] = [
        {
          sourceObject: 'Account',
          targetObject: 'Contact',
          relationshipName: 'Contacts',
          type: 'lookup',
        },
      ];

      const result = builder.build({
        node: makeNode('Contact'),
        fields: [lookup('AccountId', 'Account'), { name: 'Email', type: 'email', referenceTo: [] }],
        selectFields: ['Id', 'Name', 'AccountId'],
        edges,
        cache,
        rootObjectApiName: 'Case',
        rootRecordId: ROOT_ID,
      });

      expect(result.scoped).toBe(true);
      expect(result.scope).toBe('parent-fk');
      expect(result.parentObjectsUsed).toEqual(['Account']);
      expect(result.scopeIdCount).toBe(2);
      expect(result.statements[0]).toBe(
        `SELECT Id, Name, AccountId FROM Contact WHERE AccountId IN ('001AAA', '001BBB')`,
      );
    });

    it('reverse-lookup (root → child) — scopes CaseHistory by Case IDs', () => {
      const builder = new ScopedSoqlBuilder();
      const cache = new RecordScopeCache();
      cache.add('Case', [ROOT_ID]);

      const edges: ForgeGraphEdge[] = [
        {
          sourceObject: 'Case',
          targetObject: 'CaseHistory',
          relationshipName: 'Histories',
          type: 'lookup',
        },
      ];

      const result = builder.build({
        node: makeNode('CaseHistory'),
        fields: [lookup('CaseId', 'Case')],
        selectFields: ['Id', 'CaseId', 'Field'],
        edges,
        cache,
        rootObjectApiName: 'Case',
        rootRecordId: ROOT_ID,
      });

      expect(result.scoped).toBe(true);
      expect(result.scope).toBe('parent-fk');
      expect(result.statements[0]).toBe(
        `SELECT Id, CaseId, Field FROM CaseHistory WHERE CaseId IN ('${ROOT_ID}')`,
      );
    });

    it('combines multiple parents with OR', () => {
      const builder = new ScopedSoqlBuilder();
      const cache = new RecordScopeCache();
      cache.add('Account', ['001AAA']);
      cache.add('Case', [ROOT_ID]);

      const edges: ForgeGraphEdge[] = [
        {
          sourceObject: 'Account',
          targetObject: 'Contact',
          relationshipName: 'Contacts',
          type: 'lookup',
        },
        {
          sourceObject: 'Case',
          targetObject: 'Contact',
          relationshipName: 'CaseContacts',
          type: 'lookup',
        },
      ];

      const result = builder.build({
        node: makeNode('Contact'),
        fields: [lookup('AccountId', 'Account'), lookup('Case_Source__c', 'Case')],
        selectFields: ['Id'],
        edges,
        cache,
        rootObjectApiName: 'Case',
        rootRecordId: ROOT_ID,
      });

      expect(result.scope).toBe('parent-fk');
      expect(result.parentObjectsUsed).toEqual(['Account', 'Case']);
      expect(result.statements[0]).toBe(
        `SELECT Id FROM Contact WHERE AccountId IN ('001AAA') OR Case_Source__c IN ('${ROOT_ID}')`,
      );
    });

    it('emits multiple FK clauses when one parent has several reference fields on the child', () => {
      const builder = new ScopedSoqlBuilder();
      const cache = new RecordScopeCache();
      cache.add('Account', ['001AAA']);

      const edges: ForgeGraphEdge[] = [
        {
          sourceObject: 'Account',
          targetObject: 'Contact',
          relationshipName: 'Contacts',
          type: 'lookup',
        },
      ];

      const result = builder.build({
        node: makeNode('Contact'),
        fields: [lookup('AccountId', 'Account'), lookup('PrimaryAccount__c', 'Account')],
        selectFields: ['Id'],
        edges,
        cache,
        rootObjectApiName: 'Case',
        rootRecordId: ROOT_ID,
      });

      expect(result.statements[0]).toContain('AccountId IN');
      expect(result.statements[0]).toContain('PrimaryAccount__c IN');
    });

    it('handles polymorphic lookups (e.g. WhatId → [Account, Opportunity])', () => {
      const builder = new ScopedSoqlBuilder();
      const cache = new RecordScopeCache();
      cache.add('Account', ['001AAA']);

      const edges: ForgeGraphEdge[] = [
        {
          sourceObject: 'Account',
          targetObject: 'Task',
          relationshipName: 'Tasks',
          type: 'lookup',
        },
      ];

      const result = builder.build({
        node: makeNode('Task'),
        fields: [polymorphic('WhatId', ['Account', 'Opportunity'])],
        selectFields: ['Id', 'WhatId'],
        edges,
        cache,
        rootObjectApiName: 'Case',
        rootRecordId: ROOT_ID,
      });

      expect(result.scoped).toBe(true);
      expect(result.statements[0]).toBe(`SELECT Id, WhatId FROM Task WHERE WhatId IN ('001AAA')`);
    });
  });

  describe('self-cached', () => {
    it('uses pre-cached IDs for the node itself before falling back to FK scoping', () => {
      const builder = new ScopedSoqlBuilder();
      const cache = new RecordScopeCache();
      cache.add('Account', ['001AAA', '001BBB']);

      const result = builder.build({
        node: makeNode('Account'),
        fields: [],
        selectFields: ['Id', 'Name'],
        edges: [],
        cache,
        rootObjectApiName: 'Case',
        rootRecordId: ROOT_ID,
      });

      expect(result.scope).toBe('self-cached');
      expect(result.statements[0]).toBe(
        `SELECT Id, Name FROM Account WHERE Id IN ('001AAA', '001BBB')`,
      );
      expect(result.scopeIdCount).toBe(2);
    });
  });

  describe('every edge', () => {
    const contactsOfAccount: ForgeGraphEdge = {
      sourceObject: 'Account',
      targetObject: 'Contact',
      relationshipName: 'Contacts',
      type: 'lookup',
    };

    /** A cache holding the root account and the contact its lookup names. */
    function keyContactCache(): RecordScopeCache {
      const cache = new RecordScopeCache();
      cache.addRead('Account', ['001AAA']);
      cache.add('Contact', ['003KEY']);
      return cache;
    }

    it('reads an object rows already read point at by those ids, then under its cached parents', () => {
      const result = new ScopedSoqlBuilder().build({
        node: makeNode('Contact'),
        fields: [lookup('AccountId', 'Account')],
        selectFields: ['Id', 'AccountId'],
        edges: [contactsOfAccount],
        cache: keyContactCache(),
        rootObjectApiName: 'Account',
        rootRecordId: '001AAA',
        everyEdge: true,
      });

      expect(result.scoped).toBe(true);
      expect(result.scope).toBe('self-and-parent-fk');
      expect(result.statements).toEqual([
        "SELECT Id, AccountId FROM Contact WHERE Id IN ('003KEY')",
        "SELECT Id, AccountId FROM Contact WHERE AccountId IN ('001AAA')",
      ]);
      expect(result.parentObjectsUsed).toEqual(['Account']);
      expect(result.scopeIdCount).toBe(2);
      // The first reads the contact the account names; the second, the
      // contacts under the account.
      expect(result.byIdCount).toBe(1);
    });

    it('reads it by the cached ids alone when not asked for every edge', () => {
      const result = new ScopedSoqlBuilder().build({
        node: makeNode('Contact'),
        fields: [lookup('AccountId', 'Account')],
        selectFields: ['Id'],
        edges: [contactsOfAccount],
        cache: keyContactCache(),
        rootObjectApiName: 'Account',
        rootRecordId: '001AAA',
      });

      expect(result.scope).toBe('self-cached');
      expect(result.statements).toEqual(["SELECT Id FROM Contact WHERE Id IN ('003KEY')"]);
    });

    it('holds the rows found under a parent to the required parents in scope, not those named by id', () => {
      // The contact the account names is needed whatever its region; a
      // sibling found through `AccountId` is kept inside what was read.
      const cache = keyContactCache();
      cache.addRead('Region__c', ['a0R000000000001AAA']);

      const result = new ScopedSoqlBuilder().build({
        node: makeNode('Contact'),
        fields: [
          lookup('AccountId', 'Account'),
          { name: 'Region__c', type: 'reference', referenceTo: ['Region__c'], nillable: false },
        ],
        selectFields: ['Id'],
        edges: [contactsOfAccount],
        cache,
        rootObjectApiName: 'Account',
        rootRecordId: '001AAA',
        everyEdge: true,
        readObjects: new Set(['Account', 'Contact', 'Region__c']),
      });

      expect(result.statements).toEqual([
        "SELECT Id FROM Contact WHERE Id IN ('003KEY')",
        "SELECT Id FROM Contact WHERE (AccountId IN ('001AAA')) AND (Region__c IN ('a0R000000000001AAA'))",
      ]);
    });

    it('takes nothing from a lookup of the object to itself', () => {
      const result = new ScopedSoqlBuilder().build({
        node: makeNode('Contact'),
        fields: [lookup('ReportsToId', 'Contact')],
        selectFields: ['Id'],
        edges: [
          {
            sourceObject: 'Contact',
            targetObject: 'Contact',
            relationshipName: 'ReportsTo',
            type: 'lookup',
          },
        ],
        cache: keyContactCache(),
        rootObjectApiName: 'Account',
        rootRecordId: '001AAA',
        everyEdge: true,
      });

      expect(result.scope).toBe('self-cached');
      expect(result.statements).toEqual(["SELECT Id FROM Contact WHERE Id IN ('003KEY')"]);
    });

    it('reads a child under the ids its parent held when read, not under ids met for it since', () => {
      // The root account's `ParentId` names an account no read will fetch.
      const cache = new RecordScopeCache();
      cache.addRead('Account', ['001AAA']);
      cache.add('Account', ['001PARENT']);

      const result = new ScopedSoqlBuilder().build({
        node: makeNode('Contact'),
        fields: [lookup('AccountId', 'Account')],
        selectFields: ['Id'],
        edges: [contactsOfAccount],
        cache,
        rootObjectApiName: 'Account',
        rootRecordId: '001AAA',
        everyEdge: true,
      });

      expect(result.statements).toEqual(["SELECT Id FROM Contact WHERE AccountId IN ('001AAA')"]);
    });

    it('carries the extra filter on the reads by id and under parents alike', () => {
      const result = new ScopedSoqlBuilder().build({
        node: makeNode('Contact'),
        fields: [lookup('AccountId', 'Account')],
        selectFields: ['Id'],
        edges: [contactsOfAccount],
        cache: keyContactCache(),
        rootObjectApiName: 'Account',
        rootRecordId: '001AAA',
        extraWhere: "Status__c = 'Open'",
        everyEdge: true,
      });

      expect(result.statements).toEqual([
        "SELECT Id FROM Contact WHERE Id IN ('003KEY') AND (Status__c = 'Open')",
        "SELECT Id FROM Contact WHERE (AccountId IN ('001AAA')) AND (Status__c = 'Open')",
      ]);
    });

    it('lays both reads under the URI limit and asks for every id once', () => {
      const ids = (prefix: string, count: number): string[] =>
        Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(15, '0')}`);
      const contactIds = ids('003', 1300);
      const accountIds = ids('001', 600);
      const cache = new RecordScopeCache();
      cache.addRead('Account', accountIds);
      cache.add('Contact', contactIds);

      const result = new ScopedSoqlBuilder().build({
        node: makeNode('Contact'),
        fields: [lookup('AccountId', 'Account')],
        selectFields: ['Id', 'AccountId'],
        edges: [contactsOfAccount],
        cache,
        rootObjectApiName: 'Case',
        rootRecordId: ROOT_ID,
        everyEdge: true,
      });

      for (const soql of result.statements) {
        expect(encodeURIComponent(soql).length).toBeLessThan(16_000);
      }
      const byId = result.statements.filter((soql) => soql.includes(' WHERE Id IN ('));
      const underParent = result.statements.filter((soql) =>
        soql.includes(' WHERE AccountId IN ('),
      );
      expect(byId.length + underParent.length).toBe(result.statements.length);
      expect(result.statements.indexOf(underParent[0])).toBe(byId.length);
      expect(result.byIdCount).toBe(byId.length);
      expect(byId.flatMap((soql) => soql.match(/003\d{15}/g) ?? [])).toEqual(contactIds);
      expect(underParent.flatMap((soql) => soql.match(/001\d{15}/g) ?? [])).toEqual(accountIds);
    });
  });

  describe('unscoped', () => {
    it('returns a zero-result query when no parent is in cache', () => {
      const builder = new ScopedSoqlBuilder();
      const cache = new RecordScopeCache();

      const result = builder.build({
        node: makeNode('Product2'),
        fields: [],
        selectFields: ['Id'],
        edges: [],
        cache,
        rootObjectApiName: 'Case',
        rootRecordId: ROOT_ID,
      });

      expect(result.scoped).toBe(false);
      expect(result.scope).toBe('unscoped');
      expect(result.statements[0]).toBe('SELECT Id FROM Product2 WHERE Id = NULL');
      expect(result.scopeIdCount).toBe(0);
    });

    it('returns unscoped when an edge exists but the parent has no cached IDs', () => {
      const builder = new ScopedSoqlBuilder();
      const cache = new RecordScopeCache();
      // Edge says Account is a parent, but cache has no Account IDs.
      const edges: ForgeGraphEdge[] = [
        {
          sourceObject: 'Account',
          targetObject: 'Contact',
          relationshipName: 'Contacts',
          type: 'lookup',
        },
      ];

      const result = builder.build({
        node: makeNode('Contact'),
        fields: [lookup('AccountId', 'Account')],
        selectFields: ['Id'],
        edges,
        cache,
        rootObjectApiName: 'Case',
        rootRecordId: ROOT_ID,
      });

      expect(result.scoped).toBe(false);
    });

    it('returns unscoped when no FK field maps to the cached parent', () => {
      const builder = new ScopedSoqlBuilder();
      const cache = new RecordScopeCache();
      cache.add('Account', ['001AAA']);

      const edges: ForgeGraphEdge[] = [
        {
          sourceObject: 'Account',
          targetObject: 'Contact',
          relationshipName: 'Contacts',
          type: 'lookup',
        },
      ];

      // Contact has no field referencing Account in the metadata supplied here.
      const result = builder.build({
        node: makeNode('Contact'),
        fields: [{ name: 'Email', type: 'email', referenceTo: [] }],
        selectFields: ['Id', 'Email'],
        edges,
        cache,
        rootObjectApiName: 'Case',
        rootRecordId: ROOT_ID,
      });

      expect(result.scoped).toBe(false);
      expect(result.scope).toBe('unscoped');
    });
  });

  describe('select clause', () => {
    it('falls back to SELECT Id when no fields are supplied', () => {
      const builder = new ScopedSoqlBuilder();
      const cache = new RecordScopeCache();
      const result = builder.build({
        node: makeNode('Case'),
        fields: [],
        selectFields: [],
        edges: [],
        cache,
        rootObjectApiName: 'Case',
        rootRecordId: ROOT_ID,
      });
      expect(result.statements[0]).toBe(`SELECT Id FROM Case WHERE Id = '${ROOT_ID}'`);
    });

    it('rejects field names that fail SOQL identifier validation', () => {
      const builder = new ScopedSoqlBuilder();
      const cache = new RecordScopeCache();
      expect(() =>
        builder.build({
          node: makeNode('Case'),
          fields: [],
          selectFields: ['Id', 'Name; DROP'],
          edges: [],
          cache,
          rootObjectApiName: 'Case',
          rootRecordId: ROOT_ID,
        }),
      ).toThrow(/Invalid Salesforce API name/);
    });
  });

  it('keeps a scoped read inside the required parents the run has read', () => {
    // A price book entry reached through its product satisfies the scope
    // while belonging to a price book nothing in this run creates. Read, it
    // travels all the way to the insert and is refused there for a required
    // Pricebook2Id pointing outside the graph.
    const cache = new RecordScopeCache();
    cache.add('Product2', ['01t1', '01t2']);
    cache.add('Pricebook2', ['01s1']);

    const result = new ScopedSoqlBuilder().build({
      node: { objectApiName: 'PricebookEntry' } as never,
      fields: [
        { name: 'Product2Id', type: 'reference', referenceTo: ['Product2'], nillable: false },
        { name: 'Pricebook2Id', type: 'reference', referenceTo: ['Pricebook2'], nillable: false },
      ],
      selectFields: ['Id'],
      edges: [
        {
          sourceObject: 'Product2',
          targetObject: 'PricebookEntry',
          relationshipName: 'PricebookEntries',
          type: 'lookup',
        },
      ],
      cache,
      rootObjectApiName: 'Opportunity',
      rootRecordId: '0061',
      readObjects: new Set(['Opportunity', 'Product2', 'Pricebook2', 'PricebookEntry']),
    });

    expect(result.scoped).toBe(true);
    const soql = result.statements.join(' | ');
    // The scope still finds the entries through the product...
    expect(soql).toContain("Product2Id IN ('01t1', '01t2')");
    // ...and they must also sit in a price book this run read.
    expect(soql).toContain("AND (Pricebook2Id IN ('01s1'))");
  });

  describe('a required lookup at an object the run does not read', () => {
    /** A contact's scope: the root account, and the users its row named. */
    function contactScope(): RecordScopeCache {
      const cache = new RecordScopeCache();
      cache.addRead('Account', ['001AAA']);
      cache.add('User', ['005FIRST']);
      return cache;
    }
    const contactsOfAccount: ForgeGraphEdge = {
      sourceObject: 'Account',
      targetObject: 'Contact',
      relationshipName: 'Contacts',
      type: 'lookup',
    };
    const requiredUser = (name: string): ScopableField => ({
      name,
      type: 'reference',
      referenceTo: ['User'],
      nillable: false,
    });

    it('does not narrow on the users the rows read before named', () => {
      // Every lookup at a User caches the id it meets, and no read ever
      // fetches a User: held to them, a contact created by anyone else was
      // left out of the clone.
      const result = new ScopedSoqlBuilder().build({
        node: makeNode('Contact'),
        fields: [
          lookup('AccountId', 'Account'),
          requiredUser('OwnerId'),
          requiredUser('CreatedById'),
          requiredUser('LastModifiedById'),
        ],
        selectFields: ['Id'],
        edges: [contactsOfAccount],
        cache: contactScope(),
        rootObjectApiName: 'Account',
        rootRecordId: '001AAA',
        readObjects: new Set(['Account', 'Contact']),
      });

      expect(result.statements).toEqual(["SELECT Id FROM Contact WHERE AccountId IN ('001AAA')"]);
      expect(result.reason).not.toContain('required parents');
    });

    it('holds a lookup that may name either kind to the kind the run reads', () => {
      // An event's relation names a contact or a user. The user can never be
      // written; the contact must be one the run has.
      const cache = contactScope();
      cache.addRead('Contact', ['003AAA']);

      const result = new ScopedSoqlBuilder().build({
        node: makeNode('EventRelation'),
        fields: [
          lookup('AccountId', 'Account'),
          {
            name: 'RelationId',
            type: 'reference',
            referenceTo: ['Contact', 'User'],
            nillable: false,
          },
        ],
        selectFields: ['Id'],
        edges: [{ ...contactsOfAccount, targetObject: 'EventRelation' }],
        cache,
        rootObjectApiName: 'Account',
        rootRecordId: '001AAA',
        readObjects: new Set(['Account', 'Contact', 'EventRelation']),
      });

      expect(result.statements).toEqual([
        "SELECT Id FROM EventRelation WHERE (AccountId IN ('001AAA')) AND (RelationId IN ('003AAA'))",
      ]);
    });

    it('narrows on nothing when the caller does not say which objects it reads', () => {
      const cache = contactScope();
      cache.addRead('Region__c', ['a0R000000000001AAA']);

      const result = new ScopedSoqlBuilder().build({
        node: makeNode('Contact'),
        fields: [
          lookup('AccountId', 'Account'),
          { name: 'Region__c', type: 'reference', referenceTo: ['Region__c'], nillable: false },
          requiredUser('OwnerId'),
        ],
        selectFields: ['Id'],
        edges: [contactsOfAccount],
        cache,
        rootObjectApiName: 'Account',
        rootRecordId: '001AAA',
      });

      expect(result.statements).toEqual(["SELECT Id FROM Contact WHERE AccountId IN ('001AAA')"]);
    });
  });

  it('does not restrict on a required parent the run has not read', () => {
    // Nothing cached for the target means nothing to restrict against, and an
    // empty IN list would select no rows at all.
    const cache = new RecordScopeCache();
    cache.add('Product2', ['01t1']);

    const result = new ScopedSoqlBuilder().build({
      node: { objectApiName: 'PricebookEntry' } as never,
      fields: [
        { name: 'Product2Id', type: 'reference', referenceTo: ['Product2'], nillable: false },
        { name: 'Pricebook2Id', type: 'reference', referenceTo: ['Pricebook2'], nillable: false },
      ],
      selectFields: ['Id'],
      edges: [
        {
          sourceObject: 'Product2',
          targetObject: 'PricebookEntry',
          relationshipName: 'PricebookEntries',
          type: 'lookup',
        },
      ],
      cache,
      rootObjectApiName: 'Opportunity',
      rootRecordId: '0061',
    });

    expect(result.statements.join(' | ')).not.toContain('Pricebook2Id IN ()');
    expect(result.statements.join(' | ')).not.toContain('Pricebook2Id');
  });

  describe('a required parent whose scope is too large for one query', () => {
    const ids = (prefix: string, count: number): string[] =>
      Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(15, '0')}`);
    const required = (name: string, target: string): ScopableField => ({
      name,
      type: 'reference',
      referenceTo: [target],
      nillable: false,
    });
    const childOf = (parent: string, child: string): ForgeGraphEdge => ({
      sourceObject: parent,
      targetObject: child,
      relationshipName: `${parent}To${child}`,
      type: 'lookup',
    });
    /** The rows of `tables` every statement selects, once each. */
    const readAll = (tables: Record<string, FakeRow[]>, statements: string[]): Set<string> =>
      new Set(statements.flatMap((soql) => selectRows(tables, soql).map((row) => String(row.Id))));

    it('reads the items of 1,300 orders, and of their promotions, each statement under the URI limit', () => {
      // Every item must belong to an order the run has: the narrowing that
      // says so repeated all 1,300 order ids in every statement, and a query
      // URI holds about 500. The read threw before a single item was read.
      const orders = ids('801', 1300);
      // Named by a row read after the orders were: in the narrowing, not in
      // the orders' scope.
      const namedLater = ids('802', 5);
      const promotions = ids('a0P', 3);
      const cache = new RecordScopeCache();
      cache.addRead('Order', orders);
      cache.add('Order', namedLater);
      cache.addRead('Promotion__c', promotions);
      const item = (n: number, order: string, promotion: string | null): FakeRow => ({
        Id: `802${String(n).padStart(15, '0')}X`,
        OrderId: order,
        Promotion__c: promotion,
      });
      const tables = {
        OrderItem: [
          ...orders.map((order, n) => item(n, order, null)),
          // Under a promotion, on an order named later: in scope.
          item(5000, namedLater[0], promotions[0]),
          // Under a promotion, on an order the run does not have: out.
          item(5001, '801999999999999999', promotions[1]),
          // Under neither.
          item(5002, '801999999999999998', null),
        ],
      };

      const result = new ScopedSoqlBuilder().build({
        node: makeNode('OrderItem'),
        fields: [required('OrderId', 'Order'), lookup('Promotion__c', 'Promotion__c')],
        selectFields: ['Id', 'OrderId', 'Promotion__c'],
        edges: [childOf('Order', 'OrderItem'), childOf('Promotion__c', 'OrderItem')],
        cache,
        rootObjectApiName: 'Account',
        rootRecordId: '001000000000001AAA',
        everyEdge: true,
        readObjects: new Set(['Account', 'Order', 'Promotion__c', 'OrderItem']),
      });

      for (const soql of result.statements) {
        expect(encodeURIComponent(soql).length).toBeLessThan(16_000);
      }
      const read = readAll(tables, result.statements);
      expect(read.size).toBe(1301);
      expect(read.has(tables.OrderItem[1300].Id as string)).toBe(true);
      expect(read.has(tables.OrderItem[1301].Id as string)).toBe(false);
      expect(read.has(tables.OrderItem[1302].Id as string)).toBe(false);
    });

    it('holds rows to two large required parents at once, splitting both', () => {
      // A relation between an account and a contact, both required, found
      // under 900 accounts and 900 contacts.
      const accounts = ids('001', 900);
      const contacts = ids('003', 900);
      const cache = new RecordScopeCache();
      cache.addRead('Account', accounts);
      cache.addRead('Contact', contacts);
      const relation = (n: number, account: string, contact: string): FakeRow => ({
        Id: `07k${String(n).padStart(15, '0')}`,
        AccountId: account,
        ContactId: contact,
      });
      const tables = {
        AccountContactRelation: [
          ...accounts.map((account, n) => relation(n, account, contacts[n])),
          // Its contact outside what the run has: out.
          relation(5000, accounts[0], '003999999999999999'),
          // Its account outside what the run has: out.
          relation(5001, '001999999999999999', contacts[0]),
        ],
      };

      const result = new ScopedSoqlBuilder().build({
        node: makeNode('AccountContactRelation'),
        fields: [required('AccountId', 'Account'), required('ContactId', 'Contact')],
        selectFields: ['Id', 'AccountId', 'ContactId'],
        edges: [
          childOf('Account', 'AccountContactRelation'),
          childOf('Contact', 'AccountContactRelation'),
        ],
        cache,
        rootObjectApiName: 'Case',
        rootRecordId: ROOT_ID,
        everyEdge: true,
        readObjects: new Set(['Case', 'Account', 'Contact', 'AccountContactRelation']),
      });

      for (const soql of result.statements) {
        expect(encodeURIComponent(soql).length).toBeLessThan(16_000);
      }
      const read = readAll(tables, result.statements);
      expect(read.size).toBe(900);
      expect([...read].some((id) => id.includes('5000') || id.includes('5001'))).toBe(false);
    });

    it('keeps carrying a narrowing that fits in the statement it always did', () => {
      const cache = new RecordScopeCache();
      cache.addRead('Order', ['801000000000001AAA']);

      const result = new ScopedSoqlBuilder().build({
        node: makeNode('OrderItem'),
        fields: [required('OrderId', 'Order')],
        selectFields: ['Id'],
        edges: [childOf('Order', 'OrderItem')],
        cache,
        rootObjectApiName: 'Account',
        rootRecordId: '001000000000001AAA',
        everyEdge: true,
        readObjects: new Set(['Order', 'OrderItem']),
      });

      expect(result.statements).toEqual([
        "SELECT Id FROM OrderItem WHERE (OrderId IN ('801000000000001AAA')) AND (OrderId IN ('801000000000001AAA'))",
      ]);
    });
  });

  describe('rows joining two sets of records', () => {
    it('splits the long list over statements and carries the short one in each', () => {
      const products = Array.from({ length: 1300 }, (_, i) => `01t${String(i).padStart(15, '0')}`);

      const statements = new ScopedSoqlBuilder().buildJoining({
        objectApiName: 'ProductSellingModelOption',
        selectFields: ['Id', 'Product2Id'],
        split: { field: 'Product2Id', ids: new Set(products) },
        whole: { field: 'ProductSellingModelId', ids: new Set(['0jP000000000001AAA']) },
        extraWhere: 'IsDefault = true',
      });

      expect(statements.length).toBe(3);
      for (const soql of statements) {
        expect(encodeURIComponent(soql).length).toBeLessThan(16_000);
        expect(
          soql.endsWith(
            ") AND (ProductSellingModelId IN ('0jP000000000001AAA')) AND (IsDefault = true)",
          ),
        ).toBe(true);
      }
      expect(statements.flatMap((soql) => soql.match(/01t\d{15}/g) ?? [])).toEqual(products);
    });
  });

  describe('a catalog', () => {
    const CATALOG: ReadonlySet<string> = new Set(['PricebookEntry', 'Product2', 'Pricebook2']);
    const READ = new Set(['Opportunity', 'Quote', 'QuoteLineItem', ...CATALOG]);
    const pricesOfBook: ForgeGraphEdge = {
      sourceObject: 'Pricebook2',
      targetObject: 'PricebookEntry',
      relationshipName: 'PricebookEntries',
      type: 'lookup',
    };
    const required = (name: string, target: string): ScopableField => ({
      name,
      type: 'reference',
      referenceTo: [target],
      nillable: false,
    });
    const priceFields = [
      required('Pricebook2Id', 'Pricebook2'),
      required('Product2Id', 'Product2'),
    ];
    const readPrices = (cache: RecordScopeCache, catalog?: ReadonlySet<string>) =>
      new ScopedSoqlBuilder().build({
        node: makeNode('PricebookEntry'),
        fields: priceFields,
        selectFields: ['Id'],
        edges: [pricesOfBook],
        cache,
        rootObjectApiName: 'Opportunity',
        rootRecordId: '006000000000001AAA',
        everyEdge: true,
        readObjects: READ,
        catalog,
      });

    /** The opportunity's price book, read because the opportunity names it, and the price its line uses. */
    function bookMetThroughALookup(): RecordScopeCache {
      const cache = new RecordScopeCache();
      cache.add('Pricebook2', ['01s000000000001AAA']);
      cache.addRead('Pricebook2', ['01s000000000001AAA']);
      cache.add('PricebookEntry', ['01u000000000001AAA']);
      return cache;
    }

    it('reads the prices of a book the run only met through a lookup by the ids rows name', () => {
      const result = readPrices(bookMetThroughALookup(), CATALOG);

      expect(result.scope).toBe('self-cached');
      expect(result.statements).toEqual([
        "SELECT Id FROM PricebookEntry WHERE Id IN ('01u000000000001AAA')",
      ]);
      expect(result.byIdCount).toBe(1);
    });

    it('reads the whole book as before when the caller names no catalog', () => {
      const result = readPrices(bookMetThroughALookup());

      expect(result.scope).toBe('self-and-parent-fk');
      expect(result.statements[1]).toContain("Pricebook2Id IN ('01s000000000001AAA')");
    });

    it('reads every price of a book the run reached from above', () => {
      const cache = new RecordScopeCache();
      cache.addRead('Pricebook2', ['01s000000000002AAA']);
      cache.addReached('Pricebook2', ['01s000000000002AAA']);

      const result = readPrices(cache, CATALOG);

      // The prices' products are read after them, so they hold nothing back.
      expect(result.statements).toEqual([
        'SELECT Id FROM PricebookEntry WHERE (Pricebook2Id IN (' +
          "'01s000000000002AAA')) AND (Pricebook2Id IN ('01s000000000002AAA'))",
      ]);
      expect(result.byIdCount).toBe(0);
    });

    it('holds a line to its catalog lookups only once the catalog is read', () => {
      // A quote line is read before the prices it names: they are read by
      // those names, and holding the line to the prices named so far left
      // out every line whose price no earlier line had named.
      const cache = new RecordScopeCache();
      cache.addRead('Quote', ['0Q0000000000001AAA']);
      cache.add('PricebookEntry', ['01u000000000001AAA']);
      cache.add('Product2', ['01t000000000001AAA']);
      const readLines = () =>
        new ScopedSoqlBuilder().build({
          node: makeNode('QuoteLineItem'),
          fields: [
            required('QuoteId', 'Quote'),
            required('PricebookEntryId', 'PricebookEntry'),
            required('Product2Id', 'Product2'),
          ],
          selectFields: ['Id'],
          edges: [
            {
              sourceObject: 'Quote',
              targetObject: 'QuoteLineItem',
              relationshipName: 'QuoteLineItems',
              type: 'lookup',
            },
          ],
          cache,
          rootObjectApiName: 'Opportunity',
          rootRecordId: '006000000000001AAA',
          everyEdge: true,
          readObjects: READ,
          catalog: CATALOG,
        });

      expect(readLines().statements).toEqual([
        'SELECT Id FROM QuoteLineItem WHERE (QuoteId IN (' +
          "'0Q0000000000001AAA')) AND (QuoteId IN ('0Q0000000000001AAA'))",
      ]);

      cache.addRead('PricebookEntry', ['01u000000000001AAA']);
      expect(readLines().statements[0]).toContain(
        "AND (PricebookEntryId IN ('01u000000000001AAA'))",
      );
      expect(readLines().statements[0]).not.toContain('Product2Id');
    });
  });
});
