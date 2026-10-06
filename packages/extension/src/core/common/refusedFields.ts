/**
 * The fields a target refused a row on, and the row written again without
 * them.
 *
 * A target refuses a row on fields it names for reasons no read before the
 * write tells: a validation rule of its own (`FIELD_CUSTOM_VALIDATION_EXCEPTION`)
 * — a phone it wants in another format — a restricted picklist that does not
 * take the row's value (`INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST`): one the
 * field does not hold, one its controlling value does not allow, or one the
 * record type the row goes in with does not take — and the lookup filter of a
 * lookup, which does not take the record the row names
 * (`FIELD_FILTER_VALIDATION_EXCEPTION`). The picklist's refusal gets past the
 * check a copy makes before the write: that check keeps a value the target's
 * describe lists, and one the UI API says the record type takes, and a record
 * type never given values of the field takes none of them while the UI API
 * answers them all. A real run was refused so on every row of an object, and
 * what hung from those rows failed with them. The refusal tells; written again
 * without the fields it named, the row goes in, short of a value.
 *
 * Forge's batch writer and Frozen's loader decide alike which fields a row goes
 * again without, and count alike the rows that went in so. A lookup is left
 * out only by a caller that knows which lookups the target lets be empty:
 * Frozen's loader passes none, and a lookup filter's refusal leaves its row
 * failed there.
 */

import type { ForgeFieldRefusal, ForgeRefusedField } from '@sandforge/shared';
import { codeAndMessage, type SaveErrorDetail } from './existingRecordMatch.js';

/**
 * The code a validation rule of the target refuses a row with. A trigger that
 * puts an error on one of the row's fields is reported with it too, and is the
 * same refusal of that field.
 */
const VALIDATION_RULE_REFUSAL = 'FIELD_CUSTOM_VALIDATION_EXCEPTION';

/**
 * The code a restricted picklist of the target refuses a value with: one the
 * field does not hold, one the record type the row goes in with does not take,
 * or one its controlling value does not allow.
 */
export const RESTRICTED_PICKLIST_REFUSAL = 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST';

/**
 * The code a lookup filter of the target refuses a row with: the record its
 * lookup names does not meet the filter — an account of another type, a user
 * of another profile. Left out, the lookup leaves the row without that
 * relation, which only a lookup the target lets be empty takes: one it
 * requires would have the row refused again for want of it
 * (`REQUIRED_FIELD_MISSING`).
 */
export const LOOKUP_FILTER_REFUSAL = 'FIELD_FILTER_VALIDATION_EXCEPTION';

/** What refused a row on the fields its error named, by the code it refused with. */
const REFUSED_BY: ReadonlyMap<string, ForgeFieldRefusal> = new Map([
  [VALIDATION_RULE_REFUSAL, 'validation-rule'],
  [RESTRICTED_PICKLIST_REFUSAL, 'restricted-picklist'],
  [LOOKUP_FILTER_REFUSAL, 'lookup-filter'],
]);

/** A field a row goes without, what refused it, and the refusal that named it. */
export type FieldToLeaveOut = Omit<ForgeRefusedField, 'rows' | 'refusedBy'> & {
  readonly refusedBy: ForgeFieldRefusal;
};

/**
 * Rows written without the fields the target refused them on: how many, and
 * each field left out with what refused it, the refusal that named it and how
 * many of them went without it.
 */
export interface WrittenWithoutFields<F extends ForgeRefusedField = ForgeRefusedField> {
  rows: number;
  fields: F[];
}

/** Whether a payload gives a field a value: leaving out one it gives none changes nothing. */
function holdsValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

/**
 * The key of `payload` the platform named, when the payload gives it a value.
 * An API name ignores case, and a payload built from the source's describe
 * need not spell a field as the target's names it.
 */
export function heldKeyOf(payload: Record<string, unknown>, named: string): string | undefined {
  const wanted = named.toLowerCase();
  return Object.keys(payload).find(
    (key) => key.toLowerCase() === wanted && holdsValue(payload[key]),
  );
}

/**
 * The fields to write a refused row again without, each with what refused it
 * and the refusal that named it: only when every error of the refusal is a
 * validation rule's, a restricted picklist's or a lookup filter's, and each
 * names a field the row gives a value to — for a lookup filter, a lookup the
 * target lets be empty; a refusal that holds several leaves out every field
 * they name. Nothing otherwise — an error that names no field, or only fields
 * the row leaves empty, would refuse the row again whatever went, as any other
 * error would, and so would a lookup the target requires, left out.
 *
 * A row holding two values a restricted picklist refuses is refused for the
 * first alone: run against a real target, the refusal named one field of the
 * two. Written again without it, the row is refused for the second.
 *
 * @param details - Every error the target refused the row with.
 * @param keep - A field the row cannot go without: the external id an upsert matches it by.
 * @param mayBeEmpty - Whether the target lets a row leave a field empty, by
 *   the payload's name for it: what says a lookup a filter refused can be left
 *   out. Without it, none is.
 */
export function refusedFields(
  details: readonly SaveErrorDetail[] | undefined,
  payload: Record<string, unknown>,
  keep: string | undefined,
  mayBeEmpty?: (field: string) => boolean,
): FieldToLeaveOut[] | undefined {
  if (!details || details.length === 0) return undefined;
  const leftOut = new Map<string, FieldToLeaveOut>();
  for (const detail of details) {
    const refusedBy = REFUSED_BY.get(detail.statusCode);
    if (!refusedBy) return undefined;
    const held = detail.fields
      .map((named) => heldKeyOf(payload, named))
      .filter(
        (key): key is string => key !== undefined && key.toLowerCase() !== keep?.toLowerCase(),
      );
    if (held.length === 0) return undefined;
    if (refusedBy === 'lookup-filter' && !held.every((field) => mayBeEmpty?.(field) === true)) {
      return undefined;
    }
    for (const field of held) {
      if (!leftOut.has(field)) {
        leftOut.set(field, { field, refusedBy, reason: codeAndMessage(detail) });
      }
    }
  }
  return [...leftOut.values()];
}

/**
 * Whether the target refused a row with a validation rule's code on no field:
 * a rule that puts its error on the record, or a trigger that does, with the
 * same code. Such an error names nothing the row could go without, and the
 * row is not sent again for it.
 */
export function refusedOnNoField(details: readonly SaveErrorDetail[] | undefined): boolean {
  return (details ?? []).some(
    (detail) => detail.statusCode === VALIDATION_RULE_REFUSAL && detail.fields.length === 0,
  );
}

/** `payload` without the fields of `leftOut`, the payload itself left as it was. */
export function without(
  payload: Record<string, unknown>,
  leftOut: ReadonlyArray<Pick<FieldToLeaveOut, 'field'>>,
): Record<string, unknown> {
  const fields = new Set(leftOut.map((f) => f.field));
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !fields.has(key)));
}

/**
 * `from` added to `into`, which is changed in place — or made, when there is
 * none: a field left out for the same refusal is counted once, with the rows
 * of both.
 */
export function addWrittenWithoutFields<F extends ForgeRefusedField>(
  into: WrittenWithoutFields<F> | undefined,
  from: WrittenWithoutFields<F>,
): WrittenWithoutFields<F> {
  const sum = into ?? { rows: 0, fields: [] };
  sum.rows += from.rows;
  for (const field of from.fields) {
    const known = sum.fields.find((f) => f.field === field.field && f.reason === field.reason);
    if (known) known.rows += field.rows;
    else sum.fields.push({ ...field });
  }
  return sum;
}

/** What refused a field rows went without, as a line says it. */
const REFUSED_IT: Readonly<Record<ForgeFieldRefusal, string>> = {
  'validation-rule': 'a validation rule of the target refused it',
  'restricted-picklist': 'a restricted picklist of the target refused its value',
  'lookup-filter': 'a lookup filter of the target refused the record it names',
};

/**
 * What a line says of the rows written without the fields the target refused
 * them on: each field, how many rows went without it, what refused it and in
 * what words — or, for one a declared rule gave another value
 * (`replacedWith`), which value they went in with. Empty when none did. A
 * field recorded before a picklist's refusal was written again is a
 * validation rule's.
 */
export function writtenWithoutFieldsNote(
  written: WrittenWithoutFields<ForgeRefusedField & { replacedWith?: string }> | undefined,
): string {
  return (written?.fields ?? [])
    .map(({ field, refusedBy = 'validation-rule', reason, rows, replacedWith }) => {
      const how =
        replacedWith === undefined
          ? `written without ${field}`
          : `written with ${field} set to "${replacedWith}"`;
      return `, ${rows} ${how}: ${REFUSED_IT[refusedBy]}, ${reason}`;
    })
    .join('');
}
