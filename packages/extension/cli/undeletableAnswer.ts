/**
 * What a command line answers a removal that finds objects of the run whose
 * records the user it runs as may not delete (`RunRemovalOptions.onUndeletable`):
 * with `--leave-undeletable` the rest is removed and those stay; without it
 * each is named and the removal stops before its first delete. Run as it was,
 * a removal deleted the children, then had every parent refused, and said
 * only what the org said of each.
 */

/** The flag that lets a removal go on without the objects its user may not delete. */
const LEAVE_UNDELETABLE_FLAG = '--leave-undeletable';

/**
 * @param leaveUndeletable - Whether {@link LEAVE_UNDELETABLE_FLAG} was given.
 * @param target - The org, as the command line was given it.
 * @param write - Where the lines go: standard error.
 */
export function undeletableAnswer(
  leaveUndeletable: boolean,
  target: string,
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): (objects: ReadonlyArray<{ objectApiName: string; records: number }>) => Promise<boolean> {
  return async (objects) => {
    const named = objects.map((o) => `${o.objectApiName} (${o.records} records)`).join(', ');
    write(`The user SandForge connects as may not delete the records of ${named} in ${target}.`);
    if (leaveUndeletable) {
      write(
        `Those stay, with the records they hang from; the rest is removed (${LEAVE_UNDELETABLE_FLAG}).`,
      );
      return true;
    }
    write(
      'Nothing was removed. Give that user Delete on those objects, or run again with ' +
        `${LEAVE_UNDELETABLE_FLAG} to remove the rest and leave them.`,
    );
    return false;
  };
}
