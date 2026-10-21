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

import type { ForgeContactPointsReport, SyncConfig } from '@sandforge/shared';
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
 * What a run's result says of the emails and phone numbers it wrote, as a
 * Forge run's says it (`SyncExecutionResult.contactPoints`): what its
 * neutralizer changed, field by field, or that it kept them as read, as its
 * configuration asked, once it wrote a record. Nothing when it neutralized
 * none, or kept them and wrote nothing.
 *
 * @param neutralizer - The run's neutralizer; none when it keeps them.
 * @param wrote - Whether the run wrote a record.
 */
export function contactPointsOfResult(
  neutralizer: ContactPointNeutralizer | undefined,
  wrote: boolean,
): ForgeContactPointsReport | undefined {
  if (!neutralizer) return wrote ? { neutralized: false, fields: [], values: 0 } : undefined;
  const report = neutralizer.report();
  return report.values > 0 ? report : undefined;
}

/**
 * Neutralize the contact points of the rows about to be written to an object,
 * in place. The neutralizer counts each value it changes, field by field: its
 * `report()` is what the run's result says of them, once for the run, as a
 * Forge run's says it.
 *
 * Each object's result said it in a sentence among its errors, in English
 * whatever the panel's language: every Sync of contacts, which neutralizes by
 * default, showed "1 × 12 email address(es) and phone number(s) of Contact
 * neutralized" in red under a run that had succeeded.
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
 */
export function neutralizeSyncRows(
  neutralizer: ContactPointNeutralizer,
  objectApiName: string,
  fields: readonly FieldInfo[],
  rows: Record<string, unknown>[],
  matchField?: string,
): void {
  const written = matchField ? fields.filter((field) => field.name !== matchField) : fields;
  const neutralize = neutralizer.forObject(objectApiName, written);
  if (!neutralize) return;
  for (const row of rows) neutralize(row);
}
