import * as path from 'node:path';

import { describe, it, expect, vi } from 'vitest';

import { BackupRecordStore } from './BackupRecordStore.js';

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
    mkdir: vi.fn(async () => undefined),
    rm: async (p) => {
      files.delete(p);
    },
  });
  return { files, store };
}

describe('BackupRecordStore', () => {
  it('round-trips one object of a backup', async () => {
    const { store } = createStore();
    const records = [{ Id: '001a' }, { Id: '001b' }];

    await store.save('op-1', 'Account', records);

    expect(await store.read('op-1', 'Account')).toEqual(records);
  });

  it('keeps objects and operations in separate files', async () => {
    const { files, store } = createStore();

    await store.save('op-1', 'Account', [{ Id: 'a' }]);
    await store.save('op-1', 'Contact', [{ Id: 'c' }]);
    await store.save('op-2', 'Account', [{ Id: 'z' }]);

    expect(files.size).toBe(3);
    expect(await store.read('op-1', 'Contact')).toEqual([{ Id: 'c' }]);
    expect(await store.read('op-2', 'Account')).toEqual([{ Id: 'z' }]);
  });

  it('returns null for a backup written before the store existed', async () => {
    // The readers fall back to ConfigStore on null, which is what keeps
    // pre-existing backups restorable without a migration pass.
    const { store } = createStore();
    expect(await store.read('never-written', 'Account')).toBeNull();
  });

  it('confines a crafted operationId to one path segment', async () => {
    // operationId and objectApiName arrive from a bridge payload.
    const { files, store } = createStore();

    await store.save('../../etc/passwd', 'Account', [{ Id: 'a' }]);

    const written = Array.from(files.keys())[0];
    expect(written).not.toContain('..');
    // path.join uses the host separator, so normalise before comparing.
    expect(written.split(path.sep).join('/')).toContain('/storage/backups/');
  });

  it('treats deleting a missing file as success', async () => {
    const { store } = createStore();
    await expect(store.delete('op-1', 'Account')).resolves.toBeUndefined();
  });
});
