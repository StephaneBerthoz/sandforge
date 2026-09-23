import type { BaseMessage } from './base.messages.js';
import type {
  BackupStatus,
  CleanupRecommendation,
  CleanupScanResult,
  DataQualityScanResult,
  DataQualityScanTarget,
  PiiInventoryResult,
  RemovalOutcome,
  RemovalPlanObject,
  SubjectEraseMode,
  SubjectIdentifiers,
  SubjectRequestLogEntry,
  SubjectSearchResult,
} from '../dataops.types.js';
import type { SavedTemplateMethod } from '../../constants/saved-anonymization-templates.js';
import type { GovernancePolicySummary } from '../governance.types.js';

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

/** One rule of a masking template as the host lists it: the `Object.Field` it masks, and how. */
export interface AnonymizationTemplateRule {
  fieldPattern: string;
  ruleType: string;
  description: string;
}

/** A masking template as the host lists it: one that ships, or one the user saved. */
export interface ListedAnonymizationTemplate {
  id: string;
  name: string;
  description: string;
  complianceFramework: string;
  rules: readonly AnonymizationTemplateRule[];
  /** True for a template the user saved, which can be deleted; absent for one that ships. */
  saved?: boolean;
}

/** Response containing available anonymization templates with their rules */
export interface AnonymizationTemplatesResponse extends BaseMessage {
  type: 'dataops:anonymization-templates:response';
  payload: { templates: ListedAnonymizationTemplate[] };
}

/**
 * Save rules as a named template of the user's, kept in extension storage
 * (validated by anonymizationTemplateSavePayloadSchema).
 */
export interface AnonymizationTemplateSaveRequest extends BaseMessage {
  type: 'dataops:anonymization-template:save';
  payload: {
    name: string;
    rules: Array<{ fieldPattern: string; ruleType: SavedTemplateMethod }>;
  };
}

/** The template saved, as the host will list it. */
export interface AnonymizationTemplateSaveResponse extends BaseMessage {
  type: 'dataops:anonymization-template:save:response';
  payload: { template: ListedAnonymizationTemplate };
}

/** Delete a template the user saved; one that ships is refused. */
export interface AnonymizationTemplateDeleteRequest extends BaseMessage {
  type: 'dataops:anonymization-template:delete';
  payload: { templateId: string };
}

/** Whether the template was there to delete. */
export interface AnonymizationTemplateDeleteResponse extends BaseMessage {
  type: 'dataops:anonymization-template:delete:response';
  payload: { templateId: string; deleted: boolean };
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
 * Measure the records of a few objects: fill counts, repeated values of a key,
 * records not modified for `staleDays` (validated by
 * dataOpsQualityScanPayloadSchema). Read-only: aggregate queries and describes.
 */
export interface DataOpsQualityScanRequest extends BaseMessage {
  type: 'dataops:quality-scan';
  payload: { orgId: string; objects: DataQualityScanTarget[]; staleDays: number };
}

/** Result of `dataops:quality-scan`; a scan that could not start fails on `dataops:error`. */
export interface DataOpsQualityScanResponse extends BaseMessage {
  type: 'dataops:quality-scan:response';
  payload: DataQualityScanResult;
}

/**
 * Which fields of a few objects hold personal data: the pre-flight PII
 * detector, confirmed on a bounded sample (validated by
 * dataOpsPiiInventoryPayloadSchema). Reads only.
 */
export interface DataOpsPiiInventoryRequest extends BaseMessage {
  type: 'dataops:pii-inventory';
  payload: { orgId: string; objects: string[] };
}

/** Result of `dataops:pii-inventory`: counts per field, never a value. */
export interface DataOpsPiiInventoryResponse extends BaseMessage {
  type: 'dataops:pii-inventory:response';
  payload: PiiInventoryResult;
}

/**
 * Find the records of a few objects that hold one person's address, name or
 * number (validated by dataOpsSubjectSearchPayloadSchema). Counted first, then
 * listed up to a bound. A search opens a request in the local log, or adds to
 * the one it names.
 */
export interface DataOpsSubjectSearchRequest extends BaseMessage {
  type: 'dataops:dsr:search';
  payload: SubjectIdentifiers & { orgId: string; objects: string[]; requestId?: string };
}

/** Result of `dataops:dsr:search`. */
export interface DataOpsSubjectSearchResponse extends BaseMessage {
  type: 'dataops:dsr:search:response';
  payload: SubjectSearchResult;
}

/**
 * Save every field of the records a request found to a JSON file the user
 * picks. The host reads, asks where, and writes: the records never cross the
 * bridge.
 */
export interface DataOpsSubjectExportRequest extends BaseMessage {
  type: 'dataops:dsr:export';
  payload: { orgId: string; requestId: string };
}

/** Result of `dataops:dsr:export`: how many records, and whether the file was written. */
export interface DataOpsSubjectExportResponse extends BaseMessage {
  type: 'dataops:dsr:export:response';
  payload: {
    requestId: string;
    records: number;
    saved:
      | { status: 'saved'; path: string }
      | { status: 'cancelled' }
      | { status: 'error'; message: string };
  };
}

/**
 * Erase records a request found: overwrite their personal data with the
 * DataOps anonymizer, or delete them — both through Production Guard. A dry
 * run answers what it would do and writes nothing.
 */
export interface DataOpsSubjectEraseRequest extends BaseMessage {
  type: 'dataops:dsr:erase';
  payload: {
    orgId: string;
    requestId: string;
    mode: SubjectEraseMode;
    /** The records to erase, each one the request found. */
    records: Array<{ objectApiName: string; ids: string[] }>;
    dryRun: boolean;
  };
}

/** Result of `dataops:dsr:erase`: the plan of a dry run, or what the run did. */
export interface DataOpsSubjectEraseResponse extends BaseMessage {
  type: 'dataops:dsr:erase:response';
  payload: {
    requestId: string;
    mode: SubjectEraseMode;
    dryRun: boolean;
    plan: RemovalPlanObject[];
    /** Absent on a dry run. */
    outcome?: RemovalOutcome;
  };
}

/** The local log of subject requests, newest first. */
export interface DataOpsSubjectLogRequest extends BaseMessage {
  type: 'dataops:dsr:log';
}

/** Result of `dataops:dsr:log`. */
export interface DataOpsSubjectLogResponse extends BaseMessage {
  type: 'dataops:dsr:log:response';
  payload: { entries: SubjectRequestLogEntry[] };
}

/**
 * Count, for a few objects, the records a cleanup would look at: not modified
 * for `staleDays`, orphans of a lookup the business relies on, repeated values
 * of a key. The quality scan's own request (validated by
 * dataOpsQualityScanPayloadSchema). Reads only.
 */
export interface DataOpsCleanupScanRequest extends BaseMessage {
  type: 'dataops:cleanup:scan';
  payload: { orgId: string; objects: DataQualityScanTarget[]; staleDays: number };
}

/** Result of `dataops:cleanup:scan`. */
export interface DataOpsCleanupScanResponse extends BaseMessage {
  type: 'dataops:cleanup:scan:response';
  payload: CleanupScanResult;
}

/** Save the records a recommendation names to a JSON file the user picks. */
export interface DataOpsCleanupExportRequest extends BaseMessage {
  type: 'dataops:cleanup:export';
  payload: { orgId: string; objectApiName: string; recommendation: CleanupRecommendation };
}

/** Result of `dataops:cleanup:export`. */
export interface DataOpsCleanupExportResponse extends BaseMessage {
  type: 'dataops:cleanup:export:response';
  payload: {
    objectApiName: string;
    records: number;
    /** More records are recommended than one export reads. */
    truncated: boolean;
    saved:
      | { status: 'saved'; path: string }
      | { status: 'cancelled' }
      | { status: 'error'; message: string };
  };
}

/**
 * Delete the records a recommendation names, through Production Guard. A dry
 * run answers how many it would delete and what the org would delete along
 * with them, and deletes nothing.
 */
export interface DataOpsCleanupDeleteRequest extends BaseMessage {
  type: 'dataops:cleanup:delete';
  payload: {
    orgId: string;
    objectApiName: string;
    recommendation: CleanupRecommendation;
    dryRun: boolean;
  };
}

/** Result of `dataops:cleanup:delete`. */
export interface DataOpsCleanupDeleteResponse extends BaseMessage {
  type: 'dataops:cleanup:delete:response';
  payload: {
    objectApiName: string;
    dryRun: boolean;
    plan: RemovalPlanObject;
    /** More records are recommended than one delete reads. */
    truncated: boolean;
    /** Absent on a dry run. */
    outcome?: RemovalOutcome;
  };
}

/**
 * Error response for dataops backup/rollback/anonymize/quality-scan failures
 * (emitted via sendHandlerError). Dual-channel note: `operation:failed` carries the
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
  payload: { policies: GovernancePolicySummary[] };
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
