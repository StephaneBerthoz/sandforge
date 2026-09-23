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

import {
  PRICEBOOK_ENTRY_BOOK_FIELD,
  STANDARD_PRICEBOOK_SOQL,
  isPricebookEntry,
} from '@sandforge/shared';
import type { GuardDecision } from '@sandforge/shared';
import type { OperationRequest } from '../../core/precheck/ProductionGuard.js';
import type { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { consultProductionGuard } from '../../core/precheck/consultProductionGuard.js';
import { assertSoqlIdentifier, sanitizeSoqlValue } from '../../core/common/soqlValidator.js';
import {
  ACCOUNT_CONTACT_RELATION,
  STATUS_LIFECYCLES,
  draftStartOf,
  statusCategories,
  type StatusCategories,
} from '../../core/common/platformRecords.js';
import { insertionGroups, orderWithinGroup } from '../../core/common/insertionOrder.js';
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
  type MissingRequiredField,
  type PerObjectLoadResult,
  type PicklistRule,
  type PlaceholderCreation,
  type PurgeReport,
  type SafetyTier,
  type SchemaAlignObjectResult,
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
  orgAccess: Omit<TargetOrgAccess, 'count'>;
  writer: FrozenDmlWriter;
  /**
   * Existing ProductionGuard — tier check on every DML batch. Each decision
   * goes to the caller of `load` through `onGuardDecision`, and the bridge
   * records the load with it in the audit trail.
   */
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
  /**
   * What Production Guard decided about each DML batch, as it decides it —
   * a refusal included, before the load stops on it. The bridge records the
   * run with the most telling of them.
   */
  onGuardDecision?: (decision: GuardDecision) => void;
  /**
   * The load's cancel. Honoured before each write: the purge of each object,
   * each placeholder, each object of the insert pass, and each pass after it.
   * The load then keeps its mapping and stops with
   * {@link FrozenLoadCancelledError}; nothing after the cancel is written.
   */
  signal?: AbortSignal;
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

/**
 * Raised when the load's cancel stops it between two writes. The mapping is
 * kept by then, so a reload finds what the load wrote; `written` says what
 * that was, for the audit trail.
 */
export class FrozenLoadCancelledError extends Error {
  constructor(readonly written: Pick<FrozenLoadReport, 'perObject' | 'placeholders' | 'purge'>) {
    super(
      'The load was cancelled before it had written the whole dataset. What it wrote is kept in ' +
        'the mapping: a reload reuses or purges it.',
    );
    this.name = 'FrozenLoadCancelledError';
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

/** Ids per `IN` list in the load's own reads of the target. */
const ID_IN_CHUNK = 200;

/** A status set aside at insert, to apply once the record is in. */
interface DeferredStatus {
  objectApiName: string;
  referenceId: string;
  status: string;
}

/** One object's results, from two insert calls made for it. */
function mergeResults(
  first: PerObjectLoadResult,
  second: PerObjectLoadResult,
): PerObjectLoadResult {
  return {
    objectApiName: second.objectApiName,
    fromFiles: first.fromFiles + second.fromFiles,
    inserted: first.inserted + second.inserted,
    reused: first.reused + second.reused,
    skippedDuplicates: [...first.skippedDuplicates, ...second.skippedDuplicates],
    failed: [...first.failed, ...second.failed],
  };
}

/** A placeholder the load will create, everything about it already known. */
interface PlaceholderPlan {
  kind: 'placeholder';
  missing: MissingRequiredField;
  /** `Object.field` of the lookup it fills. */
  key: string;
  name: string;
  targetObject: string;
  recordTypeId?: string;
}

/** How one required field the dataset leaves empty will be filled. */
type RequiredFieldPlan = PlaceholderPlan | { kind: 'default'; missing: MissingRequiredField };

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
    const groups = insertionGroups(dependencies);
    const groupOrder = groups.flat();

    // 3. Reload: reuse by identity keys, then purge residuals (children
    //    before parents — reverse insertion order; unknown objects last).
    const mapping = new Map<string, string>();
    const reused = new Set<string>();
    // The standard price book is matched, never inserted: every org has
    // exactly one and none can be created. Matched before a reload purges,
    // so the purge never reaches for it.
    if (working.standardPricebook) {
      const [book] = await this.deps.orgAccess.query(orgId, STANDARD_PRICEBOOK_SOQL);
      if (typeof book?.Id === 'string') {
        mapping.set(working.standardPricebook, book.Id);
        reused.add(working.standardPricebook);
      }
    }
    const purge: PurgeReport = { deleted: {}, deactivated: {}, failures: [] };
    const placeholders: PlaceholderCreation[] = [];
    const perObject: PerObjectLoadResult[] = [];

    /*
     * Stop at a cancel, before the next write. A load read no cancel: once
     * started it purged, inserted and patched to its end. The mapping is kept
     * first, with the entries of the previous one this load has not replaced:
     * a reload then finds and purges what this load wrote, and the residuals
     * it had not purged yet. Kept as this load's alone, it would lose them.
     */
    const checkpoint = async (): Promise<void> => {
      if (!options.signal?.aborted) return;
      await this.deps.mappingStore.persist(new Map([...previousMapping, ...mapping]));
      throw new FrozenLoadCancelledError({ perObject, placeholders, purge });
    };

    if (options.reload) {
      emit({ phase: 'reload', status: 'started', progress: 5, message: 'Reusing reference data' });
      await this.reuseByIdentityKeys(options, working, mapping, reused);
      if (!options.pilot) {
        await this.purgeResiduals(
          options,
          previousMapping,
          mapping,
          [...groupOrder].reverse(),
          purge,
          checkpoint,
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
    /** Lookups the target will not take empty, per object — from its describe. */
    const requiredLookups = new Map<string, Set<string>>();
    for (const objectData of working.objects) {
      const objectApiName = objectData.objectApiName;
      // An extraction writes a file for every object of the graph, and most
      // hold nothing for the dossiers kept: of a real Opportunity dataset's 69
      // objects, 56 were empty. With nothing to write there is nothing to
      // describe, align or satisfy — and asking, the load stopped on the
      // first required field of the first empty object, demanding a default
      // for records that did not exist.
      if (objectData.records.length === 0) continue;
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
      requiredLookups.set(
        objectApiName,
        new Set(
          describe.fields
            .filter(
              (f) =>
                f.createable &&
                !f.nillable &&
                !f.defaultedOnCreate &&
                (f.referenceTo?.length ?? 0) > 0,
            )
            .map((f) => f.name),
        ),
      );
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
    const requiredDefaults: FrozenLoadReport['requiredDefaults'] = [];
    // Everything the dataset needs is settled before the first placeholder is
    // written. One at a time, a load created the placeholders it could, then
    // stopped on the first default nobody had declared: technical records
    // left in the target for a load that did not happen, and one missing
    // entry reported per attempt.
    const plans = await this.planRequiredFields(options, alignment.objectResults);
    for (const plan of plans) {
      if (plan.kind === 'placeholder') {
        await checkpoint();
        await this.createPlaceholder(options, plan, alignedByObject, mapping, placeholders);
      } else {
        this.applyScalarDefault(plan.missing, alignedByObject, requiredDefaults);
      }
    }
    emit({
      phase: 'placeholders',
      status: 'done',
      progress: 25,
      message: 'Required fields handled',
    });

    // 7. Insert pass 1 (topological order; cycle FKs nullified, queued).
    // Inside a cycle, a lookup the target requires cannot wait for pass 2,
    // so the object it points at goes first.
    const insertOrder = groups.flatMap((group) =>
      group.length > 1
        ? orderWithinGroup(group, requiredDependencies(alignedByObject, requiredLookups, refIndex))
        : group,
    );
    const pendingFk: PendingFk[] = [];
    const deferredStatuses: DeferredStatus[] = [];
    const duplicatePatterns =
      this.config.duplicateErrorPatterns ?? DEFAULT_DUPLICATE_ERROR_PATTERNS;
    let objectIndex = 0;
    for (const objectApiName of insertOrder) {
      const aligned = alignedByObject.get(objectApiName);
      if (!aligned) {
        continue; // object excluded from target — listed in alignment.excludedObjects
      }
      await checkpoint();
      objectIndex++;
      emit({
        phase: 'insert',
        objectName: objectApiName,
        status: 'started',
        progress: 25 + Math.round((55 * objectIndex) / Math.max(insertOrder.length, 1)),
        message: `Inserting ${objectApiName}`,
      });
      if (objectApiName === ACCOUNT_CONTACT_RELATION) {
        await this.matchDirectRelations(orgId, working, aligned, mapping, reused);
      }
      const fromFiles =
        working.objects.find((o) => o.objectApiName === objectApiName)?.records.length ??
        aligned.length;
      const lifecycle = STATUS_LIFECYCLES[objectApiName];
      const startingRecords = lifecycle
        ? await this.startAsDrafts(orgId, objectApiName, lifecycle, aligned, deferredStatuses)
        : aligned;
      const insert = (
        records: Array<{ referenceId: string; fields: Record<string, unknown> }>,
        count: number,
      ): Promise<PerObjectLoadResult> =>
        this.insertObject(
          options,
          objectApiName,
          count,
          records,
          refIndex,
          mapping,
          reused,
          pendingFk,
          duplicatePatterns,
        );
      // A custom price is refused for a product with no standard one, so the
      // standard prices are written first, in a call of their own.
      const standardRef = working.standardPricebook;
      const objectResult =
        isPricebookEntry(objectApiName) && standardRef
          ? mergeResults(
              await insert(
                startingRecords.filter((r) => r.fields[PRICEBOOK_ENTRY_BOOK_FIELD] === standardRef),
                0,
              ),
              await insert(
                startingRecords.filter((r) => r.fields[PRICEBOOK_ENTRY_BOOK_FIELD] !== standardRef),
                fromFiles,
              ),
            )
          : await insert(startingRecords, fromFiles);
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
    await checkpoint();
    emit({ phase: 'pass2', status: 'started', progress: 82, message: 'Patching cycle FKs' });
    const pass2 = await this.patchCycleFks(options, pendingFk, mapping);
    emit({
      phase: 'pass2',
      status: pass2.unresolved.length > 0 ? 'error' : 'done',
      progress: 88,
      message: `Pass 2: ${pass2.resolved} resolved, ${pass2.unresolved.length} unresolved`,
    });

    // 8b. Statuses set aside at insert, now that each record's children are in.
    await checkpoint();
    const statuses = await this.applyDeferredStatuses(options, deferredStatuses, mapping);
    if (statuses.restored + statuses.refused.length > 0) {
      emit({
        phase: 'pass2',
        status: statuses.refused.length > 0 ? 'error' : 'done',
        progress: 89,
        message: `Statuses: ${statuses.restored} applied, ${statuses.refused.length} refused`,
      });
    }

    // 9. PersonContact post-load — sidecar resolved through the mapping.
    await checkpoint();
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
    // Nor is the contract written after a cancel that came during that pass:
    // an upload the cancel aborted wrote nothing and answered nothing, and
    // the contract would count as loaded what the pass never wrote.
    await checkpoint();

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
      statuses.refused.length > 0 ||
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
      statuses,
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

  /**
   * Run one DML batch past the existing ProductionGuard: a tier check, a
   * decision kept in the guard's session log when
   * `sandforge.safety.auditLogging` is on, and handed to the caller.
   */
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
    const { check, decision } = await consultProductionGuard(this.deps.guard, request);
    options.onGuardDecision?.(decision);
    if (decision === 'refused' || decision === 'declined') {
      throw new LoadGuardError(
        'guard-refused',
        `Production guard refused ${operation} on ${objectApiName}: ${check.blockedReason ?? 'confirmation declined'}`,
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
    checkpoint: () => Promise<void>,
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
    // An activated order keeps its products and itself from being deleted —
    // "unable to modify activated order" — and the last load activated them.
    // Back to a draft first, and the deletes below can do their work.
    for (const [objectApiName, lifecycle] of Object.entries(STATUS_LIFECYCLES)) {
      const ids = residualsByObject.get(objectApiName);
      if (!ids || ids.length === 0) continue;
      const draft = (await this.statusCategories(options.orgId, lifecycle))?.draft;
      if (!draft) continue;
      await checkpoint();
      await this.checkGuard(options, 'update', objectApiName, ids.length);
      // A refusal here shows again, with its reason, as the delete that follows.
      await this.deps.writer.update(
        options.orgId,
        objectApiName,
        ids.map((id) => ({ Id: id, Status: draft })),
      );
    }
    const known = reverseOrder.filter((o) => residualsByObject.has(o));
    const unknown = [...residualsByObject.keys()].filter((o) => !reverseOrder.includes(o)).sort();
    for (const objectApiName of [...known, ...unknown]) {
      const ids = residualsByObject.get(objectApiName) ?? [];
      const deactivationField = this.config.undeletableObjects?.[objectApiName];
      if (deactivationField !== undefined) {
        await checkpoint();
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
        // A standard price goes only once the custom prices of its product
        // have: asked for both in one call, the target refused the standard
        // one with an UNKNOWN_EXCEPTION. The insert's rule, run backwards.
        const rounds = isPricebookEntry(objectApiName)
          ? await this.customPricesFirst(options.orgId, ids)
          : objectApiName === ACCOUNT_CONTACT_RELATION
            ? [await this.withoutDirectRelations(options.orgId, ids)]
            : [ids];
        for (const round of rounds) {
          if (round.length === 0) continue;
          await checkpoint();
          await this.checkGuard(options, 'delete', objectApiName, round.length);
          const outcomes = await this.deps.writer.delete(options.orgId, objectApiName, round);
          // Already gone is what a purge wants: a parent deleted a step
          // earlier takes its cascading children with it. Run for real, a
          // reload counted ten of those as failures and called a clean load
          // one with errors.
          outcomes.forEach((outcome, i) => {
            if (outcome.success || outcome.errors.some((e) => e.includes('ENTITY_IS_DELETED'))) {
              purge.deleted[objectApiName] = (purge.deleted[objectApiName] ?? 0) + 1;
            } else {
              purge.failures.push({ objectApiName, recordId: round[i], errors: outcome.errors });
            }
          });
        }
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
    if (targetId !== null && typeof targetId === 'object') {
      // Kept, every record naming it is refused; dropped, the record goes in
      // with the running user's default record type — and says so here.
      delete fields.RecordTypeId;
      issues.push({
        objectApiName,
        referenceId: record.referenceId,
        recordTypeName: rtName,
        detail:
          `RecordType ${developerName} is in the target org but not available to the running ` +
          "user — RecordTypeId dropped, the user's default record type applies. Assign it to " +
          "the user's profile or a permission set to keep it.",
      });
      return { referenceId: record.referenceId, fields };
    }
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

  /**
   * Settle every required field the dataset leaves empty, writing nothing.
   *
   * Each one needs a declared placeholder (a lookup) or a declared default (a
   * scalar), and a placeholder needs an object to create and, when one is
   * named, a record type the target has. All of it is checked here, reading
   * only, and every gap goes into one error — so a person fixes the
   * configuration once, and a refused load has written nothing.
   *
   * @throws {LoadConfigError} Listing every gap found.
   */
  private async planRequiredFields(
    options: FrozenLoadOptions,
    objectResults: SchemaAlignObjectResult[],
  ): Promise<RequiredFieldPlan[]> {
    const plans: RequiredFieldPlan[] = [];
    const gaps: string[] = [];
    for (const objectResult of objectResults) {
      for (const missing of objectResult.missingRequired) {
        const key = `${missing.objectApiName}.${missing.field}`;
        if (!missing.isLookup) {
          if (this.config.requiredFieldDefaults?.[key] === undefined) {
            gaps.push(`requiredFieldDefaults["${key}"]: a value for this required field`);
          } else {
            plans.push({ kind: 'default', missing });
          }
          continue;
        }
        const spec = this.config.requiredLookupPlaceholders?.[key];
        if (!spec) {
          gaps.push(
            `requiredLookupPlaceholders["${key}"]: a placeholder (name + recordTypeDeveloperName) ` +
              `for this required lookup to ${missing.referenceTo.join(' or ') || 'its parent'}`,
          );
          continue;
        }
        const targetObject = spec.targetObjectApiName ?? missing.referenceTo[0];
        if (!targetObject) {
          gaps.push(
            `requiredLookupPlaceholders["${key}"].targetObjectApiName: the target describe ` +
              'names no object this lookup points at',
          );
          continue;
        }
        let recordTypeId: string | undefined;
        if (spec.recordTypeDeveloperName) {
          const resolved = await this.deps.recordTypeResolver.resolveByDeveloperName(
            options.orgId,
            targetObject,
            spec.recordTypeDeveloperName,
          );
          if (resolved !== null && typeof resolved === 'object') {
            gaps.push(
              `requiredLookupPlaceholders["${key}"]: record type ${spec.recordTypeDeveloperName} ` +
                `on ${targetObject} is not available to the running user`,
            );
            continue;
          }
          recordTypeId = resolved ?? undefined;
          if (!recordTypeId) {
            gaps.push(
              `requiredLookupPlaceholders["${key}"]: record type ${spec.recordTypeDeveloperName} ` +
                `is not on ${targetObject} in the target org — deploy it before loading`,
            );
            continue;
          }
        }
        plans.push({
          kind: 'placeholder',
          missing,
          key,
          name: spec.name,
          targetObject,
          recordTypeId,
        });
      }
    }
    if (gaps.length > 0) {
      throw new LoadConfigError(
        `The dataset leaves ${gaps.length} required field(s) empty that the configuration does ` +
          'not cover. Nothing was written. Declare them all, then load again — records are ' +
          `never silently excluded:\n- ${gaps.join('\n- ')}`,
      );
    }
    return plans;
  }

  /** Create ONE technical placeholder for a required lookup missing from the dataset. */
  private async createPlaceholder(
    options: FrozenLoadOptions,
    plan: PlaceholderPlan,
    alignedByObject: Map<string, Array<{ referenceId: string; fields: Record<string, unknown> }>>,
    mapping: Map<string, string>,
    placeholders: PlaceholderCreation[],
  ): Promise<void> {
    const { missing, key, targetObject } = plan;
    const record: Record<string, unknown> = { Name: plan.name };
    if (plan.recordTypeId) record.RecordTypeId = plan.recordTypeId;
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
      placeholderName: plan.name,
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
    // Settled by planRequiredFields: a default is declared for every key here.
    const value = this.config.requiredFieldDefaults?.[key];
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
        // No value is left out, and the platform decides: its default, the
        // running user as owner. The `clear` generator marks what it removed
        // with '', and sent as '' or null a field is given a value — a wrong
        // one. Run for real: an owner "cannot be blank", a date "cannot
        // deserialize ''", a feed item's revision "cannot be less than 1".
        if (value === '' || value === null || value === undefined) continue;
        if (typeof value === 'string' && refIndex.has(value)) {
          const realId = mapping.get(value);
          if (realId) {
            payload[field] = realId;
          } else {
            // Cycle (target inserted later) or a parent skipped/failed:
            // left empty now, pass 2 resolves or lists it — never opaque.
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

  /**
   * Find the relations the platform created itself.
   *
   * Inserting a Contact with an AccountId makes Salesforce create the direct
   * AccountContactRelation between them. The dataset carries that relation
   * too — it was read from the source — and inserting it again is refused:
   * "the contact already has a relationship with this account". So the one
   * the platform made is looked up, mapped and counted as reused.
   */
  private async matchDirectRelations(
    orgId: string,
    working: FrozenDataset,
    aligned: Array<{ referenceId: string; fields: Record<string, unknown> }>,
    mapping: Map<string, string>,
    reused: Set<string>,
  ): Promise<void> {
    const accountOfContact = new Map<string, unknown>();
    for (const contact of working.objects.find((o) => o.objectApiName === 'Contact')?.records ??
      []) {
      accountOfContact.set(contact.referenceId, contact.fields.AccountId);
    }
    // Direct: the relation joins a Contact to the Account it was created with.
    const direct = aligned.filter((r) => {
      const contactRef = r.fields.ContactId;
      return (
        typeof contactRef === 'string' &&
        r.fields.AccountId !== undefined &&
        accountOfContact.get(contactRef) === r.fields.AccountId &&
        mapping.has(contactRef) &&
        typeof r.fields.AccountId === 'string' &&
        mapping.has(r.fields.AccountId)
      );
    });
    if (direct.length === 0) return;
    const contactIds = [...new Set(direct.map((r) => mapping.get(r.fields.ContactId as string)))];
    const rows = await this.deps.orgAccess.query(
      orgId,
      'SELECT Id, AccountId, ContactId FROM AccountContactRelation WHERE IsDirect = true ' +
        `AND ContactId IN (${contactIds.map((id) => `'${sanitizeSoqlValue(String(id))}'`).join(', ')})`,
    );
    const byPair = new Map(
      rows.map((row) => [`${String(row.AccountId)}|${String(row.ContactId)}`, row.Id]),
    );
    for (const relation of direct) {
      const accountId = mapping.get(relation.fields.AccountId as string);
      const contactId = mapping.get(relation.fields.ContactId as string);
      const id = byPair.get(`${String(accountId)}|${String(contactId)}`);
      if (typeof id === 'string') {
        mapping.set(relation.referenceId, id);
        reused.add(relation.referenceId);
      }
    }
  }

  /**
   * Put records whose status is past Draft in at a Draft status, and keep
   * the real one for {@link applyDeferredStatuses}.
   *
   * The categories are the target's own — `OrderStatus` and `ContractStatus`
   * list every value with its category — so nothing about a customised
   * picklist is guessed. A target that cannot say leaves the records as they
   * are, and the insert reports what it refuses.
   */
  private async startAsDrafts(
    orgId: string,
    objectApiName: string,
    lifecycle: string,
    aligned: Array<{ referenceId: string; fields: Record<string, unknown> }>,
    deferred: DeferredStatus[],
  ): Promise<Array<{ referenceId: string; fields: Record<string, unknown> }>> {
    const categories = await this.statusCategories(orgId, lifecycle);
    if (!categories?.draft) return aligned;
    return aligned.map((record) => {
      const draft = draftStartOf(record.fields.Status, categories);
      if (!draft) return record;
      deferred.push({
        objectApiName,
        referenceId: record.referenceId,
        status: String(record.fields.Status),
      });
      return { referenceId: record.referenceId, fields: { ...record.fields, Status: draft } };
    });
  }

  /**
   * Relations the purge leaves to the platform: a direct one cannot be
   * deleted — "delete the contact instead" — and goes with its contact,
   * which the purge deletes a step later.
   */
  private async withoutDirectRelations(orgId: string, ids: readonly string[]): Promise<string[]> {
    const direct = new Set<string>();
    for (let i = 0; i < ids.length; i += ID_IN_CHUNK) {
      const inList = ids
        .slice(i, i + ID_IN_CHUNK)
        .map((id) => `'${sanitizeSoqlValue(id)}'`)
        .join(', ');
      const rows = await this.deps.orgAccess.query(
        orgId,
        `SELECT Id FROM ${ACCOUNT_CONTACT_RELATION} WHERE Id IN (${inList}) AND IsDirect = true`,
      );
      for (const row of rows) direct.add(String(row.Id));
    }
    return ids.filter((id) => !direct.has(id));
  }

  /** Price entry ids split into custom prices, then standard ones. */
  private async customPricesFirst(orgId: string, ids: readonly string[]): Promise<string[][]> {
    const standard = new Set<string>();
    for (let i = 0; i < ids.length; i += ID_IN_CHUNK) {
      const inList = ids
        .slice(i, i + ID_IN_CHUNK)
        .map((id) => `'${sanitizeSoqlValue(id)}'`)
        .join(', ');
      const rows = await this.deps.orgAccess.query(
        orgId,
        `SELECT Id FROM PricebookEntry WHERE Id IN (${inList}) AND Pricebook2.IsStandard = true`,
      );
      for (const row of rows) standard.add(String(row.Id));
    }
    return [ids.filter((id) => !standard.has(id)), ids.filter((id) => standard.has(id))];
  }

  /**
   * The target's statuses for a lifecycle object, each with its category,
   * and one status of the Draft category — or nothing, when the target
   * cannot say (the object is not enabled there).
   */
  private async statusCategories(
    orgId: string,
    lifecycle: string,
  ): Promise<StatusCategories | undefined> {
    return statusCategories((soql) => this.deps.orgAccess.query(orgId, soql), lifecycle);
  }

  /** Apply the statuses {@link startAsDrafts} set aside, record by record. */
  private async applyDeferredStatuses(
    options: FrozenLoadOptions,
    deferred: readonly DeferredStatus[],
    mapping: ReadonlyMap<string, string>,
  ): Promise<FrozenLoadReport['statuses']> {
    const refused: FrozenLoadReport['statuses']['refused'] = [];
    let restored = 0;
    const byObject = new Map<string, Array<DeferredStatus & { id: string }>>();
    for (const entry of deferred) {
      const id = mapping.get(entry.referenceId);
      // Not inserted: its failure is already in perObject.
      if (!id) continue;
      byObject.set(entry.objectApiName, [
        ...(byObject.get(entry.objectApiName) ?? []),
        { ...entry, id },
      ]);
    }
    for (const [objectApiName, entries] of byObject) {
      const records = entries.map((e) => ({ Id: e.id, Status: e.status }));
      await this.checkGuard(options, 'update', objectApiName, records.length);
      const outcomes = await this.deps.writer.update(options.orgId, objectApiName, records);
      outcomes.forEach((outcome, i) => {
        if (outcome.success) {
          restored++;
        } else {
          refused.push({
            objectApiName,
            referenceId: entries[i].referenceId,
            status: entries[i].status,
            detail: outcome.errors.join('; '),
          });
        }
      });
    }
    return { restored, refused };
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
 * Object → objects its records point at through a lookup the target requires.
 * Only these must be satisfied at insert; every other FK can wait for pass 2.
 */
function requiredDependencies(
  alignedByObject: ReadonlyMap<string, Array<{ fields: Record<string, unknown> }>>,
  requiredLookups: ReadonlyMap<string, ReadonlySet<string>>,
  refIndex: ReadonlyMap<string, string>,
): Map<string, Set<string>> {
  const deps = new Map<string, Set<string>>();
  for (const [objectApiName, records] of alignedByObject) {
    const required = requiredLookups.get(objectApiName);
    const set = new Set<string>();
    if (required) {
      for (const record of records) {
        for (const field of required) {
          const value = record.fields[field];
          const target = typeof value === 'string' ? refIndex.get(value) : undefined;
          if (target && target !== objectApiName) set.add(target);
        }
      }
    }
    deps.set(objectApiName, set);
  }
  return deps;
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
