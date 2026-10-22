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
import type { BackupExpired } from '../src/bridge/handlers/DataOpsHandler.js';
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

/**
 * The days `--max-age-days` keeps a snapshot, as `sandforge.backup.maxAgeDays`
 * keeps a backup, or undefined when the line gives none; stops the command,
 * exit 2, on a value that is not a number of days. The command lines expired
 * every snapshot past the extension's default of thirty days, with no way to
 * keep one longer.
 */
export function maxAgeDaysOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{1,5}$/.test(value)) {
    process.stderr.write(`Not a number of days: "${value}"\n`);
    process.exit(2);
  }
  return Number(value);
}

/**
 * The settings `DataOpsHandler` reads, as the line of `sandforge-backup` or
 * `sandforge-dataops` sets them: the cap of records a snapshot reads
 * (`--max-records`), and the retention (`--max-age-days`); every other one
 * the extension's default.
 */
export function settingsOf(args: {
  maxRecords?: number;
  maxAgeDays?: number;
}): <T>(key: string, fallback: T) => T {
  return <T>(key: string, fallback: T): T => {
    if (key === 'backup.maxRecordsPerObject' && args.maxRecords !== undefined) {
      return args.maxRecords as T;
    }
    if (key === 'backup.maxAgeDays' && args.maxAgeDays !== undefined) {
      return args.maxAgeDays as T;
    }
    return fallback;
  };
}

/**
 * A snapshot the retention removed, as the line on stderr says it: the one a
 * Sync run kept of what it wrote over named, since removing that run no
 * longer puts those values back.
 */
export function expiredLine(expired: BackupExpired): string {
  const head =
    `removed snapshot ${expired.operationId}` +
    `${expired.takenAt !== undefined ? `, taken ${expired.takenAt}` : ''}: ` +
    `past the retention of ${expired.days} day(s) (--max-age-days, 0 keeps them all)`;
  return expired.syncRunId !== undefined
    ? `${head}. It held what the Sync run ${expired.syncRunId || '(unknown)'} wrote over: ` +
        'removing that run with sandforge-sync --remove no longer puts those values back'
    : head;
}
