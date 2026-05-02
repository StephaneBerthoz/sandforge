import type { ForgeGraph, ForgeGraphNode, ForgeNodeStatus } from '@sandforge/shared';
import { IdRemapper } from './IdRemapper.js';
import { ForgeBatchStrategy as ForgeBatchStrategyService } from './ForgeBatchStrategy.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { assertSoqlIdentifier, sanitizeSoqlValue } from '../../core/common/soqlValidator.js';

/**
 * Strict Salesforce record ID format (15 or 18 alphanumeric characters).
 * Used as a defense-in-depth check before SOQL interpolation.
 */
const SF_RECORD_ID_RE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
import { RecordScopeCache } from './RecordScopeCache.js';
import { ScopedSoqlBuilder } from './ScopedSoqlBuilder.js';
import { ReferenceDataMapper } from './ReferenceDataMapper.js';
import { RecordTypeMapper } from '../sync/RecordTypeMapper.js';
import type { RecordTypeMapping } from '../sync/RecordTypeMapper.js';

/** Result of a single record insert operation. */
export interface InsertResult {
  /** New Salesforce record ID. */
  id: string;
  /** Whether the insert succeeded. */
  success: boolean;
  /** Error messages if the insert failed. */
  errors: string[];
}

/** Result of a single record update operation. */
export interface UpdateResult {
  /** Salesforce record ID that was updated. */
  id: string;
  /** Whether the update succeeded. */
  success: boolean;
  /** Error messages if the update failed. */
  errors: string[];
}

/** Field metadata returned by describeFields. */
export interface FieldInfo {
  /** Field API name. */
  name: string;
  /** Whether the field can be queried. */
  queryable: boolean;
  /** Whether the field can be set on create. */
  createable: boolean;
  /** Whether the field is a reference (lookup/master-detail). */
  isReference: boolean;
  /**
   * Objects this reference field can point to (one entry for monomorphic,
   * many for polymorphic fields like Task.WhatId). Only meaningful when
   * `isReference === true`. Required for scope-aware execution; optional
   * for legacy (full-table) execution.
   */
  referenceTo?: string[];
  /**
   * Whether the field accepts `null` on create. When `false` AND the
   * field is a required reference, an orphan FK (no remap entry) makes
   * the whole record unsavable — the executor will skip that record
   * rather than send a payload Salesforce will reject.
   */
  nillable?: boolean;
  /**
   * For picklist / multipicklist fields, the list of *active* values the
   * field accepts. When this dep is populated for the *target* org, the
   * executor strips values that don't appear in the list before insert,
   * avoiding `INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST` rejections caused
   * by source-org picklist entries that don't exist on the target.
   * Empty / missing list = no validation.
   */
  picklistValues?: string[];
  /**
   * Whether this field is an `externalId` on the SObject — i.e. uniquely
   * identifies a record across orgs. Used by the upsert path so devs can
   * re-run the recipe against the same source record without hitting
   * `DUPLICATE_VALUE` on a previously cloned target row.
   */
  externalId?: boolean;
}

/** Optional execution mode parameters. */
export interface ExecuteOptions {
  /**
   * The root record ID supplied by the user (`ForgeConfig.recordId`). When
   * provided alongside `rootObjectApiName`, the executor enters
   * **record-scoped mode**: queries are restricted to the transitive closure
   * of this record instead of cloning every row of every table.
   */
  rootRecordId?: string;
  /** API name of the root object (resolved from the record ID prefix). */
  rootObjectApiName?: string;
  /**
   * When true, the executor still queries source records and populates the
   * scope cache, but skips all writes to the target org. Used by the recipe
   * to preview what *would* happen before committing real writes.
   */
  dryRun?: boolean;
  /**
   * How to handle reference fields whose value points to a record that was
   * never cloned (User, Owner, an excluded parent, etc.) — i.e. the
   * `IdRemapper` has no entry for it.
   *
   * - `'nullify'`: replace the orphaned reference with `null`. Salesforce
   *   then either leaves the field empty or assigns the running user
   *   (for OwnerId). Default in scoped mode.
   * - `'keep'`: preserve the original source-org ID. Almost always rejected
   *   by Salesforce for FKs; left as escape hatch and for legacy
   *   compatibility (default outside scoped mode).
   *
   * `RecordTypeId` is preserved unless a `recordTypeMappings` entry exists
   * for the source value, in which case it is translated to the target ID.
   */
  referenceFallback?: 'nullify' | 'keep';
  /**
   * Cross-org RecordType ID translations (matched by `developerName`).
   * Built up-front by the caller — typically by querying `RecordType` on
   * both orgs and passing the result through {@link RecordTypeMapper}.
   *
   * When supplied, every cloned record's `RecordTypeId` is rewritten to the
   * target-org ID. Records whose `RecordTypeId` has no mapping keep the
   * source value (which Salesforce will reject if the target org does not
   * happen to share that ID).
   */
  recordTypeMappings?: RecordTypeMapping[];
  /**
   * Optional per-object hard cap on the number of records to clone. When
   * set (and > 0), the executor appends `LIMIT N` to every scoped query.
   * Useful for keeping dev-sized clones bounded even when a node's scope
   * naturally pulls thousands of rows (e.g. `InsurancePolicyCoverage`).
   *
   * Records are picked by Salesforce's natural row order — caller can
   * influence this via SOQL hints in a future iteration.
   */
  maxRecordsPerObject?: number;
  /**
   * Object API names whose rows should be *mapped* to existing target
   * records (matched on `Name` / `DeveloperName`) instead of inserted.
   * Defaults to a small set of canonical reference-data tables that are
   * expected to be metadata-deployed: `BusinessHours`, `OperatingHours`.
   * Override or extend per environment as needed.
   */
  referenceDataObjects?: string[];
  /**
   * Wave 2 v4 — single-hop orphan parent expansion. When a record has a
   * required reference field whose target was *never* in the discovery
   * graph (e.g. `Asset.AccountId` pointing at an Account outside the
   * scoped clone), the executor on-demand:
   *
   *   1. Fetches the missing parent by Id from the source org.
   *   2. Inserts a minimal copy into the target org.
   *   3. Records the source→target mapping in the IdRemapper.
   *
   * Single-hop only — the fetched parent's *own* required FKs are
   * orphan-nullified normally (no recursion). Capped at
   * `maxOrphanParentExpansions` to bound API usage.
   *
   * Default: `false` (back-compat — required orphans surface as
   * REQUIRED_FIELD_MISSING errors).
   */
  expandOrphanParents?: boolean;
  /**
   * Maximum number of orphan parents the executor will fetch+insert per
   * `execute()` call when `expandOrphanParents` is true. Default 20.
   */
  maxOrphanParentExpansions?: number;
  /**
   * Insert vs upsert behaviour:
   *   - `'auto'` — for objects whose describe surfaces an `externalId`
   *     field, use `sobject.upsert(records, externalIdField)` so re-runs
   *     against an already-cloned source record patch the existing
   *     target row instead of failing with DUPLICATE_VALUE. Falls back
   *     to insert when no external Id is found.
   *   - `undefined` (default) — always insert.
   */
  upsertMode?: 'auto';
  /**
   * Per-object field exclusions. Field names listed here are stripped
   * from every record before insert/upsert, even if the source describe
   * marks them as createable. Common BA use case: clone Accounts but
   * skip `Description` (long-text PII) or `NumberOfEmployees`
   * (org-specific calc).
   *
   * Lookup is keyed by SObject API name; the inner array is a list of
   * field API names. Case-sensitive (matches Salesforce API name casing).
   */
  fieldExclusions?: Record<string, string[]>;
  /**
   * Per-object owner remap. When the source-org `OwnerId` of a record
   * matches a key, the cleaned record gets the mapped target Id instead.
   * Useful when cloning records authored by users that don't exist on
   * the target sandbox (e.g. ex-employees) — without this, Salesforce
   * rejects the insert with INVALID_OWNER. Pass-through when no mapping
   * exists for the source Id (the executor's reference fallback then
   * applies — typically nullify in scoped mode).
   */
  ownerMappings?: Record<string, string>;
  /**
   * Per-object SOQL WHERE-clause fragment appended via `AND (...)` to the
   * scope-derived clause. Lets BAs narrow a clone to a subset
   * (e.g. `Status = 'Open' AND CreatedDate > LAST_N_DAYS:30`) without
   * changing graph topology. Only applied in scoped mode (record root).
   * Validated upstream — see `forgeConfigSchema.objectSoqlFilters`.
   */
  objectSoqlFilters?: Record<string, string>;
  /**
   * Per-object source→target field rename. When the target sandbox has
   * the same logical field under a different API name (schema drift,
   * managed-package re-key, namespace change), this map rewrites the
   * keys in every cleaned record before insert.
   *
   * Example: `{ Account: { 'Region__c': 'Region__pc' } }` — sources every
   * `Region__c` value into `Region__pc` on the target Account. The
   * original key is dropped from the cleaned record so the target
   * describe doesn't reject the unknown field.
   */
  fieldMappings?: Record<string, Record<string, string>>;
}

/** Dependencies for ForgeExecutor, injected at construction time. */
export interface ForgeExecutorDeps {
  /** Query records from a Salesforce org. */
  queryRecords: (orgId: string, soql: string) => Promise<Record<string, unknown>[]>;
  /** Insert records into a Salesforce org. */
  insertRecords: (
    orgId: string,
    objectName: string,
    records: Record<string, unknown>[],
  ) => Promise<InsertResult[]>;
  /**
   * Update existing records on a Salesforce org. Used by Wave 2 v3 cycle
   * handling: when a record was inserted with a nullified cycle FK, the
   * second pass patches the FK to the now-cloned parent's target ID via
   * this method. Optional — when omitted, the executor skips the
   * second-pass UPDATE and surfaces the missing FKs in the error report.
   */
  updateRecords?: (
    orgId: string,
    objectName: string,
    records: Record<string, unknown>[],
  ) => Promise<UpdateResult[]>;
  /**
   * Upsert records on a Salesforce org via an external Id field. Used by
   * the upsert path (`ExecuteOptions.upsertMode = 'auto'`) so re-runs
   * patch existing target rows instead of failing on DUPLICATE_VALUE.
   * Optional — when omitted, the executor falls back to insert.
   */
  upsertRecords?: (
    orgId: string,
    objectName: string,
    externalIdField: string,
    records: Record<string, unknown>[],
  ) => Promise<InsertResult[]>;
  /** Get field metadata for an object (queryable, createable, reference flags). */
  describeFields: (orgId: string, objectName: string) => Promise<FieldInfo[]>;
  /**
   * Whether the SObject as a whole accepts inserts on this org. False for
   * read-only system entities like CaseHistory, ContentDocumentLink,
   * AuditTrail variants, etc. When provided, the executor consults this
   * before scheduling inserts so unsupported nodes are skipped cleanly
   * with a helpful error rather than failing record-by-record at runtime.
   */
  isObjectCreatable?: (orgId: string, objectName: string) => Promise<boolean>;
  /** Optional batch strategy for splitting inserts into batches. */
  batchStrategy?: ForgeBatchStrategyService;
  /** Optional anonymization function applied before insert. */
  anonymize?: (records: Record<string, unknown>[], objectApiName: string) => Record<string, unknown>[];
}

/** Progress event emitted during execution. */
export interface ForgeProgressEvent {
  /** Object being processed. */
  objectName: string;
  /** Current status of the object. */
  status: ForgeNodeStatus;
  /** Progress percentage (0-100). */
  progress: number;
  /** Human-readable status message. */
  message: string;
}

/** Sample of a record that failed insertion, with the platform errors. */
export interface ExecutionErrorSample {
  /** Compact key=value summary of up to 4 fields (for UI display). */
  recordSummary: string;
  /** Error messages returned by Salesforce, one per error on the record. */
  messages: string[];
}

/** Aggregated error report for a single object that failed during execution. */
export interface ExecutionObjectError {
  /** API name of the object. */
  objectApiName: string;
  /** Stage where the failure happened — 'query' (read source), 'insert', 'scope'. */
  stage: 'query' | 'insert' | 'scope';
  /** Number of records that failed at this stage. */
  failedCount: number;
  /** Total records attempted at this stage (0 for 'scope' stage). */
  attemptedCount: number;
  /** Up to 3 sample failures (truncated to keep payloads UI-friendly). */
  samples: ExecutionErrorSample[];
}

/** Summary returned after execution completes. */
export interface ExecutionSummary {
  /** Number of successfully inserted records. */
  successCount: number;
  /** Number of records that failed to insert. */
  failedCount: number;
  /** Number of skipped objects. */
  skippedCount: number;
  /** Total remapped IDs. */
  remapCount: number;
  /** Per-object error reports — populated whenever any record or object fails. */
  errors: ExecutionObjectError[];
}

/**
 * Executes a Forge plan by processing graph nodes in topological order.
 *
 * For each included node: queries records from the source org, remaps
 * lookup IDs, inserts into the target org, and tracks new ID mappings.
 * Errors on a parent cause dependent children to be skipped.
 */
export class ForgeExecutor {
  private readonly deps: ForgeExecutorDeps;
  private isPaused = false;
  private pauseResolve: (() => void) | null = null;
  private isAborted = false;

  /** @param deps - Injected dependencies for org data operations. */
  constructor(deps: ForgeExecutorDeps) {
    this.deps = deps;
  }

  /** Pause execution between batches. Idempotent — calling twice is safe. */
  pause(): void {
    if (this.isPaused) return;
    this.isPaused = true;
  }

  /** Resume execution after pause. */
  resume(): void {
    this.isPaused = false;
    const resolver = this.pauseResolve;
    this.pauseResolve = null;
    resolver?.();
  }

  /** Abort execution. Resumes any paused state to propagate the abort. */
  abort(): void {
    this.isAborted = true;
    // Snapshot+null+invoke so a concurrent pause/resume can't leak the
    // promise resolver into a paused state from a previous run.
    const resolver = this.pauseResolve;
    this.pauseResolve = null;
    this.isPaused = false;
    resolver?.();
  }

  /**
   * Wait if paused, throw if aborted.
   * Called between batch iterations.
   */
  private async waitIfPaused(): Promise<void> {
    if (this.isAborted) {
      throw new Error('Forge execution was aborted by user request. No further batches will be processed.');
    }
    if (!this.isPaused) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.pauseResolve = resolve;
    });
    if (this.isAborted) {
      throw new Error('Forge execution was aborted while paused. No further batches will be processed.');
    }
  }

  /**
   * Execute the forge plan for the given graph.
   *
   * @param graph - The dependency graph to execute.
   * @param sourceOrgId - ID of the source Salesforce org.
   * @param targetOrgId - ID of the target Salesforce org.
   * @param onProgress - Callback for progress events.
   * @returns Execution summary with counts.
   */
  async execute(
    graph: ForgeGraph,
    sourceOrgId: string,
    targetOrgId: string,
    onProgress: (event: ForgeProgressEvent) => void,
    options?: ExecuteOptions,
  ): Promise<ExecutionSummary> {
    this.isAborted = false;
    this.isPaused = false;
    this.pauseResolve = null;

    const isScoped = !!(options?.rootRecordId && options.rootObjectApiName);
    const dryRun = options?.dryRun ?? false;
    const referenceFallback = options?.referenceFallback ?? (isScoped ? 'nullify' : 'keep');
    const scopeCache = isScoped ? new RecordScopeCache() : null;
    const scopedBuilder = isScoped ? new ScopedSoqlBuilder() : null;
    const recordTypeMappings = options?.recordTypeMappings;
    const recordTypeMapper = recordTypeMappings && recordTypeMappings.length > 0 ? new RecordTypeMapper() : null;
    // Per-object opt-in field exclusions and owner mapping. Keyed by SObject
    // API name. Lookups happen at most once per node (case-sensitive).
    const fieldExclusions = options?.fieldExclusions ?? {};
    const ownerMappings = options?.ownerMappings ?? {};
    const fieldMappings = options?.fieldMappings ?? {};
    const referenceDataObjects = new Set(
      options?.referenceDataObjects ?? ['BusinessHours', 'OperatingHours'],
    );
    const referenceDataMapper = new ReferenceDataMapper((orgId, soql) =>
      this.deps.queryRecords(orgId, soql),
    );

    if (scopeCache && options?.rootRecordId && options.rootObjectApiName) {
      scopeCache.add(options.rootObjectApiName, [options.rootRecordId]);
    }

    let sortedNodes = topologicalSort(graph);
    if (isScoped && options?.rootObjectApiName) {
      sortedNodes = bringRootToFront(sortedNodes, options.rootObjectApiName);
    }

    const remapper = new IdRemapper();
    const failedObjects = new Set<string>();
    const errors: ExecutionObjectError[] = [];

    /** Records inserted with nullified cycle FKs — patched in pass 2. */
    interface PendingFkUpdate {
      objectApiName: string;
      /** Target Id of the freshly-inserted record (the one to UPDATE). */
      newId: string;
      /** Source-org Id of the record (carried for triage on errors). */
      sourceId: string | undefined;
      fieldName: string;
      sourceRefId: string;
    }
    const pendingFkUpdates: PendingFkUpdate[] = [];

    /** Counter for the single-hop orphan parent expansion (Wave 2 v4). */
    const expandOrphanParents = options?.expandOrphanParents ?? false;
    const maxOrphanExpansions = options?.maxOrphanParentExpansions ?? 20;
    let orphanExpansionsUsed = 0;
    const orphanExpansionErrors: ExecutionErrorSample[] = [];
    /**
     * Negative cache shared across nodes — once an orphan expansion fails
     * for a given (object, sourceId), don't retry it on every other child
     * that references the same parent. Prevents duplicate target rows when
     * two siblings both reference the same uncloned Account.
     */
    const failedOrphans = new Set<string>();

    let successCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    for (const node of sortedNodes) {
      if (!node.included) {
        skippedCount++;
        onProgress({
          objectName: node.objectApiName,
          status: 'skipped',
          progress: 100,
          message: `Skipped ${node.objectApiName} (excluded)`,
        });
        continue;
      }

      // Check if any parent object has failed
      const parentObjects = getParentObjects(node.objectApiName, graph);
      const hasFailedParent = parentObjects.some((p) => failedObjects.has(p));
      if (hasFailedParent) {
        skippedCount++;
        failedObjects.add(node.objectApiName);
        onProgress({
          objectName: node.objectApiName,
          status: 'skipped',
          progress: 100,
          message: `Skipped ${node.objectApiName} (parent failed)`,
        });
        continue;
      }

      // Pre-flight: skip nodes the target org refuses to accept inserts on
      // (read-only system entities like Case History or audit-log variants).
      // The check is best-effort — when the dep is not provided we fall back
      // to the legacy behaviour of letting the runtime reject batch-by-batch.
      if (!dryRun && this.deps.isObjectCreatable) {
        try {
          const creatable = await this.deps.isObjectCreatable(targetOrgId, node.objectApiName);
          if (!creatable) {
            skippedCount++;
            errors.push({
              objectApiName: node.objectApiName,
              stage: 'scope',
              failedCount: 0,
              attemptedCount: 0,
              samples: [{ recordSummary: '(node-level skip)', messages: [`Object is not createable on target org`] }],
            });
            onProgress({
              objectName: node.objectApiName,
              status: 'skipped',
              progress: 100,
              message: `Skipped ${node.objectApiName} (target org rejects inserts on this entity)`,
            });
            continue;
          }
        } catch (err: unknown) {
          // Surface as a per-object error instead of silently dropping —
          // the user gets a clear hint when auth dropped or describe blocked.
          errors.push({
            objectApiName: node.objectApiName,
            stage: 'scope',
            failedCount: 0,
            attemptedCount: 0,
            samples: [{
              recordSummary: '(target describe failed)',
              messages: [`isObjectCreatable check failed: ${err instanceof Error ? err.message : String(err)}`],
            }],
          });
        }
      }

      try {
        // Step 1: Scanning — describe fields to build SOQL and filter sets
        onProgress({
          objectName: node.objectApiName,
          status: 'scanning',
          progress: 0,
          message: `Querying ${node.objectApiName} records...`,
        });

        const fieldInfos = await this.deps.describeFields(sourceOrgId, node.objectApiName);
        const queryFields = fieldInfos.filter((f) => f.queryable).map((f) => f.name);
        const createableSet = new Set(fieldInfos.filter((f) => f.createable).map((f) => f.name));
        const lookupFields = fieldInfos.filter((f) => f.isReference).map((f) => f.name);

        if (queryFields.length === 0) {
          queryFields.push('Id');
        }

        let soql: string;
        if (scopedBuilder && scopeCache && options?.rootObjectApiName && options.rootRecordId) {
          const scopeFields = fieldInfos
            .filter((f) => f.isReference)
            .map((f) => ({
              name: f.name,
              type: 'reference',
              referenceTo: f.referenceTo ?? [],
            }));
          const scopeResult = scopedBuilder.build({
            node,
            fields: scopeFields,
            selectFields: queryFields,
            edges: graph.edges,
            cache: scopeCache,
            rootObjectApiName: options.rootObjectApiName,
            rootRecordId: options.rootRecordId,
            extraWhere: options?.objectSoqlFilters?.[node.objectApiName],
          });
          if (!scopeResult.scoped) {
            skippedCount++;
            errors.push({
              objectApiName: node.objectApiName,
              stage: 'scope',
              failedCount: 0,
              attemptedCount: 0,
              samples: [{ recordSummary: '(no record queried)', messages: [scopeResult.reason] }],
            });
            onProgress({
              objectName: node.objectApiName,
              status: 'skipped',
              progress: 100,
              message: `Skipped ${node.objectApiName} (out of scope: ${scopeResult.reason})`,
            });
            continue;
          }
          soql = scopeResult.soql;
        } else {
          soql = `SELECT ${queryFields.join(', ')} FROM ${assertSoqlIdentifier(node.objectApiName)}`;
        }

        // Math.floor on positive non-integers is safe; guard against
        // negatives or NaN that would produce MALFORMED_QUERY.
        if (options?.maxRecordsPerObject && options.maxRecordsPerObject > 0) {
          const cap = Math.floor(options.maxRecordsPerObject);
          if (cap > 0) soql += ` LIMIT ${cap}`;
        }

        const records = await this.deps.queryRecords(sourceOrgId, soql);

        // Reference-data branch: resolve source IDs against target rows by
        // Name/DeveloperName instead of cloning. Adds entries to the IdRemapper
        // so downstream FKs pick up the correct target IDs naturally.
        if (referenceDataObjects.has(node.objectApiName) && !dryRun) {
          const refResolve = await referenceDataMapper.resolve(
            node.objectApiName,
            records,
            targetOrgId,
          );
          for (const m of refResolve.mappings) {
            remapper.add(m.sourceId, m.targetId);
          }
          if (refResolve.unmatched.length > 0) {
            errors.push({
              objectApiName: node.objectApiName,
              stage: 'scope',
              failedCount: refResolve.unmatched.length,
              attemptedCount: records.length,
              samples: refResolve.unmatched.slice(0, 3).map((u) => ({
                recordSummary: `Id=${u.sourceId} matchValue=${u.matchValue ?? 'null'}`,
                messages: [`Reference-data row not found on target org`],
              })),
            });
          }
          // Still seed the scope cache so FK propagation works.
          if (scopeCache) {
            const ownIds: string[] = [];
            for (const rec of records) {
              const id = rec['Id'];
              if (typeof id === 'string' && id) ownIds.push(id);
            }
            scopeCache.add(node.objectApiName, ownIds);
          }
          successCount += refResolve.mappings.length;
          onProgress({
            objectName: node.objectApiName,
            status: 'done',
            progress: 100,
            message: `Mapped ${node.objectApiName} via reference-data lookup: ${refResolve.mappings.length} resolved, ${refResolve.unmatched.length} unmatched`,
          });
          continue;
        }

        // Seed cache with this node's IDs and extract FK values for downstream
        // multi-hop scoping (e.g. Case.AccountId → Account, then Account.OwnerId → User).
        if (scopeCache) {
          const ownIds: string[] = [];
          for (const rec of records) {
            const id = rec['Id'];
            if (typeof id === 'string' && id) ownIds.push(id);
          }
          scopeCache.add(node.objectApiName, ownIds);

          const refFieldsWithTargets = fieldInfos.filter(
            (f) => f.isReference && f.referenceTo && f.referenceTo.length > 0,
          );
          for (const field of refFieldsWithTargets) {
            const targets = field.referenceTo ?? [];
            for (const rec of records) {
              const value = rec[field.name];
              if (typeof value !== 'string' || !value) continue;
              for (const target of targets) {
                scopeCache.add(target, [value]);
              }
            }
          }
        }

        if (dryRun) {
          onProgress({
            objectName: node.objectApiName,
            status: 'done',
            progress: 100,
            message: `[dry-run] ${node.objectApiName}: ${records.length} record(s) would be inserted`,
          });
          successCount += records.length;
          continue;
        }

        // Step 2: Remap lookup IDs, translate RecordTypeId, nullify orphans,
        //         strip non-createable fields. `null` values produced by
        //         `nullifyOrphanedFks` are omitted from the payload entirely
        //         — Salesforce treats explicit `null` on required fields as
        //         "set to null" (rejected) rather than "use default", so
        //         omitting lets the platform auto-fill OwnerId etc.
        let targetCreatableSet: Set<string> | null = null;
        let targetPicklistValuesByField: Map<string, Set<string>> | null = null;
        if (!dryRun) {
          try {
            const targetFields = await this.deps.describeFields(targetOrgId, node.objectApiName);
            targetCreatableSet = new Set(targetFields.filter((f) => f.createable).map((f) => f.name));
            // Collect picklist value whitelists for cross-org strip.
            const pmap = new Map<string, Set<string>>();
            for (const f of targetFields) {
              if (f.picklistValues && f.picklistValues.length > 0) {
                pmap.set(f.name, new Set(f.picklistValues));
              }
            }
            if (pmap.size > 0) targetPicklistValuesByField = pmap;
          } catch (err: unknown) {
            // Surface schema-drift defense failure: target describe is the
            // *only* way to detect missing fields/picklist drift before
            // insert. Without this signal the user sees cryptic INVALID_FIELD
            // and can't tell if it's drift or auth.
            errors.push({
              objectApiName: node.objectApiName,
              stage: 'scope',
              failedCount: 0,
              attemptedCount: 0,
              samples: [{
                recordSummary: '(target describe failed — falling back to source schema)',
                messages: [err instanceof Error ? err.message : String(err)],
              }],
            });
          }
        }
        const effectiveCreatableSet = targetCreatableSet
          ? intersect(createableSet, targetCreatableSet)
          : createableSet;
        // Wave 2 v4 — single-hop orphan parent expansion.
        // Identify required reference fields whose value isn't in the remapper
        // and points outside the discovery graph; fetch+insert each parent
        // on-demand so the child record can pick up the new target ID
        // instead of failing with REQUIRED_FIELD_MISSING.
        if (expandOrphanParents && !dryRun && orphanExpansionsUsed < maxOrphanExpansions) {
          const requiredOrphans = new Map<string, { object: string; sourceId: string }>();
          const requiredRefFields = fieldInfos.filter(
            (f) => f.isReference && f.nillable === false && f.name !== 'RecordTypeId',
          );
          for (const r of records) {
            for (const field of requiredRefFields) {
              const value = r[field.name];
              if (typeof value !== 'string' || !value) continue;
              if (remapper.get(value)) continue;
              for (const target of field.referenceTo ?? []) {
                if (target === node.objectApiName) continue;
                // Excluded objects (User, RecordType, Group, history/feed/share/
                // changeevent suffixes) can't be cloned in a meaningful way and
                // would just burn API calls + add noise to the error report.
                if (isExpansionExcludedObject(target)) continue;
                const key = `${target}::${value}`;
                if (!requiredOrphans.has(key)) {
                  requiredOrphans.set(key, { object: target, sourceId: value });
                }
                break;
              }
            }
          }
          // Process orphan expansions in parallel waves. Sequential
          // expansions cost up to 60 round-trips (20 orphans × 3 ops);
          // bounded concurrency 4 cuts that ~4x while staying under
          // jsforce's default 5-conn pool.
          const ORPHAN_CONCURRENCY = 4;
          const eligible: Array<{ object: string; sourceId: string; cacheKey: string }> = [];
          for (const [, entry] of requiredOrphans) {
            if (orphanExpansionsUsed + eligible.length >= maxOrphanExpansions) break;
            const cacheKey = `${entry.object}::${entry.sourceId}`;
            if (failedOrphans.has(cacheKey)) continue;
            if (remapper.get(entry.sourceId)) continue;
            eligible.push({ ...entry, cacheKey });
          }
          for (let i = 0; i < eligible.length; i += ORPHAN_CONCURRENCY) {
            const slice = eligible.slice(i, i + ORPHAN_CONCURRENCY);
            await Promise.all(
              slice.map(async (entry) => {
                try {
                  const newId = await this.expandSingleOrphanParent(
                    sourceOrgId,
                    targetOrgId,
                    entry.object,
                    entry.sourceId,
                    recordTypeMappings,
                    recordTypeMapper,
                  );
                  if (newId) {
                    // CR-001: count only successful expansions toward the cap
                    // so a string of misses doesn't silently exhaust the budget
                    // before the eligible list has had a chance to succeed.
                    orphanExpansionsUsed++;
                    remapper.add(entry.sourceId, newId);
                    // CR-007: register the parent in scopeCache so multi-hop
                    // children that pivot through this object include the
                    // newly cloned row in their scope query (otherwise the
                    // scope cache reports the orphan as out-of-scope and the
                    // child never gets cloned).
                    if (scopeCache) {
                      scopeCache.add(entry.object, [entry.sourceId]);
                    }
                  } else {
                    failedOrphans.add(entry.cacheKey);
                    if (orphanExpansionErrors.length < 3) {
                      orphanExpansionErrors.push({
                        recordSummary: `${entry.object}/${entry.sourceId}`,
                        messages: [`Orphan parent expansion produced no new id`],
                      });
                    }
                  }
                } catch (err) {
                  failedOrphans.add(entry.cacheKey);
                  if (orphanExpansionErrors.length < 3) {
                    orphanExpansionErrors.push({
                      recordSummary: `${entry.object}/${entry.sourceId}`,
                      messages: [extractErrorMessage(err)],
                    });
                  }
                }
              }),
            );
          }
        }

        // Build cleaned records for insert. Strip non-createable fields,
        // omit nullified orphan FKs, and remove Person Account __pc fields
        // when the record itself isn't a Person Account.
        type Built = {
          source: Record<string, unknown>;
          cleaned: Record<string, unknown>;
          /** FKs that were nullified — used by 2-pass cycle UPDATE. */
          nullifiedFks: NullifiedFk[];
        };
        const built: Built[] = records.map((r) => {
          // Identify orphan FKs from the ORIGINAL record (pre-remap) so we
          // don't confuse already-remapped target IDs with unmapped sources.
          const nullifiedFks: NullifiedFk[] = [];
          if (referenceFallback === 'nullify') {
            for (const field of fieldInfos) {
              if (!field.isReference) continue;
              if (field.name === 'RecordTypeId') continue;
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
          let remapped = remapper.remapRecord(r, remapLookupFields);
          for (const nf of nullifiedFks) {
            remapped[nf.field] = null;
          }
          // Apply per-object owner remap (BA need: clone records authored by
          // ex-employees onto a sandbox where their User no longer exists).
          // Only applies to OwnerId — the generic remapper doesn't see User
          // FKs because Users aren't in the cloned graph.
          const sourceOwner = remapped['OwnerId'];
          if (typeof sourceOwner === 'string' && ownerMappings[sourceOwner]) {
            remapped['OwnerId'] = ownerMappings[sourceOwner];
          }
          // Coerce IsPersonAccount: jsforce sometimes returns boolean,
          // sometimes the SOAP-normalized string 'true'. Strict === true
          // missed the string case → __pc fields stripped from real
          // person accounts, breaking the insert.
          const ipa = remapped['IsPersonAccount'];
          const isPersonAccount = ipa === true || ipa === 'true' || ipa === 1;
          // Per-node field exclusions (BA opt-in). Computed once per node
          // outside the loop would be cleaner, but doing it here keeps the
          // change scoped — perf cost is one Set construction per record,
          // negligible vs the existing remapper/anonymizer work.
          const excludedFields = new Set(fieldExclusions[node.objectApiName] ?? []);
          // Per-node source→target field rename map (BA opt-in for schema
          // drift). When a key is in this map, the cleaned record uses the
          // mapped target name instead and the source name is dropped.
          // Source name still has to pass the createable check below since
          // we read from `remapped[key]` first — the rename is applied on
          // the *write* side of the cleaned record.
          const fieldRename = fieldMappings[node.objectApiName] ?? {};
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
            if (!effectiveCreatableSet.has(key)) continue;
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
              targetPicklistValuesByField &&
              typeof value === 'string' &&
              targetPicklistValuesByField.has(key) &&
              !targetPicklistValuesByField.get(key)!.has(value)
            ) {
              continue;
            }
            cleaned[key] = value;
          }
          return { source: r, cleaned, nullifiedFks };
        });
        const filteredRecords = built;
        let remappedRecords = filteredRecords.map((b) => b.cleaned);
        if (recordTypeMapper && recordTypeMappings) {
          remappedRecords = recordTypeMapper.apply(remappedRecords, recordTypeMappings);
        }

        // Step 2b: Apply anonymization if configured
        if (this.deps.anonymize) {
          remappedRecords = this.deps.anonymize(remappedRecords, node.objectApiName);
        }

        // Step 3: Running — batch and insert into target
        const batchStrategy = this.deps.batchStrategy ?? new ForgeBatchStrategyService();
        const { batchSize, batchCount } = batchStrategy.resolve(
          node.batchStrategy,
          remappedRecords.length,
        );

        onProgress({
          objectName: node.objectApiName,
          status: 'running',
          progress: 0,
          message: `Inserting ${remappedRecords.length} ${node.objectApiName} records in ${batchCount} batch(es)...`,
        });

        let nodeSuccess = 0;
        let nodeFailure = 0;
        let recordOffset = 0;
        const nodeErrorSamples: ExecutionErrorSample[] = [];

        // Upsert via external Id when available — re-runs patch existing
        // target rows instead of failing on DUPLICATE_VALUE. When multiple
        // ext-id fields exist (legacy ExtId__c + new MigrationKey__c), the
        // first describe-order pick may be non-unique → DUPLICATE_EXTERNAL_ID.
        // Tiebreaker: prefer fields whose values are non-null + unique in
        // the *source batch*; fall back to alphabetical for determinism.
        const upsertField = this.pickUpsertField(
          fieldInfos,
          effectiveCreatableSet,
          remappedRecords,
          options?.upsertMode === 'auto' && this.deps.upsertRecords ? 'auto' : 'off',
        );

        for (let b = 0; b < batchCount; b++) {
          await this.waitIfPaused();

          const batch = remappedRecords.slice(b * batchSize, (b + 1) * batchSize);
          const results = upsertField && this.deps.upsertRecords
            ? await this.deps.upsertRecords(
                targetOrgId,
                node.objectApiName,
                upsertField,
                batch,
              )
            : await this.deps.insertRecords(
                targetOrgId,
                node.objectApiName,
                batch,
              );

          // Step 4: Register new IDs for this batch + capture failure samples.
          // Use filteredRecords (post required-FK skip) for the source-ID
          // lookup so remapper entries point at the correct origin record.
          //
          // Defense: jsforce/Salesforce should return one result per input
          // record (and in input order), but partial-failure modes have
          // truncated arrays in the wild. If results.length < batch.length,
          // count the missing entries as failures and KEEP recordOffset
          // aligned to batch.length so subsequent batches still index
          // correctly.
          const expected = batch.length;
          const actual = results.length;
          for (let i = 0; i < actual; i++) {
            const result = results[i];
            if (result.success) {
              nodeSuccess++;
              const built = filteredRecords[recordOffset + i];
              const oldId = built?.source['Id'];
              if (typeof oldId === 'string') {
                remapper.add(oldId, result.id);
              }
              // Wave 2 v3 — record nullified FKs so pass 2 can patch them
              // once the parent target is in the IdRemapper.
              if (built && built.nullifiedFks.length > 0) {
                const sourceId = typeof built.source['Id'] === 'string' ? built.source['Id'] : undefined;
                for (const nf of built.nullifiedFks) {
                  pendingFkUpdates.push({
                    objectApiName: node.objectApiName,
                    newId: result.id,
                    sourceId,
                    fieldName: nf.field,
                    sourceRefId: nf.sourceRefId,
                  });
                }
              }
            } else {
              nodeFailure++;
              if (nodeErrorSamples.length < 3) {
                nodeErrorSamples.push({
                  recordSummary: summarizeRecordForError(batch[i]),
                  messages: result.errors,
                });
              }
            }
          }
          // Account for missing results — keeps recordOffset aligned with
          // the source batch and prevents IdRemapper cross-contamination.
          if (actual < expected) {
            for (let i = actual; i < expected; i++) {
              nodeFailure++;
              if (nodeErrorSamples.length < 3) {
                nodeErrorSamples.push({
                  recordSummary: summarizeRecordForError(batch[i]),
                  messages: [`No result returned for record (API truncated batch: ${actual}/${expected})`],
                });
              }
            }
          }

          recordOffset += expected;

          onProgress({
            objectName: node.objectApiName,
            status: 'running',
            progress: Math.round(((b + 1) / batchCount) * 100),
            message: `batch ${b + 1}/${batchCount} \u2014 ${Math.min((b + 1) * batchSize, remappedRecords.length)}/${remappedRecords.length} records`,
          });
        }

        successCount += nodeSuccess;
        failedCount += nodeFailure;

        if (nodeFailure > 0) {
          errors.push({
            objectApiName: node.objectApiName,
            stage: 'insert',
            failedCount: nodeFailure,
            attemptedCount: nodeSuccess + nodeFailure,
            samples: nodeErrorSamples,
          });
        }

        // Fail-fast on partial-but-mostly-failure: if >50% of records
        // failed, mark the node as failed so downstream children skip
        // (their FKs would orphan-nullify and silently corrupt the clone).
        const total = nodeSuccess + nodeFailure;
        const failureRate = total > 0 ? nodeFailure / total : 0;
        if (nodeFailure > 0 && (nodeSuccess === 0 || failureRate > 0.5)) {
          failedObjects.add(node.objectApiName);
          onProgress({
            objectName: node.objectApiName,
            status: 'error',
            progress: 100,
            message: nodeSuccess === 0
              ? `Failed all ${node.objectApiName} records`
              : `${nodeFailure}/${total} ${node.objectApiName} records failed (>50%) — children will be skipped`,
          });
        } else {
          onProgress({
            objectName: node.objectApiName,
            status: 'done',
            progress: 100,
            message: `Completed ${node.objectApiName}: ${nodeSuccess} succeeded, ${nodeFailure} failed`,
          });
        }
      } catch (err) {
        failedObjects.add(node.objectApiName);
        failedCount += node.recordCount;
        errors.push({
          objectApiName: node.objectApiName,
          stage: 'query',
          failedCount: node.recordCount,
          attemptedCount: node.recordCount,
          samples: [{ recordSummary: '(stage failed before insert)', messages: [extractErrorMessage(err)] }],
        });
        onProgress({
          objectName: node.objectApiName,
          status: 'error',
          progress: 100,
          message: `Error on ${node.objectApiName}: ${extractErrorMessage(err)}`,
        });
      }
    }

    // Pass 2 — patch nullified cycle FKs whose targets are now cloned.
    // Without this, records inserted with `Foo.BarId = null` (because Bar
    // had not been cloned yet at insert time) would stay disconnected. We
    // group pending updates by (objectApiName, newId) so multiple FK fields
    // on the same record collapse to a single UPDATE call, then dispatch
    // through `deps.updateRecords` in a per-object batch.
    if (!dryRun && this.deps.updateRecords && pendingFkUpdates.length > 0) {
      const updatesByObject = new Map<string, Map<string, Record<string, unknown>>>();
      let resolvedCount = 0;
      const unresolved: ExecutionErrorSample[] = [];
      for (const upd of pendingFkUpdates) {
        const newRefId = remapper.get(upd.sourceRefId);
        if (!newRefId) {
          if (unresolved.length < 3) {
            unresolved.push({
              recordSummary: `${upd.objectApiName} source=${upd.sourceId ?? '?'} target=${upd.newId} ${upd.fieldName}=<source ${upd.sourceRefId}>`,
              messages: [`Cycle FK '${upd.fieldName}' could not be resolved — referenced parent (source ${upd.sourceRefId}) was not cloned`],
            });
          }
          continue;
        }
        let perObj = updatesByObject.get(upd.objectApiName);
        if (!perObj) {
          perObj = new Map();
          updatesByObject.set(upd.objectApiName, perObj);
        }
        // CR-002: explicit "read current → check conflict → build → set"
        // pattern so the mutable-by-reference semantics are obvious.
        // Previous code relied on `existing` aliasing the map entry and
        // mutating it in place — silently broken if a refactor introduces
        // defensive cloning. Now the intent is unambiguous.
        const current = perObj.get(upd.newId);
        const previousValue = current?.[upd.fieldName];
        // Detect dup-on-same-record collisions (same record, same field,
        // different remapped target) — surface explicitly so the user
        // can investigate ambiguous polymorphic FKs (Task.WhatId etc.).
        if (previousValue !== undefined && previousValue !== newRefId) {
          if (unresolved.length < 3) {
            unresolved.push({
              recordSummary: `${upd.objectApiName} source=${upd.sourceId ?? '?'} target=${upd.newId} ${upd.fieldName}`,
              messages: [`Conflicting cycle FK update for ${upd.fieldName}: ${String(previousValue)} vs ${newRefId}`],
            });
          }
          continue;
        }
        const updated = current ?? { Id: upd.newId };
        updated[upd.fieldName] = newRefId;
        perObj.set(upd.newId, updated);
        resolvedCount++;
      }
      let pass2Failed = 0;
      const pass2Samples: ExecutionErrorSample[] = [];
      for (const [objectApiName, perObj] of updatesByObject) {
        const recordsToUpdate = [...perObj.values()];
        try {
          const updateResults = await this.deps.updateRecords(
            targetOrgId,
            objectApiName,
            recordsToUpdate,
          );
          for (let i = 0; i < updateResults.length; i++) {
            const r = updateResults[i];
            if (!r.success) {
              pass2Failed++;
              if (pass2Samples.length < 3) {
                pass2Samples.push({
                  recordSummary: summarizeRecordForError(recordsToUpdate[i]),
                  messages: r.errors,
                });
              }
            }
          }
        } catch (err) {
          pass2Failed += recordsToUpdate.length;
          if (pass2Samples.length < 3) {
            pass2Samples.push({
              recordSummary: `${objectApiName} batch failed`,
              messages: [extractErrorMessage(err)],
            });
          }
        }
      }
      const totalAttempted = resolvedCount + unresolved.length;
      onProgress({
        objectName: '__pass2__',
        status: pass2Failed + unresolved.length > 0 ? 'error' : 'done',
        progress: 100,
        message: `Pass 2 (cycle FK update): ${resolvedCount - pass2Failed}/${totalAttempted} resolved`,
      });
      if (pass2Failed > 0 || unresolved.length > 0) {
        errors.push({
          objectApiName: '__pass2__',
          stage: 'insert',
          failedCount: pass2Failed + unresolved.length,
          attemptedCount: totalAttempted,
          samples: [...pass2Samples, ...unresolved].slice(0, 3),
        });
      }
    }

    if (orphanExpansionErrors.length > 0) {
      errors.push({
        objectApiName: '__expandOrphanParents__',
        stage: 'insert',
        failedCount: orphanExpansionErrors.length,
        attemptedCount: orphanExpansionsUsed,
        samples: orphanExpansionErrors,
      });
    }

    return {
      successCount,
      failedCount,
      skippedCount,
      remapCount: remapper.count,
      errors,
    };
  }

  /**
   * Single-hop orphan parent expansion (Wave 2 v4).
   *
   * Fetches a missing parent record from the source org by Id, copies it
   * to the target org with a minimal payload (createable target fields
   * only, RecordType remapped if applicable, orphan FKs nullified), and
   * returns the new target ID. Returns `null` when the parent can't be
   * fetched or the insert fails.
   *
   * Intentionally non-recursive — the fetched parent's *own* required FKs
   * are nullified rather than expanded further. Callers must respect the
   * `maxOrphanParentExpansions` cap to bound API usage.
   */
  /**
   * Pick the upsert key field deterministically. Salesforce upsert needs an
   * external Id field that's *unique per record in the batch* — picking
   * non-unique fields blows up with DUPLICATE_EXTERNAL_ID. When multiple
   * candidates exist (legacy + new), we prefer the one whose values are all
   * present and unique in the current batch; alphabetical fallback ensures
   * determinism across describe-version drift.
   */
  private pickUpsertField(
    fieldInfos: FieldInfo[],
    creatable: ReadonlySet<string>,
    records: Array<Record<string, unknown>>,
    mode: 'auto' | 'off',
  ): string | undefined {
    if (mode === 'off' || !this.deps.upsertRecords) return undefined;
    const candidates = fieldInfos
      .filter((f) => f.externalId && creatable.has(f.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (candidates.length === 0) return undefined;
    // Prefer a candidate with non-null + unique values across the batch.
    for (const c of candidates) {
      const seen = new Set<string>();
      let ok = true;
      for (const r of records) {
        const v = r[c.name];
        if (typeof v !== 'string' || v.length === 0) {
          ok = false;
          break;
        }
        if (seen.has(v)) {
          ok = false;
          break;
        }
        seen.add(v);
      }
      if (ok) {
        // CR-004: log the chosen field so the user can attribute
        // upsert-related errors to the picked external Id without
        // having to re-derive it from describe metadata.
        console.info(
          `[forge] upsert: using "${c.name}" as external Id (unique across ${records.length} records)`,
        );
        return c.name;
      }
    }
    // CR-004: no clean winner → fall BACK TO INSERT instead of the
    // alphabetically-first candidate. The previous behavior produced
    // DUPLICATE_EXTERNAL_ID errors at run time when the chosen field
    // wasn't actually unique; falling back to a plain insert lets the
    // user see DUPLICATE_VALUE per-record (more actionable) and avoids
    // truncated batches in jsforce's bulk upsert path.
    console.warn(
      `[forge] upsert: no externalId candidate is non-null+unique across batch ` +
        `(${candidates.map((c) => c.name).join(', ')}) — falling back to insert`,
    );
    return undefined;
  }

  private async expandSingleOrphanParent(
    sourceOrgId: string,
    targetOrgId: string,
    parentObject: string,
    sourceRecordId: string,
    recordTypeMappings: RecordTypeMapping[] | undefined,
    recordTypeMapper: RecordTypeMapper | null,
  ): Promise<string | null> {
    // Defense-in-depth: although sourceRecordId originates from a trusted
    // SOQL query result, validate before interpolating to block injection
    // via crafted source-org data (e.g. a managed package supplying a
    // text-typed "reference" through describe).
    if (!SF_RECORD_ID_RE.test(sourceRecordId)) {
      throw new Error(`Invalid Salesforce record ID for orphan expansion: "${sourceRecordId}"`);
    }
    const fields = await this.deps.describeFields(sourceOrgId, parentObject);
    const queryFields = fields.filter((f) => f.queryable).map((f) => f.name);
    if (queryFields.length === 0) queryFields.push('Id');
    const soql = `SELECT ${queryFields.join(', ')} FROM ${assertSoqlIdentifier(parentObject)} WHERE Id = '${sanitizeSoqlValue(sourceRecordId)}'`;
    const records = await this.deps.queryRecords(sourceOrgId, soql);
    if (records.length === 0) return null;

    let targetCreatable: Set<string> | null = null;
    try {
      const targetFields = await this.deps.describeFields(targetOrgId, parentObject);
      targetCreatable = new Set(targetFields.filter((f) => f.createable).map((f) => f.name));
    } catch (err: unknown) {
      // Don't bury the error — the orphan path is high-blast-radius
      // (creates new rows on target). Log so the user sees it in output.
      console.warn(
        `[forge] orphan-parent target describe failed for ${parentObject}: ${err instanceof Error ? err.message : String(err)}. Falling back to source createable.`,
      );
    }
    const sourceCreatable = new Set(fields.filter((f) => f.createable).map((f) => f.name));
    const effectiveCreatable = targetCreatable ? intersect(sourceCreatable, targetCreatable) : sourceCreatable;

    const r = records[0];
    const cleaned: Record<string, unknown> = {};
    const ipaOrphan = r['IsPersonAccount'];
    const isPerson = ipaOrphan === true || ipaOrphan === 'true' || ipaOrphan === 1;
    for (const field of fields) {
      const key = field.name;
      if (!effectiveCreatable.has(key)) continue;
      if (key.endsWith('__pc') && !isPerson) continue;
      if (key === 'Name' && isPerson) continue;
      const value = r[key];
      if (value === null || value === undefined) continue;
      if (field.isReference && typeof value === 'string' && key !== 'RecordTypeId') {
        // FKs on the parent itself: orphan-nullify (no recursion).
        continue;
      }
      cleaned[key] = value;
    }
    const payload = recordTypeMapper && recordTypeMappings
      ? recordTypeMapper.apply([cleaned], recordTypeMappings)[0]
      : cleaned;
    const result = await this.deps.insertRecords(targetOrgId, parentObject, [payload]);
    if (!result[0] || !result[0].success) return null;
    return result[0].id;
  }
}

/**
 * Compact key=value summary of a record (first ~4 fields, values truncated)
 * used for error reporting in {@link ExecutionObjectError.samples}. Keeps
 * payloads small enough to render in the wizard error panel.
 */
function summarizeRecordForError(record: Record<string, unknown>): string {
  const keys = Object.keys(record).slice(0, 4);
  const parts: string[] = [];
  for (const k of keys) {
    const v = record[k];
    // CR-020: explicit handling for undefined and objects so debug output
    // doesn't show '[object Object]' or 'undefined' generically.
    let str: string;
    if (v === null) str = 'null';
    else if (v === undefined) str = 'undefined';
    else if (typeof v === 'string') str = v.length > 30 ? v.slice(0, 30) + '…' : v;
    else if (typeof v === 'object') {
      try {
        const json = JSON.stringify(v);
        str = json.length > 30 ? json.slice(0, 30) + '…' : json;
      } catch {
        str = '<unserializable>';
      }
    }
    else str = String(v);
    parts.push(`${k}=${str}`);
  }
  return parts.join(' ') || '(empty)';
}

/**
 * Object names that the orphan-parent expansion path refuses to fetch
 * even when a child node references them as a required FK. These are
 * either system-managed (User, Group, RecordType) or audit-trail
 * style entities Salesforce won't let us insert anyway. Skipping them
 * here avoids burning API calls + spamming the error panel with
 * predictable REQUIRED_FIELD_MISSING / CANNOT_INSERT failures.
 *
 * CR-018: extended to mirror the BFS-side exclusion list. Without this,
 * orphan-expand could try to clone a BusinessProcess / DandBCompany /
 * ProcessInstance — silently round-tripping the API and littering the
 * error panel with predictable failures.
 */
const EXPANSION_EXCLUDED_OBJECTS = new Set([
  'User',
  'Group',
  'Profile',
  'UserRole',
  'RecordType',
  'Organization',
  'Queue',
  'PermissionSet',
  'BusinessProcess',
  'CurrencyType',
  'DandBCompany',
  'DuplicateRecordItem',
  'DuplicateRecordSet',
  'ProcessInstance',
]);

const EXPANSION_EXCLUDED_SUFFIXES = ['History', 'Feed', 'Share', 'ChangeEvent', '__hd', '__Tag'];

function isExpansionExcludedObject(name: string): boolean {
  if (EXPANSION_EXCLUDED_OBJECTS.has(name)) return true;
  return EXPANSION_EXCLUDED_SUFFIXES.some((s) => name.endsWith(s));
}

/**
 * Intersection of two sets — used to take the safe subset of fields that
 * exist as createable on BOTH the source and target orgs (defends against
 * schema drift between sandboxes).
 */
function intersect(a: Set<string>, b: Set<string>): Set<string> {
  const result = new Set<string>();
  for (const v of a) {
    if (b.has(v)) result.add(v);
  }
  return result;
}

/** Sample of a field that was nullified during clean (used by 2-pass cycle UPDATE). */
interface NullifiedFk {
  /** Field API name on the cloned record (e.g. `AccountId`). */
  field: string;
  /** Source-org ID that the FK pointed to before nullification. */
  sourceRefId: string;
  /** Target objects this FK can reference (for polymorphic awareness). */
  targetObjects: string[];
}

/**
 * Reorder a topologically sorted list so the root object comes first while
 * preserving the relative order of all other nodes. Used in record-scoped
 * mode to guarantee the root record (and the FK values it carries) populate
 * the scope cache before any sibling node from the same cycle wave runs.
 *
 * CR-003: throws if the root is excluded from the graph. In scoped mode
 * the root *must* be cloned; otherwise every child that references it
 * orphan-nullifies its FK silently, producing a disconnected clone.
 * The error surfaces to the UI so the user can either include the root
 * or drop scoped mode.
 */
function bringRootToFront(
  nodes: ForgeGraphNode[],
  rootObjectApiName: string,
): ForgeGraphNode[] {
  const rootIndex = nodes.findIndex((n) => n.objectApiName === rootObjectApiName);
  if (rootIndex < 0) {
    throw new Error(
      `Cannot run scoped clone with root "${rootObjectApiName}" missing from the graph. ` +
        `The root node was excluded or filtered out — re-include it before executing.`,
    );
  }
  const rootNode = nodes[rootIndex];
  if (!rootNode.included) {
    throw new Error(
      `Cannot run scoped clone with root "${rootObjectApiName}" excluded. ` +
        `Children referencing the root would orphan-nullify their FK silently. ` +
        `Either include the root node or switch to non-scoped mode.`,
    );
  }
  if (rootIndex === 0) return nodes;
  const reordered = [...nodes];
  const [root] = reordered.splice(rootIndex, 1);
  reordered.unshift(root);
  return reordered;
}

/**
 * Get the parent object names for a given object based on graph edges.
 * A parent is an object that appears as sourceObject in an edge
 * where the given object is the targetObject.
 */
function getParentObjects(objectApiName: string, graph: ForgeGraph): string[] {
  return graph.edges
    .filter((e) => e.targetObject === objectApiName)
    .map((e) => e.sourceObject);
}

/**
 * Topological sort of graph nodes so parents are processed before children.
 *
 * Uses Kahn's algorithm: nodes with no incoming edges are processed first,
 * then their outgoing edges are removed, revealing the next layer.
 * If cycles exist, remaining nodes are appended at the end.
 */
function topologicalSort(graph: ForgeGraph): ForgeGraphNode[] {
  const nodeMap = new Map<string, ForgeGraphNode>();
  for (const node of graph.nodes) {
    nodeMap.set(node.objectApiName, node);
  }

  // Build in-degree map AND adjacency map in one O(E) pass. Adjacency
  // turns the inner edge scan from O(E) to O(out-degree), critical for
  // big graphs (50K-record clones with 350 SObjects).
  const inDegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of graph.nodes) {
    inDegree.set(node.objectApiName, 0);
  }
  for (const edge of graph.edges) {
    if (inDegree.has(edge.targetObject)) {
      inDegree.set(edge.targetObject, (inDegree.get(edge.targetObject) ?? 0) + 1);
    }
    const list = outgoing.get(edge.sourceObject);
    if (list) list.push(edge.targetObject);
    else outgoing.set(edge.sourceObject, [edge.targetObject]);
  }

  // Start with nodes that have no incoming edges
  const queue: string[] = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) {
      queue.push(name);
    }
  }

  const sorted: ForgeGraphNode[] = [];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);

    const node = nodeMap.get(name);
    if (node) {
      sorted.push(node);
    }

    // Remove outgoing edges via adjacency map (O(out-degree)).
    const targets = outgoing.get(name);
    if (targets) {
      for (const target of targets) {
        if (inDegree.has(target)) {
          const newDegree = (inDegree.get(target) ?? 1) - 1;
          inDegree.set(target, newDegree);
          if (newDegree === 0 && !visited.has(target)) {
            queue.push(target);
          }
        }
      }
    }
  }

  // Append any remaining nodes (cycles)
  for (const node of graph.nodes) {
    if (!visited.has(node.objectApiName)) {
      sorted.push(node);
    }
  }

  return sorted;
}
