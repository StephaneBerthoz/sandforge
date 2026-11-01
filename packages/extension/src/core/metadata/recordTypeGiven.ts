/**
 * The record type an org gives a record created without one, for the user
 * who writes it, as that user's describe of the object tells it.
 *
 * Every module writes a record held on Master in the source without a
 * `RecordTypeId`, and lets the target give it its type. Which one was read
 * from `defaultRecordTypeMapping` alone, and was wrong: on a scratch org whose
 * admin had Master for default and one other Opportunity type open, an
 * Opportunity created without a type went in with that other type, by Apex
 * and by Bulk alike, while the describe named Master. The probes of
 * that org and its source settled the rule, every branch of it:
 *
 * - the describe names a default that is not Master: that default (the
 *   profile's, as an Account went in as Business_Account);
 * - it names Master, and the user can use no other type: Master;
 * - it names Master, and exactly one other type is open: that one;
 * - it names Master, and two or more are open: Master — what an insert gave
 *   with three open, and with two once a permission set opened a second.
 *
 * Open is what the user can create records of: available, active, not
 * Master. A fresh describe after a permission set is assigned already says
 * what the assignment opened, conditional or not, so a run that assigns
 * reads it again before its first write and needs nothing else.
 */

import type { RecordTypeGivenBasis, RecordTypeNamed } from '@sandforge/shared';
import type { RecordTypeAvailability } from './recordTypeAvailability.js';

/**
 * What the target gives a record created without a record type: `master`,
 * nothing to say — the object has no other type, or the platform keeps
 * Master —; `given`, that type, and why.
 */
export type GivenRecordType =
  { kind: 'master' } | { kind: 'given'; info: RecordTypeAvailability; basis: RecordTypeGivenBasis };

const MASTER: GivenRecordType = { kind: 'master' };

/** Whether the user can create records of the type: available, active, not Master. */
function isOpen(info: RecordTypeAvailability): boolean {
  return info.available && info.active && !info.master;
}

/**
 * The record type the org gives a record of the object created without one,
 * for the user whose describe `infos` are ({@link GivenRecordType}).
 *
 * A default the describe names that the user could not use is no default to
 * give: it is read as Master, and the types open to the user decide.
 *
 * @param infos - `recordTypeInfos` of the target's describe, as `parseRecordTypeInfos` reads them.
 */
export function recordTypeGivenOf(infos: readonly RecordTypeAvailability[]): GivenRecordType {
  const byDefault = infos.find((info) => info.defaultRecordTypeMapping);
  if (byDefault && isOpen(byDefault)) {
    return { kind: 'given', info: byDefault, basis: 'userDefault' };
  }
  const open = infos.filter(isOpen);
  if (open.length === 1) return { kind: 'given', info: open[0]!, basis: 'onlyOneOpen' };
  return MASTER;
}

/**
 * What a run's result predicts of the type given, as `RecordTypeGiven.predicted`
 * holds it: the type by its DeveloperName and label, and why; undefined when
 * the org keeps Master, and there is nothing to say.
 */
export function predictedRecordTypeOf(
  given: GivenRecordType,
): (RecordTypeNamed & { basis: RecordTypeGivenBasis }) | undefined {
  if (given.kind === 'master') return undefined;
  return { developerName: given.info.developerName, label: given.info.name, basis: given.basis };
}
