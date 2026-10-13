import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, it, expect, vi } from 'vitest';

import { BackupRecordStore, nodeBackupFiles } from './BackupRecordStore.js';
import type { BackupRecord } from './BackupRecordStore.js';

/**
 * Backup record payloads must not live in globalState.
 *
 * dataops:backup wrote every object's full SOQL result set through ConfigStore,
 * which is backed by `context.globalState`. VSCode serializes that memento in
 * its entirety on every write, so one backup put megabytes behind every
 * unrelated `set()` — a settings toggle, a saved template — and behind
 * activation, which parses the blob.
 */

/**
 * A store over files kept in memory, each with when it was last written: the
 * time `clock.now` says when it is written.
 *
 * @param refuseRemoval - Whether the file system refuses to remove a file.
 */
function createStore(refuseRemoval: (filePath: string) => boolean = () => false) {
  const files = new Map<string, string>();
  const modified = new Map<string, number>();
  const clock = { now: 0 };
  /** Write a file, at the time the clock says. */
  const put = (p: string, content: string): void => {
    files.set(p, content);
    modified.set(p, clock.now);
  };
  const store = new BackupRecordStore({
    storagePath: '/storage',
    readFile: async (p) => {
      const content = files.get(p);
      if (content === undefined) throw new Error('ENOENT');
      return content;
    },
    writeFile: async (p, content) => {
      put(p, content);
    },
    appendFile: async (p, content) => {
      put(p, (files.get(p) ?? '') + content);
    },
    exists: async (p) => files.has(p),
    readLines: async function* (p) {
      const content = files.get(p);
      if (content === undefined) throw new Error('ENOENT');
      yield* content.split('\n');
    },
    mkdir: vi.fn(async () => undefined),
    rm: async (p) => {
      if (refuseRemoval(p)) throw new Error('EBUSY: resource busy or locked');
      files.delete(p);
      modified.delete(p);
    },
    listFiles: async (dir) =>
      [...files.keys()]
        .filter((p) => path.dirname(p) === dir)
        .map((p) => ({ name: path.basename(p), modifiedMs: modified.get(p) ?? clock.now })),
  });
  return { files, store, clock, put };
}

/** Every batch a pass over an object's records yields, in order. */
async function batchesOf(
  store: BackupRecordStore,
  operationId: string,
  objectApiName: string,
  size: number,
): Promise<BackupRecord[][] | null> {
  const batches = await store.batches(operationId, objectApiName, size);
  if (batches === null) return null;
  const seen: BackupRecord[][] = [];
  for await (const batch of batches) seen.push(batch);
  return seen;
}

describe('BackupRecordStore', () => {
  it('keeps an object written a page at a time, and hands it back a batch at a time', async () => {
    const { store } = createStore();

    await store.begin('op-1', 'Account');
    await store.append('op-1', 'Account', [{ Id: '001a' }, { Id: '001b' }, { Id: '001c' }]);
    await store.append('op-1', 'Account', [{ Id: '001d' }, { Id: '001e' }]);

    // Never more than a batch at once, whatever the object holds.
    expect(await batchesOf(store, 'op-1', 'Account', 2)).toEqual([
      [{ Id: '001a' }, { Id: '001b' }],
      [{ Id: '001c' }, { Id: '001d' }],
      [{ Id: '001e' }],
    ]);
  });

  it('writes one record to a line, each page added to the end of the file', async () => {
    const { files, store } = createStore();

    await store.begin('op-1', 'Contact');
    await store.append('op-1', 'Contact', [{ Id: '003a', Name: 'A' }]);
    await store.append('op-1', 'Contact', [{ Id: '003b', Name: 'B' }]);

    const [[file, content]] = [...files.entries()];
    expect(file.endsWith('op-1__Contact.ndjson')).toBe(true);
    expect(content).toBe('{"Id":"003a","Name":"A"}\n{"Id":"003b","Name":"B"}\n');
  });

  it('reads the object again from its first record on each pass', async () => {
    // A restore reads an object twice: the recycle bin first, then the upsert.
    const { store } = createStore();
    await store.begin('op-1', 'Account');
    await store.append('op-1', 'Account', [{ Id: 'a' }, { Id: 'b' }]);

    const batches = await store.batches('op-1', 'Account', 1);
    const passes: string[][] = [];
    for (let pass = 0; pass < 2; pass++) {
      const ids: string[] = [];
      for await (const batch of batches ?? []) ids.push(...batch.map((r) => String(r.Id)));
      passes.push(ids);
    }
    expect(passes).toEqual([
      ['a', 'b'],
      ['a', 'b'],
    ]);
  });

  it('starts an object begun again empty', async () => {
    const { store } = createStore();
    await store.begin('op-1', 'Account');
    await store.append('op-1', 'Account', [{ Id: 'old' }]);

    await store.begin('op-1', 'Account');
    await store.append('op-1', 'Account', [{ Id: 'new' }]);

    expect(await batchesOf(store, 'op-1', 'Account', 10)).toEqual([[{ Id: 'new' }]]);
  });

  it('reads a backup written as one array per object, as backups were before', async () => {
    const { files, store } = createStore();
    // The form `save` wrote: one JSON array, in `<backup>__<object>.json`.
    files.set(
      path.join('/storage', 'backups', 'op-old__Contact.json'),
      JSON.stringify([{ Id: '003a' }, { Id: '003b' }, { Id: '003c' }]),
    );

    expect(await batchesOf(store, 'op-old', 'Contact', 2)).toEqual([
      [{ Id: '003a' }, { Id: '003b' }],
      [{ Id: '003c' }],
    ]);
  });

  it('returns null for a backup written before the store existed', async () => {
    // The readers fall back to ConfigStore on null, which is what keeps
    // pre-existing backups restorable without a migration pass.
    const { store } = createStore();
    expect(await store.batches('never-written', 'Account', 200)).toBeNull();
  });

  it('refuses a line that holds no record, naming the object and the line', async () => {
    // A file cut short mid-page, or edited: what it holds is not what was read.
    const { files, store } = createStore();
    files.set(path.join('/storage', 'backups', 'op-1__Account.ndjson'), '{"Id":"a"}\n{"Id":"b"\n');

    await expect(batchesOf(store, 'op-1', 'Account', 200)).rejects.toThrow(
      'The backup of Account is damaged at line 2 of its file',
    );
  });

  it('confines a crafted operationId to one path segment', async () => {
    // operationId and objectApiName arrive from a bridge payload.
    const { files, store } = createStore();

    await store.begin('../../etc/passwd', 'Account');

    const written = Array.from(files.keys())[0];
    expect(written).not.toContain('..');
    // path.join uses the host separator, so normalise before comparing.
    expect(written.split(path.sep).join('/')).toContain('/storage/backups/');
  });

  it('deletes an object in either form, and treats a missing file as success', async () => {
    const { files, store } = createStore();
    await store.begin('op-1', 'Account');
    files.set(path.join('/storage', 'backups', 'op-1__Account.json'), '[]');

    await store.delete('op-1', 'Account');

    expect(files.size).toBe(0);
    await expect(store.delete('op-1', 'Account')).resolves.toBeUndefined();
  });

  describe('the files of a backup whose metadata was never saved', () => {
    const HOUR = 60 * 60_000;
    const DAY = 24 * HOUR;

    /** The names of the files left in the backups directory. */
    function left(files: Map<string, string>): string[] {
      return [...files.keys()].map((p) => path.basename(p)).sort();
    }

    it('removes those of a backup no window has written to for longer than the safe age', async () => {
      // A window that crashed in the middle of a backup: its pages, and no metadata.
      const { files, store, clock } = createStore();
      await store.begin('wv-crashed', 'Contact');
      await store.append('wv-crashed', 'Contact', [{ Id: '003a' }]);
      await store.begin('wv-crashed', 'My_Object__c');
      clock.now = 2 * DAY;

      const removed = await store.sweep([], DAY, clock.now);

      expect(removed.sort()).toEqual([
        'wv-crashed__Contact.ndjson',
        'wv-crashed__My_Object__c.ndjson',
      ]);
      expect(files.size).toBe(0);
    });

    it('removes a file of the older form, one array an object, left the same way', async () => {
      const { files, store, clock, put } = createStore();
      put(path.join('/storage', 'backups', 'op-old__Lead.json'), '[{"Id":"00Qa"}]');
      clock.now = 2 * DAY;

      expect(await store.sweep([], DAY, clock.now)).toEqual(['op-old__Lead.json']);
      expect(files.size).toBe(0);
    });

    it('keeps those of a backup written to more recently: another window may be taking it', async () => {
      const { files, store, clock } = createStore();
      await store.begin('wv-elsewhere', 'Contact');
      clock.now = DAY - 1;

      expect(await store.sweep([], DAY, clock.now)).toEqual([]);
      expect(left(files)).toEqual(['wv-elsewhere__Contact.ndjson']);
    });

    it('keeps an object read whole long ago while the backup is still reading the next one', async () => {
      // Contact was read whole two days ago; Lead got a page an hour ago.
      const { files, store, clock } = createStore();
      await store.begin('wv-long', 'Contact');
      await store.append('wv-long', 'Contact', [{ Id: '003a' }]);
      clock.now = 2 * DAY - HOUR;
      await store.begin('wv-long', 'Lead');
      clock.now = 2 * DAY;

      expect(await store.sweep([], DAY, clock.now)).toEqual([]);
      expect(left(files)).toEqual(['wv-long__Contact.ndjson', 'wv-long__Lead.ndjson']);
    });

    it('keeps those of a backup whose metadata is kept, or that this window is writing, whatever their age', async () => {
      const { files, store, clock, put } = createStore();
      await store.begin('wv-listed', 'Contact');
      put(path.join('/storage', 'backups', 'wv-listed__Lead.json'), '[]');
      await store.begin('wv-writing', 'Account');
      await store.begin('wv-orphan', 'Account');
      clock.now = 30 * DAY;

      const removed = await store.sweep(['wv-listed', 'wv-writing'], DAY, clock.now);

      expect(removed).toEqual(['wv-orphan__Account.ndjson']);
      expect(left(files)).toEqual([
        'wv-listed__Contact.ndjson',
        'wv-listed__Lead.json',
        'wv-writing__Account.ndjson',
      ]);
    });

    it('leaves alone a file no backup writes', async () => {
      const { files, store, clock, put } = createStore();
      put(path.join('/storage', 'backups', 'notes.txt'), 'kept by hand');
      put(path.join('/storage', 'backups', 'index.json'), '{}');
      clock.now = 30 * DAY;

      expect(await store.sweep([], DAY, clock.now)).toEqual([]);
      expect(left(files)).toEqual(['index.json', 'notes.txt']);
    });

    it('removes the rest of a backup when one of its files cannot be removed', async () => {
      const { files, store, clock } = createStore((p) => p.endsWith('Contact.ndjson'));
      await store.begin('wv-crashed', 'Contact');
      await store.begin('wv-crashed', 'Lead');
      clock.now = 2 * DAY;

      expect(await store.sweep([], DAY, clock.now)).toEqual(['wv-crashed__Lead.ndjson']);
      expect(left(files)).toEqual(['wv-crashed__Contact.ndjson']);
    });
  });
});

describe('nodeBackupFiles', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('keeps a backup on disk one record to a line, and reads it back a batch at a time', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sandforge-backup-store-'));
    const store = new BackupRecordStore(nodeBackupFiles(dir));
    const records = Array.from({ length: 1_234 }, (_, i) => ({ Id: `003${i}`, Name: `N ${i}` }));

    await store.begin('op-1', 'Contact');
    for (let i = 0; i < records.length; i += 500) {
      await store.append('op-1', 'Contact', records.slice(i, i + 500));
    }

    const lines = (await readFile(path.join(dir, 'backups', 'op-1__Contact.ndjson'), 'utf8'))
      .trimEnd()
      .split('\n');
    expect(lines).toHaveLength(1_234);
    const sizes: number[] = [];
    const read: BackupRecord[] = [];
    for await (const batch of (await store.batches('op-1', 'Contact', 200)) ?? []) {
      sizes.push(batch.length);
      read.push(...batch);
    }
    expect(sizes).toEqual([200, 200, 200, 200, 200, 200, 34]);
    expect(read).toEqual(records);
  });

  it('reads an array file left by a backup taken before', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sandforge-backup-store-'));
    const files = nodeBackupFiles(dir);
    await files.mkdir(path.join(dir, 'backups'));
    await writeFile(
      path.join(dir, 'backups', 'op-old__Lead.json'),
      JSON.stringify([{ Id: '00Qa' }]),
      'utf8',
    );

    const store = new BackupRecordStore(files);
    const read: BackupRecord[] = [];
    for await (const batch of (await store.batches('op-old', 'Lead', 200)) ?? []) {
      read.push(...batch);
    }
    expect(read).toEqual([{ Id: '00Qa' }]);
    expect(await files.exists(path.join(dir, 'backups', 'op-old__Lead.ndjson'))).toBe(false);
  });

  it('removes from disk the files of a backup left without metadata, once old enough', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sandforge-backup-store-'));
    const store = new BackupRecordStore(nodeBackupFiles(dir));
    await store.begin('wv-crashed', 'Contact');
    await store.append('wv-crashed', 'Contact', [{ Id: '003a' }]);
    await store.begin('wv-listed', 'Contact');
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    for (const name of ['wv-crashed__Contact.ndjson', 'wv-listed__Contact.ndjson']) {
      await utimes(path.join(dir, 'backups', name), twoDaysAgo, twoDaysAgo);
    }

    const removed = await store.sweep(['wv-listed'], 24 * 60 * 60_000, Date.now());

    expect(removed).toEqual(['wv-crashed__Contact.ndjson']);
    const files = nodeBackupFiles(dir);
    expect(await files.exists(path.join(dir, 'backups', 'wv-crashed__Contact.ndjson'))).toBe(false);
    expect(await files.exists(path.join(dir, 'backups', 'wv-listed__Contact.ndjson'))).toBe(true);
  });

  it('lists no file in a storage no backup has written to yet', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sandforge-backup-store-'));

    expect(await nodeBackupFiles(dir).listFiles(path.join(dir, 'backups'))).toEqual([]);
    expect(await new BackupRecordStore(nodeBackupFiles(dir)).sweep([], 0, Date.now())).toEqual([]);
  });
});
