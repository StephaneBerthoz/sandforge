import type { PipelineCondition } from '../types/automation.types.js';

/** Category of a pipeline template */
export type TemplateCategory =
  'environment' | 'migration' | 'maintenance' | 'compliance' | 'monitoring';

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

/**
 * The templates the marketplace ships. Each runs once installed: every step
 * is one a pipeline runs, configured as its step check reads it, with the
 * orgs and a Sync step's saved configuration left for the person installing
 * it to choose (the page's `templateBlockers` holds every card to it). Most
 * of the fifteen it shipped held a step that never ran — a Pre-check of a
 * check SandForge does not have, a Restore, a Delete, an object list of
 * `__custom__`, a masking or a seed with no template —; those with a step
 * that runs in their place were rewritten, the others removed.
 *
 * Ids are kept across rewrites: a pipeline installed from a template is
 * saved under the template's id.
 */
export const BUILTIN_PIPELINE_TEMPLATES: readonly PipelineTemplate[] = [
  {
    id: 'tpl-sandbox-refresh',
    name: 'Sandbox Refresh Post-Processing',
    description:
      'Automate post-refresh tasks: anonymize data and seed test records, then show a notification.',
    category: 'environment',
    rating: 4.8,
    steps: [
      // The org of each step is asked for once installed, as a Backup's is:
      // the refreshed sandbox, which no template can name.
      {
        name: 'Anonymize PII',
        type: 'anonymize',
        config: { templateId: 'tpl-gdpr-standard' },
        description: 'Mask personal data after refresh',
      },
      {
        name: 'Seed Test Data',
        type: 'seed',
        config: { templateId: 'prebuilt-minimal-demo' },
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
    description:
      'Back up the accounts, contacts, opportunities and their line items of an org, into the backups the DataOps page lists and restores.',
    category: 'maintenance',
    rating: 4.7,
    steps: [
      {
        name: 'Backup Accounts',
        type: 'backup',
        config: { objects: ['Account', 'Contact'] },
        description: 'Back up accounts and contacts',
      },
      {
        name: 'Backup Opportunities',
        type: 'backup',
        config: { objects: ['Opportunity', 'OpportunityLineItem'] },
        description: 'Back up sales data',
      },
      {
        name: 'Show Notification',
        type: 'notification',
        config: { message: 'The nightly backup finished: the DataOps page lists it.' },
        description: 'Show a VS Code notification when the backups are taken',
      },
    ],
    tags: ['backup', 'nightly', 'scheduled'],
  },
  {
    id: 'tpl-dev-onboarding',
    name: 'New Developer Onboarding',
    description:
      'Fill a new developer sandbox with linked accounts, contacts, opportunities and cases, then leads, campaigns and activities.',
    category: 'environment',
    rating: 4.6,
    steps: [
      {
        name: 'Seed CRM Starter',
        type: 'seed',
        config: { templateId: 'prebuilt-crm-starter' },
        description: 'Create linked accounts, contacts, opportunities and cases',
      },
      {
        name: 'Seed Leads and Activities',
        type: 'seed',
        config: { templateId: 'prebuilt-leads-activities-starter' },
        description: 'Create leads, their campaigns, and the calls and meetings booked with them',
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
      "Read the target's API usage, storage and failed Apex jobs, then compare its Apex, flows, components and objects with the source org's.",
    category: 'environment',
    rating: 4.7,
    steps: [
      {
        name: 'Pre-Deployment Checks',
        type: 'precheck',
        config: { checks: ['apiLimits', 'storage', 'failedJobs'] },
        description: 'Read the target org before a release',
      },
      {
        name: 'Compare Metadata',
        type: 'compare',
        config: {
          types: [
            'ApexClass',
            'ApexTrigger',
            'Flow',
            'LightningComponentBundle',
            'CustomObject',
            'CustomField',
          ],
        },
        description: 'Compare metadata between orgs',
      },
    ],
    tags: ['release', 'validation', 'deployment'],
  },
  {
    id: 'tpl-mass-anonymization',
    name: 'Mass Anonymization',
    description:
      'Mask the personal data of every object the Sandbox Data Scrub template names, a snapshot of each value taken first.',
    category: 'compliance',
    rating: 4.6,
    steps: [
      {
        name: 'Anonymize PII',
        type: 'anonymize',
        config: { templateId: 'tpl-sandbox-scrub' },
        description: 'Mask the personal data of contacts, leads, accounts and opportunities',
      },
      {
        name: 'Show Notification',
        type: 'notification',
        config: { message: 'The masking finished: its snapshot is on the DataOps page.' },
        description: 'Show a VS Code notification when the masking is done',
      },
    ],
    tags: ['anonymization', 'bulk', 'compliance'],
  },
  {
    // The id predates the rename and is kept so pipelines already installed
    // from it still resolve.
    id: 'tpl-incremental-sync',
    name: 'Checked Sync',
    description:
      "Read the target's API usage and storage, then run a Sync configuration saved on the Sync page.",
    category: 'migration',
    rating: 4.5,
    steps: [
      {
        name: 'Check the Target',
        type: 'precheck',
        config: { checks: ['apiLimits', 'storage'] },
        description: 'Read API usage and storage before the sync',
      },
      {
        name: 'Sync Records',
        type: 'sync',
        config: {},
        description: 'Run the saved Sync configuration you choose',
      },
      {
        name: 'Show Notification',
        type: 'notification',
        config: { message: 'The sync finished: its counts are in the run history.' },
        description: 'Show a VS Code notification when the sync is done',
      },
    ],
    tags: ['sync', 'validation'],
  },
  {
    id: 'tpl-schema-drift',
    name: 'Schema Drift Detection',
    description:
      'Compare the objects, fields, record types, validation rules and layouts of two orgs, and show a notification when they differ.',
    category: 'monitoring',
    rating: 4.3,
    steps: [
      {
        name: 'Compare Schemas',
        type: 'compare',
        config: {
          types: ['CustomObject', 'CustomField', 'RecordType', 'ValidationRule', 'Layout'],
        },
        description: 'Compare the schemas of the two orgs',
      },
      {
        name: 'Any Difference',
        type: 'condition',
        config: {},
        condition: { field: 'compareDifferenceCount', operator: 'gt', value: 0 },
        description: 'Go on only when the schemas differ',
      },
      {
        name: 'Show Notification',
        type: 'notification',
        config: {
          message: 'Schema drift detection found differences: the run history lists the counts.',
        },
        description: 'Show a VS Code notification when the schemas differ',
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
    // The id of the Emergency Rollback it replaces, whose Restore step no
    // pipeline runs: a checkpoint taken first is what takes a write back.
    id: 'tpl-emergency-rollback',
    name: 'Protected Write',
    description:
      'Take a checkpoint of the target, then run a Sync configuration saved on the Sync page: Rewind… on the Checkpoints page returns the org to the checkpoint if the write went wrong.',
    category: 'maintenance',
    rating: 4.9,
    steps: [
      {
        name: 'Take a Checkpoint',
        type: 'checkpoint',
        config: { mode: 'everything', name: 'Before the protected write {date}' },
        description: 'Keep the data the write may change',
      },
      {
        name: 'Sync Records',
        type: 'sync',
        config: {},
        description: 'Run the saved Sync configuration you choose',
      },
      {
        name: 'Show Notification',
        type: 'notification',
        config: {
          message: 'The protected write finished: Rewind… on the Checkpoints page takes it back.',
        },
        description: 'Show a VS Code notification when the write is done',
      },
    ],
    tags: ['checkpoint', 'rewind', 'protected'],
  },
];
