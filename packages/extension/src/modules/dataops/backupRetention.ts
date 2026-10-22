/**
 * How long the DataOps backup store keeps a backup, `sandforge.backup.maxAgeDays`,
 * and what that leaves a Sync run's removal to put back.
 *
 * A Sync run keeps the values it writes over in that store, and its removal
 * gives them back from it; the retention takes them with every other backup
 * once they reach its age. The run's card read what it could put back from
 * the run's file alone: five weeks on, it still said the values were kept on
 * this machine, the confirmation listed the records to be given them back,
 * and only once the user had typed the org's name and the run's creations
 * were deleted did the result say the values were no longer kept.
 */

import type { SyncRunOverwritten } from '../sync/SyncRunCreations.js';

/**
 * How many days a backup is kept, when `sandforge.backup.maxAgeDays` says
 * nothing. A backup holds the records' values as the org held them, personal
 * data among them, and was kept until ten newer ones of the same org pushed
 * it out: an org backed up once kept it for good.
 */
export const BACKUP_MAX_AGE_DAYS_DEFAULT = 30;

/** One day, in milliseconds. */
const DAY_MS = 24 * 60 * 60_000;

/** What reads the extension's settings: the part of `Services` this needs. */
export interface RetentionSettings {
  getSandforgeSetting?: <T>(key: string, fallback: T) => T;
}

/**
 * The days `sandforge.backup.maxAgeDays` keeps a backup; 0 when it keeps
 * them all — set so, or set to something that is not a number.
 */
export function backupMaxAgeDays(settings: RetentionSettings | undefined): number {
  const asked = settings?.getSandforgeSetting?.<unknown>(
    'backup.maxAgeDays',
    BACKUP_MAX_AGE_DAYS_DEFAULT,
  );
  return typeof asked === 'number' && Number.isFinite(asked) && asked > 0 ? asked : 0;
}

/** A backup's metadata, as the store lists it: when it was taken. */
export interface BackupTaken {
  timestamp?: string;
}

/** What a removal can still put back of what a run wrote over. */
export interface PutBackKept {
  /** The objects whose backup is still kept, as the run names them. */
  kept: SyncRunOverwritten[];
  /** Records whose backup is gone — deleted, or past its retention — which nothing puts back. */
  notKept: number;
  /** When the first of the kept backups reaches its retention, ISO 8601; absent when none does. */
  keptUntil?: string;
}

/**
 * Of what a removal of a run would put back, what the store still keeps the
 * values of, read from the backups' metadata — `backup:<id>`, which the
 * retention removes with a backup's files — and until when.
 *
 * @param metaOf - A backup's metadata by its id; undefined once it is gone.
 * @param maxAgeDays - What {@link backupMaxAgeDays} reads; 0 keeps them all.
 */
export function putBackKept(
  plan: readonly SyncRunOverwritten[],
  metaOf: (backupId: string) => BackupTaken | undefined,
  maxAgeDays: number,
): PutBackKept {
  const kept: SyncRunOverwritten[] = [];
  let notKept = 0;
  let until = Number.POSITIVE_INFINITY;
  for (const object of plan) {
    const meta = metaOf(object.backup);
    if (!meta) {
      notKept += object.ids.length;
      continue;
    }
    kept.push(object);
    const taken = Date.parse(meta.timestamp ?? '');
    if (maxAgeDays > 0 && Number.isFinite(taken)) {
      until = Math.min(until, taken + maxAgeDays * DAY_MS);
    }
  }
  return {
    kept,
    notKept,
    ...(Number.isFinite(until) ? { keptUntil: new Date(until).toISOString() } : {}),
  };
}
