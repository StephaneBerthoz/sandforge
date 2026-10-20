/**
 * The email addresses and phone numbers of the rows a Sync run writes, made
 * unreachable before they go, as Forge makes them (`ContactPointNeutralizer`):
 * every address under `.invalid`, every phone number a fictional one.
 *
 * A Sync copied them as the source held them. Copied into a sandbox whose
 * record-triggered flows email and text the contacts they are written for,
 * the copies were real people, reachable from the sandbox — what Forge
 * stopped doing by default after a clone met such flows in a client's
 * sandbox. A configuration that sets `keepContactPoints` copies them as read.
 */

import type { SyncConfig } from '@sandforge/shared';
import { ContactPointNeutralizer } from '../forge/stages/ContactPointNeutralizer.js';
import type { FieldInfo } from '../forge/ForgeExecutor.js';

/**
 * The neutralizer a run of `config` writes with: one per run, its fictional
 * numbers drawn with a key of its own. None when the configuration keeps the
 * emails and phone numbers as read.
 */
export function contactPointsOfRun(
  config: Pick<SyncConfig, 'keepContactPoints'>,
): ContactPointNeutralizer | undefined {
  return config.keepContactPoints === true ? undefined : new ContactPointNeutralizer();
}

/**
 * Neutralize the contact points of the rows about to be written to an object,
 * in place, and say what was done.
 *
 * The fields are the target's: the rows hold its names once mapped, and what
 * the target makes an email or a phone field is what its automation reads.
 * The field the write matches on is left as read: an upsert by an external id
 * that holds an address would no longer find the copy an earlier run wrote,
 * and would write a second one.
 *
 * @param neutralizer - The run's neutralizer.
 * @param objectApiName - The object written.
 * @param fields - The target's describe of it.
 * @param rows - The payloads the write sends, changed in place.
 * @param matchField - The field the write matches on, when it is not `Id`.
 * @returns The note the object's result says it with; nothing when no value changed.
 */
export function neutralizeSyncRows(
  neutralizer: ContactPointNeutralizer,
  objectApiName: string,
  fields: readonly FieldInfo[],
  rows: Record<string, unknown>[],
  matchField?: string,
): string | undefined {
  const written = matchField ? fields.filter((field) => field.name !== matchField) : fields;
  const neutralize = neutralizer.forObject(objectApiName, written);
  if (!neutralize) return undefined;
  const changed = new Map<string, number>();
  for (const row of rows) {
    const before = { ...row };
    neutralize(row);
    for (const field of Object.keys(before)) {
      if (before[field] !== row[field]) changed.set(field, (changed.get(field) ?? 0) + 1);
    }
  }
  if (changed.size === 0) return undefined;
  const values = [...changed.values()].reduce((sum, count) => sum + count, 0);
  return (
    `${values} email address(es) and phone number(s) of ${objectApiName} neutralized ` +
    `(${[...changed.keys()].join(', ')}): addresses under .invalid, numbers fictional, so the ` +
    "target's automation reaches no one. A configuration that keeps contact points copies them as read."
  );
}
