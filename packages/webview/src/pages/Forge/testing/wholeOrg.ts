import type { ForgeGraph, ForgeGraphNode, ForgeWholeOrgDryRun } from '@sandforge/shared';

/** A node of a clone of the whole org, as its discovery answers with it. */
function node(
  objectApiName: string,
  recordCount: number,
  piiFields: string[] = [],
  anonymizeFields: string[] = [],
): ForgeGraphNode {
  return {
    objectApiName,
    recordCount,
    fieldCount: 40,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields,
    anonymizeFields,
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 30,
    estimatedSizeMB: recordCount * 0.002,
    estimatedApiCalls: Math.ceil(recordCount / 200),
    batchStrategy: 'auto',
  };
}

/**
 * The graph a discovery of the whole org answers with: four objects that hold
 * records, Contact and Lead with personal fields, and the objects of the
 * source it leaves out, each with why.
 */
export function wholeOrgGraph(): ForgeGraph {
  const nodes = [
    node('Account', 1_200, ['Phone'], []),
    node('Contact', 4_800, ['Email', 'Phone', 'Birthdate'], []),
    node('Lead', 2_500, ['Email'], []),
    node('Opportunity', 900),
  ];
  return {
    nodes,
    edges: [
      {
        sourceObject: 'Contact',
        targetObject: 'Account',
        relationshipName: 'AccountId',
        type: 'lookup',
      },
    ],
    totalRecords: nodes.reduce((sum, n) => sum + n.recordCount, 0),
    estimatedSizeMB: 19,
    estimatedDurationSeconds: 120,
    leftOut: [
      { objectApiName: 'AccountFeed', reason: 'chatter' },
      { objectApiName: 'AccountHistory', reason: 'history' },
      { objectApiName: 'Invoice__c', reason: 'missingInTarget' },
      { objectApiName: 'ProcessInstance', reason: 'platformCreated' },
      { objectApiName: 'UserRole', reason: 'setup', detail: 'noLayout' },
      { objectApiName: 'Secret__c', reason: 'unreadable', detail: 'No such column' },
    ],
  };
}

/**
 * What the dry run of that graph says at its gate, as `forge:execute:response`
 * carries it beside its result: the source's requests and the target's Bulk
 * API batches past what each has left; set `refused` to none for a run that
 * would go through.
 */
export function wholeOrgDryRun(over: Partial<ForgeWholeOrgDryRun> = {}): ForgeWholeOrgDryRun {
  return {
    wouldInsert: [
      { objectApiName: 'Contact', rows: 4_800, jobs: 1, byRest: 0 },
      { objectApiName: 'Lead', rows: 2_500, jobs: 1, byRest: 0 },
      { objectApiName: 'Account', rows: 1_200, jobs: 0, byRest: 1_200 },
      { objectApiName: 'Opportunity', rows: 900, jobs: 0, byRest: 900 },
    ],
    totalRows: 9_400,
    targetRequests: { verdict: 'fits', estimate: 140, max: 100_000, remaining: 92_000 },
    sourceRequests: { verdict: 'exceeds', estimate: 120_000, max: 150_000, remaining: 4_000 },
    bulkBatches: { verdict: 'exceeds', estimate: 16_000, max: 15_000, remaining: 2_000 },
    storage: { verdict: 'fits', estimateMB: 18.8, maxMB: 1_024, remainingMB: 800 },
    durationSeconds: 4_000,
    leftOut: {
      objects: wholeOrgGraph().leftOut ?? [],
      counts: [
        { reason: 'chatter', count: 1 },
        { reason: 'history', count: 1 },
        { reason: 'missingInTarget', count: 1 },
        { reason: 'platformCreated', count: 1 },
        { reason: 'setup', count: 1 },
        { reason: 'unreadable', count: 1 },
      ],
    },
    personalAsIs: [
      { objectApiName: 'Account', fields: ['Phone'] },
      { objectApiName: 'Contact', fields: ['Email', 'Phone', 'Birthdate'] },
      { objectApiName: 'Lead', fields: ['Email'] },
    ],
    wouldBeRefused: [
      {
        code: 'API_BUDGET_EXCEEDED',
        message:
          'The run writes through Bulk API jobs that take about 16000 of the daily Bulk API batches.',
        api: { kind: 'bulkBatches', org: 'target', estimate: 16_000, remaining: 2_000 },
      },
      {
        code: 'API_BUDGET_EXCEEDED',
        message: 'The run reads the source records in about 120000 API requests.',
        api: { kind: 'requests', org: 'source', estimate: 120_000, remaining: 4_000 },
      },
    ],
    ...over,
  };
}
