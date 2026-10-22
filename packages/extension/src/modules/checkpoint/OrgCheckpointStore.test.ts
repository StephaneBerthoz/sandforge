import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  checkpointIdSchema,
  previewIdSchema,
  rewindIdSchema,
  type OrgCheckpoint,
} from '@sandforge/shared';
import { fingerprintOf } from './checkpointFingerprint';
import {
  CheckpointStoreError,
  DEFAULT_KEEP_DAYS,
  acquireOrgLock,
  binFileOf,
  binReachSince,
  defaultCheckpointLocksDir,
  defaultCheckpointStoreRoot,
  expiresAtFor,
  expiresSoon,
  indexFileOf,
  newFolderId,
  openCheckpointStore,
  organizationKey,
  previewDirOf,
  rewindDirOf,
  scratchOrgExpired,
  type CheckpointStoreOptions,
  type OrgCheckpointStore,
  type OrgLockSelf,
} from './OrgCheckpointStore';

/** Whether the system gives files an owner and permission bits the store can rely on. */
const POSIX = process.platform !== 'win32';

/** An Organization Id in its 18-character form, and the 15 it is made from. */
const ORG = '00Dxx0000001234EAA';
const ORG_15 = '00Dxx0000001234';
const OTHER_ORG = '00Dxx0000005678EAA';

const NOW = new Date('2026-10-22T12:00:00.000Z');
const DAY = 24 * 60 * 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const ACCOUNT_PRINT = fingerprintOf([
  { name: 'Id', type: 'id', createable: false, updateable: false, nillable: false },
  { name: 'Name', type: 'string', createable: true, updateable: true, nillable: false },
]);

/** A ready checkpoint of a Developer Edition org, taken an hour before {@link NOW}. */
function checkpointOf(patch: Partial<OrgCheckpoint> = {}): OrgCheckpoint {
  return {
    version: 1,
    checkpointId: 'ck-20261022-110000-a1b2',
    name: 'Before UAT',
    org: {
      organizationId: ORG,
      alias: 'DEV-SB',
      username: 'admin@example.com',
      instanceUrl: 'https://example-dev-ed.my.salesforce.com',
      isSandbox: false,
      organizationType: 'Developer Edition',
      tier: 'developer',
    },
    takenBy: { userId: '005xx000001AbCdAAA', viewAllData: true, modifyAllData: true },
    readFrom: '2026-10-22T11:00:00.000Z',
    takenAt: '2026-10-22T11:01:00.000Z',
    scope: { mode: 'everything', leftOut: [] },
    objects: [
      {
        objectApiName: 'Account',
        records: 2,
        inBin: 0,
        readOrder: 0,
        readMode: 'query',
        undeletable: true,
        cascadeParents: [],
        fingerprint: ACCOUNT_PRINT.digest,
        fields: ['Id', 'Name'],
        leftOutFields: [],
      },
    ],
    ignoredFields: [],
    snapshotId: 'op-1',
    movedWhileTaken: { changed: 0, deleted: 0, created: 0 },
    bytes: 1024,
    expiresAt: iso(NOW.getTime() + 29 * DAY),
    status: 'ready',
    takenOn: { host: 'workstation', pid: 4242 },
    ...patch,
  };
}

const made: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-checkpoints-test-'));
  made.push(dir);
  return dir;
}

/** A store in a folder of its own, with the locks in a home folder of its own. */
function storeIn(
  dir: string = scratch(),
  options: Partial<CheckpointStoreOptions> = {},
): OrgCheckpointStore {
  const opened = openCheckpointStore({
    root: join(dir, 'checkpoints'),
    locksDir: defaultCheckpointLocksDir(join(dir, 'home')),
    ...options,
  });
  if (!('store' in opened)) throw new Error(`refused: ${opened.refusal.reason}`);
  return opened.store;
}

/** Keep a checkpoint as a take does: its folder, then its prints, then its file. */
async function kept(store: OrgCheckpointStore, checkpoint: OrgCheckpoint = checkpointOf()) {
  const folder = await store.create(checkpoint.org.organizationId, checkpoint.checkpointId);
  await store.writeFingerprints(folder, { Account: ACCOUNT_PRINT });
  await store.write(checkpoint);
  return folder;
}

const modeOf = (path: string): number => statSync(path).mode & 0o777;

describe('where checkpoints are kept', () => {
  it('keeps them in the user’s own SandForge folder, or under the one SANDFORGE_JOURNAL_DIR names', () => {
    expect(defaultCheckpointStoreRoot({})).toBe(join(homedir(), '.sandforge', 'checkpoints'));
    expect(defaultCheckpointStoreRoot({ SANDFORGE_JOURNAL_DIR: '  ' })).toBe(
      join(homedir(), '.sandforge', 'checkpoints'),
    );
    expect(defaultCheckpointStoreRoot({ SANDFORGE_JOURNAL_DIR: '/srv/runner/sandforge' })).toBe(
      join(resolve('/srv/runner/sandforge'), 'checkpoints'),
    );
  });

  it('files a checkpoint under its org and its id, the 15- and 18-character Organization Ids alike', () => {
    const store = storeIn();
    const folder = store.folderOf(ORG_15, 'ck-20261022-110000-a1b2');

    expect(folder.organizationId).toBe(ORG);
    expect(folder.dir).toBe(join(store.root, ORG, 'ck-20261022-110000-a1b2'));
    expect(store.folderOf(ORG, 'ck-20261022-110000-a1b2')).toEqual(folder);
    expect(folder.checkpointFile).toBe(join(folder.dir, 'checkpoint.json'));
    expect(folder.fingerprintsFile).toBe(join(folder.dir, 'fingerprints.json'));
    expect(folder.snapshotsFile).toBe(join(folder.dir, 'snapshots.json'));
    expect(indexFileOf(folder, 'Account')).toBe(join(folder.dir, 'index', 'Account.idx'));
    expect(binFileOf(folder, 'Account')).toBe(join(folder.dir, 'bin', 'Account.ids'));
    expect(previewDirOf(folder, 'pv-20261022-120000-c3d4')).toBe(
      join(folder.dir, 'previews', 'pv-20261022-120000-c3d4'),
    );
    expect(rewindDirOf(folder, 'rw-20261022-120000-e5f6')).toBe(
      join(folder.dir, 'rewinds', 'rw-20261022-120000-e5f6'),
    );
  });

  it('never lets an id, an org or an object name that is not one of its shapes reach a path', () => {
    const store = storeIn();
    const folder = store.folderOf(ORG, 'ck-20261022-110000-a1b2');
    const refusals = [
      () => store.folderOf(ORG, '../ck-20261022-110000-a1b2'),
      () => store.folderOf('../../etc', 'ck-20261022-110000-a1b2'),
      () => store.folderOf('005xx000001AbCdAAA', 'ck-20261022-110000-a1b2'),
      () => indexFileOf(folder, 'Account/../../x'),
      () => binFileOf(folder, '..'),
      () => previewDirOf(folder, 'rw-20261022-120000-e5f6'),
      () => rewindDirOf(folder, 'rw-20261022-120000-e5f6/..'),
    ];

    for (const refused of refusals) expect(refused).toThrow(CheckpointStoreError);
  });

  it('names new folders by when they are made, in the shapes the messages accept', () => {
    const earlier = newFolderId('ck', new Date('2026-10-22T14:05:12.345Z'));
    const later = newFolderId('ck', new Date('2026-10-22T14:05:13.000Z'));

    expect(earlier).toMatch(/^ck-20261022-140512-[a-z0-9]{4}$/);
    expect(checkpointIdSchema.safeParse(earlier).success).toBe(true);
    expect(previewIdSchema.safeParse(newFolderId('pv')).success).toBe(true);
    expect(rewindIdSchema.safeParse(newFolderId('rw')).success).toBe(true);
    expect(earlier < later).toBe(true);
  });
});

describe('openCheckpointStore', () => {
  it.runIf(POSIX)(
    'makes the store, its org and checkpoint folders and their files readable by their owner alone',
    async () => {
      const dir = scratch();
      const store = storeIn(dir);
      const folder = await kept(store);

      for (const path of [store.root, store.locksDir, join(store.root, ORG), folder.dir]) {
        expect(modeOf(path)).toBe(0o700);
      }
      expect(modeOf(folder.indexDir)).toBe(0o700);
      expect(modeOf(folder.binDir)).toBe(0o700);
      expect(modeOf(folder.checkpointFile)).toBe(0o600);
      expect(modeOf(folder.fingerprintsFile)).toBe(0o600);
    },
  );

  it('refuses a store another user owns, who could read the snapshots and replace them', () => {
    const dir = scratch();
    const notMe = (statSync(dir).uid || 0) + 1;

    const opened = openCheckpointStore({
      root: join(dir, 'checkpoints'),
      locksDir: join(dir, 'locks'),
      uid: () => notMe,
    });

    expect(opened).toEqual({
      refusal: { reason: 'otherOwner', path: join(dir, 'checkpoints') },
    });
  });

  it('refuses a store whose path is a file, and opens where the system gives files no owner', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'checkpoints'), '');

    expect(
      openCheckpointStore({ root: join(dir, 'checkpoints'), locksDir: join(dir, 'locks') }),
    ).toEqual({ refusal: { reason: 'notAFolder', path: join(dir, 'checkpoints') } });
    expect(
      'store' in
        openCheckpointStore({
          root: join(dir, 'other'),
          locksDir: join(dir, 'locks'),
          uid: () => undefined,
        }),
    ).toBe(true);
  });
});

describe('writing a checkpoint', () => {
  it('reads back what it wrote, checked', async () => {
    const store = storeIn();
    await kept(store);

    const read = await store.read('ck-20261022-110000-a1b2');

    expect(read?.checkpoint).toEqual(checkpointOf());
    expect(read?.folder.organizationId).toBe(ORG);
  });

  it('leaves the file as it was when a write is stopped before it ends', async () => {
    const dir = scratch();
    const store = storeIn(dir);
    const folder = await kept(store);
    const stopped = storeIn(dir, {
      rename: () => Promise.reject(new Error('the window closed')),
    });

    await expect(stopped.write(checkpointOf({ name: 'Renamed' }))).rejects.toThrow(
      'the window closed',
    );

    expect((await store.read('ck-20261022-110000-a1b2'))?.checkpoint?.name).toBe('Before UAT');
    expect(readdirSync(folder.dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('never reads the file a write left beside it when its process died', async () => {
    const store = storeIn();
    const folder = await kept(store);
    writeFileSync(`${folder.checkpointFile}.4242-abcd1234.tmp`, '{"version":1,"name":');

    const [entry] = await store.list({ now: NOW });

    expect(entry?.valid).toBe(true);
    expect(entry?.checkpoint?.name).toBe('Before UAT');
  });

  it('refuses to write a checkpoint it would list as damaged', async () => {
    const store = storeIn();
    await kept(store);

    const backwards = checkpointOf({ takenAt: '2026-10-22T10:00:00.000Z' });

    await expect(store.write(backwards)).rejects.toMatchObject({ code: 'invalid' });
    expect((await store.read('ck-20261022-110000-a1b2'))?.checkpoint).toEqual(checkpointOf());
  });

  it('never writes into a folder deleted meanwhile, which would stand for a snapshot that is gone', async () => {
    const store = storeIn();
    const folder = await kept(store);
    rmSync(folder.dir, { recursive: true });

    await expect(store.write(checkpointOf())).rejects.toThrow();

    expect(existsSync(folder.dir)).toBe(false);
  });

  it('refuses a new checkpoint under an id already kept', async () => {
    const store = storeIn();
    await kept(store);

    await expect(store.create(ORG_15, 'ck-20261022-110000-a1b2')).rejects.toMatchObject({
      code: 'exists',
    });
  });

  it('changes a checkpoint one change after the other, so none is lost', async () => {
    const store = storeIn();
    await kept(store);

    await Promise.all([
      store.update('ck-20261022-110000-a1b2', (c) => ({ ...c, name: 'Clean baseline' })),
      store.update('ck-20261022-110000-a1b2', (c) => ({
        ...c,
        ignoredFields: ['Case.Last_Touched__c'],
      })),
    ]);

    const checkpoint = (await store.read('ck-20261022-110000-a1b2'))?.checkpoint;
    expect(checkpoint?.name).toBe('Clean baseline');
    expect(checkpoint?.ignoredFields).toEqual(['Case.Last_Touched__c']);
  });

  it('never moves a checkpoint to another id or org by a change', async () => {
    const store = storeIn();
    await kept(store);

    await expect(
      store.update('ck-20261022-110000-a1b2', (c) => ({
        ...c,
        checkpointId: 'ck-20261022-110000-zzzz',
      })),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      store.update('ck-20261022-110000-a1b2', (c) => ({
        ...c,
        org: { ...c.org, organizationId: OTHER_ORG },
      })),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(store.update('ck-20261022-110000-zzzz', (c) => c)).rejects.toMatchObject({
      code: 'notFound',
    });
  });
});

describe('the field prints', () => {
  it('reads back the prints of every object, as the checkpoint names them', async () => {
    const store = storeIn();
    const folder = await kept(store);

    const prints = await store.readFingerprints(folder, checkpointOf());

    expect(prints.get('Account')).toEqual(ACCOUNT_PRINT);
  });

  it('says the checkpoint is damaged when its prints are missing, do not parse, or are not its own', async () => {
    const store = storeIn();
    const folder = await kept(store);
    const other = { ...ACCOUNT_PRINT, digest: 'f'.repeat(64) };

    await store.writeFingerprints(folder, { Account: other });
    await expect(store.readFingerprints(folder, checkpointOf())).rejects.toMatchObject({
      code: 'damaged',
    });
    await store.writeFingerprints(folder, {});
    await expect(store.readFingerprints(folder, checkpointOf())).rejects.toMatchObject({
      code: 'damaged',
    });
    writeFileSync(folder.fingerprintsFile, '{"version":1,"objects":{"Account":{"digest":1}}}');
    await expect(store.readFingerprints(folder, checkpointOf())).rejects.toMatchObject({
      code: 'damaged',
    });
    rmSync(folder.fingerprintsFile);
    await expect(store.readFingerprints(folder, checkpointOf())).rejects.toMatchObject({
      code: 'damaged',
    });
  });
});

describe('listing', () => {
  it('lists the checkpoints of every org, newest first, or of one org', async () => {
    const store = storeIn();
    await kept(store, checkpointOf({ checkpointId: 'ck-20261020-090000-aaaa' }));
    await kept(store, checkpointOf({ checkpointId: 'ck-20261022-110000-a1b2' }));
    await kept(
      store,
      checkpointOf({
        checkpointId: 'ck-20261021-090000-bbbb',
        org: { ...checkpointOf().org, organizationId: OTHER_ORG },
      }),
    );

    const all = await store.list({ now: NOW });
    const mine = await store.list({ now: NOW, organizationId: ORG_15 });

    expect(all.map((entry) => entry.checkpointId)).toEqual([
      'ck-20261022-110000-a1b2',
      'ck-20261021-090000-bbbb',
      'ck-20261020-090000-aaaa',
    ]);
    expect(all.every((entry) => entry.valid)).toBe(true);
    expect(mine.map((entry) => entry.checkpointId)).toEqual([
      'ck-20261022-110000-a1b2',
      'ck-20261020-090000-aaaa',
    ]);
    expect(mine.every((entry) => entry.organizationId === ORG)).toBe(true);
  });

  it('lists a damaged checkpoint by its folder so it can be deleted, and never uses it', async () => {
    const store = storeIn();
    const unreadable = await kept(store, checkpointOf({ checkpointId: 'ck-20261022-100000-aaaa' }));
    writeFileSync(unreadable.checkpointFile, '{"version":1,');
    const refused = await kept(store, checkpointOf({ checkpointId: 'ck-20261022-100000-bbbb' }));
    writeFileSync(refused.checkpointFile, JSON.stringify({ ...checkpointOf(), version: 2 }));
    const copied = await kept(store, checkpointOf({ checkpointId: 'ck-20261022-100000-cccc' }));
    writeFileSync(copied.checkpointFile, JSON.stringify(checkpointOf()));
    const otherOrg = await kept(store, checkpointOf({ checkpointId: 'ck-20261022-100000-dddd' }));
    writeFileSync(
      otherOrg.checkpointFile,
      JSON.stringify(
        checkpointOf({
          checkpointId: 'ck-20261022-100000-dddd',
          org: { ...checkpointOf().org, organizationId: OTHER_ORG },
        }),
      ),
    );
    const missing = await store.create(ORG, 'ck-20261022-100000-eeee');

    const entries = await store.list({ now: NOW });

    expect(entries.filter((entry) => !entry.valid)).toEqual(
      [missing, otherOrg, copied, refused, unreadable].map((folder) => ({
        checkpointId: folder.checkpointId,
        organizationId: ORG,
        valid: false,
        why: 'damaged',
      })),
    );
    expect((await store.read('ck-20261022-100000-cccc'))?.checkpoint).toBeUndefined();
    await expect(
      store.update('ck-20261022-100000-aaaa', (c) => ({ ...c, name: 'x' })),
    ).rejects.toMatchObject({ code: 'damaged' });
    expect(await store.delete('ck-20261022-100000-aaaa')).toEqual({ outcome: 'deleted' });
  });

  it('ignores what is no org’s nor checkpoint’s folder', async () => {
    const store = storeIn();
    await kept(store);
    mkdirSync(join(store.root, 'notes'));
    mkdirSync(join(store.root, ORG, 'scratch'));
    writeFileSync(join(store.root, ORG, 'ck-20261022-100000-ffff'), '');

    expect((await store.list({ now: NOW })).map((entry) => entry.checkpointId)).toEqual([
      'ck-20261022-110000-a1b2',
    ]);
  });

  it('says why a checkpoint cannot be rewound to: a take under way or that failed, a refreshed sandbox, an expired scratch org', async () => {
    const store = storeIn();
    await kept(store, checkpointOf({ checkpointId: 'ck-20261022-100000-aaaa', status: 'taking' }));
    await kept(store, checkpointOf({ checkpointId: 'ck-20261022-100000-bbbb', status: 'failed' }));
    await kept(
      store,
      checkpointOf({
        checkpointId: 'ck-20261022-100000-cccc',
        org: { ...checkpointOf().org, tier: 'scratch', scratchExpiresAt: '2026-10-21' },
      }),
    );
    await kept(
      store,
      checkpointOf({
        checkpointId: 'ck-20261022-100000-dddd',
        org: { ...checkpointOf().org, organizationId: OTHER_ORG },
      }),
    );
    const refreshedAt = vi.fn((organizationId: string) =>
      organizationId === OTHER_ORG ? '2026-10-15T08:00:00.000Z' : undefined,
    );

    const why = Object.fromEntries(
      (await store.list({ now: NOW, refreshedAt })).map((entry) => [
        entry.checkpointId,
        [entry.valid, entry.why, entry.refreshedAt],
      ]),
    );

    expect(why).toEqual({
      'ck-20261022-100000-aaaa': [false, 'taking', undefined],
      'ck-20261022-100000-bbbb': [false, 'failed', undefined],
      'ck-20261022-100000-cccc': [false, 'scratchExpired', undefined],
      'ck-20261022-100000-dddd': [false, 'refreshed', '2026-10-15T08:00:00.000Z'],
    });
    expect(refreshedAt).toHaveBeenCalledWith(OTHER_ORG);
  });

  it('lets a scratch org live through the whole of its expiry day', () => {
    const lastDay = { scratchExpiresAt: '2026-10-22' };

    expect(scratchOrgExpired(lastDay, NOW.getTime())).toBe(false);
    expect(scratchOrgExpired(lastDay, Date.parse('2026-10-23T00:00:00.000Z'))).toBe(true);
    expect(scratchOrgExpired({ scratchExpiresAt: iso(NOW.getTime() - 1) }, NOW.getTime())).toBe(
      true,
    );
    expect(scratchOrgExpired({}, NOW.getTime())).toBe(false);
  });

  it('says, once a checkpoint is older than the recycle bin’s 15 days, before when deleted records can’t come back', async () => {
    const store = storeIn();
    const old = iso(NOW.getTime() - 16 * DAY);
    await kept(
      store,
      checkpointOf({ readFrom: old, takenAt: old, expiresAt: iso(NOW.getTime() + 14 * DAY) }),
    );

    const [entry] = await store.list({ now: NOW });

    expect(entry?.binReachSince).toBe(iso(NOW.getTime() - 15 * DAY));
    expect(binReachSince({ readFrom: iso(NOW.getTime() - 14 * DAY) }, NOW.getTime())).toBe(
      undefined,
    );
  });

  it('offers the Undo of the org’s latest rewind alone, while its window lasts and its journal is kept', async () => {
    const store = storeIn();
    const until = iso(NOW.getTime() + 14 * DAY);
    const earlier = await kept(
      store,
      checkpointOf({
        checkpointId: 'ck-20261020-090000-aaaa',
        lastRewind: { rewindId: 'rw-20261021-090000-aaaa', undoUntil: until },
      }),
    );
    const latest = await kept(
      store,
      checkpointOf({
        checkpointId: 'ck-20261019-090000-bbbb',
        lastRewind: { rewindId: 'rw-20261022-090000-bbbb', undoUntil: until },
      }),
    );
    mkdirSync(rewindDirOf(earlier, 'rw-20261021-090000-aaaa'), { recursive: true });
    mkdirSync(rewindDirOf(latest, 'rw-20261022-090000-bbbb'), { recursive: true });

    const undo = async () =>
      Object.fromEntries(
        (await store.list({ now: NOW })).map((entry) => [entry.checkpointId, entry.undo]),
      );

    expect(await undo()).toEqual({
      'ck-20261020-090000-aaaa': undefined,
      'ck-20261019-090000-bbbb': { rewindId: 'rw-20261022-090000-bbbb', until },
    });

    rmSync(rewindDirOf(latest, 'rw-20261022-090000-bbbb'), { recursive: true });
    expect((await undo())['ck-20261019-090000-bbbb']).toBeUndefined();

    mkdirSync(rewindDirOf(latest, 'rw-20261022-090000-bbbb'), { recursive: true });
    await store.update('ck-20261019-090000-bbbb', (c) => ({
      ...c,
      lastRewind: {
        rewindId: 'rw-20261022-090000-bbbb',
        undoUntil: until,
        undoneAt: iso(NOW.getTime()),
      },
    }));
    expect(await undo()).toEqual({
      'ck-20261020-090000-aaaa': undefined,
      'ck-20261019-090000-bbbb': undefined,
    });
  });
});

describe('expiry', () => {
  it('writes the date a checkpoint expires on, or none to keep it until its owner deletes it', () => {
    expect(expiresAtFor(NOW, 30)).toBe('2026-11-21T12:00:00.000Z');
    expect(expiresAtFor(NOW, 0)).toBeNull();
    expect(() => expiresAtFor(NOW, -1)).toThrow(RangeError);
    expect(() => expiresAtFor(NOW, 1.5)).toThrow(RangeError);
  });

  it('warns three days before a checkpoint expires, not four, and never of one kept', async () => {
    const store = storeIn();
    await kept(
      store,
      checkpointOf({
        checkpointId: 'ck-20261022-100000-aaaa',
        expiresAt: iso(NOW.getTime() + 3 * DAY),
      }),
    );
    await kept(
      store,
      checkpointOf({
        checkpointId: 'ck-20261022-100000-bbbb',
        expiresAt: iso(NOW.getTime() + 4 * DAY),
      }),
    );
    await kept(store, checkpointOf({ checkpointId: 'ck-20261022-100000-cccc', expiresAt: null }));

    const soon = Object.fromEntries(
      (await store.list({ now: NOW })).map((entry) => [entry.checkpointId, entry.expiresSoon]),
    );

    expect(soon).toEqual({
      'ck-20261022-100000-aaaa': true,
      'ck-20261022-100000-bbbb': undefined,
      'ck-20261022-100000-cccc': undefined,
    });
    expect(expiresSoon({ expiresAt: iso(NOW.getTime() - 1) }, NOW.getTime())).toBe(false);
  });

  it('keeps a checkpoint until its owner deletes it, or gives it back thirty days from now', async () => {
    const store = storeIn();
    await kept(store);

    expect((await store.keep('ck-20261022-110000-a1b2', true, NOW)).expiresAt).toBeNull();
    const back = await store.keep('ck-20261022-110000-a1b2', false, NOW);

    expect(back.expiresAt).toBe(iso(NOW.getTime() + DEFAULT_KEEP_DAYS * DAY));
    expect((await store.read('ck-20261022-110000-a1b2'))?.checkpoint?.expiresAt).toBe(
      back.expiresAt,
    );
  });

  it('deletes the checkpoints whose date has come, each named, and with them the Undo of their rewind', async () => {
    const store = storeIn();
    const until = iso(NOW.getTime() + 10 * DAY);
    const expired = await kept(
      store,
      checkpointOf({
        checkpointId: 'ck-20261001-090000-aaaa',
        expiresAt: iso(NOW.getTime() - 60_000),
        lastRewind: { rewindId: 'rw-20261012-090000-aaaa', undoUntil: until },
      }),
    );
    mkdirSync(rewindDirOf(expired, 'rw-20261012-090000-aaaa'), { recursive: true });
    const kept30 = await kept(store, checkpointOf({ checkpointId: 'ck-20261022-100000-bbbb' }));
    const forever = await kept(
      store,
      checkpointOf({ checkpointId: 'ck-20260101-090000-cccc', expiresAt: null }),
    );

    const swept = await store.sweep(NOW);

    expect(swept.checkpoints).toEqual([
      {
        organizationId: ORG,
        checkpointId: 'ck-20261001-090000-aaaa',
        name: 'Before UAT',
        alias: 'DEV-SB',
        takenAt: '2026-10-22T11:01:00.000Z',
        expiresAt: iso(NOW.getTime() - 60_000),
        undoUntil: until,
      },
    ]);
    expect(existsSync(expired.dir)).toBe(false);
    expect(existsSync(kept30.dir)).toBe(true);
    expect(existsSync(forever.dir)).toBe(true);
    expect((await store.sweep(NOW)).checkpoints).toEqual([]);
  });

  it('deletes a rewind’s journal once Undo can no longer bring anything back, and keeps the checkpoint', async () => {
    const store = storeIn();
    const folder = await kept(
      store,
      checkpointOf({
        lastRewind: { rewindId: 'rw-20261005-090000-aaaa', undoUntil: iso(NOW.getTime() - 1) },
      }),
    );
    const journal = rewindDirOf(folder, 'rw-20261005-090000-aaaa');
    mkdirSync(journal, { recursive: true });
    writeFileSync(join(journal, 'journal.ndjson'), '{}\n');

    const swept = await store.sweep(NOW);

    expect(swept.journals).toEqual([
      {
        organizationId: ORG,
        checkpointId: 'ck-20261022-110000-a1b2',
        name: 'Before UAT',
        rewindId: 'rw-20261005-090000-aaaa',
        undoUntil: iso(NOW.getTime() - 1),
      },
    ]);
    expect(existsSync(journal)).toBe(false);
    expect((await store.read('ck-20261022-110000-a1b2'))?.checkpoint).toBeDefined();
  });

  it('deletes the previews computed more than a day ago', async () => {
    const store = storeIn();
    const folder = await kept(store);
    const old = previewDirOf(folder, 'pv-20261021-090000-aaaa');
    const fresh = previewDirOf(folder, 'pv-20261022-110000-bbbb');
    mkdirSync(old, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    const seconds = (ms: number) => ms / 1000;
    utimesSync(old, seconds(NOW.getTime() - DAY - 60_000), seconds(NOW.getTime() - DAY - 60_000));
    utimesSync(fresh, seconds(NOW.getTime() - 60_000), seconds(NOW.getTime() - 60_000));

    const swept = await store.sweep(NOW);

    expect(swept.previews).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('leaves an org a take, a rewind or an undo runs on as it is, swept next time', async () => {
    const store = storeIn();
    const folder = await kept(store, checkpointOf({ expiresAt: iso(NOW.getTime() - 1) }));
    const taken = store.lock(ORG, 'rewind', 'ck-20261022-110000-a1b2');
    if (!('lock' in taken)) throw new Error('the lock was not taken');

    try {
      const swept = await store.sweep(NOW);
      expect(swept).toEqual({ checkpoints: [], journals: [], previews: 0, skipped: [ORG] });
      expect(existsSync(folder.dir)).toBe(true);
    } finally {
      taken.lock.release();
    }

    expect((await store.sweep(NOW)).checkpoints).toHaveLength(1);
  });
});

describe('deleting', () => {
  it('deletes a checkpoint’s folder from this machine, and says when none is kept', async () => {
    const store = storeIn();
    const folder = await kept(store);

    expect(await store.delete('ck-20261022-110000-a1b2')).toEqual({
      outcome: 'deleted',
      checkpoint: checkpointOf(),
    });
    expect(existsSync(folder.dir)).toBe(false);
    expect(await store.delete('ck-20261022-110000-a1b2')).toEqual({ outcome: 'notFound' });
  });

  it('refuses while a take, a rewind or an undo of its org runs, whose files it would pull away', async () => {
    const store = storeIn();
    const folder = await kept(store);
    const taken = store.lock(ORG, 'take', 'ck-20261022-110000-a1b2');
    if (!('lock' in taken)) throw new Error('the lock was not taken');

    try {
      const outcome = await store.delete('ck-20261022-110000-a1b2');
      expect(outcome).toMatchObject({
        outcome: 'busy',
        holder: { operation: 'take', pid: process.pid, checkpointId: 'ck-20261022-110000-a1b2' },
      });
      expect(existsSync(folder.dir)).toBe(true);
    } finally {
      taken.lock.release();
    }
  });
});

describe('the lock of an org', () => {
  const BOOTED = NOW.getTime() - 3 * 60 * 60_000;
  /** Another process of this machine, started two hours before {@link NOW}. */
  const OTHER: OrgLockSelf = {
    host: hostname(),
    pid: 4242,
    startedAt: iso(NOW.getTime() - 2 * 60 * 60_000),
  };
  const checks = (alive: boolean) => ({
    isAlive: () => alive,
    bootedAt: () => BOOTED,
    now: () => NOW.getTime(),
  });

  it('is one file per org, its owner’s alone, naming the process that holds it and what it does', () => {
    const dir = scratch();
    const store = storeIn(dir);
    const taken = store.lock(ORG_15, 'take', 'ck-20261022-110000-a1b2');
    if (!('lock' in taken)) throw new Error('the lock was not taken');

    try {
      const file = join(store.locksDir, `${ORG}.lock`);
      const lock = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      expect(lock).toMatchObject({
        version: 1,
        host: hostname(),
        pid: process.pid,
        operation: 'take',
        checkpointId: 'ck-20261022-110000-a1b2',
      });
      expect(taken.lock.organizationId).toBe(ORG);
      expect(readdirSync(store.locksDir)).toEqual([`${ORG}.lock`]);
      if (POSIX) {
        expect(modeOf(file)).toBe(0o600);
        expect(modeOf(store.locksDir)).toBe(0o700);
      }
    } finally {
      taken.lock.release();
    }
    expect(readdirSync(store.locksDir)).toEqual([]);
  });

  it('is held once: a second take of the same org, in either form of its id, is refused until it is released', () => {
    const store = storeIn();
    const first = store.lock(ORG, 'take');
    if (!('lock' in first)) throw new Error('the lock was not taken');

    expect(store.lock(ORG_15, 'rewind')).toMatchObject({ busy: { operation: 'take' } });
    expect(store.heldBy(ORG)).toMatchObject({ operation: 'take', pid: process.pid });
    const elsewhere = store.lock(OTHER_ORG, 'rewind');
    expect('lock' in elsewhere).toBe(true);
    if ('lock' in elsewhere) elsewhere.lock.release();

    first.lock.release();
    first.lock.release();

    expect(store.heldBy(ORG)).toBeUndefined();
    const again = store.lock(ORG, 'rewind');
    expect('lock' in again).toBe(true);
    if ('lock' in again) again.lock.release();
  });

  it('is shared by two stores, the default one and one a command line names', () => {
    const dir = scratch();
    vi.stubEnv('HOME', join(dir, 'home'));
    vi.stubEnv('USERPROFILE', join(dir, 'home'));
    vi.stubEnv('SANDFORGE_JOURNAL_DIR', join(dir, 'journal'));
    const opened = [
      openCheckpointStore({ root: defaultCheckpointStoreRoot() }),
      openCheckpointStore({ root: join(dir, 'elsewhere') }),
    ].map((result) => {
      if (!('store' in result)) throw new Error(`refused: ${result.refusal.reason}`);
      return result.store;
    });
    const [panel, commandLine] = opened as [OrgCheckpointStore, OrgCheckpointStore];
    expect(panel.root).not.toBe(commandLine.root);

    const taken = panel.lock(ORG, 'rewind');
    if (!('lock' in taken)) throw new Error('the lock was not taken');
    try {
      expect(commandLine.lock(ORG_15, 'rewind')).toMatchObject({ busy: { operation: 'rewind' } });
      expect(commandLine.locksDir).toBe(join(dir, 'home', '.sandforge', 'locks'));
    } finally {
      taken.lock.release();
    }
  });

  it('refuses while another process of this machine that holds it runs', () => {
    const dir = scratch();
    const other = storeIn(dir, { lockSelf: OTHER, lockChecks: checks(true) });
    const held = other.lock(ORG, 'undo');
    if (!('lock' in held)) throw new Error('the lock was not taken');

    const here = storeIn(dir, { lockChecks: checks(true) });

    expect(here.lock(ORG, 'rewind')).toEqual({
      busy: {
        host: hostname(),
        pid: 4242,
        hostStartedAt: OTHER.startedAt,
        acquiredAt: NOW.toISOString(),
        operation: 'undo',
      },
    });
    held.lock.release();
  });

  it('takes over the lock of a process that is gone, or that started before the machine did', () => {
    const dir = scratch();
    const left = storeIn(dir, { lockSelf: OTHER, lockChecks: checks(true) });
    expect('lock' in left.lock(ORG, 'take')).toBe(true);
    const beforeBoot: OrgLockSelf = { ...OTHER, pid: 4343, startedAt: iso(BOOTED - 60 * 60_000) };
    expect('lock' in storeIn(dir, { lockSelf: beforeBoot }).lock(OTHER_ORG, 'take')).toBe(true);

    const gone = storeIn(dir, { lockChecks: checks(false) }).lock(ORG, 'rewind');
    const reused = storeIn(dir, { lockChecks: checks(true) }).lock(OTHER_ORG, 'rewind');

    expect('lock' in gone).toBe(true);
    expect('lock' in reused).toBe(true);
    const file = join(dir, 'home', '.sandforge', 'locks', `${ORG}.lock`);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      pid: process.pid,
      operation: 'rewind',
    });
    if ('lock' in gone) gone.lock.release();
    if ('lock' in reused) reused.lock.release();
  });

  it('takes over a lock file that is no lock, and never removes one another process took over', () => {
    const dir = scratch();
    const locksDir = join(dir, 'home', '.sandforge', 'locks');
    mkdirSync(locksDir, { recursive: true });
    writeFileSync(join(locksDir, `${ORG}.lock`), 'not a lock');
    const first = acquireOrgLock(
      locksDir,
      ORG,
      { operation: 'take' },
      {
        self: OTHER,
        checks: checks(true),
      },
    );
    if (!('lock' in first)) throw new Error('the lock was not taken');

    // The first process is taken for gone, and this one takes the lock over.
    const second = acquireOrgLock(
      locksDir,
      ORG,
      { operation: 'rewind' },
      { checks: checks(false) },
    );
    if (!('lock' in second)) throw new Error('the lock was not taken over');
    first.lock.release();

    expect(JSON.parse(readFileSync(join(locksDir, `${ORG}.lock`), 'utf8'))).toMatchObject({
      pid: process.pid,
      operation: 'rewind',
    });
    second.lock.release();
    expect(readdirSync(locksDir)).toEqual([]);
  });

  it('holds a lock taken on another machine that shares this home folder for as long as a run is believed', () => {
    const dir = scratch();
    const elsewhere: OrgLockSelf = {
      host: 'build-agent-2',
      pid: process.pid,
      startedAt: OTHER.startedAt,
    };
    const held = storeIn(dir, { lockSelf: elsewhere, lockChecks: checks(true) }).lock(ORG, 'take');
    expect('lock' in held).toBe(true);

    const now = (ms: number) => ({ ...checks(false), now: () => ms });
    expect(storeIn(dir, { lockChecks: now(NOW.getTime() + 60_000) }).heldBy(ORG)).toMatchObject({
      host: 'build-agent-2',
    });
    const later = storeIn(dir, { lockChecks: now(NOW.getTime() + 25 * 60 * 60_000) }).lock(
      ORG,
      'take',
    );
    expect('lock' in later).toBe(true);
    if ('lock' in later) later.lock.release();
  });

  it('names the org by its 18-character Organization Id, whichever form it is given in', () => {
    expect(organizationKey(ORG_15)).toBe(ORG);
    expect(organizationKey(ORG)).toBe(ORG);
    expect(() => organizationKey('005xx000001AbCdAAA')).toThrow(CheckpointStoreError);
  });
});
