/**
 * AutopilotExecutor executes an autopilot plan wave by wave.
 * Emits real-time progress events for the UI.
 * Supports pause/resume/skip operations.
 */

import { TypedEventEmitter } from '../../core/common/TypedEventEmitter.js';
import type {
  ExecutionPlan,
  AutopilotEvent,
  AutopilotNodeProgressEvent,
  AutopilotNodeCompletedEvent,
  AutopilotNodeFailedEvent,
  AutopilotAnonymizationRule,
  AutopilotEdge,
  AutopilotRefusal,
  ApiName,
} from '@sandforge/shared';
import {
  PRICEBOOK_ENTRY_OBJECT,
  PRICEBOOK_OBJECT,
  STANDARD_PRICEBOOK_SOQL,
  isPlatformRequiredField,
  isPricebookEntry,
  splitStandardPricebookEntries,
} from '@sandforge/shared';
import type { SmartAnonymizer } from './SmartAnonymizer.js';
import type { RecordIdRemapper, UnresolvedLookup } from './RecordIdRemapper.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { insertionGroups, orderWithinGroup } from '../../core/common/insertionOrder.js';
import { LookupPatchSet } from '../../core/common/lookupPatches.js';
import { sanitizeSoqlValue } from '../../core/common/soqlValidator.js';
import { lookupsAtObjectsLeftOut } from '../forge/excludedObjects.js';
import type { DescribedLookup } from '../../core/metadata/describedLookups.js';
import {
  RECORD_TYPES_SOQL,
  RecordTypeMapper,
  parseRecordTypeRows,
  warnUnmappedRecordType,
  type RecordTypeMapping,
} from '../sync/RecordTypeMapper.js';
import {
  NO_STATUS_CODE,
  existingRecordOf,
  saveErrorDetail,
  type SaveErrorDetail,
  type SaveOutcome,
} from '../../core/common/existingRecordMatch.js';
import {
  ACCOUNT_CONTACT_RELATION,
  ACTIVITY_OF_RELATION,
  EMAIL_MESSAGE,
  NATURAL_KEYS,
  RowsLeftToThePlatform,
  STATUS_LIFECYCLES,
  TASK,
  directAccountContactRelations,
  draftStartOf,
  existingActivityRelations,
  lookupsThePlatformFills,
  recordsByNaturalKey,
  statusCategories,
  tasksWrittenWithEmails,
  waitsForItsTask,
  type RowsLeftOut,
  type SoqlQuery,
  type StatusCategories,
} from '../../core/common/platformRecords.js';
import {
  RECORD_TYPE_UNAVAILABLE,
  recordTypeBlockedMessage,
  recordTypeBlockedReason,
  unavailableRecordTypeUses,
  type RecordTypeAvailability,
  type UnavailableRecordTypeUse,
} from '../../core/metadata/recordTypeAvailability.js';
import { logger } from '../../logger.js';

/** Local alias matching the autopilot domain name. */
type AnonymizationRule = AutopilotAnonymizationRule;

/** Function to query records from source org */
export type QueryFn = (
  objectApiName: string,
  offset: number,
  limit: number,
) => Promise<Record<string, unknown>[]>;

/**
 * Function to insert records into the target org: one outcome per record, in
 * the order the records were given.
 *
 * Per record, because what the run does next depends on which record it is:
 * a record written or one the target already holds is mapped for its
 * children, a refused one is reported with its code. A result that kept only
 * the ids written and the refusal messages could not say which source record
 * a refusal was about, so a parent the target refused as a duplicate left
 * every child without it.
 */
export type InsertFn = (
  objectApiName: string,
  records: Record<string, unknown>[],
) => Promise<SaveOutcome[]>;

/** Function to update records of the target org: one outcome per record, in order. */
export type UpdateFn = (
  objectApiName: string,
  records: Record<string, unknown>[],
) => Promise<SaveOutcome[]>;

/**
 * Fatal-crash event. Carries the message the run died with, so a listener that
 * only observes events (and never sees the thrown error) can still report why.
 */
export interface AutopilotExecutionFailedEvent extends AutopilotEvent {
  /** Event type discriminator */
  readonly type: 'execution-failed';
  /** Message the execution died with */
  readonly error: string;
}

/** Events emitted by AutopilotExecutor */
export type AutopilotExecutorEvents = {
  [key: string]: unknown;
  'node-progress': AutopilotNodeProgressEvent;
  'node-completed': AutopilotNodeCompletedEvent;
  'node-failed': AutopilotNodeFailedEvent;
  'wave-completed': AutopilotEvent;
  'execution-started': AutopilotEvent;
  'execution-completed': AutopilotEvent;
  'execution-failed': AutopilotExecutionFailedEvent;
  paused: AutopilotEvent;
  resumed: AutopilotEvent;
};

/** A lookup a run did not send, and on how many records it held a value. */
export interface DefaultedLookup {
  /** The lookup's API name. */
  field: string;
  /** Records that carried a value for it in the source. */
  count: number;
}

/** What became of one object's records. */
export interface ObjectOutcome {
  /** Records written. */
  written: number;
  /**
   * Records the target already held and named — or that the platform made
   * itself, or owns — linked to for their children and never written.
   */
  linked: number;
  /** Records refused. */
  failed: number;
  /** Why, by status code and fields. */
  refusals: AutopilotRefusal[];
  /**
   * Lookups at objects the run does not copy — a `User`, a queue, metadata —
   * left to the target's default instead of sent with an id from the source,
   * which the target does not hold. `OwnerId` becomes the running user. Only
   * the lookups that held a value are listed.
   */
  leftToDefault?: DefaultedLookup[];
  /**
   * Records read and never sent, by reason: the platform writes them itself
   * and refuses one from a copy — a tracked change — or they cannot go in
   * without one it does, a comment on it. Neither written nor failed.
   */
  leftToThePlatform?: RowsLeftOut[];
}

/**
 * The lookups a record was written without — the record they point at came
 * later in its wave — filled once it was in.
 */
export interface LookupOutcome {
  /** Records whose lookups were filled. */
  filled: number;
  /** Why the others were not: those records keep the lookups empty. */
  refusals: AutopilotRefusal[];
}

/** The statuses set aside for records born a draft, as the end of the run applied them. */
export interface StatusOutcome {
  /** Records given back the status they had in the source. */
  applied: number;
  /** Why the others were not: those records stay in the target as drafts. */
  refusals: AutopilotRefusal[];
}

/** Execution result summary */
export interface ExecutionResult {
  /** Total successfully inserted records */
  totalSuccess: number;
  /** Total failed records */
  totalFailure: number;
  /** Total skipped records */
  totalSkipped: number;
  /**
   * Records the target already held, linked to instead of written. Neither
   * written nor failed.
   */
  totalLinked?: number;
  /** Total elapsed time in milliseconds */
  elapsedMs: number;
  /** Objects that completed successfully */
  completedObjects: string[];
  /** Objects that failed */
  failedObjects: string[];
  /** Objects that were skipped */
  skippedObjects: string[];
  /**
   * First error per failed object, keyed by API name — `STATUS_CODE: message`
   * whenever the target gave a code. The aggregate counters cannot carry it,
   * and it is what the UI shows on the failed node.
   */
  nodeErrors?: Record<string, string>;
  /** What became of each object's records, keyed by API name. */
  objectOutcomes?: Record<string, ObjectOutcome>;
  /** The statuses applied once the children were in, per object born a draft. */
  statuses?: Record<string, StatusOutcome>;
  /** The lookups filled once the records they point at were in, per object. */
  lookups?: Record<string, LookupOutcome>;
  /**
   * Message the run died with. Set only when execution crashed, in which case
   * the counters above are partial and the executor rethrows instead of
   * returning this result.
   */
  fatalError?: string;
}

/** Dependencies for the executor */
export interface AutopilotExecutorDeps {
  /** Function to query records from source org */
  query: QueryFn;
  /** Function to insert records into target org */
  insert: InsertFn;
  /** Anonymizer for PII fields */
  anonymizer: SmartAnonymizer;
  /** ID remapper for lookup fields */
  remapper: RecordIdRemapper;
  /** Batch size for queries and inserts (default: 200) */
  batchSize?: number;
  /**
   * The fields the TARGET org will accept on a write, per object.
   *
   * Without it a run sends every field it read. `SELECT FIELDS(ALL)` returns
   * the audit fields, the compound address fields and every formula and
   * roll-up an object carries, and Salesforce refuses the whole record:
   * "Unable to create/update fields: LastModifiedDate, CreatedById,
   * BillingAddress, …". Run for real between two orgs, that was all one
   * hundred and twenty-six records of a two-object run — every object, none
   * written.
   *
   * Asked of the target and not the source, which is also what catches a
   * field the source has and the target does not: a `Quote` was refused for
   * "No such column" on a custom field never deployed there.
   *
   * Optional, so a caller that cannot describe keeps the previous behaviour.
   */
  describeCreateableFields?: (objectApiName: string) => Promise<ReadonlySet<string>>;
  /**
   * The object's record types in the TARGET org, as the running user sees
   * them — read from the describe `describeCreateableFields` already made.
   * Optional, like the count below: without both, record types are left to
   * the platform.
   */
  describeRecordTypes?: (objectApiName: string) => Promise<readonly RecordTypeAvailability[]>;
  /**
   * How many SOURCE records carry each `RecordTypeId`. The run reads an
   * object a page at a time, so this count is how it knows every record type
   * before the first page is written. Asked only when the target has a type
   * the running user cannot use.
   */
  countRecordTypes?: (objectApiName: string) => Promise<ReadonlyMap<string, number>>;
  /**
   * The object's key prefix in the TARGET org. An id a refusal names is
   * linked to only when it carries it: a unique index is per object, so an id
   * of anything else is not the record. Without it an id is checked for its
   * form alone.
   */
  describeKeyPrefix?: (objectApiName: string) => Promise<string | null | undefined>;
  /**
   * The object's lookups in the TARGET org, from the same describe: what each
   * may point at, and whether it may be set on create and on update.
   *
   * What it answers decides three things. A lookup whose every target is an
   * object the run does not copy is left to the target's default rather than
   * sent with an id of the source. A lookup the second pass cannot set —
   * createable but not updateable — has to be right at insert, so the object
   * it points at is written first. And the second pass fills only what an
   * update can set. Without it, lookups are sent as the remapper leaves them.
   */
  describeLookups?: (objectApiName: string) => Promise<readonly DescribedLookup[]>;
  /** SOQL against the SOURCE org — the standard price book's id there. */
  querySource?: SoqlQuery;
  /**
   * SOQL against the TARGET org: its standard price book, the relations the
   * platform made itself, the statuses a lifecycle object may start with,
   * and a duplicate a refusal does not name. Without it none of those is
   * asked, and each such record is written — or refused — like any other.
   */
  queryTarget?: SoqlQuery;
  /**
   * Update records of the target — the statuses a record could not be born
   * with. Without it a record is inserted with the status it has, and the
   * platform says whether it takes it.
   */
  update?: UpdateFn;
}

/** Standing in for a record the platform gave no result for. */
const NO_RESULT_DETAIL: SaveErrorDetail = {
  statusCode: NO_STATUS_CODE,
  message: 'No result returned for the record',
  fields: [],
};

/** Standing in for a refusal the platform gave no reason for. */
const NO_REASON_DETAIL: SaveErrorDetail = {
  statusCode: NO_STATUS_CODE,
  message: 'Refused without a reason',
  fields: [],
};

/**
 * Counts the reasons records were refused, by status code and fields. A
 * record refused for two reasons is counted under both.
 */
class RefusalTally {
  private readonly byReason = new Map<string, AutopilotRefusal>();

  /** Count one record's errors. */
  add(details: readonly SaveErrorDetail[]): void {
    const seen = new Set<string>();
    for (const detail of details) {
      const key = `${detail.statusCode}\u0000${detail.fields.join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const known = this.byReason.get(key);
      this.byReason.set(
        key,
        known
          ? { ...known, count: known.count + 1 }
          : {
              statusCode: detail.statusCode,
              fields: [...detail.fields],
              count: 1,
              message: detail.message,
            },
      );
    }
  }

  /** Count a reason that already knows how many records it covers. */
  addCounted(refusal: AutopilotRefusal): void {
    const key = `${refusal.statusCode}\u0000${refusal.fields.join(',')}`;
    const known = this.byReason.get(key);
    this.byReason.set(key, known ? { ...known, count: known.count + refusal.count } : refusal);
  }

  /** The reasons, the most frequent first. */
  list(): AutopilotRefusal[] {
    return [...this.byReason.values()].sort((a, b) => b.count - a.count);
  }
}

/** One object's running totals while its records are written. */
interface ObjectState {
  written: number;
  linked: number;
  failed: number;
  /** `STATUS_CODE: message`, one per refused record. */
  errors: string[];
  refusals: RefusalTally;
  apiCallsUsed: number;
  /** Lookups left to the target's default → records that held a value. */
  defaulted: Map<string, number>;
}

/** An object's totals before any of its records is written. */
function emptyObjectState(): ObjectState {
  return {
    written: 0,
    linked: 0,
    failed: 0,
    errors: [],
    refusals: new RefusalTally(),
    apiCallsUsed: 0,
    defaulted: new Map(),
  };
}

/** Result of executing a single object */
interface ObjectResult {
  success: number;
  linked: number;
  failure: number;
  errors: string[];
  refusals: AutopilotRefusal[];
  apiCallsUsed: number;
  elapsedMs: number;
  leftToDefault: DefaultedLookup[];
}

/** A lookup a written record went in without, owed until the record it points at is in. */
interface OwedLookup {
  objectApiName: string;
  /** Target id of the record written without it. */
  recordId: string;
  fieldApiName: string;
  /** Source id of the record it points at. */
  sourceId: string;
  /** The objects that record may belong to. */
  parents: readonly ApiName[];
}

/** A status a record could not be born with, to apply once its children are in. */
interface DeferredStatus {
  objectApiName: string;
  /** Target id of the record written. */
  id: string;
  status: string;
}

/**
 * Executes an autopilot plan wave by wave.
 * Emits real-time progress events for the UI.
 * Supports pause/resume/skip operations.
 */
export class AutopilotExecutor extends TypedEventEmitter<AutopilotExecutorEvents> {
  private readonly deps: AutopilotExecutorDeps;
  private readonly batchSize: number;
  private paused = false;
  private pausePromise: Promise<void> | null = null;
  private pauseResolve: (() => void) | null = null;
  private skippedObjects = new Set<string>();
  /** One describe of the target per object, kept for the run. */
  private readonly creatableByObject = new Map<string, ReadonlySet<string> | null>();
  /** The target's key prefix per object, kept for the run. */
  private readonly keyPrefixByObject = new Map<string, Promise<string | null | undefined>>();
  /** A lifecycle object's statuses in the target, kept for the run. */
  private readonly lifecycleByObject = new Map<string, Promise<StatusCategories | undefined>>();
  /** The standard price book's id in each org, when both said. */
  private standardPricebook: { source: string; target: string } | undefined;
  /** Statuses set aside at insert, applied once the last wave is in. */
  private readonly deferredStatuses: DeferredStatus[] = [];
  /** The target's lookups per object, kept for the run. */
  private readonly lookupsByObject = new Map<string, Promise<readonly DescribedLookup[] | null>>();
  /** Source record type → target record type, when both orgs said. */
  private recordTypeMappings: RecordTypeMapping[] | undefined;
  /** The objects of the plan: the only ones whose records the run writes. */
  private planned: ReadonlySet<string> = new Set();
  /** Lookups written empty, filled at the end of their wave. */
  private readonly owedLookups: OwedLookup[] = [];
  /** Source record types the target has no match for, reported once each. */
  private readonly unmappedRecordTypes = new Set<string>();
  /** The records read and left to the platform, kept for the run: what hangs from them goes too. */
  private readonly leftToThePlatform = new RowsLeftToThePlatform();
  /** The task each email read names, by the email's source id. */
  private readonly taskOfEmail = new Map<string, string>();
  /**
   * The emails on a case read and held back until the task node has had its
   * turn: each names its task, which has no id in the target before. See
   * `waitsForItsTask`.
   */
  private readonly emailsAfterTheirTask: Record<string, unknown>[] = [];
  /** Whether the task node has had its turn, whatever it wrote. */
  private taskTurnOver = false;

  /**
   * What the target will take on a write, or `null` when nothing can say.
   *
   * A failed describe is not a reason to stop: the run then behaves as it did
   * before this existed.
   */
  private async creatableFieldsOf(objectApiName: string): Promise<ReadonlySet<string> | null> {
    if (!this.deps.describeCreateableFields) return null;
    const cached = this.creatableByObject.get(objectApiName);
    if (cached !== undefined) return cached;
    try {
      const answer = await this.deps.describeCreateableFields(objectApiName);
      // An empty answer means the describe could not say, not that the object
      // takes no field: filtering on it would send an empty record. An object
      // that genuinely has no writable field cannot be written anyway, so
      // letting the platform refuse it loses nothing and says more.
      const usable = answer.size > 0 ? answer : null;
      this.creatableByObject.set(objectApiName, usable);
      return usable;
    } catch {
      this.creatableByObject.set(objectApiName, null);
      return null;
    }
  }

  /** The object's lookups in the target, or `null` when nothing can say. */
  private lookupsOf(objectApiName: string): Promise<readonly DescribedLookup[] | null> {
    const describe = this.deps.describeLookups;
    if (!describe) return Promise.resolve(null);
    let cached = this.lookupsByObject.get(objectApiName);
    if (!cached) {
      cached = describe(objectApiName).catch(() => null);
      this.lookupsByObject.set(objectApiName, cached);
    }
    return cached;
  }

  /** The object's key prefix in the target, or nothing when the describe cannot say. */
  private keyPrefixOf(objectApiName: string): Promise<string | null | undefined> {
    const describe = this.deps.describeKeyPrefix;
    if (!describe) return Promise.resolve(undefined);
    let cached = this.keyPrefixByObject.get(objectApiName);
    if (!cached) {
      cached = describe(objectApiName).catch(() => undefined);
      this.keyPrefixByObject.set(objectApiName, cached);
    }
    return cached;
  }

  constructor(deps: AutopilotExecutorDeps) {
    super();
    this.deps = deps;
    this.batchSize = deps.batchSize ?? 200;
  }

  /**
   * The record types the object's records carry that the running user cannot
   * use in the target org — empty when none, or when nothing can say.
   *
   * A type that exists in the target but is closed to the running user
   * refuses every record carrying it, with an INVALID_CROSS_REFERENCE_KEY
   * that names the id and not the reason. The count is asked only when the
   * describe shows such a type, and only when `RecordTypeId` is sent at all.
   * It is read in the source, so its ids are the source's: translated first,
   * or they never match a type of the target and nothing is ever held back.
   */
  private async recordTypesHeldBack(objectApiName: string): Promise<UnavailableRecordTypeUse[]> {
    const { describeRecordTypes, countRecordTypes } = this.deps;
    if (!describeRecordTypes || !countRecordTypes) return [];
    const writable = await this.creatableFieldsOf(objectApiName);
    if (writable && !writable.has('RecordTypeId')) return [];
    try {
      const infos = await describeRecordTypes(objectApiName);
      if (!infos.some((info) => !info.available && !info.master)) return [];
      const counts = this.inTargetRecordTypes(await countRecordTypes(objectApiName));
      return unavailableRecordTypeUses(objectApiName, counts, infos);
    } catch {
      return [];
    }
  }

  /** Records per record type, keyed by the target's ids where the mapping knows one. */
  private inTargetRecordTypes(counts: ReadonlyMap<string, number>): Map<string, number> {
    const targetIdOf = new Map(this.recordTypeMappings?.map((m) => [m.sourceId, m.targetId]));
    const translated = new Map<string, number>();
    for (const [id, count] of counts) {
      const target = targetIdOf.get(id) ?? id;
      translated.set(target, (translated.get(target) ?? 0) + count);
    }
    return translated;
  }

  /**
   * Match the record types of the plan's objects between the two orgs, by
   * object and API name.
   *
   * Two sandboxes of one production org can hold the same record type — the
   * same object, the same API name — under two different ids, one deployed to
   * each after it was made. Carried as it was read, the source's id was
   * refused by the target: every product of a real run, with
   * INVALID_CROSS_REFERENCE_KEY on `RecordTypeId`. Matched the way Forge
   * matches them; a type the target lacks keeps the source id and says so in
   * the log. Best effort: when either org cannot say, record types are sent
   * as they were read.
   */
  private async mapRecordTypes(plan: ExecutionPlan): Promise<void> {
    const { querySource, queryTarget } = this.deps;
    if (!querySource || !queryTarget) return;
    const objects = [...new Set(plan.waves.flatMap((wave) => wave.objects))];
    if (objects.length === 0) return;
    // Bounded to the plan's objects: each query then answers in one page.
    const soql =
      `${RECORD_TYPES_SOQL} AND SobjectType IN ` +
      `(${objects.map((name) => `'${sanitizeSoqlValue(name)}'`).join(', ')})`;
    try {
      const [source, target] = await Promise.all([querySource(soql), queryTarget(soql)]);
      this.recordTypeMappings = new RecordTypeMapper().buildMapping(
        parseRecordTypeRows(source),
        parseRecordTypeRows(target),
      );
    } catch (err) {
      logger.warn('Autopilot could not match the record types of the two orgs', {
        error: extractErrorMessage(err),
      });
    }
  }

  /**
   * Match the two orgs' standard price books, when the plan carries price
   * books or prices at all.
   *
   * Every org has exactly one standard price book and none can be created,
   * so it is matched — by `IsStandard`, never by its name, which a French org
   * translates — and never inserted. Copied like any other book, it left
   * another custom book named after it in the target on every run, and the
   * standard prices read from the source were remapped into that copy, where
   * the platform refuses a price for a product with no standard one. Best
   * effort: when either org cannot say, the run goes on as it did before.
   */
  private async matchStandardPricebooks(plan: ExecutionPlan): Promise<void> {
    const { querySource, queryTarget } = this.deps;
    if (!querySource || !queryTarget) return;
    const objects = new Set<string>(plan.waves.flatMap((wave) => wave.objects));
    if (!objects.has(PRICEBOOK_OBJECT) && !objects.has(PRICEBOOK_ENTRY_OBJECT)) return;
    try {
      const [sourceBook, targetBook] = await Promise.all([
        querySource(STANDARD_PRICEBOOK_SOQL),
        queryTarget(STANDARD_PRICEBOOK_SOQL),
      ]);
      const source = sourceBook[0]?.['Id'];
      const target = targetBook[0]?.['Id'];
      if (typeof source !== 'string' || typeof target !== 'string') return;
      this.standardPricebook = { source, target };
      this.deps.remapper.registerMappings(PRICEBOOK_OBJECT as ApiName, [[source, target]]);
    } catch (err) {
      logger.warn('Autopilot could not match the standard price books', {
        error: extractErrorMessage(err),
      });
    }
  }

  /**
   * Execute the full plan wave by wave.
   * @param plan - The execution plan with waves
   * @param edges - Dependency edges for ID remapping
   * @param rules - Anonymization rules to apply
   * @param recordCounts - Map of object API name to record count
   * @returns Execution result summary
   */
  async execute(
    plan: ExecutionPlan,
    edges: AutopilotEdge[],
    rules: AnonymizationRule[],
    recordCounts: Map<string, number>,
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    const nodeErrors: Record<string, string> = {};
    const objectOutcomes: Record<string, ObjectOutcome> = {};
    const result: ExecutionResult = {
      totalSuccess: 0,
      totalFailure: 0,
      totalSkipped: 0,
      totalLinked: 0,
      elapsedMs: 0,
      completedObjects: [],
      failedObjects: [],
      skippedObjects: [],
      nodeErrors,
      objectOutcomes,
    };

    this.emit(
      'execution-started',
      this.makeEvent({
        type: 'execution-started' as const,
        timestamp: '',
      }),
    );

    /** Write one object of a wave and, after the tasks, the emails that waited for them. */
    const writeNode = async (objectApiName: string): Promise<void> => {
      await writeObject(objectApiName);
      // The emails that wait for the task each names go in once the task
      // node has had its turn: see `writeEmailsAfterTheirTask`.
      if (objectApiName === TASK) await this.writeEmailsAfterTheirTask(edges, result);
    };

    /** Write one object of a wave, and say how it went. */
    const writeObject = async (objectApiName: string): Promise<void> => {
      if (this.skippedObjects.has(objectApiName)) {
        const totalRecords = recordCounts.get(objectApiName) ?? 0;
        result.skippedObjects.push(objectApiName);
        result.totalSkipped += totalRecords;
        return;
      }

      await this.checkPause();

      const totalRecords = recordCounts.get(objectApiName) ?? 0;
      try {
        const objResult = await this.executeObject(
          objectApiName as ApiName,
          edges,
          rules,
          totalRecords,
        );

        result.totalSuccess += objResult.success;
        result.totalFailure += objResult.failure;
        result.totalLinked = (result.totalLinked ?? 0) + objResult.linked;
        const leftToThePlatform = this.leftToThePlatform.counts(objectApiName);
        objectOutcomes[objectApiName] = {
          written: objResult.success,
          linked: objResult.linked,
          failed: objResult.failure,
          refusals: objResult.refusals,
          ...(objResult.leftToDefault.length > 0 ? { leftToDefault: objResult.leftToDefault } : {}),
          ...(leftToThePlatform.length > 0 ? { leftToThePlatform } : {}),
        };

        // A node that wrote nothing is still whole when every record it
        // holds is in the target: linked to, its children point at it.
        if (objResult.errors.length > 0 && objResult.success + objResult.linked === 0) {
          result.failedObjects.push(objectApiName);
          nodeErrors[objectApiName] = objResult.errors[0];
          this.emit(
            'node-failed',
            this.makeEvent({
              type: 'node-failed' as const,
              timestamp: '',
              objectApiName: objectApiName as ApiName,
              errors: objResult.errors,
              partialSuccessCount: objResult.success,
              failureCount: objResult.failure,
              linkedCount: objResult.linked,
              refusals: objResult.refusals,
            }),
          );
        } else {
          result.completedObjects.push(objectApiName);
          this.emit(
            'node-completed',
            this.makeEvent({
              type: 'node-completed' as const,
              timestamp: '',
              objectApiName: objectApiName as ApiName,
              successCount: objResult.success,
              failureCount: objResult.failure,
              linkedCount: objResult.linked,
              refusals: objResult.refusals,
              elapsedMs: objResult.elapsedMs,
              apiCallsUsed: objResult.apiCallsUsed,
            }),
          );
        }
      } catch (err) {
        result.failedObjects.push(objectApiName);
        const errorMsg = extractErrorMessage(err);
        nodeErrors[objectApiName] = errorMsg;
        this.emit(
          'node-failed',
          this.makeEvent({
            type: 'node-failed' as const,
            timestamp: '',
            objectApiName: objectApiName as ApiName,
            errors: [errorMsg],
            partialSuccessCount: 0,
            failureCount: 0,
            linkedCount: 0,
            refusals: [],
          }),
        );
      }
    };

    try {
      await this.matchStandardPricebooks(plan);
      await this.mapRecordTypes(plan);
      this.planned = new Set(plan.waves.flatMap((wave) => wave.objects));
      const lookups: Record<string, LookupOutcome> = {};

      for (const wave of plan.waves) {
        await this.writeWave(wave.objects, edges, writeNode);
        // What the wave's records went in without, now that what they point
        // at is in: before the next wave, whose records may read it.
        await this.fillOwedLookups(lookups);

        this.emit(
          'wave-completed',
          this.makeEvent({
            type: 'wave-completed' as const,
            timestamp: '',
          }),
        );
      }

      // Emails still waiting for the task each names — the task node never
      // had its turn — go in with what the run could give them.
      if (this.emailsAfterTheirTask.length > 0) {
        await this.writeEmailsAfterTheirTask(edges, result);
        await this.fillOwedLookups(lookups);
      }

      // Whatever is still owed points at a record no wave wrote.
      this.owedLookups.length = 0;

      // Statuses set aside at insert, now that every record's children are in.
      const statuses = await this.applyDeferredStatuses();
      if (Object.keys(statuses).length > 0) result.statuses = statuses;
      if (Object.keys(lookups).length > 0) result.lookups = lookups;

      result.elapsedMs = Date.now() - startTime;
      this.emit(
        'execution-completed',
        this.makeEvent({
          type: 'execution-completed' as const,
          timestamp: '',
        }),
      );

      return result;
    } catch (err) {
      result.elapsedMs = Date.now() - startTime;
      result.fatalError = extractErrorMessage(err);
      logger.error('Autopilot execution crashed', { error: result.fatalError });
      this.emit(
        'execution-failed',
        this.makeEvent({
          type: 'execution-failed' as const,
          timestamp: '',
          error: result.fatalError,
        }),
      );
      // Rethrow: returning hands the caller partial counters indistinguishable
      // from a finished run, which is how a crash reaches the user as a success.
      throw err;
    }
  }

  /**
   * Write the objects of one wave: those that point at each other one after
   * the other, parents first, and the others side by side.
   *
   * A wave is a level of the plan, and the objects of a cycle share one:
   * `Account` and `Contact` point at each other, and so do an opportunity
   * and its synced quote. Written all at once, whichever came first lost its
   * lookup — a real run left 18 contacts out of 18 without their account and
   * 8 opportunities out of 8 without theirs. Ordered the way Frozen Dataset
   * orders its load: each cycle a group, written after the groups it depends
   * on and, inside, after what its members cannot be written without. What
   * still points forward is filled by the second pass at the end of the wave.
   */
  private async writeWave(
    objects: readonly string[],
    edges: readonly AutopilotEdge[],
    writeNode: (objectApiName: string) => Promise<void>,
  ): Promise<void> {
    const members = new Set(objects);
    const within = edges.filter(
      (edge) => edge.from !== edge.to && members.has(edge.from) && members.has(edge.to),
    );
    const deps = new Map(objects.map((name) => [name, new Set<string>()]));
    for (const edge of within) deps.get(edge.to)?.add(edge.from);
    const groups = insertionGroups(deps);
    const groupOf = new Map<string, number>();
    groups.forEach((group, index) => group.forEach((name) => groupOf.set(name, index)));

    // A group starts once the groups it depends on are written; groups that
    // depend on nothing of the wave — every group of a wave the plan built —
    // are written side by side, as they always were.
    const written: Array<Promise<void>> = [];
    for (const [index, group] of groups.entries()) {
      const before = new Set<Promise<void>>();
      for (const name of group) {
        for (const parent of deps.get(name) ?? []) {
          const other = groupOf.get(parent);
          if (other !== undefined && other !== index) before.add(written[other]);
        }
      }
      written.push(
        (async () => {
          await Promise.all(before);
          const order =
            group.length > 1
              ? orderWithinGroup(group, await this.setAtInsert(group, within))
              : group;
          for (const name of order) await writeNode(name);
        })(),
      );
    }
    await Promise.all(written);
  }

  /**
   * Within one cycle, what each object cannot be written without: what its
   * required lookups point at, and what its lookups the second pass cannot
   * set — the target takes them on create and not on update — point at.
   */
  private async setAtInsert(
    group: readonly string[],
    edges: readonly AutopilotEdge[],
  ): Promise<Map<string, Set<string>>> {
    const members = new Set(group);
    const needs = new Map<string, Set<string>>();
    for (const edge of edges) {
      if (!members.has(edge.to) || !members.has(edge.from)) continue;
      const lookup = (await this.lookupsOf(edge.to))?.find((l) => l.name === edge.fieldApiName);
      const insertOnly = lookup !== undefined && lookup.createable && !lookup.updateable;
      if (!edge.required && !isPlatformRequiredField(edge.to, edge.fieldApiName) && !insertOnly) {
        continue;
      }
      needs.set(edge.to, (needs.get(edge.to) ?? new Set()).add(edge.from));
    }
    return needs;
  }

  /**
   * The second pass: fill the lookups the wave's records went in without,
   * now that the records they point at are in — Forge's pass 2, one update
   * per record however many lookups it owes. A lookup whose record is not in
   * yet stays owed; one whose record never reaches the target stays empty.
   */
  private async fillOwedLookups(outcomes: Record<string, LookupOutcome>): Promise<void> {
    const owed = this.owedLookups.splice(0, this.owedLookups.length);
    const { update } = this.deps;
    if (!update || owed.length === 0) return;
    const patches = new LookupPatchSet();
    for (const lookup of owed) {
      const value = lookup.parents
        .map((parent) => this.deps.remapper.getTargetId(parent, lookup.sourceId))
        .find((id) => id !== undefined);
      if (!value) {
        this.owedLookups.push(lookup);
        continue;
      }
      patches.add({
        objectApiName: lookup.objectApiName,
        recordId: lookup.recordId,
        fieldName: lookup.fieldApiName,
        value,
      });
    }
    for (const [objectApiName, records] of patches.updates()) {
      const known = outcomes[objectApiName];
      let filled = known?.filled ?? 0;
      const refusals = new RefusalTally();
      for (const refusal of known?.refusals ?? []) refusals.addCounted(refusal);
      for (let i = 0; i < records.length; i += this.batchSize) {
        const part = records.slice(i, i + this.batchSize);
        const results = await updateEach(update, objectApiName, part);
        part.forEach((_, index) => {
          const outcome = results[index];
          if (outcome?.success) filled++;
          else refusals.add(detailsOf(outcome));
        });
      }
      outcomes[objectApiName] = { filled, refusals: refusals.list() };
    }
  }

  /**
   * Execute a single object transfer: query, anonymize, remap, insert in batches.
   * @param objectApiName - The object to transfer
   * @param edges - Dependency edges for remapping
   * @param rules - Anonymization rules
   * @param totalRecords - Total records to process
   * @returns Object result with success/failure counts
   */
  private async executeObject(
    objectApiName: ApiName,
    edges: AutopilotEdge[],
    rules: AnonymizationRule[],
    totalRecords: number,
  ): Promise<ObjectResult> {
    const objStart = Date.now();
    const state = emptyObjectState();
    const finish = (): ObjectResult => ({
      success: state.written,
      linked: state.linked,
      failure: state.failed,
      errors: state.errors,
      refusals: state.refusals.list(),
      apiCallsUsed: state.apiCallsUsed,
      elapsedMs: Date.now() - objStart,
      leftToDefault: [...state.defaulted].map(([field, count]) => ({ field, count })),
    });

    // Held back whole, before its first page: a run translates a record type
    // into the target's own but never picks another one, so there is no
    // default to fall back on without the user choosing it. The node fails
    // with what to change in the target, and nothing of it is written.
    const heldBack = totalRecords > 0 ? await this.recordTypesHeldBack(objectApiName) : [];
    if (heldBack.length > 0) {
      state.failed = totalRecords;
      state.errors.push(...heldBack.map(recordTypeBlockedMessage));
      for (const use of heldBack) {
        state.refusals.addCounted({
          statusCode: RECORD_TYPE_UNAVAILABLE,
          fields: ['RecordTypeId'],
          count: use.recordCount,
          message: recordTypeBlockedReason(use),
        });
      }
      state.apiCallsUsed = 1;
      return finish();
    }

    const progress = (processed: number): void => {
      const done = Math.min(processed, totalRecords);
      this.emit(
        'node-progress',
        this.makeEvent({
          type: 'node-progress' as const,
          timestamp: '',
          objectApiName,
          progress: totalRecords > 0 ? Math.round((done / totalRecords) * 100) : 100,
          recordsProcessed: done,
          recordsTotal: totalRecords,
          apiCallsUsed: state.apiCallsUsed,
        }),
      );
    };

    let offset = 0;
    const standardBook = this.standardPricebook;
    if (isPricebookEntry(objectApiName) && standardBook) {
      // A custom price is refused for a product with no standard one, and
      // the pages of a read come in no order the run chooses: a product's
      // custom price can sit a page ahead of its standard one. So every page
      // is read first, and the standard prices are written in calls of their
      // own before the custom ones.
      const rows: Record<string, unknown>[] = [];
      while (offset < totalRecords) {
        await this.checkPause();
        const batch = await this.deps.query(objectApiName, offset, this.batchSize);
        state.apiCallsUsed++;
        if (batch.length === 0) break;
        offset += batch.length;
        const kept = this.leaveToThePlatform(objectApiName, batch, edges);
        this.deps.anonymizer.anonymize(kept, rules, objectApiName);
        rows.push(...kept);
      }
      const { standard, custom } = splitStandardPricebookEntries(rows, standardBook.source);
      let processed = 0;
      for (const round of [standard, custom]) {
        for (let i = 0; i < round.length; i += this.batchSize) {
          await this.checkPause();
          const batch = round.slice(i, i + this.batchSize);
          await this.writeBatch(objectApiName, batch, edges, state);
          processed += batch.length;
          progress(processed);
        }
      }
      return finish();
    }

    while (offset < totalRecords) {
      await this.checkPause();

      // 1. Query from source
      const read = await this.deps.query(objectApiName, offset, this.batchSize);
      state.apiCallsUsed++;

      if (read.length === 0) {
        break;
      }

      // What the platform writes itself never goes further than the read.
      const batch = this.leaveToThePlatform(objectApiName, read, edges);

      // 2. Anonymize
      this.deps.anonymizer.anonymize(batch, rules, objectApiName);

      // 3. Remap, link and insert
      await this.writeBatch(objectApiName, batch, edges, state);

      offset += read.length;

      // 4. Emit node-progress
      progress(offset);
    }

    return finish();
  }

  /**
   * The records of a page a copy may send: those the platform writes itself
   * are left out — see `writtenByThePlatform` — and so are those that name
   * one left out in a lookup they may not leave empty, noted for the run.
   *
   * Autopilot reads whole tables. Sent, a tracked change is refused, "Cannot
   * directly insert FeedItem with type TrackedChange", and a comment on it
   * goes without the feed item it answers, which it may not leave empty.
   */
  private leaveToThePlatform(
    objectApiName: string,
    records: Record<string, unknown>[],
    edges: readonly AutopilotEdge[],
  ): Record<string, unknown>[] {
    const required = new Set(
      edges
        .filter(
          (edge) =>
            edge.to === objectApiName &&
            (edge.required || isPlatformRequiredField(edge.to, edge.fieldApiName)),
        )
        .map((edge) => edge.fieldApiName),
    );
    return this.leftToThePlatform.keep(objectApiName, records, [...required]);
  }

  /**
   * Write one batch of source records: remap their lookups, link the records
   * the target already holds, insert the rest, and map every source id the
   * target now has a record for — written or already there — for the
   * children still to come.
   */
  private async writeBatch(
    objectApiName: ApiName,
    batch: Record<string, unknown>[],
    edges: AutopilotEdge[],
    state: ObjectState,
  ): Promise<void> {
    const mappings: Array<[string, string]> = [];

    // The standard price book is matched, never inserted — mapped already.
    let rows = batch;
    const standardBook = this.standardPricebook;
    if (objectApiName === PRICEBOOK_OBJECT && standardBook) {
      rows = batch.filter((record) => record['Id'] !== standardBook.source);
      state.linked += batch.length - rows.length;
    }
    // An email on a case names its task, which the task node still to come
    // would leave without an id in the target: it waits for it. The others go
    // now, and the platform writes their tasks as it takes them.
    if (objectApiName === EMAIL_MESSAGE) rows = this.holdEmailsForTheirTask(rows);
    if (rows.length === 0) return;

    const remap = this.deps.remapper.remapRecords(rows, edges, objectApiName);
    await this.leaveToDefault(objectApiName, rows, state);

    // With the fields the target will take. `Id` and `attributes` stay: the
    // insert function strips them itself, and `Id` is what maps the record.
    const writable = await this.creatableFieldsOf(objectApiName);
    let payload = writable
      ? rows.map((record) => {
          const kept: Record<string, unknown> = {};
          for (const key of Object.keys(record)) {
            if (key === 'Id' || key === 'attributes' || writable.has(key)) {
              kept[key] = record[key];
            }
          }
          return kept;
        })
      : rows;
    payload = this.translateRecordTypes(objectApiName, payload);
    // A lookup the platform fills in itself is neither sent nor owed to the
    // second pass: an email's task, unless the email is on a case. Sent with
    // the id read from the source, the email is refused, "you cannot modify
    // this field". See `lookupsThePlatformFills`.
    const filled = new Map<number, readonly string[]>();
    payload.forEach((record, index) => {
      const fields = lookupsThePlatformFills(objectApiName, record);
      for (const field of fields) delete record[field];
      if (fields.length > 0) filled.set(index, fields);
    });
    const owedBySource = await this.lookupsOwed(
      objectApiName,
      rows,
      remap.unresolved.filter((lookup) => !filled.get(lookup.index)?.includes(lookup.fieldApiName)),
      writable,
    );

    // Each read of the target counted as it is made: the lookups below ask
    // nothing when there is nothing to ask about.
    const target = this.deps.queryTarget;
    const queryTarget: SoqlQuery | undefined = target
      ? (soql) => {
          state.apiCallsUsed++;
          return target(soql);
        }
      : undefined;
    // The relation the platform made when it wrote the contact with its
    // account is the one read from the source: inserted again it is refused,
    // and the refusal names no record. Found by its account and contact, now
    // target ids, and linked to.
    if (objectApiName === ACCOUNT_CONTACT_RELATION && queryTarget) {
      const direct = await directAccountContactRelations(queryTarget, payload);
      for (const [index, id] of direct) {
        const sourceId = payload[index]['Id'];
        if (typeof sourceId === 'string') mappings.push([sourceId, id]);
      }
      state.linked += direct.size;
      payload = payload.filter((_, index) => !direct.has(index));
    }
    // So is the relation it wrote for a task's or an event's who as it wrote
    // the activity: found by the activity and the record it names, now target
    // ids. See `existingActivityRelations`.
    if (ACTIVITY_OF_RELATION[objectApiName] !== undefined && queryTarget) {
      const held = await existingActivityRelations(queryTarget, objectApiName, payload);
      for (const [index, id] of held) {
        const sourceId = payload[index]['Id'];
        if (typeof sourceId === 'string') mappings.push([sourceId, id]);
      }
      state.linked += held.size;
      payload = payload.filter((_, index) => !held.has(index));
    }
    // The task the platform wrote with one of the run's emails is the one
    // read from the source: linked to, never sent a second time.
    if (objectApiName === TASK && queryTarget) {
      const linked = await this.tasksWrittenWithTheirEmail(payload, queryTarget);
      for (const [sourceId, id] of linked) mappings.push([sourceId, id]);
      state.linked += linked.size;
      payload = payload.filter((record) => !linked.has(String(record['Id'])));
    }
    if (payload.length === 0) {
      this.register(objectApiName, mappings);
      return;
    }

    const drafts = await this.startAsDrafts(objectApiName, payload);
    const outcomes = await this.deps.insert(objectApiName, payload);
    state.apiCallsUsed++;

    const keyPrefix = await this.keyPrefixOf(objectApiName);
    const keyFields = NATURAL_KEYS[objectApiName];
    const byNaturalKey: Array<{
      payload: Record<string, unknown>;
      sourceId: string | undefined;
      outcome: SaveOutcome;
    }> = [];
    payload.forEach((record, index) => {
      const sourceId = typeof record['Id'] === 'string' ? record['Id'] : undefined;
      const outcome = outcomes[index];
      if (!outcome) {
        this.refuse(state, undefined);
        return;
      }
      if (outcome.success) {
        state.written++;
        if (sourceId && outcome.id) mappings.push([sourceId, outcome.id]);
        const status = drafts.get(index);
        if (status && outcome.id) {
          this.deferredStatuses.push({ objectApiName, id: outcome.id, status });
        }
        // Only a record the run wrote owes a lookup: one the target already
        // held is linked to, and never written to.
        const owed = sourceId ? owedBySource.get(sourceId) : undefined;
        for (const lookup of outcome.id ? (owed ?? []) : []) {
          this.owedLookups.push({
            objectApiName,
            recordId: outcome.id,
            fieldApiName: lookup.fieldApiName,
            sourceId: lookup.sourceId,
            parents: lookup.parents,
          });
        }
        return;
      }
      // Refused because the target holds the record, and says which: its
      // children link to it, and nothing is written to it.
      const existing = existingRecordOf(outcome, keyPrefix);
      if (existing.kind === 'linked') {
        state.linked++;
        if (sourceId) mappings.push([sourceId, existing.id]);
        return;
      }
      if (existing.kind === 'unidentified' && keyFields && queryTarget) {
        // Settled below: the record may be found by its key.
        byNaturalKey.push({ payload: record, sourceId, outcome });
        return;
      }
      this.refuse(state, outcome);
    });

    if (keyFields && queryTarget && byNaturalKey.length > 0) {
      const found = await recordsByNaturalKey(
        queryTarget,
        objectApiName,
        keyFields,
        byNaturalKey.map((d) => d.payload),
      );
      byNaturalKey.forEach((duplicate, index) => {
        const id = found[index];
        if (id && duplicate.sourceId) {
          state.linked++;
          mappings.push([duplicate.sourceId, id]);
          return;
        }
        this.refuse(state, duplicate.outcome);
      });
    }

    this.register(objectApiName, mappings);
  }

  /**
   * The emails of a page to write now: an email on a case that names a task
   * waits for the task node's turn, while it is still to come and the run
   * copies tasks (`waitsForItsTask`). The task each email names is noted for
   * the task node, which links the ones the platform wrote.
   */
  private holdEmailsForTheirTask(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    for (const email of rows) {
      const task = email['ActivityId'];
      if (typeof email['Id'] === 'string' && typeof task === 'string' && task !== '') {
        this.taskOfEmail.set(email['Id'], task);
      }
    }
    if (this.taskTurnOver || !this.planned.has(TASK)) return rows;
    const now: Record<string, unknown>[] = [];
    for (const row of rows) {
      if (waitsForItsTask(row)) this.emailsAfterTheirTask.push(row);
      else now.push(row);
    }
    return now;
  }

  /**
   * Of the tasks about to be written, those the platform wrote with an email
   * the run wrote: the task that email names in the target, by the task's
   * source id. The platform writes the task of an email that is not on a case
   * as it takes the email, and refuses its id from a copy: the task read from
   * the source is that one. A task the platform did not write — its email
   * related to no record of the target, or not written — is not listed, and
   * goes as any other.
   */
  private async tasksWrittenWithTheirEmail(
    tasks: readonly Record<string, unknown>[],
    queryTarget: SoqlQuery,
  ): Promise<Map<string, string>> {
    /** The email each task was written with, in the target, by the task's source id. */
    const emailOfTask = new Map<string, string>();
    for (const [email, task] of this.taskOfEmail) {
      const written = this.deps.remapper.getTargetId(EMAIL_MESSAGE as ApiName, email);
      if (written) emailOfTask.set(task, written);
    }
    const asked = tasks.map((task) => String(task['Id'])).filter((id) => emailOfTask.has(id));
    if (asked.length === 0) return new Map();
    let found: Map<string, string>;
    try {
      found = await tasksWrittenWithEmails(queryTarget, [
        ...new Set(asked.map((id) => emailOfTask.get(id) ?? '')),
      ]);
    } catch (err) {
      // Not looked up, the tasks go as read, and one may stand beside the
      // platform's.
      logger.warn('Autopilot could not look up the tasks written with its emails', {
        error: extractErrorMessage(err),
      });
      return new Map();
    }
    const linked = new Map<string, string>();
    for (const id of asked) {
      const task = found.get(emailOfTask.get(id) ?? '');
      if (task) linked.set(id, task);
    }
    return linked;
  }

  /**
   * The task node has had its turn, whatever it wrote: the emails that
   * waited for the task each names go in, with the id that task has in the
   * target in place of the source's, and are counted with the other emails.
   * The email node is said to have completed once one of them is in.
   *
   * A page at a time, a pause honoured before each, as every other write of
   * the run: written in one call as the task node ended, they went in while
   * the run stood paused.
   */
  private async writeEmailsAfterTheirTask(
    edges: AutopilotEdge[],
    result: ExecutionResult,
  ): Promise<void> {
    this.taskTurnOver = true;
    const emails = this.emailsAfterTheirTask.splice(0, this.emailsAfterTheirTask.length);
    if (emails.length === 0) return;
    const state = emptyObjectState();
    for (let i = 0; i < emails.length; i += this.batchSize) {
      await this.checkPause();
      await this.writeBatch(
        EMAIL_MESSAGE as ApiName,
        emails.slice(i, i + this.batchSize),
        edges,
        state,
      );
    }
    result.totalSuccess += state.written;
    result.totalFailure += state.failed;
    result.totalLinked = (result.totalLinked ?? 0) + state.linked;
    const outcomes = result.objectOutcomes ?? {};
    result.objectOutcomes = outcomes;
    const known = outcomes[EMAIL_MESSAGE];
    const refusals = new RefusalTally();
    for (const refusal of [...(known?.refusals ?? []), ...state.refusals.list()]) {
      refusals.addCounted(refusal);
    }
    const defaulted = new Map((known?.leftToDefault ?? []).map((d) => [d.field, d.count]));
    for (const [field, count] of state.defaulted) {
      defaulted.set(field, (defaulted.get(field) ?? 0) + count);
    }
    const outcome: ObjectOutcome = {
      ...known,
      written: (known?.written ?? 0) + state.written,
      linked: (known?.linked ?? 0) + state.linked,
      failed: (known?.failed ?? 0) + state.failed,
      refusals: refusals.list(),
      ...(defaulted.size > 0
        ? { leftToDefault: [...defaulted].map(([field, count]) => ({ field, count })) }
        : {}),
    };
    outcomes[EMAIL_MESSAGE] = outcome;
    if (outcome.written + outcome.linked > 0 && result.failedObjects.includes(EMAIL_MESSAGE)) {
      result.failedObjects.splice(result.failedObjects.indexOf(EMAIL_MESSAGE), 1);
      delete result.nodeErrors?.[EMAIL_MESSAGE];
      result.completedObjects.push(EMAIL_MESSAGE);
    }
    this.emit(
      'node-completed',
      this.makeEvent({
        type: 'node-completed' as const,
        timestamp: '',
        objectApiName: EMAIL_MESSAGE as ApiName,
        successCount: outcome.written,
        failureCount: outcome.failed,
        linkedCount: outcome.linked,
        refusals: outcome.refusals,
        elapsedMs: 0,
        apiCallsUsed: state.apiCallsUsed,
      }),
    );
  }

  /**
   * Take out of each record the lookups at objects the run does not copy, and
   * count those that held a value.
   *
   * The rule Forge applies to a lookup no copy can remap: every object it may
   * point at is one no wave writes — a `User`, a queue, metadata — so no
   * target id will ever stand for the source's. Carried as read, the source
   * id reached a target that did not hold it: every order of a real run was
   * refused over an `OwnerId`. Left out, the platform fills the field in:
   * `OwnerId` becomes the running user, a custom lookup at a user is empty.
   * `RecordTypeId` has its own translation, by name.
   */
  private async leaveToDefault(
    objectApiName: string,
    rows: Record<string, unknown>[],
    state: ObjectState,
  ): Promise<void> {
    const lookups = await this.lookupsOf(objectApiName);
    if (!lookups) return;
    const fields = lookupsAtObjectsLeftOut(
      lookups.filter((lookup) => lookup.name !== 'RecordTypeId'),
      (target) => !this.planned.has(target),
    );
    if (fields.size === 0) return;
    const writable = await this.creatableFieldsOf(objectApiName);
    for (const record of rows) {
      for (const field of fields) {
        const value = record[field];
        // Counted only when it would have been sent: an audit field the
        // target sets itself was never the run's to give.
        const held = value !== null && value !== undefined && value !== '';
        if (held && (!writable || writable.has(field))) {
          state.defaulted.set(field, (state.defaulted.get(field) ?? 0) + 1);
        }
        delete record[field];
      }
    }
  }

  /** `RecordTypeId` as the target knows it, when the two orgs' record types were matched. */
  private translateRecordTypes(
    objectApiName: string,
    payload: Record<string, unknown>[],
  ): Record<string, unknown>[] {
    const mappings = this.recordTypeMappings;
    if (!mappings || !payload.some((record) => typeof record['RecordTypeId'] === 'string')) {
      return payload;
    }
    return new RecordTypeMapper().apply(payload, mappings, (recordTypeId) => {
      if (this.unmappedRecordTypes.has(recordTypeId)) return;
      this.unmappedRecordTypes.add(recordTypeId);
      warnUnmappedRecordType(objectApiName, recordTypeId, 'autopilot');
    });
  }

  /**
   * The lookups each record goes in without and a second pass can fill, by
   * the record's source id: the ones the remapper cleared, that the insert
   * sends and an update can set.
   */
  private async lookupsOwed(
    objectApiName: string,
    rows: readonly Record<string, unknown>[],
    unresolved: readonly UnresolvedLookup[],
    writable: ReadonlySet<string> | null,
  ): Promise<Map<string, UnresolvedLookup[]>> {
    const owed = new Map<string, UnresolvedLookup[]>();
    if (!this.deps.update || unresolved.length === 0) return owed;
    const lookups = await this.lookupsOf(objectApiName);
    for (const lookup of unresolved) {
      if (writable && !writable.has(lookup.fieldApiName)) continue;
      const described = lookups?.find((l) => l.name === lookup.fieldApiName);
      if (described && !described.updateable) continue;
      const sourceId = rows[lookup.index]?.['Id'];
      if (typeof sourceId !== 'string') continue;
      owed.set(sourceId, [...(owed.get(sourceId) ?? []), lookup]);
    }
    return owed;
  }

  /** Record a refused record with why. */
  private refuse(state: ObjectState, outcome: SaveOutcome | undefined): void {
    state.failed++;
    const details = detailsOf(outcome);
    state.errors.push(outcome?.errors[0] ?? lineOf(details[0]));
    state.refusals.add(details);
  }

  /** Map source ids to the target records the children will point at. */
  private register(objectApiName: ApiName, mappings: Array<[string, string]>): void {
    if (mappings.length > 0) this.deps.remapper.registerMappings(objectApiName, mappings);
  }

  /**
   * Put records whose status is past Draft in at a Draft status, and keep the
   * one they had, by payload index, for {@link applyDeferredStatuses}.
   *
   * Run for real, an order inserted activated was refused — "for a new order,
   * choose Draft" — and an activated order takes no products, so its lines,
   * a wave later, would be refused as well. The target's own categories say
   * which statuses are drafts; a target that cannot say, or a run that cannot
   * write the status back afterwards, leaves the records as they are.
   */
  private async startAsDrafts(
    objectApiName: string,
    payload: Record<string, unknown>[],
  ): Promise<Map<number, string>> {
    const drafts = new Map<number, string>();
    const lifecycle = STATUS_LIFECYCLES[objectApiName];
    const { queryTarget, update } = this.deps;
    if (!lifecycle || !queryTarget || !update) return drafts;
    let categories = this.lifecycleByObject.get(objectApiName);
    if (!categories) {
      categories = statusCategories(queryTarget, lifecycle);
      this.lifecycleByObject.set(objectApiName, categories);
    }
    const known = await categories;
    if (!known) return drafts;
    payload.forEach((record, index) => {
      const draft = draftStartOf(record['Status'], known);
      if (!draft) return;
      drafts.set(index, String(record['Status']));
      record['Status'] = draft;
    });
    return drafts;
  }

  /**
   * Give the records born a draft the status they had in the source, once
   * every wave — and so every child they take — is in.
   */
  private async applyDeferredStatuses(): Promise<Record<string, StatusOutcome>> {
    const outcomes: Record<string, StatusOutcome> = {};
    const { update } = this.deps;
    if (!update || this.deferredStatuses.length === 0) return outcomes;
    const byObject = new Map<string, DeferredStatus[]>();
    for (const entry of this.deferredStatuses) {
      byObject.set(entry.objectApiName, [...(byObject.get(entry.objectApiName) ?? []), entry]);
    }
    for (const [objectApiName, entries] of byObject) {
      let applied = 0;
      const refusals = new RefusalTally();
      for (let i = 0; i < entries.length; i += this.batchSize) {
        const part = entries.slice(i, i + this.batchSize);
        const results = await updateEach(
          update,
          objectApiName,
          part.map((entry) => ({ Id: entry.id, Status: entry.status })),
        );
        part.forEach((_, index) => {
          const outcome = results[index];
          if (outcome?.success) applied++;
          else refusals.add(detailsOf(outcome));
        });
      }
      outcomes[objectApiName] = { applied, refusals: refusals.list() };
    }
    this.deferredStatuses.length = 0;
    return outcomes;
  }

  /** Pause execution. Subsequent batch iterations will wait until resumed. */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.pausePromise = new Promise<void>((resolve) => {
      this.pauseResolve = resolve;
    });
    this.emit(
      'paused',
      this.makeEvent({
        type: 'paused' as const,
        timestamp: '',
      }),
    );
  }

  /** Resume execution after a pause. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.pauseResolve?.();
    this.pausePromise = null;
    this.pauseResolve = null;
    this.emit(
      'resumed',
      this.makeEvent({
        type: 'resumed' as const,
        timestamp: '',
      }),
    );
  }

  /**
   * Skip an object. If called before execution reaches that object, it will be skipped.
   * @param objectApiName - The object to skip
   */
  skip(objectApiName: string): void {
    this.skippedObjects.add(objectApiName);
  }

  /** Check if paused and wait until resumed. */
  private async checkPause(): Promise<void> {
    if (this.paused && this.pausePromise) {
      await this.pausePromise;
    }
  }

  /** Create a timestamped event, overriding the timestamp field. */
  private makeEvent<T extends AutopilotEvent>(event: T): T {
    return { ...event, timestamp: new Date().toISOString() };
  }
}

/**
 * Update records of the target, one outcome per record: a call that throws
 * is every record of it refused, with the message it threw.
 */
async function updateEach(
  update: UpdateFn,
  objectApiName: string,
  records: Record<string, unknown>[],
): Promise<SaveOutcome[]> {
  try {
    return await update(objectApiName, records);
  } catch (err) {
    const message = extractErrorMessage(err);
    return records.map(() => ({
      id: '',
      success: false,
      errors: [message],
      errorDetails: [saveErrorDetail(message)],
    }));
  }
}

/**
 * A refused record's errors with their codes — never none, so every refused
 * record is counted under some reason. A writer that gave messages only has
 * them read as they are, under no code.
 */
function detailsOf(outcome: SaveOutcome | undefined): SaveErrorDetail[] {
  if (!outcome) return [NO_RESULT_DETAIL];
  if (outcome.errorDetails && outcome.errorDetails.length > 0) return outcome.errorDetails;
  if (outcome.errors.length > 0) return outcome.errors.map((message) => saveErrorDetail(message));
  return [NO_REASON_DETAIL];
}

/** `STATUS_CODE: message`, or the message alone when the target gave no code. */
function lineOf(detail: SaveErrorDetail): string {
  return detail.statusCode === NO_STATUS_CODE
    ? detail.message
    : `${detail.statusCode}: ${detail.message}`;
}
