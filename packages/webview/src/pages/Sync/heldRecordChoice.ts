import type { SyncConfig, SyncConflictStrategy, SyncOperation } from '@sandforge/shared';

/**
 * Whether a write finds a record the target already holds and writes over
 * it: an upsert by its key, an update by its id. An insert creates a record
 * whatever the target holds, and a delete writes no value.
 */
export function writesOverHeld(operation: SyncOperation): boolean {
  return operation === 'upsert' || operation === 'update';
}

/**
 * The direction and strategy a configuration sends for what the page asks:
 * what to do when the target already holds the record.
 *
 * The page asked for a Direction and a Conflict Strategy side by side.
 * Bidirectional wrote to the target alone, as every run does, after reading
 * the target's records to settle each conflict; on Source to Target, the
 * default, the strategy was never read, so Target Wins did nothing there. The
 * one question left is the one a run acts on, and only where a write finds a
 * held record: overwriting it with the source's values is the plain write,
 * which reads nothing of the target first; the three others need the read.
 *
 * @param choice - What the page asks to do with a record the target holds.
 * @param findsHeld - Whether an object of the run finds one: see {@link writesOverHeld}.
 */
export function runSettingsOf(
  choice: SyncConflictStrategy,
  findsHeld: boolean,
): Pick<SyncConfig, 'direction' | 'conflictStrategy'> {
  if (!findsHeld || choice === 'source_wins') {
    return { direction: 'source_to_target', conflictStrategy: 'source_wins' };
  }
  return { direction: 'bidirectional', conflictStrategy: choice };
}

/**
 * What a configuration's runs did with a record the target already held, as
 * the page names it: its strategy on a bidirectional run, the source's values
 * written over it on any other. Null when no object of it finds one.
 */
export function heldRecordChoiceOf(
  config: Pick<SyncConfig, 'direction' | 'conflictStrategy' | 'objects'>,
): SyncConflictStrategy | null {
  if (!config.objects.some((object) => writesOverHeld(object.operation))) return null;
  return config.direction === 'bidirectional' ? config.conflictStrategy : 'source_wins';
}
