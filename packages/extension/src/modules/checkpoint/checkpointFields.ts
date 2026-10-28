/**
 * Which fields a checkpoint keeps of each object, how it reads them, and which
 * of them a rewind may write back.
 *
 * A checkpoint is read once and compared with the org many times after, so
 * what it keeps decides what a rewind can see. It keeps the stamps every
 * comparison reads and the values a person or an integration can set — the
 * fields the user may create or edit — and nothing the org computes: a
 * formula, a roll-up or an audit date read back into a restore is a value no
 * one may write, and comparing it would count the org's own arithmetic as a
 * change. Measured on six standard objects, the writable fields hold about a
 * third of what every field does.
 *
 * What it cannot keep is said, field by field, when the checkpoint is taken:
 * a field the user may read but not write is hidden from a rewind by
 * field-level security; a classic encrypted field the user reads masked would
 * keep the mask, and a rewind would write it back over the real value, as a
 * Sync run's removal did; a file body is no field value.
 *
 * A file, `ContentDocument`, is kept as a record whose content is left out:
 * the fields a person sets — its title, description, owner and sharing — and,
 * as witnesses a rewind compares nothing by and never writes, the latest
 * version and the size of its content. A new version since moves the first,
 * which the org lets no one point back at an older one (P-A6); the second is
 * what bringing the file back takes of the org's file storage (P-A8). Where
 * the file sits in a library, the asset it backs and whether it is archived
 * are the library's settings, not the file's data, and are not kept.
 */

import * as z from 'zod';
import { CrudFlsGuard } from '../../core/metadata/CrudFlsGuard.js';
import type { ObjectDescribe } from '../../core/metadata/describeTypes.js';
import {
  ACCOUNT,
  CONTACT,
  TASK,
  accountKindOf,
  isPersonAccountRow,
  leftOutForAccountKind,
} from '../../core/common/platformRecords.js';
import { ENCRYPTED_FIELD_TYPE } from '../sync/encryptedFields.js';
import { FILE_OBJECT } from './checkpointScope.js';

/** A field as an object's describe gives it, as far as a checkpoint reads it. */
export const checkpointFieldSchema = z
  .object({
    name: z.string(),
    type: z.string(),
    createable: z.boolean().optional(),
    updateable: z.boolean().optional(),
    nillable: z.boolean().optional(),
    calculated: z.boolean().optional(),
    autoNumber: z.boolean().optional(),
    permissionable: z.boolean().optional(),
    /** Shield Platform Encryption: transparent through the API, unlike a classic encrypted field. */
    encrypted: z.boolean().optional(),
    referenceTo: z.array(z.string()).nullish(),
  })
  .loose();

/** An object's describe, as far as a checkpoint reads it. */
export const checkpointDescribeSchema = z
  .object({
    name: z.string(),
    /** Whether a record deleted on its own comes back from the recycle bin on its own. */
    undeletable: z.boolean().optional(),
    fields: z.array(checkpointFieldSchema),
    childRelationships: z
      .array(
        z
          .object({
            childSObject: z.string(),
            field: z.string(),
            cascadeDelete: z.boolean().optional(),
            restrictedDelete: z.boolean().optional(),
          })
          .loose(),
      )
      .nullish(),
  })
  .loose();

/** A described field, checked. */
export type CheckpointField = z.infer<typeof checkpointFieldSchema>;

/** A described object, checked. */
export type CheckpointDescribe = z.infer<typeof checkpointDescribeSchema>;

/**
 * The stamps every row of a checkpoint carries, whatever else it keeps: the
 * id, the stamp that says whether the record moved since it was read, and who
 * created and last changed it, when. None of them is writable; the comparison
 * reads them all.
 */
export const SNAPSHOT_STAMPS: readonly string[] = [
  'Id',
  'SystemModstamp',
  'CreatedDate',
  'CreatedById',
  'LastModifiedDate',
  'LastModifiedById',
];

/** The flag of an account, and of a contact, that tells a person account's. */
export const PERSON_ACCOUNT_FLAG = 'IsPersonAccount';

/** The object of an event: read with archived ones, as a task is. */
const EVENT = 'Event';

/**
 * What a file's snapshot keeps beside the fields a person sets, never
 * compared and never written: the version a new one replaces as the latest,
 * which the org refuses to set (`INVALID_FIELD_FOR_INSERT_UPDATE`, P-A6), and
 * the bytes of its content, which a file brought back from the recycle bin
 * takes again of the org's file storage (P-A8).
 */
export const FILE_WITNESSES: readonly string[] = ['LatestPublishedVersionId', 'ContentSize'];

/**
 * A file's fields that belong to a library rather than to the file — its
 * place in one, the asset it backs, whether it is archived — that a file's
 * snapshot does not keep: neither compared nor written back. Named so a
 * preview can say they are not compared.
 */
export const FILE_SETTINGS_NOT_KEPT: readonly string[] = [
  'ParentId',
  'ContentAssetId',
  'IsArchived',
];

/**
 * The content of a file, its versions' `VersionData`, listed among the
 * fields its snapshot leaves out as a file body: said before the take, and
 * what keeps a rewind from making a file emptied from the recycle bin again
 * (`recreatable`, which reads the bodies left out), as it would make one with
 * no content. A file has no base64 field of its own to say so.
 */
export const FILE_BODY = 'VersionData';

/** Whether `objectApiName` is a file's, whose witnesses and settings its snapshot treats apart. */
function isFile(objectApiName: string): boolean {
  return objectApiName.toLowerCase() === FILE_OBJECT.toLowerCase();
}

/** The witnesses its snapshot keeps of an object, in lower case: a file's alone has any. */
function witnessesOf(objectApiName: string): ReadonlySet<string> {
  return new Set(isFile(objectApiName) ? FILE_WITNESSES.map((name) => name.toLowerCase()) : []);
}

/**
 * How a checkpoint reads an object: a plain query, or one that reads the
 * recycle bin too, kept to the live records.
 */
export type CheckpointReadMode = 'query' | 'scanAllLive';

/**
 * How a checkpoint reads `objectApiName`.
 *
 * A plain query leaves out the tasks and events Salesforce has archived —
 * closed tasks and past events older than about a year — which `queryAll`
 * returns ("Archived Activities", Salesforce Help). Read with a plain query
 * at one end and a full one at the other, an activity archived in between
 * would read as deleted since, and as one the recycle bin no longer holds.
 * Every read of them goes through `queryAll` with `IsDeleted = false`.
 */
export function readModeOf(objectApiName: string): CheckpointReadMode {
  return objectApiName === TASK || objectApiName === EVENT ? 'scanAllLive' : 'query';
}

/** Why a checkpoint keeps no value of a field it could otherwise have kept. */
export type LeftOutFieldReason = 'fls' | 'encrypted' | 'base64' | 'compound';

/** A field a checkpoint keeps no value of, with why. */
export interface LeftOutField {
  field: string;
  reason: LeftOutFieldReason;
}

/** What a checkpoint keeps of one object. */
export interface CaptureProjection {
  /** The columns its snapshot reads, the stamps first. */
  fields: string[];
  /** The fields it keeps no value of, with why: said when the checkpoint is taken. */
  leftOutFields: LeftOutField[];
}

/** What deciding a checkpoint's fields needs to know of the user it reads as. */
export interface CaptureOptions {
  /**
   * Whether that user reads classic encrypted fields in clear
   * (`viewsEncryptedData`): without it, the API answers them masked.
   */
  viewsEncryptedData: boolean;
}

/**
 * The guard that tells a field no one writes from one the user may not, over
 * one describe already read.
 *
 * `partitionWritableFields` reads nothing of an object but its fields' write
 * flags and the four shapes of a field the org writes itself; the rest of the
 * guard's describe is filled in neutrally, as nothing reads it.
 */
function guardOver(described: CheckpointDescribe): CrudFlsGuard {
  const shaped: ObjectDescribe = {
    name: described.name,
    label: described.name,
    labelPlural: described.name,
    keyPrefix: null,
    custom: false,
    createable: true,
    updateable: true,
    deletable: true,
    queryable: true,
    fields: described.fields.map((field) => ({
      name: field.name,
      label: field.name,
      type: field.type,
      length: 0,
      nillable: field.nillable === true,
      createable: field.createable === true,
      updateable: field.updateable === true,
      externalId: false,
      referenceTo: field.referenceTo ?? [],
      relationshipName: null,
      picklistValues: [],
      defaultValue: null,
      calculated: field.calculated === true,
      autoNumber: field.autoNumber === true,
      unique: false,
      ...(field.permissionable === undefined ? {} : { permissionable: field.permissionable }),
    })),
    recordTypeInfos: [],
    childRelationships: [],
  };
  return new CrudFlsGuard(async () => shaped);
}

/** Whether a field is a compound one, written through its parts: an address, a geolocation. */
function isCompound(field: CheckpointField): boolean {
  return field.type === 'address' || field.type === 'location';
}

/** A field's describe by its name, as Salesforce matches one: whatever its case. */
function fieldsByName(described: CheckpointDescribe): Map<string, CheckpointField> {
  return new Map(described.fields.map((field) => [field.name.toLowerCase(), field]));
}

/**
 * What a checkpoint keeps of the object `described` describes, for the user
 * it was described as.
 *
 * The stamps, then every field the user may create or edit — less a file
 * body, and less a classic encrypted field read masked — and, on an account
 * or a contact of an org with person accounts, the flag that tells a person
 * account's row: a rewind gives a person account its fields back by its kind,
 * and counts its contact with it.
 */
export async function captureProjection(
  described: CheckpointDescribe,
  options: CaptureOptions,
): Promise<CaptureProjection> {
  const byName = fieldsByName(described);
  const kept = SNAPSHOT_STAMPS.filter((stamp) => byName.has(stamp.toLowerCase()));
  const personFlag = byName.get(PERSON_ACCOUNT_FLAG.toLowerCase());
  if (personFlag && (described.name === ACCOUNT || described.name === CONTACT)) {
    kept.push(personFlag.name);
  }
  const file = isFile(described.name);
  if (file) {
    for (const witness of FILE_WITNESSES) {
      const field = byName.get(witness.toLowerCase());
      if (field) kept.push(field.name);
    }
  }
  const notKept = new Set(file ? FILE_SETTINGS_NOT_KEPT.map((name) => name.toLowerCase()) : []);
  const already = new Set(kept.map((name) => name.toLowerCase()));
  const candidates = described.fields
    .map((field) => field.name)
    .filter((name) => !already.has(name.toLowerCase()) && !notKept.has(name.toLowerCase()));

  const { writable, skipped, denied } = await guardOver(described).partitionWritableFields(
    described.name,
    'upsert',
    candidates,
  );
  const leftOutFields: LeftOutField[] = [];
  const reasonOf = new Map<string, LeftOutFieldReason>();
  for (const name of denied) reasonOf.set(name, 'fls');
  for (const name of skipped) {
    const field = byName.get(name.toLowerCase());
    if (field && isCompound(field)) reasonOf.set(name, 'compound');
  }
  const writableNames = new Set(writable);
  for (const name of writable) {
    const type = byName.get(name.toLowerCase())?.type;
    if (type === 'base64') reasonOf.set(name, 'base64');
    else if (type === ENCRYPTED_FIELD_TYPE && !options.viewsEncryptedData) {
      reasonOf.set(name, 'encrypted');
    }
  }
  // In the describe's order, as the org lists its fields.
  for (const name of candidates) {
    const reason = reasonOf.get(name);
    if (reason !== undefined) leftOutFields.push({ field: name, reason });
    else if (writableNames.has(name)) kept.push(name);
  }
  if (file) leftOutFields.push({ field: FILE_BODY, reason: 'base64' });
  return { fields: kept, leftOutFields };
}

/**
 * The reference fields of `child` whose parent's delete takes its records
 * along — master-detail fields and lookups that delete in cascade — as the
 * parents' describes list them: the field describe of a standard lookup such
 * as a contact's account does not say it, the account's child relationships
 * do.
 *
 * A record of such a field comes back from the recycle bin with its parent,
 * and goes with it. Only the fields `child`'s own describe lists are named:
 * one field-level security hides from the user cannot be read.
 *
 * @param describes - The objects described with it: a parent not among them
 *   names nothing.
 */
export function cascadeParentsOf(
  child: CheckpointDescribe,
  describes: Iterable<CheckpointDescribe>,
): string[] {
  const own = fieldsByName(child);
  const childName = child.name.toLowerCase();
  const fields = new Set<string>();
  for (const parent of describes) {
    for (const relationship of parent.childRelationships ?? []) {
      if (relationship.cascadeDelete !== true) continue;
      if (relationship.childSObject.toLowerCase() !== childName) continue;
      const field = own.get(relationship.field.toLowerCase());
      if (field) fields.add(field.name);
    }
  }
  return [...fields].sort();
}

/**
 * The reference fields of `child` whose parent the org refuses to delete
 * while a live record names it, and whose delete does not take the record
 * along — as the parents' describes list them: a case's account, seen live
 * on a scratch org. A rewind that deletes such a record and its parent must
 * delete the record first, and Salesforce then keeps it in the recycle bin
 * for good, which Undo cannot change. Only the fields `child`'s own describe
 * lists are named, as {@link cascadeParentsOf} names its own.
 *
 * @param describes - The objects described with it: a parent not among them
 *   names nothing.
 */
export function restrictParentsOf(
  child: CheckpointDescribe,
  describes: Iterable<CheckpointDescribe>,
): string[] {
  const own = fieldsByName(child);
  const childName = child.name.toLowerCase();
  const fields = new Set<string>();
  for (const parent of describes) {
    for (const relationship of parent.childRelationships ?? []) {
      if (relationship.restrictedDelete !== true || relationship.cascadeDelete === true) continue;
      if (relationship.childSObject.toLowerCase() !== childName) continue;
      const field = own.get(relationship.field.toLowerCase());
      if (field) fields.add(field.name);
    }
  }
  return [...fields].sort();
}

/** What a checkpoint records of one object before reading it. */
export interface ObjectCapture extends CaptureProjection {
  objectApiName: string;
  readMode: CheckpointReadMode;
  /**
   * Whether a record deleted on its own comes back on its own. Not said by
   * the describe is read as not: such a record is then expected back with its
   * parent, and an undo is told it may not bring it back, rather than promised.
   */
  undeletable: boolean;
  /** {@link cascadeParentsOf}. */
  cascadeParents: string[];
  /** {@link restrictParentsOf}. */
  restrictParents: string[];
}

/**
 * {@link captureProjection}, {@link readModeOf}, {@link cascadeParentsOf} and
 * {@link restrictParentsOf} of one object.
 */
export async function objectCapture(
  described: CheckpointDescribe,
  describes: Iterable<CheckpointDescribe>,
  options: CaptureOptions,
): Promise<ObjectCapture> {
  return {
    objectApiName: described.name,
    readMode: readModeOf(described.name),
    undeletable: described.undeletable === true,
    cascadeParents: cascadeParentsOf(described, describes),
    restrictParents: restrictParentsOf(described, describes),
    ...(await captureProjection(described, options)),
  };
}

/**
 * The fields of `objectApiName` its owner chose not to compare, in lower case:
 * the checkpoint's `ignoredFields` name them `Object.Field`.
 */
export function ignoredFieldsOf(
  objectApiName: string,
  ignoredFields: readonly string[],
): ReadonlySet<string> {
  const object = objectApiName.toLowerCase();
  const ignored = new Set<string>();
  for (const entry of ignoredFields) {
    const dot = entry.indexOf('.');
    if (dot <= 0 || dot === entry.length - 1) continue;
    if (entry.slice(0, dot).toLowerCase() !== object) continue;
    ignored.add(entry.slice(dot + 1).toLowerCase());
  }
  return ignored;
}

/**
 * Whether a column of a snapshot of `objectApiName` is a value a rewind
 * compares, rather than a stamp, the person flag or a file's witness.
 */
function isValueColumn(objectApiName: string, field: string): boolean {
  const name = field.toLowerCase();
  return (
    name !== PERSON_ACCOUNT_FLAG.toLowerCase() &&
    !SNAPSHOT_STAMPS.some((stamp) => stamp.toLowerCase() === name) &&
    !witnessesOf(objectApiName).has(name)
  );
}

/**
 * The fields of a snapshot a comparison with the org reads: its values, less
 * the stamps, the person flag and a file's witnesses, and less the fields its
 * owner chose not to compare — those an automation sets again on every save
 * would otherwise keep every rewind partial.
 */
export function comparedFields(
  objectApiName: string,
  snapshotFields: readonly string[],
  ignoredFields: readonly string[],
): string[] {
  const ignored = ignoredFieldsOf(objectApiName, ignoredFields);
  return snapshotFields.filter(
    (field) => isValueColumn(objectApiName, field) && !ignored.has(field.toLowerCase()),
  );
}

/** Why a rewind does not write a field of a snapshot back. */
export type NotWrittenReason = 'ignored' | 'notPresent' | 'notUpdateable' | 'fls' | 'encrypted';

/** The fields a rewind may write back to one object, and the rest of the snapshot's with why. */
export interface RestoreAllowList {
  fields: string[];
  notWritten: Array<{ field: string; reason: NotWrittenReason }>;
}

/** What {@link restoreAllowList} decides from. */
export interface RestoreAllowListInput {
  objectApiName: string;
  /** The columns the snapshot holds of it. */
  snapshotFields: readonly string[];
  /** Its describe now, as the user the rewind writes as reads it. */
  described: CheckpointDescribe;
  /** The checkpoint's `ignoredFields`. */
  ignoredFields: readonly string[];
  /** Whether that user reads classic encrypted fields in clear now. */
  viewsEncryptedData: boolean;
}

/**
 * The fields a rewind may write back to one object: those of the snapshot the
 * org still has, that the user may edit, that its owner did not choose to
 * stop comparing, and, of a classic encrypted field, only one the user reads
 * in clear — read masked, its value now would be compared with the
 * checkpoint's as a difference, kept masked as the value from before the
 * rewind, and written back so by an undo.
 *
 * It is the list a give-back reads the org's values by and writes by: a
 * snapshot row carries `attributes` and its stamps, and a restore that took
 * every key of a row put them in its query and its update.
 */
export async function restoreAllowList(input: RestoreAllowListInput): Promise<RestoreAllowList> {
  const ignored = ignoredFieldsOf(input.objectApiName, input.ignoredFields);
  const byName = fieldsByName(input.described);
  const notWritten: RestoreAllowList['notWritten'] = [];
  const present: string[] = [];
  for (const field of input.snapshotFields) {
    if (!isValueColumn(input.objectApiName, field)) continue;
    if (ignored.has(field.toLowerCase())) notWritten.push({ field, reason: 'ignored' });
    // Deleted since, or hidden since by field-level security: the describe
    // lists neither, and the org refuses a query or an update that names it.
    else if (!byName.has(field.toLowerCase())) notWritten.push({ field, reason: 'notPresent' });
    else present.push(field);
  }
  const { writable, skipped, denied } = await guardOver(input.described).partitionWritableFields(
    input.described.name,
    'update',
    present,
  );
  const reasonOf = new Map<string, NotWrittenReason>();
  for (const field of skipped) reasonOf.set(field, 'notUpdateable');
  // A field the user may set on a new record but not change on one that
  // exists is no field-level security: the org lets no one change it.
  for (const field of denied) {
    const createable = byName.get(field.toLowerCase())?.createable === true;
    reasonOf.set(field, createable ? 'notUpdateable' : 'fls');
  }
  for (const field of writable) {
    const type = byName.get(field.toLowerCase())?.type;
    if (type === ENCRYPTED_FIELD_TYPE && !input.viewsEncryptedData) {
      reasonOf.set(field, 'encrypted');
    }
  }
  const fields: string[] = [];
  for (const field of present) {
    const reason = reasonOf.get(field);
    if (reason === undefined) fields.push(field);
    else notWritten.push({ field, reason });
  }
  return { fields, notWritten };
}

/**
 * Whether a snapshot row of `objectApiName` is a person account's contact.
 *
 * Salesforce neither creates nor deletes one on its own: "You can modify a
 * person contact but you can't create or delete a person contact … Instead,
 * delete or modify the account" (SOAP API Developer Guide, "Person Account
 * Record Types"). A rewind counts it with its account, which alone it
 * deletes, brings back, or gives its person fields back.
 */
export function isPersonContact(objectApiName: string, row: Record<string, unknown>): boolean {
  return objectApiName === CONTACT && isPersonAccountRow(row);
}

/**
 * The part of a snapshot row a rewind writes back: its id, and the fields of
 * `allowList` the row holds, less what its kind of account cannot hold — a
 * business account's person fields, a person account's name, which the org
 * computes — told by the flag the row was kept with.
 *
 * Nothing else of the row goes: not its `attributes`, not its stamps, not a
 * field the org has lost since.
 */
export function rowToWriteBack(
  objectApiName: string,
  row: Record<string, unknown>,
  allowList: readonly string[],
): Record<string, unknown> {
  const kind = objectApiName === ACCOUNT ? accountKindOf(row, false) : undefined;
  const written: Record<string, unknown> = {};
  if (typeof row.Id === 'string') written.Id = row.Id;
  for (const field of allowList) {
    if (!(field in row)) continue;
    if (kind !== undefined && leftOutForAccountKind(ACCOUNT, field, kind)) continue;
    written[field] = row[field];
  }
  return written;
}
