import type {
  CheckpointListEntry,
  CheckpointRefusal,
  CheckpointScopeResponse,
  OrgCheckpoint,
  RewindUndoCannot,
  RewindUndoCannotReason,
} from '@sandforge/shared';

/**
 * Days a checkpoint is kept unless its owner keeps it until they delete it:
 * the store's default (`DEFAULT_KEEP_DAYS` in the extension's
 * OrgCheckpointStore), which the take asks for by number.
 */
export const CHECKPOINT_KEEP_DAYS = 30;

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
