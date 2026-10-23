import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeTargetAutomation, OrgCheckpoint, RewindDiff } from '@sandforge/shared';

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import {
  MEMORY_ORG_USER,
  factCombinations,
  type MemoryChild,
  type MemoryOrgFacts,
  type MemoryOrgRequest,
  type MemoryRow,
} from '../../test/memoryRemovalOrg.js';
import { MemoryRestoreOrg } from '../../test/memoryRestoreOrg.js';
import {
  openCheckpointStore,
  rewindDirOf,
  type CheckpointFolder,
  type OrgCheckpointStore,
} from './OrgCheckpointStore.js';
import { previewCheckpoint } from './previewCheckpoint.js';
import { readRewindJournal } from './rewindJournal.js';
import {
  REWIND_RESIDUAL_IDS,
  RewindStopped,
  inRewindWords,
  rewindOrg,
  rewindOrgOf,
  type RewindDeps,
  type RewindOutcome,
  type RewindRequest,
} from './rewindOrg.js';
import { takeCheckpoint, type TakeOrg } from './takeCheckpoint.js';
import { undoRewind } from './undoRewind.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * The rewind, on the memory org the bricks run on: a checkpoint taken of it
 * as a take takes one, changes made since, the preview a user confirms, then
 * the rewind — its guard and gates, its fresh read, its journal, its passes
 * and its verify. The org counts a composite as one request and every SOAP
 * call apart, as the orgs were seen to; its clock moves a second each time
 * it is read once the checkpoint is taken, so what the rewind writes is
 * dated after Tr, as on a real org.
 */

const ORG_ID = '00D000000000001AAA';
const AUTOMATED_PROCESS = '005000000000002AAA';
const COLLEAGUE = '005000000000003AAA';

/** T0 on the org's clock, with its milliseconds. */
const T0 = Date.parse('2026-10-22T14:05:12.731Z');
/** Long before the checkpoint: the records and the fields the org held. */
const LONG_AGO = Date.parse('2026-10-01T09:00:00.000Z');
/** When people worked in the org after the checkpoint. */
const SINCE = T0 + 60_000;
/** When the user previewed the rewind. */
const PREVIEWED = T0 + 120_000;
/** When the rewind begins. */
const REWOUND = T0 + 180_000;

let clock = T0;

const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;
const account = (n: number): string => id('001', n);
const contact = (n: number): string => id('003', n);
const opportunity = (n: number): string => id('006', n);
const line = (n: number): string => id('00k', n);
const book = (n: number): string => id('01s', n);
const order = (n: number): string => id('801', n);

/** The audit fields and the id, as the org describes them: no one writes them. */
const STAMP_FIELDS = [
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

function writable(name: string, type = 'string', extra: Record<string, unknown> = {}) {
  return { name, label: name, type, createable: true, updateable: true, nillable: true, ...extra };
}

const FIELDS: Record<string, unknown[]> = {
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
const CHILDREN: Record<string, MemoryChild[]> = {
  Account: [
    { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
    { childSObject: 'Opportunity', field: 'AccountId', cascadeDelete: true },
  ],
  Opportunity: [
    { childSObject: 'OpportunityLineItem', field: 'OpportunityId', cascadeDelete: true },
  ],
};

/** The objects the checkpoint holds. */
const PICKED = ['Account', 'Contact', 'Opportunity', 'OpportunityLineItem'];

/** What an opportunity's price book is refused for, live, while it has products. */
const PRICE_BOOK_HELD = {
  objectApiName: 'Opportunity',
  fields: ['Pricebook2Id'],
  childSObject: 'OpportunityLineItem',
  field: 'OpportunityId',
  statusCode: 'FIELD_INTEGRITY_EXCEPTION',
  message: 'Cannot change pricebook on opportunity with line items',
};

/**
 * The memory org as a take, a preview and a rewind read it: a global
 * describe of objects a person works in, `/limits`, the org's own record and
 * its user's permissions, on a Developer Edition org.
 */
class RewindTestOrg extends MemoryRestoreOrg implements TakeOrg {
  limits = { Max: 15_000, Remaining: 14_000 };
  /** Whether each read of its clock moves it a second, as time passes during a rewind. */
  ticking = false;
  /** Told of every query the take's snapshot reads through, before it is answered. */
  onSnapshotRead?: (soql: string) => void;

  constructor(
    options: { facts?: Partial<MemoryOrgFacts>; fields?: Record<string, unknown[]> } = {},
  ) {
    super(CHILDREN, { now: () => clock, ...(options.facts ? { facts: options.facts } : {}) });
    clock = LONG_AGO;
    for (const [name, fields] of Object.entries(options.fields ?? FIELDS)) {
      this.changeSchema(name, fields);
    }
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
      sobjects: Object.keys(FIELDS).map((name) => ({
        name,
        label: name,
        queryable: true,
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
      return { DailyApiRequests: this.limits };
    }
    return super.request(request);
  }

  override async serverTime(): Promise<string> {
    if (this.ticking) clock += 1_000;
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
function spent(org: MemoryRestoreOrg): number {
  return org.requests + org.soapCalls;
}

const dirs: string[] = [];

beforeEach(() => {
  clock = T0;
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.mocked(getJsforceConnection).mockReset();
});

interface Taken {
  org: RewindTestOrg;
  store: OrgCheckpointStore;
  checkpoint: OrgCheckpoint;
  folder: CheckpointFolder;
  /** The live records as the checkpoint holds them. */
  atCheckpoint: OrgState;
}

/** What the org holds of what a test compares, live and in the recycle bin: no stamp. */
interface OrgState {
  live: Record<string, unknown[]>;
  bin: Record<string, unknown[]>;
}

const COMPARED = [
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

function stateOf(org: MemoryRestoreOrg, objects = [...PICKED, 'Order']): OrgState {
  const pick = (row: MemoryRow): Record<string, unknown> =>
    Object.fromEntries([
      ['Id', row.Id],
      ...COMPARED.filter((field) => field in row).map((field) => [field, row[field] ?? null]),
    ]);
  const sorted = (rows: MemoryRow[]): unknown[] =>
    rows.map(pick).sort((a, b) => String(a.Id).localeCompare(String(b.Id)));
  return {
    live: Object.fromEntries(objects.map((name) => [name, sorted(org.all(name))])),
    bin: Object.fromEntries(objects.map((name) => [name, sorted(org.inBin(name))])),
  };
}

/**
 * Records long before the checkpoint, then the checkpoint, taken at T0 of the
 * picked objects as a take takes it, through a snapshot handler reading the
 * same org.
 */
async function taken(
  build: (org: RewindTestOrg) => void = baseRecords,
  org = new RewindTestOrg(),
  objects = PICKED,
): Promise<Taken> {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-rewind-'));
  dirs.push(dir);
  const opened = openCheckpointStore({ root: join(dir, 'store'), locksDir: join(dir, 'locks') });
  if ('refusal' in opened) throw new Error(`no store: ${opened.refusal.reason}`);
  clock = LONG_AGO;
  build(org);
  clock = T0;
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
    },
    {
      orgId: 'org-1',
      orgName: 'DEV-ED',
      alias: 'DEV-ED',
      username: 'tester@example.com',
      instanceUrl: 'https://example.my.salesforce.com',
      registered: { orgType: 'Developer' },
      mode: 'picked',
      objects,
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
    atCheckpoint: stateOf(org),
  };
}

/** The records of the org long before the checkpoint. */
function baseRecords(org: RewindTestOrg): void {
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
 * What a colleague did since the checkpoint: an account renamed, two created
 * with a contact under one, and an account deleted with its two contacts.
 */
function changedSince(org: RewindTestOrg): void {
  clock = SINCE;
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

/** The preview the user confirms, read at PREVIEWED. */
async function previewed(t: Taken): Promise<RewindDiff> {
  clock = PREVIEWED;
  const outcome = await previewCheckpoint({ org: t.org, store: t.store }, request(t));
  if (!outcome.previewed) throw new Error(outcome.refusal.message);
  return outcome.diff;
}

const request = (t: Taken) => ({
  checkpoint: t.checkpoint,
  folder: t.folder,
  orgName: 'DEV-ED',
  registered: { orgType: 'Developer' as const },
  username: 'tester@example.com',
});

/** The rewind of `t` to its checkpoint, acting on the preview `previewId`, at REWOUND unless the clock is later. */
async function rewound(
  t: Taken,
  previewId: string,
  options: { deps?: Partial<RewindDeps>; request?: Partial<RewindRequest> } = {},
): Promise<RewindOutcome> {
  clock = Math.max(clock, REWOUND);
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
        acceptOutside: false,
        ...options.request,
      },
    );
  } finally {
    t.org.ticking = false;
  }
}

/** The result of a rewind that ran, or a failed test. */
function resultOf(outcome: RewindOutcome) {
  if (!outcome.rewound) throw new Error(`refused: ${outcome.refusal.message}`);
  return outcome.result;
}

/** The kinds of the lines of a rewind's journal, in order. */
function journalKinds(folder: CheckpointFolder, rewindId: string): string[] {
  return readFileSync(join(rewindDirOf(folder, rewindId), 'journal.ndjson'), 'utf8')
    .split('\n')
    .filter((text) => text !== '')
    .map((text) => (JSON.parse(text) as { kind: string }).kind);
}

describe('rewindOrg, on the memory org', () => {
  it('puts the org back as the checkpoint holds it: brings back what was deleted since with what went with it, gives back what changed, deletes what was created, then reads the org again and finds nothing that differs', async () => {
    const t = await taken();
    changedSince(t.org);
    const diff = await previewed(t);

    const result = resultOf(await rewound(t, diff.previewId));

    expect(stateOf(t.org).live).toEqual(t.atCheckpoint.live);
    expect(result.status).toBe('success');
    expect(result.residual).toEqual([]);
    // The second read found nothing to do: it is the verify, and no second pass is made.
    expect(result.passes).toBe(1);
    expect(result.deleted.map(({ objectApiName, deleted }) => [objectApiName, deleted])).toEqual([
      ['Contact', 1],
      ['Account', 2],
    ]);
    expect(
      result.undeleted.map(({ objectApiName, undeleted }) => [objectApiName, undeleted]),
    ).toEqual([['Account', 1]]);
    expect(
      result.restored.map(({ objectApiName, planned, restored }) => [
        objectApiName,
        planned,
        restored,
      ]),
    ).toEqual([
      ['Contact', 2, 2],
      ['Account', 2, 2],
    ]);
    // Its own deletes in the bin, the account it brought back out of it.
    expect(
      t.org
        .inBin('Account')
        .map((row) => row.Id)
        .sort(),
    ).toEqual([account(4), account(5)]);

    // The journal went through, and the checkpoint says when, and until when Undo reaches.
    const journal = await readRewindJournal(t.folder, result.rewindId);
    expect(journal.endedAt).toBeDefined();
    const read = await t.store.read(t.checkpoint.checkpointId);
    const last = read?.checkpoint?.lastRewind;
    expect(last?.rewindId).toBe(result.rewindId);
    expect(last?.endedAt).toBeDefined();
    expect(Date.parse(last?.undoUntil ?? '') - Date.parse(journal.head.startedAt)).toBe(
      15 * 24 * 60 * 60_000,
    );
    expect(result.undo).toEqual({ until: last?.undoUntil, cannot: [] });
    // Its reads and the preview it acted on are deleted; the journal stays, for Undo.
    expect(readdirSync(t.folder.previewsDir)).toEqual([]);
    expect(existsSync(rewindDirOf(t.folder, result.rewindId))).toBe(true);
  });
});

/** The calls to the org a stop is counted in. */
const CALLS = new Set([
  'query',
  'queryMore',
  'queryDeleted',
  'request',
  'update',
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
function stoppedAfter(
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

/** The ids of a live object's records, sorted. */
function liveIds(org: MemoryRestoreOrg, objectApiName: string): string[] {
  return org
    .all(objectApiName)
    .map((row) => row.Id)
    .sort();
}

/** A read of the org's automation that sends nothing, finding what `found` says. */
function automationOf(
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
async function undone(t: Taken, rewindId: string) {
  const held = t.store.lock(ORG_ID, 'undo');
  if (!('lock' in held)) throw new Error('the org’s lock is held');
  clock += 60_000;
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

describe('rewindOrg: what a pass writes, in its order', () => {
  /** An opportunity whose price book changed since, as a product was added under it. */
  function heldInPlace(org: RewindTestOrg): void {
    clock = SINCE;
    org.edit('Opportunity', opportunity(1), { Pricebook2Id: book(2) }, COLLEAGUE);
    org.add('OpportunityLineItem', {
      Id: line(1),
      Quantity: 1,
      OpportunityId: opportunity(1),
      LastModifiedById: COLLEAGUE,
    });
  }

  it('gives back once its deletes are through a value a record it deletes held in place (gate G1)', async () => {
    const t = await taken();
    t.org.heldByChildren.push(PRICE_BOOK_HELD);
    heldInPlace(t.org);
    const diff = await previewed(t);

    const result = resultOf(await rewound(t, diff.previewId, { request: { acceptNoUndo: true } }));

    expect(result.status).toBe('success');
    expect(stateOf(t.org).live).toEqual(t.atCheckpoint.live);
    // In the pass that deleted the product: no second pass was needed for it.
    expect(result.passes).toBe(1);
    expect(result.restored).toEqual([
      expect.objectContaining({
        objectApiName: 'Opportunity',
        planned: 1,
        restored: 1,
        refused: 0,
      }),
    ]);
    expect(result.undo?.cannot).toEqual([{ objectApiName: 'OpportunityLineItem', count: 1 }]);
    // The product went first, then the price book was given back, once.
    expect(t.org.deletes.map(({ ids }) => ids)).toEqual([[line(1)]]);
    expect(t.org.updates).toEqual([
      { objectApiName: 'Opportunity', records: [{ Id: opportunity(1), Pricebook2Id: book(1) }] },
    ]);
  });

  it('says what a record given back after the deletes waited for when the org still refuses it', async () => {
    const t = await taken();
    t.org.heldByChildren.push(PRICE_BOOK_HELD);
    heldInPlace(t.org);
    const diff = await previewed(t);
    t.org.beforeDelete = () =>
      t.org.refuseUpdate.set(opportunity(1), {
        statusCode: 'UNABLE_TO_LOCK_ROW',
        message: 'locked',
      });

    const result = resultOf(await rewound(t, diff.previewId, { request: { acceptNoUndo: true } }));

    const waited =
      'Opportunity: given back once the OpportunityLineItem records hanging from it that the ' +
      'rewind deletes were gone, as those records held some of its values in place';
    expect(result.status).toBe('partial');
    expect(result.residual).toEqual([
      {
        objectApiName: 'Opportunity',
        reason: 'refused',
        count: 1,
        ids: [opportunity(1)],
        message: `UNABLE_TO_LOCK_ROW: locked — ${waited}`,
      },
    ]);
    expect(result.restored[0].reasons).toEqual(['UNABLE_TO_LOCK_ROW: locked', waited]);
  });

  it('keeps, of a record given back after the deletes, the values it held before the rewind wrote anything: Undo gives those back', async () => {
    const t = await taken();
    t.org.heldByChildren.push(PRICE_BOOK_HELD);
    heldInPlace(t.org);
    t.org.edit('Opportunity', opportunity(1), { Name: 'Deal, changed' }, COLLEAGUE);
    const before = stateOf(t.org);
    const diff = await previewed(t);
    // The org's automation renames the opportunity as its product goes.
    t.org.beforeDelete = () => {
      t.org.beforeDelete = undefined;
      t.org.edit('Opportunity', opportunity(1), { Name: 'Recalculated' }, AUTOMATED_PROCESS);
    };

    const result = resultOf(await rewound(t, diff.previewId, { request: { acceptNoUndo: true } }));
    expect(result.status).toBe('success');
    await undone(t, result.rewindId);

    // The product the rewind deleted stays in the bin, as the preview said
    // Undo couldn't bring it back; the opportunity holds what it held before.
    expect(stateOf(t.org).live.Opportunity).toEqual(before.live.Opportunity);
  });

  it('names the children the bin holds of a record before it brings the record back, and holds what it brought back as its own whoever the org names their last modifier', async () => {
    for (const facts of factCombinations(['undeleterIsLastModifier'])) {
      const t = await taken(baseRecords, new RewindTestOrg({ facts }));
      changedSince(t.org);
      const diff = await previewed(t);
      const said = JSON.stringify(facts);

      const result = resultOf(await rewound(t, diff.previewId));

      expect(result.status, said).toBe('success');
      expect(result.residual, said).toEqual([]);
      expect(
        t.org.all('Account').find((row) => row.Id === account(2)),
        said,
      ).toMatchObject({ Industry: 'Energy' });
      const kinds = journalKinds(t.folder, result.rewindId);
      expect(kinds.indexOf('withParent'), said).toBeGreaterThan(0);
      expect(kinds.indexOf('withParent'), said).toBeLessThan(kinds.indexOf('bringingBack'));
      const journal = await readRewindJournal(t.folder, result.rewindId);
      expect(journal.did.broughtBack, said).toEqual([
        { objectApiName: 'Contact', ids: [contact(1), contact(2)] },
        { objectApiName: 'Account', ids: [account(2)] },
      ]);
    }
  });

  it('gives an order activated since that was Draft at the checkpoint its status back first, alone', async () => {
    const t = await taken(
      (org) => {
        baseRecords(org);
        org.add('Order', { Id: order(1), Status: 'Draft', Description: 'As agreed' });
      },
      new RewindTestOrg(),
      [...PICKED, 'Order'],
    );
    clock = SINCE;
    t.org.edit('Order', order(1), { Status: 'Activated', Description: 'Changed' }, COLLEAGUE);
    const diff = await previewed(t);

    const result = resultOf(await rewound(t, diff.previewId));

    expect(result.status).toBe('success');
    expect(t.org.updates).toEqual([
      { objectApiName: 'Order', records: [{ Id: order(1), Status: 'Draft' }] },
      { objectApiName: 'Order', records: [{ Id: order(1), Description: 'As agreed' }] },
    ]);
  });

  it('never sends a person account’s name, which the org computes from its person’s', async () => {
    const personFlag = { name: 'IsPersonAccount', label: 'Is Person Account', type: 'boolean' };
    const fields = {
      ...FIELDS,
      Account: [
        ...STAMP_FIELDS,
        writable('Name'),
        writable('FirstName'),
        writable('LastName'),
        personFlag,
      ],
      Contact: [
        ...STAMP_FIELDS,
        writable('LastName'),
        writable('AccountId', 'reference', { referenceTo: ['Account'] }),
        personFlag,
      ],
    };
    const t = await taken((org) => {
      baseRecords(org);
      org.addPersonAccount(
        { Id: account(9), Name: 'Ada Lovelace', FirstName: 'Ada', LastName: 'Lovelace' },
        contact(9),
      );
    }, new RewindTestOrg({ fields }));
    clock = SINCE;
    t.org.edit('Account', account(9), { Name: 'Ada Byron', LastName: 'Byron' }, COLLEAGUE);
    const diff = await previewed(t);

    const result = resultOf(await rewound(t, diff.previewId));

    expect(t.org.updates).toEqual([
      { objectApiName: 'Account', records: [{ Id: account(9), LastName: 'Lovelace' }] },
    ]);
    expect(result.restored).toEqual([
      expect.objectContaining({ objectApiName: 'Account', restored: 1, refused: 0 }),
    ]);
    expect(result.restored[0].restoredWithout).toBeUndefined();
  });

  it('hands the give-back 2,000 records at most a call, and brings back 2,001 records deleted since', async () => {
    const count = 2_001;
    const t = await taken((org) => {
      baseRecords(org);
      for (let n = 0; n < count; n++) {
        org.add('Account', { Id: account(100 + n), Name: `Many ${n}`, Industry: 'Energy' });
        org.add('Contact', { Id: contact(100 + n), LastName: `Alone ${n}` });
      }
    });
    clock = SINCE;
    for (let n = 0; n < count; n++) {
      t.org.edit('Account', account(100 + n), { Industry: 'Retail' }, COLLEAGUE);
      t.org.trash('Contact', contact(100 + n), COLLEAGUE);
    }
    const diff = await previewed(t);

    const result = resultOf(await rewound(t, diff.previewId));

    expect(result.status).toBe('success');
    expect(result.restored).toEqual([
      expect.objectContaining({ objectApiName: 'Contact', planned: count, restored: count }),
      expect.objectContaining({ objectApiName: 'Account', planned: count, restored: count }),
    ]);
    expect(result.undeleted).toEqual([
      expect.objectContaining({ objectApiName: 'Contact', planned: count, undeleted: count }),
    ]);
    expect(stateOf(t.org).live).toEqual(t.atCheckpoint.live);
  }, 60_000);
});

describe('rewindOrg: the second pass and the verify', () => {
  it('deletes in a second pass what came back with a parent it brought back and what its own automation made in answer to the first', async () => {
    const t = await taken();
    clock = SINCE;
    t.org.add('Contact', {
      Id: contact(5),
      LastName: 'Made since',
      AccountId: account(2),
      LastModifiedById: COLLEAGUE,
    });
    t.org.trash('Account', account(2), COLLEAGUE);
    const diff = await previewed(t);
    let answered = false;
    const undelete = async (ids: string[]): Promise<unknown> => {
      const answer = await t.org.undelete(ids);
      if (!answered) {
        answered = true;
        t.org.add('Account', {
          Id: account(6),
          Name: 'Made by a flow',
          LastModifiedById: AUTOMATED_PROCESS,
        });
      }
      return answer;
    };

    const result = resultOf(await rewound(t, diff.previewId, { deps: { undelete } }));

    expect(result.status).toBe('success');
    expect(result.passes).toBe(2);
    expect(stateOf(t.org).live).toEqual(t.atCheckpoint.live);
    expect(
      result.deleted.map(({ objectApiName, planned, deleted }) => [
        objectApiName,
        planned,
        deleted,
      ]),
    ).toEqual([
      ['Contact', 1, 1],
      ['Account', 1, 1],
    ]);
  });

  it('counts a record the second pass gave back once, by its last outcome, when the first was refused', async () => {
    const t = await taken();
    changedSince(t.org);
    const diff = await previewed(t);
    t.org.refuseUpdate.set(account(1), { statusCode: 'UNABLE_TO_LOCK_ROW', message: 'locked' });

    const result = resultOf(
      await rewound(t, diff.previewId, {
        deps: {
          onProgress: ({ pass }) => {
            if (pass === 2) t.org.refuseUpdate.clear();
          },
        },
      }),
    );

    expect(result.status).toBe('success');
    expect(result.passes).toBe(2);
    expect(result.restored.find((object) => object.objectApiName === 'Account')).toMatchObject({
      planned: 2,
      restored: 2,
      refused: 0,
    });
  });

  it('counts a record the second pass deleted or brought back once, by its last outcome, when the first was refused', async () => {
    const t = await taken();
    changedSince(t.org);
    const diff = await previewed(t);
    t.org.refuse.set(account(4), 'locked by a colleague');
    let refusing = true;
    const undelete = (ids: string[]): Promise<unknown> =>
      refusing
        ? Promise.resolve(
            ids.map((id) => ({
              id,
              success: false,
              errors: [{ statusCode: 'UNDELETE_FAILED', message: 'locked' }],
            })),
          )
        : t.org.undelete(ids);

    const result = resultOf(
      await rewound(t, diff.previewId, {
        deps: {
          undelete,
          onProgress: ({ pass }) => {
            if (pass !== 2) return;
            refusing = false;
            t.org.refuse.clear();
          },
        },
      }),
    );

    expect(result.status).toBe('success');
    expect(result.passes).toBe(2);
    expect(stateOf(t.org).live).toEqual(t.atCheckpoint.live);
    expect(
      result.deleted.map(({ objectApiName, planned, deleted, refused }) => [
        objectApiName,
        planned,
        deleted,
        refused,
      ]),
    ).toEqual([
      ['Contact', 1, 1, 0],
      ['Account', 2, 2, 0],
    ]);
    expect(result.undeleted).toEqual([
      expect.objectContaining({ objectApiName: 'Account', planned: 1, undeleted: 1, refused: 0 }),
    ]);
    expect(
      result.restored.map(({ objectApiName, planned, restored, alreadyGone }) => [
        objectApiName,
        planned,
        restored,
        alreadyGone,
      ]),
    ).toEqual([
      ['Contact', 2, 2, 0],
      ['Account', 2, 2, 0],
    ]);
  });

  it('leaves as they made them the records another user changed during the rewind, names who, and ends unstable', async () => {
    const t = await taken();
    changedSince(t.org);
    t.org.edit('Account', account(3), { Industry: 'Retail' }, COLLEAGUE);
    const diff = await previewed(t);
    let changed = false;
    const undelete = async (ids: string[]): Promise<unknown> => {
      if (!changed) {
        changed = true;
        t.org.edit('Account', account(3), { Industry: 'Mining' }, COLLEAGUE);
      }
      return t.org.undelete(ids);
    };

    const result = resultOf(await rewound(t, diff.previewId, { deps: { undelete } }));

    expect(result.status).toBe('unstable');
    expect(result.residual).toEqual([
      {
        objectApiName: 'Account',
        reason: 'changedDuringRewind',
        by: COLLEAGUE,
        count: 1,
        ids: [account(3)],
      },
    ]);
    expect(t.org.all('Account').find((row) => row.Id === account(3))).toMatchObject({
      Industry: 'Mining',
    });
    expect(t.org.all('Account').find((row) => row.Id === account(1))).toMatchObject({
      Name: 'Account one',
    });
  });

  it('acts on what the user confirmed and names what changed since the preview, without going on for it', async () => {
    const t = await taken();
    changedSince(t.org);
    const diff = await previewed(t);
    clock = PREVIEWED + 10_000;
    t.org.add('Account', {
      Id: account(7),
      Name: 'Since the preview',
      LastModifiedById: COLLEAGUE,
    });

    const result = resultOf(await rewound(t, diff.previewId));

    expect(result.status).toBe('partial');
    expect(result.residual).toEqual([
      { objectApiName: 'Account', reason: 'changedSincePreview', count: 1, ids: [account(7)] },
    ]);
    expect(liveIds(t.org, 'Account')).toContain(account(7));
    expect(result.passes).toBe(1);
  });

  it('brings back a record deleted while the checkpoint was taken, and never names it once it is back', async () => {
    const org = new RewindTestOrg();
    org.onSnapshotRead = (soql) => {
      if (/ FROM Account\b/.test(soql) && org.all('Account').some((row) => row.Id === account(3))) {
        org.trash('Account', account(3), COLLEAGUE);
      }
    };
    const t = await taken(baseRecords, org);
    const diff = await previewed(t);
    expect(diff.objects).toEqual([
      expect.objectContaining({
        objectApiName: 'Account',
        toBringBack: { inBin: 0, withParent: 0, deletedWhileTaken: 1 },
      }),
    ]);

    const result = resultOf(await rewound(t, diff.previewId));

    expect(result.status).toBe('success');
    expect(result.residual).toEqual([]);
    expect(liveIds(t.org, 'Account')).toContain(account(3));
    expect(result.undeleted).toEqual([
      expect.objectContaining({ objectApiName: 'Account', undeleted: 1 }),
    ]);
  });

  it('converges, or names every record that still differs, under every hypothesis the probes left about stamps, cascades and cleared lookups', async () => {
    const combinations = factCombinations([
      'deleteStamps',
      'childDeletedAloneStays',
      'undeleterIsLastModifier',
      'clearedLookupRestamps',
      'undeleteRestoresLookups',
    ]);
    for (const facts of combinations) {
      const t = await taken(baseRecords, new RewindTestOrg({ facts }));
      changedSince(t.org);
      const diff = await previewed(t);
      const said = JSON.stringify(facts);

      const result = resultOf(await rewound(t, diff.previewId));

      expect(result.status, said).not.toBe('unstable');
      const named = new Set(result.residual.flatMap(({ ids }) => ids));
      const now = stateOf(t.org).live;
      for (const [objectApiName, rows] of Object.entries(t.atCheckpoint.live)) {
        const held = new Map(
          (rows as Array<{ Id: string }>).map((row) => [row.Id, JSON.stringify(row)]),
        );
        const live = new Map(
          (now[objectApiName] as Array<{ Id: string }>).map((row) => [row.Id, JSON.stringify(row)]),
        );
        for (const record of new Set([...held.keys(), ...live.keys()])) {
          if (held.get(record) === live.get(record)) continue;
          expect({ said, record, named: named.has(record) }).toEqual({ said, record, named: true });
        }
      }
    }
  }, 60_000);
});

describe('rewindOrg: what it refuses before it writes', () => {
  /** Nothing was written to the org: no update, no delete, no undelete, no journal. */
  function untouched(t: Taken, before: OrgState): void {
    expect(t.org.updates).toEqual([]);
    expect(t.org.deletes).toEqual([]);
    expect(stateOf(t.org)).toEqual(before);
    expect(existsSync(t.folder.rewindsDir) ? readdirSync(t.folder.rewindsDir) : []).toEqual([]);
  }

  it('refuses a production org with the guard’s words, having read nothing but what the guard asked', async () => {
    const t = await taken();
    changedSince(t.org);
    const diff = await previewed(t);
    t.org.edit('Organization', ORG_ID, { OrganizationType: 'Enterprise Edition' });
    const before = stateOf(t.org);
    const asked = spent(t.org);

    const outcome = await rewound(t, diff.previewId);

    expect(outcome).toMatchObject({ rewound: false, refusal: { code: 'PRODUCTION' } });
    expect(spent(t.org) - asked).toBe(2);
    untouched(t, before);
  });

  it('refuses while a take, a rewind or an undo of the org holds its lock, or a run writes to it', async () => {
    const t = await taken();
    changedSince(t.org);
    const diff = await previewed(t);
    const before = stateOf(t.org);
    const held = t.store.lock(ORG_ID, 'take');
    if (!('lock' in held)) throw new Error('the org’s lock is held');
    try {
      expect(await rewound(t, diff.previewId)).toMatchObject({
        rewound: false,
        refusal: {
          code: 'RUN_WRITING',
          message: expect.stringMatching(/^A checkpoint of DEV-ED is being taken/) as unknown,
        },
      });
    } finally {
      held.lock.release();
    }
    expect(
      await rewound(t, diff.previewId, {
        deps: { runWriting: () => 'A Sync run is writing to DEV-ED.' },
      }),
    ).toEqual({
      rewound: false,
      refusal: { code: 'RUN_WRITING', message: 'A Sync run is writing to DEV-ED.' },
    });
    untouched(t, before);
  });

  it('refuses to delete records Undo couldn’t bring back unless that was accepted', async () => {
    const t = await taken();
    clock = SINCE;
    t.org.add('OpportunityLineItem', {
      Id: line(1),
      Quantity: 1,
      OpportunityId: opportunity(1),
      LastModifiedById: COLLEAGUE,
    });
    const diff = await previewed(t);
    const before = stateOf(t.org);

    const outcome = await rewound(t, diff.previewId);

    expect(outcome).toEqual({
      rewound: false,
      refusal: {
        code: 'NO_UNDO',
        message:
          "Undo couldn't bring back 1 OpportunityLineItem record(s) this rewind deletes: " +
          'Salesforce undeletes them only with their parent, which stays. Rewind refused; ' +
          "accept that Undo couldn't bring them back to rewind all the same. No record was " +
          'written.',
      },
    });
    untouched(t, before);
    const accepted = resultOf(
      await rewound(t, diff.previewId, { request: { acceptNoUndo: true } }),
    );
    expect(accepted.status).toBe('success');
    expect(liveIds(t.org, 'OpportunityLineItem')).toEqual([]);
  });

  it('refuses when the org runs automation as it writes, or cannot say what it runs, unless accepted', async () => {
    const t = await taken();
    changedSince(t.org);
    const diff = await previewed(t);
    const before = stateOf(t.org);
    const blind = automationOf({ unread: [{ part: 'flows', reason: 'Tooling API timed out' }] });

    const outcome = await rewound(t, diff.previewId, { deps: { readAutomation: blind } });

    expect(outcome).toMatchObject({ rewound: false, refusal: { code: 'AUTOMATION' } });
    untouched(t, before);
    const accepted = await rewound(t, diff.previewId, {
      deps: { readAutomation: blind },
      request: { acceptAutomation: true },
    });
    expect(resultOf(accepted).status).toBe('success');
  });

  it('refuses a rewind that would take more requests than the org has left today', async () => {
    const t = await taken();
    changedSince(t.org);
    const diff = await previewed(t);
    const before = stateOf(t.org);
    t.org.limits = { Max: 15_000, Remaining: 30 };

    const outcome = await rewound(t, diff.previewId);

    expect(outcome).toMatchObject({
      rewound: false,
      refusal: {
        code: 'API_BUDGET',
        message: expect.stringMatching(
          /^This rewind takes about \d+ API requests; DEV-ED has 30 of its 15000 left today/,
        ) as unknown,
      },
    });
    untouched(t, before);
  });
});

describe('rewindOrg: stopped, and taken up again', () => {
  it('stopped at any call, leaves its journal open; the next rewind takes it up, sends again nothing it did, ends where a whole rewind ends, and Undo returns the org to how it was before the first pass', async () => {
    // How many calls a whole rewind of the scenario sends.
    const whole = await taken();
    changedSince(whole.org);
    const wholeDiff = await previewed(whole);
    const calls = resultOf(await rewound(whole, wholeDiff.previewId)).apiRequests.used;
    expect(calls).toBeGreaterThan(20);

    for (let at = 1; at <= calls; at++) {
      const t = await taken();
      changedSince(t.org);
      const beforeRewind = stateOf(t.org);
      const diff = await previewed(t);
      const controller = new AbortController();
      const stopping = stoppedAfter(t.org, at, controller);
      let first: RewindOutcome | undefined;
      try {
        first = await rewound(t, diff.previewId, {
          deps: {
            org: stopping,
            undelete: (ids) => stopping.undelete(ids),
            signal: controller.signal,
          },
        });
      } catch (err: unknown) {
        expect(err, `at ${at}`).toBeInstanceOf(RewindStopped);
      }
      if (first?.rewound) expect(first.result.status, `at ${at}`).toMatch(/^(cancelled|success)$/);

      const again = resultOf(await rewound(t, diff.previewId));

      expect(again.status, `at ${at}`).toBe('success');
      expect(stateOf(t.org).live, `at ${at}`).toEqual(t.atCheckpoint.live);
      expect(readdirSync(t.folder.rewindsDir), `at ${at}`).toEqual([again.rewindId]);
      // A record is deleted once, whatever pass or rewind deleted it.
      const deleted = t.org.deletes.flatMap(({ ids }) => ids);
      expect(new Set(deleted).size, `at ${at}`).toBe(deleted.length);

      const undo = await undone(t, again.rewindId);
      expect(undo.status, `at ${at}`).toBe('success');
      expect(stateOf(t.org), `at ${at}`).toEqual(beforeRewind);
    }
  }, 180_000);

  it('holds the org’s lock for its whole length, and lets it go once over', async () => {
    const t = await taken();
    changedSince(t.org);
    const diff = await previewed(t);
    const busy: boolean[] = [];

    resultOf(
      await rewound(t, diff.previewId, {
        deps: {
          onProgress: () => {
            const other = t.store.lock(ORG_ID, 'take');
            busy.push('busy' in other);
            if ('lock' in other) other.lock.release();
          },
        },
      }),
    );

    expect(busy.length).toBeGreaterThan(2);
    expect(busy.every(Boolean)).toBe(true);
    const after = t.store.lock(ORG_ID, 'take');
    expect('lock' in after).toBe(true);
    if ('lock' in after) after.lock.release();
  });
});

describe('rewindOrg: what it costs', () => {
  it('sends the org no more requests than the estimate its preview gave, every relationship read having records pointing through it, and counts them as the org does', async () => {
    const t = await taken((org) => {
      baseRecords(org);
      org.add('Opportunity', {
        Id: opportunity(2),
        Name: 'Deal two',
        AccountId: account(2),
        Pricebook2Id: book(1),
      });
    });
    clock = SINCE;
    t.org.edit('Account', account(1), { Name: 'Renamed' }, COLLEAGUE);
    t.org.add('Account', { Id: account(4), Name: 'New one', LastModifiedById: COLLEAGUE });
    t.org.add('Contact', {
      Id: contact(4),
      LastName: 'New',
      AccountId: account(4),
      LastModifiedById: COLLEAGUE,
    });
    t.org.add('Opportunity', {
      Id: opportunity(4),
      Name: 'New deal',
      AccountId: account(4),
      LastModifiedById: COLLEAGUE,
    });
    t.org.add('OpportunityLineItem', {
      Id: line(4),
      Quantity: 2,
      OpportunityId: opportunity(4),
      LastModifiedById: COLLEAGUE,
    });
    t.org.trash('Account', account(2), COLLEAGUE);
    clock = PREVIEWED;
    const preview = await previewCheckpoint({ org: t.org, store: t.store }, request(t));
    if (!preview.previewed) throw new Error(preview.refusal.message);
    const asked = spent(t.org);

    const result = resultOf(await rewound(t, preview.diff.previewId));

    expect(result.status).toBe('success');
    expect(stateOf(t.org).live).toEqual(t.atCheckpoint.live);
    expect(result.apiRequests.used).toBe(spent(t.org) - asked);
    expect(result.apiRequests.used).toBeLessThanOrEqual(preview.estimate.apiRequests);
    expect(result.apiRequests.leftToday).toBe(14_000 - result.apiRequests.used);
  });

  it('sends exactly what the estimate counts when there is nothing to write: the guard, the limits and the fresh read', async () => {
    const t = await taken();
    clock = PREVIEWED;
    const preview = await previewCheckpoint({ org: t.org, store: t.store }, request(t));
    if (!preview.previewed) throw new Error(preview.refusal.message);
    const asked = spent(t.org);

    const result = resultOf(await rewound(t, preview.diff.previewId));

    expect(result.status).toBe('success');
    expect(result.undo).toBeUndefined();
    expect(spent(t.org) - asked).toBe(preview.estimate.apiRequests);
    expect(existsSync(t.folder.rewindsDir) ? readdirSync(t.folder.rewindsDir) : []).toEqual([]);
  });
});

describe('inRewindWords', () => {
  it('words what a rewind leaves as left as it is, never as the run wrote it', () => {
    expect(
      inRewindWords(
        'Opportunity.StageName: the value from before is no longer taken (bad value) — left as ' +
          'the run wrote it',
      ),
    ).toBe(
      "Opportunity.StageName: the checkpoint's value is no longer taken (bad value) — left as it is",
    );
    expect(inRewindWords('The values from before the run could not be read: timeout')).toBe(
      "The checkpoint's values could not be read: timeout",
    );
    expect(
      inRewindWords(
        'The user SandForge connects as may not delete Case records in this org: the 3 ' +
          'record(s) of the run stay, and were not sent.',
      ),
    ).toBe(
      'The user SandForge connects as may not delete Case records in this org: the 3 ' +
        'record(s) the rewind would delete stay, and were not sent.',
    );
    expect(inRewindWords('FIELD_INTEGRITY_EXCEPTION: no')).toBe('FIELD_INTEGRITY_EXCEPTION: no');
  });

  it('names fifty ids of a residual at most, its count saying how many there are', () => {
    expect(REWIND_RESIDUAL_IDS).toBe(50);
  });
});

describe('rewindOrgOf', () => {
  it('reads and writes the org through the connection a take reads and a removal writes through', async () => {
    const calls: string[] = [];
    const page = { totalSize: 0, done: true, records: [] };
    const conn = {
      version: '66.0',
      request: (asked: { url: string }) => {
        calls.push(`request ${asked.url}`);
        return Promise.resolve({});
      },
      query: (soql: string, options?: { scanAll?: boolean }) => {
        calls.push(`query ${soql} ${options?.scanAll === true ? 'all' : 'live'}`);
        return Promise.resolve(page);
      },
      queryMore: (url: string) => {
        calls.push(`more ${url}`);
        return Promise.resolve(page);
      },
      describe: (name: string) => {
        calls.push(`describe ${name}`);
        return Promise.resolve({});
      },
      describeGlobal: () => {
        calls.push('global');
        return Promise.resolve({ sobjects: [] });
      },
      sobject: (name: string) => ({
        update: () => {
          calls.push(`update ${name}`);
          return Promise.resolve([]);
        },
        destroy: () => {
          calls.push(`destroy ${name}`);
          return Promise.resolve([]);
        },
      }),
      soap: {
        getServerTimestamp: () => Promise.resolve({ timestamp: '2026-10-22T14:05:12.000Z' }),
        getUserInfo: () => Promise.resolve({ userId: MEMORY_ORG_USER }),
      },
      limitInfo: {},
    };
    const org = rewindOrgOf(conn as never);

    expect(org.version).toBe('66.0');
    await org.query('SELECT Id FROM Account', { scanAll: true });
    await org.queryMore('/services/data/v66.0/query/01g-2000');
    await org.queryDeleted('SELECT Id FROM Account WHERE IsDeleted = true');
    await org.describe('Account');
    await org.describeGlobal();
    await org.request({ method: 'GET', url: '/limits' });
    await org.update('Account', [{ Id: account(1) }]);
    await org.destroy('Account', [account(1)]);
    expect(await org.serverTime()).toBe('2026-10-22T14:05:12.000Z');
    expect(await org.userId()).toBe(MEMORY_ORG_USER);
    expect(calls).toEqual([
      'query SELECT Id FROM Account all',
      'more /services/data/v66.0/query/01g-2000',
      'query SELECT Id FROM Account WHERE IsDeleted = true all',
      'describe Account',
      'global',
      'request /limits',
      'update Account',
      'destroy Account',
    ]);
  });
});
