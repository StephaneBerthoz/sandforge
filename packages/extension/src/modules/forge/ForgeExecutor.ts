import type { ForgeGraph, ForgeGraphNode, ForgeNodeStatus } from '@sandforge/shared';
import { IdRemapper } from './IdRemapper.js';
import { ForgeBatchStrategy as ForgeBatchStrategyService } from './ForgeBatchStrategy.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { RecordScopeCache } from './RecordScopeCache.js';
import { ScopedSoqlBuilder } from './ScopedSoqlBuilder.js';
import { ReferenceDataMapper } from './ReferenceDataMapper.js';
import { RecordTypeMapper } from '../sync/RecordTypeMapper.js';
import type { RecordTypeMapping } from '../sync/RecordTypeMapper.js';
import { resolveStageConfig, type ForgeStageConfig } from './stages/ForgeStageConfig.js';
import {
  buildNodeQuery,
  getParentObjects,
  seedOwnIds,
  seedScopeCache,
  sortNodesForExecution,
} from './stages/ScopeResolver.js';
import { OrphanExpander } from './stages/OrphanExpander.js';
import { cleanNodeRecords, describeTargetFieldSets, intersect } from './stages/RecordCleaner.js';
import { BatchWriter, type PendingFkUpdate } from './stages/BatchWriter.js';
import { patchCycleFkUpdates } from './stages/CycleFkPatcher.js';

/**
 * Raised when the user aborts a forge run.
 *
 * A distinct type is required, not a plain Error: the per-node catch treats
 * every thrown value as a node-level failure, records it and moves on to the
 * next object. An abort raised as a generic Error was therefore absorbed by
 * that handler and the run kept writing to the target org.
 */
export class ForgeAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForgeAbortedError';
  }
}

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
  anonymize?: (
    records: Record<string, unknown>[],
    objectApiName: string,
  ) => Record<string, unknown>[];
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
  /**
   * Full source→target ID mapping table produced during execution. Lets
   * the caller audit which source-org record became which target-org
   * record (BA need: post-clone reconciliation, CSV export, or a "where
   * did this Account go on the new sandbox?" lookup). Always populated
   * — empty Record when no inserts succeeded. Persisted as part of the
   * checkpoint state for resume.
   */
  remapTable: Record<string, string>;
}

/**
 * Per-`execute()` shared state threaded through the node pipeline. The
 * stages receive the slices they need; the executor stays the single owner
 * of counters, error reports and ID mappings.
 */
interface ExecutionState {
  /** Normalized stage configuration resolved from `ExecuteOptions`. */
  readonly config: ForgeStageConfig;
  readonly sourceOrgId: string;
  readonly targetOrgId: string;
  readonly graph: ForgeGraph;
  readonly onProgress: (event: ForgeProgressEvent) => void;
  readonly remapper: IdRemapper;
  /** Scope cache — `null` outside record-scoped mode. */
  readonly scopeCache: RecordScopeCache | null;
  /** Scoped SOQL builder — `null` outside record-scoped mode. */
  readonly scopedBuilder: ScopedSoqlBuilder | null;
  /** RecordType translator — `null` when no mappings were supplied. */
  readonly recordTypeMapper: RecordTypeMapper | null;
  readonly referenceDataMapper: ReferenceDataMapper;
  readonly orphanExpander: OrphanExpander;
  readonly batchWriter: BatchWriter;
  /** Objects whose downstream children must be skipped. */
  readonly failedObjects: Set<string>;
  readonly errors: ExecutionObjectError[];
  /** Nullified cycle FKs queued for the pass-2 UPDATE. */
  readonly pendingFkUpdates: PendingFkUpdate[];
  successCount: number;
  failedCount: number;
  skippedCount: number;
}

/**
 * Executes a Forge plan by processing graph nodes in topological order.
 *
 * Thin orchestrator over the stage pipeline in `./stages/`:
 * ScopeResolver (ordering + SOQL) → OrphanExpander (Wave 2 v4) →
 * RecordCleaner (remap/nullify/strip) → BatchWriter (insert/upsert) →
 * CycleFkPatcher (pass-2 cycle FK UPDATE). For each included node the
 * executor queries records from the source org, lets the stages transform
 * and write them, and tracks new ID mappings. Errors on a parent cause
 * dependent children to be skipped.
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
      throw new ForgeAbortedError(
        'Forge execution was aborted by user request. No further batches will be processed.',
      );
    }
    if (!this.isPaused) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.pauseResolve = resolve;
    });
    if (this.isAborted) {
      throw new ForgeAbortedError(
        'Forge execution was aborted while paused. No further batches will be processed.',
      );
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

    const config = resolveStageConfig(options);
    const state: ExecutionState = {
      config,
      sourceOrgId,
      targetOrgId,
      graph,
      onProgress,
      remapper: new IdRemapper(),
      scopeCache: config.isScoped ? new RecordScopeCache() : null,
      scopedBuilder: config.isScoped ? new ScopedSoqlBuilder() : null,
      recordTypeMapper:
        config.recordTypeMappings && config.recordTypeMappings.length > 0
          ? new RecordTypeMapper()
          : null,
      referenceDataMapper: new ReferenceDataMapper((orgId, soql) =>
        this.deps.queryRecords(orgId, soql),
      ),
      orphanExpander: new OrphanExpander(this.deps),
      batchWriter: new BatchWriter(this.deps, this.deps.batchStrategy),
      failedObjects: new Set<string>(),
      errors: [],
      pendingFkUpdates: [],
      successCount: 0,
      failedCount: 0,
      skippedCount: 0,
    };

    if (state.scopeCache && config.rootRecordId && config.rootObjectApiName) {
      state.scopeCache.add(config.rootObjectApiName, [config.rootRecordId]);
    }

    const sortedNodes = sortNodesForExecution(
      graph,
      config.isScoped ? config.rootObjectApiName : undefined,
    );

    for (const node of sortedNodes) {
      // Abort is checked per node, not only per batch: waitIfPaused() runs
      // between batches, so a node small enough to fit one batch never reached
      // it, and the per-node catch below swallowed every error anyway — the
      // loop advanced to the next object and kept writing after Abort.
      //
      // Throwing rather than breaking keeps abort a single signal: the caller
      // sees ForgeAbortedError whether the user hit Abort mid-batch or between
      // objects, instead of a rejection in one case and a partial summary that
      // looks like success in the other.
      if (this.isAborted) {
        throw new ForgeAbortedError(
          'Forge execution was aborted by user request. Remaining objects were not processed.',
        );
      }

      if (!node.included) {
        state.skippedCount++;
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
      const hasFailedParent = parentObjects.some((p) => state.failedObjects.has(p));
      if (hasFailedParent) {
        state.skippedCount++;
        state.failedObjects.add(node.objectApiName);
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
      if (!config.dryRun && this.deps.isObjectCreatable) {
        try {
          const creatable = await this.deps.isObjectCreatable(targetOrgId, node.objectApiName);
          if (!creatable) {
            state.skippedCount++;
            state.errors.push({
              objectApiName: node.objectApiName,
              stage: 'scope',
              failedCount: 0,
              attemptedCount: 0,
              samples: [
                {
                  recordSummary: '(node-level skip)',
                  messages: [`Object is not createable on target org`],
                },
              ],
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
          state.errors.push({
            objectApiName: node.objectApiName,
            stage: 'scope',
            failedCount: 0,
            attemptedCount: 0,
            samples: [
              {
                recordSummary: '(target describe failed)',
                messages: [
                  `isObjectCreatable check failed: ${err instanceof Error ? err.message : String(err)}`,
                ],
              },
            ],
          });
        }
      }

      await this.executeNode(node, state);
    }

    // Pass 2 — patch nullified cycle FKs whose targets are now cloned.
    const pass2Error = await patchCycleFkUpdates({
      pendingFkUpdates: state.pendingFkUpdates,
      remapper: state.remapper,
      updateRecords: this.deps.updateRecords,
      targetOrgId,
      enabled: !config.dryRun,
      onProgress,
    });
    if (pass2Error) {
      state.errors.push(pass2Error);
    }

    const orphanExpansionError = state.orphanExpander.buildErrorReport();
    if (orphanExpansionError) {
      state.errors.push(orphanExpansionError);
    }

    return {
      successCount: state.successCount,
      failedCount: state.failedCount,
      skippedCount: state.skippedCount,
      remapCount: state.remapper.count,
      errors: state.errors,
      // BA reconciliation: dump the full source→target ID map so callers
      // can audit, export to CSV, or persist as part of a checkpoint.
      // toJSON returns a plain object (Record) so it serializes cleanly
      // through the bridge envelope.
      remapTable: state.remapper.toJSON(),
    };
  }

  /**
   * Run one node through the stage pipeline: scope query → reference-data
   * mapping / dry-run short-circuits → target describe → orphan expansion →
   * clean → RecordType translation → anonymization → batch write.
   *
   * Owns the node-level `try/catch`: any stage failure marks the node as
   * failed (children skip) and surfaces in the error report.
   */
  private async executeNode(node: ForgeGraphNode, state: ExecutionState): Promise<void> {
    const { config, sourceOrgId, targetOrgId, onProgress, remapper } = state;
    try {
      // Step 1: Scanning — describe fields to build SOQL and filter sets
      onProgress({
        objectName: node.objectApiName,
        status: 'scanning',
        progress: 0,
        message: `Querying ${node.objectApiName} records...`,
      });

      const fieldInfos = await this.deps.describeFields(sourceOrgId, node.objectApiName);
      const createableSet = new Set(fieldInfos.filter((f) => f.createable).map((f) => f.name));

      const query = buildNodeQuery({
        node,
        edges: state.graph.edges,
        fieldInfos,
        scopedBuilder: state.scopedBuilder,
        scopeCache: state.scopeCache,
        rootObjectApiName: config.rootObjectApiName,
        rootRecordId: config.rootRecordId,
        extraWhere: config.objectSoqlFilters?.[node.objectApiName],
        maxRecordsPerObject: config.maxRecordsPerObject,
      });
      if (query.kind === 'skip') {
        state.skippedCount++;
        state.errors.push({
          objectApiName: node.objectApiName,
          stage: 'scope',
          failedCount: 0,
          attemptedCount: 0,
          samples: [{ recordSummary: '(no record queried)', messages: [query.reason] }],
        });
        onProgress({
          objectName: node.objectApiName,
          status: 'skipped',
          progress: 100,
          message: `Skipped ${node.objectApiName} (out of scope: ${query.reason})`,
        });
        return;
      }

      const records = await this.deps.queryRecords(sourceOrgId, query.soql);

      // Reference-data branch: resolve source IDs against target rows by
      // Name/DeveloperName instead of cloning. Adds entries to the IdRemapper
      // so downstream FKs pick up the correct target IDs naturally.
      if (config.referenceDataObjects.has(node.objectApiName) && !config.dryRun) {
        const refResolve = await state.referenceDataMapper.resolve(
          node.objectApiName,
          records,
          targetOrgId,
        );
        for (const m of refResolve.mappings) {
          remapper.add(m.sourceId, m.targetId);
        }
        if (refResolve.unmatched.length > 0) {
          state.errors.push({
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
        if (state.scopeCache) {
          seedOwnIds(state.scopeCache, node.objectApiName, records);
        }
        state.successCount += refResolve.mappings.length;
        onProgress({
          objectName: node.objectApiName,
          status: 'done',
          progress: 100,
          message: `Mapped ${node.objectApiName} via reference-data lookup: ${refResolve.mappings.length} resolved, ${refResolve.unmatched.length} unmatched`,
        });
        return;
      }

      if (state.scopeCache) {
        seedScopeCache(state.scopeCache, node.objectApiName, records, fieldInfos);
      }

      if (config.dryRun) {
        onProgress({
          objectName: node.objectApiName,
          status: 'done',
          progress: 100,
          message: `[dry-run] ${node.objectApiName}: ${records.length} record(s) would be inserted`,
        });
        state.successCount += records.length;
        return;
      }

      // Step 2: describe the *target* org (schema-drift defense) — the only
      // way to detect missing fields/picklist drift before insert.
      let targetCreatableSet: Set<string> | null = null;
      let targetPicklistValuesByField: Map<string, Set<string>> | null = null;
      try {
        const targetSets = await describeTargetFieldSets(
          this.deps.describeFields,
          targetOrgId,
          node.objectApiName,
        );
        targetCreatableSet = targetSets.creatable;
        targetPicklistValuesByField = targetSets.picklistValuesByField;
      } catch (err: unknown) {
        // Surface schema-drift defense failure: target describe is the
        // *only* way to detect missing fields/picklist drift before
        // insert. Without this signal the user sees cryptic INVALID_FIELD
        // and can't tell if it's drift or auth.
        state.errors.push({
          objectApiName: node.objectApiName,
          stage: 'scope',
          failedCount: 0,
          attemptedCount: 0,
          samples: [
            {
              recordSummary: '(target describe failed — falling back to source schema)',
              messages: [err instanceof Error ? err.message : String(err)],
            },
          ],
        });
      }
      const effectiveCreatableSet = targetCreatableSet
        ? intersect(createableSet, targetCreatableSet)
        : createableSet;

      // Wave 2 v4 — single-hop orphan parent expansion. Runs before the
      // clean stage so expanded parents land in the remapper and children
      // pick up the new target ID instead of orphan-nullifying.
      await state.orphanExpander.expandForNode({
        node,
        fieldInfos,
        records,
        sourceOrgId,
        targetOrgId,
        remapper,
        scopeCache: state.scopeCache,
        recordTypeMappings: config.recordTypeMappings,
        recordTypeMapper: state.recordTypeMapper,
        enabled: config.expandOrphanParents,
        maxExpansions: config.maxOrphanParentExpansions,
      });

      const cleanedRecords = cleanNodeRecords({
        records,
        fieldInfos,
        remapper,
        referenceFallback: config.referenceFallback,
        ownerMappings: config.ownerMappings,
        // Per-node field exclusions and renames are record-invariant —
        // resolved once per node rather than per record.
        excludedFields: new Set(config.fieldExclusions[node.objectApiName] ?? []),
        fieldRename: config.fieldMappings[node.objectApiName] ?? {},
        creatableFields: effectiveCreatableSet,
        picklistValuesByField: targetPicklistValuesByField,
      });
      let recordsToInsert = cleanedRecords.map((b) => b.cleaned);
      if (state.recordTypeMapper && config.recordTypeMappings) {
        recordsToInsert = state.recordTypeMapper.apply(recordsToInsert, config.recordTypeMappings);
      }

      // Step 2b: Apply anonymization if configured
      if (this.deps.anonymize) {
        recordsToInsert = this.deps.anonymize(recordsToInsert, node.objectApiName);
      }

      // Step 3: Running — batch and insert into target
      const writeResult = await state.batchWriter.writeNode({
        node,
        records: recordsToInsert,
        cleanedRecords,
        fieldInfos,
        creatableFields: effectiveCreatableSet,
        upsertMode: config.upsertMode,
        targetOrgId,
        remapper,
        waitIfPaused: () => this.waitIfPaused(),
        onProgress,
      });
      const nodeSuccess = writeResult.successCount;
      const nodeFailure = writeResult.failureCount;
      state.successCount += nodeSuccess;
      state.failedCount += nodeFailure;
      state.pendingFkUpdates.push(...writeResult.pendingFkUpdates);

      if (nodeFailure > 0) {
        state.errors.push({
          objectApiName: node.objectApiName,
          stage: 'insert',
          failedCount: nodeFailure,
          attemptedCount: nodeSuccess + nodeFailure,
          samples: writeResult.errorSamples,
        });
      }

      // Fail-fast on partial-but-mostly-failure: if >50% of records
      // failed, mark the node as failed so downstream children skip
      // (their FKs would orphan-nullify and silently corrupt the clone).
      const total = nodeSuccess + nodeFailure;
      const failureRate = total > 0 ? nodeFailure / total : 0;
      if (nodeFailure > 0 && (nodeSuccess === 0 || failureRate > 0.5)) {
        state.failedObjects.add(node.objectApiName);
        onProgress({
          objectName: node.objectApiName,
          status: 'error',
          progress: 100,
          message:
            nodeSuccess === 0
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
      // An abort is a control-flow signal, not a node failure. Recording it as
      // one and continuing is what let a cancelled run carry on writing.
      if (err instanceof ForgeAbortedError) {
        throw err;
      }
      state.failedObjects.add(node.objectApiName);
      state.failedCount += node.recordCount;
      state.errors.push({
        objectApiName: node.objectApiName,
        stage: 'query',
        failedCount: node.recordCount,
        attemptedCount: node.recordCount,
        samples: [
          { recordSummary: '(stage failed before insert)', messages: [extractErrorMessage(err)] },
        ],
      });
      onProgress({
        objectName: node.objectApiName,
        status: 'error',
        progress: 100,
        message: `Error on ${node.objectApiName}: ${extractErrorMessage(err)}`,
      });
    }
  }
}
