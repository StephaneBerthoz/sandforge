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
