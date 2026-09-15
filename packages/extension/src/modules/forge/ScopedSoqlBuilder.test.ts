import { describe, it, expect } from 'vitest';
import { ScopedSoqlBuilder } from './ScopedSoqlBuilder.js';
import type { ScopableField } from './ScopedSoqlBuilder.js';
import { RecordScopeCache } from './RecordScopeCache.js';
import type { ForgeGraphEdge, ForgeGraphNode } from '@sandforge/shared';

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
});
