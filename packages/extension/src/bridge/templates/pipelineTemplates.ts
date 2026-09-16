/** Predefined pipeline templates for automation workflows. */
export const PIPELINE_TEMPLATES = [
  {
    id: 'tpl-sandbox-refresh',
    name: 'Sandbox Refresh',
    description:
      'Full sandbox refresh: backup data, seed test data, verify deployment, run smoke tests.',
    category: 'environment',
    steps: [
      {
        name: 'Backup Target Data',
        type: 'dataops:backup',
        description: 'Export current target data before refresh.',
      },
      {
        name: 'Seed Test Data',
        type: 'seed:execute',
        description: 'Generate and insert test data from templates.',
      },
      {
        name: 'Verify Deployment',
        type: 'compare:execute',
        description: 'Compare metadata between source and target.',
      },
      {
        name: 'Run Smoke Tests',
        type: 'script:apex',
        description: 'Execute Apex smoke test suite.',
      },
    ],
  },
  {
    // The id predates the rename. It is shown to no one, and renaming it would
    // only change the `pipeline:templates` payload for no reader. The name
    // differs from the Marketplace's "Data Migration Check", which is a
    // different set of steps.
    id: 'tpl-data-migration-dry',
    name: 'Migration Pre-flight Check',
    description:
      'Describe source objects, deltas, field mappings and conflicts for a migration (steps do not run yet).',
    category: 'migration',
    steps: [
      {
        name: 'Describe Source Objects',
        type: 'sync:describe-global',
        description: 'List all queryable objects in source.',
      },
      {
        name: 'Detect Deltas',
        type: 'sync:delta',
        description: 'Identify new, modified, and deleted records.',
      },
      {
        name: 'Validate Field Mappings',
        type: 'sync:describe-fields',
        description: 'Verify field compatibility between orgs.',
      },
      {
        name: 'List Conflicts',
        type: 'sync:preview',
        description: 'List conflicts between source and target records.',
      },
    ],
  },
  {
    id: 'tpl-nightly-cleanup',
    name: 'Nightly Cleanup',
    description:
      'Scheduled cleanup: anonymize stale data, archive old records, refresh monitoring.',
    category: 'maintenance',
    steps: [
      {
        name: 'Anonymize PII',
        type: 'dataops:anonymize',
        description: 'Apply GDPR anonymization rules to sensitive data.',
      },
      {
        name: 'Archive Old Records',
        type: 'dataops:backup',
        description: 'Backup and archive records older than 90 days.',
      },
      {
        name: 'Refresh Monitor',
        type: 'monitor:refresh',
        description: 'Refresh org health and limit data.',
      },
    ],
  },
] as const;
