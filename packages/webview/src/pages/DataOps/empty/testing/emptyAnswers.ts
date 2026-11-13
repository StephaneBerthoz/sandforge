/**
 * What the emptying's tests stand in for: the extension's answers to
 * `dataops:empty:*`, in the contract's shapes — a scope, a preview of two
 * objects, a run and its undo, and the audit trail's entries of them.
 */
import type {
  AuditLogEntry,
  DataOpsEmptyPreviewResponse,
  DataOpsEmptyRunResult,
  DataOpsEmptyScopeResponse,
  DataOpsEmptyUndoResult,
} from '@sandforge/shared';

/** A run's id, as the journal makes them. */
export const RUN_ID = 'em-20261112-140512-a1b2';

/** The scope of the org: ten objects, one custom setting, a few never touched. */
export function scopeAnswer(
  hardDelete: DataOpsEmptyScopeResponse['payload']['hardDelete'] = { permitted: false },
): DataOpsEmptyScopeResponse['payload'] {
  const objects = ['Account', 'Case', 'Contact', 'Opportunity', 'Order', 'Task'];
  return {
    mode: 'org',
    objects,
    leftOut: [
      { objectApiName: 'AccountFeed', reason: 'chatter' },
      { objectApiName: 'ApexClass', reason: 'metadata' },
      { objectApiName: 'User', reason: 'setup' },
      { objectApiName: 'Region__c', reason: 'customSetting' },
    ],
    candidates: [...objects, 'Region__c'],
    tier: 'development',
    hardDelete,
  };
}

/** The preview of emptying Account and Contact, with what goes along and a blocker. */
export function previewAnswer(
  overrides: Partial<DataOpsEmptyPreviewResponse['payload']> = {},
): DataOpsEmptyPreviewResponse['payload'] {
  return {
    previewId: 'ep-20261112-140500-c3d4',
    readAt: '2026-11-12T14:05:00.000Z',
    orgName: 'dev',
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
      affected: ['Account', 'Contact', 'Opportunity'],
      cost: {
        apiRequests: 31,
        seconds: 42,
        bulkBatches: 0,
        passes: [
          { objectApiName: 'Account', records: 120, restCalls: 1, jobs: [], toTheBin: true },
          { objectApiName: 'Contact', records: 25, restCalls: 1, jobs: [], toTheBin: true },
        ],
        binRecords: 670,
        bin: { documentedCapacity: 12_500, past: false },
        api: { verdict: 'fits', estimate: 31, max: 100_000, remaining: 99_000 },
      },
      total: { records: 670, objects: 3, uncounted: [] },
      statements: 6,
    },
    access: { kind: 'org' },
    hardDelete: { permitted: false },
    peopleActive: { people: 0 },
    automation: {
      act: 'cleanup',
      objects: [{ objectApiName: 'Account', records: 120 }],
      steps: { delete: ['Account', 'Contact'] },
      automation: {
        objectsRead: ['Account', 'Contact'],
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
    },
    refusals: [],
    ...overrides,
  };
}

/** A run that went through, Undo offered. */
export function runResultOf(overrides: Partial<DataOpsEmptyRunResult> = {}): DataOpsEmptyRunResult {
  return {
    runId: RUN_ID,
    status: 'success',
    hard: false,
    passes: [
      { objectApiName: 'Account', planned: 120, deleted: 118, gone: 0, refused: 2, reasons: [] },
      { objectApiName: 'Contact', planned: 25, deleted: 25, gone: 0, refused: 0, reasons: [] },
    ],
    totals: { deleted: 143, gone: 0, refused: 2, notReached: 0 },
    undo: { offered: true },
    notes: [],
    startedAt: '2026-11-12T14:07:00.000Z',
    finishedAt: '2026-11-12T14:07:40.000Z',
    ...overrides,
  };
}

/** The undo of {@link runResultOf}. */
export function undoResultOf(): DataOpsEmptyUndoResult {
  return {
    runId: RUN_ID,
    status: 'partial',
    objects: [
      {
        objectApiName: 'Account',
        planned: 118,
        undeleted: 110,
        alreadyBack: 0,
        notInBin: 8,
        othersDeletion: 0,
        refused: 0,
        reasons: [],
      },
    ],
    notes: [],
    finishedAt: '2026-11-12T14:09:00.000Z',
  };
}

/** An audit entry of an emptying's act, as `reports:audit` lists it. */
export function auditEntry(
  act: 'run' | 'undo',
  at: string,
  overrides: Partial<AuditLogEntry> = {},
): AuditLogEntry {
  return {
    id: `${act}-${at}`,
    action: act === 'undo' ? 'empty_undo' : 'cleanup_delete',
    module: 'dataops',
    orgId: 'org-1',
    operationId: `op-${act}`,
    outcome: 'success',
    objects: [
      {
        objectApiName: 'Account',
        created: act === 'undo' ? 5 : 0,
        updated: 0,
        deleted: act === 'run' ? 5 : 0,
        failed: 0,
      },
    ],
    details:
      act === 'run'
        ? { empty: 'run', runId: RUN_ID, hard: false }
        : { empty: 'undo', runId: RUN_ID },
    timestamp: at,
    ...overrides,
  };
}
