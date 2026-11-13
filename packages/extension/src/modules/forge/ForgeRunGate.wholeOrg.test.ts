import { describe, it, expect } from 'vitest';
import type { RunCheckpointEstimate } from '@sandforge/shared';

import {
  API_BUDGET_EXCEEDED,
  BULK_BATCHES_NOT_TOLD,
  CHECKPOINT_REFUSED,
  ForgeRunGateError,
  forgeRequestPartsOf,
  forgeWriteBudgetOf,
  forgeWritesOf,
  personalFieldsAsIsOf,
  readBoundStopOf,
  readDataStorage,
  wholeOrgCostOf,
  wholeOrgDryRunOf,
  wholeOrgFilesOf,
  wholeOrgLeftOutOf,
  wholeOrgWritePlanOf,
  writePlanOf,
  WHOLE_ORG_SOURCE_READS_PER_OBJECT,
  WHOLE_ORG_TARGET_READS_PER_OBJECT,
  type LimitsTransport,
  type WholeOrgGraph,
  type WholeOrgMeasures,
} from './ForgeRunGate.js';
import { FORGE_BULK_JOB_ROWS } from './forgeBulkWrite.js';
import {
  FORGE_BULK_POLL_SCHEDULE,
  bulkJobRequests,
  bulkJobStateReads,
} from '../../core/engine/bulkJobCost.js';

const MB = 1024 * 1024;

/** `value`, which the test needs there: a test that finds nothing fails here, saying so. */
function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value, found none');
  return value;
}

/** What the counts of a clone of the whole org hand its gate of one object: no row, a count. */
const counted = (objectApiName: string, rows: number) => ({
  objectApiName,
  rows: [],
  counted: { rows },
});

/*
 * A clone of the whole org of 25,000 cases, 3,000 tasks and 600 accounts. As
 * Forge's writer sends them through the Bulk API: the cases in jobs of
 * 10,000, 10,000 and 5,000; the tasks by REST whatever their number, written
 * with their emails; the accounts by REST, under 2,000 and watched by the
 * standard duplicate rule.
 */
const plan = writePlanOf([
  counted('Case', 25_000),
  counted('Task', 3_000),
  counted('Account', 600),
]);

/*
 * The calls of one job of Forge's writer, read after waits of 5, 10, 20, then
 * 30 seconds, as long as a job that saves its records takes: its wait of 24
 * seconds, then 60 records a second.
 * - 10,000 rows, about 191 seconds: nine waits, ten reads, sixteen calls.
 * - 5,000 rows, about 107 seconds: six waits, seven reads, thirteen calls.
 */
const JOB_10K = 3 + 10 + 3;
const JOB_5K = 3 + 7 + 3;
const CASES = JOB_10K + JOB_10K + JOB_5K;
// 3,000 tasks and 600 accounts by REST: fifteen calls and three.
const REST = 15 + 3;
/** What the run reads of the target as it writes the three objects, past their writes. */
const TARGET_READS = 3 * WHOLE_ORG_TARGET_READS_PER_OBJECT;
/** What it reads of the source as it reads the three objects, past their pages. */
const SOURCE_READS = 3 * WHOLE_ORG_SOURCE_READS_PER_OBJECT;

/** The target's `/limits`, as an org answers them. */
function limitsAnswer(over: Partial<Record<string, { Max: number; Remaining: number }>> = {}) {
  return {
    DataStorageMB: { Max: 1_024, Remaining: 900 },
    FileStorageMB: { Max: 2_048, Remaining: 2_000 },
    DailyApiRequests: { Max: 5_000_000, Remaining: 4_900_000 },
    DailyBulkApiBatches: { Max: 15_000, Remaining: 14_990 },
    ...over,
  };
}

/** What a checkpoint first would cost, as its scope estimates it at the gate. */
function estimateOf(
  apiRequests: number,
  refusal?: RunCheckpointEstimate['refusal'],
): RunCheckpointEstimate {
  return {
    state: 'planned',
    estimate: { records: 380_000, apiRequests, apiRequestsLeft: 4_000, seconds: 900, bytes: 9 },
    objects: ['Case', 'Task', 'Account'],
    added: [],
    notHeld: [],
    keepDays: 7,
    ...(refusal ? { refusal } : {}),
  };
}

describe('the limits a clone of the whole org is held to, read with the data storage', () => {
  it('reads the daily Bulk API batches and the file storage from the same answer, in one request', async () => {
    const calls: string[] = [];
    const transport: LimitsTransport = {
      request: async ({ method, url }) => {
        calls.push(`${method} ${url}`);
        return limitsAnswer();
      },
    };

    await expect(readDataStorage(transport)).resolves.toEqual({
      maxMB: 1_024,
      remainingMB: 900,
      dailyApiRequests: { max: 5_000_000, remaining: 4_900_000 },
      dailyBulkApiBatches: { max: 15_000, remaining: 14_990 },
      fileStorage: { maxMB: 2_048, remainingMB: 2_000 },
    });
    expect(calls).toEqual(['GET /limits']);
  });

  it('leaves out of what it read a limit the answer does not list', async () => {
    const storage = await readDataStorage({
      request: async () => ({ DataStorageMB: { Max: 5, Remaining: 4 } }),
    });

    expect(storage).not.toHaveProperty('dailyBulkApiBatches');
    expect(storage).not.toHaveProperty('fileStorage');
  });
});

describe('how Forge’s writer sends an object through the Bulk API, as its gate prices it', () => {
  it('cuts it in jobs of 10,000, and sends by REST what is left under 2,000', () => {
    expect(forgeWritesOf('Case', 25_000, {})).toEqual({ jobs: [10_000, 10_000, 5_000], rest: 0 });
    expect(forgeWritesOf('Case', 11_000, {})).toEqual({ jobs: [10_000], rest: 1_000 });
    expect(forgeWritesOf('Case', 2_000, {})).toEqual({ jobs: [2_000], rest: 0 });
    expect(forgeWritesOf('Case', 1_999, {})).toEqual({ jobs: [], rest: 1_999 });
    expect(forgeWritesOf('Case', 0, {})).toEqual({ jobs: [], rest: 0 });
  });

  it('sends by REST an object no job writes: a task, an email, a file, and one a duplicate rule watches', () => {
    for (const object of ['Task', 'EmailMessage', 'ContentVersion', 'Attachment']) {
      expect(forgeWritesOf(object, 50_000, {})).toEqual({ jobs: [], rest: 50_000 });
    }
    // The standard rules' objects until the target says which its rules watch.
    expect(forgeWritesOf('Account', 25_000, {})).toEqual({ jobs: [], rest: 25_000 });
    expect(forgeWritesOf('Account', 25_000, { restOnly: new Set() }).jobs).toHaveLength(3);
    expect(forgeWritesOf('Case', 25_000, { restOnly: new Set(['Case']) })).toEqual({
      jobs: [],
      rest: 25_000,
    });
  });

  it('takes a job of as many rows as the writer sends in one', () => {
    expect(forgeWritesOf('Case', FORGE_BULK_JOB_ROWS + 2_000, {}).jobs).toEqual([
      FORGE_BULK_JOB_ROWS,
      2_000,
    ]);
  });
});

describe('the run part of a clone that writes through the Bulk API', () => {
  it('prices each job by the calls Forge’s writer sends over its whole time, the rest by REST calls of 200', () => {
    // And what it reads of the target as it writes each object.
    expect(forgeRequestPartsOf({ plan, bulk: {} })).toEqual({ run: CASES + REST + TARGET_READS });
    // Every row by REST, as a clone of records writes them: 125, 15 and 3.
    expect(forgeRequestPartsOf({ plan })).toEqual({ run: 125 + 15 + 3 });
  });

  it('prices a job at the pace a seed of 12,000 cases saved its records at, not at the pace of deletes', () => {
    const tenThousand = writePlanOf([counted('Case', 10_000)]);

    expect(forgeRequestPartsOf({ plan: tenThousand, bulk: {} })).toEqual({
      run: JOB_10K + WHOLE_ORG_TARGET_READS_PER_OBJECT,
    });
    // At the pace of deletes, 37 seconds: four waits, five reads, eleven calls.
    expect(
      bulkJobRequests({ stateReads: bulkJobStateReads(10_000, FORGE_BULK_POLL_SCHEDULE) }),
    ).toBe(11);
  });

  it('counts the second pass’s updates as jobs too, and a call per file copied', () => {
    expect(
      forgeRequestPartsOf({ plan, bulk: {}, updatedAfterInsert: ['Case', 'Account'], files: 40 }),
    ).toEqual({ run: CASES + REST + CASES + 3 + 40 + TARGET_READS });
  });
});

describe('what a clone of the whole org takes beside the target’s requests', () => {
  const measures: WholeOrgMeasures = { files: { count: 450, bytes: 300 * MB } };

  it('counts the source’s requests still to come: a page per 2,000 rows, a read per file, a query of links per 200 files', () => {
    // 13 pages of cases, 2 of tasks, 1 of accounts; 450 files, 3 queries of
    // their links; and what it reads of the source besides, each object.
    expect(wholeOrgCostOf({ plan, measures }).sourceRequests).toBe(
      13 + 2 + 1 + 450 + 3 + SOURCE_READS,
    );
    // What the executor counted of its own reads stands for the gate's pages.
    expect(wholeOrgCostOf({ plan, measures: { ...measures, sourceReads: 9 } }).sourceRequests).toBe(
      9 + SOURCE_READS,
    );
    // From the command line, what it sent the source before the gate, as counted.
    expect(
      wholeOrgCostOf({ plan, measures: { ...measures, sourceReads: 9 }, sourceSentBefore: 246 })
        .sourceRequests,
    ).toBe(9 + SOURCE_READS + 246);
  });

  it('counts a Bulk API batch per job, its second pass’s included, and names what goes by REST', () => {
    expect(wholeOrgCostOf({ plan, measures })).toMatchObject({
      objects: [
        { objectApiName: 'Case', rows: 25_000, jobs: 3 },
        { objectApiName: 'Task', rows: 3_000, jobs: 0 },
        { objectApiName: 'Account', rows: 600, jobs: 0 },
      ],
      bulkBatches: 3,
      restObjects: ['Task', 'Account'],
    });
    expect(wholeOrgCostOf({ plan, measures, updatedAfterInsert: ['Case'] }).bulkBatches).toBe(6);
  });

  it('reckons the time its writes take, one after another: each job its wait and 60 records a second, REST 0.01 s a record', () => {
    expect(wholeOrgCostOf({ plan, measures }).durationSeconds).toBeCloseTo(
      2 * (24 + 10_000 / 60) + (24 + 5_000 / 60) + 3_000 * 0.01 + 600 * 0.01,
    );
  });
});

/** A clone of the whole org that copies no file and measured nothing past its counts. */
const NO_MEASURES: WholeOrgMeasures = {};

describe('the write budget of a clone of the whole org, one part of the model of every run', () => {
  /** What the gate is given of a clone of the whole org whose limits all fit. */
  const fits = {
    plan,
    budget: { max: 5_000_000, remaining: 4_900_000 },
    target: 'TGT-SB',
    wholeOrg: {
      measures: NO_MEASURES,
      bulkBatches: { max: 15_000, remaining: 14_990 },
      sourceBudget: { max: 5_000_000, remaining: 4_000_000 },
      source: 'SRC',
    },
  };

  it('lets through a clone every allowance of which fits, and always asks', () => {
    const budget = forgeWriteBudgetOf(fits);

    expect(budget.stop).toBeUndefined();
    expect(budget.asks).toBe(true);
    expect(budget.api).toMatchObject({ verdict: 'fits', estimate: CASES + REST + TARGET_READS });
    expect(budget.wholeOrg.source).toMatchObject({ verdict: 'fits', estimate: 16 + SOURCE_READS });
    expect(budget.wholeOrg.bulkBatches).toMatchObject({ verdict: 'fits', estimate: 3 });
  });

  it('refuses its writes past the target’s requests, naming them the target’s', () => {
    const budget = forgeWriteBudgetOf({ ...fits, budget: { max: 15_000, remaining: 50 } });

    expect(budget.stop).toMatchObject({
      code: API_BUDGET_EXCEEDED,
      api: {
        kind: 'requests',
        org: 'target',
        estimate: CASES + REST + TARGET_READS,
        remaining: 50,
      },
    });
    expect(budget.stop?.message).toMatch(/^The run takes about 75 API requests, and TGT-SB has 50/);
    expect(ForgeRunGateError.of(defined(budget.stop)).stop).toEqual({
      code: API_BUDGET_EXCEEDED,
      api: { kind: 'requests', org: 'target', estimate: 75, remaining: 50 },
    });
  });

  it('prices a clone counted live at no fewer requests than it then sent either org', () => {
    // Asked live on a scratch org: 157 records of 19 objects by REST, a
    // checkpoint first of 64 requests. The target took about 220 requests in
    // all, 73 of them before the gate; the source about 314, 246 before it,
    // and its pages were priced 21. Priced its writes and pages alone, the
    // run said 87 and 21.
    const rowsOf: Array<[string, number]> = [
      ['PricebookEntry', 47],
      ['Account', 24],
      ['Case', 22],
      ['Contact', 22],
      ['WorkBadgeDefinition', 12],
      ['Lead', 4],
      ['OpportunityLineItem', 4],
      ['OrderItem', 4],
      ['Product2', 3],
      ['CaseComment', 2],
      ['Order', 2],
      ['Task', 2],
      ['QuoteLineItem', 2],
      ['Quote', 1],
      ['Event', 2],
      ['Entitlement', 1],
      ['Pricebook2', 1],
      ['ContentWorkspace', 1],
      ['FieldServiceMobileSettings', 1],
    ];
    const live = writePlanOf(rowsOf.map(([name, rows]) => counted(name, rows)));
    expect(live.totalRows).toBe(157);

    const budget = forgeWriteBudgetOf({
      plan: live,
      checkpoint: estimateOf(64),
      sentBefore: 73,
      budget: { max: 5_000_000, remaining: 4_980_000 },
      target: 'TGT-SB',
      wholeOrg: {
        measures: { sourceReads: 21 },
        bulkBatches: { max: 15_000, remaining: 14_977 },
        sourceBudget: { max: 5_000_000, remaining: 4_995_000 },
        source: 'SRC',
        sourceSentBefore: 246,
      },
    });

    expect(budget.api.estimate).toBeGreaterThanOrEqual(220);
    expect(budget.wholeOrg.source.estimate).toBeGreaterThanOrEqual(314);
  });

  it('refuses its jobs past the Bulk API batches the target has left today', () => {
    const budget = forgeWriteBudgetOf({
      ...fits,
      wholeOrg: { ...fits.wholeOrg, bulkBatches: { max: 15_000, remaining: 2 } },
    });

    expect(budget.stop).toEqual({
      code: API_BUDGET_EXCEEDED,
      message:
        'The run writes through Bulk API jobs that take about 3 of the daily Bulk API batches, ' +
        'and TGT-SB has 2 of its 15000 left: its jobs would be refused part way through. Run it ' +
        'once the org has batches to spare — the limit is counted over the last 24 hours, and ' +
        'Bulk API 1.0 shares it — or leave objects out. Nothing was written.',
      api: { kind: 'bulkBatches', org: 'target', estimate: 3, remaining: 2 },
    });
  });

  it('refuses its reads past the requests the source has left today', () => {
    const budget = forgeWriteBudgetOf({
      ...fits,
      wholeOrg: { ...fits.wholeOrg, sourceBudget: { max: 15_000, remaining: 15 } },
    });

    expect(budget.stop).toMatchObject({
      code: API_BUDGET_EXCEEDED,
      api: { kind: 'requests', org: 'source', estimate: 16 + SOURCE_READS, remaining: 15 },
    });
    expect(budget.stop?.message).toMatch(
      /^The run reads the source records in about 25 API requests, and SRC has 15 of its 15000/,
    );
  });

  it('refuses a large target for the checkpoint it would take first, before any budget, the others said besides', () => {
    const tooMany = {
      code: 'TOO_MANY_RECORDS' as const,
      message:
        'The objects this checkpoint would keep hold 380000 records in TGT-SB, past its limit ' +
        'of 200000: pick fewer objects, or raise the limit. No record was read.',
    };
    const budget = forgeWriteBudgetOf({
      ...fits,
      checkpoint: estimateOf(400, tooMany),
      budget: { max: 15_000, remaining: 100 },
      wholeOrg: { ...fits.wholeOrg, bulkBatches: { max: 15_000, remaining: 0 } },
    });

    expect(budget.stop).toMatchObject({ code: CHECKPOINT_REFUSED, refusal: tooMany });
    expect(ForgeRunGateError.of(defined(budget.stop)).stop).toEqual({
      code: CHECKPOINT_REFUSED,
      reason: 'TOO_MANY_RECORDS',
    });
    // The checkpoint's requests counted among the target's, then each other refusal in turn.
    expect(budget.api).toMatchObject({ estimate: CASES + REST + TARGET_READS + 400 });
    expect(budget.alsoRefused?.map((refused) => refused.api)).toEqual([
      {
        kind: 'requests',
        org: 'target',
        estimate: CASES + REST + TARGET_READS + 400,
        remaining: 100,
      },
      { kind: 'bulkBatches', org: 'target', estimate: 3, remaining: 0 },
    ]);
  });

  it('says the batches could not be read when the target does not list them, and refuses nothing for them', () => {
    const budget = forgeWriteBudgetOf({
      ...fits,
      wholeOrg: { ...fits.wholeOrg, bulkBatches: undefined },
    });

    expect(budget.wholeOrg.bulkBatches).toEqual({
      verdict: 'unread',
      estimate: 3,
      unread: BULK_BATCHES_NOT_TOLD,
    });
    expect(budget.stop).toBeUndefined();
  });

  it('holds a run that sends no job to no Bulk API batch', () => {
    const small = writePlanOf([counted('Case', 1_500)]);
    expect(forgeWriteBudgetOf({ ...fits, plan: small }).wholeOrg.bulkBatches).toBeUndefined();
  });

  it('leaves any other run as it was: every write by REST, no allowance of a whole org, asked only for its checkpoint', () => {
    const budget = forgeWriteBudgetOf({
      plan,
      budget: { max: 15_000, remaining: 50 },
      target: 'TGT-SB',
    });

    expect(budget.api).toMatchObject({ estimate: 143 });
    expect(budget.stop).toEqual({ code: API_BUDGET_EXCEEDED, message: expect.any(String) });
    expect(budget).not.toHaveProperty('wholeOrg');
    expect(budget).not.toHaveProperty('alsoRefused');
    expect(budget.asks).toBe(false);
  });
});

describe('the objects a clone of the whole org reads whole past their bound', () => {
  it('refuses them by name, held to the lowest bound, and keeps them on its error', () => {
    const stop = readBoundStopOf([
      { objectApiName: 'PricebookEntry', rows: 72_000, bound: 50_000 },
      { objectApiName: 'Product2', rows: 51_000, bound: 50_000 },
    ]);

    expect(stop).toEqual({
      code: 'READ_BOUND_EXCEEDED',
      message:
        'A clone of the whole org reads a few objects whole, and PricebookEntry (72000 rows), ' +
        'Product2 (51000 rows) hold more than the 50000 rows of one object the ' +
        'sandforge.forge.maxRecordsPerObject setting lets a run hold at once: raise the setting ' +
        'or leave the object out on Review. Nothing was written.',
      readBound: {
        bound: 50_000,
        objects: [
          { objectApiName: 'PricebookEntry', rows: 72_000 },
          { objectApiName: 'Product2', rows: 51_000 },
        ],
      },
    });
    expect(ForgeRunGateError.of(defined(stop)).stop?.readBound?.bound).toBe(50_000);
    expect(readBoundStopOf(undefined)).toBeUndefined();
    expect(readBoundStopOf([])).toBeUndefined();
  });

  it('names no more objects on its error than the page reads', () => {
    const over = Array.from({ length: 250 }, (_, i) => ({
      objectApiName: `Ref_${i}__c`,
      rows: 60_000,
      bound: 50_000,
    }));
    expect(readBoundStopOf(over)?.readBound?.objects).toHaveLength(200);
  });
});

describe('the files a clone of the whole org copies, against the target’s file storage', () => {
  const told = {
    maxMB: 1_024,
    remainingMB: 900,
    fileStorage: { maxMB: 2_048, remainingMB: 100 },
  };

  it('refuses files past the file storage the target has left, as a refusal for files', () => {
    const { files, stop } = wholeOrgFilesOf({ count: 450, bytes: 300 * MB }, told, 'TGT-SB');

    expect(files).toMatchObject({ count: 450, check: { verdict: 'exceeds', estimateMB: 300 } });
    expect(stop).toEqual({
      code: 'STORAGE_EXCEEDED',
      message:
        'The files to copy take about 300 MB of file storage, and TGT-SB has 100 MB left of ' +
        '2048 MB: leave out the objects whose files take it, turn the copy of files off on ' +
        'Review, or free file storage in TGT-SB. Nothing was written.',
      storage: { estimateMB: 300, remainingMB: 100, kind: 'files' },
    });
    expect(ForgeRunGateError.of(defined(stop)).stop?.storage).toEqual({
      estimateMB: 300,
      remainingMB: 100,
      kind: 'files',
    });
  });

  it('lets through files that fit', () => {
    expect(wholeOrgFilesOf({ count: 3, bytes: MB }, told, 'TGT-SB')).toEqual({
      files: { count: 3, check: expect.objectContaining({ verdict: 'fits' }) },
    });
  });

  // The file copier of every other run refuses files it could not check
  // against the target's file storage: copied unmeasured, a whole org's
  // files could fill it part way through, records written and files not.
  it('refuses files whose fit the target would not tell, as the file copier of any run does', () => {
    const { files, stop } = wholeOrgFilesOf(
      { count: 3, bytes: MB },
      { maxMB: 1, remainingMB: 1 },
      'TGT-SB',
    );

    expect(files).toMatchObject({
      check: { verdict: 'unread', unread: 'the limits the org answered list no FileStorageMB' },
    });
    expect(stop).toEqual({
      code: 'FILE_STORAGE_UNREAD',
      message:
        'The file storage TGT-SB has left could not be read (the limits the org answered list ' +
        'no FileStorageMB), so the 3 files to copy could not be checked against it: turn the ' +
        'copy of files off on Review, or run it again once the org answers. Nothing was written.',
    });
    expect(
      wholeOrgFilesOf({ count: 3, bytes: MB }, { unread: 'REQUEST_LIMIT_EXCEEDED' }, 'TGT-SB').stop
        ?.code,
    ).toBe('FILE_STORAGE_UNREAD');
  });

  it('refuses files the source would neither sum nor list', () => {
    expect(wholeOrgFilesOf({ unmeasured: true }, told, 'TGT-SB')).toEqual({
      files: { unmeasured: true },
      stop: {
        code: 'FILES_UNREAD',
        message: expect.stringContaining('The source would neither sum nor list its files'),
      },
    });
  });

  it('checks nothing for a clone that copies none', () => {
    expect(wholeOrgFilesOf(undefined, told, 'TGT-SB')).toEqual({});
    expect(wholeOrgFilesOf({ count: 0, bytes: 0 }, told, 'TGT-SB')).toEqual({});
  });
});

describe('the write plan of a clone of the whole org', () => {
  it('takes its emails at the size of their text, which a count says nothing of', () => {
    const objects = [counted('EmailMessage', 12_000), counted('Case', 100)];

    expect(
      writePlanOf(objects).objects.find((o) => o.objectApiName === 'EmailMessage'),
    ).toMatchObject({ storageBytes: 0 });
    const measured = wholeOrgWritePlanOf(objects, { emailTextBytes: 90 * MB });
    expect(measured.objects.find((o) => o.objectApiName === 'EmailMessage')).toMatchObject({
      rows: 12_000,
      storageBytes: 90 * MB,
    });
    expect(measured.storageBytes).toBe(90 * MB + 100 * 2 * 1024);
    expect(wholeOrgWritePlanOf(objects, {})).toEqual(writePlanOf(objects));
  });
});

describe('what a clone of the whole org leaves out, and the personal fields it copies as they are', () => {
  const graph: WholeOrgGraph = {
    nodes: [
      {
        objectApiName: 'Contact',
        included: true,
        piiFields: ['Email', 'Phone', 'Birthdate'],
        anonymizeFields: ['Email', 'Phone'],
      },
      { objectApiName: 'Case', included: true, piiFields: ['SuppliedEmail'], anonymizeFields: [] },
      {
        objectApiName: 'Lead',
        included: false,
        piiFields: ['Email'],
        anonymizeFields: ['Email'],
        leftOutByUser: true,
      },
      { objectApiName: 'Note', included: true, piiFields: [], anonymizeFields: [] },
    ],
    leftOut: [
      { objectApiName: 'User', reason: 'setup' },
      { objectApiName: 'Profile', reason: 'setup' },
      { objectApiName: 'Invoice', reason: 'platformCreated' },
      { objectApiName: 'AccountHistory', reason: 'history' },
    ],
  };

  it('names every object it leaves out with why, those the user took out besides, and counts them by reason', () => {
    expect(wholeOrgLeftOutOf(graph)).toEqual({
      objects: [...(graph.leftOut ?? []), { objectApiName: 'Lead', reason: 'excludedByUser' }],
      counts: [
        { reason: 'setup', count: 2 },
        { reason: 'excludedByUser', count: 1 },
        { reason: 'history', count: 1 },
        { reason: 'platformCreated', count: 1 },
      ],
    });
  });

  it('copies as they are every personal field with Anonymize off, and only those left unselected with it on', () => {
    const written = new Set(['Contact', 'Case', 'Lead', 'Note']);

    expect(personalFieldsAsIsOf(graph.nodes, written, false)).toEqual([
      { objectApiName: 'Contact', fields: ['Email', 'Phone', 'Birthdate'] },
      { objectApiName: 'Case', fields: ['SuppliedEmail'] },
    ]);
    expect(personalFieldsAsIsOf(graph.nodes, written, true)).toEqual([
      { objectApiName: 'Contact', fields: ['Birthdate'] },
      { objectApiName: 'Case', fields: ['SuppliedEmail'] },
    ]);
    // An object the run writes nothing of copies nothing as it is.
    expect(personalFieldsAsIsOf(graph.nodes, new Set(['Case']), false)).toEqual([
      { objectApiName: 'Case', fields: ['SuppliedEmail'] },
    ]);
  });
});

/**
 * An org that answers its `/limits` and fails at the least call that is not
 * a read of them: a dry run that sent a write would throw here, and every
 * call is kept, so a test can say what was sent.
 */
function readOnlyOrg(answer: unknown): LimitsTransport & {
  calls: string[];
  create: () => never;
  update: () => never;
  destroy: () => never;
  bulk2: { loadAndWaitForResults: () => never };
} {
  const calls: string[] = [];
  const write = (what: string): never => {
    calls.push(what);
    throw new Error(`a dry run writes nothing, and it sent ${what}`);
  };
  return {
    calls,
    // Typed wider than a read of the limits, so that a write would reach it.
    request: async ({ method, url }: { method: string; url: string }) => {
      calls.push(`${method} ${url}`);
      if (method !== 'GET' || url !== '/limits') return write(`${method} ${url}`);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    create: () => write('create'),
    update: () => write('update'),
    destroy: () => write('destroy'),
    bulk2: { loadAndWaitForResults: () => write('a Bulk API job') },
  };
}

describe('the dry run of a clone of the whole org, stopped at its gate', () => {
  const graph: WholeOrgGraph = {
    nodes: [
      { objectApiName: 'Case', included: true, piiFields: ['SuppliedEmail'], anonymizeFields: [] },
      { objectApiName: 'Task', included: true, piiFields: [], anonymizeFields: [] },
      {
        objectApiName: 'Account',
        included: true,
        piiFields: ['Phone'],
        anonymizeFields: ['Phone'],
      },
      {
        objectApiName: 'EmailMessage',
        included: true,
        piiFields: ['ToAddress'],
        anonymizeFields: [],
      },
    ],
    leftOut: [{ objectApiName: 'User', reason: 'setup' }],
  };
  const objects = [
    counted('Case', 25_000),
    counted('Task', 3_000),
    {
      ...counted('Account', 600),
      leftOut: { heldBack: 0, writtenBefore: 0, linkedByValue: { rows: 2, fields: ['Key__c'] } },
    },
    counted('EmailMessage', 1_200),
  ];
  const measures: WholeOrgMeasures = {
    emailTextBytes: 40 * MB,
    files: { count: 450, bytes: 300 * MB },
  };

  it('says what the run would insert and take of both orgs, reading their limits and nothing else, writing nothing', async () => {
    const target = readOnlyOrg(limitsAnswer());
    const source = readOnlyOrg({ DailyApiRequests: { Max: 5_000_000, Remaining: 4_000_000 } });

    const dry = await wholeOrgDryRunOf({
      objects,
      measures,
      graph,
      anonymizePII: true,
      target: { org: 'TGT-SB', limits: target },
      source: { org: 'SRC', limits: source },
    });

    expect(target.calls).toEqual(['GET /limits']);
    expect(source.calls).toEqual(['GET /limits']);
    expect(dry.wouldInsert).toEqual([
      { objectApiName: 'Case', rows: 25_000, jobs: 3, byRest: 0 },
      { objectApiName: 'Task', rows: 3_000, jobs: 0, byRest: 3_000 },
      { objectApiName: 'EmailMessage', rows: 1_200, jobs: 0, byRest: 1_200 },
      { objectApiName: 'Account', rows: 600, jobs: 0, byRest: 600 },
    ]);
    expect(dry.totalRows).toBe(29_800);
    // The tasks in 15 REST calls, the emails in 6, the accounts in 4 with the 2
    // the write links by their value, the files a call each, and what it
    // reads of the target as it writes the four objects; and the read of
    // whether the target delivers its emails, which this dry run did not
    // make, at the most a run's sends.
    const targetReads = 4 * WHOLE_ORG_TARGET_READS_PER_OBJECT;
    expect(dry.targetRequests).toMatchObject({
      verdict: 'fits',
      estimate: CASES + 15 + 6 + 4 + 450 + targetReads + 2,
      remaining: 4_900_000,
      parts: { run: CASES + 15 + 6 + 4 + 450 + targetReads, deliverability: 2 },
    });
    expect(dry.sourceRequests).toMatchObject({
      verdict: 'fits',
      estimate: 13 + 2 + 1 + 1 + 450 + 3 + 4 * WHOLE_ORG_SOURCE_READS_PER_OBJECT,
    });
    expect(dry.bulkBatches).toMatchObject({ verdict: 'fits', estimate: 3, remaining: 14_990 });
    expect(dry.storage).toMatchObject({ verdict: 'fits', remainingMB: 900 });
    expect(dry.storage.estimateMB).toBeCloseTo(40 + ((25_000 + 3_000 + 600) * 2) / 1024);
    expect(dry.files).toMatchObject({ count: 450, check: { verdict: 'fits', estimateMB: 300 } });
    expect(dry.leftOut).toEqual({
      objects: [{ objectApiName: 'User', reason: 'setup' }],
      counts: [{ reason: 'setup', count: 1 }],
      rows: {
        writtenBefore: 0,
        heldBack: [],
        linkedByValue: [{ objectApiName: 'Account', rows: 2, fields: ['Key__c'] }],
      },
    });
    expect(dry.personalAsIs).toEqual([
      { objectApiName: 'Case', fields: ['SuppliedEmail'] },
      { objectApiName: 'EmailMessage', fields: ['ToAddress'] },
    ]);
    expect(dry.durationSeconds).toBeCloseTo(
      2 * (24 + 10_000 / 60) + (24 + 5_000 / 60) + (3_000 + 1_200 + 600) * 0.01,
    );
    expect(dry.wouldBeRefused).toEqual([]);
  });

  it('prices the target’s requests as its run’s gate prices them: the read-backs, the lease of the mute and the read of the deliverability, never fewer', async () => {
    const budget = { max: 5_000_000, remaining: 4_900_000 };
    const runGate = (beside: { readBack?: number; mute?: number; deliverability?: number }) =>
      forgeWriteBudgetOf({
        plan: wholeOrgWritePlanOf(objects, measures),
        ...beside,
        budget,
        target: 'TGT-SB',
        wholeOrg: { measures, bulkBatches: undefined, sourceBudget: undefined, source: 'SRC' },
      }).api;
    const dryOf = (beside: { readBack?: number; mute?: number; deliverability?: number }) =>
      wholeOrgDryRunOf({
        objects,
        measures,
        graph,
        anonymizePII: true,
        ...beside,
        target: { org: 'TGT-SB', limits: readOnlyOrg(limitsAnswer()) },
        source: { org: 'SRC', limits: readOnlyOrg({ DailyApiRequests: { Max: 9, Remaining: 9 } }) },
      });

    // Three read-backs of the record types given, a mute of one set — its
    // identity, three reads, the set assigned and taken back — and the
    // Apex of the deliverability, as the run's gate is told them.
    const told = { readBack: 3, mute: 7, deliverability: 1 };
    const dry = await dryOf(told);
    expect(dry.targetRequests).toMatchObject({
      estimate: runGate(told).estimate,
      parts: { readBack: 3, mute: 7, deliverability: 1 },
    });
    // Nothing that still runs sends an email: no read, as the run.
    expect((await dryOf({ ...told, deliverability: 0 })).targetRequests.estimate).toBe(
      runGate({ ...told, deliverability: 0 }).estimate,
    );
    // The deliverability not read, the most its read sends: above the run's
    // whatever that read sent.
    const unread = (await dryOf({ readBack: 3, mute: 7 })).targetRequests;
    expect(unread).toMatchObject({ parts: { deliverability: 2 } });
    for (const deliverability of [0, 1, 2]) {
      expect(unread.estimate).toBeGreaterThanOrEqual(
        runGate({ readBack: 3, mute: 7, deliverability }).estimate,
      );
    }
  });

  it('prices, from the command line, what it sent each org before its gate as sent, read once it has read the limits', async () => {
    const target = readOnlyOrg(limitsAnswer());
    const source = readOnlyOrg({ DailyApiRequests: { Max: 5_000_000, Remaining: 4_000_000 } });
    const read: Array<{ target: number; source: number }> = [];
    const priced = await wholeOrgDryRunOf({
      objects,
      measures,
      graph,
      anonymizePII: true,
      deliverability: 0,
      // Discovery's 246 of the source and the target's reads before the
      // gate, then the limits each dry run read.
      sentBefore: () => {
        const sent = { target: 73 + target.calls.length, source: 246 + source.calls.length };
        read.push(sent);
        return sent;
      },
      target: { org: 'TGT-SB', limits: target },
      source: { org: 'SRC', limits: source },
    });
    const unpriced = await wholeOrgDryRunOf({
      objects,
      measures,
      graph,
      anonymizePII: true,
      deliverability: 0,
      target: { org: 'TGT-SB', limits: readOnlyOrg(limitsAnswer()) },
      source: { org: 'SRC', limits: readOnlyOrg({ DailyApiRequests: { Max: 9, Remaining: 9 } }) },
    });

    expect(read).toEqual([{ target: 74, source: 247 }]);
    expect(priced.targetRequests.estimate).toBe(unpriced.targetRequests.estimate + 74);
    expect(priced.sourceRequests.estimate).toBe(unpriced.sourceRequests.estimate + 247);
  });

  it('names every refusal the run would meet, in the order it meets them', async () => {
    const target = readOnlyOrg(
      limitsAnswer({
        DataStorageMB: { Max: 5, Remaining: 4 },
        FileStorageMB: { Max: 20, Remaining: 20 },
        DailyApiRequests: { Max: 15_000, Remaining: 300 },
        DailyBulkApiBatches: { Max: 15_000, Remaining: 1 },
      }),
    );
    const source = readOnlyOrg({ DailyApiRequests: { Max: 15_000, Remaining: 30 } });

    const dry = await wholeOrgDryRunOf({
      objects,
      measures: {
        ...measures,
        readWholeOver: [{ objectApiName: 'PricebookEntry', rows: 72_000, bound: 50_000 }],
      },
      graph,
      anonymizePII: false,
      checkpoint: estimateOf(40, {
        code: 'TOO_MANY_RECORDS',
        message: 'The objects this checkpoint would keep hold 380000 records in TGT-SB.',
      }),
      target: { org: 'TGT-SB', limits: target },
      source: { org: 'SRC', limits: source },
    });

    expect(dry.wouldBeRefused.map(({ code, storage, api }) => ({ code, storage, api }))).toEqual([
      { code: 'READ_BOUND_EXCEEDED', storage: undefined, api: undefined },
      {
        code: 'STORAGE_EXCEEDED',
        storage: { estimateMB: expect.any(Number), remainingMB: 4 },
        api: undefined,
      },
      {
        code: 'STORAGE_EXCEEDED',
        storage: { estimateMB: 300, remainingMB: 20, kind: 'files' },
        api: undefined,
      },
      { code: CHECKPOINT_REFUSED, storage: undefined, api: undefined },
      {
        code: API_BUDGET_EXCEEDED,
        storage: undefined,
        api: { kind: 'requests', org: 'target', estimate: expect.any(Number), remaining: 300 },
      },
      {
        code: API_BUDGET_EXCEEDED,
        storage: undefined,
        api: { kind: 'bulkBatches', org: 'target', estimate: 3, remaining: 1 },
      },
      {
        code: API_BUDGET_EXCEEDED,
        storage: undefined,
        api: {
          kind: 'requests',
          org: 'source',
          estimate: 470 + 4 * WHOLE_ORG_SOURCE_READS_PER_OBJECT,
          remaining: 30,
        },
      },
    ]);
    expect(dry.wouldBeRefused[1]?.message).toMatch(/data storage.*Nothing was written\.$/);
    expect(target.calls).toEqual(['GET /limits']);
    expect(source.calls).toEqual(['GET /limits']);
  });

  it('reads the target’s requests on their own when its limits leave the storage out, and says what it could not read', async () => {
    const target = readOnlyOrg({ DailyApiRequests: { Max: 5_000_000, Remaining: 4_000_000 } });
    const source = readOnlyOrg(new Error('INSUFFICIENT_ACCESS: no API access'));

    const dry = await wholeOrgDryRunOf({
      objects,
      measures,
      graph,
      anonymizePII: false,
      target: { org: 'TGT-SB', limits: target },
      source: { org: 'SRC', limits: source },
    });

    expect(target.calls).toEqual(['GET /limits', 'GET /limits']);
    expect(dry.storage.verdict).toBe('unread');
    expect(dry.targetRequests).toMatchObject({ verdict: 'fits', remaining: 4_000_000 });
    expect(dry.sourceRequests).toMatchObject({
      verdict: 'unread',
      unread: 'INSUFFICIENT_ACCESS: no API access',
    });
    expect(dry.bulkBatches).toMatchObject({ verdict: 'unread' });
    expect(dry.files).toMatchObject({ check: { verdict: 'unread' } });
    // What could not be read refuses nothing, but the files the target's
    // file storage could not be checked for, as the file copier refuses them.
    expect(dry.wouldBeRefused.map((stop) => stop.code)).toEqual(['FILE_STORAGE_UNREAD']);
  });
});
