import type { BaseMessage } from './base.messages.js';
import type { RealTimeSyncMetrics } from '../sync.types.js';

/**
 * How a real-time session finds, in the target org, the record a change is
 * about.
 *
 * - `id`: the two orgs share record ids — sandboxes copied from the same
 *   production do, for every record that existed at the copy. A record created
 *   since has no twin to update.
 * - `externalId`: an external id field of the target object, filled from the
 *   source field of the same name. A change is upserted on it.
 * - `syncConfig`: the field mapping of a saved Sync configuration between the
 *   same two orgs — its external id, mappings, transforms and add-on fields.
 */
export type RealTimeMatch =
  { kind: 'id' } | { kind: 'externalId'; field: string } | { kind: 'syncConfig'; configId: string };

/** A watched object whose changes are written to the target org. */
export interface RealTimeApplyObject {
  /** API name of the object. */
  objectApiName: string;
  /** How the target record of a change is found. */
  match: RealTimeMatch;
  /** Whether a record deleted in the source is deleted in the target too. */
  applyDeletes: boolean;
}

/**
 * What became of one change event.
 *
 * - `applied`: written to the target.
 * - `failed`: not written; `error` says why.
 * - `watched`: the object is watched without being applied.
 * - `kept-target`: the target record was edited after the change was made,
 *   and the session's conflict strategy kept that edit.
 * - `held`: same collision, held for a decision on the Conflicts tab.
 * - `deletes-off`: a deletion, and deletes are not applied for the object.
 * - `own-write`: the session's own write coming back — source and target are
 *   the same org, or another session writes back — so it is not applied again.
 */
export type RealTimeEventOutcome =
  'applied' | 'failed' | 'watched' | 'kept-target' | 'held' | 'deletes-off' | 'own-write';

/** An object of the source org that publishes change events. */
export interface RealTimePublishingObject {
  /** API name of the object. */
  objectApiName: string;
  /** The event channel the source org lists it on (`ChangeEvents` is the standard one). */
  channel: string;
  /** Whether the target org has the object. */
  inTarget: boolean;
  /** External id fields of the object in the target org. */
  externalIdFields: string[];
  /** Saved Sync configurations between these two orgs that carry the object. */
  syncConfigs: Array<{ id: string; name: string }>;
}

/** Request to start a real-time CDC sync session. */
export interface RealTimeStartRequest extends BaseMessage {
  type: 'realtime:start';
  payload: {
    sourceOrgId: string;
    targetOrgId: string;
    watchedObjects: string[];
    /** Watched objects whose changes are written to the target; the others are only shown. */
    apply: RealTimeApplyObject[];
    conflictStrategy: string;
    flushIntervalMs: number;
    maxBatchSize: number;
  };
}

/** Request to stop a real-time CDC sync session. */
export interface RealTimeStopRequest extends BaseMessage {
  type: 'realtime:stop';
  payload: { sessionId: string };
}

/** Request to get the current real-time sync status. */
export interface RealTimeStatusRequest extends BaseMessage {
  type: 'realtime:status';
}

/** Request to get real-time sync metrics. */
export interface RealTimeMetricsRequest extends BaseMessage {
  type: 'realtime:metrics';
}

/** Request for the objects of the source org that publish change events. */
export interface RealTimeObjectsRequest extends BaseMessage {
  type: 'realtime:objects';
  payload: { sourceOrgId: string; targetOrgId: string };
}

/** Request to resolve a real-time sync conflict. */
export interface RealTimeResolveConflictRequest extends BaseMessage {
  type: 'realtime:resolve-conflict';
  payload: {
    /** Unique conflict ID (primary key for resolution) */
    conflictId: string;
    /** Legacy replay ID for backward compatibility */
    eventReplayId?: number;
    /** Bulk resolution strategy */
    resolution: string;
    /** Per-field resolution choices for manual resolution */
    fieldResolutions?: Record<string, { value: unknown; source: 'source' | 'target' | 'manual' }>;
  };
}

/** Response confirming a real-time sync session has started, or saying why it did not. */
export interface RealTimeStartedResponse extends BaseMessage {
  type: 'realtime:started';
  payload: {
    success: boolean;
    sessionId?: string;
    /** The objects the session subscribed to. */
    watchedObjects: string[];
    /** Objects the source org refused a subscription for, with its answer. */
    refused: Array<{ objectApiName: string; reason: string }>;
    /** What the session had to settle for, such as a resume point the org no longer holds. */
    notes: string[];
    error?: string;
  };
}

/** Response confirming a real-time sync session has stopped. */
export interface RealTimeStoppedResponse extends BaseMessage {
  type: 'realtime:stopped';
  payload: {
    sessionId: string;
    reason: string;
    success?: boolean;
  };
}

/** Push event when a CDC change is received and processed. */
export interface RealTimeCDCEventMessage extends BaseMessage {
  type: 'realtime:event';
  payload: {
    replayId: number;
    objectApiName: string;
    changeType: string;
    recordIds: string[];
    commitTimestamp: string;
    applied: boolean;
    error?: string;
  };
}

/** Batched CDC events for efficient WebView delivery. */
export interface RealTimeEventsBatchMessage extends BaseMessage {
  type: 'realtime:events-batch';
  payload: {
    events: Array<{
      replayId: number;
      objectApiName: string;
      changeType: string;
      recordIds: string[];
      commitTimestamp: string;
      changedFields: Record<string, unknown>;
      commitUser: string;
      transactionKey: string;
      applied: boolean;
      outcome: RealTimeEventOutcome;
      error?: string;
    }>;
  };
}

/** Response containing the current real-time sync status. */
export interface RealTimeStatusResponse extends BaseMessage {
  type: 'realtime:status:response';
  payload: {
    status: string;
    sessionId?: string;
    watchedObjects: string[];
    refused?: Array<{ objectApiName: string; reason: string }>;
    notes?: string[];
    error?: string;
  };
}

/** Response containing real-time sync metrics, `null` while no session has run. */
export interface RealTimeMetricsResponse extends BaseMessage {
  type: 'realtime:metrics:response';
  payload: {
    metrics: RealTimeSyncMetrics | null;
  };
}

/** Response listing the objects of the source org that publish change events. */
export interface RealTimeObjectsResponse extends BaseMessage {
  type: 'realtime:objects:response';
  payload: {
    objects: RealTimePublishingObject[];
  };
}

/** Error answer of a `realtime:*` request the host could not serve. */
export interface RealTimeErrorResponse extends BaseMessage {
  type: 'realtime:error';
  payload: {
    message: string;
    code: string;
    retryable: boolean;
  };
}

/** Push event when a conflict is detected during real-time sync. */
export interface RealTimeConflictDetected extends BaseMessage {
  type: 'realtime:conflict';
  payload: {
    replayId: number;
    objectApiName: string;
    recordIds: string[];
    changeType: string;
    sourceValues: Record<string, unknown>;
    targetValues: Record<string, unknown>;
    targetLastModified: string;
  };
}

/** Response confirming a real-time sync conflict has been resolved. */
export interface RealTimeConflictResolvedResponse extends BaseMessage {
  type: 'realtime:conflict-resolved';
  payload: {
    conflictId: string;
    resolution: string;
    success: boolean;
    resolvedValues?: Record<string, unknown>;
    error?: string;
  };
}
