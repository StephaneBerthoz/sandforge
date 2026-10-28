import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgCheckpoint, RewindDiff, RewindDiffObject } from '@sandforge/shared';

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { MemoryFileOrg, fileId } from '../../test/memoryFileOrg.js';
import { MEMORY_ORG_USER, type MemoryOrgRequest } from '../../test/memoryRemovalOrg.js';
import { fileLinkClassFileOf, type FileLinkClass } from './checkpointFiles.js';
import {
  openCheckpointStore,
  previewDirOf,
  type CheckpointFolder,
  type OrgCheckpointStore,
} from './OrgCheckpointStore.js';
import { spooledRows } from './orgStreams.js';
import { previewCheckpoint, type PreviewOutcome } from './previewCheckpoint.js';
import { classFileOf, type RewindClass } from './rewindDiff.js';
import { workedObjects } from '../dataops/RecordRemoval.js';
import { diffEstimate, relationshipsOf, rewindEstimate } from './rewindEstimate.js';
import { takeCheckpoint, type TakeOrg } from './takeCheckpoint.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * The preview of a rewind to a checkpoint that holds files, on the memory org
 * that holds files as the probes of the files' lot saw a scratch org hold
 * them (`memoryFileOrg.ts`): the checkpoint taken as a take takes it, the
 * files and their links changed since by the session's user and another,
 * then the preview — which files it deletes, brings back and names, the
 * links it removes, inserts again and gives back, what it cannot undo, the
 * file storage, and what it sends.
 */

const ORG_ID = '00D000000000001AAA';
const AUTOMATED_PROCESS = '005000000000002AAA';
/** A user other than the one SandForge connects as, who owns files the admin sees by id alone (P-A7). */
const OTHER_USER = '005000000000077AAA';

/** T0 on the org's clock, with its milliseconds. */
const T0 = Date.parse('2026-10-22T14:05:12.731Z');
/** Long before the checkpoint. */
const LONG_AGO = Date.parse('2026-10-01T09:00:00.000Z');
/** Since the checkpoint. */
const SINCE = T0 + 60_000;

let clock = T0;

const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;
const account = (n: number): string => id('001', n);
const contact = (n: number): string => id('003', n);
/** A library, which no checkpoint holds. */
const library = (n: number): string => id('058', n);

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

/** What the org describes of each object it lists (FA1, FA3). */
const FIELDS: Record<string, unknown[]> = {
  Account: [...STAMP_FIELDS, writable('Name')],
  Contact: [
    ...STAMP_FIELDS,
    writable('LastName'),
    writable('AccountId', 'reference', { referenceTo: ['Account'] }),
  ],
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
      referenceTo: ['Account', 'Contact', 'User', 'ContentWorkspace'],
    },
    { name: 'ContentDocumentId', type: 'reference', createable: true },
    { name: 'IsDeleted', type: 'boolean', permissionable: false },
    { name: 'SystemModstamp', type: 'datetime', permissionable: false },
    writable('ShareType', 'picklist'),
    writable('Visibility', 'picklist'),
  ],
};

/** The objects the org lists, with the first characters of their ids. */
const LISTED: Record<string, Record<string, unknown>> = {
  Account: { keyPrefix: '001' },
  Contact: { keyPrefix: '003' },
  ContentDocument: { createable: false, keyPrefix: '069' },
  ContentDocumentLink: { keyPrefix: '06A' },
  ContentVersion: { deletable: false, keyPrefix: '068' },
  ContentWorkspace: { keyPrefix: '058' },
};

/** An account's contacts go with it; a file's links go with their record (P-A2). */
const CHILDREN = {
  Account: [
    { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
    { childSObject: 'ContentDocumentLink', field: 'LinkedEntityId', cascadeDelete: true },
  ],
  Contact: [{ childSObject: 'ContentDocumentLink', field: 'LinkedEntityId', cascadeDelete: true }],
  ContentDocument: [
    { childSObject: 'ContentDocumentLink', field: 'ContentDocumentId', cascadeDelete: true },
  ],
};

/**
 * The memory org as a take and a preview read it, holding files: a global
 * describe with the first characters of each object's ids, `/limits` with
 * the org's file storage, the org's own record and its user's permissions,
 * on a Developer Edition org.
 */
class FilesTestOrg extends MemoryFileOrg implements TakeOrg {
  limits = { Max: 15_000, Remaining: 14_000 };
  /** What `/limits` says of the file storage, in MB; absent, nothing. */
  fileStorage?: { Max: number; Remaining: number } = { Max: 20, Remaining: 20 };
  /** Every statement the org was sent through a query or a composite. */
  readonly asked: string[] = [];

  constructor() {
    super(CHILDREN, { now: () => clock });
    clock = LONG_AGO;
    for (const [name, fields] of Object.entries(FIELDS)) this.changeSchema(name, fields);
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
      PermissionsQueryAllFiles: false,
    });
    this.add('User', {
      Id: AUTOMATED_PROCESS,
      UserType: 'AutomatedProcess',
      Name: 'Automated Process',
    });
    this.add('User', { Id: MEMORY_ORG_USER, Name: 'Ada Admin' });
    this.add('User', { Id: OTHER_USER, Name: 'Grace Tester' });
  }

  override async describeGlobal(): Promise<unknown> {
    this.requests++;
    return {
      sobjects: Object.entries(LISTED).map(([name, extra]) => ({
        name,
        label: name,
        queryable: true,
        createable: true,
        updateable: true,
        deletable: true,
        layoutable: true,
        ...extra,
      })),
    };
  }

  override async query(soql: string, options?: { scanAll?: boolean }) {
    this.asked.push(soql);
    return super.query(soql, options);
  }

  override async request(request: MemoryOrgRequest): Promise<unknown> {
    if (request.method === 'GET' && request.url.endsWith('/limits')) {
      this.requests++;
      return {
        DailyApiRequests: this.limits,
        ...(this.fileStorage ? { FileStorageMB: this.fileStorage } : {}),
      };
    }
    if (typeof request.body === 'string') this.asked.push(decodeURIComponent(request.body));
    return super.request(request);
  }
}

/** Everything the memory org answered: its REST requests, a composite one, and its SOAP calls. */
function spent(org: MemoryFileOrg): number {
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
  org: FilesTestOrg;
  store: OrgCheckpointStore;
  checkpoint: OrgCheckpoint;
  folder: CheckpointFolder;
}

/** Accounts and a contact long before the checkpoint: what files hang from. */
function seedRecords(org: FilesTestOrg): void {
  clock = LONG_AGO;
  for (const n of [1, 2, 3]) org.add('Account', { Id: account(n), Name: `Account ${n}` });
  org.add('Contact', { Id: contact(1), LastName: 'One', AccountId: account(1) });
  clock = T0;
}

/**
 * The checkpoint of the picked accounts and contacts — and the files, which
 * picked objects hold though they were not picked — taken at T0 as a take
 * takes it, through a snapshot handler reading the same org.
 */
async function taken(org: FilesTestOrg, options: { excluded?: string[] } = {}): Promise<Taken> {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-files-preview-'));
  dirs.push(dir);
  const opened = openCheckpointStore({ root: join(dir, 'store'), locksDir: join(dir, 'locks') });
  if ('refusal' in opened) throw new Error(`no store: ${opened.refusal.reason}`);
  clock = T0;
  vi.mocked(getJsforceConnection).mockResolvedValue({
    query: (soql: string, opts?: { scanAll?: boolean }) => org.query(soql, opts),
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
      objects: ['Account', 'Contact'],
      ...(options.excluded ? { excluded: options.excluded } : {}),
      name: 'Before UAT',
    },
  );
  if (!outcome.taken) throw new Error(`refused: ${outcome.refusal.message}`);
  return {
    org,
    store: opened.store,
    checkpoint: outcome.checkpoint,
    folder: opened.store.folderOf(ORG_ID, outcome.checkpoint.checkpointId),
  };
}

const request = (t: Taken) => ({
  checkpoint: t.checkpoint,
  folder: t.folder,
  orgName: 'DEV-ED',
  registered: { orgType: 'Developer' },
  username: 'tester@example.com',
});

async function previewed(t: Taken): Promise<Extract<PreviewOutcome, { previewed: true }>> {
  clock = SINCE + 60_000;
  const outcome = await previewCheckpoint({ org: t.org, store: t.store }, request(t));
  if (!outcome.previewed) throw new Error(outcome.refusal.message);
  return outcome;
}

/** The ids of one class of one object the preview wrote, in their order. */
async function classIds(t: Taken, diff: RewindDiff, objectApiName: string, cls: RewindClass) {
  const file = classFileOf(previewDirOf(t.folder, diff.previewId), objectApiName, cls);
  const ids: string[] = [];
  if (!existsSync(file)) return ids;
  for await (const row of spooledRows(file)) ids.push(String(row.Id));
  return ids;
}

/** The lines of one class of links the preview wrote. */
async function linkLines(t: Taken, diff: RewindDiff, cls: FileLinkClass) {
  const file = fileLinkClassFileOf(previewDirOf(t.folder, diff.previewId), cls);
  const lines: Array<Record<string, unknown>> = [];
  if (!existsSync(file)) return lines;
  for await (const row of spooledRows(file)) lines.push(row);
  return lines;
}

/** The diff of the files' object, as a test reads it. */
function filesOf(diff: RewindDiff): RewindDiffObject | undefined {
  return diff.objects.find((object) => object.objectApiName === 'ContentDocument');
}

describe('the preview of a checkpoint that holds files — which files a rewind deletes', () => {
  it('deletes a file added since only when a link ties it to a record the checkpoint holds: one linked to nothing it holds — a user’s own — is counted, named and left', async () => {
    const org = new FilesTestOrg();
    seedRecords(org);
    const t = await taken(org);
    expect(t.checkpoint.files).toBeDefined();
    clock = SINCE;
    org.addFile({
      documentId: fileId(10),
      title: 'Attached since',
      links: [{ entityId: account(1) }],
    });
    // The session user's own, linked to no record: its owner's link alone.
    org.addFile({ documentId: fileId(11), title: 'My own notes' });
    // Linked to a library, which no checkpoint holds.
    org.addFile({
      documentId: fileId(12),
      title: 'Shared in a library',
      links: [{ entityId: library(1) }],
    });

    const { diff } = await previewed(t);

    expect(await classIds(t, diff, 'ContentDocument', 'createdSince')).toEqual([fileId(10)]);
    expect(await classIds(t, diff, 'ContentDocument', 'outsideAdded')).toEqual([
      fileId(11),
      fileId(12),
    ]);
    expect(filesOf(diff)?.toDelete.createdSince).toBe(1);
    expect(diff.files).toMatchObject({ outsideAdded: 2, outsideDeleted: 0 });
  });

  it('deletes a file another user owns added since and attached to a record of the checkpoint, which no read but by its id shows (P-A7)', async () => {
    const org = new FilesTestOrg();
    seedRecords(org);
    const t = await taken(org);
    clock = SINCE;
    org.addFile({
      documentId: fileId(20),
      title: 'Quote from a colleague',
      ownerId: OTHER_USER,
      size: 700,
      links: [{ entityId: account(2) }],
      fields: { LastModifiedById: OTHER_USER },
    });
    // Another user's own, linked to nothing the checkpoint holds: never seen.
    org.addFile({ documentId: fileId(21), title: 'Private', ownerId: OTHER_USER });

    const { diff } = await previewed(t);

    expect(await classIds(t, diff, 'ContentDocument', 'createdSince')).toEqual([fileId(20)]);
    expect(filesOf(diff)).toMatchObject({
      toDelete: { createdSince: 1 },
      lastChangedBy: { [OTHER_USER]: 1 },
    });
    expect(diff.files).toMatchObject({ outsideAdded: 0, storage: { undo: 700 }, blindSpot: true });
  });

  it('never deletes a file of the checkpoint that no record held linked to then, linked since to one: it removes the link alone (T4)', async () => {
    const org = new FilesTestOrg();
    seedRecords(org);
    clock = LONG_AGO;
    org.addFile({ documentId: fileId(30), title: 'Personal, then attached' });
    const t = await taken(org);
    clock = SINCE;
    const added = org.link(fileId(30), account(1));

    const { diff } = await previewed(t);

    expect(await classIds(t, diff, 'ContentDocument', 'createdSince')).toEqual([]);
    expect(await linkLines(t, diff, 'linkAdded')).toEqual([
      {
        Id: added,
        ContentDocumentId: fileId(30),
        LinkedEntityId: account(1),
        ShareType: 'V',
        Visibility: 'AllUsers',
      },
    ]);
    expect(diff.files).toMatchObject({ unlink: 1, relink: 0, updateLinks: 0 });
  });
});

describe('the preview of a checkpoint that holds files — the links', () => {
  it('tells the links added, removed and given another sharing since by the two ends each ties, never by a stamp nor by its Id (T5)', async () => {
    const org = new FilesTestOrg();
    seedRecords(org);
    clock = LONG_AGO;
    org.addFile({
      documentId: fileId(40),
      title: 'Contract',
      links: [{ entityId: account(1) }, { entityId: account(2), id: id('06A', 402) }],
    });
    org.addFile({
      documentId: fileId(41),
      title: 'Plan',
      links: [{ entityId: account(1), id: id('06A', 411) }],
    });
    const t = await taken(org);
    clock = SINCE;
    // Removed alone: no read shows it, not even of the recycle bin (P-A3).
    org.unlink(id('06A', 402));
    const added = org.link(fileId(40), account(3));
    // Removed, then linked again by another sharing: a new Id, the same ends.
    org.unlink(id('06A', 411));
    const again = org.link(fileId(41), account(1), { shareType: 'C' });

    const { diff } = await previewed(t);

    expect(diff.files).toMatchObject({ unlink: 1, relink: 1, updateLinks: 1 });
    expect((await linkLines(t, diff, 'linkAdded')).map((line) => line.Id)).toEqual([added]);
    expect(await linkLines(t, diff, 'linkRemoved')).toEqual([
      {
        Id: id('06A', 402),
        ContentDocumentId: fileId(40),
        LinkedEntityId: account(2),
        ShareType: 'V',
        Visibility: 'AllUsers',
      },
    ]);
    expect(await linkLines(t, diff, 'linkChanged')).toEqual([
      {
        Id: again,
        ContentDocumentId: fileId(41),
        LinkedEntityId: account(1),
        ShareType: 'V',
        Visibility: 'AllUsers',
        now: { ShareType: 'C', Visibility: 'AllUsers' },
      },
    ]);
    // The files themselves stay as they were: no stamp moved by a link (P-A4).
    expect(filesOf(diff)).toBeUndefined();
  });

  it('leaves the links that go or come back with a file or a record: of a record or a file deleted since, brought back with it; of one the rewind deletes, gone with it (P-A1, P-A2, P-A5)', async () => {
    const org = new FilesTestOrg();
    seedRecords(org);
    clock = LONG_AGO;
    org.addFile({
      documentId: fileId(50),
      title: 'On a contact',
      links: [{ entityId: contact(1) }],
    });
    org.addFile({
      documentId: fileId(51),
      title: 'Deleted since',
      size: 2_000,
      links: [{ entityId: account(2) }],
    });
    const t = await taken(org);
    clock = SINCE;
    org.trash('Contact', contact(1));
    org.trash('ContentDocument', fileId(51));
    org.add('Account', { Id: account(4), Name: 'New one' });
    org.link(fileId(50), account(4));

    const { diff } = await previewed(t);

    expect(diff.files).toMatchObject({ unlink: 0, relink: 0, updateLinks: 0 });
    expect(await classIds(t, diff, 'ContentDocument', 'inBin')).toEqual([fileId(51)]);
    expect(await classIds(t, diff, 'Contact', 'inBin')).toEqual([contact(1)]);
    expect(diff.files?.storage).toMatchObject({ bringBack: 2_000, remaining: 20 * 1_048_576 });
  });

  it('counts a file to delete linked as well to a library among what its deletion takes along outside the checkpoint, and names it among the files that hold such links (T11)', async () => {
    const org = new FilesTestOrg();
    seedRecords(org);
    const t = await taken(org);
    clock = SINCE;
    org.addFile({
      documentId: fileId(60),
      title: 'Attached and shared',
      links: [{ entityId: account(1) }, { entityId: library(1) }],
    });
    // Shared with a person: the share follows the file, and is nothing outside.
    org.addFile({
      documentId: fileId(61),
      title: 'Attached and shared with a person',
      links: [{ entityId: account(1) }, { entityId: OTHER_USER }],
    });

    const { diff } = await previewed(t);

    expect(filesOf(diff)).toMatchObject({
      toDelete: { createdSince: 2 },
      outside: [{ objectApiName: 'ContentDocumentLink', count: 1, parents: 1 }],
    });
    expect(await classIds(t, diff, 'ContentDocument', 'outsideParents')).toEqual([fileId(60)]);
    // The account's own links to files are the checkpoint's: none of them is outside it.
    expect(diff.objects.find((object) => object.objectApiName === 'Account')).toBeUndefined();
  });
});

describe('the preview of a checkpoint that holds files — what a rewind cannot undo of them', () => {
  it('names a file given a new version since among what a rewind cannot undo, and gives back the title the new version gave it; a file whose version is the checkpoint’s is named nowhere (T6)', async () => {
    const org = new FilesTestOrg();
    seedRecords(org);
    clock = LONG_AGO;
    org.addFile({ documentId: fileId(70), title: 'Brochure', links: [{ entityId: account(1) }] });
    org.addFile({ documentId: fileId(71), title: 'Untouched', links: [{ entityId: account(1) }] });
    const t = await taken(org);
    clock = SINCE;
    org.newVersion(fileId(70), 'Brochure v2');

    const { diff } = await previewed(t);

    expect(filesOf(diff)).toMatchObject({
      toGiveBack: { records: 1, fields: 1 },
      cannotUndo: [{ reason: 'newFileVersion', count: 1 }],
    });
    expect(await classIds(t, diff, 'ContentDocument', 'newFileVersion')).toEqual([fileId(70)]);
    expect(org.deletes).toEqual([]);
  });

  it('brings back another user’s file of the checkpoint deleted since, read by its id, and names one emptied from the recycle bin gone for good', async () => {
    const org = new FilesTestOrg();
    seedRecords(org);
    clock = LONG_AGO;
    org.addFile({
      documentId: fileId(80),
      title: 'Their quote',
      ownerId: OTHER_USER,
      size: 900,
      links: [{ entityId: account(2) }],
    });
    org.addFile({
      documentId: fileId(81),
      title: 'Their scan',
      ownerId: OTHER_USER,
      links: [{ entityId: account(3) }],
    });
    const t = await taken(org);
    clock = SINCE;
    org.trash('ContentDocument', fileId(80));
    org.trash('ContentDocument', fileId(81));
    org.purge(fileId(81));

    const { diff } = await previewed(t);

    expect(await classIds(t, diff, 'ContentDocument', 'deletedWhileTaken')).toEqual([fileId(80)]);
    expect(await classIds(t, diff, 'ContentDocument', 'goneForGood')).toEqual([fileId(81)]);
    expect(filesOf(diff)).toMatchObject({
      toBringBack: { deletedWhileTaken: 1 },
      cannotUndo: [{ reason: 'goneForGood', count: 1 }],
    });
    // Their links come back with the file, or are gone with it: none to insert.
    expect(diff.files).toMatchObject({ relink: 0, storage: { bringBack: 900 } });
  });

  it('leaves in the recycle bin a file deleted since that no record of the checkpoint linked to, and counts it', async () => {
    const org = new FilesTestOrg();
    seedRecords(org);
    clock = LONG_AGO;
    org.addFile({ documentId: fileId(90), title: 'Old personal file', size: 5_000 });
    const t = await taken(org);
    clock = SINCE;
    org.trash('ContentDocument', fileId(90));

    const { diff } = await previewed(t);

    expect(await classIds(t, diff, 'ContentDocument', 'inBin')).toEqual([]);
    expect(await classIds(t, diff, 'ContentDocument', 'outsideDeleted')).toEqual([fileId(90)]);
    expect(diff.files).toMatchObject({ outsideDeleted: 1, storage: { bringBack: 0 } });
  });
});

describe('the preview of a checkpoint that holds files — file storage (T10)', () => {
  /** A checkpoint holding files of `sizes` bytes on an account, each deleted since. */
  async function deletedSince(sizes: readonly number[], remainingMb: number) {
    const org = new FilesTestOrg();
    seedRecords(org);
    clock = LONG_AGO;
    sizes.forEach((size, at) =>
      org.addFile({
        documentId: fileId(100 + at),
        title: `Big ${at}`,
        size,
        links: [{ entityId: account(1) }],
      }),
    );
    const t = await taken(org);
    clock = SINCE;
    for (const at of sizes.keys()) org.trash('ContentDocument', fileId(100 + at));
    org.fileStorage = { Max: 20, Remaining: remainingMb };
    return previewed(t);
  }

  const MB = 1_048_576;

  it('refuses a rewind that brings back more file storage than the org has left, naming both sizes', async () => {
    const outcome = await deletedSince([6 * MB, 6 * MB], 10);

    expect(outcome.diff.files?.storage).toMatchObject({ bringBack: 12 * MB, remaining: 10 * MB });
    expect(outcome.refusal).toEqual({
      code: 'FILE_STORAGE',
      message:
        'Bringing back 2 files takes 12 MB of file storage; DEV-ED has 10 MB left. Free file ' +
        'storage, then rewind again. No record was read or written.',
    });
  });

  it('lets a rewind bring back exactly what the org has left, and less', async () => {
    expect((await deletedSince([5 * MB, 5 * MB], 10)).refusal).toBeUndefined();
    expect((await deletedSince([9 * MB], 10)).refusal).toBeUndefined();
  });

  it('holds nothing to a storage the org does not say', async () => {
    const org = new FilesTestOrg();
    seedRecords(org);
    clock = LONG_AGO;
    org.addFile({
      documentId: fileId(110),
      title: 'Big',
      size: 30 * MB,
      links: [{ entityId: account(1) }],
    });
    const t = await taken(org);
    clock = SINCE;
    org.trash('ContentDocument', fileId(110));
    org.fileStorage = undefined;

    const outcome = await previewed(t);

    expect(outcome.diff.files?.storage).toEqual({ bringBack: 30 * MB, undo: 0 });
    expect(outcome.refusal).toBeUndefined();
  });
});

describe('the preview of a checkpoint that holds no files (T13)', () => {
  it('previews as SandForge 1.69 did: no files, no link read, and an account’s links to files counted outside the checkpoint', async () => {
    const org = new FilesTestOrg();
    seedRecords(org);
    const t = await taken(org, { excluded: ['ContentDocument'] });
    expect(t.checkpoint.files).toBeUndefined();
    expect(t.checkpoint.objects.map((object) => object.objectApiName)).not.toContain(
      'ContentDocument',
    );
    clock = SINCE;
    org.add('Account', { Id: account(5), Name: 'Created since' });
    clock = SINCE + 1_000;
    org.addFile({ documentId: fileId(120), title: 'On it', links: [{ entityId: account(5) }] });
    org.addFile({ documentId: fileId(121), title: 'Mine' });
    const before = org.asked.length;

    const { diff } = await previewed(t);

    expect(diff).not.toHaveProperty('files');
    expect(diff).not.toHaveProperty('filesRequests');
    expect(diff.objects).toEqual([
      expect.objectContaining({
        objectApiName: 'Account',
        toDelete: { createdSince: 1, broughtBackSince: 0, comesBackWithParent: 0 },
        outside: [{ objectApiName: 'ContentDocumentLink', count: 1, parents: 1 }],
      }),
    ]);
    const read = org.asked.slice(before);
    expect(read.some((soql) => /LinkedEntityId IN \(SELECT/.test(soql))).toBe(false);
    expect(read.some((soql) => /FROM ContentDocument\b/.test(soql))).toBe(false);
  });
});

describe('the preview of a checkpoint that holds files — what it sends (T15)', () => {
  it('sends the org exactly what the estimate counts for 500 files and 1,500 links, read through the records and by id', async () => {
    const org = new FilesTestOrg();
    clock = LONG_AGO;
    for (let n = 1; n <= 250; n++) org.add('Account', { Id: account(n), Name: `Account ${n}` });
    for (let n = 1; n <= 500; n++) {
      org.addFile({
        documentId: fileId(1_000 + n),
        title: `File ${n}`,
        size: 100,
        // Half of them another user's, which the admin reads by id alone.
        ...(n % 2 === 0 ? { ownerId: OTHER_USER } : {}),
        links: [
          { entityId: account(1 + (n % 250)) },
          { entityId: account(1 + ((n + 1) % 250)) },
          { entityId: account(1 + ((n + 2) % 250)) },
        ],
      });
    }
    const t = await taken(org);
    expect(t.checkpoint.files).toMatchObject({ documents: 500, links: 1_500, anchored: 500 });
    clock = SINCE;
    for (let n = 1; n <= 40; n++) org.trash('ContentDocument', fileId(1_000 + n));
    for (let n = 1; n <= 30; n++) {
      org.addFile({
        documentId: fileId(2_000 + n),
        title: `New ${n}`,
        ...(n % 3 === 0 ? { ownerId: OTHER_USER } : {}),
        links: [{ entityId: account(n) }],
      });
    }
    org.link(fileId(1_100), account(200));
    const before = spent(org);

    const outcome = await previewed(t);

    const sent = spent(org) - before;
    expect(outcome.diff.files).toMatchObject({ unlink: 1, relink: 0 });
    expect(filesOf(outcome.diff)).toMatchObject({
      toDelete: { createdSince: 30 },
      toBringBack: { inBin: 20, deletedWhileTaken: 20 },
    });
    expect(outcome.diff.filesRequests).toBeGreaterThan(0);
    const read = diffEstimate({ objects: t.checkpoint.objects, diff: outcome.diff });
    // The guard of a Developer Edition org reads its Organization record, its
    // edition and the user's permissions; then the day's limits; then the
    // diff, its clock included.
    expect(sent).toBe(3 + 1 + read.apiRequests);
    const { filesRequests, files, ...without } = outcome.diff;
    expect(files).toBeDefined();
    expect(filesRequests).toBeDefined();
    expect(
      3 + 1 + diffEstimate({ objects: t.checkpoint.objects, diff: without }).apiRequests,
    ).toBeLessThan(sent);
  });
  it('prices the rewind with no relationship to a file’s links or versions outside the checkpoint: it holds them with the files, and its reads of them are the files’ own', async () => {
    const org = new FilesTestOrg();
    seedRecords(org);
    const t = await taken(org);
    clock = SINCE;
    org.add('Account', { Id: account(6), Name: 'Created since' });
    org.addFile({ documentId: fileId(130), title: 'On it', links: [{ entityId: account(6) }] });

    const outcome = await previewed(t);

    const worked = new Set((await workedObjects(org)).keys());
    const described = new Map(
      await Promise.all(
        ['Account', 'Contact', 'ContentDocument'].map(
          async (name) => [name, await org.describe(name)] as const,
        ),
      ),
    );
    const priced = (inCheckpoint: Set<string>) =>
      rewindEstimate({
        objects: t.checkpoint.objects,
        diff: outcome.diff,
        automationRequests: 0,
        relationships: new Map(
          [...described].map(([name, body]) => [
            name,
            relationshipsOf(body, { inCheckpoint, worked }),
          ]),
        ),
      });
    const held = new Set(['account', 'contact', 'contentdocument']);
    const withFiles = new Set([...held, 'contentdocumentlink', 'contentversion']);
    expect(outcome.estimate).toEqual({ ...priced(withFiles), apiRequestsLeft: 14_000 });
    expect(priced(held).apiRequests).toBeGreaterThan(outcome.estimate.apiRequests);
  });
});
