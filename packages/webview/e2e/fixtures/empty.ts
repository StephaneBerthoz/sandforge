import type {
  AuditLogEntry,
  DataOpsAutomationAnswer,
  DataOpsEmptyPreviewPass,
  DataOpsEmptyPreviewResponse,
  DataOpsEmptyRunResult,
  DataOpsEmptyScopeResponse,
  DataOpsEmptyUndoResult,
} from '@sandforge/shared';
import { DEV_SANDBOX } from './mock-orgs';

/**
 * What the extension answers the Cleanup tab's emptying with, for the specs
 * that draw it in Chromium: the scope, two previews, a run and its undo, and
 * the audit trail's entries. The shapes are the `dataops:empty:*` contract's,
 * typed against it, and were read from the handler's answers on the memory
 * org its tests empty, the counts scaled: a spec draws only states the
 * extension can send.
 */

/** The org emptied: the dev sandbox the specs connect first. */
export const EMPTY_ORG = DEV_SANDBOX;

/** A run's id, as the journal makes them. */
export const RUN_ID = 'em-20261112-140512-a1b2';

/** What fires as the records go: nothing, nothing sends. */
export function nothingFires(objects: string[]): DataOpsAutomationAnswer {
  return {
    act: 'cleanup',
    objects: objects.map((objectApiName) => ({ objectApiName, records: 1 })),
    steps: { delete: objects },
    automation: {
      objectsRead: objects,
      objects: [],
      unread: [],
      conditionsNotRead: 0,
      conditionsBound: 0,
      requests: 0,
    },
    lines: [],
    emails: [],
    emailsAsk: false,
    refusals: [],
  };
}

/** The scope of the org: what may be picked, what the whole org empties, what is never touched. */
export function emptyScope(
  hardDelete: DataOpsEmptyScopeResponse['payload']['hardDelete'] = { permitted: false },
): DataOpsEmptyScopeResponse['payload'] {
  const objects = [
    'Account',
    'Case',
    'Contact',
    'Opportunity',
    'Order',
    'OrderItem',
    'Pricebook2',
    'PricebookEntry',
    'Product2',
    'Task',
  ];
  return {
    mode: 'org',
    objects,
    leftOut: [
      { objectApiName: 'AccountFeed', reason: 'chatter' },
      { objectApiName: 'AccountHistory', reason: 'history' },
      { objectApiName: 'ApexClass', reason: 'metadata' },
      { objectApiName: 'Profile', reason: 'setup' },
      { objectApiName: 'User', reason: 'setup' },
      { objectApiName: 'Region__c', reason: 'customSetting' },
    ],
    candidates: [...objects, 'Region__c'],
    tier: 'development',
    hardDelete,
  };
}

/**
 * The preview of emptying Account and Contact: what goes along with them,
 * an activated order set back to Draft, a case whose lookup refuses the
 * delete — a blocker the run is then refused on —, and nothing that fires.
 */
export function objectsPreview(
  overrides: Partial<DataOpsEmptyPreviewResponse['payload']> = {},
): DataOpsEmptyPreviewResponse['payload'] {
  return {
    previewId: 'ep-20261112-140500-c3d4',
    readAt: '2026-11-12T14:05:00.000Z',
    orgName: EMPTY_ORG.alias,
    tier: 'development',
    preview: {
      mode: 'objects',
      deleteMode: 'recycle',
      passes: [
        { objectApiName: 'Account', records: { records: 120 }, sent: { records: 120 } },
        { objectApiName: 'Contact', records: { records: 340 }, sent: { records: 25 } },
      ],
      along: [
        {
          objectApiName: 'Opportunity',
          records: { records: 210 },
          via: [
            {
              field: 'AccountId',
              parent: 'Account',
              emptied: 'Account',
              records: { records: 210 },
            },
          ],
        },
        {
          objectApiName: 'Order',
          records: { records: 14 },
          via: [
            { field: 'AccountId', parent: 'Account', emptied: 'Account', records: { records: 14 } },
          ],
        },
        {
          objectApiName: 'Task',
          records: { records: 96, atMost: true },
          via: [
            { field: 'WhatId', parent: 'Account', emptied: 'Account', records: { records: 96 } },
          ],
        },
      ],
      leftOut: [],
      refusals: [{ code: 'activatedOrder', objectApiName: 'Order', records: { records: 3 } }],
      blockers: [
        { objectApiName: 'Case', field: 'AccountId', parent: 'Account', records: { records: 2 } },
      ],
      beforeParent: [],
      unordered: [],
      undoLost: [],
      undo: true,
      affected: ['Account', 'Contact', 'Opportunity', 'Order', 'Task'],
      cost: {
        apiRequests: 31,
        seconds: 42,
        bulkBatches: 0,
        passes: [
          { objectApiName: 'Account', records: 120, restCalls: 1, jobs: [], toTheBin: true },
          { objectApiName: 'Contact', records: 25, restCalls: 1, jobs: [], toTheBin: true },
        ],
        binRecords: 780,
        bin: { documentedCapacity: 12_500, past: false },
        api: { verdict: 'fits', estimate: 31, max: 100_000, remaining: 99_000 },
      },
      total: { records: 780, objects: 5, uncounted: [] },
      statements: 12,
    },
    access: { kind: 'org' },
    hardDelete: { permitted: false },
    peopleActive: { people: 0 },
    automation: nothingFires(['Account', 'Contact', 'Order']),
    refusals: [],
    ...overrides,
  };
}

/** Thirty-seven objects people work in, as a whole org's preview lists them. */
const WHOLE_ORG = [
  'Account',
  'Asset',
  'Campaign',
  'Case',
  'Contact',
  'Contract',
  'Entitlement',
  'Event',
  'Lead',
  'Opportunity',
  'Order',
  'Pricebook2',
  'PricebookEntry',
  'Product2',
  'Quote',
  'ServiceContract',
  'Solution',
  'Task',
  'WorkOrder',
  'Delivery__c',
  'Invoice__c',
  'Payment__c',
  'Shipment__c',
  'Store__c',
  'Survey__c',
  'Territory__c',
  'Ticket__c',
  'Visit__c',
  'Warranty__c',
  'Vendor__c',
];
const WHOLE_ORG_ALONG = [
  'CampaignMember',
  'ContractLineItem',
  'OpportunityContactRole',
  'OpportunityLineItem',
  'OrderItem',
  'QuoteLineItem',
  'WorkOrderLineItem',
];

/**
 * The preview of emptying the whole org: 48,213 records of 37 objects, Task
 * by a Bulk API job, custom prices that go before the standard ones and
 * leave Undo short — a refusal its box lifts —, and a recycle bin past what
 * Salesforce documents for it.
 */
export function orgPreview(
  overrides: Partial<DataOpsEmptyPreviewResponse['payload']> = {},
): DataOpsEmptyPreviewResponse['payload'] {
  // 30 emptied objects and 7 going along, 48,213 records in all.
  const counts = WHOLE_ORG.map((name) => (name === 'Task' ? 20_000 : 800));
  const alongCounts = WHOLE_ORG_ALONG.map(() => 600);
  counts[0] += 48_213 - [...counts, ...alongCounts].reduce((sum, n) => sum + n, 0);
  const passes: DataOpsEmptyPreviewPass[] = WHOLE_ORG.map((objectApiName, i) => ({
    objectApiName,
    records: { records: counts[i] },
    sent: { records: counts[i] },
    ...(objectApiName === 'Task' ? { archived: { records: 1_200 } } : {}),
    ...(objectApiName === 'Pricebook2' ? { kept: { records: 1 } } : {}),
  }));
  return {
    ...objectsPreview(),
    previewId: 'ep-20261112-140600-e5f6',
    preview: {
      mode: 'org',
      deleteMode: 'recycle',
      passes,
      along: WHOLE_ORG_ALONG.map((objectApiName) => ({
        objectApiName,
        records: { records: 600 },
        via: [
          { field: 'ParentId', parent: 'Account', emptied: 'Account', records: { records: 600 } },
        ],
      })),
      leftOut: emptyScope().leftOut,
      refusals: [
        { code: 'standardPriceBook', objectApiName: 'Pricebook2', records: { records: 1 } },
      ],
      blockers: [],
      beforeParent: [
        {
          objectApiName: 'PricebookEntry',
          field: 'Product2Id',
          parent: 'Product2',
          reason: 'customPrices',
        },
      ],
      unordered: [],
      undoLost: [
        {
          objectApiName: 'PricebookEntry',
          field: 'Product2Id',
          parent: 'Product2',
          reason: 'customPrices',
          records: { records: 40 },
        },
      ],
      undo: true,
      affected: [...WHOLE_ORG, ...WHOLE_ORG_ALONG].sort(),
      cost: {
        apiRequests: 1_480,
        seconds: 1_260,
        bulkBatches: 2,
        passes: WHOLE_ORG.map((objectApiName, i) => ({
          objectApiName,
          records: counts[i],
          restCalls: objectApiName === 'Task' ? 0 : Math.ceil(counts[i] / 200),
          jobs: objectApiName === 'Task' ? [20_000] : [],
          toTheBin: true,
        })),
        binRecords: 48_213,
        bin: { documentedCapacity: 12_500, past: true },
        api: { verdict: 'fits', estimate: 1_480, max: 100_000, remaining: 97_500 },
        batches: { verdict: 'fits', estimate: 2, max: 15_000, remaining: 14_990 },
      },
      total: { records: 48_213, objects: 37, uncounted: [] },
      statements: 74,
    },
    automation: nothingFires(WHOLE_ORG),
    refusals: [
      {
        code: 'NO_UNDO',
        message:
          '40 record(s) go before a record they name, as Salesforce requires (PricebookEntry ' +
          'before Product2): once both have gone, Undo cannot bring them back. Accept it to ' +
          'empty all the same, or leave those objects out. Nothing was deleted.',
      },
    ],
    ...overrides,
  };
}

/** A run that went through: Undo offered. */
export function runResult(overrides: Partial<DataOpsEmptyRunResult> = {}): DataOpsEmptyRunResult {
  return {
    runId: RUN_ID,
    status: 'success',
    hard: false,
    passes: [
      {
        objectApiName: 'Account',
        planned: 120,
        deleted: 120,
        gone: 0,
        refused: 0,
        reasons: [],
      },
      { objectApiName: 'Contact', planned: 25, deleted: 25, gone: 0, refused: 0, reasons: [] },
    ],
    totals: { deleted: 145, gone: 0, refused: 0, notReached: 0 },
    undo: { offered: true },
    notes: [],
    startedAt: '2026-11-12T14:07:00.000Z',
    finishedAt: '2026-11-12T14:07:40.000Z',
    ...overrides,
  };
}

/** What a run met with the case that names an account: the account refused, the org's words. */
export function blockedRunResult(): DataOpsEmptyRunResult {
  return runResult({
    status: 'partial',
    passes: [
      {
        objectApiName: 'Account',
        planned: 120,
        deleted: 118,
        gone: 0,
        refused: 2,
        reasons: ['DELETE_FAILED: a Case still names it in AccountId'],
      },
      { objectApiName: 'Contact', planned: 25, deleted: 25, gone: 0, refused: 0, reasons: [] },
    ],
    totals: { deleted: 143, gone: 0, refused: 2, notReached: 0 },
  });
}

/** A run stopped from the page between two calls: what it had not reached is said. */
export function cancelledRunResult(): DataOpsEmptyRunResult {
  return runResult({
    status: 'cancelled',
    passes: [
      { objectApiName: 'Account', planned: 120, deleted: 120, gone: 0, refused: 0, reasons: [] },
      {
        objectApiName: 'Contact',
        planned: 25,
        deleted: 0,
        gone: 0,
        refused: 0,
        notReached: 25,
        reasons: [],
      },
    ],
    totals: { deleted: 120, gone: 0, refused: 0, notReached: 25 },
  });
}

/** The undo of {@link runResult}: every record back. */
export function undoResult(): DataOpsEmptyUndoResult {
  return {
    runId: RUN_ID,
    status: 'success',
    objects: [
      {
        objectApiName: 'Account',
        planned: 120,
        undeleted: 120,
        alreadyBack: 0,
        notInBin: 0,
        othersDeletion: 0,
        refused: 0,
        reasons: [],
      },
      {
        objectApiName: 'Contact',
        planned: 25,
        undeleted: 23,
        alreadyBack: 2,
        notInBin: 0,
        othersDeletion: 0,
        refused: 0,
        reasons: [],
      },
    ],
    notes: [],
    finishedAt: '2026-11-12T14:09:00.000Z',
  };
}

/** The audit trail's entries of the org's emptyings, as `reports:audit` answers them. */
export function emptyAudit(): AuditLogEntry[] {
  return [
    {
      id: 'a3f1c2d4-0000-4000-8000-000000000001',
      action: 'cleanup_delete',
      module: 'dataops',
      orgId: EMPTY_ORG.id,
      orgAlias: EMPTY_ORG.alias,
      operationId: 'run-earlier',
      outcome: 'partial',
      guard: 'allowed',
      objects: [
        { objectApiName: 'Account', created: 0, updated: 0, deleted: 118, failed: 2 },
        { objectApiName: 'Contact', created: 0, updated: 0, deleted: 25, failed: 0 },
      ],
      details: {
        empty: 'run',
        mode: 'objects',
        deleteMode: 'recycle',
        runId: RUN_ID,
        hard: false,
        gone: 0,
      },
      timestamp: '2026-11-12T14:07:40.000Z',
    },
  ];
}
