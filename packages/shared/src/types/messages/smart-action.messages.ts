import type { BaseMessage } from './base.messages.js';
import type { SmartActionRecommendation } from '../smart-action.types.js';
import type { QuickSyncConfig } from '../quickSync.types.js';

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
