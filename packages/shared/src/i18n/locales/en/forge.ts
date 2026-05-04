import type { TranslationRecord } from '../../types.js';

export const forge: TranslationRecord = {
  subtitle: 'Clone a full data graph between orgs with ID remapping and PII anonymization.',
  selectNode: 'Select a node to view details',
  objects: 'Objects',
  records: 'Records',
  estSize: 'Est. Size',
  estDuration: 'Est. Duration',
  executeForge: 'Execute Forge',
  abortConfirm: 'Are you sure you want to abort the current forge operation?',
  aborted: 'Forge operation aborted by user.',
  forging: 'FORGING...',
  paused: 'PAUSED',
  complete: 'COMPLETE',
  elapsed: 'Elapsed',
  done: 'Done',
  running: 'Running',
  queued: 'Queued',
  failed: 'Failed',
  resume: 'Resume',
  pause: 'Pause',
  abort: 'Abort',
  recordIdPlaceholder: 'Enter a Salesforce Record ID (e.g. 001xx000003DGbZ)',
  soqlPlaceholder: "SELECT Id FROM Account WHERE Industry = 'Technology'",
  noTemplates: 'No templates saved yet.',
  aiPlaceholder:
    'Describe the data you need (e.g. "All accounts with their contacts and opportunities")...',
  depthDirect: 'Direct only',
  depthFull: 'Full tree',
  depthCustom: 'Custom depth',
  sourceOrg: 'Source Org',
  targetOrg: 'Target Org',
  anonymizePII: 'Anonymize PII fields',
  skipEmpty: 'Skip empty objects',
  discoverGraph: 'Discover Graph',
  includeNode: 'Include in forge',
  piiFields: 'PII Fields',
  anonymize: 'Anonymize',
  anonymizationPreview: 'Anonymization Preview',
  fieldName: 'Field',
  before: 'Before',
  after: 'After',
  inserted: 'Inserted',
  skipped: 'Skipped',
  idRemaps: 'ID Remaps',
  successRate: 'Success Rate',
  object: 'Object',
  status: 'Status',
  errors: 'Errors',
  saveTemplate: 'Save as Template',
  copyReport: 'Copy Report',
  forgeAgain: 'Forge Again',
  templates: 'Templates',
  lastUsed: 'Last used',
  useTemplate: 'Use Template',
  deleteTemplate: 'Delete Template',
  metadataMismatch: 'Metadata mismatch detected between source and target orgs.',
  syncMetadata: 'Sync Metadata',
  skipMetadata: 'Skip',

  // Review phase
  'review.planTab': 'Plan',
  'review.anonymizationTab': 'Anonymization',
  'review.complianceTab': 'Compliance',
  'review.metadataTab': 'Metadata',
  'review.back': '← Back to Discovery',
  'review.wave': 'Wave',
  'review.planLoading': 'Generating execution plan...',
  'review.cycles': 'Cycle Resolutions',
  'review.category': 'Category',
  'review.method': 'Method',
  'review.anonymizationDesc':
    '{count} PII fields detected. Configure anonymization method per category.',
  'review.framework': 'Framework',
  'review.noCompliance': 'No compliance framework selected. Select one to generate a report.',
  'review.complianceLoading': 'Select a framework and execute to generate compliance report.',
  'review.complianceStatus': 'Status',
  'review.noDiffs': 'No metadata differences detected.',
  'review.diffsFound': '{count} differences found between source and target.',

  // Batch strategies
  'batch.auto': 'Auto',
  'batch.rest': 'REST API',
  'batch.bulk': 'Bulk API 2.0',

  // Anonymization categories
  'anon.email': 'Email',
  'anon.phone': 'Phone',
  'anon.name': 'Name (First/Last)',
  'anon.address': 'Address',
  'anon.ssn_id': 'SSN / National ID',
  'anon.financial': 'Financial',
  'anon.other': 'Other',

  // Input preview panel
  livePreview: 'Live Preview',
  estimatedGraph: 'Estimated Graph',
  piiWarning: '{count} PII fields detected',
  piiWarningHint: 'Enable anonymization to protect data',
  noOrgSelected: 'Select an org',
  depth: 'Depth',
  recordTab: 'Record',
  soqlTab: 'SOQL',
  templateTab: 'Template',
  aiTab: 'AI',

  // Record-volume cap (records per object during execution)
  recordLimit: 'Records per object',
  recordLimitHint: 'Cap how many rows are cloned per object. Lower = faster, safer on big orgs.',
  recordLimitAll: 'All',
  recordLimitOpt10: '10 / object (sample)',
  recordLimitOpt50: '50 / object',
  recordLimitOpt100: '100 / object',
  recordLimitOpt500: '500 / object',
  recordLimitOpt1000: '1000 / object',

  // Builtin starter templates
  starterBadge: 'Starter',
  starterTemplates: 'Starter templates',
  yourTemplates: 'Your templates',

  // Results enhancements
  exportJson: 'Export JSON',
  retryFailed: 'Retry Failed',
  anonymizedFields: 'Anonymized Fields',
  apiCallsConsumed: 'API Calls',
  logFilterAll: 'All',
  logFilterErrors: 'Errors',
  logFilterWarnings: 'Warnings',

  // Smart error translator (Pilier 3) — surfaced inline in the errors panel.
  error: {
    duplicateValue: {
      explanation:
        'A record with the same uniqueness key already exists in the target sandbox (likely cloned in a previous run).',
      action: 'Delete the existing record or switch to upsert mode (coming soon).',
    },
    invalidCrossReferenceKey: {
      explanation:
        "A reference field (Owner, Manager, ...) points to a User that doesn't exist in the target sandbox. The field was nullified automatically.",
      action:
        'Salesforce will assign the running User. No action required unless the record needs a specific Owner.',
    },
    requiredFieldMissing: {
      explanation: 'A required field is missing: {{detail}}.',
      action: 'Increase the depth or add the referenced parent manually to the scope.',
    },
    invalidPicklist: {
      explanation: "The source picklist value doesn't exist in the target sandbox (config drift).",
      action:
        'Align the picklists via Salesforce Setup or let the auto-strip handle it (silent skip).',
    },
    invalidFieldForInsert: {
      explanation:
        'A field cannot be set on insert (auto-computed, FLS, or missing from the target schema).',
      action:
        'Check field-level security (FLS) on your target profile, or align the source/target schemas.',
    },
    fieldIntegrity: {
      explanation: 'Salesforce integrity constraint violated: {{detail}}.',
      action: 'Read the detail — Salesforce usually names the offending field or business rule.',
    },
    cannotInsertEntity: {
      explanation:
        "This table is read-only (audit/history/system). Salesforce won't accept the insert.",
      action: 'This object is now skipped automatically by scope (isObjectCreatable).',
    },
    insufficientAccess: {
      explanation: "Your profile on the target sandbox doesn't have sufficient access.",
      action: 'Ask an admin to grant the required permissions or switch to an admin User.',
    },
    storageLimit: {
      explanation: 'The target sandbox has no storage left.',
      action: 'Clean up obsolete data or request a Salesforce quota increase.',
    },
    invalidType: {
      explanation: "The object type doesn't exist (likely deleted from the target).",
      action: 'Align the source/target schemas, or exclude this object from the scope.',
    },
    notFound: {
      explanation: 'The source record was not found.',
      action: 'Check the record ID and the source org.',
    },
    stringTooLong: {
      explanation: 'A value exceeds the field maximum length: {{detail}}.',
      action: 'Truncate the source value or align the field length across orgs.',
    },
    cycleFkUnresolved: {
      explanation:
        "Field '{{fieldName}}' references a parent that was never cloned (source ID {{sourceRefId}}). The record was inserted without the link.",
      action: 'Increase the depth to include the parent, or accept the disconnected record.',
    },
    outOfScope: {
      explanation: 'This object has no path to the root record — no parent in scope.',
      action:
        'Add this object manually via custom SOQL, or ignore (likely isolated reference data).',
    },
    unknown: {
      explanation: '{{detail}}',
      action:
        'Consult the Salesforce docs on this error code or report the raw message to support.',
    },
  },
};
