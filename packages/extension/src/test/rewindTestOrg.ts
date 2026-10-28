/**
 * The memory org a rewind runs on in tests, and the steps of a rewind's
 * life a test goes through: a checkpoint taken of it as a take takes one,
 * changes made since, the preview a user confirms, the rewind, its undo.
 *
 * The org is the removal tests' org whose updates are made
 * (`MemoryRestoreOrg`), read the way a take, a preview and a rewind read an
 * org: a global describe of objects a person works in, `/limits`, the org's
 * own record and its user's permissions, on a Developer Edition org. It
 * counts a composite as one request and every SOAP call apart, as the orgs
 * were seen to. Its clock is {@link clock}: once the checkpoint is taken it
 * moves a second each time a rewind reads it, so what the rewind writes is
 * dated after Tr, as on a real org.
 *
 * A test file that takes a checkpoint mocks the module the snapshot's
 * connection comes from, before it imports this one:
 *
 * ```ts
 * vi.mock('../../core/connection/ConnectionHelper.js', () => ({ getJsforceConnection: vi.fn() }));
 * ```
 *
 * Lives under `src/test/`: a helper, not a suite.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { vi } from 'vitest';
import type { ForgeTargetAutomation, OrgCheckpoint, RewindDiff } from '@sandforge/shared';

import { getJsforceConnection } from '../core/connection/ConnectionHelper.js';
import {
  openCheckpointStore,
  recreatedFileOf,
  rewindDirOf,
  type CheckpointFolder,
  type OrgCheckpointStore,
} from '../modules/checkpoint/OrgCheckpointStore.js';
import { previewCheckpoint } from '../modules/checkpoint/previewCheckpoint.js';
import {
  rewindOrg,
  type RewindDeps,
  type RewindOutcome,
  type RewindRequest,
} from '../modules/checkpoint/rewindOrg.js';
import {
  takeCheckpoint,
  type TakeDeps,
  type TakeOrg,
} from '../modules/checkpoint/takeCheckpoint.js';
import { undoRewind } from '../modules/checkpoint/undoRewind.js';
import {
  MEMORY_ORG_USER,
  type MemoryChild,
  type MemoryOrgFacts,
  type MemoryOrgRequest,
  type MemoryRow,
} from './memoryRemovalOrg.js';
import { MemoryRestoreOrg } from './memoryRestoreOrg.js';

export const ORG_ID = '00D000000000001AAA';
export const AUTOMATED_PROCESS = '005000000000002AAA';
export const COLLEAGUE = '005000000000003AAA';

/** T0 on the org's clock, with its milliseconds. */
export const T0 = Date.parse('2026-10-22T14:05:12.731Z');
/** Long before the checkpoint: the records and the fields the org held. */
export const LONG_AGO = Date.parse('2026-10-01T09:00:00.000Z');
/** When people worked in the org after the checkpoint. */
export const SINCE = T0 + 60_000;
/** When the user previewed the rewind. */
export const PREVIEWED = T0 + 120_000;
/** When the rewind begins. */
export const REWOUND = T0 + 180_000;

/** The org's clock, in milliseconds: a test moves it as time passes in the org. */
export const clock = { now: T0 };

export const id = (prefix: string, n: number): string =>
  `${prefix}${String(n).padStart(12, '0')}AAA`;
export const account = (n: number): string => id('001', n);
export const contact = (n: number): string => id('003', n);
export const opportunity = (n: number): string => id('006', n);
export const line = (n: number): string => id('00k', n);
export const book = (n: number): string => id('01s', n);
export const order = (n: number): string => id('801', n);

/** The audit fields and the id, as the org describes them: no one writes them. */
export const STAMP_FIELDS = [
  { name: 'Id', label: 'Id', type: 'id', permissionable: false },
  { name: 'SystemModstamp', label: 'System Modstamp', type: 'datetime', permissionable: false },
  { name: 'CreatedDate', label: 'Created Date', type: 'datetime', permissionable: false },
  {
    name: 'CreatedById',
    label: 'Created By',
    type: 'reference',
    referenceTo: ['User'],
    permissionable: false,
  },
  {
    name: 'LastModifiedDate',
    label: 'Last Modified Date',
    type: 'datetime',
    permissionable: false,
  },
  {
    name: 'LastModifiedById',
    label: 'Last Modified By',
    type: 'reference',
    referenceTo: ['User'],
    permissionable: false,
  },
  { name: 'IsDeleted', label: 'Deleted', type: 'boolean', permissionable: false },
];

/** A field anyone may write, as the org describes it. */
export function writable(
  name: string,
  type = 'string',
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { name, label: name, type, createable: true, updateable: true, nillable: true, ...extra };
}

/** The person account's flag, as the org describes it on an account and a contact. */
export const PERSON_FLAG = { name: 'IsPersonAccount', label: 'Is Person Account', type: 'boolean' };

export const FIELDS: Record<string, unknown[]> = {
  Account: [...STAMP_FIELDS, writable('Name'), writable('Industry')],
  Contact: [
    ...STAMP_FIELDS,
    writable('LastName'),
    writable('AccountId', 'reference', { referenceTo: ['Account'] }),
  ],
  Opportunity: [
    ...STAMP_FIELDS,
    writable('Name'),
    writable('AccountId', 'reference', { referenceTo: ['Account'] }),
    writable('Pricebook2Id', 'reference', { referenceTo: ['Pricebook2'] }),
  ],
  // A product is made under its opportunity and stays there.
  OpportunityLineItem: [
    ...STAMP_FIELDS,
    writable('Quantity', 'double'),
    writable('OpportunityId', 'reference', { referenceTo: ['Opportunity'], updateable: false }),
  ],
  Order: [...STAMP_FIELDS, writable('Status'), writable('Description')],
};

/** An account's contacts and opportunities go with it, an opportunity's products with it. */
export const CHILDREN: Record<string, MemoryChild[]> = {
  Account: [
    { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
    { childSObject: 'Opportunity', field: 'AccountId', cascadeDelete: true },
  ],
  Opportunity: [
    { childSObject: 'OpportunityLineItem', field: 'OpportunityId', cascadeDelete: true },
  ],
};

/** The objects the checkpoint holds. */
export const PICKED = ['Account', 'Contact', 'Opportunity', 'OpportunityLineItem'];

/** What an opportunity's price book is refused for, live, while it has products. */
export const PRICE_BOOK_HELD = {
  objectApiName: 'Opportunity',
  fields: ['Pricebook2Id'],
  childSObject: 'OpportunityLineItem',
  field: 'OpportunityId',
  statusCode: 'FIELD_INTEGRITY_EXCEPTION',
  message: 'Cannot change pricebook on opportunity with line items',
};

/** How a test org is set up. */
export interface RewindTestOrgOptions {
  facts?: Partial<MemoryOrgFacts>;
  /** Per object, the fields its describe lists: {@link FIELDS} unless given. */
  fields?: Record<string, unknown[]>;
  /** Per object, the child relationships its describe lists: {@link CHILDREN} unless given. */
  children?: Record<string, MemoryChild[]>;
}

/** See the module's comment. */
export class RewindTestOrg extends MemoryRestoreOrg implements TakeOrg {
  limits = { Max: 15_000, Remaining: 14_000 };
  /** Its daily email limits, as `/limits` lists them: none unless told. */
  emailLimits: Record<string, { Max: number; Remaining: number }> = {};
  /** Whether each read of its clock moves it a second, as time passes during a rewind. */
  ticking = false;
  /** Told of every query the take's snapshot reads through, before it is answered. */
  onSnapshotRead?: (soql: string) => void;
  /** Objects its global describe says the org does not query: views over other records. */
  readonly unqueryable = new Set<string>();
  /** The objects its global describe lists: those it was given fields of. */
  private readonly objects: string[];

  constructor(options: RewindTestOrgOptions = {}) {
    super(options.children ?? CHILDREN, {
      now: () => clock.now,
      ...(options.facts ? { facts: options.facts } : {}),
    });
    clock.now = LONG_AGO;
    const fields = options.fields ?? FIELDS;
    this.objects = Object.keys(fields);
    for (const [name, described] of Object.entries(fields)) this.changeSchema(name, described);
    this.comesBackOnlyWithParent.add('OpportunityLineItem');
    this.add('Organization', {
      Id: ORG_ID,
      IsSandbox: false,
      OrganizationType: 'Developer Edition',
    });
    this.add('UserPermissionAccess', {
      Id: '0Up000000000001AAA',
      PermissionsViewAllData: true,
      PermissionsModifyAllData: true,
      PermissionsViewEncryptedData: false,
    });
    this.add('User', { Id: AUTOMATED_PROCESS, UserType: 'AutomatedProcess' });
    this.add('User', { Id: MEMORY_ORG_USER, Name: 'Ada Admin' });
    this.add('User', { Id: COLLEAGUE, Name: 'Grace Tester' });
  }

  override async describeGlobal(): Promise<unknown> {
    this.requests++;
    return {
      sobjects: this.objects.map((name) => ({
        name,
        label: name,
        queryable: !this.unqueryable.has(name),
        createable: true,
        updateable: true,
        deletable: true,
        layoutable: true,
      })),
    };
  }

  override async request(request: MemoryOrgRequest): Promise<unknown> {
    if (request.method === 'GET' && request.url.endsWith('/limits')) {
      this.requests++;
      return { DailyApiRequests: this.limits, ...this.emailLimits };
    }
    return super.request(request);
  }

  override async serverTime(): Promise<string> {
    if (this.ticking) clock.now += 1_000;
    return super.serverTime();
  }

  /** An update, a person account's name then made of its person's, as the org makes it. */
  override async update(
    objectApiName: string,
    records: Array<Record<string, unknown>>,
  ): Promise<unknown> {
    const answer = await super.update(objectApiName, records);
    if (objectApiName === 'Account') {
      for (const row of this.all('Account')) {
        if (row.IsPersonAccount !== true) continue;
        row.Name = [row.FirstName, row.LastName]
          .filter((part) => typeof part === 'string')
          .join(' ');
      }
    }
    return answer;
  }
}

/** Everything the memory org answered: its REST requests, a composite one, and its SOAP calls. */
export function spent(org: MemoryRestoreOrg): number {
  return org.requests + org.soapCalls;
}

/** The folders the checkpoints of a test are kept in, removed by {@link removeTaken}. */
const dirs: string[] = [];

/** Remove the folders of the checkpoints taken so far: a test file's `afterEach`. */
export function removeTaken(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A checkpoint taken of a test org, and where it is kept. */
export interface Taken {
  org: RewindTestOrg;
  store: OrgCheckpointStore;
  checkpoint: OrgCheckpoint;
  folder: CheckpointFolder;
  /** The live records as the checkpoint holds them. */
  atCheckpoint: OrgState;
}

/** What the org holds of what a test compares, live and in the recycle bin: no stamp. */
export interface OrgState {
  live: Record<string, unknown[]>;
  bin: Record<string, unknown[]>;
}

/** The fields {@link stateOf} compares unless told others. */
export const COMPARED = [
  'Name',
  'Industry',
  'LastName',
  'AccountId',
  'Pricebook2Id',
  'Quantity',
  'OpportunityId',
  'Status',
  'Description',
];

/** What `org` holds of `objects`, live and in the bin, on the fields `compared`. */
export function stateOf(
  org: MemoryRestoreOrg,
  objects: readonly string[] = [...PICKED, 'Order'],
  compared: readonly string[] = COMPARED,
): OrgState {
  const pick = (row: MemoryRow): Record<string, unknown> =>
    Object.fromEntries([
      ['Id', row.Id],
      ...compared.filter((field) => field in row).map((field) => [field, row[field] ?? null]),
    ]);
  const sorted = (rows: MemoryRow[]): unknown[] =>
    rows.map(pick).sort((a, b) => String(a.Id).localeCompare(String(b.Id)));
  return {
    live: Object.fromEntries(objects.map((name) => [name, sorted(org.all(name))])),
    bin: Object.fromEntries(objects.map((name) => [name, sorted(org.inBin(name))])),
  };
}

/** The records of the org long before the checkpoint. */
export function baseRecords(org: RewindTestOrg): void {
  org.add('Account', { Id: account(1), Name: 'Account one', Industry: 'Energy' });
  org.add('Account', { Id: account(2), Name: 'Account two', Industry: 'Energy' });
  org.add('Account', { Id: account(3), Name: 'Account three', Industry: 'Energy' });
  org.add('Contact', { Id: contact(1), LastName: 'One', AccountId: account(2) });
  org.add('Contact', { Id: contact(2), LastName: 'Two', AccountId: account(2) });
  org.add('Contact', { Id: contact(3), LastName: 'Three', AccountId: account(1) });
  org.add('Opportunity', {
    Id: opportunity(1),
    Name: 'Deal',
    AccountId: account(1),
    Pricebook2Id: book(1),
  });
}

/**
 * Records long before the checkpoint, then the checkpoint, taken at T0 of
 * `objects` as a take takes it, through a snapshot handler reading the same
 * org: its values written through `snapshotFiles` when given, compressed
 * otherwise.
 */
export async function taken(
  build: (org: RewindTestOrg) => void = baseRecords,
  org = new RewindTestOrg(),
  objects: readonly string[] = PICKED,
  compared: { objects?: readonly string[]; fields?: readonly string[] } = {},
  snapshotFiles?: TakeDeps['snapshotFiles'],
): Promise<Taken> {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-rewind-'));
  dirs.push(dir);
  const opened = openCheckpointStore({ root: join(dir, 'store'), locksDir: join(dir, 'locks') });
  if ('refusal' in opened) throw new Error(`no store: ${opened.refusal.reason}`);
  clock.now = LONG_AGO;
  build(org);
  clock.now = T0;
  vi.mocked(getJsforceConnection).mockResolvedValue({
    query: (soql: string, options?: { scanAll?: boolean }) => {
      org.onSnapshotRead?.(soql);
      return org.query(soql, options);
    },
    queryMore: (nextRecordsUrl: string) => org.queryMore(nextRecordsUrl),
    describe: (objectApiName: string) => org.describe(objectApiName),
  } as never);
  const outcome = await takeCheckpoint(
    {
      org,
      store: opened.store,
      handler: {
        log: () => undefined,
        orgManager: { getOrg: () => ({ orgType: 'Developer' }) } as never,
        orgRegistry: {} as never,
      },
      now: () => new Date(T0),
      ...(snapshotFiles !== undefined ? { snapshotFiles } : {}),
    },
    {
      orgId: 'org-1',
      orgName: 'DEV-ED',
      alias: 'DEV-ED',
      username: 'tester@example.com',
      instanceUrl: 'https://example.my.salesforce.com',
      registered: { orgType: 'Developer' },
      mode: 'picked',
      objects: [...objects],
      name: 'Before UAT',
    },
  );
  if (!outcome.taken) throw new Error(`refused: ${outcome.refusal.message}`);
  org.onSnapshotRead = undefined;
  const folder = opened.store.folderOf(ORG_ID, outcome.checkpoint.checkpointId);
  return {
    org,
    store: opened.store,
    checkpoint: outcome.checkpoint,
    folder,
    atCheckpoint: stateOf(org, compared.objects, compared.fields),
  };
}

/**
 * What a colleague did since the checkpoint: an account renamed, two created
 * with a contact under one, and an account deleted with its two contacts.
 */
export function changedSince(org: RewindTestOrg): void {
  clock.now = SINCE;
  org.edit('Account', account(1), { Name: 'Renamed' }, COLLEAGUE);
  org.add('Account', { Id: account(4), Name: 'New one', LastModifiedById: COLLEAGUE });
  org.add('Account', { Id: account(5), Name: 'New two', LastModifiedById: COLLEAGUE });
  org.add('Contact', {
    Id: contact(4),
    LastName: 'New',
    AccountId: account(4),
    LastModifiedById: COLLEAGUE,
  });
  org.edit('Account', account(2), { Industry: 'Retail' }, COLLEAGUE);
  org.trash('Account', account(2), COLLEAGUE);
}

/** How the user asks for a preview, or a rewind, of `t`. */
export const request = (
  t: Pick<Taken, 'checkpoint' | 'folder'>,
): {
  checkpoint: OrgCheckpoint;
  folder: CheckpointFolder;
  orgName: string;
  registered: { orgType: 'Developer' };
  username: string;
} => ({
  checkpoint: t.checkpoint,
  folder: t.folder,
  orgName: 'DEV-ED',
  registered: { orgType: 'Developer' as const },
  username: 'tester@example.com',
});

/** The preview the user confirms, read at PREVIEWED unless the clock is later. */
export async function previewed(t: Taken): Promise<RewindDiff> {
  clock.now = Math.max(clock.now, PREVIEWED);
  const outcome = await previewCheckpoint({ org: t.org, store: t.store }, request(t));
  if (!outcome.previewed) throw new Error(outcome.refusal.message);
  return outcome.diff;
}

/** The rewind of `t` to its checkpoint, acting on the preview `previewId`, at REWOUND unless the clock is later. */
export async function rewound(
  t: Taken,
  previewId: string,
  options: { deps?: Partial<RewindDeps>; request?: Partial<RewindRequest> } = {},
): Promise<RewindOutcome> {
  clock.now = Math.max(clock.now, REWOUND);
  t.org.ticking = true;
  const read = await t.store.read(t.checkpoint.checkpointId);
  if (!read?.checkpoint) throw new Error('the checkpoint is gone');
  try {
    return await rewindOrg(
      {
        org: t.org,
        undelete: (ids) => t.org.undelete(ids),
        store: t.store,
        ...options.deps,
      },
      {
        ...request(t),
        checkpoint: read.checkpoint,
        previewId,
        acceptAutomation: false,
        acceptNoUndo: false,
        acceptRecreate: false,
        acceptOutside: false,
        ...options.request,
      },
    );
  } finally {
    t.org.ticking = false;
  }
}

/** The result of a rewind that ran, or a failed test. */
export function resultOf(
  outcome: RewindOutcome,
): Extract<RewindOutcome, { rewound: true }>['result'] {
  if (!outcome.rewound) throw new Error(`refused: ${outcome.refusal.message}`);
  return outcome.result;
}

/** The kinds of the lines of a rewind's journal, in order. */
export function journalKinds(folder: CheckpointFolder, rewindId: string): string[] {
  return readFileSync(join(rewindDirOf(folder, rewindId), 'journal.ndjson'), 'utf8')
    .split('\n')
    .filter((text) => text !== '')
    .map((text) => (JSON.parse(text) as { kind: string }).kind);
}

/** The calls to the org a stop is counted in. */
export const CALLS = new Set([
  'query',
  'queryMore',
  'queryDeleted',
  'request',
  'update',
  'create',
  'destroy',
  'undelete',
  'serverTime',
  'userId',
  'describe',
  'describeGlobal',
]);

/**
 * The org, stopped once it has answered `calls` calls: the signal is aborted
 * as the last of them goes, and the rewind stops before its next one.
 */
export function stoppedAfter(
  org: RewindTestOrg,
  calls: number,
  controller: AbortController,
): RewindTestOrg {
  let sent = 0;
  return new Proxy(org, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      const call = value as (...args: unknown[]) => unknown;
      if (typeof property !== 'string' || !CALLS.has(property)) return call.bind(target);
      return (...args: unknown[]) => {
        sent++;
        const answer = call.apply(target, args);
        if (sent >= calls) controller.abort();
        return answer;
      };
    },
  });
}

/**
 * The records a rewind of the checkpoint in `folder` made again, by the Id
 * each has now: the Id the checkpoint holds it by.
 */
export function recreatedOf(folder: CheckpointFolder): Map<string, string> {
  const file = recreatedFileOf(folder);
  const held = new Map<string, string>();
  if (!existsSync(file)) return held;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line === '') continue;
    const { from, to } = JSON.parse(line) as { from: string; to: string };
    held.set(to, from);
  }
  return held;
}

/**
 * `rows` as the checkpoint names their records: a record a rewind made
 * again by the Id it had, and a lookup naming one by that Id too, so the org
 * once rewound compares with the checkpoint, new Ids aside.
 */
export function asHeld<T extends Record<string, unknown>>(
  rows: readonly T[],
  recreated: ReadonlyMap<string, string>,
): T[] {
  return rows
    .map(
      (row) =>
        Object.fromEntries(
          Object.entries(row).map(([field, value]) => [
            field,
            typeof value === 'string' ? (recreated.get(value) ?? value) : value,
          ]),
        ) as T,
    )
    .sort((a, b) => String(a.Id).localeCompare(String(b.Id)));
}

/** The live records of `state` as the checkpoint in `folder` names them: see {@link asHeld}. */
export function liveAsHeld(state: OrgState, folder: CheckpointFolder): OrgState['live'] {
  const recreated = recreatedOf(folder);
  return Object.fromEntries(
    Object.entries(state.live).map(([objectApiName, rows]) => [
      objectApiName,
      asHeld(rows as Array<Record<string, unknown>>, recreated),
    ]),
  );
}

/** The ids of a live object's records, sorted. */
export function liveIds(org: MemoryRestoreOrg, objectApiName: string): string[] {
  return org
    .all(objectApiName)
    .map((row) => row.Id)
    .sort();
}

/** A read of the org's automation that sends nothing, finding what `found` says. */
export function automationOf(
  found: Partial<ForgeTargetAutomation> = {},
): () => Promise<ForgeTargetAutomation> {
  return () =>
    Promise.resolve({
      objectsRead: [],
      objects: [],
      unread: [],
      conditionsNotRead: 0,
      conditionsBound: 0,
      requests: 0,
      ...found,
    });
}

/** Undo the rewind `rewindId` of `t`, a minute on, under the org's lock. */
export async function undone(
  t: Taken,
  rewindId: string,
): Promise<Awaited<ReturnType<typeof undoRewind>>> {
  const held = t.store.lock(ORG_ID, 'undo');
  if (!('lock' in held)) throw new Error('the org’s lock is held');
  clock.now += 60_000;
  try {
    return await undoRewind({
      folder: t.folder,
      rewindId,
      lock: held.lock,
      objects: t.checkpoint.objects,
      org: t.org,
      undelete: (ids) => t.org.undelete(ids),
    });
  } finally {
    held.lock.release();
  }
}
