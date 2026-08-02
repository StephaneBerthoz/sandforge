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
