import type { z } from 'zod';
import type { BaseMessage } from './base.messages.js';
import type { seedConfigSchema } from '../../schemas/seed-config.schema.js';
import type {
  SeedTemplate,
  CsvImportConfig,
  CsvColumnMapping,
  CsvValidationResult,
  SeedExecutionResult,
  SeedRecordTypeOption,
  SeedRemovalResult,
  SeedRunRemovalInfo,
} from '../seed.types.js';
import type { CloneConfig, ClonePreviewResult, CloneExecutionResult } from '../clone.types.js';
import type { ForgeSweepListing } from '../forge.types.js';

/**
 * Seed messages.
 *
 * The payload is the template itself, as the webview sends it and as the
 * extension validates it — it named a `templateId` the handler never read.
 * The template type comes from the seed config schema, so a change to that
 * schema reaches this contract; SeedOpsHandler assigns its validated payload
 * to this type, which keeps the two from drifting apart unnoticed.
 *
 * `dryRun` is accepted only to be refused with DRY_RUN_UNSUPPORTED: a stored
 * request carrying it must be turned down by name rather than run as a real
 * seed that writes.
 */
export interface SeedExecuteRequest extends BaseMessage {
  type: 'seed:execute';
  payload: { orgId: string; template: z.input<typeof seedConfigSchema>; dryRun?: boolean };
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
 * One shape: the SeedOrchestrator result of a run that happened. A request
 * that cannot run is answered on `seed:error`, never with a summary of a run
 * that did not take place.
 */
export interface SeedExecuteResponse extends BaseMessage {
  type: 'seed:execute:response';
  payload: SeedExecutionResult;
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
      /** Digits a number field holds before its decimal point; 0 for other types. */
      integerDigits: number;
      /** The object described, which decides whose name a name field holds. */
      objectApiName: string;
    }>;
    /**
     * The record types the target offers the running user on the object,
     * person account types marked: what the panel lets a seed choose from.
     */
    recordTypes?: SeedRecordTypeOption[];
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

// ─── Seed Removal Messages ───────────────────────────────────────────────────

/**
 * `seed:removal:info`. WebView -> Extension. What a removal of a run's
 * records would take, and whether one can run, read from what the run kept —
 * nothing is asked of the org.
 */
export interface SeedRemovalInfoRequest extends BaseMessage {
  type: 'seed:removal:info';
  payload: { runId: string };
}

/** `seed:removal:info:response`. Extension -> WebView. `null` when nothing of the run is kept. */
export interface SeedRemovalInfoResponse extends BaseMessage {
  type: 'seed:removal:info:response';
  payload: { info: SeedRunRemovalInfo | null };
}

/**
 * `seed:removal:list`. WebView -> Extension. The Seed runs kept, newest first,
 * each with what a removal of it would take and whether one can run: the
 * runs of earlier windows too, read from the extension's storage.
 */
export interface SeedRemovalListRequest extends BaseMessage {
  type: 'seed:removal:list';
  payload: Record<string, never>;
}

/** `seed:removal:list:response`. Extension -> WebView. */
export interface SeedRemovalListResponse extends BaseMessage {
  type: 'seed:removal:list:response';
  payload: { runs: SeedRunRemovalInfo[] };
}

/**
 * `seed:remove`. WebView -> Extension. Remove from its org what a run
 * created, as the run kept it — the request names the run, never records.
 */
export interface SeedRemoveRequest extends BaseMessage {
  type: 'seed:remove';
  payload: {
    runId: string;
    /** Remove the records modified since the run too, and what was added to them since. */
    includeChanged?: boolean;
    /**
     * Sweep first what the target's automation created during the run, as
     * its user, that the run did not write.
     */
    sweep?: boolean;
  };
}

/**
 * `seed:remove:sweep`. WebView -> Extension. What a sweep asked with the
 * removal of a run would take, read only, for the confirmation to list.
 */
export interface SeedRemoveSweepRequest extends BaseMessage {
  type: 'seed:remove:sweep';
  payload: { runId: string };
}

/** `seed:remove:sweep:response`. Extension -> WebView. */
export interface SeedRemoveSweepResponse extends BaseMessage {
  type: 'seed:remove:sweep:response';
  payload: { runId: string; listing: ForgeSweepListing };
}

/** `seed:remove:sweep:error`. Extension -> WebView. The read of what a sweep would take failed. */
export interface SeedRemoveSweepErrorResponse extends BaseMessage {
  type: 'seed:remove:sweep:error';
  payload: { message: string; code: string; retryable: boolean };
}

/** `seed:remove:response`. Extension -> WebView. Also when the removal was cancelled part way. */
export interface SeedRemoveResponse extends BaseMessage {
  type: 'seed:remove:response';
  payload: { result: SeedRemovalResult; operationId: string };
}

/**
 * `seed:remove:error`. Extension -> WebView. A removal refused before it
 * started (`NOT_KEPT`, `NOTHING_TO_REMOVE`, `ALREADY_REMOVED`, `DUPLICATE`,
 * `ORG_GONE`, the guard's codes), one that failed, or a read of what a run
 * kept that failed.
 */
export interface SeedRemoveErrorResponse extends BaseMessage {
  type: 'seed:remove:error';
  payload: { message: string; code: string; retryable: boolean };
}

/**
 * `seed:open-record`. WebView -> Extension. Open in the browser the page of a
 * record a Seed run created, in the org it wrote to.
 *
 * The request names the run and the record, never an address: the extension
 * takes the object and the org from what the run kept, and opens only a
 * record the run says it created.
 */
export interface SeedOpenRecordRequest extends BaseMessage {
  type: 'seed:open-record';
  payload: {
    /** The run's id: its result's `operationId`. */
    runId: string;
    /** The record's id in the org the run wrote to. */
    recordId: string;
  };
}

/**
 * `seed:open-record:response`. Extension -> WebView. What the browser did:
 * VS Code may decline to open the page.
 */
export interface SeedOpenRecordResponse extends BaseMessage {
  type: 'seed:open-record:response';
  payload: { status: 'opened' } | { status: 'error'; message: string };
}

/**
 * `seed:open-record:error`. Extension -> WebView. The record was not opened:
 * the run is no longer kept (`NOT_KEPT`), it did not create that record
 * (`NOT_CREATED`), or its org is gone or has no address a page can be built
 * from (`ORG_NOT_FOUND`, `INVALID_INSTANCE_URL`).
 */
export interface SeedOpenRecordErrorResponse extends BaseMessage {
  type: 'seed:open-record:error';
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
