import type { BaseMessage } from './base.messages.js';
import type { CompareResult } from '../compare.types.js';

/** Compare messages */
export interface CompareExecuteRequest extends BaseMessage {
  type: 'compare:execute';
  payload: { configId: string };
}

/**
 * Result of a `compare:execute` (or legacy `compare:start`) run.
 * This is the single response channel posted by CompareHandler for both
 * request types — the webview listens on `compare:execute:response`.
 */
export interface CompareExecuteResponse extends BaseMessage {
  type: 'compare:execute:response';
  payload: CompareResult;
}

/**
 * Legacy alias of `compare:execute`, still routed by CompareHandler.
 * Payload validated server-side by `compareExecutePayloadSchema`.
 */
export interface CompareStartRequest extends BaseMessage {
  type: 'compare:start';
  payload: { sourceOrgId: string; targetOrgId: string; types: string[] };
}

/** Request to compare permission sets and profiles between two orgs. */
export interface ComparePermissionsRequest extends BaseMessage {
  type: 'compare:permissions';
  payload: { sourceOrgId: string; targetOrgId: string };
}

/** Request to capture and compare object snapshots between two orgs. */
export interface CompareSnapshotsRequest extends BaseMessage {
  type: 'compare:snapshots';
  payload: { sourceOrgId: string; targetOrgId: string };
}

/** Request to detect configuration drift between two orgs. */
export interface CompareDriftRequest extends BaseMessage {
  type: 'compare:drift';
  payload: { sourceOrgId: string; targetOrgId: string };
}

/** Diff bucket used by compare:permissions (source-only / target-only / shared entries). */
export interface ComparePermissionsBucket<T> {
  sourceOnly: T[];
  targetOnly: T[];
  shared: T[];
}

/** Response containing the permission set / profile diff between two orgs. */
export interface ComparePermissionsResponse extends BaseMessage {
  type: 'compare:permissions:response';
  payload: {
    permissions: {
      permissionSets: ComparePermissionsBucket<{ name: string; label: string }>;
      profiles: ComparePermissionsBucket<{ name: string }>;
    };
  };
}

/** Per-org object census inside a compare:snapshots result. */
export interface CompareSnapshotSide {
  orgId: string;
  totalObjects: number;
  customObjects: number;
  standardObjects: number;
  queryableObjects: number;
}

/** Response containing the object snapshot comparison between two orgs. */
export interface CompareSnapshotsResponse extends BaseMessage {
  type: 'compare:snapshots:response';
  payload: {
    snapshot: {
      source: CompareSnapshotSide;
      target: CompareSnapshotSide;
      diff: { sourceOnly: string[]; targetOnly: string[]; sharedCount: number };
      capturedAt: string;
    };
  };
}

/** Single drift item comparing one org setting between source and target. */
export interface CompareDriftItem {
  setting: string;
  sourceValue: string;
  targetValue: string;
  status: 'match' | 'drift' | 'missing_source' | 'missing_target';
}

/** Response containing the configuration drift report between two orgs. */
export interface CompareDriftResponse extends BaseMessage {
  type: 'compare:drift:response';
  payload: {
    drift: {
      items: CompareDriftItem[];
      totalChecked: number;
      driftCount: number;
      matchCount: number;
      missingCount: number;
      detectedAt: string;
    };
  };
}

/** Error response for compare operations (emitted via sendHandlerError). */
export interface CompareErrorResponse extends BaseMessage {
  type: 'compare:error';
  payload: { message: string; code: string; retryable: boolean };
}
