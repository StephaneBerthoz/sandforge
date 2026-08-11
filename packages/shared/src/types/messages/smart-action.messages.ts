import type { BaseMessage } from './base.messages.js';
import type { SmartActionRecommendation } from '../smart-action.types.js';
import type {
  QuickSyncConfig,
  QuickSyncPreview,
  RelationshipSuggestion,
  SmartObjectSuggestion,
} from '../quickSync.types.js';

/** Request to analyze an org and get a smart action recommendation. */
export interface SmartActionAnalyzeRequest extends BaseMessage {
  type: 'smart-action:analyze';
  payload: { targetOrgId: string; sourceOrgId?: string };
}

/** Response containing the smart action recommendation. */
export interface SmartActionAnalyzeResponse extends BaseMessage {
  type: 'smart-action:analyze:response';
  payload: { recommendation: SmartActionRecommendation };
}

/** Error response for smart action analysis failures (emitted via sendHandlerError). */
export interface SmartActionErrorResponse extends BaseMessage {
  type: 'smart-action:error';
  payload: { message: string; code: string; retryable: boolean };
}

// ─── QuickSync wizard messages ───────────────────────────────────────────────

/** Request object suggestions for the QuickSync wizard (WebView -> Extension). */
export interface QuickSyncSuggestObjectsRequest extends BaseMessage {
  type: 'quicksync:suggest-objects';
  payload: { orgId: string; alreadySelected: string[] };
}

/** Request parent-dependency detection for a selected object (WebView -> Extension). */
export interface QuickSyncDetectRelationshipsRequest extends BaseMessage {
  type: 'quicksync:detect-relationships';
  payload: {
    orgId: string;
    objectApiName: string;
    alreadySelected: string[];
    availableObjects: string[];
  };
}

/** Request a record-count preview for the selected objects (WebView -> Extension). */
export interface QuickSyncPreviewRequest extends BaseMessage {
  type: 'quicksync:preview';
  payload: { sourceOrgId: string; selectedObjects: string[]; parentObjects?: string[] };
}

/** Request execution of a QuickSync configuration (WebView -> Extension). */
export interface QuickSyncExecuteRequest extends BaseMessage {
  type: 'quicksync:execute';
  payload: { config: QuickSyncConfig };
}

/** Response containing the smart object suggestions for the QuickSync wizard. */
export interface QuickSyncSuggestObjectsResponse extends BaseMessage {
  type: 'quicksync:suggest-objects:response';
  payload: { suggestions: SmartObjectSuggestion[] };
}

/** Response containing the detected parent-dependency suggestions. */
export interface QuickSyncDetectRelationshipsResponse extends BaseMessage {
  type: 'quicksync:detect-relationships:response';
  payload: { suggestions: RelationshipSuggestion[] };
}

/** Response containing the record-count / API-call preview for the selected objects. */
export interface QuickSyncPreviewResponse extends BaseMessage {
  type: 'quicksync:preview:response';
  payload: { preview: QuickSyncPreview };
}

/**
 * Response for `quicksync:execute` — carries the sync configuration built by
 * the handler; the webview re-dispatches it as a `sync:execute` message,
 * delegating execution to the existing SyncOpsHandler flow. `syncConfig` is a
 * SyncConfig cast at the emission site, hence the wide shape.
 */
export interface QuickSyncExecuteResponse extends BaseMessage {
  type: 'quicksync:execute:response';
  payload: { syncConfig: Record<string, unknown>; objectCount: number };
}

/** Error response for QuickSync wizard operations (emitted via sendHandlerError). */
export interface QuickSyncErrorResponse extends BaseMessage {
  type: 'quicksync:error';
  payload: { message: string; code: string; retryable: boolean };
}
