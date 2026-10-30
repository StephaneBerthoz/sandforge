import type { PipelineStepType } from '@sandforge/shared';
import { CHECKPOINT_STEP_DEFAULT_KEEP_DAYS } from '@sandforge/shared';

/** Categories for grouping step types */
export type StepCategory = 'data' | 'control' | 'notification' | 'quality';

/** Metadata describing a step type and its capabilities */
export interface StepTypeInfo {
  type: PipelineStepType;
  label: string;
  description: string;
  category: StepCategory;
  icon: string;
  configSchema: Record<string, unknown>;
}

/** Registry of all available pipeline step types with their metadata */
const STEP_REGISTRY: StepTypeInfo[] = [
  {
    type: 'seed',
    label: 'Seed Data',
    description:
      'Seed an org with a template saved on the Seed page or shipped with SandForge, never a production org; its records are taken back from Seed’s Recent runs',
    category: 'data',
    icon: 'database',
    // A template with an AI rule is refused: nobody watches a pipeline run.
    configSchema: { orgId: { type: 'string' }, templateId: { type: 'string' } },
  },
  {
    type: 'sync',
    label: 'Sync Data',
    description:
      'Run a Sync configuration saved on the Sync page; a target Production Guard asks about, a production org or a sandbox marked Staging, needs an Approval step before it',
    category: 'data',
    icon: 'sync',
    configSchema: { configId: { type: 'string' } },
  },
  {
    type: 'backup',
    label: 'Backup',
    description: 'Take a DataOps snapshot of the listed objects into local storage',
    category: 'data',
    icon: 'archive',
    configSchema: { orgId: { type: 'string' }, objects: { type: 'array' } },
  },
  {
    type: 'restore',
    label: 'Restore',
    description: 'Restore data from a previous backup snapshot',
    category: 'data',
    icon: 'history',
    configSchema: { backupId: { type: 'string' } },
  },
  {
    type: 'anonymize',
    label: 'Anonymize',
    description:
      'Mask an org with a DataOps template, after a snapshot of the values it writes over, never a production org',
    category: 'data',
    icon: 'shield',
    configSchema: {
      orgId: { type: 'string' },
      templateId: { type: 'string' },
      // One object, its rows held to a SOQL condition; every object the
      // template names when absent.
      object: { type: 'string', optional: true },
      where: { type: 'string', optional: true },
    },
  },
  {
    type: 'delete',
    label: 'Delete',
    description: 'Delete records matching specified criteria',
    category: 'data',
    icon: 'trash',
    configSchema: { objectName: { type: 'string' }, where: { type: 'string' } },
  },
  // Their configurations are read by `pipelineCheckpointStepConfigSchema`
  // and `pipelineRewindStepConfigSchema`; the defaults here are theirs: a
  // rewind refused while people are active, every acceptance off, and no
  // bound on records, which the step has to be given.
  {
    type: 'checkpoint',
    label: 'Checkpoint',
    description:
      'Take a checkpoint of a sandbox, a scratch org or a Developer Edition org, kept on this machine',
    category: 'data',
    icon: 'bookmark',
    configSchema: {
      orgId: { type: 'string' },
      mode: { type: 'string', default: 'everything' },
      objects: { type: 'array', optional: true },
      excluded: { type: 'array', optional: true },
      name: { type: 'string', optional: true },
      keepDays: { type: 'number', default: CHECKPOINT_STEP_DEFAULT_KEEP_DAYS },
      maxTotal: { type: 'number', optional: true },
      ignoredFields: { type: 'array', optional: true },
    },
  },
  {
    type: 'rewind',
    label: 'Rewind',
    description:
      'Put an org back to a checkpoint kept on this machine, once confirmed by typing the org’s alias, at most maxRecords records',
    category: 'data',
    icon: 'history',
    configSchema: {
      orgId: { type: 'string' },
      checkpointId: { type: 'string' },
      objects: { type: 'array', optional: true },
      acceptAutomation: { type: 'boolean', default: false },
      acceptNoUndo: { type: 'boolean', default: false },
      acceptRecreate: { type: 'boolean', default: false },
      acceptOutside: { type: 'boolean', default: false },
      acceptUnseen: { type: 'boolean', default: false },
      maxRecords: { type: 'number', required: true },
      refuseWhenActive: { type: 'boolean', default: true },
    },
  },
  {
    type: 'compare',
    label: 'Compare Orgs',
    description: 'Compare the metadata of two orgs, as the Compare page does',
    category: 'quality',
    icon: 'git-compare',
    configSchema: {
      sourceOrgId: { type: 'string' },
      targetOrgId: { type: 'string' },
      types: { type: 'array' },
    },
  },
  {
    type: 'precheck',
    label: 'Pre-check',
    description:
      'Read an org’s API usage, storage, error logs or failed jobs as the Monitor does; the run stops on a critical reading',
    category: 'quality',
    icon: 'check-circle',
    configSchema: { orgId: { type: 'string' }, checks: { type: 'array' } },
  },
  {
    type: 'condition',
    label: 'Condition',
    description: 'Branch pipeline execution based on conditions',
    category: 'control',
    icon: 'git-branch',
    configSchema: {
      field: { type: 'string' },
      operator: { type: 'string' },
      value: { type: 'string' },
    },
  },
  {
    type: 'delay',
    label: 'Delay',
    description: 'Wait for a specified duration before continuing',
    category: 'control',
    icon: 'clock',
    configSchema: { durationMs: { type: 'number' } },
  },
  {
    type: 'approval',
    label: 'Approval',
    description:
      'Pauses the run until someone approves it in VS Code; a rejection, or no answer in time, stops it',
    category: 'control',
    icon: 'user-check',
    // Whoever answers in the VS Code window that runs the pipeline: no list
    // of approvers, whom nothing could reach.
    configSchema: { message: { type: 'string' }, timeoutMinutes: { type: 'number' } },
  },
  {
    type: 'notification',
    label: 'Notification',
    description: 'Shows its message as a VS Code notification',
    category: 'notification',
    icon: 'bell',
    // No channel and no recipients: the message is shown in VS Code, to the
    // person running the pipeline, and sent nowhere else.
    configSchema: { message: { type: 'string' } },
  },
];

/**
 * Provides a registry of all available pipeline step types.
 * Each step type includes metadata such as labels, descriptions, icons,
 * and config schemas used by the UI to render step configuration forms.
 */
export class StepLibrary {
  private readonly registry: Map<PipelineStepType, StepTypeInfo>;

  constructor() {
    this.registry = new Map(STEP_REGISTRY.map((info) => [info.type, info]));
  }

  /**
   * Return all available step types.
   * @returns Array of step type metadata
   */
  getStepTypes(): StepTypeInfo[] {
    return [...this.registry.values()];
  }

  /**
   * Return metadata for a specific step type.
   * @param type - The step type to look up
   * @returns The step type info, or undefined if not found
   */
  getStepType(type: PipelineStepType): StepTypeInfo | undefined {
    return this.registry.get(type);
  }

  /**
   * Return the default configuration for a specific step type: a key's own
   * `default` when it declares one, none for an `optional` key or a
   * `required` one — a Rewind step's bound on records, which no default may
   * set — and an empty value of its type otherwise.
   * @param type - The step type to get defaults for
   * @returns A record of default config values (empty object if type not found)
   */
  getDefaultConfig(type: PipelineStepType): Record<string, unknown> {
    const info = this.registry.get(type);
    if (!info) {
      return {};
    }

    const defaults: Record<string, unknown> = {};
    for (const [key, schemaDef] of Object.entries(info.configSchema)) {
      const schema = schemaDef as Record<string, unknown>;
      if (schema['optional'] === true || schema['required'] === true) continue;
      if ('default' in schema) {
        defaults[key] = schema['default'];
        continue;
      }
      switch (schema['type']) {
        case 'string':
          defaults[key] = '';
          break;
        case 'number':
          defaults[key] = 0;
          break;
        case 'array':
          defaults[key] = [];
          break;
        case 'boolean':
          defaults[key] = false;
          break;
        default:
          defaults[key] = null;
      }
    }
    return defaults;
  }

  /**
   * Validate a step configuration against the step type schema.
   * Returns an array of validation error strings (empty if valid).
   * @param type - The step type to validate against
   * @param config - The config to validate
   * @returns Array of validation errors
   */
  validateStepConfig(type: PipelineStepType, config: Record<string, unknown>): string[] {
    const info = this.registry.get(type);
    if (!info) {
      return [`Unknown step type: ${type}`];
    }

    const errors: string[] = [];
    for (const [key, schemaDef] of Object.entries(info.configSchema)) {
      const schema = schemaDef as Record<string, unknown>;
      const value = config[key];
      const expectedType = schema['type'] as string;

      if (value === undefined || value === null) {
        continue;
      }

      if (expectedType === 'array' && !Array.isArray(value)) {
        errors.push(`Field "${key}" must be an array`);
      } else if (expectedType === 'string' && typeof value !== 'string') {
        errors.push(`Field "${key}" must be a string`);
      } else if (expectedType === 'number' && typeof value !== 'number') {
        errors.push(`Field "${key}" must be a number`);
      } else if (expectedType === 'boolean' && typeof value !== 'boolean') {
        errors.push(`Field "${key}" must be a boolean`);
      }
    }

    return errors;
  }

  /**
   * Return all unique step categories.
   * @returns Array of step category values
   */
  getStepCategories(): StepCategory[] {
    const categories = new Set<StepCategory>();
    for (const info of this.registry.values()) {
      categories.add(info.category);
    }
    return [...categories];
  }
}
