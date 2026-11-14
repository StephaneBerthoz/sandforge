/**
 * The statements of a run in slices: the read of one slice, the counts of
 * the rows created during the run that no slice holds, and the read of such
 * rows in a range a slice already masked.
 *
 * A slice is the first rows past the last one of the slice before, by Id,
 * under the run's filter: `Id > '<start>' ORDER BY Id LIMIT <size>`. Its end
 * is the last row its snapshot holds, which the next slice starts past, so
 * two slices never share a row and none is skipped between them. Its bounds
 * are found by reading, never by counting: a COUNT over a large table runs
 * out of time, and millions of rows share one CreatedDate.
 */

import { assertSoqlIdentifier, assertSoqlWhere } from '../../../core/common/soqlValidator.js';
import { soqlDateTimeOf } from '../../sync/SyncDelta.js';

/** A record id, 15 or 18 letters and digits: what goes into a statement as it is. */
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** What holds the rows of a slice, beside the run's filter. */
export interface SliceBounds {
  /** The last row of the slice before: the slice holds the rows past it. Absent for the first. */
  afterId?: string;
  /** The last row the range holds: set for a slice of late rows, in a range already masked. */
  untilId?: string;
  /** Only the rows created since: a slice of late rows. As the org's clock gave it. */
  createdSince?: string;
}

/** A record id checked to go into a statement as it is. */
function checkedId(id: string): string {
  if (!RECORD_ID.test(id)) throw new Error(`Not a record id: "${id}".`);
  return id;
}

/**
 * The conditions a slice's rows meet: the run's filter, in parentheses so
 * that an `OR` in it reaches nothing else; created since a moment, for late
 * rows; and between its bounds by Id.
 *
 * @throws When the filter does more than filter, or a bound is not an id.
 */
export function sliceConditions(where: string | undefined, bounds: SliceBounds): string[] {
  const filter = where?.trim();
  return [
    ...(filter ? [`(${assertSoqlWhere(filter)})`] : []),
    ...(bounds.createdSince !== undefined
      ? [`CreatedDate >= ${soqlDateTimeOf(bounds.createdSince)}`]
      : []),
    ...(bounds.afterId !== undefined ? [`Id > '${checkedId(bounds.afterId)}'`] : []),
    ...(bounds.untilId !== undefined ? [`Id <= '${checkedId(bounds.untilId)}'`] : []),
  ];
}

/** The WHERE of {@link sliceConditions}, or nothing for none. */
function whereOf(conditions: readonly string[]): string {
  return conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`;
}

/**
 * The read of one slice: its fields, its rows by Id, as many as a slice
 * holds.
 *
 * @param select - The fields read, each a field's name, comma separated.
 * @param size - Rows the slice holds at most.
 * @throws When the object, the filter or a bound is not what it should be.
 */
export function sliceStatement(
  objectApiName: string,
  select: string,
  where: string | undefined,
  bounds: SliceBounds,
  size: number,
): string {
  if (!Number.isInteger(size) || size <= 0) throw new Error(`Not a slice size: ${size}.`);
  return (
    `SELECT ${select} FROM ${assertSoqlIdentifier(objectApiName)}` +
    `${whereOf(sliceConditions(where, bounds))} ORDER BY Id LIMIT ${size}`
  );
}

/**
 * The count of the rows under the run's filter created since `since` in a
 * range by Id: every range a slice masked, `untilId` the end of the last; or
 * one slice's.
 */
export function lateCountStatement(
  objectApiName: string,
  where: string | undefined,
  since: string,
  range: { afterId?: string; untilId: string },
): string {
  return (
    `SELECT COUNT() FROM ${assertSoqlIdentifier(objectApiName)}` +
    whereOf(sliceConditions(where, { ...range, createdSince: since }))
  );
}

/** The count of the rows under the run's filter past the last slice's end: none was read into a slice. */
export function tailCountStatement(
  objectApiName: string,
  where: string | undefined,
  afterId: string,
): string {
  return (
    `SELECT COUNT() FROM ${assertSoqlIdentifier(objectApiName)}` +
    whereOf(sliceConditions(where, { afterId }))
  );
}
