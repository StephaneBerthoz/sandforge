import type { BaseMessage } from './base.messages.js';
import type { SyncExecutionResult, SyncHistoryEntry, SyncScheduleEntry } from '../sync.types.js';
import type { ExportFormat } from '../reporting.types.js';

/** Sync messages */
export interface SyncExecuteRequest extends BaseMessage {
  type: 'sync:execute';
  payload: { configId: string; dryRun: boolean };
}

/** Response for sync execution — the SyncOrchestrator result (consumed by useSyncPageData). */
export interface SyncExecuteResponse extends BaseMessage {
  type: 'sync:execute:response';
  payload: SyncExecutionResult;
}

/** Response containing the createable + queryable object API names of an org. */
export interface SyncDescribeGlobalResponse extends BaseMessage {
  type: 'sync:describe-global:response';
  payload: { objects: string[] };
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

/** Response for sync config list. */
export interface SyncConfigListResponse extends BaseMessage {
  type: 'sync:config:list:response';
  payload: { configs: Array<{ id: string; name: string; description: string; updatedAt: string }> };
}

/** Response for sync config delete. */
export interface SyncConfigDeleteResponse extends BaseMessage {
  type: 'sync:config:delete:response';
  payload: { success: boolean };
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
