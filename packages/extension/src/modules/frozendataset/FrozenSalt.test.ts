import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FROZEN_SALT_ENV_VAR, MissingSaltError } from './DeterministicPseudonymizer.js';
import {
  FROZEN_SALT_SECRET_KEY,
  MIN_SALT_LENGTH,
  commandLineSaltKeeper,
  fingerprintOf,
  newFrozenSalt,
  saltProblem,
  secretStorageSaltKeeper,
  type SaltSecrets,
} from './FrozenSalt.js';

/** VS Code's secret storage, in memory; `keeps: false` stands for one that loses what it is given. */
function secrets(keeps = true): SaltSecrets & { kept: Map<string, string> } {
  const kept = new Map<string, string>();
  return {
    kept,
    getSecret: async (key) => kept.get(key),
    storeSecret: async (key, value) => {
      if (keeps) kept.set(key, value);
    },
  };
}

describe('the salt the editor keeps', () => {
  it('is made on the first extraction, kept in secret storage, and the same on every later one', async () => {
    // Required as an environment variable set before VS Code starts, its
    // absence refused every extraction with SALT_MISSING.
    const store = secrets();
    const keeper = secretStorageSaltKeeper(store, {});

    expect(await keeper.read()).toBeUndefined();
    const first = await keeper.forExtraction();
    const second = await keeper.forExtraction();

    expect(first.created).toBe(true);
    expect(first.source).toBe('secretStorage');
    expect(store.kept.get(FROZEN_SALT_SECRET_KEY)).toBe(first.salt);
    expect(second).toEqual({ salt: first.salt, source: 'secretStorage' });
    expect(await keeper.read()).toEqual({ salt: first.salt, source: 'secretStorage' });
  });

  it('takes SANDFORGE_FROZEN_SALT where it is set, as a CI job gives it, and keeps nothing', async () => {
    const store = secrets();
    const keeper = secretStorageSaltKeeper(store, {
      [FROZEN_SALT_ENV_VAR]: 'salt-from-the-ci-job',
    });

    expect(await keeper.forExtraction()).toEqual({
      salt: 'salt-from-the-ci-job',
      source: 'environment',
    });
    expect(store.kept.size).toBe(0);
  });

  it('refuses rather than pseudonymize with a salt the storage did not keep', async () => {
    // The next extraction would have drawn another salt, and other
    // pseudonyms for the same records, without a word.
    await expect(secretStorageSaltKeeper(secrets(false), {}).forExtraction()).rejects.toThrow(
      MissingSaltError,
    );
  });
});

describe('the salt the command line reads', () => {
  it('comes from SANDFORGE_FROZEN_SALT, or from the file given, never made up', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'frozen-salt-'));
    try {
      const file = join(dir, 'salt.txt');
      writeFileSync(file, '  salt-held-in-a-file-by-the-team  \n');

      expect(await commandLineSaltKeeper({}, file).forExtraction()).toEqual({
        salt: 'salt-held-in-a-file-by-the-team',
        source: 'file',
      });
      expect(
        await commandLineSaltKeeper({ [FROZEN_SALT_ENV_VAR]: 'from-env-wins' }, file).read(),
      ).toEqual({ salt: 'from-env-wins', source: 'environment' });
      await expect(commandLineSaltKeeper({}).forExtraction()).rejects.toThrow(MissingSaltError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a salt given by hand', () => {
  it(`is refused under ${MIN_SALT_LENGTH} characters`, () => {
    expect(saltProblem('short')).toMatch(/16 characters at least/);
    expect(saltProblem(newFrozenSalt())).toBeUndefined();
  });

  it('is shown by its fingerprint alone, the same for the same salt', () => {
    const salt = newFrozenSalt();
    expect(fingerprintOf(salt)).toMatch(/^[0-9a-f]{12}$/);
    expect(fingerprintOf(salt)).toBe(fingerprintOf(salt));
    expect(fingerprintOf(salt)).not.toBe(fingerprintOf(newFrozenSalt()));
  });
});
