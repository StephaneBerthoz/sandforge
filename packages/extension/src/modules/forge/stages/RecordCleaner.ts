/**
 * Record cleaning stage of the Forge execution pipeline.
 *
 * Turns raw source-org records into insert-ready payloads: remaps lookup
 * IDs through the {@link IdRemapper}, nullifies orphaned FKs (tracked for
 * the pass-2 cycle UPDATE), applies per-object owner remaps, field
 * exclusions and source→target renames, strips non-createable fields,
 * replaces or drops the picklist values the target org would refuse — for
 * the row's record type, when it is known there (`RecordTypePicklists.ts`) —
 * and removes Person Account `__pc` fields from business accounts.
 *
 * `null` values produced by orphan nullification are omitted from the
 * payload entirely — Salesforce treats explicit `null` on required fields
 * as "set to null" (rejected) rather than "use default", so omitting lets
 * the platform auto-fill OwnerId etc.
 */

import type { FieldInfo, ForgeExecutorDeps } from '../ForgeExecutor.js';
import type { IdRemapper } from '../IdRemapper.js';
import { exclusiveFieldsToDrop } from '@sandforge/shared';
import { lookupsAtObjectsLeftOut } from '../excludedObjects.js';
import {
  isPersonAccountRow,
  lookupsThePlatformFills,
} from '../../../core/common/platformRecords.js';
import {
  checkRowPicklists,
  picklistFieldsOf,
  type PicklistChange,
  type PicklistField,
  type RecordTypeValues,
} from './RecordTypePicklists.js';
import type { ContactPointNeutralizer } from './ContactPointNeutralizer.js';

/** Sample of a field that was nullified during clean (used by 2-pass cycle UPDATE). */
export interface NullifiedFk {
  /**
   * Field API name on the cloned record (e.g. `AccountId`), as the target has
   * it: the name a field map writes it under, where the user renamed it.
   */
  field: string;
  /** Source-org ID that the FK pointed to before nullification. */
  sourceRefId: string;
  /** Target objects this FK can reference (for polymorphic awareness). */
  targetObjects: string[];
  /**
   * Set when only an insert sets the field in the target: the second pass
   * cannot fill it in, and says it is left empty instead of sending an update
   * the platform refuses. See `isInsertOnlyField` in shared.
   */
  insertOnly?: true;
}

/** A source record paired with its cleaned, insert-ready payload. */
export interface CleanedRecord {
  /** The original source-org record (pre-remap) — used for source-ID lookup. */
  source: Record<string, unknown>;
  /** The cleaned payload sent to the target org. */
  cleaned: Record<string, unknown>;
  /** FKs that were nullified — used by 2-pass cycle UPDATE. */
  nullifiedFks: NullifiedFk[];
  /**
   * Picklist values the payload does not carry as read, the target being bound
   * to refuse them. Always set by {@link cleanNodeRecords}; absent, there were none.
   */
  picklistChanges?: PicklistChange[];
}

/** Field sets derived from the *target* org describe (schema-drift defense). */
export interface TargetFieldSets {
  /** Fields createable on the target org. */
  creatable: Set<string>;
  /**
   * Fields an update can set on the target org, as the user the run writes as
   * sees them: what the second pass may fill in. A field the describe does
   * not say of reads as one it can, as `FieldInfo.updateable` does.
   */
  updateable: Set<string>;
  /**
   * Active picklist value whitelists per field, or `null` when the target
   * describe surfaced no restricted picklists (no validation applied).
   */
  picklistValuesByField: Map<string, Set<string>> | null;
  /**
   * The target's picklist fields, by name: which are restricted, multi-select,
   * required, and dependent on which field. Empty when the object has none.
   */
  picklistFields: Map<string, PicklistField>;
  /**
   * The target's describe of the object, every field with what it says of the
   * values each takes: what a simulation checks the rows against, and what a
   * text is cut to when the user chose to cut it.
   */
  fields: readonly FieldInfo[];
}

/**
 * The createable and updateable field sets of a target describe, and the
 * picklist value whitelists used for cross-org strip: what the run's rows and
 * a parent copied from outside the graph are both checked against.
 *
 * @param objectApiName - The object described, which says of some picklists
 *   how their values are checked (`picklistFieldsOf`).
 */
export function targetFieldSetsOf(
  targetFields: readonly FieldInfo[],
  objectApiName?: string,
): TargetFieldSets {
  const creatable = new Set(targetFields.filter((f) => f.createable).map((f) => f.name));
  const updateable = new Set(targetFields.filter((f) => f.updateable !== false).map((f) => f.name));
  // Collect picklist value whitelists for cross-org strip.
  const pmap = new Map<string, Set<string>>();
  for (const f of targetFields) {
    if (f.picklistValues && f.picklistValues.length > 0) {
      pmap.set(f.name, new Set(f.picklistValues));
    }
  }
  return {
    creatable,
    updateable,
    picklistValuesByField: pmap.size > 0 ? pmap : null,
    picklistFields: picklistFieldsOf(targetFields, objectApiName),
    fields: targetFields,
  };
}

/**
 * Describe the target org and derive the createable-field set plus the
 * picklist value whitelists used for cross-org strip. Throws when the
 * describe fails — the caller surfaces the error and falls back to the
 * source schema.
 */
export async function describeTargetFieldSets(
  describeFields: ForgeExecutorDeps['describeFields'],
  targetOrgId: string,
  objectApiName: string,
): Promise<TargetFieldSets> {
  return targetFieldSetsOf(await describeFields(targetOrgId, objectApiName), objectApiName);
}

/**
 * Whether an update in the target can set a field: what the second pass may
 * fill in. Read from the target's describe where the run has it — the update
 * goes as the user the run writes as — and from the source's otherwise, a
 * flag the describe does not give reading as one it can.
 *
 * Read from the source alone, a lookup the user the run reads as may not
 * edit and the one it writes as may was never filled in; one the target's
 * user may not edit was sent in an update the target refused, which took the
 * row's other lookups of that update down with it.
 *
 * @param targetUpdatable - `TargetFieldSets.updateable`, when the target was described.
 * @param writtenAs - The name a field map writes the field under, when it renames it.
 */
export function updatableInTarget(
  field: Pick<FieldInfo, 'name' | 'updateable'>,
  targetUpdatable: ReadonlySet<string> | undefined,
  writtenAs?: string,
): boolean {
  return targetUpdatable
    ? targetUpdatable.has(writtenAs ?? field.name)
    : field.updateable !== false;
}

/**
 * Intersection of two sets — used to take the safe subset of fields that
 * exist as createable on BOTH the source and target orgs (defends against
 * schema drift between sandboxes).
 */
export function intersect(a: Set<string>, b: Set<string>): Set<string> {
  const result = new Set<string>();
  for (const v of a) {
    if (b.has(v)) result.add(v);
  }
  return result;
}

/** Inputs for {@link cleanNodeRecords}. */
export interface CleanNodeRecordsInput {
  /** SObject these records belong to — used for per-object platform rules. */
  objectApiName: string;
  /** Raw records queried from the source org. */
  records: Record<string, unknown>[];
  /** Source-org field metadata for the node. */
  fieldInfos: FieldInfo[];
  /** Source→target ID mappings accumulated so far. */
  remapper: IdRemapper;
  /** Orphan-FK handling for this execution. */
  referenceFallback: 'nullify' | 'keep';
  /**
   * Objects that failed in this run. A lookup that can point at one of them
   * and names no record the run wrote is emptied and listed, whatever
   * `referenceFallback` says — see {@link cleanNodeRecords}.
   */
  failedObjects?: ReadonlySet<string>;
  /**
   * Objects this run writes, or links to records the target holds. A lookup
   * that can point at one of them only and names no record the run has
   * written yet is emptied, and filled in by the second pass, whatever
   * `referenceFallback` says — see {@link cleanNodeRecords}.
   */
  writtenObjects?: ReadonlySet<string>;
  /** Per-object owner remap (source `OwnerId` → target `OwnerId`). */
  ownerMappings: Record<string, string>;
  /** Field exclusions resolved for this node. */
  excludedFields: ReadonlySet<string>;
  /** Source→target field rename map resolved for this node. */
  fieldRename: Record<string, string>;
  /**
   * Effective createable set — source describe intersected with the target
   * describe when available (schema-drift defense).
   */
  creatableFields: ReadonlySet<string>;
  /**
   * Fields an update can set in the target, from its describe: what the
   * second pass may fill in (`TargetFieldSets.updateable`). Absent — the
   * target's describe failed — the source's describe says it of each field.
   */
  updatableFields?: ReadonlySet<string>;
  /** Target-org picklist whitelists (null = no validation). */
  picklistValuesByField: Map<string, Set<string>> | null;
  /** The target's picklist fields; absent, none is known restricted, multi-select or dependent. */
  picklistFields?: ReadonlyMap<string, PicklistField>;
  /**
   * What the record type each row goes in with allows of the object's
   * picklists, by `RecordTypeId` as the row was read: a row whose record type
   * is not here has its values checked against the values of each field.
   */
  recordTypeValues?: ReadonlyMap<string, RecordTypeValues>;
  /**
   * The rows of person accounts the target takes as business accounts: it has
   * no person accounts, or the record type a row gets there is a business
   * account's (`takenAsBusinessAccounts` in the executor). Taken so, a row
   * keeps its name — the platform computes none for it, and refused it
   * without one — and goes without the fields only a person account holds
   * (`isPersonAccountField`). Absent, every person account goes in as one,
   * its computed name left out.
   */
  businessAccounts?: ReadonlySet<Record<string, unknown>>;
  /**
   * What makes the email addresses and phone numbers of the rows unreachable
   * before they are written (`ContactPointNeutralizer`). Absent, they go as
   * the source holds them: the run was told to keep them.
   */
  contactPoints?: ContactPointNeutralizer;
  /**
   * The user's decisions on the row once it is whole and before its picklist
   * values are checked: a value mapped to another or left out, a default
   * given to a field it leaves empty (`RunDecisions.applyToRow`). Changes the
   * row in place.
   *
   * @param recordTypeId - The row's `RecordTypeId` as it was read.
   */
  decide?: (row: Record<string, unknown>, recordTypeId: string | undefined) => void;
}

/** The name parts only a person account holds; `Salutation` "is available on person accounts". */
const PERSON_NAME_FIELDS: ReadonlySet<string> = new Set([
  'FirstName',
  'LastName',
  'MiddleName',
  'Suffix',
  'Salutation',
]);

/**
 * Whether only a person account holds a field of an account: its name parts,
 * the standard fields named `Person…`, and the custom fields of its contact
 * (`__pc`). "If the IsPersonAccount field has the value false, the following
 * fields have a null value and can't be modified" (Object Reference for the
 * Salesforce Platform, Account, IsPersonAccount Fields): sent with a business
 * account, they were refused with it.
 */
export function isPersonAccountField(name: string): boolean {
  return (
    PERSON_NAME_FIELDS.has(name) ||
    name.endsWith('__pc') ||
    (name.startsWith('Person') && !name.includes('__'))
  );
}

/**
 * Build cleaned records for insert. Strip non-createable fields, omit
 * nullified orphan FKs, and remove Person Account `__pc` fields when the
 * record itself isn't a Person Account.
 *
 * RecordTypeId is *not* rewritten here — it is owned by RecordTypeMapper
 * (target-org name lookup), applied by the caller right after this stage.
 */
export function cleanNodeRecords(input: CleanNodeRecordsInput): CleanedRecord[] {
  const {
    objectApiName,
    records,
    fieldInfos,
    remapper,
    referenceFallback,
    failedObjects,
    writtenObjects,
    ownerMappings,
    excludedFields,
    fieldRename,
    creatableFields,
    updatableFields,
    picklistValuesByField,
    picklistFields,
    recordTypeValues,
    businessAccounts,
    contactPoints,
    decide,
  } = input;
  const lookupFields = fieldInfos.filter((f) => f.isReference).map((f) => f.name);
  const neutralize = contactPoints?.forObject(objectApiName, fieldInfos, fieldRename);
  /** Whether the insert carries a lookup: createable in both orgs, or written under a rename. */
  const carriedAtInsert = (field: FieldInfo): boolean =>
    creatableFields.has(field.name) || fieldRename[field.name] !== undefined;
  /**
   * Lookups that can point at an object that failed in this run: emptied, when
   * they name no record the run wrote, whatever `referenceFallback` says.
   *
   * `'keep'` carries an id the run has no counterpart for as it is, because
   * two sandboxes refreshed from the same production can share it. An object
   * that failed in this run is not such a case: the run set out to write its
   * records and could not, so an id of one names in the target either nothing
   * — and the whole row is refused with it — or a record other than the one
   * the run meant to write. Emptied, the row goes in, and the second pass
   * reports the lookup it could not fill in, as it does in a record-scoped run.
   */
  const lookupsAtFailed = new Set(
    fieldInfos
      .filter((f) => f.isReference && (f.referenceTo ?? []).some((o) => failedObjects?.has(o)))
      .map((f) => f.name),
  );
  /**
   * Lookups at one object, which this run writes: emptied when they name no
   * record the run has written yet, and filled in by the second pass once it
   * has, whatever `referenceFallback` says.
   *
   * `'keep'` carries the id of a record the run does not write, which a
   * sandbox refreshed from the same production can share with the source. A
   * record the run writes is not such a case. A cycle's lookup at a record
   * written after it, sent as it was read, named in such a sandbox the
   * target's own record and not the copy the run wrote — which every other
   * lookup of the copies points at — and in any other target nothing, which
   * cost the whole row. A lookup that can point at several objects is left
   * to `referenceFallback`: its id can name a record of any of them.
   */
  const lookupsAtWritten = new Set(
    fieldInfos
      .filter((f) => {
        const targets = f.referenceTo ?? [];
        return f.isReference && targets.length === 1 && writtenObjects?.has(targets[0]) === true;
      })
      .map((f) => f.name),
  );
  /**
   * Lookups whose every target is an object no clone creates — one the
   * platform will not take as data, or one every copy leaves out. Computed
   * once per node rather than per record. The second list was missing: run
   * for real, an Opportunity's `LastAmountChangedHistoryId` waited for an
   * `OpportunityHistory` no wave would ever write, and pass 2 reported it
   * unresolved on every clone.
   */
  const uncopyableLookups = lookupsAtObjectsLeftOut(fieldInfos.filter((f) => f.isReference));
  const targetPicklists = picklistFields ?? new Map<string, PicklistField>();

  return records.map((r) => {
    // Identify orphan FKs from the ORIGINAL record (pre-remap) so we
    // don't confuse already-remapped target IDs with unmapped sources.
    const nullifiedFks: NullifiedFk[] = [];
    /** The fields of `nullifiedFks` by the name the row was read with. */
    const nullifiedAsRead: string[] = [];
    for (const field of fieldInfos) {
      if (!field.isReference) continue;
      // Excluded by the user, a field is never written: neither at insert nor
      // by the second pass, which filled it in once its record came after.
      if (excludedFields.has(field.name)) continue;
      // A lookup no write of the run can set is the platform's to fill — a
      // person account's contact, a quote's account read from its
      // opportunity — or one the user the run writes as may not set. It goes
      // neither at insert nor in the second pass: owed there, it was sent in
      // an update the platform refuses, or reported as a lookup left empty
      // when the record the platform filled it with was in place.
      const carried = carriedAtInsert(field);
      const updatable = updatableInTarget(field, updatableFields, fieldRename[field.name]);
      if (!carried && !updatable) continue;
      if (
        referenceFallback !== 'nullify' &&
        !lookupsAtFailed.has(field.name) &&
        !lookupsAtWritten.has(field.name)
      ) {
        continue;
      }
      if (field.name === 'RecordTypeId') continue;
      // A lookup at something no clone creates is not an orphan waiting
      // for its parent: no wave will ever produce that parent, so pass 2
      // can only report it as unresolved for ever. Run for real, a single
      // Opportunity produced three such reports — OwnerId, CreatedById and
      // LastModifiedById, all pointing at a User — for a record that was
      // written correctly. Left out of the list, the field is dropped
      // below and the platform fills it in.
      if (uncopyableLookups.has(field.name)) continue;
      const value = r[field.name];
      if (typeof value !== 'string' || !value) continue;
      // Named by a record the run has written, the lookup goes with the row —
      // unless the insert cannot carry it, the user the run reads as not
      // allowed to set it: the update the target allows is then owed it.
      if (carried && remapper.get(value)) continue;
      nullifiedAsRead.push(field.name);
      nullifiedFks.push({
        // Owed under the name the target has: a field map writes the lookup
        // under its own, and the second pass sent the source's name, which
        // the target may not have, or may give to another field.
        field: fieldRename[field.name] ?? field.name,
        sourceRefId: value,
        targetObjects: field.referenceTo ?? [],
        // Written with the row or never: the second pass, which cannot fill
        // it in, says it is left empty rather than send what is refused.
        ...(updatable ? {} : { insertOnly: true as const }),
      });
    }
    // RecordTypeId is owned by RecordTypeMapper (target-org name lookup).
    // Filter from generic remap so source-org RT IDs are not rewritten
    // to *some other* unrelated target ID accidentally cached in the
    // remapper from prior inserts.
    const remapLookupFields = lookupFields.filter((n) => n !== 'RecordTypeId');
    const remapped = remapper.remapRecord(r, remapLookupFields);
    for (const field of nullifiedAsRead) {
      remapped[field] = null;
    }
    // Apply per-object owner remap (BA need: clone records authored by
    // ex-employees onto a sandbox where their User no longer exists).
    // Only applies to OwnerId — the generic remapper doesn't see User
    // FKs because Users aren't in the cloned graph.
    const sourceOwner = remapped['OwnerId'];
    // Whether an explicit owner mapping resolved this record's owner. The
    // lookup below has to ask this rather than re-read the source value: the
    // mapping is keyed on what the remapper produced, not on what was read.
    let ownerResolved = false;
    if (typeof sourceOwner === 'string' && ownerMappings[sourceOwner]) {
      remapped['OwnerId'] = ownerMappings[sourceOwner];
      ownerResolved = true;
    }
    // Read as every stage reads it: jsforce sometimes returns the flag as a
    // boolean, sometimes as the SOAP-normalized string 'true', and a strict
    // `=== true` stripped the `__pc` fields of real person accounts.
    const isPersonAccount = isPersonAccountRow(remapped);
    // A person account the target takes as a business account goes in as one.
    const asBusiness = isPersonAccount && businessAccounts?.has(r) === true;
    const cleaned: Record<string, unknown> = {};
    // Written under a rename: the field map answers for what the target takes.
    const renamed = new Set<string>();
    for (const key of Object.keys(remapped)) {
      if (excludedFields.has(key)) continue;
      // Field-mapping path: if the source field is renamed on target,
      // bypass the createable check on the source name and write under
      // the mapped name (which also has to be a real createable target
      // field — the executor doesn't validate the target side; that's
      // the user's responsibility per the field-map contract). No value is
      // no value under either name: a lookup emptied for the second pass
      // went as an explicit `null`.
      const renamedTo = fieldRename[key];
      if (renamedTo) {
        if (remapped[key] !== null) cleaned[renamedTo] = remapped[key];
        renamed.add(renamedTo);
        continue;
      }
      if (!creatableFields.has(key)) continue;
      /*
       * A lookup that can only ever point at something a clone never creates
       * — `OwnerId` at a `User`, and the other provisioning and metadata
       * objects — is dropped rather than carried. It cannot be remapped by
       * construction, and carrying it sends the target org an id from the
       * source: on a real run, `OwnerId` is what made the second pass report
       * "cycle FK could not be resolved" and lose the record. Dropped, the
       * platform fills it in — `OwnerId` becomes the running user, which is
       * what seeding a sandbox wants. An explicit owner mapping is applied
       * above and survives, because by then the value is a target id.
       *
       * `referenceFallback: 'keep'` is left alone: it is a caller saying to
       * carry ids across as they are, which is meaningful when the two orgs
       * are the same one. This rule answers a different question — a lookup
       * whose target can never be in the graph, rather than one whose target
       * was in it and was not cloned — and conflating the two is what broke
       * three of that option's tests when it did not make the distinction.
       */
      if (
        // `RecordTypeId` names an object no clone creates, and has its own
        // resolution all the same: RecordTypeMapper looks the type up by name
        // in the target org. The nullify loop above exempts it for the same
        // reason, and this rule forgot to until three of its tests said so.
        key !== 'RecordTypeId' &&
        referenceFallback !== 'keep' &&
        uncopyableLookups.has(key) &&
        !(key === 'OwnerId' && ownerResolved)
      ) {
        continue;
      }
      // Person Account `__pc` fields are not valid on Business Accounts.
      if (key.endsWith('__pc') && !isPersonAccount) continue;
      // Nor is any field only a person account holds, on one the target
      // takes as a business account.
      if (asBusiness && isPersonAccountField(key)) continue;
      // Person Account `Name` is auto-computed from FirstName/LastName.
      // Salesforce rejects an explicit `Name` value with
      // INVALID_FIELD_FOR_INSERT_UPDATE: Unable to create/update fields: Name.
      // Taken as a business account, the row gets no computed name, and the
      // target refuses it without one.
      if (key === 'Name' && isPersonAccount && !asBusiness) continue;
      const value = remapped[key];
      if (value === null) continue;
      cleaned[key] = value;
    }
    // Picklist values the target would refuse at insert, with
    // INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: checked once the row is whole,
    // a dependent value against its controlling value as written.
    // `RecordTypeId` is still the source's here, which is what
    // `recordTypeValues` is keyed by.
    const recordTypeId = cleaned['RecordTypeId'];
    // What the user decided of the row's values comes first: a value mapped
    // to one the target still refuses is checked as any other.
    decide?.(cleaned, typeof recordTypeId === 'string' ? recordTypeId : undefined);
    const picklistChanges = checkRowPicklists(
      cleaned,
      picklistValuesByField,
      targetPicklists,
      typeof recordTypeId === 'string' ? recordTypeValues?.get(recordTypeId) : undefined,
      renamed,
    );
    // Two fields the describe calls createable that the platform accepts
    // one of. Nothing in the metadata says so, so this is the only place
    // that can know it.
    for (const field of exclusiveFieldsToDrop(objectApiName, cleaned)) {
      delete cleaned[field];
    }
    // A lookup the platform fills in itself goes neither now nor in the
    // second pass: an email's task, which it refuses from a copy and creates
    // with the email. See `lookupsThePlatformFills`.
    const filled = lookupsThePlatformFills(objectApiName, cleaned);
    for (const field of filled) delete cleaned[field];
    neutralize?.(cleaned);
    return {
      source: r,
      cleaned,
      nullifiedFks: nullifiedFks.filter((nf) => !filled.includes(nf.field)),
      picklistChanges,
    };
  });
}
