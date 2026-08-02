import type { BaseMessage } from './base.messages.js';

/** Request to start a real-time CDC sync session. */
export interface RealTimeStartRequest extends BaseMessage {
  type: 'realtime:start';
  payload: {
    sourceOrgId: string;
    targetOrgId: string;
    watchedObjects: string[];
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

/** Response confirming a real-time sync session has started. */
export interface RealTimeStartedResponse extends BaseMessage {
  type: 'realtime:started';
  payload: {
    sessionId: string;
    watchedObjects: string[];
  };
}

/** Response confirming a real-time sync session has stopped. */
export interface RealTimeStoppedResponse extends BaseMessage {
  type: 'realtime:stopped';
  payload: {
    sessionId: string;
    reason: string;
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
    error?: string;
  };
}

/** Response containing real-time sync metrics. */
export interface RealTimeMetricsResponse extends BaseMessage {
  type: 'realtime:metrics:response';
  payload: {
    eventsReceived: number;
    eventsApplied: number;
    eventsFailed: number;
    eventsPerMinute: number;
    averageLagMs: number;
    currentLagMs: number;
    errorRate: number;
    startedAt: string;
    lastEventAt?: string;
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
  };
}
