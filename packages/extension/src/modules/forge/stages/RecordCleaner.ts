/**
 * Record cleaning stage of the Forge execution pipeline.
 *
 * Turns raw source-org records into insert-ready payloads: remaps lookup
 * IDs through the {@link IdRemapper}, nullifies orphaned FKs (tracked for
 * the pass-2 cycle UPDATE), applies per-object owner remaps, field
 * exclusions and source→target renames, strips non-createable fields,
 * drops cross-org picklist values the target org rejects, and removes
 * Person Account `__pc` fields from business accounts.
 *
 * `null` values produced by orphan nullification are omitted from the
 * payload entirely — Salesforce treats explicit `null` on required fields
 * as "set to null" (rejected) rather than "use default", so omitting lets
 * the platform auto-fill OwnerId etc.
 */

import type { FieldInfo, ForgeExecutorDeps } from '../ForgeExecutor.js';
import type { IdRemapper } from '../IdRemapper.js';
import { exclusiveFieldsToDrop, isUncopyableObject } from '@sandforge/shared';
import { isExcludedFromCopy } from '../excludedObjects.js';

/** Sample of a field that was nullified during clean (used by 2-pass cycle UPDATE). */
export interface NullifiedFk {
  /** Field API name on the cloned record (e.g. `AccountId`). */
  field: string;
  /** Source-org ID that the FK pointed to before nullification. */
  sourceRefId: string;
  /** Target objects this FK can reference (for polymorphic awareness). */
  targetObjects: string[];
}

/** A source record paired with its cleaned, insert-ready payload. */
export interface CleanedRecord {
  /** The original source-org record (pre-remap) — used for source-ID lookup. */
  source: Record<string, unknown>;
  /** The cleaned payload sent to the target org. */
  cleaned: Record<string, unknown>;
  /** FKs that were nullified — used by 2-pass cycle UPDATE. */
  nullifiedFks: NullifiedFk[];
}

/** Field sets derived from the *target* org describe (schema-drift defense). */
export interface TargetFieldSets {
  /** Fields createable on the target org. */
  creatable: Set<string>;
  /**
   * Active picklist value whitelists per field, or `null` when the target
   * describe surfaced no restricted picklists (no validation applied).
   */
  picklistValuesByField: Map<string, Set<string>> | null;
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
  const targetFields = await describeFields(targetOrgId, objectApiName);
  const creatable = new Set(targetFields.filter((f) => f.createable).map((f) => f.name));
  // Collect picklist value whitelists for cross-org strip.
  const pmap = new Map<string, Set<string>>();
  for (const f of targetFields) {
    if (f.picklistValues && f.picklistValues.length > 0) {
      pmap.set(f.name, new Set(f.picklistValues));
    }
  }
  return { creatable, picklistValuesByField: pmap.size > 0 ? pmap : null };
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
  /** Target-org picklist whitelists (null = no validation). */
  picklistValuesByField: Map<string, Set<string>> | null;
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
    ownerMappings,
    excludedFields,
    fieldRename,
    creatableFields,
    picklistValuesByField,
  } = input;
  const lookupFields = fieldInfos.filter((f) => f.isReference).map((f) => f.name);
  /**
   * Lookups whose every target is an object no clone creates — one the
   * platform will not take as data, or one every copy leaves out. Computed
   * once per node rather than per record. The second list was missing: run
   * for real, an Opportunity's `LastAmountChangedHistoryId` waited for an
   * `OpportunityHistory` no wave would ever write, and pass 2 reported it
   * unresolved on every clone.
   */
  const uncopyableLookups = new Set(
    fieldInfos
      .filter(
        (f) =>
          f.isReference &&
          (f.referenceTo?.length ?? 0) > 0 &&
          (f.referenceTo ?? []).every(
            (target) => isUncopyableObject(target) || isExcludedFromCopy(target),
          ),
      )
      .map((f) => f.name),
  );

  return records.map((r) => {
    // Identify orphan FKs from the ORIGINAL record (pre-remap) so we
    // don't confuse already-remapped target IDs with unmapped sources.
    const nullifiedFks: NullifiedFk[] = [];
    if (referenceFallback === 'nullify') {
      for (const field of fieldInfos) {
        if (!field.isReference) continue;
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
        if (remapper.get(value)) continue;
        nullifiedFks.push({
          field: field.name,
          sourceRefId: value,
          targetObjects: field.referenceTo ?? [],
        });
      }
    }
    // RecordTypeId is owned by RecordTypeMapper (target-org name lookup).
    // Filter from generic remap so source-org RT IDs are not rewritten
    // to *some other* unrelated target ID accidentally cached in the
    // remapper from prior inserts.
    const remapLookupFields = lookupFields.filter((n) => n !== 'RecordTypeId');
    const remapped = remapper.remapRecord(r, remapLookupFields);
    for (const nf of nullifiedFks) {
      remapped[nf.field] = null;
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
    // Coerce IsPersonAccount: jsforce sometimes returns boolean,
    // sometimes the SOAP-normalized string 'true'. Strict === true
    // missed the string case → __pc fields stripped from real
    // person accounts, breaking the insert.
    const ipa = remapped['IsPersonAccount'];
    const isPersonAccount = ipa === true || ipa === 'true' || ipa === 1;
    const cleaned: Record<string, unknown> = {};
    for (const key of Object.keys(remapped)) {
      if (excludedFields.has(key)) continue;
      // Field-mapping path: if the source field is renamed on target,
      // bypass the createable check on the source name and write under
      // the mapped name (which also has to be a real createable target
      // field — the executor doesn't validate the target side; that's
      // the user's responsibility per the field-map contract).
      const renamedTo = fieldRename[key];
      if (renamedTo) {
        cleaned[renamedTo] = remapped[key];
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
      // Person Account `Name` is auto-computed from FirstName/LastName.
      // Salesforce rejects an explicit `Name` value with
      // INVALID_FIELD_FOR_INSERT_UPDATE: Unable to create/update fields: Name.
      if (key === 'Name' && isPersonAccount) continue;
      const value = remapped[key];
      if (value === null) continue;
      // Cross-org picklist value validation — drop values the target
      // org's restricted picklist doesn't accept (avoids
      // INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST on insert).
      if (
        picklistValuesByField &&
        typeof value === 'string' &&
        picklistValuesByField.has(key) &&
        !picklistValuesByField.get(key)!.has(value)
      ) {
        continue;
      }
      cleaned[key] = value;
    }
    // Two fields the describe calls createable that the platform accepts
    // one of. Nothing in the metadata says so, so this is the only place
    // that can know it.
    for (const field of exclusiveFieldsToDrop(objectApiName, cleaned)) {
      delete cleaned[field];
    }
    return { source: r, cleaned, nullifiedFks };
  });
}
