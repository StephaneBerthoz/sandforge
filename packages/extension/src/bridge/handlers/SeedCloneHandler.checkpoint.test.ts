/**
 * A clone from the Seed page asked to take a checkpoint of what it writes
 * before its first record (Checkpoint first): the target's automation read
 * once, for the checkpoint's scope and the emails alike, its requests counted
 * with the clone's, asked about, taken after the answer and before the first
 * record, kept once a record went; refused under its own code, nothing written.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BaseMessage,
  ForgeTargetAutomation,
  RunCheckpointEstimate,
  RunCheckpointTaken,
} from '@sandforge/shared';
import { SeedCloneHandler } from './SeedCloneHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import {
  writePathOrderDefects,
  type BeforeRunCheckpoints,
  type WritePathStep,
} from '../../modules/checkpoint/beforeRunCheckpoint.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));
vi.mock('../../core/common/sforceLimitParser.js', () => ({
  checkApiLimits: vi.fn(),
}));

/** The source's reads and the order of the objects are doubles. */
const fetcher = vi.hoisted(() => ({
  fetchRecords: vi.fn(),
  countRecords: vi.fn(),
  fetchSample: vi.fn(),
  describe: vi.fn((conn: { describe: (name: string) => Promise<unknown> }, name: string) =>
    conn.describe(name),
  ),
}));
const linker = vi.hoisted(() => ({
  buildEdgesFromDescribe: vi.fn(),
  resolveInsertOrder: vi.fn(),
  lookupsFilledAfter: vi.fn(),
  lookupsOf: vi.fn(),
}));
vi.mock('../../modules/seed/CloneRecordFetcher.js', () => ({
  CloneRecordFetcher: vi.fn().mockImplementation(function () {
    return fetcher;
  }),
}));
vi.mock('../../modules/seed/CloneReferenceLinker.js', () => ({
  CloneReferenceLinker: vi.fn().mockImplementation(function () {
    return linker;
  }),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

/** Every step a clone makes, in the order it makes it, as the fakes below put them down. */
const steps: string[] = [];

/** The id the clone runs under: its request's. */
const OPERATION_ID = 'msg-seed:clone:execute';

const clonePayload = {
  sourceOrgId: 'src-org',
  targetOrgId: 'tgt-org',
  objects: [{ objectApiName: 'Account' }],
  previewId: 'msg-seed:clone:preview',
};

function buildMsg(type: string, payload: unknown): InboundRequest {
  return inboundRequest({ id: `msg-${type}`, type, timestamp: Date.now(), payload } as BaseMessage);
}

/**
 * The target's account flows: one opens a task under each account created,
 * another a note under each account updated.
 */
function accountAutomation(objects: readonly string[]): ForgeTargetAutomation {
  return {
    objectsRead: [...objects],
    objects: [
      {
        objectApiName: 'Account',
        flows: [
          {
            apiName: 'Account_Follow_Up',
            label: 'Account follow-up',
            timing: 'afterSave',
            startsOn: 'create',
            condition: 'read',
            creates: ['Task'],
            permissions: [],
          },
          {
            apiName: 'Account_Review',
            label: 'Account review',
            timing: 'afterSave',
            startsOn: 'update',
            condition: 'read',
            creates: ['Note'],
            permissions: [],
          },
        ],
        triggers: [],
      },
    ],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 25,
    requests: 1,
  };
}

const ESTIMATE: RunCheckpointEstimate = {
  state: 'planned',
  estimate: { records: 12, apiRequests: 68, apiRequestsLeft: 15_000, seconds: 20, bytes: 400_000 },
  objects: ['Account', 'Task', 'ContentDocument'],
  added: [
    {
      objectApiName: 'Task',
      reason:
        "The target's flow 'Account follow-up' creates Task records as Account records go in.",
    },
  ],
  notHeld: [],
  keepDays: 7,
};

const TAKEN: RunCheckpointTaken = {
  state: 'taken',
  checkpointId: 'ck-20261101-101500-e5f6',
  name: 'Before Seed run 2026-11-01 10:15 UTC',
  takenAt: '2026-11-01T10:15:04.000Z',
  expiresAt: '2026-11-08T10:15:04.000Z',
  objects: ESTIMATE.objects,
  records: 12,
  bytes: 400_000,
  requests: 68,
  added: ESTIMATE.added,
  notHeld: [],
};

/** The checkpoints of the window, each call put down as a step. */
function fakeCheckpoints(scoped: RunCheckpointEstimate = ESTIMATE) {
  return {
    scope: vi.fn<BeforeRunCheckpoints['scope']>(async () => {
      steps.push('checkpoint scope');
      return scoped;
    }),
    take: vi.fn<BeforeRunCheckpoints['take']>(async () => {
      steps.push('checkpoint take');
      return { taken: true, checkpoint: TAKEN };
    }),
    settle: vi.fn<BeforeRunCheckpoints['settle']>(async (taken, wrote) => {
      steps.push('checkpoint settle');
      return wrote ? taken : { state: 'deleted', deleted: 'nothingWritten' };
    }),
  };
}

/** A step put down by the fakes, as the write path's order names it. */
const AS_STEP: Readonly<Record<string, WritePathStep>> = {
  'automation read': 'reads',
  'limits read': 'reads',
  'checkpoint scope': 'stillRunning',
  question: 'question',
  'checkpoint take': 'checkpointTake',
  write: 'write',
  result: 'result',
};

describe('SeedCloneHandler — a clone that takes a checkpoint first', () => {
  let deps: HandlerDeps;
  let handler: SeedCloneHandler;
  let guard: ProductionGuard;
  let checkpoints: ReturnType<typeof fakeCheckpoints>;
  const read =
    vi.fn<(orgId: string, objects: readonly string[]) => Promise<ForgeTargetAutomation>>();
  const create = vi.fn(async (batch: unknown[]) => {
    steps.push('write');
    return batch.map((_, n) => ({
      id: `001${String(n + 1).padStart(12, '0')}AAA`,
      success: true,
      errors: [],
    }));
  });

  const posted = (type: string) =>
    vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
      .filter((m) => m.type === type);
  const failed = () =>
    vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
      .filter((m) => m.type === 'operation:failed');

  /** Both orgs, the target with `remaining` API requests left today. */
  function orgs(remaining = 15_000) {
    vi.mocked(getJsforceConnection).mockImplementation(
      async (orgId: string) =>
        ({
          describeGlobal: vi.fn().mockResolvedValue({ sobjects: [] }),
          describe: vi.fn().mockResolvedValue({
            fields: [{ name: 'Name', type: 'string', createable: true, updateable: true }],
            keyPrefix: '001',
          }),
          query: vi.fn(async () => ({ done: true, totalSize: 0, records: [] })),
          queryMore: vi.fn(),
          sobject: vi.fn(() => ({ create, update: vi.fn(), upsert: vi.fn() })),
          request: vi.fn(async () => {
            if (orgId === 'tgt-org') steps.push('limits read');
            return {
              DataStorageMB: { Max: 5, Remaining: 5 },
              DailyApiRequests: { Max: 15_000, Remaining: remaining },
              SingleEmail: { Max: 15, Remaining: 15 },
            };
          }),
          limitInfo: undefined,
        }) as never,
    );
  }

  /** Previews the clone of three accounts, then runs it with `extra`. */
  async function clone(extra: Record<string, unknown> = {}): Promise<void> {
    await handler.handle(buildMsg('seed:clone:preview', clonePayload));
    steps.length = 0;
    await handler.handle(buildMsg('seed:clone:execute', { ...clonePayload, ...extra }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    steps.length = 0;
    read.mockReset();
    read.mockImplementation(async (_orgId, objects) => {
      steps.push('automation read');
      return accountAutomation(objects);
    });
    linker.buildEdgesFromDescribe.mockReturnValue([]);
    linker.resolveInsertOrder.mockReturnValue(['Account']);
    linker.lookupsFilledAfter.mockReturnValue([]);
    linker.lookupsOf.mockReturnValue([]);
    fetcher.countRecords.mockResolvedValue(3);
    fetcher.fetchSample.mockResolvedValue([]);
    fetcher.fetchRecords.mockResolvedValue(
      Array.from({ length: 3 }, (_, i) => ({
        Id: `001${String(i).padStart(12, '0')}SRC`,
        Name: `Acme ${i}`,
      })),
    );
    guard = new ProductionGuard();
    vi.spyOn(guard, 'confirmRun').mockImplementation(async () => {
      steps.push('question');
      return 'confirmed';
    });
    const store = new Map<string, unknown>();
    let n = 0;
    deps = {
      log: vi.fn(),
      broker: {
        postToWebview: vi.fn((m: BaseMessage) => {
          if (m.type === 'seed:clone:execute:response') steps.push('result');
        }),
      } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn(() => ({ orgType: 'Developer', alias: 'my-dev-org' })),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as HandlerDeps['orgRegistry'],
      configStore: {
        get: vi.fn((key: string) => store.get(key)),
        set: vi.fn((key: string, value: unknown) => {
          store.set(key, JSON.parse(JSON.stringify(value)));
        }),
      } as unknown as HandlerDeps['configStore'],
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      infraServices: { productionGuard: guard } as HandlerDeps['infraServices'],
      nextId: () => String(++n),
    };
    handler = new SeedCloneHandler(deps);
    handler.setTargetAutomation({ read });
    checkpoints = fakeCheckpoints();
    handler.setBeforeRunCheckpoints(checkpoints);
  });

  const auditEntry = () =>
    new AuditTrailStore(deps.configStore)
      .list()
      .entries.find((e) => e.operationId === OPERATION_ID);

  it('reads the automation once, takes it after the question and before the first record, and keeps it once a record went', async () => {
    orgs();

    await clone({ checkpointFirst: { keepDays: 3 } });

    expect(steps).toEqual([
      'automation read',
      'checkpoint scope',
      'limits read',
      'question',
      'checkpoint take',
      'write',
      'checkpoint settle',
      'result',
    ]);
    expect(
      writePathOrderDefects(steps.flatMap((step) => (AS_STEP[step] ? [AS_STEP[step]] : []))),
    ).toEqual([]);
    // One read for the scope and the emails alike.
    expect(read).toHaveBeenCalledTimes(1);
    const [ask, own] = checkpoints.scope.mock.calls[0] ?? [];
    expect(ask).toMatchObject({
      module: 'seed',
      orgId: 'tgt-org',
      operationId: OPERATION_ID,
      written: ['Account'],
      request: { keepDays: 3 },
    });
    // What the flows create as the accounts go in, and as the second pass
    // writes them again.
    expect(ask?.running.firing.map((entry) => [entry.name, entry.write])).toEqual([
      ['Account follow-up', 'insert'],
      ['Account review', 'update'],
    ]);
    expect(own).toEqual({});
    expect(checkpoints.take.mock.calls[0]?.[1]).toEqual({ runId: OPERATION_ID });
    expect(vi.mocked(guard.confirmRun).mock.calls[0]?.[0]).toMatchObject({
      stage: 'write',
      module: 'seed',
      objects: [{ objectApiName: 'Account', rows: 3 }],
      total: 3,
      checkpoint: ESTIMATE,
    });
    expect(checkpoints.settle).toHaveBeenCalledWith(TAKEN, true);
    expect(posted('seed:clone:execute:response')[0]?.payload).toMatchObject({
      status: 'success',
      totalInserted: 3,
      checkpoint: TAKEN,
    });
    expect(auditEntry()).toMatchObject({ checkpointId: TAKEN.checkpointId });
  });

  it("counts the checkpoint's requests against what the target has left today", async () => {
    orgs(50);

    await clone({ checkpointFirst: {} });

    const [error] = failed();
    expect(error?.payload).toMatchObject({ code: 'API_BUDGET_EXCEEDED' });
    expect(String(error?.payload.error)).toContain('68 of them for the checkpoint');
    expect(checkpoints.take).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('is refused before anything is asked when its scope is refused', async () => {
    checkpoints = fakeCheckpoints({
      ...ESTIMATE,
      refusal: { code: 'TOO_MANY_RECORDS', message: 'Past the limit. No record was read.' },
    });
    handler.setBeforeRunCheckpoints(checkpoints);
    orgs();

    await clone({ checkpointFirst: {} });

    expect(failed()[0]?.payload).toMatchObject({
      code: 'CHECKPOINT_REFUSED',
      checkpointRefusal: 'TOO_MANY_RECORDS',
    });
    expect(steps).not.toContain('question');
    expect(checkpoints.take).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(auditEntry()).toMatchObject({
      outcome: 'stopped',
      details: expect.objectContaining({
        code: 'CHECKPOINT_REFUSED',
        checkpointRefusal: 'TOO_MANY_RECORDS',
      }),
    });
  });

  it('writes no record when the take is refused once the question is answered', async () => {
    checkpoints.take.mockResolvedValue({
      taken: false,
      refusal: { code: 'RUN_WRITING', message: 'A SandForge run is writing to my-dev-org.' },
    });
    orgs();

    await clone({ checkpointFirst: {} });

    expect(failed()[0]?.payload).toMatchObject({
      code: 'CHECKPOINT_REFUSED',
      checkpointRefusal: 'RUN_WRITING',
    });
    expect(create).not.toHaveBeenCalled();
    expect(checkpoints.settle).not.toHaveBeenCalled();
  });

  it('ends as a clone cancelled before it wrote when its Stop comes while the take reads', async () => {
    checkpoints.take.mockResolvedValue({ taken: false, stopped: true });
    orgs();

    await clone({ checkpointFirst: {} });

    expect(posted('seed:clone:execute:response')[0]?.payload).toMatchObject({
      totalInserted: 0,
      cancelled: true,
    });
    expect(create).not.toHaveBeenCalled();
    expect(auditEntry()).toMatchObject({
      outcome: 'stopped',
      details: expect.objectContaining({ code: 'RUN_CANCELLED' }),
    });
  });

  it('takes nothing once the question is declined', async () => {
    vi.mocked(guard.confirmRun).mockResolvedValue('declined');
    orgs();

    await clone({ checkpointFirst: {} });

    expect(failed()[0]?.payload).toMatchObject({ code: 'SEED_WRITE_DECLINED' });
    expect(checkpoints.take).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('asks nothing of a checkpoint for a clone not asked to take one', async () => {
    orgs();

    await clone();

    expect(checkpoints.scope).not.toHaveBeenCalled();
    expect(steps).not.toContain('question');
    expect(create).toHaveBeenCalled();
    expect(posted('seed:clone:execute:response')[0]?.payload).not.toHaveProperty('checkpoint');
  });
});
