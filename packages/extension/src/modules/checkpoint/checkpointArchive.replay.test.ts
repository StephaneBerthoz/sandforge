import { createCipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CheckpointReplayAnnex, OrgCheckpoint } from '@sandforge/shared';

import { MEMORY_ORG_USER } from '../../test/memoryRemovalOrg.js';
import {
  FIELDS,
  ORG_ID,
  PREVIEWED,
  RewindTestOrg,
  STAMP_FIELDS,
  T0,
  account,
  removeTaken,
  taken,
  writable,
} from '../../test/rewindTestOrg.js';
import {
  ARCHIVE_EXTENSION,
  exportCheckpointArchive,
  importCheckpointArchive,
  importReceivedArchive,
  parseArchiveKey,
  readArchiveHeader,
  receivedStoreRootOf,
  type ArchiveImported,
} from './checkpointArchive.js';
import {
  openCheckpointStore,
  organizationKey,
  replayAnnexFileOf,
  type CheckpointFolder,
  type OrgCheckpointStore,
} from './OrgCheckpointStore.js';
import { readReplayAnnex } from './replay/replayAnnex.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * A checkpoint's replay annex as it leaves the machine and comes back, file
 * format 2; a file SandForge 1.80 exported, read as it was; and a file a
 * teammate sent, imported to be replayed without asking its org anything.
 *
 * The file of 1.80 (`fixtures/checkpoint-1.80.sfcheckpoint.json`) was written
 * by SandForge 1.80's own export, of a Developer Edition checkpoint of six
 * accounts, a hierarchy custom setting and a file: its bytes and its key as
 * they came out, so that what this SandForge reads of it is what a teammate
 * on 1.80 sends.
 */

const dirs: string[] = [];

afterEach(() => {
  removeTaken();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-archive-replay-'));
  dirs.push(dir);
  return dir;
}

function storeAt(dir: string, name: string): OrgCheckpointStore {
  const opened = openCheckpointStore({ root: join(dir, name), locksDir: join(dir, 'locks') });
  if ('refusal' in opened) throw new Error(`no store: ${opened.refusal.reason}`);
  return opened.store;
}

/** Accounts with an owner, as an org describes them. */
const OWNED_FIELDS = {
  ...FIELDS,
  Account: [
    ...STAMP_FIELDS,
    writable('Name'),
    writable('OwnerId', 'reference', { referenceTo: ['Group', 'User'] }),
  ],
};

/** An org whose accounts' owner and record type its annex keeps. */
function ownedOrg(): RewindTestOrg {
  const org = new RewindTestOrg({ fields: OWNED_FIELDS });
  org.missingFields.set('RecordType', new Set(['IsPersonType']));
  org.add('User', {
    Id: MEMORY_ORG_USER,
    Username: 'ada@example.com.uat',
    Name: 'Ada Admin',
    IsActive: true,
    UserType: 'Standard',
  });
  org.add('RecordType', {
    Id: '012000000000001AAA',
    SobjectType: 'Account',
    DeveloperName: 'Retail',
    NamespacePrefix: null,
    Name: 'Retail',
    IsActive: true,
  });
  return org;
}

/** A checkpoint of two owned accounts, taken with its annex, of an org that says it is a Staging copy. */
async function takenWithAnnex() {
  const t = await taken(
    (org) => {
      org.add('Account', { Id: account(1), Name: 'One', OwnerId: MEMORY_ORG_USER });
      org.add('Account', { Id: account(2), Name: 'Two', OwnerId: MEMORY_ORG_USER });
    },
    ownedOrg(),
    ['Account'],
  );
  const checkpoint = await t.store.update(t.checkpoint.checkpointId, (kept) => ({
    ...kept,
    org: { ...kept.org, dataStorageMaxMB: 5120, staging: true },
  }));
  return { ...t, checkpoint };
}

/** A checkpoint exported to a file in `dir`, under a key of its own. */
async function exportedTo(
  dir: string,
  folder: CheckpointFolder,
  checkpoint: OrgCheckpoint,
): Promise<{ file: string; key: Buffer }> {
  const file = join(dir, `export-${randomBytes(3).toString('hex')}${ARCHIVE_EXTENSION}`);
  const key = randomBytes(32);
  await exportCheckpointArchive({
    folder,
    checkpoint,
    out: file,
    key,
    sandforgeVersion: '1.81.0',
    chunkBytes: 4096,
  });
  return { file, key };
}

/** A file imported into `store` as a teammate's machine imports it, its org having answered. */
async function importedInto(
  store: OrgCheckpointStore,
  file: string,
  key: Buffer,
): Promise<ArchiveImported> {
  const read = await readArchiveHeader(file);
  if ('refusal' in read) throw new Error(read.refusal.message);
  return importCheckpointArchive({
    store,
    file,
    read: read.read,
    key,
    alias: 'TEAM-SB',
    keepDays: 30,
    takenOn: { host: 'teammate-laptop', pid: 4242 },
    now: new Date(PREVIEWED),
  });
}

/** The file SandForge 1.80 exported, written where `dir` is, and its key. */
function fileOf180(dir: string): { file: string; key: Buffer; sha256: string } {
  const fixture = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'checkpoint-1.80.sfcheckpoint.json'), 'utf8'),
  ) as { key: string; sha256: string; base64: string };
  const file = join(dir, `made-by-1.80${ARCHIVE_EXTENSION}`);
  writeFileSync(file, Buffer.from(fixture.base64, 'base64'), { mode: 0o600 });
  const key = parseArchiveKey(fixture.key);
  if (key === undefined) throw new Error('the fixture holds no key');
  return { file, key, sha256: fixture.sha256 };
}

describe('a checkpoint with its replay annex, exported and imported', () => {
  it('leaves in file format 2, its org’s storage and Staging mark in the header, and comes back with its annex as it was', async () => {
    const t = await takenWithAnnex();
    const dir = scratch();
    const annex = await readReplayAnnex(t.folder);
    expect(annex?.users.map((user) => user.username)).toEqual(['ada@example.com.uat']);

    const { file, key } = await exportedTo(dir, t.folder, t.checkpoint);
    const read = await readArchiveHeader(file);
    if ('refusal' in read) throw new Error(read.refusal.message);
    expect(read.read.header).toMatchObject({
      formatVersion: 2,
      checkpointFormat: 1,
      dataStorageMaxMB: 5120,
      staging: true,
    });

    const there = storeAt(dir, 'teammate');
    const imported = await importedInto(there, file, key);
    if (!imported.imported) throw new Error(imported.refusal.message);
    const folder = there.folderOf(ORG_ID, t.checkpoint.checkpointId);
    expect(await readReplayAnnex(folder)).toEqual(annex);
    expect(imported.checkpoint.replayAnnex).toEqual(t.checkpoint.replayAnnex);
    expect(imported.checkpoint.org).toMatchObject({ dataStorageMaxMB: 5120, staging: true });
  });

  it('leaves in file format 1 a checkpoint taken before 1.81, which has no annex: SandForge 1.80 imports it as ever', async () => {
    const t = await takenWithAnnex();
    const dir = scratch();
    rmSync(replayAnnexFileOf(t.folder));
    const before181 = await t.store.update(t.checkpoint.checkpointId, (kept) => ({
      ...kept,
      replayAnnex: undefined,
      org: { ...kept.org, dataStorageMaxMB: undefined, staging: undefined },
    }));

    const { file, key } = await exportedTo(dir, t.folder, before181);

    const read = await readArchiveHeader(file);
    if ('refusal' in read) throw new Error(read.refusal.message);
    expect(read.read.header.formatVersion).toBe(1);
    expect(read.read.header).not.toHaveProperty('dataStorageMaxMB');
    expect(read.read.header).not.toHaveProperty('staging');
    const imported = await importedInto(storeAt(dir, 'teammate'), file, key);
    expect(imported).toMatchObject({ imported: true, outcome: 'imported' });
  });

  it('refuses to export an annex this machine could not replay, which the teammate’s would refuse whole', async () => {
    const t = await takenWithAnnex();
    writeFileSync(replayAnnexFileOf(t.folder), gzipSync('{"version":1}'));

    await expect(exportedTo(scratch(), t.folder, t.checkpoint)).rejects.toMatchObject({
      code: 'damaged',
    });
  });
});

describe('a file SandForge 1.80 exported', () => {
  it('reads as a file of format 1, without an annex, made by 1.80', async () => {
    const { file, sha256 } = fileOf180(scratch());
    expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(sha256);

    const read = await readArchiveHeader(file);

    if ('refusal' in read) throw new Error(read.refusal.message);
    expect(read.read.header).toMatchObject({
      formatVersion: 1,
      checkpointFormat: 1,
      sandforgeVersion: '1.80.0',
      orgTier: 'developer',
      organizationId: organizationKey(ORG_ID),
      records: 9,
      objects: 3,
    });
    expect(read.read.header).not.toHaveProperty('dataStorageMaxMB');
  });

  it('is imported with its records, its custom setting and its file, and no annex: a replay of it is made without one', async () => {
    const dir = scratch();
    const { file, key } = fileOf180(dir);
    const store = storeAt(dir, 'here');

    const imported = await importedInto(store, file, key);

    if (!imported.imported) throw new Error(imported.refusal.message);
    const { checkpoint } = imported;
    expect(checkpoint.name).toBe('Before UAT of Northwind');
    expect(checkpoint.objects.map((object) => [object.objectApiName, object.records])).toEqual([
      ['Account', 6],
      ['ContentDocument', 1],
      ['Hier__c', 2],
    ]);
    expect(checkpoint.files).toMatchObject({ documents: 1, links: 1 });
    expect(checkpoint).not.toHaveProperty('replayAnnex');
    expect(checkpoint.org).not.toHaveProperty('dataStorageMaxMB');
    expect(checkpoint.importedFrom?.sandforgeVersion).toBe('1.80.0');
    const folder = store.folderOf(ORG_ID, checkpoint.checkpointId);
    expect(await readReplayAnnex(folder)).toBeUndefined();
    expect(await store.list()).toMatchObject([
      { checkpointId: checkpoint.checkpointId, valid: true },
    ]);
  });
});

describe('a file received, to be replayed', () => {
  it('is kept in the store of files received, no org asked, never in the store a rewind reads', async () => {
    const dir = scratch();
    const { file, key } = fileOf180(dir);
    const store = storeAt(dir, 'here');

    const received = await importReceivedArchive({
      storeRoot: store.root,
      locksDir: join(dir, 'locks'),
      file,
      key,
      keepDays: 30,
      takenOn: { host: 'laptop', pid: 7 },
      now: new Date(T0),
    });

    if (!received.imported) throw new Error(received.refusal.message);
    expect(received.store?.root).toBe(receivedStoreRootOf(store.root));
    expect(await received.store?.list()).toMatchObject([
      { checkpointId: received.checkpoint.checkpointId, valid: true },
    ]);
    // The store a rewind reads lists none of it, and its sweep leaves it.
    expect(await store.list()).toEqual([]);
    expect((await store.sweep(new Date(T0 + 400 * 86_400_000))).checkpoints).toEqual([]);
    expect(existsSync(receivedStoreRootOf(store.root))).toBe(true);

    const again = await importReceivedArchive({
      storeRoot: store.root,
      locksDir: join(dir, 'locks'),
      file,
      key,
      keepDays: 30,
      takenOn: { host: 'laptop', pid: 7 },
    });
    expect(again).toMatchObject({ imported: true, outcome: 'alreadyKept' });
  });

  it('refuses a key that is not the file’s before a block is read, and keeps nothing', async () => {
    const dir = scratch();
    const { file } = fileOf180(dir);
    const store = storeAt(dir, 'here');

    const refused = await importReceivedArchive({
      storeRoot: store.root,
      locksDir: join(dir, 'locks'),
      file,
      key: randomBytes(32),
      keepDays: 30,
      takenOn: { host: 'laptop', pid: 7 },
    });

    expect(refused).toMatchObject({ imported: false, refusal: { code: 'IMPORT_KEY' } });
    const opened = openCheckpointStore({
      root: receivedStoreRootOf(store.root),
      locksDir: join(dir, 'locks'),
    });
    if ('refusal' in opened) throw new Error(opened.refusal.reason);
    expect(await opened.store.list()).toEqual([]);
  });
});

// ─── Files forged from the format, for what no export writes ────────────────

const BLOCK_KEY_INFO = 'sandforge-checkpoint/1 block key';
const KEY_CHECK_INFO = 'sandforge-checkpoint/1 key check';
const CHECKPOINT_ID = 'ck-20261113-091500-k3m9';

/** One entry of a forged file: its line, then its bytes. */
function entry(path: string, bytes: Buffer): Buffer {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return Buffer.concat([
    Buffer.from(`${JSON.stringify({ path, bytes: bytes.length, sha256 })}\n`),
    bytes,
  ]);
}

/** A checkpoint of no object, which needs no snapshot: what the annex's checks are reached with. */
function emptyCheckpoint(replayAnnex?: OrgCheckpoint['replayAnnex']): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      checkpointId: CHECKPOINT_ID,
      name: 'Forged',
      org: {
        organizationId: ORG_ID,
        username: 'admin@example.com',
        instanceUrl: 'https://example.my.salesforce.com',
        isSandbox: true,
        organizationType: 'Developer Edition',
        tier: 'sandbox',
      },
      takenBy: { userId: MEMORY_ORG_USER, viewAllData: true, modifyAllData: true },
      readFrom: new Date(T0).toISOString(),
      takenAt: new Date(T0).toISOString(),
      scope: { mode: 'picked', leftOut: [] },
      objects: [],
      ignoredFields: [],
      snapshotId: `snapshot-${CHECKPOINT_ID}`,
      movedWhileTaken: { changed: 0, deleted: 0, created: 0 },
      status: 'ready',
      ...(replayAnnex !== undefined ? { replayAnnex } : {}),
    }),
  );
}

/** An annex of one user, of the org `organizationId`. */
function oneUserAnnex(organizationId = ORG_ID): CheckpointReplayAnnex {
  return {
    version: 1,
    organizationId,
    recordTypes: [],
    users: [
      {
        id: MEMORY_ORG_USER,
        username: 'ada@example.com',
        name: 'Ada Admin',
        isActive: true,
        userType: 'Standard',
      },
    ],
    queues: [],
    unread: [],
  };
}

const ONE_USER = { recordTypes: 0, users: 1, queues: 0, standardPricebook: false };

/** A `.sfcheckpoint` file made as the format's comment says one is, of `files` and of `formatVersion`. */
function forged(key: Buffer, files: Array<[string, Buffer]>, formatVersion: number): Buffer {
  const body = Buffer.concat([
    ...files.map(([path, bytes]) => entry(path, bytes)),
    Buffer.from(`${JSON.stringify({ end: true, files: files.length })}\n`),
  ]);
  const salt = randomBytes(32);
  const prefix = randomBytes(8);
  const line = Buffer.from(
    `${JSON.stringify({
      format: 'sandforge-checkpoint',
      formatVersion,
      checkpointFormat: 1,
      sandforgeVersion: '1.81.0',
      organizationId: organizationKey(ORG_ID),
      orgTier: 'sandbox',
      checkpointId: CHECKPOINT_ID,
      takenAt: new Date(T0).toISOString(),
      records: 0,
      objects: 0,
      files: files.length,
      bytes: files.reduce((total, [, bytes]) => total + bytes.length, 0),
      cipher: 'aes-256-gcm',
      kdf: 'hkdf-sha256',
      salt: salt.toString('hex'),
      noncePrefix: prefix.toString('hex'),
      keyCheck: Buffer.from(hkdfSync('sha256', key, salt, KEY_CHECK_INFO, 16)).toString('hex'),
      chunkBytes: 4096,
    })}\n`,
  );
  const blockKey = Buffer.from(hkdfSync('sha256', key, salt, BLOCK_KEY_INFO, 32));
  const headerHash = createHash('sha256').update(line).digest();
  const compressed = gzipSync(body);
  const blocks: Buffer[] = [];
  const count = Math.ceil(compressed.length / 4096);
  for (let index = 0; index < count; index++) {
    const nonce = Buffer.alloc(12);
    prefix.copy(nonce, 0);
    nonce.writeUInt32BE(index, 8);
    const aad = Buffer.alloc(37);
    headerHash.copy(aad, 0);
    aad.writeUInt32BE(index, 32);
    aad[36] = index === count - 1 ? 1 : 0;
    const cipher = createCipheriv('aes-256-gcm', blockKey, nonce, { authTagLength: 16 });
    cipher.setAAD(aad);
    blocks.push(
      cipher.update(compressed.subarray(index * 4096, (index + 1) * 4096)),
      cipher.final(),
      cipher.getAuthTag(),
    );
  }
  return Buffer.concat([line, ...blocks]);
}

/** Field prints of no object. */
const NO_PRINTS = gzipSync(`${JSON.stringify({ version: 1, objects: {} })}\n`);

describe('an import of a file whose annex is not the one its export writes', () => {
  /** A forged file imported into a store of its own: how it ended, and the store. */
  async function importForged(
    files: Array<[string, Buffer]>,
    formatVersion: number,
  ): Promise<{ imported: ArchiveImported; store: OrgCheckpointStore }> {
    const dir = scratch();
    const key = randomBytes(32);
    const file = join(dir, `forged${ARCHIVE_EXTENSION}`);
    writeFileSync(file, forged(key, files, formatVersion));
    const store = storeAt(dir, 'teammate');
    return { imported: await importedInto(store, file, key), store };
  }

  const annexOf = (annex: CheckpointReplayAnnex): Buffer => gzipSync(JSON.stringify(annex));

  it('imports a file of format 2 whose annex is its checkpoint’s, as counted', async () => {
    const { imported } = await importForged(
      [
        ['checkpoint.json', emptyCheckpoint(ONE_USER)],
        ['fingerprints.json.gz', NO_PRINTS],
        ['replay.json.gz', annexOf(oneUserAnnex())],
      ],
      2,
    );
    expect(imported).toMatchObject({ imported: true, outcome: 'imported' });
  });

  it.each([
    [
      'carries an annex its file format does not',
      1,
      [['replay.json.gz', annexOf(oneUserAnnex())]] as Array<[string, Buffer]>,
      'carries a replay annex, which its file format does not',
    ],
    ['says it carries an annex and holds none', 2, [], 'says it carries a replay annex'],
    [
      'holds an annex of another org',
      2,
      [['replay.json.gz', annexOf(oneUserAnnex('00D000000000002AAA'))]] as Array<[string, Buffer]>,
      'holds the replay annex of another org',
    ],
    [
      'holds an annex its checkpoint counts otherwise',
      2,
      [['replay.json.gz', annexOf({ ...oneUserAnnex(), users: [] })]] as Array<[string, Buffer]>,
      'holds another replay annex than its checkpoint counts',
    ],
    [
      'holds an annex that does not parse',
      2,
      [['replay.json.gz', gzipSync('{"version":1}')]] as Array<[string, Buffer]>,
      'replay annex does not parse',
    ],
  ])('refuses a file that %s, and keeps nothing', async (_what, formatVersion, annex, why) => {
    const { imported, store } = await importForged(
      [
        ['checkpoint.json', emptyCheckpoint(ONE_USER)],
        ['fingerprints.json.gz', NO_PRINTS],
        ...annex,
      ],
      formatVersion,
    );

    expect(imported).toMatchObject({ imported: false, refusal: { code: 'IMPORT_DAMAGED' } });
    if (!imported.imported) expect(imported.refusal.message).toContain(why);
    expect(await store.list()).toEqual([]);
  });

  it('keeps the annex of a checkpoint SandForge 1.80 rewrote, which lost its counts', async () => {
    const { imported } = await importForged(
      [
        ['checkpoint.json', emptyCheckpoint()],
        ['fingerprints.json.gz', NO_PRINTS],
        ['replay.json.gz', annexOf(oneUserAnnex())],
      ],
      2,
    );
    expect(imported).toMatchObject({ imported: true });
  });
});
