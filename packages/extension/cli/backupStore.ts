/**
 * Where the DataOps command lines keep their snapshots, and how the folder is
 * made.
 *
 * `sandforge-backup` and `sandforge-dataops` kept them in a fixed folder of the
 * system's temp directory, `sandforge-backups`. A masking run's snapshot holds
 * the values it masks as they were, personal data among them: on a shared
 * Linux host or a self-hosted runner, the folder was another user's to read,
 * or to make first, and the one snapshot that could undo a masking run went
 * at the next reboot. They are kept in the user's own SandForge folder now,
 * beside the clone command's journals, readable by that user alone.
 */

import { mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** What a folder and a file of the store are made with: their owner alone reads them. */
export const STORE_DIR_MODE = 0o700;

/**
 * The folder the snapshots go in when the command line names none:
 * `backups/` in the folder `SANDFORGE_JOURNAL_DIR` names, the clone command's
 * own, or in `.sandforge` in the home directory.
 */
export function defaultBackupStoreOf(env: NodeJS.ProcessEnv = process.env): string {
  return toolStoreOf('backups', env);
}

/**
 * The folder a command keeps its state in when the command line names none:
 * `<name>/` in the folder `SANDFORGE_JOURNAL_DIR` names, or in `.sandforge`
 * in the home directory, opened with {@link openBackupStore}.
 *
 * Compare and Monitor kept their host's store in a fixed folder of the
 * system's temp directory, `sandforge-compare` and `sandforge-monitor`, the
 * shared default the backups had left: on a self-hosted runner, a second user
 * failed on a folder the first had made, and two jobs of one user wrote over
 * each other's store. They keep it beside the other commands' state now,
 * their owner's alone.
 *
 * @param name - The command's folder: `backups`, `compare`, `monitor`.
 */
export function toolStoreOf(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = env['SANDFORGE_JOURNAL_DIR'];
  const home =
    dir !== undefined && dir.trim() !== '' ? resolve(dir) : join(homedir(), '.sandforge');
  return join(home, name);
}

/** What {@link openBackupStore} reads of the file system, so it can be tested. */
export interface StoreFolderFs {
  mkdir: (path: string, options: { recursive: true; mode: number }) => void;
  stat: (path: string) => { isDirectory: () => boolean; uid: number };
  /** The user the command runs as; absent where the system has none, as on Windows. */
  uid?: () => number;
}

/** The file system the command lines run on. */
const nodeFs: StoreFolderFs = {
  mkdir: (path, options) => {
    mkdirSync(path, options);
  },
  stat: (path) => statSync(path),
  ...(typeof process.getuid === 'function' ? { uid: () => process.getuid?.() ?? -1 } : {}),
};

/**
 * Make the store's folder, readable by its owner alone when it is new, and
 * refuse one another user owns: whoever owns it can read the snapshots, and
 * replace them before a restore reads them.
 *
 * @returns Why the folder cannot be used, or `undefined` when it can.
 */
export function openBackupStore(dir: string, fs: StoreFolderFs = nodeFs): string | undefined {
  try {
    fs.mkdir(dir, { recursive: true, mode: STORE_DIR_MODE });
    const folder = fs.stat(dir);
    if (!folder.isDirectory()) return `The store ${dir} is not a folder.`;
    const me = fs.uid?.();
    if (me !== undefined && folder.uid !== me) {
      return (
        `The store ${dir} belongs to another user, who can read its snapshots and change ` +
        'them: name a folder of your own with --store.'
      );
    }
    return undefined;
  } catch (err: unknown) {
    return `The store ${dir} could not be made: ${err instanceof Error ? err.message : String(err)}`;
  }
}
