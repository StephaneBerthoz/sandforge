/**
 * Frozen dataset loader: replays a frozen dataset into a fresh
 * sandbox, REPLAYABLY — reload without refresh reuses the reference data
 * by identity keys and purges residuals children-before-parents.
 *
 * Pipeline (every divergence is listed in the report, nothing is silent):
 *   1. entry guards (LoadGuards.ts) — sandbox-only, protected envs,
 *      mocked callouts, non-empty dataset;
 *   2. reload: reuse by configured identity keys, then purge residuals
 *      children-before-parents (undeletable objects are DEACTIVATED);
 *   3. schema alignment (SchemaAligner.ts) incl. RecordType resolution by
 *      DeveloperName and picklist RecordType-gap checks;
 *   4. technical placeholders for required lookups absent from the dataset
 *      — named, correctly record-typed, never an exclusion;
 *   5. insert pass 1 in topological order — cycle FKs are nullified and
 *      queued, then patched in pass 2 (pattern of forge CycleFkPatcher);
 *   6. PersonContact post-load: the sidecar referenceId→referenceId pairs
 *      are resolved through the persisted mapping and posted as targeted
 *      Account.PersonContactId updates;
 *   7. the referenceId→real-ID mapping is persisted in
 *      the sas, and the counting contract (files minus exclusions) is
 *      written for the PostLoadVerifier.
 *
 * Native anti-duplicate rejections of the target are an EXPLICIT degraded
 * mode: the record is skipped and listed, never an opaque error.
 */

import type { OperationRequest } from '../../core/precheck/ProductionGuard.js';
import type { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { assertSoqlIdentifier, sanitizeSoqlValue } from '../../core/common/soqlValidator.js';
import { SasPathGuard } from './SasPathGuard.js';
import { assertLoadGuards, LoadGuardError } from './LoadGuards.js';
import { SchemaAligner } from './SchemaAligner.js';
import {
  writeCountingContract,
  countingContractPath,
  type CountingContractEntry,
} from './CountingContract.js';
import type { FrozenManifest } from './manifest.js';
import type {
  FrozenDataset,
  FrozenRecord,
  RecordTypeIdResolver,
  ReferenceIdMappingStore,
} from './types.js';
import {
  DEFAULT_DUPLICATE_ERROR_PATTERNS,
  type CalloutMockDetector,
  type FailedRecord,
  type FrozenDmlWriter,
  type FrozenLoadConfig,
  type FrozenLoadProgressEvent,
  type FrozenLoadReport,
  type PerObjectLoadResult,
  type PicklistRule,
  type PlaceholderCreation,
  type PurgeReport,
  type SafetyTier,
  type SchemaAlignmentReport,
  type SkippedDuplicate,
  type TargetOrgAccess,
} from './loadTypes.js';

/** Mapping store access required by the loader (engine interface + read). */
export interface LoadMappingStore extends ReferenceIdMappingStore {
  load(): Promise<Map<string, string>>;
  readonly filePath: string;
}

/** Dependencies of {@link FrozenDatasetLoader}. */
export interface FrozenDatasetLoaderDeps {
  orgAccess: TargetOrgAccess;
  writer: FrozenDmlWriter;
  /** Existing ProductionGuard — tier checks + audit trail on every DML batch. */
  guard: ProductionGuard;
  mockDetector: CalloutMockDetector;
  /** Engine extension point — target RecordType resolution by DeveloperName. */
  recordTypeResolver: RecordTypeIdResolver;
  /** Engine extension point — referenceId→real-ID persistence (sas). */
  mappingStore: LoadMappingStore;
  config?: FrozenLoadConfig;
  sasGuard?: SasPathGuard;
}

/** Options of one load run. */
export interface FrozenLoadOptions {
  orgId: string;
  /** Existing safety-tier classification (ProductionGuard). */
  orgTier: SafetyTier;
  dataset: FrozenDataset;
  /** Frozen manifest — its source org is cross-checked by the guards. */
  manifest?: FrozenManifest;
  /** Sas directory (mapping + counting contract). Must be outside the repo. */
  sasDir: string;
  /**
   * Reload without refresh: reuse by identity keys and purge residuals
   * children-before-parents. Ignored for the purge in pilot mode (a pilot
   * smoke test never reconciles the whole org).
   */
  reload?: boolean;
  /** Pilot mode: load ONE root folder (~2 min smoke test) before the full load. */
  pilot?: { rootReferenceId?: string };
  /** Progress sink — the bridge consumes these callbacks. */
  onProgress?: (event: FrozenLoadProgressEvent) => void;
  /** Clock injection for deterministic tests. */
  now?: () => Date;
}

/** Error thrown when required configuration is missing (actionable). */
export class LoadConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoadConfigError';
  }
}

/** A cycle FK nullified at pass 1, to patch at pass 2. */
interface PendingFk {
  objectApiName: string;
  /** referenceId of the CHILD record carrying the FK. */
  referenceId: string;
  field: string;
  /** referenceId carried by the FK at pass 1. */
  targetReferenceId: string;
}

/** Synthetic mapping key prefix for placeholder records. */
const PLACEHOLDER_KEY_PREFIX = 'placeholder:';

/** Recover the object API name from a mapping key (record or placeholder). */
function objectFromMappingKey(referenceId: string): string {
  if (referenceId.startsWith(PLACEHOLDER_KEY_PREFIX)) {
    // Format: placeholder:<targetObject>:<Object.field>
    return referenceId.split(':')[1] ?? 'Unknown';
  }
  const dash = referenceId.lastIndexOf('-');
  return dash > 0 ? referenceId.slice(0, dash) : 'Unknown';
}

/** Quote a scalar dataset value for SOQL. */
function soqlLiteral(value: unknown): string {
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }
  return `'${sanitizeSoqlValue(String(value))}'`;
}

export class FrozenDatasetLoader {
  private readonly config: FrozenLoadConfig;
  private readonly sasGuard: SasPathGuard;

  constructor(private readonly deps: FrozenDatasetLoaderDeps) {
    this.config = deps.config ?? {};
    this.sasGuard = deps.sasGuard ?? new SasPathGuard();
  }

  /** Load (or reload) the frozen dataset into the target sandbox. */
  async load(options: FrozenLoadOptions): Promise<FrozenLoadReport> {
    const now = options.now ?? (() => new Date());
    const startedAt = now();
    const emit = (event: FrozenLoadProgressEvent): void => options.onProgress?.(event);
    const { orgId } = options;

    // 1. Entry guards — refusal is actionable, never a DML on the source.
    emit({ phase: 'guards', status: 'started', progress: 0, message: 'Evaluating entry guards' });
    await assertLoadGuards({
      orgId,
      orgTier: options.orgTier,
      dataset: options.dataset,
      manifest: options.manifest,
      mockDetector: this.deps.mockDetector,
      protectedOrgIds: this.config.protectedOrgIds,
    });
    emit({ phase: 'guards', status: 'done', progress: 2, message: 'Entry guards passed' });

    const previousMapping = await this.deps.mappingStore.load();

    // 2. Pilot scope — one root folder: its descendants plus the reference
    //    records it (transitively) points at.
    const working = options.pilot
      ? this.filterPilotScope(options.dataset, options.pilot.rootReferenceId)
      : options.dataset;
    const refIndex = buildReferenceIndex(working);
    const dependencies = buildObjectDependencies(working, refIndex);
    const { order, cyclic } = topoOrder(dependencies);
    const insertOrder = [...order, ...cyclic];

    // 3. Reload: reuse by identity keys, then purge residuals (children
    //    before parents — reverse insertion order; unknown objects last).
    const mapping = new Map<string, string>();
    const reused = new Set<string>();
    const purge: PurgeReport = { deleted: {}, deactivated: {}, failures: [] };
    if (options.reload) {
      emit({ phase: 'reload', status: 'started', progress: 5, message: 'Reusing reference data' });
      await this.reuseByIdentityKeys(options, working, mapping, reused);
      if (!options.pilot) {
        await this.purgeResiduals(
          options,
          previousMapping,
          mapping,
          [...cyclic].reverse().concat([...order].reverse()),
          purge,
        );
      }
      emit({ phase: 'reload', status: 'done', progress: 10, message: 'Reload pass done' });
    }

    // 4. RecordType resolution by DeveloperName + PersonContactId strip
    //    (the sidecar restores it post-load — the field does not exist at insert).
    emit({ phase: 'align', status: 'started', progress: 12, message: 'Resolving record types' });
    const recordTypeIssues: SchemaAlignmentReport['recordTypeIssues'] = [];
    const rtResolved = new Map<string, FrozenRecord[]>();
    const resolvedRecordTypes = new Map<string, string>();
    for (const objectData of working.objects) {
      const records: FrozenRecord[] = [];
      for (const record of objectData.records) {
        records.push(
          await this.resolveRecordType(
            options,
            working,
            objectData.objectApiName,
            record,
            resolvedRecordTypes,
            recordTypeIssues,
          ),
        );
      }
      rtResolved.set(objectData.objectApiName, records);
    }

    // 5. Schema alignment per object.
    const aligner = new SchemaAligner(this.deps.orgAccess);
    const alignment: SchemaAlignmentReport = {
      objectResults: [],
      excludedObjects: [],
      removals: [],
      adjustments: [],
      recordTypeIssues,
    };
    const alignedByObject = new Map<
      string,
      Array<{ referenceId: string; fields: Record<string, unknown> }>
    >();
    for (const objectData of working.objects) {
      const objectApiName = objectData.objectApiName;
      let describe;
      try {
        describe = await this.deps.orgAccess.describe(orgId, objectApiName);
      } catch (err) {
        alignment.excludedObjects.push({
          objectApiName,
          reason: `Not present in target org: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
      const result = await aligner.alignObject({
        orgId,
        objectApiName,
        records: rtResolved.get(objectApiName) ?? [],
        describe,
        resolvedRecordTypes,
        ruleFor: (obj, field) => this.picklistRuleFor(obj, field),
      });
      alignment.objectResults.push(result);
      alignment.removals.push(...result.removals);
      alignment.adjustments.push(...result.adjustments);
      alignedByObject.set(
        objectApiName,
        result.alignedRecords.map((fields, i) => ({
          referenceId: (rtResolved.get(objectApiName) ?? [])[i].referenceId,
          fields,
        })),
      );
    }
    emit({ phase: 'align', status: 'done', progress: 20, message: 'Schema aligned' });

    // 6. Placeholders for required lookups absent from the dataset.
    emit({
      phase: 'placeholders',
      status: 'started',
      progress: 22,
      message: 'Checking required fields',
    });
    const placeholders: PlaceholderCreation[] = [];
    const requiredDefaults: FrozenLoadReport['requiredDefaults'] = [];
    for (const objectResult of alignment.objectResults) {
      for (const missing of objectResult.missingRequired) {
        if (missing.isLookup) {
          await this.createPlaceholder(options, missing, alignedByObject, mapping, placeholders);
        } else {
          this.applyScalarDefault(missing, alignedByObject, requiredDefaults);
        }
      }
    }
    emit({
      phase: 'placeholders',
      status: 'done',
      progress: 25,
      message: 'Required fields handled',
    });

    // 7. Insert pass 1 (topological order; cycle FKs nullified, queued).
    const perObject: PerObjectLoadResult[] = [];
    const pendingFk: PendingFk[] = [];
    const duplicatePatterns =
      this.config.duplicateErrorPatterns ?? DEFAULT_DUPLICATE_ERROR_PATTERNS;
    let objectIndex = 0;
    for (const objectApiName of insertOrder) {
      const aligned = alignedByObject.get(objectApiName);
      if (!aligned) {
        continue; // object excluded from target — listed in alignment.excludedObjects
      }
      objectIndex++;
      emit({
        phase: 'insert',
        objectName: objectApiName,
        status: 'started',
        progress: 25 + Math.round((55 * objectIndex) / Math.max(insertOrder.length, 1)),
        message: `Inserting ${objectApiName}`,
      });
      const objectResult = await this.insertObject(
        options,
        objectApiName,
        working.objects.find((o) => o.objectApiName === objectApiName)?.records.length ??
          aligned.length,
        aligned,
        refIndex,
        mapping,
        reused,
        pendingFk,
        duplicatePatterns,
      );
      perObject.push(objectResult);
      emit({
        phase: 'insert',
        objectName: objectApiName,
        status: objectResult.failed.length > 0 ? 'error' : 'done',
        progress: 25 + Math.round((55 * objectIndex) / Math.max(insertOrder.length, 1)),
        message: `${objectApiName}: ${objectResult.inserted} inserted, ${objectResult.reused} reused, ${objectResult.skippedDuplicates.length} duplicates skipped, ${objectResult.failed.length} failed`,
      });
    }

    // 8. Pass 2: patch nullified cycle FKs (CycleFkPatcher pattern).
    emit({ phase: 'pass2', status: 'started', progress: 82, message: 'Patching cycle FKs' });
    const pass2 = await this.patchCycleFks(options, pendingFk, mapping);
    emit({
      phase: 'pass2',
      status: pass2.unresolved.length > 0 ? 'error' : 'done',
      progress: 88,
      message: `Pass 2: ${pass2.resolved} resolved, ${pass2.unresolved.length} unresolved`,
    });

    // 9. PersonContact post-load — sidecar resolved through the mapping.
    emit({
      phase: 'personcontact',
      status: 'started',
      progress: 90,
      message: 'Restoring PersonContact links',
    });
    const personContact = await this.restorePersonContacts(options, working, mapping);
    emit({
      phase: 'personcontact',
      status: personContact.unresolved.length > 0 ? 'error' : 'done',
      progress: 94,
      message: `PersonContact: ${personContact.restored} restored, ${personContact.unresolved.length} unresolved`,
    });

    // 10. Persist mapping + counting contract (sas).
    emit({
      phase: 'persist',
      status: 'started',
      progress: 96,
      message: 'Persisting mapping and contract',
    });
    await this.deps.mappingStore.persist(mapping);
    const contractPath = this.writeContract(options, working, perObject, placeholders, now);
    emit({ phase: 'persist', status: 'done', progress: 98, message: 'Sas artifacts written' });

    const hasErrors =
      perObject.some((o) => o.failed.length > 0) ||
      pass2.unresolved.length > 0 ||
      personContact.unresolved.length > 0 ||
      purge.failures.length > 0;

    const report: FrozenLoadReport = {
      status: hasErrors ? 'completed-with-errors' : 'completed',
      orgId,
      mode: { pilot: options.pilot !== undefined, reload: options.reload === true },
      startedAt: startedAt.toISOString(),
      durationMs: now().getTime() - startedAt.getTime(),
      alignment,
      placeholders,
      requiredDefaults,
      perObject,
      pass2,
      personContact,
      purge,
      mappingPath: this.deps.mappingStore.filePath,
      contractPath,
    };
    emit({
      phase: 'done',
      status: report.status === 'completed' ? 'done' : 'error',
      progress: 100,
      message: `Load ${report.status}`,
    });
    return report;
  }

  /** Guard-check + audit-trail one DML batch through the existing ProductionGuard. */
  private async checkGuard(
    options: FrozenLoadOptions,
    operation: OperationRequest['operation'],
    objectApiName: string,
    recordCount: number,
  ): Promise<void> {
    const request: OperationRequest = {
      orgId: options.orgId,
      orgTier: options.orgTier,
      operation,
      objectName: objectApiName,
      recordCount,
      module: 'frozendataset',
    };
    const result = this.deps.guard.check(request);
    this.deps.guard.logOperation(request, result);
    if (!(await this.deps.guard.confirmIfNeeded(result))) {
      throw new LoadGuardError(
        'guard-refused',
        `Production guard refused ${operation} on ${objectApiName}: ${result.blockedReason ?? 'confirmation declined'}`,
      );
    }
  }

  /** Pilot scope: descendants of the root folder + the reference records it needs. */
  private filterPilotScope(dataset: FrozenDataset, rootReferenceId?: string): FrozenDataset {
    const rootObject = this.config.rootObjectApiName;
    if (!rootObject) {
      throw new LoadConfigError(
        'Pilot mode requires config.rootObjectApiName (the business-folder root object).',
      );
    }
    const rootRecords = dataset.objects.find((o) => o.objectApiName === rootObject)?.records ?? [];
    const root = rootReferenceId ?? rootRecords[0]?.referenceId;
    if (!root || !rootRecords.some((r) => r.referenceId === root)) {
      throw new LoadConfigError(
        `Pilot root ${rootReferenceId ?? '<first>'} not found in ${rootObject} records ` +
          `(${rootRecords.length} in dataset). Provide pilot.rootReferenceId of an existing root record.`,
      );
    }
    const refIndex = buildReferenceIndex(dataset);
    // Descendants: records whose fields point at a reached referenceId.
    const reached = new Set<string>([root]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const objectData of dataset.objects) {
        for (const record of objectData.records) {
          if (reached.has(record.referenceId)) {
            continue;
          }
          if (Object.values(record.fields).some((v) => typeof v === 'string' && reached.has(v))) {
            reached.add(record.referenceId);
            grew = true;
          }
        }
      }
    }
    // Ancestors: reference records the reached records point at (shared referential).
    const ancestorQueue = [...reached];
    while (ancestorQueue.length > 0) {
      const current = ancestorQueue.pop() as string;
      const record = findRecord(dataset, current);
      if (!record) {
        continue;
      }
      for (const value of Object.values(record.fields)) {
        if (typeof value === 'string' && refIndex.has(value) && !reached.has(value)) {
          reached.add(value);
          ancestorQueue.push(value);
        }
      }
    }
    return {
      ...dataset,
      objects: dataset.objects
        .map((o) => ({ ...o, records: o.records.filter((r) => reached.has(r.referenceId)) }))
        .filter((o) => o.records.length > 0),
    };
  }

  /** Reuse existing target records matched by configured identity keys. */
  private async reuseByIdentityKeys(
    options: FrozenLoadOptions,
    working: FrozenDataset,
    mapping: Map<string, string>,
    reused: Set<string>,
  ): Promise<void> {
    for (const [objectApiName, keyFields] of Object.entries(this.config.identityKeys ?? {})) {
      const records = working.objects.find((o) => o.objectApiName === objectApiName)?.records ?? [];
      if (records.length === 0) {
        continue;
      }
      const candidates = records.filter((r) =>
        keyFields.every(
          (f) => r.fields[f] !== undefined && r.fields[f] !== null && r.fields[f] !== '',
        ),
      );
      if (candidates.length === 0) {
        continue;
      }
      const selectFields = ['Id', ...keyFields].map(assertSoqlIdentifier).join(', ');
      const matched = new Map<string, string>(); // tupleKey → real Id
      const CHUNK = 100;
      for (let i = 0; i < candidates.length; i += CHUNK) {
        const where = candidates
          .slice(i, i + CHUNK)
          .map(
            (r) =>
              `(${keyFields.map((f) => `${assertSoqlIdentifier(f)} = ${soqlLiteral(r.fields[f])}`).join(' AND ')})`,
          )
          .join(' OR ');
        const soql = `SELECT ${selectFields} FROM ${assertSoqlIdentifier(objectApiName)} WHERE ${where}`;
        for (const row of await this.deps.orgAccess.query(options.orgId, soql)) {
          if (typeof row.Id === 'string') {
            matched.set(tupleKey(keyFields.map((f) => row[f])), row.Id);
          }
        }
      }
      for (const record of candidates) {
        const realId = matched.get(tupleKey(keyFields.map((f) => record.fields[f])));
        if (realId) {
          mapping.set(record.referenceId, realId);
          reused.add(record.referenceId);
        }
      }
    }
  }

  /**
   * Purge residuals: records of the PREVIOUS mapping not reused by this
   * run. Deletion runs children-before-parents (reverse insertion order;
   * objects unknown to the current graph last). Undeletable objects are
   * deactivated instead.
   */
  private async purgeResiduals(
    options: FrozenLoadOptions,
    previousMapping: Map<string, string>,
    mapping: Map<string, string>,
    reverseOrder: string[],
    purge: PurgeReport,
  ): Promise<void> {
    const residualsByObject = new Map<string, string[]>();
    for (const [referenceId, realId] of previousMapping) {
      if (mapping.has(referenceId)) {
        continue; // reused — kept
      }
      const objectApiName = objectFromMappingKey(referenceId);
      const bucket = residualsByObject.get(objectApiName) ?? [];
      bucket.push(realId);
      residualsByObject.set(objectApiName, bucket);
    }
    const known = reverseOrder.filter((o) => residualsByObject.has(o));
    const unknown = [...residualsByObject.keys()].filter((o) => !reverseOrder.includes(o)).sort();
    for (const objectApiName of [...known, ...unknown]) {
      const ids = residualsByObject.get(objectApiName) ?? [];
      const deactivationField = this.config.undeletableObjects?.[objectApiName];
      if (deactivationField !== undefined) {
        await this.checkGuard(options, 'update', objectApiName, ids.length);
        const outcomes = await this.deps.writer.update(
          options.orgId,
          objectApiName,
          ids.map((id) => ({ Id: id, [deactivationField]: false })),
        );
        outcomes.forEach((outcome, i) => {
          if (outcome.success) {
            purge.deactivated[objectApiName] = (purge.deactivated[objectApiName] ?? 0) + 1;
          } else {
            purge.failures.push({ objectApiName, recordId: ids[i], errors: outcome.errors });
          }
        });
      } else {
        await this.checkGuard(options, 'delete', objectApiName, ids.length);
        const outcomes = await this.deps.writer.delete(options.orgId, objectApiName, ids);
        outcomes.forEach((outcome, i) => {
          if (outcome.success) {
            purge.deleted[objectApiName] = (purge.deleted[objectApiName] ?? 0) + 1;
          } else {
            purge.failures.push({ objectApiName, recordId: ids[i], errors: outcome.errors });
          }
        });
      }
    }
  }

  /**
   * Resolve one record's RecordTypeId (carried as the RT *Name*) to the
   * target ID by DeveloperName — never by label, which differs between
   * orgs (mojibake included). Also
   * strips Account.PersonContactId: restored post-load from the sidecar.
   */
  private async resolveRecordType(
    options: FrozenLoadOptions,
    dataset: FrozenDataset,
    objectApiName: string,
    record: FrozenRecord,
    resolvedRecordTypes: Map<string, string>,
    issues: SchemaAlignmentReport['recordTypeIssues'],
  ): Promise<FrozenRecord> {
    const fields = { ...record.fields };
    if (objectApiName === 'Account') {
      delete fields.PersonContactId;
    }
    const rtName = fields.RecordTypeId;
    if (typeof rtName !== 'string' || rtName === '') {
      delete fields.RecordTypeId;
      return { referenceId: record.referenceId, fields };
    }
    const developerName = (dataset.recordTypes[objectApiName] ?? []).find(
      (rt) => rt.name === rtName,
    )?.developerName;
    if (!developerName) {
      delete fields.RecordTypeId;
      issues.push({
        objectApiName,
        referenceId: record.referenceId,
        recordTypeName: rtName,
        detail: 'RecordType name absent from the dataset recordTypes map — RecordTypeId dropped',
      });
      return { referenceId: record.referenceId, fields };
    }
    const targetId = await this.deps.recordTypeResolver.resolveByDeveloperName(
      options.orgId,
      objectApiName,
      developerName,
    );
    if (!targetId) {
      delete fields.RecordTypeId;
      issues.push({
        objectApiName,
        referenceId: record.referenceId,
        recordTypeName: rtName,
        detail: `RecordType ${developerName} not found in target org — RecordTypeId dropped`,
      });
      return { referenceId: record.referenceId, fields };
    }
    fields.RecordTypeId = targetId;
    resolvedRecordTypes.set(record.referenceId, targetId);
    return { referenceId: record.referenceId, fields };
  }

  /** Create ONE technical placeholder for a required lookup missing from the dataset. */
  private async createPlaceholder(
    options: FrozenLoadOptions,
    missing: { objectApiName: string; field: string; referenceTo: string[] },
    alignedByObject: Map<string, Array<{ referenceId: string; fields: Record<string, unknown> }>>,
    mapping: Map<string, string>,
    placeholders: PlaceholderCreation[],
  ): Promise<void> {
    const key = `${missing.objectApiName}.${missing.field}`;
    const spec = this.config.requiredLookupPlaceholders?.[key];
    if (!spec) {
      throw new LoadConfigError(
        `Required lookup ${key} is absent from the dataset and has no placeholder configured. ` +
          `Remediation: declare requiredLookupPlaceholders["${key}"] (name + recordTypeDeveloperName) ` +
          'so the loader can create a named, record-typed technical record — records are never silently excluded.',
      );
    }
    const targetObject = spec.targetObjectApiName ?? missing.referenceTo[0];
    if (!targetObject) {
      throw new LoadConfigError(
        `Cannot infer the placeholder object for required lookup ${key}: the target describe ` +
          'exposes no referenceTo. Declare requiredLookupPlaceholders targetObjectApiName.',
      );
    }
    const record: Record<string, unknown> = { Name: spec.name };
    if (spec.recordTypeDeveloperName) {
      const rtId = await this.deps.recordTypeResolver.resolveByDeveloperName(
        options.orgId,
        targetObject,
        spec.recordTypeDeveloperName,
      );
      if (!rtId) {
        throw new LoadConfigError(
          `Placeholder RecordType ${spec.recordTypeDeveloperName} not found on ${targetObject} in the ` +
            `target org. Deploy the RecordType metadata before loading (placeholder for ${key}).`,
        );
      }
      record.RecordTypeId = rtId;
    }
    await this.checkGuard(options, 'insert', targetObject, 1);
    const [outcome] = await this.deps.writer.insert(options.orgId, targetObject, [record]);
    if (!outcome.success || !outcome.id) {
      throw new LoadConfigError(
        `Placeholder insert failed for required lookup ${key} on ${targetObject}: ` +
          `${outcome.errors.join('; ') || 'no id returned'}. Fix the target org configuration and retry.`,
      );
    }
    mapping.set(`${PLACEHOLDER_KEY_PREFIX}${targetObject}:${key}`, outcome.id);
    let affected = 0;
    for (const aligned of alignedByObject.get(missing.objectApiName) ?? []) {
      const current = aligned.fields[missing.field];
      if (current === undefined || current === null || current === '') {
        aligned.fields[missing.field] = outcome.id;
        affected++;
      }
    }
    placeholders.push({
      objectApiName: missing.objectApiName,
      field: missing.field,
      placeholderObjectApiName: targetObject,
      placeholderName: spec.name,
      placeholderId: outcome.id,
      affectedRecords: affected,
    });
  }

  /** Apply a declared scalar default for a required field missing from the dataset. */
  private applyScalarDefault(
    missing: { objectApiName: string; field: string },
    alignedByObject: Map<string, Array<{ referenceId: string; fields: Record<string, unknown> }>>,
    applied: FrozenLoadReport['requiredDefaults'],
  ): void {
    const key = `${missing.objectApiName}.${missing.field}`;
    const value = this.config.requiredFieldDefaults?.[key];
    if (value === undefined) {
      throw new LoadConfigError(
        `Required field ${key} is absent from the dataset and has no declared default. ` +
          `Remediation: declare requiredFieldDefaults["${key}"] so the load is explicit — ` +
          'records are never silently excluded.',
      );
    }
    let affected = 0;
    for (const aligned of alignedByObject.get(missing.objectApiName) ?? []) {
      const current = aligned.fields[missing.field];
      if (current === undefined || current === null || current === '') {
        aligned.fields[missing.field] = value;
        affected++;
      }
    }
    applied.push({
      objectApiName: missing.objectApiName,
      field: missing.field,
      value,
      affectedRecords: affected,
    });
  }

  /** Insert pass 1 for one object; queue unresolved FKs for pass 2. */
  private async insertObject(
    options: FrozenLoadOptions,
    objectApiName: string,
    fromFiles: number,
    aligned: Array<{ referenceId: string; fields: Record<string, unknown> }>,
    refIndex: ReadonlyMap<string, string>,
    mapping: Map<string, string>,
    reused: Set<string>,
    pendingFk: PendingFk[],
    duplicatePatterns: readonly string[],
  ): Promise<PerObjectLoadResult> {
    const result: PerObjectLoadResult = {
      objectApiName,
      fromFiles,
      inserted: 0,
      reused: 0,
      skippedDuplicates: [] as SkippedDuplicate[],
      failed: [] as FailedRecord[],
    };
    const toInsert = aligned.filter((r) => !reused.has(r.referenceId));
    result.reused = aligned.length - toInsert.length;
    if (toInsert.length === 0) {
      return result;
    }
    const payloads = toInsert.map((record) => {
      const payload: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(record.fields)) {
        if (typeof value === 'string' && refIndex.has(value)) {
          const realId = mapping.get(value);
          if (realId) {
            payload[field] = realId;
          } else {
            // Cycle (target inserted later) or a parent skipped/failed:
            // nullify now, pass 2 resolves or lists it — never opaque.
            payload[field] = null;
            pendingFk.push({
              objectApiName,
              referenceId: record.referenceId,
              field,
              targetReferenceId: value,
            });
          }
        } else {
          payload[field] = value;
        }
      }
      return payload;
    });
    await this.checkGuard(options, 'insert', objectApiName, payloads.length);
    const outcomes = await this.deps.writer.insert(options.orgId, objectApiName, payloads);
    outcomes.forEach((outcome, i) => {
      const referenceId = toInsert[i].referenceId;
      if (outcome.success && outcome.id) {
        mapping.set(referenceId, outcome.id);
        result.inserted++;
      } else if (isDuplicateRejection(outcome.errors, duplicatePatterns)) {
        result.skippedDuplicates.push({ objectApiName, referenceId, errors: outcome.errors });
      } else {
        result.failed.push({ objectApiName, referenceId, errors: outcome.errors });
      }
    });
    return result;
  }

  /** Pass 2: patch nullified cycle FKs — updates coalesced per record. */
  private async patchCycleFks(
    options: FrozenLoadOptions,
    pendingFk: PendingFk[],
    mapping: ReadonlyMap<string, string>,
  ): Promise<FrozenLoadReport['pass2']> {
    const unresolved: FrozenLoadReport['pass2']['unresolved'] = [];
    const updatesByObject = new Map<string, Map<string, Record<string, unknown>>>();
    const refIdByChildId = new Map<string, string>();
    for (const pending of pendingFk) {
      const childId = mapping.get(pending.referenceId);
      const targetId = mapping.get(pending.targetReferenceId);
      if (!childId || !targetId) {
        unresolved.push({
          objectApiName: pending.objectApiName,
          referenceId: pending.referenceId,
          field: pending.field,
          detail: !childId
            ? 'child record was not loaded (see perObject failures/skips)'
            : `referenced record ${pending.targetReferenceId} was not loaded (skipped, failed or excluded)`,
        });
        continue;
      }
      refIdByChildId.set(childId, pending.referenceId);
      const perObject =
        updatesByObject.get(pending.objectApiName) ?? new Map<string, Record<string, unknown>>();
      const current = perObject.get(childId) ?? { Id: childId };
      current[pending.field] = targetId;
      perObject.set(childId, current);
      updatesByObject.set(pending.objectApiName, perObject);
    }
    let resolved = 0;
    for (const [objectApiName, perObject] of updatesByObject) {
      const records = [...perObject.values()];
      await this.checkGuard(options, 'update', objectApiName, records.length);
      const outcomes = await this.deps.writer.update(options.orgId, objectApiName, records);
      outcomes.forEach((outcome, i) => {
        if (outcome.success) {
          resolved += Object.keys(records[i]).length - 1; // minus Id
        } else {
          unresolved.push({
            objectApiName,
            referenceId: refIdByChildId.get(String(records[i].Id)) ?? String(records[i].Id),
            field: Object.keys(records[i])
              .filter((k) => k !== 'Id')
              .join(','),
            detail: outcome.errors.join('; '),
          });
        }
      });
    }
    return { resolved, unresolved };
  }

  /** PersonContact post-load: resolve the sidecar pairs and post targeted updates. */
  private async restorePersonContacts(
    options: FrozenLoadOptions,
    working: FrozenDataset,
    mapping: ReadonlyMap<string, string>,
  ): Promise<FrozenLoadReport['personContact']> {
    const sidecar = working.personContactSidecar ?? [];
    const unresolved: FrozenLoadReport['personContact']['unresolved'] = [];
    const updates: Array<Record<string, unknown>> = [];
    for (const link of sidecar) {
      const accountId = mapping.get(link.accountReferenceId);
      const contactId = mapping.get(link.contactReferenceId);
      if (!accountId || !contactId) {
        unresolved.push(link);
        continue;
      }
      updates.push({ Id: accountId, PersonContactId: contactId });
    }
    let restored = 0;
    if (updates.length > 0) {
      await this.checkGuard(options, 'update', 'Account', updates.length);
      const outcomes = await this.deps.writer.update(options.orgId, 'Account', updates);
      outcomes.forEach((outcome, i) => {
        if (outcome.success) {
          restored++;
        } else {
          unresolved.push(sidecar[i]);
        }
      });
    }
    return { restored, unresolved };
  }

  /** Write the counting contract (files minus exclusions) into the sas. */
  private writeContract(
    options: FrozenLoadOptions,
    working: FrozenDataset,
    perObject: PerObjectLoadResult[],
    placeholders: PlaceholderCreation[],
    now: () => Date,
  ): string {
    const objects: Record<string, CountingContractEntry> = {};
    for (const result of perObject) {
      const exclusionReasons: Record<string, number> = {};
      if (result.skippedDuplicates.length > 0) {
        exclusionReasons['duplicate-skipped'] = result.skippedDuplicates.length;
      }
      if (result.failed.length > 0) {
        exclusionReasons['dml-failed'] = result.failed.length;
      }
      const excluded = result.skippedDuplicates.length + result.failed.length;
      const added = placeholders.filter(
        (p) => p.placeholderObjectApiName === result.objectApiName,
      ).length;
      objects[result.objectApiName] = {
        fromFiles: result.fromFiles,
        exclusionReasons,
        excluded,
        added,
        expected: result.inserted + result.reused + added,
      };
    }
    return writeCountingContract(this.sasGuard, options.sasDir, {
      version: 1,
      orgId: options.orgId,
      datasetVersion: working.datasetVersion,
      writtenAt: now().toISOString(),
      objects,
    });
  }

  /** Declared picklist rule for `Object.field` (field-specific, else default). */
  private picklistRuleFor(objectApiName: string, field: string): PicklistRule {
    return (
      this.config.picklistRules?.[`${objectApiName}.${field}`] ??
      this.config.defaultPicklistRule ?? { action: 'clear' }
    );
  }

  /** Exposed for tests/docs: the contract path inside a sas directory. */
  contractPath(sasDir: string): string {
    return countingContractPath(this.sasGuard, sasDir);
  }
}

/** referenceId → objectApiName for every record of the dataset. */
function buildReferenceIndex(dataset: FrozenDataset): Map<string, string> {
  const index = new Map<string, string>();
  for (const objectData of dataset.objects) {
    for (const record of objectData.records) {
      index.set(record.referenceId, objectData.objectApiName);
    }
  }
  return index;
}

/** Object → set of objects its records reference (through referenceId-valued fields). */
function buildObjectDependencies(
  dataset: FrozenDataset,
  refIndex: ReadonlyMap<string, string>,
): Map<string, Set<string>> {
  const deps = new Map<string, Set<string>>();
  for (const objectData of dataset.objects) {
    const set = deps.get(objectData.objectApiName) ?? new Set<string>();
    for (const record of objectData.records) {
      for (const value of Object.values(record.fields)) {
        if (typeof value === 'string') {
          const target = refIndex.get(value);
          if (target && target !== objectData.objectApiName) {
            set.add(target);
          }
        }
      }
    }
    deps.set(objectData.objectApiName, set);
  }
  return deps;
}

/**
 * Kahn topological order over the dependency graph: objects with no
 * dependencies (parents) insert first. Cyclic remainders are appended
 * alphabetically — their mutual FKs are handled by the 2-pass pattern.
 */
function topoOrder(deps: ReadonlyMap<string, ReadonlySet<string>>): {
  order: string[];
  cyclic: string[];
} {
  const remaining = new Map([...deps.entries()].map(([k, v]) => [k, new Set(v)]));
  const order: string[] = [];
  for (;;) {
    const ready = [...remaining.entries()]
      .filter(([, d]) => d.size === 0)
      .map(([name]) => name)
      .sort();
    if (ready.length === 0) {
      break;
    }
    for (const name of ready) {
      order.push(name);
      remaining.delete(name);
      for (const d of remaining.values()) {
        d.delete(name);
      }
    }
  }
  return { order, cyclic: [...remaining.keys()].sort() };
}

/** Find a record by referenceId across the dataset. */
function findRecord(dataset: FrozenDataset, referenceId: string): FrozenRecord | undefined {
  for (const objectData of dataset.objects) {
    const found = objectData.records.find((r) => r.referenceId === referenceId);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** Composite identity-key tuple as a stable string. */
function tupleKey(values: unknown[]): string {
  return JSON.stringify(values.map((v) => (v === undefined ? null : v)));
}

/** True when the DML errors match the configured native duplicate markers. */
function isDuplicateRejection(errors: string[], patterns: readonly string[]): boolean {
  return errors.some((e) => patterns.some((p) => e.toLowerCase().includes(p.toLowerCase())));
}
