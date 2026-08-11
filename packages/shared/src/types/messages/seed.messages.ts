import type { BaseMessage } from './base.messages.js';
import type {
  SeedTemplate,
  CsvImportConfig,
  CsvColumnMapping,
  CsvValidationResult,
  SeedExecutionResult,
} from '../seed.types.js';
import type { CloneConfig, ClonePreviewResult, CloneExecutionResult } from '../clone.types.js';

/** Seed messages */
export interface SeedExecuteRequest extends BaseMessage {
  type: 'seed:execute';
  payload: { templateId: string; orgId: string; dryRun: boolean };
}

/** Seed describe global objects request. */
export interface SeedDescribeGlobalRequest extends BaseMessage {
  type: 'seed:describe-global';
  payload: { orgId: string };
}

/** Seed describe single object fields request. */
export interface SeedDescribeObjectRequest extends BaseMessage {
  type: 'seed:describe-object';
  payload: { orgId: string; objectApiName: string };
}

/**
 * Response for seed execution (consumed by useQuickSeed / useSeedExecution).
 *
 * Dual shape: the real path posts the SeedOrchestrator result
 * ({@link SeedExecutionResult}); the dry-run short-circuit posts a synthetic
 * `{ success, dryRun, insertedCount, results }` summary instead.
 */
export interface SeedExecuteResponse extends BaseMessage {
  type: 'seed:execute:response';
  payload:
    | SeedExecutionResult
    | { success: boolean; dryRun: boolean; insertedCount: number; results: unknown[] };
}

/** Response containing describable (createable) objects of an org. */
export interface SeedDescribeGlobalResponse extends BaseMessage {
  type: 'seed:describe-global:response';
  payload: {
    objects: Array<{
      apiName: string;
      label: string;
      recordCount: number;
      dependencies: string[];
    }>;
  };
}

/** Response containing the createable fields of a single object. */
export interface SeedDescribeObjectResponse extends BaseMessage {
  type: 'seed:describe-object:response';
  payload: {
    objectApiName: string;
    objectLabel: string;
    fields: Array<{
      fieldApiName: string;
      label: string;
      type: string;
      required: boolean;
      picklistValues: string[];
      referenceTo: string[];
      length: number;
    }>;
  };
}

/**
 * Error response for seed template/describe/execute/persona failures (emitted
 * via sendHandlerError). Transport-level execute failures merge an extra
 * offline `retryHint` object into the payload (sendHandlerError extraPayload).
 */
export interface SeedErrorResponse extends BaseMessage {
  type: 'seed:error';
  payload: { message: string; code: string; retryable: boolean };
}

/** Request to save a seed template (create or update). */
export interface SeedTemplateSaveRequest extends BaseMessage {
  type: 'seed:template:save';
  payload: { template: SeedTemplate };
}

/** Request to load a seed template by ID. */
export interface SeedTemplateLoadRequest extends BaseMessage {
  type: 'seed:template:load';
  payload: { id: string };
}

/** Request to list all seed templates. */
export interface SeedTemplateListRequest extends BaseMessage {
  type: 'seed:template:list';
}

/** Request to delete a seed template by ID. */
export interface SeedTemplateDeleteRequest extends BaseMessage {
  type: 'seed:template:delete';
  payload: { id: string };
}

/** Response for seed template save. */
export interface SeedTemplateSaveResponse extends BaseMessage {
  type: 'seed:template:save:response';
  payload: { success: boolean; id: string };
}

/** Response for seed template load. */
export interface SeedTemplateLoadResponse extends BaseMessage {
  type: 'seed:template:load:response';
  payload: { template: SeedTemplate | null };
}

/** Response for seed template list. */
export interface SeedTemplateListResponse extends BaseMessage {
  type: 'seed:template:list:response';
  payload: {
    templates: Array<{
      id: string;
      name: string;
      description: string;
      tags: string[];
      updatedAt: string;
      objectCount: number;
      totalRecords: number;
    }>;
  };
}

/** Response for seed template delete. */
export interface SeedTemplateDeleteResponse extends BaseMessage {
  type: 'seed:template:delete:response';
  payload: { success: boolean };
}

// ── CSV Import messages ─────────────────────────────────────────────────────

/** Request to execute a CSV import into Salesforce. */
export interface SeedCsvExecuteRequest extends BaseMessage {
  type: 'seed:csv:execute';
  payload: CsvImportConfig;
}

/** Request to validate CSV data against Salesforce metadata. */
export interface SeedCsvValidateRequest extends BaseMessage {
  type: 'seed:csv:validate';
  payload: {
    orgId: string;
    objectApiName: string;
    records: Record<string, string>[];
    columnMappings: CsvColumnMapping[];
    externalIdField?: string;
  };
}

/** Response for CSV validation with typed errors. */
export interface SeedCsvValidateResponse extends BaseMessage {
  type: 'seed:csv:validate:response';
  payload: CsvValidationResult;
}

/**
 * Response for CSV import execution (see SeedCsvHandler.CsvExecutionResultPayload;
 * consumed by useCsvImport in the webview).
 */
export interface SeedCsvExecuteResponse extends BaseMessage {
  type: 'seed:csv:execute:response';
  payload: { insertedCount: number; failedCount: number; errors: string[] };
}

/** Error response for CSV validate/execute failures (emitted via sendHandlerError). */
export interface SeedCsvErrorResponse extends BaseMessage {
  type: 'seed:csv:error';
  payload: { message: string; code: string; retryable: boolean };
}

// ─── Clone Messages ─────────────────────────────────────────────────────────

/** Request to execute a clone operation from source to target org. */
export interface SeedCloneExecuteRequest extends BaseMessage {
  type: 'seed:clone:execute';
  payload: CloneConfig;
}

/** Request to preview a clone operation (counts, sample data, insert order). */
export interface SeedClonePreviewRequest extends BaseMessage {
  type: 'seed:clone:preview';
  payload: CloneConfig;
}

/** Response containing clone preview data. */
export interface SeedClonePreviewResponse extends BaseMessage {
  type: 'seed:clone:preview:response';
  payload: ClonePreviewResult;
}

/** Request to describe objects available on a source org for cloning. */
export interface SeedCloneDescribeSourceRequest extends BaseMessage {
  type: 'seed:clone:describe-source';
  payload: { sourceOrgId: string };
}

/** Response containing describable objects from the source org. */
export interface SeedCloneDescribeSourceResponse extends BaseMessage {
  type: 'seed:clone:describe-source:response';
  payload: { objects: Array<{ apiName: string; label: string; recordCount: number }> };
}

/** Response containing the clone execution result (consumed by useClone in the webview). */
export interface SeedCloneExecuteResponse extends BaseMessage {
  type: 'seed:clone:execute:response';
  payload: CloneExecutionResult;
}

/** Error response for clone describe/preview failures (emitted via sendHandlerError). */
export interface SeedCloneErrorResponse extends BaseMessage {
  type: 'seed:clone:error';
  payload: { message: string; code: string; retryable: boolean };
}

// ─── Persona Messages ────────────────────────────────────────────────────────

/** Persona field pattern describing how a specific field should be generated. */
export interface PersonaFieldPatternMsg {
  fieldType: string;
  generator: string;
  params?: Record<string, unknown>;
  examples: string[];
}

/** An AI persona for industry-specific data generation. */
export interface PersonaMsg {
  id: string;
  name: string;
  description: string;
  industry: string;
  locale: string;
  dataPatterns: Record<string, PersonaFieldPatternMsg>;
}

/** Request to list all available personas (built-in and custom). */
export interface SeedListPersonasRequest extends BaseMessage {
  type: 'seed:list-personas';
}

/** Response containing the list of all personas. */
export interface SeedListPersonasResponse extends BaseMessage {
  type: 'seed:list-personas:response';
  payload: { personas: PersonaMsg[] };
}

/** Request to create a custom persona from a text description. */
export interface SeedCreatePersonaRequest extends BaseMessage {
  type: 'seed:create-persona';
  payload: { description: string };
}

/** Response containing the newly created custom persona. */
export interface SeedCreatePersonaResponse extends BaseMessage {
  type: 'seed:create-persona:response';
  payload: { persona: PersonaMsg; success: boolean; error?: string };
}
