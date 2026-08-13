import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  AutopilotEdge,
  AutopilotAnonymizationRule,
  AutopilotNodeProgressEvent,
  AutopilotNodeFailedEvent,
  ApiName,
  ExecutionPlan,
} from '@sandforge/shared';
import {
  AutopilotExecutor,
  type AutopilotExecutionFailedEvent,
  type AutopilotExecutorDeps,
  type InsertResult,
  type QueryFn,
  type InsertFn,
} from './AutopilotExecutor.js';
import type { SmartAnonymizer } from './SmartAnonymizer.js';
import type { RecordIdRemapper } from './RecordIdRemapper.js';

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

/** Create mock dependencies. */
function makeDeps(overrides: Partial<AutopilotExecutorDeps> = {}): AutopilotExecutorDeps {
  const queryMock: QueryFn = vi.fn().mockResolvedValue([]);
  const insertMock: InsertFn = vi.fn().mockResolvedValue({
    successIds: [],
    sourceIds: [],
    errors: [],
  } satisfies InsertResult);

  const anonymizerMock = {
    anonymize: vi.fn().mockImplementation((records: Record<string, unknown>[]) => records),
    getPersonaRegistry: vi.fn(),
  } as unknown as SmartAnonymizer;

  const remapperMock = {
    remapRecords: vi.fn().mockReturnValue({ remapped: 0, missing: 0, skipped: 0 }),
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
      .mockResolvedValueOnce({
        successIds: ['tgt1', 'tgt2'],
        sourceIds: ['src1', 'src2'],
        errors: [],
      })
      .mockResolvedValueOnce({
        successIds: ['tgt3'],
        sourceIds: ['src3'],
        errors: [],
      });

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
      .mockResolvedValueOnce({
        successIds: ['ta1'],
        sourceIds: ['a1'],
        errors: [],
      })
      .mockResolvedValueOnce({
        successIds: ['tc1'],
        sourceIds: ['c1'],
        errors: [],
      });

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
      .mockResolvedValueOnce({
        successIds: ['t1'],
        sourceIds: ['a1'],
        errors: [],
      })
      .mockResolvedValueOnce({
        successIds: ['t2'],
        sourceIds: ['c1'],
        errors: [],
      });

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

    vi.mocked(deps.insert).mockResolvedValueOnce({
      successIds: ['t1', 't2'],
      sourceIds: ['a1', 'a2'],
      errors: [],
    });

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
      .mockResolvedValueOnce({
        successIds: [],
        sourceIds: [],
        errors: ['FIELD_INTEGRITY_EXCEPTION: invalid field'],
      })
      .mockResolvedValueOnce({
        successIds: ['tc1'],
        sourceIds: ['c1'],
        errors: [],
      });

    const result = await executor.execute(plan, [], [], recordCounts);

    expect(result.failedObjects).toContain('Account');
    expect(result.completedObjects).toContain('Contact');
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].objectApiName).toBe('Account');
    expect(failedEvents[0].errors).toContain('FIELD_INTEGRITY_EXCEPTION: invalid field');
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
      .mockResolvedValueOnce({
        successIds: ['tgtAcc1'],
        sourceIds: ['srcAcc1'],
        errors: [],
      })
      .mockResolvedValueOnce({
        successIds: ['tgtCon1'],
        sourceIds: ['srcCon1'],
        errors: [],
      });

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

    vi.mocked(deps.insert).mockResolvedValueOnce({
      successIds: ['tc1'],
      sourceIds: ['c1'],
      errors: [],
    });

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
      .mockResolvedValueOnce({
        successIds: ['t1', 't2'],
        sourceIds: ['a1', 'a2'],
        errors: [],
      })
      .mockResolvedValueOnce({
        successIds: ['t3', 't4'],
        sourceIds: ['a3', 'a4'],
        errors: [],
      });

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
      .mockResolvedValueOnce({
        successIds: ['ta1', 'ta2'],
        sourceIds: ['a1', 'a2'],
        errors: [],
      })
      .mockResolvedValueOnce({
        successIds: ['tl1'],
        sourceIds: ['l1'],
        errors: ['DUPLICATE_VALUE: l2 duplicate'],
      });

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
