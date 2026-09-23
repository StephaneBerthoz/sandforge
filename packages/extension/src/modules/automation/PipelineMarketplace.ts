import type { PipelineCondition } from '@sandforge/shared';

/** Category of a pipeline template */
export type TemplateCategory =
  | 'environment'
  | 'migration'
  | 'maintenance'
  | 'compliance'
  | 'monitoring';

/** A step definition within a pipeline template */
export interface TemplateStep {
  name: string;
  type: string;
  config: Record<string, unknown>;
  /**
   * What a Condition step tests, in the shape the router reads: the step's
   * `condition`, never its `config`. A condition written in `config` is no
   * condition at all, and the step is refused before the run.
   */
  condition?: PipelineCondition;
  description: string;
}

/** A reusable pipeline template from the marketplace */
export interface PipelineTemplate {
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  rating: number;
  steps: TemplateStep[];
  tags: string[];
}

/** Built-in templates shipped with the marketplace */
const BUILTIN_TEMPLATES: PipelineTemplate[] = [
  {
    id: 'tpl-sandbox-refresh',
    name: 'Sandbox Refresh Post-Processing',
    description:
      'Automate post-refresh tasks: anonymize data and seed test records, then show a notification.',
    category: 'environment',
    rating: 4.8,
    steps: [
      {
        name: 'Anonymize PII',
        type: 'anonymize',
        config: { objects: ['Contact', 'Lead'] },
        description: 'Mask personal data after refresh',
      },
      {
        name: 'Seed Test Data',
        type: 'seed',
        config: { count: 500 },
        description: 'Generate test records',
      },
      {
        name: 'Show Notification',
        type: 'notification',
        config: { message: 'Sandbox post-processing finished.' },
        description: 'Show a VS Code notification when the run gets here',
      },
    ],
    tags: ['sandbox', 'refresh', 'post-processing'],
  },
  {
    id: 'tpl-nightly-backup',
    name: 'Nightly Data Backup',
    description: 'Schedule a nightly backup of critical objects to a secure location.',
    category: 'maintenance',
    rating: 4.7,
    steps: [
      {
        name: 'Backup Accounts',
        type: 'backup',
        config: { objects: ['Account', 'Contact'] },
        description: 'Export account hierarchy',
      },
      {
        name: 'Backup Opportunities',
        type: 'backup',
        config: { objects: ['Opportunity', 'OpportunityLineItem'] },
        description: 'Export sales data',
      },
      {
        name: 'Verify Integrity',
        type: 'precheck',
        config: { checks: ['rowCount'] },
        description: 'Validate backup completeness',
      },
    ],
    tags: ['backup', 'nightly', 'scheduled'],
  },
  {
    id: 'tpl-weekly-quality',
    name: 'Weekly Data Quality Scan',
    description: 'Run weekly data quality checks and generate a report of anomalies.',
    category: 'monitoring',
    rating: 4.5,
    steps: [
      {
        name: 'Scan Duplicates',
        type: 'precheck',
        config: { checks: ['duplicates'] },
        description: 'Detect duplicate records',
      },
      {
        name: 'Check Completeness',
        type: 'precheck',
        config: { checks: ['completeness'] },
        description: 'Find records with missing required fields',
      },
      {
        name: 'Show Notification',
        type: 'notification',
        config: { message: 'The weekly data quality scan finished.' },
        description: 'Show a VS Code notification when the scan is done',
      },
    ],
    tags: ['quality', 'weekly', 'scan'],
  },
  {
    id: 'tpl-gdpr-compliance',
    name: 'GDPR Compliance Check',
    description: 'Verify GDPR compliance by scanning PII fields and consent records.',
    category: 'compliance',
    rating: 4.9,
    steps: [
      {
        name: 'Scan PII Fields',
        type: 'precheck',
        config: { checks: ['pii'] },
        description: 'Identify unprotected PII',
      },
      {
        name: 'Check Consent',
        type: 'precheck',
        config: { checks: ['consent'] },
        description: 'Validate consent records',
      },
      {
        name: 'Anonymize Non-Compliant',
        type: 'anonymize',
        config: { objects: ['Contact'] },
        description: 'Mask non-compliant data',
      },
      {
        name: 'Show Notification',
        type: 'notification',
        config: { message: 'The GDPR compliance check finished.' },
        description: 'Show a VS Code notification when the check is done',
      },
    ],
    tags: ['gdpr', 'compliance', 'privacy'],
  },
  {
    id: 'tpl-dev-onboarding',
    name: 'New Developer Onboarding',
    description: 'Provision a new developer sandbox with test data and standard configuration.',
    category: 'environment',
    rating: 4.6,
    steps: [
      {
        name: 'Seed Reference Data',
        type: 'seed',
        config: { count: 200 },
        description: 'Create base reference records',
      },
      {
        name: 'Seed Test Accounts',
        type: 'seed',
        config: { count: 50, objectName: 'Account' },
        description: 'Generate sample accounts',
      },
      {
        name: 'Configure Permissions',
        type: 'script',
        config: { language: 'apex' },
        description: 'Assign permission sets',
      },
      {
        name: 'Show Notification',
        type: 'notification',
        config: { message: 'The developer sandbox is provisioned.' },
        description: 'Show a VS Code notification when the sandbox is ready',
      },
    ],
    tags: ['onboarding', 'developer', 'environment'],
  },
  {
    id: 'tpl-release-validation',
    name: 'Release Validation',
    description:
      'Validate a release by running pre-checks, comparing orgs, and verifying data integrity.',
    category: 'environment',
    rating: 4.7,
    steps: [
      {
        name: 'Pre-Deployment Checks',
        type: 'precheck',
        config: { checks: ['permissions', 'limits'] },
        description: 'Verify org readiness',
      },
      {
        name: 'Compare Schema',
        type: 'compare',
        config: {},
        description: 'Compare metadata between orgs',
      },
      {
        name: 'Run Test Suite',
        type: 'script',
        config: { language: 'apex', body: 'System.runTests()' },
        description: 'Execute Apex tests',
      },
    ],
    tags: ['release', 'validation', 'deployment'],
  },
  {
    // The id predates the rename and is kept so pipelines already installed
    // from it still resolve. Nothing in this template previews: once sync
    // steps run, its sync step writes to the target org.
    id: 'tpl-migration-dry-run',
    name: 'Data Migration Check',
    description: 'Snapshot the source, check the field mappings, sync, then compare both orgs.',
    category: 'migration',
    rating: 4.4,
    steps: [
      {
        name: 'Export Source Data',
        type: 'backup',
        config: { objects: ['Account', 'Contact', 'Opportunity'] },
        description: 'Snapshot source records',
      },
      {
        name: 'Validate Mapping',
        type: 'precheck',
        config: { checks: ['mapping'] },
        description: 'Verify field mappings',
      },
      {
        name: 'Sync Records',
        type: 'sync',
        config: {},
        description: 'Sync step (records are not transferred by pipelines yet)',
      },
      {
        name: 'Compare Results',
        type: 'compare',
        config: {},
        description: 'Diff source vs target',
      },
    ],
    tags: ['migration', 'validation'],
  },
  {
    id: 'tpl-mass-anonymization',
    name: 'Mass Anonymization',
    description: 'Anonymize sensitive data across multiple objects in bulk.',
    category: 'compliance',
    rating: 4.6,
    steps: [
      {
        name: 'Anonymize Contacts',
        type: 'anonymize',
        config: { objects: ['Contact'], fields: ['Email', 'Phone'] },
        description: 'Mask contact PII',
      },
      {
        name: 'Anonymize Leads',
        type: 'anonymize',
        config: { objects: ['Lead'], fields: ['Email', 'Phone'] },
        description: 'Mask lead PII',
      },
      {
        name: 'Anonymize Users',
        type: 'anonymize',
        config: { objects: ['User'], fields: ['Email'] },
        description: 'Mask user emails',
      },
      {
        name: 'Verify Anonymization',
        type: 'precheck',
        config: { checks: ['pii'] },
        description: 'Confirm no PII remains',
      },
    ],
    tags: ['anonymization', 'bulk', 'compliance'],
  },
  {
    // The id predates the rename and is kept so pipelines already installed
    // from it still resolve. The sync step is a plain sync, not an
    // incremental one.
    id: 'tpl-incremental-sync',
    name: 'Checked Sync',
    description: 'Check recent changes, sync the configured objects, then validate record counts.',
    category: 'migration',
    rating: 4.5,
    steps: [
      {
        name: 'Detect Changes',
        type: 'precheck',
        config: { checks: ['lastModified'] },
        description: 'Identify modified records',
      },
      {
        name: 'Sync Records',
        type: 'sync',
        config: {},
        description: 'Sync step (records are not transferred by pipelines yet)',
      },
      {
        name: 'Verify Sync',
        type: 'precheck',
        config: { checks: ['rowCount'] },
        description: 'Validate record counts',
      },
    ],
    tags: ['sync', 'validation'],
  },
  {
    id: 'tpl-full-org-backup',
    name: 'Full Org Backup',
    description: 'Complete backup of all standard and custom objects in the org.',
    category: 'maintenance',
    rating: 4.8,
    steps: [
      {
        name: 'Backup Standard Objects',
        type: 'backup',
        config: { objects: ['Account', 'Contact', 'Opportunity', 'Case'] },
        description: 'Export standard objects',
      },
      {
        name: 'Backup Custom Objects',
        type: 'backup',
        config: { objects: ['__custom__'] },
        description: 'Export custom objects',
      },
      {
        name: 'Backup Metadata',
        type: 'backup',
        config: { objects: ['__metadata__'] },
        description: 'Export org metadata',
      },
      {
        name: 'Archive',
        type: 'script',
        config: { language: 'shell' },
        description: 'Compress and archive the backup',
      },
    ],
    tags: ['backup', 'full', 'archive'],
  },
  {
    id: 'tpl-schema-drift',
    name: 'Schema Drift Detection',
    description: 'Detect schema changes between environments to prevent drift issues.',
    category: 'monitoring',
    rating: 4.3,
    steps: [
      {
        name: 'Snapshot Source Schema',
        type: 'compare',
        config: { mode: 'schema' },
        description: 'Capture source org schema',
      },
      {
        name: 'Snapshot Target Schema',
        type: 'compare',
        config: { mode: 'schema' },
        description: 'Capture target org schema',
      },
      {
        name: 'Diff Schemas',
        type: 'compare',
        config: { mode: 'diff' },
        description: 'Compare schemas and report differences',
      },
      {
        name: 'Show Notification',
        type: 'notification',
        config: {
          message: 'Schema drift detection finished: the run history lists the differences.',
        },
        description: 'Show a VS Code notification when the comparisons are done',
      },
    ],
    tags: ['schema', 'drift', 'monitoring'],
  },
  {
    id: 'tpl-api-limit-monitoring',
    name: 'API Limit Monitoring',
    // The pre-check stops the run where the Monitor calls API usage critical,
    // above 80%, so the condition after it asks about the band below that,
    // where the Monitor starts to warn: tested at 80%, it could never hold
    // once the run got to it.
    description:
      'Check API usage against the daily limit: a notification past 60%, and the run stops past 80%.',
    category: 'monitoring',
    rating: 4.4,
    steps: [
      {
        name: 'Check API Usage',
        type: 'precheck',
        config: { checks: ['apiLimits'] },
        description: 'Read API consumption; the run stops here past 80%',
      },
      {
        name: 'Evaluate Thresholds',
        type: 'condition',
        config: {},
        condition: { field: 'apiUsagePercent', operator: 'gt', value: 60 },
        description: 'Go on only when usage exceeds 60%',
      },
      {
        name: 'Show Notification',
        type: 'notification',
        config: { message: 'API usage has passed 60% of the daily limit.' },
        description: 'Show a VS Code notification',
      },
    ],
    tags: ['api', 'limits', 'monitoring', 'governor'],
  },
  {
    id: 'tpl-stale-data-cleanup',
    name: 'Stale Data Cleanup',
    description:
      'Identify and remove stale records that have not been updated in a configurable period.',
    category: 'maintenance',
    rating: 4.2,
    steps: [
      {
        name: 'Identify Stale Records',
        type: 'precheck',
        config: { checks: ['staleness'], thresholdDays: 90 },
        description: 'Find records older than threshold',
      },
      {
        name: 'Backup Before Delete',
        type: 'backup',
        config: { objects: ['__stale__'] },
        description: 'Safety backup of stale records',
      },
      {
        name: 'Delete Stale Records',
        type: 'delete',
        config: { where: 'LastModifiedDate < LAST_N_DAYS:90' },
        description: 'Remove stale data',
      },
    ],
    tags: ['cleanup', 'stale', 'maintenance'],
  },
  {
    id: 'tpl-cross-org-sync',
    name: 'Cross-Org Data Sync',
    description: 'Synchronize data between two Salesforce orgs with conflict resolution.',
    category: 'migration',
    rating: 4.6,
    steps: [
      {
        name: 'Pre-Sync Validation',
        type: 'precheck',
        config: { checks: ['permissions', 'connectivity'] },
        description: 'Verify both orgs are accessible',
      },
      {
        name: 'Sync Accounts',
        type: 'sync',
        config: { objects: ['Account'], conflictResolution: 'sourceWins' },
        description: 'Sync account records',
      },
      {
        name: 'Sync Contacts',
        type: 'sync',
        config: { objects: ['Contact'], conflictResolution: 'sourceWins' },
        description: 'Sync contact records',
      },
      {
        name: 'Show Notification',
        type: 'notification',
        config: { message: 'The cross-org sync finished.' },
        description: 'Show a VS Code notification when the sync is done',
      },
    ],
    tags: ['sync', 'cross-org', 'migration'],
  },
  {
    id: 'tpl-emergency-rollback',
    name: 'Emergency Rollback',
    description: 'Restore data from the latest backup in case of critical failure.',
    category: 'maintenance',
    rating: 4.9,
    steps: [
      {
        name: 'Identify Latest Backup',
        type: 'precheck',
        config: { checks: ['backupExists'] },
        description: 'Locate most recent backup',
      },
      {
        name: 'Restore Data',
        type: 'restore',
        config: { backupId: 'latest' },
        description: 'Restore records from backup',
      },
      {
        name: 'Verify Restoration',
        type: 'precheck',
        config: { checks: ['rowCount', 'integrity'] },
        description: 'Validate restored data',
      },
      {
        name: 'Show Notification',
        type: 'notification',
        config: { message: 'The emergency rollback finished.' },
        description: 'Show a VS Code notification when the rollback is done',
      },
    ],
    tags: ['rollback', 'emergency', 'restore'],
  },
];

/**
 * Generates a RFC4122 v4 UUID via the platform crypto primitive.
 * Used internally to assign unique identifiers to imported templates.
 */
function generateId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Provides a marketplace of reusable pipeline templates.
 * Ships with 15 built-in templates and supports importing, exporting,
 * searching, and filtering templates by category.
 */
export class PipelineMarketplace {
  private readonly templates: Map<string, PipelineTemplate>;

  constructor() {
    this.templates = new Map(BUILTIN_TEMPLATES.map((t) => [t.id, t]));
  }

  /**
   * Return all available templates.
   * @returns Array of all pipeline templates
   */
  getTemplates(): PipelineTemplate[] {
    return [...this.templates.values()];
  }

  /**
   * Return templates filtered by category.
   * @param category - The category to filter by
   * @returns Array of templates matching the category
   */
  getByCategory(category: string): PipelineTemplate[] {
    return [...this.templates.values()].filter((t) => t.category === category);
  }

  /**
   * Retrieve a specific template by its ID.
   * @param id - The template ID to look up
   * @returns The template, or undefined if not found
   */
  getById(id: string): PipelineTemplate | undefined {
    return this.templates.get(id);
  }

  /**
   * Import a template from a JSON string.
   * Validates that the JSON contains the required fields and assigns a new ID.
   * @param json - JSON string representing a pipeline template
   * @returns The imported template with a fresh ID
   * @throws Error if the JSON is invalid or missing required fields
   */
  importTemplate(json: string): PipelineTemplate {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error(
        'Invalid JSON format: the template file could not be parsed as JSON. Check the file for syntax errors.',
      );
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Template must be a JSON object');
    }

    const obj = parsed as Record<string, unknown>;

    if (typeof obj['name'] !== 'string' || !obj['name']) {
      throw new Error('Template must have a non-empty "name" string');
    }

    if (typeof obj['description'] !== 'string') {
      throw new Error('Template must have a "description" string');
    }

    const validCategories: TemplateCategory[] = [
      'environment',
      'migration',
      'maintenance',
      'compliance',
      'monitoring',
    ];
    if (!validCategories.includes(obj['category'] as TemplateCategory)) {
      throw new Error(`Template "category" must be one of: ${validCategories.join(', ')}`);
    }

    if (!Array.isArray(obj['steps']) || obj['steps'].length === 0) {
      throw new Error('Template must have at least one step');
    }

    const template: PipelineTemplate = {
      id: generateId(),
      name: obj['name'] as string,
      description: obj['description'] as string,
      category: obj['category'] as TemplateCategory,
      rating: typeof obj['rating'] === 'number' ? obj['rating'] : 0,
      steps: (obj['steps'] as TemplateStep[]).map((step) => ({
        name: String(step.name ?? ''),
        type: String(step.type ?? ''),
        config: (step.config as Record<string, unknown>) ?? {},
        ...(typeof step.condition === 'object' && step.condition !== null
          ? { condition: step.condition }
          : {}),
        description: String(step.description ?? ''),
      })),
      tags: Array.isArray(obj['tags']) ? (obj['tags'] as string[]).map(String) : [],
    };

    this.templates.set(template.id, template);
    return template;
  }

  /**
   * Export a template as a JSON string.
   * @param id - The ID of the template to export
   * @returns JSON string representation of the template
   * @throws Error if the template is not found
   */
  exportTemplate(id: string): string {
    const template = this.templates.get(id);
    if (!template) {
      throw new Error(`Template not found: ${id}`);
    }
    return JSON.stringify(template, null, 2);
  }

  /**
   * Search templates by matching the query against name, description, and tags.
   * The search is case-insensitive.
   * @param query - The search term
   * @returns Array of templates matching the query
   */
  search(query: string): PipelineTemplate[] {
    const lowerQuery = query.toLowerCase();
    return [...this.templates.values()].filter((t) => {
      const nameMatch = t.name.toLowerCase().includes(lowerQuery);
      const descMatch = t.description.toLowerCase().includes(lowerQuery);
      const tagMatch = t.tags.some((tag) => tag.toLowerCase().includes(lowerQuery));
      return nameMatch || descMatch || tagMatch;
    });
  }
}
