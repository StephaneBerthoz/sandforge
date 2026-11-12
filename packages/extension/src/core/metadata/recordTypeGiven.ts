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
 *
 * What a run says before it writes is that prediction; what it says once
 * written is what a read of the first records it created found, one request
 * an object, read by every module that writes such records alike.
 */

import * as z from 'zod';
import type { RecordTypeGiven, RecordTypeGivenBasis, RecordTypeNamed } from '@sandforge/shared';
import { assertSoqlIdentifier } from '../common/soqlValidator.js';
import { namesMasterRecordType } from '../../modules/sync/RecordTypeMapper.js';
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

/**
 * The ids a read back of the record types the target gave asks about: the
 * first records of an object the run created, in one request. What a record
 * created without a type gets is one fact of the user and the object for the
 * whole run, the lease holding still as it writes; only the target's
 * automation can set another on some of them, and the first records show it
 * when it does. Read back whole, a large run would send a request per 200
 * of its records again, as many as its writes.
 */
export const RECORD_TYPE_READ_BACK_IDS = 200;

/** A record id as the target answered it, fit to go into a statement as a literal. */
const RECORD_ID = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/;

/**
 * The read of the record types the records `ids` hold in the target, counted
 * by type: one request, the first {@link RECORD_TYPE_READ_BACK_IDS} of them.
 * A record on Master reads an empty `RecordTypeId`.
 */
export function recordTypeReadBackSoql(objectApiName: string, ids: readonly string[]): string {
  const asked = ids
    .filter((id) => RECORD_ID.test(id))
    .slice(0, RECORD_TYPE_READ_BACK_IDS)
    .map((id) => `'${id}'`);
  return (
    `SELECT RecordTypeId, COUNT(Id) n FROM ${assertSoqlIdentifier(objectApiName)} ` +
    `WHERE Id IN (${asked.join(', ')}) GROUP BY RecordTypeId`
  );
}

/** One row of that read, as the org answers it: external input, checked before it is read. */
const readBackRowSchema = z.object({
  RecordTypeId: z.string().nullish(),
  n: z.number().int().nonnegative(),
});

/**
 * What a read back found, from the rows the org answered: per record type,
 * named as the object's describe names it — Master for an empty
 * `RecordTypeId` —, how many of the records read hold it, the most first.
 * Rows the read cannot tell are its failure, said in words.
 *
 * @param types - The object's record types in the target, named.
 */
export function recordTypesReadBack(
  rows: readonly unknown[],
  types: readonly RecordTypeAvailability[],
): NonNullable<RecordTypeGiven['readBack']> {
  const parsed = z.array(readBackRowSchema).safeParse(rows);
  if (!parsed.success) {
    return { read: 0, types: [], unread: 'the org answered rows that name no record type count' };
  }
  const byType = new Map<string, RecordTypeNamed & { rows: number }>();
  for (const { RecordTypeId, n } of parsed.data) {
    const named = recordTypeNamedOf(RecordTypeId ?? null, types);
    const known = byType.get(named.developerName);
    if (known) known.rows += n;
    else byType.set(named.developerName, { ...named, rows: n });
  }
  const found = [...byType.values()].sort((a, b) => b.rows - a.rows);
  return { read: found.reduce((sum, type) => sum + type.rows, 0), types: found };
}

/** A record type read back, by the name its object's describe gives it: its id when the describe has none. */
function recordTypeNamedOf(
  id: string | null,
  types: readonly RecordTypeAvailability[],
): RecordTypeNamed {
  if (id === null || namesMasterRecordType(id)) {
    const master = types.find((type) => type.master);
    return { developerName: master?.developerName ?? 'Master', label: master?.name ?? 'Master' };
  }
  const known = types.find((type) => type.recordTypeId.slice(0, 15) === id.slice(0, 15));
  return known
    ? { developerName: known.developerName, label: known.name }
    : { developerName: id, label: id };
}

/**
 * The id of the record type the target gives a record sent without one, from
 * the describe of the user the run writes as: the type `recordTypeGivenOf`
 * names, or Master's own id when the record stays on it; undefined with no
 * describe, or one that lists no Master.
 */
export function givenRecordTypeId(
  infos: readonly RecordTypeAvailability[] | undefined,
): string | undefined {
  if (!infos) return undefined;
  const given = recordTypeGivenOf(infos);
  return given.kind === 'given'
    ? given.info.recordTypeId
    : infos.find((type) => type.master)?.recordTypeId;
}
