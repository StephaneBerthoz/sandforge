/**
 * A CSV import from the Seed page asked to take a checkpoint of the object it
 * writes before its first row (Checkpoint first): scoped from what the
 * target's automation creates as the rows go in, its requests counted with
 * the import's, asked about, taken after the answer and as close to the first
 * row as it can be, kept once a row went; refused under its own code, nothing
 * written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BaseMessage,
  ForgeTargetAutomation,
  RunCheckpointEstimate,
  RunCheckpointTaken,
} from '@sandforge/shared';
import { SeedCsvHandler } from './SeedCsvHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import {
  nodeSeedRunCreations,
  type SeedRunCreations,
} from '../../modules/seed/SeedRunCreations.js';
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

/** Every step an import makes, in the order it makes it, as the fakes below put them down. */
const steps: string[] = [];

/** The writer the import builds, its writes put down as steps. */
const writer = vi.hoisted(() => ({
  insert: vi.fn(),
  upsert: vi.fn(),
  /** What the import told the writer to tell it of each call: what its run's file keeps. */
  calls: undefined as undefined | { answered: (...args: unknown[]) => void },
}));
vi.mock('../../modules/sync/BulkDataWriter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../modules/sync/BulkDataWriter.js')>()),
  BulkDataWriter: vi.fn().mockImplementation(function (built: { calls?: typeof writer.calls }) {
    writer.calls = built.calls;
    return writer;
  }),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

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
  checkpointId: 'ck-20261101-101500-c3d4',
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

const OPERATION_ID = 'csv-ck';
const RUN_USER = '005000000000001AAA';

function buildMsg(payload: Record<string, unknown>): InboundRequest {
  return inboundRequest({
    id: OPERATION_ID,
    type: 'seed:csv:execute',
    timestamp: Date.now(),
    payload: {
      orgId: 'tgt-org',
      objectApiName: 'Account',
      records: [{ name: 'Acme' }, { name: 'Globex' }],
      columnMappings: [
        { csvHeader: 'name', sfFieldApiName: 'Name', sfFieldType: 'string', sfFieldLength: 255 },
      ],
      ...payload,
    },
  } as BaseMessage);
}

describe('SeedCsvHandler — an import that takes a checkpoint first', () => {
  let deps: HandlerDeps;
  let handler: SeedCsvHandler;
  let guard: ProductionGuard;
  let checkpoints: ReturnType<typeof fakeCheckpoints>;
  const read =
    vi.fn<(orgId: string, objects: readonly string[]) => Promise<ForgeTargetAutomation>>();

  const posted = (type: string) =>
    vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
      .filter((m) => m.type === type);

  /** A Developer Edition with `remaining` API requests left today. */
  function target(
    remaining = 15_000,
    identity: () => Promise<{ user_id: string }> = async () => ({ user_id: RUN_USER }),
  ) {
    vi.mocked(getJsforceConnection).mockResolvedValue({
      identity,
      request: vi.fn(async () => {
        steps.push('limits read');
        return {
          DataStorageMB: { Max: 5, Remaining: 5 },
          DailyApiRequests: { Max: 15_000, Remaining: remaining },
        };
      }),
      limitInfo: undefined,
    } as never);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    steps.length = 0;
    read.mockReset();
    read.mockImplementation(async (_orgId, objects) => {
      steps.push('automation read');
      return accountAutomation(objects);
    });
    writer.insert.mockImplementation(async (object: string, rows: unknown[]) => {
      steps.push('write');
      const outcomes = rows.map((_, n) => ({
        success: true,
        id: `001${String(n).padStart(12, '0')}AAA`,
        errors: [],
      }));
      writer.calls?.answered(object, 'insert', outcomes);
      return outcomes;
    });
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
          if (m.type === 'seed:csv:execute:response') steps.push('result');
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
    handler = new SeedCsvHandler(deps);
    handler.setTargetAutomation({ read });
    checkpoints = fakeCheckpoints();
    handler.setBeforeRunCheckpoints(checkpoints);
  });

  const auditEntry = () =>
    new AuditTrailStore(deps.configStore)
      .list()
      .entries.find((e) => e.operationId === OPERATION_ID);

  describe('kept in the run’s file', () => {
    let dir: string;
    let runs: SeedRunCreations;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'sandforge-csv-run-'));
      runs = nodeSeedRunCreations(dir);
      handler.setRunCreations(runs);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('names the checkpoint and the user it wrote as, once the org said, and the list reads both', async () => {
      target();

      await handler.handle(buildMsg({ checkpointFirst: { keepDays: 3 } }));
      await vi.waitFor(async () =>
        expect((await runs.get(OPERATION_ID))?.runUserId).toBe(RUN_USER),
      );

      expect((await runs.get(OPERATION_ID))?.checkpoint).toEqual(TAKEN);
    });

    it('goes on past a target that never says who it is, and keeps its run without it', async () => {
      target(15_000, () => new Promise(() => undefined));

      await handler.handle(buildMsg({}));

      expect(posted('seed:csv:execute:response')[0]?.payload).toMatchObject({ insertedCount: 2 });
      const kept = await runs.get(OPERATION_ID);
      expect(kept?.created).toHaveLength(1);
      expect(kept).not.toHaveProperty('runUserId');
    });
  });

  it('takes it after the question and before the first row, keeps it once a row went, and names it', async () => {
    target();

    await handler.handle(buildMsg({ checkpointFirst: { keepDays: 3 } }));

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
    const [ask, own] = checkpoints.scope.mock.calls[0] ?? [];
    expect(ask).toMatchObject({
      module: 'seed',
      orgId: 'tgt-org',
      operationId: OPERATION_ID,
      written: ['Account'],
      request: { keepDays: 3 },
    });
    // An insert fires what starts on a creation alone: the review flow, which
    // starts on an update, creates nothing under the rows imported.
    expect(ask?.running.firing.map((entry) => entry.name)).toEqual(['Account follow-up']);
    expect(own).toEqual({});
    const [, takeOwn, options] = checkpoints.take.mock.calls[0] ?? [];
    expect(takeOwn).toEqual({ runId: OPERATION_ID });
    expect(options?.planned).toBe(ESTIMATE);
    expect(vi.mocked(guard.confirmRun).mock.calls[0]?.[0]).toMatchObject({
      stage: 'write',
      module: 'seed',
      org: 'my-dev-org',
      objects: [{ objectApiName: 'Account', rows: 2 }],
      total: 2,
      storage: { maxMB: 5, remainingMB: 5 },
      checkpoint: ESTIMATE,
    });
    expect(checkpoints.settle).toHaveBeenCalledWith(TAKEN, true);
    expect(posted('seed:csv:execute:response')[0]?.payload).toMatchObject({
      insertedCount: 2,
      checkpoint: TAKEN,
    });
    expect(auditEntry()).toMatchObject({ checkpointId: TAKEN.checkpointId });
  });

  it('scopes an upsert with what fires as its rows update the records the target holds', async () => {
    writer.upsert.mockImplementation(async (_object: string, _key: string, rows: unknown[]) => {
      steps.push('write');
      return rows.map(() => ({ success: true, errors: [] }));
    });
    target();

    await handler.handle(buildMsg({ checkpointFirst: {}, externalIdField: 'External_Id__c' }));

    const [ask] = checkpoints.scope.mock.calls[0] ?? [];
    expect(ask?.running.firing.map((entry) => [entry.name, entry.write])).toEqual([
      ['Account follow-up', 'insert'],
      ['Account review', 'update'],
    ]);
    expect(writer.upsert).toHaveBeenCalled();
  });

  it("counts the checkpoint's requests against what the org has left today", async () => {
    // The import's own job fits in 50 requests; with the take's 68 it does not.
    target(50);

    await handler.handle(buildMsg({ checkpointFirst: {} }));

    const [error] = posted('seed:csv:error');
    expect(error?.payload).toMatchObject({ code: 'API_BUDGET_EXCEEDED' });
    expect(String(error?.payload.message)).toContain('68 of them for the checkpoint');
    expect(checkpoints.take).not.toHaveBeenCalled();
    expect(writer.insert).not.toHaveBeenCalled();
  });

  it('is refused before anything is asked when its scope is refused', async () => {
    checkpoints = fakeCheckpoints({
      ...ESTIMATE,
      refusal: {
        code: 'PRODUCTION',
        message: 'my-dev-org is a production org. No record was read.',
      },
    });
    handler.setBeforeRunCheckpoints(checkpoints);
    target();

    await handler.handle(buildMsg({ checkpointFirst: {} }));

    const [error] = posted('seed:csv:error');
    expect(error?.payload).toMatchObject({
      code: 'CHECKPOINT_REFUSED',
      checkpointRefusal: 'PRODUCTION',
    });
    expect(steps).not.toContain('question');
    expect(checkpoints.take).not.toHaveBeenCalled();
    expect(writer.insert).not.toHaveBeenCalled();
    expect(auditEntry()).toMatchObject({
      outcome: 'stopped',
      details: expect.objectContaining({
        code: 'CHECKPOINT_REFUSED',
        checkpointRefusal: 'PRODUCTION',
      }),
    });
  });

  it('writes no row when the take is refused once the question is answered', async () => {
    checkpoints.take.mockResolvedValue({
      taken: false,
      refusal: { code: 'RUN_WRITING', message: 'A SandForge run is writing to my-dev-org.' },
    });
    target();

    await handler.handle(buildMsg({ checkpointFirst: {} }));

    expect(posted('seed:csv:error')[0]?.payload).toMatchObject({
      code: 'CHECKPOINT_REFUSED',
      checkpointRefusal: 'RUN_WRITING',
    });
    expect(writer.insert).not.toHaveBeenCalled();
    expect(checkpoints.settle).not.toHaveBeenCalled();
  });

  it('ends as an import cancelled before its first row when its Stop comes while the take reads', async () => {
    checkpoints.take.mockResolvedValue({ taken: false, stopped: true });
    target();

    await handler.handle(buildMsg({ checkpointFirst: {} }));

    expect(posted('seed:csv:execute:response')[0]?.payload).toMatchObject({
      insertedCount: 0,
      cancelled: true,
    });
    expect(posted('seed:csv:error')).toEqual([]);
    expect(writer.insert).not.toHaveBeenCalled();
    expect(auditEntry()).toMatchObject({
      outcome: 'stopped',
      details: expect.objectContaining({ code: 'IMPORT_CANCELLED' }),
    });
  });

  it('takes nothing once the question is declined', async () => {
    vi.mocked(guard.confirmRun).mockResolvedValue('declined');
    target();

    await handler.handle(buildMsg({ checkpointFirst: {} }));

    expect(posted('seed:csv:error')[0]?.payload).toMatchObject({ code: 'SEED_WRITE_DECLINED' });
    expect(checkpoints.take).not.toHaveBeenCalled();
    expect(writer.insert).not.toHaveBeenCalled();
  });

  it('reads no automation and asks nothing for an import not asked to take one', async () => {
    target();

    await handler.handle(buildMsg({}));

    expect(read).not.toHaveBeenCalled();
    expect(checkpoints.scope).not.toHaveBeenCalled();
    expect(steps).not.toContain('question');
    expect(writer.insert).toHaveBeenCalled();
    expect(posted('seed:csv:execute:response')[0]?.payload).not.toHaveProperty('checkpoint');
  });
});
