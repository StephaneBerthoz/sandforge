import type { BaseMessage } from './base.messages.js';
import type { BackupStatus } from '../dataops.types.js';

/** Backup messages */
export interface BackupExecuteRequest extends BaseMessage {
  type: 'backup:execute';
  payload: { configId: string };
}

/** Request the persisted backup history for one org. */
export interface BackupListRequest extends BaseMessage {
  type: 'backup:list';
  payload: { orgId: string };
}

/**
 * Result of `backup:list`. The channel is `:result`, not `:response`, because
 * that is what the DataOps page has always listened on — the request side was
 * simply never declared, so the broker rejected it before any handler saw it
 * and the backup list was permanently empty.
 */
export interface BackupListResult extends BaseMessage {
  type: 'backup:list:result';
  payload: { backups: BackupSummary[] };
}

/** One entry of the backup history, as persisted by dataops:backup. */
export interface BackupSummary {
  operationId: string;
  orgId: string;
  timestamp: string;
  totalRecords: number;
  totalSize: number;
  status: BackupStatus;
  objectResults: Array<{ objectApiName: string; recordCount: number }>;
}

/** Export one backup, records included, so it can leave the machine. */
export interface BackupExportRequest extends BaseMessage {
  type: 'backup:export';
  payload: { orgId: string; operationId: string };
}

/** Result of `backup:export` — a serialized document ready to download. */
export interface BackupExportResult extends BaseMessage {
  type: 'backup:export:result';
  payload: { operationId: string; filename: string; data: string };
}

/** Anonymization templates */
export interface AnonymizationTemplatesRequest extends BaseMessage {
  type: 'dataops:anonymization-templates';
}

/** Response containing available anonymization templates with their rules */
export interface AnonymizationTemplatesResponse extends BaseMessage {
  type: 'dataops:anonymization-templates:response';
  payload: {
    templates: Array<{
      id: string;
      name: string;
      description: string;
      complianceFramework: string;
      rules: Array<{ fieldPattern: string; ruleType: string; description: string }>;
    }>;
  };
}

// ─── Data Masking Template Messages ──────────────────────────────────────────

/** Request to get masking templates for a specific object. */
export interface MaskingTemplatesByObjectRequest extends BaseMessage {
  type: 'dataops:masking-templates-by-object';
  payload: { objectName: string };
}

/** Response containing masking templates for a specific object. */
export interface MaskingTemplatesByObjectResponse extends BaseMessage {
  type: 'dataops:masking-templates-by-object:response';
  payload: {
    objectName: string;
    templates: Array<{
      fieldApiName: string;
      ruleType: string;
      description: string;
      recommended: boolean;
    }>;
  };
}

/** PII detection pre-check */
export interface PIIScanRequest extends BaseMessage {
  type: 'precheck:pii-scan';
  payload: { orgId: string; objectNames: string[] };
}

/** Response from PII detection scan with detected fields per object */
export interface PIIScanResponse extends BaseMessage {
  type: 'precheck:pii-scan:response';
  payload: {
    success: boolean;
    results?: Array<{
      objectName: string;
      piiFields: Array<{ fieldName: string; piiType: string; confidence: number }>;
    }>;
    error?: string;
  };
}

// ─── DataOps operation messages ──────────────────────────────────────────────

/** Request to back up selected objects from an org (validated by dataOpsBackupPayloadSchema). */
export interface DataOpsBackupRequest extends BaseMessage {
  type: 'dataops:backup';
  payload: { orgId: string; objects: string[] };
}

/** Request to roll back a previous data operation (validated by dataOpsRollbackPayloadSchema). */
export interface DataOpsRollbackRequest extends BaseMessage {
  type: 'dataops:rollback';
  payload: { orgId: string; operationId: string };
}

/** Request to anonymize data with a masking template (validated by dataOpsAnonymizePayloadSchema). */
export interface DataOpsAnonymizeRequest extends BaseMessage {
  type: 'dataops:anonymize';
  payload: { orgId: string; templateId: string; objects?: string[] };
}

/** Response after a successful backup of the selected objects. */
export interface DataOpsBackupResponse extends BaseMessage {
  type: 'dataops:backup:response';
  payload: {
    operationId: string;
    status: string;
    objects: Array<{ objectApiName: string; recordCount: number }>;
    totalRecords: number;
    timestamp: string;
  };
}

/** Response after a successful rollback of a previous data operation. */
export interface DataOpsRollbackResponse extends BaseMessage {
  type: 'dataops:rollback:response';
  payload: { operationId: string; status: string; message: string; totalRestored: number };
}

/** Response after a successful anonymization run. */
export interface DataOpsAnonymizeResponse extends BaseMessage {
  type: 'dataops:anonymize:response';
  payload: { templateId: string; status: string; recordsProcessed: number; message: string };
}

/**
 * Error response for dataops backup/rollback/anonymize failures (emitted via
 * sendHandlerError). Dual-channel note: `operation:failed` carries the
 * lifecycle, `dataops:error` settles the in-flight webview mutation — the
 * webview surfaces the error from this channel only (see DataOpsHandler).
 */
export interface DataOpsErrorResponse extends BaseMessage {
  type: 'dataops:error';
  payload: { message: string; code: string; retryable: boolean };
}

// ─── Governance messages ─────────────────────────────────────────────────────

/** Request to list all governance policies (summaries). */
export interface GovernancePoliciesListRequest extends BaseMessage {
  type: 'governance:policies:list';
}

/**
 * Result of `governance:policies:list`. The channel is `:result` (not
 * `:response`) — same convention as `monitor:alerts:result` — because both
 * the handler and the webview consumer were built on it.
 */
export interface GovernancePoliciesListResult extends BaseMessage {
  type: 'governance:policies:result';
  payload: {
    policies: Array<{
      id: string;
      name: string;
      description: string;
      ruleCount: number;
      createdAt: string;
      updatedAt: string;
    }>;
  };
}

/** Request to get a single governance policy by ID. */
export interface GovernancePolicyGetRequest extends BaseMessage {
  type: 'governance:policy:get';
  payload: { policyId: string };
}

/**
 * Request to save (create or update) a governance policy. The policy object is
 * validated server-side by `GovernancePolicySchema` (extension GovernanceEngine
 * module); no shared TS mirror of that schema exists yet.
 */
export interface GovernancePolicySaveRequest extends BaseMessage {
  type: 'governance:policy:save';
  payload: { policy: Record<string, unknown> };
}

/** Request to delete a governance policy by ID. */
export interface GovernancePolicyDeleteRequest extends BaseMessage {
  type: 'governance:policy:delete';
  payload: { policyId: string };
}

/** Request to export all governance policies as a JSON string. */
export interface GovernancePoliciesExportRequest extends BaseMessage {
  type: 'governance:policies:export';
}

/** Request to import governance policies from a JSON string. */
export interface GovernancePoliciesImportRequest extends BaseMessage {
  type: 'governance:policies:import';
  payload: { json: string };
}

/** Request to evaluate a governance policy against live org limits. */
export interface GovernanceEvaluateRequest extends BaseMessage {
  type: 'governance:evaluate';
  payload: { policyId: string; orgId: string };
}

/** Request to list the default governance policy templates. */
export interface GovernanceTemplatesRequest extends BaseMessage {
  type: 'governance:templates';
}

/**
 * Result of `governance:policy:get` (`:result` channel, same convention as
 * `governance:policies:result`). The policy object is the extension-side
 * GovernancePolicy (validated by GovernancePolicySchema); no shared TS mirror
 * of that schema exists yet — see {@link GovernancePolicySaveRequest}.
 */
export interface GovernancePolicyResult extends BaseMessage {
  type: 'governance:policy:result';
  payload: { policy: Record<string, unknown> | null };
}

/**
 * Response for `governance:policy:save`. Dual-use channel: the success path is
 * posted via buildResponse (`{ success: true }`); a policy that fails
 * GovernancePolicySchema validation is reported on the same channel via
 * sendHandlerError (`{ message, code, retryable }`).
 */
export interface GovernancePolicySaveResponse extends BaseMessage {
  type: 'governance:policy:save:response';
  payload: { success?: boolean; message?: string; code?: string; retryable?: boolean };
}

/** Response after deleting a governance policy. */
export interface GovernancePolicyDeleteResponse extends BaseMessage {
  type: 'governance:policy:delete:response';
  payload: { success: boolean };
}

/** Response containing all governance policies as a JSON string. */
export interface GovernancePoliciesExportResponse extends BaseMessage {
  type: 'governance:policies:export:response';
  payload: { json: string };
}

/**
 * Response for `governance:policies:import`. Dual-use channel (same convention
 * as {@link GovernancePolicySaveResponse}): success via buildResponse,
 * failure via sendHandlerError on the same channel.
 */
export interface GovernancePoliciesImportResponse extends BaseMessage {
  type: 'governance:policies:import:response';
  payload: {
    success?: boolean;
    count?: number;
    message?: string;
    code?: string;
    retryable?: boolean;
  };
}

/**
 * Response for `governance:evaluate`. Dual-use channel (same convention as
 * {@link GovernancePolicySaveResponse}). `result` is the extension-side
 * GovernanceEvaluationResult (no shared TS mirror yet).
 */
export interface GovernanceEvaluateResponse extends BaseMessage {
  type: 'governance:evaluate:response';
  payload: {
    success?: boolean;
    result?: Record<string, unknown>;
    message?: string;
    code?: string;
    retryable?: boolean;
  };
}

/** Response containing the default governance policy templates. */
export interface GovernanceTemplatesResponse extends BaseMessage {
  type: 'governance:templates:response';
  payload: { templates: Array<Record<string, unknown>> };
}

/** Error response for governance operations (emitted via sendHandlerError). */
export interface GovernanceErrorResponse extends BaseMessage {
  type: 'governance:error';
  payload: { message: string; code: string; retryable: boolean };
}
