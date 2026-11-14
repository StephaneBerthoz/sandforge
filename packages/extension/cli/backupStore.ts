/**
 * Where the DataOps command lines keep their snapshots, how the folder is
 * made, and what they read of it before any org is reached: the snapshot or
 * the set of slices a restore names, and the sets a listing names.
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
import type { ConfigStore } from '../src/core/storage/ConfigStore.js';
import {
  BackupSetStore,
  slicesOf,
  type BackupSet,
} from '../src/modules/dataops/slices/backupSet.js';
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

/** Every value a flag is given on the line, the flag given once or again. */
export function valuesOf(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, at) =>
    arg === flag && at + 1 < args.length ? [args[at + 1] ?? ''] : [],
  );
}

/**
 * The slices `--slice` names, each value a number or numbers joined by
 * commas, the flag given once or again: `--slice 2`, `--slice 1,3`. Stops the
 * command, exit 2, on a value that names none.
 */
export function slicesNamed(values: readonly string[]): number[] {
  const named: number[] = [];
  for (const value of values) {
    if (!/^[1-9]\d{0,5}(,[1-9]\d{0,5})*$/.test(value)) {
      process.stderr.write(`Not a slice's number: "${value}". Give --slice 2, or --slice 1,3.\n`);
      process.exit(2);
    }
    for (const n of value.split(',').map(Number)) if (!named.includes(n)) named.push(n);
  }
  return named.sort((a, b) => a - b);
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
        'removing that run with sandforge sync --remove no longer puts those values back'
    : head;
}

// ─── Sets of slices ──────────────────────────────────────────────────────────

/** One day, in milliseconds. */
const DAY_MS = 24 * 60 * 60_000;

/** What a restore names, read from the store alone, before any org is reached. */
export interface RestoreTarget {
  /** How its question names it: `snapshot <id>`, or a set and the slices put back. */
  words: string;
  /** Per object, the records written back, as the read of what the org runs takes them. */
  objects: Array<{ objectApiName: string; records: number }>;
  totalRecords: number;
}

/** A snapshot's metadata, as a restore reads it before it asks. */
interface SnapshotMeta {
  totalRecords?: number;
  objects?: Array<{ objectApiName: string; recordCount?: number }>;
  origin?: string;
  setId?: string;
  slice?: { index: number };
}

/**
 * What a restore of `id` puts back, read from the store: a snapshot's
 * records, or the slices of a set of slices it chooses — those named, every
 * one with `rewriteAll`, or those not put back yet —, as the restore chooses
 * them. A slice's own snapshot is named as its set's slice. Undefined when
 * the store holds neither.
 */
export function restoreTargetOf(
  store: ConfigStore,
  id: string,
  options: { slices?: readonly number[]; rewriteAll?: boolean } = {},
): RestoreTarget | undefined {
  const meta = store.get<SnapshotMeta>(`backup:${id}`);
  if (meta) {
    const objects = (meta.objects ?? []).map((o) => ({
      objectApiName: o.objectApiName,
      records: o.recordCount ?? 0,
    }));
    return {
      words:
        meta.origin === 'slice' && meta.setId !== undefined
          ? `slice ${meta.slice?.index ?? '?'} of set ${meta.setId}`
          : `snapshot ${id}`,
      objects,
      totalRecords: meta.totalRecords ?? objects.reduce((sum, o) => sum + o.records, 0),
    };
  }
  const set = new BackupSetStore(store).get(id);
  if (!set) return undefined;
  const taken = set.objects.flatMap((o) =>
    o.slices
      .filter((s) => s.state !== 'pending')
      .map((slice) => ({ objectApiName: o.objectApiName, slice })),
  );
  const named = options.slices;
  const chosen = named
    ? taken.filter((t) => named.includes(t.slice.index))
    : options.rewriteAll === true
      ? taken
      : taken.filter((t) => t.slice.restoredAt === undefined);
  const objects: RestoreTarget['objects'] = [];
  for (const { objectApiName, slice } of chosen) {
    const held = objects.find((o) => o.objectApiName === objectApiName);
    if (held) held.records += slice.rows;
    else objects.push({ objectApiName, records: slice.rows });
  }
  const which = named
    ? `slice(s) ${named.join(', ')}`
    : options.rewriteAll === true
      ? 'every slice'
      : `the ${chosen.length} slice(s) not put back yet`;
  return {
    words: `set ${id} (${which}, of ${taken.length})`,
    objects,
    totalRecords: objects.reduce((sum, o) => sum + o.records, 0),
  };
}

/**
 * What a restore of a set of slices says of each slice it reached: what it
 * wrote back, what the org refused, what it held already; a slice put back
 * before, which it did not read again, said so. None for a snapshot.
 */
export function restoredSliceLines(payload: Record<string, unknown>): string[] {
  const slices = payload['slices'];
  if (!Array.isArray(slices)) return [];
  return (
    slices as Array<{
      index: number;
      objectApiName: string;
      restored: number;
      failed: number;
      unchanged: number;
      skipped?: true;
    }>
  ).map((s) =>
    s.skipped === true
      ? `  slice ${s.index}  ${s.objectApiName}  put back before, not read again ` +
        '(--slice or --rewrite-all puts it back again)'
      : `  slice ${s.index}  ${s.objectApiName}  put back ${s.restored}  refused ${s.failed}  ` +
        `unchanged ${s.unchanged}`,
  );
}

/** The sets of slices the store keeps, every org's. */
export function setsOfStore(store: ConfigStore): BackupSet[] {
  return new BackupSetStore(store).list();
}

/**
 * When the retention removes a set, by when it last moved: its slices, its
 * manifest and its key together, an open one too. Undefined when the
 * retention keeps every backup (0 days).
 */
export function setExpiresAt(
  set: Pick<BackupSet, 'lastActivityAt'>,
  days: number,
): string | undefined {
  const moved = Date.parse(set.lastActivityAt);
  if (days <= 0 || !Number.isFinite(moved)) return undefined;
  return new Date(moved + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * A set of slices as `--list` names it, one line whatever its slices: its
 * id, when it began, the org, each object and the filter it held it to, its
 * slices and records, what it is and where it stands, and when the
 * retention removes it.
 *
 * @param days - The retention, in days; 0 keeps every backup.
 */
export function setLine(set: BackupSet, days: number): string {
  const slices = slicesOf(set);
  const records = slices.reduce((sum, s) => sum + s.rows, 0);
  const objects = set.objects
    .map((o) => `${o.objectApiName}${o.where !== undefined ? ` (where ${o.where})` : ''}`)
    .join(', ');
  const expires = setExpiresAt(set, days);
  return (
    `${set.setId}  ${set.startedAt}  ${set.orgId}  ${objects}  ${slices.length} slice(s) of up ` +
    `to ${set.size}  ${records} record(s)  ${set.kind}, ${set.state}  ` +
    (expires !== undefined ? `expires ${expires}` : 'kept (--max-age-days 0)')
  );
}
