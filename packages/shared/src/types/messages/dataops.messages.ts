import type { BaseMessage } from './base.messages.js';

/** Backup messages */
export interface BackupExecuteRequest extends BaseMessage {
  type: 'backup:execute';
  payload: { configId: string };
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

// ─── Governance messages ─────────────────────────────────────────────────────

/** Request to list all governance policies (summaries). */
export interface GovernancePoliciesListRequest extends BaseMessage {
  type: 'governance:policies:list';
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
