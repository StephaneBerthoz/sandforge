/**
 * What a command line answers a removal that finds objects of the run whose
 * records the user it runs as may not delete (`RunRemovalOptions.onUndeletable`):
 * with `--leave-undeletable` the rest is removed and those stay; without it
 * each is named and the removal stops before its first delete. Run as it was,
 * a removal deleted the children, then had every parent refused, and said
 * only what the org said of each.
 */

import type { RunRefusal } from './runRefused.js';

/** The flag that lets a removal go on without the objects its user may not delete. */
const LEAVE_UNDELETABLE_FLAG = '--leave-undeletable';

/** The code of a removal stopped for objects its user may not delete, the flag not given. */
export const UNDELETABLE_NOT_LEFT = 'UNDELETABLE_NOT_LEFT';

/**
 * Why a removal stops before its first delete for `objects`, whose records
 * the user it runs as may not delete, under its code: the command ends on it
 * as on every refusal before a delete, its line and, with --json, stdout
 * naming the code. Said in two sentences of its own, it had none.
 *
 * @param target - The org, as the command line was given it.
 */
export function undeletableRefusal(
  objects: ReadonlyArray<{ objectApiName: string; records: number }>,
  target: string,
): RunRefusal {
  const named = objects.map((o) => `${o.objectApiName} (${o.records} records)`).join(', ');
  return {
    code: UNDELETABLE_NOT_LEFT,
    message:
      `The user SandForge connects as may not delete the records of ${named} in ${target}. ` +
      'Nothing was removed. Give that user Delete on those objects, or run again with ' +
      `${LEAVE_UNDELETABLE_FLAG} to remove the rest and leave them.`,
  };
}

/**
 * @param leaveUndeletable - Whether {@link LEAVE_UNDELETABLE_FLAG} was given.
 * @param target - The org, as the command line was given it.
 * @param refused - Told why the removal stops, without the flag: the command
 *   ends on it once the removal has given back what it held.
 * @param write - Where the lines go: standard error.
 */
export function undeletableAnswer(
  leaveUndeletable: boolean,
  target: string,
  refused: (refusal: RunRefusal) => void,
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): (objects: ReadonlyArray<{ objectApiName: string; records: number }>) => Promise<boolean> {
  return async (objects) => {
    if (!leaveUndeletable) {
      refused(undeletableRefusal(objects, target));
      return false;
    }
    const named = objects.map((o) => `${o.objectApiName} (${o.records} records)`).join(', ');
    write(`The user SandForge connects as may not delete the records of ${named} in ${target}.`);
    write(
      `Those stay, with the records they hang from; the rest is removed (${LEAVE_UNDELETABLE_FLAG}).`,
    );
    return true;
  };
}
