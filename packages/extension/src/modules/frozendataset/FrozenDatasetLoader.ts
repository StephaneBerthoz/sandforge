/**
 * Frozen dataset loader: replays a frozen dataset into a fresh
 * sandbox, REPLAYABLY — reload without refresh reuses the reference data
 * by identity keys and purges, children-before-parents, what earlier loads
 * created and it does not reuse.
 *
 * Pipeline (every divergence is listed in the report, nothing is silent):
 *   1. entry guards (LoadGuards.ts) — sandbox-only, protected envs,
 *      mocked callouts, non-empty dataset;
 *   2. what the target already holds is matched: the standard price book,
 *      a selling model by its natural key, the option joining a product and
 *      a model both matched — and on a reload the records its identity keys
 *      find;
 *   3. schema alignment (SchemaAligner.ts) incl. RecordType resolution by
 *      DeveloperName and picklist RecordType-gap checks; an object the
 *      target lacks, or takes no insert of, is left out and listed; every
 *      required field the dataset leaves empty is settled against the
 *      configuration, and all the gaps are refused at once;
 *   4. a reload purges what earlier loads created and it did not match,
 *      children-before-parents (undeletable objects are DEACTIVATED), and
 *      never a record they only linked;
 *   5. technical placeholders for required lookups absent from the records
 *      it writes — named, correctly record-typed, never an exclusion;
 *   6. insert pass 1 in topological order — cycle FKs are nullified and
 *      queued, then patched in pass 2 (pattern of forge CycleFkPatcher);
 *   7. PersonContact post-load: the sidecar referenceId→referenceId pairs
 *      are resolved through the persisted mapping and posted as targeted
 *      Account.PersonContactId updates;
 *   8. the referenceId→real-ID mapping is persisted in
 *      the sas — with what the load created, the target's dates of it, and
 *      the loads before it that it did not purge — and the counting contract
 *      (files minus exclusions, and the load it counts) is written for the
 *      PostLoadVerifier.
 *
 * Native anti-duplicate rejections of the target are an EXPLICIT degraded
 * mode: the record is skipped and listed, never an opaque error.
 */

import {
  PRICEBOOK_ENTRY_BOOK_FIELD,
  PRICEBOOK_ENTRY_CURRENCY_FIELD,
  PRICEBOOK_ENTRY_OBJECT,
  PRICEBOOK_ENTRY_PRODUCT_FIELD,
  PRICEBOOK_ENTRY_SELLING_MODEL_FIELD,
  SELLING_MODEL_OPTION_OBJECT,
  STANDARD_PRICEBOOK_SOQL,
  isPricebookEntry,
} from '@sandforge/shared';
import type { ForgeWrittenBetween, GuardDecision } from '@sandforge/shared';
import type { OperationRequest } from '../../core/precheck/ProductionGuard.js';
import type { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { consultProductionGuard } from '../../core/precheck/consultProductionGuard.js';
import { assertSoqlIdentifier, sanitizeSoqlValue } from '../../core/common/soqlValidator.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import {
  ACCOUNT_CONTACT_RELATION,
  EMAIL_MESSAGE,
  NATURAL_KEYS,
  RowsLeftToThePlatform,
  STATUS_LIFECYCLES,
  TASK,
  TASK_RELATION,
  draftStartOf,
  emailWriteEdges,
  existingSellingModelOptions,
  existingTaskRelations,
  leftToThePlatformNote,
  lookupsThePlatformFills,
  recordsByNaturalKey,
  standardPriceIds,
  statusCategories,
  type LeftToThePlatform,
  type PlatformWrittenRows,
  tasksWrittenWithEmails,
  waitsForItsTask,
  withTheRelationItIs,
  type StatusCategories,
} from '../../core/common/platformRecords.js';
import type { OperationOutcome } from '../sync/DataSync.js';
import { leftToThePlatformCoverage } from './manifest.js';
import { insertionGroups, orderWithinGroup } from '../../core/common/insertionOrder.js';
import { catalogWriteEdges } from '../forge/stages/ScopeResolver.js';
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
  LoadCreatedRecords,
  PreviousLoad,
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
  /** The loads the stored mapping records, newest first: what a reload purges. */
  previousLoads(): Promise<PreviousLoad[]>;
  /**
   * Keep, with each load the mapping records, what a reload's purge left on
   * the records of that load it did not delete, by record id: the
   * `LastModifiedDate` the org left on each.
   */
  recordStamps(stamps: Readonly<Record<string, string>>): Promise<boolean>;
  readonly filePath: string;
}

/** Dependencies of {@link FrozenDatasetLoader}. */
export interface FrozenDatasetLoaderDeps {
  orgAccess: Omit<TargetOrgAccess, 'count'>;
  writer: FrozenDmlWriter;
  /**
   * The writer of what a reload gives back on its way out — the statuses its
   * purge set to Draft for deletes that did not come — which a cancel must
   * not stop: `writer` is bound to the load's cancel, and stopped by it,
   * would leave the orders it deactivated as drafts. Absent, `writer` writes
   * it.
   */
  restoringWriter?: FrozenDmlWriter;
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
   * Reload without refresh: reuse by identity keys and purge, children
   * before parents, what earlier loads created and this one does not reuse —
   * never a record they linked. Ignored for the purge in pilot mode (a pilot
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
   * {@link FrozenLoadCancelledError}; nothing after the cancel is written but
   * the statuses a reload's purge set to Draft, given back.
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

/**
 * Raised when a load fails once it has created records, or purged some an
 * earlier load created: a Production Guard refusal after some batches, a
 * placeholder the target refused, a write that threw, a pass after the
 * inserts that did. The mapping is kept by then, as at a cancel — with what
 * the load created so far and the target's dates of it — so a removal takes
 * it back and a reload purges it. `written` says what that was, for the audit
 * trail; the cause says why the load failed.
 */
export class FrozenLoadFailedError extends Error {
  /** Whether the mapping names what the load wrote: false when the sas could not be written. */
  readonly mappingKept: boolean;

  constructor(
    cause: unknown,
    readonly written: Pick<FrozenLoadReport, 'perObject' | 'placeholders' | 'purge'>,
    /** Why the mapping could not be kept, when it could not. */
    notKept?: string,
  ) {
    super(failedLoadMessage(cause, written, notKept), { cause });
    this.name = 'FrozenLoadFailedError';
    this.mappingKept = notKept === undefined;
  }
}

/**
 * What a load that failed once it had written says after why it failed: what
 * it left in the target — the records it created, per object, and how many
 * of the earlier loads' it purged — and whether the mapping names them.
 */
function failedLoadMessage(
  cause: unknown,
  written: Pick<FrozenLoadReport, 'perObject' | 'placeholders' | 'purge'>,
  notKept: string | undefined,
): string {
  const createdPerObject = new Map<string, number>();
  const count = (objectApiName: string, records: number): void => {
    if (records === 0) return;
    createdPerObject.set(objectApiName, (createdPerObject.get(objectApiName) ?? 0) + records);
  };
  for (const placeholder of written.placeholders) count(placeholder.placeholderObjectApiName, 1);
  for (const object of written.perObject) count(object.objectApiName, object.inserted);
  const created = [...createdPerObject.values()].reduce((sum, n) => sum + n, 0);
  const purged = [
    ...Object.values(written.purge.deleted),
    ...Object.values(written.purge.deactivated),
  ].reduce((sum, n) => sum + n, 0);
  const left = [
    ...(created > 0
      ? [
          `created ${created} record(s) (` +
            [...createdPerObject].map(([object, n]) => `${object}: ${n}`).join(', ') +
            ')',
        ]
      : []),
    ...(purged > 0 ? [`purged ${purged} record(s) that earlier loads created`] : []),
  ].join(' and ');
  let named: string;
  if (notKept !== undefined) {
    named =
      created > 0
        ? `The mapping could not be written, and nothing names what it created — no removal or reload will find it: ${notKept}`
        : `The mapping could not be written: ${notKept}`;
  } else {
    named =
      created > 0
        ? 'What it created is kept in the mapping: a removal takes it back, and a reload purges it or finds it again.'
        : 'What the earlier loads created and it did not purge is still named in the mapping, for a removal or the next reload.';
  }
  return `${extractErrorMessage(cause)}\nThe load failed after it had ${left}. ${named}`;
}

/** What a load that fails part way has to keep, handed over by the load before its first write. */
interface LoadInProgress {
  /** Keep its mapping, with what it created so far and the target's dates of it. */
  keepMapping(): Promise<void>;
  /** Whether its mapping was kept already: as it ended, or at a cancel. */
  mappingKept(): boolean;
  /** Whether it created a record, or purged one an earlier load created. */
  wroteSome(): boolean;
  /** What it wrote so far, for the audit trail. */
  written: Pick<FrozenLoadReport, 'perObject' | 'placeholders' | 'purge'>;
}

/**
 * Keep the mapping of a load that failed once it had written — unless its end
 * kept it already — and the error it then ends with.
 */
async function keptAfterFailure(
  cause: unknown,
  load: LoadInProgress,
): Promise<FrozenLoadFailedError> {
  if (!load.mappingKept()) {
    try {
      await load.keepMapping();
    } catch (err: unknown) {
      return new FrozenLoadFailedError(cause, load.written, extractErrorMessage(err));
    }
  }
  return new FrozenLoadFailedError(cause, load.written);
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

/**
 * The keys of the records a load created, per object, in the order it wrote
 * them: what removing the load takes. A record it linked or reused is never
 * among them.
 */
class CreatedKeys {
  private readonly byObject = new Map<string, string[]>();
  /** Objects whose records the load sent audit dates for: see `readWrittenBetween`. */
  private readonly auditDated = new Set<string>();

  /**
   * Note a record the load created.
   *
   * @param auditDates - Whether its insert carried a creation or modification
   *   date: the target then dates the record by that one, not by the load.
   */
  add(objectApiName: string, key: string, auditDates = false): void {
    const keys = this.byObject.get(objectApiName) ?? [];
    keys.push(key);
    this.byObject.set(objectApiName, keys);
    if (auditDates) this.auditDated.add(objectApiName);
  }

  /** Whether the load sent audit dates for some record of the object. */
  sentAuditDates(objectApiName: string): boolean {
    return this.auditDated.has(objectApiName);
  }

  /**
   * As the mapping keeps them: the ones `carried` from the loads before this
   * one — records they created that this load reuses — then the ones this
   * load wrote, one entry per object.
   */
  list(carried: readonly LoadCreatedRecords[] = []): LoadCreatedRecords[] {
    const merged = new Map<string, string[]>();
    const append = (objectApiName: string, keys: readonly string[]): void => {
      merged.set(objectApiName, [...(merged.get(objectApiName) ?? []), ...keys]);
    };
    for (const { objectApiName, referenceIds } of carried) append(objectApiName, referenceIds);
    for (const [objectApiName, keys] of this.byObject) append(objectApiName, keys);
    return [...merged].map(([objectApiName, referenceIds]) => ({ objectApiName, referenceIds }));
  }
}

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

/** A record by its first fifteen characters: the same record, whichever length its id is written in. */
function recordKey(id: string): string {
  return id.slice(0, 15);
}

/** The audit dates a target may let the running user set on the records it creates. */
const AUDIT_DATE_FIELDS = ['CreatedDate', 'LastModifiedDate'] as const;

/**
 * The columns the dates of the load's records are read back by, tried in
 * turn, as a Forge run reads its own: when each was created and last
 * modified, and its system stamp; or, for an object that keeps no
 * `LastModifiedDate`, the system stamp alone.
 */
const WRITTEN_DATE_COLUMNS: readonly (readonly string[])[] = [
  ['CreatedDate', 'LastModifiedDate', 'SystemModstamp'],
  ['SystemModstamp'],
];

/** A date the org wrote, in epoch milliseconds; NaN when there is none to read. */
function epochOf(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}

/**
 * What a reload does with the records the loads before it created: purges
 * the ones it does not reuse, and keeps as created by its own chain the ones
 * it does.
 */
interface PurgePlan {
  /** Per object, the ids to purge. */
  residuals: Map<string, string[]>;
  /**
   * Per record to purge, by record key: the latest `LastModifiedDate` it may
   * carry and still be as its load left it — the target's date of that load's
   * last write, or a later one a removal or a reload of it left on the record.
   * Absent for a record of a load the target did not date.
   */
  datedBy: Map<string, number>;
  /** The keys of this load's mapping that name a record an earlier load created. */
  carried: LoadCreatedRecords[];
  /** Per object, records of a mapping that does not say what its load created, left in place. */
  leftUnrecorded: Record<string, number>;
}

/** A record of an earlier load the purge set to Draft for its delete, and the status it had. */
interface DraftedResidual {
  objectApiName: string;
  id: string;
  /** The Draft status it was set to. */
  draft: string;
  /** The status it had, and gets back if it stays in the org. */
  status: string;
  /**
   * Whether it was as its load left it when the purge set it to Draft: only
   * then is what the purge leaves on it stamped as the purge's doing. A change
   * someone made stays a change.
   */
  unchanged: boolean;
}

/**
 * List among the purge's failures a record it set to Draft and leaves there:
 * with the delete the target refused it, when it did, or on its own.
 */
function leftAtDraft(purge: PurgeReport, record: DraftedResidual, reason: string): void {
  const detail =
    `Status set to ${record.draft} for the purge, and left there: ${record.status} could ` +
    `not be given back — ${reason}`;
  const refused = purge.failures.find(
    (failure) =>
      failure.objectApiName === record.objectApiName &&
      recordKey(failure.recordId) === recordKey(record.id),
  );
  if (refused) refused.errors = [...refused.errors, detail];
  else {
    purge.failures.push({
      objectApiName: record.objectApiName,
      recordId: record.id,
      errors: [detail],
    });
  }
}

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

  /**
   * Load (or reload) the frozen dataset into the target sandbox.
   *
   * A load that fails once it has created records, or purged some an earlier
   * load created, keeps its mapping as a cancelled one does and ends with
   * {@link FrozenLoadFailedError}. Kept only at its end and at a cancel, a
   * load that failed part way was named nowhere: no reload purged what it
   * wrote, no removal could take it back, and the next load did not know it.
   * One that fails before it created or purged a record leaves the mapping as
   * it was, and ends with what it failed on.
   */
  async load(options: FrozenLoadOptions): Promise<FrozenLoadReport> {
    const running: { load?: LoadInProgress } = {};
    try {
      return await this.loadInto(options, running);
    } catch (err: unknown) {
      const load = running.load;
      if (err instanceof FrozenLoadCancelledError || !load?.wroteSome()) throw err;
      throw await keptAfterFailure(err, load);
    }
  }

  /** {@link load}, handing `running` what a failure keeps before its first write. */
  private async loadInto(
    options: FrozenLoadOptions,
    running: { load?: LoadInProgress },
  ): Promise<FrozenLoadReport> {
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

    const previousLoads = await this.deps.mappingStore.previousLoads();

    // 2. Pilot scope — one root folder: its descendants plus the reference
    //    records it (transitively) points at.
    const working = options.pilot
      ? this.filterPilotScope(options.dataset, options.pilot.rootReferenceId)
      : options.dataset;
    const refIndex = buildReferenceIndex(working);
    const dependencies = buildObjectDependencies(working, refIndex);
    const groups = insertionGroups(dependencies);
    const groupOrder = groups.flat();

    // What the platform writes itself is never sent: see
    // `writtenByThePlatform`. A dataset frozen before extractions left them
    // out can carry a tracked change, whose type its rules kept, and the
    // platform refuses one from a copy — "Cannot directly insert FeedItem with
    // type TrackedChange". Its reference stays known, so a lookup that names
    // it is told apart from a value; what cannot go in without it goes with
    // it once the target says which lookups a record may not leave empty. A
    // task relation whose `IsWhat` the rules cleared is told by what it names.
    const leftToThePlatform = new RowsLeftToThePlatform();
    // Nor is a feed item whose type the dataset does not carry: see
    // `UNTYPED_FEED_ITEMS`. What hangs from one goes with it, the same way.
    const untypedFeedItems = new RowsLeftToThePlatform(untypedFeedItem);
    const loading: FrozenDataset = {
      ...working,
      objects: working.objects.map((objectData) => ({
        ...objectData,
        records: objectData.records.filter(
          (r) =>
            !leftToThePlatform.leaveOut(
              objectData.objectApiName,
              r.referenceId,
              withTheRelationItIs(
                objectData.objectApiName,
                r.fields,
                typeof r.fields.RelationId === 'string'
                  ? refIndex.get(r.fields.RelationId)
                  : undefined,
              ),
            ) && !untypedFeedItems.leaveOut(objectData.objectApiName, r.referenceId, r.fields),
        ),
      })),
    };

    // 3. What the target already holds, found before anything is written: the
    //    standard price book, what the platform keeps one of, and on a reload
    //    what the identity keys find.
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
    const created = new CreatedKeys();
    /** Records earlier loads created that this load reuses, by the keys it maps them under. */
    let carried: LoadCreatedRecords[] = [];
    /**
     * Records of the earlier loads that are no longer theirs, by id: the ones
     * this load purged, and the ones it reuses and keeps as its own. What is
     * left of those loads is kept with this one's mapping, so a removal still
     * takes it and the next reload still purges it.
     */
    const settled = new Set<string>();

    /**
     * Whether the mapping was kept. Kept a second time, the load would also
     * read as one of the loads before it, and be offered for removal twice.
     */
    let mappingKept = false;

    /*
     * Keep the mapping of what this load wrote — with what it created, the
     * target's dates of it, and the loads before it with what they still have
     * in the org — at its end, at a cancel, and at a failure once it wrote.
     */
    const persistMapping = async (): Promise<void> => {
      const writtenBetween = await this.readWrittenBetween(orgId, created, mapping);
      await this.deps.mappingStore.persist(mapping, {
        created: created.list(carried),
        startedAt,
        ...(writtenBetween ? { writtenBetween } : {}),
        earlier: { settled: [...settled] },
      });
      mappingKept = true;
    };

    /*
     * Stop at a cancel, before the next write. A load read no cancel: once
     * started it purged, inserted and patched to its end. The mapping is kept
     * first, with the loads before it and what they still have in the org: a
     * reload then finds and purges what this load wrote, and the records of
     * those loads it had not purged yet; a removal takes either. Kept as this
     * load's alone, the mapping would lose them.
     */
    const checkpoint = async (): Promise<void> => {
      if (!options.signal?.aborted) return;
      await persistMapping();
      throw new FrozenLoadCancelledError({ perObject, placeholders, purge });
    };

    // What a failure keeps from here on, as the cancel does: a record this
    // load created, or one of an earlier load it purged, is known from the
    // moment the target answers the write.
    running.load = {
      keepMapping: persistMapping,
      mappingKept: () => mappingKept,
      wroteSome: () =>
        created.list().length > 0 ||
        Object.keys(purge.deleted).length > 0 ||
        Object.keys(purge.deactivated).length > 0,
      written: { perObject, placeholders, purge },
    };

    if (options.reload) {
      emit({ phase: 'reload', status: 'started', progress: 5, message: 'Reusing reference data' });
      await this.reuseByIdentityKeys(options, loading, mapping, reused);
    }
    // What the target already holds and keeps one of is linked on every load,
    // and before a reload purges, as the standard book is: a model an earlier
    // load created and this one finds again is kept, as its own.
    await this.matchByNaturalKey(orgId, loading, mapping, reused);
    await this.matchSellingModelOptions(orgId, loading, mapping, reused);

    // 4. RecordType resolution by DeveloperName + PersonContactId strip
    //    (the sidecar restores it post-load — the field does not exist at insert).
    emit({ phase: 'align', status: 'started', progress: 12, message: 'Resolving record types' });
    const recordTypeIssues: SchemaAlignmentReport['recordTypeIssues'] = [];
    const rtResolved = new Map<string, FrozenRecord[]>();
    const resolvedRecordTypes = new Map<string, string>();
    for (const objectData of loading.objects) {
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
    /** Objects the target takes no insert of, left out with records to write. */
    const refusedObjects: string[] = [];
    for (const objectData of loading.objects) {
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
      // An object the target takes no insert of is not sent. Run for real, a
      // load sent the error log one of the dossier's quotes had, and the
      // target refused it — "entity type cannot be inserted" — as its describe
      // said it would. A record the load only links is no insert; one it has
      // to write is lost, and that is an error, as Forge counts it.
      const toWrite = objectData.records.filter((r) => !reused.has(r.referenceId)).length;
      if (describe.createable === false && toWrite > 0) {
        refusedObjects.push(objectApiName);
        const reason =
          `Not createable in target org: ${toWrite} record${toWrite === 1 ? '' : 's'} ` +
          'of the dataset not loaded';
        alignment.excludedObjects.push({ objectApiName, reason });
        emit({
          phase: 'align',
          objectName: objectApiName,
          status: 'error',
          progress: 12,
          message: `Skipped ${objectApiName} — ${reason}`,
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
        linked: reused,
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
    leaveWhatHangsFrom(alignedByObject, requiredLookups, [leftToThePlatform, untypedFeedItems]);

    // 6. Placeholders for required lookups absent from the dataset.
    emit({
      phase: 'placeholders',
      status: 'started',
      progress: 22,
      message: 'Checking required fields',
    });
    const requiredDefaults: FrozenLoadReport['requiredDefaults'] = [];
    // Everything the dataset needs is settled before the first write: a
    // reload's purge, the first placeholder. One at a time, a load created the
    // placeholders it could, then stopped on the first default nobody had
    // declared: technical records left in the target for a load that did not
    // happen, and one missing entry reported per attempt.
    const plans = await this.planRequiredFields(options, alignment.objectResults);

    // 6b. Reload: purge what earlier loads created and this one does not
    //     reuse (children before parents — reverse insertion order; unknown
    //     objects last), once nothing the load can know in advance refuses
    //     it. Purged before the required fields were settled, a reload the
    //     configuration then refused had deleted what the earlier loads
    //     created, for a load that never wrote a record.
    if (options.reload) {
      let reloadDone = 'Reload pass done';
      if (!options.pilot) {
        emit({
          phase: 'reload',
          status: 'started',
          progress: 23,
          message: 'Purging what earlier loads created',
        });
        const plan = await this.planPurge(orgId, previousLoads, mapping);
        carried = plan.carried;
        for (const key of carried.flatMap((object) => object.referenceIds)) {
          const id = mapping.get(key);
          if (id) settled.add(recordKey(id));
        }
        const left = Object.values(plan.leftUnrecorded).reduce((sum, n) => sum + n, 0);
        if (left > 0) {
          purge.leftUnrecorded = plan.leftUnrecorded;
          reloadDone +=
            ` — ${left} record(s) left in place of a load recorded before loads kept what ` +
            'they created: it may have linked them';
        }
        await this.purgeResiduals(
          options,
          plan,
          [...groupOrder].reverse(),
          purge,
          checkpoint,
          settled,
        );
        // Through its purge, the reload has judged every record of a load
        // that does not say what it created: purged, reused or left as one
        // it may have linked. Kept, the load would be judged again at every
        // reload, and its linked records reported as left each time.
        for (const previous of previousLoads) {
          if (previous.created) continue;
          for (const id of previous.mapping.values()) settled.add(recordKey(id));
        }
      }
      emit({ phase: 'reload', status: 'done', progress: 24, message: reloadDone });
    }

    // What fills a required field goes into the records the load writes. One
    // it only links is never sent; counted with them, the report said a
    // default had gone into the selling model the load had found by its key.
    const written = (objectApiName: string) =>
      (alignedByObject.get(objectApiName) ?? []).filter((r) => !reused.has(r.referenceId));
    for (const plan of plans) {
      if (plan.kind === 'placeholder') {
        await checkpoint();
        await this.createPlaceholder(
          options,
          plan,
          written(plan.missing.objectApiName),
          mapping,
          placeholders,
          created,
        );
      } else {
        this.applyScalarDefault(
          plan.missing,
          written(plan.missing.objectApiName),
          requiredDefaults,
        );
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
    // An email on a case names its task, which the tasks inserted after the
    // emails would leave without an id in the target: it waits for them, and
    // goes in once the task object has had its turn. See `waitsForItsTask`.
    const tasksToInsert = new Set(
      insertOrder.includes(TASK) ? (alignedByObject.get(TASK) ?? []).map((r) => r.referenceId) : [],
    );
    const emailsAfterTheirTask: Array<{ referenceId: string; fields: Record<string, unknown> }> =
      [];
    let objectIndex = 0;
    let taskTurnOver = false;
    const insertEmailsAfterTheirTask = async (): Promise<void> => {
      taskTurnOver = true;
      const emails = emailsAfterTheirTask.splice(0, emailsAfterTheirTask.length);
      if (emails.length === 0) return;
      await checkpoint();
      const late = await this.insertObject(
        options,
        EMAIL_MESSAGE,
        0,
        emails,
        refIndex,
        mapping,
        reused,
        pendingFk,
        duplicatePatterns,
        created,
      );
      const at = perObject.findIndex((o) => o.objectApiName === EMAIL_MESSAGE);
      if (at >= 0) perObject[at] = mergeResults(perObject[at], late);
      else perObject.push(late);
      emit({
        phase: 'insert',
        objectName: EMAIL_MESSAGE,
        status: late.failed.length > 0 ? 'error' : 'done',
        progress: 25 + Math.round((55 * objectIndex) / Math.max(insertOrder.length, 1)),
        message: `${EMAIL_MESSAGE} after their task: ${late.inserted} inserted, ${late.reused} reused, ${late.skippedDuplicates.length} duplicates skipped, ${late.failed.length} failed`,
      });
    };
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
      if (objectApiName === TASK) {
        await this.matchTasksWrittenWithEmails(orgId, working, aligned, mapping, reused);
      }
      if (objectApiName === TASK_RELATION) {
        await this.matchTaskRelations(orgId, aligned, mapping, reused);
      }
      const fromFiles =
        working.objects.find((o) => o.objectApiName === objectApiName)?.records.length ??
        aligned.length;
      const lifecycle = STATUS_LIFECYCLES[objectApiName];
      let startingRecords = lifecycle
        ? await this.startAsDrafts(orgId, objectApiName, lifecycle, aligned, deferredStatuses)
        : aligned;
      if (objectApiName === EMAIL_MESSAGE && !taskTurnOver && tasksToInsert.size > 0) {
        const waits = (fields: Record<string, unknown>): boolean =>
          waitsForItsTask(fields, (id) => refIndex.get(id)) &&
          tasksToInsert.has(String(fields.ActivityId));
        emailsAfterTheirTask.push(...startingRecords.filter((r) => waits(r.fields)));
        startingRecords = startingRecords.filter((r) => !waits(r.fields));
      }
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
          created,
        );
      // A custom price is refused for a product with no standard one, so the
      // standard prices are written first, in a call of their own.
      const standardRef = working.standardPricebook;
      let objectResult: PerObjectLoadResult;
      if (isPricebookEntry(objectApiName) && standardRef) {
        const standardPrices = await insert(
          startingRecords.filter((r) => r.fields[PRICEBOOK_ENTRY_BOOK_FIELD] === standardRef),
          0,
        );
        // The custom prices are a write of their own: a cancel that came
        // during the standard ones stops the load before them, as it stops it
        // before any other write, with the standard prices counted. Nothing
        // looked at it here, and the custom prices were written after it.
        if (options.signal?.aborted) perObject.push({ ...standardPrices, fromFiles });
        await checkpoint();
        const customPrices = await insert(
          startingRecords.filter((r) => r.fields[PRICEBOOK_ENTRY_BOOK_FIELD] !== standardRef),
          fromFiles,
        ).catch((err: unknown) => {
          // Counted, as at a cancel: the standard prices are in the target.
          perObject.push({ ...standardPrices, fromFiles });
          throw err;
        });
        objectResult = mergeResults(standardPrices, customPrices);
      } else {
        objectResult = await insert(startingRecords, fromFiles);
      }
      perObject.push(objectResult);
      const leftOutNote = [
        ...leftToThePlatform
          .counts(objectApiName)
          .map(({ why, count }) => leftToThePlatformNote(count, why)),
        ...untypedFeedItems
          .counts(objectApiName)
          .map(({ why, count }) => untypedFeedItemNote(count, why)),
      ]
        .map((note) => `, ${note}`)
        .join('');
      const waiting =
        objectApiName === EMAIL_MESSAGE && emailsAfterTheirTask.length > 0
          ? `, ${emailsAfterTheirTask.length} on a case waiting for ${emailsAfterTheirTask.length === 1 ? 'its task' : 'their tasks'}`
          : '';
      emit({
        phase: 'insert',
        objectName: objectApiName,
        status: objectResult.failed.length > 0 ? 'error' : 'done',
        progress: 25 + Math.round((55 * objectIndex) / Math.max(insertOrder.length, 1)),
        message: `${objectApiName}: ${objectResult.inserted} inserted, ${objectResult.reused} reused, ${objectResult.skippedDuplicates.length} duplicates skipped, ${objectResult.failed.length} failed${waiting}${leftOutNote}`,
      });
      if (objectApiName === TASK) await insertEmailsAfterTheirTask();
    }
    // Emails still waiting for their task — the task object never had its
    // turn — go in with what the load could give them.
    await insertEmailsAfterTheirTask();

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
    await persistMapping();
    const leftOut = leftToThePlatform.counts();
    const untyped = untypedFeedItems.counts();
    const contractPath = this.writeContract(
      options,
      working,
      perObject,
      placeholders,
      {
        now,
        startedAt,
      },
      [
        ...leftOut.map(({ objectApiName, count }) => ({
          objectApiName,
          count,
          reason: 'left-to-the-platform',
        })),
        ...untyped.map(({ objectApiName, count }) => ({
          objectApiName,
          count,
          reason: 'untyped-feed-item',
        })),
      ],
    );
    emit({ phase: 'persist', status: 'done', progress: 98, message: 'Sas artifacts written' });

    const hasErrors =
      refusedObjects.length > 0 ||
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
      ...(leftOut.length > 0 ? { leftToThePlatform: leftToThePlatformCoverage(leftOut) } : {}),
      ...(untyped.length > 0
        ? {
            untypedFeedItems: untyped.map(({ objectApiName, why, count }) => ({
              objectApiName,
              count,
              note: untypedFeedItemNote(count, why),
            })),
          }
        : {}),
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

  /**
   * Pilot scope: descendants of the root folder + the reference records it
   * needs, the catalog its prices need included.
   */
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
    const reachAncestors = (ancestorQueue: string[]): void => {
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
    };
    reachAncestors([...reached]);
    // What the folder's prices need and none of its records points at: a
    // line names its custom price, never the standard one the platform wants
    // first, nor the option that lets its product be sold under its model.
    // Rehearsed against a real target, a pilot sent its four prices with
    // neither, which the platform refuses. They come with what they point
    // at: the standard book, their models.
    const needed = catalogThePricesNeed(dataset, reached).filter((id) => !reached.has(id));
    for (const id of needed) reached.add(id);
    reachAncestors(needed);
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
   * Link each record of an object the platform keeps one of per natural key
   * to the one the target holds under that key (`NATURAL_KEYS`).
   *
   * A selling model is one per type, pricing term and unit, and a target that
   * sells under selling models holds the ones it sells under. Inserted again,
   * the model is refused — "a product selling model already exists for this
   * combination" — and the refusal names no record. Skipped as a duplicate,
   * it left every price of the dataset sold under it without its model: a
   * lookup set at insert or never, since the platform takes no update of it,
   * and pass 2 listed each one unresolved. Forge met the refusal on a real
   * clone and links the one record the key finds; this looks the key up
   * before anything is written.
   *
   * A key field the rules cleared — `''`, what the `clear` generator leaves —
   * or did not carry says nothing of the key: such a record is not matched,
   * and the insert says what the target makes of it. `null` is a key value:
   * a one-time model has no pricing term.
   */
  private async matchByNaturalKey(
    orgId: string,
    working: FrozenDataset,
    mapping: Map<string, string>,
    reused: Set<string>,
  ): Promise<void> {
    for (const [objectApiName, keyFields] of Object.entries(NATURAL_KEYS)) {
      const records = (
        working.objects.find((o) => o.objectApiName === objectApiName)?.records ?? []
      ).filter(
        (r) =>
          !mapping.has(r.referenceId) &&
          keyFields.every((f) => r.fields[f] !== undefined && r.fields[f] !== ''),
      );
      if (records.length === 0) continue;
      let found: Array<string | undefined>;
      try {
        found = await recordsByNaturalKey(
          (soql) => this.deps.orgAccess.query(orgId, soql),
          objectApiName,
          keyFields,
          records.map((r) => r.fields),
        );
      } catch {
        // A target without the object cannot be asked. Its absence is listed
        // by the alignment, and any other refusal by the insert.
        continue;
      }
      records.forEach((record, i) => {
        const id = found[i];
        if (id === undefined) return;
        mapping.set(record.referenceId, id);
        reused.add(record.referenceId);
      });
    }
  }

  /**
   * Link each selling model option of the dataset whose product and model
   * this load links rather than writes — a product reused by its identity
   * keys, a model found by its natural key — to the option the target
   * already holds for that pair.
   *
   * A product is sold under a model through one option, and the target
   * holding both may well hold the option that joins them: inserted again,
   * it would be refused. Found the way Forge finds it, by the pair, before a
   * reload purges, for the reason the models are. An option of a product
   * this load writes is new with its product.
   */
  private async matchSellingModelOptions(
    orgId: string,
    working: FrozenDataset,
    mapping: Map<string, string>,
    reused: Set<string>,
  ): Promise<void> {
    const joined: Array<{ referenceId: string; pair: Record<string, string> }> = [];
    for (const record of working.objects.find(
      (o) => o.objectApiName === SELLING_MODEL_OPTION_OBJECT,
    )?.records ?? []) {
      if (mapping.has(record.referenceId)) continue;
      const product = record.fields[PRICEBOOK_ENTRY_PRODUCT_FIELD];
      const model = record.fields[PRICEBOOK_ENTRY_SELLING_MODEL_FIELD];
      const productId = typeof product === 'string' ? mapping.get(product) : undefined;
      const modelId = typeof model === 'string' ? mapping.get(model) : undefined;
      if (productId === undefined || modelId === undefined) continue;
      joined.push({
        referenceId: record.referenceId,
        pair: {
          [PRICEBOOK_ENTRY_PRODUCT_FIELD]: productId,
          [PRICEBOOK_ENTRY_SELLING_MODEL_FIELD]: modelId,
        },
      });
    }
    if (joined.length === 0) return;
    const held = await existingSellingModelOptions(
      (soql) => this.deps.orgAccess.query(orgId, soql),
      joined.map((j) => j.pair),
    );
    for (const [index, id] of held) {
      mapping.set(joined[index].referenceId, id);
      reused.add(joined[index].referenceId);
    }
  }

  /**
   * What a reload purges of the loads before it, and what it keeps of them as
   * its own.
   *
   * Only what a load created goes: a record it inserted, or a technical
   * placeholder. A record it linked — found by identity keys, a selling model
   * or option the target held, the standard price book, a direct relation the
   * platform made — was in the target before it, or is the platform's, and
   * stays: a reload whose rules or dataset changed since would otherwise
   * delete it, the moment this load did not match it again. A record any
   * other key of the same load names is linked, whichever key lists it as
   * created, as its removal reads it.
   *
   * A created record this load matched again — by identity keys, by a natural
   * key — is not purged: it is kept as created, under the key this load maps
   * it by, so that its removal, and the next reload, still take it. Matched
   * again means the same record, whatever key names it: a key matched to
   * another record leaves the one the earlier load created to the purge.
   *
   * A mapping written before loads kept what they created cannot say which
   * of its records the load linked. Of it, the purge takes only what no load
   * links: never a record of an object the configuration gives identity keys
   * to, a selling model or option, the standard price book, a record whose
   * key names no object, or one a later load says it linked; each of those
   * not matched again is left in place and counted. A load that ran with
   * identity keys the configuration no longer gives could have linked a
   * record of another object; nothing records it.
   */
  private async planPurge(
    orgId: string,
    previousLoads: readonly PreviousLoad[],
    mapping: ReadonlyMap<string, string>,
  ): Promise<PurgePlan> {
    const plan: PurgePlan = {
      residuals: new Map(),
      datedBy: new Map(),
      carried: [],
      leftUnrecorded: {},
    };
    const namedNow = new Map<string, string>();
    for (const [key, id] of mapping) {
      if (!namedNow.has(recordKey(id))) namedNow.set(recordKey(id), key);
    }
    const seen = new Set<string>();
    const purgeOne = (objectApiName: string, id: string): void => {
      plan.residuals.set(objectApiName, [...(plan.residuals.get(objectApiName) ?? []), id]);
    };
    const carry = (objectApiName: string, key: string): void => {
      const last = plan.carried.at(-1);
      if (last?.objectApiName === objectApiName) last.referenceIds.push(key);
      else plan.carried.push({ objectApiName, referenceIds: [key] });
    };
    const leave = (objectApiName: string): void => {
      plan.leftUnrecorded[objectApiName] = (plan.leftUnrecorded[objectApiName] ?? 0) + 1;
    };
    /** Unrecorded records that may be the standard price book, asked about once. */
    const maybeStandardBook: string[] = [];

    // What a load that says what it created linked, per load; and every
    // record any of them linked, which a load that does not say what it
    // created never has purged on its word.
    const linkedBy = previousLoads.map((previous) => {
      const linked = new Set<string>();
      if (!previous.created) return linked;
      const createdKeys = new Set(previous.created.flatMap((object) => object.referenceIds));
      for (const [key, id] of previous.mapping) {
        if (!createdKeys.has(key)) linked.add(recordKey(id));
      }
      return linked;
    });
    const linkedByAny = new Set(linkedBy.flatMap((linked) => [...linked]));

    previousLoads.forEach((previous, index) => {
      if (!previous.created) {
        for (const [key, id] of previous.mapping) {
          const record = recordKey(id);
          if (namedNow.has(record) || seen.has(record)) continue;
          seen.add(record);
          const objectApiName = objectFromMappingKey(key);
          if (this.mayHaveLinked(objectApiName, key) || linkedByAny.has(record)) {
            leave(objectApiName);
          } else if (objectApiName === 'Pricebook2' && !key.startsWith(PLACEHOLDER_KEY_PREFIX)) {
            maybeStandardBook.push(id);
          } else {
            purgeOne(objectApiName, id);
          }
        }
        return;
      }
      // As its removal reads a record unchanged since the load: modified no
      // later than the load's last write, or than what a removal left on it.
      const lastWrite = epochOf(previous.writtenBetween?.last);
      const stampOf = new Map(
        Object.entries(previous.removalStamps ?? {}).map(([id, date]) => [
          recordKey(id),
          epochOf(date),
        ]),
      );
      for (const { objectApiName, referenceIds } of previous.created) {
        for (const key of referenceIds) {
          const id = previous.mapping.get(key);
          if (id === undefined) continue;
          const record = recordKey(id);
          if (linkedBy[index].has(record) || seen.has(record)) continue;
          seen.add(record);
          const ownKey = namedNow.get(record);
          if (ownKey !== undefined) {
            carry(objectApiName, ownKey);
            continue;
          }
          purgeOne(objectApiName, id);
          const dated = [lastWrite, stampOf.get(record) ?? Number.NaN].filter(Number.isFinite);
          if (dated.length > 0) plan.datedBy.set(record, Math.max(...dated));
        }
      }
    });

    // A price book a mapping that does not say what its load created names
    // may be the standard one, which every load links and none can delete.
    // A target that cannot say which is the standard one has none purged.
    if (maybeStandardBook.length > 0) {
      let standard: string | undefined;
      try {
        const [book] = await this.deps.orgAccess.query(orgId, STANDARD_PRICEBOOK_SOQL);
        standard = typeof book?.Id === 'string' ? recordKey(book.Id) : '';
      } catch {
        standard = undefined;
      }
      for (const id of maybeStandardBook) {
        if (standard === undefined || recordKey(id) === standard) leave('Pricebook2');
        else purgeOne('Pricebook2', id);
      }
    }
    return plan;
  }

  /**
   * Whether a load could have linked, rather than written, a record of an
   * object: one the configuration gives identity keys to, one the target
   * keeps one of per natural key, a selling model option, or one no key
   * names. A technical placeholder is always written.
   */
  private mayHaveLinked(objectApiName: string, key: string): boolean {
    if (key.startsWith(PLACEHOLDER_KEY_PREFIX)) return false;
    return (
      objectApiName === 'Unknown' ||
      objectApiName === SELLING_MODEL_OPTION_OBJECT ||
      Object.prototype.hasOwnProperty.call(NATURAL_KEYS, objectApiName) ||
      Object.prototype.hasOwnProperty.call(this.config.identityKeys ?? {}, objectApiName)
    );
  }

  /**
   * Purge what earlier loads created and this one does not reuse
   * ({@link planPurge}). Deletion runs children-before-parents (reverse
   * insertion order; objects unknown to the current graph last). Undeletable
   * objects are deactivated instead. Each record deleted, found deleted or
   * deactivated is noted in `settled`: no longer the earlier load's.
   *
   * An order or a contract past Draft is set to Draft before anything is
   * deleted, and one the purge leaves in the org — its delete refused, or not
   * reached when a cancel or a failure stopped the purge — gets its status
   * back on the way out, as Forge's removal gives it back: see
   * {@link giveStatusesBack}.
   */
  private async purgeResiduals(
    options: FrozenLoadOptions,
    plan: Pick<PurgePlan, 'residuals' | 'datedBy'>,
    reverseOrder: string[],
    purge: PurgeReport,
    checkpoint: () => Promise<void>,
    settled: Set<string>,
  ): Promise<void> {
    const residualsByObject = plan.residuals;
    /** Records set to Draft for their delete, until they get their status back. */
    const drafted: DraftedResidual[] = [];
    // Every way out once a status was set to Draft — the purge's end, a
    // cancel, a write that failed — first gives what the purge leaves in the
    // org its status back. Stopped between an order set to Draft and its
    // delete, a reload left the order deactivated, and the load that created
    // it named with an order modified after it: that load's removal kept the
    // order as changed since.
    const giveBack = async (): Promise<void> => {
      const left = drafted.splice(0);
      if (left.length > 0) await this.giveStatusesBack(options, left, purge);
    };
    const stop = async (): Promise<void> => {
      if (options.signal?.aborted) await giveBack();
      await checkpoint();
    };
    try {
      // An activated order keeps its products and itself from being deleted —
      // "unable to modify activated order" — and the last load activated them.
      // Back to a draft first, and the deletes below can do their work.
      await this.draftResiduals(options, plan, drafted, stop);
      const known = reverseOrder.filter((o) => residualsByObject.has(o));
      const unknown = [...residualsByObject.keys()].filter((o) => !reverseOrder.includes(o)).sort();
      for (const objectApiName of [...known, ...unknown]) {
        const ids = residualsByObject.get(objectApiName) ?? [];
        const deactivationField = this.config.undeletableObjects?.[objectApiName];
        if (deactivationField !== undefined) {
          await stop();
          await this.checkGuard(options, 'update', objectApiName, ids.length);
          const outcomes = await this.deps.writer.update(
            options.orgId,
            objectApiName,
            ids.map((id) => ({ Id: id, [deactivationField]: false })),
          );
          outcomes.forEach((outcome, i) => {
            if (outcome.success) {
              purge.deactivated[objectApiName] = (purge.deactivated[objectApiName] ?? 0) + 1;
              settled.add(recordKey(ids[i]));
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
            await stop();
            await this.checkGuard(options, 'delete', objectApiName, round.length);
            const outcomes = await this.deps.writer.delete(options.orgId, objectApiName, round);
            // Already gone is what a purge wants: a parent deleted a step
            // earlier takes its cascading children with it. Run for real, a
            // reload counted ten of those as failures and called a clean load
            // one with errors.
            outcomes.forEach((outcome, i) => {
              if (outcome.success || outcome.errors.some((e) => e.includes('ENTITY_IS_DELETED'))) {
                purge.deleted[objectApiName] = (purge.deleted[objectApiName] ?? 0) + 1;
                settled.add(recordKey(round[i]));
              } else {
                purge.failures.push({ objectApiName, recordId: round[i], errors: outcome.errors });
              }
            });
          }
        }
      }
    } catch (err: unknown) {
      await giveBack();
      throw err;
    }
    await giveBack();
  }

  /**
   * Set to Draft the records to purge of an object with a status lifecycle —
   * an order, a contract — that are past Draft, each noted in `drafted` with
   * the status it had before the call is made: an update the target applied
   * without answering is given back all the same. A refusal here shows again,
   * with its reason, as the delete that follows; so does a record whose
   * status could not be read, which is left as it is.
   */
  private async draftResiduals(
    options: FrozenLoadOptions,
    plan: Pick<PurgePlan, 'residuals' | 'datedBy'>,
    drafted: DraftedResidual[],
    stop: () => Promise<void>,
  ): Promise<void> {
    for (const [objectApiName, lifecycle] of Object.entries(STATUS_LIFECYCLES)) {
      const ids = plan.residuals.get(objectApiName);
      if (!ids || ids.length === 0) continue;
      const categories = await this.statusCategories(options.orgId, lifecycle);
      const draft = categories?.draft;
      if (!categories || !draft) continue;
      let rows: Array<Record<string, unknown>>;
      try {
        rows = await this.readRecords(
          options.orgId,
          objectApiName,
          ['Status', 'LastModifiedDate'],
          ids,
        );
      } catch {
        continue;
      }
      const pastDraft = rows.flatMap((row): DraftedResidual[] => {
        const category = categories.categoryOf.get(String(row.Status));
        if (typeof row.Id !== 'string' || category === undefined || category === 'Draft') {
          return [];
        }
        const datedBy = plan.datedBy.get(recordKey(row.Id)) ?? Number.NaN;
        return [
          {
            objectApiName,
            id: row.Id,
            draft,
            status: String(row.Status),
            unchanged: epochOf(row.LastModifiedDate) <= datedBy,
          },
        ];
      });
      if (pastDraft.length === 0) continue;
      await stop();
      await this.checkGuard(options, 'update', objectApiName, pastDraft.length);
      drafted.push(...pastDraft);
      await this.deps.writer.update(
        options.orgId,
        objectApiName,
        pastDraft.map(({ id }) => ({ Id: id, Status: draft })),
      );
    }
  }

  /**
   * Give each record the purge set to Draft and leaves in the org the status
   * it had, then keep what that left on the ones that were as their load left
   * them with the load that created them (`recordStamps`), as Forge's removal
   * keeps what it leaves on a run's records: a removal of that load reads the
   * date as the purge's doing, not as a change made since.
   *
   * A record someone gave another status since is left as they left it, and
   * one the purge deleted is gone. One whose status cannot be given back — an
   * order whose products the purge deleted is not activated again — is listed
   * among the purge's failures, and stays at Draft.
   *
   * Written through `restoringWriter`, which the load's cancel does not stop,
   * and never thrown: it runs on the purge's way out, and what stopped the
   * purge is what the load ends on.
   */
  private async giveStatusesBack(
    options: FrozenLoadOptions,
    drafted: readonly DraftedResidual[],
    purge: PurgeReport,
  ): Promise<void> {
    const writer = this.deps.restoringWriter ?? this.deps.writer;
    const stamps: Record<string, string> = {};
    for (const objectApiName of new Set(drafted.map((record) => record.objectApiName))) {
      const records = drafted.filter((record) => record.objectApiName === objectApiName);
      const byKey = new Map(records.map((record) => [recordKey(record.id), record]));
      let rows: Array<Record<string, unknown>>;
      try {
        rows = await this.readRecords(
          options.orgId,
          objectApiName,
          ['Status'],
          records.map((record) => record.id),
        );
      } catch (err: unknown) {
        for (const record of records) {
          leftAtDraft(purge, record, `its status was not read back: ${extractErrorMessage(err)}`);
        }
        continue;
      }
      const inDraft = rows.flatMap((row) => {
        const record = typeof row.Id === 'string' ? byKey.get(recordKey(row.Id)) : undefined;
        return record && row.Status === record.draft ? [record] : [];
      });
      for (let at = 0; at < inDraft.length; at += ID_IN_CHUNK) {
        const batch = inDraft.slice(at, at + ID_IN_CHUNK);
        let outcomes: OperationOutcome[];
        try {
          await this.checkGuard(options, 'update', objectApiName, batch.length);
          outcomes = await writer.update(
            options.orgId,
            objectApiName,
            batch.map(({ id, status }) => ({ Id: id, Status: status })),
          );
        } catch (err: unknown) {
          const reason = extractErrorMessage(err);
          outcomes = batch.map(() => ({ success: false, errors: [reason] }));
        }
        batch.forEach((record, index) => {
          const outcome = outcomes[index];
          if (outcome?.success) return;
          leftAtDraft(purge, record, outcome?.errors.join('; ') || 'the org gave no reason');
        });
      }
      const unchanged = inDraft.filter((record) => record.unchanged);
      if (unchanged.length === 0) continue;
      try {
        const dated = await this.readRecords(
          options.orgId,
          objectApiName,
          ['LastModifiedDate'],
          unchanged.map((record) => record.id),
        );
        for (const row of dated) {
          if (typeof row.Id === 'string' && typeof row.LastModifiedDate === 'string') {
            stamps[row.Id] = row.LastModifiedDate;
          }
        }
      } catch {
        // Unstamped: the load's removal reads them as changed since it, and
        // keeps them unless asked to take those too.
      }
    }
    if (Object.keys(stamps).length === 0) return;
    try {
      await this.deps.mappingStore.recordStamps(stamps);
    } catch {
      // As unstamped.
    }
  }

  /** Some records of an object by id, with `fields`, {@link ID_IN_CHUNK} ids per query. */
  private async readRecords(
    orgId: string,
    objectApiName: string,
    fields: readonly string[],
    ids: readonly string[],
  ): Promise<Array<Record<string, unknown>>> {
    const columns = ['Id', ...fields].map(assertSoqlIdentifier).join(', ');
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < ids.length; i += ID_IN_CHUNK) {
      const inList = ids
        .slice(i, i + ID_IN_CHUNK)
        .map((id) => `'${sanitizeSoqlValue(id)}'`)
        .join(', ');
      rows.push(
        ...(await this.deps.orgAccess.query(
          orgId,
          `SELECT ${columns} FROM ${assertSoqlIdentifier(objectApiName)} WHERE Id IN (${inList})`,
        )),
      );
    }
    return rows;
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
   * only, before a reload purges anything, and every gap goes into one error
   * — so a person fixes the configuration once, and a refused load has
   * written nothing.
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
          'not cover. Nothing was written. Declare them all, then load again — ' +
          `records are never silently excluded:\n- ${gaps.join('\n- ')}`,
      );
    }
    return plans;
  }

  /**
   * Create ONE technical placeholder for a required lookup missing from the
   * dataset, and point at it each of `records` — the ones the load writes of
   * the object — that leaves the lookup empty.
   */
  private async createPlaceholder(
    options: FrozenLoadOptions,
    plan: PlaceholderPlan,
    records: ReadonlyArray<{ fields: Record<string, unknown> }>,
    mapping: Map<string, string>,
    placeholders: PlaceholderCreation[],
    created: CreatedKeys,
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
    const placeholderKey = `${PLACEHOLDER_KEY_PREFIX}${targetObject}:${key}`;
    mapping.set(placeholderKey, outcome.id);
    created.add(targetObject, placeholderKey);
    let affected = 0;
    for (const aligned of records) {
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

  /**
   * Apply a declared scalar default for a required field missing from the
   * dataset to each of `records` — the ones the load writes of the object —
   * that leaves it empty.
   */
  private applyScalarDefault(
    missing: { objectApiName: string; field: string },
    records: ReadonlyArray<{ fields: Record<string, unknown> }>,
    applied: FrozenLoadReport['requiredDefaults'],
  ): void {
    const key = `${missing.objectApiName}.${missing.field}`;
    // Settled by planRequiredFields: a default is declared for every key here.
    const value = this.config.requiredFieldDefaults?.[key];
    let affected = 0;
    for (const aligned of records) {
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
    created: CreatedKeys,
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
      const pending: PendingFk[] = [];
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
            pending.push({
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
      // A lookup the platform fills in itself goes neither now nor in pass 2:
      // an email's task, which it refuses from a copy and writes with the
      // email. See `lookupsThePlatformFills`.
      const filled = lookupsThePlatformFills(objectApiName, payload);
      for (const field of filled) delete payload[field];
      pendingFk.push(...pending.filter((p) => !filled.includes(p.field)));
      return payload;
    });
    await this.checkGuard(options, 'insert', objectApiName, payloads.length);
    const outcomes = await this.deps.writer.insert(options.orgId, objectApiName, payloads);
    outcomes.forEach((outcome, i) => {
      const referenceId = toInsert[i].referenceId;
      if (outcome.success && outcome.id) {
        mapping.set(referenceId, outcome.id);
        created.add(
          objectApiName,
          referenceId,
          AUDIT_DATE_FIELDS.some((f) => f in payloads[i]),
        );
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
   * Link each task of the dataset the platform wrote with an email this load
   * wrote to the task it wrote.
   *
   * The emails go first, without the id of their task (`emailWriteEdges`),
   * and the platform writes the task of each that is related to a record as
   * it takes it. The task read from the source is that one: mapped to it and
   * counted as reused, never inserted a second time beside it. A task the
   * platform did not write — its email related to no record, or not loaded —
   * is inserted as any other.
   */
  private async matchTasksWrittenWithEmails(
    orgId: string,
    working: FrozenDataset,
    aligned: Array<{ referenceId: string; fields: Record<string, unknown> }>,
    mapping: Map<string, string>,
    reused: Set<string>,
  ): Promise<void> {
    const tasks = new Set(aligned.map((r) => r.referenceId));
    /** The target id of the email each task went with, by the task's referenceId. */
    const emailOfTask = new Map<string, string>();
    for (const email of working.objects.find((o) => o.objectApiName === EMAIL_MESSAGE)?.records ??
      []) {
      const task = email.fields.ActivityId;
      if (typeof task !== 'string' || !tasks.has(task) || reused.has(email.referenceId)) continue;
      const id = mapping.get(email.referenceId);
      if (id) emailOfTask.set(task, id);
    }
    if (emailOfTask.size === 0) return;
    const written = await tasksWrittenWithEmails(
      (soql) => this.deps.orgAccess.query(orgId, soql),
      [...new Set(emailOfTask.values())],
    );
    for (const [task, email] of emailOfTask) {
      const id = written.get(email);
      if (id === undefined) continue;
      mapping.set(task, id);
      reused.add(task);
    }
  }

  /**
   * Link each task relation the target already holds — the ones the platform
   * wrote for its task's who as it took the task — to the one it holds. See
   * `existingTaskRelations`; a relation to the task's what never comes this
   * far (`PLATFORM_WRITTEN_ROWS`).
   */
  private async matchTaskRelations(
    orgId: string,
    aligned: Array<{ referenceId: string; fields: Record<string, unknown> }>,
    mapping: Map<string, string>,
    reused: Set<string>,
  ): Promise<void> {
    const idOf = (value: unknown): string | undefined =>
      typeof value === 'string' ? mapping.get(value) : undefined;
    const held = await existingTaskRelations(
      (soql) => this.deps.orgAccess.query(orgId, soql),
      aligned.map((r) => ({
        TaskId: idOf(r.fields.TaskId),
        RelationId: idOf(r.fields.RelationId),
      })),
    );
    for (const [index, id] of held) {
      mapping.set(aligned[index].referenceId, id);
      reused.add(aligned[index].referenceId);
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
    const standard = await standardPriceIds((soql) => this.deps.orgAccess.query(orgId, soql), ids);
    return [ids.filter((id) => !standard.has(id)), ids.filter((id) => standard.has(id))];
  }

  /**
   * Read back when the target dated the records this load created: the
   * earliest `CreatedDate` among them and the latest `LastModifiedDate` it
   * left on them, by the org's own clock — as a Forge run reads its own
   * (`ForgeExecutor.readWrittenBetween`). Read as the load ends, after the
   * passes that patch its records: their last stamp is the load's.
   *
   * Removing the load goes by these, not by this machine's clock: a record the
   * org stamped after the load ended is one changed since, and dated by a
   * clock a second behind the org's, the records the load wrote last read
   * that way. A record whose insert carried a creation or modification date —
   * the rules kept the source's, and the target lets the running user set
   * audit fields — keeps the source's, years before the load: its object is
   * dated by the system stamp, which no one sets. What an earlier load
   * created and this one reuses is not read: it was written before this load
   * began.
   *
   * Best effort: an object whose dates cannot be read leaves the load
   * undated, and its removal then dates it from the records and from this
   * machine's clock. Dated by the objects it could read, the load would end
   * before the writes it could not, and a removal would read those as
   * changes made since.
   */
  private async readWrittenBetween(
    orgId: string,
    created: CreatedKeys,
    mapping: ReadonlyMap<string, string>,
  ): Promise<ForgeWrittenBetween | undefined> {
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    for (const { objectApiName, referenceIds } of created.list()) {
      const ids = [
        ...new Set(
          referenceIds.flatMap((key) => {
            const id = mapping.get(key);
            return id ? [id] : [];
          }),
        ),
      ];
      const stampOnly = created.sentAuditDates(objectApiName);
      for (let i = 0; i < ids.length; i += ID_IN_CHUNK) {
        const rows = await this.writtenDatesOf(orgId, objectApiName, ids.slice(i, i + ID_IN_CHUNK));
        if (!rows) return undefined;
        for (const row of rows) {
          // A record whose own date is not the org's, or that keeps none, is
          // dated by its system stamp.
          const stamp = epochOf(row.SystemModstamp);
          const dated = (field: string): number => {
            const date = stampOnly ? Number.NaN : epochOf(row[field]);
            return Number.isFinite(date) ? date : stamp;
          };
          const createdAt = dated('CreatedDate');
          const modifiedAt = dated('LastModifiedDate');
          if (Number.isFinite(createdAt)) first = Math.min(first, createdAt);
          if (Number.isFinite(modifiedAt)) last = Math.max(last, modifiedAt);
        }
      }
    }
    if (!Number.isFinite(first) || !Number.isFinite(last)) return undefined;
    return {
      first: new Date(first).toISOString(),
      last: new Date(Math.max(first, last)).toISOString(),
    };
  }

  /**
   * The dates of some records the load created, read by the first set of
   * {@link WRITTEN_DATE_COLUMNS} their object keeps; undefined when none
   * could be read.
   */
  private async writtenDatesOf(
    orgId: string,
    objectApiName: string,
    ids: readonly string[],
  ): Promise<Array<Record<string, unknown>> | undefined> {
    const inList = ids.map((id) => `'${sanitizeSoqlValue(id)}'`).join(', ');
    for (const columns of WRITTEN_DATE_COLUMNS) {
      try {
        return await this.deps.orgAccess.query(
          orgId,
          `SELECT Id, ${columns.join(', ')} FROM ${assertSoqlIdentifier(objectApiName)} ` +
            `WHERE Id IN (${inList})`,
        );
      } catch {
        // The next set of columns, or none.
      }
    }
    return undefined;
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

  /**
   * Write the counting contract (files minus exclusions) into the sas. The
   * records the load left out before sending anything — to the platform, or
   * for a type the dataset does not carry — are an exclusion of their own,
   * under their reason, and an object all of whose records were is counted
   * too: none of it is expected.
   *
   * The contract names the load it counts by when it began, as the mapping
   * the load kept names it: a verification reads the records a mapping names
   * against the contract of the load that wrote it, or not at all.
   */
  private writeContract(
    options: FrozenLoadOptions,
    working: FrozenDataset,
    perObject: PerObjectLoadResult[],
    placeholders: PlaceholderCreation[],
    clock: { now: () => Date; startedAt: Date },
    leftOut: ReadonlyArray<{ objectApiName: string; count: number; reason: string }>,
  ): string {
    const leftOf = new Map<string, Record<string, number>>();
    for (const { objectApiName, count, reason } of leftOut) {
      const reasons = leftOf.get(objectApiName) ?? {};
      reasons[reason] = (reasons[reason] ?? 0) + count;
      leftOf.set(objectApiName, reasons);
    }
    const results = [...perObject];
    for (const [objectApiName, reasons] of leftOf) {
      if (results.some((r) => r.objectApiName === objectApiName)) continue;
      results.push({
        objectApiName,
        fromFiles:
          working.objects.find((o) => o.objectApiName === objectApiName)?.records.length ??
          Object.values(reasons).reduce((sum, count) => sum + count, 0),
        inserted: 0,
        reused: 0,
        skippedDuplicates: [],
        failed: [],
      });
    }
    const objects: Record<string, CountingContractEntry> = {};
    for (const result of results) {
      const exclusionReasons: Record<string, number> = {};
      if (result.skippedDuplicates.length > 0) {
        exclusionReasons['duplicate-skipped'] = result.skippedDuplicates.length;
      }
      if (result.failed.length > 0) {
        exclusionReasons['dml-failed'] = result.failed.length;
      }
      let left = 0;
      for (const [reason, count] of Object.entries(leftOf.get(result.objectApiName) ?? {})) {
        exclusionReasons[reason] = count;
        left += count;
      }
      const excluded = result.skippedDuplicates.length + result.failed.length + left;
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
      writtenAt: clock.now().toISOString(),
      loadStartedAt: clock.startedAt.toISOString(),
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

/**
 * Leave out of what is loaded every record whose lookup the target will not
 * take empty names one left out — a comment on a tracked change names the
 * feed item it answers — and what hangs from those, until none is.
 */
function leaveWhatHangsFrom(
  alignedByObject: Map<string, Array<{ referenceId: string; fields: Record<string, unknown> }>>,
  requiredLookups: ReadonlyMap<string, ReadonlySet<string>>,
  leftOut: readonly RowsLeftToThePlatform[],
): void {
  for (let changed = true; changed; ) {
    changed = false;
    for (const [objectApiName, aligned] of alignedByObject) {
      const lookups = [...(requiredLookups.get(objectApiName) ?? [])];
      const kept = aligned.filter(
        (r) =>
          !leftOut.some((rows) => rows.leaveOut(objectApiName, r.referenceId, r.fields, lookups)),
      );
      if (kept.length === aligned.length) continue;
      alignedByObject.set(objectApiName, kept);
      changed = true;
    }
  }
}

/**
 * Feed items whose type the dataset does not carry.
 *
 * An extraction cleared every field its rules named no generator for, the
 * type of a feed item among them, and until 1.38.2 it kept the tracked
 * changes. A load of such a dataset cannot tell a tracked change, which the
 * platform writes itself, from a post: sent untyped, a feed item goes in as a
 * post, and run for real, a tracked change was refused as one — "Required
 * fields are missing: [Body]". Left out, with what hangs from them, and the
 * report says to extract the dataset again.
 */
const UNTYPED_FEED_ITEMS: PlatformWrittenRows = {
  field: 'Type',
  value: '',
  noun: 'feed item whose type the dataset does not carry',
};

/** {@link UNTYPED_FEED_ITEMS} when `row` is one of them. */
function untypedFeedItem(
  objectApiName: string,
  row: Record<string, unknown>,
): PlatformWrittenRows | undefined {
  if (objectApiName !== 'FeedItem') return undefined;
  const type = row['Type'];
  return typeof type === 'string' && type !== '' ? undefined : UNTYPED_FEED_ITEMS;
}

/**
 * What a load report says of `count` records of one object it left out for a
 * feed item whose type the dataset does not carry.
 */
function untypedFeedItemNote(count: number, why: LeftToThePlatform): string {
  const again = 'extract the dataset again, with rules that keep FeedItem.Type';
  if (why.through) {
    return `${count} left out: ${why.through} names a feed item whose type the dataset does not carry — ${again}`;
  }
  return (
    `${count} feed item${count === 1 ? '' : 's'} left out: the dataset does not carry ` +
    `${count === 1 ? 'its' : 'their'} type, and a tracked change cannot be told from a post — ${again}`
  );
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

/**
 * Object → set of objects its records reference (through referenceId-valued
 * fields), and those the catalog has to be written after though none of its
 * records points at them.
 */
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
  // A price points at no option, and the platform refuses a price for a
  // product under a selling model the product has no option for. Ordered by
  // the lookups alone, the prices and the options were ready together and
  // went in by name, the prices first. Forge's catalog order says which goes
  // first where no lookup does.
  for (const { sourceObject, targetObject } of catalogWriteEdges(new Set(deps.keys()), [])) {
    deps.get(targetObject)?.add(sourceObject);
  }
  // An email names its task, and the platform writes that task with the
  // email unless it is on a case: the emails go first, the lookup they name
  // their task by ordering nothing, and one on a case waits for the tasks as
  // it is inserted. See `emailWriteEdges`.
  for (const { sourceObject, targetObject } of emailWriteEdges(new Set(deps.keys()))) {
    deps.get(sourceObject)?.delete(targetObject);
    deps.get(targetObject)?.add(sourceObject);
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

/**
 * The referenceIds of the records the prices among `reached` need, which no
 * record points at: the standard price of each custom price — of its product,
 * under its selling model, in its currency, as the extraction reads it — and
 * the option that lets each price's product be sold under its selling model.
 */
function catalogThePricesNeed(dataset: FrozenDataset, reached: ReadonlySet<string>): string[] {
  const recordsOf = (objectApiName: string): FrozenRecord[] =>
    dataset.objects.find((o) => o.objectApiName === objectApiName)?.records ?? [];
  const keyOf = (fields: Record<string, unknown>, keyFields: readonly string[]): string =>
    keyFields.map((f) => String(fields[f] ?? '')).join('|');
  const priceKey = [
    PRICEBOOK_ENTRY_PRODUCT_FIELD,
    PRICEBOOK_ENTRY_SELLING_MODEL_FIELD,
    PRICEBOOK_ENTRY_CURRENCY_FIELD,
  ];
  const optionKey = [PRICEBOOK_ENTRY_PRODUCT_FIELD, PRICEBOOK_ENTRY_SELLING_MODEL_FIELD];
  const names = (fields: Record<string, unknown>, field: string): boolean =>
    typeof fields[field] === 'string' && fields[field] !== '';

  const allPrices = recordsOf(PRICEBOOK_ENTRY_OBJECT);
  const prices = allPrices.filter(
    (r) => reached.has(r.referenceId) && names(r.fields, PRICEBOOK_ENTRY_PRODUCT_FIELD),
  );
  const standardBook = dataset.standardPricebook;
  const isStandard = (r: FrozenRecord): boolean =>
    standardBook !== undefined && r.fields[PRICEBOOK_ENTRY_BOOK_FIELD] === standardBook;
  const customKeys = new Set(
    prices.filter((r) => !isStandard(r)).map((r) => keyOf(r.fields, priceKey)),
  );
  const standardPrices = allPrices.filter(
    (r) => isStandard(r) && customKeys.has(keyOf(r.fields, priceKey)),
  );
  const soldUnder = new Set(
    [...prices, ...standardPrices]
      .filter((r) => names(r.fields, PRICEBOOK_ENTRY_SELLING_MODEL_FIELD))
      .map((r) => keyOf(r.fields, optionKey)),
  );
  const options = recordsOf(SELLING_MODEL_OPTION_OBJECT).filter((r) =>
    soldUnder.has(keyOf(r.fields, optionKey)),
  );
  return [...standardPrices, ...options].map((r) => r.referenceId);
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
