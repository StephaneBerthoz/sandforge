import * as vscode from 'vscode';

import { FROZEN_SALT_ENV_VAR } from '../modules/frozendataset/DeterministicPseudonymizer';
import {
  FROZEN_SALT_SECRET_KEY,
  fingerprintOf,
  saltProblem,
  secretStorageSaltKeeper,
  type SaltSecrets,
} from '../modules/frozendataset/FrozenSalt';

/** Copies the Frozen dataset salt kept in this editor, for a teammate. */
export const COPY_FROZEN_SALT_COMMAND = 'sandforge.frozen.copySalt';

/** Keeps a salt a teammate gave, for the extractions of this editor. */
export const USE_FROZEN_SALT_COMMAND = 'sandforge.frozen.useSalt';

/** What the two commands say and ask, worded by the editor. */
export interface FrozenSaltUi {
  writeClipboard(text: string): Promise<void>;
  /** The salt is on the clipboard. */
  copied(fingerprint: string): void;
  /** The salt a teammate gave; nothing when the user closed the box. */
  askSalt(): Promise<string | undefined>;
  /** Whether to replace the salt kept here by another one. */
  confirmReplace(kept: string, given: string): Promise<boolean>;
  /** The salt given is kept; `overridden` when the environment's wins over it. */
  used(fingerprint: string, overridden: boolean): void;
}

/**
 * Copy the salt this editor's extractions pseudonymize with: the one kept, or
 * the environment's where it is set; made and kept now when there is none
 * yet, as the first extraction would.
 */
export async function copyFrozenSalt(
  secrets: SaltSecrets,
  ui: FrozenSaltUi,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const { salt } = await secretStorageSaltKeeper(secrets, env).forExtraction();
  await ui.writeClipboard(salt);
  ui.copied(fingerprintOf(salt));
}

/**
 * Keep a salt a teammate gave, so this editor's extractions draw the same
 * pseudonyms as theirs. Replacing a salt already kept is asked first: the
 * extractions made with it would no longer be made again the same way.
 */
export async function useFrozenSalt(
  secrets: SaltSecrets,
  ui: FrozenSaltUi,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const given = (await ui.askSalt())?.trim();
  if (given === undefined || saltProblem(given) !== undefined) return;
  const kept = await secrets.getSecret(FROZEN_SALT_SECRET_KEY);
  if (kept !== undefined && kept !== given) {
    const replace = await ui.confirmReplace(fingerprintOf(kept), fingerprintOf(given));
    if (!replace) return;
  }
  await secrets.storeSecret(FROZEN_SALT_SECRET_KEY, given);
  ui.used(fingerprintOf(given), Boolean(env[FROZEN_SALT_ENV_VAR]));
}

/** The editor's wording of the two commands. */
function editorUi(): FrozenSaltUi {
  return {
    writeClipboard: async (text) => {
      await vscode.env.clipboard.writeText(text);
    },
    copied: (fingerprint) => {
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          'SandForge: the Frozen dataset salt (fingerprint {0}) is on the clipboard. Give it to a teammate as you would a password: whoever holds it can tell which source value a pseudonym was drawn from.',
          fingerprint,
        ),
      );
    },
    askSalt: async () =>
      vscode.window.showInputBox({
        password: true,
        ignoreFocusOut: true,
        prompt: vscode.l10n.t(
          'The Frozen dataset salt a teammate gave you: your extractions will draw the same pseudonyms as theirs.',
        ),
        validateInput: (value) =>
          saltProblem(value) === undefined
            ? undefined
            : vscode.l10n.t('A salt holds 16 characters at least.'),
      }),
    confirmReplace: async (kept, given) => {
      const replace = vscode.l10n.t('Replace');
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t(
          'SandForge: this editor already keeps a Frozen dataset salt (fingerprint {0}). Replace it with {1}? An extraction made with the one kept now could no longer be made again with the same pseudonyms.',
          kept,
          given,
        ),
        { modal: true },
        replace,
      );
      return choice === replace;
    },
    used: (fingerprint, overridden) => {
      void vscode.window.showInformationMessage(
        overridden
          ? vscode.l10n.t(
              'SandForge: the Frozen dataset salt {0} is kept, but SANDFORGE_FROZEN_SALT is set in this window and wins over it until it is unset.',
              fingerprint,
            )
          : vscode.l10n.t(
              'SandForge: Frozen dataset extractions draw their pseudonyms with the salt {0} from now on.',
              fingerprint,
            ),
      );
    },
  };
}

/**
 * Register the two commands that share the Frozen dataset salt between
 * teammates: one copies it, the other keeps the one given.
 *
 * @returns the Disposables — the caller MUST push them to context.subscriptions.
 */
export function registerFrozenSaltCommands(secrets: SaltSecrets): vscode.Disposable[] {
  const ui = editorUi();
  return [
    vscode.commands.registerCommand(COPY_FROZEN_SALT_COMMAND, () => copyFrozenSalt(secrets, ui)),
    vscode.commands.registerCommand(USE_FROZEN_SALT_COMMAND, () => useFrozenSalt(secrets, ui)),
  ];
}
