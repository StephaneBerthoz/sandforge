/**
 * Where the pseudonymization salt of a Frozen dataset comes from.
 *
 * The salt keys every pseudonym an extraction writes: the same salt gives the
 * same pseudonyms, run after run and machine after machine, and a second salt
 * gives other ones, silently. It used to come from `SANDFORGE_FROZEN_SALT`
 * alone, an environment variable set before VS Code starts — from a shell
 * with it exported, the `export` syntax of bash, which PowerShell does not
 * read — and an extraction was refused with "SALT_MISSING" until it was.
 *
 * In the editor it is now kept in VS Code's secret storage, made on the first
 * extraction and kept from then on, so that every later one pseudonymizes the
 * same way. It is never written to a file nor shown: its fingerprint is. A
 * teammate who extracts the same dataset is given it (copied by a command)
 * and sets it (by another). The environment variable still wins where it is
 * set, which is how a CI job and the command line give it. The command line
 * reads it from the variable or from a file, and never makes one: a salt
 * nobody keeps would give pseudonyms nobody can make again.
 */

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  DeterministicPseudonymizer,
  FROZEN_SALT_ENV_VAR,
  MissingSaltError,
} from './DeterministicPseudonymizer.js';

/** The key the editor keeps the salt under in VS Code's secret storage. */
export const FROZEN_SALT_SECRET_KEY = 'frozen.salt';

/** The fewest characters a salt given by hand may hold. */
export const MIN_SALT_LENGTH = 16;

/** Where a salt came from. */
export type FrozenSaltSource = 'environment' | 'secretStorage' | 'file';

/** A salt, where it came from, and whether it was made just now. */
export interface FrozenSalt {
  readonly salt: string;
  readonly source: FrozenSaltSource;
  /** Set when it did not exist before this extraction asked for it. */
  readonly created?: true;
}

/** What keeps the salt between extractions. */
export interface FrozenSaltKeeper {
  /** The salt kept, without making one. */
  read(): Promise<FrozenSalt | undefined>;
  /**
   * The salt an extraction pseudonymizes with: the one kept, or — where the
   * keeper can keep one — a new one, kept from now on.
   *
   * @throws {MissingSaltError} When there is none and none can be kept.
   */
  forExtraction(): Promise<FrozenSalt>;
}

/** The secret storage the editor keeps the salt in (`SecretVault`). */
export interface SaltSecrets {
  getSecret(key: string): Promise<string | undefined>;
  storeSecret(key: string, value: string): Promise<void>;
}

/** A new salt: 32 random bytes, as base64url. */
export function newFrozenSalt(): string {
  return randomBytes(32).toString('base64url');
}

/** Why a salt given by hand cannot be used; nothing when it can. */
export function saltProblem(value: string): string | undefined {
  const salt = value.trim();
  if (salt.length < MIN_SALT_LENGTH) {
    return `A salt holds ${MIN_SALT_LENGTH} characters at least; this one holds ${salt.length}.`;
  }
  return undefined;
}

/** The fingerprint of a salt, the only thing of it ever shown: see `saltFingerprint`. */
export function fingerprintOf(salt: string): string {
  return new DeterministicPseudonymizer(salt).saltFingerprint;
}

/** The salt the environment gives, when it gives one. */
function fromEnvironment(env: NodeJS.ProcessEnv): FrozenSalt | undefined {
  const salt = env[FROZEN_SALT_ENV_VAR];
  return salt ? { salt, source: 'environment' } : undefined;
}

/**
 * The editor's keeper: `SANDFORGE_FROZEN_SALT` where it is set, else the salt
 * kept in VS Code's secret storage, made and kept on the first extraction.
 *
 * @param secrets - VS Code's secret storage.
 * @param env - The environment of the extension host.
 */
export function secretStorageSaltKeeper(
  secrets: SaltSecrets,
  env: NodeJS.ProcessEnv = process.env,
): FrozenSaltKeeper {
  const read = async (): Promise<FrozenSalt | undefined> => {
    const given = fromEnvironment(env);
    if (given) return given;
    const kept = await secrets.getSecret(FROZEN_SALT_SECRET_KEY);
    return kept ? { salt: kept, source: 'secretStorage' } : undefined;
  };
  return {
    read,
    forExtraction: async () => {
      const known = await read();
      if (known) return known;
      const salt = newFrozenSalt();
      await secrets.storeSecret(FROZEN_SALT_SECRET_KEY, salt);
      // Read back: a storage that did not keep it would give the next
      // extraction another salt, and other pseudonyms, without a word.
      if ((await secrets.getSecret(FROZEN_SALT_SECRET_KEY)) !== salt) throw new MissingSaltError();
      return { salt, source: 'secretStorage', created: true };
    },
  };
}

/**
 * The command line's keeper: `SANDFORGE_FROZEN_SALT`, else the file given
 * with `--salt-file`. It makes none.
 *
 * @param env - The environment of the command.
 * @param saltFile - The file holding the salt, its surrounding blanks left out.
 */
export function commandLineSaltKeeper(
  env: NodeJS.ProcessEnv = process.env,
  saltFile?: string,
): FrozenSaltKeeper {
  const read = async (): Promise<FrozenSalt | undefined> => {
    const given = fromEnvironment(env);
    if (given) return given;
    if (saltFile === undefined) return undefined;
    const salt = (await readFile(saltFile, 'utf8')).trim();
    return salt ? { salt, source: 'file' } : undefined;
  };
  return {
    read,
    forExtraction: async () => {
      const known = await read();
      if (!known) throw new MissingSaltError();
      return known;
    },
  };
}
