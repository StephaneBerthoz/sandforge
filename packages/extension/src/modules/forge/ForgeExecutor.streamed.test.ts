import { describe, it, expect, vi } from 'vitest';
import { forgeRunCreatedRecords } from '@sandforge/shared';
import type { ForgeGraph, ForgeGraphEdge, ForgeGraphNode } from '@sandforge/shared';
import { selectRows, type FakeRow } from '../../test/fakeSoql.js';
import { canonicalRecordId } from '../../core/common/existingRecordMatch.js';
import { PersonaRegistry } from '../autopilot/SmartAnonymizer.js';
import { ForgeAnonymizer } from './ForgeAnonymizer.js';
import { ForgeAbortedError, ForgeExecutor } from './ForgeExecutor.js';
import { ForgeRunStore, memoryRunFile, type RunFile } from './ForgeRunStore.js';
import { reconcileInFlight, type InFlightTarget } from './ForgeInFlight.js';
import { partialSummaryOf } from './interruptedRun.js';
import type { RecordTypeAvailability } from '../../core/metadata/recordTypeAvailability.js';
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

const KEY_PREFIX: Record<string, string> = {
  Account: '001',
  Contact: '003',
  Contract: '800',
  Opportunity: '006',
};

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
  /** The target's record types per object, as the running user sees them. */
  recordTypes?: Record<string, RecordTypeAvailability[]>;
  /** Told as the target answers each insert call, by its number, before the answer is returned. */
  onAnswer?: (call: number) => void;
  /** Whether the target is out of reach: every insert call throws. */
  insertsFail?: () => boolean;
  /**
   * The update call, by its number, before which the process is killed: it
   * is never sent nor answered, and `onKill` is told first.
   */
  killBeforeUpdate?: number;
  onKill?: () => void;
}

/** The rows of `object` per record type, as `SELECT RecordTypeId, COUNT(Id) n … GROUP BY RecordTypeId` answers. */
function recordTypeCounts(schema: Schema, soql: string): Row[] | undefined {
  const match =
    /^SELECT RecordTypeId, COUNT\(Id\) n FROM (\w+)(?: WHERE (.+))? GROUP BY RecordTypeId$/.exec(
      soql,
    );
  if (!match) return undefined;
  const [, object, where] = match;
  const after = where ? /Id > '(\w+)'/.exec(where)?.[1] : undefined;
  const counts = new Map<string | null, number>();
  for (const row of schema[object]?.rows ?? []) {
    if (after !== undefined && String(row['Id']) <= after) continue;
    const type = typeof row['RecordTypeId'] === 'string' ? row['RecordTypeId'] : null;
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts].map(([RecordTypeId, n]) => ({ RecordTypeId, n }));
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
  let updateCalls = 0;
  const insertCalls: Array<{ object: string; rows: number }> = [];
  /** The record types counted per object, by the statement that counted them. */
  const recordTypeScans: string[] = [];
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
      const counted = recordTypeCounts(schema, soql);
      if (counted) {
        recordTypeScans.push(soql);
        return counted;
      }
      return handOut(select(soql));
    }),
    ...(options.recordTypes
      ? {
          describeObject: async (_org: string, object: string) => ({
            keyPrefix: KEY_PREFIX[object] ?? null,
            recordTypes: options.recordTypes?.[object] ?? [],
          }),
        }
      : {}),
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
      if (options.insertsFail?.()) throw new Error('The process was killed.');
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
      options.onAnswer?.(insertCalls.length);
      return results;
    }),
    updateRecords: vi.fn(async (_org: string, object: string, rows: Row[]) => {
      updateCalls++;
      if (options.killBeforeUpdate === updateCalls) {
        options.onKill?.();
        return new Promise<never>(() => {});
      }
      return rows.map((row) => {
        const id = String(row['Id']);
        const record = target.get(object)?.get(id);
        if (record) Object.assign(record, { ...row, Id: undefined });
        return { id, success: record !== undefined, errors: record ? [] : ['not found'] };
      });
    }),
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
  return { executor, deps, written, insertCalls, flow, recordTypeScans };
}

/** The ids of the records the target was sent updates of, in the order sent. */
function updatedIds(deps: ForgeExecutorDeps): string[] {
  const update = deps.updateRecords;
  if (!update) return [];
  return vi.mocked(update).mock.calls.flatMap(([, , rows]) => rows.map((row) => String(row['Id'])));
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

/**
 * Accounts naming their key contact and, most of them, a parent account;
 * contacts under their account. The accounts go first, and each owes its key
 * contact, and its parent when it comes later, to the second pass.
 */
function twoLookups(): { schema: Schema; graph: ForgeGraph } {
  const accounts = Array.from({ length: 13 }, (_, n) => ({
    Id: sourceId('Account', n),
    Name: `Account ${n}`,
    ParentId: n % 3 === 0 ? null : sourceId('Account', (n * 5 + 2) % 13),
    Key_Contact__c: sourceId('Contact', (n * 4) % 13),
  }));
  const contacts = Array.from({ length: 13 }, (_, n) => ({
    Id: sourceId('Contact', n),
    LastName: `Contact ${n}`,
    AccountId: sourceId('Account', (n * 2) % 13),
  }));
  return {
    schema: {
      Account: {
        fields: [
          text('Name'),
          lookup('ParentId', 'Account', true),
          lookup('Key_Contact__c', 'Contact', true),
        ],
        rows: accounts,
      },
      Contact: {
        fields: [text('LastName'), lookup('AccountId', 'Account', false)],
        rows: contacts,
      },
    },
    graph: graphOf(
      [node('Account', 13), node('Contact', 13)],
      [
        edge('Account', 'Contact', true),
        edge('Contact', 'Account', false),
        edge('Account', 'Account', false),
      ],
    ),
  };
}

/**
 * An account whose key contact is one of its contacts, the contacts
 * reporting to one another, opportunities under it, and another account with
 * contacts of its own: what a clone of the first account reaches is it, its
 * contacts and its opportunities.
 */
function accountFamily(): { schema: Schema; graph: ForgeGraph } {
  const accounts = Array.from({ length: 2 }, (_, n) => ({
    Id: sourceId('Account', n),
    Name: `Account ${n}`,
    Key_Contact__c: sourceId('Contact', n === 0 ? 5 : 8),
  }));
  const contacts = Array.from({ length: 10 }, (_, n) => ({
    Id: sourceId('Contact', n),
    LastName: `Contact ${n}`,
    AccountId: sourceId('Account', n < 8 ? 0 : 1),
    ReportsToId: n < 8 ? sourceId('Contact', (n + 3) % 8) : null,
  }));
  const opportunities = Array.from({ length: 3 }, (_, n) => ({
    Id: sourceId('Opportunity', n),
    Name: `Opportunity ${n}`,
    AccountId: sourceId('Account', 0),
  }));
  return {
    schema: {
      Account: {
        fields: [text('Name'), lookup('Key_Contact__c', 'Contact', true)],
        rows: accounts,
      },
      Contact: {
        fields: [
          text('LastName'),
          lookup('AccountId', 'Account', false),
          lookup('ReportsToId', 'Contact', true),
        ],
        rows: contacts,
      },
      Opportunity: {
        fields: [text('Name'), lookup('AccountId', 'Account', false)],
        rows: opportunities,
      },
    },
    graph: graphOf(
      [node('Account', 2), node('Contact', 10), node('Opportunity', 3)],
      [
        edge('Account', 'Contact', true),
        edge('Contact', 'Account', false),
        edge('Contact', 'Contact', false),
        edge('Account', 'Opportunity', true),
      ],
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

/**
 * Contracts past Draft under their accounts, more of them than one call of
 * statuses takes: their statuses go back in two calls.
 */
function manyStatuses(): { schema: Schema; graph: ForgeGraph } {
  const accounts = Array.from({ length: 4 }, (_, n) => ({
    Id: sourceId('Account', n),
    Name: `Account ${n}`,
  }));
  const contracts = Array.from({ length: 250 }, (_, n) => ({
    Id: sourceId('Contract', n),
    AccountId: sourceId('Account', n % 4),
    Status: 'Activated',
  }));
  return {
    schema: {
      Account: { fields: [text('Name')], rows: accounts },
      Contract: {
        fields: [lookup('AccountId', 'Account', false), text('Status', 'picklist')],
        rows: contracts,
      },
    },
    graph: graphOf(
      [node('Account', 4), node('Contract', 250)],
      [edge('Account', 'Contract', true)],
    ),
  };
}

/** A record type of the target, open to the user the run writes as or closed to them. */
function recordType(n: number, available: boolean): RecordTypeAvailability {
  const recordTypeId = canonicalRecordId(`012S${String(n).padStart(11, '0')}`);
  if (!recordTypeId) throw new Error('no id');
  return {
    recordTypeId,
    developerName: available ? 'Open_Type' : 'Closed_Type',
    name: available ? 'Open type' : 'Closed type',
    available,
    active: true,
    master: false,
    defaultRecordTypeMapping: available,
  };
}

/**
 * Accounts of a record type the user may use, then, in the table's last
 * page, of one closed to them; contacts under every account.
 */
function closedRecordType(): {
  schema: Schema;
  graph: ForgeGraph;
  recordTypes: Record<string, RecordTypeAvailability[]>;
} {
  const open = recordType(1, true);
  const closed = recordType(2, false);
  const accounts = Array.from({ length: 12 }, (_, n) => ({
    Id: sourceId('Account', n),
    Name: `Account ${n}`,
    RecordTypeId: n < 9 ? open.recordTypeId : closed.recordTypeId,
  }));
  const contacts = Array.from({ length: 10 }, (_, n) => ({
    Id: sourceId('Contact', n),
    LastName: `Contact ${n}`,
    AccountId: sourceId('Account', n),
  }));
  return {
    schema: {
      Account: {
        fields: [text('Name'), lookup('RecordTypeId', 'RecordType', true)],
        rows: accounts,
      },
      Contact: {
        fields: [text('LastName'), lookup('AccountId', 'Account', false)],
        rows: contacts,
      },
    },
    graph: graphOf([node('Account', 12), node('Contact', 10)], [edge('Account', 'Contact', true)]),
    recordTypes: { Account: [open, closed] },
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
    // It is said apart: the rows past it are in the source, none in the clone.
    expect(capped.summary.cappedObjects).toEqual({
      perObject: 5,
      objects: ['Account', 'Contact'],
    });
    expect(paged.summary.cappedObjects).toBeUndefined();
  });

  it('says nothing of the cap on each object when a table holds no more rows than it', async () => {
    const { schema, graph } = selfLookups();
    const whole = await runOver(schema, graph, { stream: { pageSize: 4 } });
    const rows = whole.summary.readByObject.find((o) => o.objectApiName === 'Account')?.read ?? 0;

    const atTheCap = await runOver(schema, graph, {
      maxRecordsPerObject: rows,
      stream: { pageSize: 4 },
    });

    expect(atTheCap.summary.readByObject).toContainEqual({ objectApiName: 'Account', read: rows });
    expect(atTheCap.summary.cappedObjects?.objects ?? []).not.toContain('Account');
  });

  it('tells the gate, before anything is read, the tables whose count is past the cap on each object', async () => {
    const { schema, graph } = selfLookups();
    const orgs = fakeOrgs(schema);
    const boundaries: ForgeWriteBoundary[] = [];

    await orgs.executor.execute(graph, 'src', 'tgt', () => {}, {
      maxRecordsPerObject: 5,
      beforeWrite: async (boundary) => void boundaries.push(boundary),
      stream: { pageSize: 4 },
    });

    expect(boundaries[0]?.capped).toEqual({ perObject: 5, objects: ['Account', 'Contact'] });
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

  describe('a run that keeps its journal, stopped part way and resumed from it', () => {
    /** The records a summary says the run created, as removals take them: object → target ids. */
    function removalOf(summary: ExecutionSummary): Map<string, string[]> {
      const plan = forgeRunCreatedRecords({
        idRemapTable: summary.remapTable,
        idRemapExisting: [...summary.existingSourceIds, ...summary.updatedSourceIds],
        idRemapCreated: summary.createdByObject,
      });
      return new Map(plan.map(({ objectApiName, ids }) => [objectApiName, [...ids].sort()]));
    }

    /** Two removal plans as one, each object's ids together. */
    function together(...plans: Array<Map<string, string[]>>): Map<string, string[]> {
      const all = new Map<string, string[]>();
      for (const plan of plans) {
        for (const [object, ids] of plan)
          all.set(object, [...(all.get(object) ?? []), ...ids].sort());
      }
      return all;
    }

    /**
     * The run stopped once the target has taken `stopAfter` rows, then the
     * same run resumed over the same orgs from the journal the first part
     * left; `cutJournal` changes that journal first, as a closed window would.
     */
    async function stopAndResume(
      schema: Schema,
      graph: ForgeGraph,
      pageSize: number,
      stopAfter: number,
      cutJournal: (text: string) => string = (text) => text,
    ) {
      const orgOptions: FakeOrgOptions = { abortAfterInserts: stopAfter };
      const orgs = fakeOrgs(schema, orgOptions);
      const firstFile = memoryRunFile();
      const firstStore = ForgeRunStore.open(firstFile);
      const stopped = await orgs.executor
        .execute(graph, 'src', 'tgt', () => {}, { stream: { pageSize, store: firstStore } })
        .then(
          () => undefined,
          (err: unknown) => err,
        );
      firstStore.close();
      const first = partialSummaryOf(stopped);
      const insertsBefore = orgs.insertCalls.reduce((sum, call) => sum + call.rows, 0);
      // The second part: nothing stops it.
      orgOptions.abortAfterInserts = undefined;
      const read = vi.spyOn(orgs.deps, 'queryPages');
      const store = ForgeRunStore.open(memoryRunFile(cutJournal(firstFile.text())));
      const second = await orgs.executor.execute(graph, 'src', 'tgt', () => {}, {
        stream: { pageSize, store },
      });
      store.close();
      const secondReads = read.mock.calls.map(([, soql]) => soql);
      return { orgs, stopped, first, second, insertsBefore, secondReads };
    }

    describe.each([
      ['self-lookups', selfLookups, [1, 9, 30]],
      ['a cycle', cycle, [1, 8, 17]],
      ['statuses given back', statuses, [2, 9]],
    ] as const)('over %s', (_name, build, stops) => {
      it.each(
        [2, 3, 7].flatMap((pageSize) => stops.map((stopAfter) => [pageSize, stopAfter] as const)),
      )(
        'writes, links and leaves to remove in its two parts what one run does, in pages of %i stopped after %i rows',
        async (pageSize, stopAfter) => {
          const { schema, graph } = build();
          const whole = await runOver(schema, graph);
          const { orgs, stopped, first, second, insertsBefore } = await stopAndResume(
            schema,
            graph,
            pageSize,
            stopAfter,
          );

          expect(stopped).toBeInstanceOf(ForgeAbortedError);
          expect(first).toBeDefined();
          // The target holds what one run leaves: every row once, every lookup
          // the second pass fills in, every status given back.
          expect(orgs.written()).toEqual(whole.written());
          // No row written twice.
          const inserted = orgs.insertCalls.reduce((sum, call) => sum + call.rows, 0);
          expect(inserted).toBe(whole.summary.successCount);
          expect(insertsBefore).toBeGreaterThanOrEqual(stopAfter);
          expect((first?.successCount ?? 0) + second.successCount).toBe(whole.summary.successCount);
          expect(second.failedCount).toBe(0);
          // The remap of the second part holds the first's: the run's whole.
          expect(second.remapTable).toEqual(whole.summary.remapTable);
          // What each part created, removed together, is what one run created.
          const firstPlan = first ? removalOf(first) : new Map<string, string[]>();
          expect(together(firstPlan, removalOf(second))).toEqual(removalOf(whole.summary));
          for (const [object, ids] of firstPlan) {
            const again = removalOf(second).get(object) ?? [];
            expect(ids.filter((id) => again.includes(id))).toEqual([]);
          }
        },
      );
    });

    it('writes no row twice when the window closed after a page went in and before its checkpoint', async () => {
      const { schema, graph } = selfLookups();
      const whole = await runOver(schema, graph);
      // The last checkpoint of the first part never reached the journal.
      const withoutLastCheckpoint = (text: string): string => {
        const lines = text.split('\n');
        const last = lines.map((line) => line.startsWith('{"at"')).lastIndexOf(true);
        return lines.filter((_, index) => index !== last).join('\n');
      };
      const { orgs, first, second } = await stopAndResume(
        schema,
        graph,
        5,
        10,
        withoutLastCheckpoint,
      );

      expect(orgs.written()).toEqual(whole.written());
      expect(orgs.insertCalls.reduce((sum, call) => sum + call.rows, 0)).toBe(
        whole.summary.successCount,
      );
      // The page read again links to what the first part wrote of it.
      expect(second.linkedCount).toBe(5);
      expect((first?.successCount ?? 0) + second.successCount).toBe(whole.summary.successCount);
    });

    it.each([
      [1, 'Account', selfLookups],
      [3, 'Account', selfLookups],
      [6, 'Contact', selfLookups],
      [2, 'Contract', statuses],
    ] as const)(
      'keeps what call %i created, the lookups and the statuses its records owe, on disk before the run goes on: a process killed right after the answer leaves them to link to and give',
      async (killedAfter, object, build) => {
        const { schema, graph } = build();
        const whole = await runOver(schema, graph);
        /*
         * The journal of a process killed at the first turn after the target
         * answered the call — a page of five rows: the kill is queued as the
         * store first touches the file once the answer is in, and nothing
         * written after it reaches the disk. An account of the first page
         * names another of the same page as its parent: the lookup went in
         * empty, owed with the record.
         */
        const disk = memoryRunFile();
        let armed = false;
        let killed = false;
        const killable = {
          size: () => {
            if (armed) {
              armed = false;
              queueMicrotask(() => {
                killed = true;
              });
            }
            return disk.size();
          },
          append: (text: string) => {
            if (!killed) disk.append(text);
          },
          read: (offset: number, length: number) => disk.read(offset, length),
          close: () => {},
        };
        const orgOptions: FakeOrgOptions = {
          onAnswer: (call) => {
            if (call === killedAfter) armed = true;
          },
          insertsFail: () => killed,
        };
        const orgs = fakeOrgs(schema, orgOptions);
        await orgs.executor
          .execute(graph, 'src', 'tgt', () => {}, {
            stream: { pageSize: 5, store: ForgeRunStore.open(killable) },
          })
          .catch(() => undefined);
        expect(killed).toBe(true);
        // Its five rows went in before the kill.
        expect(orgs.insertCalls[killedAfter - 1]).toEqual({ object, rows: 5 });

        // Taken up from what the disk holds: the page the kill cut short is
        // read again, and its five contacts linked to, never sent again.
        orgOptions.insertsFail = undefined;
        orgOptions.onAnswer = undefined;
        const store = ForgeRunStore.open(memoryRunFile(disk.text()));
        const resumed = await orgs.executor.execute(graph, 'src', 'tgt', () => {}, {
          stream: { pageSize: 5, store },
        });
        store.close();
        expect(orgs.written()).toEqual(whole.written());
        expect(orgs.insertCalls.reduce((sum, call) => sum + call.rows, 0)).toBe(
          whole.summary.successCount,
        );
        expect(resumed.linkedCount).toBe(5);
      },
    );

    describe('killed while an insert call was under way: the org committed it, its answer never reached the journal', () => {
      /**
       * The run killed as the target answers call `killedDuring`: what the
       * call sent is in the target, and nothing the run writes after the
       * call went — its answer, its records — reaches the disk.
       */
      async function killedDuringACall(killedDuring: number, build = selfLookups) {
        const { schema, graph } = build();
        const whole = await runOver(schema, graph);
        const disk = memoryRunFile();
        let killed = false;
        const killable: RunFile = {
          size: () => disk.size(),
          append: (text: string) => {
            if (!killed) disk.append(text);
          },
          read: (offset: number, length: number) => disk.read(offset, length),
          close: () => {},
        };
        const orgOptions: FakeOrgOptions = {
          onAnswer: (call) => {
            if (call === killedDuring) killed = true;
          },
          insertsFail: () => killed,
        };
        const orgs = fakeOrgs(schema, orgOptions);
        await orgs.executor
          .execute(graph, 'src', 'tgt', () => {}, {
            stream: { pageSize: 5, store: ForgeRunStore.open(killable) },
          })
          .catch(() => undefined);
        expect(killed).toBe(true);
        orgOptions.insertsFail = undefined;
        orgOptions.onAnswer = undefined;
        return { schema, graph, whole, orgs, disk };
      }

      /** The target the fake orgs wrote to, as a reconciliation reads it: every record the run's user's. */
      function readBack(orgs: ReturnType<typeof fakeOrgs>): InFlightTarget {
        return {
          queryPages: (soql: string) =>
            (async function* page() {
              const [, fields, object] = /^SELECT (.+?) FROM (\w+) /.exec(soql) ?? [];
              const names = (fields ?? '').split(', ');
              const table = orgs.written()[object ?? ''] ?? {};
              yield Object.entries(table).map(([id, row]) =>
                Object.fromEntries(
                  names.map((name) => [name, name === 'Id' ? id : (row[name] ?? null)]),
                ),
              );
            })(),
          userId: async () => 'user',
        };
      }

      it.each([
        [1, 'self-lookups', selfLookups],
        [3, 'self-lookups', selfLookups],
        [6, 'self-lookups', selfLookups],
        [1, 'a cycle', cycle],
        [2, 'a cycle', cycle],
        [2, 'statuses given back', statuses],
      ] as const)(
        'finds what call %i wrote over %s in the target before the run is taken up, and writes no row twice',
        async (killedDuring, _name, build) => {
          const { graph, whole, orgs, disk } = await killedDuringACall(killedDuring, build);
          // The call's line is on disk, its answer is not.
          const sent = disk
            .text()
            .split('\n')
            .filter((line) => line.startsWith('["x"'));
          expect(sent).toHaveLength(killedDuring);

          const file = memoryRunFile(disk.text());
          const reconciled = await reconcileInFlight(file, readBack(orgs));
          expect(reconciled.calls).toBe(1);
          expect(reconciled.found.reduce((sum, { rows }) => sum + rows, 0)).toBe(5);
          expect(reconciled.uncertain).toEqual([]);

          const store = ForgeRunStore.open(file);
          const resumed = await orgs.executor.execute(graph, 'src', 'tgt', () => {}, {
            stream: { pageSize: 5, store },
          });
          store.close();
          // The target holds what one run leaves: every row once.
          expect(orgs.written()).toEqual(whole.written());
          expect(orgs.insertCalls.reduce((sum, call) => sum + call.rows, 0)).toBe(
            whole.summary.successCount,
          );
          expect(resumed.linkedCount).toBe(5);
        },
      );

      it.each([
        [6, 'contacts, whose account each went in with'],
        [2, 'accounts, some of which went in without the parent they name'],
        [1, 'accounts, the first of the run'],
      ] as const)(
        'fills in on the rows of call %i (%s) found in the target only the lookups they went in without, as the whole run did',
        async (killedDuring, _rows) => {
          const { graph, whole, orgs, disk } = await killedDuringACall(killedDuring);
          const file = memoryRunFile(disk.text());
          await reconcileInFlight(file, readBack(orgs));
          // The rows found, by their source id and the record the target holds.
          const found = file
            .text()
            .split('\n')
            .filter((line) => line.startsWith('["c"') && line.includes('"found'))
            .map((line) => JSON.parse(line) as string[]);
          expect(found).toHaveLength(5);
          const updatesBefore = updatedIds(orgs.deps).length;

          const store = ForgeRunStore.open(file);
          await orgs.executor.execute(graph, 'src', 'tgt', () => {}, {
            stream: { pageSize: 5, store },
          });
          store.close();

          // What the resume sent to each row found, against what the whole
          // run sent to the same row: an update only for a lookup the row's
          // insert left out, never one for each lookup it names.
          const resumed = new Set(updatedIds(orgs.deps).slice(updatesBefore));
          const wholeUpdated = new Set(updatedIds(whole.deps));
          for (const [, sourceRow, targetRow] of found) {
            const updatedByWhole = wholeUpdated.has(whole.summary.remapTable[sourceRow] ?? '');
            expect(resumed.has(targetRow)).toBe(updatedByWhole);
          }
          expect(orgs.written()).toEqual(whole.written());
        },
      );

      it('writes the call again when nothing looks for it first: what the journal alone leaves', async () => {
        const { graph, whole, orgs, disk } = await killedDuringACall(3);
        const store = ForgeRunStore.open(memoryRunFile(disk.text()));
        await orgs.executor.execute(graph, 'src', 'tgt', () => {}, {
          stream: { pageSize: 5, store },
        });
        store.close();
        expect(orgs.insertCalls.reduce((sum, call) => sum + call.rows, 0)).toBe(
          whole.summary.successCount + 5,
        );
      });
    });

    it('says the rows it links to were written before the run stopped, not by a run it retried', async () => {
      const { schema, graph } = selfLookups();
      const withoutLastCheckpoint = (text: string): string => {
        const lines = text.split('\n');
        const last = lines.map((line) => line.startsWith('{"at"')).lastIndexOf(true);
        return lines.filter((_, index) => index !== last).join('\n');
      };
      const orgOptions: FakeOrgOptions = { abortAfterInserts: 10 };
      const orgs = fakeOrgs(schema, orgOptions);
      const firstFile = memoryRunFile();
      const firstStore = ForgeRunStore.open(firstFile);
      await orgs.executor
        .execute(graph, 'src', 'tgt', () => {}, { stream: { pageSize: 5, store: firstStore } })
        .catch(() => undefined);
      firstStore.close();
      orgOptions.abortAfterInserts = undefined;
      const events: ForgeProgressEvent[] = [];
      const store = ForgeRunStore.open(memoryRunFile(withoutLastCheckpoint(firstFile.text())));
      await orgs.executor.execute(graph, 'src', 'tgt', (event) => events.push(event), {
        stream: { pageSize: 5, store },
      });
      store.close();
      const accounts = events.find((e) => e.objectName === 'Account' && e.status === 'done');
      expect(accounts?.message).toContain(
        '5 already in the target, written before the run stopped',
      );
      expect(events.some((e) => e.message.includes('from the run retried'))).toBe(false);
    });

    it('reads each object after the checkpoint the first part left, and nothing of an object it read to its end', async () => {
      const { schema, graph } = selfLookups();
      // Stopped in the accounts: they are read again after the last one written.
      const inAccounts = await stopAndResume(schema, graph, 10, 10);
      expect(inAccounts.secondReads).toEqual([
        `SELECT Id, Name, ParentId FROM Account WHERE Id > '${sourceId('Account', 9)}' ORDER BY Id`,
        'SELECT Id, LastName, AccountId FROM Contact ORDER BY Id',
      ]);
      // Stopped in the contacts: the accounts, read to their end, are not read again.
      const inContacts = await stopAndResume(schema, graph, 10, 30);
      expect(inContacts.secondReads).toEqual([
        `SELECT Id, LastName, AccountId FROM Contact WHERE Id > '${sourceId('Contact', 9)}' ORDER BY Id`,
      ]);
    });

    it('fills in the lookups and gives back the statuses the first part owed, at the end of the second', async () => {
      const { schema, graph } = statuses();
      const { second } = await stopAndResume(schema, graph, 3, 6);
      expect(second.errors).toEqual([]);
    });

    it('writes, links and leaves to remove what a run that holds them in memory does, in one go', async () => {
      for (const build of [selfLookups, cycle, statuses]) {
        const { schema, graph } = build();
        const whole = await runOver(schema, graph);
        const store = ForgeRunStore.open(memoryRunFile());
        const paged = await runOver(schema, graph, { stream: { pageSize: 3, store } });
        expect(paged.written()).toEqual(whole.written());
        expect(outcomeOf(paged.summary)).toEqual(outcomeOf(whole.summary));
        expect(paged.summary.errors).toEqual(whole.summary.errors);
      }
    });

    it('sends one update per record in a second pass that reads what is owed two lookups at a time', async () => {
      const { schema, graph } = twoLookups();
      const whole = await runOver(schema, graph);
      const store = ForgeRunStore.open(memoryRunFile());
      const paged = await runOver(schema, graph, {
        stream: { pageSize: 5, store, secondPassPageSize: 2 },
      });
      expect(paged.written()).toEqual(whole.written());
      expect(paged.summary.errors).toEqual([]);
      const updated = updatedIds(paged.deps);
      // Every account owes its key contact, and most their parent: one update each.
      expect(updated).toHaveLength(13);
      expect(new Set(updated).size).toBe(13);
    });

    it('says two values of one lookup owed in two pages of the second pass, wherever they were owed', async () => {
      const { schema, graph } = twoLookups();
      // The window closed after the first page of accounts went in, before its
      // checkpoint: the resume reads the page again.
      const withoutLastCheckpoint = (text: string): string => {
        const lines = text.split('\n');
        const last = lines.map((line) => line.startsWith('{"at"')).lastIndexOf(true);
        return lines.filter((_, index) => index !== last).join('\n');
      };
      const orgOptions: FakeOrgOptions = { abortAfterInserts: 5 };
      const orgs = fakeOrgs(schema, orgOptions);
      const firstFile = memoryRunFile();
      const firstStore = ForgeRunStore.open(firstFile);
      await orgs.executor
        .execute(graph, 'src', 'tgt', () => {}, {
          stream: { pageSize: 5, store: firstStore, secondPassPageSize: 2 },
        })
        .catch(() => undefined);
      firstStore.close();
      // Meanwhile the first account was given another key contact in the source:
      // the first part owed the one it read, the second owes the one it reads now.
      const first = schema['Account']?.rows[0];
      if (!first) throw new Error('no account');
      first['Key_Contact__c'] = sourceId('Contact', 7);
      orgOptions.abortAfterInserts = undefined;
      const store = ForgeRunStore.open(memoryRunFile(withoutLastCheckpoint(firstFile.text())));
      const second = await orgs.executor.execute(graph, 'src', 'tgt', () => {}, {
        stream: { pageSize: 5, store, secondPassPageSize: 2 },
      });
      store.close();
      const pass2 = second.errors.find((error) => error.objectApiName === '__pass2__');
      expect(pass2?.failedCount).toBe(1);
      expect(pass2?.samples.map((sample) => sample.messages[0])).toEqual([
        expect.stringMatching(
          /^Conflicting cycle FK update for Key_Contact__c: 003T\w+ vs 003T\w+$/,
        ),
      ]);
    });

    /**
     * A journal file on disk that takes nothing more once the process is
     * killed (`kill`): what the disk holds then is `disk.text()`.
     */
    function killableFile(): {
      file: RunFile;
      disk: ReturnType<typeof memoryRunFile>;
      kill: () => void;
      killed: () => boolean;
    } {
      const disk = memoryRunFile();
      let dead = false;
      return {
        file: {
          size: () => disk.size(),
          append: (text: string) => {
            if (!dead) disk.append(text);
          },
          read: (offset: number, length: number) => disk.read(offset, length),
          close: () => {},
        },
        disk,
        kill: () => {
          dead = true;
        },
        killed: () => dead,
      };
    }

    /**
     * Run `build`'s clone in pages of 5 until the process is killed before the
     * update call `killBefore` — the calls before it answered — then take it up
     * from what the disk holds. What each update call sent, the killed one
     * left out: it never left the machine.
     */
    async function killedInUpdatesAndResumed(
      build: () => { schema: Schema; graph: ForgeGraph },
      killBefore: number,
      secondPassPageSize?: number,
    ) {
      const { schema, graph } = build();
      const whole = await runOver(schema, graph);
      const journal = killableFile();
      const orgOptions: FakeOrgOptions = { killBeforeUpdate: killBefore, onKill: journal.kill };
      const orgs = fakeOrgs(schema, orgOptions);
      void orgs.executor.execute(graph, 'src', 'tgt', () => {}, {
        stream: { pageSize: 5, store: ForgeRunStore.open(journal.file), secondPassPageSize },
      });
      await vi.waitUntil(() => journal.killed());
      orgOptions.killBeforeUpdate = undefined;
      const store = ForgeRunStore.open(memoryRunFile(journal.disk.text()));
      const resumed = await new ForgeExecutor(orgs.deps).execute(graph, 'src', 'tgt', () => {}, {
        stream: { pageSize: 5, store, secondPassPageSize },
      });
      store.close();
      const update = orgs.deps.updateRecords;
      const sent = update
        ? vi
            .mocked(update)
            .mock.calls.filter((_, call) => call !== killBefore - 1)
            .map(([, object, rows]) => ({ object, rows }))
        : [];
      return { whole, orgs, resumed, sent };
    }

    it.each([2, 4, 6])(
      'sends each record its lookups once when the process is killed in the second pass before update call %i, and the run is taken up',
      async (killBefore) => {
        const { whole, orgs, resumed, sent } = await killedInUpdatesAndResumed(
          twoLookups,
          killBefore,
          2,
        );
        expect(orgs.written()).toEqual(whole.written());
        expect(resumed.errors).toEqual([]);
        const updated = sent.flatMap(({ rows }) => rows.map((row) => String(row['Id'])));
        // One update per account in all, whichever part sent it.
        expect(updated).toHaveLength(13);
        expect(new Set(updated).size).toBe(13);
      },
    );

    it('gives each status back once when the process is killed between two calls of statuses, and the run is taken up', async () => {
      const { whole, orgs, resumed, sent } = await killedInUpdatesAndResumed(manyStatuses, 2);
      expect(orgs.written()).toEqual(whole.written());
      expect(resumed.errors).toEqual([]);
      const given = sent
        .filter(({ object }) => object === 'Contract')
        .flatMap(({ rows }) => rows.map((row) => String(row['Id'])));
      // 200 in the call before the kill, the 50 others once taken up.
      expect(given).toHaveLength(250);
      expect(new Set(given).size).toBe(250);
      expect(sent.map(({ rows }) => rows.length)).toEqual([200, 50]);
    });

    it('counts the records past its bound and leaves their ids in the journal', async () => {
      const { schema, graph } = selfLookups();
      const store = ForgeRunStore.open(memoryRunFile());
      const paged = await runOver(schema, graph, {
        stream: { pageSize: 5, store, summaryBound: 10 },
      });
      expect(paged.summary.remapInJournal).toBe(true);
      expect(paged.summary.remapTable).toEqual({});
      expect(paged.summary.createdByObject).toEqual([]);
      expect(paged.summary.remapCount).toBe(63);
      expect(paged.summary.remapByObject).toEqual([
        { objectApiName: 'Account', created: 23, linked: 0 },
        { objectApiName: 'Contact', created: 40, linked: 0 },
      ]);
      expect(paged.summary.successCount).toBe(63);
    });
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

  describe('the gate of a run that links to what an earlier run wrote, or holds an object back', () => {
    it('takes the rows the run it retries wrote off the counts, and says so', async () => {
      const { schema, graph } = selfLookups();
      const first = await runOver(schema, graph, { stream: { pageSize: 10 } });
      // The run retried wrote seven accounts and three contacts.
      const writtenBefore = Object.fromEntries(
        [
          ...Array.from({ length: 7 }, (_, n) => sourceId('Account', n)),
          ...Array.from({ length: 3 }, (_, n) => sourceId('Contact', n)),
        ].map((id) => [id, first.summary.remapTable[id]]),
      );
      const orgs = fakeOrgs(schema);
      orgs.deps.describeObject = async (_org, object) => ({
        keyPrefix: KEY_PREFIX[object] ?? null,
        recordTypes: [],
      });
      const boundaries: ForgeWriteBoundary[] = [];
      await orgs.executor.execute(graph, 'src', 'tgt', () => {}, {
        writtenBefore,
        beforeWrite: async (boundary) => void boundaries.push(boundary),
        stream: { pageSize: 10 },
      });
      expect(boundaries[0]?.objects).toEqual([
        {
          objectApiName: 'Account',
          rows: [],
          counted: { rows: 16 },
          leftOut: { writtenBefore: 7 },
        },
        {
          objectApiName: 'Contact',
          rows: [],
          counted: { rows: 37 },
          leftOut: { writtenBefore: 3 },
        },
      ]);
    });

    it('counts what the run it retries wrote of an object read through a filter through that filter, leaving out the parents it read by id outside it', async () => {
      const { schema, graph } = selfLookups();
      const accounts = schema['Account'];
      if (!accounts) throw new Error('no accounts');
      accounts.fields.push(text('Type'));
      accounts.rows.forEach((row, n) => {
        row['Type'] = n < 12 ? 'Customer' : 'Partner';
      });
      // The run retried wrote five customers, and two partners its customers
      // named as their parent, read by id outside the filter.
      const writtenBefore = Object.fromEntries(
        [0, 1, 2, 3, 4, 15, 20].map((n) => [
          sourceId('Account', n),
          canonicalRecordId(`001T${String(n).padStart(11, '0')}`) ?? '',
        ]),
      );
      const orgs = fakeOrgs(schema);
      orgs.deps.describeObject = async (_org, object) => ({
        keyPrefix: KEY_PREFIX[object] ?? null,
        recordTypes: [],
      });
      // The source counts through what the statement asks.
      orgs.deps.countRecords = async (_org, soql) => {
        const [, object, where] = /^SELECT COUNT\(\) FROM (\w+)(?: WHERE (.+))?$/.exec(soql) ?? [];
        if (!object) throw new Error(`not a count: ${soql}`);
        if (!where) return schema[object]?.rows.length ?? 0;
        return selectRows(tablesOf(schema), `SELECT Id FROM ${object} WHERE ${where}`).length;
      };
      const boundaries: ForgeWriteBoundary[] = [];
      await orgs.executor
        .execute(graph, 'src', 'tgt', () => {}, {
          writtenBefore,
          objectSoqlFilters: { Account: "Type = 'Customer'" },
          beforeWrite: async (boundary) => {
            boundaries.push(boundary);
            throw new Error('Stopped at the gate.');
          },
          stream: { pageSize: 10 },
        })
        .catch(() => undefined);
      expect(boundaries[0]?.objects[0]).toEqual({
        objectApiName: 'Account',
        rows: [],
        counted: { rows: 7 },
        leftOut: { writtenBefore: 5 },
      });
    });

    it('counts nothing to write of an object held back whole for a record type, and says how many it holds back', async () => {
      const { schema, graph, recordTypes } = closedRecordType();
      const boundaries: ForgeWriteBoundary[] = [];
      await runOver(
        schema,
        graph,
        {
          beforeWrite: async (boundary) => void boundaries.push(boundary),
          stream: { pageSize: 4 },
        },
        { recordTypes },
      );
      expect(boundaries[0]?.objects[0]).toEqual({
        objectApiName: 'Account',
        rows: [],
        counted: { rows: 0 },
        leftOut: { heldBack: 12 },
      });
    });

    it('leaves out of a run read whole the rows the run it retries wrote and an object its write holds back', async () => {
      const { schema, graph, recordTypes } = closedRecordType();
      const writtenBefore = {
        [sourceId('Contact', 0)]: canonicalRecordId('003T00000000099') ?? '',
      };
      const boundaries: ForgeWriteBoundary[] = [];
      // Read whole, every row is in hand at the gate.
      await runOver(
        schema,
        graph,
        { writtenBefore, beforeWrite: async (boundary) => void boundaries.push(boundary) },
        { recordTypes },
      );
      const byObject = Object.fromEntries(
        (boundaries[0]?.objects ?? []).map((object) => [object.objectApiName, object]),
      );
      expect(byObject['Account']?.rows).toEqual([]);
      expect(byObject['Account']?.leftOut).toEqual({ heldBack: 12 });
      expect(byObject['Contact']?.rows).toHaveLength(9);
      expect(byObject['Contact']?.leftOut).toEqual({ writtenBefore: 1 });
    });
  });

  describe('a record type closed to the user the run writes as', () => {
    it.each(PAGE_SIZES)(
      'holds the object back whole before its first page, as a run read whole does, in pages of %i',
      async (pageSize) => {
        const { schema, graph, recordTypes } = closedRecordType();
        const whole = await runOver(schema, graph, {}, { recordTypes });
        const paged = await runOver(schema, graph, { stream: { pageSize } }, { recordTypes });

        expect(whole.written()).toEqual({});
        expect(paged.written()).toEqual(whole.written());
        expect(paged.insertCalls).toEqual([]);
        expect(paged.summary.failedCount).toBe(whole.summary.failedCount);
        expect(paged.summary.errors).toEqual(whole.summary.errors);
        expect(
          paged.events.filter((e) => e.objectName === 'Account' && e.status === 'error'),
        ).toEqual(whole.events.filter((e) => e.objectName === 'Account' && e.status === 'error'));
        // Judged from the record types the table holds, counted before a row of it is read.
        expect(paged.recordTypeScans).toEqual([
          'SELECT RecordTypeId, COUNT(Id) n FROM Account GROUP BY RecordTypeId',
        ]);
        expect(paged.summary.readByObject).not.toContainEqual(
          expect.objectContaining({ objectApiName: 'Account' }),
        );
      },
    );

    it('writes every page of an object whose record types are all open, counting them once', async () => {
      const { schema, graph, recordTypes } = closedRecordType();
      const openOnly = {
        Account: recordTypes.Account.map((type) => ({ ...type, available: true })),
      };
      const whole = await runOver(schema, graph, {}, { recordTypes: openOnly });
      const paged = await runOver(
        schema,
        graph,
        { stream: { pageSize: 4 } },
        { recordTypes: openOnly },
      );
      expect(paged.written()).toEqual(whole.written());
      expect(paged.summary.successCount).toBe(22);
      expect(paged.recordTypeScans).toEqual([]);
    });

    it('counts the record types under the run filter and after the checkpoint of the run it resumes', async () => {
      const { schema, graph, recordTypes } = closedRecordType();
      const paged = await runOver(
        schema,
        graph,
        {
          objectSoqlFilters: { Account: "Name != 'none'" },
          stream: {
            pageSize: 4,
            resumeAfter: { Account: { lastId: sourceId('Account', 3), read: 4 } },
          },
        },
        { recordTypes },
      );
      expect(paged.recordTypeScans).toEqual([
        `SELECT RecordTypeId, COUNT(Id) n FROM Account WHERE (Name != 'none') AND Id > '${sourceId('Account', 3)}' GROUP BY RecordTypeId`,
      ]);
      expect(paged.insertCalls.filter((call) => call.object === 'Account')).toEqual([]);
    });
  });

  it.each([1, 9, 10])(
    'takes a run from a record that kept its journal up where it stopped: its scope read again, what it wrote linked to, nothing written twice, stopped after %i rows',
    async (stopAfter) => {
      const { schema, graph } = accountFamily();
      const scoped: ExecuteOptions = {
        rootRecordId: sourceId('Account', 0),
        rootObjectApiName: 'Account',
      };
      const whole = await runOver(schema, graph, scoped);
      const orgOptions: FakeOrgOptions = { abortAfterInserts: stopAfter };
      const orgs = fakeOrgs(schema, orgOptions);
      const firstFile = memoryRunFile();
      const firstStore = ForgeRunStore.open(firstFile);
      await orgs.executor
        .execute(graph, 'src', 'tgt', () => {}, {
          ...scoped,
          stream: { store: firstStore },
        })
        .catch(() => undefined);
      firstStore.close();
      orgOptions.abortAfterInserts = undefined;
      const store = ForgeRunStore.open(memoryRunFile(firstFile.text()));
      const second = await orgs.executor.execute(graph, 'src', 'tgt', () => {}, {
        ...scoped,
        stream: { store },
      });
      store.close();
      expect(whole.summary.successCount).toBeGreaterThanOrEqual(stopAfter);
      expect(orgs.written()).toEqual(whole.written());
      expect(orgs.insertCalls.reduce((sum, call) => sum + call.rows, 0)).toBe(
        whole.summary.successCount,
      );
      expect(second.failedCount).toBe(0);
      // A lookup the first part filled in is not sent again.
      const updates = updatedIds(orgs.deps);
      expect(updates).toHaveLength(new Set(updates).size);
    },
  );

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

describe('a run of whole tables, with owners the target may not have', () => {
  const OWNER = '005000000000001AAA';
  const OTHER = '005000000000002AAA';
  const MAPPED = '005000000000003AAA';
  const TARGET_USER = '005000000000009AAA';
  const schema: Schema = {
    Contact: {
      fields: [text('LastName'), lookup('OwnerId', 'User', true)],
      rows: [
        { Id: sourceId('Contact', 1), LastName: 'One', OwnerId: OWNER },
        { Id: sourceId('Contact', 2), LastName: 'Two', OwnerId: OTHER },
        { Id: sourceId('Contact', 3), LastName: 'Three', OwnerId: MAPPED },
      ],
    },
  };
  const graph = graphOf([node('Contact', 3)], []);

  /** Run the contacts over a target whose users are `held`, or that refuses to say. */
  async function runWith(held: string[] | 'refused', options: ExecuteOptions = {}) {
    const orgs = fakeOrgs(schema);
    const read = orgs.deps.queryRecords;
    const asked: string[] = [];
    orgs.deps.queryRecords = vi.fn(async (org: string, soql: string, onTruncated?: () => void) => {
      if (org === 'tgt' && / FROM User /.test(soql)) {
        asked.push(soql);
        if (held === 'refused') throw new Error('INSUFFICIENT_ACCESS');
        return held.filter((id) => soql.includes(id)).map((Id) => ({ Id }));
      }
      return read(org, soql, onTruncated);
    });
    const events: ForgeProgressEvent[] = [];
    const summary = await orgs.executor.execute(graph, 'src', 'tgt', (e) => events.push(e), {
      stream: {},
      ...options,
    });
    const owners = Object.values(orgs.written()['Contact'] ?? {}).map((row) => row['OwnerId']);
    return { summary, events, owners, asked };
  }

  it('writes without its owner a row whose owner the target holds no user of, and says so', async () => {
    // Two scratch orgs share no user: every contact of a run of whole tables
    // was refused on its owner with INVALID_CROSS_REFERENCE_KEY.
    const { summary, events, owners, asked } = await runWith([OWNER]);

    expect(summary.successCount).toBe(3);
    expect(owners.filter((owner) => owner !== undefined)).toEqual([OWNER]);
    expect(asked).toHaveLength(1);
    expect(events.find((e) => e.status === 'done')?.message).toContain(
      'written without a lookup naming a record the target does not hold, which the platform fills (the owner with the user the run writes as): OwnerId on 2',
    );
  });

  it("puts a mapped owner's user of the target in place, without asking about the source's", async () => {
    const { owners, asked } = await runWith([], { ownerMappings: { [MAPPED]: TARGET_USER } });

    expect(owners.filter((owner) => owner !== undefined)).toEqual([TARGET_USER]);
    expect(asked.join(' ')).not.toContain(MAPPED);
  });

  it('carries the owners as read when the target will not say which users it holds', async () => {
    const { owners } = await runWith('refused');

    expect(owners.sort()).toEqual([MAPPED, OTHER, OWNER].sort());
  });

  it('asks nothing of a run that nullifies: it never carries an owner', async () => {
    const { owners, asked } = await runWith([], { referenceFallback: 'nullify' });

    expect(asked).toEqual([]);
    expect(owners).toEqual([undefined, undefined, undefined]);
  });
});
