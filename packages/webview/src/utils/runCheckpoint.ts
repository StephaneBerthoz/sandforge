import {
  panelWordingOf,
  type RunCheckpointEstimate,
  type RunCheckpointInfo,
} from '@sandforge/shared';

/**
 * What refused a checkpoint a run was to take first, by the take's code, in
 * the interface language: the host says it in English, and the page said
 * only that it was refused. A code with no words of its own is said as the
 * take's guards refusing it.
 */
const REFUSAL_KEYS: ReadonlyMap<string, string> = new Map([
  ['DISK', 'errors.checkpointRefused.reason.disk'],
  ['RUN_WRITING', 'errors.checkpointRefused.reason.runWriting'],
  ['NOTHING_HELD', 'errors.checkpointRefused.reason.nothingHeld'],
  ['TOO_MANY_RECORDS', 'errors.checkpointRefused.reason.tooManyRecords'],
  ['API_BUDGET', 'errors.checkpointRefused.reason.apiBudget'],
  ['PERMISSIONS', 'errors.checkpointRefused.reason.permissions'],
  ['PRODUCTION', 'errors.checkpointRefused.reason.production'],
  ['SCRATCH_EXPIRED', 'errors.checkpointRefused.reason.scratchExpired'],
]);

/**
 * Why a checkpoint taken before a run was refused, as a sentence: by the
 * take's own refusal code when the run's stop names one, and as a take that
 * could not be taken when it names none — a take that failed, or a host
 * that did not say.
 *
 * @param reason - The take's `CheckpointRefusalCode`, as the stop carries it.
 * @param t - Translates a key in the interface language.
 */
export function checkpointRefusalWords(
  reason: string | undefined,
  t: (key: string) => string,
): string {
  if (reason === undefined) return t('errors.checkpointRefused.reason.unsaid');
  return t(REFUSAL_KEYS.get(reason) ?? 'errors.checkpointRefused.reason.other');
}

/**
 * The words the panel gives an error by its code (`panelWordingOf`), or
 * undefined for a code it leaves to the host: what happened and what to do,
 * as one text, with what refused the checkpoint of a run stopped for one
 * between the two, which the error carries beside its code. A Sync run, a
 * seed, a CSV import and a clone are refused alike; the host's words are
 * English.
 *
 * @param payload - The error's payload, read for its `checkpointRefusal`.
 * @param t - Translates a key in the interface language.
 */
export function panelRefusalWords(
  code: string | null | undefined,
  payload: Record<string, unknown>,
  t: (key: string) => string,
): string | undefined {
  const worded = panelWordingOf(code);
  if (!worded) return undefined;
  const { checkpointRefusal } = payload;
  const why =
    code === 'CHECKPOINT_REFUSED'
      ? `${checkpointRefusalWords(
          typeof checkpointRefusal === 'string' ? checkpointRefusal : undefined,
          t,
        )} `
      : '';
  return `${t(worded.explanationKey)} ${why}${t(worded.actionKey)}`;
}

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
