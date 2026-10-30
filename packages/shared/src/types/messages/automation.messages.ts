import type { BaseMessage } from './base.messages.js';
import type {
  PipelineMaskingTemplateInfo,
  PipelineRewindStepInfo,
  PipelineRewindStepInvalidReason,
  PipelineSeedTemplateInfo,
  PipelineSyncConfigInfo,
  PipelineTriggerStatus,
} from '../automation.types.js';

/**
 * Response for `pipeline:execute` — the pipeline execution
 * result bag (`{ status, stepResults, ... }`). No shared TS mirror of the
 * orchestrator result exists yet; the webview consumes it as
 * `Record<string, unknown>` (useAutomationPageData).
 */
export interface PipelineRunResponse extends BaseMessage {
  type: 'pipeline:run:response';
  payload: Record<string, unknown>;
}

/**
 * One step of a running pipeline, as it starts and as it ends, so the page's
 * execution view follows the run rather than showing every step pending until
 * the answer arrives. `operationId` is the id of the `pipeline:execute`
 * request that started the run.
 */
export interface PipelineStepUpdate extends BaseMessage {
  type: 'pipeline:step';
  payload: {
    operationId: string;
    stepId: string;
    status: 'running' | 'completed' | 'failed' | 'skipped';
    /** How long the step ran, in milliseconds, once it has ended. */
    duration?: number;
    /** What the step did (see `PipelineStepResult.summary`). */
    summary?: string;
    /** Why the step failed. */
    error?: string;
    /**
     * Set while an Approval step waits for an answer: the message it asks
     * with, and when it stops waiting. The page offers Approve and Reject
     * beside the step, as the VS Code notification does.
     */
    approval?: { message?: string; expiresAt: string };
  };
}

/**
 * The page's answer to an Approval step of the run it started, as Approve or
 * Reject beside the step. The first answer — this one or the notification's —
 * is the step's; one that comes after it changes nothing. No reply: the step's
 * end arrives on `pipeline:step`.
 */
export interface PipelineApprovalAnswerRequest extends BaseMessage {
  type: 'pipeline:approval';
  payload: { operationId: string; stepId: string; decision: 'approved' | 'rejected' };
}

/** The saved Sync configurations a pipeline's Sync step can run. */
export interface PipelineSyncConfigsRequest extends BaseMessage {
  type: 'pipeline:sync-configs';
}

/**
 * Each saved Sync configuration, with whether it reads and what Production
 * Guard does with a run of it — what the page checks a Sync step against
 * before Run, as the extension does before the run.
 */
export interface PipelineSyncConfigsResponse extends BaseMessage {
  type: 'pipeline:sync-configs:response';
  payload: { configs: PipelineSyncConfigInfo[] };
}

/** The Seed templates a pipeline's Seed step can run: those the Seed page saved, and those SandForge ships. */
export interface PipelineSeedTemplatesRequest extends BaseMessage {
  type: 'pipeline:seed-templates';
}

/**
 * Each Seed template, with whether it reads and whether it holds an AI rule —
 * what the page checks a Seed step against before Run, as the extension does
 * before the run.
 */
export interface PipelineSeedTemplatesResponse extends BaseMessage {
  type: 'pipeline:seed-templates:response';
  payload: { templates: PipelineSeedTemplateInfo[] };
}

/** The masking templates a pipeline's Anonymize step can run: those DataOps ships, and those its page saved. */
export interface PipelineMaskingTemplatesRequest extends BaseMessage {
  type: 'pipeline:masking-templates';
}

/** Each masking template, with the objects its rules name: what an Anonymize step offers to pick from. */
export interface PipelineMaskingTemplatesResponse extends BaseMessage {
  type: 'pipeline:masking-templates:response';
  payload: { templates: PipelineMaskingTemplateInfo[] };
}

/**
 * The Rewind steps of a saved pipeline, as the extension reads them on this
 * machine: whether each can rewind, and whether it is confirmed for its
 * configuration as saved. Asked again once the pipeline is saved: an edit on
 * the canvas changes nothing until then.
 */
export interface PipelineRewindStepsRequest extends BaseMessage {
  type: 'pipeline:rewind-steps';
  payload: { pipelineId: string };
}

/** The saved pipeline's Rewind steps, in pipeline order; none for a pipeline that is not saved. */
export interface PipelineRewindStepsResponse extends BaseMessage {
  type: 'pipeline:rewind-steps:response';
  payload: { pipelineId: string; steps: PipelineRewindStepInfo[] };
}

/**
 * Confirm a Rewind step of a saved pipeline, as the person typed it below its
 * preview: the org's alias, or its username when it has none. The extension
 * reads the step from the pipeline as saved, never from the page, compares
 * `typed` to the org it names character for character, checks the checkpoint
 * is kept here, valid and of that org, and keeps the confirmation on this
 * machine, bound to the step's configuration (`rewindGrantDigest`): saving a
 * change to it voids the confirmation, and changing it back does not bring
 * it back.
 */
export interface PipelineRewindGrantRequest extends BaseMessage {
  type: 'pipeline:rewind-grant';
  payload: { pipelineId: string; stepId: string; typed: string };
}

/**
 * Why a Rewind step's confirmation was not kept, as a code the page words in
 * the reader's language:
 *
 * - `NOT_SAVED`: the saved pipeline holds no Rewind step of that id — the
 *   page shows a pipeline or a step not saved yet, or one deleted since;
 * - `CONFIG_INVALID`: the saved step's configuration does not read
 *   (`pipelineRewindStepConfigSchema`); `reason` is its first issue;
 * - `ORG_UNKNOWN`: the org it names is not registered here;
 * - `CHECKPOINT_INVALID`: its checkpoint cannot be rewound to here; `why`
 *   says which way (`PipelineRewindStepInvalidReason`);
 * - `TYPED_MISMATCH`: what was typed is not the org's alias, or its username
 *   when it has none, character for character.
 */
export type PipelineRewindGrantRefusal =
  'NOT_SAVED' | 'CONFIG_INVALID' | 'ORG_UNKNOWN' | 'CHECKPOINT_INVALID' | 'TYPED_MISMATCH';

/** The step as it stands once confirmed, or why its confirmation was not kept: nothing kept then. */
export interface PipelineRewindGrantResponse extends BaseMessage {
  type: 'pipeline:rewind-grant:response';
  payload:
    | { granted: true; pipelineId: string; stepId: string; step: PipelineRewindStepInfo }
    | {
        granted: false;
        pipelineId: string;
        stepId: string;
        code: PipelineRewindGrantRefusal;
        /** With `CHECKPOINT_INVALID`: why the checkpoint cannot be rewound to. */
        why?: PipelineRewindStepInvalidReason;
        /** With `CONFIG_INVALID`: the schema's first issue. */
        reason?: string;
      };
}

/**
 * Take back a Rewind step's confirmation: the step no longer runs until a
 * person confirms it again. Nothing else of the pipeline changes.
 */
export interface PipelineRewindRevokeRequest extends BaseMessage {
  type: 'pipeline:rewind-revoke';
  payload: { pipelineId: string; stepId: string };
}

/** Whether a confirmation was kept for the step, and is no longer. */
export interface PipelineRewindRevokeResponse extends BaseMessage {
  type: 'pipeline:rewind-revoke:response';
  payload: { pipelineId: string; stepId: string; revoked: boolean };
}

/** Error response for pipeline operations (emitted via sendHandlerError). */
export interface PipelineErrorResponse extends BaseMessage {
  type: 'pipeline:error';
  payload: { message: string; code: string; retryable: boolean };
}

/** Pipeline templates */
export interface PipelineTemplatesRequest extends BaseMessage {
  type: 'pipeline:templates';
}

/** Response containing available pipeline templates */
export interface PipelineTemplatesResponse extends BaseMessage {
  type: 'pipeline:templates:response';
  payload: {
    templates: Array<{
      id: string;
      name: string;
      description: string;
      category: string;
      steps: Array<{ name: string; type: string; description: string }>;
    }>;
  };
}

/**
 * Runs a pipeline from an inline definition (AutomationHandler.handlePipelineRun);
 * answers on `pipeline:run:response`.
 */
export interface PipelineExecuteRequest extends BaseMessage {
  type: 'pipeline:execute';
  payload: { pipeline: Record<string, unknown>; variables?: Record<string, string> };
}

/** Request to list saved pipelines from ConfigStore. */
export interface PipelineListRequest extends BaseMessage {
  type: 'pipeline:list';
}

/**
 * Response containing the saved pipelines (`pipelines` category in
 * ConfigStore), and what each of their schedule and sandbox refresh triggers
 * will do. Beside the pipelines rather than inside them: a pipeline loaded
 * from this list is saved back as it is, and the status is not its own.
 */
export interface PipelineListResponse extends BaseMessage {
  type: 'pipeline:list:response';
  payload: { pipelines: Array<Record<string, unknown>>; triggers?: PipelineTriggerStatus[] };
}

/** Request to list pipeline execution history from ConfigStore. */
export interface PipelineHistoryRequest extends BaseMessage {
  type: 'pipeline:history';
}

/** Response containing pipeline execution history, sorted by timestamp descending. */
export interface PipelineHistoryResponse extends BaseMessage {
  type: 'pipeline:history:response';
  payload: { history: Array<Record<string, unknown>> };
}

/** Request to persist a pipeline configuration to ConfigStore. */
export interface PipelineSaveRequest extends BaseMessage {
  type: 'pipeline:save';
  payload: { id: string; config: Record<string, unknown> };
}

/** Response after persisting a pipeline configuration. */
export interface PipelineSaveResponse extends BaseMessage {
  type: 'pipeline:save:response';
  payload: { success: boolean; id: string };
}

/** Migration import (universal) */
export interface MigrationImportRequest extends BaseMessage {
  type: 'migration:import';
  payload: { filePath: string; format?: string };
}

/** Response after importing a migration file with detected format */
export interface MigrationImportResponse extends BaseMessage {
  type: 'migration:import:response';
  payload: {
    success: boolean;
    config?: Record<string, unknown>;
    detectedFormat?: string;
    error?: string;
  };
}

/** Migration import (SFDMU) */
export interface MigrationImportSfdmuRequest extends BaseMessage {
  type: 'migration:import-sfdmu';
  payload: { filePath: string };
}

/** Response after importing an SFDMU export.json with detected dependencies */
export interface MigrationImportSfdmuResponse extends BaseMessage {
  type: 'migration:import-sfdmu:response';
  payload: {
    success: boolean;
    config?: Record<string, unknown>;
    dependencies?: Array<{ from: string; to: string }>;
    error?: string;
  };
}

/**
 * Save the configuration the Migration page holds — as edited there, with
 * the two orgs picked there — as a Sync configuration under `name`: one the
 * Sync page lists among its saved configurations and a schedule can run.
 * Checked with the schema Sync checks its saved configurations with.
 */
export interface MigrationSaveSyncConfigRequest extends BaseMessage {
  type: 'migration:save-sync-config';
  payload: { name: string; config: Record<string, unknown> };
}

/**
 * Why a migration was not saved as a Sync configuration, as a code the page
 * words in the reader's language.
 *
 * - `NAME_REQUIRED`: no name was given.
 * - `DUPLICATE_NAME`: a saved Sync configuration already has that name.
 * - `SYNC_CANNOT_COPY`: Sync does not copy the objects in `objects`.
 * - `INVALID_CONFIG`: Sync's schema refuses the configuration; `reason` is
 *   its first issue, as the schema words it.
 */
export type MigrationSaveSyncConfigRefusal =
  'NAME_REQUIRED' | 'DUPLICATE_NAME' | 'SYNC_CANNOT_COPY' | 'INVALID_CONFIG';

/** The Sync configuration saved, or why none was. */
export interface MigrationSaveSyncConfigResponse extends BaseMessage {
  type: 'migration:save-sync-config:response';
  payload:
    | { success: true; id: string; name: string }
    | {
        success: false;
        code: MigrationSaveSyncConfigRefusal;
        /** With `SYNC_CANNOT_COPY`: the objects Sync does not copy. */
        objects?: string[];
        /** With `INVALID_CONFIG`: the schema's first issue. */
        reason?: string;
      };
}

/** Error response for migration import failures (emitted via sendHandlerError). */
export interface MigrationErrorResponse extends BaseMessage {
  type: 'migration:error';
  payload: { message: string; code: string; retryable: boolean };
}

/** Pipeline marketplace */
export interface MarketplaceListRequest extends BaseMessage {
  type: 'marketplace:list';
  payload?: { category?: string; query?: string };
}

/** Response containing available marketplace pipeline templates */
export interface MarketplaceListResponse extends BaseMessage {
  type: 'marketplace:list:response';
  payload: {
    success: boolean;
    templates?: Array<{
      id: string;
      name: string;
      description: string;
      category: string;
      author: string;
      /** The type of each step, so a card can say which of them cannot run in a pipeline yet. */
      stepTypes?: string[];
    }>;
    error?: string;
  };
}

/** Request to install a pipeline template from the marketplace */
export interface MarketplaceInstallRequest extends BaseMessage {
  type: 'marketplace:install';
  payload: { templateId: string };
}

/** Response after installing a marketplace template */
export interface MarketplaceInstallResponse extends BaseMessage {
  type: 'marketplace:install:response';
  payload: { success: boolean; pipeline?: Record<string, unknown>; error?: string };
}
