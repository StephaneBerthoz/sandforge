import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { fileRunKeys, runKeyCheck, secretRunKeys } from './runKeyStore.js';

const KEY = 'a'.repeat(64);

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe('runKeyStore', () => {
  it('keeps a set key in the secret storage under its set, and forgets it', async () => {
    const secrets = new Map<string, string>();
    const keys = secretRunKeys({
      storeSecret: async (k, v) => {
        secrets.set(k, v);
      },
      getSecret: async (k) => secrets.get(k),
      deleteSecret: async (k) => {
        secrets.delete(k);
      },
    });

    await keys.save('set-1', KEY);
    expect([...secrets.keys()]).toEqual(['dataops.runKey.set-1']);
    expect(await keys.load('set-1')).toBe(KEY);
    await keys.delete('set-1');
    expect(await keys.load('set-1')).toBeUndefined();
  });

  it('keeps a command line key in a file only its owner reads, in a folder only its owner opens', async () => {
    const store = mkdtempSync(path.join(tmpdir(), 'sandforge-run-keys-'));
    folders.push(store);
    const keys = fileRunKeys(store);

    await keys.save('cli-dataops-anonymize-1', KEY);

    const file = path.join(store, 'keys', 'cli-dataops-anonymize-1.key');
    // Windows keeps no permission bits: Node reads 0o666 there, whatever was asked.
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(path.join(store, 'keys')).mode & 0o777).toBe(0o700);
    }
    expect(await keys.load('cli-dataops-anonymize-1')).toBe(KEY);
    await keys.delete('cli-dataops-anonymize-1');
    expect(readdirSync(path.join(store, 'keys'))).toEqual([]);
    expect(await keys.load('cli-dataops-anonymize-1')).toBeUndefined();
  });

  it('reads no key from a file that holds none, and names no file outside its folder', async () => {
    const store = mkdtempSync(path.join(tmpdir(), 'sandforge-run-keys-'));
    folders.push(store);
    const keys = fileRunKeys(store);
    await keys.save('set-1', KEY);
    writeFileSync(path.join(store, 'keys', 'set-1.key'), 'not a key');

    expect(await keys.load('set-1')).toBeUndefined();
    await expect(keys.save('../outside', KEY)).rejects.toThrow('Not a set id');
  });

  it('tells a key again by sixteen hex digits that do not hold it', () => {
    expect(runKeyCheck(KEY)).toMatch(/^[0-9a-f]{16}$/);
    expect(runKeyCheck(KEY)).toBe(runKeyCheck(KEY));
    expect(runKeyCheck('b'.repeat(64))).not.toBe(runKeyCheck(KEY));
    expect(KEY).not.toContain(runKeyCheck(KEY));
  });
});
