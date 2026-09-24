import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  AutopilotEdge,
  AutopilotAnonymizationRule,
  AutopilotNodeProgressEvent,
  AutopilotNodeCompletedEvent,
  AutopilotNodeFailedEvent,
  ApiName,
  ExecutionPlan,
} from '@sandforge/shared';
import { STANDARD_PRICEBOOK_SOQL } from '@sandforge/shared';
import {
  AutopilotExecutor,
  type AutopilotExecutionFailedEvent,
  type AutopilotExecutorDeps,
  type QueryFn,
  type InsertFn,
  type UpdateFn,
} from './AutopilotExecutor.js';
import type { SaveOutcome } from '../../core/common/existingRecordMatch.js';
import type { SoqlQuery } from '../../core/common/platformRecords.js';
import type { DescribedLookup } from '../../core/metadata/describedLookups.js';
import { RECORD_TYPES_SOQL } from '../sync/RecordTypeMapper.js';
import { logger } from '../../logger.js';
import type { SmartAnonymizer } from './SmartAnonymizer.js';
import { RecordIdRemapper } from './RecordIdRemapper.js';
import { selectRows, type FakeRow } from '../../test/fakeSoql.js';

/** Local alias matching the autopilot domain name. */
type AnonymizationRule = AutopilotAnonymizationRule;

/** Helper to create an anonymization rule fixture. */
function makeRule(overrides: Partial<AnonymizationRule> = {}): AnonymizationRule {
  return {
    objectApiName: 'Contact' as ApiName,
    fieldApiName: 'Email',
    method: 'fake',
    piiCategory: 'PII',
    aiConfidence: 0.95,
    userOverridden: false,
    ...overrides,
  };
}

/** Helper to create a minimal execution plan. */
function makePlan(
  waves: Array<{ order: number; objects: string[]; dependsOn: number[] }>,
  totalRecords = 0,
): ExecutionPlan {
  return {
    waves: waves.map((w) => ({
      order: w.order,
      objects: w.objects as ApiName[],
      dependsOn: w.dependsOn,
    })),
    totalRecords,
    estimatedDurationSec: 10,
    estimatedApiCalls: 5,
    complianceFramework: 'gdpr',
    anonymizationSummary: {
      totalPiiFields: 0,
      totalFieldsToAnonymize: 0,
      methodBreakdown: {
        fake: 0,
        mask: 0,
        hash: 0,
        nullify: 0,
        redact: 0,
        shuffle: 0,
        truncate: 0,
        preserve_format: 0,
        age_band: 0,
        generalize: 0,
        constant: 0,
      },
      objectsWithPii: [],
    },
    cycleResolutions: [],
  };
}

/** Helper to create an edge fixture. */
function makeEdge(overrides: Partial<AutopilotEdge> = {}): AutopilotEdge {
  return {
    from: 'Account' as ApiName,
    to: 'Contact' as ApiName,
    fieldApiName: 'AccountId',
    relationshipType: 'lookup',
    required: false,
    ...overrides,
  };
}

/** Outcomes of records the target wrote, with the ids it gave them. */
function written(...ids: string[]): SaveOutcome[] {
  return ids.map((id) => ({ id, success: true, errors: [] }));
}

/** The outcome of a record the target refused, as `toSaveOutcome` builds it. */
function refused(statusCode: string, message: string, fields: string[] = []): SaveOutcome {
  return {
    id: '',
    success: false,
    errors: [`${statusCode}: ${message}`],
    errorDetails: [{ statusCode, message, fields }],
  };
}

/** Create mock dependencies. */
function makeDeps(overrides: Partial<AutopilotExecutorDeps> = {}): AutopilotExecutorDeps {
  const queryMock: QueryFn = vi.fn().mockResolvedValue([]);
  const insertMock: InsertFn = vi.fn().mockResolvedValue([]);

  const anonymizerMock = {
    anonymize: vi.fn().mockImplementation((records: Record<string, unknown>[]) => records),
    getPersonaRegistry: vi.fn(),
  } as unknown as SmartAnonymizer;

  const remapperMock = {
    remapRecords: vi.fn().mockReturnValue({ remapped: 0, missing: 0, skipped: 0, unresolved: [] }),
    registerMappings: vi.fn(),
    getTargetId: vi.fn(),
    hasObject: vi.fn(),
    getMappingCount: vi.fn(),
    totalMappings: 0,
    clear: vi.fn(),
  } as unknown as RecordIdRemapper;

  return {
    query: queryMock,
    insert: insertMock,
    anonymizer: anonymizerMock,
    remapper: remapperMock,
    batchSize: 2,
    ...overrides,
  };
}

describe('AutopilotExecutor', () => {
  let executor: AutopilotExecutor;
  let deps: AutopilotExecutorDeps;

  beforeEach(() => {
    deps = makeDeps();
    executor = new AutopilotExecutor(deps);
  });

  // ── Test 1: Single-wave single-object plan ────────────────────────────────

  it('should execute a single-wave single-object plan and emit started, progress, completed', async () => {
    const events: Array<{ type: string }> = [];
    executor.on('execution-started', (e) => events.push(e));
    executor.on('node-progress', (e) => events.push(e));
    executor.on('node-completed', (e) => events.push(e));
    executor.on('wave-completed', (e) => events.push(e));
    executor.on('execution-completed', (e) => events.push(e));

    const plan = makePlan([{ order: 0, objects: ['Account'], dependsOn: [] }], 3);
    const recordCounts = new Map([['Account', 3]]);

    // Return 2 records in first batch, 1 in second
    vi.mocked(deps.query)
      .mockResolvedValueOnce([
        { Id: 'src1', Name: 'A' },
        { Id: 'src2', Name: 'B' },
      ])
      .mockResolvedValueOnce([{ Id: 'src3', Name: 'C' }]);

    vi.mocked(deps.insert)
      .mockResolvedValueOnce(written('tgt1', 'tgt2'))
      .mockResolvedValueOnce(written('tgt3'));

    const result = await executor.execute(plan, [], [], recordCounts);

    expect(result.totalSuccess).toBe(3);
    expect(result.totalFailure).toBe(0);
    expect(result.completedObjects).toEqual(['Account']);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain('execution-started');
    expect(eventTypes).toContain('node-progress');
    expect(eventTypes).toContain('node-completed');
    expect(eventTypes).toContain('wave-completed');
    expect(eventTypes).toContain('execution-completed');
  });

  // ── Test 2: Multi-wave plan ───────────────────────────────────────────────

  it('should execute multi-wave plan with waves running sequentially', async () => {
    const waveCompletedOrder: number[] = [];
    let waveCount = 0;

    executor.on('wave-completed', () => {
      waveCount++;
      waveCompletedOrder.push(waveCount);
    });

    const plan = makePlan(
      [
        { order: 0, objects: ['Account'], dependsOn: [] },
        { order: 1, objects: ['Contact'], dependsOn: [0] },
      ],
      4,
    );

    const recordCounts = new Map([
      ['Account', 1],
      ['Contact', 1],
    ]);

    vi.mocked(deps.query)
      .mockResolvedValueOnce([{ Id: 'a1', Name: 'Acc' }])
      .mockResolvedValueOnce([{ Id: 'c1', AccountId: 'a1' }]);

    vi.mocked(deps.insert)
      .mockResolvedValueOnce(written('ta1'))
      .mockResolvedValueOnce(written('tc1'));

    const result = await executor.execute(plan, [], [], recordCounts);

    expect(result.totalSuccess).toBe(2);
    expect(result.completedObjects).toEqual(['Account', 'Contact']);
    expect(waveCompletedOrder).toEqual([1, 2]);
  });

  // ── Test 3: Pause/resume ──────────────────────────────────────────────────

  it('should pause and resume execution correctly', async () => {
    const events: string[] = [];
    executor.on('paused', () => events.push('paused'));
    executor.on('resumed', () => events.push('resumed'));
    executor.on('execution-completed', () => events.push('completed'));

    const plan = makePlan(
      [
        { order: 0, objects: ['Account'], dependsOn: [] },
        { order: 1, objects: ['Contact'], dependsOn: [0] },
      ],
      2,
    );
    const recordCounts = new Map([
      ['Account', 1],
      ['Contact', 1],
    ]);

    vi.mocked(deps.query)
      .mockResolvedValueOnce([{ Id: 'a1' }])
      .mockResolvedValueOnce([{ Id: 'c1' }]);

    vi.mocked(deps.insert)
      .mockResolvedValueOnce(written('t1'))
      .mockResolvedValueOnce(written('t2'));

    // Pause after wave 1 completes, before wave 2 starts
    executor.on('wave-completed', () => {
      if (!events.includes('paused')) {
        executor.pause();
        // Resume after a short delay
        setTimeout(() => executor.resume(), 20);
      }
    });

    const result = await executor.execute(plan, [], [], recordCounts);

    expect(result.totalSuccess).toBe(2);
    expect(events).toContain('paused');
    expect(events).toContain('resumed');
    expect(events).toContain('completed');
  });

  // ── Test 4: Skip object ───────────────────────────────────────────────────

  it('should skip an object when skip is called before execution', async () => {
    const plan = makePlan([{ order: 0, objects: ['Account', 'Lead'], dependsOn: [] }], 10);
    const recordCounts = new Map([
      ['Account', 5],
      ['Lead', 5],
    ]);

    executor.skip('Lead');

    vi.mocked(deps.query).mockResolvedValueOnce([{ Id: 'a1' }, { Id: 'a2' }]);

    vi.mocked(deps.insert).mockResolvedValueOnce(written('t1', 't2'));

    const result = await executor.execute(plan, [], [], recordCounts);

    expect(result.skippedObjects).toContain('Lead');
    expect(result.totalSkipped).toBe(5);
    expect(result.completedObjects).toContain('Account');
    // query should only be called for Account
    expect(deps.query).not.toHaveBeenCalledWith('Lead', expect.anything(), expect.anything());
  });

  // ── Test 5: Insert failure emits node-failed ──────────────────────────────

  it('should emit node-failed when all inserts fail and continue execution', async () => {
    const failedEvents: AutopilotNodeFailedEvent[] = [];
    executor.on('node-failed', (e) => failedEvents.push(e));

    const plan = makePlan(
      [
        { order: 0, objects: ['Account'], dependsOn: [] },
        { order: 1, objects: ['Contact'], dependsOn: [0] },
      ],
      2,
    );
    const recordCounts = new Map([
      ['Account', 1],
      ['Contact', 1],
    ]);

    vi.mocked(deps.query)
      .mockResolvedValueOnce([{ Id: 'a1' }])
      .mockResolvedValueOnce([{ Id: 'c1' }]);

    vi.mocked(deps.insert)
      .mockResolvedValueOnce([refused('FIELD_INTEGRITY_EXCEPTION', 'invalid field')])
      .mockResolvedValueOnce(written('tc1'));

    const result = await executor.execute(plan, [], [], recordCounts);

    expect(result.failedObjects).toContain('Account');
    expect(result.completedObjects).toContain('Contact');
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].objectApiName).toBe('Account');
    expect(failedEvents[0].errors).toContain('FIELD_INTEGRITY_EXCEPTION: invalid field');
    // How many records the target refused, not only why: the audit trail
    // counts a failed node's records from this event.
    expect(failedEvents[0].failureCount).toBe(1);
    // The per-node message rides on the result too: the handler reports node
    // status from the result, not from the events.
    expect(result.nodeErrors?.['Account']).toBe('FIELD_INTEGRITY_EXCEPTION: invalid field');
    expect(result.nodeErrors?.['Contact']).toBeUndefined();
  });

  // ── Test 5b: A throwing object carries its message on the result ───────────

  it('should record the thrown message in nodeErrors when an object crashes', async () => {
    const plan = makePlan([{ order: 0, objects: ['Account'], dependsOn: [] }], 1);
    const recordCounts = new Map([['Account', 1]]);

    vi.mocked(deps.query).mockRejectedValueOnce(new Error('INVALID_SESSION_ID: expired session'));

    const result = await executor.execute(plan, [], [], recordCounts);

    expect(result.failedObjects).toContain('Account');
    expect(result.nodeErrors?.['Account']).toContain('INVALID_SESSION_ID: expired session');
  });

  // ── Test 6: Remap IDs correctly across waves ─────────────────────────────

  it('should remap IDs correctly by calling remapper with edges', async () => {
    const edges: AutopilotEdge[] = [
      makeEdge({ from: 'Account' as ApiName, to: 'Contact' as ApiName, fieldApiName: 'AccountId' }),
    ];

    const plan = makePlan(
      [
        { order: 0, objects: ['Account'], dependsOn: [] },
        { order: 1, objects: ['Contact'], dependsOn: [0] },
      ],
      2,
    );
    const recordCounts = new Map([
      ['Account', 1],
      ['Contact', 1],
    ]);

    vi.mocked(deps.query)
      .mockResolvedValueOnce([{ Id: 'srcAcc1', Name: 'Acme' }])
      .mockResolvedValueOnce([{ Id: 'srcCon1', AccountId: 'srcAcc1' }]);

    vi.mocked(deps.insert)
      .mockResolvedValueOnce(written('tgtAcc1'))
      .mockResolvedValueOnce(written('tgtCon1'));

    await executor.execute(plan, edges, [], recordCounts);

    // registerMappings should be called for Account
    expect(deps.remapper.registerMappings).toHaveBeenCalledWith('Account', [
      ['srcAcc1', 'tgtAcc1'],
    ]);

    // remapRecords should be called for Contact with the edges
    expect(deps.remapper.remapRecords).toHaveBeenCalledWith(expect.any(Array), edges, 'Contact');
  });

  // ── Test 7: Anonymization applied to records ──────────────────────────────

  it('should apply anonymization rules to records before insert', async () => {
    const rules: AnonymizationRule[] = [
      makeRule({ objectApiName: 'Contact' as ApiName, fieldApiName: 'Email', method: 'fake' }),
    ];

    const plan = makePlan([{ order: 0, objects: ['Contact'], dependsOn: [] }], 1);
    const recordCounts = new Map([['Contact', 1]]);

    vi.mocked(deps.query).mockResolvedValueOnce([{ Id: 'c1', Email: 'real@example.com' }]);

    vi.mocked(deps.insert).mockResolvedValueOnce(written('tc1'));

    await executor.execute(plan, [], rules, recordCounts);

    expect(deps.anonymizer.anonymize).toHaveBeenCalledWith(
      [{ Id: 'c1', Email: 'real@example.com' }],
      rules,
      'Contact',
    );

    // Anonymizer should be called before insert
    const anonymizeOrder = vi.mocked(deps.anonymizer.anonymize).mock.invocationCallOrder[0];
    const insertOrder = vi.mocked(deps.insert).mock.invocationCallOrder[0];
    expect(anonymizeOrder).toBeLessThan(insertOrder);
  });

  // ── Test 8: Empty plan ────────────────────────────────────────────────────

  it('should emit execution-completed immediately for empty plan', async () => {
    const events: string[] = [];
    executor.on('execution-started', () => events.push('started'));
    executor.on('execution-completed', () => events.push('completed'));

    const plan = makePlan([], 0);
    const result = await executor.execute(plan, [], [], new Map());

    expect(result.totalSuccess).toBe(0);
    expect(result.totalFailure).toBe(0);
    expect(result.totalSkipped).toBe(0);
    expect(result.completedObjects).toEqual([]);
    expect(events).toEqual(['started', 'completed']);
    expect(deps.query).not.toHaveBeenCalled();
  });

  // ── Test 9: Progress events show correct percentages ──────────────────────

  it('should emit progress events with correct percentages', async () => {
    const progressEvents: AutopilotNodeProgressEvent[] = [];
    executor.on('node-progress', (e) => progressEvents.push(e));

    const plan = makePlan([{ order: 0, objects: ['Account'], dependsOn: [] }], 4);
    const recordCounts = new Map([['Account', 4]]);

    // batchSize is 2, so 2 batches
    vi.mocked(deps.query)
      .mockResolvedValueOnce([{ Id: 'a1' }, { Id: 'a2' }])
      .mockResolvedValueOnce([{ Id: 'a3' }, { Id: 'a4' }]);

    vi.mocked(deps.insert)
      .mockResolvedValueOnce(written('t1', 't2'))
      .mockResolvedValueOnce(written('t3', 't4'));

    await executor.execute(plan, [], [], recordCounts);

    expect(progressEvents).toHaveLength(2);
    expect(progressEvents[0].progress).toBe(50);
    expect(progressEvents[0].recordsProcessed).toBe(2);
    expect(progressEvents[0].recordsTotal).toBe(4);
    expect(progressEvents[1].progress).toBe(100);
    expect(progressEvents[1].recordsProcessed).toBe(4);
    expect(progressEvents[1].recordsTotal).toBe(4);
  });

  // ── Test 10: ExecutionResult has correct counts ───────────────────────────

  it('should return ExecutionResult with correct counts for mixed outcomes', async () => {
    const plan = makePlan(
      [
        { order: 0, objects: ['Account', 'Lead'], dependsOn: [] },
        { order: 1, objects: ['Contact'], dependsOn: [0] },
      ],
      7,
    );
    const recordCounts = new Map([
      ['Account', 2],
      ['Lead', 2],
      ['Contact', 3],
    ]);

    executor.skip('Contact');

    vi.mocked(deps.query)
      .mockResolvedValueOnce([{ Id: 'a1' }, { Id: 'a2' }]) // Account
      .mockResolvedValueOnce([{ Id: 'l1' }, { Id: 'l2' }]); // Lead

    vi.mocked(deps.insert)
      .mockResolvedValueOnce(written('ta1', 'ta2'))
      .mockResolvedValueOnce([...written('tl1'), refused('DUPLICATE_VALUE', 'l2 duplicate')]);

    const result = await executor.execute(plan, [], [], recordCounts);

    expect(result.totalSuccess).toBe(3); // 2 Account + 1 Lead
    expect(result.totalFailure).toBe(1); // 1 Lead failed
    expect(result.totalSkipped).toBe(3); // Contact skipped
    expect(result.completedObjects).toContain('Account');
    expect(result.completedObjects).toContain('Lead');
    expect(result.skippedObjects).toContain('Contact');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  // ── Test 11: A crashed run rejects instead of returning partial counts ─────

  it('should emit execution-failed with the message and reject when the run crashes', async () => {
    const failedEvents: AutopilotExecutionFailedEvent[] = [];
    const completedEvents: string[] = [];
    executor.on('execution-failed', (e) => failedEvents.push(e));
    executor.on('execution-completed', () => completedEvents.push('completed'));

    const plan = makePlan([{ order: 0, objects: ['Account'], dependsOn: [] }], 1);
    const recordCounts = new Map([['Account', 1]]);
    // Fault injected outside the per-object guard, so the whole run dies
    // rather than a single node — the only path to the top-level catch.
    recordCounts.get = () => {
      throw new Error('record counts unavailable');
    };

    await expect(executor.execute(plan, [], [], recordCounts)).rejects.toThrow(
      'record counts unavailable',
    );

    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].error).toContain('record counts unavailable');
    expect(completedEvents).toEqual([]);
  });
});

describe('AutopilotExecutor — what the target will take', () => {
  it('sends only the fields the target accepts', async () => {
    // `SELECT FIELDS(ALL)` returns the audit fields, the compound address
    // fields and every formula an object carries. Sent, Salesforce refuses
    // the whole record — which was all 126 records of a two-object run.
    const deps = makeDeps({
      describeCreateableFields: async () => new Set(['Name']),
    });
    const executor = new AutopilotExecutor(deps);
    vi.mocked(deps.query).mockResolvedValueOnce([
      { Id: 'src1', Name: 'Acme', CreatedDate: '2026-01-01', BillingAddress: { city: 'Lyon' } },
    ]);
    vi.mocked(deps.insert).mockResolvedValue(written('tgt1'));

    await executor.execute(
      makePlan([{ order: 0, objects: ['Account'], dependsOn: [] }], 1),
      [],
      [],
      new Map([['Account', 1]]),
    );

    // `Id` survives the filter: the insert function strips it itself and
    // reads it back for the remapper.
    expect(Object.keys(vi.mocked(deps.insert).mock.calls[0][1][0]).sort()).toEqual(['Id', 'Name']);
  });

  it('sends everything when the describe answers with nothing', async () => {
    // An empty set means the describe could not say, not that the object
    // takes no field — filtering on it would write a blank row.
    const deps = makeDeps({
      describeCreateableFields: async () => new Set<string>(),
    });
    const executor = new AutopilotExecutor(deps);
    vi.mocked(deps.query).mockResolvedValueOnce([{ Id: 'src1', Name: 'Acme' }]);
    vi.mocked(deps.insert).mockResolvedValue(written('tgt1'));

    await executor.execute(
      makePlan([{ order: 0, objects: ['Account'], dependsOn: [] }], 1),
      [],
      [],
      new Map([['Account', 1]]),
    );

    expect(Object.keys(vi.mocked(deps.insert).mock.calls[0][1][0]).sort()).toEqual(['Id', 'Name']);
  });

  it('sends everything when the describe fails', async () => {
    const deps = makeDeps({
      describeCreateableFields: async () => {
        throw new Error('no describe today');
      },
    });
    const executor = new AutopilotExecutor(deps);
    vi.mocked(deps.query).mockResolvedValueOnce([{ Id: 'src1', Name: 'Acme' }]);
    vi.mocked(deps.insert).mockResolvedValue(written('tgt1'));

    const result = await executor.execute(
      makePlan([{ order: 0, objects: ['Account'], dependsOn: [] }], 1),
      [],
      [],
      new Map([['Account', 1]]),
    );

    expect(result.totalSuccess).toBe(1);
  });
});

describe('AutopilotExecutor — a record type the running user cannot use', () => {
  /** Fake record type ids of the target org. */
  const CUSTOMER = '012Fk00000RtAbCIAV';
  const PARTNER = '012Fk00000RtDeFIAV';

  /** The target's Account types for the running user: Partner is closed to them. */
  const ACCOUNT_TYPES = [
    {
      recordTypeId: CUSTOMER,
      developerName: 'Customer',
      name: 'Customer',
      available: true,
      active: true,
      master: false,
      defaultRecordTypeMapping: true,
    },
    {
      recordTypeId: PARTNER,
      developerName: 'Partner',
      name: 'Partner',
      available: false,
      active: true,
      master: false,
      defaultRecordTypeMapping: false,
    },
  ];

  /** One Account in the plan, 40 records to copy. */
  async function run(deps: AutopilotExecutorDeps) {
    const executor = new AutopilotExecutor(deps);
    const failed: AutopilotNodeFailedEvent[] = [];
    executor.on('node-failed', (e) => failed.push(e));
    const result = await executor.execute(
      makePlan([{ order: 0, objects: ['Account'], dependsOn: [] }], 40),
      [],
      [],
      new Map([['Account', 40]]),
    );
    return { result, failed };
  }

  it('holds the object back before its first page when some of its records use a closed type', async () => {
    const deps = makeDeps({
      describeCreateableFields: async () => new Set(['Name', 'RecordTypeId']),
      describeRecordTypes: async () => ACCOUNT_TYPES,
      countRecordTypes: async () =>
        new Map([
          [PARTNER, 12],
          [CUSTOMER, 28],
        ]),
    });

    const { result, failed } = await run(deps);

    expect(deps.query).not.toHaveBeenCalled();
    expect(deps.insert).not.toHaveBeenCalled();
    expect(result.failedObjects).toEqual(['Account']);
    expect(result.totalFailure).toBe(40);
    expect(failed[0].errors).toEqual([
      'RECORD_TYPE_UNAVAILABLE: 12 Account records use record type Partner, which the running ' +
        'user cannot use in the target org. Give the running user access to record type Partner ' +
        'on Account, or map it to one they have.',
    ]);
  });

  it('does not count the records when every type in the target is open to the running user', async () => {
    const countRecordTypes = vi.fn(async () => new Map([[CUSTOMER, 40]]));
    const deps = makeDeps({
      describeCreateableFields: async () => new Set(['Name', 'RecordTypeId']),
      describeRecordTypes: async () => ACCOUNT_TYPES.filter((t) => t.available),
      countRecordTypes,
    });

    const { result } = await run(deps);

    expect(countRecordTypes).not.toHaveBeenCalled();
    expect(result.failedObjects).toEqual([]);
  });

  it('writes the object when none of its records uses the closed type', async () => {
    const deps = makeDeps({
      describeCreateableFields: async () => new Set(['Name', 'RecordTypeId']),
      describeRecordTypes: async () => ACCOUNT_TYPES,
      countRecordTypes: async () => new Map([[CUSTOMER, 40]]),
    });

    await run(deps);

    expect(deps.query).toHaveBeenCalled();
  });

  it('leaves record types alone when the target does not let the run send RecordTypeId', async () => {
    const countRecordTypes = vi.fn(async () => new Map([[PARTNER, 40]]));
    const deps = makeDeps({
      describeCreateableFields: async () => new Set(['Name']),
      describeRecordTypes: async () => ACCOUNT_TYPES,
      countRecordTypes,
    });

    const { result } = await run(deps);

    expect(countRecordTypes).not.toHaveBeenCalled();
    expect(result.failedObjects).toEqual([]);
  });
});

/** A source whose objects hold the given rows, read a page at a time. */
function sourceOf(rows: Record<string, Record<string, unknown>[]>): QueryFn {
  return vi.fn(async (objectApiName: string, offset: number, limit: number) =>
    (rows[objectApiName] ?? []).slice(offset, offset + limit).map((row) => ({ ...row })),
  );
}

/** Record counts for the rows of {@link sourceOf}. */
function countsOf(rows: Record<string, Record<string, unknown>[]>): Map<string, number> {
  return new Map(Object.entries(rows).map(([name, list]) => [name, list.length]));
}

/** A plan of one object per wave, in the order given. */
function wavesOf(...objects: string[]): ExecutionPlan {
  return makePlan(objects.map((name, order) => ({ order, objects: [name], dependsOn: [] })));
}

describe('AutopilotExecutor — why a record was refused', () => {
  it('reports each refusal with its code and fields, counted by reason', async () => {
    // A French org answers in French: the code is what says what happened.
    const missing = "Des champs obligatoires n'ont pas été remplis : [Entity__c]";
    const rows = { Quote: [{ Id: 'q1' }, { Id: 'q2' }, { Id: 'q3' }] };
    const deps = makeDeps({ query: sourceOf(rows), batchSize: 200 });
    vi.mocked(deps.insert).mockResolvedValueOnce([
      refused('REQUIRED_FIELD_MISSING', missing, ['Entity__c']),
      refused('INVALID_CROSS_REFERENCE_KEY', 'invalid cross reference id', ['Pricebook2Id']),
      refused('REQUIRED_FIELD_MISSING', missing, ['Entity__c']),
    ]);
    const executor = new AutopilotExecutor(deps);
    const failed: AutopilotNodeFailedEvent[] = [];
    executor.on('node-failed', (e) => failed.push(e));

    const result = await executor.execute(wavesOf('Quote'), [], [], countsOf(rows));

    const refusals = [
      { statusCode: 'REQUIRED_FIELD_MISSING', fields: ['Entity__c'], count: 2, message: missing },
      {
        statusCode: 'INVALID_CROSS_REFERENCE_KEY',
        fields: ['Pricebook2Id'],
        count: 1,
        message: 'invalid cross reference id',
      },
    ];
    expect(failed[0]).toMatchObject({ failureCount: 3, linkedCount: 0, refusals });
    expect(failed[0].errors[0]).toBe(`REQUIRED_FIELD_MISSING: ${missing}`);
    expect(result.objectOutcomes?.['Quote']).toEqual({
      written: 0,
      linked: 0,
      failed: 3,
      refusals,
    });
    expect(result.nodeErrors?.['Quote']).toBe(`REQUIRED_FIELD_MISSING: ${missing}`);
  });

  it('says why the rest were refused on a node that wrote some of its records', async () => {
    const rows = { Lead: [{ Id: 'l1' }, { Id: 'l2' }] };
    const deps = makeDeps({ query: sourceOf(rows), batchSize: 200 });
    vi.mocked(deps.insert).mockResolvedValueOnce([
      ...written('00QT1'),
      refused('FIELD_CUSTOM_VALIDATION_EXCEPTION', 'Le code postal est invalide', ['PostalCode']),
    ]);
    const executor = new AutopilotExecutor(deps);
    const completed: AutopilotNodeCompletedEvent[] = [];
    executor.on('node-completed', (e) => completed.push(e));

    await executor.execute(wavesOf('Lead'), [], [], countsOf(rows));

    expect(completed[0]).toMatchObject({
      successCount: 1,
      failureCount: 1,
      refusals: [
        {
          statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
          fields: ['PostalCode'],
          count: 1,
          message: 'Le code postal est invalide',
        },
      ],
    });
  });

  it('counts a record the platform gave no result for as refused, with no code', async () => {
    const rows = { Account: [{ Id: 'a1' }, { Id: 'a2' }] };
    const deps = makeDeps({ query: sourceOf(rows), batchSize: 200 });
    vi.mocked(deps.insert).mockResolvedValueOnce(written('001T1'));

    const result = await new AutopilotExecutor(deps).execute(
      wavesOf('Account'),
      [],
      [],
      countsOf(rows),
    );

    expect(result.objectOutcomes?.['Account']).toMatchObject({ written: 1, failed: 1 });
    expect(result.objectOutcomes?.['Account']?.refusals[0].statusCode).toBe('UNKNOWN_ERROR');
  });
});

describe('AutopilotExecutor — a record the target already holds', () => {
  /** A fake Account id, in both forms (the checksum is the real algorithm's). */
  const ACCOUNT_15 = '001Fk00000AbCdE';
  const ACCOUNT_18 = '001Fk00000AbCdEIAV';
  const CONTACT_18 = '003Fk00000MnOpQIAV';

  const accountEdge = makeEdge({ from: 'Account' as ApiName, to: 'Contact' as ApiName });
  const rows = {
    Account: [{ Id: 'accSrc', Name: 'Acme' }],
    Contact: [{ Id: 'conSrc', LastName: 'Doe', AccountId: 'accSrc' }],
  };

  /** Account refused as the target wills, then its contact written. */
  async function runWith(accountOutcome: SaveOutcome) {
    const deps = makeDeps({
      query: sourceOf(rows),
      remapper: new RecordIdRemapper(),
      describeKeyPrefix: async (name) => (name === 'Account' ? '001' : '003'),
      batchSize: 200,
    });
    vi.mocked(deps.insert)
      .mockResolvedValueOnce([accountOutcome])
      .mockResolvedValueOnce(written('003T1'));
    const result = await new AutopilotExecutor(deps).execute(
      wavesOf('Account', 'Contact'),
      [accountEdge],
      [],
      countsOf(rows),
    );
    const contactPayload = vi.mocked(deps.insert).mock.calls[1][1][0];
    return { result, contactPayload };
  }

  it('links a record refused as a duplicate to the one the refusal names, and its children to it', async () => {
    const { result, contactPayload } = await runWith(
      refused(
        'DUPLICATE_VALUE',
        `valeur en double trouvée : ExternalKey__c duplique une valeur dans l'enregistrement ID : ${ACCOUNT_15}`,
      ),
    );

    expect(contactPayload['AccountId']).toBe(ACCOUNT_18);
    // Nothing was written and nothing failed: the account is in the target.
    expect(result.objectOutcomes?.['Account']).toEqual({
      written: 0,
      linked: 1,
      failed: 0,
      refusals: [],
    });
    expect(result.completedObjects).toContain('Account');
    expect(result.totalLinked).toBe(1);
  });

  it('links a record a duplicate rule refused to the one record the rule matched', async () => {
    const { contactPayload } = await runWith({
      ...refused('DUPLICATES_DETECTED', 'Utiliser un de ces enregistrements ?'),
      duplicateMatchIds: [ACCOUNT_18],
    });

    expect(contactPayload['AccountId']).toBe(ACCOUNT_18);
  });

  it('keeps a duplicate the target hides behind <unknown> refused, and its children unlinked', async () => {
    const { result, contactPayload } = await runWith(
      refused(
        'DUPLICATE_VALUE',
        "valeur en double trouvée : <unknown> duplique une valeur dans l'enregistrement ID : <unknown>",
      ),
    );

    expect(contactPayload['AccountId']).toBeNull();
    expect(result.objectOutcomes?.['Account']).toMatchObject({ linked: 0, failed: 1 });
    expect(result.objectOutcomes?.['Account']?.refusals[0].statusCode).toBe('DUPLICATE_VALUE');
  });

  it('does not link to a record of another object the refusal names', async () => {
    const { contactPayload } = await runWith(
      refused(
        'DUPLICATE_VALUE',
        `duplicate value found: ExternalKey__c duplicates value on record with id: ${CONTACT_18}`,
      ),
    );

    expect(contactPayload['AccountId']).toBeNull();
  });

  it('finds a duplicate the target does not name by its natural key', async () => {
    // "A product selling model already exists for this combination" — and
    // the refusal names no record.
    const models = {
      ProductSellingModel: [
        { Id: 'psmSrc', SellingModelType: 'OneTime', PricingTerm: 1, PricingTermUnit: 'Months' },
      ],
      PricebookEntry: [{ Id: 'pbeSrc', ProductSellingModelId: 'psmSrc' }],
    };
    const queryTarget = vi.fn<SoqlQuery>(async () => [{ Id: '0jPEXISTING' }]);
    const deps = makeDeps({
      query: sourceOf(models),
      remapper: new RecordIdRemapper(),
      queryTarget,
      batchSize: 200,
    });
    vi.mocked(deps.insert)
      .mockResolvedValueOnce([
        refused(
          'DUPLICATE_VALUE',
          'Impossible de sauvegarder cet enregistrement : un modèle de vente de produit existe déjà.',
        ),
      ])
      .mockResolvedValueOnce(written('01uT1'));

    const result = await new AutopilotExecutor(deps).execute(
      wavesOf('ProductSellingModel', 'PricebookEntry'),
      [
        makeEdge({
          from: 'ProductSellingModel' as ApiName,
          to: 'PricebookEntry' as ApiName,
          fieldApiName: 'ProductSellingModelId',
        }),
      ],
      [],
      countsOf(models),
    );

    expect(queryTarget).toHaveBeenCalledWith(
      "SELECT Id FROM ProductSellingModel WHERE SellingModelType = 'OneTime' AND PricingTerm = 1 AND PricingTermUnit = 'Months' LIMIT 2",
    );
    expect(vi.mocked(deps.insert).mock.calls[1][1][0]['ProductSellingModelId']).toBe('0jPEXISTING');
    expect(result.objectOutcomes?.['ProductSellingModel']).toMatchObject({ linked: 1, failed: 0 });
  });
});

describe('AutopilotExecutor — records the platform owns or makes', () => {
  const SOURCE_STANDARD = '01sSRCSTANDARD0';
  const TARGET_STANDARD = '01sTGTSTANDARD0';

  /** Each org answers the standard price book query with its own book. */
  const books = {
    querySource: vi.fn<SoqlQuery>(async (soql) =>
      soql === STANDARD_PRICEBOOK_SOQL ? [{ Id: SOURCE_STANDARD }] : [],
    ),
    queryTarget: vi.fn<SoqlQuery>(async (soql) =>
      soql === STANDARD_PRICEBOOK_SOQL ? [{ Id: TARGET_STANDARD }] : [],
    ),
  };

  const bookEdge = makeEdge({
    from: 'Pricebook2' as ApiName,
    to: 'PricebookEntry' as ApiName,
    fieldApiName: 'Pricebook2Id',
    required: true,
  });

  it('matches the standard price book instead of inserting it, and prices go in the target one', async () => {
    const rows = {
      Pricebook2: [
        { Id: SOURCE_STANDARD, Name: 'Standard Price Book', IsStandard: true },
        { Id: '01sSRCCUSTOM000', Name: 'Resellers' },
      ],
      PricebookEntry: [{ Id: 'pbeStd', Pricebook2Id: SOURCE_STANDARD, UnitPrice: 10 }],
    };
    const deps = makeDeps({
      query: sourceOf(rows),
      remapper: new RecordIdRemapper(),
      ...books,
      batchSize: 200,
    });
    vi.mocked(deps.insert)
      .mockResolvedValueOnce(written('01sTGTCUSTOM00'))
      .mockResolvedValueOnce(written('01uT1'));

    const result = await new AutopilotExecutor(deps).execute(
      wavesOf('Pricebook2', 'PricebookEntry'),
      [bookEdge],
      [],
      countsOf(rows),
    );

    const [bookCall, entryCall] = vi.mocked(deps.insert).mock.calls;
    expect(bookCall[1].map((r) => r['Id'])).toEqual(['01sSRCCUSTOM000']);
    expect(entryCall[1][0]['Pricebook2Id']).toBe(TARGET_STANDARD);
    expect(result.objectOutcomes?.['Pricebook2']).toMatchObject({ written: 1, linked: 1 });
  });

  it('writes the standard prices before the custom ones, even read a page later', async () => {
    // A custom price is refused for a product with no standard one.
    const rows = {
      PricebookEntry: [
        { Id: 'pbeCustom1', Pricebook2Id: '01sSRCCUSTOM000', Product2Id: 'p1' },
        { Id: 'pbeCustom2', Pricebook2Id: '01sSRCCUSTOM000', Product2Id: 'p2' },
        { Id: 'pbeStd1', Pricebook2Id: SOURCE_STANDARD, Product2Id: 'p1' },
      ],
    };
    const deps = makeDeps({ query: sourceOf(rows), ...books, batchSize: 2 });
    vi.mocked(deps.insert).mockImplementation(async (_name, records) =>
      written(...records.map((_, i) => `01uT${i}`)),
    );

    await new AutopilotExecutor(deps).execute(wavesOf('PricebookEntry'), [], [], countsOf(rows));

    expect(vi.mocked(deps.insert).mock.calls.map((call) => call[1].map((r) => r['Id']))).toEqual([
      ['pbeStd1'],
      ['pbeCustom1', 'pbeCustom2'],
    ]);
  });

  it('links the account-contact relation the platform made instead of inserting it', async () => {
    const rows = {
      Account: [{ Id: 'accSrc1' }, { Id: 'accSrc2' }],
      Contact: [{ Id: 'conSrc', AccountId: 'accSrc1' }],
      AccountContactRelation: [
        { Id: 'acrDirect', AccountId: 'accSrc1', ContactId: 'conSrc' },
        { Id: 'acrOther', AccountId: 'accSrc2', ContactId: 'conSrc' },
      ],
    };
    const queryTarget = vi.fn<SoqlQuery>(async () => [
      { Id: '07kDIRECT', AccountId: '001TA', ContactId: '003TC' },
    ]);
    const deps = makeDeps({
      query: sourceOf(rows),
      remapper: new RecordIdRemapper(),
      queryTarget,
      batchSize: 200,
    });
    vi.mocked(deps.insert)
      .mockResolvedValueOnce(written('001TA', '001TB'))
      .mockResolvedValueOnce(written('003TC'))
      .mockResolvedValueOnce(written('07kNEW'));
    const edges = [
      makeEdge({ from: 'Account' as ApiName, to: 'Contact' as ApiName }),
      makeEdge({ from: 'Account' as ApiName, to: 'AccountContactRelation' as ApiName }),
      makeEdge({
        from: 'Contact' as ApiName,
        to: 'AccountContactRelation' as ApiName,
        fieldApiName: 'ContactId',
      }),
    ];

    const result = await new AutopilotExecutor(deps).execute(
      wavesOf('Account', 'Contact', 'AccountContactRelation'),
      edges,
      [],
      countsOf(rows),
    );

    expect(queryTarget).toHaveBeenCalledWith(
      "SELECT Id, AccountId, ContactId FROM AccountContactRelation WHERE IsDirect = true AND ContactId IN ('003TC')",
    );
    // Only the relation to the other account is written.
    const relationCall = vi.mocked(deps.insert).mock.calls[2];
    expect(relationCall[1].map((r) => r['Id'])).toEqual(['acrOther']);
    expect(result.objectOutcomes?.['AccountContactRelation']).toMatchObject({
      written: 1,
      linked: 1,
      failed: 0,
    });
  });

  describe('a record born a draft', () => {
    const orderStatuses = [
      { ApiName: 'ST001', StatusCode: 'Draft' },
      { ApiName: 'ST004', StatusCode: 'Activated' },
    ];
    const rows = {
      Order: [
        { Id: 'ordActive', Status: 'ST004' },
        { Id: 'ordDraft', Status: 'ST001' },
      ],
      OrderItem: [{ Id: 'itemSrc', OrderId: 'ordActive' }],
    };
    const itemEdge = makeEdge({
      from: 'Order' as ApiName,
      to: 'OrderItem' as ApiName,
      fieldApiName: 'OrderId',
      required: true,
    });

    /** An order run whose target answers its statuses and its updates as given. */
    async function orderRun(update?: AutopilotExecutorDeps['update']) {
      const queryTarget = vi.fn<SoqlQuery>(async (soql) =>
        soql === 'SELECT ApiName, StatusCode FROM OrderStatus' ? orderStatuses : [],
      );
      const deps = makeDeps({
        query: sourceOf(rows),
        remapper: new RecordIdRemapper(),
        queryTarget,
        ...(update ? { update } : {}),
        batchSize: 200,
      });
      vi.mocked(deps.insert)
        .mockResolvedValueOnce(written('801A', '801B'))
        .mockResolvedValueOnce(written('802A'));
      const result = await new AutopilotExecutor(deps).execute(
        wavesOf('Order', 'OrderItem'),
        [itemEdge],
        [],
        countsOf(rows),
      );
      return { deps, result };
    }

    it('inserts an activated order as a draft and activates it once its products are in', async () => {
      const update = vi.fn<NonNullable<AutopilotExecutorDeps['update']>>(async (_name, records) =>
        written(...records.map((r) => String(r['Id']))),
      );

      const { deps, result } = await orderRun(update);

      const orderCall = vi.mocked(deps.insert).mock.calls[0];
      expect(orderCall[1].map((r) => r['Status'])).toEqual(['ST001', 'ST001']);
      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledWith('Order', [{ Id: '801A', Status: 'ST004' }]);
      // After the products: an activated order takes none.
      const itemInsertOrder = vi.mocked(deps.insert).mock.invocationCallOrder[1];
      expect(update.mock.invocationCallOrder[0]).toBeGreaterThan(itemInsertOrder);
      expect(result.statuses).toEqual({ Order: { applied: 1, refusals: [] } });
    });

    it('says why a status was not applied, and leaves the order a draft', async () => {
      const update = vi.fn<NonNullable<AutopilotExecutorDeps['update']>>(async () => [
        refused('FIELD_INTEGRITY_EXCEPTION', 'Commande sans produit', ['Status']),
      ]);

      const { result } = await orderRun(update);

      expect(result.statuses?.['Order']).toEqual({
        applied: 0,
        refusals: [
          {
            statusCode: 'FIELD_INTEGRITY_EXCEPTION',
            fields: ['Status'],
            count: 1,
            message: 'Commande sans produit',
          },
        ],
      });
    });

    it('sends the status as it is when the run could not write it back afterwards', async () => {
      const { deps, result } = await orderRun(undefined);

      expect(vi.mocked(deps.insert).mock.calls[0][1].map((r) => r['Status'])).toEqual([
        'ST004',
        'ST001',
      ]);
      expect(result.statuses).toBeUndefined();
    });

    it('starts a contract past Draft as a draft too, from the target categories', async () => {
      const queryTarget = vi.fn<SoqlQuery>(async (soql) =>
        soql === 'SELECT ApiName, StatusCode FROM ContractStatus'
          ? [
              { ApiName: 'Draft', StatusCode: 'Draft' },
              { ApiName: 'Activated', StatusCode: 'Activated' },
            ]
          : [],
      );
      const contracts = { Contract: [{ Id: 'ctrSrc', Status: 'Activated' }] };
      const update = vi.fn<NonNullable<AutopilotExecutorDeps['update']>>(async (_name, records) =>
        written(...records.map((r) => String(r['Id']))),
      );
      const deps = makeDeps({ query: sourceOf(contracts), queryTarget, update, batchSize: 200 });
      vi.mocked(deps.insert).mockResolvedValueOnce(written('800A'));

      await new AutopilotExecutor(deps).execute(wavesOf('Contract'), [], [], countsOf(contracts));

      expect(vi.mocked(deps.insert).mock.calls[0][1][0]['Status']).toBe('Draft');
      expect(update).toHaveBeenCalledWith('Contract', [{ Id: '800A', Status: 'Activated' }]);
    });
  });
});

/** An insert that writes every record, under the target id prefix given per object. */
function insertAs(prefixes: Record<string, string>): InsertFn {
  return vi.fn(async (objectApiName: string, records: Record<string, unknown>[]) =>
    written(...records.map((_, i) => `${prefixes[objectApiName] ?? 'X'}${i}`)),
  );
}

/** An update that takes every record. */
function updateAll(): UpdateFn {
  return vi.fn(async (_objectApiName: string, records: Record<string, unknown>[]) =>
    written(...records.map((record) => String(record['Id']))),
  );
}

/** A lookup of the target, settable on create and on update unless told otherwise. */
function lookup(name: string, referenceTo: string[], flags: Partial<DescribedLookup> = {}) {
  return { name, referenceTo, createable: true, updateable: true, ...flags };
}

describe('AutopilotExecutor — objects of one wave that point at each other', () => {
  /** A source that answers late for one object, so a racing write would overtake it. */
  function slowFor(slow: string, rows: Record<string, Record<string, unknown>[]>): QueryFn {
    const read = sourceOf(rows);
    return vi.fn(async (objectApiName: string, offset: number, limit: number) => {
      if (objectApiName === slow) await new Promise((resolve) => setTimeout(resolve, 5));
      return read(objectApiName, offset, limit);
    });
  }

  it('writes the parent of a cycle first, so its children keep their link', async () => {
    // An account points at its key contact, the contact at its account: they
    // share a wave. Written all at once, a real run left 18 contacts out of
    // 18 without their account.
    const rows = {
      Account: [{ Id: 'accSrc', Name: 'Acme', KeyContact__c: 'conSrc' }],
      Contact: [{ Id: 'conSrc', LastName: 'Doe', AccountId: 'accSrc' }],
    };
    const insert = insertAs({ Account: '001T', Contact: '003T' });
    const update = updateAll();
    const deps = makeDeps({
      query: slowFor('Account', rows),
      insert,
      update,
      remapper: new RecordIdRemapper(),
      batchSize: 200,
    });

    const result = await new AutopilotExecutor(deps).execute(
      makePlan([{ order: 0, objects: ['Contact', 'Account'], dependsOn: [] }]),
      [
        makeEdge({ from: 'Account' as ApiName, to: 'Contact' as ApiName }),
        makeEdge({
          from: 'Contact' as ApiName,
          to: 'Account' as ApiName,
          fieldApiName: 'KeyContact__c',
        }),
      ],
      [],
      countsOf(rows),
    );

    const calls = vi.mocked(insert).mock.calls;
    expect(calls.map((call) => call[0])).toEqual(['Account', 'Contact']);
    expect(calls[1][1][0]['AccountId']).toBe('001T0');
    // The account went in without the contact written after it, and was given
    // it once both were in.
    expect(calls[0][1][0]['KeyContact__c']).toBeNull();
    expect(update).toHaveBeenCalledWith('Account', [{ Id: '001T0', KeyContact__c: '003T0' }]);
    expect(result.lookups).toEqual({ Account: { filled: 1, refusals: [] } });
  });

  it('writes first what a required lookup points at, whatever the names', async () => {
    const rows = {
      Alpha__c: [{ Id: 'alphaSrc', Zulu__c: 'zuluSrc' }],
      Zulu__c: [{ Id: 'zuluSrc', Alpha__c: 'alphaSrc' }],
    };
    const insert = insertAs({ Alpha__c: 'a0AT', Zulu__c: 'a0ZT' });
    const deps = makeDeps({
      query: sourceOf(rows),
      insert,
      remapper: new RecordIdRemapper(),
      batchSize: 200,
    });

    await new AutopilotExecutor(deps).execute(
      makePlan([{ order: 0, objects: ['Alpha__c', 'Zulu__c'], dependsOn: [] }]),
      [
        makeEdge({
          from: 'Zulu__c' as ApiName,
          to: 'Alpha__c' as ApiName,
          fieldApiName: 'Zulu__c',
          required: true,
        }),
        makeEdge({
          from: 'Alpha__c' as ApiName,
          to: 'Zulu__c' as ApiName,
          fieldApiName: 'Alpha__c',
        }),
      ],
      [],
      countsOf(rows),
    );

    const calls = vi.mocked(insert).mock.calls;
    expect(calls.map((call) => call[0])).toEqual(['Zulu__c', 'Alpha__c']);
    expect(calls[1][1][0]['Zulu__c']).toBe('a0ZT0');
  });

  it('writes first what a lookup an update cannot set points at', async () => {
    // A quote takes its opportunity on create and never on update: written
    // before its opportunity, it would have kept none.
    const rows = {
      Agreement__c: [{ Id: 'agrSrc', Opportunity__c: 'oppSrc' }],
      Opportunity: [{ Id: 'oppSrc', Agreement__c: 'agrSrc' }],
    };
    const insert = insertAs({ Agreement__c: 'a0GT', Opportunity: '006T' });
    const deps = makeDeps({
      query: sourceOf(rows),
      insert,
      remapper: new RecordIdRemapper(),
      describeLookups: async (name) =>
        name === 'Agreement__c'
          ? [lookup('Opportunity__c', ['Opportunity'], { updateable: false })]
          : [lookup('Agreement__c', ['Agreement__c'])],
      batchSize: 200,
    });

    await new AutopilotExecutor(deps).execute(
      makePlan([{ order: 0, objects: ['Agreement__c', 'Opportunity'], dependsOn: [] }]),
      [
        makeEdge({
          from: 'Opportunity' as ApiName,
          to: 'Agreement__c' as ApiName,
          fieldApiName: 'Opportunity__c',
        }),
        makeEdge({
          from: 'Agreement__c' as ApiName,
          to: 'Opportunity' as ApiName,
          fieldApiName: 'Agreement__c',
        }),
      ],
      [],
      countsOf(rows),
    );

    const calls = vi.mocked(insert).mock.calls;
    expect(calls.map((call) => call[0])).toEqual(['Opportunity', 'Agreement__c']);
    expect(calls[1][1][0]['Opportunity__c']).toBe('006T0');
  });

  it('still writes side by side the objects of a wave that do not point at each other', async () => {
    const rows = { Account: [{ Id: 'a1' }], Lead: [{ Id: 'l1' }] };
    const read = sourceOf(rows);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const query = vi.fn(async (objectApiName: string, offset: number, limit: number) => {
      if (objectApiName === 'Account') await held;
      return read(objectApiName, offset, limit);
    });
    const deps = makeDeps({ query, insert: insertAs({ Account: '001T', Lead: '00QT' }) });

    const run = new AutopilotExecutor(deps).execute(
      makePlan([{ order: 0, objects: ['Account', 'Lead'], dependsOn: [] }]),
      [],
      [],
      countsOf(rows),
    );

    await vi.waitFor(() => expect(query).toHaveBeenCalledWith('Lead', 0, 2));
    release();
    expect((await run).completedObjects.sort()).toEqual(['Account', 'Lead']);
  });
});

describe('AutopilotExecutor — the second pass', () => {
  const parentEdge = makeEdge({
    from: 'Account' as ApiName,
    to: 'Account' as ApiName,
    fieldApiName: 'ParentId',
    relationshipType: 'hierarchical',
  });
  /** A child account read before its parent. */
  const rows = {
    Account: [
      { Id: 'child', Name: 'Child', ParentId: 'parent' },
      { Id: 'parent', Name: 'Parent', ParentId: null },
    ],
  };

  it('fills a lookup at a record written after it, at the end of its wave', async () => {
    const insert = vi.fn<InsertFn>(async (_name, records) =>
      written(...records.map((record) => `001T_${String(record['Id'])}`)),
    );
    const update = updateAll();
    const deps = makeDeps({
      query: sourceOf(rows),
      insert,
      update,
      remapper: new RecordIdRemapper(),
      batchSize: 200,
    });

    await new AutopilotExecutor(deps).execute(wavesOf('Account'), [parentEdge], [], countsOf(rows));

    expect(vi.mocked(insert).mock.calls[0][1][0]['ParentId']).toBeNull();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('Account', [{ Id: '001T_child', ParentId: '001T_parent' }]);
  });

  it('says why a lookup could not be filled', async () => {
    const update = vi.fn<UpdateFn>(async () => [
      refused('FIELD_CUSTOM_VALIDATION_EXCEPTION', 'Le parent doit être actif', ['ParentId']),
    ]);
    const deps = makeDeps({
      query: sourceOf(rows),
      insert: insertAs({ Account: '001T' }),
      update,
      remapper: new RecordIdRemapper(),
      batchSize: 200,
    });

    const result = await new AutopilotExecutor(deps).execute(
      wavesOf('Account'),
      [parentEdge],
      [],
      countsOf(rows),
    );

    expect(result.lookups).toEqual({
      Account: {
        filled: 0,
        refusals: [
          {
            statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
            fields: ['ParentId'],
            count: 1,
            message: 'Le parent doit être actif',
          },
        ],
      },
    });
  });

  it('never writes to a record the target already held', async () => {
    const ACCOUNT_15 = '001Fk00000AbCdE';
    const update = updateAll();
    const deps = makeDeps({
      query: sourceOf(rows),
      insert: vi.fn<InsertFn>(async () => [
        refused(
          'DUPLICATE_VALUE',
          `duplicate value found: ExternalKey__c duplicates value on record with id: ${ACCOUNT_15}`,
        ),
        ...written('001T_parent'),
      ]),
      update,
      remapper: new RecordIdRemapper(),
      describeKeyPrefix: async () => '001',
      batchSize: 200,
    });

    const result = await new AutopilotExecutor(deps).execute(
      wavesOf('Account'),
      [parentEdge],
      [],
      countsOf(rows),
    );

    expect(result.objectOutcomes?.['Account']).toMatchObject({ written: 1, linked: 1 });
    expect(update).not.toHaveBeenCalled();
  });

  it('fills only what an update can set', async () => {
    const update = updateAll();
    const deps = makeDeps({
      query: sourceOf(rows),
      insert: insertAs({ Account: '001T' }),
      update,
      remapper: new RecordIdRemapper(),
      describeLookups: async () => [lookup('ParentId', ['Account'], { updateable: false })],
      batchSize: 200,
    });

    await new AutopilotExecutor(deps).execute(wavesOf('Account'), [parentEdge], [], countsOf(rows));

    expect(update).not.toHaveBeenCalled();
  });

  it('leaves a lookup empty when the record it points at never reached the target', async () => {
    const update = updateAll();
    const deps = makeDeps({
      query: sourceOf(rows),
      insert: vi.fn<InsertFn>(async () => [
        ...written('001T_child'),
        refused('REQUIRED_FIELD_MISSING', 'Champ obligatoire manquant', ['Industry']),
      ]),
      update,
      remapper: new RecordIdRemapper(),
      batchSize: 200,
    });

    const result = await new AutopilotExecutor(deps).execute(
      wavesOf('Account'),
      [parentEdge],
      [],
      countsOf(rows),
    );

    expect(update).not.toHaveBeenCalled();
    expect(result.lookups).toBeUndefined();
  });
});

describe('AutopilotExecutor — record types matched by name', () => {
  /** The same record type, as each org names it. */
  const SOURCE_SALES = '012SRC00000SaLeSAAA';
  const TARGET_SALES = '012TGT00000SaLeSAAA';
  const rows = { Product2: [{ Id: 'p1', Name: 'Widget', RecordTypeId: SOURCE_SALES }] };

  /** An org whose record type query answers the one type, under its own id. */
  function org(id: string) {
    return vi.fn<SoqlQuery>(async (soql) =>
      soql.startsWith(RECORD_TYPES_SOQL)
        ? [{ Id: id, Name: 'Sales', DeveloperName: 'SalesProduct', SobjectType: 'Product2' }]
        : [],
    );
  }

  it("sends the target's id for the record type of the same object and name", async () => {
    const querySource = org(SOURCE_SALES);
    const deps = makeDeps({
      query: sourceOf(rows),
      querySource,
      queryTarget: org(TARGET_SALES),
      insert: insertAs({ Product2: '01tT' }),
      batchSize: 200,
    });

    await new AutopilotExecutor(deps).execute(wavesOf('Product2'), [], [], countsOf(rows));

    expect(querySource).toHaveBeenCalledWith(
      `${RECORD_TYPES_SOQL} AND SobjectType IN ('Product2')`,
    );
    expect(vi.mocked(deps.insert).mock.calls[0][1][0]['RecordTypeId']).toBe(TARGET_SALES);
  });

  it('holds the object back when the type of that name is closed to the running user', async () => {
    const deps = makeDeps({
      query: sourceOf(rows),
      querySource: org(SOURCE_SALES),
      queryTarget: org(TARGET_SALES),
      describeCreateableFields: async () => new Set(['Name', 'RecordTypeId']),
      describeRecordTypes: async () => [
        {
          recordTypeId: TARGET_SALES,
          developerName: 'SalesProduct',
          name: 'Sales',
          available: false,
          active: true,
          master: false,
          defaultRecordTypeMapping: false,
        },
      ],
      // Counted in the source, so by the source's id.
      countRecordTypes: async () => new Map([[SOURCE_SALES, 1]]),
      batchSize: 200,
    });

    const result = await new AutopilotExecutor(deps).execute(
      wavesOf('Product2'),
      [],
      [],
      countsOf(rows),
    );

    expect(deps.insert).not.toHaveBeenCalled();
    expect(result.failedObjects).toEqual(['Product2']);
    expect(result.nodeErrors?.['Product2']).toContain('record type SalesProduct (Sales)');
  });

  it('keeps the id of a type the target does not have, and says so once', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const twice = { Product2: [...rows.Product2, { ...rows.Product2[0], Id: 'p2' }] };
    const deps = makeDeps({
      query: sourceOf(twice),
      querySource: org(SOURCE_SALES),
      queryTarget: vi.fn<SoqlQuery>(async () => []),
      insert: insertAs({ Product2: '01tT' }),
      batchSize: 1,
    });

    await new AutopilotExecutor(deps).execute(wavesOf('Product2'), [], [], countsOf(twice));

    expect(vi.mocked(deps.insert).mock.calls[0][1][0]['RecordTypeId']).toBe(SOURCE_SALES);
    const unmapped = warn.mock.calls.filter(([line]) => line.includes(SOURCE_SALES));
    expect(unmapped).toHaveLength(1);
    expect(unmapped[0][0]).toMatch(/^\[autopilot\] Product2:/);
    warn.mockRestore();
  });
});

describe('AutopilotExecutor — lookups at objects the run does not copy', () => {
  const rows = {
    Account: [{ Id: 'accSrc', Name: 'Acme' }],
    Order: [
      {
        Id: 'o1',
        Name: 'First',
        OwnerId: '005SRC000000001AAA',
        AccountId: 'accSrc',
        CreatedById: '005SRC000000001AAA',
        RecordTypeId: '012SRC000000001AAA',
      },
      { Id: 'o2', Name: 'Second', OwnerId: '005SRC000000002AAA', AccountId: null },
    ],
  };
  const accountEdge = makeEdge({
    from: 'Account' as ApiName,
    to: 'Order' as ApiName,
    fieldApiName: 'AccountId',
  });

  /** The target's describe of an order: its owner a user or a queue, its account a copy. */
  const orderDescribe = {
    describeCreateableFields: async () => new Set(['Name', 'OwnerId', 'AccountId', 'RecordTypeId']),
    describeLookups: async (name: string) =>
      name === 'Order'
        ? [
            lookup('OwnerId', ['Group', 'User']),
            lookup('AccountId', ['Account']),
            lookup('CreatedById', ['User'], { createable: false, updateable: false }),
            lookup('RecordTypeId', ['RecordType']),
          ]
        : [],
  };

  it("leaves the owner to the target's default, and says on how many records", async () => {
    // Every order of a real run was refused over an owner the target did not
    // hold. Left out, the platform makes the running user the owner.
    const deps = makeDeps({
      query: sourceOf(rows),
      insert: insertAs({ Account: '001T', Order: '801T' }),
      remapper: new RecordIdRemapper(),
      ...orderDescribe,
      batchSize: 200,
    });

    const result = await new AutopilotExecutor(deps).execute(
      wavesOf('Account', 'Order'),
      [accountEdge],
      [],
      countsOf(rows),
    );

    const orders = vi.mocked(deps.insert).mock.calls[1][1];
    expect(orders.map((order) => 'OwnerId' in order)).toEqual([false, false]);
    // A lookup at a copied object is kept, and the record type goes its own way.
    expect(orders[0]).toMatchObject({ AccountId: '001T0', RecordTypeId: '012SRC000000001AAA' });
    expect(result.objectOutcomes?.['Order']?.leftToDefault).toEqual([
      { field: 'OwnerId', count: 2 },
    ]);
  });

  it('says nothing of a lookup that held no value, nor of one the target sets itself', async () => {
    const quiet = { Account: rows.Account, Order: [{ Id: 'o3', Name: 'Third' }] };
    const deps = makeDeps({
      query: sourceOf(quiet),
      insert: insertAs({ Account: '001T', Order: '801T' }),
      remapper: new RecordIdRemapper(),
      ...orderDescribe,
      batchSize: 200,
    });

    const result = await new AutopilotExecutor(deps).execute(
      wavesOf('Account', 'Order'),
      [accountEdge],
      [],
      countsOf(quiet),
    );

    expect(result.objectOutcomes?.['Order']).not.toHaveProperty('leftToDefault');
  });
});

describe('AutopilotExecutor — a feed item the platform writes itself', () => {
  const TRACKED = { field: 'Type', value: 'TrackedChange', noun: 'tracked change' };
  const rows = {
    Opportunity: [{ Id: '006SRC', Name: 'Deal' }],
    FeedItem: [
      { Id: '0D5POST', Type: 'TextPost', Body: 'Kick-off', ParentId: '006SRC' },
      { Id: '0D5CHANGE', Type: 'TrackedChange', Body: null, ParentId: '006SRC' },
    ],
    FeedComment: [
      { Id: '0D7POST', CommentBody: 'On the post', FeedItemId: '0D5POST' },
      { Id: '0D7CHANGE', CommentBody: 'On the change', FeedItemId: '0D5CHANGE' },
    ],
  };
  // As the scan draws them: a feed item's parent and a comment's feed item
  // may each be one of several objects, and neither may be left empty.
  const edges = [
    makeEdge({
      from: 'Opportunity' as ApiName,
      to: 'FeedItem' as ApiName,
      fieldApiName: 'ParentId',
      relationshipType: 'polymorphic',
      required: true,
    }),
    makeEdge({
      from: 'FeedItem' as ApiName,
      to: 'FeedComment' as ApiName,
      fieldApiName: 'FeedItemId',
      relationshipType: 'polymorphic',
      required: true,
    }),
  ];

  /** The source ids of the records of an object the target was sent. */
  function sentIds(deps: AutopilotExecutorDeps, objectApiName: string): unknown[] {
    return vi
      .mocked(deps.insert)
      .mock.calls.filter(([name]) => name === objectApiName)
      .flatMap(([, records]) => records.map((record) => record['Id']));
  }

  it('leaves out a tracked change and the comment on it, and says so', async () => {
    // Sent, the platform refuses a tracked change — "Cannot directly insert
    // FeedItem with type TrackedChange" — and the comment on it, which
    // cannot go in without it.
    const deps = makeDeps({
      query: sourceOf(rows),
      insert: insertAs({ Opportunity: '006T', FeedItem: '0D5T', FeedComment: '0D7T' }),
      remapper: new RecordIdRemapper(),
      batchSize: 200,
    });

    const result = await new AutopilotExecutor(deps).execute(
      wavesOf('Opportunity', 'FeedItem', 'FeedComment'),
      edges,
      [],
      countsOf(rows),
    );

    expect(sentIds(deps, 'FeedItem')).toEqual(['0D5POST']);
    expect(sentIds(deps, 'FeedComment')).toEqual(['0D7POST']);
    expect(result.totalFailure).toBe(0);
    expect(result.failedObjects).toEqual([]);
    expect(result.objectOutcomes?.['FeedItem']).toEqual({
      written: 1,
      linked: 0,
      failed: 0,
      refusals: [],
      leftToThePlatform: [{ objectApiName: 'FeedItem', why: { rows: TRACKED }, count: 1 }],
    });
    expect(result.objectOutcomes?.['FeedComment']?.leftToThePlatform).toEqual([
      {
        objectApiName: 'FeedComment',
        why: { rows: TRACKED, through: 'FeedItemId' },
        count: 1,
      },
    ]);
  });

  it('writes nothing of a page whose every feed item is a tracked change, and fails nothing', async () => {
    const changes = { FeedItem: [rows.FeedItem[1]] };
    const deps = makeDeps({
      query: sourceOf(changes),
      insert: insertAs({ FeedItem: '0D5T' }),
      remapper: new RecordIdRemapper(),
      batchSize: 200,
    });

    const result = await new AutopilotExecutor(deps).execute(
      wavesOf('FeedItem'),
      [],
      [],
      countsOf(changes),
    );

    expect(deps.insert).not.toHaveBeenCalled();
    expect(result.completedObjects).toEqual(['FeedItem']);
    expect(result.objectOutcomes?.['FeedItem']?.leftToThePlatform).toEqual([
      { objectApiName: 'FeedItem', why: { rows: TRACKED }, count: 1 },
    ]);
  });
});

describe("AutopilotExecutor — an email's task, which the platform fills in itself", () => {
  const ACCOUNT = '001SRCACCOUNT00';
  const CASE = '500SRCCASE00000';
  const OFFER = '02sSRCOFFER0000';
  const OFFER_TASK = '00TSRCOFFER0000';
  const ON_THE_CASE = '02sSRCONCASE000';
  const ON_THE_CASE_TASK = '00TSRCONCASE000';
  const RELATED_TO_THE_CASE = '02sSRCRELATED00';
  const RELATED_TO_THE_CASE_TASK = '00TSRCRELATED00';
  const PLATFORM_TASK = '00TPLATFORM0000';
  const rows = {
    Account: [{ Id: ACCOUNT, Name: 'Acme' }],
    Case: [{ Id: CASE, Subject: 'Broken' }],
    EmailMessage: [
      { Id: OFFER, Subject: 'Offer', RelatedToId: ACCOUNT, ActivityId: OFFER_TASK },
      { Id: ON_THE_CASE, Subject: 'It is broken', ParentId: CASE, ActivityId: ON_THE_CASE_TASK },
      {
        Id: RELATED_TO_THE_CASE,
        Subject: 'Still broken',
        RelatedToId: CASE,
        ActivityId: RELATED_TO_THE_CASE_TASK,
      },
    ],
    Task: [
      { Id: OFFER_TASK, Subject: 'Email: Offer', WhatId: ACCOUNT },
      { Id: ON_THE_CASE_TASK, Subject: 'Unread email', WhatId: CASE },
      { Id: RELATED_TO_THE_CASE_TASK, Subject: 'Second email', WhatId: CASE },
    ],
  };
  // As the scan draws them: what an email or a task is related to may be
  // one of several objects, and an email names its case and its task.
  const edges = [
    ...['Account', 'Case'].flatMap((parent) => [
      makeEdge({
        from: parent as ApiName,
        to: 'EmailMessage' as ApiName,
        fieldApiName: 'RelatedToId',
        relationshipType: 'polymorphic',
      }),
      makeEdge({
        from: parent as ApiName,
        to: 'Task' as ApiName,
        fieldApiName: 'WhatId',
        relationshipType: 'polymorphic',
      }),
    ]),
    makeEdge({ from: 'Case' as ApiName, to: 'EmailMessage' as ApiName, fieldApiName: 'ParentId' }),
    makeEdge({
      from: 'Task' as ApiName,
      to: 'EmailMessage' as ApiName,
      fieldApiName: 'ActivityId',
    }),
  ];

  /**
   * A target that answers as the platform does: it takes an email's task
   * only when the email is on a case — its ParentId, or a case in its
   * RelatedToId — and writes the task of every other email related to a
   * record itself. Each record it takes gets the key prefix of its object.
   */
  function platform() {
    const emails: FakeRow[] = [];
    const counts = new Map<string, number>();
    const prefixes: Record<string, string> = {
      Account: '001',
      Case: '500',
      EmailMessage: '02s',
      Task: '00T',
    };
    const insert: InsertFn = vi.fn(
      async (objectApiName: string, records: Record<string, unknown>[]): Promise<SaveOutcome[]> =>
        records.map((record) => {
          const onACase =
            Boolean(record['ParentId']) || String(record['RelatedToId'] ?? '').startsWith('500');
          if (objectApiName === 'EmailMessage' && record['ActivityId'] && !onACase) {
            return refused('INSUFFICIENT_ACCESS_OR_READONLY', 'you cannot modify this field');
          }
          const n = (counts.get(objectApiName) ?? 0) + 1;
          counts.set(objectApiName, n);
          const id = `${prefixes[objectApiName] ?? 'XXX'}TGT${n}`;
          if (objectApiName === 'EmailMessage') {
            emails.push({
              Id: id,
              ActivityId: record['ActivityId']
                ? String(record['ActivityId'])
                : record['RelatedToId']
                  ? PLATFORM_TASK
                  : null,
            });
          }
          return { id, success: true, errors: [] };
        }),
    );
    const queryTarget = vi.fn<SoqlQuery>(async (soql) =>
      soql.startsWith('SELECT Id, ActivityId FROM EmailMessage')
        ? selectRows({ EmailMessage: emails }, soql)
        : [],
    );
    return { insert, queryTarget };
  }

  /** What each insert of an object sent, in order. */
  function sentOf(deps: AutopilotExecutorDeps, objectApiName: string): Record<string, unknown>[] {
    return vi
      .mocked(deps.insert)
      .mock.calls.filter(([name]) => name === objectApiName)
      .flatMap(([, records]) => records.map(({ Id: _id, ...fields }) => fields));
  }

  it('sends an email that is not on a case without the task it names, whatever went first', async () => {
    // Sent with the task the run had written, as a plan that put the tasks
    // first remapped it, the email was refused:
    // INSUFFICIENT_ACCESS_OR_READONLY, "you cannot modify this field".
    const offer = {
      Account: rows.Account,
      Task: [rows.Task[0]],
      EmailMessage: [rows.EmailMessage[0]],
    };
    const deps = makeDeps({
      query: sourceOf(offer),
      ...platform(),
      remapper: new RecordIdRemapper(),
      batchSize: 200,
    });

    const result = await new AutopilotExecutor(deps).execute(
      wavesOf('Account', 'Task', 'EmailMessage'),
      edges,
      [],
      countsOf(offer),
    );

    expect(sentOf(deps, 'EmailMessage')).toEqual([{ Subject: 'Offer', RelatedToId: '001TGT1' }]);
    expect(result.totalFailure).toBe(0);
  });

  it('writes an email on a case after the tasks, with its task, and links the task the platform wrote with any other', async () => {
    // A plan that put the tasks first left the offer's task beside the one
    // the platform wrote with its email: two for one email.
    const remapper = new RecordIdRemapper();
    const deps = makeDeps({
      query: sourceOf(rows),
      ...platform(),
      remapper,
      batchSize: 200,
    });

    const result = await new AutopilotExecutor(deps).execute(
      wavesOf('Account', 'Case', 'EmailMessage', 'Task'),
      edges,
      [],
      countsOf(rows),
    );

    expect(vi.mocked(deps.insert).mock.calls.map(([name]) => name)).toEqual([
      'Account',
      'Case',
      'EmailMessage',
      'Task',
      'EmailMessage',
    ]);
    expect(sentOf(deps, 'Task')).toEqual([
      { Subject: 'Unread email', WhatId: '500TGT1' },
      { Subject: 'Second email', WhatId: '500TGT1' },
    ]);
    expect(sentOf(deps, 'EmailMessage')).toEqual([
      { Subject: 'Offer', RelatedToId: '001TGT1' },
      { Subject: 'It is broken', ParentId: '500TGT1', ActivityId: '00TTGT1' },
      { Subject: 'Still broken', RelatedToId: '500TGT1', ActivityId: '00TTGT2' },
    ]);
    expect(remapper.getTargetId('Task' as ApiName, OFFER_TASK)).toBe(PLATFORM_TASK);
    expect(result.objectOutcomes?.['EmailMessage']).toMatchObject({
      written: 3,
      linked: 0,
      failed: 0,
    });
    expect(result.objectOutcomes?.['Task']).toMatchObject({ written: 2, linked: 1, failed: 0 });
    expect(result).toMatchObject({ totalSuccess: 7, totalLinked: 1, totalFailure: 0 });
    expect(result.completedObjects).toContain('EmailMessage');
  });
});
