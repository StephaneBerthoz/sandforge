import type { ForgeGraph, ForgeGraphNode, ForgeNodeStatus } from '@sandforge/shared';
import { IdRemapper } from './IdRemapper.js';
import { ForgeBatchStrategy as ForgeBatchStrategyService } from './ForgeBatchStrategy.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
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

  /** Pause execution between batches. */
  pause(): void {
    this.isPaused = true;
  }

  /** Resume execution after pause. */
  resume(): void {
    this.isPaused = false;
    this.pauseResolve?.();
    this.pauseResolve = null;
  }

  /** Abort execution. Resumes any paused state to propagate the abort. */
  abort(): void {
    this.isAborted = true;
    this.resume();
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
      newId: string;
      fieldName: string;
      sourceRefId: string;
    }
    const pendingFkUpdates: PendingFkUpdate[] = [];

    /** Counter for the single-hop orphan parent expansion (Wave 2 v4). */
    const expandOrphanParents = options?.expandOrphanParents ?? false;
    const maxOrphanExpansions = options?.maxOrphanParentExpansions ?? 20;
    let orphanExpansionsUsed = 0;
    const orphanExpansionErrors: ExecutionErrorSample[] = [];

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
        } catch {
          // describe failed — proceed and let the insert path surface the error.
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

        if (options?.maxRecordsPerObject && options.maxRecordsPerObject > 0) {
          soql += ` LIMIT ${Math.floor(options.maxRecordsPerObject)}`;
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
          } catch {
            // describe failed on target — fall back to source schema. Will
            // surface as INVALID_FIELD errors on insert which the caller can act on.
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
                const key = `${target}::${value}`;
                if (!requiredOrphans.has(key)) {
                  requiredOrphans.set(key, { object: target, sourceId: value });
                }
                break;
              }
            }
          }
          for (const [, entry] of requiredOrphans) {
            if (orphanExpansionsUsed >= maxOrphanExpansions) break;
            orphanExpansionsUsed++;
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
                remapper.add(entry.sourceId, newId);
              } else if (orphanExpansionErrors.length < 3) {
                orphanExpansionErrors.push({
                  recordSummary: `${entry.object}/${entry.sourceId}`,
                  messages: [`Orphan parent expansion produced no new id`],
                });
              }
            } catch (err) {
              if (orphanExpansionErrors.length < 3) {
                orphanExpansionErrors.push({
                  recordSummary: `${entry.object}/${entry.sourceId}`,
                  messages: [extractErrorMessage(err)],
                });
              }
            }
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
          let remapped = remapper.remapRecord(r, lookupFields);
          for (const nf of nullifiedFks) {
            remapped[nf.field] = null;
          }
          const isPersonAccount = remapped['IsPersonAccount'] === true;
          const cleaned: Record<string, unknown> = {};
          for (const key of Object.keys(remapped)) {
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

        for (let b = 0; b < batchCount; b++) {
          await this.waitIfPaused();

          const batch = remappedRecords.slice(b * batchSize, (b + 1) * batchSize);
          const results = await this.deps.insertRecords(
            targetOrgId,
            node.objectApiName,
            batch,
          );

          // Step 4: Register new IDs for this batch + capture failure samples.
          // Use filteredRecords (post required-FK skip) for the source-ID
          // lookup so remapper entries point at the correct origin record.
          for (let i = 0; i < results.length; i++) {
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
                for (const nf of built.nullifiedFks) {
                  pendingFkUpdates.push({
                    objectApiName: node.objectApiName,
                    newId: result.id,
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

          recordOffset += batch.length;

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

        if (nodeFailure > 0 && nodeSuccess === 0) {
          failedObjects.add(node.objectApiName);
          onProgress({
            objectName: node.objectApiName,
            status: 'error',
            progress: 100,
            message: `Failed all ${node.objectApiName} records`,
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
              recordSummary: `Id=${upd.newId} ${upd.fieldName}=<source ${upd.sourceRefId}>`,
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
        const existing = perObj.get(upd.newId) ?? { Id: upd.newId };
        existing[upd.fieldName] = newRefId;
        perObj.set(upd.newId, existing);
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
  private async expandSingleOrphanParent(
    sourceOrgId: string,
    targetOrgId: string,
    parentObject: string,
    sourceRecordId: string,
    recordTypeMappings: RecordTypeMapping[] | undefined,
    recordTypeMapper: RecordTypeMapper | null,
  ): Promise<string | null> {
    const fields = await this.deps.describeFields(sourceOrgId, parentObject);
    const queryFields = fields.filter((f) => f.queryable).map((f) => f.name);
    if (queryFields.length === 0) queryFields.push('Id');
    const soql = `SELECT ${queryFields.join(', ')} FROM ${assertSoqlIdentifier(parentObject)} WHERE Id = '${sourceRecordId}'`;
    const records = await this.deps.queryRecords(sourceOrgId, soql);
    if (records.length === 0) return null;

    let targetCreatable: Set<string> | null = null;
    try {
      const targetFields = await this.deps.describeFields(targetOrgId, parentObject);
      targetCreatable = new Set(targetFields.filter((f) => f.createable).map((f) => f.name));
    } catch {
      // fall back to source createable
    }
    const sourceCreatable = new Set(fields.filter((f) => f.createable).map((f) => f.name));
    const effectiveCreatable = targetCreatable ? intersect(sourceCreatable, targetCreatable) : sourceCreatable;

    const r = records[0];
    const cleaned: Record<string, unknown> = {};
    const isPerson = r['IsPersonAccount'] === true;
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
    const str =
      v === null
        ? 'null'
        : typeof v === 'string'
          ? v.length > 30
            ? v.slice(0, 30) + '…'
            : v
          : String(v);
    parts.push(`${k}=${str}`);
  }
  return parts.join(' ') || '(empty)';
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
 */
function bringRootToFront(
  nodes: ForgeGraphNode[],
  rootObjectApiName: string,
): ForgeGraphNode[] {
  const rootIndex = nodes.findIndex((n) => n.objectApiName === rootObjectApiName);
  if (rootIndex <= 0) return nodes;
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

  // Build in-degree map (count of edges where this node is the target)
  const inDegree = new Map<string, number>();
  for (const node of graph.nodes) {
    inDegree.set(node.objectApiName, 0);
  }
  for (const edge of graph.edges) {
    if (inDegree.has(edge.targetObject)) {
      inDegree.set(edge.targetObject, (inDegree.get(edge.targetObject) ?? 0) + 1);
    }
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

    // Remove outgoing edges from this node
    for (const edge of graph.edges) {
      if (edge.sourceObject === name && inDegree.has(edge.targetObject)) {
        const newDegree = (inDegree.get(edge.targetObject) ?? 1) - 1;
        inDegree.set(edge.targetObject, newDegree);
        if (newDegree === 0 && !visited.has(edge.targetObject)) {
          queue.push(edge.targetObject);
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
