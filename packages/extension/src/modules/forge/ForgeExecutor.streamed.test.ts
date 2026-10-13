import { describe, it, expect, vi } from 'vitest';
import type { ForgeGraph, ForgeGraphEdge, ForgeGraphNode } from '@sandforge/shared';
import { selectRows, type FakeRow } from '../../test/fakeSoql.js';
import { canonicalRecordId } from '../../core/common/existingRecordMatch.js';
import { PersonaRegistry } from '../autopilot/SmartAnonymizer.js';
import { ForgeAnonymizer } from './ForgeAnonymizer.js';
import { ForgeAbortedError, ForgeExecutor } from './ForgeExecutor.js';
import type {
  ExecuteOptions,
  ExecutionSummary,
  FieldInfo,
  ForgeExecutorDeps,
  ForgeProgressEvent,
  ForgeStreamPage,
  ForgeWriteBoundary,
} from './ForgeExecutor.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * A run of whole tables read and written page by page (`ExecuteOptions.stream`):
 * each page of an object written before the next is read. Run with pages of a
 * few rows against the same orgs as a run that reads every table whole, it
 * writes the same records with the same values, links and creates the same,
 * and leaves the same to remove.
 */

type Row = Record<string, unknown>;

const KEY_PREFIX: Record<string, string> = { Account: '001', Contact: '003', Contract: '800' };

const idField: FieldInfo = { name: 'Id', queryable: true, createable: false, isReference: false };
const text = (name: string, type = 'string'): FieldInfo => ({
  name,
  queryable: true,
  createable: true,
  updateable: true,
  isReference: false,
  type,
});
const lookup = (name: string, target: string, nillable: boolean): FieldInfo => ({
  name,
  queryable: true,
  createable: true,
  updateable: true,
  isReference: true,
  referenceTo: [target],
  nillable,
});

/** A source id of `object`, the `n`-th, its checksum right. */
function sourceId(object: string, n: number): string {
  const id = canonicalRecordId(`${KEY_PREFIX[object]}S${String(n).padStart(11, '0')}`);
  if (!id) throw new Error('no id');
  return id;
}

function node(objectApiName: string, recordCount: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount,
    fieldCount: 4,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 3,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'rest',
  };
}

function edge(parent: string, child: string, required: boolean): ForgeGraphEdge {
  return {
    sourceObject: parent,
    targetObject: child,
    relationshipName: 'x',
    type: 'lookup',
    required,
  };
}

function graphOf(nodes: ForgeGraphNode[], edges: ForgeGraphEdge[]): ForgeGraph {
  return { nodes, edges, totalRecords: 0, estimatedSizeMB: 0, estimatedDurationSeconds: 0 };
}

/** The objects of a pair of orgs: each object's fields, and the source's rows of it. */
type Schema = Record<string, { fields: FieldInfo[]; rows: Row[] }>;

/** The rows of `schema`, as the scoped tests' fake org reads them. */
function tablesOf(schema: Schema): Record<string, FakeRow[]> {
  return Object.fromEntries(
    Object.entries(schema).map(([object, { rows }]) => [
      object,
      rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([field, value]) => [
            field,
            typeof value === 'string' || typeof value === 'boolean' ? value : null,
          ]),
        ),
      ),
    ]),
  );
}

interface FakeOrgOptions {
  /** Rows a page of the source's cursor holds. */
  cursorPage?: number;
  /** What the target refuses a row with, by object; nothing for a row it takes. */
  refuse?: (object: string, row: Row) => string | undefined;
  /** Abort the run once the target has taken this many inserts. */
  abortAfterInserts?: number;
  /** Deps that give no cursor: every statement read whole. */
  noCursor?: boolean;
}

/**
 * A source org holding `schema`'s rows, answering whole-table statements in
 * the order of the ids — whole, through its cursor, or counted — and a target
 * that creates what it is sent, with ids drawn in the order it takes them, and
 * applies the updates sent to what it created.
 */
function fakeOrgs(schema: Schema, options: FakeOrgOptions = {}) {
  const target = new Map<string, Map<string, Row>>();
  const created: Record<string, number> = {};
  let inserted = 0;
  const insertCalls: Array<{ object: string; rows: number }> = [];
  /** Rows the source has handed out, and rows the target has been sent or left, as the run went. */
  const flow = { handedOut: 0, written: 0, mostAhead: 0 };
  const holder: { executor?: ForgeExecutor } = {};

  const select = (soql: string): Row[] => {
    const match =
      /^SELECT (.+?) FROM (\w+)(?: WHERE Id > '(\w+)')?( ORDER BY Id)?(?: LIMIT (\d+))?$/.exec(
        soql,
      );
    // A scoped read: the fake org of the scoped tests reads it.
    if (!match) return selectRows(tablesOf(schema), soql);
    const [, fields, object, after, , limit] = match;
    const names = fields.split(', ');
    const rows = [...(schema[object]?.rows ?? [])]
      .sort((a, b) => String(a['Id']).localeCompare(String(b['Id'])))
      .filter((row) => after === undefined || String(row['Id']) > after)
      .slice(0, limit === undefined ? undefined : Number(limit));
    return rows.map((row) => Object.fromEntries(names.map((name) => [name, row[name] ?? null])));
  };
  const handOut = (rows: Row[]): Row[] => {
    flow.handedOut += rows.length;
    flow.mostAhead = Math.max(flow.mostAhead, flow.handedOut - flow.written);
    return rows;
  };

  const deps: ForgeExecutorDeps = {
    describeFields: vi.fn(async (_org: string, object: string) => {
      const known = schema[object];
      if (!known) throw new Error(`NOT_FOUND: ${object}`);
      return [idField, ...known.fields];
    }),
    queryRecords: vi.fn(async (org: string, soql: string) => {
      if (org === 'tgt') {
        if (soql === 'SELECT ApiName, StatusCode FROM ContractStatus') {
          return [
            { ApiName: 'Draft', StatusCode: 'Draft' },
            { ApiName: 'Activated', StatusCode: 'Activated' },
          ];
        }
        return [];
      }
      return handOut(select(soql));
    }),
    ...(options.noCursor
      ? {}
      : {
          queryPages: (org: string, soql: string) =>
            (async function* cursor(): AsyncGenerator<Row[]> {
              if (org !== 'src') return;
              const rows = select(soql);
              const size = options.cursorPage ?? 5;
              if (rows.length === 0) yield [];
              for (let at = 0; at < rows.length; at += size) {
                yield handOut(rows.slice(at, at + size));
              }
            })(),
        }),
    countRecords: vi.fn(async (_org: string, soql: string) => {
      const object = /FROM (\w+)/.exec(soql)?.[1] ?? '';
      return schema[object]?.rows.length ?? 0;
    }),
    insertRecords: vi.fn(async (_org: string, object: string, rows: Row[]) => {
      insertCalls.push({ object, rows: rows.length });
      flow.written += rows.length;
      const results = rows.map((row) => {
        const refusal = options.refuse?.(object, row);
        if (refusal) return { id: '', success: false, errors: [refusal] };
        created[object] = (created[object] ?? 0) + 1;
        const id = canonicalRecordId(
          `${KEY_PREFIX[object]}T${String(created[object]).padStart(11, '0')}`,
        );
        if (!id) throw new Error('no id');
        const table = target.get(object) ?? new Map<string, Row>();
        table.set(id, { ...row });
        target.set(object, table);
        return { id, success: true, errors: [] };
      });
      inserted += rows.length;
      if (options.abortAfterInserts !== undefined && inserted >= options.abortAfterInserts) {
        holder.executor?.abort();
      }
      return results;
    }),
    updateRecords: vi.fn(async (_org: string, object: string, rows: Row[]) =>
      rows.map((row) => {
        const id = String(row['Id']);
        const record = target.get(object)?.get(id);
        if (record) Object.assign(record, { ...row, Id: undefined });
        return { id, success: record !== undefined, errors: record ? [] : ['not found'] };
      }),
    ),
    isObjectCreatable: async () => true,
  };
  const executor = new ForgeExecutor(deps);
  holder.executor = executor;
  /** The target's records, object by object, each by its id: what the run left there. */
  const written = (): Record<string, Record<string, Row>> =>
    Object.fromEntries(
      [...target].map(([object, table]) => [
        object,
        Object.fromEntries(
          [...table].map(([id, row]) => [
            id,
            Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)),
          ]),
        ),
      ]),
    );
  return { executor, deps, written, insertCalls, flow };
}

/** Run `graph` over a fresh pair of orgs holding `schema`. */
async function runOver(
  schema: Schema,
  graph: ForgeGraph,
  options: ExecuteOptions = {},
  orgOptions: FakeOrgOptions = {},
) {
  const orgs = fakeOrgs(schema, orgOptions);
  const events: ForgeProgressEvent[] = [];
  const summary = await orgs.executor.execute(graph, 'src', 'tgt', (e) => events.push(e), options);
  return { ...orgs, summary, events };
}

/** What two runs must agree on to have written the same. */
function outcomeOf(summary: ExecutionSummary) {
  return {
    successCount: summary.successCount,
    failedCount: summary.failedCount,
    linkedCount: summary.linkedCount,
    skippedCount: summary.skippedCount,
    remapTable: summary.remapTable,
    createdByObject: summary.createdByObject,
    remapByObject: summary.remapByObject,
    readByObject: summary.readByObject,
  };
}

const PAGE_SIZES = [2, 3, 7, 50];

/** Accounts naming their parent account — before and after them — and contacts under them. */
function selfLookups(): { schema: Schema; graph: ForgeGraph } {
  const accounts = Array.from({ length: 23 }, (_, n) => ({
    Id: sourceId('Account', n),
    Name: `Account ${n}`,
    // Each names one before it and one after it in turn, and a few none.
    ParentId: n % 5 === 0 ? null : sourceId('Account', (n * 7 + 3) % 23),
  }));
  const contacts = Array.from({ length: 40 }, (_, n) => ({
    Id: sourceId('Contact', n),
    LastName: `Contact ${n}`,
    AccountId: sourceId('Account', n % 23),
  }));
  return {
    schema: {
      Account: { fields: [text('Name'), lookup('ParentId', 'Account', true)], rows: accounts },
      Contact: {
        fields: [text('LastName'), lookup('AccountId', 'Account', false)],
        rows: contacts,
      },
    },
    graph: graphOf(
      [node('Account', 23), node('Contact', 40)],
      [edge('Account', 'Contact', true), edge('Account', 'Account', false)],
    ),
  };
}

/** An account's key contact against a contact's account: a cycle, each lookup nillable. */
function cycle(): { schema: Schema; graph: ForgeGraph } {
  const accounts = Array.from({ length: 15 }, (_, n) => ({
    Id: sourceId('Account', n),
    Name: `Account ${n}`,
    Key_Contact__c: sourceId('Contact', (n * 4) % 15),
  }));
  const contacts = Array.from({ length: 15 }, (_, n) => ({
    Id: sourceId('Contact', n),
    LastName: `Contact ${n}`,
    AccountId: sourceId('Account', (n * 2) % 15),
  }));
  return {
    schema: {
      Account: {
        fields: [text('Name'), lookup('Key_Contact__c', 'Contact', true)],
        rows: accounts,
      },
      Contact: { fields: [text('LastName'), lookup('AccountId', 'Account', true)], rows: contacts },
    },
    graph: graphOf(
      [node('Account', 15), node('Contact', 15)],
      [edge('Account', 'Contact', false), edge('Contact', 'Account', false)],
    ),
  };
}

/** Contracts past Draft under their accounts: written as drafts, their status given back. */
function statuses(): { schema: Schema; graph: ForgeGraph } {
  const accounts = Array.from({ length: 4 }, (_, n) => ({
    Id: sourceId('Account', n),
    Name: `Account ${n}`,
  }));
  const contracts = Array.from({ length: 12 }, (_, n) => ({
    Id: sourceId('Contract', n),
    AccountId: sourceId('Account', n % 4),
    Status: n % 3 === 0 ? 'Draft' : 'Activated',
  }));
  return {
    schema: {
      Account: { fields: [text('Name')], rows: accounts },
      Contract: {
        fields: [lookup('AccountId', 'Account', false), text('Status', 'picklist')],
        rows: contracts,
      },
    },
    graph: graphOf([node('Account', 4), node('Contract', 12)], [edge('Account', 'Contract', true)]),
  };
}

/** Contacts whose names and addresses are anonymized. */
function anonymized(): { schema: Schema; graph: ForgeGraph; options: () => ExecuteOptions } {
  const contacts = Array.from({ length: 17 }, (_, n) => ({
    Id: sourceId('Contact', n),
    FirstName: `First${n}`,
    LastName: `Last${n}`,
    Email: `person${n}@example.com`,
  }));
  return {
    schema: {
      Contact: {
        fields: [text('FirstName'), text('LastName'), text('Email', 'email')],
        rows: contacts,
      },
    },
    graph: graphOf([node('Contact', 17)], []),
    options: () => ({
      anonymization: {
        fields: { Contact: ['FirstName', 'LastName', 'Email'] },
        methods: { name: 'fake', email: 'fake' } as never,
      },
    }),
  };
}

/** Deps' anonymizer of one run, keyed so that two runs over the same rows draw the same. */
function keyedAnonymizer(): ForgeExecutorDeps['anonymize'] {
  const anonymizer = new ForgeAnonymizer(new PersonaRegistry('a-key-for-two-runs'), 'a-salt');
  return (request) => anonymizer.anonymize(request);
}

describe('a run of whole tables read page by page', () => {
  describe.each([
    ['self-lookups', selfLookups],
    ['a cycle', cycle],
    ['statuses given back', statuses],
  ])('over %s', (_name, build) => {
    it.each(PAGE_SIZES)(
      'writes, links and leaves to remove what the run read whole does, in pages of %i',
      async (pageSize) => {
        const { schema, graph } = build();
        const whole = await runOver(schema, graph);
        const paged = await runOver(schema, graph, { stream: { pageSize } });

        expect(paged.written()).toEqual(whole.written());
        expect(outcomeOf(paged.summary)).toEqual(outcomeOf(whole.summary));
        expect(paged.summary.errors).toEqual(whole.summary.errors);
        // Paged, the writes went in more calls, each of a page or less.
        expect(paged.insertCalls.every((call) => call.rows <= pageSize)).toBe(true);
        expect(paged.insertCalls.length).toBeGreaterThanOrEqual(whole.insertCalls.length);
      },
    );
  });

  it.each(PAGE_SIZES)(
    'draws the same people across pages as a run read whole, in pages of %i',
    async (pageSize) => {
      const { schema, graph, options } = anonymized();
      const run = (stream?: ExecuteOptions['stream']) => {
        const orgs = fakeOrgs(schema);
        const executor = new ForgeExecutor({ ...orgs.deps, anonymize: keyedAnonymizer() });
        return executor
          .execute(graph, 'src', 'tgt', () => {}, { ...options(), ...(stream ? { stream } : {}) })
          .then((summary) => ({ summary, written: orgs.written() }));
      };
      const whole = await run();
      const paged = await run({ pageSize });

      expect(paged.written).toEqual(whole.written);
      expect(outcomeOf(paged.summary)).toEqual(outcomeOf(whole.summary));
      // Anonymized: no source name or address went to the target.
      const values = Object.values(paged.written.Contact ?? {}).flatMap((row) =>
        Object.values(row),
      );
      expect(
        values.some((value) => /First\d|Last\d|person\d+@example\.com/.test(String(value))),
      ).toBe(false);
      expect(
        new Set(Object.values(paged.written.Contact ?? {}).map((row) => row['LastName'])).size,
      ).toBeGreaterThan(1);
    },
  );

  it('holds no more rows than a page and a page of the cursor before it writes them', async () => {
    const { schema, graph } = selfLookups();
    const paged = await runOver(schema, graph, { stream: { pageSize: 4 } }, { cursorPage: 3 });
    expect(paged.summary.successCount).toBe(63);
    // Rows handed out by the source and not yet sent to the target, at most:
    // the page being written, and what is left of the cursor's page.
    expect(paged.flow.mostAhead).toBeLessThanOrEqual(4 + 3);
    const whole = await runOver(schema, graph);
    // Read whole, an object is in hand before its first row is written.
    expect(whole.flow.mostAhead).toBeGreaterThanOrEqual(40);
  });

  it('pages its writes all the same when the deps give no cursor', async () => {
    const { schema, graph } = selfLookups();
    const whole = await runOver(schema, graph);
    const paged = await runOver(schema, graph, { stream: { pageSize: 3 } }, { noCursor: true });
    expect(paged.written()).toEqual(whole.written());
    expect(paged.insertCalls.every((call) => call.rows <= 3)).toBe(true);
  });

  it('ends each object on one line that counts every page, after a step for each', async () => {
    const { schema, graph } = selfLookups();
    const paged = await runOver(schema, graph, { stream: { pageSize: 10 } });
    const ofAccount = paged.events.filter((e) => e.objectName === 'Account');
    expect(ofAccount.filter((e) => e.status === 'done')).toEqual([
      expect.objectContaining({ message: 'Completed Account: 23 succeeded, 0 failed' }),
    ]);
    expect(
      ofAccount.filter((e) => e.status === 'running' && /page \d/.test(e.message ?? '')),
    ).toHaveLength(3);
  });

  it('tells each page written: where the object stands, and the records the page created', async () => {
    const { schema, graph } = selfLookups();
    const pages: ForgeStreamPage[] = [];
    const paged = await runOver(schema, graph, {
      stream: { pageSize: 10, onPage: (page) => void pages.push(structuredClone(page)) },
    });
    const ofAccount = pages.filter((page) => page.objectApiName === 'Account');
    expect(ofAccount.map((page) => page.checkpoint)).toEqual([
      { lastId: sourceId('Account', 9), read: 10 },
      { lastId: sourceId('Account', 19), read: 20 },
      { lastId: sourceId('Account', 22), read: 23 },
    ]);
    // Every record the run created was told as its page was written: what a
    // run that stops part way leaves to remove.
    const told = Object.fromEntries(
      pages.flatMap((page) => page.created.map(({ sourceId: s, targetId }) => [s, targetId])),
    );
    expect(told).toEqual(paged.summary.remapTable);
  });

  it('resumes after the last id a run before it wrote, linking to what that run created', async () => {
    const { schema, graph } = selfLookups();
    const first = await runOver(schema, graph, {
      stream: { pageSize: 10 },
    });
    // The run before wrote the first ten accounts, then stopped.
    const writtenBefore = Object.fromEntries(
      Array.from({ length: 10 }, (_, n) => [
        sourceId('Account', n),
        first.summary.remapTable[sourceId('Account', n)],
      ]),
    );
    const orgs = fakeOrgs(schema);
    const queryPages = vi.spyOn(orgs.deps, 'queryPages');
    const summary = await orgs.executor.execute(graph, 'src', 'tgt', () => {}, {
      writtenBefore,
      stream: {
        pageSize: 10,
        resumeAfter: { Account: { lastId: sourceId('Account', 9), read: 10 } },
      },
    });
    const resumed = { ...orgs, summary };
    const accountCalls = resumed.insertCalls.filter((call) => call.object === 'Account');
    expect(accountCalls.reduce((sum, call) => sum + call.rows, 0)).toBe(13);
    expect(queryPages.mock.calls.map(([, soql]) => soql)).toContain(
      `SELECT Id, Name, ParentId FROM Account WHERE Id > '${sourceId('Account', 9)}' ORDER BY Id`,
    );
    // Each contact under one of the ten accounts goes under the record the
    // run before created.
    const contactOfFirst = Object.values(resumed.written().Contact ?? {}).find(
      (row) => row['LastName'] === 'Contact 0',
    );
    expect(contactOfFirst?.['AccountId']).toBe(writtenBefore[sourceId('Account', 0)]);
    // This run read the thirteen accounts after the checkpoint, no more.
    expect(resumed.summary.readByObject).toContainEqual({ objectApiName: 'Account', read: 13 });
  });

  it('reads an object to the ceiling and says the rest of its table was not read', async () => {
    const { schema, graph } = selfLookups();
    const paged = await runOver(schema, graph, { stream: { pageSize: 4, ceiling: 10 } });
    expect(paged.summary.truncatedObjects).toEqual(['Account', 'Contact']);
    expect(paged.summary.readByObject).toEqual([
      { objectApiName: 'Account', read: 10 },
      { objectApiName: 'Contact', read: 10 },
    ]);
    // The cap on each object, under the ceiling, is no truncation.
    const capped = await runOver(schema, graph, {
      maxRecordsPerObject: 5,
      stream: { pageSize: 4, ceiling: 10 },
    });
    expect(capped.summary.truncatedObjects).toEqual([]);
    expect(capped.summary.readByObject).toEqual([
      { objectApiName: 'Account', read: 5 },
      { objectApiName: 'Contact', read: 5 },
    ]);
  });

  it('judges an object failed on all its pages, as a run read whole judges it on its rows', async () => {
    const { schema, graph } = selfLookups();
    // The first page of accounts is refused whole, the rest taken: a third of
    // them fails, and the contacts under the others are written.
    const refuseFirst = (object: string, row: Row): string | undefined =>
      object === 'Account' && Number(String(row['Name']).split(' ')[1]) < 8
        ? 'FIELD_CUSTOM_VALIDATION_EXCEPTION: no'
        : undefined;
    const whole = await runOver(schema, graph, {}, { refuse: refuseFirst });
    const paged = await runOver(
      schema,
      graph,
      { stream: { pageSize: 8 } },
      { refuse: refuseFirst },
    );
    expect(paged.written()).toEqual(whole.written());
    expect(paged.summary.failedCount).toBe(whole.summary.failedCount);
    // One report of what the target refused, counting every row sent, as a
    // run read whole has it. The second pass leaves empty the same lookups;
    // it is sent fewer, a page's rows naming the accounts of the pages before
    // at insert.
    const ofStage = (summary: ExecutionSummary, stage: string) =>
      summary.errors.filter(
        (error) => error.stage === stage && error.objectApiName !== '__pass2__',
      );
    expect(ofStage(paged.summary, 'insert')).toEqual(ofStage(whole.summary, 'insert'));
    const pass2 = (summary: ExecutionSummary) =>
      summary.errors.find((error) => error.objectApiName === '__pass2__')?.failedCount;
    expect(pass2(paged.summary)).toBe(pass2(whole.summary));
    expect(
      paged.events.find((e) => e.objectName === 'Contact' && e.status === 'done'),
    ).toBeTruthy();

    // Refused past half, the object is failed, and the contacts skipped.
    const refuseMost = (object: string, row: Row): string | undefined =>
      object === 'Account' && Number(String(row['Name']).split(' ')[1]) < 16
        ? 'FIELD_CUSTOM_VALIDATION_EXCEPTION: no'
        : undefined;
    const failed = await runOver(
      schema,
      graph,
      { stream: { pageSize: 8 } },
      { refuse: refuseMost },
    );
    expect(failed.events.filter((e) => e.objectName === 'Account' && e.status === 'error')).toEqual(
      [
        expect.objectContaining({
          message: expect.stringMatching(/^16\/23 Account records failed \(>50%\)/),
        }),
      ],
    );
    expect(failed.insertCalls.some((call) => call.object === 'Contact')).toBe(false);
  });

  it('stops between two pages once cancelled, and writes no page after', async () => {
    const { schema, graph } = selfLookups();
    const stopped = runOver(schema, graph, { stream: { pageSize: 5 } }, { abortAfterInserts: 5 });
    await expect(stopped).rejects.toBeInstanceOf(ForgeAbortedError);
  });

  it('shows its gate counts before it reads a row, never the rows', async () => {
    const { schema, graph } = selfLookups();
    const boundaries: ForgeWriteBoundary[] = [];
    const orgs = fakeOrgs(schema);
    const before = vi.fn(async (boundary: ForgeWriteBoundary) => {
      boundaries.push(boundary);
      // Nothing read yet.
      expect(orgs.flow.handedOut).toBe(0);
    });
    await orgs.executor.execute(graph, 'src', 'tgt', () => {}, {
      beforeWrite: before,
      stream: { pageSize: 10 },
    });
    expect(boundaries).toEqual([
      {
        objects: [
          { objectApiName: 'Account', rows: [], counted: { rows: 23 } },
          { objectApiName: 'Contact', rows: [], counted: { rows: 40 } },
        ],
        dryRun: false,
      },
    ]);
    expect(vi.mocked(orgs.deps.countRecords!).mock.calls.map(([, soql]) => soql)).toEqual([
      'SELECT COUNT() FROM Account',
      'SELECT COUNT() FROM Contact',
    ]);
  });

  it('writes nothing once its gate refuses what the counts say', async () => {
    const { schema, graph } = selfLookups();
    const orgs = fakeOrgs(schema);
    await expect(
      orgs.executor.execute(graph, 'src', 'tgt', () => {}, {
        beforeWrite: async () => {
          throw new Error('too many records');
        },
        stream: { pageSize: 10 },
      }),
    ).rejects.toThrow('too many records');
    expect(orgs.deps.insertRecords).not.toHaveBeenCalled();
    expect(orgs.flow.handedOut).toBe(0);
  });

  it('reads a run from a record whole, writing once it has read, its reads through the cursor only when given pages', async () => {
    const { schema, graph } = selfLookups();
    const scoped: ExecuteOptions = {
      rootRecordId: sourceId('Account', 0),
      rootObjectApiName: 'Account',
    };
    const whole = await runOver(schema, graph, { ...scoped, stream: { ceiling: 50_000 } });
    const orgs = fakeOrgs(schema);
    const queryPages = vi.spyOn(orgs.deps, 'queryPages');
    await orgs.executor.execute(graph, 'src', 'tgt', () => {}, {
      ...scoped,
      stream: { pageSize: 2 },
    });

    expect(whole.summary.successCount).toBeGreaterThan(0);
    expect(orgs.written()).toEqual(whole.written());
    // Every row read before the first is written, as a run from a record does.
    expect(orgs.flow.mostAhead).toBe(orgs.flow.handedOut);
    expect(queryPages).toHaveBeenCalled();
    expect(vi.mocked(whole.deps.queryRecords).mock.calls.length).toBeGreaterThan(0);
  });
});
