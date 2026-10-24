import type {
  ForgeGap,
  ForgeGapDecisionKind,
  ForgeGapKind,
  ForgeGapSeverity,
} from '@sandforge/shared';
import { ALREADY_EXISTS_ERROR, forgeGapId, mergeGaps } from '@sandforge/shared';
import type { SaveErrorDetail } from '../../../core/common/existingRecordMatch.js';
import type { RehearsedRow } from './RehearsalWriter.js';

/** The code a save error carries when Salesforce gave none. */
const NO_STATUS_CODE = 'UNKNOWN_ERROR';

/** The code the target refuses a value of a restricted picklist with. */
export const RESTRICTED_PICKLIST_REFUSAL = 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST';

/**
 * Codes whose message repeats the row's value — the text too long, the
 * address, the number, the id — which a gap never carries: the code and the
 * field say it.
 */
const MESSAGE_REPEATS_THE_VALUE: ReadonlySet<string> = new Set([
  'STRING_TOO_LONG',
  'INVALID_EMAIL_ADDRESS',
  'INVALID_TYPE_ON_FIELD_IN_RECORD',
  'NUMBER_OUTSIDE_VALID_RANGE',
  'MALFORMED_ID',
  'INVALID_ID_FIELD',
  'DUPLICATE_VALUE',
]);

/**
 * Codes the run's writer meets by writing the row again without the field
 * they name: a validation rule of the target, a restricted picklist and a
 * lookup filter (`core/common/refusedFields.ts`). The row goes in, short of a
 * value: a warning, not a row lost.
 */
const WRITTEN_AGAIN_WITHOUT_THE_FIELD: ReadonlySet<string> = new Set([
  'FIELD_CUSTOM_VALIDATION_EXCEPTION',
  'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST',
  'FIELD_FILTER_VALIDATION_EXCEPTION',
]);

/**
 * The kind a refusal of a field is, when the simulation and the metadata read
 * report the same thing: its gap then takes that kind's id, and merges with
 * theirs into one line, where the decisions of that kind apply. A refusal
 * that names no field, or whose code says nothing a read before the write
 * could, stays a `rehearsal_refusal`.
 */
const KIND_OF_CODE: ReadonlyMap<
  string,
  { kind: ForgeGapKind; severity: ForgeGapSeverity; decisions: ForgeGapDecisionKind[] }
> = new Map([
  [
    'REQUIRED_FIELD_MISSING',
    {
      kind: 'required_field_missing',
      severity: 'blocking',
      decisions: ['set_default', 'exclude_object'],
    },
  ],
  [
    'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST',
    {
      kind: 'picklist_value_refused',
      severity: 'warning',
      decisions: ['map_value', 'leave_empty', 'ignore'],
    },
  ],
  [
    'STRING_TOO_LONG',
    {
      kind: 'value_too_long',
      severity: 'blocking',
      decisions: ['truncate', 'leave_empty', 'exclude_object'],
    },
  ],
  [
    'NUMBER_OUTSIDE_VALID_RANGE',
    {
      kind: 'number_out_of_range',
      severity: 'blocking',
      decisions: ['leave_empty', 'exclude_object'],
    },
  ],
  [
    // Not a row lost: the run's writer links a row a unique value refuses to
    // the record the refusal names (`existingRecordMatch.ts`). Rehearsed on
    // a live sandbox, the relation a contact's account gets from the platform
    // itself came back refused this way, and the real run linked both rows.
    // A warning, as the simulation gives the same gap.
    'DUPLICATE_VALUE',
    {
      kind: 'unique_value_collision',
      severity: 'warning',
      decisions: ['leave_empty', 'exclude_object', 'ignore'],
    },
  ],
  [
    'FIELD_FILTER_VALIDATION_EXCEPTION',
    { kind: 'lookup_filter', severity: 'warning', decisions: ['leave_empty', 'ignore'] },
  ],
]);

/** A count a gap's detail holds; 0 when it holds none. */
function numberIn(gap: ForgeGap, key: string): number {
  const value = gap.detail?.[key];
  return typeof value === 'number' ? value : 0;
}

/** The fields a gap's detail says its refusals named. */
function fieldsIn(gap: ForgeGap): string[] {
  const value = gap.detail?.['fields'];
  return Array.isArray(value) ? value : [];
}

/**
 * What the target's describe says of a picklist field: its active values,
 * and the field whose value decides which of them a record may hold.
 */
export interface TargetPicklist {
  values: readonly string[];
  controllerName?: string;
}

/** The target's picklist fields an object's refused rows name, by object then field. */
export type TargetPicklists = ReadonlyMap<string, ReadonlyMap<string, TargetPicklist>>;

/**
 * Why the target refused a value of a restricted picklist, where its describe
 * tells: `not-in-target` when the field holds no active value of it, as a
 * simulation says it; `record-type` when the field holds it and the row went
 * in with a record type, which then does not select it. Undefined where it
 * cannot tell: no describe of the field, a value the field holds on a row
 * with no record type named, or one a controlling field may refuse.
 *
 * A rehearsal's refusal carried no reason, and the list for the target's
 * admin said "add or activate the value" where the fix was selecting it for
 * the record type.
 */
function refusalReasonOf(
  picklist: TargetPicklist | undefined,
  value: string,
  recordType: string | undefined,
): 'not-in-target' | 'record-type' | undefined {
  if (!picklist) return undefined;
  const held = new Set(picklist.values);
  if (value.split(';').some((part) => !held.has(part))) return 'not-in-target';
  if (picklist.controllerName !== undefined) return undefined;
  return recordType !== undefined ? 'record-type' : undefined;
}

/** A row a rehearsal saw refused, with the errors it was refused with. */
export interface RefusedRow {
  /**
   * The row; for an update refused, the row of the record it updates, with
   * the values the update sets.
   */
  row: RehearsedRow;
  errors: readonly SaveErrorDetail[];
  /** How many of the run's rows, or of its updates, it stands for, itself included. */
  standsFor: number;
  /** Set when what was refused is an update the run makes after its inserts. */
  onUpdate?: true;
  /**
   * Set when the target refused the row for a record it holds, and named it:
   * the run's writer links the row to that record, and writes what hangs
   * from it under it.
   */
  linked?: true;
}

/**
 * The platform's message, without any of the row's own values in it: a
 * message can quote what it refused. Left out for the codes whose message is
 * the value itself.
 */
function messageOf(row: RehearsedRow, error: SaveErrorDetail): string | undefined {
  if (MESSAGE_REPEATS_THE_VALUE.has(error.statusCode) || error.message === '') return undefined;
  let message = error.message;
  for (const value of Object.values(row.fields)) {
    if (typeof value === 'string' && value.length >= 3) message = message.split(value).join('…');
  }
  return message;
}

/** The record type a row goes in with, by its DeveloperName, when the run's mapping names it. */
function recordTypeOf(
  row: RehearsedRow,
  recordTypeNames: ReadonlyMap<string, string>,
): string | undefined {
  const id = row.fields['RecordTypeId'];
  return typeof id === 'string' ? recordTypeNames.get(id.slice(0, 15)) : undefined;
}

/**
 * The gap of a row the target refused for a record it holds, naming it: a
 * warning whether or not the refusal names the field, since the run's writer
 * links the row to that record and nothing hanging from it is lost. A unique
 * value's refusal is the collision the simulation reports
 * (`unique_value_collision`); the target's own unique index on an external
 * id named no field when a Developer Edition target refused a root account
 * so, and the rehearsal reported a blocking refusal of a row the real run
 * linked.
 */
function linkedGapOf(
  refused: RefusedRow,
  error: SaveErrorDetail,
  code: string,
  detail: (field?: string) => NonNullable<ForgeGap['detail']>,
): ForgeGap {
  const { row } = refused;
  const field = error.fields[0];
  const kind: ForgeGapKind =
    code === ALREADY_EXISTS_ERROR ? 'unique_value_collision' : 'rehearsal_refusal';
  return {
    id: forgeGapId(
      kind,
      row.objectApiName,
      field,
      undefined,
      kind === 'rehearsal_refusal' ? code : undefined,
    ),
    kind,
    severity: 'warning',
    source: 'rehearsal',
    objectApiName: row.objectApiName,
    ...(field !== undefined ? { field } : {}),
    ...(kind === 'rehearsal_refusal' ? { value: code } : {}),
    rows: 1,
    detail: { ...detail(field), linkedToTheRecordItNames: true },
    decisions:
      field !== undefined
        ? ['leave_empty', 'exclude_object', 'ignore']
        : ['exclude_object', 'ignore'],
    defaultDecision: 'ignore',
  };
}

/** One gap of one error of one row: rows 1, merged with the others' afterwards. */
function gapsOfError(
  refused: RefusedRow,
  error: SaveErrorDetail,
  recordTypeNames: ReadonlyMap<string, string>,
  picklists: TargetPicklists,
): ForgeGap[] {
  const { row } = refused;
  const code = error.statusCode || NO_STATUS_CODE;
  const message = messageOf(row, error);
  const detail = (field?: string): NonNullable<ForgeGap['detail']> => {
    const value = field === undefined ? undefined : row.fields[field];
    return {
      statusCode: code,
      fields: [...error.fields],
      ...(message !== undefined ? { message } : {}),
      rowsOfTheRun: refused.standsFor,
      // A text too long is said by its length, never by what it says.
      ...(code === 'STRING_TOO_LONG' && typeof value === 'string'
        ? { valueLength: value.length }
        : {}),
      // The run writes a row again without the field refused; an update
      // refused is counted, and sent no more.
      ...(WRITTEN_AGAIN_WITHOUT_THE_FIELD.has(code) && field !== undefined && !refused.onUpdate
        ? { writtenWithoutTheField: true }
        : {}),
    };
  };
  if (refused.onUpdate) {
    // Never a read's own kind: what a read before the run reports, and the
    // decisions that answer it, are about the row the run inserts. The
    // record goes in; what the update gives it does not.
    const field = error.fields[0];
    return [
      {
        id: forgeGapId('rehearsal_update_refusal', row.objectApiName, field, undefined, code),
        kind: 'rehearsal_update_refusal',
        severity: 'warning',
        source: 'rehearsal',
        objectApiName: row.objectApiName,
        ...(field !== undefined ? { field } : {}),
        value: code,
        rows: 1,
        detail: detail(field),
        decisions: ['exclude_object', 'ignore'],
      },
    ];
  }
  if (refused.linked) return [linkedGapOf(refused, error, code, detail)];
  const known = KIND_OF_CODE.get(code);
  if (known && error.fields.length > 0) {
    // A required field's refusal names every field the row lacks: each is a
    // gap of its own, as the simulation reports them. Any other names the
    // field it refused first.
    const fields =
      known.kind === 'required_field_missing' ? error.fields : error.fields.slice(0, 1);
    return fields.map((field) => {
      const value = row.fields[field];
      const picklist = known.kind === 'picklist_value_refused';
      const recordType = picklist ? recordTypeOf(row, recordTypeNames) : undefined;
      const picked = picklist && typeof value === 'string' ? value : undefined;
      const reason =
        picked !== undefined
          ? refusalReasonOf(picklists.get(row.objectApiName)?.get(field), picked, recordType)
          : undefined;
      return {
        id: forgeGapId(known.kind, row.objectApiName, field, recordType, picked),
        kind: known.kind,
        severity: known.severity,
        source: 'rehearsal',
        objectApiName: row.objectApiName,
        field,
        ...(recordType !== undefined ? { recordType } : {}),
        ...(picked !== undefined ? { value: picked } : {}),
        rows: 1,
        detail: { ...detail(field), ...(reason !== undefined ? { reason } : {}) },
        decisions: [...known.decisions],
        ...(known.severity === 'warning' ? { defaultDecision: 'leave_empty' as const } : {}),
      };
    });
  }
  const field = error.fields[0];
  const writtenAgain = field !== undefined && WRITTEN_AGAIN_WITHOUT_THE_FIELD.has(code);
  return [
    {
      id: forgeGapId('rehearsal_refusal', row.objectApiName, field, undefined, code),
      kind: 'rehearsal_refusal',
      severity: writtenAgain ? 'warning' : 'blocking',
      source: 'rehearsal',
      objectApiName: row.objectApiName,
      ...(field !== undefined ? { field } : {}),
      value: code,
      rows: 1,
      detail: detail(field),
      decisions:
        field !== undefined
          ? ['leave_empty', 'exclude_object', 'ignore']
          : ['exclude_object', 'ignore'],
      ...(writtenAgain ? { defaultDecision: 'leave_empty' as const } : {}),
    },
  ];
}

/**
 * The gaps of the rows a rehearsal saw refused: one per object, code and
 * field — or per known kind, field and value ({@link KIND_OF_CODE}) — with
 * how many sample rows got that verdict and how many rows of the run those
 * stand for. Never a row's data: a status code, a picklist value, a length.
 * An update the run makes after its inserts that was refused is a gap of its
 * own kind (`rehearsal_update_refusal`), per object, code and field.
 *
 * @param recordTypeNames - The target's record types, by the first 15
 *   characters of their id, to their DeveloperName: a refused picklist value
 *   is a gap of the record type the row goes in with.
 * @param picklists - The target's restricted picklists the refusals name, as
 *   its describe says them: why a value was refused, where it tells.
 */
export function rehearsalGaps(
  refused: readonly RefusedRow[],
  recordTypeNames: ReadonlyMap<string, string> = new Map(),
  picklists: TargetPicklists = new Map(),
): ForgeGap[] {
  const byId = new Map<string, ForgeGap>();
  for (const entry of refused) {
    const errors: readonly SaveErrorDetail[] =
      entry.errors.length > 0
        ? entry.errors
        : [{ statusCode: NO_STATUS_CODE, message: '', fields: [] }];
    // Once per row: a row refused twice on the same gap counts once.
    const ofRow = mergeGaps(
      ...errors.map((error) => gapsOfError(entry, error, recordTypeNames, picklists)),
    );
    for (const gap of ofRow) {
      const seen = byId.get(gap.id);
      if (!seen) {
        byId.set(gap.id, gap);
        continue;
      }
      const longest = Math.max(numberIn(seen, 'valueLength'), numberIn(gap, 'valueLength'));
      byId.set(gap.id, {
        ...seen,
        rows: seen.rows + 1,
        detail: {
          ...gap.detail,
          ...seen.detail,
          rowsOfTheRun: numberIn(seen, 'rowsOfTheRun') + numberIn(gap, 'rowsOfTheRun'),
          fields: [...new Set([...fieldsIn(seen), ...fieldsIn(gap)])],
          ...(longest > 0 ? { valueLength: longest } : {}),
        },
      });
    }
  }
  return mergeGaps([...byId.values()]);
}
