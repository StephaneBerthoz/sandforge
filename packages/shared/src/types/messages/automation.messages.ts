import type { BaseMessage } from './base.messages.js';

/** Pipeline messages */
export interface PipelineRunRequest extends BaseMessage {
  type: 'pipeline:run';
  payload: { pipelineId: string; variables?: Record<string, string> };
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
 * Alias of `pipeline:run` routed to the same AutomationHandler method, carrying
 * an inline pipeline definition instead of a stored ID.
 */
export interface PipelineExecuteRequest extends BaseMessage {
  type: 'pipeline:execute';
  payload: { pipeline: Record<string, unknown>; variables?: Record<string, string> };
}

/** Request to list saved pipelines from ConfigStore. */
export interface PipelineListRequest extends BaseMessage {
  type: 'pipeline:list';
}

/** Request to list pipeline execution history from ConfigStore. */
export interface PipelineHistoryRequest extends BaseMessage {
  type: 'pipeline:history';
}

/** Request to persist a pipeline configuration to ConfigStore. */
export interface PipelineSaveRequest extends BaseMessage {
  type: 'pipeline:save';
  payload: { id: string; config: Record<string, unknown> };
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

/** Plugin management */
export interface PluginsListRequest extends BaseMessage {
  type: 'plugins:list';
}

/** Response containing the list of installed plugins and their status */
export interface PluginsListResponse extends BaseMessage {
  type: 'plugins:list:response';
  payload: {
    success: boolean;
    plugins?: Array<{ name: string; version: string; description: string; enabled: boolean }>;
    error?: string;
  };
}

/** Request to load a plugin from a file path */
export interface PluginsLoadRequest extends BaseMessage {
  type: 'plugins:load';
  payload: { pluginPath: string };
}

/** Response after loading a plugin */
export interface PluginsLoadResponse extends BaseMessage {
  type: 'plugins:load:response';
  payload: { success: boolean; loadedPlugins?: string[]; error?: string };
}

/** Request to unload a plugin by name */
export interface PluginsUnloadRequest extends BaseMessage {
  type: 'plugins:unload';
  payload: { pluginName: string };
}

/** Response after unloading a plugin */
export interface PluginsUnloadResponse extends BaseMessage {
  type: 'plugins:unload:response';
  payload: { success: boolean; error?: string };
}
