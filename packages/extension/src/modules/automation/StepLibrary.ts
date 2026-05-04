import type { PipelineStepType } from '@sandforge/shared';

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
    description: 'Generate test data using AI or templates',
    category: 'data',
    icon: 'database',
    configSchema: { objectName: { type: 'string' }, count: { type: 'number' } },
  },
  {
    type: 'sync',
    label: 'Sync Data',
    description: 'Synchronize data between orgs or external sources',
    category: 'data',
    icon: 'sync',
    configSchema: {
      sourceOrg: { type: 'string' },
      targetOrg: { type: 'string' },
      objects: { type: 'array' },
    },
  },
  {
    type: 'backup',
    label: 'Backup',
    description: 'Create a backup snapshot of selected data',
    category: 'data',
    icon: 'archive',
    configSchema: { objects: { type: 'array' }, format: { type: 'string' } },
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
    description: 'Mask or anonymize sensitive fields in records',
    category: 'data',
    icon: 'shield',
    configSchema: { objects: { type: 'array' }, fields: { type: 'array' } },
  },
  {
    type: 'delete',
    label: 'Delete',
    description: 'Delete records matching specified criteria',
    category: 'data',
    icon: 'trash',
    configSchema: { objectName: { type: 'string' }, where: { type: 'string' } },
  },
  {
    type: 'compare',
    label: 'Compare Orgs',
    description: 'Compare metadata or data between two orgs',
    category: 'quality',
    icon: 'git-compare',
    configSchema: { sourceOrg: { type: 'string' }, targetOrg: { type: 'string' } },
  },
  {
    type: 'precheck',
    label: 'Pre-check',
    description: 'Run validation checks before proceeding',
    category: 'quality',
    icon: 'check-circle',
    configSchema: { checks: { type: 'array' } },
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
    type: 'loop',
    label: 'Loop',
    description: 'Repeat a set of steps for each item in a collection',
    category: 'control',
    icon: 'repeat',
    configSchema: { collection: { type: 'string' }, maxIterations: { type: 'number' } },
  },
  {
    type: 'parallel',
    label: 'Parallel',
    description: 'Execute multiple steps simultaneously',
    category: 'control',
    icon: 'layers',
    configSchema: { stepIds: { type: 'array' } },
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
    description: 'Pause and wait for manual approval to continue',
    category: 'control',
    icon: 'user-check',
    configSchema: { approvers: { type: 'array' }, message: { type: 'string' } },
  },
  {
    type: 'script',
    label: 'Script',
    description: 'Execute a custom script or Apex anonymous block',
    category: 'control',
    icon: 'code',
    configSchema: { language: { type: 'string' }, body: { type: 'string' } },
  },
  {
    type: 'notification',
    label: 'Notification',
    description: 'Send a notification via email, Slack, or other channels',
    category: 'notification',
    icon: 'bell',
    configSchema: {
      channel: { type: 'string' },
      message: { type: 'string' },
      recipients: { type: 'array' },
    },
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
   * Return the default configuration for a specific step type.
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
