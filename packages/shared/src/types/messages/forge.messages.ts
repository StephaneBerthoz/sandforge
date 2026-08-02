import type { BaseMessage } from './base.messages.js';
import type { ForgeConfig, ForgeGraph, ForgeTemplate } from '../forge.types.js';

/** `forge:preview`. WebView -> Extension. Preview records for a single source record. */
export interface ForgePreviewRequest extends BaseMessage {
  type: 'forge:preview';
  payload: { recordId: string; orgId: string };
}

/** `forge:discover`. WebView -> Extension. Build the dependency graph for a forge config. */
export interface ForgeDiscoverRequest extends BaseMessage {
  type: 'forge:discover';
  payload: { config: ForgeConfig };
}

/** `forge:execute`. WebView -> Extension. Execute a forge run over a discovered graph. */
export interface ForgeExecuteRequest extends BaseMessage {
  type: 'forge:execute';
  payload: { graph: ForgeGraph; config: ForgeConfig };
}

/** `forge:pause`. WebView -> Extension. Pause the running forge operation (no payload). */
export interface ForgePauseRequest extends BaseMessage {
  type: 'forge:pause';
}

/** `forge:resume`. WebView -> Extension. Resume a paused forge operation (no payload). */
export interface ForgeResumeRequest extends BaseMessage {
  type: 'forge:resume';
}

/** `forge:abort`. WebView -> Extension. Abort the running forge operation (no payload). */
export interface ForgeAbortRequest extends BaseMessage {
  type: 'forge:abort';
}

/** `forge:templates:list`. WebView -> Extension. List saved forge templates (no payload). */
export interface ForgeTemplatesListRequest extends BaseMessage {
  type: 'forge:templates:list';
}

/** `forge:templates:save`. WebView -> Extension. Persist a forge template to ConfigStore. */
export interface ForgeTemplatesSaveRequest extends BaseMessage {
  type: 'forge:templates:save';
  payload: { template: ForgeTemplate };
}

/** `forge:templates:delete`. WebView -> Extension. Delete a forge template by ID. */
export interface ForgeTemplatesDeleteRequest extends BaseMessage {
  type: 'forge:templates:delete';
  payload: { templateId: string };
}

/** `forge:history:list`. WebView -> Extension. List forge execution history (no payload). */
export interface ForgeHistoryListRequest extends BaseMessage {
  type: 'forge:history:list';
}

/** `forge:plan:request`. WebView -> Extension. Generate a wave-based execution plan. */
export interface ForgePlanRequest extends BaseMessage {
  type: 'forge:plan:request';
  payload: { graph: ForgeGraph; config: ForgeConfig };
}

/** `forge:compliance:request`. WebView -> Extension. Produce a PII compliance report. */
export interface ForgeComplianceRequest extends BaseMessage {
  type: 'forge:compliance:request';
  payload: { framework: string; graph: ForgeGraph; config: ForgeConfig };
}

/** `forge:metadata-diff:request`. WebView -> Extension. Diff object metadata between two orgs (max 100 objects). */
export interface ForgeMetadataDiffRequest extends BaseMessage {
  type: 'forge:metadata-diff:request';
  payload: { sourceOrgId: string; targetOrgId: string; objectApiNames: string[] };
}

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
