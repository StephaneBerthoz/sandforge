/**
 * Core data structures of the Frozen Reference Dataset engine.
 *
 * Two dataset shapes exist:
 *
 *  - {@link ExtractedDataset}: raw records pulled from the source org.
 *    Field values still hold source data and source IDs; records are
 *    already keyed by a stable `referenceId`. This shape NEVER leaves the
 *    sas (quarantine zone outside the repo).
 *  - {@link FrozenDataset}: the pseudonymized, versionable artifact.
 *    Records carry `referenceId`s, in-scope lookups hold `referenceId`s
 *    (not source IDs), RecordTypeId fields hold the RecordType *Name*.
 *
 * The load-phase contract (spec §6-7, implemented by another agent) is
 * expressed here as extension-point interfaces — intentionally not
 * implemented by the core engine.
 */

/** A raw record as extracted from the source org, keyed by referenceId. */
export interface ExtractedRecord {
  /**
   * Stable synthetic identifier (`<ObjectApiName>-NNNNNN`, assigned in
   * source-ID-sorted order so identical exports produce identical ids —
   * spec pitfall 7). This is the ONLY join key allowed in the sas and in
   * the frozen dataset.
   */
  referenceId: string;
  /** Source-org record ID. Working data: sas-only, never frozen. */
  sourceId: string;
  /** Field values exactly as queried (source values, source lookup IDs). */
  fields: Record<string, unknown>;
}

/** Raw extraction result for one object. */
export interface ExtractedObjectData {
  objectApiName: string;
  records: ExtractedRecord[];
}

/** One entry of `rt-map.json` produced at extraction (spec §2). */
export interface RecordTypeMapEntry {
  /** Source-org RecordType ID (sas-only). */
  id: string;
  sobjectType: string;
  developerName: string;
  /** UI label — what anonymized RecordTypeId fields carry. */
  name: string;
}

/** Raw extraction result — sas-only working data. */
export interface ExtractedDataset {
  objects: ExtractedObjectData[];
  /**
   * Frozen date bound applied to every extraction query
   * (`CreatedDate <= asOf` — see FrozenDatasetExtractor docs for why a
   * CreatedDate bound is the SOQL-feasible "AS OF").
   */
  asOf: string;
  /** RecordType map captured at extraction time. */
  recordTypeMap: RecordTypeMapEntry[];
}

/** A pseudonymized record of the frozen dataset. */
export interface FrozenRecord {
  /** Stable synthetic identifier — the join key the load phase persists. */
  referenceId: string;
  /**
   * Pseudonymized field values. In-scope lookups carry the target
   * record's `referenceId`; `RecordTypeId` carries the RecordType Name.
   */
  fields: Record<string, unknown>;
}

/** Pseudonymized records for one object. */
export interface FrozenObjectData {
  objectApiName: string;
  records: FrozenRecord[];
}

/**
 * RecordType reference carried by the frozen dataset so the load phase
 * can resolve target-org IDs *by DeveloperName* (never by label —
 * spec pitfall 1).
 */
export interface FrozenRecordTypeRef {
  name: string;
  developerName: string;
}

/**
 * Sidecar link between a person Account and its PersonContact
 * (spec §6): `Account.PersonContactId` only exists after insert, so the
 * anonymization phase emits referenceId→referenceId pairs here and the
 * load phase resolves and posts them as targeted updates.
 */
export interface PersonContactLink {
  accountReferenceId: string;
  contactReferenceId: string;
}

/** The versionable frozen dataset — contains no source-org values. */
export interface FrozenDataset {
  /** Semver of the dataset content (mirrors manifest `version`). */
  datasetVersion: string;
  objects: FrozenObjectData[];
  /** RecordTypes referenced by the dataset, per object (names only). */
  recordTypes: Record<string, FrozenRecordTypeRef[]>;
  /** PersonContact sidecar (spec §6) consumed by the load phase. */
  personContactSidecar: PersonContactLink[];
}

/**
 * EXTENSION POINT for the load phase (spec §3/§6) — NOT implemented by
 * the core engine. Resolves a RecordType reference to a target-org
 * RecordType ID by (SobjectType, DeveloperName); labels are never used
 * because they differ between orgs (mojibake included).
 */
export interface RecordTypeIdResolver {
  resolveByDeveloperName(
    orgId: string,
    sobjectType: string,
    developerName: string,
  ): Promise<string | null>;
}

/**
 * EXTENSION POINT for the load phase (spec §6 pitfall 9) — NOT
 * implemented by the core engine. Persists the only reliable address of
 * a loaded record: the mapping `referenceId → real target Id` captured at
 * insert (target-org automations may rewrite business identifiers).
 */
export interface ReferenceIdMappingStore {
  persist(mapping: ReadonlyMap<string, string>): Promise<void>;
}
