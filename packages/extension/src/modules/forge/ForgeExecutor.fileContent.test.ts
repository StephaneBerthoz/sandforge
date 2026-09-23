import { describe, it, expect, vi } from 'vitest';
import type { ForgeGraph, ForgeGraphEdge, ForgeGraphNode } from '@sandforge/shared';
import { ForgeExecutor } from './ForgeExecutor.js';
import type { ExecuteOptions, FieldInfo, ForgeExecutorDeps } from './ForgeExecutor.js';
import { selectRows, type FakeRow } from '../../test/fakeSoql.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** A fake id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const QUOTE = id('0Q0', 1);
const DOCUMENT = id('0QD', 1);
/** What the API gives for a field holding a file's content: the address of the content. */
const CONTENT_ADDRESS = `/services/data/v66.0/sobjects/QuoteDocument/${DOCUMENT}/Document`;

const field = (name: string, overrides: Partial<FieldInfo> = {}): FieldInfo => ({
  name,
  queryable: true,
  createable: name !== 'Id',
  isReference: false,
  ...overrides,
});

const FIELDS: Record<string, FieldInfo[]> = {
  Quote: [field('Id'), field('Name')],
  QuoteDocument: [
    field('Id'),
    field('Name'),
    field('QuoteId', { isReference: true, referenceTo: ['Quote'], nillable: false }),
    // A file's content, createable: written back, the address would stand for it.
    field('Document', { type: 'base64' }),
    // One the platform keeps for itself, never written anyway.
    field('Preview', { type: 'base64', createable: false }),
  ],
  QuoteNote: [field('Id'), field('QuoteId', { isReference: true, referenceTo: ['Quote'] })],
};

function node(objectApiName: string): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 1,
    fieldCount: 3,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 2,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
  };
}

const edge = (targetObject: string): ForgeGraphEdge => ({
  sourceObject: 'Quote',
  targetObject,
  relationshipName: `${targetObject}s`,
  type: 'lookup',
});

const GRAPH: ForgeGraph = {
  nodes: [node('Quote'), node('QuoteDocument'), node('QuoteNote')],
  edges: [edge('QuoteDocument'), edge('QuoteNote')],
  totalRecords: 2,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 0,
};

const SOURCE: Record<string, FakeRow[]> = {
  Quote: [{ Id: QUOTE, Name: 'Offer' }],
  QuoteDocument: [
    { Id: DOCUMENT, Name: 'Offer.pdf', QuoteId: QUOTE, Document: CONTENT_ADDRESS, Preview: 'x' },
  ],
  // No note: an object read empty says nothing about its fields.
  QuoteNote: [],
};

/** A source holding the tables above, and a target that takes every record it is sent. */
function fakeOrgs() {
  const sent: Record<string, Array<Record<string, unknown>>> = {};
  let next = 0;
  const deps = {
    describeFields: vi.fn(async (_org: string, object: string) => FIELDS[object] ?? [field('Id')]),
    queryRecords: vi.fn(async (org: string, soql: string) =>
      org === 'src' ? selectRows(SOURCE, soql) : [],
    ),
    insertRecords: vi.fn(async (_org: string, object: string, rows: Record<string, unknown>[]) => {
      (sent[object] ??= []).push(...rows);
      return rows.map(() => ({ id: id('a00', ++next), success: true, errors: [] }));
    }),
  } satisfies ForgeExecutorDeps;
  return { deps, sent };
}

const SCOPED: ExecuteOptions = { rootRecordId: QUOTE, rootObjectApiName: 'Quote' };

describe("ForgeExecutor, fields holding a file's content", () => {
  it("leaves out of a clone every field that holds a file's content, rather than writing its address", async () => {
    const { deps, sent } = fakeOrgs();

    await new ForgeExecutor(deps).execute(GRAPH, 'src', 'tgt', () => undefined, SCOPED);

    expect(sent.QuoteDocument).toEqual([{ Name: 'Offer.pdf', QuoteId: id('a00', 1) }]);
    expect(JSON.stringify(sent)).not.toContain(CONTENT_ADDRESS);
    // Never read either: the address is not asked for.
    const reads = deps.queryRecords.mock.calls.map((c) => c[1]);
    const documentRead = reads.find((soql) => soql.includes('FROM QuoteDocument'));
    expect(documentRead).toBeDefined();
    expect(documentRead).not.toMatch(/\bDocument\b.*FROM/);
    expect(documentRead).not.toContain('Preview');
  });

  it('says in the summary which fields it left out, per object with records to write', async () => {
    const { deps } = fakeOrgs();

    const summary = await new ForgeExecutor(deps).execute(
      GRAPH,
      'src',
      'tgt',
      () => undefined,
      SCOPED,
    );

    expect(summary.fileContentFieldsLeftOut).toEqual([
      { objectApiName: 'QuoteDocument', fields: ['Document'] },
    ]);
  });

  it('says it on a dry run too, which writes nothing', async () => {
    const { deps, sent } = fakeOrgs();

    const summary = await new ForgeExecutor(deps).execute(GRAPH, 'src', 'tgt', () => undefined, {
      ...SCOPED,
      dryRun: true,
    });

    expect(sent).toEqual({});
    expect(summary.fileContentFieldsLeftOut).toEqual([
      { objectApiName: 'QuoteDocument', fields: ['Document'] },
    ]);
  });

  it('leaves them out of a parent fetched from outside the graph too, and says so', async () => {
    const CASE = id('500', 1);
    const ACCOUNT = id('001', 1);
    const logo = `/services/data/v66.0/sobjects/Account/${ACCOUNT}/Logo__c`;
    const tables: Record<string, FakeRow[]> = {
      Case: [{ Id: CASE, Subject: 'Broken', AccountId: ACCOUNT }],
      Account: [{ Id: ACCOUNT, Name: 'Acme', Logo__c: logo }],
    };
    const fields: Record<string, FieldInfo[]> = {
      Case: [
        field('Id'),
        field('Subject'),
        field('AccountId', { isReference: true, referenceTo: ['Account'], nillable: false }),
      ],
      Account: [field('Id'), field('Name'), field('Logo__c', { type: 'base64' })],
    };
    const sent: Record<string, Array<Record<string, unknown>>> = {};
    const deps: ForgeExecutorDeps = {
      describeFields: async (_org, object) => fields[object] ?? [field('Id')],
      queryRecords: async (org, soql) => (org === 'src' ? selectRows(tables, soql) : []),
      insertRecords: async (_org, object, rows) => {
        (sent[object] ??= []).push(...rows);
        return rows.map((_, i) => ({
          id: id(object === 'Case' ? '500' : '001', 900 + i),
          success: true,
          errors: [],
        }));
      },
    };
    const graph: ForgeGraph = { ...GRAPH, nodes: [node('Case')], edges: [] };

    const summary = await new ForgeExecutor(deps).execute(graph, 'src', 'tgt', () => undefined, {
      rootRecordId: CASE,
      rootObjectApiName: 'Case',
      expandOrphanParents: true,
    });

    expect(sent.Account).toEqual([{ Name: 'Acme' }]);
    expect(summary.fileContentFieldsLeftOut).toEqual([
      { objectApiName: 'Account', fields: ['Logo__c'] },
    ]);
  });

  it("says nothing of a run none of whose objects holds a file's content", async () => {
    const { deps } = fakeOrgs();
    const graph: ForgeGraph = { ...GRAPH, nodes: [node('Quote')], edges: [] };

    const summary = await new ForgeExecutor(deps).execute(
      graph,
      'src',
      'tgt',
      () => undefined,
      SCOPED,
    );

    expect(summary.fileContentFieldsLeftOut).toBeUndefined();
  });
});
