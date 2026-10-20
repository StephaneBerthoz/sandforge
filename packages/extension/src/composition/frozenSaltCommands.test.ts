import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  commands: { registerCommand: vi.fn(() => ({ dispose: () => undefined })) },
  window: {},
  env: {},
  l10n: { t: (message: string) => message },
}));

import { FROZEN_SALT_ENV_VAR } from '../modules/frozendataset/DeterministicPseudonymizer';
import { FROZEN_SALT_SECRET_KEY, fingerprintOf } from '../modules/frozendataset/FrozenSalt';
import {
  COPY_FROZEN_SALT_COMMAND,
  USE_FROZEN_SALT_COMMAND,
  copyFrozenSalt,
  registerFrozenSaltCommands,
  useFrozenSalt,
  type FrozenSaltUi,
} from './frozenSaltCommands';

function secrets(initial?: string) {
  const kept = new Map<string, string>(initial ? [[FROZEN_SALT_SECRET_KEY, initial]] : []);
  return {
    kept,
    getSecret: async (key: string) => kept.get(key),
    storeSecret: async (key: string, value: string) => {
      kept.set(key, value);
    },
  };
}

function ui(over: Partial<FrozenSaltUi> = {}): FrozenSaltUi & { clipboard: string[] } {
  const clipboard: string[] = [];
  return {
    clipboard,
    writeClipboard: async (text) => {
      clipboard.push(text);
    },
    copied: vi.fn(),
    askSalt: vi.fn(async () => undefined),
    confirmReplace: vi.fn(async () => true),
    used: vi.fn(),
    ...over,
  };
}

const TEAM_SALT = 'the-salt-our-team-extracts-with';

describe('the Frozen dataset salt commands', () => {
  it('copies the salt kept to the clipboard, saying only its fingerprint', async () => {
    const say = ui();
    await copyFrozenSalt(secrets(TEAM_SALT), say, {});

    expect(say.clipboard).toEqual([TEAM_SALT]);
    expect(say.copied).toHaveBeenCalledWith(fingerprintOf(TEAM_SALT));
  });

  it('makes and keeps the salt when there is none yet, as the first extraction would', async () => {
    const store = secrets();
    const say = ui();
    await copyFrozenSalt(store, say, {});

    expect(say.clipboard).toEqual([store.kept.get(FROZEN_SALT_SECRET_KEY)]);
  });

  it("keeps the salt a teammate gave, and says when the environment's wins over it", async () => {
    const store = secrets();
    const say = ui({ askSalt: async () => `  ${TEAM_SALT}  ` });
    await useFrozenSalt(store, say, { [FROZEN_SALT_ENV_VAR]: 'ci-salt-from-the-environment' });

    expect(store.kept.get(FROZEN_SALT_SECRET_KEY)).toBe(TEAM_SALT);
    expect(say.used).toHaveBeenCalledWith(fingerprintOf(TEAM_SALT), true);
  });

  it('asks before it replaces a salt already kept, and keeps it when told not to', async () => {
    const store = secrets('the-salt-this-editor-made-before');
    const say = ui({ askSalt: async () => TEAM_SALT, confirmReplace: vi.fn(async () => false) });
    await useFrozenSalt(store, say, {});

    expect(say.confirmReplace).toHaveBeenCalledWith(
      fingerprintOf('the-salt-this-editor-made-before'),
      fingerprintOf(TEAM_SALT),
    );
    expect(store.kept.get(FROZEN_SALT_SECRET_KEY)).toBe('the-salt-this-editor-made-before');
    expect(say.used).not.toHaveBeenCalled();
  });

  it('keeps nothing when the box is closed or the salt too short', async () => {
    const store = secrets();
    await useFrozenSalt(store, ui(), {});
    await useFrozenSalt(store, ui({ askSalt: async () => 'short' }), {});
    expect(store.kept.size).toBe(0);
  });

  it('registers both commands', () => {
    const disposables = registerFrozenSaltCommands(secrets());
    expect(disposables).toHaveLength(2);
    expect([COPY_FROZEN_SALT_COMMAND, USE_FROZEN_SALT_COMMAND]).toEqual([
      'sandforge.frozen.copySalt',
      'sandforge.frozen.useSalt',
    ]);
  });
});
