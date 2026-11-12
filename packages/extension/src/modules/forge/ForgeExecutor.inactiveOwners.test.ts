import { describe, it, expect, vi } from 'vitest';
import type { ForgeGraph, ForgeGraphEdge, ForgeGraphNode } from '@sandforge/shared';
import { parseSoql, selectFrom } from '../../test/memorySoql.js';
import { buildBulkCsv, BULK_NULL_CELL } from '../../core/engine/bulkCsv.js';
import { ForgeExecutor } from './ForgeExecutor.js';
import { ForgeRunStore, SENT_TAG, memoryRunFile } from './ForgeRunStore.js';
import { rowFingerprint } from './ForgeInFlight.js';
import { INACTIVE_OWNER_PERMISSION_SOQL } from './stages/TargetHolds.js';
import type { BulkRowState, BulkWriteAnswer } from './forgeBulkWrite.js';
import type {
  ExecuteOptions,
  ExecutionSummary,
  FieldInfo,
  ForgeExecutorDeps,
  ForgeProgressEvent,
  InsertResult,
} from './ForgeExecutor.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * An owner the target holds inactive. Run for real across the whole org, from
 * a production to a sandbox of it, every `Aeroport__c` and `Paiement__c` the
 * source's "Admin Salesforce" owned was refused with INACTIVE_OWNER_OR_USER —
 * that user was inactive in the sandbox — and every record under them after
 * them, for want of their parent. A run that carries owners as read (a run of
 * whole tables) asks a user's `IsActive` with the id, reads once whether the
 * user it writes as may give a record an inactive owner, and when it may not
 * sends the row without its owner, the platform giving it that user; and it
 * names those owners among its notes.
 */

type Row = Record<string, unknown>;

/** A user the target holds inactive, and one it holds active. */
const INACTIVE = '005000000000001AAA';
const OTHER_INACTIVE = '005000000000002AAA';
const ACTIVE = '005000000000003AAA';
/** A queue the target holds. */
const QUEUE = '00G000000000001AAA';

/** The `n`-th source id of an object whose ids begin with `prefix`. */
const src = (prefix: string, n: number): string => `${prefix}S${String(n).padStart(11, '0')}AAA`;

const field = (name: string, overrides: Partial<FieldInfo> = {}): FieldInfo => ({
  name,
  queryable: true,
  createable: name !== 'Id',
  updateable: name !== 'Id',
  isReference: false,
  ...overrides,
});
/** An owner as a real describe gives it: required, and set by the org when left out. */
const owner = (): FieldInfo =>
  field('OwnerId', {
    isReference: true,
    referenceTo: ['Group', 'User'],
    nillable: false,
    defaultedOnCreate: true,
  });

const FIELDS: Record<string, FieldInfo[]> = {
  Aeroport__c: [field('Id'), field('Name'), owner()],
  Compagnie__c: [field('Id'), field('Name'), owner()],
  // The detail of a master-detail: it has no owner of its own, and cannot go
  // in without its airport.
  Paiement__c: [
    field('Id'),
    field('Name'),
    field('Aeroport__c', { isReference: true, referenceTo: ['Aeroport__c'], nillable: false }),
  ],
};

function node(objectApiName: string, recordCount: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount,
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

function edge(parent: string, child: string): ForgeGraphEdge {
  return {
    sourceObject: parent,
    targetObject: child,
    relationshipName: parent,
    type: 'master-detail',
    required: true,
  };
}

function graphOf(rows: Record<string, Row[]>, edges: ForgeGraphEdge[] = []): ForgeGraph {
  return {
    nodes: Object.entries(rows).map(([object, list]) => node(object, list.length)),
    edges,
    totalRecords: 0,
    estimatedSizeMB: 0,
    estimatedDurationSeconds: 0,
  };
}

/** What the target says of the users it holds and of the user the run writes as. */
interface TargetOptions {
  /** Whether the user the run writes as has Update Records with Inactive Owners, or the read throws. */
  readonly permission?: boolean | 'throws';
  /**
   * Whether the target refuses a row whose owner it holds inactive: by
   * default, when the user the run writes as may not give one.
   */
  readonly refusesInactive?: boolean;
  /** The queues the target holds. */
  readonly queues?: readonly string[];
}

/** The users the target holds, each with whether it is active. */
const TARGET_USERS: Record<string, boolean> = {
  [INACTIVE]: false,
  [OTHER_INACTIVE]: false,
  [ACTIVE]: true,
};

/**
 * A source holding `rows` by object, and a target that holds the users
 * above, answers whether the user the run writes as may give a record an
 * inactive owner, and creates what it is sent by REST or by job — refusing,
 * as a Salesforce org does, a row whose owner it holds inactive.
 */
function orgs(rows: Record<string, Row[]>, options: TargetOptions = {}) {
  const permission = options.permission ?? false;
  const refusesInactive = options.refusesInactive ?? permission !== true;
  let created = 0;
  /** Each row the target was sent, by object, in the order sent: by REST and by job. */
  const sent: Record<string, Row[]> = {};
  /** The statements the target was asked. */
  const asked: string[] = [];

  /** The target's answer to one row, written or refused. */
  const write = (object: string, row: Row): InsertResult => {
    (sent[object] ??= []).push({ ...row });
    const ownerId = row['OwnerId'];
    if (refusesInactive && typeof ownerId === 'string' && TARGET_USERS[ownerId] === false) {
      const message = `operation performed with inactive user [${ownerId.slice(0, 15)}] as owner of [${object.toLowerCase()}]`;
      return {
        id: '',
        success: false,
        errors: [`INACTIVE_OWNER_OR_USER: ${message}`],
        errorDetails: [{ statusCode: 'INACTIVE_OWNER_OR_USER', message, fields: [] }],
      };
    }
    return {
      id: `${object.slice(0, 3)}T${String(created++).padStart(11, '0')}AAA`,
      success: true,
      errors: [],
    };
  };

  /** A read of the source: a whole table, or a page of it. */
  const readSource = (soql: string): Row[] => {
    const statement = parseSoql(soql);
    const table = rows[statement.object] ?? [];
    const selected = selectFrom(table, statement);
    if (statement.columns === null) return [{ expr0: selected.length }];
    const columns = statement.columns;
    return selected.map((row) =>
      Object.fromEntries(columns.map((name) => [name, row[name] ?? null])),
    );
  };

  /** A read of the target: its users, its queues, the permission. */
  const readTarget = (soql: string): Row[] => {
    asked.push(soql);
    if (soql === INACTIVE_OWNER_PERMISSION_SOQL) {
      if (permission === 'throws') {
        throw new Error("INVALID_FIELD: No such column 'PermissionsUpdateWithInactiveOwner'");
      }
      return [{ PermissionsUpdateWithInactiveOwner: permission }];
    }
    const statement = /^SELECT (Id(?:, IsActive)?) FROM (User|Group) WHERE Id IN \((.*)\)$/.exec(
      soql,
    );
    if (!statement) return [];
    const [, columns, object, list] = statement;
    const ids = list.split(', ').map((literal) => literal.slice(1, -1));
    if (object === 'Group') {
      return (options.queues ?? []).filter((id) => ids.includes(id)).map((Id) => ({ Id }));
    }
    return Object.entries(TARGET_USERS)
      .filter(([id]) => ids.some((asked) => asked.slice(0, 15) === id.slice(0, 15)))
      .map(([Id, IsActive]) => (columns === 'Id' ? { Id } : { Id, IsActive }));
  };

  const deps = {
    describeFields: vi.fn(async (_org: string, object: string) => FIELDS[object] ?? []),
    queryRecords: vi.fn(async (org: string, soql: string) =>
      org === 'src' ? readSource(soql) : readTarget(soql),
    ),
    insertRecords: vi.fn(async (_org: string, object: string, list: Row[]) =>
      list.map((row) => write(object, row)),
    ),
    updateRecords: vi.fn(async (_org: string, _object: string, list: Row[]) =>
      list.map((row) => ({ id: String(row['Id']), success: true, errors: [] })),
    ),
    bulkWriteRecords: vi.fn<NonNullable<ForgeExecutorDeps['bulkWriteRecords']>>(
      async (_org, object, _operation, records): Promise<BulkWriteAnswer> => ({
        answers: records.map((record) => write(object, record)),
        rows: records.map((): BulkRowState => 'answered'),
        unmatchedIds: [],
        requests: 12,
      }),
    ),
    duplicateRuleObjects: vi.fn(async () => new Set<string>()),
  } satisfies ForgeExecutorDeps;
  return { executor: new ForgeExecutor(deps), deps, sent, asked };
}

/** Run the tables of `rows` over the orgs above, and what came of it. */
async function run(
  rows: Record<string, Row[]>,
  target: TargetOptions = {},
  options: ExecuteOptions = {},
  edges: ForgeGraphEdge[] = [],
) {
  const fake = orgs(rows, target);
  const events: ForgeProgressEvent[] = [];
  const summary = await fake.executor.execute(
    graphOf(rows, edges),
    'src',
    'tgt',
    (event) => events.push(event),
    options,
  );
  const permissionReads = fake.asked.filter((soql) => soql === INACTIVE_OWNER_PERMISSION_SOQL);
  return { ...fake, events, summary, permissionReads };
}

/** The run's note of the owners the target holds inactive, of `objectApiName`. */
function ownersNote(summary: ExecutionSummary, objectApiName: string) {
  return summary.errors.find(
    (report) =>
      report.objectApiName === objectApiName &&
      report.samples.some((sample) => sample.recordSummary.startsWith('OwnerId → User')),
  );
}

/** The line that ends `objectApiName`. */
function endOf(events: readonly ForgeProgressEvent[], objectApiName: string): string {
  return (
    events.filter((e) => e.objectName === objectApiName && e.status === 'done').at(-1)?.message ??
    ''
  );
}

/** Two airports owned by the inactive user, one by an active one. */
const AIRPORTS: Row[] = [
  { Id: src('a01', 1), Name: 'Orly', OwnerId: INACTIVE },
  { Id: src('a01', 2), Name: 'Roissy', OwnerId: ACTIVE },
  { Id: src('a01', 3), Name: 'Beauvais', OwnerId: INACTIVE },
];

describe('ForgeExecutor, an owner the target holds inactive', () => {
  it('sends without its owner a row the target holds the owner of inactive, fails none, and names the owner among the notes', async () => {
    const { sent, summary, events, permissionReads, asked } = await run({ Aeroport__c: AIRPORTS });

    expect(summary.failedCount).toBe(0);
    expect(summary.successCount).toBe(3);
    expect(sent.Aeroport__c).toEqual([
      { Name: 'Orly' },
      { Name: 'Roissy', OwnerId: ACTIVE },
      { Name: 'Beauvais' },
    ]);
    expect(permissionReads).toHaveLength(1);
    expect(
      asked.some((soql) => soql.startsWith('SELECT Id, IsActive FROM User WHERE Id IN (')),
    ).toBe(true);
    const note = ownersNote(summary, 'Aeroport__c');
    expect(note).toMatchObject({ stage: 'scope', failedCount: 0, attemptedCount: 0 });
    expect(note?.samples).toEqual([
      {
        recordSummary: 'OwnerId → User (2 records)',
        messages: [
          `Written with the user the run writes as for owner: the target holds these owners inactive (${INACTIVE}) and that user may not give a record an inactive owner (Update Records with Inactive Owners). Map them to an active user under Owners (Review → Controls, or --owner-map on the command line) to give the records to that user.`,
        ],
      },
    ]);
    // No failure's code: the results would explain the note as one.
    expect(JSON.stringify(summary.errors)).not.toContain('INACTIVE_OWNER_OR_USER');
    expect(endOf(events, 'Aeroport__c')).toContain(
      ', written with the user the run writes as for owner on 2: the target holds their owner inactive',
    );
    // The line of the owners the target lacks says nothing of these.
    expect(endOf(events, 'Aeroport__c')).not.toContain('written without a lookup naming a record');
  });

  it('sends the owner as read when the user the run writes as may give a record an inactive one, and says nothing', async () => {
    const { sent, summary, events } = await run({ Aeroport__c: AIRPORTS }, { permission: true });

    expect(summary.failedCount).toBe(0);
    expect(sent.Aeroport__c?.map((row) => row['OwnerId'])).toEqual([INACTIVE, ACTIVE, INACTIVE]);
    expect(ownersNote(summary, 'Aeroport__c')).toBeUndefined();
    expect(endOf(events, 'Aeroport__c')).not.toContain('for owner on');
  });

  it('writes again without its owner a row the target refuses for it though the user may, as the field it refused', async () => {
    const { sent, summary } = await run(
      { Aeroport__c: AIRPORTS },
      { permission: true, refusesInactive: true },
    );

    expect(summary.failedCount).toBe(0);
    expect(summary.successCount).toBe(3);
    // Sent with it, refused, and sent again without the key.
    const orly = sent.Aeroport__c?.filter((row) => row['Name'] === 'Orly') ?? [];
    expect(orly[0]).toMatchObject({ OwnerId: INACTIVE });
    expect('OwnerId' in (orly.at(-1) ?? {})).toBe(false);
    expect(summary.writtenWithoutFields).toEqual([
      expect.objectContaining({
        objectApiName: 'Aeroport__c',
        fields: [expect.objectContaining({ field: 'OwnerId', refusedBy: 'inactive-owner' })],
      }),
    ]);
    expect(ownersNote(summary, 'Aeroport__c')).toBeUndefined();
  });

  it('never reads the permission when no owner is inactive', async () => {
    const { permissionReads, sent, summary } = await run({
      Aeroport__c: [{ Id: src('a01', 1), Name: 'Roissy', OwnerId: ACTIVE }],
    });

    expect(permissionReads).toEqual([]);
    expect(sent.Aeroport__c).toEqual([{ Name: 'Roissy', OwnerId: ACTIVE }]);
    expect(ownersNote(summary, 'Aeroport__c')).toBeUndefined();
  });

  it('takes a target that will not say whether the user may for one where it may not', async () => {
    const { sent, summary } = await run({ Aeroport__c: AIRPORTS }, { permission: 'throws' });

    expect(summary.failedCount).toBe(0);
    expect(sent.Aeroport__c?.map((row) => 'OwnerId' in row)).toEqual([false, true, false]);
    expect(ownersNote(summary, 'Aeroport__c')).toBeDefined();
  });

  it('reads the permission once for two objects read page by page, and says the owners once per object for all its pages', async () => {
    const airports: Row[] = Array.from({ length: 5 }, (_, n) => ({
      Id: src('a01', n + 1),
      Name: `Airport ${n + 1}`,
      OwnerId: n % 2 === 0 ? INACTIVE : ACTIVE,
    }));
    const airlines: Row[] = [
      { Id: src('a02', 1), Name: 'Air', OwnerId: OTHER_INACTIVE },
      { Id: src('a02', 2), Name: 'Sky', OwnerId: INACTIVE },
    ];

    const { summary, events, permissionReads, sent, deps } = await run(
      { Aeroport__c: airports, Compagnie__c: airlines },
      {},
      { stream: { pageSize: 2 } },
    );

    // Three pages of airports, each written before the next is read.
    expect(
      deps.insertRecords.mock.calls.filter(([, object]) => object === 'Aeroport__c'),
    ).toHaveLength(3);
    expect(summary.failedCount).toBe(0);
    expect(permissionReads).toHaveLength(1);
    expect(sent.Aeroport__c?.filter((row) => 'OwnerId' in row)).toHaveLength(2);
    expect(ownersNote(summary, 'Aeroport__c')?.samples[0]?.recordSummary).toBe(
      'OwnerId → User (3 records)',
    );
    expect(ownersNote(summary, 'Compagnie__c')?.samples[0]).toEqual({
      recordSummary: 'OwnerId → User (2 records)',
      messages: [expect.stringContaining(`(${OTHER_INACTIVE}, ${INACTIVE})`)],
    });
    expect(summary.errors.filter((report) => report.objectApiName === 'Aeroport__c')).toHaveLength(
      1,
    );
    expect(endOf(events, 'Aeroport__c')).toContain(
      'written with the user the run writes as for owner on 3: the target holds their owner inactive',
    );
  });

  it('names ten owners at most, and counts the others', async () => {
    const owners = Array.from(
      { length: 12 },
      (_, n) => `005${String(n + 10).padStart(12, '0')}AAA`,
    );
    for (const id of owners) TARGET_USERS[id] = false;
    try {
      const { summary } = await run({
        Aeroport__c: owners.map((OwnerId, n) => ({
          Id: src('a01', n + 1),
          Name: `A${n}`,
          OwnerId,
        })),
      });

      const [message] = ownersNote(summary, 'Aeroport__c')?.samples[0]?.messages ?? [];
      expect(message).toContain(`(${owners.slice(0, 10).join(', ')}, and 2 more)`);
      expect(message).not.toContain(owners[10]);
    } finally {
      for (const id of owners) delete TARGET_USERS[id];
    }
  });

  it('writes the job of a table of 2 000 rows or more with an empty owner cell, never a null, and journals what it sends', async () => {
    const airports: Row[] = Array.from({ length: 2_100 }, (_, n) => ({
      Id: src('a01', n + 1),
      Name: `Airport ${n + 1}`,
      OwnerId: n % 3 === 0 ? INACTIVE : ACTIVE,
    }));
    const file = memoryRunFile();
    const store = ForgeRunStore.open(file);

    const { deps, summary } = await run(
      { Aeroport__c: airports },
      {},
      { writeApi: 'auto', stream: { store } },
    );
    store.close();

    expect(summary.failedCount).toBe(0);
    expect(deps.bulkWriteRecords).toHaveBeenCalledTimes(1);
    const records = deps.bulkWriteRecords.mock.calls[0][3];
    expect(records.filter((record) => !('OwnerId' in record))).toHaveLength(700);
    const csv = buildBulkCsv('insert', records);
    const ownerColumn = csv.columns.indexOf('OwnerId');
    expect(csv.text).not.toContain(BULK_NULL_CELL);
    expect(csv.rows[0][ownerColumn]).toBe('');
    expect(csv.rows[1][ownerColumn]).toBe(ACTIVE);
    // The call is journaled as it is sent: each row's fingerprint is that of
    // the payload without its owner, what a run taken up finds it by.
    const sentLine = file
      .text()
      .split('\n')
      .filter((line) => line.startsWith(`["${SENT_TAG}"`))
      .map((line) => JSON.parse(line) as [string, string, string, string, string[], string[][]])
      .find((line) => line[2] === 'Aeroport__c');
    expect(sentLine).toBeDefined();
    const [, , , , fields, rows] = sentLine ?? [];
    expect(rows?.[0]?.[1]).toBe(rowFingerprint(records[0], fields ?? []));
  });

  it('writes the detail of a parent whose owner the target holds inactive, the parent written first', async () => {
    const payments: Row[] = [
      { Id: src('a03', 1), Name: 'P-1', Aeroport__c: src('a01', 1) },
      { Id: src('a03', 2), Name: 'P-2', Aeroport__c: src('a01', 3) },
    ];

    const { sent, summary } = await run({ Aeroport__c: AIRPORTS, Paiement__c: payments }, {}, {}, [
      edge('Aeroport__c', 'Paiement__c'),
    ]);

    expect(summary.failedCount).toBe(0);
    expect(summary.successCount).toBe(5);
    expect(sent.Paiement__c?.map((row) => row['Aeroport__c'])).toEqual([
      summary.remapTable[src('a01', 1)],
      summary.remapTable[src('a01', 3)],
    ]);
    expect(JSON.stringify(summary.errors)).not.toContain('REQUIRED_FIELD_MISSING');
  });

  it('keeps a queue the target holds as owner, and asks no queue whether it is active', async () => {
    const { sent, asked, permissionReads } = await run(
      { Aeroport__c: [{ Id: src('a01', 1), Name: 'Orly', OwnerId: QUEUE }] },
      { queues: [QUEUE] },
    );

    expect(sent.Aeroport__c).toEqual([{ Name: 'Orly', OwnerId: QUEUE }]);
    expect(asked.filter((soql) => soql.includes(' FROM Group '))).toEqual([
      `SELECT Id FROM Group WHERE Id IN ('${QUEUE}')`,
    ]);
    expect(permissionReads).toEqual([]);
  });

  it('writes again without its owner a row a run that nullifies maps to an inactive user, and says the field it left out', async () => {
    const { sent, summary, permissionReads } = await run(
      { Aeroport__c: [{ Id: src('a01', 1), Name: 'Orly', OwnerId: ACTIVE }] },
      {},
      { referenceFallback: 'nullify', ownerMappings: { [ACTIVE]: INACTIVE } },
    );

    expect(summary.failedCount).toBe(0);
    expect(permissionReads).toEqual([]);
    expect(sent.Aeroport__c?.[0]).toEqual({ Name: 'Orly', OwnerId: INACTIVE });
    expect(sent.Aeroport__c?.at(-1)).toEqual({ Name: 'Orly' });
    expect(summary.writtenWithoutFields?.[0]?.fields).toEqual([
      expect.objectContaining({ field: 'OwnerId', refusedBy: 'inactive-owner' }),
    ]);
  });

  it('says the same of a simulation, which writes nothing', async () => {
    const { sent, summary, events, permissionReads } = await run(
      { Aeroport__c: AIRPORTS },
      {},
      { dryRun: true },
    );

    expect(sent).toEqual({});
    expect(permissionReads).toHaveLength(1);
    expect(ownersNote(summary, 'Aeroport__c')?.samples[0]?.recordSummary).toBe(
      'OwnerId → User (2 records)',
    );
    expect(endOf(events, 'Aeroport__c')).toContain(
      'written with the user the run writes as for owner on 2: the target holds their owner inactive',
    );
  });
});
