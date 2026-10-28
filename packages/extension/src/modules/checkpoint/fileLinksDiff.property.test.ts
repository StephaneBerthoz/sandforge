import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrgCheckpoint, RewindDiff } from '@sandforge/shared';

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { paced } from '../../test/runnerPace.js';
import { MemoryFileOrg, fileId, type MemoryShareType } from '../../test/memoryFileOrg.js';
import { MEMORY_ORG_USER, type MemoryOrgRequest } from '../../test/memoryRemovalOrg.js';
import { fileLinkClassFileOf, heldFileLinks, type FileLinkClass } from './checkpointFiles.js';
import { openCheckpointStore, previewDirOf, type CheckpointFolder } from './OrgCheckpointStore.js';
import { spooledRows } from './orgStreams.js';
import { previewCheckpoint } from './previewCheckpoint.js';
import { classFileOf, type RewindClass } from './rewindDiff.js';
import { takeCheckpoint, type TakeOrg } from './takeCheckpoint.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * The preview of a checkpoint that holds files, over random histories of its
 * files and their links since — files added by the session's user or another,
 * linked to records of the checkpoint or to none, links added, removed and
 * shared otherwise, files deleted — on the memory org that holds files as the
 * probes saw a scratch org hold them. Two things hold whatever the history:
 * no file that no record of the checkpoint links to is ever among the files
 * to delete; and doing what the preview says — the links removed, inserted
 * again and given their sharing back, the files deleted and brought back —
 * then what the preview read after that says, which inserts what Salesforce
 * did not bring back with a file, leaves the files of the checkpoint live and
 * linked to its records exactly as it holds them, and nothing of the files
 * and their links to do.
 */

const ORG_ID = '00D000000000001AAA';
const OTHER_USER = '005000000000077AAA';
const T0 = Date.parse('2026-10-22T14:05:12.731Z');
const LONG_AGO = Date.parse('2026-10-01T09:00:00.000Z');

/** A fixed seed: the histories are the same on every run. */
const SEED = 1_792_700_441;
/** Histories tried: one on a Windows runner, whose disk is many times slower. */
const RUNS = process.platform === 'win32' ? 1 : 20;

let clock = T0;

const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;
/** The records of the checkpoint a file may be linked to. */
const RECORDS = [id('001', 1), id('001', 2), id('001', 3), id('003', 1)];

const STAMP_FIELDS = [
  { name: 'Id', type: 'id', permissionable: false },
  { name: 'SystemModstamp', type: 'datetime', permissionable: false },
  { name: 'CreatedDate', type: 'datetime', permissionable: false },
  { name: 'LastModifiedDate', type: 'datetime', permissionable: false },
  { name: 'LastModifiedById', type: 'reference', referenceTo: ['User'], permissionable: false },
  { name: 'IsDeleted', type: 'boolean', permissionable: false },
];

function writable(name: string, type = 'string', extra: Record<string, unknown> = {}) {
  return { name, type, createable: true, updateable: true, nillable: true, ...extra };
}

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
    writable('OwnerId', 'reference', { createable: false, referenceTo: ['User'] }),
    { name: 'LatestPublishedVersionId', type: 'reference', permissionable: false },
    { name: 'ContentSize', type: 'int', permissionable: false },
  ],
  ContentDocumentLink: [
    { name: 'Id', type: 'id', permissionable: false },
    {
      name: 'LinkedEntityId',
      type: 'reference',
      createable: true,
      referenceTo: ['Account', 'Contact', 'User'],
    },
    { name: 'ContentDocumentId', type: 'reference', createable: true },
    writable('ShareType', 'picklist'),
    writable('Visibility', 'picklist'),
  ],
};

const LISTED: Record<string, Record<string, unknown>> = {
  Account: { keyPrefix: '001' },
  Contact: { keyPrefix: '003' },
  ContentDocument: { createable: false, keyPrefix: '069' },
  ContentDocumentLink: { keyPrefix: '06A' },
  ContentVersion: { deletable: false, keyPrefix: '068' },
};

/** The memory org holding files, as a take and a preview read it. */
class HistoryOrg extends MemoryFileOrg implements TakeOrg {
  constructor() {
    super(
      {
        Account: [
          { childSObject: 'ContentDocumentLink', field: 'LinkedEntityId', cascadeDelete: true },
        ],
        Contact: [
          { childSObject: 'ContentDocumentLink', field: 'LinkedEntityId', cascadeDelete: true },
        ],
      },
      { now: () => clock },
    );
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
    });
    this.add('User', { Id: MEMORY_ORG_USER, Name: 'Ada Admin' });
    for (const n of [1, 2, 3]) this.add('Account', { Id: id('001', n), Name: `Account ${n}` });
    this.add('Contact', { Id: id('003', 1), LastName: 'One', AccountId: id('001', 1) });
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

  override async request(request: MemoryOrgRequest): Promise<unknown> {
    if (request.method === 'GET' && request.url.endsWith('/limits')) {
      this.requests++;
      return { DailyApiRequests: { Max: 15_000, Remaining: 14_000 } };
    }
    return super.request(request);
  }
}

/** A file of the history: who owns it, the records it is linked to, how. */
interface FileOf {
  other: boolean;
  records: number[];
  share: MemoryShareType;
}

/** One thing done since the checkpoint. */
type Act =
  | { kind: 'link' | 'unlink' | 'reshare'; file: number; record: number }
  | { kind: 'add'; file: FileOf }
  | { kind: 'delete'; file: number }
  | { kind: 'deleteRecord'; record: number };

const fileArb: fc.Arbitrary<FileOf> = fc.record({
  other: fc.boolean(),
  records: fc.uniqueArray(fc.integer({ min: 0, max: RECORDS.length - 1 }), { maxLength: 3 }),
  share: fc.constantFrom<MemoryShareType>('V', 'C'),
});

const actArb: fc.Arbitrary<Act> = fc.oneof(
  fc.record({
    kind: fc.constantFrom('link' as const, 'unlink' as const, 'reshare' as const),
    file: fc.nat({ max: 20 }),
    record: fc.integer({ min: 0, max: RECORDS.length - 1 }),
  }),
  fc.record({ kind: fc.constant('add' as const), file: fileArb }),
  fc.record({ kind: fc.constant('delete' as const), file: fc.nat({ max: 20 }) }),
  fc.record({
    kind: fc.constant('deleteRecord' as const),
    record: fc.integer({ min: 0, max: RECORDS.length - 1 }),
  }),
);

/** The object of a record of {@link RECORDS}. */
function objectOf(record: string): string {
  return record.startsWith('003') ? 'Contact' : 'Account';
}

/** Whether a record of {@link RECORDS} is live. */
function isLive(org: HistoryOrg, record: string): boolean {
  return org.all(objectOf(record)).some((row) => row.Id === record);
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.mocked(getJsforceConnection).mockReset();
});

/** Put the file `n` in the org, as `file` says. */
function addFile(org: HistoryOrg, n: number, file: FileOf): void {
  org.addFile({
    documentId: fileId(n),
    title: `File ${n}`,
    size: 100 + n,
    ...(file.other ? { ownerId: OTHER_USER } : {}),
    links: file.records.map((record) => ({ entityId: RECORDS[record], shareType: file.share })),
  });
}

/** The live link between `documentId` and `entityId`, if any: one of a live file. */
function linkOf(org: HistoryOrg, documentId: string, entityId: string) {
  if (!isLive(org, entityId)) return undefined;
  return org
    .heldLinks()
    .find((link) => link.ContentDocumentId === documentId && link.LinkedEntityId === entityId);
}

async function take(org: HistoryOrg): Promise<{
  checkpoint: OrgCheckpoint;
  folder: CheckpointFolder;
  store: ReturnType<typeof storeOf>;
}> {
  const store = storeOf();
  clock = T0;
  vi.mocked(getJsforceConnection).mockResolvedValue({
    query: (soql: string, opts?: { scanAll?: boolean }) => org.query(soql, opts),
    queryMore: (nextRecordsUrl: string) => org.queryMore(nextRecordsUrl),
    describe: (objectApiName: string) => org.describe(objectApiName),
  } as never);
  const outcome = await takeCheckpoint(
    {
      org,
      store,
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
      name: 'History',
    },
  );
  if (!outcome.taken) throw new Error(`refused: ${outcome.refusal.message}`);
  return {
    checkpoint: outcome.checkpoint,
    store,
    folder: store.folderOf(ORG_ID, outcome.checkpoint.checkpointId),
  };
}

function storeOf() {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-files-history-'));
  dirs.push(dir);
  const opened = openCheckpointStore({ root: join(dir, 'store'), locksDir: join(dir, 'locks') });
  if ('refusal' in opened) throw new Error(`no store: ${opened.refusal.reason}`);
  return opened.store;
}

async function lines(file: string): Promise<Array<Record<string, unknown>>> {
  const read: Array<Record<string, unknown>> = [];
  if (!existsSync(file)) return read;
  for await (const row of spooledRows(file)) read.push(row);
  return read;
}

/** What a preview read says of the files and their links, its classes read back. */
async function read(org: HistoryOrg, taken: Awaited<ReturnType<typeof take>>) {
  clock += 60_000;
  const outcome = await previewCheckpoint(
    { org, store: taken.store },
    {
      checkpoint: taken.checkpoint,
      folder: taken.folder,
      orgName: 'DEV-ED',
      registered: { orgType: 'Developer' },
      username: 'tester@example.com',
    },
  );
  if (!outcome.previewed) throw new Error(outcome.refusal.message);
  const dir = previewDirOf(taken.folder, outcome.diff.previewId);
  const ids = async (cls: RewindClass): Promise<string[]> =>
    (await lines(classFileOf(dir, 'ContentDocument', cls))).map((row) => String(row.Id));
  const links = (cls: FileLinkClass) => lines(fileLinkClassFileOf(dir, cls));
  const recordsBack: string[] = [];
  for (const object of ['Account', 'Contact']) {
    for (const row of await lines(classFileOf(dir, object, 'inBin'))) {
      recordsBack.push(String(row.Id));
    }
  }
  return {
    diff: outcome.diff,
    recordsBack,
    toDelete: [...(await ids('createdSince')), ...(await ids('broughtBackSince'))],
    toBringBack: [
      ...(await ids('inBin')),
      ...(await ids('withParent')),
      ...(await ids('deletedWhileTaken')),
    ],
    added: await links('linkAdded'),
    removed: await links('linkRemoved'),
    changed: await links('linkChanged'),
  };
}

/** Do what a preview says, as a rewind of the files and their links would. */
function act(org: HistoryOrg, said: Awaited<ReturnType<typeof read>>): void {
  clock += 1_000;
  for (const link of said.added) org.unlink(String(link.Id));
  for (const file of said.toDelete) org.trash('ContentDocument', file);
  for (const file of said.toBringBack) org.untrash(file);
  for (const record of said.recordsBack) org.untrash(record);
  for (const link of said.removed) {
    org.link(String(link.ContentDocumentId), String(link.LinkedEntityId), {
      shareType: link.ShareType as MemoryShareType,
      visibility: String(link.Visibility),
    });
  }
  for (const link of said.changed) {
    org.unlink(String(link.Id));
    org.link(String(link.ContentDocumentId), String(link.LinkedEntityId), {
      shareType: link.ShareType as MemoryShareType,
      visibility: String(link.Visibility),
    });
  }
}

/** The links of live files to the records of the checkpoint, each by its two ends and its sharing. */
function liveLinks(org: HistoryOrg): string[] {
  const live = new Set(org.all('ContentDocument').map((file) => file.Id));
  return org
    .heldLinks()
    .filter(
      (link) =>
        live.has(link.ContentDocumentId) &&
        RECORDS.includes(link.LinkedEntityId) &&
        isLive(org, link.LinkedEntityId),
    )
    .map(
      (link) =>
        `${link.ContentDocumentId} ${link.LinkedEntityId} ${link.ShareType} ${link.Visibility}`,
    )
    .sort();
}

/** The links the checkpoint holds, as {@link liveLinks} writes them. */
async function heldLinks(folder: CheckpointFolder): Promise<string[]> {
  const held: string[] = [];
  for await (const link of heldFileLinks(folder)) {
    held.push(
      `${link.ContentDocumentId} ${link.LinkedEntityId} ${link.ShareType} ${link.Visibility}`,
    );
  }
  return held.sort();
}

/** Whether nothing of the files and their links is left to do. */
function settled(said: Awaited<ReturnType<typeof read>>, diff: RewindDiff): boolean {
  return (
    said.toDelete.length + said.toBringBack.length + said.recordsBack.length === 0 &&
    (diff.files?.unlink ?? 0) + (diff.files?.relink ?? 0) + (diff.files?.updateLinks ?? 0) === 0
  );
}

describe('the preview of a checkpoint that holds files, over random histories of its files since', () => {
  it(
    'never deletes a file no record of the checkpoint links to, and what it says done twice leaves nothing of the files and their links to do',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fileArb, { minLength: 1, maxLength: 5 }),
          fc.array(actArb, { maxLength: 8 }),
          async (before, since) => {
            const org = new HistoryOrg();
            const files: string[] = [];
            clock = LONG_AGO;
            before.forEach((file, at) => {
              addFile(org, at + 1, file);
              files.push(fileId(at + 1));
            });
            const taken = await take(org);
            clock = T0 + 60_000;
            for (const each of since) {
              clock += 1_000;
              if (each.kind === 'add') {
                addFile(org, files.length + 1, each.file);
                files.push(fileId(files.length + 1));
                continue;
              }
              if (each.kind === 'deleteRecord') {
                org.trash(objectOf(RECORDS[each.record]), RECORDS[each.record]);
                continue;
              }
              const file = files[each.file % files.length];
              if (each.kind === 'delete') {
                org.trash('ContentDocument', file);
                continue;
              }
              const record = RECORDS[each.record];
              const held = linkOf(org, file, record);
              // Salesforce links no file to a record in the recycle bin.
              if (each.kind === 'link' && held === undefined && isLive(org, record)) {
                org.link(file, record);
              } else if (each.kind === 'unlink' && held !== undefined) org.unlink(held.Id);
              else if (each.kind === 'reshare' && held !== undefined) {
                org.unlink(held.Id);
                org.link(file, record, { shareType: held.ShareType === 'V' ? 'C' : 'V' });
              }
            }
            const message = JSON.stringify({ before, since });

            let said = await read(org, taken);
            for (const file of said.toDelete) {
              // Linked now to a record of the checkpoint: never one that is not.
              expect(
                RECORDS.some((record) => linkOf(org, file, record) !== undefined),
                `${message} ${file}`,
              ).toBe(true);
            }
            for (let round = 0; round < 2 && !settled(said, said.diff); round++) {
              act(org, said);
              said = await read(org, taken);
            }
            expect(
              {
                toDelete: said.toDelete,
                toBringBack: said.toBringBack,
                recordsBack: said.recordsBack,
                added: said.added,
                removed: said.removed,
                changed: said.changed,
              },
              message,
            ).toEqual({
              toDelete: [],
              toBringBack: [],
              recordsBack: [],
              added: [],
              removed: [],
              changed: [],
            });
            // What the org holds now is what the checkpoint holds.
            expect(liveLinks(org), message).toEqual(await heldLinks(taken.folder));
          },
        ),
        { numRuns: RUNS, seed: SEED, endOnFailure: true },
      );
    },
    paced(120_000),
  );
});
