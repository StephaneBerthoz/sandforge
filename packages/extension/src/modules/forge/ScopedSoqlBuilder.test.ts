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

const ROOT_ID = '500AP00000fXeQsYAK';

describe('ScopedSoqlBuilder', () => {
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
      expect(result.soql).toBe(
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

      expect(result.soql).toContain("WHERE Id = '1\\' OR Id != \\''");
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
      expect(result.soql).toBe(
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
      expect(result.soql).toBe(
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
      expect(result.soql).toBe(
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

      expect(result.soql).toContain('AccountId IN');
      expect(result.soql).toContain('PrimaryAccount__c IN');
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
      expect(result.soql).toBe(`SELECT Id, WhatId FROM Task WHERE WhatId IN ('001AAA')`);
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
      expect(result.soql).toBe(`SELECT Id, Name FROM Account WHERE Id IN ('001AAA', '001BBB')`);
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
      expect(result.soql).toBe('SELECT Id FROM Product2 WHERE Id = NULL');
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
      expect(result.soql).toBe(`SELECT Id FROM Case WHERE Id = '${ROOT_ID}'`);
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
