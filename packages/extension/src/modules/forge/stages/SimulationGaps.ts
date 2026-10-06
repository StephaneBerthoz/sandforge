/**
 * What a simulation finds the target would refuse or change in the rows a
 * real run would write, row by row, once they went through every stage a real
 * run puts them through: the gaps of `ForgeExecutionResult.gaps`.
 *
 * A gap is about the target and a field, never about a record: it carries a
 * picklist value, a currency code or a record type's name at most, otherwise
 * lengths and counts. The rows it touches are counted; which rows, and what
 * they hold, stay out of it.
 */

import type {
  ForgeGap,
  ForgeGapDecisionKind,
  ForgeGapKind,
  ForgeGapSeverity,
} from '@sandforge/shared';
import { forgeGapId, mergeGaps } from '@sandforge/shared';
import type { FieldInfo } from '../ForgeExecutor.js';
import { allowsControllingValue } from '../describeBounds.js';
import { isPersonAccountRow } from '../../../core/common/platformRecords.js';
import type { PicklistChange, PicklistField } from './RecordTypePicklists.js';

/** A gap as a detector finds it: its id and source are the collector's to give. */
export type FoundGap = Omit<ForgeGap, 'id' | 'source'>;

/**
 * What the user may decide about each kind of gap a simulation finds, in the
 * order offered — only what the run's config can hold and the run applies.
 * Holding back the rows (`skip_rows`) is offered where they are exactly those
 * holding the gap's value (`RunDecisions.SKIPPABLE_GAP_KINDS`); a picklist
 * value refused by its controlling value is not such a gap
 * ({@link picklistGapsOf}).
 */
export const SIMULATION_DECISIONS: Readonly<Partial<Record<ForgeGapKind, ForgeGapDecisionKind[]>>> =
  {
    picklist_value_refused: ['map_value', 'leave_empty', 'skip_rows', 'exclude_object', 'ignore'],
    dependent_value_invalid: ['map_value', 'leave_empty', 'exclude_object', 'ignore'],
    picklist_value_absent: ['map_value', 'skip_rows', 'ignore'],
    required_field_missing: ['set_default', 'exclude_object', 'ignore'],
    value_too_long: ['truncate', 'exclude_object', 'ignore'],
    number_out_of_range: ['exclude_object', 'ignore'],
    record_type_unmapped: ['map_record_type', 'exclude_object', 'ignore'],
    record_type_unavailable: ['map_record_type', 'exclude_object', 'ignore'],
    currency_inactive: ['map_value', 'skip_rows', 'exclude_object', 'ignore'],
    unique_value_collision: ['exclude_object', 'ignore'],
  };

/** The decisions of a kind, as a gap carries them. */
function decisionsOf(kind: ForgeGapKind): ForgeGapDecisionKind[] {
  return [...(SIMULATION_DECISIONS[kind] ?? ['ignore'])];
}

/** The most values a gap's detail lists: a picklist can hold hundreds. */
const LISTED_VALUES = 100;

/** Detail entries the collector keeps the largest of, rather than the first. */
const LARGEST_KEPT: ReadonlySet<string> = new Set(['longest', 'colliding']);

/**
 * The gaps of a simulation, each once however many rows found it: rows added
 * up, the detail of the first row kept — save the largest length met.
 */
export class SimulationGaps {
  private readonly gaps = new Map<string, ForgeGap>();

  /** How many gaps were found. */
  get size(): number {
    return this.gaps.size;
  }

  /** Count a gap found, on `found.rows` rows. */
  add(found: FoundGap): void {
    const id = forgeGapId(
      found.kind,
      found.objectApiName,
      found.field,
      found.recordType,
      found.value,
    );
    const known = this.gaps.get(id);
    if (!known) {
      this.gaps.set(id, { ...found, id, source: 'simulation', decisions: [...found.decisions] });
      return;
    }
    known.rows += found.rows;
    // Rows held back by the value alone hold back the rows of every reason
    // the gap was found for: one row whose controlling value refused it, and
    // the value is no longer one whose rows are all refused.
    if (!found.decisions.includes('skip_rows')) {
      known.decisions = known.decisions.filter((kind) => kind !== 'skip_rows');
    }
    const detail = { ...(found.detail ?? {}), ...(known.detail ?? {}) };
    for (const key of LARGEST_KEPT) {
      const was = known.detail?.[key];
      const now = found.detail?.[key];
      if (typeof was === 'number' && typeof now === 'number') detail[key] = Math.max(was, now);
    }
    known.detail = detail;
  }

  /**
   * Every gap found, gravest first, those the user chose to leave as they are
   * marked so in their detail: reported still, never applied.
   */
  list(ignored: ReadonlySet<string>): ForgeGap[] {
    const gaps = [...this.gaps.values()].map((gap) =>
      ignored.has(gap.id) ? { ...gap, detail: { ...(gap.detail ?? {}), ignored: true } } : gap,
    );
    return mergeGaps(gaps);
  }
}

/** A list of values as a gap's detail lists them: sorted, at most {@link LISTED_VALUES}. */
function listed(values: Iterable<string>): string[] {
  return [...new Set(values)].sort().slice(0, LISTED_VALUES);
}

/**
 * The gaps the picklist check of one row found: a value the target, or the
 * row's record type there, or its controlling value, would refuse, and what
 * the run writes instead — the record type's default, the first value it
 * allows, or nothing. The currency code is left out: its own check says it
 * (`currencyGapOf`).
 *
 * @param allowedOf - The values the target allows of a field, for the row's
 *   record type when it was read.
 */
export function picklistGapsOf(
  objectApiName: string,
  changes: readonly PicklistChange[],
  allowedOf: (change: PicklistChange) => readonly string[] | undefined,
): FoundGap[] {
  const found: FoundGap[] = [];
  for (const change of changes) {
    if (change.field === CURRENCY_FIELD) continue;
    const allowed = allowedOf(change);
    for (const value of change.values) {
      found.push({
        kind: 'picklist_value_refused',
        severity: 'warning',
        objectApiName,
        field: change.field,
        ...(change.recordType !== undefined ? { recordType: change.recordType } : {}),
        value,
        rows: 1,
        detail: {
          reason: change.reason,
          ...(allowed ? { allowed: listed(allowed) } : {}),
          ...(change.controllingField ? { controllingField: change.controllingField } : {}),
          ...(change.replacedBy !== undefined ? { replacement: change.replacedBy } : {}),
        },
        // Refused by its controlling value, the value goes in on the rows
        // whose controlling value allows it: holding back every row holding
        // it would take those too.
        decisions: decisionsOf('picklist_value_refused').filter(
          (kind) => kind !== 'skip_rows' || change.reason !== 'controlling-value',
        ),
        defaultDecision: change.replacedBy !== undefined ? 'map_value' : 'leave_empty',
      });
    }
  }
  return found;
}

/** The field a record's currency is held in, in an org with several. */
export const CURRENCY_FIELD = 'CurrencyIsoCode';

/** One row about to be written, as the row checks read it. */
export interface RowToCheck {
  /** What is sent: cleaned, mapped, anonymized, cut. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** The row as it was read. */
  readonly source: Readonly<Record<string, unknown>>;
  /** Whether its record type's picklist values were read, and its dependent values checked against them. */
  readonly typed: boolean;
}

/** What {@link rowGapsOf} checks the rows of one object against. */
export interface RowChecksInput {
  readonly objectApiName: string;
  readonly rows: readonly RowToCheck[];
  /** The target's describe of the object. */
  readonly targetFields: readonly FieldInfo[];
  /** The active values of each picklist field in the target. */
  readonly picklistValuesByField: ReadonlyMap<string, ReadonlySet<string>> | null;
  /** The target's picklist fields. */
  readonly picklistFields: ReadonlyMap<string, PicklistField>;
}

/** Field types whose values are texts bound by the field's length. */
const TEXT_TYPES: ReadonlySet<string> = new Set([
  'string',
  'textarea',
  'email',
  'phone',
  'url',
  'encryptedstring',
]);

/** Field types whose values are numbers bound by precision and scale. */
const DECIMAL_TYPES: ReadonlySet<string> = new Set(['double', 'currency', 'percent']);

/** Whether a row leaves a field empty. */
function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * Whether the target requires a field at insert and gives it no value of its
 * own: it may not be empty, a write can set it, the platform fills nothing in,
 * and it is no checkbox, which is never empty.
 */
function requiredInTarget(field: FieldInfo): boolean {
  return (
    field.createable &&
    field.nillable === false &&
    field.defaultedOnCreate !== true &&
    field.calculated !== true &&
    field.type !== 'boolean'
  );
}

/**
 * Whether a person account leaves a required field to the platform: its name,
 * computed from its first and last names.
 */
function filledForPersons(
  objectApiName: string,
  field: string,
  source: Readonly<Record<string, unknown>>,
): boolean {
  return objectApiName === 'Account' && field === 'Name' && isPersonAccountRow(source);
}

/** A number's value, read as a payload holds it: a number, or a numeric text. */
function numberOf(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The digits before the point a numeric field holds: its precision less its
 * scale, or an integer's digits. Undefined when the describe says neither.
 */
function integerDigitsOf(field: FieldInfo): number | undefined {
  if (field.type === 'int' && field.digits !== undefined) return field.digits;
  if (field.precision === undefined) return undefined;
  return field.precision - (field.scale ?? 0);
}

/** A controlling value as a dependent's `validFor` indexes it, or -1 when the field holds none of them. */
function controllingIndex(controller: FieldInfo | undefined, value: unknown): number {
  if (!controller) return -1;
  if (controller.type === 'boolean') {
    if (value === true || value === 'true') return 1;
    if (value === false || value === 'false') return 0;
    return -1;
  }
  if (typeof value !== 'string' || value === '') return -1;
  return (controller.controllingValues ?? []).indexOf(value);
}

/**
 * The gaps the rows of one object hold against the target's describe, about
 * to be written:
 *
 * - a field the target requires and gives no value of its own, absent or
 *   empty in the row — a field only the target has, or one the source leaves
 *   empty (`required_field_missing`);
 * - a text longer than its field (`value_too_long`), its length and the
 *   longest met said, never the text;
 * - a number with more digits before its point than its field holds
 *   (`number_out_of_range`): the target refuses it, where it rounds decimals;
 * - a value of a picklist the target takes any value of, that its list does
 *   not hold: kept, it goes in as an inactive value (`picklist_value_absent`);
 * - a dependent value its controlling value does not allow, by the describe's
 *   `validFor`, for a row whose record type's values were not read — those
 *   were checked against them (`dependent_value_invalid`).
 */
export function rowGapsOf(input: RowChecksInput, gaps: SimulationGaps): void {
  const { objectApiName, rows, targetFields, picklistValuesByField, picklistFields } = input;
  const byName = new Map(targetFields.map((field) => [field.name, field]));
  const required = targetFields.filter(requiredInTarget);
  const texts = targetFields.filter(
    (f) => f.createable && TEXT_TYPES.has(f.type ?? '') && (f.length ?? 0) > 0,
  );
  const numbers = targetFields.filter(
    (f) =>
      f.createable &&
      (DECIMAL_TYPES.has(f.type ?? '') || f.type === 'int') &&
      integerDigitsOf(f) !== undefined,
  );
  const anyValue = [...picklistFields].filter(
    ([name, info]) => info.anyValue === true && picklistValuesByField?.has(name) === true,
  );
  const dependents = targetFields.filter(
    (f) => f.createable && f.controllerName !== undefined && f.validFor !== undefined,
  );

  for (const { payload, source, typed } of rows) {
    for (const field of required) {
      if (!isEmpty(payload[field.name]) || filledForPersons(objectApiName, field.name, source)) {
        continue;
      }
      gaps.add({
        kind: 'required_field_missing',
        severity: 'blocking',
        objectApiName,
        field: field.name,
        rows: 1,
        ...(field.type ? { detail: { type: field.type } } : {}),
        decisions: decisionsOf('required_field_missing'),
      });
    }
    for (const field of texts) {
      const value = payload[field.name];
      const length = field.length ?? 0;
      if (typeof value !== 'string' || value.length <= length) continue;
      gaps.add({
        kind: 'value_too_long',
        severity: 'blocking',
        objectApiName,
        field: field.name,
        rows: 1,
        detail: { length, longest: value.length },
        decisions: decisionsOf('value_too_long'),
      });
    }
    for (const field of numbers) {
      const value = numberOf(payload[field.name]);
      const digits = integerDigitsOf(field);
      if (value === undefined || digits === undefined) continue;
      if (Math.abs(Math.trunc(value)) < 10 ** digits) continue;
      gaps.add({
        kind: 'number_out_of_range',
        severity: 'blocking',
        objectApiName,
        field: field.name,
        rows: 1,
        detail: {
          ...(field.precision !== undefined ? { precision: field.precision } : {}),
          ...(field.scale !== undefined ? { scale: field.scale } : {}),
          ...(field.type === 'int' && field.digits !== undefined ? { digits: field.digits } : {}),
        },
        decisions: decisionsOf('number_out_of_range'),
      });
    }
    for (const [name, info] of anyValue) {
      const value = payload[name];
      if (typeof value !== 'string' || value === '') continue;
      const known = picklistValuesByField?.get(name);
      const parts = info.multi ? value.split(';') : [value];
      for (const part of new Set(parts)) {
        if (known?.has(part)) continue;
        gaps.add({
          kind: 'picklist_value_absent',
          severity: 'info',
          objectApiName,
          field: name,
          value: part,
          rows: 1,
          decisions: decisionsOf('picklist_value_absent'),
        });
      }
    }
    if (typed) continue;
    for (const field of dependents) {
      const value = payload[field.name];
      if (typeof value !== 'string' || value === '') continue;
      const controller = byName.get(field.controllerName ?? '');
      const index = controllingIndex(controller, payload[field.controllerName ?? '']);
      const restricted = picklistFields.get(field.name)?.restricted === true;
      const parts = picklistFields.get(field.name)?.multi ? value.split(';') : [value];
      for (const part of new Set(parts)) {
        const validFor = field.validFor?.[part];
        // A value the describe gives no bits for is not one of the field's:
        // the picklist check says it.
        if (validFor === undefined) continue;
        if (index >= 0 && allowsControllingValue(validFor, index)) continue;
        gaps.add({
          kind: 'dependent_value_invalid',
          severity: restricted ? 'blocking' : 'warning',
          objectApiName,
          field: field.name,
          value: part,
          rows: 1,
          detail: {
            controllingField: field.controllerName ?? '',
            allowed: listed(
              (controller?.controllingValues ?? []).filter((_, i) =>
                allowsControllingValue(validFor, i),
              ),
            ),
          },
          decisions: decisionsOf('dependent_value_invalid'),
        });
      }
    }
  }
}

/**
 * The gap of a currency code the target does not hold active, counted on the
 * rows that carry it: written without it, a record takes the running user's
 * currency, its amounts kept as they are.
 */
export function currencyGapOf(objectApiName: string, code: string, rows: number): FoundGap {
  return {
    kind: 'currency_inactive',
    severity: 'blocking',
    objectApiName,
    field: CURRENCY_FIELD,
    value: code,
    rows,
    decisions: decisionsOf('currency_inactive'),
    defaultDecision: 'leave_empty',
  };
}

/**
 * The gap of a unique field whose values the target already holds, on as many
 * rows: it refuses each of them as a duplicate.
 *
 * @param colliding - How many distinct values the target already holds.
 */
export function uniqueCollisionGapOf(
  objectApiName: string,
  field: string,
  rows: number,
  colliding: number,
): FoundGap {
  return {
    kind: 'unique_value_collision',
    severity: 'blocking',
    objectApiName,
    field,
    rows,
    detail: { colliding },
    decisions: decisionsOf('unique_value_collision'),
  };
}

/**
 * The gap of a record type a row goes in with: one the target does not have
 * under the source's name (`record_type_unmapped`), or one the user the run
 * writes as may not use there (`record_type_unavailable`), with the target's
 * record types that user may map it to.
 *
 * @param name - The source record type's name for one unmapped, the target's
 *   for one unavailable.
 */
export function recordTypeGapOf(
  kind: 'record_type_unmapped' | 'record_type_unavailable',
  objectApiName: string,
  name: string,
  rows: number,
  mapTo: readonly string[],
): FoundGap {
  const severity: ForgeGapSeverity = 'blocking';
  return {
    kind,
    severity,
    objectApiName,
    field: 'RecordTypeId',
    ...(kind === 'record_type_unavailable' ? { recordType: name } : { value: name }),
    rows,
    detail: { mapTo: listed(mapTo) },
    decisions: decisionsOf(kind),
  };
}
