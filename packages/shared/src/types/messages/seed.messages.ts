import type { BaseMessage } from './base.messages.js';
import type {
  SeedTemplate,
  CsvImportConfig,
  CsvColumnMapping,
  CsvValidationResult,
} from '../seed.types.js';
import type { CloneConfig, ClonePreviewResult } from '../clone.types.js';

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
