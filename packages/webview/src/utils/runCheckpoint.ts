import type { RunCheckpointEstimate, RunCheckpointInfo } from '@sandforge/shared';

/** Whether `value` is a list of objects, each named with why. */
function notesIn(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (note: unknown) =>
        typeof note === 'object' &&
        note !== null &&
        typeof (note as Record<string, unknown>).objectApiName === 'string' &&
        typeof (note as Record<string, unknown>).reason === 'string',
    )
  );
}

/**
 * The checkpoint a run's answer says it took before its first write, read as
 * the untrusted field of a message it is: an error's payload carries it
 * beside its words when the run stopped once the take was through — its
 * mute refused, its Stop before its first write — and a page that showed the
 * error alone said nothing of a checkpoint deleted, or of one kept for what
 * the run wrote before it failed. Undefined for anything else, a simulation's
 * estimate among them.
 */
export function runCheckpointOf(value: unknown): RunCheckpointInfo | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const field = value as Record<string, unknown>;
  if (field.state === 'deleted') return { state: 'deleted', deleted: 'nothingWritten' };
  if (
    field.state === 'taken' &&
    typeof field.checkpointId === 'string' &&
    field.checkpointId !== '' &&
    typeof field.name === 'string' &&
    typeof field.takenAt === 'string' &&
    (field.expiresAt === null || typeof field.expiresAt === 'string') &&
    Array.isArray(field.objects) &&
    field.objects.every((name) => typeof name === 'string') &&
    typeof field.records === 'number' &&
    notesIn(field.notHeld) &&
    notesIn(field.added)
  ) {
    return value as RunCheckpointInfo;
  }
  return undefined;
}

/**
 * The checkpoint a run's result names, taken or deleted, or undefined: a
 * simulation's result says what one would hold and cost instead
 * ({@link runCheckpointEstimateOf}).
 */
export function takenOrDeleted(
  checkpoint: RunCheckpointInfo | RunCheckpointEstimate | undefined,
): RunCheckpointInfo | undefined {
  return checkpoint === undefined || checkpoint.state === 'planned' ? undefined : checkpoint;
}

/** What a simulation's result says a checkpoint first would hold and cost, or undefined. */
export function runCheckpointEstimateOf(
  checkpoint: RunCheckpointInfo | RunCheckpointEstimate | undefined,
): RunCheckpointEstimate | undefined {
  return checkpoint?.state === 'planned' ? checkpoint : undefined;
}
