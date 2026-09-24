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
 * The load-phase contract is expressed here as interfaces the engine calls
 * but does not implement itself: `TargetRecordTypeIdResolver` resolves
 * RecordTypes against the target org, `SasReferenceIdMappingStore` persists
 * the referenceId mapping in the sas. FrozenDatasetHandler wires both.
 */

import type { ForgeWrittenBetween } from '@sandforge/shared';
import type { RowsLeftOut } from '../../core/common/platformRecords.js';

/** A raw record as extracted from the source org, keyed by referenceId. */
export interface ExtractedRecord {
  /**
   * Stable synthetic identifier (`<ObjectApiName>-NNNNNN`, assigned in
   * source-ID-sorted order so identical exports produce identical ids).
   * This is the ONLY join key allowed in the sas and in the frozen
   * dataset.
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

/** One entry of `rt-map.json` produced at extraction. */
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
  /**
   * Objects read without the `asOf` bound, because they carry no
   * `CreatedDate` to bound on.
   *
   * The bound is what makes this dataset frozen. An object that cannot take
   * it is read as it stands, and named here rather than left to look like the
   * rest — a caller that has to state what its dataset is frozen to needs to
   * know which part of it is not.
   */
  unboundedObjects: string[];
  /**
   * Per object, the fields holding a file's bytes (`base64`). The rules
   * cannot pseudonymize what they cannot read: a file with no approved
   * `keep` rule leaves its object out of the frozen dataset.
   */
  fileFields: Record<string, string[]>;
  /** The source org's standard price book, when the dataset carries prices. */
  standardPricebookSourceId?: string;
  /**
   * The records read and left out, by object and reason: the platform writes
   * them itself and refuses one from a copy — a tracked change — or they
   * cannot go in without one it does.
   */
  leftToThePlatform?: RowsLeftOut[];
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
 * can resolve target-org IDs *by DeveloperName*, never by label.
 */
export interface FrozenRecordTypeRef {
  name: string;
  developerName: string;
}

/**
 * Sidecar link between a person Account and its PersonContact:
 * `Account.PersonContactId` only exists after insert, so the
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
  /** PersonContact sidecar consumed by the load phase. */
  personContactSidecar: PersonContactLink[];
  /**
   * The referenceId of the standard price book. Every org has exactly one and
   * none can be created, so the load matches it to the target's own.
   */
  standardPricebook?: string;
  /**
   * Objects left out because they carry files the rules do not keep: bytes
   * cannot be pseudonymized, and a record emptied of its file cannot be
   * loaded — run for real, a quote document came back as an Apex exception.
   * Set by the anonymizer, for the manifest; not written with the data.
   */
  filesLeftOut?: string[];
}

/**
 * Load-phase contract, implemented by {@link TargetRecordTypeIdResolver}.
 * Resolves a RecordType reference to a target-org RecordType ID by
 * (SobjectType, DeveloperName); labels are never used because they differ
 * between orgs (mojibake included).
 */
export interface RecordTypeIdResolver {
  /**
   * The target id for a DeveloperName: one the running user can create
   * records with, `null` when the target has no such record type, or the
   * record type marked unavailable when it exists but is not the user's.
   */
  resolveByDeveloperName(
    orgId: string,
    sobjectType: string,
    developerName: string,
  ): Promise<string | null | UnavailableRecordType>;
}

/**
 * A record type the target has and the running user cannot create records
 * with: it exists, it is active, it resolves by DeveloperName — and it is not
 * assigned to that user, so Salesforce refuses every insert that names it
 * ("this ID value isn't valid for the user").
 */
export interface UnavailableRecordType {
  unavailable: true;
  id: string;
}

/**
 * The records of one object a load created — inserted, or a technical
 * placeholder — by their keys in the mapping, in the order it wrote them. A
 * reload lists there too, first, the records an earlier load created that it
 * found again: still a load's to remove, and to purge.
 */
export interface LoadCreatedRecords {
  objectApiName: string;
  referenceIds: string[];
}

/**
 * What a load says of the mapping it persists, besides the mapping: which of
 * its records it created — every other one it linked or reused — and when it
 * began. What removing the load takes, and how it dates the load.
 */
export interface PersistedLoad {
  /** Per object, the keys whose records the load created, in the order it wrote them. */
  created: readonly LoadCreatedRecords[];
  /** When the load began, on this machine's clock. */
  startedAt: Date;
  /**
   * When the target dated the records the load wrote, read back from it as the
   * load ended: what removing them tells a change made since the load by.
   * Absent when the load wrote nothing, or not every date could be read.
   */
  writtenBetween?: ForgeWrittenBetween;
  /**
   * Keep the loads the mapping recorded before this one, to the same org, with
   * the records they created that are still theirs: a load that did not purge
   * them leaves them in the org, and their removal, or the next reload, still
   * has to find them. `settled` names, by record id, what this load took from
   * them — purged, reused as its own, or, of a load that does not say what it
   * created, judged by the purge. Absent, the mapping holds this load alone.
   */
  earlier?: { settled: readonly string[] };
}

/**
 * A load the mapping recorded before the one about to run, as the reload
 * reads it: newest first, the last load then the ones it kept.
 */
export interface PreviousLoad {
  /** referenceId → real target ID. */
  mapping: ReadonlyMap<string, string>;
  /**
   * Per object, the keys whose records the load created. Undefined for a
   * mapping written before loads kept it: its created records cannot be told
   * from the ones it linked.
   */
  created?: readonly LoadCreatedRecords[];
}

/**
 * Load-phase contract, implemented by {@link SasReferenceIdMappingStore}.
 * Persists the only reliable address of a loaded record: the mapping
 * `referenceId → real target Id` captured at insert (target-org
 * automations may rewrite business identifiers).
 */
export interface ReferenceIdMappingStore {
  persist(mapping: ReadonlyMap<string, string>, load?: PersistedLoad): Promise<void>;
}
