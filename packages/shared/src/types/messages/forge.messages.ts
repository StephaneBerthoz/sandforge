import type { BaseMessage } from './base.messages.js';

/**
 * `forge:target-preflight:request`. WebView -> Extension.
 *
 * Pre-execute target preflight: asks the extension to count existing rows
 * in the target org for each supplied object API name, so the wizard can
 * surface "X records already in target" before the user pulls the trigger.
 * Bounded server-side: max 100 objects per request, 30 s timeout.
 */
export interface ForgeTargetPreflightRequest extends BaseMessage {
  type: 'forge:target-preflight:request';
  payload: { targetOrgId: string; objectApiNames: string[] };
}

/** Per-object row count produced by the target preflight. */
export interface ForgeTargetPreflightCount {
  objectApiName: string;
  /** Row count, or the `-1` sentinel when the COUNT() query failed (FLS, non-queryable, ...). */
  existing: number;
}

/** `forge:target-preflight:response`. Extension -> WebView. */
export interface ForgeTargetPreflightResponse extends BaseMessage {
  type: 'forge:target-preflight:response';
  payload: { counts: ForgeTargetPreflightCount[] };
}

/**
 * `forge:target-preflight:error`. Extension -> WebView.
 *
 * Emitted via the shared `sendHandlerError` helper when the preflight fails
 * globally (connection error, timeout, ...). `code` is `'TIMEOUT'` or
 * `'PREFLIGHT_ERROR'`; `retryable` is true on timeouts.
 */
export interface ForgeTargetPreflightErrorMessage extends BaseMessage {
  type: 'forge:target-preflight:error';
  payload: { message: string; code: string; retryable: boolean };
}
