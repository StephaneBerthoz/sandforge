import { BUILTIN_PIPELINE_TEMPLATES } from '@sandforge/shared';
import { DEV_SANDBOX, QA_SANDBOX } from './mock-orgs';

/**
 * What the extension answers when a run is refused, or an object or a field
 * stands in the way, and the states around it: the payloads behind each way
 * out the panel offers from a refusal — Quick Sync's three, the wizard's own
 * warnings, Migration's emptying, the storage refusals of Seed Clone, a CSV
 * import and a Frozen load, the Records at most of a checkpoint, the next
 * export of Cleanup, the cards of the Automation marketplace, Forge's
 * offers on Review and Monitor's resume refused. Shared by the specs that
 * check what each does and the scans that check what each paints.
 */

/** The preview Quick Sync keeps of contacts and the accounts they name. */
const QUICK_SYNC_PREVIEW = {
  objects: [
    {
      objectApiName: 'Account',
      recordCount: 1_200,
      estimatedApiCalls: 6,
      isParentDependency: true,
    },
    {
      objectApiName: 'Contact',
      recordCount: 30_000,
      estimatedApiCalls: 150,
      isParentDependency: false,
    },
  ],
  totalRecords: 31_200,
  totalApiCalls: 156,
  estimatedDurationSec: 90,
};

/**
 * Quick Sync on its preview of contacts and the accounts they name, from the
 * dev sandbox into the QA sandbox, as the panel keeps it between visits.
 */
export const QUICK_SYNC_ON_PREVIEW = {
  quickSyncDraft: {
    sourceOrgId: DEV_SANDBOX.id,
    targetOrgId: QA_SANDBOX.id,
    selectedObjects: ['Contact', 'Account'],
    parentObjects: ['Account'],
  },
  quickSyncStep: 'preview',
  quickSyncPreview: QUICK_SYNC_PREVIEW,
};

/** Quick Sync on its objects step between the two sandboxes, nothing picked yet. */
export const QUICK_SYNC_ON_OBJECTS = {
  quickSyncDraft: {
    sourceOrgId: DEV_SANDBOX.id,
    targetOrgId: QA_SANDBOX.id,
    selectedObjects: [],
    parentObjects: [],
  },
  quickSyncStep: 'objects',
};

/**
 * The objects Quick Sync suggests from the source, as
 * `quicksync:suggest-objects` answers: Case is not among those the source
 * lets SandForge read and create.
 */
export const QUICK_SYNC_SUGGESTIONS = {
  suggestions: [
    { objectApiName: 'Account', label: 'Account', isAvailable: true, isAlreadySelected: false },
    { objectApiName: 'Contact', label: 'Contact', isAvailable: true, isAlreadySelected: false },
    { objectApiName: 'Case', label: 'Case', isAvailable: false, isAlreadySelected: false },
  ],
  availableObjects: ['Account', 'Contact', 'Opportunity'],
};

/** Why Case is struck among the suggestions, as the chip says it. */
export const CASE_NOT_IN_SOURCE =
  'Case is not among the objects the source org lets SandForge read and create.';

/** The Sync run gate's refusal of records past the target's data storage, on `sync:error`. */
export const SYNC_STORAGE_REFUSAL = {
  message:
    `The records to write take about 9.2 MB of data storage, and ${QA_SANDBOX.alias} has 2 MB ` +
    `left of 5 MB: leave objects out, narrow their filters, or free data storage in ` +
    `${QA_SANDBOX.alias}. Nothing was written.`,
  code: 'SYNC_STORAGE_EXCEEDED',
  retryable: false,
};

/** What Quick Sync says of that refusal, in place of the wizard's words it has no use for. */
export const QUICK_SYNC_STORAGE_WORDS =
  'The sync was refused before it wrote anything: its records take more data storage than the ' +
  'target org has left. Quick Sync has no filter: leave objects out here, or open them in the ' +
  'wizard, where each object takes a filter. To copy part of the source that fits the target, ' +
  'use Forge with Depth ALL and Records per object set to A sample that fits the target. Or free ' +
  'data storage in the target org: DataOps → Cleanup → Empty objects deletes what it holds of ' +
  'these objects.';

/** A draft of the Sync wizard on its execute step: one object upserted, ready to simulate. */
export const SYNC_READY_DRAFT = {
  currentStep: 4,
  direction: 'source_to_target',
  mode: 'full',
  conflictStrategy: 'source_wins',
  sourceOrgId: DEV_SANDBOX.id,
  targetOrgId: QA_SANDBOX.id,
  objectEntries: [
    {
      objectApiName: 'Invoice__c',
      operation: 'insert',
      externalIdField: '',
      batchSize: 200,
      where: '',
    },
  ],
  mappingsByObject: {},
  transforms: [],
};

/**
 * What a simulation of that draft answers: its write check finds the target
 * cannot take Invoice__c, for `why`.
 */
export function simulationWithUnwritable(
  why: 'notInTarget' | 'notCreateable',
): Record<string, unknown> {
  return {
    configId: 'cfg-ways-out',
    operationId: 'sim-ways-out',
    direction: 'source_to_target',
    conflictStrategy: 'source_wins',
    objects: [
      {
        objectApiName: 'Invoice__c',
        operation: 'insert',
        read: 12,
        insert: 12,
        update: 0,
        delete: 0,
        skipped: 0,
        refused: 0,
        conflicts: 0,
        conflictFields: [],
        notes: [],
      },
    ],
    duration: 640,
    timestamp: '2026-11-14T09:00:00.000Z',
    writeCheck: {
      objects: [{ objectApiName: 'Invoice__c', rows: 12 }],
      total: 12,
      alreadyCopied: 0,
      storage: { verdict: 'fits', estimateMB: 0.03, maxMB: 5, remainingMB: 4 },
      emails: [],
      unwritable: [{ objectApiName: 'Invoice__c', rows: 12, why }],
      apiRequests: { verdict: 'fits', estimate: 2, remaining: 14_000, max: 15_000 },
      verdict: 'asks',
    },
  };
}

/** An object of an SFDMU export as Migration imports it. */
function importedObject(objectApiName: string, insertOrder: number): Record<string, unknown> {
  return {
    objectApiName,
    operation: 'insert',
    fieldMappings: [],
    transformRules: [],
    excludedFields: [],
    addOnFields: [],
    batchSize: 200,
    insertOrder,
  };
}

/**
 * An SFDMU export Migration imports, whose `deleteOldData` emptied Account
 * and Contact in the target first: the notes say Sync does not carry it.
 */
export const SFDMU_IMPORT_DELETING_FIRST = {
  success: true,
  config: {
    id: 'cfg-sfdmu',
    name: 'SFDMU Import',
    sourceOrgId: 'imported-source',
    targetOrgId: 'imported-target',
    direction: 'source_to_target',
    mode: 'full',
    objects: [importedObject('Account', 1), importedObject('Contact', 2)],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    createdAt: '2026-11-01T08:00:00.000Z',
    updatedAt: '2026-11-01T08:00:00.000Z',
  },
  notes: [
    { code: 'deleteOldData', object: 'Account' },
    { code: 'deleteOldData', object: 'Contact' },
    { code: 'notMaster', object: 'Contact' },
  ],
};

/** The objects a Seed Clone describes in the source. */
export const CLONE_SOURCE_OBJECTS = {
  objects: [
    { apiName: 'Account', label: 'Account', recordCount: 4_000 },
    { apiName: 'Contact', label: 'Contact', recordCount: 18_000 },
    { apiName: 'Invoice__c', label: 'Invoice', recordCount: 40 },
  ],
};

/** The preview of accounts and contacts a Seed Clone answers with. */
export const CLONE_PREVIEW = {
  objects: [
    {
      objectApiName: 'Account',
      recordCount: 4_000,
      sampleRecords: [{ Name: 'Acme' }],
      relationships: [],
    },
    {
      objectApiName: 'Contact',
      recordCount: 18_000,
      sampleRecords: [{ LastName: 'Doe' }],
      relationships: [{ field: 'AccountId', referenceTo: 'Account' }],
    },
  ],
  insertOrder: ['Account', 'Contact'],
};

/**
 * The `operation:failed` of a Seed Clone refused for the data storage its
 * records take in the target, the panel's org, with the figures the
 * extension measured.
 */
export function cloneStorageFailure(operationId: string): Record<string, unknown> {
  return {
    operationId,
    error:
      `The clone was refused before it wrote anything: its records take about 12.3 MB of data ` +
      `storage, and ${DEV_SANDBOX.alias} has 4 MB left of 5 MB. Nothing was written.`,
    retryable: false,
    code: 'CLONE_STORAGE_EXCEEDED',
    org: DEV_SANDBOX.alias,
    estimateMB: 12.3,
    remainingMB: 4,
    maxMB: 5,
    heaviest: [
      { objectApiName: 'Contact', rows: 18_000, mb: 9.1 },
      { objectApiName: 'Account', rows: 4_000, mb: 3.2 },
    ],
  };
}

/** What the page says of that refusal, from its figures. */
export const CLONE_STORAGE_WORDS =
  `The clone was refused before it wrote anything: its records take about 12.3 MB of data ` +
  `storage, and ${DEV_SANDBOX.alias} has 4 MB left of 5 MB. The heaviest: Contact (18,000 ` +
  `records, 9.1 MB) and Account (4,000 records, 3.2 MB). Narrow their filter or leave them out, ` +
  `then preview again; or copy a sample of the source that fits with Forge: Depth ALL, Records ` +
  `per object “A sample that fits the target”.`;

/** The `seed:clone:error` of a preview naming an object the target does not show. */
export const OBJECT_NOT_IN_TARGET_REFUSAL = {
  message: 'NOT_FOUND: The requested resource does not exist',
  code: 'OBJECT_NOT_IN_TARGET',
  retryable: false,
  objectApiName: 'Invoice__c',
  org: DEV_SANDBOX.alias,
};

/** What the page says of it, with the two ways on. */
export const OBJECT_NOT_IN_TARGET_WORDS =
  `Invoice__c is not in ${DEV_SANDBOX.alias}, or the user SandForge connects as there may not ` +
  `see it, and nothing was written: untick it to clone the others, or deploy it to ` +
  `${DEV_SANDBOX.alias} first with Compare (Deploy from Diff) and give that user access to it.`;

/** The `seed:csv:error` of a CSV import refused for the data storage its rows take. */
export const CSV_STORAGE_REFUSAL = {
  message:
    `The import was refused before it wrote anything: its 3 rows take about 0.01 MB of data ` +
    `storage, and ${QA_SANDBOX.alias} has 0 MB left of 5 MB, room for about 1 of them. Nothing ` +
    `was written.`,
  code: 'CSV_STORAGE_EXCEEDED',
  retryable: false,
  org: QA_SANDBOX.alias,
  rows: 3,
  fitting: 1,
  estimateMB: 0.006,
  remainingMB: 0,
  maxMB: 5,
};

/** What the page says of it: the ways out are the file's. */
export const CSV_STORAGE_WORDS =
  `The import was refused before it wrote anything: its 3 rows take about 0.01 MB of data ` +
  `storage, and ${QA_SANDBOX.alias} has 0 MB left of 5 MB, room for about 1 of them. Split the ` +
  `file and import one part at a time, freeing data storage in ${QA_SANDBOX.alias} in between ` +
  `as needed.`;

/** A frozen dataset ready to load, never loaded yet. */
export const FROZEN_STATUS_TO_LOAD = {
  configured: true,
  sasDir: '/home/qa/.sandforge-sas',
  datasetDir: '/home/qa/.sandforge-sas/dataset',
  salt: { present: true, fingerprint: 'abc123def456' },
  mockDetectionConfigured: false,
  selection: null,
  manifest: {
    version: '0.1.0',
    status: 'frozen',
    frozenAt: '2026-11-10T10:00:00.000Z',
    source: { orgId: DEV_SANDBOX.id, decisionDate: '2026-11-10T09:00:00.000Z' },
    saltFingerprint: 'abc123def456',
    rulesVersion: '1.0.0',
    volumetry: {
      budgetMax: 2500,
      measured: { Opportunity: 1_800, Account: 600 },
      measuredAt: '2026-11-10T10:00:00.000Z',
    },
    controls: {
      nonReidentification: {
        passed: true,
        checks: [],
        author: 'qa',
        checkedAt: '2026-11-10T10:00:00.000Z',
      },
      dryRunLoad: null,
      author: 'qa',
      date: '2026-11-10',
    },
  },
  lastLoad: null,
  lastLoads: [],
  lastVerifies: [],
};

/** The `frozen:load:error` of a load refused for the data storage the dataset's records take. */
export const FROZEN_STORAGE_REFUSAL = {
  message:
    `The dataset's records take about 7.5 MB of data storage, and ${QA_SANDBOX.alias} has 2 MB ` +
    `left of 5 MB. Nothing was written.`,
  code: 'FROZEN_STORAGE_EXCEEDED',
  retryable: false,
  storage: { estimateMB: 7.5, remainingMB: 2, maxMB: 5 },
  orgId: QA_SANDBOX.id,
};

/** What the page says of it, with the ways out of a dataset loaded whole. */
export const FROZEN_STORAGE_WORDS =
  `The dataset's records take about 7.5 MB of data storage, and ${QA_SANDBOX.alias} has 2 MB ` +
  `left of 5 MB: the load would stop part way through, and nothing was written. Load a pilot ` +
  `first, one root folder of it; or extract a smaller dataset: lower the budget in the ` +
  `configuration, then run the selection and the extraction again; or free data storage in ` +
  `${QA_SANDBOX.alias}.`;

/** A Cleanup scan of `objects`, as `dataops:cleanup:scan` answers it. */
export function cleanupScan(objects: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    orgId: DEV_SANDBOX.id,
    staleDays: 365,
    scannedAt: '2026-11-14T10:00:00.000Z',
    orphanThreshold: 0.9,
    bounds: { duplicateGroupLimit: 2000, duplicateSample: 20, singleFieldQueries: 20 },
    objects,
  };
}

/** An object of a Cleanup scan: `stale` records untouched for a year, deletable unless said. */
export function cleanupObject(
  objectApiName: string,
  stale: number,
  deletable?: false,
): Record<string, unknown> {
  return {
    status: 'scanned',
    objectApiName,
    label: objectApiName,
    totalRecords: stale * 3,
    stale: { days: 365, records: stale },
    orphans: [],
    duplicates: null,
    keyFields: [],
    errors: [],
    ...(deletable === false ? { deletable: false } : {}),
  };
}

/** Where the next export of the stale contacts carries on, as the first one answers it. */
export const CLEANUP_NEXT_CURSOR = { skip: 1000, id: '003000000000999AAA' };

/** The first export of 1,300 stale contacts: the first 1,000, and where the next carries on. */
export const CLEANUP_FIRST_EXPORT = {
  objectApiName: 'Contact',
  records: 1000,
  truncated: true,
  exported: 1000,
  recommended: 1300,
  next: CLEANUP_NEXT_CURSOR,
  saved: { status: 'saved', path: '/home/qa/contact-stale-1.csv' },
};

/** The next export of them: the 300 left, and none after. */
export const CLEANUP_LAST_EXPORT = {
  objectApiName: 'Contact',
  records: 300,
  truncated: false,
  exported: 1300,
  recommended: 1300,
  saved: { status: 'saved', path: '/home/qa/contact-stale-2.csv' },
};

/** The templates the marketplace ships, as `marketplace:list:response` carries each card. */
export const SHIPPED_MARKETPLACE_CARDS = BUILTIN_PIPELINE_TEMPLATES.map((template) => ({
  id: template.id,
  name: template.name,
  description: template.description,
  category: template.category,
  author: 'SandForge',
  stepTypes: template.steps.map((step) => step.type),
  steps: template.steps.map((step) => ({
    name: step.name,
    type: step.type,
    config: step.config,
    ...(step.condition ? { condition: step.condition } : {}),
  })),
}));

/** A card whose Pre-check names nothing to read, and whose Notification says nothing. */
export const CARD_THAT_CANNOT_RUN = {
  id: 'tpl-unrunnable',
  name: 'Health check written by hand',
  description: 'A Pre-check and a notification, neither filled in.',
  category: 'monitoring',
  author: 'SandForge',
  stepTypes: ['precheck', 'notification'],
  steps: [
    { name: 'Check the org', type: 'precheck', config: {} },
    { name: 'Tell the team', type: 'notification', config: {} },
  ],
};

/** A node of a Forge graph, as a discovery answers with it. */
export function forgeNode(
  objectApiName: string,
  recordCount: number,
  level: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    objectApiName,
    recordCount,
    fieldCount: 50,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 40,
    estimatedSizeMB: 0.01,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
    ...overrides,
  };
}

/**
 * Accounts and the contacts, opportunities and cases under them, as a
 * discovery from a query answers; `overrides` set on Case.
 */
export function forgeGraph(caseOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nodes: [
      forgeNode('Account', 2, 0),
      forgeNode('Contact', 6, 1),
      forgeNode('Opportunity', 3, 1),
      forgeNode('Case', 4, 1, caseOverrides),
    ],
    edges: [
      {
        sourceObject: 'Contact',
        targetObject: 'Account',
        relationshipName: 'Account',
        type: 'lookup',
        required: false,
      },
    ],
    totalRecords: 15,
    estimatedSizeMB: 0.1,
    estimatedDurationSeconds: 4,
  };
}

/** The org gave no answer in time to the count of Case: left out, and its count unknown. */
export const CASE_NOT_COUNTED = { recordCount: 0, recordCountUnknown: true, included: false };

/**
 * The differences between the two orgs' schemas, one of each kind the
 * Metadata tab offers to act on: a field the target lacks, one of another
 * type, one the user may not set, an object the target lacks, one the target
 * would not describe, one the user may not create, and an optional field
 * the target lacks, said for information.
 */
export const METADATA_DIFFS = [
  {
    objectApiName: 'Contact',
    fieldApiName: 'Region__c',
    issue: 'missing',
    severity: 'warning',
    details: 'Region__c is not in the target.',
  },
  {
    objectApiName: 'Contact',
    fieldApiName: 'Score__c',
    issue: 'type_mismatch',
    severity: 'warning',
    details: 'Score__c differs in type.',
    sourceType: 'double',
    targetType: 'string',
  },
  {
    objectApiName: 'Contact',
    fieldApiName: 'Rating__c',
    issue: 'permission_denied',
    severity: 'warning',
    details: 'Rating__c cannot be set.',
  },
  {
    objectApiName: 'Case',
    fieldApiName: '',
    issue: 'object_missing',
    severity: 'error',
    details: 'Case is not in the target.',
  },
  {
    objectApiName: 'Opportunity',
    fieldApiName: '',
    issue: 'unreadable',
    severity: 'warning',
    details: 'Opportunity could not be described.',
    unreadIn: 'target',
    orgError: 'REQUEST_LIMIT_EXCEEDED',
  },
  {
    objectApiName: 'Quote',
    fieldApiName: '',
    issue: 'object_not_createable',
    severity: 'warning',
    details: 'Quote cannot be created.',
    notCreatableBy: 'user',
  },
  {
    objectApiName: 'Account',
    fieldApiName: 'Legacy_Code__c',
    issue: 'missing',
    severity: 'info',
    details: 'Legacy_Code__c is not in the target.',
  },
];

/** What the Metadata tab copies for the target's admin of those differences. */
export const METADATA_ADMIN_COPY = [
  'Changes to make in the Setup of the target org for the records SandForge clones to go in as they are:',
  '',
  '- Give the user SandForge writes as Edit on Rating__c of Contact (Setup > their profile or a permission set > Object Settings > Contact > Field Permissions).',
  '- Give the user SandForge writes as Create on Quote (Setup > their profile or a permission set > Object Settings > Quote).',
].join('\n');

/**
 * What a discovery of the whole org leaves out for the rights of the users
 * SandForge reads and writes as, beside what Salesforce keeps for itself.
 */
export const LEFT_OUT_FOR_RIGHTS = [
  { objectApiName: 'AccountFeed', reason: 'chatter' },
  { objectApiName: 'Quote__c', reason: 'notWritable' },
  { objectApiName: 'Ledger__c', reason: 'createOnly', detail: 'noDelete' },
  { objectApiName: 'Payroll__c', reason: 'notQueryable' },
];

/** What the Plan row copies for the admins of the two orgs of those objects. */
export const LEFT_OUT_ADMIN_COPY = [
  'Changes to make in Setup for SandForge to clone these objects of the whole org:',
  '',
  'In the target org:',
  '- Give the user SandForge writes as Create, Edit and Delete on Quote__c (Setup > their profile or a permission set > Object Settings > Quote__c).',
  '- Give the user SandForge writes as Delete on Ledger__c (Setup > their profile or a permission set > Object Settings > Ledger__c).',
  '',
  'In the source org:',
  '- Give the user SandForge reads as Read on Payroll__c (Setup > their profile or a permission set > Object Settings > Payroll__c).',
].join('\n');

/** The target's active users, more than the list carries: the first by name. */
export const TARGET_USERS_TRUNCATED = {
  orgId: QA_SANDBOX.id,
  users: [{ id: '005000000000101AAA', name: 'Ada Admin', username: 'ada@example.invalid' }],
  truncated: true,
};

/** A user of the target past those listed, given by the id typed. */
export const UNLISTED_TARGET_USER = '005000000000777AAA';

/** A stopped Forge clone Live Operations offers to take up, beside one still running. */
export const LIVE_OPERATIONS_WITH_A_STOPPED_CLONE = {
  operations: [
    {
      operationId: 'op-forge-stopped',
      module: 'forge',
      description: 'forge run',
      status: 'failed',
      percentage: 60,
      processedRecords: 120,
      totalRecords: 0,
      currentStep: 'Completed Account: 120 succeeded, 0 failed',
      startedAt: '2026-11-14T11:00:00Z',
      elapsedMs: 5000,
      recordsPerSecond: 24,
      error: 'Forge execution finished with a failure status.',
      resumeRun: 'forge-run-stopped',
    },
  ],
};

/** The `forge:execute:error` of a resume refused because the target could not be read. */
export const RESUME_TARGET_UNREAD_REFUSAL = {
  message:
    'The target could not be read for the insert calls the run had under way: INVALID_SESSION_ID.',
  code: 'RESUME_TARGET_UNREAD',
  retryable: false,
};

/** The `forge:execute:error` of a resume refused because its journal could not be opened. */
export const JOURNAL_UNAVAILABLE_REFUSAL = {
  message:
    'The journal of the run to resume, in /home/qa/.sandforge/journal, could not be opened (the ' +
    'disk is full). Free some space on that disk, then resume it again. Nothing was written.',
  code: 'JOURNAL_UNAVAILABLE',
  retryable: false,
};

/** Five records of one object the target refused for a lock, sent again: three written, one still held. */
export const SENT_AGAIN_FOR_A_LOCK = { rows: 5, written: 3, stillLocked: 1 };

/** What a result says of them: written, still held by the lock, and refused otherwise. */
export const SENT_AGAIN_WORDS =
  '5 records the target org refused because it could not lock a record their write needed ' +
  '(UNABLE_TO_LOCK_ROW) went again on their own, up to 3 times, waiting longer each time: 3 ' +
  'written. 1 still refused for the lock, among the refusals. 1 refused for another reason, ' +
  'among the refusals.';

/** A Sync run of contacts, some of which a lock refused and the run sent again. */
export function syncRunSentAgain(): Record<string, unknown> {
  return {
    configId: 'cfg-ways-out',
    operationId: 'run-ways-out',
    status: 'partial',
    objectResults: [
      {
        objectApiName: 'Contact',
        operation: 'insert',
        processed: 30,
        success: 28,
        failed: 2,
        skipped: 0,
        conflictCount: 0,
        errors: [
          'UNABLE_TO_LOCK_ROW: unable to obtain exclusive access to this record (sent 3 times)',
          'REQUIRED_FIELD_MISSING: Required fields are missing: [LastName]',
        ],
        sentAgainForALock: SENT_AGAIN_FOR_A_LOCK,
      },
    ],
    totalProcessed: 30,
    totalSuccess: 28,
    totalFailed: 2,
    totalSkipped: 0,
    duration: 900,
    timestamp: '2026-11-14T10:00:00.000Z',
  };
}

/** That run, as the Sync page's History lists it and opens it. */
export function syncHistoryEntrySentAgain(): Record<string, unknown> {
  return {
    id: 'h-ways-out',
    configSnapshot: {
      id: 'cfg-ways-out',
      name: 'Contacts',
      sourceOrgId: DEV_SANDBOX.id,
      targetOrgId: QA_SANDBOX.id,
      direction: 'source_to_target',
      mode: 'full',
      conflictStrategy: 'source_wins',
      objects: [],
      enableRollback: false,
      createdAt: '2026-11-14T09:00:00.000Z',
      updatedAt: '2026-11-14T09:00:00.000Z',
    },
    result: syncRunSentAgain(),
    startTime: '2026-11-14T09:59:59.000Z',
    endTime: '2026-11-14T10:00:00.000Z',
    triggeredBy: 'manual',
  };
}

/**
 * Quick Sync on its preview of contacts the source holds more of than the
 * run reads, the bound said with it.
 */
export const QUICK_SYNC_ON_A_CUT_PREVIEW = {
  ...QUICK_SYNC_ON_PREVIEW,
  quickSyncPreview: {
    ...QUICK_SYNC_PREVIEW,
    objects: [
      QUICK_SYNC_PREVIEW.objects[0],
      { ...QUICK_SYNC_PREVIEW.objects[1], recordCount: 10_000, heldInSource: 30_000 },
    ],
    totalRecords: 11_200,
    readCap: 10_000,
  },
};

/** A simulation whose read of Invoice__c stopped at the bound `readCap`. */
export function simulationCutAtReadCap(readCap: number): Record<string, unknown> {
  const simulation = simulationWithUnwritable('notInTarget');
  const writeCheck = simulation.writeCheck as Record<string, unknown>;
  return {
    ...simulation,
    readCap,
    cutAtReadCap: ['Invoice__c'],
    writeCheck: { ...writeCheck, unwritable: [], verdict: 'fits' },
  };
}

/** A Forge run of an opportunity, done: what its results open on. */
export const FORGE_RUN_DONE = {
  forgeId: 'forge-run-platform',
  status: 'success',
  graph: forgeGraph(),
  duration: 30_000,
  timestamp: '2026-11-14T09:00:00.000Z',
  idRemapCount: 1,
  createdCount: 1,
  idRemapTable: { '006000000000001SRC': '006000000000001AAA' },
  idRemapCreated: [{ objectApiName: 'Opportunity', sourceIds: ['006000000000001SRC'] }],
  targetOrgId: QA_SANDBOX.id,
  config: {
    inputMode: 'soql',
    soqlQuery: "SELECT Id FROM Account WHERE Industry = 'Energy'",
    depth: 'direct',
    anonymizePII: false,
    skipEmpty: false,
    batchSize: 'auto',
  },
};

/** An object of a verification, every record the run wrote there as it left it. */
function verifiedObject(
  objectApiName: string,
  expected: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    objectApiName,
    expected,
    present: expected,
    deleted: 0,
    notVisible: 0,
    changed: 0,
    changedRecords: [],
    deletedIds: [],
    notVisibleIds: [],
    linksChecked: 0,
    linksBroken: 0,
    brokenLinks: [],
    ...overrides,
  };
}

/**
 * The verification of that run: its opportunity there, and the contact roles
 * the platform wrote with it, none of them by the run.
 */
export const VERIFIED_WITH_THE_PLATFORMS = {
  verdict: 'verified',
  verifiedAt: '2026-11-14T09:10:00.000Z',
  attempts: 1,
  objects: [
    verifiedObject('Opportunity', 1),
    verifiedObject('OpportunityContactRole', 0, { withTheirRecord: 2 }),
  ],
};

/** An Autopilot graph of accounts and their contacts, as a scan answers it. */
export const AUTOPILOT_GRAPH = {
  nodes: ['Account', 'Contact'].map((objectApiName, index) => ({
    objectApiName,
    recordCount: index === 0 ? 500 : 1200,
    estimatedApiCalls: index === 0 ? 3 : 6,
    piiFields: [],
    anonymizationRules: [],
    status: 'pending',
    progress: 0,
    insertOrder: index,
    level: index,
    successCount: 0,
    failureCount: 0,
    errors: [],
    elapsedMs: 0,
    apiCallsUsed: 0,
  })),
  edges: [],
  cycles: [],
  stats: {
    totalObjects: 2,
    totalRelationships: 1,
    cycleCount: 0,
    maxDepth: 1,
    totalRecords: 1700,
    totalEstimatedApiCalls: 9,
  },
};

/** Its plan, as `autopilot:plan-ready` answers it. */
export const AUTOPILOT_PLAN = {
  waves: [
    { order: 0, objects: ['Account'], dependsOn: [] },
    { order: 1, objects: ['Contact'], dependsOn: [0] },
  ],
  totalRecords: 1700,
  estimatedDurationSec: 240,
  estimatedApiCalls: 9,
  complianceFramework: 'gdpr',
  anonymizationSummary: {
    totalPiiFields: 0,
    totalFieldsToAnonymize: 0,
    methodBreakdown: {},
    objectsWithPii: [],
  },
  cycleResolutions: [],
};
