/**
 * A Sync run from the page asked to take a checkpoint of what it writes before
 * its first write (Checkpoint first), through the real orchestrator, writer,
 * gate and mute, against two mocked connections and a target whose permission
 * sets live in memory: the checkpoint scoped from what still runs, asked
 * about, taken after the answer and before the mute's lease, kept once the run
 * wrote and deleted when it wrote nothing; and the record types the target
 * gave the records read back once the lease is given back, as the command
 * line reads them.
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
  SyncConfig,
  SyncExecutionResult,
} from '@sandforge/shared';
import { SyncOpsHandler } from './SyncOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { memoryPermissionOrg } from '../../test/memoryPermissionOrg.js';
import { ProductionGuard, type RunConfirmation } from '../../core/precheck/ProductionGuard.js';
import { SyncOrchestrator } from '../../modules/sync/SyncOrchestrator.js';
import type { SyncOrchestratorDeps } from '../../modules/sync/SyncOrchestrator.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { answeringDeliverability } from '../../test/deliverabilityOrg.js';
import { clearDescribeCache } from '../../core/connection/describeCache.js';
import {
  SyncRunCreations,
  type SyncRunCreationsDeps,
} from '../../modules/sync/SyncRunCreations.js';
import {
  BEFORE_RUN_DELETED_WORDS,
  writePathOrderDefects,
  type BeforeRunCheckpoints,
  type WritePathStep,
} from '../../modules/checkpoint/beforeRunCheckpoint.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

/** Every step a run makes, in the order it makes it, as the fakes below put them down. */
const steps: string[] = [];

// The plan of the mute is computed, not sent: it is put down as it is made.
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

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const SET = '0PSxx0000000001AAA';
const PARTNER = '012xx0000000001AAA';

/** An in-memory config store, enough for the audit trail and the history. */
function memoryConfigStore(): HandlerDeps['configStore'] {
  const data = new Map<string, { value: unknown; category: string }>();
  return {
    get: (key: string) => data.get(key)?.value,
    set: (key: string, value: unknown, category = 'default') => {
      data.set(key, { value: JSON.parse(JSON.stringify(value)), category });
    },
    delete: (key: string) => data.delete(key),
    has: (key: string) => data.has(key),
    getByCategory: (category: string) =>
      Object.fromEntries(
        [...data].filter(([, e]) => e.category === category).map(([k, e]) => [k, e.value]),
      ),
    getAllKeys: () => [...data.keys()],
    clearCategory: vi.fn(),
    clearAll: vi.fn(),
    initialize: vi.fn(),
  } as unknown as HandlerDeps['configStore'];
}

/** The questions asked, and the answer given. */
interface Asked {
  questions: RunConfirmation[];
  answer: boolean;
}

function createDeps(asked: Asked): HandlerDeps {
  let id = 0;
  return {
    log: vi.fn(),
    broker: {
      postToWebview: vi.fn((m: BaseMessage) => {
        if (m.type === 'sync:execute:response') steps.push('result');
      }),
    } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: {
      getOrg: vi.fn((orgId: string) =>
        orgId === 'tgt-org'
          ? { orgType: 'Production', alias: 'TRAP', metadata: { edition: 'Developer Edition' } }
          : { orgType: 'Sandbox', alias: 'SOURCE' },
      ),
    } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: memoryConfigStore(),
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    infraServices: {
      productionGuard: new ProductionGuard({
        requestRunConfirmation: async (question) => {
          steps.push('question');
          asked.questions.push(question);
          return asked.answer;
        },
      }),
    } as unknown as HandlerDeps['infraServices'],
    services: {
      getSandforgeSetting: (_key: string, fallback: unknown) => fallback,
      syncOrchestrator: (d: SyncOrchestratorDeps) => new SyncOrchestrator(d),
    } as unknown as HandlerDeps['services'],
    nextId: () => `out-${++id}`,
  };
}

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

const CONTACT_FIELDS = [
  { name: 'Id', type: 'id', createable: false, updateable: false },
  { name: 'LastName', type: 'string', createable: true, updateable: true },
];

/** Master and one record type besides, open to the user: a contact sent without one gets it. */
const RECORD_TYPES = [
  {
    recordTypeId: '012000000000000AAA',
    name: 'Master',
    developerName: 'Master',
    master: true,
    available: true,
    active: true,
    defaultRecordTypeMapping: true,
  },
  {
    recordTypeId: PARTNER,
    name: 'Partner',
    developerName: 'Partner',
    master: false,
    available: true,
    active: true,
    defaultRecordTypeMapping: false,
  },
];

/** What the checkpoint before the run would hold and cost, as the port scopes it. */
const ESTIMATE: RunCheckpointEstimate = {
  state: 'planned',
  estimate: {
    records: 38,
    apiRequests: 68,
    apiRequestsLeft: 15_000,
    seconds: 44,
    bytes: 2_200_000,
  },
  objects: ['Contact', 'Case', 'ContentDocument'],
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
  name: 'Before Sync run 2026-11-01 10:15 UTC',
  takenAt: '2026-11-01T10:15:04.000Z',
  expiresAt: '2026-11-08T10:15:04.000Z',
  objects: ['Contact', 'Case', 'ContentDocument'],
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

/** A disk in memory for the runs' files. */
function memoryRunFiles(): SyncRunCreationsDeps {
  const files = new Map<string, string>();
  return {
    storagePath: join(tmpdir(), 'storage'),
    readFile: async (filePath) => {
      const text = files.get(filePath);
      if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return text;
    },
    writeFile: async (filePath, content) => {
      files.set(filePath, content);
    },
    appendFile: async (filePath, content) => {
      files.set(filePath, (files.get(filePath) ?? '') + content);
    },
    rename: async (from, to) => {
      files.set(to, files.get(from) ?? '');
      files.delete(from);
    },
    mkdir: async () => undefined,
    rm: async (filePath) => {
      files.delete(filePath);
    },
    listFiles: async () => [],
  };
}

/** The objects the memory org answers for: the mute's reads of the permission sets. */
const PERMISSION_OBJECTS =
  /\bFROM\s+(Organization|UserPermissionAccess|PermissionSetAssignment|SetupEntityAccess|ObjectPermissions|CustomPermission|PermissionSet)\b/i;

/**
 * A source of `contacts` contacts, and a target whose permission sets live in
 * `org`: its writes, its describes and its read-back put down as steps.
 */
function mockOrgs(contacts: number, org: ReturnType<typeof memoryPermissionOrg>) {
  const rows = Array.from({ length: contacts }, (_, n) => ({
    attributes: { type: 'Contact' },
    Id: fakeId('003', n + 1),
    LastName: `Doe ${n}`,
  }));
  const create = vi.fn(async (batch: unknown[]) => {
    steps.push('write');
    return batch.map((_, n) => ({ id: fakeId('003', 900 + n), success: true, errors: [] }));
  });
  const readBack = vi.fn(async () => {
    steps.push('record types read back');
    return { done: true, totalSize: 1, records: [{ RecordTypeId: PARTNER, n: contacts }] };
  });
  vi.mocked(getJsforceConnection).mockImplementation(async (orgId: string) => {
    const target = orgId === 'tgt-org';
    return {
      query: vi.fn(async (soql: string) => {
        if (target && PERMISSION_OBJECTS.test(soql)) return org.connection.query(soql);
        if (target && soql.startsWith('SELECT RecordTypeId, COUNT(Id) n FROM Contact')) {
          return readBack();
        }
        if (soql.startsWith('SELECT COUNT()')) {
          return { done: true, totalSize: soql.includes('IsPersonAccount') ? 0 : rows.length };
        }
        if (!target && /^SELECT Id, LastName\b.* FROM Contact/.test(soql)) {
          return { done: true, records: rows };
        }
        return { done: true, records: [] };
      }),
      queryMore: vi.fn(),
      identity: org.connection.identity,
      describe: vi.fn(async (name: string) => {
        if (target) steps.push('target describe');
        return {
          name,
          fields: name === 'Contact' ? CONTACT_FIELDS : [],
          ...(target && name === 'Contact' ? { recordTypeInfos: RECORD_TYPES } : {}),
        };
      }),
      sobject: vi.fn((name: string) =>
        target && name === 'PermissionSetAssignment'
          ? org.connection.sobject(name)
          : { create, upsert: vi.fn(), update: vi.fn(), destroy: vi.fn() },
      ),
      // An org that delivers none of the emails of its automation, its user
      // holding Send Email: its read takes two requests, and asks nothing.
      request: vi.fn(
        answeringDeliverability('withheld', async () => {
          steps.push('limits read');
          return target
            ? {
                DataStorageMB: { Max: 5, Remaining: 5 },
                DailyApiRequests: { Max: 15_000, Remaining: 15_000 },
                SingleEmail: { Max: 15, Remaining: 15 },
              }
            : {};
        }).request,
      ),
      limitInfo: undefined,
    } as never;
  });
  return { create, readBack };
}

function config(): SyncConfig {
  return {
    id: 'cfg-ck',
    name: 'contacts',
    description: '',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    direction: 'source_to_target',
    mode: 'full',
    objects: [
      {
        objectApiName: 'Contact',
        operation: 'insert',
        batchSize: 200,
        fieldMappings: [],
        transformRules: [],
        excludedFields: [],
        addOnFields: [],
        insertOrder: 0,
      },
    ],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

/** Every message the handler posted, of one type. */
function posted(
  deps: HandlerDeps,
  type: string,
): Array<BaseMessage & { payload: Record<string, unknown>; correlationId?: string }> {
  return vi
    .mocked(deps.broker.postToWebview)
    .mock.calls.map(
      ([m]) => m as BaseMessage & { payload: Record<string, unknown>; correlationId?: string },
    )
    .filter((m) => m.type === type);
}

function send(handler: SyncOpsHandler, type: string, id: string, payload: unknown) {
  return handler.handle(
    inboundRequest({ id, type, timestamp: Date.now(), payload } as BaseMessage),
  );
}

/** A step put down by the fakes, as the write path's order names it; undefined for one it does not count. */
function asStep(step: string, afterTheLease: boolean): WritePathStep | undefined {
  switch (step) {
    case 'automation read':
    case 'limits read':
      return 'reads';
    case 'target describe':
      // A describe once the lease assigned is the run's check after it.
      return afterTheLease ? 'afterLeaseCheck' : 'reads';
    case 'lease plan':
      return 'leasePlan';
    case 'checkpoint scope':
      return 'stillRunning';
    case 'question':
      return 'question';
    case 'checkpoint take':
      return 'checkpointTake';
    case 'assign':
      return 'leaseAcquire';
    case 'write':
      return 'write';
    case 'unassign':
      return 'leaseRelease';
    case 'record types read back':
      return 'recordTypeReadBack';
    case 'result':
      return 'result';
    default:
      return undefined;
  }
}

/** The steps of a run as the write path's order names them. */
function writePathOf(made: readonly string[]): WritePathStep[] {
  const named: WritePathStep[] = [];
  let leased = false;
  for (const step of made) {
    if (step === 'assign') leased = true;
    if (step === 'write' || step === 'unassign') leased = false;
    const as = asStep(step, leased);
    if (as) named.push(as);
  }
  return named;
}

describe('a Sync run that takes a checkpoint first, from the page', () => {
  let asked: Asked;
  let deps: HandlerDeps;
  let handler: SyncOpsHandler;
  let dir: string;
  let creations: SyncRunCreations;
  let checkpoints: ReturnType<typeof fakeCheckpoints>;
  const read =
    vi.fn<(orgId: string, objects: readonly string[]) => Promise<ForgeTargetAutomation>>();

  beforeEach(() => {
    vi.clearAllMocks();
    clearDescribeCache();
    steps.length = 0;
    asked = { questions: [], answer: true };
    deps = createDeps(asked);
    handler = new SyncOpsHandler(deps);
    read.mockReset();
    read.mockImplementation(async (_orgId, objects) => {
      steps.push('automation read');
      return contactAutomation(objects);
    });
    handler.setTargetAutomation({ read });
    handler.setHistoryLogger({ logExecution: vi.fn() } as never);
    dir = mkdtempSync(join(tmpdir(), 'sync-checkpoint-'));
    handler.setMuteLeases({ dir, renewEveryMs: 0 });
    creations = new SyncRunCreations(memoryRunFiles());
    handler.setRunCreations(creations);
    checkpoints = fakeCheckpoints();
    handler.setBeforeRunCheckpoints(checkpoints);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A target that holds the bypass's set, its writes put down as steps. */
  const permissionOrg = (refuseAssigning?: Record<string, string>) =>
    memoryPermissionOrg({
      sets: [{ id: SET, name: 'Trap_Bypass' }],
      ...(refuseAssigning ? { refuseAssigning } : {}),
      beforeWrite: (write) => {
        steps.push(write.kind === 'insert' ? 'assign' : 'unassign');
      },
    });

  const result = (): SyncExecutionResult | undefined =>
    posted(deps, 'sync:execute:response').at(-1)?.payload as SyncExecutionResult | undefined;

  it('takes it after the question and before the lease, keeps it once written, and reads the record types back once the lease is given back', async () => {
    const org = permissionOrg();
    const { create, readBack } = mockOrgs(3, org);

    await send(handler, 'sync:execute', 'run-ck', {
      config: config(),
      muteAutomation: true,
      checkpointFirst: { keepDays: 3 },
    });
    await vi.waitFor(() => expect(steps).toContain('result'));

    // The take after the answer and before the first assignment; the
    // describe read again under the lease; the checkpoint settled once the
    // run wrote and read back, before its result.
    expect(steps).toEqual([
      'target describe',
      'target describe',
      'automation read',
      'lease plan',
      'checkpoint scope',
      'limits read',
      'question',
      'checkpoint take',
      'assign',
      'target describe',
      'write',
      'unassign',
      'record types read back',
      'checkpoint settle',
      'result',
    ]);
    expect(writePathOrderDefects(writePathOf(steps))).toEqual([]);

    // Scoped from the objects the run writes and what still runs once the
    // mute holds: the case flow, never the bypassed one.
    const [ask, own] = checkpoints.scope.mock.calls[0] ?? [];
    expect(ask).toMatchObject({
      module: 'sync',
      orgId: 'tgt-org',
      operationId: 'run-ck',
      written: ['Contact'],
      request: { keepDays: 3 },
    });
    expect(ask?.running.firing.map((entry) => entry.name)).toEqual(['Contact case']);
    expect(own).toEqual({ runId: 'run-ck' });
    // Taken with what the question said it takes, under the run's Stop.
    const [, takeOwn, options] = checkpoints.take.mock.calls[0] ?? [];
    expect(takeOwn).toEqual({ runId: 'run-ck' });
    expect(options?.planned).toBe(ESTIMATE);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    // One question, the checkpoint's block in it.
    expect(asked.questions).toHaveLength(1);
    expect(asked.questions[0]).toMatchObject({ stage: 'write', checkpoint: ESTIMATE });

    expect(create).toHaveBeenCalled();
    expect(checkpoints.settle).toHaveBeenCalledWith(TAKEN, true);
    expect(org.assignments()).toEqual([]);
    expect(result()).toMatchObject({ status: 'success', checkpoint: TAKEN });
    // The record type the target gave, read back once written.
    expect(readBack).toHaveBeenCalledTimes(1);
    expect(result()?.objectResults[0]?.recordTypeGiven?.readBack).toMatchObject({
      read: 3,
      types: [{ developerName: 'Partner', label: 'Partner', rows: 3 }],
    });
    // Named in the audit trail and on the run's file.
    const audit = new AuditTrailStore(deps.configStore).list().entries;
    expect(audit.find((e) => e.operationId === 'run-ck')).toMatchObject({
      outcome: 'success',
      checkpointId: TAKEN.checkpointId,
    });
    expect((await creations.get('run-ck'))?.checkpoint).toEqual(TAKEN);
  });

  it('reads the record types again once the lease assigned a set, past the describe the run holds', async () => {
    const org = permissionOrg();
    mockOrgs(3, org);

    await send(handler, 'sync:execute', 'run-again', {
      config: config(),
      muteAutomation: true,
      checkpointFirst: {},
    });
    await vi.waitFor(() => expect(steps).toContain('result'));

    const assign = steps.indexOf('assign');
    const write = steps.indexOf('write');
    expect(steps.slice(assign, write)).toContain('target describe');
  });

  it('keeps the user it writes as in its file, once the target said', async () => {
    const org = permissionOrg();
    mockOrgs(3, org);

    await send(handler, 'sync:execute', 'run-user', { config: config() });
    await vi.waitFor(() => expect(steps).toContain('result'));

    await vi.waitFor(async () =>
      expect((await creations.get('run-user'))?.runUserId).toBe(org.userId),
    );
  });

  it('goes on past a target that never says who it is, and keeps its run without it', async () => {
    const org = permissionOrg();
    mockOrgs(3, {
      ...org,
      connection: { ...org.connection, identity: () => new Promise(() => undefined) },
    } as never);

    await send(handler, 'sync:execute', 'run-silent', { config: config() });
    await vi.waitFor(() => expect(steps).toContain('result'));

    const run = await creations.get('run-silent');
    expect(run?.created).toHaveLength(1);
    expect(run).not.toHaveProperty('runUserId');
  });

  it('takes it after the question and writes, for a run that does not mute', async () => {
    const org = permissionOrg();
    const { create } = mockOrgs(3, org);

    await send(handler, 'sync:execute', 'run-plain', { config: config(), checkpointFirst: {} });
    await vi.waitFor(() => expect(steps).toContain('result'));

    expect(writePathOrderDefects(writePathOf(steps))).toEqual([]);
    expect(steps.indexOf('checkpoint take')).toBeLessThan(steps.indexOf('write'));
    expect(create).toHaveBeenCalled();
    expect(result()).toMatchObject({ checkpoint: TAKEN });
  });

  it('refuses the run before its question when the scope is refused: nothing taken, assigned or written', async () => {
    checkpoints = fakeCheckpoints({
      ...ESTIMATE,
      refusal: {
        code: 'RUN_WRITING',
        message: 'A SandForge run is writing to TRAP. No record was read.',
      },
    });
    handler.setBeforeRunCheckpoints(checkpoints);
    const org = permissionOrg();
    const { create } = mockOrgs(3, org);

    await send(handler, 'sync:execute', 'run-refused', {
      config: config(),
      muteAutomation: true,
      checkpointFirst: {},
    });
    await vi.waitFor(() => expect(posted(deps, 'sync:error')).toHaveLength(1));

    const [error] = posted(deps, 'sync:error');
    expect(error.payload).toMatchObject({
      code: 'CHECKPOINT_REFUSED',
      checkpointRefusal: 'RUN_WRITING',
    });
    expect(String(error.payload.message)).toMatch(/^The checkpoint before the run was refused: /);
    expect(asked.questions).toEqual([]);
    expect(checkpoints.take).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(org.writes).toEqual([]);
    const audit = new AuditTrailStore(deps.configStore).list().entries;
    expect(audit.find((e) => e.operationId === 'run-refused')).toMatchObject({
      outcome: 'stopped',
      details: expect.objectContaining({
        code: 'CHECKPOINT_REFUSED',
        checkpointRefusal: 'RUN_WRITING',
      }),
    });
  });

  it('deletes the checkpoint it took when the lease is refused after the take: the run wrote nothing', async () => {
    const org = permissionOrg({ [SET]: 'INSUFFICIENT_ACCESS' });
    const { create } = mockOrgs(3, org);

    await send(handler, 'sync:execute', 'run-lease', {
      config: config(),
      muteAutomation: true,
      checkpointFirst: {},
    });
    await vi.waitFor(() => expect(posted(deps, 'sync:error')).toHaveLength(1));

    expect(checkpoints.take).toHaveBeenCalledTimes(1);
    expect(checkpoints.settle).toHaveBeenCalledWith(TAKEN, false);
    expect(create).not.toHaveBeenCalled();
    const [error] = posted(deps, 'sync:error');
    // Said once, in the page's language, from what the error carries; the
    // lifecycle's message keeps it for Live Operations and the log.
    expect(error.payload.checkpoint).toEqual({ state: 'deleted', deleted: 'nothingWritten' });
    expect(String(error.payload.message)).not.toContain(BEFORE_RUN_DELETED_WORDS);
    expect(String(posted(deps, 'operation:failed')[0]?.payload.error)).toContain(
      BEFORE_RUN_DELETED_WORDS,
    );
    // No file of a run that wrote nothing, and nothing left assigned.
    expect(await creations.get('run-lease')).toBeUndefined();
    expect(org.assignments()).toEqual([]);
  });

  it('names on its error the checkpoint it deleted when it fails before its first write', async () => {
    const org = permissionOrg();
    const { create } = mockOrgs(3, org);
    const open = vi.mocked(getJsforceConnection).getMockImplementation();
    vi.mocked(getJsforceConnection).mockImplementation(async (...args) => {
      const conn = await (open as typeof getJsforceConnection)(...args);
      return args[0] === 'tgt-org'
        ? conn
        : ({
            ...conn,
            query: vi.fn(async (soql: string) => {
              if (/^SELECT Id, LastName\b/.test(soql)) throw new Error('The source went away.');
              return conn.query(soql);
            }),
          } as never);
    });

    await send(handler, 'sync:execute', 'run-fails', { config: config(), checkpointFirst: {} });
    await vi.waitFor(() => expect(posted(deps, 'sync:error')).toHaveLength(1));

    const [error] = posted(deps, 'sync:error');
    expect(error.payload).toMatchObject({
      checkpoint: { state: 'deleted', deleted: 'nothingWritten' },
    });
    expect(String(error.payload.message)).not.toContain(BEFORE_RUN_DELETED_WORDS);
    expect(checkpoints.settle).toHaveBeenCalledWith(TAKEN, false);
    expect(create).not.toHaveBeenCalled();
  });

  it('takes nothing once the question is declined', async () => {
    asked.answer = false;
    const org = permissionOrg();
    const { create } = mockOrgs(3, org);

    await send(handler, 'sync:execute', 'run-no', { config: config(), checkpointFirst: {} });
    await vi.waitFor(() => expect(posted(deps, 'sync:error')).toHaveLength(1));

    expect(posted(deps, 'sync:error')[0]?.payload).toMatchObject({ code: 'SYNC_WRITE_DECLINED' });
    expect(checkpoints.take).not.toHaveBeenCalled();
    expect(checkpoints.settle).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses the run, nothing written, in a window whose checkpoints it was not given', async () => {
    const bare = new SyncOpsHandler(deps);
    bare.setTargetAutomation({ read });
    const org = permissionOrg();
    const { create } = mockOrgs(3, org);

    await send(bare, 'sync:execute', 'run-bare', { config: config(), checkpointFirst: {} });
    await vi.waitFor(() => expect(posted(deps, 'sync:error')).toHaveLength(1));

    const [error] = posted(deps, 'sync:error');
    expect(error.payload).toMatchObject({ code: 'CHECKPOINT_REFUSED' });
    expect(String(error.payload.message)).toMatch(/could not be taken: .*Nothing was written\.$/);
    expect(asked.questions).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it('says in a simulation what the checkpoint would hold and cost, counted in its requests, and takes nothing', async () => {
    const org = permissionOrg();
    mockOrgs(3, org);

    await send(handler, 'sync:simulate', 'sim-ck', { config: config(), checkpointFirst: {} });
    await vi.waitFor(() => expect(posted(deps, 'sync:simulate:response')).toHaveLength(1));

    const [answer] = posted(deps, 'sync:simulate:response');
    expect(answer.payload.checkpoint).toEqual(ESTIMATE);
    const check = answer.payload.writeCheck as { apiRequests?: { estimate: number } };
    // The run's write and the read-back of the record types given, the take's
    // 68, and the two of the read of whether the target delivers the email
    // its welcome flow sends; and the run's reads of the target: who it
    // writes as, its limits, and the read of its automation's one.
    expect(check.apiRequests?.estimate).toBe(
      1 + 1 + ESTIMATE.estimate.apiRequests + 2 + (2 + 3 + 1),
    );
    expect(checkpoints.take).not.toHaveBeenCalled();
    expect(asked.questions).toEqual([]);
  });

  it('says nothing of a checkpoint in a simulation not asked for one', async () => {
    const org = permissionOrg();
    mockOrgs(3, org);

    await send(handler, 'sync:simulate', 'sim-plain', { config: config() });
    await vi.waitFor(() => expect(posted(deps, 'sync:simulate:response')).toHaveLength(1));

    expect(posted(deps, 'sync:simulate:response')[0]?.payload).not.toHaveProperty('checkpoint');
    expect(checkpoints.scope).not.toHaveBeenCalled();
  });

  it('does not queue for replay a run asked to take a checkpoint first that the network stopped', async () => {
    // Replayed from its configuration alone, it would write with no
    // checkpoint to rewind it to.
    const enqueue = vi.fn(() => true);
    deps.infraServices = {
      ...deps.infraServices,
      offlineManager: { enqueue },
    } as unknown as HandlerDeps['infraServices'];
    vi.mocked(getJsforceConnection).mockRejectedValue(
      Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' }),
    );

    await send(handler, 'sync:execute', 'run-net-ck', { config: config(), checkpointFirst: {} });
    await vi.waitFor(() => expect(posted(deps, 'sync:error')).toHaveLength(1));
    expect(enqueue).not.toHaveBeenCalled();

    await send(handler, 'sync:execute', 'run-net', { config: config() });
    await vi.waitFor(() => expect(posted(deps, 'sync:error')).toHaveLength(2));
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
