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
  SeedAutomationPreview,
  SeedRemovalResult,
  SeedRunRemovalInfo,
} from '../seed.types.js';
import type { CloneConfig, ClonePreviewResult, CloneExecutionResult } from '../clone.types.js';
import type { ForgeSweepListing } from '../forge.types.js';
import type { ScenarioCompileOptions, ScenarioPack } from '../scenario.types.js';
import type { AgentDefinition, AgentTestChoice } from '../../schemas/agentTestSpec.schema.js';
import type { ScenarioCasePicklists } from './ai.messages.js';

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
 * seed that writes. `locale` names the locale the people and places are drawn
 * in (`fr_FR`); absent, the org's default locale.
 */
export interface SeedExecuteRequest extends BaseMessage {
  type: 'seed:execute';
  payload: {
    orgId: string;
    template: z.input<typeof seedConfigSchema>;
    locale?: string;
    dryRun?: boolean;
    /**
     * Mute the target's automation for the run: assign the user it writes as,
     * for its duration, the permission sets holding the bypasses the target's
     * flows, processes and workflow rules test to stay quiet, and take them
     * back as it ends. Refused on a production org, and for a user who cannot
     * assign permission sets; what no bypass keeps quiet still runs, and is
     * asked about as ever.
     */
    muteAutomation?: boolean;
  };
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

/**
 * `seed:automation`. WebView -> Extension. What an org runs as a seed creates
 * the records of the given objects — its flows, Apex triggers, processes and
 * workflow rules, what of them sends emails or creates records, the bypasses
 * their start conditions name — and what it has left today of its daily email
 * limits. Read only, for the confirmation before Start.
 */
export interface SeedAutomationRequest extends BaseMessage {
  type: 'seed:automation';
  payload: { orgId: string; objects: string[] };
}

/** `seed:automation:response`. Extension -> WebView. The org and the objects asked about, and what was read. */
export interface SeedAutomationResponse extends BaseMessage {
  type: 'seed:automation:response';
  payload: { orgId: string; objects: string[]; preview: SeedAutomationPreview };
}

/** `seed:automation:error`. Extension -> WebView. The read could not run at all. */
export interface SeedAutomationErrorResponse extends BaseMessage {
  type: 'seed:automation:error';
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
    /**
     * Take every record the run created, not what its removals left: an undo
     * of a checkpoint's rewind brought back records its removal had found
     * gone (`backAfterRemoval`). Each is read before it is deleted, as ever;
     * the undo dated them anew, so they read as changed since the run.
     */
    again?: boolean;
    /**
     * Mute the target's automation for the run: assign the user it writes as,
     * for its duration, the permission sets holding the bypasses the target's
     * flows, processes and workflow rules test to stay quiet, and take them
     * back as it ends. Refused on a production org, and for a user who cannot
     * assign permission sets; what no bypass keeps quiet still runs, and is
     * asked about as ever.
     */
    muteAutomation?: boolean;
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

// ─── Scenario Messages (Agentforce test data) ───────────────────────────────

/**
 * A scenario pack the Seed gallery offers: one SandForge ships, one saved in
 * the workspace as a `*.sandforge-scenario.json` file, or a file of that name
 * that does not read as a pack, said with why rather than left out.
 */
export type SeedScenarioPackEntry =
  | { source: 'built-in'; pack: ScenarioPack }
  | { source: 'workspace'; path: string; relativePath: string; pack: ScenarioPack }
  | { source: 'workspace'; path: string; relativePath: string; issues: string[] };

/** `seed:scenario:packs`. WebView -> Extension. The packs SandForge ships, then the workspace's. */
export interface SeedScenarioPacksRequest extends BaseMessage {
  type: 'seed:scenario:packs';
  payload: Record<string, never>;
}

/** `seed:scenario:packs:response`. Extension -> WebView. `workspace` is false with no folder open. */
export interface SeedScenarioPacksResponse extends BaseMessage {
  type: 'seed:scenario:packs:response';
  payload: { packs: SeedScenarioPackEntry[]; workspace: boolean };
}

/**
 * What the Knowledge articles of a scenario meet in an org: no article object
 * (Knowledge off), and then none is written and the run stays a success; or
 * the fields of `Knowledge__kav` a body can be written to, read off its describe.
 */
export type SeedScenarioKnowledge =
  { available: false; reason: string } | { available: true; bodyFields: string[] };

/**
 * A pack compiled for an org: the choices the run is sent with, the org's own
 * case statuses among them, and what it writes.
 */
export interface SeedScenarioPreparation {
  /** What the run compiles the pack with, as it was compiled here. */
  options: ScenarioCompileOptions & {
    seed: number;
    caseStatus: { open: string; closed: string };
  };
  /**
   * Each object the run writes, in insert order, with its records; an
   * optional one is skipped by an org without it.
   */
  objects: Array<{ objectApiName: string; recordCount: number; optional?: boolean }>;
  /** The tests the pack's utterances make. */
  tests: number;
  /** Whether the statuses are the org's, or the defaults because the org would not say, with why. */
  caseStatusFrom: { from: 'org' } | { from: 'default'; reason: string };
  knowledge: SeedScenarioKnowledge;
}

/**
 * `seed:scenario:prepare`. WebView -> Extension. Compile a pack for an org,
 * read only: its case statuses and its articles' fields are read, nothing is
 * written.
 */
export interface SeedScenarioPrepareRequest extends BaseMessage {
  type: 'seed:scenario:prepare';
  payload: { orgId: string; pack: ScenarioPack; seed?: number; articleBodyField?: string };
}

/** `seed:scenario:prepare:response`. Extension -> WebView. The preparation, or every issue of the pack. */
export interface SeedScenarioPrepareResponse extends BaseMessage {
  type: 'seed:scenario:prepare:response';
  payload: { preparation?: SeedScenarioPreparation; issues?: string[] };
}

/**
 * `seed:scenario:execute`. WebView -> Extension. Seed an org from a pack,
 * compiled with the options its preparation answered: answered on
 * `seed:execute:response` with the run's result, its `scenario` set, or on
 * `seed:error`, as a template's seed is, and held to every gate a
 * template's seed is held to.
 */
export interface SeedScenarioExecuteRequest extends BaseMessage {
  type: 'seed:scenario:execute';
  payload: {
    orgId: string;
    pack: ScenarioPack;
    options: ScenarioCompileOptions;
    locale?: string;
  };
}

/** Where a test file can be written: a Salesforce DX project, a folder that is not one, or none open. */
export type SeedScenarioProject =
  { kind: 'dx'; dir: string } | { kind: 'folder'; dir: string } | { kind: 'none' };

/** How an org answered for its agents (`readAgentCatalog`). */
export type SeedScenarioAgents =
  | { kind: 'agents'; agents: AgentDefinition[] }
  | { kind: 'no-agent'; reason: 'none' | 'no-agentforce'; message: string }
  | { kind: 'unreadable'; object: string; message: string };

/**
 * `seed:scenario:agents`. WebView -> Extension. An org's Agentforce agents,
 * read only, with where a test file would be written and the org's Case
 * picklist values, which a draft is told.
 */
export interface SeedScenarioAgentsRequest extends BaseMessage {
  type: 'seed:scenario:agents';
  payload: { orgId: string };
}

/** `seed:scenario:agents:response`. Extension -> WebView. */
export interface SeedScenarioAgentsResponse extends BaseMessage {
  type: 'seed:scenario:agents:response';
  payload: {
    orgId: string;
    agents: SeedScenarioAgents;
    project: SeedScenarioProject;
    casePicklists?: ScenarioCasePicklists;
  };
}

/**
 * `seed:scenario:save`. WebView -> Extension. Save a pack in the workspace,
 * as `<id>.sandforge-scenario.json` at the first folder's root, never over a
 * file there unless `overwrite`.
 */
export interface SeedScenarioSaveRequest extends BaseMessage {
  type: 'seed:scenario:save';
  payload: { pack: ScenarioPack; overwrite?: boolean };
}

/** `seed:scenario:save:response`. Extension -> WebView. */
export interface SeedScenarioSaveResponse extends BaseMessage {
  type: 'seed:scenario:save:response';
  payload: {
    outcome:
      | { kind: 'saved'; path: string; relativePath: string }
      | { kind: 'exists'; path: string; relativePath: string }
      | { kind: 'no-workspace' };
  };
}

/** A test of the scenario the file leaves out, and why (`AgentTestLeftOut`). */
export interface SeedScenarioTestLeftOut {
  test: string;
  reason: 'case-not-written' | 'no-guard-topic';
  message: string;
}

/** A name of the user's choice the agent does not have, or why the choice cannot make tests. */
export interface SeedScenarioTestRefusal {
  code: string;
  name: string;
  message: string;
}

/** What writing a run's test file did. */
export type SeedScenarioTestFileOutcome =
  | {
      kind: 'written';
      path: string;
      /** Relative to the project, as the commands name it. */
      specPath: string;
      apiName: string;
      /** The two commands that create the test in the org and run it; absent outside a DX project. */
      commands?: { create: string; run: string };
      /** Set when the workspace is no DX project: `sf agent test create` runs from one. */
      notDxProject?: true;
      leftOut: SeedScenarioTestLeftOut[];
    }
  | { kind: 'exists'; path: string; specPath: string }
  | { kind: 'refused'; refusals: SeedScenarioTestRefusal[] }
  | { kind: 'no-agent'; reason: 'none' | 'no-agentforce'; message: string }
  /**
   * Nothing written, for want of what the file is made from: an open folder,
   * the run, its companion file, the pack it was seeded from, or the catalog.
   */
  | {
      kind: 'unavailable';
      reason:
        | 'no-workspace'
        | 'run-unknown'
        | 'no-companion'
        | 'companion-invalid'
        | 'pack-not-found'
        | 'catalog-unreadable';
      message: string;
    };

/**
 * `seed:scenario:test-file`. WebView -> Extension. Write the Agentforce test
 * file of a scenario's run into the workspace, from its companion file, with
 * the agent and the topics the user matched; never deployed, never run.
 */
export interface SeedScenarioTestFileRequest extends BaseMessage {
  type: 'seed:scenario:test-file';
  payload: { runId: string; choice: AgentTestChoice; overwrite?: boolean };
}

/** `seed:scenario:test-file:response`. Extension -> WebView. */
export interface SeedScenarioTestFileResponse extends BaseMessage {
  type: 'seed:scenario:test-file:response';
  payload: { runId: string; outcome: SeedScenarioTestFileOutcome };
}
