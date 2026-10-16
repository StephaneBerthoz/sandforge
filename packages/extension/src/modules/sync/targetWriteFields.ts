/**
 * What a sync may send an object in the target org, read from one describe.
 *
 * The panel and the command line describe each target object once per run
 * and read everything a write needs from that answer: the fields the running
 * user may write, the lookups among them, and the record types that user may
 * use. Kept apart from `DataSync` so the handler can build it without loading
 * the sync engine before a run starts.
 */

import {
  parseRecordTypeInfos,
  type RecordTypeAvailability,
} from '../../core/metadata/recordTypeAvailability.js';
import { ACCOUNT, PERSON_CONTACT_FIELD } from '../../core/common/platformRecords.js';
import type { FieldInfo } from '../forge/ForgeExecutor.js';

/** What the target's describe of an object says a write may send. */
export interface TargetWriteFields {
  /** Fields the target lets the running user write. */
  creatable: ReadonlySet<string>;
  /** The lookups among them. */
  references: ReadonlySet<string>;
  /**
   * The object's record types as the running user sees them. Optional: a
   * describe that does not carry them leaves record types to the platform.
   */
  recordTypes?: readonly RecordTypeAvailability[];
  /**
   * Of the account: whether the target has person accounts — its describe
   * names `PersonContactId`, the lookup at the contact the platform writes with
   * one, as Forge tells it. Absent for any other object, and when it cannot
   * be told.
   */
  personAccounts?: boolean;
  /**
   * Every field the describe names, with what a simulation checks a row
   * against before the write: whether the target requires it, how long a text
   * it holds, how many digits a number, whether it takes a value once. Absent
   * when the describe did not say.
   */
  fields?: readonly FieldInfo[];
}

/** One field of a describe, as jsforce returns it, reduced to what is read here. */
interface DescribedField {
  name: string;
  createable?: boolean;
  type?: string;
  queryable?: boolean;
  nillable?: boolean;
  defaultedOnCreate?: boolean;
  calculated?: boolean;
  length?: number;
  precision?: number;
  scale?: number;
  digits?: number;
  unique?: boolean;
  referenceTo?: readonly string[] | null;
}

/** A count the describe gives, when it gives a positive one. */
function positive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** A field of the describe as Forge's row checks read it (`rowGapsOf`). */
function fieldInfoOf(field: DescribedField): FieldInfo {
  const length = positive(field.length);
  const precision = positive(field.precision);
  const digits = positive(field.digits);
  return {
    name: field.name,
    queryable: field.queryable !== false,
    createable: field.createable === true,
    isReference: field.type === 'reference',
    ...(field.type !== undefined ? { type: field.type } : {}),
    ...(length !== undefined ? { length } : {}),
    ...(field.nillable !== undefined ? { nillable: field.nillable } : {}),
    ...(field.defaultedOnCreate !== undefined
      ? { defaultedOnCreate: field.defaultedOnCreate }
      : {}),
    ...(field.calculated === true ? { calculated: true as const } : {}),
    ...(precision !== undefined ? { precision } : {}),
    ...(precision !== undefined && typeof field.scale === 'number' && field.scale >= 0
      ? { scale: field.scale }
      : {}),
    ...(digits !== undefined ? { digits } : {}),
    ...(field.unique === true ? { unique: true as const } : {}),
    ...(field.referenceTo ? { referenceTo: [...field.referenceTo] } : {}),
  };
}

/**
 * {@link TargetWriteFields} from one describe of the target object.
 *
 * @param described - The object's describe, as jsforce returns it.
 */
export function targetWriteFieldsOf(described: {
  name?: string;
  fields: ReadonlyArray<DescribedField>;
  recordTypeInfos?: unknown;
}): TargetWriteFields {
  const writable = described.fields.filter((f) => f.createable === true);
  return {
    creatable: new Set(writable.map((f) => f.name)),
    references: new Set(writable.filter((f) => f.type === 'reference').map((f) => f.name)),
    recordTypes: parseRecordTypeInfos(described.recordTypeInfos),
    ...(described.name === ACCOUNT
      ? { personAccounts: described.fields.some((f) => f.name === PERSON_CONTACT_FIELD) }
      : {}),
    fields: described.fields.map(fieldInfoOf),
  };
}
