import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ForgeHandler } from './ForgeHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type {
  AuditLogEntry,
  BaseMessage,
  ForgeConfig,
  ForgeExecutionResult,
  ForgeGraph,
  ForgeGraphNode,
  ForgeRehearsal,
  ForgeTargetAutomation,
} from '@sandforge/shared';
import type { ForgeOrchestrator } from '../../modules/forge/ForgeOrchestrator.js';
import type { ExecuteOptions, ForgeWriteBoundary } from '../../modules/forge/ForgeExecutor.js';
import type { TargetAutomationReader } from '../../modules/forge/TargetAutomationReader.js';
import type {
  ForgeRehearser,
  RehearseOptions,
} from '../../modules/forge/rehearsal/ForgeRehearser.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { inboundRequest } from '../../test/mockFactories.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(async () => ({
    query: vi.fn().mockResolvedValue({ records: [], done: true, totalSize: 0 }),
    queryMore: vi.fn(),
    request: vi.fn(async () => ({ DataStorageMB: { Max: 200, Remaining: 150 } })),
  })),
}));
vi.mock('../../core/common/sforceLimitParser.js', () => ({
  checkApiLimits: vi.fn(),
}));

/*
 * What a Forge run's entry in the audit trail says of how the run was set up
 * and let through, beside what it wrote: anonymization, email addresses and
 * phone numbers, Review skipped or not, a simulation or a rehearsal of the
 * same case before it, what fired as it inserted, the gate's questions the
 * user answered, the decisions it applied, and the user it wrote as. None of
 * it was kept: a reader of the trail could not tell a clone anyone had looked
 * at from one sent straight from the form.
 */

const ACCOUNT_ID = '001000000000123';
const USERNAME = 'qa.runner@example.test';

function node(objectApiName: string, level: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 10,
    fieldCount: 5,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    errors: [],
    level,
    successCount: 0,
    failureCount: 0,
    createableFieldCount: 0,
    estimatedSizeMB: 0,
    estimatedApiCalls: 0,
    batchStrategy: 'auto',
  };
}

const GRAPH: ForgeGraph = {
  nodes: [node('Account', 0), node('Contact', 1)],
  edges: [
    {
      sourceObject: 'Account',
      targetObject: 'Contact',
      relationshipName: 'Contacts',
      type: 'lookup',
    },
  ],
  totalRecords: 20,
  estimatedSizeMB: 0.02,
  estimatedDurationSeconds: 0.1,
};

const CONFIG: ForgeConfig = {
  inputMode: 'record',
  recordId: ACCOUNT_ID,
  depth: 'direct',
  sourceOrgId: 'src-org',
  targetOrgId: 'tgt-org',
  anonymizePII: false,
  skipEmpty: false,
  batchSize: 'auto',
};

const RESULT: ForgeExecutionResult = {
  forgeId: 'forge-1',
  status: 'success',
  graph: GRAPH,
  duration: 10,
  timestamp: '2026-10-06T00:00:00.000Z',
  idRemapCount: 1,
  createdCount: 1,
};

/** A flow after a contact is created, and a trigger before. */
const FIRES: ForgeTargetAutomation = {
  objectsRead: ['Account', 'Contact'],
  objects: [
    {
      objectApiName: 'Contact',
      flows: [
        {
          apiName: 'Contact_Welcome',
          label: 'Contact welcome',
          timing: 'afterSave',
          startsOn: 'create',
          condition: 'read',
          permissions: [],
        },
      ],
      triggers: [{ name: 'ContactTrigger', events: ['beforeInsert'] }],
    },
  ],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 3,
};

const QUIET: ForgeTargetAutomation = { ...FIRES, objects: [] };

const VERDICTS: ForgeRehearsal = {
  gaps: [],
  rows: 2,
  sampled: 2,
  judged: 2,
  passed: 2,
  notJudged: 0,
  notJudgedWhy: [],
  updates: 0,
  updatesJudged: 0,
  updatesPassed: 0,
  updatesNotRehearsed: 0,
  calls: 1,
  plannedCalls: 1,
};

/** What the run is about to write: the account and `n` contacts. */
const boundaryOf = (n: number): ForgeWriteBoundary => ({
  objects: [
    { objectApiName: 'Account', rows: [{ Id: ACCOUNT_ID, Name: 'Acme' }] },
    {
      objectApiName: 'Contact',
      rows: Array.from({ length: n }, (_, i) => ({
        Id: `003${String(i + 1).padStart(12, '0')}`,
        LastName: `Contact ${i + 1}`,
      })),
    },
  ],
  dryRun: false,
});

describe('forge:execute, what the run’s audit entry says of how it was set up', () => {
  let handler: ForgeHandler;
  let deps: HandlerDeps;
  let store: ConfigStore;
  let answers: boolean[];
  let settings: Record<string, unknown>;
  let automation: ForgeTargetAutomation;
  let orgType: string;

  /** An orchestrator whose run hands `boundary` to the gate, then answers `result`. */
  function orchestratorAnswering(
    result: ForgeExecutionResult = RESULT,
    boundary?: ForgeWriteBoundary,
  ) {
    const execute = vi.fn(
      async (_g: ForgeGraph, _c: ForgeConfig, options?: Pick<ExecuteOptions, 'beforeWrite'>) => {
        if (boundary) await options?.beforeWrite?.(boundary);
        return result;
      },
    );
    return {
      execute,
      on: vi.fn().mockReturnValue(vi.fn()),
      abort: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      clearDiscoveryCache: vi.fn(),
    } as unknown as ForgeOrchestrator & { execute: typeof execute };
  }

  /** A rehearsal that asks, then answers. */
  function rehearser(): ForgeRehearser {
    return {
      rehearse: vi.fn(async (_g: ForgeGraph, _c: ForgeConfig, options: RehearseOptions) => {
        await options.confirm({
          rows: 2,
          sampled: 2,
          calls: 1,
          maxCalls: 5,
          updates: [],
          objects: [],
        });
        return VERDICTS;
      }),
    } as unknown as ForgeRehearser;
  }

  function wire(orchestrator: ForgeOrchestrator = orchestratorAnswering()): void {
    handler.setForgeOrchestrator(orchestrator, {
      rehearser: rehearser(),
      targetAutomation: {
        readForGraph: vi.fn(async () => automation),
      } as unknown as TargetAutomationReader,
    });
  }

  function send(type: string, payload: Record<string, unknown>, id = 'wv-execute') {
    return handler.handle(
      inboundRequest({ id, type, timestamp: Date.now(), payload } as BaseMessage),
    );
  }

  const execute = (payload: Record<string, unknown> = {}, config: Partial<ForgeConfig> = {}) =>
    send('forge:execute', { graph: GRAPH, config: { ...CONFIG, ...config }, ...payload });

  /** The entries of the clone's runs, newest first. */
  const runs = (): AuditLogEntry[] =>
    new AuditTrailStore(store).list().entries.filter((e) => e.action === 'forge_execute');

  beforeEach(() => {
    answers = [];
    settings = {};
    automation = QUIET;
    orgType = 'Sandbox';
    store = new ConfigStore(new InMemoryConfigStoreBackend());
    store.initialize();
    let n = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn((id: string) =>
          id === 'tgt-org'
            ? { orgType, alias: 'DEV', username: USERNAME }
            : { orgType: 'Sandbox', alias: 'UAT' },
        ),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as HandlerDeps['orgRegistry'],
      configStore: store,
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      services: {
        getSandforgeSetting: <T>(key: string, fallback: T): T =>
          (key in settings ? settings[key] : fallback) as T,
      } as unknown as HandlerDeps['services'],
      infraServices: {
        productionGuard: new ProductionGuard({
          requestRunConfirmation: async () => answers.shift() ?? true,
        }),
      } as unknown as HandlerDeps['infraServices'],
      nextId: () => String(++n),
    };
    handler = new ForgeHandler(deps);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('says whether the run anonymized and what it did with emails and phones', async () => {
    wire();
    await execute({}, { anonymizePII: true, keepContactPoints: true });
    await execute({}, { recordId: '001000000000456' });

    const [second, first] = runs();
    expect(first.context).toMatchObject({ anonymized: true, contactPoints: 'kept' });
    expect(second.context).toMatchObject({ anonymized: false, contactPoints: 'neutralized' });
  });

  it('says Review was skipped for a run Clone directly sent, and not for one from Review', async () => {
    wire();
    await execute({ reviewSkipped: true });
    await execute({}, { recordId: '001000000000456' });

    const [fromReview, direct] = runs();
    expect(direct.context?.reviewSkipped).toBe(true);
    expect(fromReview.context?.reviewSkipped).toBe(false);
  });

  it('says a simulation of the same case came before, and how many minutes before', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-06T10:00:00.000Z'));
    wire(orchestratorAnswering({ ...RESULT, createdCount: 0, idRemapCount: 0, dryRun: true }));
    await execute({}, { dryRun: true });

    vi.setSystemTime(new Date('2026-10-06T10:07:00.000Z'));
    wire();
    // Decided since: a value mapped, an object left out. The same case.
    await execute(
      {},
      {
        excludedObjects: ['Contact'],
        picklistValueMappings: [{ object: 'Account', field: 'Type', from: 'A', to: 'B' }],
      },
    );

    expect(runs()).toHaveLength(1);
    expect(runs()[0].context?.simulatedMinutesBefore).toBe(7);
  });

  it('says nothing came before a run of another case, nor one past the half hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-06T10:00:00.000Z'));
    wire(orchestratorAnswering({ ...RESULT, createdCount: 0, idRemapCount: 0, dryRun: true }));
    await execute({}, { dryRun: true });

    wire();
    await execute({}, { recordId: '001000000000456' });
    vi.setSystemTime(new Date('2026-10-06T10:31:00.000Z'));
    await execute();

    for (const entry of runs()) expect(entry.context).not.toHaveProperty('simulatedMinutesBefore');
  });

  it('says a rehearsal of the same case came before', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-06T10:00:00.000Z'));
    wire();
    await send('forge:rehearse:request', { graph: GRAPH, config: CONFIG }, 'wv-rehearse');

    vi.setSystemTime(new Date('2026-10-06T10:02:30.000Z'));
    await execute();

    expect(runs()[0].context).toMatchObject({ rehearsedMinutesBefore: 3 });
    expect(runs()[0].context).not.toHaveProperty('simulatedMinutesBefore');
  });

  it('counts what fired on insert and says the user confirmed it', async () => {
    automation = FIRES;
    wire();

    await execute();

    expect(runs()[0].context).toMatchObject({
      firedOnInsert: { flow: 1, trigger: 1, process: 0, workflowRule: 0, unread: [] },
      confirmed: ['automation'],
    });
    expect(JSON.stringify(runs()[0])).not.toMatch(/Contact welcome|ContactTrigger/);
  });

  it('counts nothing fired, and no question answered, when nothing fires', async () => {
    wire();

    await execute();

    expect(runs()[0].context?.firedOnInsert).toEqual({
      flow: 0,
      trigger: 0,
      process: 0,
      workflowRule: 0,
      unread: [],
    });
    expect(runs()[0].context).not.toHaveProperty('confirmed');
  });

  it('keeps what fired with a run the user declined at that question', async () => {
    automation = FIRES;
    answers = [false];
    wire();

    await execute();

    expect(runs()[0]).toMatchObject({
      outcome: 'stopped',
      details: { code: 'AUTOMATION_DECLINED' },
      context: { firedOnInsert: { flow: 1, trigger: 1 } },
    });
    expect(runs()[0].context).not.toHaveProperty('confirmed');
  });

  it('says the user confirmed the volume the run was about to write', async () => {
    automation = FIRES;
    settings['safety.confirmAboveRecords'] = 3;
    wire(orchestratorAnswering(RESULT, boundaryOf(5)));

    await execute();

    expect(runs()[0].context?.confirmed).toEqual(['automation', 'volume']);
  });

  it('counts the decisions the run applied, kind by kind, with the rows, and never a value', async () => {
    wire(
      orchestratorAnswering({
        ...RESULT,
        decisionsApplied: [
          {
            kind: 'map_value',
            objectApiName: 'Account',
            field: 'Type',
            from: 'Secret',
            to: 'Other',
            rows: 6,
          },
          { kind: 'truncate', objectApiName: 'Account', field: 'Name', rows: 2 },
        ],
      }),
    );

    await execute(
      {},
      {
        picklistValueMappings: [{ object: 'Account', field: 'Type', from: 'Secret', to: 'Other' }],
        truncateFields: [{ object: 'Account', field: 'Name' }],
        ignoredGaps: ['gap-1'],
      },
    );

    expect(runs()[0].context?.decisions).toEqual([
      { kind: 'map_value', count: 1, rows: 6 },
      { kind: 'truncate', count: 1, rows: 2 },
      { kind: 'ignore', count: 1 },
    ]);
    expect(JSON.stringify(runs()[0].context)).not.toMatch(/Secret|Other/);
  });

  it('names the user the run wrote as by a hash of its username', async () => {
    wire();

    await execute();

    const expected = `sha256:${createHash('sha256').update(USERNAME).digest('hex').slice(0, 12)}`;
    expect(runs()[0].userId).toBe(expected);
    expect(JSON.stringify(runs()[0])).not.toContain(USERNAME);
  });

  it('says how a run refused before it read anything was set up', async () => {
    orgType = 'Production';
    wire();

    await execute({ reviewSkipped: true }, { anonymizePII: true });

    expect(runs()[0]).toMatchObject({
      outcome: 'stopped',
      details: { code: 'PRODUCTION_TARGET' },
      context: { anonymized: true, contactPoints: 'neutralized', reviewSkipped: true },
    });
    expect(runs()[0].context).not.toHaveProperty('firedOnInsert');
  });
});
