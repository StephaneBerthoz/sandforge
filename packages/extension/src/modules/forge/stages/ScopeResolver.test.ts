import { describe, it, expect } from 'vitest';
import {
  buildNodeQuery,
  getParentObjects,
  seedOwnIds,
  seedScopeCache,
  sortNodesForExecution,
} from './ScopeResolver.js';
import { RecordScopeCache } from '../RecordScopeCache.js';
import { ScopedSoqlBuilder } from '../ScopedSoqlBuilder.js';
import type { FieldInfo } from '../ForgeExecutor.js';
import type { ForgeGraph, ForgeGraphEdge, ForgeGraphNode } from '@sandforge/shared';

function makeNode(objectApiName: string, overrides?: Partial<ForgeGraphNode>): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 2,
    fieldCount: 5,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 0,
    estimatedSizeMB: 0,
    estimatedApiCalls: 0,
    batchStrategy: 'auto',
    ...overrides,
  };
}

function makeGraph(nodes: ForgeGraphNode[], edges: ForgeGraphEdge[] = []): ForgeGraph {
  const totalRecords = nodes.reduce((s, n) => s + n.recordCount, 0);
  return {
    nodes,
    edges,
    totalRecords,
    estimatedSizeMB: totalRecords * 0.001,
    estimatedDurationSeconds: totalRecords * 0.01,
  };
}

/** Run `fn`, returning the message of the Error it throws (fails loudly if it does not). */
function throwMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('Expected the call to throw, but it returned normally.');
}

const LOOKUP_EDGE: ForgeGraphEdge = {
  sourceObject: 'Account',
  targetObject: 'Contact',
  relationshipName: 'Contacts',
  type: 'lookup',
};

describe('sortNodesForExecution', () => {
  it('orders parents before children', () => {
    const graph = makeGraph([makeNode('Contact'), makeNode('Account')], [LOOKUP_EDGE]);
    const sorted = sortNodesForExecution(graph);
    expect(sorted.map((n) => n.objectApiName)).toEqual(['Account', 'Contact']);
  });

  it('appends cycle members after acyclic nodes', () => {
    const graph = makeGraph(
      [makeNode('A'), makeNode('B'), makeNode('Standalone')],
      [
        { sourceObject: 'A', targetObject: 'B', relationshipName: 'Bs', type: 'lookup' },
        { sourceObject: 'B', targetObject: 'A', relationshipName: 'As', type: 'lookup' },
      ],
    );
    const sorted = sortNodesForExecution(graph);
    expect(sorted[0].objectApiName).toBe('Standalone');
    expect(sorted).toHaveLength(3);
  });

  it('brings the root object to the front when requested', () => {
    const graph = makeGraph([makeNode('Account'), makeNode('Contact')], [LOOKUP_EDGE]);
    const sorted = sortNodesForExecution(graph, 'Contact');
    expect(sorted[0].objectApiName).toBe('Contact');
  });

  it('throws when the root is missing from the graph', () => {
    const graph = makeGraph([makeNode('Account')]);
    expect(() => sortNodesForExecution(graph, 'Case')).toThrow(/missing from the graph/);
  });

  it('throws when the root node is excluded', () => {
    const graph = makeGraph([makeNode('Account', { included: false })]);
    expect(() => sortNodesForExecution(graph, 'Account')).toThrow(/excluded/);
  });

  // ERRORS-07: `included === false` means both "left out on purpose" and
  // "discovery could not measure it". The two must not produce the same
  // message — the second one is an org/access failure, not a user choice.
  it('reports a count-failed root as unmeasured, not as excluded by choice', () => {
    const graph = makeGraph([
      makeNode('Account', {
        included: false,
        status: 'error',
        recordCount: 0,
        errors: ['Record count unavailable: QUERY_TIMEOUT'],
      }),
    ]);

    const message = throwMessage(() => sortNodesForExecution(graph, 'Account'));
    expect(message).toContain('could not be measured');
    expect(message).toContain('Record count unavailable: QUERY_TIMEOUT');
    expect(message).toContain('unknown, not zero');
    expect(message).not.toContain('Either include the root node');
  });

  it('reports a describe-failed root as unmeasured', () => {
    const graph = makeGraph([
      makeNode('Account', {
        included: false,
        status: 'error',
        recordCount: 0,
        fieldCount: 0,
        errors: ['Describe unavailable: INSUFFICIENT_ACCESS'],
      }),
    ]);

    const message = throwMessage(() => sortNodesForExecution(graph, 'Account'));
    expect(message).toContain('could not be measured');
    expect(message).toContain('Describe unavailable: INSUFFICIENT_ACCESS');
  });

  it('falls back to a generic reason when the unmeasured root carries no error text', () => {
    const graph = makeGraph([makeNode('Account', { included: false, status: 'error' })]);

    expect(() => sortNodesForExecution(graph, 'Account')).toThrow(/unknown discovery error/);
  });

  it('keeps the deliberate-exclusion message for a root the user left out', () => {
    const graph = makeGraph([makeNode('Account', { included: false, recordCount: 0 })]);

    const message = throwMessage(() => sortNodesForExecution(graph, 'Account'));
    expect(message).toContain('Either include the root node');
    expect(message).not.toContain('could not be measured');
  });
});

describe('getParentObjects', () => {
  it('returns source objects of edges targeting the given object', () => {
    const graph = makeGraph(
      [makeNode('Account'), makeNode('Contact'), makeNode('Case')],
      [
        LOOKUP_EDGE,
        {
          sourceObject: 'Case',
          targetObject: 'Contact',
          relationshipName: 'Cases',
          type: 'lookup',
        },
      ],
    );
    expect(getParentObjects('Contact', graph)).toEqual(['Account', 'Case']);
    expect(getParentObjects('Account', graph)).toEqual([]);
  });
});

describe('buildNodeQuery', () => {
  const FIELDS: FieldInfo[] = [
    { name: 'Id', queryable: true, createable: false, isReference: false },
    { name: 'Name', queryable: true, createable: true, isReference: false },
    { name: 'Secret__c', queryable: false, createable: true, isReference: false },
  ];

  it('builds a full-table SELECT from queryable fields outside scoped mode', () => {
    const result = buildNodeQuery({
      node: makeNode('Account'),
      edges: [],
      fieldInfos: FIELDS,
      scopedBuilder: null,
      scopeCache: null,
    });
    expect(result).toEqual({ kind: 'query', soql: 'SELECT Id, Name FROM Account' });
  });

  it('falls back to selecting Id when no field is queryable', () => {
    const result = buildNodeQuery({
      node: makeNode('Account'),
      edges: [],
      fieldInfos: [{ name: 'Name', queryable: false, createable: true, isReference: false }],
      scopedBuilder: null,
      scopeCache: null,
    });
    expect(result).toEqual({ kind: 'query', soql: 'SELECT Id FROM Account' });
  });

  it('appends a floored LIMIT when maxRecordsPerObject is positive', () => {
    const result = buildNodeQuery({
      node: makeNode('Account'),
      edges: [],
      fieldInfos: FIELDS,
      scopedBuilder: null,
      scopeCache: null,
      maxRecordsPerObject: 50.7,
    });
    expect(result).toEqual({ kind: 'query', soql: 'SELECT Id, Name FROM Account LIMIT 50' });
  });

  it('appends no LIMIT when the cap is undefined, 0 or negative', () => {
    for (const maxRecordsPerObject of [undefined, 0, -3]) {
      const result = buildNodeQuery({
        node: makeNode('Account'),
        edges: [],
        fieldInfos: FIELDS,
        scopedBuilder: null,
        scopeCache: null,
        maxRecordsPerObject,
      });
      expect(result.kind).toBe('query');
      if (result.kind === 'query') expect(result.soql).not.toContain('LIMIT');
    }
  });

  it('scopes the root node to WHERE Id = <rootRecordId>', () => {
    const cache = new RecordScopeCache();
    cache.add('Case', ['500XX00000000001AAA']);
    const result = buildNodeQuery({
      node: makeNode('Case'),
      edges: [],
      fieldInfos: FIELDS,
      scopedBuilder: new ScopedSoqlBuilder(),
      scopeCache: cache,
      rootObjectApiName: 'Case',
      rootRecordId: '500XX00000000001AAA',
    });
    expect(result).toEqual({
      kind: 'query',
      soql: "SELECT Id, Name FROM Case WHERE Id = '500XX00000000001AAA'",
    });
  });

  it('returns skip with a reason when the node is out of scope', () => {
    const cache = new RecordScopeCache();
    cache.add('Case', ['500XX00000000001AAA']);
    const result = buildNodeQuery({
      node: makeNode('Product2'),
      edges: [],
      fieldInfos: FIELDS,
      scopedBuilder: new ScopedSoqlBuilder(),
      scopeCache: cache,
      rootObjectApiName: 'Case',
      rootRecordId: '500XX00000000001AAA',
    });
    expect(result.kind).toBe('skip');
    if (result.kind === 'skip') expect(result.reason.length).toBeGreaterThan(0);
  });

  it('ignores scope inputs when the builder or cache is null (legacy mode)', () => {
    const result = buildNodeQuery({
      node: makeNode('Case'),
      edges: [],
      fieldInfos: FIELDS,
      scopedBuilder: null,
      scopeCache: null,
      rootObjectApiName: 'Case',
      rootRecordId: '500XX00000000001AAA',
    });
    expect(result).toEqual({ kind: 'query', soql: 'SELECT Id, Name FROM Case' });
  });
});

describe('seedOwnIds / seedScopeCache', () => {
  it('registers only string Id values', () => {
    const cache = new RecordScopeCache();
    seedOwnIds(cache, 'Account', [{ Id: '001A' }, { Id: 42 }, { Name: 'NoId' }, { Id: '001B' }]);
    expect([...(cache.get('Account') ?? [])]).toEqual(['001A', '001B']);
  });

  it('propagates FK values to their target objects for multi-hop scoping', () => {
    const cache = new RecordScopeCache();
    const fields: FieldInfo[] = [
      { name: 'Id', queryable: true, createable: false, isReference: false },
      {
        name: 'AccountId',
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: ['Account'],
      },
      {
        name: 'WhatId',
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: ['Account', 'Opportunity'],
      },
      { name: 'NoTarget__c', queryable: true, createable: true, isReference: true },
    ];
    seedScopeCache(cache, 'Case', [{ Id: '500A', AccountId: '001A', WhatId: '006O' }], fields);

    expect(cache.has('Case')).toBe(true);
    expect([...(cache.get('Account') ?? [])].sort()).toEqual(['001A', '006O']);
    expect([...(cache.get('Opportunity') ?? [])]).toEqual(['006O']);
    expect(cache.has('NoTarget__c')).toBe(false);
  });
});
