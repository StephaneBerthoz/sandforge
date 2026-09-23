/**
 * Orphan expansion stage of the Forge execution pipeline.
 *
 * When a record has a required reference field whose target was *never* in
 * the discovery graph (e.g. `Asset.AccountId` pointing at an Account
 * outside the scoped clone), this stage on-demand:
 *
 *   1. Fetches the missing parent by Id from the source org.
 *   2. Inserts a minimal copy into the target org.
 *   3. Records the source→target mapping in the IdRemapper — onto the
 *      record the target already holds when it refuses the copy as a
 *      duplicate and names that record.
 *
 * Single-hop only — the fetched parent's *own* required FKs are
 * orphan-nullified normally (no recursion). Capped at
 * `maxOrphanParentExpansions` to bound API usage.
 */

import type {
  ExecutionErrorSample,
  ExecutionObjectError,
  FieldInfo,
  ForgeExecutorDeps,
} from '../ForgeExecutor.js';
import type { ForgeGraphNode } from '@sandforge/shared';
import { extractErrorMessage } from '../../../core/common/extractErrorMessage.js';
import { existingRecordOf } from '../../../core/common/existingRecordMatch.js';
import { assertSoqlIdentifier, sanitizeSoqlValue } from '../../../core/common/soqlValidator.js';
import { logger } from '../../../logger.js';
import { isExcludedFromCopy } from '../excludedObjects.js';
import type { IdRemapper } from '../IdRemapper.js';
import type { RecordScopeCache } from '../RecordScopeCache.js';
import {
  warnUnmappedRecordType,
  type RecordTypeMapper,
  type RecordTypeMapping,
} from '../../sync/RecordTypeMapper.js';
import { intersect } from './RecordCleaner.js';

/**
 * Strict Salesforce record ID format (15 or 18 alphanumeric characters).
 * Used as a defense-in-depth check before SOQL interpolation.
 */
const SF_RECORD_ID_RE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

/** Inputs for {@link OrphanExpander.expandForNode}. */
export interface OrphanExpansionInput {
  /** The graph node whose records are about to be inserted. */
  node: ForgeGraphNode;
  /** Source-org field metadata for the node. */
  fieldInfos: FieldInfo[];
  /** Raw records queried from the source org. */
  records: Record<string, unknown>[];
  /** ID of the source Salesforce org. */
  sourceOrgId: string;
  /** ID of the target Salesforce org. */
  targetOrgId: string;
  /** Source→target ID mappings accumulated so far (mutated on success). */
  remapper: IdRemapper;
  /** Scope cache — newly cloned parents are registered for multi-hop scoping. */
  scopeCache: RecordScopeCache | null;
  /** Cross-org RecordType translations applied to the parent's payload. */
  recordTypeMappings: RecordTypeMapping[] | undefined;
  /** Mapper used to rewrite the parent's RecordTypeId (null when no mappings). */
  recordTypeMapper: RecordTypeMapper | null;
  /** Master toggle (`ExecuteOptions.expandOrphanParents`). */
  enabled: boolean;
  /** Cap on expansions per `execute()` call. */
  maxExpansions: number;
  /**
   * Anonymizes a parent's payload before it is inserted, when the run
   * anonymizes: a parent copied from outside the scope carries the same
   * personal data as the rows the run anonymizes.
   */
  anonymize?: (
    objectApiName: string,
    payload: Record<string, unknown>,
    sourceId: string,
    fields: FieldInfo[],
  ) => Record<string, unknown>;
}

/**
 * Single-hop orphan parent expander. Holds the per-`execute()` expansion
 * budget, a negative cache of failed (object, sourceId) pairs, and the
 * sampled expansion errors surfaced in the execution summary.
 */
export class OrphanExpander {
  private expansionsUsed = 0;
  /**
   * Negative cache shared across nodes — once an orphan expansion fails
   * for a given (object, sourceId), don't retry it on every other child
   * that references the same parent. Prevents duplicate target rows when
   * two siblings both reference the same uncloned Account.
   */
  private readonly failedOrphans = new Set<string>();
  private readonly expansionErrors: ExecutionErrorSample[] = [];

  constructor(
    private readonly deps: Pick<
      ForgeExecutorDeps,
      'describeFields' | 'queryRecords' | 'insertRecords' | 'describeObject'
    >,
  ) {}

  /**
   * Expand required orphan parents referenced by this node's records.
   *
   * Identifies required reference fields whose value isn't in the remapper
   * and points outside the discovery graph; fetches+inserts each parent
   * on-demand so the child record can pick up the new target ID instead of
   * failing with REQUIRED_FIELD_MISSING.
   */
  async expandForNode(input: OrphanExpansionInput): Promise<void> {
    if (!input.enabled || this.expansionsUsed >= input.maxExpansions) return;
    const { node, fieldInfos, records, remapper, scopeCache } = input;

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
          // Excluded objects (User, RecordType, Group, job and log tables,
          // history/feed/share/changeevent suffixes) can't be cloned in a
          // meaningful way and would just burn API calls + add noise to the
          // error report. Same list discovery uses, so the two cannot drift.
          if (isExcludedFromCopy(target)) continue;
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
      if (this.expansionsUsed + eligible.length >= input.maxExpansions) break;
      const cacheKey = `${entry.object}::${entry.sourceId}`;
      if (this.failedOrphans.has(cacheKey)) continue;
      if (remapper.get(entry.sourceId)) continue;
      eligible.push({ ...entry, cacheKey });
    }
    for (let i = 0; i < eligible.length; i += ORPHAN_CONCURRENCY) {
      const slice = eligible.slice(i, i + ORPHAN_CONCURRENCY);
      await Promise.all(
        slice.map(async (entry) => {
          try {
            const parent = await this.expandSingleOrphanParent(
              input.sourceOrgId,
              input.targetOrgId,
              entry.object,
              entry.sourceId,
              input.recordTypeMappings,
              input.recordTypeMapper,
              input.anonymize,
            );
            if (parent) {
              // Count only successful expansions toward the cap
              // so a string of misses doesn't silently exhaust the budget
              // before the eligible list has had a chance to succeed.
              this.expansionsUsed++;
              if (parent.existing) remapper.addExisting(entry.sourceId, parent.id, entry.object);
              else remapper.add(entry.sourceId, parent.id, entry.object);
              // Register the parent in scopeCache so multi-hop
              // children that pivot through this object include the
              // newly cloned row in their scope query (otherwise the
              // scope cache reports the orphan as out-of-scope and the
              // child never gets cloned).
              if (scopeCache) {
                scopeCache.add(entry.object, [entry.sourceId]);
              }
            } else {
              this.failedOrphans.add(entry.cacheKey);
              if (this.expansionErrors.length < 3) {
                this.expansionErrors.push({
                  recordSummary: `${entry.object}/${entry.sourceId}`,
                  messages: [`Orphan parent expansion produced no new id`],
                });
              }
            }
          } catch (err) {
            this.failedOrphans.add(entry.cacheKey);
            if (this.expansionErrors.length < 3) {
              this.expansionErrors.push({
                recordSummary: `${entry.object}/${entry.sourceId}`,
                messages: [extractErrorMessage(err)],
              });
            }
          }
        }),
      );
    }
  }

  /**
   * Build the aggregated error entry for the execution summary, or `null`
   * when no expansion failed. Mirrors the `__expandOrphanParents__` report
   * the legacy executor appended at the end of `execute()`.
   */
  buildErrorReport(): ExecutionObjectError | null {
    if (this.expansionErrors.length === 0) return null;
    return {
      objectApiName: '__expandOrphanParents__',
      stage: 'insert',
      failedCount: this.expansionErrors.length,
      attemptedCount: this.expansionsUsed,
      samples: this.expansionErrors,
    };
  }

  /**
   * Fetches a missing parent record from the source org by Id, copies it
   * to the target org with a minimal payload (createable target fields
   * only, RecordType remapped if applicable, orphan FKs nullified), and
   * returns the target ID it now has — the new record's, or the existing
   * one's when the target refuses the copy as a duplicate and names the
   * record it holds. Returns `null` when the parent can't be fetched or the
   * insert fails any other way.
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
    anonymize: OrphanExpansionInput['anonymize'],
  ): Promise<{ id: string; existing: boolean } | null> {
    // Defense-in-depth: although sourceRecordId originates from a trusted
    // SOQL query result, validate before interpolating to block injection
    // via crafted source-org data (e.g. a managed package supplying a
    // text-typed "reference" through describe).
    if (!SF_RECORD_ID_RE.test(sourceRecordId)) {
      throw new Error(`Invalid Salesforce record ID for orphan expansion: "${sourceRecordId}"`);
    }
    // The object name comes from a describe's `referenceTo` and goes into the
    // REST path of both describes below, not only into the SOQL. Checking it
    // only at the SOQL line let an unvalidated name reach two requests first.
    const objectName = assertSoqlIdentifier(parentObject);
    const fields = await this.deps.describeFields(sourceOrgId, objectName);
    const queryFields = fields.filter((f) => f.queryable).map((f) => f.name);
    if (queryFields.length === 0) queryFields.push('Id');
    const soql = `SELECT ${queryFields.join(', ')} FROM ${objectName} WHERE Id = '${sanitizeSoqlValue(sourceRecordId)}'`;
    const records = await this.deps.queryRecords(sourceOrgId, soql);
    if (records.length === 0) return null;

    let targetCreatable: Set<string> | null = null;
    try {
      const targetFields = await this.deps.describeFields(targetOrgId, objectName);
      targetCreatable = new Set(targetFields.filter((f) => f.createable).map((f) => f.name));
    } catch (err: unknown) {
      // Don't bury the error — the orphan path is high-blast-radius
      // (creates new rows on target). Log so the user sees it in output.
      logger.warn(
        `[forge] orphan-parent target describe failed for ${parentObject}: ${err instanceof Error ? err.message : String(err)}. Falling back to source createable.`,
      );
    }
    const sourceCreatable = new Set(fields.filter((f) => f.createable).map((f) => f.name));
    const effectiveCreatable = targetCreatable
      ? intersect(sourceCreatable, targetCreatable)
      : sourceCreatable;

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
    const mapped =
      recordTypeMapper && recordTypeMappings
        ? recordTypeMapper.apply([cleaned], recordTypeMappings, (id) =>
            warnUnmappedRecordType(objectName, id),
          )[0]
        : cleaned;
    const payload = anonymize ? anonymize(objectName, mapped, sourceRecordId, fields) : mapped;
    const result = await this.deps.insertRecords(targetOrgId, objectName, [payload]);
    const written = result[0];
    if (!written) return null;
    if (written.success) return { id: written.id, existing: false };
    // The parent is often in the target already — which is why it was not in
    // the graph's reach to begin with. When the refusal names it, the child
    // links to it; it is never written to.
    const keyPrefix = this.deps.describeObject
      ? await this.deps.describeObject(targetOrgId, objectName).then(
          (info) => info.keyPrefix,
          () => null,
        )
      : null;
    const existing = existingRecordOf(written, keyPrefix);
    return existing.kind === 'linked' ? { id: existing.id, existing: true } : null;
  }
}
