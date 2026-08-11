import type { BaseMessage } from './base.messages.js';
import type {
  ForgeConfig,
  ForgeExecutionResult,
  ForgeGraph,
  ForgePlan,
  ForgeTemplate,
} from '../forge.types.js';
import type { ComplianceReport } from '../compliance.types.js';

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

// ─── Forge responses & events (Extension -> WebView) ────────────────────────

/** `forge:preview:response`. Extension -> WebView. Record preview for the wizard. */
export interface ForgePreviewResponse extends BaseMessage {
  type: 'forge:preview:response';
  payload: {
    objectApiName: string;
    objectLabel: string;
    recordId: string;
    fields: Array<{ name: string; value: string }>;
    estimatedRecordCount: number;
    totalFieldCount: number;
    estimatedSize: number;
  };
}

/**
 * `forge:preview:error`. Extension -> WebView.
 *
 * Dual emission path (see ForgeHandler.handleForgePreview): domain failures
 * (unknown key prefix, record not found) are posted via buildResponse with
 * only `{ message }`; unexpected failures go through sendHandlerError which
 * also sets `code` / `retryable`.
 */
export interface ForgePreviewErrorMessage extends BaseMessage {
  type: 'forge:preview:error';
  payload: { message: string; code?: string; retryable?: boolean };
}

/** `forge:discover:response`. Extension -> WebView. The discovered dependency graph. */
export interface ForgeDiscoverResponse extends BaseMessage {
  type: 'forge:discover:response';
  payload: { graph: ForgeGraph };
}

/**
 * `forge:discover:progress`. Extension -> WebView.
 *
 * Throttled (~10/s) progress event pushed during graph discovery. The payload
 * is the raw orchestrator progress event — its shape is not frozen (cast to
 * `Record<string, unknown>` at the emission site). No webview consumer
 * currently listens on this channel (the wizard only reads
 * `forge:discover:response` / `:error`).
 */
export interface ForgeDiscoverProgressMessage extends BaseMessage {
  type: 'forge:discover:progress';
  payload: Record<string, unknown>;
}

/** `forge:discover:error`. Extension -> WebView (emitted via sendHandlerError). */
export interface ForgeDiscoverErrorMessage extends BaseMessage {
  type: 'forge:discover:error';
  payload: { message: string; code: string; retryable: boolean };
}

/** `forge:execute:response`. Extension -> WebView. Final execution result. */
export interface ForgeExecuteResponse extends BaseMessage {
  type: 'forge:execute:response';
  payload: { result: ForgeExecutionResult; operationId: string };
}

/**
 * `forge:progress`. Extension -> WebView.
 *
 * Throttled (~10/s) per-node progress event pushed during execution
 * (terminal `done` / `error` states are flushed immediately). The payload is
 * the raw orchestrator event — observed keys are `objectName`, `status`,
 * `progress`, `message`, but the shape is not frozen (cast to
 * `Record<string, unknown>` at the emission site).
 */
export interface ForgeProgressMessage extends BaseMessage {
  type: 'forge:progress';
  payload: Record<string, unknown>;
}

/** `forge:execute:error`. Extension -> WebView (emitted via sendHandlerError). */
export interface ForgeExecuteErrorMessage extends BaseMessage {
  type: 'forge:execute:error';
  payload: { message: string; code: string; retryable: boolean };
}

/** `forge:templates:list:response`. Extension -> WebView. */
export interface ForgeTemplatesListResponse extends BaseMessage {
  type: 'forge:templates:list:response';
  payload: { templates: ForgeTemplate[] };
}

/** `forge:templates:save:response`. Extension -> WebView. */
export interface ForgeTemplatesSaveResponse extends BaseMessage {
  type: 'forge:templates:save:response';
  payload: { success: boolean };
}

/** `forge:templates:save:error`. Extension -> WebView (emitted via sendHandlerError). */
export interface ForgeTemplatesSaveErrorMessage extends BaseMessage {
  type: 'forge:templates:save:error';
  payload: { message: string; code: string; retryable: boolean };
}

/** `forge:templates:delete:response`. Extension -> WebView. */
export interface ForgeTemplatesDeleteResponse extends BaseMessage {
  type: 'forge:templates:delete:response';
  payload: { success: boolean };
}

/** `forge:templates:delete:error`. Extension -> WebView (emitted via sendHandlerError). */
export interface ForgeTemplatesDeleteErrorMessage extends BaseMessage {
  type: 'forge:templates:delete:error';
  payload: { message: string; code: string; retryable: boolean };
}

/** `forge:history:list:response`. Extension -> WebView. Past execution results, newest first. */
export interface ForgeHistoryListResponse extends BaseMessage {
  type: 'forge:history:list:response';
  payload: { history: ForgeExecutionResult[] };
}

/** `forge:plan:response`. Extension -> WebView. Wave-based execution plan. */
export interface ForgePlanResponse extends BaseMessage {
  type: 'forge:plan:response';
  payload: { plan: ForgePlan };
}

/** `forge:plan:error`. Extension -> WebView (emitted via sendHandlerError). */
export interface ForgePlanErrorMessage extends BaseMessage {
  type: 'forge:plan:error';
  payload: { message: string; code: string; retryable: boolean };
}

/**
 * `forge:compliance:response`. Extension -> WebView. PII compliance report;
 * `report` is `null` when the requested framework is `'none'`.
 */
export interface ForgeComplianceResponse extends BaseMessage {
  type: 'forge:compliance:response';
  payload: { report: ComplianceReport | null };
}

/** `forge:compliance:error`. Extension -> WebView (emitted via sendHandlerError). */
export interface ForgeComplianceErrorMessage extends BaseMessage {
  type: 'forge:compliance:error';
  payload: { message: string; code: string; retryable: boolean };
}

/**
 * `forge:metadata-diff:response`. Extension -> WebView. Per-object metadata
 * diff entries (extension-side MetadataDiffEntry — no shared TS mirror yet).
 */
export interface ForgeMetadataDiffResponse extends BaseMessage {
  type: 'forge:metadata-diff:response';
  payload: { diffs: Array<Record<string, unknown>> };
}

/** `forge:metadata-diff:error`. Extension -> WebView (emitted via sendHandlerError). */
export interface ForgeMetadataDiffErrorMessage extends BaseMessage {
  type: 'forge:metadata-diff:error';
  payload: { message: string; code: string; retryable: boolean };
}
