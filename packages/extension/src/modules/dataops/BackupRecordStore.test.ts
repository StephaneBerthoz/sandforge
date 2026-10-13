import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

function createStore() {
  const files = new Map<string, string>();
  const store = new BackupRecordStore({
    storagePath: '/storage',
    readFile: async (p) => {
      const content = files.get(p);
      if (content === undefined) throw new Error('ENOENT');
      return content;
    },
    writeFile: async (p, content) => {
      files.set(p, content);
    },
    appendFile: async (p, content) => {
      files.set(p, (files.get(p) ?? '') + content);
    },
    exists: async (p) => files.has(p),
    readLines: async function* (p) {
      const content = files.get(p);
      if (content === undefined) throw new Error('ENOENT');
      yield* content.split('\n');
    },
    mkdir: vi.fn(async () => undefined),
    rm: async (p) => {
      files.delete(p);
    },
  });
  return { files, store };
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
});
