import type {
  CheckpointAccessLeftOutCode,
  CheckpointLeftOutObject,
  CheckpointListEntry,
  CheckpointRefusal,
  CheckpointScopeResponse,
  OrgCheckpoint,
  RewindUndoCannot,
  RewindUndoCannotReason,
} from '@sandforge/shared';
import { CHECKPOINT_OBJECT_ROWS_MAX } from '../../utils/checkpointLimits';

/**
 * Days a checkpoint is kept unless its owner keeps it until they delete it:
 * the store's default (`DEFAULT_KEEP_DAYS` in the extension's
 * OrgCheckpointStore), which the take asks for by number.
 */
export const CHECKPOINT_KEEP_DAYS = 30;

/** The most days a take may keep a checkpoint, as the extension bounds `keepDays`. */
const CHECKPOINT_KEEP_DAYS_MAX = 3650;

/**
 * How a take a page opened keeps its checkpoint, from the days it was asked
 * for (`checkpointKeepDays`): 0 ticks Keep until I delete it, as the
 * Back into service page asks of the testers' start; a whole number of days
 * the store takes keeps it that long; anything else, the store's 30 days.
 */
export function takeKeepOf(keepDays: number | undefined): { keep: boolean; days: number } {
  if (keepDays === 0) return { keep: true, days: CHECKPOINT_KEEP_DAYS };
  return keepDays !== undefined &&
    Number.isInteger(keepDays) &&
    keepDays > 0 &&
    keepDays <= CHECKPOINT_KEEP_DAYS_MAX
    ? { keep: false, days: keepDays }
    : { keep: false, days: CHECKPOINT_KEEP_DAYS };
}

/**
 * Records a take holds at most, all objects together, unless Records at
 * most says another number: the take's own default (`DEFAULT_MAX_TOTAL` in
 * the extension's takeCheckpoint), which the page sends only when changed.
 */
export const CHECKPOINT_MAX_TOTAL = 500_000;

/** Records at most as typed, as a take is asked it: a whole number up to {@link CHECKPOINT_OBJECT_ROWS_MAX}, else undefined. */
export function takeLimitOf(typed: string): number | undefined {
  const trimmed = typed.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const limit = Number(trimmed);
  return limit >= 1 && limit <= CHECKPOINT_OBJECT_ROWS_MAX ? limit : undefined;
}

/**
 * Why Undo couldn't bring back records a rewind deletes, as an entry of a
 * preview or a result says it: one that names none is of the first reason,
 * as a diff or a result made before the second was told says it.
 */
export function undoCannotReasonOf(item: Pick<RewindUndoCannot, 'reason'>): RewindUndoCannotReason {
  return item.reason ?? 'onlyWithParent';
}

/** Records a checkpoint holds, all its objects together. */
export function recordsHeld(checkpoint: Pick<OrgCheckpoint, 'objects'>): number {
  return checkpoint.objects.reduce((sum, object) => sum + object.records, 0);
}

/**
 * Objects of a checkpoint that hold records: the "38 objects" a take reads
 * back, where its scope also holds the empty ones, kept so that what is
 * created there later is caught.
 */
export function objectsWithRecords(checkpoint: Pick<OrgCheckpoint, 'objects'>): number {
  return checkpoint.objects.filter((object) => object.records > 0).length;
}

/**
 * The checkpoints of a list that can be rewound to, each with its file, in
 * the order the list gives them: newest first.
 */
export function usableCheckpoints(
  entries: readonly CheckpointListEntry[],
): Array<CheckpointListEntry & { checkpoint: OrgCheckpoint }> {
  return entries.filter(
    (entry): entry is CheckpointListEntry & { checkpoint: OrgCheckpoint } =>
      entry.valid && entry.checkpoint !== undefined,
  );
}

/** What a scope's answer says of what a take keeps, and of its refusal. */
type ScopeFacts = Pick<CheckpointScopeResponse['payload'], 'objects' | 'leftOut' | 'refusal'>;

/**
 * Whether a take was refused before its scope was read — a production org, a
 * user without View All Data and Modify All Data — as the command line tells
 * it: the answer then holds no object, kept or left out, and an estimate of
 * nothing, which said "about 0 API requests of the 0 left today" under the
 * refusal, as if the take cost nothing. A refusal met once the scope was
 * counted keeps the estimate it is about.
 */
export function refusedBeforeScope<T extends ScopeFacts>(
  answer: T,
): answer is T & { refusal: CheckpointRefusal } {
  return answer.refusal !== undefined && answer.objects.length === 0 && answer.leftOut.length === 0;
}

/**
 * The reasons a take leaves an object out for its user's permissions alone:
 * the user has no View All Data and Modify All Data, and nothing else proves
 * they see and put back every record of it. One added to the type fails to
 * compile here.
 */
const LEFT_OUT_FOR_ACCESS: Readonly<Record<CheckpointAccessLeftOutCode, true>> = {
  noViewAll: true,
  noModifyAll: true,
  activities: true,
  catalog: true,
  filesNotProven: true,
  settingNotProven: true,
  parentNotSeen: true,
};

/** Whether an object a scope left out was left out for its user's permissions: see {@link LEFT_OUT_FOR_ACCESS}. */
export function leftOutForAccess(object: Pick<CheckpointLeftOutObject, 'code'>): boolean {
  return object.code !== undefined && object.code in LEFT_OUT_FOR_ACCESS;
}

/**
 * Whether a take would hold its objects with View All and Modify All per
 * object, its user having no View All Data and Modify All Data: an object it
 * holds says how its user holds it whole (`access`), and one it leaves out
 * for that alone says why. A scope that holds none, every object left out,
 * is one too.
 */
export function heldPerObject(answer: Pick<ScopeFacts, 'objects' | 'leftOut'>): boolean {
  return (
    answer.objects.some((object) => object.access === 'object' || object.access === 'parent') ||
    answer.leftOut.some(leftOutForAccess)
  );
}

/**
 * The least Records at most, `from` or more, a take of a scope whose objects
 * hold `records` is not refused at, as the command line's `--max-total` names
 * it (`holdingLimit` in the extension's take): raised to it, the take keeps
 * every object of as many records or fewer, up to
 * {@link CHECKPOINT_OBJECT_ROWS_MAX}, and their records together are within
 * it. Each limit tried keeps more objects than the one before, so it is tried
 * again with their records until they fit; past
 * {@link CHECKPOINT_OBJECT_ROWS_MAX}, no limit holds them.
 */
export function holdingLimit(records: readonly number[], from: number): number {
  let limit = from;
  for (;;) {
    const held = records
      .filter((count) => count <= Math.min(limit, CHECKPOINT_OBJECT_ROWS_MAX))
      .reduce((total, count) => total + count, 0);
    if (held <= limit) return limit;
    limit = held;
  }
}

/**
 * The Records at most that holds an object a scope left out past its limit,
 * with the rest the take keeps (`limit`), and whether any higher limit holds
 * it too (`orMore`: every object a limit can hold is then kept); `none` when
 * no limit up to {@link CHECKPOINT_OBJECT_ROWS_MAX} holds them. Undefined for
 * an object left out otherwise. "Records at most set to 3,542 or more holds
 * it" was said of the contacts of an org, by their own count: raised so, the
 * take kept their account relations too and was refused for all of them.
 */
export function limitHoldingOf(
  answer: Pick<ScopeFacts, 'objects' | 'leftOut'>,
  object: Pick<CheckpointLeftOutObject, 'code' | 'records'>,
): { limit: number; orMore: boolean } | 'none' | undefined {
  if (
    object.code !== 'pastTheLimit' ||
    object.records === undefined ||
    object.records > CHECKPOINT_OBJECT_ROWS_MAX
  ) {
    return undefined;
  }
  const scoped = [
    ...answer.objects.map((kept) => kept.records),
    ...answer.leftOut.flatMap(({ code, records }) =>
      code === 'pastTheLimit' && records !== undefined ? [records] : [],
    ),
  ];
  const limit = holdingLimit(scoped, object.records);
  if (limit > CHECKPOINT_OBJECT_ROWS_MAX) return 'none';
  const whole = scoped
    .filter((records) => records <= CHECKPOINT_OBJECT_ROWS_MAX)
    .reduce((total, records) => total + records, 0);
  return { limit, orMore: limit === whole };
}

/**
 * Whether a checkpoint was taken by a user without View All Data and Modify
 * All Data, each of its objects held with View All and Modify All on it, or
 * on what it hangs from: the file says it of its user.
 */
export function takenPerObject(checkpoint: Pick<OrgCheckpoint, 'takenBy'>): boolean {
  return !checkpoint.takenBy.viewAllData || !checkpoint.takenBy.modifyAllData;
}

/**
 * An estimate of time as it is worth saying: to ten seconds under a minute,
 * to the minute above. "About 1min 4s" says more than an estimate knows.
 */
export function roughSeconds(seconds: number): number {
  if (seconds < 60) return Math.max(10, Math.round(seconds / 10) * 10);
  return Math.round(seconds / 60) * 60;
}

/** Longest a name may be: the store's limit (`checkpointNameSchema`). */
export const CHECKPOINT_NAME_MAX = 120;

/**
 * Whether `name` is one a checkpoint may be called: one line of text, not
 * blank, at most {@link CHECKPOINT_NAME_MAX} characters once trimmed — the rule the
 * extension holds a take and a rename to (`checkpointNameSchema`), said here
 * before the request goes rather than as its refusal. The schema itself is
 * not imported: it would bring zod to a page that checks nothing else.
 */
export function isCheckpointName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= CHECKPOINT_NAME_MAX && !/\p{Cc}/u.test(trimmed);
}
