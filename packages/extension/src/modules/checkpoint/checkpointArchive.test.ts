import { createCipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckpointArchiveHeader, OrgCheckpoint, RewindDiff } from '@sandforge/shared';

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { MemoryFileOrg, fileId } from '../../test/memoryFileOrg.js';
import { MEMORY_ORG_USER, type MemoryOrgRequest } from '../../test/memoryRemovalOrg.js';
import {
  AUTOMATED_PROCESS,
  LONG_AGO,
  ORG_ID,
  PREVIEWED,
  STAMP_FIELDS,
  T0,
  account,
  clock,
  removeTaken,
  taken as takenOfAccounts,
  writable,
} from '../../test/rewindTestOrg.js';
import { nodeBackupFiles } from '../dataops/BackupRecordStore.js';
import {
  ARCHIVE_EXTENSION,
  archiveKeyText,
  exportCheckpointArchive,
  importCheckpointArchive,
  newArchiveKey,
  parseArchiveKey,
  readArchiveHeader,
  type ArchiveImported,
  type ArchiveRead,
} from './checkpointArchive.js';
import {
  exportedFilesOf,
  indexFileOf,
  openCheckpointStore,
  organizationKey,
  type CheckpointFolder,
  type OrgCheckpointStore,
} from './OrgCheckpointStore.js';
import { snapshotMember } from './compressedSnapshotFiles.js';
import { previewCheckpoint } from './previewCheckpoint.js';
import { NotInBin } from './snapshotIndex.js';
import { takeCheckpoint, type TakeOrg } from './takeCheckpoint.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * A checkpoint exported to a `.sfcheckpoint` file and imported into the store
 * of another machine, on the memory org of files the rewinds of files run on,
 * with a custom setting beside them: what comes back, what does not, and what
 * refuses the file before anything is kept. Some files are forged here from
 * the format itself, as its comment states it, to say what the reader does
 * with what no export of this SandForge writes.
 */

const HIERARCHY = 'Hier__c';
const PROFILE = '00e000000000001AAA';
const hier = (n: number): string => `a0A${String(n).padStart(12, '0')}AAA`;

/** A value no one would type: found in a file, it is a record's, readable by anyone. */
const MARKER = 'MARKER-7f3a-canary';

/** The accounts the org holds live at the checkpoint. */
const ACCOUNTS = 200;

/** The objects of the org, as a scratch org describes them (FA1, FA2, P-C2). */
const FIELDS: Record<string, unknown[]> = {
  Account: [...STAMP_FIELDS, writable('Name')],
  [HIERARCHY]: [
    ...STAMP_FIELDS,
    writable('Name', 'string', { length: 80 }),
    writable('SetupOwnerId', 'reference', { referenceTo: ['Organization', 'Profile', 'User'] }),
    writable('Value__c'),
  ],
  ContentDocument: [
    ...STAMP_FIELDS,
    writable('Title', 'string', { createable: false }),
    writable('OwnerId', 'reference', { createable: false, referenceTo: ['User'] }),
    {
      name: 'LatestPublishedVersionId',
      label: 'Latest Published Version',
      type: 'reference',
      permissionable: false,
    },
    { name: 'ContentSize', label: 'Size', type: 'int', permissionable: false },
  ],
  ContentDocumentLink: [
    { name: 'Id', label: 'Id', type: 'id', permissionable: false },
    {
      name: 'LinkedEntityId',
      label: 'Linked Entity',
      type: 'reference',
      createable: true,
      referenceTo: ['Account', 'User'],
    },
    { name: 'ContentDocumentId', label: 'Document', type: 'reference', createable: true },
    { name: 'IsDeleted', label: 'Deleted', type: 'boolean', permissionable: false },
    {
      name: 'SystemModstamp',
      label: 'System Modstamp',
      type: 'datetime',
      permissionable: false,
    },
    writable('ShareType', 'picklist'),
    writable('Visibility', 'picklist'),
  ],
};

/** As the global describe of a scratch org lists them. */
const LISTED: Record<string, Record<string, unknown>> = {
  Account: { keyPrefix: '001' },
  [HIERARCHY]: { keyPrefix: 'a0A', customSetting: true },
  ContentDocument: { createable: false, keyPrefix: '069' },
  ContentDocumentLink: { keyPrefix: '06A' },
  ContentVersion: { deletable: false, keyPrefix: '068' },
};

/** A file's links go with it, and an account's. */
const CHILDREN = {
  Account: [{ childSObject: 'ContentDocumentLink', field: 'LinkedEntityId', cascadeDelete: true }],
  ContentDocument: [
    { childSObject: 'ContentDocumentLink', field: 'ContentDocumentId', cascadeDelete: true },
  ],
};

/** The org of the checkpoint: accounts, the files attached to them, and a hierarchy setting. */
class TransferOrg extends MemoryFileOrg implements TakeOrg {
  limits = { Max: 15_000, Remaining: 14_000 };
  fileStorage = { Max: 50, Remaining: 50 };

  constructor() {
    super(CHILDREN, { now: () => clock.now });
    clock.now = LONG_AGO;
    for (const [name, described] of Object.entries(FIELDS)) this.changeSchema(name, described);
    this.add('Organization', {
      Id: ORG_ID,
      IsSandbox: false,
      OrganizationType: 'Developer Edition',
    });
    this.add('UserPermissionAccess', {
      Id: '0Up000000000001AAA',
      PermissionsViewAllData: true,
      PermissionsModifyAllData: true,
      PermissionsCustomizeApplication: true,
      PermissionsViewEncryptedData: false,
    });
    this.add('User', { Id: AUTOMATED_PROCESS, UserType: 'AutomatedProcess' });
    this.add('User', { Id: MEMORY_ORG_USER, Name: 'Ada Admin' });
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
      return { DailyApiRequests: this.limits, FileStorageMB: this.fileStorage };
    }
    return super.request(request);
  }
}

const dirs: string[] = [];

beforeEach(() => {
  clock.now = T0;
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  removeTaken();
  vi.mocked(getJsforceConnection).mockReset();
});

function storeAt(dir: string, name: string): OrgCheckpointStore {
  const opened = openCheckpointStore({ root: join(dir, name), locksDir: join(dir, 'locks') });
  if ('refusal' in opened) throw new Error(`no store: ${opened.refusal.reason}`);
  return opened.store;
}

interface Taken {
  dir: string;
  org: TransferOrg;
  store: OrgCheckpointStore;
  checkpoint: OrgCheckpoint;
  folder: CheckpointFolder;
}

/** The accounts, their files and the setting long before, then a checkpoint of the accounts and every setting. */
async function taken(): Promise<Taken> {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-archive-'));
  dirs.push(dir);
  const store = storeAt(dir, 'here');
  const org = new TransferOrg();
  clock.now = LONG_AGO;
  org.add('Account', { Id: account(1), Name: MARKER });
  // Names that do not compress, so that the file spans many blocks of 4 KiB.
  for (let n = 2; n <= ACCOUNTS; n++) {
    org.add('Account', { Id: account(n), Name: createHash('sha512').update(`${n}`).digest('hex') });
  }
  org.add('Account', { Id: account(ACCOUNTS + 1), Name: 'Deleted long ago' });
  clock.now = LONG_AGO + 60_000;
  org.trash('Account', account(ACCOUNTS + 1));
  org.add(HIERARCHY, { Id: hier(1), SetupOwnerId: ORG_ID, Value__c: 'org default' });
  org.add(HIERARCHY, { Id: hier(2), SetupOwnerId: PROFILE, Value__c: 'profile' });
  org.addFile({
    documentId: fileId(1),
    title: 'Contract.pdf',
    size: 2048,
    links: [{ entityId: account(1) }],
  });
  clock.now = T0;
  vi.mocked(getJsforceConnection).mockResolvedValue({
    query: (soql: string, options?: { scanAll?: boolean }) => org.query(soql, options),
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
      objects: ['Account'],
      customSettings: 'all',
      name: 'Before UAT of Northwind',
    },
  );
  if (!outcome.taken) throw new Error(`refused: ${outcome.refusal.message}`);
  return {
    dir,
    org,
    store,
    checkpoint: outcome.checkpoint,
    folder: store.folderOf(ORG_ID, outcome.checkpoint.checkpointId),
  };
}

/** The checkpoint exported, in blocks of 4 KiB so that it spans many, and its key. */
async function exported(t: Taken, key = newArchiveKey()): Promise<{ file: string; key: Buffer }> {
  const read = await t.store.read(t.checkpoint.checkpointId);
  if (!read?.checkpoint) throw new Error('the checkpoint is gone');
  const file = join(t.dir, `before-uat${ARCHIVE_EXTENSION}`);
  await exportCheckpointArchive({
    folder: t.folder,
    checkpoint: read.checkpoint,
    out: file,
    key,
    sandforgeVersion: '1.70.0',
    chunkBytes: 4096,
  });
  return { file, key };
}

/** The header of a file, read, or a failed test. */
async function headerOf(file: string): Promise<ArchiveRead> {
  const read = await readArchiveHeader(file);
  if ('refusal' in read) throw new Error(read.refusal.message);
  return read.read;
}

/** The file imported into `store`, as a teammate's machine imports it. */
async function imported(
  store: OrgCheckpointStore,
  file: string,
  key: Buffer,
  extra: { freeBytes?: (dir: string) => Promise<number | undefined>; read?: ArchiveRead } = {},
): Promise<ArchiveImported> {
  return importCheckpointArchive({
    store,
    file,
    read: extra.read ?? (await headerOf(file)),
    key,
    alias: 'TEAM-SB',
    keepDays: 30,
    takenOn: { host: 'teammate-laptop', pid: 4242 },
    now: new Date(PREVIEWED),
    ...(extra.freeBytes ? { freeBytes: extra.freeBytes } : {}),
  });
}

/** Every file under a folder, by its path in it. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(relative(dir, path).split('\\').join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/** What a refused import must leave: nothing listed, no file in the store, no folder of an import. */
async function nothingKept(store: OrgCheckpointStore): Promise<void> {
  expect(await store.list()).toEqual([]);
  expect(filesUnder(store.root)).toEqual([]);
  const folders = existsSync(store.root)
    ? readdirSync(store.root).flatMap((org) => readdirSync(join(store.root, org)))
    : [];
  expect(folders).toEqual([]);
}

/** The preview of a checkpoint of a store, read at the same moment, without its own id. */
async function previewOf(
  org: TransferOrg,
  store: OrgCheckpointStore,
  checkpointId: string,
): Promise<Omit<RewindDiff, 'previewId'> & { previewId: undefined }> {
  clock.now = PREVIEWED;
  const read = await store.read(checkpointId);
  if (!read?.checkpoint) throw new Error('the checkpoint is gone');
  const outcome = await previewCheckpoint(
    { org, store },
    {
      checkpoint: read.checkpoint,
      folder: read.folder,
      orgName: 'DEV-ED',
      registered: { orgType: 'Developer' },
      username: 'tester@example.com',
    },
  );
  if (!outcome.previewed) throw new Error(outcome.refusal.message);
  return { ...outcome.diff, previewId: undefined };
}

// ─── A file forged from the format, for what no export writes ────────────────

const BLOCK_KEY_INFO = 'sandforge-checkpoint/1 block key';
const KEY_CHECK_INFO = 'sandforge-checkpoint/1 key check';

/** One entry of a forged file: its line, then its bytes. */
function entry(path: string, bytes: Buffer): Buffer {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return Buffer.concat([
    Buffer.from(`${JSON.stringify({ path, bytes: bytes.length, sha256 })}\n`),
    bytes,
  ]);
}

/**
 * A `.sfcheckpoint` file made as the format's comment says one is: the
 * header, then the entries gzipped and sealed in STREAM blocks.
 */
function forged(
  key: Buffer,
  entries: Buffer,
  header: Partial<CheckpointArchiveHeader> & Record<string, unknown> = {},
  options: { lastSealedAsLast?: boolean } = {},
): Buffer {
  const salt = randomBytes(32);
  const prefix = randomBytes(8);
  const line = Buffer.from(
    `${JSON.stringify({
      format: 'sandforge-checkpoint',
      formatVersion: 1,
      checkpointFormat: 1,
      sandforgeVersion: '1.70.0',
      organizationId: ORG_ID,
      orgTier: 'developer',
      checkpointId: 'ck-20261022-140512-a1b2',
      takenAt: new Date(T0).toISOString(),
      records: 0,
      objects: 0,
      files: 1,
      bytes: 10,
      cipher: 'aes-256-gcm',
      kdf: 'hkdf-sha256',
      salt: salt.toString('hex'),
      noncePrefix: prefix.toString('hex'),
      keyCheck: Buffer.from(hkdfSync('sha256', key, salt, KEY_CHECK_INFO, 16)).toString('hex'),
      chunkBytes: 4096,
      ...header,
    })}\n`,
  );
  const blockKey = Buffer.from(hkdfSync('sha256', key, salt, BLOCK_KEY_INFO, 32));
  const headerHash = createHash('sha256').update(line).digest();
  const body = gzipSync(entries);
  const blocks: Buffer[] = [];
  const count = Math.ceil(body.length / 4096);
  for (let index = 0; index < count; index++) {
    const nonce = Buffer.alloc(12);
    prefix.copy(nonce, 0);
    nonce.writeUInt32BE(index, 8);
    const aad = Buffer.alloc(37);
    headerHash.copy(aad, 0);
    aad.writeUInt32BE(index, 32);
    aad[36] = index === count - 1 && options.lastSealedAsLast !== false ? 1 : 0;
    const cipher = createCipheriv('aes-256-gcm', blockKey, nonce, { authTagLength: 16 });
    cipher.setAAD(aad);
    blocks.push(
      cipher.update(body.subarray(index * 4096, (index + 1) * 4096)),
      cipher.final(),
      cipher.getAuthTag(),
    );
  }
  return Buffer.concat([line, ...blocks]);
}

/** The blocks of an exported file, as they lie after its header, each with its tag. */
function blocksOf(file: string, read: ArchiveRead): { head: Buffer; blocks: Buffer[] } {
  const bytes = readFileSync(file);
  const sealedBytes = read.header.chunkBytes + 16;
  const blocks: Buffer[] = [];
  for (let at = read.headerBytes; at < bytes.length; at += sealedBytes) {
    blocks.push(bytes.subarray(at, Math.min(at + sealedBytes, bytes.length)));
  }
  return { head: bytes.subarray(0, read.headerBytes), blocks };
}

// ─── The round trip ──────────────────────────────────────────────────────────

describe('a checkpoint exported to a file and imported on another machine', () => {
  it('comes back file for file — its compressed values as the members they are, its files, its custom setting, what a rewind recorded — its index made again as the take made it, and previews as it did', async () => {
    const t = await taken();
    // Positive control: the checkpoint holds files, a custom setting and compressed values.
    expect(t.checkpoint.files).toMatchObject({ documents: 1, links: 1 });
    expect(t.checkpoint.objects.find((o) => o.objectApiName === HIERARCHY)?.customSetting).toBe(
      'hierarchy',
    );
    // What a rewind recorded of a record the bin no longer gave back travels with it.
    await NotInBin.add(t.folder, 'Account', ['001000000000077AAA']);
    const { file, key } = await exported(t);
    const there = storeAt(t.dir, 'teammate');

    const done = await imported(there, file, key);

    expect(done).toMatchObject({ imported: true, outcome: 'imported' });
    const kept = there.folderOf(ORG_ID, t.checkpoint.checkpointId);
    const carried = (await exportedFilesOf(t.folder)).filter((f) => f.path !== 'checkpoint.json');
    expect(carried.map((f) => f.path)).toEqual(
      expect.arrayContaining([
        'fingerprints.json.gz',
        'snapshots.json',
        'files/links.ndjson.gz',
        'files/documents.ndjson.gz',
        'index/notInBin.ndjson',
      ]),
    );
    expect(carried.some((f) => /^backups\/.+__Hier__c\.ndjson\.gz$/.test(f.path))).toBe(true);
    expect(carried.some((f) => /^bin\/Account\.ids$/.test(f.path))).toBe(true);
    for (const { path, file: here } of carried) {
      expect(
        readFileSync(join(kept.dir, ...path.split('/'))).equals(readFileSync(here)),
        path,
      ).toBe(true);
    }
    // Members as they are: gzip's header with its SF subfield, never inflated and made again.
    const values = carried.find((f) => /__Account\.ndjson\.gz$/.test(f.path));
    const valuesThere = readFileSync(join(kept.dir, ...(values?.path ?? '').split('/')));
    expect([...valuesThere.subarray(0, 4)]).toEqual([0x1f, 0x8b, 8, 4]);
    expect(valuesThere.subarray(12, 14).toString('latin1')).toBe('SF');
    // The index is made again, byte for byte the take's.
    for (const { objectApiName } of t.checkpoint.objects) {
      expect(
        readFileSync(indexFileOf(kept, objectApiName)).equals(
          readFileSync(indexFileOf(t.folder, objectApiName)),
        ),
      ).toBe(true);
    }
    const listed = await there.list({ now: new Date(PREVIEWED) });
    expect(listed).toEqual([
      expect.objectContaining({ checkpointId: t.checkpoint.checkpointId, valid: true }),
    ]);
    expect(await previewOf(t.org, there, t.checkpoint.checkpointId)).toEqual(
      await previewOf(t.org, t.store, t.checkpoint.checkpointId),
    );
  });

  it('carries a checkpoint taken before the compression as it is, plain, its index made again in its own form', async () => {
    const t = await takenOfAccounts(undefined, undefined, undefined, {}, nodeBackupFiles);
    const values = (await exportedFilesOf(t.folder)).filter((f) => f.path.startsWith('backups/'));
    // Positive control: the values are plain, as SandForge 1.69 kept them.
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((f) => f.path.endsWith('.ndjson'))).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'sandforge-archive-plain-'));
    dirs.push(dir);
    const file = join(dir, `plain${ARCHIVE_EXTENSION}`);
    const key = newArchiveKey();
    await exportCheckpointArchive({
      folder: t.folder,
      checkpoint: t.checkpoint,
      out: file,
      key,
      sandforgeVersion: '1.70.0',
    });
    const there = storeAt(dir, 'teammate');

    expect(await imported(there, file, key)).toMatchObject({ imported: true, outcome: 'imported' });

    const kept = there.folderOf(ORG_ID, t.checkpoint.checkpointId);
    for (const { path, file: here } of values) {
      expect(readFileSync(join(kept.dir, ...path.split('/'))).equals(readFileSync(here))).toBe(
        true,
      );
    }
    for (const { objectApiName } of t.checkpoint.objects) {
      const index = readFileSync(indexFileOf(kept, objectApiName));
      expect(index.subarray(0, 8).toString('latin1')).toBe('SFCKIDX1');
      expect(index.equals(readFileSync(indexFileOf(t.folder, objectApiName)))).toBe(true);
    }
  });

  it('leaves without what is this machine’s alone, and takes this machine’s alias, keep and origin', async () => {
    const t = await taken();
    const changed = await t.store.update(t.checkpoint.checkpointId, (checkpoint) => ({
      ...checkpoint,
      lastRewind: { rewindId: 'rw-20261022-141102-e5f6', endedAt: new Date(T0).toISOString() },
      expiresAt: null,
    }));
    const { file, key } = await exported(t);
    const there = storeAt(t.dir, 'teammate');

    const done = await imported(there, file, key);

    if (!done.imported) throw new Error(done.refusal.message);
    const { checkpoint } = done;
    expect(checkpoint.lastRewind).toBeUndefined();
    expect(checkpoint.org.alias).toBe('TEAM-SB');
    expect(checkpoint.takenOn).toEqual({ host: 'teammate-laptop', pid: 4242 });
    expect(checkpoint.expiresAt).toBe(new Date(PREVIEWED + 30 * 24 * 60 * 60_000).toISOString());
    expect(checkpoint.importedFrom).toEqual({
      at: new Date(PREVIEWED).toISOString(),
      sandforgeVersion: '1.70.0',
      sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    });
    // What it takes here, counted as a take counts it, its own file among it.
    const kept = there.folderOf(ORG_ID, checkpoint.checkpointId);
    const onDisk = filesUnder(kept.dir).reduce(
      (total, path) => total + statSync(join(kept.dir, path)).size,
      0,
    );
    expect(checkpoint.bytes).toBe(onDisk);
    // The rest is the checkpoint as it was taken.
    const strip = (c: OrgCheckpoint) => ({
      ...c,
      lastRewind: undefined,
      takenOn: undefined,
      expiresAt: undefined,
      bytes: undefined,
      importedFrom: undefined,
      org: { ...c.org, alias: undefined },
    });
    expect(strip(checkpoint)).toEqual(strip(changed));
    expect(JSON.parse(readFileSync(kept.checkpointFile, 'utf8'))).toEqual(checkpoint);
  });

  it('is left as it is when the same checkpoint is kept already, and refused when another of its id is', async () => {
    const t = await taken();
    await NotInBin.add(t.folder, 'Account', ['001000000000077AAA']);
    const { file, key } = await exported(t);
    const there = storeAt(t.dir, 'teammate');
    await imported(there, file, key);
    const kept = there.folderOf(ORG_ID, t.checkpoint.checkpointId);
    const before = readFileSync(kept.checkpointFile, 'utf8');

    const again = await imported(there, file, key);
    expect(again).toMatchObject({ imported: true, outcome: 'alreadyKept' });
    expect(readFileSync(kept.checkpointFile, 'utf8')).toBe(before);

    // A rewind here has since recorded another record the bin no longer gives back: the
    // same files, one of them longer.
    await NotInBin.add(kept, 'Account', ['001000000000078AAA']);
    const other = await imported(there, file, key);
    expect(other).toMatchObject({ imported: false, refusal: { code: 'IMPORT_KEPT_OTHER' } });
    expect(readFileSync(kept.checkpointFile, 'utf8')).toBe(before);
    expect(readdirSync(join(there.root, kept.organizationId))).toEqual([t.checkpoint.checkpointId]);
  });
});

// ─── The file ────────────────────────────────────────────────────────────────

describe('a .sfcheckpoint file', () => {
  it('holds nothing readable — not the checkpoint’s name, its user, its alias nor a value — and its blocks inflate to nothing until decrypted', async () => {
    const t = await taken();
    const { file } = await exported(t);
    const bytes = readFileSync(file);
    const read = await headerOf(file);

    for (const clear of [MARKER, 'Before UAT', 'tester@example.com', 'DEV-ED', 'Contract.pdf']) {
      expect(bytes.includes(Buffer.from(clear)), clear).toBe(false);
    }
    // Encrypted, the blocks are no gzip stream: zlib refuses them.
    expect(() => gunzipSync(bytes.subarray(read.headerBytes))).toThrow();
    // Positive control: in the store, unencrypted, the value is there once inflated.
    const values = (await exportedFilesOf(t.folder)).find((f) =>
      /__Account\.ndjson\.gz$/.test(f.path),
    );
    expect(gunzipSync(readFileSync(values?.file ?? '')).toString('utf8')).toContain(MARKER);
  });

  it('names its org, its formats and its counts in a header read before any key, never a user nor an alias', async () => {
    const t = await taken();
    const { file } = await exported(t);

    const read = await headerOf(file);

    expect(read.header).toMatchObject({
      format: 'sandforge-checkpoint',
      formatVersion: 1,
      checkpointFormat: 1,
      sandforgeVersion: '1.70.0',
      organizationId: organizationKey(ORG_ID),
      orgTier: 'developer',
      checkpointId: t.checkpoint.checkpointId,
      takenAt: t.checkpoint.takenAt,
      records: t.checkpoint.objects.reduce((total, o) => total + o.records, 0),
      objects: t.checkpoint.objects.length,
      cipher: 'aes-256-gcm',
      kdf: 'hkdf-sha256',
      chunkBytes: 4096,
    });
    expect(Object.keys(read.header)).not.toEqual(
      expect.arrayContaining(['name', 'username', 'alias']),
    );
  });

  it('is written its owner’s alone, and never over a file there already', async () => {
    const t = await taken();
    const { file } = await exported(t);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    const read = await t.store.read(t.checkpoint.checkpointId);
    const before = readFileSync(file);

    await expect(
      exportCheckpointArchive({
        folder: t.folder,
        checkpoint: read?.checkpoint as OrgCheckpoint,
        out: file,
        key: newArchiveKey(),
        sandforgeVersion: '1.70.0',
      }),
    ).rejects.toMatchObject({ code: 'EXPORT_EXISTS' });
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(readdirSync(t.dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('encrypts each export under a block key of its own, the same key given twice', async () => {
    const t = await taken();
    const key = newArchiveKey();
    const one = await exported(t, key);
    const first = await headerOf(one.file);
    const firstBlocks = blocksOf(one.file, first).blocks;
    rmSync(one.file);

    const two = await exported(t, key);
    const second = await headerOf(two.file);

    expect(second.header.salt).not.toBe(first.header.salt);
    expect(second.header.keyCheck).not.toBe(first.header.keyCheck);
    expect(blocksOf(two.file, second).blocks[0].equals(firstBlocks[0])).toBe(false);
    // Both read back with the one key.
    const there = storeAt(t.dir, 'teammate');
    expect(await imported(there, two.file, key)).toMatchObject({ imported: true });
  });
});

// ─── Refusals ────────────────────────────────────────────────────────────────

describe('an import refused, nothing kept', () => {
  it('refuses a key that is not the file’s before a block is read', async () => {
    const t = await taken();
    const { file } = await exported(t);
    const there = storeAt(t.dir, 'teammate');

    const done = await imported(there, file, newArchiveKey());

    expect(done).toEqual({
      imported: false,
      refusal: {
        code: 'IMPORT_KEY',
        message: 'This key is not the one the file was exported with. Nothing was imported.',
      },
    });
    await nothingKept(there);
  });

  it('refuses a byte changed in a block, and one changed in a block’s tag, which only the tag tells', async () => {
    const t = await taken();
    const { file, key } = await exported(t);
    const read = await headerOf(file);
    const there = storeAt(t.dir, 'teammate');
    const original = readFileSync(file);
    expect(blocksOf(file, read).blocks.length).toBeGreaterThan(2);

    const inBlock = Buffer.from(original);
    inBlock[read.headerBytes + 4096 + 16 + 100] ^= 0x01;
    writeFileSync(file, inBlock);
    expect(await imported(there, file, key, { read })).toMatchObject({
      imported: false,
      refusal: {
        code: 'IMPORT_DAMAGED',
        message: expect.stringContaining('the 2nd of'),
      },
    });
    await nothingKept(there);

    // The last byte of the first block's tag: its ciphertext decrypts to what was sealed.
    const inTag = Buffer.from(original);
    inTag[read.headerBytes + 4096 + 15] ^= 0x01;
    writeFileSync(file, inTag);
    expect(await imported(there, file, key, { read })).toMatchObject({
      imported: false,
      refusal: { code: 'IMPORT_DAMAGED', message: expect.stringContaining('the 1st of') },
    });
    await nothingKept(there);
  });

  it('refuses a file cut after a whole block, and one whose blocks were put in another order', async () => {
    const t = await taken();
    const { file, key } = await exported(t);
    const read = await headerOf(file);
    const there = storeAt(t.dir, 'teammate');
    const { head, blocks } = blocksOf(file, read);

    // The block it now ends on was not sealed as the last.
    writeFileSync(file, Buffer.concat([head, ...blocks.slice(0, -1)]));
    expect(await imported(there, file, key)).toMatchObject({
      imported: false,
      refusal: {
        code: 'IMPORT_DAMAGED',
        message: expect.stringContaining(`of ${blocks.length - 1}, that does not decrypt`),
      },
    });
    await nothingKept(there);

    const swapped = [...blocks];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    writeFileSync(file, Buffer.concat([head, ...swapped]));
    expect(await imported(there, file, key)).toMatchObject({
      imported: false,
      refusal: { code: 'IMPORT_DAMAGED' },
    });
    await nothingKept(there);
  });

  it('refuses a file whose last block was not sealed as the last, though all it holds reads', async () => {
    const t = await taken();
    const there = storeAt(t.dir, 'teammate');
    const key = newArchiveKey();
    const file = join(t.dir, `forged${ARCHIVE_EXTENSION}`);
    const entries = Buffer.concat([
      entry('snapshots.json', Buffer.from('{}\n')),
      Buffer.from('{"end":true,"files":1}\n'),
    ]);

    writeFileSync(file, forged(key, entries, { bytes: 3 }, { lastSealedAsLast: false }));

    expect(await imported(there, file, key)).toMatchObject({
      imported: false,
      refusal: {
        code: 'IMPORT_DAMAGED',
        message: expect.stringContaining('the 1st of 1, that does not decrypt'),
      },
    });
    await nothingKept(there);
  });

  it('refuses a header changed since the export: every block authenticates it', async () => {
    const t = await taken();
    const { file, key } = await exported(t);
    const read = await headerOf(file);
    const there = storeAt(t.dir, 'teammate');
    const { head, blocks } = blocksOf(file, read);
    const changed = JSON.parse(head.toString('utf8'));
    changed.orgTier = 'sandbox';
    writeFileSync(file, Buffer.concat([Buffer.from(`${JSON.stringify(changed)}\n`), ...blocks]));

    expect(await imported(there, file, key)).toMatchObject({
      imported: false,
      refusal: { code: 'IMPORT_DAMAGED', message: expect.stringContaining('the 1st of') },
    });
    await nothingKept(there);
  });

  it('refuses the file the header read named once it holds another', async () => {
    const t = await taken();
    const { file, key } = await exported(t);
    const read = await headerOf(file);
    const there = storeAt(t.dir, 'teammate');
    await exported({ ...t, dir: mkdtempSync(join(t.dir, 'again-')) }).then(({ file: other }) => {
      writeFileSync(file, readFileSync(other));
    });

    expect(await imported(there, file, key, { read })).toMatchObject({
      imported: false,
      refusal: { code: 'IMPORT_DAMAGED', message: expect.stringContaining('changed since') },
    });
    await nothingKept(there);
  });

  it('tells a file a newer SandForge made, by its formats, before anything else of its header', async () => {
    const t = await taken();
    const file = join(t.dir, `newer${ARCHIVE_EXTENSION}`);
    for (const formats of [
      { formatVersion: 2, checkpointFormat: 1 },
      { formatVersion: 1, checkpointFormat: 2 },
    ]) {
      writeFileSync(
        file,
        `${JSON.stringify({
          format: 'sandforge-checkpoint',
          sandforgeVersion: '1.80.0',
          ...formats,
          cipher: 'xchacha20',
        })}\nrest`,
      );
      expect(await readArchiveHeader(file)).toEqual({
        refusal: {
          code: 'IMPORT_VERSION',
          message:
            `This file was made by SandForge 1.80.0, with checkpoint format ` +
            `${formats.checkpointFormat} in file format ${formats.formatVersion}, which this ` +
            'SandForge does not read: update SandForge, then import it. Nothing was imported.',
        },
      });
    }
    writeFileSync(file, 'PK\u0003\u0004 a zip, not a checkpoint');
    expect(await readArchiveHeader(file)).toMatchObject({
      refusal: { code: 'IMPORT_NOT_ARCHIVE' },
    });
  });

  it('refuses an entry that names a path outside the checkpoint’s folder, an absolute one, or a file no checkpoint holds', async () => {
    const t = await taken();
    const there = storeAt(t.dir, 'teammate');
    const key = newArchiveKey();
    const file = join(t.dir, `forged${ARCHIVE_EXTENSION}`);
    for (const path of [
      '../escaped.txt',
      '/etc/escaped',
      'C:\\escaped',
      'notes.txt',
      'index/Account.idx',
    ]) {
      const bytes = Buffer.from('0123456789');
      writeFileSync(
        file,
        forged(key, Buffer.concat([entry(path, bytes), Buffer.from('{"end":true,"files":1}\n')])),
      );
      expect(await imported(there, file, key), path).toMatchObject({
        imported: false,
        refusal: {
          code: 'IMPORT_DAMAGED',
          message: expect.stringContaining('no checkpoint holds'),
        },
      });
      await nothingKept(there);
    }
    expect(existsSync(join(t.dir, 'escaped.txt'))).toBe(false);
    // Positive control: the forge makes files the reader takes, as far as their checkpoint.json.
    writeFileSync(
      file,
      forged(
        key,
        Buffer.concat([
          entry('snapshots.json', Buffer.from('{}\n')),
          Buffer.from('{"end":true,"files":1}\n'),
        ]),
        { bytes: 3 },
      ),
    );
    expect(await imported(there, file, key)).toMatchObject({
      refusal: { message: expect.stringContaining('holds no checkpoint.json') },
    });
  });

  it('refuses a snapshot that holds other records than its checkpoint counts, as a take does', async () => {
    const t = await taken();
    // A line of the account's values dropped from the snapshot before the export.
    const values = (await exportedFilesOf(t.folder)).find((f) =>
      /__Account\.ndjson\.gz$/.test(f.path),
    );
    const lines = gunzipSync(readFileSync(values?.file ?? ''))
      .toString('utf8')
      .split('\n');
    const kept = `${lines.filter((line) => line !== '' && !line.includes(MARKER)).join('\n')}\n`;
    writeFileSync(values?.file ?? '', await snapshotMember(Buffer.from(kept)));
    const { file, key } = await exported(t);
    const there = storeAt(t.dir, 'teammate');

    expect(await imported(there, file, key)).toMatchObject({
      imported: false,
      refusal: {
        code: 'IMPORT_DAMAGED',
        message: expect.stringContaining(
          `holds ${ACCOUNTS - 1} records of Account where its checkpoint counts ${ACCOUNTS}`,
        ),
      },
    });
    await nothingKept(there);
  });

  it('refuses a disk without room for its files and their index', async () => {
    const t = await taken();
    const { file, key } = await exported(t);
    const there = storeAt(t.dir, 'teammate');

    const done = await imported(there, file, key, { freeBytes: async () => 1024 });

    expect(done).toMatchObject({
      imported: false,
      refusal: { code: 'IMPORT_DISK', message: expect.stringContaining('make room') },
    });
    await nothingKept(there);
  });
});

// ─── The key ─────────────────────────────────────────────────────────────────

describe('the key of a checkpoint file', () => {
  it('is shown as 52 letters and digits in groups of four, and read back whatever its case, dashes and spaces', () => {
    const key = newArchiveKey();
    const text = archiveKeyText(key);

    expect(text).toMatch(/^(?:[A-Z2-7]{4}-){12}[A-Z2-7]{4}$/);
    expect(parseArchiveKey(text)?.equals(key)).toBe(true);
    expect(parseArchiveKey(text.toLowerCase().replaceAll('-', ' '))?.equals(key)).toBe(true);
    expect(parseArchiveKey(text.replaceAll('-', ''))?.equals(key)).toBe(true);
  });

  it('reads no key from a text one letter short, one too many, a letter base32 has not, or a last letter whose spare bits are set', () => {
    const text = archiveKeyText(Buffer.alloc(32));
    expect(text.endsWith('A')).toBe(true);

    expect(parseArchiveKey(text.slice(0, -1))).toBeUndefined();
    expect(parseArchiveKey(`${text}A`)).toBeUndefined();
    expect(parseArchiveKey(`${text.slice(0, -1)}1`)).toBeUndefined();
    // The 256th bit is the first of the last letter's five; the four after it are none of the key's.
    expect(parseArchiveKey(`${text.slice(0, -1)}Q`)?.[31]).toBe(1);
    expect(parseArchiveKey(`${text.slice(0, -1)}B`)).toBeUndefined();
  });
});
