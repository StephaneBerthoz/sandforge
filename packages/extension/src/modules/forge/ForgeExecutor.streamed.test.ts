import { describe, it, expect, vi } from 'vitest';
import { forgeGapId, forgeRunCreatedRecords } from '@sandforge/shared';
import type { ForgeGraph, ForgeGraphEdge, ForgeGraphNode } from '@sandforge/shared';
import { selectRows, type FakeRow } from '../../test/fakeSoql.js';
import { parseSoql, selectFrom } from '../../test/memorySoql.js';
import { canonicalRecordId } from '../../core/common/existingRecordMatch.js';
import { PersonaRegistry } from '../autopilot/SmartAnonymizer.js';
import { ForgeAnonymizer } from './ForgeAnonymizer.js';
import { ForgeAbortedError, ForgeExecutor } from './ForgeExecutor.js';
import { ForgeRunStore, memoryRunFile, type RunFile } from './ForgeRunStore.js';
import { reconcileInFlight, type InFlightTarget } from './ForgeInFlight.js';
import { partialSummaryOf } from './interruptedRun.js';
import { finishedRunStatus } from './runResult.js';
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
  Event: '00U',
  EventRelation: '0RE',
  Opportunity: '006',
  Invoice__c: 'a0I',
  Policy__c: 'a0P',
  Region__c: 'a0R',
  Case: '500',
  Task: '00T',
  EmailMessage: '02s',
  Quote: '0Q0',
  vlocity_cmt__Party__c: 'a0V',
  ContentDocument: '069',
  ContentVersion: '068',
  ContentDocumentLink: '06A',
  Attachment: '00P',
  User: '005',
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
  /**
   * Whether the target takes upserts: a row whose external id matches a
   * record it holds writes over that record, any other creates one.
   */
  upserts?: boolean;
  /** Records the target holds before the run, by object. */
  targetHolds?: Record<string, Row[]>;
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
  for (const [object, rows] of Object.entries(options.targetHolds ?? {})) {
    target.set(object, new Map(rows.map((row) => [String(row['Id']), { ...row }])));
  }
  const created: Record<string, number> = {};
  let inserted = 0;
  let updateCalls = 0;
  const insertCalls: Array<{ object: string; rows: number }> = [];
  const upsertCalls: Array<{ object: string; field: string; rows: number }> = [];
  /** Each page the source handed out, by the statement it answered, and each write call, in turn. */
  const timeline: string[] = [];
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
  /**
   * A read of the target by id, answered from what it holds as Salesforce
   * answers one: an id of either length matches by its first fifteen
   * characters, and comes back with eighteen; an id of another object matches
   * nothing; a value that is no id is refused, as is an object neither org
   * has. Any other statement is not one: undefined.
   */
  const heldById = (soql: string): Row[] | undefined => {
    const asked = /^SELECT Id FROM (\w+) WHERE Id IN \((.*)\)$/.exec(soql);
    if (!asked) return undefined;
    const [, object, list] = asked;
    for (const literal of list.split(', ')) {
      if (!/^'[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?'$/.test(literal)) {
        throw new Error(`INVALID_QUERY_FILTER_OPERATOR: invalid ID field: ${literal}`);
      }
    }
    if (schema[object] === undefined && !target.has(object)) {
      throw new Error(`INVALID_TYPE: sObject type '${object}' is not supported.`);
    }
    const rows = [...(target.get(object) ?? new Map<string, Row>())].map(([id, row]) => ({
      ...row,
      Id: id,
    }));
    return selectFrom(rows, parseSoql(soql)).map((row) => ({ Id: row['Id'] }));
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
        return heldById(soql) ?? [];
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
                timeline.push(`page ${soql}`);
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
      timeline.push(`insert ${object}`);
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
    ...(options.upserts
      ? {
          upsertRecords: vi.fn(async (_org: string, object: string, field: string, rows: Row[]) => {
            upsertCalls.push({ object, field, rows: rows.length });
            timeline.push(`upsert ${object} by ${field}`);
            flow.written += rows.length;
            const table = target.get(object) ?? new Map<string, Row>();
            target.set(object, table);
            return rows.map((row) => {
              const held = [...table].find(([, record]) => record[field] === row[field]);
              if (held) {
                Object.assign(held[1], row);
                return { id: held[0], success: true, created: false, errors: [] };
              }
              created[object] = (created[object] ?? 0) + 1;
              const id = canonicalRecordId(
                `${KEY_PREFIX[object]}T${String(created[object]).padStart(11, '0')}`,
              );
              if (!id) throw new Error('no id');
              table.set(id, { ...row });
              return { id, success: true, created: true, errors: [] };
            });
          }),
        }
      : {}),
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
  return { executor, deps, written, insertCalls, upsertCalls, timeline, flow, recordTypeScans };
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

/** A field the target matches records by: an external id. */
const externalId = (name: string): FieldInfo => ({ ...text(name), externalId: true });

/** A record the target holds before the run, its id of the target's own. */
function heldId(object: string, n: number): string {
  const id = canonicalRecordId(`${KEY_PREFIX[object]}H${String(n).padStart(11, '0')}`);
  if (!id) throw new Error('no id');
  return id;
}

/**
 * Accounts and the contacts under them, each with an external id the target
 * matches its records by, and a target that holds an account and two contacts
 * under the same ids already: `keys` changes the contacts' external ids.
 */
function keyed(keys: (n: number) => string | null = (n) => `contact-key-${n}`): {
  schema: Schema;
  graph: ForgeGraph;
  holds: Record<string, Row[]>;
} {
  const accounts = Array.from({ length: 9 }, (_, n) => ({
    Id: sourceId('Account', n),
    Name: `Account ${n}`,
    Ext__c: `account-key-${n}`,
  }));
  const contacts = Array.from({ length: 14 }, (_, n) => ({
    Id: sourceId('Contact', n),
    LastName: `Contact ${n}`,
    AccountId: sourceId('Account', n % 9),
    Ext__c: keys(n),
  }));
  return {
    schema: {
      Account: { fields: [text('Name'), externalId('Ext__c')], rows: accounts },
      Contact: {
        fields: [text('LastName'), lookup('AccountId', 'Account', false), externalId('Ext__c')],
        rows: contacts,
      },
    },
    graph: graphOf([node('Account', 9), node('Contact', 14)], [edge('Account', 'Contact', true)]),
    holds: {
      Account: [{ Id: heldId('Account', 0), Name: 'Held', Ext__c: 'account-key-2' }],
      Contact: [
        { Id: heldId('Contact', 0), LastName: 'Held', Ext__c: 'contact-key-3' },
        { Id: heldId('Contact', 1), LastName: 'Held', Ext__c: 'contact-key-11' },
      ],
    },
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

  describe('a run that upserts', () => {
    const upserting = (holds: Record<string, Row[]>, more: FakeOrgOptions = {}) => ({
      upserts: true,
      targetHolds: holds,
      ...more,
    });
    /** What the target was sent of `object`, in turn: each page read of it, each write call. */
    const turnsOf = (timeline: readonly string[], object: string) =>
      timeline.filter((entry) => new RegExp(`(FROM|insert|upsert) ${object}\\b`).test(entry));

    it.each(PAGE_SIZES)(
      'upserts by the external id what the run read whole upserts, writing over what the target held, in pages of %i',
      async (pageSize) => {
        const { schema, graph, holds } = keyed();
        const whole = await runOver(schema, graph, { upsertMode: 'auto' }, upserting(holds));
        const paged = await runOver(
          schema,
          graph,
          { upsertMode: 'auto', stream: { pageSize } },
          upserting(holds),
        );

        expect(paged.written()).toEqual(whole.written());
        expect(outcomeOf(paged.summary)).toEqual(outcomeOf(whole.summary));
        expect(paged.summary.errors).toEqual(whole.summary.errors);
        // The account and the two contacts the target held, written over.
        expect(paged.summary.updatedCount).toBe(3);
        expect(paged.summary.updatedSourceIds).toEqual(whole.summary.updatedSourceIds);
        expect(paged.insertCalls).toEqual([]);
        expect(paged.upsertCalls.every((call) => call.field === 'Ext__c')).toBe(true);
        expect(paged.upsertCalls.every((call) => call.rows <= pageSize)).toBe(true);
      },
    );

    it('reads and upserts an object a page at a time, once the id and the external id of every row are read', async () => {
      const { schema, graph, holds } = keyed();
      const paged = await runOver(
        schema,
        graph,
        { upsertMode: 'auto', stream: { pageSize: 5 } },
        upserting(holds, { cursorPage: 5 }),
      );

      const keys = 'page SELECT Id, Ext__c FROM Contact ORDER BY Id';
      const rows = 'page SELECT Id, LastName, AccountId, Ext__c FROM Contact ORDER BY Id';
      const upsert = 'upsert Contact by Ext__c';
      expect(turnsOf(paged.timeline, 'Contact')).toEqual([
        ...[keys, keys, keys],
        ...[rows, upsert, rows, upsert, rows, upsert],
      ]);
      expect(paged.summary.successCount + paged.summary.updatedCount).toBe(23);
    });

    it.each([
      ['repeats an external id of a row on another page', (n: number) => `contact-key-${n % 6}`],
      [
        'leaves its external id empty on the last page',
        (n: number) => (n === 13 ? null : `contact-key-${n}`),
      ],
    ])('inserts the object a row of which %s, as the run read whole does', async (_case, keys) => {
      const { schema, graph, holds } = keyed(keys);
      const whole = await runOver(schema, graph, { upsertMode: 'auto' }, upserting(holds));
      const paged = await runOver(
        schema,
        graph,
        { upsertMode: 'auto', stream: { pageSize: 3 } },
        upserting(holds),
      );

      expect(whole.upsertCalls.filter((call) => call.object === 'Contact')).toEqual([]);
      // Each page's own external ids are unique: judged on its page alone,
      // the second page upserted onto the records the first had created.
      expect(paged.upsertCalls.filter((call) => call.object === 'Contact')).toEqual([]);
      expect(paged.written()).toEqual(whole.written());
      expect(outcomeOf(paged.summary)).toEqual(outcomeOf(whole.summary));
    });

    it('judges the external ids of a run it resumes on the rows that run read as well', async () => {
      // The ninth contact's external id is the third's, read before the checkpoint.
      const { schema, graph, holds } = keyed((n) => `contact-key-${n === 9 ? 2 : n}`);
      const resumed = await runOver(
        schema,
        graph,
        {
          upsertMode: 'auto',
          stream: {
            pageSize: 5,
            resumeAfter: { Contact: { lastId: sourceId('Contact', 4), read: 5 } },
          },
        },
        upserting(holds),
      );

      expect(resumed.timeline).toContain('page SELECT Id, Ext__c FROM Contact ORDER BY Id');
      expect(resumed.upsertCalls.filter((call) => call.object === 'Contact')).toEqual([]);
      expect(resumed.insertCalls.filter((call) => call.object === 'Contact')).toEqual([
        { object: 'Contact', rows: 5 },
        { object: 'Contact', rows: 4 },
      ]);
    });

    it('inserts an object whose external ids could not be read, and writes all of it', async () => {
      const { schema, graph, holds } = keyed();
      const orgs = fakeOrgs(schema, upserting(holds));
      const { queryPages } = orgs.deps;
      if (!queryPages) throw new Error('no cursor');
      const refused: AsyncIterable<Row[]> = {
        [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('QUERY_TIMEOUT')) }),
      };
      const executor = new ForgeExecutor({
        ...orgs.deps,
        queryPages: (org, soql) =>
          soql.startsWith('SELECT Id, Ext__c FROM Contact') ? refused : queryPages(org, soql),
      });

      const summary = await executor.execute(graph, 'src', 'tgt', () => {}, {
        upsertMode: 'auto',
        stream: { pageSize: 5 },
      });

      expect(orgs.upsertCalls.filter((call) => call.object === 'Contact')).toEqual([]);
      expect(
        orgs.insertCalls
          .filter((call) => call.object === 'Contact')
          .reduce((sum, call) => sum + call.rows, 0),
      ).toBe(14);
      expect(summary.failedCount).toBe(0);
    });

    it('reads no external id for a simulation, which writes nothing', async () => {
      const { schema, graph, holds } = keyed();
      const simulated = await runOver(
        schema,
        graph,
        { upsertMode: 'auto', dryRun: true, stream: { pageSize: 5 } },
        upserting(holds),
      );

      expect(simulated.timeline.some((entry) => entry.includes('SELECT Id, Ext__c FROM'))).toBe(
        false,
      );
      expect(simulated.summary.wouldInsertCount).toBe(23);
    });
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

  it('writes an object in windows of the rows the run sets, the pages of the org gathered, each told as it is written', async () => {
    const { schema, graph } = selfLookups();
    const pages: ForgeStreamPage[] = [];
    await runOver(schema, graph, {
      // The org's pages of 2 rows, gathered into windows of 10.
      stream: {
        pageSize: 2,
        writeWindow: 10,
        onPage: (page) => void pages.push(structuredClone(page)),
      },
    });
    expect(
      pages.filter((page) => page.objectApiName === 'Account').map((page) => page.checkpoint),
    ).toEqual([
      { lastId: sourceId('Account', 9), read: 10 },
      { lastId: sourceId('Account', 19), read: 20 },
      { lastId: sourceId('Account', 22), read: 23 },
    ]);
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

    it('holds nothing back for a closed record type only past the most rows the run reads, judged on the rows it reads', async () => {
      // Twelve accounts, the last three of a record type closed to the user:
      // read to nine, the run reads none of them. Judged on the whole table,
      // the nine open accounts were held back with them.
      const { schema, graph, recordTypes } = closedRecordType();
      const paged = await runOver(
        schema,
        graph,
        { maxRecordsPerObject: 9, stream: { pageSize: 4 } },
        { recordTypes },
      );

      expect(Object.keys(paged.written()['Account'] ?? {})).toHaveLength(9);
      expect(paged.summary.errors.filter((e) => e.objectApiName === 'Account')).toEqual([]);
      expect(vi.mocked(paged.deps.queryRecords).mock.calls.map(([, soql]) => soql)).toContain(
        'SELECT RecordTypeId FROM Account ORDER BY Id LIMIT 9',
      );

      // Read to ten, the run reads one of the closed type: held back whole, as before.
      const ten = await runOver(
        schema,
        graph,
        { maxRecordsPerObject: 10, stream: { pageSize: 4 } },
        { recordTypes },
      );
      expect(ten.written()['Account']).toBeUndefined();
      expect(ten.insertCalls.filter((call) => call.object === 'Account')).toEqual([]);
      expect(ten.summary.errors).toContainEqual(
        expect.objectContaining({ objectApiName: 'Account', stage: 'scope', failedCount: 10 }),
      );
    });

    it('keeps the count of the whole table when the read of the rows the run reads stops short', async () => {
      const { schema, graph, recordTypes } = closedRecordType();
      const orgs = fakeOrgs(schema, { recordTypes });
      const answer = orgs.deps.queryRecords;
      orgs.deps.queryRecords = vi.fn(
        async (org: string, soql: string, onTruncated?: () => void) => {
          if (soql.startsWith('SELECT RecordTypeId FROM')) onTruncated?.();
          return answer(org, soql, onTruncated);
        },
      );
      await orgs.executor.execute(graph, 'src', 'tgt', () => {}, {
        maxRecordsPerObject: 9,
        stream: { pageSize: 4 },
      });

      expect(orgs.insertCalls.filter((call) => call.object === 'Account')).toEqual([]);
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

describe('a run of whole tables, with lookups at objects outside the run', () => {
  /*
   * Run for real from one Developer Edition to another, a table of contacts
   * copied alone, its accounts left out: the simulation said both would be
   * inserted, and the run had both refused,
   * INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY on AccountId — the source's
   * account ids named nothing in the target. Between two sandboxes of one
   * production the same ids name the same accounts.
   */
  const HELD = sourceId('Account', 1);
  const GONE = sourceId('Account', 2);
  const POLICY_HELD = sourceId('Policy__c', 1);
  const POLICY_GONE = sourceId('Policy__c', 2);
  const REFUSED_CROSS_REFERENCE =
    'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY: insufficient access rights on cross-reference id';

  /** Contacts naming an account the target holds, and two naming one it does not. */
  const contacts: Schema = {
    Account: { fields: [text('Name')], rows: [] },
    Contact: {
      fields: [text('LastName'), lookup('AccountId', 'Account', true)],
      rows: [
        { Id: sourceId('Contact', 1), LastName: 'One', AccountId: HELD },
        { Id: sourceId('Contact', 2), LastName: 'Two', AccountId: GONE },
        { Id: sourceId('Contact', 3), LastName: 'Three', AccountId: GONE },
      ],
    },
  };
  /** Invoices that may not go without their policy: one the target holds, one it does not. */
  const invoices: Schema = {
    Invoice__c: {
      fields: [text('Name'), lookup('Policy__c', 'Policy__c', false)],
      rows: [
        { Id: sourceId('Invoice__c', 1), Name: 'January', Policy__c: POLICY_HELD },
        { Id: sourceId('Invoice__c', 2), Name: 'February', Policy__c: POLICY_GONE },
      ],
    },
  };
  /** What the target holds before the run: one account, one policy. */
  const holds = { Account: [{ Id: HELD, Name: 'Held' }], Policy__c: [{ Id: POLICY_HELD }] };
  /** The target refuses a lookup naming a record it does not hold, as the platform does. */
  const refuse = (_object: string, row: Row): string | undefined => {
    const named = [row['AccountId'], row['Policy__c']].filter((v) => typeof v === 'string');
    return named.some((id) => id !== HELD && id !== POLICY_HELD)
      ? REFUSED_CROSS_REFERENCE
      : undefined;
  };

  /**
   * Run `schema`'s tables, read page by page, the accounts left out by name as
   * the command line leaves out every table it does not name, over a target
   * that holds `holds` and refuses what the platform refuses.
   */
  async function runWith(schema: Schema, options: ExecuteOptions = {}, more: FakeOrgOptions = {}) {
    const graph = graphOf(
      Object.entries(schema).map(([object, { rows }]) => node(object, rows.length)),
      [],
    );
    const orgs = fakeOrgs(schema, { targetHolds: holds, refuse, ...more });
    const events: ForgeProgressEvent[] = [];
    const summary = await orgs.executor.execute(graph, 'src', 'tgt', (e) => events.push(e), {
      stream: { pageSize: 2 },
      excludedObjects: ['Account'],
      ...options,
    });
    const written = (object: string): Row[] => Object.values(orgs.written()[object] ?? {});
    const asked = vi
      .mocked(orgs.deps.queryRecords)
      .mock.calls.filter(
        ([org, soql]) => org === 'tgt' && /^SELECT Id FROM \w+ WHERE Id IN /.test(soql),
      )
      .map(([, soql]) => soql);
    const lineOf = (object: string): string =>
      events.find((e) => e.objectName === object && (e.status === 'done' || e.status === 'error'))
        ?.message ?? '';
    return { summary, written, asked, lineOf, insertCalls: orgs.insertCalls };
  }

  /** The report a run ends with of `rows` contacts written without their account. */
  const withoutTheirAccount = (rows: number) => ({
    objectApiName: 'Contact',
    stage: 'scope',
    failedCount: 0,
    attemptedCount: 0,
    samples: [
      {
        recordSummary: `AccountId → Account (${rows} records)`,
        messages: [
          'Written without AccountId: the target holds no record of these ids, outside the run.',
        ],
      },
    ],
  });

  it('keeps a lookup the target holds, and writes without it, and says, a row whose record it does not hold', async () => {
    const { summary, written, lineOf } = await runWith(contacts);

    expect(summary.successCount).toBe(3);
    expect(summary.failedCount).toBe(0);
    expect(
      written('Contact')
        .map((row) => [row['LastName'], row['AccountId']])
        .sort(),
    ).toEqual([
      ['One', HELD],
      ['Three', undefined],
      ['Two', undefined],
    ]);
    expect(lineOf('Contact')).toContain(
      'written without AccountId on 2: the target holds no record of these ids, outside the run',
    );
    expect(summary.errors).toEqual([withoutTheirAccount(2)]);
    expect(finishedRunStatus(summary)).toBe('success');
  });

  it('says so in a simulation, which writes nothing', async () => {
    const { summary, written, lineOf } = await runWith(contacts, { dryRun: true });

    expect(written('Contact')).toEqual([]);
    expect(summary.wouldInsertCount).toBe(3);
    expect(summary.failedCount).toBe(0);
    expect(lineOf('Contact')).toContain(
      'Simulated Contact: 3 would be inserted, 0 failed, written without AccountId on 2: the ' +
        'target holds no record of these ids, outside the run',
    );
    expect(summary.errors).toEqual([withoutTheirAccount(2)]);
  });

  it('asks the target once a run for each id, by object, a read by id of either length', async () => {
    const { asked } = await runWith(contacts, { stream: { pageSize: 1 } });

    expect(asked).toEqual([
      `SELECT Id FROM Account WHERE Id IN ('${HELD}')`,
      `SELECT Id FROM Account WHERE Id IN ('${GONE}')`,
    ]);
  });

  it('holds back before the write, and says, a row that may not go without a record the target does not hold', async () => {
    const { summary, written, insertCalls, lineOf } = await runWith(invoices);

    expect(written('Invoice__c').map((row) => row['Name'])).toEqual(['January']);
    // Never sent: the target was not asked to refuse it.
    expect(insertCalls.reduce((sum, call) => sum + call.rows, 0)).toBe(1);
    expect(summary.successCount).toBe(1);
    expect(summary.failedCount).toBe(1);
    expect(summary.errors).toEqual([
      {
        objectApiName: 'Invoice__c',
        stage: 'scope',
        failedCount: 1,
        attemptedCount: 0,
        samples: [
          {
            recordSummary: 'Policy__c → Policy__c (1 record)',
            messages: [
              'Not written: Policy__c may not be left empty, and the target holds no ' +
                'Policy__c record of the id it names, outside the run.',
            ],
          },
        ],
      },
    ]);
    expect(lineOf('Invoice__c')).toBe(
      'Completed Invoice__c: 1 succeeded, 1 failed, 1 of them held back for want of their parent',
    );
  });

  it('holds the same row back in a simulation, and counts the other among what it would insert', async () => {
    const { summary } = await runWith(invoices, { dryRun: true });

    expect(summary.wouldInsertCount).toBe(1);
    expect(summary.failedCount).toBe(1);
    expect(summary.errors.map((error) => error.samples[0]?.messages[0])).toEqual([
      'Not written: Policy__c may not be left empty, and the target holds no Policy__c record ' +
        'of the id it names, outside the run.',
    ]);
  });

  it('asks nothing of a record-scoped run, which leaves the lookup empty as before', async () => {
    const { summary, written, asked } = await runWith(contacts, {
      stream: undefined,
      rootObjectApiName: 'Contact',
      rootRecordId: sourceId('Contact', 2),
    });

    expect(asked).toEqual([]);
    expect(written('Contact')).toEqual([{ LastName: 'Two' }]);
    expect(summary.errors.flatMap((error) => error.samples.flatMap((s) => s.messages))).toEqual([
      'Written with the lookup empty: the Account record it points at is not in the clone.',
    ]);
  });

  it('counts the reads among the requests the run sent, two hundred ids a read', async () => {
    const many: Schema = {
      Contact: {
        fields: [text('LastName'), lookup('AccountId', 'Account', true)],
        rows: Array.from({ length: 201 }, (_, n) => ({
          Id: sourceId('Contact', n),
          LastName: `Contact ${n}`,
          AccountId: sourceId('Account', 1000 + n),
        })),
      },
    };
    /** The run's requests, as deps that count each read and write report them. */
    const requestsOf = async (options: ExecuteOptions) => {
      const orgs = fakeOrgs(many, { targetHolds: holds });
      let sent = 0;
      const { queryRecords, insertRecords } = orgs.deps;
      orgs.deps.queryRecords = async (...args) => {
        sent++;
        return queryRecords(...args);
      };
      orgs.deps.insertRecords = async (...args) => {
        sent++;
        return insertRecords(...args);
      };
      orgs.deps.requestsSent = () => sent;
      const summary = await new ForgeExecutor(orgs.deps).execute(
        graphOf([node('Contact', 201)], []),
        'src',
        'tgt',
        () => {},
        options,
      );
      return summary.apiCalls ?? 0;
    };

    const asking = await requestsOf({});
    const notAsking = await requestsOf({ fieldExclusions: { Contact: ['AccountId'] } });

    expect(asking - notAsking).toBe(2);
  });

  it('carries the ids of an object the target will not be read for, and asks it no more', async () => {
    // Neither org has the regions' object here: the target refuses the read,
    // INVALID_TYPE, which says nothing of what it holds.
    const regions = [1, 2, 3].map((n) => sourceId('Region__c', n));
    const schema: Schema = {
      Contact: {
        fields: [text('LastName'), lookup('Region__c', 'Region__c', true)],
        rows: regions.map((region, n) => ({
          Id: sourceId('Contact', n),
          LastName: `Contact ${n}`,
          Region__c: region,
        })),
      },
    };
    const { written, asked } = await runWith(
      schema,
      { stream: { pageSize: 1 } },
      { refuse: () => undefined },
    );

    expect(asked).toHaveLength(1);
    expect(written('Contact').map((row) => row['Region__c'])).toEqual(regions);
  });
});

describe('the fields a run leaves out of its rows', () => {
  /** Accounts and the contacts under them, each contact with a description, an email and its manager. */
  function described(): { schema: Schema; graph: ForgeGraph } {
    const { schema, graph } = accountFamily();
    const contact = schema['Contact'];
    if (!contact) throw new Error('no contacts');
    return {
      schema: {
        ...schema,
        Contact: {
          fields: [...contact.fields, text('Description', 'textarea'), text('Email', 'email')],
          rows: contact.rows.map((row, n) => ({
            ...row,
            Description: `Notes on contact ${n}`,
            Email: `person${n}@example.com`,
          })),
        },
      },
      graph,
    };
  }

  /** Every statement the run sent the source, through a whole read or its cursor. */
  function statementsOf(orgs: ReturnType<typeof fakeOrgs>): string[] {
    const whole = vi
      .mocked(orgs.deps.queryRecords)
      .mock.calls.filter(([org]) => org === 'src')
      .map(([, soql]) => soql);
    const paged = orgs.deps.queryPages
      ? vi
          .mocked(orgs.deps.queryPages)
          .mock.calls.filter(([org]) => org === 'src')
          .map(([, soql]) => soql)
      : [];
    return [...whole, ...paged];
  }

  it.each([
    ['of whole tables, page by page', { stream: { pageSize: 3 } }],
    ['from a record', { rootRecordId: sourceId('Account', 0), rootObjectApiName: 'Account' }],
  ] as Array<[string, ExecuteOptions]>)(
    'reads none of them from the source in a run %s, the lookups among them all the same',
    async (_name, options) => {
      // Left out of the rows for the personal data they hold, a description and
      // an email were read from the source all the same, and held with the
      // rows until the write dropped them.
      const { schema, graph } = described();
      const orgs = fakeOrgs(schema);
      if (orgs.deps.queryPages) vi.spyOn(orgs.deps, 'queryPages');
      const summary = await orgs.executor.execute(graph, 'src', 'tgt', () => {}, {
        ...options,
        fieldExclusions: { Contact: ['Description', 'Email', 'ReportsToId'] },
      });

      const contactReads = statementsOf(orgs).filter((soql) => / FROM Contact\b/.test(soql));
      expect(contactReads.length).toBeGreaterThan(0);
      for (const soql of contactReads) {
        const select = soql.slice(0, soql.indexOf(' FROM '));
        expect(select).not.toMatch(/\bDescription\b|\bEmail\b/);
        expect(select).toMatch(/\bReportsToId\b/);
        expect(select).toMatch(/\bAccountId\b/);
      }
      expect(summary.successCount).toBeGreaterThan(0);
      for (const row of Object.values(orgs.written()['Contact'] ?? {})) {
        expect(row).not.toHaveProperty('Description');
        expect(row).not.toHaveProperty('Email');
        expect(row).not.toHaveProperty('ReportsToId');
      }
    },
  );
});

describe('the rows held back on an object without record types', () => {
  it('holds back the rows a gap naming its master names, and lists the decision with what the run applied', async () => {
    // Found live on a Developer Edition pair: on such an object the master
    // record type is read for its restricted dependent picklists and named
    // Master, its gaps with it, and "Hold back these rows" held back none of
    // them, writing them with the value left out.
    const schema: Schema = {
      Contact: {
        fields: [text('LastName'), text('LeadSource', 'picklist')],
        rows: Array.from({ length: 5 }, (_, n) => ({
          Id: sourceId('Contact', n),
          LastName: `Contact ${n}`,
          LeadSource: n < 2 ? 'Fax' : 'Web',
        })),
      },
    };
    const graph = graphOf([node('Contact', 5)], []);
    const { summary, written } = await runOver(schema, graph, {
      stream: { pageSize: 2 },
      decisions: {
        skippedRows: [
          {
            object: 'Contact',
            gapId: forgeGapId('picklist_value_refused', 'Contact', 'LeadSource', 'Master', 'Fax'),
          },
        ],
      },
    });

    expect(Object.values(written()['Contact'] ?? {}).map((row) => row['LeadSource'])).toEqual([
      'Web',
      'Web',
      'Web',
    ]);
    expect(summary.decisionsApplied).toEqual([
      {
        kind: 'skip_rows',
        objectApiName: 'Contact',
        field: 'LeadSource',
        recordType: 'Master',
        from: 'Fax',
        rows: 2,
      },
    ]);
  });
});

describe('a clone of the whole org, read page by page whatever it holds', () => {
  /** What the activities and emails of the org look like to a copy. */
  const what = (name: string): FieldInfo => ({
    ...lookup(name, 'Account', true),
    referenceTo: ['Account', 'Case'],
  });
  const ACCOUNT = sourceId('Account', 1);
  const CASE = sourceId('Case', 1);
  /** The task the platform wrote with the email related to the account. */
  const TASK_OF_ACCOUNT_EMAIL = sourceId('Task', 1);
  /** The task the email on the case names from the copy. */
  const TASK_OF_CASE_EMAIL = sourceId('Task', 2);
  const PLAIN_TASK = sourceId('Task', 3);
  /** Done more than a year ago: `query` no longer answers it, `queryAll` does. */
  const ARCHIVED_TASK = sourceId('Task', 4);
  /** In the recycle bin: no copy writes it. */
  const DELETED_TASK = sourceId('Task', 5);
  const EMAIL_ON_ACCOUNT = sourceId('EmailMessage', 1);
  const EMAIL_ON_CASE = sourceId('EmailMessage', 2);
  const EMAIL_ON_CASE_WITHOUT_TASK = sourceId('EmailMessage', 3);

  function activities(): { schema: Schema; graph: ForgeGraph } {
    const schema: Schema = {
      Account: { fields: [text('Name')], rows: [{ Id: ACCOUNT, Name: 'Acme' }] },
      Case: { fields: [text('Subject')], rows: [{ Id: CASE, Subject: 'Broken' }] },
      Task: {
        fields: [text('Subject'), what('WhatId')],
        rows: [
          { Id: TASK_OF_ACCOUNT_EMAIL, Subject: 'Email: Offer', WhatId: ACCOUNT },
          { Id: TASK_OF_CASE_EMAIL, Subject: 'Email: Re broken', WhatId: CASE },
          { Id: PLAIN_TASK, Subject: 'Call back', WhatId: CASE },
          { Id: ARCHIVED_TASK, Subject: 'Old call', WhatId: ACCOUNT, IsArchived: true },
          { Id: DELETED_TASK, Subject: 'Binned', WhatId: ACCOUNT, IsDeleted: true },
        ],
      },
      EmailMessage: {
        fields: [
          text('Subject'),
          lookup('ParentId', 'Case', true),
          what('RelatedToId'),
          lookup('ActivityId', 'Task', true),
        ],
        rows: [
          {
            Id: EMAIL_ON_ACCOUNT,
            Subject: 'Offer',
            RelatedToId: ACCOUNT,
            ActivityId: TASK_OF_ACCOUNT_EMAIL,
          },
          {
            Id: EMAIL_ON_CASE,
            Subject: 'Re broken',
            ParentId: CASE,
            ActivityId: TASK_OF_CASE_EMAIL,
          },
          { Id: EMAIL_ON_CASE_WITHOUT_TASK, Subject: 'Ack', ParentId: CASE },
        ],
      },
    };
    const graph = graphOf(
      [node('Account', 1), node('Case', 1), node('Task', 4), node('EmailMessage', 3)],
      [
        edge('Account', 'EmailMessage', false),
        edge('Case', 'EmailMessage', false),
        edge('Case', 'Task', false),
        edge('Account', 'Task', false),
        edge('Task', 'EmailMessage', false),
      ],
    );
    return { schema, graph };
  }

  /** The read of the emails' text a clone of the whole org measures them by at its gate. */
  const EMAIL_SIZE_READ = 'SELECT Id, Subject FROM EmailMessage ORDER BY Id';

  interface WholeOrgOptions {
    /** Rows a page of the source's cursor holds. */
    cursorPage?: number;
    /**
     * Throw `error` in place of a page of `object`'s statement — the `at`-th
     * page the source hands out of it, counted from 1 — the first `times`
     * times that page is reached (once by default).
     */
    failPage?: { object: string; at: number; error: unknown; times?: number };
    /** The record types of each object, as the target's describe gives them. */
    recordTypes?: Record<string, RecordTypeAvailability[]>;
  }

  /** What the executor holds of a run under way, as far as these tests look. */
  type Running = { preread: Map<string, { records: unknown[] }> } | null;

  /**
   * A pair of orgs as a clone of the whole org meets them: a source whose
   * `query` leaves out the archived and the deleted rows, which `queryAll`
   * answers, read through a cursor in pages; and a target that writes the
   * task of an email related to a record itself, refuses an email naming its
   * task unless it is on a case, and answers what it wrote by id.
   */
  function wholeOrg(schema: Schema, options: WholeOrgOptions = {}) {
    const target = new Map<string, Map<string, Row>>();
    const created: Record<string, number> = {};
    const reads: Array<{ soql: string; all: boolean }> = [];
    /** The statements of the source read at once (`queryRecords`), in the order asked. */
    const queries: string[] = [];
    const counts: Array<{ soql: string; all: boolean }> = [];
    const inserts: Array<{ object: string; rows: Row[] }> = [];
    /** Per statement opened, the rows the run held of other objects at that moment. */
    const heldOfOthers: Array<{ object: string; held: number }> = [];
    const holder: { executor?: ForgeExecutor } = {};
    let failures = 0;
    const visible = (object: string, all: boolean): Row[] =>
      (schema[object]?.rows ?? [])
        .filter((row) => all || (row['IsArchived'] !== true && row['IsDeleted'] !== true))
        .map((row) => ({ IsDeleted: false, ...row }));
    const columnsOf = (columns: readonly string[] | null, row: Row): Row =>
      Object.fromEntries((columns ?? []).map((c) => [c, row[c] ?? null]));
    const select = (soql: string, all: boolean): Row[] => {
      // The rows of each record type, as the org groups them.
      const grouped = /^SELECT RecordTypeId, COUNT\(Id\) n (FROM .+) GROUP BY RecordTypeId$/.exec(
        soql,
      );
      if (grouped) {
        const counts = new Map<unknown, number>();
        for (const row of select(`SELECT Id, RecordTypeId ${grouped[1]}`, all)) {
          counts.set(row['RecordTypeId'], (counts.get(row['RecordTypeId']) ?? 0) + 1);
        }
        return [...counts].map(([RecordTypeId, n]) => ({ RecordTypeId, n }));
      }
      const statement = parseSoql(soql);
      return selectFrom(visible(statement.object, all), statement).map((row) =>
        columnsOf(statement.columns, row),
      );
    };
    const newId = (object: string, kind = 'T'): string => {
      created[object] = (created[object] ?? 0) + 1;
      const id = canonicalRecordId(
        `${KEY_PREFIX[object]}${kind}${String(created[object]).padStart(11, '0')}`,
      );
      if (!id) throw new Error('no id');
      return id;
    };
    const table = (object: string): Map<string, Row> => {
      const rows = target.get(object) ?? new Map<string, Row>();
      target.set(object, rows);
      return rows;
    };
    const running = (): Running => (holder.executor as unknown as { running: Running }).running;

    const deps: ForgeExecutorDeps = {
      describeFields: vi.fn(async (_org: string, object: string) => {
        const known = schema[object];
        if (!known) throw new Error(`NOT_FOUND: ${object}`);
        return [idField, ...known.fields];
      }),
      queryRecords: vi.fn(async (org: string, soql: string) => {
        if (org !== 'tgt') {
          queries.push(soql);
          return select(soql, false);
        }
        const statement = parseSoql(soql);
        const rows = [...table(statement.object)].map(([Id, row]) => ({ ...row, Id }));
        return selectFrom(rows, statement).map((row) => columnsOf(statement.columns, row));
      }),
      queryPages: (org: string, soql: string, read?: { all?: true }) =>
        (async function* cursor(): AsyncGenerator<Row[]> {
          if (org !== 'src') return;
          const all = read?.all === true;
          reads.push({ soql, all });
          const object = / FROM (\w+)/.exec(soql)?.[1] ?? '';
          heldOfOthers.push({
            object,
            held: [...(running()?.preread ?? [])]
              .filter(([other]) => other !== object)
              .reduce((sum, [, { records }]) => sum + records.length, 0),
          });
          const rows = select(soql, all);
          const size = options.cursorPage ?? 2;
          if (rows.length === 0) yield [];
          for (let at = 0, page = 1; at < rows.length; at += size, page++) {
            const fail = options.failPage;
            if (fail?.object === object && fail.at === page && failures < (fail.times ?? 1)) {
              failures++;
              throw fail.error;
            }
            yield rows.slice(at, at + size);
          }
        })(),
      countRecords: vi.fn(async (_org: string, soql: string, read?: { all?: true }) => {
        counts.push({ soql, all: read?.all === true });
        const statement = parseSoql(soql);
        return selectFrom(visible(statement.object, read?.all === true), statement).length;
      }),
      insertRecords: vi.fn(async (_org: string, object: string, rows: Row[]) => {
        inserts.push({ object, rows: rows.map((row) => ({ ...row })) });
        return rows.map((row) => {
          if (object === 'EmailMessage' && row['ActivityId'] && !row['ParentId']) {
            return {
              id: '',
              success: false,
              errors: ['INSUFFICIENT_ACCESS_OR_READONLY: you cannot modify this field'],
            };
          }
          const id = newId(object);
          const record: Row = { ...row };
          // The platform writes the task of an email related to a record.
          if (object === 'EmailMessage' && !row['ParentId'] && row['RelatedToId']) {
            const task = newId('Task', 'P');
            table('Task').set(task, { Subject: `Email: ${String(row['Subject'])}` });
            record['ActivityId'] = task;
          }
          table(object).set(id, record);
          return { id, success: true, errors: [] };
        });
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
      ...(options.recordTypes
        ? {
            describeObject: async (_org: string, object: string) => ({
              keyPrefix: KEY_PREFIX[object] ?? null,
              recordTypes: options.recordTypes?.[object] ?? [],
            }),
          }
        : {}),
    };
    const executor = new ForgeExecutor(deps);
    holder.executor = executor;
    return { executor, deps, target, reads, queries, counts, inserts, heldOfOthers };
  }

  /** Run `graph` over a fresh pair of such orgs, as a clone of the whole org. */
  async function cloneOver(
    schema: Schema,
    graph: ForgeGraph,
    options: ExecuteOptions = {},
    orgOptions: WholeOrgOptions = {},
  ) {
    const orgs = wholeOrg(schema, orgOptions);
    const events: ForgeProgressEvent[] = [];
    const summary = await orgs.executor.execute(graph, 'src', 'tgt', (e) => events.push(e), {
      ...options,
      stream: { everything: true, ...options.stream },
    });
    return { ...orgs, summary, events };
  }

  /** Settle `running`, the clock moved on a second at a time while it waits. */
  async function withTheClockMoving<T>(running: Promise<T>): Promise<T> {
    let settled = false;
    void running.then(
      () => (settled = true),
      () => (settled = true),
    );
    while (!settled) await vi.advanceTimersByTimeAsync(1_000);
    return running;
  }

  describe('its emails and tasks', () => {
    it('writes the emails on a case after the tasks they name, a page at a time, and links each task the platform wrote with an email', async () => {
      const { schema, graph } = activities();
      const gates: ForgeWriteBoundary[] = [];
      // A gate: the run asks every row before it writes one, and reads page
      // by page all the same, with no task in hand when the emails go.
      const run = await cloneOver(
        schema,
        graph,
        { beforeWrite: async (boundary) => void gates.push(boundary) },
        { cursorPage: 10 },
      );

      expect(run.inserts.map(({ object }) => object)).toEqual([
        'Account',
        'Case',
        'EmailMessage',
        'Task',
        'EmailMessage',
      ]);
      const [firstEmails, tasks, emailsAfter] = run.inserts.slice(2);
      // The email related to the account goes without the task it names,
      // which the platform writes; the one on the case waits for its own.
      expect(firstEmails.rows.map((row) => row['Subject'])).toEqual(['Offer', 'Ack']);
      expect(firstEmails.rows[0]).not.toHaveProperty('ActivityId');
      // The task the platform wrote with the email is linked, never sent; the
      // archived one is written, the binned one never read.
      expect(tasks.rows.map((row) => row['Subject'])).toEqual([
        'Email: Re broken',
        'Call back',
        'Old call',
      ]);
      expect(emailsAfter.rows).toEqual([
        expect.objectContaining({
          Subject: 'Re broken',
          ActivityId: run.summary.remapTable[TASK_OF_CASE_EMAIL],
        }),
      ]);
      expect(run.summary.remapTable[TASK_OF_ACCOUNT_EMAIL]).toMatch(/^00TP/);
      expect(run.summary.existingSourceIds).toContain(TASK_OF_ACCOUNT_EMAIL);
      expect(run.summary.withTheirRecordSourceIds).toEqual([TASK_OF_ACCOUNT_EMAIL]);
      // The task the platform wrote with the email is counted as written by
      // it, never among the records the target held before the run.
      expect(run.summary.writtenByThePlatform).toEqual([{ objectApiName: 'Task', rows: 1 }]);
      expect(run.summary.existingRecords).toEqual([]);
      expect(run.summary.failedCount).toBe(0);
      expect(run.summary.remapTable[DELETED_TASK]).toBeUndefined();
      expect(run.summary.remapTable[PLAIN_TASK]).toBeDefined();
      expect(run.summary.remapTable[ARCHIVED_TASK]).toBeDefined();

      // The emails on a case read again once the tasks are written — the
      // read of their text that measured them for the gate apart.
      const emailReads = run.reads.filter(
        ({ soql }) => / FROM EmailMessage/.test(soql) && soql !== EMAIL_SIZE_READ,
      );
      expect(emailReads.map(({ soql }) => soql.replace(/^SELECT .+? FROM/, 'FROM'))).toEqual([
        'FROM EmailMessage ORDER BY Id',
        'FROM EmailMessage WHERE (ActivityId != null) ORDER BY Id',
      ]);

      const linesOf = (object: string) =>
        run.events.filter(
          (e) => e.objectName === object && e.status !== 'running' && e.status !== 'scanning',
        );
      expect(linesOf('Task')).toEqual([
        expect.objectContaining({
          status: 'done',
          message:
            'Completed Task: 3 succeeded, 1 written by the platform with their email, 0 failed',
        }),
      ]);
      expect(linesOf('EmailMessage')).toEqual([
        expect.objectContaining({
          status: 'done',
          message:
            'Completed EmailMessage: 2 succeeded, 0 failed, 1 on a case waiting for its task; ' +
            'after their task: 1 succeeded, 0 failed',
        }),
      ]);
      // The gate was shown the archived activities among the rows to write.
      expect(gates[0]?.objects).toContainEqual(
        expect.objectContaining({ objectApiName: 'Task', counted: { rows: 4 } }),
      );
      // And the emails by the size of their text, read page by page.
      expect(run.reads.filter(({ soql }) => soql === EMAIL_SIZE_READ)).toHaveLength(1);
      expect(gates[0]?.objects).toContainEqual(
        expect.objectContaining({
          objectApiName: 'EmailMessage',
          counted: { rows: 3, bytes: 'Offer'.length + 'Re broken'.length + 'Ack'.length },
        }),
      );
    });

    it('reads no email again when none on a case waited for its task, and ends the emails on the line of their turn', async () => {
      const { schema, graph } = activities();
      schema['EmailMessage'] = {
        ...schema['EmailMessage'],
        rows: schema['EmailMessage'].rows.filter((row) => row['Id'] !== EMAIL_ON_CASE),
      };
      const run = await cloneOver(schema, graph, { beforeWrite: async () => {} });

      const emailReads = run.reads.filter(
        ({ soql }) => / FROM EmailMessage/.test(soql) && soql !== EMAIL_SIZE_READ,
      );
      expect(emailReads.map(({ soql }) => soql.replace(/^SELECT .+? FROM/, 'FROM'))).toEqual([
        'FROM EmailMessage ORDER BY Id',
      ]);
      expect(
        run.events.filter(
          (e) =>
            e.objectName === 'EmailMessage' && e.status !== 'running' && e.status !== 'scanning',
        ),
      ).toEqual([
        expect.objectContaining({
          status: 'done',
          message: 'Completed EmailMessage: 2 succeeded, 0 failed',
        }),
      ]);
      expect(run.summary.failedCount).toBe(0);
    });

    it('reads and counts the archived tasks through queryAll, the binned ones left out by the statement', async () => {
      const { schema, graph } = activities();
      const run = await cloneOver(schema, graph, { beforeWrite: async () => {} });

      expect(run.reads.filter(({ soql }) => / FROM Task/.test(soql))).toEqual([
        {
          soql: 'SELECT Id, Subject, WhatId FROM Task WHERE (IsDeleted = false) ORDER BY Id',
          all: true,
        },
      ]);
      expect(run.counts.filter(({ soql }) => / FROM Task/.test(soql))).toEqual([
        { soql: 'SELECT COUNT() FROM Task WHERE (IsDeleted = false)', all: true },
      ]);
      // Any other object read and counted as it always was.
      expect(run.reads.filter(({ all, soql }) => all && !/ FROM Task/.test(soql))).toEqual([]);
      expect(run.counts.filter(({ all, soql }) => all && !/ FROM Task/.test(soql))).toEqual([]);
    });

    it('reads the record types of the tasks through queryAll: one closed to the user that only archived tasks carry holds the tasks back before their first page', async () => {
      const { schema, graph } = activities();
      const open = recordType(1, true);
      const closed = recordType(2, false);
      schema['Task'] = {
        fields: [...schema['Task'].fields, lookup('RecordTypeId', 'RecordType', true)],
        rows: schema['Task'].rows.map((row) => ({
          ...row,
          RecordTypeId: row['Id'] === ARCHIVED_TASK ? closed.recordTypeId : open.recordTypeId,
        })),
      };
      const run = await cloneOver(
        schema,
        graph,
        { beforeWrite: async () => {} },
        { recordTypes: { Task: [open, closed] } },
      );

      expect(run.reads).toContainEqual({
        soql: 'SELECT RecordTypeId, COUNT(Id) n FROM Task WHERE (IsDeleted = false) GROUP BY RecordTypeId',
        all: true,
      });
      expect(run.deps.queryRecords).not.toHaveBeenCalledWith(
        'src',
        expect.stringMatching(/GROUP BY RecordTypeId/),
      );
      // Held back whole, the archived task counted with the others; the
      // binned one never.
      expect(run.inserts.filter(({ object }) => object === 'Task')).toEqual([]);
      expect(run.summary.errors).toContainEqual(
        expect.objectContaining({ objectApiName: 'Task', stage: 'scope', failedCount: 4 }),
      );
    });

    it('keeps where the emails on a case stand apart from where the email node does, in the journal', async () => {
      const { schema, graph } = activities();
      const store = ForgeRunStore.open(memoryRunFile());
      store.beginPart(new Date('2026-11-02T08:00:00.000Z'));
      await cloneOver(schema, graph, { stream: { store } });

      expect(store.checkpoints().get('EmailMessage')).toEqual({
        lastId: EMAIL_ON_CASE_WITHOUT_TASK,
        read: 3,
        done: true,
      });
      // The pass read the two emails that name a task, and wrote the one on a case.
      expect(store.checkpoints().get('EmailMessage/afterTask')).toEqual({
        lastId: EMAIL_ON_CASE,
        read: 2,
        done: true,
      });
    });

    it('reads the emails on a case again in a part taken up once the email node was read to its end', async () => {
      const { schema, graph } = activities();
      const first = await cloneOver(schema, graph);
      // The part before wrote the account, the case and the emails that go
      // first, and stopped before the tasks.
      const run = await cloneOver(
        schema,
        graph,
        {
          stream: {
            resumeAfter: {
              Account: { lastId: ACCOUNT, read: 1 },
              Case: { lastId: CASE, read: 1 },
              EmailMessage: { lastId: EMAIL_ON_CASE_WITHOUT_TASK, read: 3 },
            },
          },
          writtenBefore: Object.fromEntries(
            [ACCOUNT, CASE, EMAIL_ON_ACCOUNT, EMAIL_ON_CASE_WITHOUT_TASK].map((id) => [
              id,
              first.summary.remapTable[id],
            ]),
          ),
        },
        { cursorPage: 10 },
      );

      expect(run.inserts.map(({ object }) => object)).toEqual(['Task', 'EmailMessage']);
      expect(run.inserts[1].rows.map((row) => row['Subject'])).toEqual(['Re broken']);
    });
  });

  it('lets go of the rows of each object once written, where a run of whole tables keeps them', async () => {
    const { schema, graph } = activities();
    const all = await cloneOver(schema, graph);
    expect(all.heldOfOthers.length).toBeGreaterThan(3);
    expect(all.heldOfOthers.every(({ held }) => held === 0)).toBe(true);

    // Read page by page without copying the whole org, the last page of each
    // object stays to the end of the run.
    const tables = wholeOrg(schema);
    await tables.executor.execute(
      graphOf(
        graph.nodes.filter((n) => n.objectApiName === 'Account' || n.objectApiName === 'Case'),
        [],
      ),
      'src',
      'tgt',
      () => {},
      { stream: {} },
    );
    expect(tables.heldOfOthers.some(({ held }) => held > 0)).toBe(true);
  });

  describe('a cursor the source could not go on with', () => {
    function accounts(count: number): { schema: Schema; graph: ForgeGraph } {
      const schema: Schema = {
        Account: {
          fields: [text('Name')],
          rows: Array.from({ length: count }, (_, n) => ({
            Id: sourceId('Account', n),
            Name: `Account ${n}`,
          })),
        },
      };
      return { schema, graph: graphOf([node('Account', count)], []) };
    }
    const namesWritten = (inserts: Array<{ rows: Row[] }>): unknown[] =>
      inserts.flatMap(({ rows }) => rows.map((row) => row['Name']));

    it('reads on after the last row it wrote once the cursor expired, each row written once, those a window held of it too', async () => {
      const { schema, graph } = accounts(7);
      const run = await cloneOver(
        schema,
        graph,
        // Windows of 3 rows over pages of 2: the third page of the cursor
        // fails while the window holds a row of the second.
        { stream: { writeWindow: 3 } },
        {
          cursorPage: 2,
          failPage: {
            object: 'Account',
            at: 3,
            error: Object.assign(new Error('INVALID_QUERY_LOCATOR: invalid query locator'), {
              errorCode: 'INVALID_QUERY_LOCATOR',
            }),
          },
        },
      );

      expect(namesWritten(run.inserts)).toEqual(
        Array.from({ length: 7 }, (_, n) => `Account ${n}`),
      );
      expect(run.reads.map(({ soql }) => soql)).toEqual([
        'SELECT Id, Name FROM Account ORDER BY Id',
        `SELECT Id, Name FROM Account WHERE Id > '${sourceId('Account', 2)}' ORDER BY Id`,
      ]);
      expect(run.summary.failedCount).toBe(0);
      expect(run.summary.failedReads ?? []).toEqual([]);
    });

    it('asks a page again after a wait when the connection dropped, and fails the read past three tries', async () => {
      const { schema, graph } = accounts(8);
      const dropped = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      try {
        const run = await withTheClockMoving(
          cloneOver(
            schema,
            graph,
            {},
            { failPage: { object: 'Account', at: 2, error: dropped, times: 2 } },
          ),
        );
        // Dropped on the second page of the read, and of the read after it.
        expect(namesWritten(run.inserts)).toEqual(
          Array.from({ length: 8 }, (_, n) => `Account ${n}`),
        );
        expect(run.reads.map(({ soql }) => soql)).toEqual([
          'SELECT Id, Name FROM Account ORDER BY Id',
          `SELECT Id, Name FROM Account WHERE Id > '${sourceId('Account', 1)}' ORDER BY Id`,
          `SELECT Id, Name FROM Account WHERE Id > '${sourceId('Account', 3)}' ORDER BY Id`,
        ]);

        // Dropped on its first page every time: the statement as first read.
        const failed = await withTheClockMoving(
          cloneOver(
            schema,
            graph,
            {},
            { failPage: { object: 'Account', at: 1, error: dropped, times: 99 } },
          ),
        );
        // The first try, and three more.
        expect(failed.reads.map(({ soql }) => soql)).toEqual(
          Array.from({ length: 4 }, () => 'SELECT Id, Name FROM Account ORDER BY Id'),
        );
        expect(failed.summary.failedReads).toEqual(['Account']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('fails the read at once on anything else', async () => {
      const { schema, graph } = accounts(4);
      const run = await cloneOver(
        schema,
        graph,
        {},
        {
          failPage: {
            object: 'Account',
            at: 2,
            error: new Error('MALFORMED_QUERY: unexpected token'),
          },
        },
      );
      expect(run.reads).toHaveLength(1);
      expect(run.summary.failedReads).toEqual(['Account']);
    });
  });

  it('copies an object of a managed package the graph holds as any other, its lookups at its own records filled in once they are written', async () => {
    // Vlocity's parties are data like an account: a clone of the whole org
    // holds them as a node. Taken for an object no clone creates, a party
    // naming one on a later page was asked of the target, found nowhere, and
    // written without it for good.
    const PARTY = 'vlocity_cmt__Party__c';
    const schema: Schema = {
      [PARTY]: {
        fields: [text('Name'), lookup('vlocity_cmt__ParentPartyId__c', PARTY, true)],
        rows: Array.from({ length: 4 }, (_, n) => ({
          Id: sourceId(PARTY, n),
          Name: `Party ${n}`,
          vlocity_cmt__ParentPartyId__c: n === 0 ? sourceId(PARTY, 3) : null,
        })),
      },
    };
    const graph = graphOf([node(PARTY, 4)], []);
    const orgs = fakeOrgs(schema);
    const summary = await orgs.executor.execute(graph, 'src', 'tgt', () => {}, {
      stream: { pageSize: 2, everything: true },
    });

    expect(summary.failedCount).toBe(0);
    expect(summary.createdByObject).toContainEqual(
      expect.objectContaining({ objectApiName: PARTY }),
    );
    const parties = orgs.written()[PARTY] ?? {};
    expect(parties[summary.remapTable[sourceId(PARTY, 0)]]?.['vlocity_cmt__ParentPartyId__c']).toBe(
      summary.remapTable[sourceId(PARTY, 3)],
    );
    expect(
      vi
        .mocked(orgs.deps.queryRecords)
        .mock.calls.filter(
          ([org, soql]) => org === 'tgt' && soql.startsWith(`SELECT Id FROM ${PARTY} `),
        ),
    ).toEqual([]);
  });

  it('leaves the quote an opportunity syncs with empty, and says so, where a run of whole tables fills it in', async () => {
    const schema: Schema = {
      Opportunity: {
        fields: [text('Name'), lookup('SyncedQuoteId', 'Quote', true)],
        rows: [
          { Id: sourceId('Opportunity', 1), Name: 'Deal', SyncedQuoteId: sourceId('Quote', 1) },
        ],
      },
      Quote: {
        fields: [text('Name'), lookup('OpportunityId', 'Opportunity', false)],
        rows: [
          { Id: sourceId('Quote', 1), Name: 'Offer', OpportunityId: sourceId('Opportunity', 1) },
        ],
      },
    };
    const graph = graphOf(
      [node('Opportunity', 1), node('Quote', 1)],
      [edge('Opportunity', 'Quote', true), edge('Quote', 'Opportunity', false)],
    );

    const tables = await runOver(schema, graph, { stream: {} });
    const all = await runOver(schema, graph, { stream: { everything: true } });

    const synced = (run: typeof all): unknown[] =>
      Object.values(run.written()['Opportunity'] ?? {}).map((row) => row['SyncedQuoteId']);
    expect(synced(tables)).toEqual([tables.summary.remapTable[sourceId('Quote', 1)]]);
    expect(synced(all)).toEqual([undefined]);
    expect(updatedIds(all.deps)).toEqual([]);
    expect(all.summary.errors).toContainEqual(
      expect.objectContaining({
        objectApiName: 'Opportunity',
        failedCount: 0,
        samples: [
          expect.objectContaining({
            recordSummary: '(Opportunity.SyncedQuoteId)',
            messages: [expect.stringMatching(/^Left empty on 1 opportunity: /)],
          }),
        ],
      }),
    );
    expect(tables.summary.errors).toEqual([]);
  });
  describe('its files, copied in a last pass once every record is written', () => {
    const DOC_ON_BOTH = sourceId('ContentDocument', 1);
    const DOC_OF_A_USER = sourceId('ContentDocument', 2);
    const DOC_TOO_LARGE = sourceId('ContentDocument', 3);
    const DOC_ON_A_RECORD_LEFT = sourceId('ContentDocument', 4);
    const USER = sourceId('User', 1);
    const LEFT_OUT = sourceId('Account', 9);
    /** The largest file copied, in bytes, in these tests. */
    const MAX = 100;

    /** Two accounts, files on them and elsewhere, and attachments. */
    function withFiles(): { schema: Schema; graph: ForgeGraph } {
      const [first, second] = [sourceId('Account', 1), sourceId('Account', 2)];
      const version = (n: number, document: string, size: number): Row => ({
        Id: sourceId('ContentVersion', n),
        ContentDocumentId: document,
        Title: `Doc ${n}`,
        PathOnClient: `doc-${n}.pdf`,
        ContentSize: size,
        ContentLocation: 'S',
        IsLatest: true,
        SharingPrivacy: 'N',
      });
      const link = (document: string, entity: string): Row => ({
        ContentDocumentId: document,
        LinkedEntityId: entity,
        ShareType: 'V',
        Visibility: 'AllUsers',
      });
      const schema: Schema = {
        Account: {
          fields: [text('Name')],
          rows: [
            { Id: first, Name: 'Acme' },
            { Id: second, Name: 'Globex' },
          ],
        },
        ContentVersion: {
          fields: [],
          rows: [
            version(1, DOC_ON_BOTH, 10),
            version(2, DOC_OF_A_USER, 20),
            version(3, DOC_TOO_LARGE, MAX + 1),
            version(4, DOC_ON_A_RECORD_LEFT, 30),
          ],
        },
        ContentDocumentLink: {
          fields: [],
          rows: [
            { ...link(DOC_ON_BOTH, first), Id: sourceId('ContentDocumentLink', 1) },
            { ...link(DOC_ON_BOTH, second), Id: sourceId('ContentDocumentLink', 2) },
            { ...link(DOC_ON_BOTH, USER), Id: sourceId('ContentDocumentLink', 3) },
            { ...link(DOC_OF_A_USER, USER), Id: sourceId('ContentDocumentLink', 4) },
            { ...link(DOC_TOO_LARGE, first), Id: sourceId('ContentDocumentLink', 5) },
            { ...link(DOC_ON_A_RECORD_LEFT, LEFT_OUT), Id: sourceId('ContentDocumentLink', 6) },
          ],
        },
        Attachment: {
          fields: [],
          rows: [
            {
              Id: sourceId('Attachment', 1),
              ParentId: second,
              Name: 'scan.png',
              ContentType: 'image/png',
              BodyLength: 5,
              IsPrivate: false,
            },
            {
              Id: sourceId('Attachment', 2),
              ParentId: LEFT_OUT,
              Name: 'other.png',
              BodyLength: 6,
              IsPrivate: false,
            },
          ],
        },
      };
      return { schema, graph: graphOf([node('Account', 2)], []) };
    }

    /** A pair of such orgs, the target taking files as Salesforce does: a document for each version. */
    function withFileDeps(schema: Schema) {
      const orgs = wholeOrg(schema, { cursorPage: 2 });
      const sizeOf = new Map(
        [...schema['ContentVersion'].rows, ...schema['Attachment'].rows].map((row) => [
          String(row['Id']),
          Number(row['ContentSize'] ?? row['BodyLength']),
        ]),
      );
      let made = 0;
      const files: Array<{ object: string; record: Row }> = [];
      Object.assign(orgs.deps, {
        readFileBody: vi.fn(async (_org: string, _object: string, id: string) =>
          Buffer.alloc(sizeOf.get(id) ?? 0, 1).toString('base64'),
        ),
        insertFile: vi.fn(async (_org: string, object: string, record: Row) => {
          made++;
          files.push({ object, record });
          const id = canonicalRecordId(
            `${KEY_PREFIX[object]}T${String(made).padStart(11, '0')}`,
          ) as string;
          const table = orgs.target.get(object) ?? new Map<string, Row>();
          orgs.target.set(object, table);
          table.set(
            id,
            object === 'ContentVersion'
              ? {
                  ContentDocumentId: canonicalRecordId(
                    `069T${String(made).padStart(11, '0')}`,
                  ) as string,
                }
              : { ParentId: record['ParentId'] },
          );
          return { id, success: true, errors: [] };
        }),
        remainingFileStorageMB: vi.fn(async () => 1_000),
      });
      return { ...orgs, files };
    }

    /** The statements the run listed its files with, in the order asked. */
    const fileReadsOf = (queries: readonly string[]): string[] =>
      queries.filter((soql) => /^SELECT Id, .* FROM (ContentVersion|Attachment) /.test(soql));
    const VERSIONS =
      'SELECT Id, ContentDocumentId, Title, PathOnClient, ContentSize, SharingPrivacy FROM ContentVersion ' +
      `WHERE IsLatest = true AND ContentLocation = 'S' AND ContentSize <= ${MAX}`;
    const ATTACHMENTS =
      'SELECT Id, ParentId, Name, ContentType, BodyLength, IsPrivate FROM Attachment ' +
      `WHERE BodyLength <= ${MAX}`;

    it('copies each file onto the records the run created, published on the first and linked to the others, and none it did not', async () => {
      const { schema, graph } = withFiles();
      const orgs = withFileDeps(schema);
      const store = ForgeRunStore.open(memoryRunFile());
      const summary = await orgs.executor.execute(graph, 'src', 'tgt', () => {}, {
        files: { maxFileBytes: MAX, acceptedAsIs: true },
        stream: { everything: true, store, pageSize: 2 },
      });

      const accountIn = (n: number): string => summary.remapTable[sourceId('Account', n)];
      // The document on both accounts, and the attachment under the second:
      // nothing of a user's file, one past the largest copied, or one on a
      // record the run did not write.
      expect(orgs.files).toEqual([
        {
          object: 'ContentVersion',
          record: expect.objectContaining({ Title: 'Doc 1', FirstPublishLocationId: accountIn(1) }),
        },
        {
          object: 'Attachment',
          record: expect.objectContaining({ Name: 'scan.png', ParentId: accountIn(2) }),
        },
      ]);
      expect(orgs.inserts.filter(({ object }) => object === 'ContentDocumentLink')).toEqual([
        {
          object: 'ContentDocumentLink',
          rows: [expect.objectContaining({ LinkedEntityId: accountIn(2), ShareType: 'V' })],
        },
      ]);
      // Found from the files, a page at a time, never from the records: each
      // page a statement of its own after the last id of the one before, so
      // that no cursor waits, unread, while the files of a page are copied.
      expect(fileReadsOf(orgs.queries)).toEqual([
        `${VERSIONS} ORDER BY Id LIMIT 2`,
        `${VERSIONS} AND Id > '${sourceId('ContentVersion', 2)}' ORDER BY Id LIMIT 2`,
        `${ATTACHMENTS} ORDER BY Id LIMIT 2`,
        `${ATTACHMENTS} AND Id > '${sourceId('Attachment', 2)}' ORDER BY Id LIMIT 2`,
      ]);
      expect(
        orgs.reads.filter(({ soql }) => / FROM (ContentVersion|Attachment)/.test(soql)),
      ).toEqual([]);
      expect(summary.files?.objects).toEqual([
        expect.objectContaining({ objectApiName: 'ContentDocument', planned: 1, copied: 1 }),
        expect.objectContaining({ objectApiName: 'Attachment', planned: 1, copied: 1 }),
      ]);
      expect(summary.files?.links).toBe(1);
      expect(summary.files?.leftOut).toEqual([]);
      // Each kind keeps where it stands, as a pass of its own.
      expect(store.checkpoints().get('ContentDocument/files')).toEqual({
        lastId: sourceId('ContentVersion', 4),
        read: 3,
        done: true,
      });
      expect(store.checkpoints().get('Attachment/files')).toEqual({
        lastId: sourceId('Attachment', 2),
        read: 2,
        done: true,
      });
      // A removal of the run takes the document and the attachment.
      expect(store.mapping(DOC_ON_BOTH)).toMatchObject({
        kind: 'created',
        objectApiName: 'ContentDocument',
      });
      expect(store.mapping(sourceId('Attachment', 1))).toMatchObject({
        kind: 'created',
        objectApiName: 'Attachment',
      });
      expect(summary.failedCount).toBe(0);
    });

    it('reads on after where a run it takes up stood: the Salesforce Files done, the attachments after the last copied', async () => {
      const { schema, graph } = withFiles();
      const orgs = withFileDeps(schema);
      await orgs.executor.execute(graph, 'src', 'tgt', () => {}, {
        files: { maxFileBytes: MAX, acceptedAsIs: true },
        stream: {
          everything: true,
          resumeAfter: {
            'ContentDocument/files': { lastId: sourceId('ContentVersion', 4), read: 3 },
            'Attachment/files': { lastId: sourceId('Attachment', 0), read: 1 },
          },
        },
      });
      // Each read after its last id, in pages of the org's 2 000.
      expect(fileReadsOf(orgs.queries)).toEqual([
        `${VERSIONS} AND Id > '${sourceId('ContentVersion', 4)}' ORDER BY Id LIMIT 2000`,
        `${ATTACHMENTS} AND Id > '${sourceId('Attachment', 0)}' ORDER BY Id LIMIT 2000`,
      ]);

      // Read to its end, a kind is read no more.
      const done = withFileDeps(schema);
      await done.executor.execute(graph, 'src', 'tgt', () => {}, {
        files: { maxFileBytes: MAX, acceptedAsIs: true },
        stream: {
          everything: true,
          resumeAfter: {
            'ContentDocument/files': {
              lastId: sourceId('ContentVersion', 4),
              read: 3,
              done: true,
            } as { lastId: string; read: number },
          },
        },
      });
      expect(fileReadsOf(done.queries).filter((soql) => / FROM ContentVersion/.test(soql))).toEqual(
        [],
      );
      expect(done.files.map(({ object }) => object)).toEqual(['Attachment']);
    });

    it('asks a page of files again when the source did not answer, after a wait', async () => {
      const { schema, graph } = withFiles();
      const orgs = withFileDeps(schema);
      const read = vi.mocked(orgs.deps.queryRecords).getMockImplementation();
      let refused = 0;
      vi.mocked(orgs.deps.queryRecords).mockImplementation(async (org, soql, onTruncated) => {
        if (org === 'src' && soql.startsWith(VERSIONS) && refused++ === 0) {
          throw Object.assign(new Error('SERVER_UNAVAILABLE: try again'), {
            errorCode: 'SERVER_UNAVAILABLE',
          });
        }
        return read ? read(org, soql, onTruncated) : [];
      });
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      try {
        const summary = await withTheClockMoving(
          orgs.executor.execute(graph, 'src', 'tgt', () => {}, {
            files: { maxFileBytes: MAX, acceptedAsIs: true },
            stream: { everything: true },
          }),
        );
        expect(fileReadsOf(orgs.queries)).toEqual([
          `${VERSIONS} ORDER BY Id LIMIT 2000`,
          `${ATTACHMENTS} ORDER BY Id LIMIT 2000`,
        ]);
        expect(orgs.files.map(({ object }) => object)).toEqual(['ContentVersion', 'Attachment']);
        expect(summary.errors).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('says the files the source would not list, leaves them for a run that takes it up, and still ends the run with what it wrote', async () => {
      const { schema, graph } = withFiles();
      const orgs = withFileDeps(schema);
      const read = vi.mocked(orgs.deps.queryRecords).getMockImplementation();
      vi.mocked(orgs.deps.queryRecords).mockImplementation(async (org, soql, onTruncated) => {
        if (org === 'src' && soql.startsWith(VERSIONS)) {
          throw Object.assign(
            new Error('QUERY_TIMEOUT: Your query request was running for too long'),
            {
              errorCode: 'QUERY_TIMEOUT',
            },
          );
        }
        return read ? read(org, soql, onTruncated) : [];
      });
      const store = ForgeRunStore.open(memoryRunFile());
      const summary = await orgs.executor.execute(graph, 'src', 'tgt', () => {}, {
        files: { maxFileBytes: MAX, acceptedAsIs: true },
        stream: { everything: true, store },
      });

      // Said, once, and the attachments copied all the same.
      expect(summary.errors).toEqual([
        expect.objectContaining({
          objectApiName: 'ContentDocument',
          stage: 'query',
          samples: [
            expect.objectContaining({
              messages: [expect.stringMatching(/^Not read, so not copied .*QUERY_TIMEOUT/)],
            }),
          ],
        }),
      ]);
      expect(orgs.files.map(({ object }) => object)).toEqual(['Attachment']);
      expect(summary.successCount).toBe(2);
      // Nothing passed: a run that takes it up lists them from the start.
      expect(store.checkpoints().get('ContentDocument/files')).toBeUndefined();
      expect(store.checkpoints().get('Attachment/files')).toMatchObject({ done: true });
    });

    it('leaves a page whose links could not be read for a run that takes it up, and says so', async () => {
      const { schema, graph } = withFiles();
      const orgs = withFileDeps(schema);
      const read = vi.mocked(orgs.deps.queryRecords).getMockImplementation();
      vi.mocked(orgs.deps.queryRecords).mockImplementation(async (org, soql, onTruncated) => {
        if (org === 'src' && / FROM ContentDocumentLink /.test(soql)) {
          throw new Error('MALFORMED_QUERY: too complicated');
        }
        return read ? read(org, soql, onTruncated) : [];
      });
      const store = ForgeRunStore.open(memoryRunFile());
      const summary = await orgs.executor.execute(graph, 'src', 'tgt', () => {}, {
        files: { maxFileBytes: MAX, acceptedAsIs: true },
        stream: { everything: true, store, pageSize: 2 },
      });

      expect(summary.errors).toEqual([
        expect.objectContaining({
          objectApiName: 'ContentDocument',
          stage: 'query',
          samples: [expect.objectContaining({ recordSummary: '(links of 2 files)' })],
        }),
      ]);
      // The first page not passed, and no page after it read.
      expect(store.checkpoints().get('ContentDocument/files')).toBeUndefined();
      expect(fileReadsOf(orgs.queries).filter((soql) => / FROM ContentVersion/.test(soql))).toEqual(
        [`${VERSIONS} ORDER BY Id LIMIT 2`],
      );
      expect(orgs.files.map(({ object }) => object)).toEqual(['Attachment']);

      // Links past the bound of the read: said, the file copied onto the
      // records among those read.
      const cut = withFileDeps(schema);
      const readCut = vi.mocked(cut.deps.queryRecords).getMockImplementation();
      vi.mocked(cut.deps.queryRecords).mockImplementation(async (org, soql, onTruncated) => {
        if (org === 'src' && / FROM ContentDocumentLink /.test(soql)) onTruncated?.();
        return readCut ? readCut(org, soql, onTruncated) : [];
      });
      const cutSummary = await cut.executor.execute(graph, 'src', 'tgt', () => {}, {
        files: { maxFileBytes: MAX, acceptedAsIs: true },
        stream: { everything: true },
      });
      expect(cutSummary.errors).toEqual([
        expect.objectContaining({
          objectApiName: 'ContentDocument',
          stage: 'query',
          samples: [
            expect.objectContaining({
              messages: [expect.stringMatching(/^More links than the source reads at once/)],
            }),
          ],
        }),
      ]);
      expect(cut.files.map(({ object }) => object)).toEqual(['ContentVersion', 'Attachment']);
    });

    it('tells its gate the files it may copy and those past the largest, as the source sums them', async () => {
      const { schema, graph } = withFiles();
      const orgs = withFileDeps(schema);
      const read = vi.mocked(orgs.deps.queryRecords).getMockImplementation();
      // The org sums the versions; it holds no attachment, and sums them to null.
      vi.mocked(orgs.deps.queryRecords).mockImplementation(async (org, soql, onTruncated) => {
        if (org === 'src' && soql.startsWith('SELECT SUM(ContentSize) total, COUNT(Id) n ')) {
          return [{ total: 123_456, n: 7 }];
        }
        if (org === 'src' && soql.startsWith('SELECT SUM(BodyLength) total, COUNT(Id) n ')) {
          return [{ total: null, n: 0 }];
        }
        return read ? read(org, soql, onTruncated) : [];
      });
      vi.mocked(orgs.deps.countRecords!).mockImplementation(async (_org, soql) => {
        if (/FROM ContentVersion WHERE .*ContentSize > /.test(soql)) return 2;
        if (/FROM Attachment WHERE BodyLength > /.test(soql)) return 0;
        return 2;
      });
      const gates: ForgeWriteBoundary[] = [];
      await orgs.executor.execute(graph, 'src', 'tgt', () => {}, {
        files: { maxFileBytes: MAX, acceptedAsIs: true },
        beforeWrite: async (boundary) => void gates.push(boundary),
        stream: { everything: true },
      });

      expect(gates[0]?.files).toEqual({ bytes: 123_456, count: 7, overCeiling: 2 });
      expect(gates[0]).not.toHaveProperty('filesUnmeasured');
      const asked = vi.mocked(orgs.deps.queryRecords).mock.calls.map(([, soql]) => soql);
      expect(asked.filter((soql) => /^SELECT SUM\(/.test(soql))).toEqual([
        'SELECT SUM(ContentSize) total, COUNT(Id) n FROM ContentVersion ' +
          `WHERE IsLatest = true AND ContentLocation = 'S' AND ContentSize <= ${MAX}`,
        `SELECT SUM(BodyLength) total, COUNT(Id) n FROM Attachment WHERE BodyLength <= ${MAX}`,
      ]);
      expect(vi.mocked(orgs.deps.countRecords!).mock.calls.map(([, soql]) => soql)).toEqual(
        expect.arrayContaining([
          'SELECT COUNT() FROM ContentVersion ' +
            `WHERE IsLatest = true AND ContentLocation = 'S' AND ContentSize > ${MAX}`,
          `SELECT COUNT() FROM Attachment WHERE BodyLength > ${MAX}`,
        ]),
      );
      // Summed by the org: no file listed to measure them.
      expect(
        orgs.reads.filter(({ soql }) => / FROM (ContentVersion|Attachment)/.test(soql)),
      ).toEqual([]);
    });

    it('tells its gate the files it may copy and those past the largest, summed page by page when the source will not sum them', async () => {
      const { schema, graph } = withFiles();
      const orgs = withFileDeps(schema);
      const gates: ForgeWriteBoundary[] = [];
      await orgs.executor.execute(graph, 'src', 'tgt', () => {}, {
        files: { maxFileBytes: MAX, acceptedAsIs: true },
        beforeWrite: async (boundary) => void gates.push(boundary),
        stream: { everything: true },
      });

      // Every file within the largest — of the run's records or not, those
      // being known once they are written — and the one past it.
      expect(gates[0]?.files).toEqual({ bytes: 10 + 20 + 30 + 5 + 6, count: 5, overCeiling: 1 });
    });

    it('tells its gate it could not measure the files when the source will neither sum nor list them', async () => {
      const { schema, graph } = withFiles();
      const orgs = withFileDeps(schema);
      const open = orgs.deps.queryPages;
      orgs.deps.queryPages = (org, soql, options) => {
        if (/^SELECT Id, ContentSize FROM ContentVersion /.test(soql)) {
          return (async function* refused(): AsyncGenerator<Row[]> {
            yield await Promise.reject(new Error('INSUFFICIENT_ACCESS: ContentVersion'));
          })();
        }
        return open ? open(org, soql, options) : (async function* none() {})();
      };
      const gates: ForgeWriteBoundary[] = [];
      await orgs.executor.execute(graph, 'src', 'tgt', () => {}, {
        files: { maxFileBytes: MAX, acceptedAsIs: true },
        beforeWrite: async (boundary) => void gates.push(boundary),
        stream: { everything: true },
      });

      expect(gates[0]).not.toHaveProperty('files');
      expect(gates[0]?.filesUnmeasured).toBe(true);
    });
  });

  describe('its gate', () => {
    it('is told a node read whole whose rows are past the bound of such a read, and the phone numbers past those the fiction holds', async () => {
      const schema: Schema = {
        Account: {
          fields: [
            text('Name'),
            text('Phone', 'phone'),
            text('Fax', 'phone'),
            // Texts the neutralizer gives fictional numbers to as well, by
            // their name: one the source counts, one it cannot filter on.
            text('Mobile_Phone__c'),
            text('Phone_Notes__c', 'textarea'),
          ],
          rows: [{ Id: sourceId('Account', 1), Name: 'Acme', Phone: '+33 1 23 45 67 89' }],
        },
        BusinessHours: {
          fields: [text('Name')],
          rows: [1, 2, 3].map((n) => ({ Id: `01m${String(n).padStart(12, '0')}`, Name: `H${n}` })),
        },
      };
      const graph = graphOf([node('BusinessHours', 3), node('Account', 1)], []);
      const orgs = wholeOrg(schema);
      // An org of thousands of accounts with a phone number, and a fax for some.
      vi.mocked(orgs.deps.countRecords!).mockImplementation(async (_org, soql) => {
        if (/FROM BusinessHours/.test(soql)) return 3;
        if (/ Phone != null/.test(soql)) return 9_000;
        if (/Fax != null/.test(soql)) return 2_500;
        if (/Mobile_Phone__c != null/.test(soql)) return 700;
        if (/Phone_Notes__c != null/.test(soql)) {
          throw new Error(
            'INVALID_FIELD: field Phone_Notes__c can not be filtered in a query call',
          );
        }
        return 12_000;
      });
      const refused = new Error('refused at the gate');
      const gates: ForgeWriteBoundary[] = [];
      const run = orgs.executor.execute(graph, 'src', 'tgt', () => {}, {
        beforeWrite: async (boundary) => {
          gates.push(boundary);
          throw refused;
        },
        stream: { everything: true, wholeReadBound: 2 },
      });

      await expect(run).rejects.toThrow(refused);
      expect(gates[0]?.wholeReadOver).toEqual([
        { objectApiName: 'BusinessHours', rows: 3, bound: 2 },
      ]);
      // The one the source would not count, as many as the accounts written.
      expect(gates[0]?.contactPointsBlanked).toBe(9_000 + 2_500 + 700 + 12_000 - 10_000);
      // Nothing was written.
      expect(orgs.inserts).toEqual([]);

      // A run that keeps the contact points blanks none.
      const kept = wholeOrg(schema);
      vi.mocked(kept.deps.countRecords!).mockImplementation(async () => 12_000);
      const keptGates: ForgeWriteBoundary[] = [];
      await kept.executor
        .execute(graph, 'src', 'tgt', () => {}, {
          keepContactPoints: true,
          beforeWrite: async (boundary) => {
            keptGates.push(boundary);
            throw refused;
          },
          stream: { everything: true, wholeReadBound: 50_000 },
        })
        .catch(() => undefined);
      expect(keptGates[0]).not.toHaveProperty('contactPointsBlanked');
      expect(keptGates[0]).not.toHaveProperty('wholeReadOver');
    });

    it('stops the run, writing nothing more of it, when a node it reads whole still meets the bound', async () => {
      const schema: Schema = {
        BusinessHours: {
          fields: [text('Name')],
          rows: [{ Id: `01m${String(1).padStart(12, '0')}`, Name: 'Default' }],
        },
      };
      const orgs = wholeOrg(schema);
      const read = vi.mocked(orgs.deps.queryRecords).getMockImplementation();
      // The table grew between its count and its read: the deps' bound cut it.
      vi.mocked(orgs.deps.queryRecords).mockImplementation(async (org, soql, onTruncated) => {
        if (org === 'src' && / FROM BusinessHours/.test(soql)) onTruncated?.();
        return read ? read(org, soql) : [];
      });

      await expect(
        orgs.executor.execute(graphOf([node('BusinessHours', 1)], []), 'src', 'tgt', () => {}, {
          stream: { everything: true, wholeReadBound: 1 },
        }),
      ).rejects.toThrow(
        /^Internal error: BusinessHours holds more rows than a clone of the whole org reads whole \(1\)/,
      );
    });
  });

  it('keeps the records the platform wrote with its own as marks of its journal, listed under the bound and counted past it', async () => {
    const { schema, graph } = activities();
    const listed = ForgeRunStore.open(memoryRunFile());
    const under = await cloneOver(schema, graph, { stream: { store: listed } });
    expect(under.summary.withTheirRecordSourceIds).toEqual([TASK_OF_ACCOUNT_EMAIL]);
    expect(listed.withTheirRecordCount).toBe(1);

    const counted = ForgeRunStore.open(memoryRunFile());
    const past = await cloneOver(schema, graph, {
      stream: { store: counted, summaryBound: 1 },
    });
    expect(past.summary.remapInJournal).toBe(true);
    expect(past.summary.withTheirRecordSourceIds).toBeUndefined();
    expect(past.summary.withTheirRecordCount).toBe(1);
  });

  it('sends the lookups its second pass owes an object as one Bulk API job a window, where pages of 2 000 split them', async () => {
    // Invoices naming the next one, written in one window: every lookup owed.
    const COUNT = 2_500;
    const schema: Schema = {
      Invoice__c: {
        fields: [text('Name'), lookup('Next__c', 'Invoice__c', true)],
        rows: Array.from({ length: COUNT }, (_, n) => ({
          Id: sourceId('Invoice__c', n),
          Name: `INV-${n}`,
          Next__c: n + 1 < COUNT ? sourceId('Invoice__c', n + 1) : null,
        })),
      },
    };
    // Planned as discovery plans a table of thousands: a job's worth goes as one.
    const graph = graphOf(
      [{ ...node('Invoice__c', COUNT), batchStrategy: 'auto' }],
      [edge('Invoice__c', 'Invoice__c', false)],
    );
    const runWith = async (secondPassPageSize?: number) => {
      const orgs = wholeOrg(schema, { cursorPage: 2_000 });
      let made = 0;
      // A job writes every row it is sent; what it created, the target holds,
      // so a REST update finds it.
      const jobs = vi.fn<NonNullable<ForgeExecutorDeps['bulkWriteRecords']>>(
        async (_org, object, operation, records) => {
          const table = orgs.target.get(object) ?? new Map<string, Row>();
          orgs.target.set(object, table);
          const answers = records.map((record) => {
            const id =
              operation === 'update'
                ? String(record['Id'])
                : (canonicalRecordId(
                    `${KEY_PREFIX[object]}B${String(++made).padStart(11, '0')}`,
                  ) as string);
            table.set(id, { ...table.get(id), ...record, Id: undefined });
            return { id, success: true, errors: [] };
          });
          return {
            answers,
            rows: records.map(() => 'answered' as const),
            unmatchedIds: [],
            requests: 8,
          };
        },
      );
      Object.assign(orgs.deps, { bulkWriteRecords: jobs });
      const store = ForgeRunStore.open(memoryRunFile());
      const summary = await orgs.executor.execute(graph, 'src', 'tgt', () => {}, {
        writeApi: 'auto',
        stream: {
          everything: true,
          store,
          writeWindow: 10_000,
          ...(secondPassPageSize ? { secondPassPageSize } : {}),
        },
      });
      const sent = (operation: string): number[] =>
        jobs.mock.calls.filter((call) => call[2] === operation).map((call) => call[3].length);
      const restUpdates = vi
        .mocked(orgs.deps.updateRecords!)
        .mock.calls.reduce((sum, call) => sum + call[2].length, 0);
      return { summary, inserted: sent('insert'), updated: sent('update'), restUpdates };
    };

    const window = await runWith(10_000);
    expect(window.inserted).toEqual([COUNT]);
    expect(window.updated).toEqual([COUNT - 1]);
    expect(window.restUpdates).toBe(0);
    expect(window.summary.failedCount).toBe(0);

    // Pages of 2 000: the rest of the second page is under a job's worth.
    const paged = await runWith();
    expect(paged.updated).toEqual([2_000]);
    expect(paged.restUpdates).toBe(COUNT - 1 - 2_000);
  }, 60_000);
});

describe('the relations of events read page by page', () => {
  it('says once, for the whole table, how many of the relations it linked went without the invitee flag', async () => {
    // Each page of a table of event relations said its own note on the line
    // that ends the table: "1 linked without IsInvitee: …, 1 linked without
    // IsInvitee: …", one per page, where the notes of an opportunity's team
    // are said once for the object.
    const who = sourceId('Contact', 1);
    const events = [1, 2, 3].map((n) => sourceId('Event', n));
    const schema: Schema = {
      Contact: { fields: [text('LastName')], rows: [{ Id: who, LastName: 'Who' }] },
      Event: {
        fields: [text('Subject'), lookup('WhoId', 'Contact', true)],
        rows: events.map((Id, n) => ({ Id, Subject: `Visit ${n}`, WhoId: who })),
      },
      EventRelation: {
        fields: [
          lookup('EventId', 'Event', false),
          lookup('RelationId', 'Contact', false),
          text('IsParent', 'boolean'),
          { ...text('IsInvitee', 'boolean'), updateable: false },
          text('IsWhat', 'boolean'),
        ],
        rows: events.map((EventId, n) => ({
          Id: sourceId('EventRelation', n),
          EventId,
          RelationId: who,
          IsParent: true,
          IsInvitee: true,
          IsWhat: false,
        })),
      },
    };
    const graph = graphOf(
      [node('Contact', 1), node('Event', 3), node('EventRelation', 3)],
      [
        edge('Contact', 'Event', false),
        edge('Event', 'EventRelation', true),
        edge('Contact', 'EventRelation', true),
      ],
    );
    const orgs = fakeOrgs(schema);
    // The target writes the relation of each event to its who as it takes
    // the event, no invitee: the run links each row read to it.
    const platform: FakeRow[] = [];
    const insert = orgs.deps.insertRecords;
    orgs.deps.insertRecords = async (org, object, rows) => {
      const results = await insert(org, object, rows);
      if (object === 'Event') {
        results.forEach((result, i) =>
          platform.push({
            Id: canonicalRecordId(`0RET${String(platform.length + 1).padStart(11, '0')}`) ?? '',
            EventId: result.id,
            RelationId: String(rows[i]?.['WhoId']),
          }),
        );
      }
      return results;
    };
    const query = orgs.deps.queryRecords;
    orgs.deps.queryRecords = async (org, soql, onTruncated) =>
      org === 'tgt' && soql.includes(' FROM EventRelation WHERE EventId IN ')
        ? selectRows({ EventRelation: platform }, soql)
        : query(org, soql, onTruncated);
    const said: ForgeProgressEvent[] = [];

    await orgs.executor.execute(graph, 'src', 'tgt', (e) => said.push(e), {
      stream: { pageSize: 1 },
    });

    expect(said.filter((e) => e.objectName === 'EventRelation').at(-1)?.message).toBe(
      'Completed EventRelation: 0 succeeded, 3 linked to records already in the target, 0 failed, ' +
        '3 linked without IsInvitee: the target does not let it be updated',
    );
  });
});
