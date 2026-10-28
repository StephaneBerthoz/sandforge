import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from 'jsforce';

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { MemoryFileOrg, fileId } from '../../test/memoryFileOrg.js';
import {
  MEMORY_ORG_USER,
  type MemoryChild,
  type MemoryOrgRequest,
} from '../../test/memoryRemovalOrg.js';
import { removalOrder } from '../forge/ForgeRunRemoval.js';
import {
  binFileOf,
  indexFileOf,
  openCheckpointStore,
  type CheckpointFolder,
  type OrgCheckpointStore,
} from './OrgCheckpointStore.js';
import { heldFileDocuments, heldFileLinks } from './checkpointFiles.js';
import { BYTES_PER_BIN_ID_KEPT, takeEstimate } from './rewindEstimate.js';
import { SnapshotIndex, compressedSnapshotFileOf, writeSnapshotIndex } from './snapshotIndex.js';
import { spooledRows } from './orgStreams.js';
import {
  CheckpointTakeStopped,
  DEFAULT_MAX_TOTAL,
  scopeCheckpoint,
  takeCheckpoint,
  takeOrgOf,
  type TakeDeps,
  type TakeOrg,
  type TakeOutcome,
  type TakeRequest,
} from './takeCheckpoint.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

// The index a take writes, the real one unless a test makes it miscount.
vi.mock('./snapshotIndex.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./snapshotIndex.js')>();
  return { ...actual, writeSnapshotIndex: vi.fn(actual.writeSnapshotIndex) };
});

/*
 * A take on the memory org the later bricks run on: its guard, its scope,
 * the moment it is of, the recycle bin as it was then, the snapshot read by
 * a DataOps handler bound to the checkpoint's folder, children first, each
 * object's index, and what moved while it read. The org's clock is the
 * test's; the handler's connection is the same org, every statement it is
 * sent recorded.
 */

const ORG_ID = '00D000000000001AAA';
const OTHER_ORG_ID = '00D000000000009AAA';
const AUTOMATED_PROCESS = '005000000000002AAA';

/** T0 on the org's clock, with its milliseconds. */
const T0 = Date.parse('2026-10-22T14:05:12.731Z');
/** Long before the checkpoint: the records the org held. */
const LONG_AGO = Date.parse('2026-10-01T09:00:00.000Z');
/** This machine's clock when the take runs. */
const MACHINE_NOW = new Date('2026-10-22T14:05:10.000Z');

let clock = T0;

function accountId(n: number): string {
  return `001${String(n).padStart(12, '0')}AAA`;
}
function contactId(n: number): string {
  return `003${String(n).padStart(12, '0')}AAA`;
}
function caseId(n: number): string {
  return `500${String(n).padStart(12, '0')}AAA`;
}
function taskId(n: number): string {
  return `00T${String(n).padStart(12, '0')}AAA`;
}

/** The audit fields and the id, as the org describes them: no one writes them. */
const STAMP_FIELDS = [
  { name: 'Id', type: 'id', permissionable: false },
  { name: 'SystemModstamp', type: 'datetime', permissionable: false },
  { name: 'CreatedDate', type: 'datetime', permissionable: false },
  { name: 'CreatedById', type: 'reference', referenceTo: ['User'], permissionable: false },
  { name: 'LastModifiedDate', type: 'datetime', permissionable: false },
  { name: 'LastModifiedById', type: 'reference', referenceTo: ['User'], permissionable: false },
  { name: 'IsDeleted', type: 'boolean', permissionable: false },
];

function writable(name: string, type = 'string', extra: Record<string, unknown> = {}) {
  return { name, type, createable: true, updateable: true, nillable: true, ...extra };
}

/** What the org describes of each object it lists. */
const FIELDS: Record<string, unknown[]> = {
  Account: [
    ...STAMP_FIELDS,
    writable('Name'),
    { name: 'BillingAddress', type: 'address' },
    { name: 'Rating_Formula__c', type: 'string', calculated: true },
    writable('Secret__c', 'encryptedstring'),
    { name: 'Hidden__c', type: 'string', createable: false, updateable: false },
  ],
  Contact: [
    ...STAMP_FIELDS,
    writable('LastName'),
    writable('AccountId', 'reference', { referenceTo: ['Account'] }),
  ],
  Case: [
    ...STAMP_FIELDS,
    writable('Subject'),
    writable('AccountId', 'reference', { referenceTo: ['Account'] }),
    writable('ContactId', 'reference', { referenceTo: ['Contact'] }),
  ],
  Task: [...STAMP_FIELDS, writable('Subject')],
  Lead: [...STAMP_FIELDS, writable('LastName')],
};

/** Who points at whom: a case's account refuses its delete while the case lives, as seen live. */
const CHILDREN: Record<string, MemoryChild[]> = {
  Account: [
    { childSObject: 'Contact', field: 'AccountId' },
    { childSObject: 'Case', field: 'AccountId', restrictedDelete: true },
    // An account's attachments go with it, and come back with it (P-A9).
    { childSObject: 'Attachment', field: 'ParentId', cascadeDelete: true },
  ],
  Contact: [{ childSObject: 'Case', field: 'ContactId' }],
};

/** The data objects described above, as the org lists them. */
const DATA_OBJECTS: Record<string, Record<string, unknown>> = {
  Account: {},
  Case: {},
  Contact: {},
  Lead: {},
  Task: {},
};

/** The objects of files, as a scratch org's global describe lists them (FA1, FA2, FA10). */
const FILE_OBJECTS: Record<string, Record<string, unknown>> = {
  ContentDocument: { createable: false, keyPrefix: '069' },
  ContentDocumentLink: { keyPrefix: '06A' },
  ContentVersion: { deletable: false, keyPrefix: '068' },
  Attachment: { layoutable: false, keyPrefix: '00P' },
  Document: { layoutable: false, keyPrefix: '015' },
};

/** The prefixes of the data objects' ids, as the global describe gives them. */
const KEY_PREFIXES: Record<string, string> = {
  Account: '001',
  Contact: '003',
  Case: '500',
  Task: '00T',
  Lead: '00Q',
};

/** What the org describes of the objects of files a checkpoint describes. */
const FILE_FIELDS: Record<string, unknown[]> = {
  ContentDocument: [
    ...STAMP_FIELDS,
    writable('Title', 'string', { createable: false }),
    writable('Description', 'textarea', { createable: false }),
    writable('OwnerId', 'reference', { createable: false, referenceTo: ['User'] }),
    writable('SharingPrivacy', 'picklist', { createable: false }),
    writable('SharingOption', 'picklist', { createable: false }),
    writable('ParentId', 'reference', { createable: false, referenceTo: ['ContentWorkspace'] }),
    { name: 'LatestPublishedVersionId', type: 'reference', permissionable: false },
    { name: 'ContentSize', type: 'int', permissionable: false },
  ],
  ContentDocumentLink: [
    { name: 'Id', type: 'id', permissionable: false },
    {
      name: 'LinkedEntityId',
      type: 'reference',
      createable: true,
      referenceTo: ['Account', 'Contact', 'Case', 'User', 'ContentWorkspace'],
    },
    { name: 'ContentDocumentId', type: 'reference', createable: true },
    { name: 'IsDeleted', type: 'boolean', permissionable: false },
    { name: 'SystemModstamp', type: 'datetime', permissionable: false },
    writable('ShareType', 'picklist'),
    writable('Visibility', 'picklist'),
  ],
  Attachment: [
    ...STAMP_FIELDS,
    writable('Name'),
    writable('ParentId', 'reference', { referenceTo: ['Account', 'Contact', 'Case'] }),
    writable('Body', 'base64'),
    writable('IsPrivate', 'boolean'),
  ],
};

/** The objects the org lists, beyond the data objects described above. */
const LISTED_ELSEWHERE: Record<string, Record<string, unknown>> = {
  FeedItem: {},
  Config__c: { customSetting: true },
  User: {},
};

/**
 * The rows of a page the memory org answers, as a scratch org answered them
 * (P-D2): 1,000 to a statement of a snapshot's width — 49 columns of
 * contacts — where 2,000 were asked, and the 2,000 asked to a narrow one, of
 * ids and stamps. Where between 5 columns and 49 the org starts shortening
 * its pages nothing measured; a snapshot's statement names its six stamps
 * and a value at least.
 */
function pageRowsOf(_page: number, soql: string): number {
  const select = /^SELECT (.+?) FROM /i.exec(soql)?.[1] ?? '';
  return select.split(',').length > 6 ? 1_000 : 2_000;
}

/**
 * The memory org as a take reads it: its global describe lists what a test
 * says, with the rights of a user who may write everything, and it answers
 * `/limits`. Every statement and call it is sent is recorded. It holds files
 * as the probes saw a scratch org hold them (`memoryFileOrg.ts`).
 */
class TakeTestOrg extends MemoryFileOrg implements TakeOrg {
  limits = { Max: 15_000, Remaining: 14_000 };
  readonly asked: string[] = [];
  /** Called with each call's path or statement before it is answered: what a test fails a call from. */
  failing?: (what: string) => Error | undefined;
  /**
   * The subrequests of a composite the org answers with an error of its own,
   * by their address: asked alone, they are answered.
   */
  refusedInComposite?: (url: string) => boolean;

  constructor(private readonly listed: Record<string, Record<string, unknown>>) {
    super(CHILDREN, { now: () => clock, pageSize: pageRowsOf });
    for (const [name, fields] of Object.entries({ ...FIELDS, ...FILE_FIELDS })) {
      this.changeSchema(name, fields);
    }
  }

  /** The Tooling API's global describe: a request, which lists no object here. */
  async toolingObjects(): Promise<string[]> {
    this.requests++;
    return [];
  }

  /** Every request the org answered, SOAP calls among them, the snapshot's handler's too. */
  requestsSent(): number {
    return this.requests + this.soapCalls;
  }

  override async describeGlobal(): Promise<unknown> {
    this.requests++;
    this.asked.push('describeGlobal');
    return {
      sobjects: Object.entries(this.listed).map(([name, extra]) => ({
        name,
        label: `${name} label`,
        queryable: true,
        createable: true,
        updateable: true,
        deletable: true,
        ...(KEY_PREFIXES[name] !== undefined ? { keyPrefix: KEY_PREFIXES[name] } : {}),
        ...extra,
      })),
    };
  }

  override async serverTime(): Promise<string> {
    this.asked.push('serverTime');
    return super.serverTime();
  }

  override async query(soql: string, options?: { scanAll?: boolean }) {
    this.asked.push(soql);
    const failure = this.failing?.(soql);
    if (failure) throw failure;
    return super.query(soql, options);
  }

  override async request(request: MemoryOrgRequest): Promise<unknown> {
    const body = typeof request.body === 'string' ? request.body : '';
    const what = `${request.method} ${request.url} ${body}`;
    this.asked.push(what);
    const failure = this.failing?.(what);
    if (failure) throw failure;
    if (request.method === 'GET' && request.url.endsWith('/limits')) {
      this.requests++;
      return { DailyApiRequests: this.limits };
    }
    const answer = await super.request(request);
    const refused = this.refusedInComposite;
    if (refused === undefined || request.method !== 'POST' || !request.url.endsWith('/composite')) {
      return answer;
    }
    const asked = (JSON.parse(body) as { compositeRequest: Array<{ url: string }> })
      .compositeRequest;
    const { compositeResponse } = answer as { compositeResponse: Array<Record<string, unknown>> };
    return {
      compositeResponse: compositeResponse.map((sub, at) =>
        refused(decodeURIComponent(asked[at].url))
          ? {
              ...sub,
              httpStatusCode: 500,
              body: [{ errorCode: 'UNKNOWN_EXCEPTION', message: 'An unexpected error occurred.' }],
            }
          : sub,
      ),
    };
  }
}

interface Harness {
  org: TakeTestOrg;
  store: OrgCheckpointStore;
  root: string;
  /** What the snapshot's own handler sent the org, in order. */
  sent: Array<{ soql: string; scanAll: boolean }>;
  deps: TakeDeps;
  /** Called with each statement the snapshot's handler sends, before the org answers it. */
  before: (hook: (soql: string) => void) => void;
}

const dirs: string[] = [];

beforeEach(() => {
  clock = T0;
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.mocked(getJsforceConnection).mockReset();
  vi.mocked(writeSnapshotIndex).mockClear();
});

/** What the org says of itself and of its user. */
interface OrgSays {
  sandbox?: boolean;
  edition?: string;
  modifyAllData?: boolean;
  /** The Organization Id the snapshot's handler reads, when it reads another org's. */
  snapshotOrgId?: string;
}

function harness(
  says: OrgSays = {},
  listed: Record<string, Record<string, unknown>> = { ...DATA_OBJECTS, ...LISTED_ELSEWHERE },
): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-take-'));
  dirs.push(dir);
  const opened = openCheckpointStore({ root: join(dir, 'store'), locksDir: join(dir, 'locks') });
  if ('refusal' in opened) throw new Error(`no store: ${opened.refusal.reason}`);
  const org = new TakeTestOrg(listed);
  clock = LONG_AGO;
  org.add('Organization', {
    Id: ORG_ID,
    IsSandbox: says.sandbox ?? true,
    OrganizationType: says.edition ?? 'Enterprise Edition',
  });
  org.add('UserPermissionAccess', {
    Id: '0Up000000000001AAA',
    PermissionsViewAllData: true,
    PermissionsModifyAllData: says.modifyAllData ?? true,
    PermissionsViewEncryptedData: false,
  });
  org.add('User', { Id: AUTOMATED_PROCESS, UserType: 'AutomatedProcess' });
  clock = T0;

  const sent: Harness['sent'] = [];
  let hook: (soql: string) => void = () => undefined;
  vi.mocked(getJsforceConnection).mockResolvedValue({
    query: async (soql: string, options?: { scanAll?: boolean }) => {
      sent.push({ soql, scanAll: options?.scanAll === true });
      hook(soql);
      if (soql === 'SELECT Id FROM Organization') {
        // Answered here, as the org the handler reached says; a request all the same.
        org.requests++;
        return {
          totalSize: 1,
          done: true,
          records: [{ Id: says.snapshotOrgId ?? ORG_ID }],
        };
      }
      return org.query(soql, options);
    },
    queryMore: (nextRecordsUrl: string) => org.queryMore(nextRecordsUrl),
    describe: (objectApiName: string) => org.describe(objectApiName),
  } as never);

  const deps: TakeDeps = {
    org,
    store: opened.store,
    handler: {
      log: () => undefined,
      orgManager: { getOrg: () => ({ orgType: 'Sandbox' }) } as never,
      orgRegistry: {} as never,
    },
    now: () => MACHINE_NOW,
  };
  return {
    org,
    store: opened.store,
    root: join(dir, 'store'),
    sent,
    deps,
    before: (next) => {
      hook = next;
    },
  };
}

/** A take of the org, everything people work in, unless told otherwise. */
function request(extra: Partial<TakeRequest> = {}): TakeRequest {
  return {
    orgId: 'org-1',
    orgName: 'DEV-SB',
    alias: 'DEV-SB',
    username: 'tester@example.com',
    instanceUrl: 'https://example.my.salesforce.com',
    registered: { orgType: 'Sandbox' },
    mode: 'everything',
    ...extra,
  };
}

/** Records the org held long before the checkpoint. */
function seed(org: TakeTestOrg): void {
  clock = LONG_AGO;
  org.add('Account', { Id: accountId(1), Name: 'Northwind', Secret__c: '***', Hidden__c: 'x' });
  org.add('Account', { Id: accountId(2), Name: 'Contoso' });
  org.add('Contact', { Id: contactId(1), LastName: 'Ada', AccountId: accountId(1) });
  org.add('Contact', { Id: contactId(2), LastName: 'Grace', AccountId: accountId(1) });
  org.add('Contact', { Id: contactId(3), LastName: 'Hedy', AccountId: accountId(2) });
  org.add('Case', { Id: caseId(1), Subject: 'Broken', AccountId: accountId(1) });
  org.add('Task', { Id: taskId(1), Subject: 'Call back' });
  org.add('Task', { Id: taskId(2), Subject: 'Closed a year ago' });
  org.archive('Task', taskId(2));
  clock = T0;
}

function taken(outcome: TakeOutcome) {
  if (!outcome.taken) throw new Error(`refused: ${outcome.refusal.message}`);
  return outcome;
}

/** The checkpoints' folders of every org in the store: none once nothing was kept. */
function checkpointFolders(root: string): string[] {
  return readdirSync(root).flatMap((org) => readdirSync(join(root, org)));
}

/** The ids a bin file holds. */
async function idsIn(file: string): Promise<string[]> {
  const ids: string[] = [];
  for await (const row of spooledRows(file)) ids.push(String(row.Id));
  return ids;
}

/** The objects the snapshot's handler read, in the order it read them. */
function snapshotReads(sent: Harness['sent']): string[] {
  return sent
    .map(({ soql }) => /^SELECT .+ FROM (\w+)/.exec(soql)?.[1])
    .filter((object): object is string => object !== undefined && object !== 'Organization');
}

/** Whether a statement read records of an object: anything but the guard's, the user's and the counts. */
function readsRecords(asked: readonly string[]): string[] {
  return asked.filter((what) => {
    const read = decodeURIComponent(what);
    return (
      /IsDeleted = true|FROM ContentDocumentLink|SELECT Id, SystemModstamp/.test(read) &&
      !/COUNT\(\)/.test(read)
    );
  });
}

describe('takeCheckpoint — what it keeps', () => {
  it('keeps every record of every object people work in, read children first in the order a removal deletes them, with each object’s fields, read mode and index', async () => {
    const h = harness();
    seed(h.org);

    const outcome = taken(await takeCheckpoint(h.deps, request({ name: 'Before UAT' })));
    const { checkpoint } = outcome;

    expect(checkpoint.status).toBe('ready');
    expect(checkpoint.name).toBe('Before UAT');
    expect(checkpoint.objects.map((object) => [object.objectApiName, object.records])).toEqual([
      ['Case', 1],
      ['Contact', 3],
      ['Account', 2],
      ['Lead', 0],
      ['Task', 2],
    ]);
    expect(checkpoint.objects.map((object) => object.readOrder)).toEqual([0, 1, 2, 3, 4]);
    // What a rewind must delete before the account it points at, as the account lists it.
    expect(
      checkpoint.objects.map((object) => [object.objectApiName, object.restrictParents]),
    ).toEqual([
      ['Case', ['AccountId']],
      ['Contact', []],
      ['Account', []],
      ['Lead', []],
      ['Task', []],
    ]);
    const order = await removalOrder(
      h.org,
      checkpoint.objects.map(({ objectApiName }) => ({ objectApiName })),
    );
    expect(order.map(({ objectApiName }) => objectApiName)).toEqual(
      checkpoint.objects.map(({ objectApiName }) => objectApiName),
    );
    // The snapshot read them in that order, and never read the empty one.
    expect(snapshotReads(h.sent)).toEqual(['Case', 'Contact', 'Account', 'Task']);

    const account = checkpoint.objects.find((object) => object.objectApiName === 'Account');
    expect(account?.fields).toEqual([
      'Id',
      'SystemModstamp',
      'CreatedDate',
      'CreatedById',
      'LastModifiedDate',
      'LastModifiedById',
      'Name',
    ]);
    expect(account?.leftOutFields).toEqual([
      { field: 'BillingAddress', reason: 'compound' },
      { field: 'Secret__c', reason: 'encrypted' },
      { field: 'Hidden__c', reason: 'fls' },
    ]);
    expect(h.sent.find(({ soql }) => soql.includes('FROM Account'))?.soql).toBe(
      'SELECT Id, SystemModstamp, CreatedDate, CreatedById, LastModifiedDate, LastModifiedById, Name FROM Account',
    );
    // Tasks are read through the recycle bin, kept to the live ones: the archived one is held.
    expect(h.sent.find(({ soql }) => soql.includes('FROM Task'))).toEqual({
      soql: 'SELECT Id, SystemModstamp, CreatedDate, CreatedById, LastModifiedDate, LastModifiedById, Subject FROM Task WHERE (IsDeleted = false)',
      scanAll: true,
    });
    expect(checkpoint.objects.find((object) => object.objectApiName === 'Task')?.readMode).toBe(
      'scanAllLive',
    );

    const folder = h.store.folderOf(ORG_ID, checkpoint.checkpointId);
    const tasks = await SnapshotIndex.read(folder, checkpoint.snapshotId, 'Task');
    expect([tasks.has(taskId(1)), tasks.has(taskId(2))]).toEqual([true, true]);
    const leads = await SnapshotIndex.read(folder, checkpoint.snapshotId, 'Lead');
    expect(leads.size).toBe(0);
    // Every object's index matches what its read kept.
    for (const object of checkpoint.objects) {
      expect(
        (await SnapshotIndex.read(folder, checkpoint.snapshotId, object.objectApiName)).size,
      ).toBe(object.records);
    }
    expect(outcome.notChecked).toEqual([]);
  });

  it('keeps each object’s values compressed as they were read, never in a plain file, indexed in the second form row for row, an object counted empty as an empty file', async () => {
    const h = harness();
    seed(h.org);

    const { checkpoint } = taken(await takeCheckpoint(h.deps, request()));

    const folder = h.store.folderOf(ORG_ID, checkpoint.checkpointId);
    expect(readdirSync(join(folder.dir, 'backups')).sort()).toEqual(
      checkpoint.objects
        .map(({ objectApiName }) => `${checkpoint.snapshotId}__${objectApiName}.ndjson.gz`)
        .sort(),
    );
    for (const { objectApiName, records } of checkpoint.objects) {
      const file = compressedSnapshotFileOf(folder, checkpoint.snapshotId, objectApiName);
      const bytes = readFileSync(file);
      // An empty file is never inflated: zlib refuses one.
      const lines = bytes.length === 0 ? '' : gunzipSync(bytes).toString('utf8');
      expect(lines.split('\n').filter((line) => line !== '').length).toBe(records);
      expect(readFileSync(indexFileOf(folder, objectApiName)).toString('latin1', 0, 8)).toBe(
        'SFCKIDX2',
      );
      const index = await SnapshotIndex.read(folder, checkpoint.snapshotId, objectApiName);
      expect([index.format, index.size]).toEqual([2, records]);
    }
    expect(checkpoint.objects.find((object) => object.objectApiName === 'Lead')?.records).toBe(0);
  });

  it('says before it reads a record about the disk the compressed checkpoint then takes', async () => {
    const h = harness();
    seed(h.org);

    const outcome = taken(await takeCheckpoint(h.deps, request()));

    const { bytes } = outcome.checkpoint;
    expect(outcome.estimate.bytes).toBeGreaterThan(bytes * 0.5);
    expect(outcome.estimate.bytes).toBeLessThan(bytes * 1.5);
  });

  it('records the bytes its files take once its own file is written, the objects it lists among them', async () => {
    const h = harness();
    seed(h.org);

    const { checkpoint } = taken(await takeCheckpoint(h.deps, request()));

    const folder = h.store.folderOf(ORG_ID, checkpoint.checkpointId);
    const sizes = (dir: string): number =>
      readdirSync(dir, { withFileTypes: true }).reduce(
        (sum, entry) =>
          sum +
          (entry.isDirectory()
            ? sizes(join(dir, entry.name))
            : statSync(join(dir, entry.name)).size),
        0,
      );
    expect(checkpoint.bytes).toBe(sizes(folder.dir));
  });

  it('records the org as it said it is — a sandbox’s edition too — the user it read as and the Automated Process user, its moments on the org’s clock, and its expiry', async () => {
    const h = harness({ sandbox: true, edition: 'Enterprise Edition' });
    seed(h.org);

    const { checkpoint } = taken(await takeCheckpoint(h.deps, request()));

    expect(checkpoint.org).toEqual({
      organizationId: ORG_ID,
      alias: 'DEV-SB',
      username: 'tester@example.com',
      instanceUrl: 'https://example.my.salesforce.com',
      isSandbox: true,
      organizationType: 'Enterprise Edition',
      tier: 'sandbox',
    });
    expect(checkpoint.takenBy).toEqual({
      userId: MEMORY_ORG_USER,
      automatedProcessUserId: AUTOMATED_PROCESS,
      viewAllData: true,
      modifyAllData: true,
      queryAllFiles: false,
    });
    expect(checkpoint.readFrom).toBe(new Date(T0).toISOString());
    expect(checkpoint.takenAt).toBe(new Date(T0).toISOString());
    expect(checkpoint.name).toBe('2026-10-22 14:05 UTC');
    expect(checkpoint.expiresAt).toBe(
      new Date(MACHINE_NOW.getTime() + 30 * 24 * 60 * 60_000).toISOString(),
    );
    expect(checkpoint.takenOn.pid).toBe(process.pid);
    expect(checkpoint.ignoredFields).toEqual([]);
  });

  it('records a Developer Edition org by the edition the guard read, and keeps one until it is deleted when told 0 days', async () => {
    const h = harness({ sandbox: false, edition: 'Developer Edition' });
    seed(h.org);

    const { checkpoint } = taken(
      await takeCheckpoint(
        h.deps,
        request({
          registered: { orgType: 'Developer' },
          keepDays: 0,
          ignoredFields: ['Case.Subject'],
        }),
      ),
    );

    expect(checkpoint.org).toMatchObject({
      isSandbox: false,
      organizationType: 'Developer Edition',
      tier: 'developer',
    });
    expect(checkpoint.expiresAt).toBeNull();
    expect(checkpoint.ignoredFields).toEqual(['Case.Subject']);
    // The edition was the guard's: not asked again.
    expect(h.org.asked.filter((what) => what.startsWith('SELECT OrganizationType'))).toHaveLength(
      1,
    );
  });

  it('writes each object’s field prints to fingerprints.json.gz and the checkpoint last, both readable by their owner alone, and lists it as valid without contacting the org', async () => {
    const h = harness();
    seed(h.org);

    const { checkpoint } = taken(await takeCheckpoint(h.deps, request()));
    const folder = h.store.folderOf(ORG_ID, checkpoint.checkpointId);

    const prints = await h.store.readFingerprints(folder, checkpoint);
    expect([...prints.keys()].sort()).toEqual(['Account', 'Case', 'Contact', 'Lead', 'Task']);
    expect(prints.get('Account')?.fields).toHaveProperty('Secret__c');
    const raw = JSON.parse(readFileSync(folder.checkpointFile, 'utf8')) as Record<string, unknown>;
    expect(raw).not.toHaveProperty('fingerprints');
    // Windows keeps no POSIX modes: its user profile holds the files apart.
    if (process.platform !== 'win32') {
      for (const file of [
        folder.checkpointFile,
        folder.fingerprintsFile,
        binFileOf(folder, 'Account'),
      ]) {
        expect(statSync(file).mode & 0o777).toBe(0o600);
      }
      expect(statSync(folder.dir).mode & 0o777).toBe(0o700);
    }
    expect(checkpointFolders(h.root)).toEqual([checkpoint.checkpointId]);
    expect(checkpoint.bytes).toBeGreaterThan(0);

    const asked = h.org.requests;
    const [entry] = await h.store.list({ organizationId: ORG_ID, now: MACHINE_NOW });
    expect(entry).toMatchObject({ checkpointId: checkpoint.checkpointId, valid: true });
    expect(h.org.requests).toBe(asked);
    // Nothing of the take is left in its folder beside the checkpoint's own parts.
    expect(readdirSync(folder.dir).sort()).toEqual([
      'backups',
      'bin',
      'checkpoint.json',
      'fingerprints.json.gz',
      'index',
      'snapshots.json',
    ]);
  });
});

describe('takeCheckpoint — its moment and its progress', () => {
  it('reads T0 on the org’s clock before it counts the records, so an object counted empty is one read empty after T0, and T1 once every read is done', async () => {
    const h = harness();
    seed(h.org);

    taken(await takeCheckpoint(h.deps, request()));

    const asked = h.org.asked.map(decodeURIComponent);
    const clockReads = asked.flatMap((what, at) => (what === 'serverTime' ? [at] : []));
    const firstCount = asked.findIndex((what) => what.includes('SELECT COUNT() FROM'));
    const firstBin = asked.findIndex((what) =>
      what.includes('IsDeleted = true AND SystemModstamp <'),
    );
    expect(clockReads).toHaveLength(2);
    expect(clockReads[0]).toBeLessThan(firstCount);
    expect(firstCount).toBeLessThan(firstBin);
    // T1 follows the snapshot, whose reads go through the handler's own connection.
    expect(clockReads[1]).toBeGreaterThan(firstBin);
  });

  it('reports how far it is, the snapshot’s own progress among it, from the guard to the checkpoint taken', async () => {
    const h = harness();
    seed(h.org);
    const seen: Array<{ percentage: number; step: string }> = [];

    taken(
      await takeCheckpoint(
        { ...h.deps, onProgress: ({ percentage, step }) => seen.push({ percentage, step }) },
        request({ name: 'Before demo' }),
      ),
    );

    expect(seen[0]).toEqual({ percentage: 0, step: 'Checking DEV-SB' });
    expect(seen.at(-1)).toEqual({ percentage: 100, step: "Checkpoint 'Before demo' taken" });
    expect(seen.map(({ step }) => step)).toContain('Exported Account (2 records)');
    const percentages = seen.map(({ percentage }) => percentage);
    expect(percentages).toEqual([...percentages].sort((a, b) => a - b));
  });
});

describe('takeCheckpoint — the recycle bin at the checkpoint', () => {
  it('holds what was in the bin stamped before T0’s second: not a record deleted in that second before T0, nor one deleted after', async () => {
    const h = harness();
    seed(h.org);
    clock = LONG_AGO + 60_000;
    h.org.add('Account', { Id: accountId(7), Name: 'deleted long ago' });
    h.org.trash('Account', accountId(7));
    h.org.add('Account', { Id: accountId(8), Name: 'deleted in T0’s second' });
    h.org.add('Account', { Id: accountId(9), Name: 'deleted while taken' });
    // In T0's own second, before T0: stamped to T0's second, which the bin at
    // the checkpoint does not reach.
    clock = Math.floor(T0 / 1000) * 1000 + 200;
    h.org.trash('Account', accountId(8));
    clock = T0;
    h.before((soql) => {
      if (!soql.includes('FROM Case')) return;
      clock = T0 + 20_000;
      h.org.trash('Account', accountId(9));
    });

    const { checkpoint } = taken(await takeCheckpoint(h.deps, request()));
    const folder = h.store.folderOf(ORG_ID, checkpoint.checkpointId);

    expect(await idsIn(binFileOf(folder, 'Account'))).toEqual([accountId(7)]);
    expect(checkpoint.objects.find((object) => object.objectApiName === 'Account')?.inBin).toBe(1);
    expect(
      h.org.asked
        .map(decodeURIComponent)
        .find((what) => what.includes('IsDeleted = true AND SystemModstamp <')),
    ).toContain('SystemModstamp < 2026-10-22T14:05:12Z');
    // Both were live at T0 and are gone, the second deleted after its object
    // was read: each was deleted while the checkpoint was taken.
    expect(checkpoint.movedWhileTaken.deleted).toBe(2);
  });
});

describe('takeCheckpoint — what moved while it was taken', () => {
  it('counts the records changed, deleted and created after their object was read, and holds each as it was read', async () => {
    const h = harness();
    seed(h.org);
    // Contacts are read before Accounts: what happens to them while the
    // Accounts are read is after their read.
    h.before((soql) => {
      if (!soql.includes('FROM Account')) return;
      clock = T0 + 30_000;
      h.org.edit('Contact', contactId(1), { LastName: 'Ada (edited)' });
      h.org.trash('Contact', contactId(2));
      h.org.add('Contact', { Id: contactId(9), LastName: 'New', AccountId: accountId(2) });
      // Accounts are read after this: held as they are now, they did not
      // move while the take ran.
      h.org.edit('Account', accountId(1), { Name: 'Northwind (edited before its read)' });
      h.org.add('Account', { Id: accountId(9), Name: 'Read with the rest' });
    });

    const { checkpoint } = taken(await takeCheckpoint(h.deps, request()));

    expect(checkpoint.movedWhileTaken).toEqual({ changed: 1, deleted: 1, created: 1 });
    expect(checkpoint.takenAt).toBe(new Date(T0 + 30_000).toISOString());
    const folder = h.store.folderOf(ORG_ID, checkpoint.checkpointId);
    const contacts = await SnapshotIndex.read(folder, checkpoint.snapshotId, 'Contact');
    expect([contactId(1), contactId(2), contactId(9)].map((id) => contacts.has(id))).toEqual([
      true,
      true,
      false,
    ]);
    expect(checkpoint.objects.find((object) => object.objectApiName === 'Account')?.records).toBe(
      3,
    );
  });

  it('says it nothing moved when nothing did, without reading what moved in objects whose newest stamp is older', async () => {
    const h = harness();
    seed(h.org);

    const { checkpoint } = taken(await takeCheckpoint(h.deps, request()));

    expect(checkpoint.movedWhileTaken).toEqual({ changed: 0, deleted: 0, created: 0 });
    expect(
      h.org.asked
        .map(decodeURIComponent)
        .filter((what) => what.includes('SystemModstamp >=') && !what.includes('COUNT()')),
    ).toEqual([]);
  });
});

describe('takeCheckpoint — refused before anything is read', () => {
  it('refuses an org the registry has as a sandbox that says it is a production org, reading nothing of it but what it is', async () => {
    const h = harness({ sandbox: false, edition: 'Enterprise Edition' });
    seed(h.org);

    const outcome = await takeCheckpoint(h.deps, request());

    expect(outcome).toMatchObject({ taken: false, refusal: { code: 'PRODUCTION' } });
    expect(h.org.asked).toEqual([
      'SELECT Id, IsSandbox FROM Organization LIMIT 1',
      'SELECT OrganizationType FROM Organization LIMIT 1',
    ]);
    expect(checkpointFolders(h.root)).toEqual([]);
    expect(getJsforceConnection).not.toHaveBeenCalled();
  });

  it('refuses a user without Modify All Data before reading any object', async () => {
    const h = harness({ modifyAllData: false });
    seed(h.org);

    const outcome = await takeCheckpoint(h.deps, request());

    expect(outcome).toMatchObject({ taken: false, refusal: { code: 'PERMISSIONS' } });
    expect(h.org.asked).not.toContain('describeGlobal');
    expect(checkpointFolders(h.root)).toEqual([]);
  });

  it('refuses while a rewind of the org holds its lock, and while a SandForge run writes to it, then takes once both have ended', async () => {
    const h = harness();
    seed(h.org);
    const rewind = h.store.lock(ORG_ID, 'rewind');
    if (!('lock' in rewind)) throw new Error('not locked');

    const locked = await takeCheckpoint(h.deps, request());
    rewind.lock.release();
    let writing: string | undefined = 'A Sync run is writing to DEV-SB: take it once it has ended.';
    const busy = await takeCheckpoint({ ...h.deps, runWriting: () => writing }, request());
    writing = undefined;
    const later = await takeCheckpoint({ ...h.deps, runWriting: () => writing }, request());

    expect(locked).toMatchObject({ taken: false, refusal: { code: 'RUN_WRITING' } });
    expect(locked.taken ? '' : locked.refusal.message).toMatch(/^A rewind is writing to DEV-SB/);
    expect(busy).toEqual({
      taken: false,
      refusal: {
        code: 'RUN_WRITING',
        message: 'A Sync run is writing to DEV-SB: take it once it has ended.',
      },
    });
    expect(later.taken).toBe(true);
    expect(h.store.heldBy(ORG_ID)).toBeUndefined();
  });

  it('refuses more records than its limit before reading any of them, and leaves out an object past it alone, named', async () => {
    const h = harness();
    seed(h.org);
    clock = LONG_AGO;
    for (let n = 10; n < 40; n++) h.org.add('Account', { Id: accountId(n), Name: `Bulk ${n}` });
    clock = T0;

    const refused = await takeCheckpoint(h.deps, request({ maxTotal: 35 }));
    expect(refused).toMatchObject({ taken: false, refusal: { code: 'TOO_MANY_RECORDS' } });
    expect(refused.taken ? '' : refused.refusal.message).toContain('hold 38 records');
    expect(readsRecords(h.org.asked)).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(checkpointFolders(h.root)).toEqual([]);

    const { checkpoint } = taken(await takeCheckpoint(h.deps, request({ maxTotal: 20 })));
    expect(checkpoint.objects.map((object) => object.objectApiName)).not.toContain('Account');
    expect(checkpoint.scope.leftOut).toContainEqual({
      objectApiName: 'Account',
      reason:
        "Account has 32 records, past the checkpoint's limit of 20 for one object: left out of " +
        'the checkpoint, as part of it would be taken for all of it.',
    });
    expect(snapshotReads(h.sent)).not.toContain('Account');
  });

  it('refuses a take that would cost more API requests than the org has left today, before reading any record', async () => {
    const h = harness();
    seed(h.org);
    h.org.limits = { Max: 15_000, Remaining: 10 };

    const outcome = await takeCheckpoint(h.deps, request());

    expect(outcome).toMatchObject({ taken: false, refusal: { code: 'API_BUDGET' } });
    expect(outcome.taken ? '' : outcome.refusal.message).toMatch(
      /^This checkpoint takes about \d+ API requests; DEV-SB has 10 of its 15000 left today/,
    );
    expect(readsRecords(h.org.asked)).toEqual([]);
    expect(checkpointFolders(h.root)).toEqual([]);
  });
});

describe('takeCheckpoint — the scope', () => {
  it('leaves out Chatter, custom settings and setup, and an object the org refuses to read whole, each named, and takes the rest', async () => {
    const h = harness();
    seed(h.org);
    h.org.refuseRead.set('Lead', {
      errorCode: 'MALFORMED_QUERY',
      message: 'Implementation restriction: Lead requires a filter',
    });

    const { checkpoint } = taken(await takeCheckpoint(h.deps, request()));

    expect(checkpoint.objects.map((object) => object.objectApiName)).not.toContain('Lead');
    expect(checkpoint.scope.leftOut).toEqual([
      {
        objectApiName: 'Config__c',
        reason:
          'Custom settings are left out unless you pick them as custom settings: they are ' +
          'configuration, which a rewind sets back.',
      },
      {
        objectApiName: 'FeedItem',
        reason:
          'Chatter posts, comments and feeds are left out: Salesforce brings a post back only ' +
          'with what it was posted on.',
      },
      {
        objectApiName: 'Lead',
        reason:
          'Left out: the org refuses to read it whole (MALFORMED_QUERY: Implementation ' +
          'restriction: Lead requires a filter).',
      },
      { objectApiName: 'User', reason: 'Users, permissions and setup are left out.' },
    ]);
  });

  it('fails, keeping nothing, when a describe never reached the org, rather than leave the object out', async () => {
    const h = harness();
    seed(h.org);
    h.org.failing = (what) =>
      what.includes('sobjects/Case/describe') ? new Error('socket hang up') : undefined;

    await expect(takeCheckpoint(h.deps, request())).rejects.toThrow(
      'The org did not answer the describe of Case: socket hang up',
    );
    expect(checkpointFolders(h.root)).toEqual([]);
    expect(h.store.heldBy(ORG_ID)).toBeUndefined();
  });

  it('takes the objects picked, and only those', async () => {
    const h = harness();
    seed(h.org);

    const { checkpoint } = taken(
      await takeCheckpoint(
        h.deps,
        request({ mode: 'picked', objects: ['Contact', 'Account', 'Nope__c'] }),
      ),
    );

    expect(checkpoint.scope.mode).toBe('picked');
    expect(checkpoint.objects.map((object) => object.objectApiName)).toEqual([
      'Contact',
      'Account',
    ]);
    expect(checkpoint.scope.leftOut).toEqual([
      { objectApiName: 'Nope__c', reason: 'The org has no object of this name.' },
    ]);
    expect(snapshotReads(h.sent)).toEqual(['Contact', 'Account']);
  });
});

/**
 * Two custom settings as P-C2 found them deployed side by side: both with
 * `SetupOwnerId`, polymorphic over the org, a profile and a user; a
 * hierarchy's `Name` optional, a list's required.
 */
const SETTING_FIELDS: Record<string, unknown[]> = {
  App_Switches__c: [
    ...STAMP_FIELDS,
    writable('Name', 'string', { length: 80 }),
    writable('SetupOwnerId', 'reference', { referenceTo: ['Organization', 'Profile', 'User'] }),
    writable('Value__c'),
  ],
  Endpoints__c: [
    ...STAMP_FIELDS,
    writable('Name', 'string', { nillable: false, length: 38 }),
    writable('SetupOwnerId', 'reference', { referenceTo: ['Organization', 'Profile', 'User'] }),
    writable('Value__c'),
  ],
};

/** A harness whose org lists both custom settings, a row in each, and its user's Customize Application. */
function settingsHarness(customizeApplication = true): Harness {
  const h = harness(
    {},
    {
      ...DATA_OBJECTS,
      App_Switches__c: { customSetting: true },
      Endpoints__c: { customSetting: true },
    },
  );
  for (const [name, fields] of Object.entries(SETTING_FIELDS)) h.org.changeSchema(name, fields);
  h.org.all('UserPermissionAccess')[0].PermissionsCustomizeApplication = customizeApplication;
  seed(h.org);
  clock = LONG_AGO;
  h.org.add('App_Switches__c', { Id: 'a0A000000000001AAA', SetupOwnerId: ORG_ID, Value__c: 'on' });
  h.org.add('Endpoints__c', {
    Id: 'a0B000000000001AAA',
    Name: 'Billing',
    SetupOwnerId: ORG_ID,
    Value__c: 'https://billing.example.com',
  });
  h.org.add('Endpoints__c', {
    Id: 'a0B000000000002AAA',
    Name: 'Shipping',
    SetupOwnerId: ORG_ID,
    Value__c: 'https://shipping.example.com',
  });
  clock = T0;
  return h;
}

/** The statements that asked the user's permissions. */
function permissionReads(asked: readonly string[]): string[] {
  return asked.filter((what) => what.includes('FROM UserPermissionAccess'));
}

const LEFT_OUT_UNLESS_PICKED =
  'Custom settings are left out unless you pick them as custom settings: they are ' +
  'configuration, which a rewind sets back.';

describe('takeCheckpoint — custom settings', () => {
  it('leaves every custom setting out when none is named, in either mode, one picked as an object among them, and never asks for Customize Application', async () => {
    const everything = settingsHarness(false);
    const all = taken(await takeCheckpoint(everything.deps, request())).checkpoint;
    expect(all.objects.map((object) => object.objectApiName)).not.toContain('Endpoints__c');
    expect(all.objects.some((object) => object.customSetting !== undefined)).toBe(false);
    expect(all.scope.leftOut).toEqual(
      expect.arrayContaining([
        { objectApiName: 'App_Switches__c', reason: LEFT_OUT_UNLESS_PICKED },
        { objectApiName: 'Endpoints__c', reason: LEFT_OUT_UNLESS_PICKED },
      ]),
    );
    expect(permissionReads(everything.org.asked).join(' ')).not.toContain(
      'PermissionsCustomizeApplication',
    );

    const picked = settingsHarness(false);
    const some = taken(
      await takeCheckpoint(
        picked.deps,
        request({ mode: 'picked', objects: ['Account', 'Endpoints__c'] }),
      ),
    ).checkpoint;
    expect(some.objects.map((object) => object.objectApiName)).toEqual(['Account']);
    expect(some.scope.leftOut).toContainEqual({
      objectApiName: 'Endpoints__c',
      reason: LEFT_OUT_UNLESS_PICKED,
    });
    expect(snapshotReads(picked.sent)).toEqual(['Account']);
  });

  it('holds the custom settings named, each with its kind, in everything people work in, and names one the org does not have', async () => {
    const h = settingsHarness();

    const { checkpoint } = taken(
      await takeCheckpoint(
        h.deps,
        request({ customSettings: ['endpoints__c', 'App_Switches__c', 'Nope__c'] }),
      ),
    );

    const settings = checkpoint.objects.filter((object) => object.customSetting !== undefined);
    expect(
      settings.map(({ objectApiName, customSetting, records }) => ({
        objectApiName,
        customSetting,
        records,
      })),
    ).toEqual([
      { objectApiName: 'App_Switches__c', customSetting: 'hierarchy', records: 1 },
      { objectApiName: 'Endpoints__c', customSetting: 'list', records: 2 },
    ]);
    expect(settings.find((object) => object.objectApiName === 'Endpoints__c')?.fields).toEqual(
      expect.arrayContaining(['Name', 'SetupOwnerId', 'Value__c']),
    );
    expect(
      checkpoint.objects.find((object) => object.objectApiName === 'Account'),
    ).not.toHaveProperty('customSetting');
    expect(checkpoint.scope.leftOut).toContainEqual({
      objectApiName: 'Nope__c',
      reason: 'Picked as a custom setting: the org has no custom setting of this name.',
    });
    expect(snapshotReads(h.sent)).toEqual(
      expect.arrayContaining(['App_Switches__c', 'Endpoints__c']),
    );
    expect(permissionReads(h.org.asked)[0]).toContain('PermissionsCustomizeApplication');
  });

  it('adds every custom setting to the objects picked when all are asked for, unless one is left out by name', async () => {
    const h = settingsHarness();

    const { checkpoint } = taken(
      await takeCheckpoint(
        h.deps,
        request({
          mode: 'picked',
          objects: ['Account'],
          customSettings: 'all',
          excluded: ['App_Switches__c'],
        }),
      ),
    );

    expect(
      checkpoint.objects.map((object) => [object.objectApiName, object.customSetting]),
    ).toEqual([
      ['Account', undefined],
      ['Endpoints__c', 'list'],
    ]);
    expect(checkpoint.scope.leftOut).toContainEqual({
      objectApiName: 'App_Switches__c',
      reason: 'Left out as asked.',
    });
  });

  it('refuses a take that names custom settings by a user without Customize Application, before reading anything of the org but the guard’s, and keeps nothing', async () => {
    const h = settingsHarness(false);

    const outcome = await takeCheckpoint(h.deps, request({ customSettings: ['Endpoints__c'] }));

    expect(outcome).toMatchObject({ taken: false, refusal: { code: 'PERMISSIONS' } });
    expect(outcome.taken ? '' : outcome.refusal.message).toBe(
      "tester@example.com needs Customize Application to keep and rewind custom settings, and doesn't " +
        'have it: View All Custom Settings lets a user read them, never write them. Leave the ' +
        'custom settings out of the checkpoint, or give the user Customize Application. No record ' +
        'was read or written.',
    );
    expect(h.org.asked).not.toContain('describeGlobal');
    expect(h.sent).toEqual([]);
    expect(checkpointFolders(h.root)).toEqual([]);

    // The same user, given it, takes the checkpoint.
    h.org.all('UserPermissionAccess')[0].PermissionsCustomizeApplication = true;
    const granted = taken(
      await takeCheckpoint(h.deps, request({ customSettings: ['Endpoints__c'] })),
    );
    expect(granted.checkpoint.objects.map((object) => object.objectApiName)).toContain(
      'Endpoints__c',
    );
  });

  it('offers every custom setting the org lists to pick from, with its kind and rows, held or not, and costs the take nothing for those it does not hold', async () => {
    const h = settingsHarness();

    const none = await scopeCheckpoint(h.deps, request());
    const one = await scopeCheckpoint(h.deps, request({ customSettings: ['Endpoints__c'] }));

    const offered = [
      {
        objectApiName: 'App_Switches__c',
        label: 'App_Switches__c label',
        kind: 'hierarchy',
        records: 1,
      },
      { objectApiName: 'Endpoints__c', label: 'Endpoints__c label', kind: 'list', records: 2 },
    ];
    expect(none.customSettings).toEqual(offered);
    expect(one.customSettings).toEqual(offered);
    expect(none.objects.map((object) => object.objectApiName)).not.toContain('Endpoints__c');
    expect(one.objects.find((object) => object.objectApiName === 'Endpoints__c')).toMatchObject({
      customSetting: 'list',
      records: 2,
    });
    // What the offer reads beside the scope is no request of the take's.
    expect(one.estimate.records - none.estimate.records).toBe(2);
    expect(readsRecords(h.org.asked)).toEqual([]);
  });
});

describe('takeCheckpoint — every record or nothing', () => {
  it('fails and keeps nothing when an object grows past the limit between its count and its read', async () => {
    const h = harness();
    seed(h.org);
    clock = LONG_AGO;
    for (let n = 10; n < 100; n++) h.org.add('Account', { Id: accountId(n), Name: `Bulk ${n}` });
    clock = T0;
    h.before((soql) => {
      if (!soql.includes('FROM Account')) return;
      for (let n = 100; n < 120; n++) h.org.add('Account', { Id: accountId(n), Name: `Late ${n}` });
    });

    await expect(takeCheckpoint(h.deps, request({ maxTotal: 100 }))).rejects.toThrow(
      /Account holds 112 records, past the 100 a snapshot reads of one object/,
    );
    expect(checkpointFolders(h.root)).toEqual([]);
    expect(h.store.heldBy(ORG_ID)).toBeUndefined();
  });

  it('keeps nothing when it is stopped while the snapshot reads', async () => {
    const h = harness();
    seed(h.org);
    const stop = new AbortController();
    h.before((soql) => {
      if (soql.includes('FROM Contact')) stop.abort();
    });

    await expect(
      takeCheckpoint({ ...h.deps, signal: stop.signal }, request()),
    ).rejects.toBeInstanceOf(CheckpointTakeStopped);
    expect(checkpointFolders(h.root)).toEqual([]);
    expect(h.store.heldBy(ORG_ID)).toBeUndefined();
  });

  it('refuses a snapshot whose index does not hold as many records as its read kept', async () => {
    const h = harness();
    seed(h.org);
    const real = (await vi.importActual<typeof import('./snapshotIndex.js')>('./snapshotIndex.js'))
      .writeSnapshotIndex;
    vi.mocked(writeSnapshotIndex).mockImplementation(
      async (folder: CheckpointFolder, snapshotId: string, objectApiName: string) => {
        const written = await real(folder, snapshotId, objectApiName);
        return objectApiName === 'Contact' ? { ...written, rows: written.rows - 1 } : written;
      },
    );

    try {
      await expect(takeCheckpoint(h.deps, request())).rejects.toThrow(
        'The snapshot of Contact holds 2 records where its read kept 3: it is not kept.',
      );
    } finally {
      vi.mocked(writeSnapshotIndex).mockImplementation(real);
    }
    expect(checkpointFolders(h.root)).toEqual([]);
  });

  it('keeps nothing when the snapshot was read from another org than the one the guard read', async () => {
    const h = harness({ snapshotOrgId: OTHER_ORG_ID });
    seed(h.org);

    await expect(takeCheckpoint(h.deps, request())).rejects.toThrow(
      `The snapshot was read from another org (${OTHER_ORG_ID}), not from DEV-SB: it is not kept.`,
    );
    expect(checkpointFolders(h.root)).toEqual([]);
  });
});

describe('scopeCheckpoint', () => {
  it('says what a take would hold, leave out and cost, reading no record and keeping nothing', async () => {
    const h = harness();
    seed(h.org);

    const scope = await scopeCheckpoint(h.deps, request());

    expect(scope.refusal).toBeUndefined();
    expect(scope.objects.map((object) => [object.objectApiName, object.records])).toEqual([
      ['Case', 1],
      ['Contact', 3],
      ['Account', 2],
      ['Lead', 0],
      ['Task', 2],
    ]);
    expect(scope.objects.find((object) => object.objectApiName === 'Account')).toMatchObject({
      label: 'Account label',
      undeletable: true,
      leftOutFields: [
        { field: 'BillingAddress', reason: 'compound' },
        { field: 'Secret__c', reason: 'encrypted' },
        { field: 'Hidden__c', reason: 'fls' },
      ],
    });
    expect(scope.leftOut.map((object) => object.objectApiName)).toEqual([
      'Config__c',
      'FeedItem',
      'User',
    ]);
    const { bytes, ...cost } = scope.estimate;
    // Each object counted again: its bin at T0, and of each holding records,
    // what was stamped since the change reads' start, none of either.
    const { bytes: rowsAlone, ...expected } = takeEstimate({
      described: 5,
      recounted: 5 + 4,
      objects: [1, 3, 2, 0, 2].map((records) => ({
        records,
        otherGroups: [],
        inBin: 0,
        ...(records > 0 ? { stampedSince: 0 } : {}),
      })),
      pageRows: 2_000,
    });
    expect(cost).toEqual({ ...expected, apiRequestsLeft: 14_000 });
    // Its disk counts, beside the rows, what checkpoint.json lists of the
    // objects kept and left out, and their prints.
    expect(bytes).toBeGreaterThan(rowsAlone);
    expect(readsRecords(h.org.asked)).toEqual([]);
    expect(getJsforceConnection).not.toHaveBeenCalled();
    expect(checkpointFolders(h.root)).toEqual([]);
  });

  it('answers with the refusal a take would meet, and reads nothing of a production org', async () => {
    const production = harness({ sandbox: false, edition: 'Enterprise Edition' });
    const scope = await scopeCheckpoint(production.deps, request());
    expect(scope).toMatchObject({ objects: [], leftOut: [], refusal: { code: 'PRODUCTION' } });
    expect(production.org.asked).not.toContain('describeGlobal');

    const tooMany = harness();
    seed(tooMany.org);
    const limited = await scopeCheckpoint(tooMany.deps, request({ maxTotal: 5 }));
    expect(limited.refusal?.code).toBe('TOO_MANY_RECORDS');
    expect(limited.objects.length).toBeGreaterThan(0);
  });

  it('says a take would be refused while another one holds the org’s lock', async () => {
    const h = harness();
    seed(h.org);
    const other = h.store.lock(ORG_ID, 'take');
    if (!('lock' in other)) throw new Error('not locked');
    try {
      const scope = await scopeCheckpoint(h.deps, request());
      expect(scope.refusal?.code).toBe('RUN_WRITING');
      expect(scope.refusal?.message).toMatch(/^A checkpoint of DEV-SB is being taken/);
    } finally {
      other.lock.release();
    }
  });
});

describe('takeCheckpoint — the requests it sends', () => {
  /** The phases of a take whose figures differ between what it sent and what it estimated. */
  function differing(outcome: Extract<TakeOutcome, { taken: true }>): Record<string, number> {
    const estimated = outcome.estimate.requestsByPhase;
    const counted = outcome.requests?.byPhase;
    if (!estimated || !counted) throw new Error('not counted or not estimated by phase');
    return Object.fromEntries(
      Object.entries(counted)
        .map(([phase, sent]) => [phase, sent - estimated[phase as keyof typeof estimated]])
        .filter(([, more]) => more !== 0),
    );
  }

  it('counts every request it sends, phase by phase, its SOAP calls and its snapshot’s among them, each phase as its estimate said', async () => {
    const h = harness();
    seed(h.org);
    const scope = await scopeCheckpoint(h.deps, request());
    const before = { all: h.org.requestsSent(), soap: h.org.soapCalls };

    const outcome = taken(await takeCheckpoint(h.deps, request()));

    expect(outcome.requests).toEqual({
      total: h.org.requestsSent() - before.all,
      byPhase: {
        // The org, its edition, the permissions, the limits.
        guard: 4,
        // The two global describes, one composite of describes, the encryption right.
        scope: 4,
        // The user, the Automated Process user, T0.
        start: 3,
        // The five counts; then the bin and what was stamped since of the
        // four objects holding records, in two calls.
        counts: 1 + 2,
        bin: 1,
        // Four objects of a page each, and which org the snapshot is of.
        snapshot: 5,
        // T1 and one composite of checks: nothing moved.
        stability: 2,
      },
    });
    // The clock twice and the user: SOAP calls, each a request of the day's.
    expect(h.org.soapCalls - before.soap).toBe(3);
    expect(outcome.estimate).toEqual(scope.estimate);
    expect(outcome.requests?.total).toBe(scope.estimate.apiRequests);
    expect(differing(outcome)).toEqual({});
  });

  it('prices a wide object’s other column groups by the ids each statement of them holds, a full page and the last apart', async () => {
    const h = harness();
    seed(h.org);
    const custom = Array.from(
      { length: 600 },
      (_, n) => `Customer_Field_${String(n).padStart(4, '0')}__c`,
    );
    h.org.changeSchema('Account', [
      ...STAMP_FIELDS,
      writable('Name'),
      ...custom.map((name) => writable(name)),
    ]);
    clock = LONG_AGO;
    for (let n = 10; n < 2_608; n++) h.org.add('Account', { Id: accountId(n), Name: `Wide ${n}` });
    clock = T0;

    const outcome = taken(await takeCheckpoint(h.deps, request()));

    const account = outcome.checkpoint.objects.find((o) => o.objectApiName === 'Account');
    expect(account?.records).toBe(2_600);
    // Read in three groups: two pages of 1,000 rows, as the org answers a
    // wide statement, then one of 600, each read again by its ids in the two
    // other groups.
    const statements = h.sent.filter(({ soql }) => soql.includes('FROM Account WHERE Id IN ('));
    expect(statements.length).toBeGreaterThan(2 * 2 * 4);
    expect(outcome.requests?.byPhase.snapshot).toBe(
      3 + statements.length + 1 + 3, // its pages, its reads by id, the org, the other objects
    );
    expect(differing(outcome)).toEqual({});
  });

  it('prices again alone each describe and each count a composite did not answer, as the take asks them again', async () => {
    const h = harness();
    seed(h.org);
    h.org.refusedInComposite = (url) =>
      url.includes('sobjects/Case/describe') || url.includes('SELECT COUNT() FROM Lead');
    const scope = await scopeCheckpoint(h.deps, request());

    const outcome = taken(await takeCheckpoint(h.deps, request()));

    expect(outcome.checkpoint.objects.map((object) => object.objectApiName)).toContain('Case');
    expect(scope.estimate.requestsByPhase).toMatchObject({ scope: 3 + 1 + 1, counts: 1 + 1 + 2 });
    expect(outcome.requests?.byPhase).toEqual(scope.estimate.requestsByPhase);
  });

  it('counts the objects it counts, one it then leaves out past the limit for one object among them', async () => {
    const h = harness({}, { ...DATA_OBJECTS, Opportunity: {}, ...LISTED_ELSEWHERE });
    seed(h.org);
    h.org.changeSchema('Opportunity', [...STAMP_FIELDS, writable('Name')]);
    clock = LONG_AGO;
    for (let n = 0; n < 30; n++) {
      h.org.add('Opportunity', { Id: `006${String(n).padStart(12, '0')}AAA`, Name: `Big ${n}` });
    }
    clock = T0;

    const outcome = taken(await takeCheckpoint(h.deps, request({ maxTotal: 20 })));

    expect(outcome.checkpoint.objects).toHaveLength(5);
    expect(outcome.checkpoint.scope.leftOut.map((out) => out.objectApiName)).toContain(
      'Opportunity',
    );
    // Six objects counted, two composites, and again the four kept that hold
    // records, two more; five kept, one composite of bin reads and one of
    // checks.
    expect(outcome.requests?.byPhase).toMatchObject({ counts: 2 + 2, bin: 1, stability: 2 });
    expect(differing(outcome)).toEqual({});
  });

  it('prices the recycle bin of an object holding no live record as it reads it, and counts what its bin/ keeps of it: it counts that bin before it reads it', async () => {
    const h = harness();
    seed(h.org);
    const before = await scopeCheckpoint(h.deps, request());
    clock = LONG_AGO;
    for (let n = 0; n < 4_500; n++) {
      const id = `00Q${String(n).padStart(12, '0')}AAA`;
      h.org.add('Lead', { Id: id, LastName: `Gone ${n}` });
      h.org.trash('Lead', id);
    }
    clock = T0;

    const outcome = taken(await takeCheckpoint(h.deps, request()));

    const lead = outcome.checkpoint.objects.find((o) => o.objectApiName === 'Lead');
    expect(lead).toMatchObject({ records: 0, inBin: 4_500 });
    // Three pages of ids, the first with the other objects', two more alone:
    // estimated as sent.
    expect(outcome.requests?.byPhase.bin).toBe((before.estimate.requestsByPhase?.bin ?? 0) + 2);
    expect(differing(outcome)).toEqual({});
    // Each id kept in clear, a line each, as bin/ holds it.
    const binBytes = statSync(
      binFileOf(h.deps.store.folderOf(ORG_ID, outcome.checkpoint.checkpointId), 'Lead'),
    ).size;
    expect(binBytes).toBe(4_500 * BYTES_PER_BIN_ID_KEPT);
    expect(outcome.estimate.bytes - before.estimate.bytes).toBeGreaterThanOrEqual(binBytes);
  });

  it('counts the reads of what moved while it was taken, which no estimate knows before', async () => {
    const h = harness();
    seed(h.org);
    h.before((soql) => {
      if (!soql.includes('FROM Account')) return;
      clock = T0 + 30_000;
      h.org.edit('Contact', contactId(1), { LastName: 'Ada (edited)' });
    });

    const outcome = taken(await takeCheckpoint(h.deps, request()));

    expect(outcome.checkpoint.movedWhileTaken.changed).toBe(1);
    // The Contacts moved: their L and D in one composite, their count in another.
    expect(differing(outcome)).toEqual({ stability: 2 });
  });

  it('says nothing of what it sent when its org does not count it', async () => {
    const h = harness();
    seed(h.org);
    Object.assign(h.org, { requestsSent: undefined });

    const outcome = taken(await takeCheckpoint(h.deps, request()));

    expect(outcome).not.toHaveProperty('requests');
    expect(outcome.estimate.requestsByPhase?.guard).toBe(4);
  });

  it('hands its org the connection the snapshot reads through, whose requests it counts with its own', async () => {
    const h = harness();
    seed(h.org);
    const handed: unknown[] = [];
    Object.assign(h.org, { countAlso: (connection: unknown) => handed.push(connection) });

    taken(await takeCheckpoint(h.deps, request()));

    expect(handed).toHaveLength(1);
    expect(handed[0]).toBe(await vi.mocked(getJsforceConnection).mock.results[0]?.value);
  });
});

describe('takeCheckpoint — the Automated Process user', () => {
  it('names the user the org’s flows write as, among the two users of that type a scratch org has, in either order (P-B4)', async () => {
    const users = [
      { Id: '005000000000003AAA', UserType: 'AutomatedProcess', Name: 'Data.com Clean' },
      { Id: '005000000000004AAA', UserType: 'AutomatedProcess', Name: 'Automated Process' },
    ];
    for (const listed of [users, [...users].reverse()]) {
      const h = harness();
      seed(h.org);
      clock = LONG_AGO;
      // The harness's lone user of the type out of the way: the org's two.
      h.org.trash('User', AUTOMATED_PROCESS);
      for (const user of listed) h.org.add('User', user);
      clock = T0;

      const { checkpoint } = taken(await takeCheckpoint(h.deps, request()));

      expect(checkpoint.takenBy.automatedProcessUserId, `${listed[0].Name} first`).toBe(
        '005000000000004AAA',
      );
    }
  });

  it('takes the one user of that type of an org that names it otherwise, and none of an org that has several, none so named', async () => {
    const one = harness();
    seed(one.org);
    const several = harness();
    seed(several.org);
    clock = LONG_AGO;
    several.org.add('User', {
      Id: '005000000000005AAA',
      UserType: 'AutomatedProcess',
      Name: 'Another process',
    });
    clock = T0;

    expect(taken(await takeCheckpoint(one.deps, request())).checkpoint.takenBy).toMatchObject({
      automatedProcessUserId: AUTOMATED_PROCESS,
    });
    expect(
      taken(await takeCheckpoint(several.deps, request())).checkpoint.takenBy,
    ).not.toHaveProperty('automatedProcessUserId');
  });
});

describe('takeCheckpoint — what it reads past a page, priced before it reads it', () => {
  it('prices the bin’s pages, the snapshot’s pages of 1,000 rows and the reads again of what a load just before T0 stamped, and sends as many', async () => {
    const h = harness();
    seed(h.org);
    // Loaded two minutes before T0, as the contacts of P-D2 were: stamped
    // in the five minutes the last phase reads again.
    clock = T0 - 2 * 60_000;
    for (let n = 10; n < 3_010; n++) {
      h.org.add('Contact', { Id: contactId(n), LastName: `Loaded ${n}`, AccountId: accountId(1) });
    }
    clock = LONG_AGO;
    for (let n = 0; n < 4_500; n++) {
      h.org.add('Case', { Id: caseId(100 + n), Subject: `Closed ${n}` });
      h.org.trash('Case', caseId(100 + n));
    }
    clock = T0;
    const scope = await scopeCheckpoint(h.deps, request());

    const outcome = taken(await takeCheckpoint(h.deps, request()));

    expect(outcome.estimate.requestsByPhase).toEqual(scope.estimate.requestsByPhase);
    expect(outcome.requests?.byPhase).toMatchObject({
      // Three pages of the bin's ids, the first with the other objects'.
      bin: 1 + 2,
      // The contacts in four pages of 1,000 rows, the three other objects
      // holding records a page each, which org the snapshot is of.
      snapshot: 4 + 3 + 1,
      // T1, the checks, the contacts' moved and deleted reads — their first
      // pages in one call, then one more page of 2,000 ids — and their count.
      stability: 1 + 1 + (1 + 1) + 1,
    });
    expect(outcome.requests?.byPhase).toEqual(outcome.estimate.requestsByPhase);
  });
});

/** A user other than the one SandForge connects as. */
const OTHER_USER = '005000000000077AAA';

/** An org listing the objects of files beside the data objects. */
function fileHarness(): Harness {
  return harness({}, { ...DATA_OBJECTS, ...FILE_OBJECTS, ...LISTED_ELSEWHERE });
}

/** Files the org held long before the checkpoint, on the seeded records. */
function seedFiles(org: TakeTestOrg): void {
  clock = LONG_AGO;
  org.addFile({
    documentId: fileId(1),
    title: 'Contract',
    size: 1_200,
    links: [{ entityId: accountId(1) }, { entityId: contactId(1), shareType: 'C' }],
  });
  // Another user's, which a read naming no id does not show (P-A7).
  org.addFile({
    documentId: fileId(2),
    title: 'Quote',
    ownerId: OTHER_USER,
    size: 300,
    links: [{ entityId: accountId(2) }],
  });
  // The session user's own, linked to no record.
  org.addFile({ documentId: fileId(3), title: 'Notes', size: 50 });
  org.add('Attachment', {
    Id: '00P000000000001AAA',
    Name: 'scan.pdf',
    ParentId: accountId(1),
    Body: 'c2Nhbg==',
  });
  clock = T0;
}

/** Every line of an async source. */
async function all<T>(lines: AsyncIterable<T>): Promise<T[]> {
  const read: T[] = [];
  for await (const line of lines) read.push(line);
  return read;
}

/** What a link holds, as a test compares it. */
function ends(link: { ContentDocumentId: string; LinkedEntityId: string; ShareType: string }) {
  return [link.ContentDocumentId, link.LinkedEntityId, link.ShareType];
}

describe('takeCheckpoint — the files', () => {
  it('holds files and attachments as records, and the links of its records to files with each file’s latest version and size, another user’s among them', async () => {
    const h = fileHarness();
    seed(h.org);
    seedFiles(h.org);

    const { checkpoint } = taken(await takeCheckpoint(h.deps, request()));

    const objects = new Map(checkpoint.objects.map((object) => [object.objectApiName, object]));
    // The snapshot of files reads them naming no id: the user's own alone.
    expect(objects.get('ContentDocument')).toMatchObject({ records: 2 });
    expect(objects.get('ContentDocument')?.fields).toEqual(
      expect.arrayContaining(['LatestPublishedVersionId', 'ContentSize', 'Title', 'OwnerId']),
    );
    expect(objects.get('ContentDocument')?.leftOutFields).toEqual([
      { field: 'VersionData', reason: 'base64' },
    ]);
    expect(objects.get('Attachment')).toMatchObject({
      records: 1,
      cascadeParents: ['ParentId'],
      leftOutFields: [{ field: 'Body', reason: 'base64' }],
    });
    expect(checkpoint.files).toEqual({ documents: 3, links: 3, anchored: 2 });
    expect(checkpoint.takenBy.queryAllFiles).toBe(false);
    expect(checkpoint.scope.leftOut).toEqual(
      expect.arrayContaining([
        {
          objectApiName: 'ContentVersion',
          reason: expect.stringContaining('Held with its file (ContentDocument)'),
        },
        {
          objectApiName: 'ContentDocumentLink',
          reason: expect.stringContaining('Held with its file (ContentDocument)'),
        },
        {
          objectApiName: 'Document',
          reason:
            'Documents of the Documents tab are left out: they are shared content kept in ' +
            'folders, as setup is.',
        },
      ]),
    );

    const read = await h.store.read(checkpoint.checkpointId);
    if (!read) throw new Error('not kept');
    const links = await all(heldFileLinks(read.folder));
    expect(links.map(ends)).toEqual(
      expect.arrayContaining([
        [fileId(1), accountId(1), 'V'],
        [fileId(1), contactId(1), 'C'],
        [fileId(2), accountId(2), 'V'],
      ]),
    );
    expect(links).toHaveLength(3);
    const documents = await all(heldFileDocuments(read.folder));
    expect(new Map(documents.map((file) => [file.Id, [file.anchored, file.ContentSize]]))).toEqual(
      new Map([
        [fileId(1), [true, 1_200]],
        [fileId(2), [true, 300]],
        [fileId(3), [false, 50]],
      ]),
    );
    expect(documents.every((file) => typeof file.LatestPublishedVersionId === 'string')).toBe(true);
    // Kept compressed, as the snapshot is.
    expect(readdirSync(read.folder.filesDir).sort()).toEqual([
      'documents.ndjson.gz',
      'links.ndjson.gz',
    ]);
  });

  it('reads the links through the records, never through the files, and each file a link names by its id', async () => {
    const h = fileHarness();
    seed(h.org);
    seedFiles(h.org);

    taken(await takeCheckpoint(h.deps, request()));

    const asked = h.org.asked.map(decodeURIComponent);
    const linkReads = asked.filter(
      (what) => what.includes('FROM ContentDocumentLink') && !what.includes('COUNT()'),
    );
    expect(linkReads.length).toBeGreaterThan(0);
    for (const read of linkReads) expect(read).toContain('LinkedEntityId IN (SELECT Id FROM');
    expect(asked.some((what) => what.includes('FROM ContentDocument WHERE Id IN ('))).toBe(true);
  });

  it('sends the requests its estimate said for the files, and says before the take whether the user has Query All Files', async () => {
    const h = fileHarness();
    seed(h.org);
    seedFiles(h.org);
    const scope = await scopeCheckpoint(h.deps, request());

    const outcome = taken(await takeCheckpoint(h.deps, request()));

    expect(scope.files).toEqual({ held: true, queryAllFiles: false, addedToPicked: [] });
    expect(outcome.requests?.byPhase).toEqual(outcome.estimate.requestsByPhase);
    expect(outcome.estimate).toEqual(scope.estimate);
  });

  it('reads the links of an object by lists of its records’ ids when the org refuses to read them in one statement, and says so', async () => {
    const h = fileHarness();
    seed(h.org);
    seedFiles(h.org);
    h.org.refuseSemiJoin = {
      errorCode: 'QUERY_TIMEOUT',
      message: 'Your query request was running for too long.',
    };

    const { checkpoint } = taken(await takeCheckpoint(h.deps, request()));

    expect(checkpoint.files).toEqual({
      documents: 3,
      links: 3,
      anchored: 2,
      readByIds: ['Case', 'Contact', 'Account'],
    });
    const read = await h.store.read(checkpoint.checkpointId);
    if (!read) throw new Error('not kept');
    const links = await all(heldFileLinks(read.folder));
    expect(links.map((link) => link.LinkedEntityId).sort()).toEqual(
      [accountId(1), accountId(2), contactId(1)].sort(),
    );
  });

  it('fails, keeping nothing, when the links of an object could not be read whole either way', async () => {
    const h = fileHarness();
    seed(h.org);
    seedFiles(h.org);
    h.org.refuseSemiJoin = {
      errorCode: 'QUERY_TIMEOUT',
      message: 'Your query request was running for too long.',
    };
    h.org.failing = (what) =>
      decodeURIComponent(what).includes("LinkedEntityId IN ('")
        ? new Error('socket hang up')
        : undefined;

    await expect(takeCheckpoint(h.deps, request())).rejects.toThrow('socket hang up');
    expect(checkpointFolders(h.root)).toEqual([]);
  });

  it('holds the files and attachments of the objects picked, unless they are left out by name, and keeps no annex then', async () => {
    const h = fileHarness();
    seed(h.org);
    seedFiles(h.org);

    const picked = taken(
      await takeCheckpoint(h.deps, request({ mode: 'picked', objects: ['Account'] })),
    ).checkpoint;
    const without = taken(
      await takeCheckpoint(
        h.deps,
        request({ mode: 'picked', objects: ['Account'], excluded: ['ContentDocument'] }),
      ),
    ).checkpoint;

    expect(picked.objects.map((object) => object.objectApiName).sort()).toEqual([
      'Account',
      'Attachment',
      'ContentDocument',
    ]);
    // The links of the accounts alone: the checkpoint holds no contact.
    expect(picked.files).toEqual({ documents: 3, links: 2, anchored: 2 });
    expect(without.objects.map((object) => object.objectApiName).sort()).toEqual([
      'Account',
      'Attachment',
    ]);
    expect(without).not.toHaveProperty('files');
    const read = await h.store.read(without.checkpointId);
    expect(read !== undefined && existsSync(read.folder.filesDir)).toBe(false);
  });
});

describe('DEFAULT_MAX_TOTAL', () => {
  it('holds the default limit of records the design names', () => {
    expect(DEFAULT_MAX_TOTAL).toBe(500_000);
  });
});

describe('takeOrgOf', () => {
  it('reads the org’s clock and the user through SOAP, and the Tooling API’s objects, none when it will not say', async () => {
    const conn = {
      version: '66.0',
      soap: {
        getServerTimestamp: vi.fn(async () => ({ timestamp: '2026-10-22T14:05:12.731Z' })),
        getUserInfo: vi.fn(async () => ({ userId: MEMORY_ORG_USER })),
      },
      tooling: { describeGlobal: vi.fn(async () => ({ sobjects: [{ name: 'ApexClass' }] })) },
      describeGlobal: vi.fn(async () => ({ sobjects: [] })),
      request: vi.fn(async () => ({})),
      query: vi.fn(async () => ({ records: [], done: true, totalSize: 0 })),
      queryMore: vi.fn(),
    };
    const org = takeOrgOf(conn as unknown as Connection);

    expect(org.version).toBe('66.0');
    expect(await org.serverTime()).toBe('2026-10-22T14:05:12.731Z');
    expect(await org.userId()).toBe(MEMORY_ORG_USER);
    expect(await org.toolingObjects?.()).toEqual(['ApexClass']);
    conn.tooling.describeGlobal.mockRejectedValueOnce(new Error('no Tooling API for this user'));
    expect(await org.toolingObjects?.()).toEqual([]);
  });

  it('counts every request its connection sends from then on, SOAP calls among them, and those of a connection handed to it', async () => {
    const soap = '/services/Soap/u/66.0/00D000000000001';
    const transportOf = () => ({ httpRequest: vi.fn(async (_request: { url: string }) => ({})) });
    const transport = transportOf();
    const conn = {
      version: '66.0',
      _transport: transport,
      request: vi.fn(async () => ({})),
      soap: {
        getServerTimestamp: async () => {
          await transport.httpRequest({ url: `https://example.my.salesforce.com${soap}` });
          return { timestamp: '2026-10-22T14:05:12.731Z' };
        },
      },
    };
    const org = takeOrgOf(conn as unknown as Connection);

    await org.request({ method: 'POST', url: '/composite', body: '{}' });
    await org.serverTime();
    expect(org.requestsSent?.()).toBe(2);

    const snapshot = { request: vi.fn(async () => ({})), _transport: transportOf() };
    org.countAlso?.(snapshot as unknown as Connection);
    await snapshot.request();
    await snapshot.request();
    await snapshot._transport.httpRequest({ url: `https://example.my.salesforce.com${soap}` });
    expect(org.requestsSent?.()).toBe(5);
  });
});
