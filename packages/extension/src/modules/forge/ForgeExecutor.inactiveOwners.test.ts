import { describe, it, expect, vi } from 'vitest';
import type { ForgeGraph, ForgeGraphEdge, ForgeGraphNode } from '@sandforge/shared';
import { parseSoql, selectFrom } from '../../test/memorySoql.js';
import { ForgeExecutor } from './ForgeExecutor.js';
import { ForgeRunGateError, OWNER_MAP_INACTIVE } from './ForgeRunGate.js';
import { INACTIVE_OWNER_PERMISSION_SOQL } from './stages/TargetHolds.js';
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
 * An owner the target holds inactive. A sandbox made from a production holds
 * the production's users, its inactive ones inactive: it refuses with
 * INACTIVE_OWNER_OR_USER every record such a user owns, and every record
 * under them then fails for want of its parent. A run that carries owners as
 * read (a run of whole tables) asks a user's `IsActive` with the id, reads
 * once whether the user it writes as may give a record an inactive owner, and
 * when it may not sends the row without its owner, the platform giving it
 * that user; and it names those owners among its notes. An owner the user
 * mapped to a user the target holds inactive has the run refused before it
 * reads anything.
 *
 * The fake target answers as a real one was seen to: the refusal's words,
 * the user between brackets on fifteen characters and no field named; the
 * permission's read refused with INVALID_FIELD while the org's setting is off;
 * a row sent without `OwnerId` taken, owned by the user the run writes as.
 */

type Row = Record<string, unknown>;

/** Users the target holds inactive, and one it holds active. */
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
/**
 * The owner as a describe says it: required, and filled by the platform with
 * the user the run writes as when a row goes without it.
 */
const owner = (): FieldInfo =>
  field('OwnerId', {
    isReference: true,
    referenceTo: ['Group', 'User'],
    nillable: false,
    defaultedOnCreate: true,
  });

const FIELDS: Record<string, FieldInfo[]> = {
  Station__c: [field('Id'), field('Name'), owner()],
  Carrier__c: [field('Id'), field('Name'), owner()],
  // The detail of a master-detail: it has no owner of its own, and cannot go
  // in without its station.
  Payment__c: [
    field('Id'),
    field('Name'),
    field('Station__c', { isReference: true, referenceTo: ['Station__c'], nillable: false }),
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
    batchStrategy: 'rest',
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
  /** Whether the user the run writes as has Update Records with Inactive Owners, or the read is refused. */
  readonly permission?: boolean | 'refused';
  /**
   * Whether the target refuses a row whose owner it holds inactive: by
   * default, when the user the run writes as may not give one.
   */
  readonly refusesInactive?: boolean;
  /** The queues the target holds. */
  readonly queues?: readonly string[];
  /**
   * Users the target refuses as owners at the write though it answered them
   * active before the run: deactivated while it went.
   */
  readonly deactivatedSince?: readonly string[];
}

/** The users the target holds, each with its name and whether it is active. */
const TARGET_USERS: Record<string, { name: string; active: boolean }> = {
  [INACTIVE]: { name: 'Former Admin', active: false },
  [OTHER_INACTIVE]: { name: 'Former Clerk', active: false },
  [ACTIVE]: { name: 'Current Admin', active: true },
};

/** The refusal of a row whose owner the target holds inactive, in the target's words. */
function inactiveOwnerRefusal(object: string, ownerId: string): InsertResult {
  const message = `operation performed with inactive user [${ownerId.slice(0, 15)}] as owner of ${object.toLowerCase()}`;
  return {
    id: '',
    success: false,
    errors: [`INACTIVE_OWNER_OR_USER: ${message}`],
    errorDetails: [{ statusCode: 'INACTIVE_OWNER_OR_USER', message, fields: [] }],
  };
}

/**
 * A source holding `rows` by object, and a target that holds the users
 * above, answers whether the user the run writes as may give a record an
 * inactive owner, and creates what it is sent — refusing, as a Salesforce org
 * does, a row whose owner it holds inactive.
 */
function orgs(rows: Record<string, Row[]>, options: TargetOptions = {}) {
  const permission = options.permission ?? 'refused';
  const refusesInactive = options.refusesInactive ?? permission !== true;
  const deactivatedSince = new Set(options.deactivatedSince ?? []);
  let created = 0;
  /** Each row the target was sent, by object, in the order sent. */
  const sent: Record<string, Row[]> = {};
  /** The statements the target was asked. */
  const asked: string[] = [];
  /** The statements the source was asked. */
  const read: string[] = [];

  /** The target's answer to one row, written or refused. */
  const write = (object: string, row: Row): InsertResult => {
    (sent[object] ??= []).push({ ...row });
    const ownerId = row['OwnerId'];
    if (typeof ownerId === 'string') {
      const inactive = TARGET_USERS[ownerId]?.active === false;
      if ((refusesInactive && inactive) || deactivatedSince.has(ownerId)) {
        return inactiveOwnerRefusal(object, ownerId);
      }
    }
    return {
      id: `${object.slice(0, 3)}T${String(created++).padStart(11, '0')}AAA`,
      success: true,
      errors: [],
    };
  };

  /** A read of the source: a whole table, or a page of it. */
  const readSource = (soql: string): Row[] => {
    read.push(soql);
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
      if (permission === 'refused') {
        // As an org answers while its setting is off: the field is not there.
        throw new Error(
          "INVALID_FIELD: No such column 'PermissionsUpdateWithInactiveOwner' on entity 'UserPermissionAccess'",
        );
      }
      return [{ PermissionsUpdateWithInactiveOwner: permission }];
    }
    const statement =
      /^SELECT (Id(?:, Name)?(?:, IsActive)?) FROM (User|Group) WHERE Id IN \((.*)\)$/.exec(soql);
    if (!statement) return [];
    const [, columns, object, list] = statement;
    const ids = list.split(', ').map((literal) => literal.slice(1, -1));
    if (object === 'Group') {
      return (options.queues ?? []).filter((id) => ids.includes(id)).map((Id) => ({ Id }));
    }
    return Object.entries(TARGET_USERS)
      .filter(([id]) => ids.some((one) => one.slice(0, 15) === id.slice(0, 15)))
      .map(([Id, { name, active }]) => ({
        Id,
        ...(columns.includes('Name') ? { Name: name } : {}),
        ...(columns.includes('IsActive') ? { IsActive: active } : {}),
      }));
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
  } satisfies ForgeExecutorDeps;
  return { executor: new ForgeExecutor(deps), deps, sent, asked, read };
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

/** Two stations owned by the inactive user, one by an active one. */
const STATIONS: Row[] = [
  { Id: src('a01', 1), Name: 'North', OwnerId: INACTIVE },
  { Id: src('a01', 2), Name: 'South', OwnerId: ACTIVE },
  { Id: src('a01', 3), Name: 'East', OwnerId: INACTIVE },
];

describe('ForgeExecutor, an owner the target holds inactive', () => {
  it('sends without its owner a row the target holds the owner of inactive, fails none, and names the owner among the notes', async () => {
    const { sent, summary, events, permissionReads, asked } = await run({ Station__c: STATIONS });

    expect(summary.failedCount).toBe(0);
    expect(summary.successCount).toBe(3);
    expect(sent.Station__c).toEqual([
      { Name: 'North' },
      { Name: 'South', OwnerId: ACTIVE },
      { Name: 'East' },
    ]);
    expect(permissionReads).toHaveLength(1);
    expect(
      asked.some((soql) => soql.startsWith('SELECT Id, IsActive FROM User WHERE Id IN (')),
    ).toBe(true);
    const note = ownersNote(summary, 'Station__c');
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
    expect(endOf(events, 'Station__c')).toContain(
      ', written with the user the run writes as for owner on 2: the target holds their owner inactive',
    );
    // The line of the owners the target lacks says nothing of these.
    expect(endOf(events, 'Station__c')).not.toContain('written without a lookup naming a record');
  });

  it('sends the owner as read when the user the run writes as may give a record an inactive one, and says nothing', async () => {
    const { sent, summary, events } = await run({ Station__c: STATIONS }, { permission: true });

    expect(summary.failedCount).toBe(0);
    expect(sent.Station__c?.map((row) => row['OwnerId'])).toEqual([INACTIVE, ACTIVE, INACTIVE]);
    expect(ownersNote(summary, 'Station__c')).toBeUndefined();
    expect(endOf(events, 'Station__c')).not.toContain('for owner on');
  });

  it('writes again without its owner a row the target refuses for it though the user may, as the field it refused', async () => {
    const { sent, summary } = await run(
      { Station__c: STATIONS },
      { permission: true, refusesInactive: true },
    );

    expect(summary.failedCount).toBe(0);
    expect(summary.successCount).toBe(3);
    // Sent with it, refused, and sent again without the key.
    const north = sent.Station__c?.filter((row) => row['Name'] === 'North') ?? [];
    expect(north[0]).toMatchObject({ OwnerId: INACTIVE });
    expect('OwnerId' in (north.at(-1) ?? {})).toBe(false);
    expect(summary.writtenWithoutFields).toEqual([
      expect.objectContaining({
        objectApiName: 'Station__c',
        fields: [expect.objectContaining({ field: 'OwnerId', refusedBy: 'inactive-owner' })],
      }),
    ]);
    expect(ownersNote(summary, 'Station__c')).toBeUndefined();
  });

  it('never reads the permission when no owner is inactive', async () => {
    const { permissionReads, sent, summary } = await run({
      Station__c: [{ Id: src('a01', 1), Name: 'South', OwnerId: ACTIVE }],
    });

    expect(permissionReads).toEqual([]);
    expect(sent.Station__c).toEqual([{ Name: 'South', OwnerId: ACTIVE }]);
    expect(ownersNote(summary, 'Station__c')).toBeUndefined();
  });

  it('takes a target whose permission reads false for one where the user may not', async () => {
    const { sent, summary } = await run({ Station__c: STATIONS }, { permission: false });

    expect(summary.failedCount).toBe(0);
    expect(sent.Station__c?.map((row) => 'OwnerId' in row)).toEqual([false, true, false]);
    expect(ownersNote(summary, 'Station__c')).toBeDefined();
  });

  it('reads the permission once for two objects read page by page, and says the owners once per object for all its pages', async () => {
    const stations: Row[] = Array.from({ length: 5 }, (_, n) => ({
      Id: src('a01', n + 1),
      Name: `Station ${n + 1}`,
      OwnerId: n % 2 === 0 ? INACTIVE : ACTIVE,
    }));
    const carriers: Row[] = [
      { Id: src('a02', 1), Name: 'Air', OwnerId: OTHER_INACTIVE },
      { Id: src('a02', 2), Name: 'Sky', OwnerId: INACTIVE },
    ];

    const { summary, events, permissionReads, sent, deps } = await run(
      { Station__c: stations, Carrier__c: carriers },
      {},
      { stream: { pageSize: 2 } },
    );

    // Three pages of stations, each written before the next is read.
    expect(
      deps.insertRecords.mock.calls.filter(([, object]) => object === 'Station__c'),
    ).toHaveLength(3);
    expect(summary.failedCount).toBe(0);
    expect(permissionReads).toHaveLength(1);
    expect(sent.Station__c?.filter((row) => 'OwnerId' in row)).toHaveLength(2);
    expect(ownersNote(summary, 'Station__c')?.samples[0]?.recordSummary).toBe(
      'OwnerId → User (3 records)',
    );
    expect(ownersNote(summary, 'Carrier__c')?.samples[0]).toEqual({
      recordSummary: 'OwnerId → User (2 records)',
      messages: [expect.stringContaining(`(${OTHER_INACTIVE}, ${INACTIVE})`)],
    });
    expect(summary.errors.filter((report) => report.objectApiName === 'Station__c')).toHaveLength(
      1,
    );
    expect(endOf(events, 'Station__c')).toContain(
      'written with the user the run writes as for owner on 3: the target holds their owner inactive',
    );
  });

  it('names ten owners at most, and counts the others', async () => {
    const owners = Array.from(
      { length: 12 },
      (_, n) => `005${String(n + 10).padStart(12, '0')}AAA`,
    );
    for (const id of owners) TARGET_USERS[id] = { name: `Former ${id}`, active: false };
    try {
      const { summary } = await run({
        Station__c: owners.map((OwnerId, n) => ({
          Id: src('a01', n + 1),
          Name: `S${n}`,
          OwnerId,
        })),
      });

      const [message] = ownersNote(summary, 'Station__c')?.samples[0]?.messages ?? [];
      expect(message).toContain(`(${owners.slice(0, 10).join(', ')}, and 2 more)`);
      expect(message).not.toContain(owners[10]);
    } finally {
      for (const id of owners) delete TARGET_USERS[id];
    }
  });

  it('writes the detail of a parent whose owner the target holds inactive, the parent written first', async () => {
    const payments: Row[] = [
      { Id: src('a03', 1), Name: 'P-1', Station__c: src('a01', 1) },
      { Id: src('a03', 2), Name: 'P-2', Station__c: src('a01', 3) },
    ];

    const { sent, summary } = await run({ Station__c: STATIONS, Payment__c: payments }, {}, {}, [
      edge('Station__c', 'Payment__c'),
    ]);

    expect(summary.failedCount).toBe(0);
    expect(summary.successCount).toBe(5);
    expect(sent.Payment__c?.map((row) => row['Station__c'])).toEqual([
      summary.remapTable[src('a01', 1)],
      summary.remapTable[src('a01', 3)],
    ]);
    expect(JSON.stringify(summary.errors)).not.toContain('REQUIRED_FIELD_MISSING');
  });

  it('keeps a queue the target holds as owner, and asks no queue whether it is active', async () => {
    const { sent, asked, permissionReads } = await run(
      { Station__c: [{ Id: src('a01', 1), Name: 'North', OwnerId: QUEUE }] },
      { queues: [QUEUE] },
    );

    expect(sent.Station__c).toEqual([{ Name: 'North', OwnerId: QUEUE }]);
    expect(asked.filter((soql) => soql.includes(' FROM Group '))).toEqual([
      `SELECT Id FROM Group WHERE Id IN ('${QUEUE}')`,
    ]);
    expect(permissionReads).toEqual([]);
  });

  it('says the same of a simulation, which writes nothing', async () => {
    const { sent, summary, events, permissionReads } = await run(
      { Station__c: STATIONS },
      {},
      { dryRun: true },
    );

    expect(sent).toEqual({});
    expect(permissionReads).toHaveLength(1);
    expect(ownersNote(summary, 'Station__c')?.samples[0]?.recordSummary).toBe(
      'OwnerId → User (2 records)',
    );
    expect(endOf(events, 'Station__c')).toContain(
      'written with the user the run writes as for owner on 2: the target holds their owner inactive',
    );
  });
});

describe('ForgeExecutor, an owner mapping to a user the target holds inactive', () => {
  const MAPPED_FROM = '005000000000009AAA';
  const ROWS = { Station__c: [{ Id: src('a01', 1), Name: 'North', OwnerId: MAPPED_FROM }] };

  it('refuses the run before it reads anything, naming the user and the owners mapped to it', async () => {
    const fake = orgs(ROWS);

    const refused = await fake.executor
      .execute(graphOf(ROWS), 'src', 'tgt', () => undefined, {
        ownerMappings: { [MAPPED_FROM]: INACTIVE, [ACTIVE]: ACTIVE },
      })
      .then(
        () => undefined,
        (err: unknown) => err,
      );

    expect(refused).toBeInstanceOf(ForgeRunGateError);
    expect(refused).toMatchObject({ code: OWNER_MAP_INACTIVE });
    expect((refused as Error).message).toBe(
      `Owners given to users the target holds inactive: Former Admin (${INACTIVE}), given the ` +
        `records of ${MAPPED_FROM}. The target refuses a record owned by an inactive user, and ` +
        'the run will not give it to the user it writes as instead of the one chosen. Give ' +
        'those records to an active user under Owners (Review → Controls, or --owner-map on ' +
        'the command line), or reactivate the user in the target. Nothing was read or written.',
    );
    expect(fake.read).toEqual([]);
    expect(fake.deps.describeFields).not.toHaveBeenCalled();
    expect(fake.deps.insertRecords).not.toHaveBeenCalled();
    expect(fake.asked).toEqual([
      `SELECT Id, Name, IsActive FROM User WHERE Id IN ('${INACTIVE}', '${ACTIVE}')`,
    ]);
  });

  it('refuses a simulation the same way: the run it rehearses would be refused', async () => {
    const fake = orgs(ROWS);

    await expect(
      fake.executor.execute(graphOf(ROWS), 'src', 'tgt', () => undefined, {
        dryRun: true,
        ownerMappings: { [MAPPED_FROM]: INACTIVE.slice(0, 15) },
      }),
    ).rejects.toMatchObject({ code: OWNER_MAP_INACTIVE });
    expect(fake.read).toEqual([]);
  });

  it('runs a mapping to an active user, which it asked about once', async () => {
    const { sent, summary, asked } = await run(
      ROWS,
      {},
      { ownerMappings: { [MAPPED_FROM]: ACTIVE } },
    );

    expect(summary.failedCount).toBe(0);
    expect(sent.Station__c).toEqual([{ Name: 'North', OwnerId: ACTIVE }]);
    expect(asked.filter((soql) => soql.startsWith('SELECT Id, Name, IsActive FROM User'))).toEqual([
      `SELECT Id, Name, IsActive FROM User WHERE Id IN ('${ACTIVE}')`,
    ]);
  });

  it('fails a row the target refuses for a mapped owner all the same, and never gives it to the user the run writes as', async () => {
    const { sent, summary } = await run(
      ROWS,
      { deactivatedSince: [ACTIVE] },
      { ownerMappings: { [MAPPED_FROM]: ACTIVE }, referenceFallback: 'nullify' },
    );

    expect(sent.Station__c).toEqual([{ Name: 'North', OwnerId: ACTIVE }]);
    expect(summary.successCount).toBe(0);
    expect(summary.failedCount).toBe(1);
    expect(summary.writtenWithoutFields).toBeUndefined();
    expect(JSON.stringify(summary.errors)).toContain(
      `INACTIVE_OWNER_OR_USER: operation performed with inactive user [${ACTIVE.slice(0, 15)}] as owner of station__c`,
    );
  });
});
