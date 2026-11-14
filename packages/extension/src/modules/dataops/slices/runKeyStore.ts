/**
 * Where the key a masking run in slices masks with is kept until its set
 * ends: the editor's secret storage, or a file only its owner reads on a
 * command line.
 *
 * The key a masking run hashes and draws its people with was one per window,
 * never written down: a run resumed in another window, or by the command
 * line, gave the same address another digest and the same record another
 * person, and a run of a million rows a slice at a time is resumed more
 * often than not. Kept for the set, a resume masks as the run it resumes
 * did. It adds nothing a reader of the machine did not have: the slices'
 * snapshots, beside it, hold the values in clear. It goes when the set is
 * done, given up or expired.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

/** Where a set's key is kept: given, read back, forgotten. */
export interface RunKeyStore {
  save(setId: string, key: string): Promise<void>;
  /** The key kept for the set, or undefined when none is. */
  load(setId: string): Promise<string | undefined>;
  delete(setId: string): Promise<void>;
}

/** What the secret storage of the editor offers: SecretVault's own calls. */
export interface RunKeySecrets {
  storeSecret(key: string, value: string): Promise<void>;
  getSecret(key: string): Promise<string | undefined>;
  deleteSecret(key: string): Promise<void>;
}

/** A set id as it goes into a secret's name or a file's: letters, digits, `-` and `_`. */
function keyName(setId: string): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(setId)) throw new Error(`Not a set id: "${setId}".`);
  return setId;
}

/** A key as it is kept: 64 hex digits, what the handler mints. */
const RUN_KEY = /^[0-9a-f]{64}$/;

/**
 * The keys of the editor's sets, in its secret storage
 * (`sandforge.dataops.runKey.<setId>` once SecretVault prefixes it).
 */
export function secretRunKeys(secrets: RunKeySecrets): RunKeyStore {
  return {
    save: async (setId, key) => {
      await secrets.storeSecret(`dataops.runKey.${keyName(setId)}`, key);
    },
    load: async (setId) => {
      const kept = await secrets.getSecret(`dataops.runKey.${keyName(setId)}`);
      return kept !== undefined && RUN_KEY.test(kept) ? kept : undefined;
    },
    delete: async (setId) => {
      await secrets.deleteSecret(`dataops.runKey.${keyName(setId)}`);
    },
  };
}

/** What a file only its owner reads is written with, and its folder. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * The keys of a command line's sets, one file each under `<store>/keys`,
 * which only the user reads: the store's snapshots sit beside it with the
 * same rights.
 *
 * @param storeDir - The command line's store, where its backups go.
 */
export function fileRunKeys(storeDir: string): RunKeyStore {
  const dir = path.join(storeDir, 'keys');
  const fileOf = (setId: string): string => path.join(dir, `${keyName(setId)}.key`);
  return {
    save: async (setId, key) => {
      await mkdir(dir, { recursive: true, mode: DIR_MODE });
      await writeFile(fileOf(setId), key, { encoding: 'utf8', mode: FILE_MODE });
    },
    load: async (setId) => {
      try {
        const kept = (await readFile(fileOf(setId), 'utf8')).trim();
        return RUN_KEY.test(kept) ? kept : undefined;
      } catch {
        return undefined;
      }
    },
    delete: async (setId) => {
      await rm(fileOf(setId), { force: true });
    },
  };
}

/**
 * What a set keeps of its key to tell it again: sixteen hex digits of a
 * digest, from which the key cannot be read back. A resume whose key does
 * not give it masks with another key than the run it resumes.
 */
export function runKeyCheck(key: string): string {
  return createHash('sha256').update(`sandforge-slice-key:${key}`).digest('hex').slice(0, 16);
}
