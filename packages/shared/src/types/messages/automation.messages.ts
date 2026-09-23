import type { BaseMessage } from './base.messages.js';

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
  };
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

/** Response containing the saved pipelines (`pipelines` category in ConfigStore). */
export interface PipelineListResponse extends BaseMessage {
  type: 'pipeline:list:response';
  payload: { pipelines: Array<Record<string, unknown>> };
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
