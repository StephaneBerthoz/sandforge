/**
 * A seed from the panel asked to take a checkpoint of what it writes before
 * its first write (Checkpoint first): scoped from what still runs once the
 * mute's plan holds, its requests counted at the storage gate, asked about,
 * taken after the answer and before the mute's lease, kept once the seed
 * sent a record and deleted when it sent none; and refused, at its scope or
 * its take, under its own code, never as the data storage the page said was
 * exceeded.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BaseMessage,
  ForgeTargetAutomation,
  RunCheckpointEstimate,
  RunCheckpointTaken,
  SeedTemplate,
} from '@sandforge/shared';
import { CRM_STARTER, RETAIL_ORDERS_PACK, SALES_CLOUD_STARTER } from '@sandforge/shared';

import { SeedOpsHandler } from './SeedOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { memoryPermissionOrg } from '../../test/memoryPermissionOrg.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { EMAIL_NOT_PERMITTED } from '../../modules/forge/targetDeliverability.js';
import {
  nodeSeedRunCreations,
  type SeedRunCreations,
} from '../../modules/seed/SeedRunCreations.js';
import {
  BEFORE_RUN_DELETED_WORDS,
  writePathOrderDefects,
  type BeforeRunCheckpoints,
  type WritePathStep,
} from '../../modules/checkpoint/beforeRunCheckpoint.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

/** Every step a seed makes, in the order it makes it, as the fakes below put them down. */
const steps: string[] = [];

// The plan of the mute and what still runs are computed, not sent: each is
// put down as it is made.
vi.mock('../../modules/forge/AutomationMuteLease.js', async (original) => {
  const actual = await original<typeof import('../../modules/forge/AutomationMuteLease.js')>();
  return {
    ...actual,
    muteForRun: vi.fn((...args: Parameters<typeof actual.muteForRun>) => {
      steps.push('lease plan');
      return actual.muteForRun(...args);
    }),
  };
});
vi.mock('../../modules/seed/seedFit.js', async (original) => {
  const actual = await original<typeof import('../../modules/seed/seedFit.js')>();
  return {
    ...actual,
    seedRoomOf: vi.fn((...args: Parameters<typeof actual.seedRoomOf>) => {
      steps.push('still running');
      return actual.seedRoomOf(...args);
    }),
  };
});

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

const SET = '0PSxx0000000001AAA';

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

/** Two accounts and three contacts: a seed that fits a Developer Edition. */
const SMALL: SeedTemplate = {
  ...CRM_STARTER,
  objects: CRM_STARTER.objects
    .filter((o) => o.objectApiName === 'Account' || o.objectApiName === 'Contact')
    .map((o) => ({ ...o, recordCount: o.objectApiName === 'Account' ? 2 : 3 })),
  relations: [],
};

/**
 * The target's contact automation: a flow emailing each contact created and
 * opening a task, which a permission set's bypass keeps quiet; and a flow
 * opening a case under each, which nothing keeps quiet.
 */
function contactAutomation(objects: readonly string[]): ForgeTargetAutomation {
  return {
    objectsRead: [...objects],
    objects: [
      {
        objectApiName: 'Contact',
        flows: [
          {
            apiName: 'Welcome_Email',
            label: 'Welcome Email',
            timing: 'afterSave',
            startsOn: 'create',
            condition: 'read',
            creates: ['Task'],
            permissions: [{ name: 'Trap_Bypass_Flow', bypass: true, held: false }],
            messages: [{ kind: 'email', name: 'Send Welcome Email', limit: 'SingleEmail' }],
          },
          {
            apiName: 'Contact_Case',
            label: 'Contact case',
            timing: 'afterSave',
            startsOn: 'create',
            condition: 'read',
            creates: ['Case'],
            permissions: [],
          },
        ],
        triggers: [],
      },
    ],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 25,
    bypassGrants: [
      {
        permission: 'Trap_Bypass_Flow',
        permissionSets: [{ name: 'Trap_Bypass', label: 'Trap Bypass', grants: 1 }],
      },
    ],
    requests: 1,
  };
}

/** What the checkpoint before the seed would hold and cost, as the port scopes it. */
const ESTIMATE: RunCheckpointEstimate = {
  state: 'planned',
  estimate: {
    records: 38,
    apiRequests: 68,
    apiRequestsLeft: 15_000,
    seconds: 44,
    bytes: 2_200_000,
  },
  objects: ['Account', 'Contact', 'Case', 'ContentDocument'],
  added: [
    {
      objectApiName: 'Case',
      reason: "The target's flow 'Contact_Case' creates Case records as Contact records go in.",
    },
  ],
  notHeld: [],
  keepDays: 7,
};

const TAKEN: RunCheckpointTaken = {
  state: 'taken',
  checkpointId: 'ck-20261101-101500-a1b2',
  name: 'Before Seed run 2026-11-01 10:15 UTC',
  takenAt: '2026-11-01T10:15:04.000Z',
  expiresAt: '2026-11-08T10:15:04.000Z',
  objects: ESTIMATE.objects,
  records: 38,
  bytes: 2_200_000,
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
  'lease plan': 'leasePlan',
  'still running': 'stillRunning',
  'checkpoint scope': 'stillRunning',
  'deliverability read': 'deliverabilityRead',
  question: 'question',
  'checkpoint take': 'checkpointTake',
  assign: 'leaseAcquire',
  write: 'write',
  unassign: 'leaseRelease',
  result: 'result',
};

describe('SeedOpsHandler — a seed that takes a checkpoint first', () => {
  let deps: HandlerDeps;
  let handler: SeedOpsHandler;
  let guard: ProductionGuard;
  let checkpoints: ReturnType<typeof fakeCheckpoints>;
  let dir: string;
  let audited: Array<{ key: string; value: unknown }>;
  /** Whether the seed's run sends a record: one whose generator made none sends nothing. */
  let sendsRecords: boolean;
  const read =
    vi.fn<(orgId: string, objects: readonly string[]) => Promise<ForgeTargetAutomation>>();
  const create = vi.fn(async (batch: Record<string, unknown>[]) => {
    steps.push('write');
    return batch.map((_, n) => ({ id: fakeId('003', n + 1), success: true, errors: [] }));
  });

  const posted = (type: string) =>
    vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
      .filter((m) => m.type === type);

  /** A Developer Edition whose permission sets live in memory, its limits as given. */
  function developerEdition(
    org: ReturnType<typeof memoryPermissionOrg>,
    api = { Max: 15_000, Remaining: 15_000 },
    storage = { Max: 5, Remaining: 5 },
  ) {
    vi.mocked(getJsforceConnection).mockResolvedValue({
      request: vi.fn(async ({ url }: { url: string }) => {
        // An org on System email only: what still runs sends nothing out,
        // and asks nothing of a seed that is not asked a question otherwise.
        if (url.includes('executeAnonymous')) {
          steps.push('deliverability read');
          return { compiled: true, success: false, exceptionMessage: EMAIL_NOT_PERMITTED };
        }
        if (url.includes('UserPermissionAccess')) {
          return { records: [{ PermissionsEmailSingle: true }] };
        }
        steps.push('limits read');
        return {
          DataStorageMB: storage,
          DailyApiRequests: api,
          SingleEmail: { Max: 15, Remaining: 15 },
        };
      }),
      query: async (soql: string) =>
        soql.includes('DefaultLocaleSidKey')
          ? { records: [{ DefaultLocaleSidKey: 'en_US' }] }
          : org.connection.query(soql),
      identity: org.connection.identity,
      sobject: (name: string) =>
        name === 'PermissionSetAssignment' ? org.connection.sobject(name) : { create },
    } as never);
  }

  /** A target that holds the bypass's set, its writes put down as steps. */
  const permissionOrg = (refuseAssigning?: Record<string, string>) =>
    memoryPermissionOrg({
      sets: [{ id: SET, name: 'Trap_Bypass' }],
      ...(refuseAssigning ? { refuseAssigning } : {}),
      beforeWrite: (write) => {
        steps.push(write.kind === 'insert' ? 'assign' : 'unassign');
      },
    });

  beforeEach(() => {
    vi.clearAllMocks();
    steps.length = 0;
    audited = [];
    sendsRecords = true;
    read.mockReset();
    read.mockImplementation(async (_orgId, objects) => {
      steps.push('automation read');
      return contactAutomation(objects);
    });
    let n = 0;
    guard = new ProductionGuard();
    vi.spyOn(guard, 'confirmRun').mockImplementation(async () => {
      steps.push('question');
      return 'confirmed';
    });
    const store = new Map<string, unknown>();
    deps = {
      log: vi.fn(),
      broker: {
        postToWebview: vi.fn((m: BaseMessage) => {
          if (m.type === 'seed:execute:response') steps.push('result');
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
          audited.push({ key, value });
        }),
        getKeysByPrefix: vi.fn(() => []),
      } as unknown as HandlerDeps['configStore'],
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      infraServices: { productionGuard: guard } as HandlerDeps['infraServices'],
      services: {
        isAIEnabled: () => false,
        getSandforgeSetting: vi.fn((_key: string, fallback: unknown) => fallback),
        // The seed's own inserts, through the handler's insert: what keeps
        // the checkpoint once one goes.
        seedOrchestrator: vi.fn(
          (seedDeps: {
            insert: (
              orgId: string,
              objectApiName: string,
              records: Record<string, unknown>[],
              batchSize: number,
            ) => Promise<unknown>;
          }) => ({
            execute: vi.fn(async (template: SeedTemplate, orgId: string) => {
              if (sendsRecords) await seedDeps.insert(orgId, 'Contact', [{ LastName: 'Doe' }], 200);
              return {
                templateId: template.id,
                operationId: 'op-1',
                status: 'success',
                objectResults: [],
                totalRecordsCreated: 1,
                totalRecordsFailed: 0,
                duration: 1,
                timestamp: '2026-11-01T00:00:00.000Z',
              };
            }),
          }),
        ),
      } as unknown as HandlerDeps['services'],
      nextId: () => String(++n),
    };
    handler = new SeedOpsHandler(deps);
    handler.setTargetAutomation({ read });
    dir = mkdtempSync(join(tmpdir(), 'seed-checkpoint-'));
    handler.setMuteLeases({ dir, renewEveryMs: 0 });
    checkpoints = fakeCheckpoints();
    handler.setBeforeRunCheckpoints(checkpoints);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const execute = (template: SeedTemplate, extra: Record<string, unknown> = {}) =>
    handler.handle(
      inboundRequest({
        id: 'seed-ck',
        type: 'seed:execute',
        timestamp: Date.now(),
        payload: { orgId: 'org-1', template, ...extra },
      }),
    );

  /** The audit entry of the seed, once it was recorded. */
  const auditEntry = () =>
    new AuditTrailStore(deps.configStore).list().entries.find((e) => e.operationId === 'seed-ck');

  describe('kept in the run’s file', () => {
    let runs: SeedRunCreations;

    beforeEach(() => {
      runs = nodeSeedRunCreations(dir);
      handler.setRunCreations(runs);
    });

    it('names the checkpoint and the user it wrote as, once the org said', async () => {
      const org = permissionOrg();
      developerEdition(org);

      await execute(SMALL, { checkpointFirst: {} });
      await vi.waitFor(() => expect(steps).toContain('result'));

      const [run] = await runs.list();
      await vi.waitFor(async () =>
        expect((await runs.get(run?.runId ?? ''))?.runUserId).toBe(org.userId),
      );
      expect((await runs.get(run?.runId ?? ''))?.checkpoint).toEqual(TAKEN);
    });

    it('leaves no file of a seed that took one and sent nothing', async () => {
      const org = permissionOrg();
      developerEdition(org);
      sendsRecords = false;

      await execute(SMALL, { checkpointFirst: {} });
      await vi.waitFor(() => expect(steps).toContain('result'));

      expect(await runs.list()).toEqual([]);
    });

    it('goes on past a target that never says who it is, and keeps its run without it', async () => {
      const org = permissionOrg();
      developerEdition({
        ...org,
        connection: { ...org.connection, identity: () => new Promise(() => undefined) },
      } as never);

      await execute(SMALL);
      await vi.waitFor(() => expect(steps).toContain('result'));

      const [run] = await runs.list();
      expect(run?.created).toHaveLength(1);
      expect(run).not.toHaveProperty('runUserId');
    });
  });

  it('takes it after the question and before the lease, keeps it once a record went, and names it in the result and the audit trail', async () => {
    const org = permissionOrg();
    developerEdition(org);

    await execute(SMALL, { muteAutomation: true, checkpointFirst: { keepDays: 3 } });
    await vi.waitFor(() => expect(steps).toContain('result'));

    expect(steps).toEqual([
      'automation read',
      'lease plan',
      'still running',
      'checkpoint scope',
      'limits read',
      'question',
      'checkpoint take',
      'assign',
      'write',
      'unassign',
      'checkpoint settle',
      'result',
    ]);
    expect(
      writePathOrderDefects(steps.flatMap((step) => (AS_STEP[step] ? [AS_STEP[step]] : []))),
    ).toEqual([]);
    // Scoped from the objects the seed creates and what still runs once the
    // mute holds: the case flow, never the bypassed one.
    const [ask, own] = checkpoints.scope.mock.calls[0] ?? [];
    expect(ask).toMatchObject({
      module: 'seed',
      orgId: 'org-1',
      operationId: 'seed-ck',
      written: ['Account', 'Contact'],
      request: { keepDays: 3 },
    });
    expect(ask?.running.firing.map((entry) => entry.name)).toEqual(['Contact case']);
    expect(own).toEqual({});
    // Taken with what the question said it takes, under the seed's Stop,
    // its own run file left out of what refuses it.
    const [, takeOwn, options] = checkpoints.take.mock.calls[0] ?? [];
    expect(takeOwn).toEqual({ runId: expect.any(String) });
    expect(options?.planned).toBe(ESTIMATE);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(vi.mocked(guard.confirmRun).mock.calls[0]?.[0]).toMatchObject({
      stage: 'write',
      module: 'seed',
      checkpoint: ESTIMATE,
    });
    expect(checkpoints.settle).toHaveBeenCalledWith(TAKEN, true);
    expect(org.assignments()).toEqual([]);
    expect(posted('seed:execute:response')[0]?.payload).toMatchObject({ checkpoint: TAKEN });
    expect(auditEntry()).toMatchObject({ outcome: 'success', checkpointId: TAKEN.checkpointId });
  });

  it('takes it, and mutes, for a scenario as for a template: the page asks both of a pack', async () => {
    const org = permissionOrg();
    developerEdition(org);

    await handler.handle(
      inboundRequest({
        id: 'seed-ck',
        type: 'seed:scenario:execute',
        timestamp: Date.now(),
        payload: {
          orgId: 'org-1',
          pack: RETAIL_ORDERS_PACK,
          options: { seed: 1, caseStatus: { open: 'New', closed: 'Closed' } },
          muteAutomation: true,
          checkpointFirst: {},
        },
      }),
    );
    await vi.waitFor(() => expect(steps).toContain('result'));

    expect(checkpoints.scope.mock.calls[0]?.[0]).toMatchObject({ module: 'seed', request: {} });
    expect(steps.indexOf('checkpoint take')).toBeLessThan(steps.indexOf('assign'));
    expect(steps.indexOf('assign')).toBeLessThan(steps.indexOf('write'));
    expect(org.assignments()).toEqual([]);
    expect(posted('seed:execute:response')[0]?.payload).toMatchObject({ checkpoint: TAKEN });
  });

  it("counts the checkpoint's requests at the storage gate: a seed that fits alone is refused with them", async () => {
    // 50 requests left of 15 000: the seed's own two fit, the take's 68 do not.
    const org = permissionOrg();
    developerEdition(org, { Max: 15_000, Remaining: 50 });

    await execute(SMALL, { checkpointFirst: {} });

    const [error] = posted('seed:error');
    expect(error?.payload).toMatchObject({ code: 'API_BUDGET_EXCEEDED' });
    expect(String(error?.payload.message)).toContain('68 of them for the checkpoint');
    expect(checkpoints.take).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('is refused under its own code when its scope is refused, the storage exceeded or not, with no fit proposed', async () => {
    checkpoints = fakeCheckpoints({
      ...ESTIMATE,
      refusal: {
        code: 'DISK',
        message:
          'The checkpoint before the run takes about 2.1 MB on this machine, and its disk has ' +
          '0.5 MB free, less than that and a tenth more: make room, or leave objects out of the ' +
          'checkpoint. No record was read.',
      },
    });
    handler.setBeforeRunCheckpoints(checkpoints);
    const org = permissionOrg();
    // A template three times the org's storage: the checkpoint's refusal is
    // what is said, and no smaller seed answers it.
    developerEdition(org);

    await execute(SALES_CLOUD_STARTER, { muteAutomation: true, checkpointFirst: {} });

    const [error] = posted('seed:error');
    expect(error?.payload).toMatchObject({ code: 'CHECKPOINT_REFUSED', checkpointRefusal: 'DISK' });
    expect(String(error?.payload.message)).toMatch(/^The checkpoint before the run was refused: /);
    expect(error?.payload).not.toHaveProperty('fit');
    expect(error?.payload).not.toHaveProperty('estimateMB');
    expect(steps).not.toContain('question');
    expect(checkpoints.take).not.toHaveBeenCalled();
    expect(org.writes).toEqual([]);
    expect(create).not.toHaveBeenCalled();
    expect(auditEntry()).toMatchObject({
      outcome: 'stopped',
      details: expect.objectContaining({ code: 'CHECKPOINT_REFUSED', checkpointRefusal: 'DISK' }),
    });
  });

  it('is refused, nothing assigned or written, when the take is refused once the question is answered', async () => {
    checkpoints.take.mockImplementation(async () => {
      steps.push('checkpoint take');
      return {
        taken: false,
        refusal: {
          code: 'RUN_WRITING',
          message: 'A SandForge run is writing to my-dev-org: start this run once it has ended.',
        },
      };
    });
    const org = permissionOrg();
    developerEdition(org);

    await execute(SMALL, { muteAutomation: true, checkpointFirst: {} });
    await vi.waitFor(() => expect(posted('seed:error')).toHaveLength(1));

    expect(posted('seed:error')[0]?.payload).toMatchObject({
      code: 'CHECKPOINT_REFUSED',
      checkpointRefusal: 'RUN_WRITING',
    });
    expect(org.writes).toEqual([]);
    expect(create).not.toHaveBeenCalled();
    expect(checkpoints.settle).not.toHaveBeenCalled();
    expect(auditEntry()).toMatchObject({
      outcome: 'stopped',
      details: expect.objectContaining({
        code: 'CHECKPOINT_REFUSED',
        checkpointRefusal: 'RUN_WRITING',
      }),
    });
  });

  it('deletes the checkpoint it took when the lease is refused after the take: the seed wrote nothing', async () => {
    const org = permissionOrg({ [SET]: 'INSUFFICIENT_ACCESS' });
    developerEdition(org);

    await execute(SMALL, { muteAutomation: true, checkpointFirst: {} });
    await vi.waitFor(() => expect(posted('seed:error')).toHaveLength(1));

    expect(checkpoints.take).toHaveBeenCalledTimes(1);
    expect(checkpoints.settle).toHaveBeenCalledWith(TAKEN, false);
    expect(create).not.toHaveBeenCalled();
    // Said once, in the page's language, from what the error carries; the
    // lifecycle's message keeps it for Live Operations and the log.
    const [error] = posted('seed:error');
    expect(error?.payload.code).toBe('MUTE_FAILED');
    expect(error?.payload.checkpoint).toEqual({ state: 'deleted', deleted: 'nothingWritten' });
    expect(String(error?.payload.message)).not.toContain(BEFORE_RUN_DELETED_WORDS);
    expect(String(posted('operation:failed')[0]?.payload.error)).toContain(
      BEFORE_RUN_DELETED_WORDS,
    );
    expect(org.assignments()).toEqual([]);
  });

  it('takes nothing once the question is declined', async () => {
    vi.mocked(guard.confirmRun).mockResolvedValue('declined');
    const org = permissionOrg();
    developerEdition(org);

    await execute(SMALL, { checkpointFirst: {} });

    expect(posted('seed:error')[0]?.payload).toMatchObject({ code: 'SEED_WRITE_DECLINED' });
    expect(checkpoints.take).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('is refused when nobody can answer for its checkpoint, where a seed without one goes on', async () => {
    vi.mocked(guard.confirmRun).mockResolvedValue('unavailable');
    const org = permissionOrg();
    developerEdition(org);

    await execute(SMALL, { checkpointFirst: {} });

    expect(posted('seed:error')[0]?.payload).toMatchObject({
      code: 'SEED_CONFIRMATION_UNAVAILABLE',
    });
    expect(checkpoints.take).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('is refused, nothing written, in a window whose checkpoints it was not given', async () => {
    const bare = new SeedOpsHandler(deps);
    bare.setTargetAutomation({ read });
    const org = permissionOrg();
    developerEdition(org);

    await bare.handle(
      inboundRequest({
        id: 'seed-bare',
        type: 'seed:execute',
        timestamp: Date.now(),
        payload: { orgId: 'org-1', template: SMALL, checkpointFirst: {} },
      }),
    );

    const [error] = posted('seed:error');
    expect(error?.payload).toMatchObject({ code: 'CHECKPOINT_REFUSED' });
    expect(String(error?.payload.message)).toMatch(/could not be taken: .*Nothing was written\.$/);
    expect(steps).not.toContain('question');
    expect(create).not.toHaveBeenCalled();
  });

  it('deletes the checkpoint of a seed that sent no record, and says so in its result', async () => {
    // Every record left out before it went: nothing for the checkpoint to
    // take back, and the target's values in clear on this machine.
    sendsRecords = false;
    const org = permissionOrg();
    developerEdition(org);

    await execute(SMALL, { checkpointFirst: {} });
    await vi.waitFor(() => expect(steps).toContain('result'));

    expect(checkpoints.settle).toHaveBeenCalledWith(TAKEN, false);
    expect(posted('seed:execute:response')[0]?.payload).toMatchObject({
      checkpoint: { state: 'deleted', deleted: 'nothingWritten' },
    });
    expect(auditEntry()).not.toHaveProperty('checkpointId');
  });

  it('asks nothing of a checkpoint for a seed not asked to take one', async () => {
    const org = permissionOrg();
    developerEdition(org);

    await execute(SMALL);
    await vi.waitFor(() => expect(steps).toContain('result'));

    expect(checkpoints.scope).not.toHaveBeenCalled();
    expect(steps).not.toContain('question');
    expect(posted('seed:execute:response')[0]?.payload).not.toHaveProperty('checkpoint');
  });
});
