/**
 * The picklist values a row goes into the target with, checked against what
 * the target allows for the record type the row goes in with.
 *
 * Run for real between two orgs, six of a clone's seven failed rows were
 * `INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value for restricted picklist
 * field`, on two custom objects whose rows carry a record type. Each value was
 * active in the target, so the check against the describe let it through; the
 * row's record type did not keep it. A restricted picklist refuses a value its
 * record's type does not keep, and a dependent one a value its controlling
 * value does not allow. Only the UI API says either
 * (`core/metadata/recordTypePicklists.ts`), in one request per record type for
 * every picklist field of the object.
 *
 * A value the target would refuse is replaced by the record type's default for
 * the field; for a field the target requires and the record type sets no
 * default for, by the first value the record type allows, as the row cannot go
 * in without one; and otherwise it is left out. Each is counted per object and
 * field, with why, for the object's line and the run's result.
 */

import type { ForgePicklistRefusal, ForgePicklistValuesChanged } from '@sandforge/shared';
import type {
  RecordTypePicklist,
  RecordTypePicklists,
} from '../../../core/metadata/recordTypePicklists.js';
import { extractErrorMessage } from '../../../core/common/extractErrorMessage.js';
import type { RecordTypeMapping } from '../../sync/RecordTypeMapper.js';
import type { ExecutionErrorSample, FieldInfo } from '../ForgeExecutor.js';

/** What the target describe says of one picklist field, its values aside. */
export interface PicklistField {
  /** A multi-select picklist: a value is several, `;`-separated, each checked on its own. */
  readonly multi: boolean;
  /** Restricted: the target refuses a value the row's record type does not keep. */
  readonly restricted: boolean;
  /** Required at insert, and given no value by the platform when left out. */
  readonly required: boolean;
  /** For a dependent picklist, the field whose value decides what it allows. */
  readonly controllerName?: string;
  /**
   * Set when the target takes any value of the field: an unrestricted
   * picklist or multi-select picklist, as its describe says, or a combobox.
   * "The API doesn't enforce the list of values for advisory (unrestricted)
   * picklist fields on create() or update()", and one it does not hold goes
   * in as an inactive value of the field (Object Reference for the
   * Salesforce Platform, Picklist Field Type). Absent when the describe does
   * not say, and the value is checked as a restricted one's is; absent too of
   * a picklist whose values are records of their own (`VALUES_OF_THEIR_OWN`).
   */
  readonly anyValue?: boolean;
}

/**
 * The standard picklists whose values are records of an object of their own —
 * a case's status a CaseStatus, an opportunity's stage an OpportunityStage —
 * each carrying more than its name: whether it closes the case, the
 * probability it gives (Object Reference for the Salesforce Platform,
 * Picklist Field Type, which names CaseStatus, ContractStatus, LeadStatus,
 * OpportunityStage, PartnerRole, SolutionStatus, TaskPriority and
 * TaskStatus). The describe calls them unrestricted, and whether the API
 * takes a value they do not hold is said nowhere: kept as read and refused,
 * a case would be lost where its status, left out, takes the target's
 * default. Their values are checked as a restricted picklist's are, as they
 * always were. So are the statuses whose values each carry a category the
 * platform acts on — an order's draft or activated, a work order's, a work
 * order line item's or a service appointment's status category — and a
 * campaign member's, whose values are the statuses its campaign holds: the
 * reference does not list them, nor says more of a value they do not hold.
 */
const VALUES_OF_THEIR_OWN: Readonly<Record<string, readonly string[]>> = {
  AccountPartner: ['Role'],
  CampaignMember: ['Status'],
  Case: ['Status'],
  Contract: ['Status'],
  Lead: ['Status'],
  Opportunity: ['StageName'],
  OpportunityPartner: ['Role'],
  Order: ['Status'],
  Partner: ['Role'],
  ServiceAppointment: ['Status'],
  Solution: ['Status'],
  Task: ['Priority', 'Status'],
  WorkOrder: ['Status'],
  WorkOrderLineItem: ['Status'],
};

/**
 * The picklist fields of a target describe, by name.
 *
 * @param objectApiName - The object described: what says a picklist's values
 *   are records of their own (`VALUES_OF_THEIR_OWN`). Absent, none is.
 */
export function picklistFieldsOf(
  fields: readonly FieldInfo[],
  objectApiName?: string,
): Map<string, PicklistField> {
  const picklists = new Map<string, PicklistField>();
  const ofTheirOwn =
    objectApiName !== undefined &&
    Object.prototype.hasOwnProperty.call(VALUES_OF_THEIR_OWN, objectApiName)
      ? VALUES_OF_THEIR_OWN[objectApiName]
      : [];
  for (const field of fields) {
    const multi = field.type === 'multipicklist';
    if (field.type !== 'picklist' && !multi && !field.picklistValues?.length) continue;
    const anyValue =
      (field.type === 'combobox' || field.restrictedPicklist === false) &&
      !ofTheirOwn.includes(field.name);
    picklists.set(field.name, {
      multi,
      restricted: field.restrictedPicklist === true,
      required: field.nillable === false && field.defaultedOnCreate !== true,
      ...(field.controllerName ? { controllerName: field.controllerName } : {}),
      ...(anyValue ? { anyValue } : {}),
    });
  }
  return picklists;
}

/** What one record type of the target allows, under the name it goes by. */
export interface RecordTypeValues {
  /** The record type's API name, as the record type mapping gives it. */
  readonly recordType: string;
  /** What it allows of each picklist field the target's answer covers. */
  readonly picklists: RecordTypePicklists;
}

/** A picklist value a row was not written with as it was read, and what it got instead. */
export interface PicklistChange {
  /** The field, by the name it is written under. */
  readonly field: string;
  /** Why the target would refuse the values. */
  readonly reason: ForgePicklistRefusal;
  /** The values read that it would refuse. */
  readonly values: readonly string[];
  /** The record type the row goes in with, when its values were read. */
  readonly recordType?: string;
  /** For `controlling-value`, the field whose value decides. */
  readonly controllingField?: string;
  /** What the row is written with instead; absent when the value was left out. */
  readonly replacedBy?: string;
  /** How `replacedBy` was chosen. */
  readonly replacement?: 'default' | 'first';
}

/** No field written under a rename. */
const NONE: ReadonlySet<string> = new Set();

/**
 * The keys of a row, each controlling field before the fields that depend on
 * it: a dependent value is checked against its controlling value as written,
 * after that one was checked in turn.
 */
function controllersFirst(
  keys: readonly string[],
  fields: ReadonlyMap<string, PicklistField>,
): string[] {
  const present = new Set(keys);
  const ordered: string[] = [];
  const placed = new Set<string>();
  const place = (key: string, depth: number): void => {
    if (placed.has(key)) return;
    const controller = fields.get(key)?.controllerName;
    // A chain is as long as the row has keys; past that it is a loop.
    if (controller && present.has(controller) && depth < keys.length) place(controller, depth + 1);
    if (placed.has(key)) return;
    placed.add(key);
    ordered.push(key);
  };
  for (const key of keys) place(key, 0);
  return ordered;
}

/** A controlling value as the UI API keys it: a checkbox by `true` and `false`. */
function controllingValueOf(value: unknown): string | undefined {
  if (typeof value === 'boolean') return String(value);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The values, each once, grouped by why they are refused, in the order met. */
function byReason(
  refused: readonly string[],
  reasonOf: (value: string) => ForgePicklistRefusal,
): Array<[ForgePicklistRefusal, string[]]> {
  const groups = new Map<ForgePicklistRefusal, string[]>();
  for (const value of refused) {
    const reason = reasonOf(value);
    const values = groups.get(reason) ?? [];
    if (!values.includes(value)) values.push(value);
    groups.set(reason, values);
  }
  return [...groups];
}

/**
 * Check one field of a row against what its record type allows, and replace
 * or leave out what it does not.
 */
function checkAgainstRecordType(
  row: Record<string, unknown>,
  field: string,
  parts: readonly string[],
  info: PicklistField,
  allowed: RecordTypePicklist,
  recordType: string,
  known: ReadonlySet<string> | undefined,
): PicklistChange[] {
  const kept = new Set(allowed.values);
  let allows: ReadonlySet<string> = kept;
  let controllingField: string | undefined;
  // A controlling value the UI API names says which of the values it allows;
  // one it does not name, or none at all, leaves the record type's values.
  const controlling = info.controllerName
    ? controllingValueOf(row[info.controllerName])
    : undefined;
  const byControlling =
    controlling === undefined ? undefined : allowed.allowedByControllingValue?.get(controlling);
  if (byControlling) {
    allows = new Set(allowed.values.filter((value) => byControlling.has(value)));
    controllingField = info.controllerName;
  }
  const refused = parts.filter((part) => !allows.has(part));
  if (refused.length === 0) return [];
  const reasonOf = (value: string): ForgePicklistRefusal => {
    if (known && !known.has(value)) return 'not-in-target';
    return kept.has(value) ? 'controlling-value' : 'record-type';
  };

  let replacedBy: string | undefined;
  let replacement: 'default' | 'first' | undefined;
  const rest = parts.filter((part) => allows.has(part));
  if (info.multi && rest.length > 0) {
    // What the record type allows of a selection is written; the rest is left out.
    row[field] = rest.join(';');
  } else {
    if (allowed.defaultValue !== null && allows.has(allowed.defaultValue)) {
      replacedBy = allowed.defaultValue;
      replacement = 'default';
    } else if (info.required) {
      // Left out, a field the target requires costs the row. No one chose a
      // value for it there; the first the record type lists comes first in
      // the order its admin gave them.
      replacedBy = allowed.values.find((value) => allows.has(value));
      replacement = replacedBy === undefined ? undefined : 'first';
    }
    if (replacedBy === undefined) delete row[field];
    else row[field] = replacedBy;
  }
  return byReason(refused, reasonOf).map(([reason, values]) => ({
    field,
    reason,
    values,
    recordType,
    ...(reason === 'controlling-value' && controllingField ? { controllingField } : {}),
    ...(replacedBy !== undefined && replacement ? { replacedBy, replacement } : {}),
  }));
}

/**
 * Check the picklist values of one cleaned row, and replace or leave out those
 * the target would refuse. Changes `row` in place.
 *
 * A restricted picklist of a row whose record type was read is checked
 * against what that record type allows: see the module's comment. Any other
 * restricted picklist with values in the target describe — the row's record
 * type unknown there or unread, or the field missing from the record type's
 * answer — is checked against the field's active values, and a value it does
 * not hold is left out, as it always was; so is a picklist whose describe
 * does not say whether it is restricted. A picklist the target takes any
 * value of (`PicklistField.anyValue`) keeps the value read: checked against
 * the field's active values, a value the target would have taken was lost. A
 * multi-select value is checked one selection at a time.
 *
 * @param fieldValues - The active values of each picklist field in the target.
 * @param fields - The target's picklist fields.
 * @param typed - What the row's record type allows, when it was read.
 * @param renamed - Fields the row is written with under a rename: the field
 *   map's to answer for, never checked.
 */
export function checkRowPicklists(
  row: Record<string, unknown>,
  fieldValues: ReadonlyMap<string, ReadonlySet<string>> | null,
  fields: ReadonlyMap<string, PicklistField>,
  typed: RecordTypeValues | undefined,
  renamed: ReadonlySet<string> = NONE,
): PicklistChange[] {
  const changes: PicklistChange[] = [];
  for (const field of controllersFirst(Object.keys(row), fields)) {
    const value = row[field];
    if (typeof value !== 'string' || renamed.has(field)) continue;
    const info = fields.get(field);
    const known = fieldValues?.get(field);
    const allowed = info?.restricted ? typed?.picklists.get(field) : undefined;
    if (!known && !allowed) continue;
    // Empty is no value: nothing to check, and nothing lost by not sending it.
    if (value === '') {
      delete row[field];
      continue;
    }
    const parts = info?.multi ? value.split(';') : [value];
    if (info && allowed && typed) {
      changes.push(
        ...checkAgainstRecordType(row, field, parts, info, allowed, typed.recordType, known),
      );
      continue;
    }
    if (!known || info?.anyValue) continue;
    const refused = parts.filter((part) => !known.has(part));
    if (refused.length === 0) continue;
    const rest = parts.filter((part) => known.has(part));
    if (info?.multi && rest.length > 0) row[field] = rest.join(';');
    else delete row[field];
    changes.push({ field, reason: 'not-in-target', values: [...new Set(refused)] });
  }
  return changes;
}

/** Inputs of {@link RecordTypePicklistReads.forRows}. */
export interface RecordTypeReadInput {
  /** The object the rows belong to. */
  readonly objectApiName: string;
  /** The rows as read: `RecordTypeId` is the source's. */
  readonly rows: readonly Record<string, unknown>[];
  /** The target's picklist fields of the object. */
  readonly fields: ReadonlyMap<string, PicklistField>;
  /**
   * Whether the rows are written with a field under its own name: createable
   * in both orgs, neither excluded nor renamed.
   */
  readonly written: (field: string) => boolean;
  /** The run's record type mapping; absent, no row's record type is known in the target. */
  readonly recordTypeMappings: readonly RecordTypeMapping[] | undefined;
}

/**
 * Something to say once of a record type whose values the check could not
 * use: its read failed, or its answer left out fields its rows hold a value
 * in. Those are checked against the values of each field instead.
 */
export interface RecordTypeReadNote {
  /** The record type, by API name. */
  readonly recordType: string;
  /** The read's error, when it failed. */
  readonly error?: string;
  /** The fields the answer left out, when it came. */
  readonly leftOut?: readonly string[];
}

/** What reading a record type's values gave: them, or why not. */
type RecordTypeRead = { picklists: RecordTypePicklists } | { error: string };

/** Read a record type's values, a failure — thrown or rejected — kept as its message. */
async function readOnce(
  read: (objectApiName: string, recordTypeId: string) => Promise<RecordTypePicklists>,
  objectApiName: string,
  recordTypeId: string,
): Promise<RecordTypeRead> {
  try {
    return { picklists: await read(objectApiName, recordTypeId) };
  } catch (error: unknown) {
    return { error: extractErrorMessage(error) };
  }
}

/**
 * What the record types of the target allow of the objects' picklists, read
 * once a run per object and record type, however many times rows of them are
 * written.
 */
export class RecordTypePicklistReads {
  private readonly reads = new Map<string, Promise<RecordTypeRead>>();
  /** What has been said of each object and record type, and of each field left out of an answer. */
  private readonly said = new Set<string>();

  /**
   * @param read - The target's UI API read; absent, no record type is read and
   *   every value is checked against the values of its field.
   */
  constructor(
    private readonly read?: (
      objectApiName: string,
      recordTypeId: string,
    ) => Promise<RecordTypePicklists>,
  ) {}

  /**
   * By `RecordTypeId` as the rows carry it, what the record type each goes in
   * with allows: read for a record type the mapping translates — the row's
   * record type is then known in the target — and only when one of its rows
   * holds a value in a restricted picklist the rows are written with. With
   * the notes not yet said of the record types read.
   */
  async forRows(
    input: RecordTypeReadInput,
  ): Promise<{ byRecordType: Map<string, RecordTypeValues>; notes: RecordTypeReadNote[] }> {
    const byRecordType = new Map<string, RecordTypeValues>();
    const notes: RecordTypeReadNote[] = [];
    const { read } = this;
    if (!read || !input.recordTypeMappings || !input.written('RecordTypeId')) {
      return { byRecordType, notes };
    }
    const restricted = [...input.fields]
      .filter(([name, field]) => field.restricted && input.written(name))
      .map(([name]) => name);
    if (restricted.length === 0) return { byRecordType, notes };
    // Matched as the mapping matches when the row is translated.
    const mapping = new Map(input.recordTypeMappings.map((m) => [m.sourceId, m]));
    const held = new Map<string, Set<string>>();
    for (const row of input.rows) {
      const recordTypeId = row['RecordTypeId'];
      if (typeof recordTypeId !== 'string' || !mapping.has(recordTypeId)) continue;
      for (const field of restricted) {
        const value = row[field];
        if (typeof value !== 'string' || value === '') continue;
        const fields = held.get(recordTypeId) ?? new Set<string>();
        fields.add(field);
        held.set(recordTypeId, fields);
      }
    }
    const answers = await Promise.all(
      [...held].map(async ([sourceId, fields]) => {
        const { targetId, developerName } = mapping.get(sourceId)!;
        const key = `${input.objectApiName}|${targetId}`;
        let pending = this.reads.get(key);
        if (!pending) {
          pending = readOnce(read, input.objectApiName, targetId);
          this.reads.set(key, pending);
        }
        return { sourceId, fields, developerName, key, answer: await pending };
      }),
    );
    for (const { sourceId, fields, developerName, key, answer } of answers) {
      if ('error' in answer) {
        if (!this.said.has(key)) {
          this.said.add(key);
          notes.push({ recordType: developerName, error: answer.error });
        }
        continue;
      }
      byRecordType.set(sourceId, { recordType: developerName, picklists: answer.picklists });
      const leftOut = [...fields].filter(
        (field) => !answer.picklists.has(field) && !this.said.has(`${key}|${field}`),
      );
      if (leftOut.length === 0) continue;
      for (const field of leftOut) this.said.add(`${key}|${field}`);
      notes.push({ recordType: developerName, leftOut });
    }
    return { byRecordType, notes };
  }
}

/** A note on a record type, as a sample of the object's report. */
export function recordTypeReadSample(note: RecordTypeReadNote): ExecutionErrorSample {
  return note.error !== undefined
    ? {
        recordSummary:
          `(picklist values of record type ${note.recordType} could not be read — ` +
          "checked against each field's values)",
        messages: [note.error],
      }
    : {
        recordSummary:
          `(picklist values of record type ${note.recordType} not given for ` +
          `${(note.leftOut ?? []).join(', ')} — checked against each field's values)`,
        messages: [
          `The target's answer for record type ${note.recordType} leaves out ` +
            `${(note.leftOut ?? []).join(', ')}.`,
        ],
      };
}

/**
 * The picklist changes of many rows, by object, field, reason and outcome,
 * rows counted, in the order first met.
 */
export class PicklistChangeTally {
  private readonly entries = new Map<
    string,
    { entry: ForgePicklistValuesChanged; values: Set<string> }
  >();

  /** How many entries the tally holds. */
  get size(): number {
    return this.entries.size;
  }

  /** Count the changes of one row of `objectApiName`. */
  add(objectApiName: string, changes: readonly PicklistChange[]): void {
    for (const change of changes) {
      const key = [
        objectApiName,
        change.field,
        change.reason,
        change.recordType ?? '',
        change.controllingField ?? '',
        change.replacement ?? '',
        change.replacedBy ?? '',
      ].join('\u0000');
      const known = this.entries.get(key);
      if (known) {
        known.entry.rows++;
        for (const value of change.values) known.values.add(value);
        continue;
      }
      this.entries.set(key, {
        entry: {
          objectApiName,
          field: change.field,
          reason: change.reason,
          values: [],
          rows: 1,
          ...(change.recordType !== undefined ? { recordType: change.recordType } : {}),
          ...(change.controllingField !== undefined
            ? { controllingField: change.controllingField }
            : {}),
          ...(change.replacedBy !== undefined ? { replacedBy: change.replacedBy } : {}),
          ...(change.replacement !== undefined ? { replacement: change.replacement } : {}),
        },
        values: new Set(change.values),
      });
    }
  }

  /** The entries, each with its values sorted. */
  list(): ForgePicklistValuesChanged[] {
    return [...this.entries.values()].map(({ entry, values }) => ({
      ...entry,
      values: [...values].sort(),
    }));
  }
}

/**
 * One entry, as a line or the command's summary says it: `Status__c on 2 rows:
 * "Old" not allowed for record type Retail, replaced by "New", the default of
 * record type Retail`.
 */
export function describePicklistChange(change: ForgePicklistValuesChanged): string {
  const rows = `${change.rows} row${change.rows === 1 ? '' : 's'}`;
  const values = change.values.map((value) => `"${value}"`).join(', ');
  const why =
    change.reason === 'not-in-target'
      ? 'not a value of the field in the target'
      : change.reason === 'record-type'
        ? `not allowed for record type ${change.recordType ?? ''}`
        : `not allowed with the value of ${change.controllingField ?? 'its controlling field'}`;
  const outcome =
    change.replacedBy === undefined
      ? 'left out'
      : change.replacement === 'first'
        ? `replaced by "${change.replacedBy}", the first value record type ` +
          `${change.recordType ?? ''} allows: the field is required and has no default there`
        : `replaced by "${change.replacedBy}", the default of record type ${change.recordType ?? ''}`;
  return `${change.field} on ${rows}: ${values} ${why}, ${outcome}`;
}

/**
 * What an object's line says of the picklist values its write did not send as
 * read — `, picklist values not written as read: Status__c on 2 rows: …` —
 * or nothing.
 */
export function picklistChangesNote(changes: readonly ForgePicklistValuesChanged[]): string {
  if (changes.length === 0) return '';
  return `, picklist values not written as read: ${changes.map(describePicklistChange).join('; ')}`;
}
