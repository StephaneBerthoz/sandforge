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
import type { SyncOperation, SyncUnwritableReason } from '@sandforge/shared';
import { ACCOUNT, PERSON_CONTACT_FIELD } from '../../core/common/platformRecords.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import type { FieldInfo } from '../forge/ForgeExecutor.js';
import { isNotFound } from '../forge/ForgeMetadataDiff.js';

/** What the target's describe of an object says a write may send. */
export interface TargetWriteFields {
  /** Fields the target lets the running user write. */
  creatable: ReadonlySet<string>;
  /** The lookups among them. */
  references: ReadonlySet<string>;
  /**
   * Whether the target lets the running user create the object's records at
   * all, and edit them, as its describe says: a profile without Create on
   * Case answers false here while it may still read every field. Absent when
   * the describe did not say.
   */
  objectCreateable?: boolean;
  objectUpdateable?: boolean;
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
  createable?: boolean;
  updateable?: boolean;
  fields: ReadonlyArray<DescribedField>;
  recordTypeInfos?: unknown;
}): TargetWriteFields {
  const writable = described.fields.filter((f) => f.createable === true);
  return {
    creatable: new Set(writable.map((f) => f.name)),
    references: new Set(writable.filter((f) => f.type === 'reference').map((f) => f.name)),
    ...(typeof described.createable === 'boolean'
      ? { objectCreateable: described.createable }
      : {}),
    ...(typeof described.updateable === 'boolean'
      ? { objectUpdateable: described.updateable }
      : {}),
    recordTypes: parseRecordTypeInfos(described.recordTypeInfos),
    ...(described.name === ACCOUNT
      ? { personAccounts: described.fields.some((f) => f.name === PERSON_CONTACT_FIELD) }
      : {}),
    fields: described.fields.map(fieldInfoOf),
  };
}

/** Why a run may not write any record of an object in the target. */
export type TargetRefusalReason = SyncUnwritableReason;

/** An object a run may not write in the target, why, and the sentence each of its records is refused with. */
export interface TargetRefusal {
  why: TargetRefusalReason;
  message: string;
}

/**
 * The sentence a record of an object the target will not take is refused
 * with. The first two open as Forge's refusals of the same objects do, so
 * the panels give them the same explanation (`error-hints.ts`).
 */
export function targetRefusalMessage(
  objectApiName: string,
  why: TargetRefusalReason,
  detail?: string,
): string {
  switch (why) {
    case 'notInTarget':
      return (
        'Object is not in the target org, or the user the run writes as cannot see it: ' +
        `${objectApiName}. None of its records were sent.`
      );
    case 'notCreateable':
      return (
        'Object is not createable on target org: the user the run writes as may not create ' +
        `${objectApiName} records there. None of its records were sent.`
      );
    case 'notUpdateable':
      return (
        'Object is not updateable on target org: the user the run writes as may not edit ' +
        `${objectApiName} records there. None of its records were sent.`
      );
    case 'unread':
      return (
        `The target org did not describe ${objectApiName}${detail ? ` (${detail})` : ''}, so ` +
        'what it takes could not be told and none of its records were sent.'
      );
  }
}

/**
 * Whether the target takes an object's records as the run writes them, from
 * its describe: an object it has not — or that the running user cannot see,
 * which its describe answers alike, NOT_FOUND — one that user may not create
 * for an insert or an upsert, or may not edit for an update or an upsert, is
 * refused whole, as is one it would not describe.
 *
 * A run read a failed describe as "could not say", and sent every row as it
 * was read, every field of it: the target then refused each record, after
 * the objects before it were written, and a simulation counted them written.
 * A delete is not refused here: it sends ids alone.
 */
export async function targetAccessOf(
  describe: (objectApiName: string) => Promise<TargetWriteFields>,
  objectApiName: string,
  operation: SyncOperation,
): Promise<
  | { target: TargetWriteFields }
  | { refused: TargetRefusal; target?: TargetWriteFields }
  | { notAsked: true }
> {
  let target: TargetWriteFields;
  try {
    target = await describe(objectApiName);
  } catch (err: unknown) {
    if (operation === 'delete') return { notAsked: true };
    const why: TargetRefusalReason = isNotFound(err) ? 'notInTarget' : 'unread';
    return {
      refused: {
        why,
        message: targetRefusalMessage(objectApiName, why, extractErrorMessage(err)),
      },
    };
  }
  const creates = operation === 'insert' || operation === 'upsert';
  const edits = operation === 'update' || operation === 'upsert';
  const why: TargetRefusalReason | undefined =
    creates && target.objectCreateable === false
      ? 'notCreateable'
      : edits && target.objectUpdateable === false
        ? 'notUpdateable'
        : undefined;
  return why
    ? { refused: { why, message: targetRefusalMessage(objectApiName, why) }, target }
    : { target };
}
