import { describe, it, expect } from 'vitest';
import {
  buildNodeQuery,
  CATALOG_OBJECTS,
  CATALOG_READ_ORDER,
  catalogWriteEdges,
  getParentObjects,
  queryNodeRecords,
  readsFromAbove,
  seedOwnIds,
  seedScopeCache,
  sortNodesForExecution,
  sortNodesForWriting,
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

  // `included === false` means both "left out on purpose" and
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
    expect(result).toEqual({ kind: 'query', statements: ['SELECT Id, Name FROM Account'] });
  });

  it("applies the object's filter to a full-table SELECT outside scoped mode", () => {
    // A SOQL-mode run carries its WHERE clause as the root object's filter. It
    // used to be dropped here, and the root was read from the whole table.
    const result = buildNodeQuery({
      node: makeNode('Account'),
      edges: [],
      fieldInfos: FIELDS,
      scopedBuilder: null,
      scopeCache: null,
      extraWhere: "Industry = 'X' OR Rating = 'Hot'",
      maxRecordsPerObject: 200,
    });
    expect(result).toEqual({
      kind: 'query',
      statements: [
        "SELECT Id, Name FROM Account WHERE (Industry = 'X' OR Rating = 'Hot') LIMIT 200",
      ],
      limit: 200,
    });
  });

  it('falls back to selecting Id when no field is queryable', () => {
    const result = buildNodeQuery({
      node: makeNode('Account'),
      edges: [],
      fieldInfos: [{ name: 'Name', queryable: false, createable: true, isReference: false }],
      scopedBuilder: null,
      scopeCache: null,
    });
    expect(result).toEqual({ kind: 'query', statements: ['SELECT Id FROM Account'] });
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
    expect(result).toEqual({
      kind: 'query',
      statements: ['SELECT Id, Name FROM Account LIMIT 50'],
      limit: 50,
    });
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
      if (result.kind === 'query') expect(result.statements.join(' ')).not.toContain('LIMIT');
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
      statements: ["SELECT Id, Name FROM Case WHERE Id = '500XX00000000001AAA'"],
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
    expect(result).toEqual({ kind: 'query', statements: ['SELECT Id, Name FROM Case'] });
  });
  it('puts the LIMIT on every statement of a chunked scope', () => {
    const cache = new RecordScopeCache();
    cache.add(
      'Contact',
      Array.from({ length: 1300 }, (_, i) => `003${String(i).padStart(15, '0')}`),
    );
    const result = buildNodeQuery({
      node: makeNode('Contact'),
      edges: [],
      fieldInfos: FIELDS,
      scopedBuilder: new ScopedSoqlBuilder(),
      scopeCache: cache,
      rootObjectApiName: 'Case',
      rootRecordId: '500XX00000000001AAA',
      maxRecordsPerObject: 25,
    });
    expect(result.kind).toBe('query');
    if (result.kind !== 'query') return;
    expect(result.statements).toHaveLength(3);
    for (const soql of result.statements) expect(soql.endsWith(' LIMIT 25')).toBe(true);
    expect(result.limit).toBe(25);
  });

  it('reads a node through every edge that reaches it in scoped mode', () => {
    // The root account names one contact through a lookup; its other
    // contacts are found through their `AccountId`.
    const cache = new RecordScopeCache();
    cache.addRead('Account', ['001000000000001AAA']);
    cache.add('Contact', ['003000000000001AAA']);
    const result = buildNodeQuery({
      node: makeNode('Contact'),
      edges: [LOOKUP_EDGE],
      fieldInfos: [
        { name: 'Id', queryable: true, createable: false, isReference: false },
        {
          name: 'AccountId',
          queryable: true,
          createable: true,
          isReference: true,
          referenceTo: ['Account'],
        },
      ],
      scopedBuilder: new ScopedSoqlBuilder(),
      scopeCache: cache,
      rootObjectApiName: 'Account',
      rootRecordId: '001000000000001AAA',
    });
    expect(result).toEqual({
      kind: 'query',
      statements: [
        "SELECT Id, AccountId FROM Contact WHERE Id IN ('003000000000001AAA')",
        "SELECT Id, AccountId FROM Contact WHERE AccountId IN ('001000000000001AAA')",
      ],
      // The first reads the contact the account names; the second, the
      // contacts found under the account.
      byIdCount: 1,
    });
  });

  it('holds a scoped read to the required parents of the objects the run reads, and no others', () => {
    const cache = new RecordScopeCache();
    cache.addRead('Account', ['001000000000001AAA']);
    cache.add('User', ['005000000000001AAA']);
    const requiredLookup = (name: string, target: string): FieldInfo => ({
      name,
      queryable: true,
      createable: true,
      isReference: true,
      referenceTo: [target],
      nillable: false,
    });
    const result = buildNodeQuery({
      node: makeNode('AccountContactRelation'),
      edges: [{ ...LOOKUP_EDGE, targetObject: 'AccountContactRelation' }],
      fieldInfos: [
        { name: 'Id', queryable: true, createable: false, isReference: false },
        requiredLookup('AccountId', 'Account'),
        requiredLookup('CreatedById', 'User'),
      ],
      scopedBuilder: new ScopedSoqlBuilder(),
      scopeCache: cache,
      rootObjectApiName: 'Account',
      rootRecordId: '001000000000001AAA',
      readObjects: new Set(['Account', 'AccountContactRelation']),
    });
    expect(result).toEqual({
      kind: 'query',
      statements: [
        'SELECT Id, AccountId, CreatedById FROM AccountContactRelation ' +
          "WHERE (AccountId IN ('001000000000001AAA')) AND (AccountId IN ('001000000000001AAA'))",
      ],
    });
  });
});

describe('queryNodeRecords', () => {
  it('merges chunk results and keeps one row per Id', async () => {
    const byStatement: Record<string, Record<string, unknown>[]> = {
      q1: [{ Id: '003A' }, { Id: '003B' }],
      // A row matching two FK clauses comes back from both chunks.
      q2: [{ Id: '003B' }, { Id: '003C' }],
    };
    const queried: string[] = [];
    const records = await queryNodeRecords(
      { kind: 'query', statements: ['q1', 'q2'] },
      async (soql) => {
        queried.push(soql);
        return byStatement[soql] ?? [];
      },
    );
    expect(queried).toEqual(['q1', 'q2']);
    expect(records.map((r) => r['Id'])).toEqual(['003A', '003B', '003C']);
  });

  it('stops at the per-object cap across chunks', async () => {
    const queried: string[] = [];
    const records = await queryNodeRecords(
      { kind: 'query', statements: ['q1', 'q2', 'q3'], limit: 3 },
      async (soql) => {
        queried.push(soql);
        return [{ Id: `${soql}-1` }, { Id: `${soql}-2` }];
      },
    );
    expect(records).toHaveLength(3);
    expect(queried).toEqual(['q1', 'q2']);
  });

  it('returns a single statement result untouched', async () => {
    const rows = [{ Name: 'no Id selected' }, { Name: 'no Id selected' }];
    const records = await queryNodeRecords({ kind: 'query', statements: ['q1'] }, async () => rows);
    expect(records).toBe(rows);
  });

  it('names the rows the reads under a parent returned, a row a read by id returned too among them', async () => {
    const byStatement: Record<string, Record<string, unknown>[]> = {
      byId: [{ Id: '003NAMED' }, { Id: '003BOTH' }],
      underParent: [{ Id: '003BOTH' }, { Id: '003SIBLING' }],
    };
    const reached = new Set<string>();

    const records = await queryNodeRecords(
      { kind: 'query', statements: ['byId', 'underParent'], byIdCount: 1 },
      async (soql) => byStatement[soql] ?? [],
      reached,
    );

    expect(records.map((r) => r['Id'])).toEqual(['003NAMED', '003BOTH', '003SIBLING']);
    expect([...reached]).toEqual(['003BOTH', '003SIBLING']);
  });

  it('names every row of a single read from above, and none of a single read by id', async () => {
    const rows = [{ Id: '001ROOT' }];
    const fromAbove = new Set<string>();
    const byId = new Set<string>();

    await queryNodeRecords({ kind: 'query', statements: ['root'] }, async () => rows, fromAbove);
    await queryNodeRecords(
      { kind: 'query', statements: ['named'], byIdCount: 1 },
      async () => rows,
      byId,
    );

    expect([...fromAbove]).toEqual(['001ROOT']);
    expect([...byId]).toEqual([]);
  });
});

describe('the catalog', () => {
  const priceFields: FieldInfo[] = [
    { name: 'Id', queryable: true, createable: false, isReference: false },
    {
      name: 'Pricebook2Id',
      queryable: true,
      createable: true,
      isReference: true,
      referenceTo: ['Pricebook2'],
      nillable: false,
    },
  ];
  const pricesOfBook: ForgeGraphEdge = {
    sourceObject: 'Pricebook2',
    targetObject: 'PricebookEntry',
    relationshipName: 'PricebookEntries',
    type: 'lookup',
  };

  it('is read prices first, then products and selling models, their options, and price books', () => {
    expect(CATALOG_READ_ORDER).toEqual([
      'PricebookEntry',
      'Product2',
      'ProductSellingModel',
      'ProductSellingModelOption',
      'Pricebook2',
    ]);
    expect([...CATALOG_OBJECTS].sort()).toEqual([
      'Pricebook2',
      'PricebookEntry',
      'Product2',
      'ProductSellingModel',
      'ProductSellingModelOption',
    ]);
  });

  it('reads the prices a record names by id, and not under the book an opportunity named', () => {
    const cache = new RecordScopeCache();
    cache.addRead('Pricebook2', ['01s000000000001AAA']);
    cache.add('PricebookEntry', ['01u000000000001AAA']);

    const result = buildNodeQuery({
      node: makeNode('PricebookEntry'),
      edges: [pricesOfBook],
      fieldInfos: priceFields,
      scopedBuilder: new ScopedSoqlBuilder(),
      scopeCache: cache,
      rootObjectApiName: 'Opportunity',
      rootRecordId: '006000000000001AAA',
      readObjects: new Set(['Opportunity', 'Pricebook2', 'PricebookEntry']),
      catalog: CATALOG_OBJECTS,
    });

    expect(result).toEqual({
      kind: 'query',
      statements: [
        "SELECT Id, Pricebook2Id FROM PricebookEntry WHERE Id IN ('01u000000000001AAA')",
      ],
      byIdCount: 1,
    });
    if (result.kind === 'query') expect(readsFromAbove(result)).toBe(false);
  });

  it('reads from above the prices of the book it is rooted at', () => {
    const cache = new RecordScopeCache();
    cache.addRead('Pricebook2', ['01s000000000002AAA']);
    cache.addReached('Pricebook2', ['01s000000000002AAA']);

    const result = buildNodeQuery({
      node: makeNode('PricebookEntry'),
      edges: [pricesOfBook],
      fieldInfos: priceFields,
      scopedBuilder: new ScopedSoqlBuilder(),
      scopeCache: cache,
      rootObjectApiName: 'Pricebook2',
      rootRecordId: '01s000000000002AAA',
      readObjects: new Set(['Pricebook2', 'PricebookEntry']),
      catalog: CATALOG_OBJECTS,
    });

    expect(result.kind).toBe('query');
    if (result.kind === 'query') expect(readsFromAbove(result)).toBe(true);
  });

  describe('the selling model options', () => {
    const optionFields: FieldInfo[] = [
      { name: 'Id', queryable: true, createable: false, isReference: false },
      {
        name: 'Product2Id',
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: ['Product2'],
        nillable: false,
      },
      {
        name: 'ProductSellingModelId',
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: ['ProductSellingModel'],
        nillable: false,
      },
    ];
    const readOptions = (cache: RecordScopeCache) =>
      buildNodeQuery({
        node: makeNode('ProductSellingModelOption'),
        // As a graph that walked the catalog holds them: every option under a
        // product and under a selling model.
        edges: [
          { ...pricesOfBook, sourceObject: 'Product2', targetObject: 'ProductSellingModelOption' },
          {
            ...pricesOfBook,
            sourceObject: 'ProductSellingModel',
            targetObject: 'ProductSellingModelOption',
          },
        ],
        fieldInfos: optionFields,
        scopedBuilder: new ScopedSoqlBuilder(),
        scopeCache: cache,
        rootObjectApiName: 'Opportunity',
        rootRecordId: '006000000000001AAA',
        readObjects: new Set(['Opportunity', ...CATALOG_OBJECTS]),
        catalog: CATALOG_OBJECTS,
      });

    it('reads the options of the products in scope under the selling models in scope, however they were reached', () => {
      // Both only named, by the prices: neither brings anything else under it.
      const cache = new RecordScopeCache();
      cache.addRead('Product2', ['01t000000000001AAA', '01t000000000002AAA']);
      cache.addRead('ProductSellingModel', ['0jP000000000001AAA']);

      const result = readOptions(cache);

      expect(result).toEqual({
        kind: 'query',
        statements: [
          'SELECT Id, Product2Id, ProductSellingModelId FROM ProductSellingModelOption WHERE ' +
            "(Product2Id IN ('01t000000000001AAA', '01t000000000002AAA')) " +
            "AND (ProductSellingModelId IN ('0jP000000000001AAA'))",
        ],
        byIdCount: 1,
      });
      if (result.kind === 'query') expect(readsFromAbove(result)).toBe(false);
    });

    it('reads none while the run holds no selling model', () => {
      const cache = new RecordScopeCache();
      cache.addRead('Product2', ['01t000000000001AAA']);

      expect(readOptions(cache).kind).toBe('skip');
    });
  });
});

describe('sortNodesForWriting', () => {
  const link = (parent: string, child: string, required = false): ForgeGraphEdge => ({
    sourceObject: parent,
    targetObject: child,
    relationshipName: `${parent}To${child}`,
    type: 'lookup',
    required,
  });
  const order = (graph: ForgeGraph): string[] =>
    sortNodesForWriting(graph).map((n) => n.objectApiName);

  it('writes an optional parent before its child where the required edges leave it free', () => {
    // Discovery meets the root opportunity first; its account and price book
    // are optional parents, and one line item has a required one.
    const graph = makeGraph(
      ['Opportunity', 'Account', 'Pricebook2', 'OpportunityLineItem', 'PricebookEntry'].map((n) =>
        makeNode(n),
      ),
      [
        link('Account', 'Opportunity'),
        link('Pricebook2', 'Opportunity'),
        link('Opportunity', 'OpportunityLineItem', true),
        link('PricebookEntry', 'OpportunityLineItem', true),
      ],
    );

    const written = order(graph);

    expect(written.indexOf('Account')).toBeLessThan(written.indexOf('Opportunity'));
    expect(written.indexOf('Pricebook2')).toBeLessThan(written.indexOf('Opportunity'));
    expect(written.indexOf('Opportunity')).toBeLessThan(written.indexOf('OpportunityLineItem'));
  });

  it('keeps what a required edge decides against an optional parent, and writes optional parents first elsewhere', () => {
    // B needs A; A merely points back at B: A goes first whatever its lookup
    // says. C is A's optional parent, and nothing stops it going before A.
    const graph = makeGraph(
      ['B', 'A', 'C'].map((n) => makeNode(n)),
      [link('A', 'B', true), link('B', 'A'), link('C', 'A')],
    );

    expect(order(graph)).toEqual(['C', 'A', 'B']);
  });

  it('writes the members of a cycle of optional edges with the fewest parents still to write first', () => {
    // An opportunity and the quote synced to it point at each other; the
    // account points at neither and is written before both.
    const graph = makeGraph(
      ['Opportunity', 'Quote', 'Account', 'QuoteLineItem'].map((n) => makeNode(n)),
      [
        link('Quote', 'Opportunity'),
        link('Opportunity', 'Quote'),
        link('Account', 'Opportunity'),
        link('Quote', 'QuoteLineItem', true),
      ],
    );

    expect(order(graph)).toEqual(['Account', 'Opportunity', 'Quote', 'QuoteLineItem']);
  });
});

describe('the catalog write order', () => {
  const nodes = (...names: string[]) => names.map((name) => makeNode(name));
  const lineEdge = (parent: string, child: string, required = false): ForgeGraphEdge => ({
    sourceObject: parent,
    targetObject: child,
    relationshipName: `${parent}To${child}`,
    type: 'lookup',
    required,
  });

  it('writes products and selling models, their options, prices and then lines, whatever order discovery met them in', () => {
    // Two levels around an opportunity: the lines, the price and the product
    // at the edge of the graph, unwalked, with no edge between them.
    const graph = makeGraph(
      nodes(
        'Opportunity',
        'Quote',
        'ProductSellingModel',
        'QuoteLineItem',
        'OrderItem',
        'PricebookEntry',
        'Pricebook2',
        'ProductSellingModelOption',
        'Product2',
      ),
      [lineEdge('Opportunity', 'Quote'), lineEdge('Quote', 'QuoteLineItem', true)],
    );
    const objects = new Set(graph.nodes.map((n) => n.objectApiName));

    const order = sortNodesForWriting(
      graph,
      catalogWriteEdges(objects, ['QuoteLineItem', 'OrderItem']),
    ).map((n) => n.objectApiName);

    const before = (a: string, b: string): boolean => order.indexOf(a) < order.indexOf(b);
    expect(before('Product2', 'ProductSellingModelOption')).toBe(true);
    expect(before('ProductSellingModel', 'ProductSellingModelOption')).toBe(true);
    expect(before('ProductSellingModelOption', 'PricebookEntry')).toBe(true);
    expect(before('Pricebook2', 'PricebookEntry')).toBe(true);
    expect(before('PricebookEntry', 'QuoteLineItem')).toBe(true);
    expect(before('PricebookEntry', 'OrderItem')).toBe(true);
    expect(before('Quote', 'QuoteLineItem')).toBe(true);
  });

  it('orders only the objects the run writes', () => {
    const edges = catalogWriteEdges(new Set(['Product2', 'PricebookEntry', 'OrderItem']), [
      'OrderItem',
      'QuoteLineItem',
    ]);

    expect(edges.map((e) => `${e.sourceObject}>${e.targetObject}`)).toEqual([
      'Product2>PricebookEntry',
      'PricebookEntry>OrderItem',
    ]);
    expect(edges.every((e) => e.required === true)).toBe(true);
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

  it('settles the scope of the object it read: its self-lookup names a row kept out of scope', () => {
    const cache = new RecordScopeCache();
    const fields: FieldInfo[] = [
      { name: 'Id', queryable: true, createable: false, isReference: false },
      {
        name: 'ParentId',
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: ['Account'],
      },
    ];
    seedScopeCache(cache, 'Account', [{ Id: '001A', ParentId: '001P' }], fields);

    expect([...(cache.get('Account') ?? [])]).toEqual(['001A', '001P']);
    expect([...(cache.scopeOf('Account') ?? [])]).toEqual(['001A']);
  });
});
