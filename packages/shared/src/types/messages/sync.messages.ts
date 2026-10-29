import type { BaseMessage } from './base.messages.js';
import type {
  SyncEarlierCopies,
  SyncExecutionResult,
  SyncHistoryEntry,
  SyncMode,
  SyncRemovalResult,
  SyncRunRemovalInfo,
  SyncScheduleEntry,
  SyncEncryptedFieldsMasked,
  SyncSimulationResult,
  SyncWriteOrder,
} from '../sync.types.js';
import type { ExportFormat } from '../reporting.types.js';
import type { ForgeSweepListing, ForgeTargetAutomation } from '../forge.types.js';
import type { ForgeRemovalSteps } from '../../utils/forge-target-automation.js';

/** Sync messages */
export interface SyncExecuteRequest extends BaseMessage {
  type: 'sync:execute';
  payload: { configId: string };
}

/** Response for sync execution — the SyncOrchestrator result (consumed by useSyncPageData). */
export interface SyncExecuteResponse extends BaseMessage {
  type: 'sync:execute:response';
  payload: SyncExecutionResult;
}

/**
 * Simulate a sync: read both orgs, compare, and say per object what the run
 * would insert, update, skip or find in conflict. Nothing is written. Asked
 * apart from `sync:execute` rather than as a flag of the configuration, so a
 * saved or scheduled configuration can never carry it.
 */
export interface SyncSimulateRequest extends BaseMessage {
  type: 'sync:simulate';
  payload: { config: Record<string, unknown> };
}

/** Response for a simulation — what the run would do, object by object. */
export interface SyncSimulateResponse extends BaseMessage {
  type: 'sync:simulate:response';
  payload: SyncSimulationResult;
}

/**
 * `sync:write-order`. WebView -> Extension. The order a run of this
 * configuration writes its objects in, as the run computes it from the
 * target's describe of each: what the Review step shows before anything runs.
 * Checked as a run's configuration is; errors on `sync:error`.
 */
export interface SyncWriteOrderRequest extends BaseMessage {
  type: 'sync:write-order';
  payload: { config: Record<string, unknown> };
}

/**
 * `sync:write-order:response`. Extension -> WebView. With the order, per
 * object, the classic encrypted fields the user the source is read as reads
 * masked, lacking View Encrypted Data, which a run leaves out
 * (`SyncObjectResult.encryptedLeftOut`): what Review warns of. Absent when
 * none, or when the source would not say.
 */
export interface SyncWriteOrderResponse extends BaseMessage {
  type: 'sync:write-order:response';
  payload: { order: SyncWriteOrder; encrypted?: SyncEncryptedFieldsMasked[] };
}

/** Pause a running sync before its next object or batch, by the id of the request that started it. */
export interface SyncPauseRequest extends BaseMessage {
  type: 'sync:pause';
  payload: { operationId: string };
}

/** Resume a paused sync, by the id of the request that started it. */
export interface SyncResumeRequest extends BaseMessage {
  type: 'sync:resume';
  payload: { operationId: string };
}

/** What a pause or a resume came to. */
export interface SyncRunControlAnswer {
  /** Whether a running sync had this id. */
  success: boolean;
  operationId: string;
  /** Whether the run is now held before its next object or batch. */
  paused: boolean;
  /** Why nothing was done, when nothing was. */
  error?: string;
}

/** Response for `sync:pause`. */
export interface SyncPauseResponse extends BaseMessage {
  type: 'sync:pause:response';
  payload: SyncRunControlAnswer;
}

/** Response for `sync:resume`. */
export interface SyncResumeResponse extends BaseMessage {
  type: 'sync:resume:response';
  payload: SyncRunControlAnswer;
}

/**
 * Response containing the objects a sync may copy from an org: those its
 * user may read, and, asked with the target, that the target takes.
 */
export interface SyncDescribeGlobalResponse extends BaseMessage {
  type: 'sync:describe-global:response';
  payload: {
    objects: string[];
    /**
     * Asked with the target: the source's objects the target has not, or
     * whose records the user SandForge writes as may neither create nor edit
     * there. Listed for the picker to show and not let be picked. Absent when none.
     */
    unwritable?: Array<{ objectApiName: string; why: 'notInTarget' | 'notCreateable' }>;
  };
}

/** Response containing the createable fields of an object on both source and target orgs. */
export interface SyncDescribeFieldsResponse extends BaseMessage {
  type: 'sync:describe-fields:response';
  payload: {
    objectApiName: string;
    sourceFields: Array<{ apiName: string; label: string; type: string }>;
    targetFields: Array<{ apiName: string; label: string; type: string }>;
  };
}

/** Error response for sync config/describe/execute failures (emitted via sendHandlerError). */
export interface SyncErrorResponse extends BaseMessage {
  type: 'sync:error';
  payload: { message: string; code: string; retryable: boolean };
}

/** Sync describe global objects request. */
export interface SyncDescribeGlobalRequest extends BaseMessage {
  type: 'sync:describe-global';
  payload: { orgId: string };
}

/** Sync describe fields for source and target request. */
export interface SyncDescribeFieldsRequest extends BaseMessage {
  type: 'sync:describe-fields';
  payload: { sourceOrgId: string; targetOrgId: string; objectApiName: string };
}

/** Request to save a sync configuration (create or update). */
export interface SyncConfigSaveRequest extends BaseMessage {
  type: 'sync:config:save';
  payload: { config: Record<string, unknown> };
}

/** Request to load a sync configuration by ID. */
export interface SyncConfigLoadRequest extends BaseMessage {
  type: 'sync:config:load';
  payload: { id: string };
}

/** Request to list all sync configurations. */
export interface SyncConfigListRequest extends BaseMessage {
  type: 'sync:config:list';
}

/** Request to delete a sync configuration by ID. */
export interface SyncConfigDeleteRequest extends BaseMessage {
  type: 'sync:config:delete';
  payload: { id: string };
}

/**
 * "Run full next time": clear the watermarks of a saved delta configuration,
 * so its next run reads every object whole.
 */
export interface SyncConfigResetDeltaRequest extends BaseMessage {
  type: 'sync:config:reset-delta';
  payload: { id: string };
}

/** Response for sync config save. */
export interface SyncConfigSaveResponse extends BaseMessage {
  type: 'sync:config:save:response';
  payload: { success: boolean; id: string };
}

/** Response for sync config load. */
export interface SyncConfigLoadResponse extends BaseMessage {
  type: 'sync:config:load:response';
  payload: { config: Record<string, unknown> | null };
}

/** One saved configuration, as the list names it. */
export interface SyncConfigSummary {
  id: string;
  name: string;
  description: string;
  updatedAt: string;
  /** Full, or delta: a delta configuration reads each object from its watermark. */
  mode?: SyncMode;
  /** Whether a delta run of it deletes in the target what the source deleted. */
  propagateDeletes?: boolean;
  /** How many of its objects hold a watermark: what "Run full next time" clears. */
  watermarks?: number;
}

/** Response for sync config list. */
export interface SyncConfigListResponse extends BaseMessage {
  type: 'sync:config:list:response';
  payload: { configs: SyncConfigSummary[] };
}

/** Response for sync config delete. */
export interface SyncConfigDeleteResponse extends BaseMessage {
  type: 'sync:config:delete:response';
  payload: { success: boolean };
}

/** Response for "Run full next time": the watermarks cleared, by object. */
export interface SyncConfigResetDeltaResponse extends BaseMessage {
  type: 'sync:config:reset-delta:response';
  payload: { success: boolean; id: string; cleared: number };
}

// ─── Sync History Messages ───────────────────────────────────────────────────

/** Request to list all sync history entries. */
export interface SyncHistoryListRequest extends BaseMessage {
  type: 'sync:history:list';
}

/** Response containing all sync history entries. */
export interface SyncHistoryListResponse extends BaseMessage {
  type: 'sync:history:list:response';
  payload: { entries: SyncHistoryEntry[] };
}

/** Request to get a single sync history entry by ID. */
export interface SyncHistoryDetailRequest extends BaseMessage {
  type: 'sync:history:detail';
  payload: { entryId: string };
}

/** Response containing a single sync history entry. */
export interface SyncHistoryDetailResponse extends BaseMessage {
  type: 'sync:history:detail:response';
  payload: { entry: SyncHistoryEntry | null };
}

/** Request to re-run a sync from a history entry's config snapshot. */
export interface SyncHistoryRerunRequest extends BaseMessage {
  type: 'sync:history:rerun';
  payload: { entryId: string };
}

/** Request to export sync history entries. */
export interface SyncHistoryExportRequest extends BaseMessage {
  type: 'sync:history:export';
  payload: { format: ExportFormat; entryIds?: string[] };
}

/** Response containing exported sync history data. */
export interface SyncHistoryExportResponse extends BaseMessage {
  type: 'sync:history:export:response';
  payload: { data: string; format: ExportFormat; filename: string };
}

/** Error response for sync history operations (emitted via sendHandlerError). */
export interface SyncHistoryErrorResponse extends BaseMessage {
  type: 'sync:history:error';
  payload: { message: string; code: string; retryable: boolean };
}

// ─── Sync Removal Messages ───────────────────────────────────────────────────

/**
 * `sync:removal:info`. WebView -> Extension. What a removal of a run's
 * creations would take, and whether one can run, read from what the run kept
 * — nothing is asked of the org.
 */
export interface SyncRemovalInfoRequest extends BaseMessage {
  type: 'sync:removal:info';
  payload: { runId: string };
}

/** `sync:removal:info:response`. Extension -> WebView. `null` when nothing of the run is kept. */
export interface SyncRemovalInfoResponse extends BaseMessage {
  type: 'sync:removal:info:response';
  payload: { info: SyncRunRemovalInfo | null };
}

/**
 * `sync:removal:list`. WebView -> Extension. The runs whose creations are
 * kept that no entry of the history holds: a run a closed window stopped
 * before it ended, or one the history no longer lists. With `realtime`, the
 * sessions of the Real-Time tab instead, which no other list holds.
 */
export interface SyncRemovalListRequest extends BaseMessage {
  type: 'sync:removal:list';
  payload?: { realtime?: true };
}

/** `sync:removal:list:response`. Extension -> WebView. Newest first. */
export interface SyncRemovalListResponse extends BaseMessage {
  type: 'sync:removal:list:response';
  payload: { runs: SyncRunRemovalInfo[] };
}

/**
 * `sync:remove`. WebView -> Extension. Remove from its target what a run
 * created, as the run kept it — the request names the run, never records.
 */
export interface SyncRemoveRequest extends BaseMessage {
  type: 'sync:remove';
  payload: {
    runId: string;
    /** Remove the records modified since the run too, and what was added to them since. */
    includeChanged?: boolean;
    /**
     * Sweep first what the target's automation created during the run, as
     * its user, that the run did not write.
     */
    sweep?: boolean;
    /**
     * Take every record and file the run created, not what its removals
     * left: an undo of a checkpoint's rewind brought back records its removal
     * had found gone (`backAfterRemoval`). Each is read before it is deleted,
     * as ever; the undo dated them anew, so they read as changed since the run.
     */
    again?: boolean;
  };
}

/**
 * `sync:remove:sweep`. WebView -> Extension. What a sweep asked with the
 * removal of a run would take, read only, for the confirmation to list.
 */
export interface SyncRemoveSweepRequest extends BaseMessage {
  type: 'sync:remove:sweep';
  payload: { runId: string };
}

/** `sync:remove:sweep:response`. Extension -> WebView. */
export interface SyncRemoveSweepResponse extends BaseMessage {
  type: 'sync:remove:sweep:response';
  payload: { runId: string; listing: ForgeSweepListing };
}

/** `sync:remove:sweep:error`. Extension -> WebView. The read of what a sweep would take failed. */
export interface SyncRemoveSweepErrorResponse extends BaseMessage {
  type: 'sync:remove:sweep:error';
  payload: { message: string; code: string; retryable: boolean };
}

/**
 * `sync:remove:automation`. WebView -> Extension. What the target runs as the
 * removal of a run takes it back, read only, for the confirmation to list.
 * The run is named, never its objects: the extension reads them from what
 * the run kept, as the removal does.
 */
export interface SyncRemoveAutomationRequest extends BaseMessage {
  type: 'sync:remove:automation';
  /** `again`: on the objects of every record the run created, as `sync:remove` takes them `again`. */
  payload: { runId: string; again?: boolean };
}

/**
 * `sync:remove:automation:response`. Extension -> WebView. What the target
 * runs on the objects of the run, the triggers after an undelete among it,
 * and the objects each step of the removal writes: those it brings back from
 * the recycle bin, gives back their values, sets back to Draft and deletes.
 */
export interface SyncRemoveAutomationResponse extends BaseMessage {
  type: 'sync:remove:automation:response';
  payload: { runId: string; automation: ForgeTargetAutomation; steps: ForgeRemovalSteps };
}

/** `sync:remove:automation:error`. Extension -> WebView. The read of what the removal fires failed. */
export interface SyncRemoveAutomationErrorResponse extends BaseMessage {
  type: 'sync:remove:automation:error';
  payload: { message: string; code: string; retryable: boolean };
}

/** `sync:remove:response`. Extension -> WebView. Also when the removal was cancelled part way. */
export interface SyncRemoveResponse extends BaseMessage {
  type: 'sync:remove:response';
  payload: { result: SyncRemovalResult; operationId: string };
}

/**
 * `sync:remove:error`. Extension -> WebView. A removal refused before it
 * started (`NOT_KEPT`, `NOTHING_TO_REMOVE`, `ALREADY_REMOVED`, `DUPLICATE`,
 * `RUNNING`, `ORG_GONE`, the guard's codes), one that failed, or a read of
 * what a run kept that failed.
 */
export interface SyncRemoveErrorResponse extends BaseMessage {
  type: 'sync:remove:error';
  payload: { message: string; code: string; retryable: boolean };
}

/**
 * `sync:earlier-copies`. WebView -> Extension. What the last run kept between
 * these orgs created of these objects that is still in the target, and
 * whether a run of the configuration named leaves it as it is: what Quick
 * Sync's preview and a history entry's Run again say before they insert
 * again. Errors on `sync:remove:error`.
 */
export interface SyncEarlierCopiesRequest extends BaseMessage {
  type: 'sync:earlier-copies';
  payload: {
    sourceOrgId: string;
    targetOrgId: string;
    /** The objects the run inserts without a key. */
    objects: string[];
    /** The configuration the run is of, when it is one that may be saved. */
    configId?: string;
  };
}

/** `sync:earlier-copies:response`. Extension -> WebView. */
export interface SyncEarlierCopiesResponse extends BaseMessage {
  type: 'sync:earlier-copies:response';
  payload: { copies: SyncEarlierCopies };
}

// ─── Sync Schedule Messages ──────────────────────────────────────────────────

/** Request to list all sync schedules. */
export interface SyncScheduleListRequest extends BaseMessage {
  type: 'sync:schedule:list';
}

/** Response containing all sync schedule entries. */
export interface SyncScheduleListResponse extends BaseMessage {
  type: 'sync:schedule:list:response';
  payload: { schedules: SyncScheduleEntry[] };
}

/** Request to create or update a sync schedule. */
export interface SyncScheduleUpsertRequest extends BaseMessage {
  type: 'sync:schedule:upsert';
  payload: {
    schedule: Omit<SyncScheduleEntry, 'nextRunAt' | 'lastRunAt' | 'lastResult'>;
  };
}

/** Response after creating or updating a sync schedule. */
export interface SyncScheduleUpsertResponse extends BaseMessage {
  type: 'sync:schedule:upsert:response';
  payload: { success: boolean; schedule?: SyncScheduleEntry };
}

/** Request to toggle a sync schedule on/off. */
export interface SyncScheduleToggleRequest extends BaseMessage {
  type: 'sync:schedule:toggle';
  payload: { scheduleId: string; enabled: boolean };
}

/** Response after toggling a sync schedule. */
export interface SyncScheduleToggleResponse extends BaseMessage {
  type: 'sync:schedule:toggle:response';
  payload: { success: boolean; schedule?: SyncScheduleEntry };
}

/** Request to delete a sync schedule. */
export interface SyncScheduleDeleteRequest extends BaseMessage {
  type: 'sync:schedule:delete';
  payload: { scheduleId: string };
}

/** Response after deleting a sync schedule. */
export interface SyncScheduleDeleteResponse extends BaseMessage {
  type: 'sync:schedule:delete:response';
  payload: { success: boolean };
}

/** Error response for sync schedule operations (emitted via sendHandlerError). */
export interface SyncScheduleErrorResponse extends BaseMessage {
  type: 'sync:schedule:error';
  payload: { message: string; code: string; retryable: boolean };
}
