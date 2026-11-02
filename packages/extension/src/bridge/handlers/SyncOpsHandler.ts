import * as z from 'zod';
import { assertSoqlOrderBy } from '../../core/common/soqlValidator.js';
import type {
  AuditObjectCounts,
  AuditOutcome,
  CheckpointRefusal,
  GuardDecision,
  MappingType,
  RunCheckpointEstimate,
  RunCheckpointInfo,
  RunCheckpointRequest,
  RunCheckpointTaken,
  SyncConfig,
  SyncConfigSummary,
  SyncEncryptedFieldsMasked,
  SyncExecutionResult,
  SyncHistoryEntry,
  SyncObjectConfig,
  SyncObjectResult,
  SyncOperation,
  SyncRunControlAnswer,
  SyncSimulationResult,
} from '@sandforge/shared';
import {
  TRANSFORM_RULE_NO_FIELD,
  auditMutedOf,
  fieldlessTransformRefusal,
  fieldlessTransformRules,
  sanitizeSoqlObjectName,
  guardTierOf,
  recordWriteHeaders,
  syncConfigNameRefused,
} from '@sandforge/shared';
import type { OrgTypeAndEdition } from '@sandforge/shared';
import type {
  HandlerDeps,
  DomainHandler,
  GrappeEventEnvelope,
  InboundRequest,
  OperationFailureContext,
} from './HandlerTypes.js';
import {
  buildResponse,
  sendHandlerError,
  sendNotification,
  sendOperationStarted,
  sendOperationProgress,
  sendOperationCompleted,
  sendOperationFailed,
  objectsFailureContext,
  postGrappeEvent,
  readGrappeConfig,
  robustnessConfigOf,
  bulkManagerOf,
  syntheticRequest,
  ABORTED_BEFORE_START,
  PRODUCTION_GUARD_MISSING,
  productionGuardMissingError,
  GUARD_REFUSAL,
  guardBlockedError,
  guardRefusalCode,
} from './HandlerTypes.js';
import { SyncConfigStore } from '../../modules/sync/SyncConfigStore.js';
import { keepRunUser } from '../../modules/sync/runUser.js';
import { RUN_CANCELLED } from '../../modules/forge/forgeAudit.js';
import { toSaveOutcomes } from '../../core/common/existingRecordMatch.js';
import type { SyncExecutionLogger } from '../../modules/sync/SyncExecutionLogger.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { readColumnsApart } from '../../core/common/wideRead.js';
import {
  queryAllPages,
  FORGE_QUERY_MAX_RECORDS,
  FORGE_QUERY_MAX_PAGES,
} from '../../modules/forge/queryAllPages.js';
import { DmlOperationTracker } from '../../core/common/DmlOperationTracker.js';
import {
  validatePayload,
  syncExecutePayloadSchema,
  syncConfigSavePayloadSchema,
  syncConfigIdPayloadSchema,
  syncDescribeGlobalPayloadSchema,
  syncDescribeFieldsPayloadSchema,
  syncSimulatePayloadSchema,
  syncRunControlPayloadSchema,
  syncCannotCopy,
} from '../validatePayload.js';
import { FieldTypeValidator } from '../../modules/sync/FieldTypeValidator.js';
import { notSentAsRead } from '../../modules/sync/FieldMapping.js';
import { SyncRunFailure, SyncRunRefused } from '../../modules/sync/SyncRunFailure.js';
import { describeCached } from '../../core/connection/describeCache.js';
import type { FieldDescriptor } from '../../modules/sync/FieldTypeValidator.js';
import { checkApiLimits } from '../../core/common/sforceLimitParser.js';
import { resolveOrgTier, getQueryLimits } from '../../core/common/queryLimits.js';
import { isNetworkError } from '../../core/common/isNetworkError.js';
import { RetryableOperation } from '../../core/engine/RetryableOperation.js';
import { TimeoutManager } from '../../core/engine/TimeoutManager.js';
import { BulkApiExecutor } from '../../core/engine/BulkApiExecutor.js';
import type { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import type { OperationRequest } from '../../core/precheck/ProductionGuard.js';
import { consultProductionGuard } from '../../core/precheck/consultProductionGuard.js';
import { emptyCounts, recordWriteRun } from '../../modules/audit/auditTrail.js';
import {
  NO_APEX_IN_PRODUCTION,
  readEmailDeliverability,
} from '../../modules/forge/targetDeliverability.js';
import { runEmailsDetailsOf, type RunEmailsSaid } from '../../modules/forge/runEmailsSaid.js';
import { BulkDataWriter, syncWriterCalls } from '../../modules/sync/BulkDataWriter.js';
import {
  targetWriteFieldsOf,
  type TargetWriteFields,
} from '../../modules/sync/targetWriteFields.js';
import type { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import { PauseGate } from '../../modules/sync/PauseGate.js';
import { targetLookup } from '../../modules/sync/SyncSimulation.js';
import {
  orgDeltaReads,
  sourceReadWhere,
  type SyncDeltaReads,
  type SyncDeltaStore,
} from '../../modules/sync/SyncDelta.js';
import type {
  OrchestratorCountFn,
  OrchestratorFindFn,
  OrchestratorQueryFn,
  SourceRead,
} from '../../modules/sync/SyncOrchestrator.js';
import {
  filesSummaryLine,
  orgFileCopyDeps,
  targetAllowsDeletes,
  type FileCopyOrg,
  type SyncFileDeps,
  type SyncFileStore,
} from '../../modules/sync/SyncFiles.js';
import type {
  SyncCreationRecorder,
  SyncRunCreations,
} from '../../modules/sync/SyncRunCreations.js';
import {
  BEFORE_RUN_DELETED_WORDS,
  beforeRunProgressWords,
  type BeforeRunAsk,
  type BeforeRunCheckpoints,
} from '../../modules/checkpoint/beforeRunCheckpoint.js';
import {
  storeOverwriteBackup,
  syncOverwriteKeeper,
  type BackupRecordFiles,
} from '../../modules/sync/syncOverwrites.js';
import {
  maskedEncryptedFields,
  viewsEncryptedDataOnce,
} from '../../modules/sync/encryptedFields.js';
import { savedConfigIdMap, type SyncIdMapStore } from '../../modules/sync/SyncIdMap.js';
import type { SyncRecordTypes } from '../../modules/sync/syncRecordTypes.js';
import type { RunCurrencies } from '../../core/common/recordCurrencies.js';
import type { StandardPricebooks } from '../../modules/sync/syncPrices.js';
import type { TargetAutomationReader } from '../../modules/forge/TargetAutomationReader.js';
import { liveAnswer, type WriteConfirmation } from '../../core/precheck/ProductionGuard.js';
import {
  DEFAULT_CONFIRM_ABOVE_RECORDS,
  readApiBudget,
  readDataStorage,
  readEmailLimits,
} from '../../modules/forge/ForgeRunGate.js';
import {
  mutingSyncWriteGate,
  syncRunWrites,
  syncWriteGate,
  type SyncCheckpointFirst,
  type SyncGatePolicy,
  type SyncWriteGate,
  type SyncWriteMeasures,
} from '../../modules/sync/SyncRunGate.js';
import {
  muteForRun,
  muteOrgOf,
  type MuteLeaseOptions,
} from '../../modules/forge/AutomationMuteLease.js';
import {
  lookupsOf,
  orderSyncObjects,
  type WriteLookup,
} from '../../modules/sync/syncWriteOrder.js';

/** How long the read of the target's data storage and email limits may take. */
const LIMITS_TIMEOUT_MS = 30_000;

/** How long the read of the target's automation may take, as Forge's may. */
const AUTOMATION_TIMEOUT_MS = 60_000;

/** What a run refused at its start left undone, as its refusal ends. */
const NOTHING_DONE = 'Nothing was read or written.';

/** What a simulation refused at its start left undone: it never writes. */
const NOTHING_READ = 'Nothing was read.';

/**
 * Why a run asked to take a checkpoint first takes none, in a window whose
 * checkpoints the Sync handler was never given: the run is refused, nothing
 * written, rather than run without the rewind the option promised.
 */
const NO_CHECKPOINTS_HERE = 'the checkpoints of this window are not open to the Sync page';

/**
 * The checkpoint a run asked to take first, bound to the run: what its gate
 * scopes and takes it through, and what each of them said, for the run to
 * point at once it has written or to delete when it wrote nothing.
 */
interface SyncRunCheckpoint {
  gate: SyncCheckpointFirst;
  /** What the gate's scope said it would hold and cost; undefined until it was asked. */
  planned(): RunCheckpointEstimate | undefined;
  /** The checkpoint taken; undefined until the take kept one. */
  taken(): RunCheckpointTaken | undefined;
  /** The refusal its scope or its take met, by its code; undefined when none did. */
  refusal(): CheckpointRefusal | undefined;
}

/** What starts a run nobody watches from the Sync page: a schedule, or a pipeline's Sync step. */
export type UnattendedSyncOrigin = Extract<
  SyncHistoryEntry['triggeredBy'],
  'schedule' | 'pipeline'
>;

/** Message types handled by SyncOpsHandler. */
const SYNC_TYPES = new Set([
  'sync:execute',
  'sync:simulate',
  'sync:write-order',
  'sync:pause',
  'sync:resume',
  'sync:describe-global',
  'sync:describe-fields',
  'sync:config:save',
  'sync:config:load',
  'sync:config:list',
  'sync:config:delete',
  'sync:config:reset-delta',
]);

/**
 * Severity ranking used to collapse a multi-object sync into the single
 * operation the Production Guard judges. Highest wins, so one `delete` object
 * makes the whole run destructive in the guard's eyes.
 */
const SYNC_OPERATION_SEVERITY: Record<SyncOperation, number> = {
  insert: 0,
  update: 1,
  upsert: 2,
  delete: 3,
};

/**
 * Build the Production Guard request describing a sync run on its target org.
 *
 * The guard judges one operation on one object, while a sync config carries
 * one operation per object — both are collapsed conservatively:
 * - `operation`: the most destructive operation configured (see
 *   {@link SYNC_OPERATION_SEVERITY}). This used to be hard-coded to
 *   `'upsert'`, which presented a delete-mode sync as a write and let it
 *   straight past the rule that blocks destructive operations on production.
 *   A delta run that carries the source's deletions is judged as the delete
 *   it is.
 * - `objectName`: every object in the config, not just the first — the audit
 *   entry and the confirmation prompt must name what is actually touched.
 * - `recordCount`: `'unknown'`. The source rows are only queried later,
 *   inside the orchestrator, so no count is known at gate time — the
 *   previous hard-coded 1 claimed a volume nobody had measured.
 *
 * A pipeline's Sync step asks the guard with this same request before its
 * pipeline starts. It kept a copy of its own, which judged a delta run that
 * deletes as the upsert it also is: the step was let through beforehand, then
 * refused by the run as a delete once the steps before it had run.
 *
 * @param config - The sync config about to be executed.
 * @param targetOrg - The target org as the registry holds it, its type and
 *   edition (`guardTierOf`: a Developer Edition org is a development one);
 *   absent for one the registry does not know, which the guard reads as
 *   production.
 * @returns The guard request for its target org.
 */
export function syncGuardRequest(
  config: SyncConfig,
  targetOrg: OrgTypeAndEdition | undefined,
): OperationRequest {
  const objects = config.objects ?? [];
  let operation: SyncOperation = 'insert';
  for (const object of objects) {
    if (SYNC_OPERATION_SEVERITY[object.operation] > SYNC_OPERATION_SEVERITY[operation]) {
      operation = object.operation;
    }
  }
  if (config.mode === 'delta' && config.propagateDeletes === true) operation = 'delete';
  const objectNames = objects.map((o) => o.objectApiName);
  return {
    orgId: config.targetOrgId,
    orgTier: guardTierOf(targetOrg),
    operation,
    objectName: objectNames.length > 0 ? objectNames.join(', ') : 'SyncData',
    recordCount: 'unknown',
    module: 'sync',
  };
}

/**
 * What a sync did per object, for the audit trail. Each object runs one
 * operation, so its successes are created, updated or deleted — for an upsert,
 * created or updated as the org said for each record, and upserted when it
 * did not say.
 */
function syncAuditObjects(results: readonly SyncObjectResult[]): AuditObjectCounts[] {
  return results.map((result) => {
    // The deletions a delta run carried for the source's are this object's
    // deletes, beside what its operation wrote.
    const counts = {
      ...emptyCounts(result.objectApiName),
      failed: result.failed + (result.delta?.deleteFailed ?? 0),
      deleted: result.delta?.deleted ?? 0,
    };
    switch (result.operation) {
      case 'insert':
        return { ...counts, created: result.success };
      case 'update':
        return { ...counts, updated: result.success };
      case 'delete':
        return { ...counts, deleted: result.success };
      case 'upsert': {
        // Created and updated as the org said for each record; a record it
        // said neither of is counted apart, not guessed into either.
        const split = result.upsertSplit ?? { created: 0, updated: 0 };
        const unsaid = result.success - split.created - split.updated;
        return {
          ...counts,
          created: split.created,
          updated: split.updated,
          ...(unsaid > 0 ? { upserted: unsaid } : {}),
        };
      }
    }
  });
}

/**
 * Mapping types that write the source value as it was read. A transform,
 * constant, formula or add-on rewrites the value before it is written, so its
 * source type says nothing about what reaches the target field.
 */
const VERBATIM_MAPPING_TYPES: ReadonlySet<MappingType> = new Set<MappingType>(['direct', 'rename']);

/** Most field mismatches named in one refusal; the rest are counted. */
const MAX_REPORTED_FIELD_MISMATCHES = 20;

/**
 * The part of a describe response the field-type comparison reads. The refusal
 * rests on it, so an org answering without a field's type must end the run
 * with a message rather than a TypeError inside the comparison.
 */
const describedFieldsSchema = z.object({
  fields: z.array(
    z
      .object({
        name: z.string(),
        type: z.string(),
        createable: z.boolean(),
        updateable: z.boolean(),
      })
      .loose(),
  ),
});
type DescribedField = z.infer<typeof describedFieldsSchema>['fields'][number];

/** Read the describe fields of `objectApiName`, refusing a response of any other shape. */
function parseDescribedFields(
  describe: unknown,
  objectApiName: string,
  org: 'source' | 'target',
): DescribedField[] {
  const parsed = describedFieldsSchema.safeParse(describe);
  if (parsed.success) return parsed.data.fields;
  const issue = parsed.error.issues[0];
  throw new Error(
    `The ${org} org described ${objectApiName} in a shape field types cannot be compared on ` +
      `(${issue.path.join('.')}: ${issue.message}), so the sync was not started and nothing ` +
      `was written.`,
  );
}

/** What a run and a simulation of it read both orgs with: see `SyncOpsHandler.readersFor`. */
interface SyncReaders {
  sourceConn: Awaited<ReturnType<typeof getJsforceConnection>>;
  targetConn: Awaited<ReturnType<typeof getJsforceConnection>>;
  querySource: OrchestratorQueryFn;
  queryTarget: OrchestratorQueryFn;
  /** The encrypted fields the source's user reads masked: see `SyncOrchestratorDeps.maskedSourceFields`. */
  maskedSourceFields: (objectApiName: string) => Promise<string[]>;
  countSource: OrchestratorCountFn;
  describeTargetFields: (objectApiName: string) => Promise<TargetWriteFields>;
  /**
   * The same describe asked of the target again, past the one the run holds:
   * see `SyncOrchestratorDeps.describeTargetFieldsAgain`.
   */
  describeTargetFieldsAgain: (objectApiName: string) => Promise<TargetWriteFields>;
  /**
   * The rows a statement over the target returns, every page of them: what
   * reads back the record types the target gave (`SyncOrchestratorDeps.queryTargetRows`).
   */
  queryTargetRows: (soql: string) => Promise<Array<Record<string, unknown>>>;
  /** Both orgs' record types, what `RecordTypeId` is mapped with: see `readSyncRecordTypes`. */
  recordTypes: () => Promise<SyncRecordTypes>;
  /** Both orgs' currencies, what a row in one the target lacks is written in: see `readRunCurrencies`. */
  currencies: () => Promise<RunCurrencies | undefined>;
  /** Both orgs' standard price books, matched by the run: see `readStandardPricebooks`. */
  standardPricebooks: () => Promise<StandardPricebooks | undefined>;
  findInTarget: OrchestratorFindFn;
  /** The ids an object's read returns, asked for alone: see `SyncOrchestratorDeps.readSourceIds`. */
  readSourceIds: (objectConfig: SyncObjectConfig) => Promise<string[]>;
  /** Of an account's or a contact's records, those of person accounts: see `SyncOrchestratorDeps.countPersonAccounts`. */
  countPersonAccounts: (objectConfig: SyncObjectConfig, read?: SourceRead) => Promise<number>;
  /** What a delta configuration asks both orgs: see `SyncDelta`. */
  deltaReads: SyncDeltaReads;
  /** What a configuration that copies files reads and writes: see `SyncFiles`. */
  files: SyncFileDeps;
}

/**
 * Who answers for the emails of a run nobody is asked about, and what lifts
 * its refusal. A pipeline's step is answered by the Approval before it — the
 * answer the step's run carries (`withGivenAnswer`) — and nothing else; a
 * schedule by no one. A run from the page is asked: only a lease that does not
 * hold what it was to keep quiet refuses it.
 */
function syncEmailsAnswerOf(policy: SyncGatePolicy): {
  emailsAccepted?: boolean;
  emailsLiftedBy: string;
} {
  if (policy === 'ask') {
    return {
      emailsLiftedBy: 'Untick Mute automation to be asked about them and sync all the same',
    };
  }
  const given = liveAnswer();
  return given
    ? {
        emailsAccepted: given.approved,
        emailsLiftedBy: 'Approve an Approval step put before this Sync step to sync all the same',
      }
    : {
        emailsLiftedBy:
          'Run it from the Sync page, which asks before it writes, to sync all the same',
      };
}

/**
 * Domain handler for sync-related webview-to-extension messages.
 *
 * Routes sync:* message types to schema description and data synchronization
 * operations between Salesforce orgs, with production guard checks,
 * performance tracking, retry, timeout, bulk API, and field type validation.
 * Record writes are delegated to {@link BulkDataWriter}; this handler only
 * orchestrates message handling, guards, and progress channels.
 */
export class SyncOpsHandler implements DomainHandler {
  /**
   * Set of active operation IDs being tracked.
   * Used to ensure cleanup happens exactly once in all code paths.
   */
  private readonly activeOperationIds = new Set<string>();

  /** Tracks DML operations to prevent duplicate submissions. */
  private readonly dmlTracker = new DmlOperationTracker();

  /** Persistence facade for sync configurations. */
  private readonly syncConfigStore: SyncConfigStore;

  /** Background operation registry for detached execution. */
  private registry?: BackgroundOperationRegistry;

  /**
   * Execution-history logger. Injected by ExtensionHandlers so every completed
   * sync lands in SyncHistoryStore (powers the sync:history:* read surface).
   */
  private historyLogger?: SyncExecutionLogger;

  /** Live operation tracker feeding the Monitor "live operations" panel. */
  private liveTracker?: LiveOperationTracker;

  /** The pause of each run under way, by its operation id: what `sync:pause` sets. */
  private readonly pauseGates = new Map<string, PauseGate>();

  /** Where every run keeps what it creates, for its removal. */
  private runCreations?: SyncRunCreations;

  /**
   * The DataOps backup store, where a run keeps the values of what it writes
   * over before it writes (`syncOverwrites`). Without it, or without
   * {@link runCreations}, nothing is kept and an update cannot be taken back.
   */
  private backupRecords?: BackupRecordFiles;

  /**
   * What reads the target's automation for a run's write gate: the handler's
   * own reader, as Forge reads it, loaded the first time a run needs it,
   * unless another is set.
   */
  private targetAutomation: Pick<TargetAutomationReader, 'read'> = {
    read: async (orgId, objectApiNames) => (await this.ownReader()).read(orgId, objectApiNames),
  };
  /** The reader {@link targetAutomation} reads through, once loaded. */
  private reader?: Promise<TargetAutomationReader>;

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {
    this.syncConfigStore = new SyncConfigStore(deps.configStore);
  }

  /**
   * Another reader of the target's automation than the handler's own: a run's
   * write gate counts the emails the target's flows send as its records go in.
   */
  setTargetAutomation(reader: Pick<TargetAutomationReader, 'read'>): void {
    this.targetAutomation = reader;
  }

  /** The handler's own reader of the target's automation, as Forge reads it, off the activation path. */
  private ownReader(): Promise<TargetAutomationReader> {
    this.reader ??= import('../../modules/forge/TargetAutomationReader.js').then(
      ({ TargetAutomationReader, targetAutomationQueries }) =>
        new TargetAutomationReader(
          targetAutomationQueries((orgId) =>
            getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager),
          ),
        ),
    );
    return this.reader;
  }

  /** `sandforge.safety.confirmAboveRecords`: the volume past which a run asks before it writes; 0 never asks. */
  private confirmAboveRecords(): number {
    const value = this.deps.services?.getSandforgeSetting?.<unknown>(
      'safety.confirmAboveRecords',
      DEFAULT_CONFIRM_ABOVE_RECORDS,
    );
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : DEFAULT_CONFIRM_ABOVE_RECORDS;
  }

  /**
   * What a run of `config` is held to before its first write, and a
   * simulation of it measured by (`SyncRunGate`): its records against the
   * target's data storage, its daily emails, whether the target delivers them
   * and the setting's volume, asked of the user through Production Guard's
   * confirmation when someone started it, and refused past the emails when
   * nobody watches it — and, where the target delivers them, unless the
   * Approval before a pipeline's step answered for them.
   *
   * @param policy - Who answers for the run (`SyncGatePolicy`).
   * @param checkpointFirst - The checkpoint the run takes of what it writes
   *   before its first write, when asked: counted in its requests and asked
   *   about at its gate, taken once the question is answered.
   */
  private writeGateFor(
    config: SyncConfig,
    targetConn: Awaited<ReturnType<typeof getJsforceConnection>>,
    policy: SyncGatePolicy,
    readAutomation?: SyncWriteMeasures['readAutomation'],
    checkpointFirst?: SyncCheckpointFirst,
  ): SyncWriteGate {
    const target = this.deps.orgManager.getOrg(config.targetOrgId);
    const reader = this.targetAutomation;
    const guard = this.deps.infraServices?.productionGuard;
    const emailsAnswer = syncEmailsAnswerOf(policy);
    return syncWriteGate(
      {
        readStorage: () =>
          new TimeoutManager(LIMITS_TIMEOUT_MS).withTimeout('sync:limits', () =>
            readDataStorage(targetConn),
          ),
        readApiBudget: () =>
          new TimeoutManager(LIMITS_TIMEOUT_MS).withTimeout('sync:limits', () =>
            readApiBudget(targetConn),
          ),
        readAutomation:
          readAutomation ??
          ((objects) =>
            new TimeoutManager(AUTOMATION_TIMEOUT_MS).withTimeout('sync:automation', () =>
              reader.read(config.targetOrgId, objects),
            )),
        readLimits: () =>
          new TimeoutManager(LIMITS_TIMEOUT_MS).withTimeout('sync:limits', () =>
            readEmailLimits(targetConn),
          ),
        // As the user the run writes as, once something that still runs may
        // send an email: one line of anonymous Apex that sends nothing, never
        // in a production org, where a person may still run a sync.
        readDeliverability: () =>
          guardTierOf(target) === 'production'
            ? Promise.resolve(NO_APEX_IN_PRODUCTION)
            : readEmailDeliverability(targetConn),
        emails: {
          target: target?.alias ?? config.targetOrgId,
          accepted: emailsAnswer.emailsAccepted === true,
          keepsAddresses: config.keepContactPoints === true,
        },
        confirmAboveRecords: this.confirmAboveRecords(),
        ...(checkpointFirst ? { checkpointFirst } : {}),
      },
      {
        policy,
        org: target?.alias ?? config.targetOrgId,
        orgTier: guardTierOf(target),
        ...(guard ? { confirm: (question: WriteConfirmation) => guard.confirmRun(question) } : {}),
        emailsLiftedBy: emailsAnswer.emailsLiftedBy,
      },
    );
  }

  /**
   * Set the background operation registry for detached execution.
   * Called from ExtensionHandlers after construction.
   *
   * @param registry - The shared BackgroundOperationRegistry instance.
   */
  setRegistry(registry: BackgroundOperationRegistry): void {
    this.registry = registry;
  }

  /** Where and how a run that mutes keeps its lease, in place of the home directory's. */
  setMuteLeases(options: MuteLeaseOptions): void {
    this.muteLeases = options;
  }

  /** Where and how the mute leases are kept, when not the home directory's. */
  private muteLeases: MuteLeaseOptions = {};

  /**
   * Inject the sync execution-history logger.
   *
   * @param logger - The shared SyncExecutionLogger instance.
   */
  setHistoryLogger(logger: SyncExecutionLogger): void {
    this.historyLogger = logger;
  }

  /**
   * Inject the live operation tracker so sync executions show up in the
   * Monitor "live operations" panel. Called from ExtensionHandlers.
   *
   * @param tracker - The shared LiveOperationTracker instance.
   */
  setLiveOperationTracker(tracker: LiveOperationTracker): void {
    this.liveTracker = tracker;
  }

  /**
   * Inject where every run keeps what it creates in its target, as it writes
   * it: a run from the page, a re-run, a schedule's and a pipeline's alike.
   * Without it a run keeps nothing, and cannot be taken back.
   *
   * @param store - The file-backed store of each run's creations.
   */
  setRunCreations(store: SyncRunCreations): void {
    this.runCreations = store;
  }

  /**
   * Inject the DataOps backup store: a run keeps there, before it writes, the
   * values the records it writes over hold, listed on the Restore tab as a
   * backup of the target, and its removal gives them back.
   */
  setBackupRecordStore(store: BackupRecordFiles): void {
    this.backupRecords = store;
  }

  /**
   * The checkpoints of this window, which a run asked to take one of what it
   * writes before its first write (Checkpoint first) takes it through, as
   * every module's run does. Unset, such a run is refused, nothing written.
   */
  setBeforeRunCheckpoints(checkpoints: BeforeRunCheckpoints): void {
    this.beforeRunCheckpoints = checkpoints;
  }

  /** See {@link setBeforeRunCheckpoints}. */
  private beforeRunCheckpoints?: BeforeRunCheckpoints;

  /**
   * The checkpoint a run of `config` asked to take first, bound to the run:
   * scoped at its gate from the objects it writes and what still runs as it
   * writes them, taken once its question is answered and before the mute's
   * lease — under the run's Stop, its progress the run's, named on the run's
   * file — and only the run's own file, by its id, left out of what refuses
   * it. A simulation scopes it, and never takes it.
   *
   * @param run - The run's Stop and its file; absent for a simulation.
   */
  private runCheckpointOf(
    config: SyncConfig,
    operationId: string,
    request: RunCheckpointRequest,
    run?: { signal: AbortSignal; recorder?: Pick<SyncCreationRecorder, 'checkpoint'> },
  ): SyncRunCheckpoint {
    const checkpoints = this.beforeRunCheckpoints;
    // The run's file is kept under its operation id, and written by this
    // process: that file alone does not refuse its own checkpoint.
    const own = { runId: operationId };
    let ask: BeforeRunAsk | undefined;
    let planned: RunCheckpointEstimate | undefined;
    let taken: RunCheckpointTaken | undefined;
    let refusal: CheckpointRefusal | undefined;
    return {
      gate: {
        scope: async (written, running) => {
          if (!checkpoints) throw new Error(NO_CHECKPOINTS_HERE);
          ask = {
            module: 'sync',
            orgId: config.targetOrgId,
            operationId,
            written: [...written],
            running,
            request,
          };
          planned = await checkpoints.scope(ask, own);
          refusal = planned.refusal;
          return planned;
        },
        take: async (estimate) => {
          if (!checkpoints || !ask) throw new Error(NO_CHECKPOINTS_HERE);
          const outcome = await checkpoints.take(ask, own, {
            planned: estimate,
            ...(run
              ? {
                  signal: run.signal,
                  onProgress: (progress) => {
                    const label = beforeRunProgressWords(progress.percentage);
                    const percent = Math.round(progress.percentage);
                    const { processedObjects, totalObjects } = progress;
                    sendOperationProgress(
                      this.deps,
                      operationId,
                      percent,
                      processedObjects,
                      totalObjects,
                      label,
                    );
                    this.liveTracker?.updateProgress(
                      operationId,
                      percent,
                      processedObjects,
                      totalObjects,
                      label,
                    );
                  },
                }
              : {}),
          });
          if (outcome.taken) {
            taken = outcome.checkpoint;
            run?.recorder?.checkpoint?.(outcome.checkpoint);
          } else if ('refusal' in outcome) {
            refusal = outcome.refusal;
          }
          return outcome;
        },
      },
      planned: () => planned,
      taken: () => taken,
      refusal: () => refusal,
    };
  }

  /**
   * What becomes of the checkpoint a run took first, once the run has ended:
   * kept when it sent a write, whatever became of the run after; deleted when
   * it sent none — its lease refused after the take, its Stop before its first
   * write. A checkpoint the store would not delete, or could not be told of,
   * stays, and is said in the log.
   */
  private async settleRunCheckpoint(
    checkpoint: SyncRunCheckpoint | undefined,
    wrote: boolean,
    operationId: string,
  ): Promise<RunCheckpointInfo | undefined> {
    const taken = checkpoint?.taken();
    if (!taken || !this.beforeRunCheckpoints) return undefined;
    try {
      return await this.beforeRunCheckpoints.settle(taken, wrote);
    } catch (err: unknown) {
      this.deps.log(
        `[WARN] sync ${operationId}: the checkpoint '${taken.name}' taken before the run is ` +
          `kept: ${extractErrorMessage(err)}`,
      );
      return taken;
    }
  }

  /**
   * Whether a run is still under way in this window: its creations are still
   * being written, and no removal may take them meanwhile.
   *
   * @param operationId - The run's id, which its creations are kept under.
   */
  isRunning(operationId: string): boolean {
    return this.activeOperationIds.has(operationId);
  }

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: InboundRequest): Promise<boolean> {
    if (!SYNC_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'sync:describe-global':
        await this.handleDescribeGlobal(msg);
        return true;
      case 'sync:describe-fields':
        await this.handleDescribeFields(msg);
        return true;
      case 'sync:execute':
        await this.handleExecute(msg);
        return true;
      case 'sync:simulate':
        await this.handleSimulate(msg);
        return true;
      case 'sync:write-order':
        await this.handleWriteOrder(msg);
        return true;
      case 'sync:pause':
        await this.handleRunControl(msg, 'pause');
        return true;
      case 'sync:resume':
        await this.handleRunControl(msg, 'resume');
        return true;
      case 'sync:config:save':
        await this.handleConfigSave(msg);
        return true;
      case 'sync:config:load':
        await this.handleConfigLoad(msg);
        return true;
      case 'sync:config:list':
        await this.handleConfigList(msg);
        return true;
      case 'sync:config:delete':
        await this.handleConfigDelete(msg);
        return true;
      case 'sync:config:reset-delta':
        await this.handleConfigResetDelta(msg);
        return true;
      default:
        return false;
    }
  }

  /**
   * Refuse a configuration a transform rule of which names no field, before
   * anything is read, written or saved: run, the rule would change every
   * field of every record (`fieldlessTransformRules`). Said on `channel` by
   * its code, with each such rule and its object for the page to name in its
   * language; the message is English, and ends with `undone`.
   *
   * @returns Whether it was refused.
   */
  private refusedFieldless(
    msg: InboundRequest,
    config: { objects: Parameters<typeof fieldlessTransformRules>[0] },
    context: string,
    channel: string,
    undone: string,
  ): boolean {
    const rules = fieldlessTransformRules(config.objects);
    if (rules.length === 0) return false;
    sendHandlerError(
      this.deps,
      context,
      channel,
      msg,
      new Error(`${fieldlessTransformRefusal(rules)} ${undone}`),
      { code: TRANSFORM_RULE_NO_FIELD, extraPayload: { rules } },
    );
    return true;
  }

  /**
   * Save a sync configuration. One a transform rule of which names no field
   * is refused: a schedule of it could only ever be refused. A new one under
   * a name another saved configuration has, or a saved one renamed to it, is
   * refused by the code the page words, as Migration's save refuses it: the
   * wizard named every configuration after its pair of orgs, and Migration
   * then refused that name as taken.
   */
  private async handleConfigSave(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(syncConfigSavePayloadSchema, msg, 'sync:error', this.deps);
    if (!parsed) return;
    if (
      this.refusedFieldless(
        msg,
        parsed.config,
        'sync:config:save',
        'sync:error',
        'Nothing was saved.',
      )
    ) {
      return;
    }
    try {
      const config = parsed.config as unknown as SyncConfig;
      if (syncConfigNameRefused(this.syncConfigStore.list(), config.id, config.name)) {
        const refused = buildResponse(this.deps, msg, 'sync:config:save:response', {
          success: false,
          id: config.id,
          code: 'DUPLICATE_NAME',
        });
        this.deps.broker.postToWebview(refused);
        this.deps.log(`[TX] ${refused.type} id=${refused.id} DUPLICATE_NAME`);
        return;
      }
      this.syncConfigStore.save(config);
      const response = buildResponse(this.deps, msg, 'sync:config:save:response', {
        success: true,
        id: config.id,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'sync:config:save', 'sync:error', msg, err);
    }
  }

  /** Load a sync configuration by ID. */
  private async handleConfigLoad(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(syncConfigIdPayloadSchema, msg, 'sync:error', this.deps);
    if (!parsed) return;
    try {
      const config = this.syncConfigStore.load(parsed.id);
      const response = buildResponse(this.deps, msg, 'sync:config:load:response', {
        config: (config as unknown as Record<string, unknown>) ?? null,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'sync:config:load', 'sync:error', msg, err);
    }
  }

  /** List all sync configurations (summary view). */
  private async handleConfigList(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    try {
      const configs = this.syncConfigStore.list();
      const summaries: SyncConfigSummary[] = configs.map((c) => {
        const delta = this.syncConfigStore.loadDelta(c.id);
        return {
          id: c.id,
          name: c.name,
          description: c.description,
          updatedAt: c.updatedAt,
          mode: c.mode,
          propagateDeletes: c.propagateDeletes === true,
          watermarks: delta.kind === 'stored' ? delta.state.entries.length : 0,
        };
      });
      const response = buildResponse(this.deps, msg, 'sync:config:list:response', {
        configs: summaries,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'sync:config:list', 'sync:error', msg, err);
    }
  }

  /** Delete a sync configuration by ID. */
  private async handleConfigDelete(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(syncConfigIdPayloadSchema, msg, 'sync:error', this.deps);
    if (!parsed) return;
    try {
      const success = this.syncConfigStore.delete(parsed.id);
      // And which record of the target each record of its runs became: no
      // run of it reads them again.
      await this.runCreations
        ?.idMap()
        .delete(parsed.id)
        .catch((err: unknown) =>
          this.deps.log(`[WARN] sync:config:delete ${parsed.id}: ${extractErrorMessage(err)}`),
        );
      const response = buildResponse(this.deps, msg, 'sync:config:delete:response', { success });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'sync:config:delete', 'sync:error', msg, err);
    }
  }

  /**
   * "Run full next time": clear the watermarks of a saved configuration, so
   * its next run reads every object whole. A configuration that is not saved
   * has none, and is refused rather than answered as cleared.
   */
  private async handleConfigResetDelta(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(syncConfigIdPayloadSchema, msg, 'sync:error', this.deps);
    if (!parsed) return;
    try {
      if (!this.syncConfigStore.load(parsed.id)) {
        throw new Error('This configuration is no longer saved: there is nothing to reset.');
      }
      const cleared = this.syncConfigStore.clearDelta(parsed.id);
      const response = buildResponse(this.deps, msg, 'sync:config:reset-delta:response', {
        success: true,
        id: parsed.id,
        cleared,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id} cleared=${cleared}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'sync:config:reset-delta', 'sync:error', msg, err);
    }
  }

  /**
   * Where a delta run keeps its watermarks: beside the saved configuration of
   * the same id, and nowhere for one that is not saved.
   */
  private deltaStoreFor(): SyncDeltaStore {
    return this.syncConfigStore.deltaStore();
  }

  /**
   * Where a run keeps the files it copied: beside the saved configuration of
   * the same id, and nowhere for one that is not saved, which copies none.
   */
  private fileStoreFor(): SyncFileStore {
    return this.syncConfigStore.fileStore();
  }

  /**
   * Where a run of a saved configuration keeps which record of the target
   * each source record it wrote became, and reads what earlier runs wrote:
   * on disk beside what every run created (`SyncIdMap`), for a saved
   * configuration alone. Nowhere in a window that keeps no run's creations.
   */
  private idMapFor(): SyncIdMapStore | undefined {
    const creations = this.runCreations;
    if (!creations) return undefined;
    return savedConfigIdMap(creations.idMap(), (configId) =>
      this.syncConfigStore.isSaved(configId),
    );
  }

  /**
   * Record a finished run — succeeded, partial, or failed with whatever it
   * wrote before it failed — in the audit trail and the lineage.
   *
   * A run the user cancelled is recorded as cancelled once it wrote a record,
   * carried a deletion or had one refused, its counts saying which; stopped,
   * under the code of a run cancelled before it wrote, when it had done none.
   * It was recorded as partial, or failed, as a run the org cut short is.
   */
  private recordRun(
    config: SyncConfig,
    operationId: string,
    result: SyncExecutionResult,
    guardDecision: GuardDecision | undefined,
    triggeredBy: SyncHistoryEntry['triggeredBy'],
    emails?: RunEmailsSaid,
  ): void {
    const objects = syncAuditObjects(result.objectResults ?? []);
    const touched = objects.some(
      (o) => o.created + o.updated + o.deleted + o.failed + (o.upserted ?? 0) > 0,
    );
    const outcome: AuditOutcome =
      result.cancelled === true ? (touched ? 'cancelled' : 'stopped') : result.status;
    recordWriteRun(this.deps, {
      action: 'sync_execute',
      module: 'sync',
      operationId,
      orgId: config.targetOrgId,
      outcome,
      ...(outcome === 'stopped' ? { code: RUN_CANCELLED } : {}),
      guard: guardDecision,
      objects,
      source: { origin: 'org', orgId: config.sourceOrgId },
      // What started it: the page, a re-run, a schedule or a pipeline; and
      // whether the target delivered the emails of what still ran.
      details: { triggeredBy, ...runEmailsDetailsOf(emails) },
      ...(result.mutedAutomation ? { muted: auditMutedOf(result.mutedAutomation) } : {}),
      // The checkpoint it took first and kept: what a rewind to before it goes to.
      ...(result.checkpoint?.state === 'taken'
        ? { checkpointId: result.checkpoint.checkpointId }
        : {}),
    });
  }

  /** Record a run refused before the guard could judge it, by the code of the refusal. */
  private recordRefused(operationId: string, targetOrgId: string, code: string): void {
    recordWriteRun(this.deps, {
      action: 'sync_execute',
      module: 'sync',
      operationId,
      orgId: targetOrgId,
      outcome: 'stopped',
      code,
    });
  }

  /** Record a run Production Guard stopped before it wrote anything. */
  private recordStopped(operationId: string, targetOrgId: string, decision: GuardDecision): void {
    recordWriteRun(this.deps, {
      action: 'sync_execute',
      module: 'sync',
      operationId,
      orgId: targetOrgId,
      outcome: 'stopped',
      guard: decision,
    });
  }

  /** The Production Guard request a run of `config` is judged by: see {@link syncGuardRequest}. */
  private buildGuardRequest(config: SyncConfig): OperationRequest {
    return syncGuardRequest(config, this.deps.orgManager.getOrg(config.targetOrgId));
  }

  /**
   * Refuse the run before anything is written when a field it copies cannot
   * hold the value it is given.
   *
   * Both orgs are described per object and every field the write sends
   * verbatim is compared: the mapped pairs, and the same-named fields of every
   * field that goes as read — all of them when the object has no mapping. A
   * field the object excludes, or a mapping takes elsewhere, is not sent. A
   * mapping whose value a transform rewrites is not judged on its
   * source type, and target fields nobody can write are left to the org.
   * Without this, a text field mapped onto a date field was only discovered
   * record by record by Salesforce, after the run had started writing.
   *
   * @throws {Error} Naming every mismatched pair, when at least one is found.
   */
  private async assertFieldTypesMatch(
    config: SyncConfig,
    sourceConn: Awaited<ReturnType<typeof getJsforceConnection>>,
    targetConn: Awaited<ReturnType<typeof getJsforceConnection>>,
    describeTimeoutMs: number,
  ): Promise<void> {
    const validator = new FieldTypeValidator();
    const mismatches: string[] = [];
    const toDescriptor = (f: DescribedField): FieldDescriptor => ({
      apiName: f.name,
      type: f.type,
    });

    for (const object of config.objects) {
      // A delete writes no field value.
      if (object.operation === 'delete') continue;
      const name = object.objectApiName;
      const timeout = new TimeoutManager(describeTimeoutMs);
      // Cached per org and object: a Quick Sync has just described the same
      // objects on the same orgs to build its mapping, and each describe here
      // carries its own timeout — describing twice doubled the chances of
      // running out of one and ending the run before it wrote anything.
      const [sourceDesc, targetDesc] = await Promise.all([
        timeout.withTimeout(`describe-source-${name}`, () =>
          describeCached(config.sourceOrgId, name, () => sourceConn.describe(name)),
        ),
        timeout.withTimeout(`describe-target-${name}`, () =>
          describeCached(config.targetOrgId, name, () => targetConn.describe(name)),
        ),
      ]);
      const sourceFields = parseDescribedFields(sourceDesc, name, 'source').map(toDescriptor);
      const targetFields = parseDescribedFields(targetDesc, name, 'target')
        .filter((f) => f.createable || f.updateable)
        .map(toDescriptor);

      // A mapping renames its field and every other goes as read, under its
      // own name (`mapFields`): those are compared by name, as they all were
      // when the object had no mapping. Compared as mapped pairs alone, the
      // fields an object with one rename sent as read went unjudged.
      const notAsRead = notSentAsRead(object.fieldMappings, object.excludedFields);
      const pairs: Array<Record<string, string>> = [
        Object.fromEntries(
          sourceFields
            .filter((f) => !notAsRead.has(f.apiName.toLowerCase()))
            .map((f) => [f.apiName, f.apiName]),
        ),
        ...object.fieldMappings
          .filter((m) => VERBATIM_MAPPING_TYPES.has(m.type))
          .map((m) => ({ [m.sourceField]: m.targetField })),
      ];

      for (const mapping of pairs) {
        for (const e of validator.validateMapping(sourceFields, targetFields, mapping).errors) {
          mismatches.push(
            `${name}.${e.sourceField} (${e.sourceType}) -> ${name}.${e.targetField} (${e.targetType})`,
          );
        }
      }
    }

    if (mismatches.length === 0) return;
    const named = mismatches.slice(0, MAX_REPORTED_FIELD_MISMATCHES).join('; ');
    const more =
      mismatches.length > MAX_REPORTED_FIELD_MISMATCHES
        ? ` and ${mismatches.length - MAX_REPORTED_FIELD_MISMATCHES} more`
        : '';
    throw new Error(
      `Field types do not match between the orgs, so the sync was not started and nothing ` +
        `was written: ${named}${more}. Map each field onto a field of a compatible type, or ` +
        `convert the value with a transform.`,
    );
  }

  private async handleDescribeGlobal(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(syncDescribeGlobalPayloadSchema, msg, 'sync:error', this.deps);
    if (!parsed) return;
    const config = robustnessConfigOf(this.deps);

    try {
      const conn = await getJsforceConnection(
        parsed.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );

      const timeout = new TimeoutManager(config.timeouts.describeGlobal);
      const result = await timeout.withTimeout('describe-global', () => conn.describeGlobal());
      checkApiLimits(conn.limitInfo, 'sync:describe-global');

      // The objects no copy writes are left out — files, users, metadata,
      // history, sharing and the platform's own records — and the bridge
      // refuses a config naming one: the list Forge and Autopilot read.
      const copyable = result.sobjects.filter(
        (s: { name: string; queryable: boolean }) => s.queryable && !syncCannotCopy(s.name),
      );
      let objects: string[];
      const unwritable: Array<{ objectApiName: string; why: 'notInTarget' | 'notCreateable' }> = [];
      if (parsed.targetOrgId === undefined) {
        objects = copyable
          .filter((s: { createable: boolean }) => s.createable)
          .map((s: { name: string }) => s.name);
      } else {
        // Asked with the target, what the user may create is read where the
        // run writes. Read from the source alone, the list held only what the
        // source's user may create — reading needs no Create — and a
        // read-only source user got an empty picker, "No objects configured".
        const targetConn = await getJsforceConnection(
          parsed.targetOrgId,
          this.deps.orgRegistry,
          this.deps.orgManager,
        );
        const target = await timeout.withTimeout('describe-global', () =>
          targetConn.describeGlobal(),
        );
        checkApiLimits(targetConn.limitInfo, 'sync:describe-global target');
        const inTarget = new Map<string, { createable: boolean; updateable: boolean }>(
          target.sobjects.map((t: { name: string; createable: boolean; updateable: boolean }) => [
            t.name,
            { createable: t.createable, updateable: t.updateable },
          ]),
        );
        objects = [];
        for (const s of copyable as Array<{ name: string; createable: boolean }>) {
          const there = inTarget.get(s.name);
          if (there && (there.createable || there.updateable)) {
            objects.push(s.name);
            continue;
          }
          // An object neither org's user may create is one no copy writes, as
          // the platform's own records are: left out as before. One the
          // source's user may create is shown, with why it cannot be picked.
          if (!s.createable) continue;
          unwritable.push({ objectApiName: s.name, why: there ? 'notCreateable' : 'notInTarget' });
        }
      }

      const response = buildResponse(this.deps, msg, 'sync:describe-global:response', {
        objects,
        ...(unwritable.length > 0 ? { unwritable } : {}),
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'sync:describe-global', 'sync:error', msg, err);
    }
  }

  private async handleDescribeFields(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(syncDescribeFieldsPayloadSchema, msg, 'sync:error', this.deps);
    if (!parsed) return;
    const payload = parsed;
    const config = robustnessConfigOf(this.deps);

    try {
      const sourceConn = await getJsforceConnection(
        payload.sourceOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const targetConn = await getJsforceConnection(
        payload.targetOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );

      const timeout = new TimeoutManager(config.timeouts.describe);
      const [sourceDesc, targetDesc] = await Promise.all([
        timeout.withTimeout('describe-source', () => sourceConn.describe(payload.objectApiName)),
        timeout.withTimeout('describe-target', () => targetConn.describe(payload.objectApiName)),
      ]);
      checkApiLimits(sourceConn.limitInfo, `sync:describe-fields source ${payload.objectApiName}`);
      checkApiLimits(targetConn.limitInfo, `sync:describe-fields target ${payload.objectApiName}`);

      const mapFields = (
        fields: Array<{ name: string; label: string; type: string; createable: boolean }>,
      ) =>
        fields
          .filter((f) => f.createable)
          .map((f) => ({ apiName: f.name, label: f.label, type: f.type }));

      const response = buildResponse(this.deps, msg, 'sync:describe-fields:response', {
        objectApiName: payload.objectApiName,
        sourceFields: mapFields(
          sourceDesc.fields as Array<{
            name: string;
            label: string;
            type: string;
            createable: boolean;
          }>,
        ),
        targetFields: mapFields(
          targetDesc.fields as Array<{
            name: string;
            label: string;
            type: string;
            createable: boolean;
          }>,
        ),
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'sync:describe-fields', 'sync:error', msg, err);
    }
  }

  /**
   * `sync:write-order`: the order a run of this configuration writes its
   * objects in, as the run computes it before its first write
   * (`syncWriteOrder`), from the target's describe of each object — the
   * describes the run reads again, cached. What Review shows before anything
   * runs: a run used to write the objects in the order they were added.
   */
  private async handleWriteOrder(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(syncSimulatePayloadSchema, msg, 'sync:error', this.deps);
    if (!parsed) return;
    const config = parsed.config as unknown as SyncConfig;
    try {
      const targetConn = await getJsforceConnection(
        config.targetOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const timeoutMs = robustnessConfigOf(this.deps).timeouts.describe;
      const lookups = new Map<string, WriteLookup[]>();
      for (const object of config.objects) {
        if (object.operation === 'delete') continue;
        const name = object.objectApiName;
        try {
          const described = await new TimeoutManager(timeoutMs).withTimeout(
            `describe-target-${name}`,
            () => describeCached(config.targetOrgId, name, () => targetConn.describe(name)),
          );
          lookups.set(name, lookupsOf(object, targetWriteFieldsOf(described)));
        } catch {
          // Ordered without its lookups, as the run orders it: its write
          // describes it again, and says why it cannot.
        }
      }
      const { order } = orderSyncObjects(config.objects, lookups);
      // And what Review warns of: the encrypted fields a run leaves out.
      const encrypted = await this.encryptedMaskedOf(config, timeoutMs).catch(() => []);
      const response = buildResponse(this.deps, msg, 'sync:write-order:response', {
        order,
        ...(encrypted.length > 0 ? { encrypted } : {}),
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'sync:write-order', 'sync:error', msg, err);
    }
  }

  /**
   * Per object a run of `config` writes, the classic encrypted fields the user
   * the source is read as reads masked, which the run leaves out
   * (`SyncOrchestratorDeps.maskedSourceFields`): its View Encrypted Data asked
   * once, each object's describe the cached one. Review said nothing of
   * them, and the run copied the masks.
   */
  private async encryptedMaskedOf(
    config: SyncConfig,
    timeoutMs: number,
  ): Promise<SyncEncryptedFieldsMasked[]> {
    const objects = config.objects.filter((object) => object.operation !== 'delete');
    if (objects.length === 0) return [];
    const sourceConn = await getJsforceConnection(
      config.sourceOrgId,
      this.deps.orgRegistry,
      this.deps.orgManager,
    );
    const masked = maskedEncryptedFields(
      viewsEncryptedDataOnce(
        async (soql) => (await sourceConn.query<Record<string, unknown>>(soql)).records,
      ),
      (name) =>
        new TimeoutManager(timeoutMs).withTimeout(`describe-source-${name}`, () =>
          describeCached(config.sourceOrgId, name, () => sourceConn.describe(name)),
        ),
    );
    const out: SyncEncryptedFieldsMasked[] = [];
    for (const object of objects) {
      const fields = await masked(object.objectApiName);
      if (fields.length > 0) out.push({ objectApiName: object.objectApiName, fields });
    }
    return out;
  }

  private async handleExecute(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(syncExecutePayloadSchema, msg, 'sync:error', this.deps);
    if (!parsed) return;
    if (this.refusedFieldless(msg, parsed.config, 'sync:execute', 'sync:error', NOTHING_DONE)) {
      return;
    }
    await this.startExecution(
      msg,
      parsed.config,
      'manual',
      parsed.muteAutomation === true,
      parsed.checkpointFirst,
    );
  }

  /**
   * `sync:simulate`: what a run of this configuration would do, object by
   * object, with nothing written.
   *
   * Checked at the boundary exactly as a run is, then read and compared by the
   * same engine — the field types of both orgs, each object's read, its
   * mappings, transforms and add-ons, the rows left to the platform and, on a
   * bidirectional run, its conflicts. No guard is consulted and nothing is
   * written to the audit trail or the history: the writer the engine is given
   * refuses every write. It is listed in Live Operations like a run, so its
   * Cancel — and the Sync page's — stop it before its next object.
   */
  private async handleSimulate(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(syncSimulatePayloadSchema, msg, 'sync:error', this.deps);
    if (!parsed) return;
    if (this.refusedFieldless(msg, parsed.config, 'sync:simulate', 'sync:error', NOTHING_READ)) {
      return;
    }
    const operationId = msg.id;
    const config = parsed.config as unknown as SyncConfig;
    const description = `Simulation of a sync of ${config.objects.length} object(s), writing nothing`;
    const abortController = new AbortController();
    sendOperationStarted(this.deps, operationId, 'sync', description);
    this.liveTracker?.register(operationId, 'sync', description);

    const simulation = this.simulateSync(
      msg,
      config,
      operationId,
      abortController,
      parsed.checkpointFirst,
    );
    if (this.registry) {
      // The registry reads a `failure` status as a failed operation; a
      // simulation that stopped on an error is one.
      const outcome = simulation.then((result) => ({
        status: result === null || result.error ? 'failure' : 'success',
      }));
      this.registry.register(operationId, 'sync', description, outcome, abortController);
    } else {
      await simulation;
    }
  }

  /**
   * Run a simulation in the background and answer it on
   * `sync:simulate:response`; `null` when it could not start, which is said on
   * `sync:error`.
   *
   * @param checkpointFirst - The checkpoint a run would take first: what it
   *   would hold and cost, and the refusal a real run would meet, said and
   *   counted with the run's requests; nothing is taken.
   */
  private async simulateSync(
    msg: InboundRequest,
    config: SyncConfig,
    operationId: string,
    abortController: AbortController,
    checkpointFirst?: RunCheckpointRequest,
  ): Promise<SyncSimulationResult | null> {
    const robustnessConfig = robustnessConfigOf(this.deps);
    const failure: OperationFailureContext = {
      module: 'sync',
      operation: msg.type,
      ...objectsFailureContext(config.objects),
    };
    try {
      const readers = await this.readersFor(config, abortController.signal);
      const { DataSync } = await import('../../modules/sync/DataSync.js');
      const { ConflictResolver } = await import('../../modules/sync/ConflictResolver.js');
      const { FieldMappingService } = await import('../../modules/sync/FieldMapping.js');
      const { TransformPipeline } = await import('../../modules/sync/TransformPipeline.js');
      const { toolingQueriesOver, toolingValidationRules } =
        await import('../../modules/forge/TargetGapReader.js');
      const { toolingRetrievesOver } =
        await import('../../modules/forge/TargetAutomationReader.js');
      const tooling = readers.targetConn.tooling;

      // A simulation writes nothing, and its writer says so to anything that
      // tries: the engine never hands it a record, and if it ever did the
      // simulation would stop on this error rather than write.
      const refuse = async (): Promise<never> => {
        throw new Error('A simulation writes nothing: the write it reached was refused.');
      };
      const dataSync = new DataSync({
        insert: refuse,
        update: refuse,
        upsert: refuse,
        delete: refuse,
        describeTargetFields: readers.describeTargetFields,
      });
      if (!this.deps.services) {
        throw new Error(
          'SyncOpsHandler: composition-root services not injected. Wire ExtensionHandlersDeps.services in extension.ts.',
        );
      }
      // The checkpoint a run would take first, scoped as the run's gate
      // scopes it: never taken, since a simulation's gate only measures.
      const checkpoint = checkpointFirst
        ? this.runCheckpointOf(config, operationId, checkpointFirst)
        : undefined;
      const orchestrator = this.deps.services.syncOrchestrator({
        dataSync,
        conflictResolver: new ConflictResolver(),
        fieldMapping: new FieldMappingService(),
        transformPipeline: new TransformPipeline(),
        querySource: readers.querySource,
        maskedSourceFields: readers.maskedSourceFields,
        queryTarget: readers.queryTarget,
        services: this.deps.services,
        signal: abortController.signal,
        findInTarget: readers.findInTarget,
        describeTargetFields: readers.describeTargetFields,
        // What the run leaves as earlier runs copied it, found as the run
        // finds it; and what it writes, counted and measured as its gate
        // measures it, asking nobody.
        readSourceIds: readers.readSourceIds,
        countSource: readers.countSource,
        countPersonAccounts: readers.countPersonAccounts,
        writeGate: this.writeGateFor(
          config,
          readers.targetConn,
          'ask',
          undefined,
          checkpoint?.gate,
        ),
        // What reads back the record types the target gave, as the run reads
        // them: never called by a simulation, its requests counted as the
        // run's gate counts them.
        queryTargetRows: readers.queryTargetRows,
        // Mapped as the run maps them.
        recordTypes: readers.recordTypes,
        // A currency the target does not hold active replaced, and the
        // amounts converted, as the run does it.
        currencies: readers.currencies,
        // The standard price book matched, as the run matches it.
        standardPricebooks: readers.standardPricebooks,
        // Read as the run reads them; a simulation records no watermark.
        deltaStore: this.deltaStoreFor(),
        deltaReads: readers.deltaReads,
        // What earlier runs of the configuration wrote, read as the run reads
        // it, so a lookup at one of their copies is told as the run sends it.
        idMap: this.idMapFor(),
        // The files a run would copy, found and measured as the run finds
        // them; none is read or written, and nothing is recorded.
        files: readers.files,
        // What it cannot evaluate, listed beside what it predicts: the
        // target's validation rules, read as Forge's pre-flight reads them,
        // each with the field it shows its error on by its API name, read
        // back from the label a French org answers, as Frozen's preview does;
        // and each formula, so an insert's caveat leaves out the rules that
        // refuse only a change of a record.
        readValidationRules: toolingValidationRules(
          async (soql) =>
            (
              await queryAllPages<Record<string, unknown>>(
                {
                  query: async (q) => tooling.query<Record<string, unknown>>(q),
                  queryMore: async (url) => tooling.queryMore<Record<string, unknown>>(url),
                },
                soql,
              )
            ).records,
          toolingQueriesOver(readers.targetConn),
          toolingRetrievesOver(readers.targetConn),
        ),
        onSimulationProgress: (done, total, objectApiName) => {
          const pct = Math.round((done / total) * 100);
          const label = `Simulating ${objectApiName}`;
          sendOperationProgress(this.deps, operationId, pct, done, total, label);
          this.liveTracker?.updateProgress(operationId, pct, done, total, label);
        },
      });

      await this.assertFieldTypesMatch(
        config,
        readers.sourceConn,
        readers.targetConn,
        robustnessConfig.timeouts.describe,
      );

      const simulated = await orchestrator.simulate(config);
      const planned = checkpoint?.planned();
      const result: SyncSimulationResult = {
        ...simulated,
        ...(planned ? { checkpoint: planned } : {}),
        operationId,
      };
      if (result.cancelled) {
        this.endCancelled(operationId);
      } else if (result.error) {
        this.liveTracker?.fail(operationId, result.error);
        sendOperationFailed(this.deps, operationId, result.error, true, { context: failure });
      } else {
        sendOperationProgress(this.deps, operationId, 100, 1, 1, 'Simulation complete');
        sendOperationCompleted(this.deps, operationId, { status: 'success', simulated: true });
        this.liveTracker?.complete(operationId);
      }
      this.deps.log(
        `[sync] simulation ${operationId} ${result.cancelled ? 'stopped' : 'finished'}: ` +
          result.objects
            .map(
              (o) =>
                `${o.objectApiName} insert=${o.insert} update=${o.update} delete=${o.delete} ` +
                `skipped=${o.skipped} refused=${o.refused} conflicts=${o.conflicts}`,
            )
            .join('; '),
      );
      const response = buildResponse(
        this.deps,
        msg,
        'sync:simulate:response',
        result as unknown as Record<string, unknown>,
      );
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
      return result;
    } catch (err: unknown) {
      this.liveTracker?.fail(operationId, extractErrorMessage(err));
      sendHandlerError(this.deps, 'sync:simulate', 'sync:error', msg, err);
      sendOperationFailed(this.deps, operationId, extractErrorMessage(err), true, {
        context: failure,
      });
      return null;
    }
  }

  /**
   * `sync:pause` / `sync:resume`: hold a running sync before its next object
   * or batch, or let it go on. Answered with whether the run is now paused,
   * or why nothing was done: a run that has finished, or one this window
   * never started, has no pause to set.
   */
  private async handleRunControl(msg: InboundRequest, action: 'pause' | 'resume'): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(syncRunControlPayloadSchema, msg, 'sync:error', this.deps);
    if (!parsed) return;
    const { operationId } = parsed;
    const responseType = action === 'pause' ? 'sync:pause:response' : 'sync:resume:response';
    const gate = this.pauseGates.get(operationId);
    let answer: SyncRunControlAnswer;
    if (!gate) {
      answer = {
        success: false,
        operationId,
        paused: false,
        error: 'No sync with this id is running: it has finished, or it was not started here.',
      };
    } else {
      if (action === 'pause') {
        gate.pause();
        this.liveTracker?.pause(operationId);
      } else {
        gate.resume();
        this.liveTracker?.resume(operationId);
      }
      answer = { success: true, operationId, paused: gate.isPaused };
    }
    const response = buildResponse(
      this.deps,
      msg,
      responseType,
      answer as unknown as Record<string, unknown>,
    );
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ${response.type} id=${response.id} paused=${answer.paused}`);
  }

  /**
   * What a run and a simulation of it read both orgs with: the two
   * connections, the source and target reads, the source count Grappe's
   * threshold is measured on, the target's describe of what a write may
   * carry, and the target lookup a simulation asks in place of a write.
   *
   * @param signal - The run's cancel, which stops a simulation's lookups.
   */
  private async readersFor(config: SyncConfig, signal: AbortSignal): Promise<SyncReaders> {
    const robustnessConfig = robustnessConfigOf(this.deps);
    const sourceConn = await getJsforceConnection(
      config.sourceOrgId,
      this.deps.orgRegistry,
      this.deps.orgManager,
    );
    const targetConn = await getJsforceConnection(
      config.targetOrgId,
      this.deps.orgRegistry,
      this.deps.orgManager,
    );

    /**
     * Query limits, resolved PER ORG.
     *
     * This used to resolve the tier from the source alone and hand the same
     * closure to both reads. Harmless while every read carried a LIMIT; the
     * moment the cap became conditional it inverted the protection it exists
     * for — on a sandbox -> production sync the source is a sandbox, so the
     * production TARGET was read with no cap at all, against the very org
     * whose API budget the cap protects.
     */
    const limitsFor = (
      orgId: string,
    ): { tier: ReturnType<typeof resolveOrgTier>; limits: ReturnType<typeof getQueryLimits> } => {
      const org = this.deps.orgManager.getOrg(orgId);
      const tier = resolveOrgTier(org?.orgType === 'Sandbox' || org?.orgType === 'Scratch');
      return { tier, limits: getQueryLimits(tier) };
    };

    // Build query functions with retry wrapping and dynamic limits
    const queryRetryOp = new RetryableOperation({ retryConfig: robustnessConfig.retry });
    const buildQueryFn =
      (conn: typeof sourceConn, orgId: string) =>
      async (
        _orgId: string,
        objectConfig: import('@sandforge/shared').SyncObjectConfig,
        read?: SourceRead,
      ): Promise<Record<string, unknown>[]> => {
        const safeObj = sanitizeSoqlObjectName(objectConfig.objectApiName);
        // What follows the field list: the filter, the order, the cap.
        let tail = '';
        // The boundary refuses a WHERE that does more than filter; checked
        // again here because this is where it becomes query text, and a
        // `LIMIT 1` riding on the filter would cut the read short while the
        // run still reported itself complete. A delta read adds its bound
        // before it, and keeps the filter whole in parentheses.
        const where = sourceReadWhere(objectConfig.where, read?.changedSince);
        if (where) {
          tail += ` WHERE ${where}`;
        }
        // An SFDMU export carries its read order, and the importer keeps it.
        // The boundary refuses anything but field names, ASC/DESC and NULLS
        // FIRST/LAST; checked again here because this is where it becomes
        // query text — an ORDER BY ends the statement, so whatever followed
        // it would run.
        if (objectConfig.orderBy) {
          tail += ` ORDER BY ${assertSoqlOrderBy(objectConfig.orderBy)}`;
        }
        // This query used to end in a bare
        // `LIMIT ${syncQueryLimits.defaultQueryLimit}` and read the first
        // page only — 2 000 rows from a sandbox source, 500 from a
        // production one. On the 100 000-record orgs this product targets
        // that copies 2 % of the object and reports a completed sync.
        //
        // Two changes, and only these two:
        //  - the read follows the cursor to the end (`queryAllPages`, the
        //    same bounded helper Forge uses);
        //  - when a bound cuts the read short the user is told, on the
        //    notification channel and in the log. A bounded sync is a
        //    legitimate outcome; a silently partial one is the defect.
        //
        // The production cap stays. `queryLimits` keeps a production source
        // conservative on purpose — a sandbox refresh must not spend a
        // business org's daily API budget — so a production-tier run is
        // still capped server-side at `defaultQueryLimit` and now announces
        // the cut instead of hiding it. Sandbox and scratch sources, where
        // the 100 000-row clone actually happens, read every page up to
        // FORGE_QUERY_MAX_RECORDS / FORGE_QUERY_MAX_PAGES.
        const { tier, limits } = limitsFor(orgId);
        if (tier === 'production') {
          tail += ` LIMIT ${limits.defaultQueryLimit}`;
        }
        let boundCutTheRead = false;
        const retryResult = await queryRetryOp.execute(async () => {
          boundCutTheRead = false;
          // The fields are named from the describe. Asked `FIELDS(ALL)`,
          // which Salesforce answers only under a LIMIT of 200 at most, the
          // org refused this read every time — a request per object — and
          // the fallback named the fields all the same: in one statement,
          // which an object of hundreds of fields made too long for its URL
          // (414 or 431), and which on a production-tier source it cut to 200 rows
          // under `FIELDS(ALL)` again, with no word of it. Too long for one
          // query, the fields are read in column groups (`readColumnsApart`),
          // the first with the filter, the order and the cap; the others by
          // the ids it returned.
          const described = (await conn.describe(safeObj)).fields.map((field) => field.name);
          const fields = described.length > 0 ? described : ['Id'];
          const pages = {
            // jsforce hands back a thenable `Query`, not a Promise.
            query: async (q: string) => conn.query<Record<string, unknown>>(q),
            queryMore: async (url: string) => conn.queryMore<Record<string, unknown>>(url),
          };
          return readColumnsApart(
            `SELECT ${fields.join(', ')} FROM ${safeObj}${tail}`,
            async (statement) => {
              const paged = await queryAllPages<Record<string, unknown>>(pages, statement);
              boundCutTheRead ||= paged.truncated;
              return paged.records;
            },
          );
        });
        if (!retryResult.success) {
          throw retryResult.error ?? new Error('Query failed after retries');
        }
        checkApiLimits(conn.limitInfo, `sync:execute query ${safeObj}`);
        const records = retryResult.result ?? [];
        const tierCapReached = tier === 'production' && records.length >= limits.defaultQueryLimit;
        if (boundCutTheRead || tierCapReached) {
          // A delta configuration keeps the object's watermark where it was:
          // what the bound left unread is read by the next run.
          read?.onBoundReached?.();
          const bound = tierCapReached
            ? `${limits.defaultQueryLimit} records (production-tier query cap)`
            : `${FORGE_QUERY_MAX_RECORDS} records / ${FORGE_QUERY_MAX_PAGES} pages`;
          // The same closure reads both orgs, and a short read means
          // different things on each: on the source it means part of the
          // object is not copied, on the target it means conflict detection
          // ran against part of the destination — a record the target holds
          // past the bound is never compared. Saying "the sync copies this
          // subset" on the target read would be the wrong warning.
          const side = orgId === config.sourceOrgId ? 'source' : 'target';
          const consequence =
            side === 'source'
              ? 'this sync copies a subset, not the whole object'
              : 'conflict detection ran against a subset of the destination';
          this.deps.log(
            `[WARN] sync:execute ${safeObj} (${side}): read stopped at ${records.length} ` +
              `record(s) — bound: ${bound}. ${consequence}.`,
          );
          sendNotification(
            this.deps,
            'warning',
            'Sync',
            `${safeObj}: only ${records.length} record(s) were read from the ${side} ` +
              `(bound: ${bound}) — ${consequence}. ` +
              `Narrow it with a WHERE filter, or split the run.`,
          );
        }
        return records;
      };

    // What the Grappe threshold is measured against: the rows the read above
    // would return, counted with the same filter before the run writes. The
    // read stops at a bound — the query limit on a production source,
    // FORGE_QUERY_MAX_RECORDS elsewhere — so the count stops there too, and a
    // run is never reported past the rows it will actually read.
    const countSource = async (
      orgId: string,
      objectConfig: import('@sandforge/shared').SyncObjectConfig,
      read?: SourceRead,
    ): Promise<number> => {
      const safeObj = sanitizeSoqlObjectName(objectConfig.objectApiName);
      let soql = `SELECT COUNT() FROM ${safeObj}`;
      const where = sourceReadWhere(objectConfig.where, read?.changedSince);
      if (where) {
        soql += ` WHERE ${where}`;
      }
      const { totalSize } = await sourceConn.query(soql);
      const { tier, limits } = limitsFor(orgId);
      return Math.min(
        totalSize,
        tier === 'production' ? limits.defaultQueryLimit : FORGE_QUERY_MAX_RECORDS,
      );
    };
    // Of an account's or a contact's records under the filter, the person
    // accounts': an org without them has no such field, and holds none.
    const countPersonAccounts = async (
      objectConfig: import('@sandforge/shared').SyncObjectConfig,
      read?: SourceRead,
    ): Promise<number> => {
      const safeObj = sanitizeSoqlObjectName(objectConfig.objectApiName);
      const where = sourceReadWhere(objectConfig.where, read?.changedSince);
      const soql =
        `SELECT COUNT() FROM ${safeObj} WHERE IsPersonAccount = true` +
        (where ? ` AND (${where})` : '');
      try {
        return (await sourceConn.query(soql)).totalSize;
      } catch {
        return 0;
      }
    };

    // One describe of the target per object, kept for the run. Without it a
    // sync with no field mappings sends every field it read — see
    // `DataSyncDeps.describeCreateableFields`. The record types the running
    // user may use are read from the same describe.
    const targetFieldsByObject = new Map<string, TargetWriteFields>();
    const describeTargetFields = async (objectApiName: string): Promise<TargetWriteFields> => {
      const cached = targetFieldsByObject.get(objectApiName);
      if (cached) return cached;
      const described = await targetConn.describe(objectApiName);
      const answer = targetWriteFieldsOf(described);
      targetFieldsByObject.set(objectApiName, answer);
      return answer;
    };
    // Asked of the target again, kept nowhere: once the mute's lease assigned
    // a permission set, which may open record types to the user the run
    // writes as, the describe the run holds no longer says which the target
    // gives a record sent without one. A fresh describe is up to date at once.
    const describeTargetFieldsAgain = async (objectApiName: string): Promise<TargetWriteFields> =>
      targetWriteFieldsOf(await targetConn.describe(objectApiName));
    const queryTargetRows = async (soql: string): Promise<Array<Record<string, unknown>>> =>
      (
        await queryAllPages<Record<string, unknown>>(
          {
            query: async (q) => targetConn.query<Record<string, unknown>>(q),
            queryMore: async (url) => targetConn.queryMore<Record<string, unknown>>(url),
          },
          soql,
        )
      ).records;

    // What a simulation asks the target in place of the write: see
    // `targetLookup`.
    const lookup = targetLookup(
      {
        query: async (q) => targetConn.query<Record<string, unknown>>(q),
        queryMore: async (url) => targetConn.queryMore<Record<string, unknown>>(url),
      },
      signal,
    );
    const findInTarget: OrchestratorFindFn = async (orgId, objectConfig, keyField, keys) => {
      const held = await lookup(orgId, objectConfig, keyField, keys);
      checkApiLimits(targetConn.limitInfo, `sync:simulate lookup ${objectConfig.objectApiName}`);
      return held;
    };

    // The source's latest stamp, its recycle bin and the keys both orgs hold:
    // what a delta configuration reads beside the run's own reads.
    const deltaReads = orgDeltaReads(
      {
        query: async (q, options) => sourceConn.query<Record<string, unknown>>(q, options),
        queryMore: async (url) => sourceConn.queryMore<Record<string, unknown>>(url),
      },
      {
        query: async (q) => targetConn.query<Record<string, unknown>>(q),
        queryMore: async (url) => targetConn.queryMore<Record<string, unknown>>(url),
      },
      signal,
    );

    // What a configuration that copies files reads and writes beside its
    // records: the requests Forge's file copy sends, over both connections.
    const fileOrg = (conn: typeof sourceConn): FileCopyOrg => ({
      pages: {
        query: async (q) => conn.query<Record<string, unknown>>(q),
        queryMore: async (url) => conn.queryMore<Record<string, unknown>>(url),
      },
      transport: conn,
      // The links of a copied file, written as every record write is: no
      // duplicate rule or assignment rule decides them.
      create: async (objectApiName, records) =>
        conn.sobject(objectApiName).create(records, { headers: recordWriteHeaders() }),
    });
    // The ids the object's read returns, asked for alone: the same filter,
    // order and bounds as `buildQueryFn`, and on a delta read the same bound.
    const sourceIds = async (
      objectConfig: import('@sandforge/shared').SyncObjectConfig,
      changedSince?: string,
    ): Promise<string[]> => {
      const safeObj = sanitizeSoqlObjectName(objectConfig.objectApiName);
      let soql = `SELECT Id FROM ${safeObj}`;
      const where = sourceReadWhere(objectConfig.where, changedSince);
      if (where) soql += ` WHERE ${where}`;
      if (objectConfig.orderBy) soql += ` ORDER BY ${assertSoqlOrderBy(objectConfig.orderBy)}`;
      const { tier, limits } = limitsFor(config.sourceOrgId);
      if (tier === 'production') soql += ` LIMIT ${limits.defaultQueryLimit}`;
      const { records } = await queryAllPages(fileOrg(sourceConn).pages, soql);
      return records.flatMap((row) => (typeof row.Id === 'string' ? [row.Id] : []));
    };
    const files: SyncFileDeps = {
      copy: orgFileCopyDeps({
        [config.sourceOrgId]: fileOrg(sourceConn),
        [config.targetOrgId]: fileOrg(targetConn),
      }),
      sourceIds,
      store: this.fileStoreFor(),
      // The earlier copy of an attachment the source changed, deleted once
      // the new copy is written: in one call, as a record delete is. Only
      // where Production Guard would allow a delete in the target.
      ...(config.files !== undefined &&
      targetAllowsDeletes(
        this.deps.infraServices?.productionGuard,
        config.targetOrgId,
        this.deps.orgManager.getOrg(config.targetOrgId),
      )
        ? {
            deleteFromTarget: async (objectApiName: string, ids: string[]) =>
              toSaveOutcomes(
                await targetConn.sobject(objectApiName).destroy(ids),
                objectApiName,
              ).map((outcome) => ({
                id: outcome.id,
                success: outcome.success,
                errors: outcome.errors,
              })),
          }
        : {}),
    };

    // Both orgs' record types, read by the run before its first object: a
    // record's type is mapped to the target's of the same object and API name.
    const recordTypes = async (): Promise<SyncRecordTypes> => {
      const { readSyncRecordTypes } = await import('../../modules/sync/syncRecordTypes.js');
      return readSyncRecordTypes(fileOrg(sourceConn).pages, fileOrg(targetConn).pages);
    };
    // Both orgs' currencies, read by the run before the first object whose
    // rows carry one.
    const currencies = async (): Promise<RunCurrencies | undefined> => {
      const { readRunCurrencies } = await import('../../core/common/recordCurrencies.js');
      return readRunCurrencies(
        async (soql) => (await sourceConn.query<Record<string, unknown>>(soql)).records,
        async (soql) => (await targetConn.query<Record<string, unknown>>(soql)).records,
        {
          source: async (soql) =>
            (await sourceConn.tooling.query<Record<string, unknown>>(soql)).records,
          target: async (soql) =>
            (await targetConn.tooling.query<Record<string, unknown>>(soql)).records,
        },
      );
    };
    // Both orgs' standard price books, read by the run before the first
    // object whose rows name a price book.
    const standardPricebooks = async (): Promise<StandardPricebooks | undefined> => {
      const { readStandardPricebooks } = await import('../../modules/sync/syncPrices.js');
      return readStandardPricebooks(
        async (soql) => (await sourceConn.query<Record<string, unknown>>(soql)).records,
        async (soql) => (await targetConn.query<Record<string, unknown>>(soql)).records,
      );
    };

    // The encrypted fields the source's user reads masked: its permission
    // asked once for the run, each object's describe the cached one.
    const maskedSourceFields = maskedEncryptedFields(
      viewsEncryptedDataOnce(
        async (soql) => (await sourceConn.query<Record<string, unknown>>(soql)).records,
      ),
      (name) => describeCached(config.sourceOrgId, name, () => sourceConn.describe(name)),
    );

    return {
      sourceConn,
      targetConn,
      querySource: buildQueryFn(sourceConn, config.sourceOrgId),
      queryTarget: buildQueryFn(targetConn, config.targetOrgId),
      maskedSourceFields,
      countSource,
      describeTargetFields,
      describeTargetFieldsAgain,
      queryTargetRows,
      recordTypes,
      currencies,
      standardPricebooks,
      findInTarget,
      readSourceIds: (objectConfig) => sourceIds(objectConfig),
      countPersonAccounts,
      deltaReads,
      files,
    };
  }

  /**
   * Re-run a sync from a persisted history config snapshot (`sync:history:rerun`).
   *
   * The snapshot was produced by a previously validated config, but it
   * round-trips through ConfigStore and the webview, so it is re-validated
   * here before execution (defense-in-depth). Validation failures are
   * reported on the `sync:history:error` channel the history store consumes.
   *
   * @param msg - The triggering `sync:history:rerun` message (correlation id source).
   * @param snapshot - The raw config snapshot loaded from SyncHistoryStore.
   */
  async rerunFromSnapshot(msg: InboundRequest, snapshot: unknown): Promise<void> {
    this.deps.log(`[RX] sync:history:rerun id=${msg.id}`);
    const parsed = validatePayload(
      syncExecutePayloadSchema,
      { ...msg, payload: { config: snapshot } },
      'sync:history:error',
      this.deps,
    );
    if (!parsed) return;
    if (
      this.refusedFieldless(
        msg,
        parsed.config,
        'sync:history:rerun',
        'sync:history:error',
        NOTHING_DONE,
      )
    ) {
      return;
    }
    await this.startExecution(msg, parsed.config, 'rerun');
  }

  /**
   * Execute a sync config on behalf of the sync schedule executor
   * (`sync:schedule:*` tick loop, wired via ExtensionHandlers.startSyncScheduler).
   *
   * Unlike the fire-and-forget message path (`sync:execute`), this awaits the
   * full execution and resolves with the orchestrator result so
   * SyncScheduleExecutor can persist `lastRunAt`/`lastResult`. Lifecycle
   * events still flow on the usual `operation:*` channels and the run lands
   * in sync history with its origin as `triggeredBy`.
   *
   * A pipeline's Sync step runs its configuration through here too. Its run
   * was recorded as a schedule's and listed in Live Operations as "Scheduled
   * sync", whoever had started the pipeline: `origin` says which it is, in the
   * history, in Live Operations and in the audit trail.
   *
   * The config round-trips through ConfigStore, so it is re-validated here
   * before execution (same defense-in-depth rule as rerunFromSnapshot) — an
   * invalid config rejects the returned promise instead of posting to an
   * error channel nobody is listening on at tick time.
   *
   * @param config - The schedule's persisted sync config.
   * @param origin - What started the run: a schedule, or a pipeline's Sync step.
   * @returns The orchestrator result (status 'failure' on execution error).
   */
  async executeScheduled(
    config: SyncConfig,
    origin: UnattendedSyncOrigin = 'schedule',
  ): Promise<SyncExecutionResult> {
    const parsed = syncExecutePayloadSchema.safeParse({ config });
    if (!parsed.success) {
      throw new Error(
        `Scheduled sync config failed validation: ${parsed.error.issues
          .map((i) => i.message)
          .join('; ')}`,
      );
    }
    // Before the guard is asked: a run refused anyway needs no one's consent.
    const fieldless = fieldlessTransformRules(parsed.data.config.objects);
    if (fieldless.length > 0) {
      throw Object.assign(new Error(`${fieldlessTransformRefusal(fieldless)} ${NOTHING_DONE}`), {
        code: TRANSFORM_RULE_NO_FIELD,
      });
    }
    // No webview request waits on a scheduled run: its origin is a listed
    // synthetic request, whose id doubles as the operationId on operation:*.
    const msg =
      origin === 'pipeline'
        ? syntheticRequest('sync:pipeline', crypto.randomUUID(), 'sync:execute')
        : syntheticRequest('sync:schedule', crypto.randomUUID(), 'sync:execute');
    const operationId = msg.id;

    // Fill per-object batch sizes from the `sandforge.sync.defaultBatchSize`
    // setting when the stored config omitted them (same rule as startExecution).
    const defaultBatchSize =
      this.deps.services?.getSandforgeSetting?.('sync.defaultBatchSize', 200) ?? 200;
    const filledConfig = {
      ...parsed.data.config,
      objects: parsed.data.config.objects.map((o) => ({
        ...o,
        batchSize: o.batchSize ?? defaultBatchSize,
      })),
    } as unknown as SyncConfig;

    // Production guard on target org — same policy as manual runs. A blocked
    // or declined run rejects so the scheduler marks the schedule as failed,
    // and so does a run with no guard to pass: with the code a manual run's
    // refusal carries, and recorded as a manual run's refusal is.
    const guard = this.deps.infraServices?.productionGuard;
    if (!guard) {
      this.recordRefused(operationId, filledConfig.targetOrgId, PRODUCTION_GUARD_MISSING.code);
      throw productionGuardMissingError();
    }
    const { check, decision } = await consultProductionGuard(
      guard,
      this.buildGuardRequest(filledConfig),
    );
    // What the run carries to the audit trail when it ends.
    const guardDecision = decision;
    if (decision === 'refused' || decision === 'declined') {
      this.recordStopped(operationId, filledConfig.targetOrgId, decision);
    }
    if (decision === 'refused') {
      throw new Error(
        `Operation blocked by Production Guard: ${check.blockedReason ?? check.impactSummary}`,
      );
    }
    if (decision === 'declined') {
      throw new Error(
        `${origin === 'pipeline' ? 'Pipeline' : 'Scheduled'} sync cancelled (confirmation declined).`,
      );
    }

    this.dmlTracker.register(operationId, 'sync', 'upsert', filledConfig.objects?.length ?? 0);
    this.activeOperationIds.add(operationId);
    this.deps.infraServices?.performanceTracker?.start(operationId, 'sync');
    const scheduledDescription = `${origin === 'pipeline' ? 'Pipeline' : 'Scheduled'} sync of ${
      filledConfig.objects?.length ?? 0
    } object(s)`;
    sendOperationStarted(this.deps, operationId, 'sync', scheduledDescription);
    // Feed the Monitor "live operations" panel (total unknown until queries
    // run), where its Pause reaches the run's gate as the Sync page's does.
    this.liveTracker?.register(operationId, 'sync', scheduledDescription, 0, { pausable: true });

    const abortController = new AbortController();
    // executeSync never rejects (it reports on operation:failed and converts
    // the outcome to a failure-status result), so no try/catch is needed here.
    const execution = this.executeSync(
      msg,
      filledConfig,
      operationId,
      abortController,
      origin,
      guardDecision,
    );
    // Registered like a manual run: Live Operations lists this run, and its
    // Cancel (`execution:abort`) finds a run through the registry only.
    this.registry?.register(operationId, 'sync', scheduledDescription, execution, abortController);
    return execution;
  }

  /**
   * Shared execution entry point for `sync:execute` and `sync:history:rerun`:
   * fills per-object batch sizes, runs the production guard, registers the
   * operation, and dispatches the detached execution.
   *
   * @param msg - Triggering bridge message (correlation + operation id source).
   * @param rawConfig - Payload-validated sync config (webview or history snapshot).
   * @param triggeredBy - Origin marker persisted in the execution history entry.
   * @param checkpointFirst - The checkpoint the page asked the run to take of
   *   what it writes before its first write; absent, it takes none.
   */
  private async startExecution(
    msg: InboundRequest,
    rawConfig: unknown,
    triggeredBy: 'manual' | 'rerun',
    muteAutomation = false,
    checkpointFirst?: RunCheckpointRequest,
  ): Promise<void> {
    // Build a deterministic ID from the message ID to detect genuine duplicates
    const operationId = msg.id;
    const failure: OperationFailureContext = { module: 'sync', operation: msg.type };
    // Held under the run's id until it is registered: the page offers Cancel
    // as soon as it asks for the run, and a cancel sent while Production
    // Guard asked was refused as a run not found — the run then started once
    // the question was answered.
    const pending = this.registry?.holdUntilStart(operationId);

    try {
      // Fill per-object batch sizes from the `sandforge.sync.defaultBatchSize`
      // setting when the webview omitted them.
      const defaultBatchSize =
        this.deps.services?.getSandforgeSetting?.('sync.defaultBatchSize', 200) ?? 200;
      const parsedConfig = rawConfig as { objects: Array<{ batchSize?: number }> };
      const config = {
        ...parsedConfig,
        objects: parsedConfig.objects.map((o) => ({
          ...o,
          batchSize: o.batchSize ?? defaultBatchSize,
        })),
      } as unknown as import('@sandforge/shared').SyncConfig;
      Object.assign(failure, objectsFailureContext(config.objects));

      // Production guard check on target org. No write without it: a guard
      // that was never injected refuses the run.
      const guard = this.deps.infraServices?.productionGuard;
      if (!guard) {
        this.recordRefused(operationId, config.targetOrgId, PRODUCTION_GUARD_MISSING.code);
        sendHandlerError(
          this.deps,
          'sync:execute',
          'sync:error',
          msg,
          new Error(PRODUCTION_GUARD_MISSING.message),
          { code: PRODUCTION_GUARD_MISSING.code },
        );
        sendOperationFailed(this.deps, operationId, PRODUCTION_GUARD_MISSING.message, false, {
          context: failure,
        });
        return;
      }
      const { check, decision } = await consultProductionGuard(
        guard,
        this.buildGuardRequest(config),
      );
      // What the run carries to the audit trail when it ends.
      const guardDecision = decision;
      if (decision === 'refused' || decision === 'declined') {
        this.recordStopped(operationId, config.targetOrgId, decision);
      }
      if (decision === 'refused') {
        throw guardBlockedError(check.blockedReason ?? check.impactSummary);
      }
      // Production Guard's question, which every write to a production org is
      // asked and no setting turns off: the user's explicit consent.
      if (decision === 'declined') {
        const message = 'Operation cancelled by user (confirmation declined).';
        // Settle the in-flight useBridgeMutation listener on sync:error
        // (same dual-channel contract as the catch paths below), with the
        // code every write path declines with: the page says it in the
        // interface language by it, where this prose is English.
        sendHandlerError(this.deps, 'sync:execute', 'sync:error', msg, new Error(message), {
          code: GUARD_REFUSAL.declined,
        });
        sendOperationFailed(this.deps, operationId, message, false, { context: failure });
        return;
      }
      // Cancelled while the guard asked: the run does not start, nothing is
      // written, and the page is answered with a run cancelled before it
      // synced any object.
      if (pending?.signal.aborted) {
        this.answerCancelledBeforeStart(msg, config, decision);
        return;
      }

      // Check for duplicate operation
      if (this.dmlTracker.isDuplicate(operationId)) {
        this.deps.log(`[WARN] Duplicate sync operation detected: ${operationId}`);
        sendHandlerError(
          this.deps,
          'sync:execute',
          'sync:error',
          msg,
          new Error(`Duplicate operation: ${operationId}`),
        );
        sendOperationFailed(this.deps, operationId, `Duplicate operation: ${operationId}`, false, {
          context: failure,
        });
        return;
      }
      this.dmlTracker.register(operationId, 'sync', 'upsert', config.objects?.length ?? 0);

      // Start performance tracking and register the operation ID
      this.activeOperationIds.add(operationId);
      this.deps.infraServices?.performanceTracker?.start(operationId, 'sync');

      const description = `Sync ${config.objects?.length ?? 0} object(s)`;
      sendOperationStarted(this.deps, operationId, 'sync', description);
      // Feed the Monitor "live operations" panel (total unknown until queries
      // run), where its Pause reaches the run's gate as the Sync page's does.
      this.liveTracker?.register(operationId, 'sync', description, 0, { pausable: true });

      // Create AbortController for this operation
      const abortController = new AbortController();

      // Build the execution promise (runs detached in the background)
      const executionPromise = this.executeSync(
        msg,
        config,
        operationId,
        abortController,
        triggeredBy,
        guardDecision,
        muteAutomation,
        checkpointFirst,
      );

      // Register with BackgroundOperationRegistry if available
      if (this.registry) {
        this.registry.register(operationId, 'sync', description, executionPromise, abortController);
      } else {
        // Fallback: await directly when no registry is available
        await executionPromise;
      }

      // Return immediately -- execution continues in background
    } catch (err: unknown) {
      this.dmlTracker.markFailed(operationId);
      // Dual channel, single display: `operation:failed` carries the lifecycle
      // (webview clears global loading + auto AI-resolver); `sync:error` is the
      // `<domain>:error` channel useBridgeMutation listens on — it settles the
      // in-flight mutation with the real message. The webview surfaces the
      // error from sync:error only, so the user sees it exactly once.
      sendHandlerError(this.deps, 'sync:execute', 'sync:error', msg, err, {
        code: guardRefusalCode(err),
      });
      sendOperationFailed(this.deps, operationId, extractErrorMessage(err), true, {
        context: failure,
      });
    } finally {
      pending?.release();
    }
  }

  /**
   * Answer a run the user cancelled before it started: recorded as stopped
   * under the code of a run cancelled before it started, with the guard's
   * decision, and answered as a run cancelled before it synced any object. It
   * is no run of the history, which keeps the runs that read or wrote.
   */
  private answerCancelledBeforeStart(
    msg: InboundRequest,
    config: SyncConfig,
    decision: GuardDecision,
  ): void {
    recordWriteRun(this.deps, {
      action: 'sync_execute',
      module: 'sync',
      operationId: msg.id,
      orgId: config.targetOrgId,
      outcome: 'stopped',
      guard: decision,
      code: ABORTED_BEFORE_START,
    });
    const result: SyncExecutionResult = {
      configId: config.id,
      operationId: msg.id,
      // Never a success, as a run a cancel stopped never is.
      status: 'partial',
      objectResults: [],
      totalProcessed: 0,
      totalSuccess: 0,
      totalFailed: 0,
      totalSkipped: 0,
      duration: 0,
      timestamp: new Date().toISOString(),
      cancelled: true,
      error: 'Cancelled before it started: nothing was written.',
    };
    const response = buildResponse(
      this.deps,
      msg,
      'sync:execute:response',
      result as unknown as Record<string, unknown>,
    );
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ${response.type} id=${response.id} (cancelled before it started)`);
  }

  /**
   * End a run a cancel stopped, the way a cancelled backup ends: aborted in
   * the registry, and posted as a completion that says it was aborted.
   *
   * A cancelled sync was posted with the status its objects came to, so the
   * recent operations and Home listed a run the user had stopped as succeeded
   * or failed, and Live Operations kept it running until it was done.
   *
   * @param operationId - The run's id.
   */
  private endCancelled(operationId: string): void {
    // Aborted already when the cancel came through the registry, which is
    // then a no-op: a run stopped any other way is listed aborted too, rather
    // than completed once its promise settles.
    this.registry?.abort(operationId);
    sendOperationCompleted(this.deps, operationId, { aborted: true });
    this.liveTracker?.cancel(operationId);
  }

  /**
   * Execute sync operation in the background.
   * Extracted from handleExecute to allow detached execution via BackgroundOperationRegistry.
   *
   * Resolves with the orchestrator result so scheduled executions
   * (`executeScheduled`) can persist lastRunAt/lastResult; failures are
   * reported on `operation:failed` and converted to a failure-status result
   * rather than a rejection, keeping the registry's monitored promise clean.
   * A run the registry's abort stopped resolves with the objects it reached,
   * `cancelled` set, and ends as cancelled; an error thrown while a cancel is
   * pending is still a failure.
   */
  private async executeSync(
    msg: InboundRequest,
    config: import('@sandforge/shared').SyncConfig,
    operationId: string,
    abortController: AbortController,
    triggeredBy: SyncHistoryEntry['triggeredBy'],
    guardDecision?: GuardDecision,
    muteAutomation = false,
    checkpointFirst?: RunCheckpointRequest,
  ): Promise<SyncExecutionResult> {
    const robustnessConfig = robustnessConfigOf(this.deps);
    /** What the run muted of the target's automation, once it ended. */
    let mutedAutomation: import('@sandforge/shared').MutedAutomation | undefined;
    /** The run's gate when it mutes the target's automation, and its lease. */
    let muting: ReturnType<typeof mutingSyncWriteGate> | undefined;
    /**
     * Whether the run sent a write to the target: the checkpoint it took
     * first is kept once it did, whatever became of the run after, and
     * deleted when it never did.
     */
    let wrote = false;
    /** What became of its emails at its gate: what its audit entry says of them. */
    let emails: RunEmailsSaid | undefined;
    /** The run's gate, its answer on the emails kept as it answers. */
    const emailsKeptBy = (gate: SyncWriteGate): SyncWriteGate => ({
      measure: (counted) => gate.measure(counted),
      hold: async (counted) => {
        const held = await gate.hold(counted);
        emails = held.answer.emails;
        return held;
      },
    });
    // The run's pause, found by `sync:pause` and `sync:resume` while it runs.
    const pauseGate = new PauseGate();
    this.pauseGates.set(operationId, pauseGate);
    // What the run creates, kept under its id as it writes it, whoever started
    // it: its removal takes that back, from the history or the results.
    const creations = this.runCreations?.recorder({
      runId: operationId,
      configId: config.id,
      configName: config.name ?? '',
      sourceOrgId: config.sourceOrgId,
      targetOrgId: config.targetOrgId,
    });
    // What it writes over, its values kept first in the DataOps store, as a
    // backup of the target: what its removal gives back.
    const backupFiles = this.backupRecords;
    const overwrites =
      creations && backupFiles
        ? storeOverwriteBackup({
            runId: operationId,
            orgId: config.targetOrgId,
            files: backupFiles,
            meta: this.deps.configStore,
          })
        : undefined;
    // The checkpoint asked first, taken under the run's Stop and named on its file.
    const checkpoint = checkpointFirst
      ? this.runCheckpointOf(config, operationId, checkpointFirst, {
          signal: abortController.signal,
          ...(creations ? { recorder: creations } : {}),
        })
      : undefined;
    /** Say how many records the backup holds, once the run has ended. */
    const closeBackup = (): void => {
      try {
        overwrites?.close();
      } catch (err: unknown) {
        this.deps.log(
          `[WARN] sync ${operationId}: the backup of what it wrote over could not be listed whole: ` +
            extractErrorMessage(err),
        );
      }
    };

    try {
      const readers = await this.readersFor(config, abortController.signal);
      const { sourceConn, targetConn } = readers;
      // The user it writes as, kept in its file for the sweep of its removal:
      // asked as the run begins, and waited for by nothing.
      keepRunUser(creations, () => targetConn.identity(), `sync ${operationId}`);
      const targetRows = readers.queryTargetRows;
      const keeper =
        creations && overwrites
          ? syncOverwriteKeeper({
              query: targetRows,
              backup: overwrites,
              recorder: creations,
              describe: readers.describeTargetFields,
              // An encrypted field the run's user reads masked is not kept.
              viewsEncrypted: viewsEncryptedDataOnce(targetRows),
            })
          : undefined;

      // Build robustness utilities
      const bulkExecutor = new BulkApiExecutor(robustnessConfig.bulk.threshold);
      // Salesforce caps concurrent Bulk API jobs per org, not per run, so a
      // sync counts its jobs against the same limiter as every other write
      // path. (`sandforge.sync.maxConcurrentOps` caps concurrent sync *runs* —
      // see SyncScheduleHandler — not the jobs inside one.)
      const bulkManager = bulkManagerOf(this.deps);
      // Build the record writer: mutualizes insert/upsert/update/delete across
      // the streaming, Bulk API, and REST batch paths (see BulkDataWriter).
      const writer = new BulkDataWriter({
        connection: targetConn,
        bulkExecutor,
        bulkManager,
        retryConfig: robustnessConfig.retry,
        signal: abortController.signal,
        pauseGate,
        onProgress: (processed, total, label) => {
          const pct = Math.round((processed / total) * 100);
          sendOperationProgress(this.deps, operationId, pct, processed, total, label);
          this.liveTracker?.updateProgress(operationId, pct, processed, total, label);
        },
        log: (message) => this.deps.log(message),
        // Each call as it goes and as it answers, kept by the run's recorder,
        // a Bulk API job with its id once the org opened it: see
        // `syncWriterCalls`. The object's write still notes what it created
        // once it returns, which the file reads once.
        ...(creations ? { calls: syncWriterCalls(creations, keeper) } : {}),
      });

      // Lazy-import sync dependencies
      const { DataSync } = await import('../../modules/sync/DataSync.js');
      const { ConflictResolver } = await import('../../modules/sync/ConflictResolver.js');
      const { FieldMappingService } = await import('../../modules/sync/FieldMapping.js');
      const { TransformPipeline } = await import('../../modules/sync/TransformPipeline.js');

      /** A write about to go to the target: once one goes, the run has written. */
      const sending = (rows: readonly unknown[]): void => {
        if (rows.length > 0) wrote = true;
      };
      const dataSync = new DataSync({
        upsert: (objectName, externalIdField, records, batchSize) => {
          sending(records);
          return writer.upsert(objectName, externalIdField, records, batchSize);
        },
        insert: (objectName, records, batchSize) => {
          sending(records);
          return writer.insert(objectName, records, batchSize);
        },
        update: (objectName, records, batchSize) => {
          sending(records);
          return writer.update(objectName, records, batchSize);
        },
        delete: (objectName, recordIds, batchSize) => {
          sending(recordIds);
          return writer.delete(objectName, recordIds, batchSize);
        },
        describeTargetFields: readers.describeTargetFields,
      });
      const conflictResolver = new ConflictResolver();
      const fieldMapping = new FieldMappingService();
      const transformPipeline = new TransformPipeline();

      const syncDeps = {
        dataSync,
        conflictResolver,
        fieldMapping,
        transformPipeline,
        querySource: readers.querySource,
        // An encrypted field the source's user reads masked is left out of every record.
        maskedSourceFields: readers.maskedSourceFields,
        queryTarget: readers.queryTarget,
        services: this.deps.services,
        // Same contract as seed: without BOTH the config and the callback the
        // `grappe:*` channels never fire and the Grappe page stays blank.
        grappeConfig: readGrappeConfig(this.deps.services),
        onGrappeEvent: (event: GrappeEventEnvelope) => postGrappeEvent(this.deps, event),
        countSource: readers.countSource,
        countPersonAccounts: readers.countPersonAccounts,
        // The parents its objects' lookups name written first, from the
        // describe each write reads too.
        describeTargetFields: readers.describeTargetFields,
        // The same, asked of the target again once the mute's lease assigned
        // a permission set, which may have opened record types to the user.
        describeTargetFieldsAgain: readers.describeTargetFieldsAgain,
        // The lease the gate took, given back once the last write is through,
        // before the record types the target gave are read back.
        leaseOfTheGate: () => muting?.lease(),
        // What reads back the record types the target gave the records the
        // run created without one, once its writes are through, as the
        // command line reads them.
        queryTargetRows: targetRows,
        // What an earlier run of a saved configuration copied, still in the
        // target, left as it is: found by the ids each insert reads.
        readSourceIds: readers.readSourceIds,
        findInTarget: readers.findInTarget,
        // Held, before its first write, to the target's data storage, its
        // daily emails and the setting's volume: asked of the user who
        // started it, refused past the emails when nobody watches it.
        // Asked to take a checkpoint first, the gate scopes it from what still
        // runs, asks about it, and takes it once the question is answered,
        // before the mute's lease.
        writeGate: ((): SyncWriteGate => {
          const policy: SyncGatePolicy =
            triggeredBy === 'schedule' || triggeredBy === 'pipeline' ? 'unattended' : 'ask';
          if (!muteAutomation) {
            return emailsKeptBy(
              this.writeGateFor(config, targetConn, policy, undefined, checkpoint?.gate),
            );
          }
          // Asked to mute, the gate plans the mute from what the target runs
          // on the objects the run writes, measures what still runs, and
          // takes the lease once it lets the run write.
          const reader = this.targetAutomation;
          const readAutomation: SyncWriteMeasures['readAutomation'] = (objects) =>
            new TimeoutManager(AUTOMATION_TIMEOUT_MS).withTimeout('sync:automation', () =>
              reader.read(config.targetOrgId, objects),
            );
          muting = mutingSyncWriteGate(
            (read) => this.writeGateFor(config, targetConn, policy, read, checkpoint?.gate),
            readAutomation,
            (read) =>
              muteForRun(async () => muteOrgOf(targetConn), read, {
                ...this.muteLeases,
                writes: syncRunWrites,
              }),
            operationId,
            {
              target: this.deps.orgManager.getOrg(config.targetOrgId)?.alias ?? config.targetOrgId,
              liftedBy: syncEmailsAnswerOf(policy).emailsLiftedBy,
            },
          );
          return emailsKeptBy(muting.gate);
        })(),
        // Both orgs' record types, a record's mapped to the target's.
        recordTypes: readers.recordTypes,
        // Both orgs' currencies: a row in one the target does not hold active
        // goes in its corporate currency, its amounts converted.
        currencies: readers.currencies,
        // Both orgs' standard price books: the source's matched to the
        // target's, and the prices written as the platform takes them.
        standardPricebooks: readers.standardPricebooks,
        // The controller the registry aborts: Live Operations' Cancel, and
        // the Sync page's.
        signal: abortController.signal,
        // The page's Pause and Resume.
        pauseGate,
        // A delta configuration's watermarks, kept beside it.
        deltaStore: this.deltaStoreFor(),
        deltaReads: readers.deltaReads,
        // The files of the records it writes, when the configuration copies
        // them, with their progress on the run's.
        files: {
          ...readers.files,
          onProgress: (percent: number, label: string) => {
            sendOperationProgress(this.deps, operationId, percent, 0, 0, label);
            this.liveTracker?.updateProgress(operationId, percent, 0, 0, label);
          },
        },
        ...(creations ? { creations } : {}),
        // Which record of the target each record of a saved configuration's
        // runs became: an earlier run's copy is what a lookup at it names.
        idMap: this.idMapFor(),
      };
      if (!this.deps.services) {
        throw new Error(
          'SyncOpsHandler: composition-root services not injected. Wire ExtensionHandlersDeps.services in extension.ts.',
        );
      }
      const orchestrator = this.deps.services.syncOrchestrator(syncDeps);

      await this.assertFieldTypesMatch(
        config,
        sourceConn,
        targetConn,
        robustnessConfig.timeouts.describe,
      );

      sendOperationProgress(this.deps, operationId, 10, 0, 1, 'Initializing sync');
      const ran = await orchestrator.execute(config).finally(async () => {
        mutedAutomation = await muting?.release();
      });
      // Its checkpoint kept once it wrote, deleted when it wrote nothing: a
      // run stopped before its first write, or with no row to write.
      const kept = await this.settleRunCheckpoint(checkpoint, wrote, operationId);
      const result: SyncExecutionResult = {
        ...ran,
        ...(mutedAutomation ? { mutedAutomation } : {}),
        ...(kept ? { checkpoint: kept } : {}),
      };
      await creations?.end({ status: result.status, cancelled: result.cancelled === true });
      closeBackup();
      if (result.cancelled) {
        this.endCancelled(operationId);
      } else {
        sendOperationProgress(this.deps, operationId, 100, 1, 1, 'Sync complete');
        sendOperationCompleted(this.deps, operationId, {
          status: (result as { status?: string }).status ?? 'completed',
        });
        this.liveTracker?.complete(operationId);
      }
      this.dmlTracker.markCompleted(operationId);
      if (config.files) {
        const outcomes = result.objectResults.flatMap((r) => (r.files ? [r.files] : []));
        this.deps.log(`[sync] ${operationId} files: ${filesSummaryLine(outcomes)}`);
      }
      checkApiLimits(sourceConn.limitInfo, 'sync:execute completion (source)');
      checkApiLimits(targetConn.limitInfo, 'sync:execute completion (target)');

      // Persist the execution in the sync history (powers sync:history:*).
      // A logging failure must never fail the sync itself — log and move on.
      try {
        this.historyLogger?.logExecution(config, result, triggeredBy);
      } catch (historyErr: unknown) {
        this.deps.log(`[WARN] sync history logging failed: ${extractErrorMessage(historyErr)}`);
      }
      this.recordRun(config, operationId, result, guardDecision, triggeredBy, emails);

      const response = buildResponse(
        this.deps,
        msg,
        'sync:execute:response',
        result as unknown as Record<string, unknown>,
      );
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
      return result;
    } catch (err: unknown) {
      // What it created before it failed stays removable, the run ended.
      await creations?.end({ status: 'failure' });
      closeBackup();
      this.dmlTracker.markFailed(operationId);
      // The checkpoint it took first, kept once it wrote, deleted when it
      // wrote nothing: its lease refused after the take among them.
      const kept = await this.settleRunCheckpoint(checkpoint, wrote, operationId);
      const deleted = kept?.state === 'deleted';
      this.liveTracker?.fail(operationId, extractErrorMessage(err));
      // Refused before its first write — by its write gate, or for an insert
      // that could not tell what earlier runs copied: nothing was written, so
      // it is recorded as stopped, under its code, as a run Production Guard
      // stopped is, and the history keeps no run of it. The page words the
      // refusal by its code; one of its checkpoint's carries the take's.
      if (err instanceof SyncRunRefused) {
        const refusal = checkpoint?.refusal();
        const message = deleted ? `${err.message} ${BEFORE_RUN_DELETED_WORDS}` : err.message;
        // The page says what became of the checkpoint itself, in its language.
        const beside = {
          ...(refusal ? { checkpointRefusal: refusal.code } : {}),
          ...(kept ? { checkpoint: kept } : {}),
        };
        recordWriteRun(this.deps, {
          action: 'sync_execute',
          module: 'sync',
          operationId,
          orgId: config.targetOrgId,
          outcome: 'stopped',
          guard: guardDecision,
          code: err.code,
          details: {
            triggeredBy,
            ...(refusal ? { checkpointRefusal: refusal.code } : {}),
            ...runEmailsDetailsOf(emails),
          },
        });
        sendHandlerError(this.deps, 'sync:execute', 'sync:error', msg, err, {
          code: err.code,
          extraPayload: beside,
        });
        sendOperationFailed(this.deps, operationId, message, false, {
          context: {
            module: 'sync',
            operation: msg.type,
            ...objectsFailureContext(config.objects),
          },
        });
        return {
          ...err.result,
          configId: config.id,
          operationId,
          status: 'failure',
          timestamp: new Date().toISOString(),
          error: message,
          ...(kept ? { checkpoint: kept } : {}),
        };
      }
      // Transport-level failure: the org was unreachable — queue the config so
      // OfflineManager replays it when connectivity returns.
      // Guard on `triggeredBy`: a replay (`rerun`) that fails again is NOT
      // re-queued. Without this the drain loop is infinite — each failed replay
      // re-enqueues while the probe still reports 'online', the debounced drain
      // replays it a second later, and every cycle fires operationQueued +
      // operationExecuted notifications. One replay attempt, then the failure
      // surfaces through the normal operation:failed channel and that's it.
      // A run asked to take a checkpoint first is not queued either: replayed
      // from its configuration alone, it would write with no checkpoint to
      // rewind it to, which the person had asked for.
      if (
        isNetworkError(err) &&
        triggeredBy !== 'rerun' &&
        checkpointFirst === undefined &&
        this.deps.infraServices?.offlineManager
      ) {
        const queued = this.deps.infraServices.offlineManager.enqueue({
          id: operationId,
          type: 'sync',
          orgId: config.targetOrgId,
          payload: { config: config as unknown as Record<string, unknown> },
        });
        if (queued) {
          this.deps.log(`[OFFLINE] sync queued for replay on reconnect: ${operationId}`);
        }
      } else if (isNetworkError(err) && triggeredBy === 'rerun') {
        this.deps.log(
          `[OFFLINE] sync replay failed again — not re-queued (replay outcomes surface via operation:failed): ${operationId}`,
        );
      }
      // Dual channel, single display (see startExecution): operation:failed
      // carries the lifecycle, sync:error settles the in-flight mutation with
      // the real message. Scheduled runs have no listener — the extra message
      // is simply ignored. A run that failed before its first write says its
      // checkpoint is gone with it: the page in its language, from `checkpoint`.
      const failed = deleted
        ? new Error(`${extractErrorMessage(err)} ${BEFORE_RUN_DELETED_WORDS}`)
        : err;
      sendHandlerError(this.deps, 'sync:execute', 'sync:error', msg, err, {
        ...(kept ? { extraPayload: { checkpoint: kept } } : {}),
      });
      sendOperationFailed(this.deps, operationId, extractErrorMessage(failed), true, {
        context: { module: 'sync', operation: msg.type, ...objectsFailureContext(config.objects) },
      });
      // Failure-status result (instead of a rejection) so scheduled executions
      // can persist lastResult='failure' without an unhandled rejection in the
      // BackgroundOperationRegistry's monitored promise.
      // A run that failed partway through carries what it had already written
      // (SyncRunFailure). Without it every failure read as "0 objects, 0 ms".
      const partial = err instanceof SyncRunFailure ? err.result : undefined;
      const failureResult: SyncExecutionResult = {
        ...(partial ?? {
          objectResults: [],
          totalProcessed: 0,
          totalSuccess: 0,
          totalFailed: 0,
          totalSkipped: 0,
          duration: 0,
        }),
        configId: config.id,
        operationId,
        status: 'failure',
        timestamp: new Date().toISOString(),
        error: extractErrorMessage(failed),
        ...(kept ? { checkpoint: kept } : {}),
      };

      // Persist the failed execution too (same contract as the success path
      // above). A run that threw is precisely the one the user needs in the
      // history panel — it is what `sync:history:rerun` replays — and logging
      // only successes left history and re-run dead for every failed run.
      // A logging failure must never mask the sync's own error.
      try {
        this.historyLogger?.logExecution(config, failureResult, triggeredBy);
      } catch (historyErr: unknown) {
        this.deps.log(`[WARN] sync history logging failed: ${extractErrorMessage(historyErr)}`);
      }
      // What it wrote before it failed is in the partial result, when there is one.
      this.recordRun(config, operationId, failureResult, guardDecision, triggeredBy, emails);

      return failureResult;
    } finally {
      this.pauseGates.delete(operationId);
      if (this.activeOperationIds.has(operationId)) {
        this.deps.infraServices?.performanceTracker?.complete(operationId);
        this.activeOperationIds.delete(operationId);
      }
    }
  }
}
