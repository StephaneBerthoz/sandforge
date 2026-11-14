import type {
  ForgeGraph,
  ForgeGraphNode,
  ForgeSampleBudget,
  ForgeWholeOrgDryRun,
  WholeOrgSample,
  WholeOrgSampleBudget,
  WholeOrgSampleResult,
} from '@sandforge/shared';

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

/**
 * What a sample of that org may take of a Developer Edition target, 5 MB of
 * which 4.5 are left: 80 % of what is left past the 0.5 MB kept for rounding.
 */
export function sampleBudgetTerms(over: Partial<WholeOrgSampleBudget> = {}): WholeOrgSampleBudget {
  return {
    bytes: 3_355_443,
    remainingMB: 4.5,
    maxMB: 5,
    share: 0.8,
    roundingMB: 0.5,
    limitedBy: 'storage',
    ...over,
  };
}

/**
 * What Review reads of the target before a sample of that org is simulated
 * (`forge:sample-budget:response`): every record takes about 412 MB, past
 * the 4.5 MB left; a sample may take 3.2 MB; Opportunity goes whole; drawing
 * it reads about 1,950 requests of the source in about 4 minutes.
 */
export function sampleBudget(over: Partial<ForgeSampleBudget> = {}): ForgeSampleBudget {
  return {
    wholeOrg: { verdict: 'exceeds', estimateMB: 412, maxMB: 5, remainingMB: 4.5 },
    budget: sampleBudgetTerms(),
    whole: [{ objectApiName: 'Opportunity', why: 'smallParent' }],
    planReads: {
      source: { verdict: 'fits', estimate: 1_950, max: 15_000, remaining: 14_000 },
      seconds: 240,
    },
    ...over,
  };
}

/**
 * What the simulation of a sample of that org drew, as its dry run says it
 * (`wholeOrgDryRun.sample`): 1,812 records of 9,400, seed 1, spread over the
 * org, held by the target's storage.
 */
export function wholeOrgSample(over: Partial<WholeOrgSample> = {}): WholeOrgSample {
  return {
    seed: 1,
    draw: 'uniform',
    floor: 1,
    parents: 'all',
    children: 100,
    share: 0.0041,
    budget: sampleBudgetTerms({ automationMB: 0.1 }),
    rows: 1_812,
    storageBytes: 3_250_585,
    objects: [
      {
        objectApiName: 'Opportunity',
        sourceRows: 900,
        kept: 900,
        roots: 0,
        below: 0,
        asParents: 0,
        whole: true,
      },
      {
        objectApiName: 'Account',
        sourceRows: 1_200,
        kept: 712,
        roots: 500,
        below: 0,
        asParents: 212,
      },
      {
        objectApiName: 'Contact',
        sourceRows: 4_800,
        kept: 200,
        roots: 12,
        below: 180,
        asParents: 8,
        childrenCut: [{ field: 'AccountId', rows: 1_340 }],
      },
    ],
    whole: [{ objectApiName: 'Opportunity', why: 'smallParent' }],
    heavyRoots: [
      {
        objectApiName: 'Account',
        id: '001000000000001AAA',
        rows: 4_100,
        relation: { objectApiName: 'Contact', field: 'AccountId' },
      },
    ],
    dropped: [
      { objectApiName: 'Contact', rows: 6, reason: 'noParentInSource' },
      { objectApiName: 'Account', rows: 3, reason: 'recordTypeNotInTarget' },
    ],
    leftEmpty: [{ objectApiName: 'Contact', field: 'ReportsToId', rows: 14 }],
    noRecordDrawn: [{ objectApiName: 'Lead', sourceRows: 2_500 }],
    planRequests: { source: 61 },
    plan: {
      path: '/storage/forge-samples/3f9a/plan',
      sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      drawnAt: '2026-11-14T14:02:00.000Z',
      drawnBy: 'run',
    },
    ...over,
  };
}

/**
 * What a run of that sample wrote, as its result says it (`result.sample`):
 * every record of the plan but four Contacts gone from the source since,
 * and two held back for a parent changed since.
 */
export function wholeOrgSampleResult(
  over: Partial<WholeOrgSampleResult> = {},
): WholeOrgSampleResult {
  const [opportunity, account, contact] = wholeOrgSample().objects;
  return {
    seed: 1,
    draw: 'uniform',
    share: 0.0041,
    sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    drawnAt: '2026-11-14T14:02:00.000Z',
    objects: [
      { ...opportunity, written: 900, goneSinceTheSample: 0, changedSinceTheSample: 0 },
      { ...account, written: 712, goneSinceTheSample: 0, changedSinceTheSample: 0 },
      { ...contact, written: 194, goneSinceTheSample: 4, changedSinceTheSample: 2 },
    ],
    leftEmpty: [{ objectApiName: 'Contact', field: 'ReportsToId', rows: 14 }],
    ...over,
  };
}
