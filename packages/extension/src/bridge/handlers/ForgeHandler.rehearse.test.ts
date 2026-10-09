import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ForgeHandler } from './ForgeHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type {
  BaseMessage,
  ForgeConfig,
  ForgeGraph,
  ForgeGraphNode,
  ForgeRehearsal,
  ForgeTargetAutomation,
} from '@sandforge/shared';
import type { ForgeOrchestrator } from '../../modules/forge/ForgeOrchestrator.js';
import type { TargetAutomationReader } from '../../modules/forge/TargetAutomationReader.js';
import type {
  ForgeRehearser,
  RehearseOptions,
} from '../../modules/forge/rehearsal/ForgeRehearser.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import type { RunConfirmation } from '../../core/precheck/ProductionGuard.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import type { LiveOperation } from '../../modules/monitor/LiveOperationTracker.js';
import {
  RehearsalCancelledError,
  RehearsalNotRolledBackError,
} from '../../modules/forge/rehearsal/rehearse.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { inboundRequest } from '../../test/mockFactories.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(async () => ({
    query: vi.fn().mockResolvedValue({ records: [], done: true, totalSize: 0 }),
    queryMore: vi.fn(),
  })),
}));

/*
 * forge:rehearse: the channel Review's Rehearse goes through. The rehearsal
 * creates records in the target and rolls them back, through the target's
 * automation: refused against a production org, put to the user before its
 * first call, one at a time.
 */

function node(objectApiName: string, level: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 1,
    fieldCount: 2,
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
  totalRecords: 2,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 0,
};

const CONFIG: ForgeConfig = {
  inputMode: 'record',
  recordId: '001000000000123',
  depth: 'direct',
  sourceOrgId: 'src-org',
  targetOrgId: 'tgt-org',
  anonymizePII: false,
  skipEmpty: false,
  batchSize: 'auto',
};

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

const FIRES: ForgeTargetAutomation = {
  objectsRead: ['Account', 'Contact'],
  objects: [
    {
      objectApiName: 'Contact',
      flows: [],
      triggers: [{ name: 'ContactTrigger', events: ['beforeInsert', 'afterUpdate'] }],
    },
  ],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 2,
};

describe('forge:rehearse', () => {
  let handler: ForgeHandler;
  let deps: HandlerDeps;
  let questions: RunConfirmation[];
  let answers: boolean[];
  let orgType: string;
  /** What the fake rehearsal did, in order. */
  let steps: string[];
  let rehearser: ForgeRehearser & { rehearse: ReturnType<typeof vi.fn> };
  let store: ConfigStore;
  let tracker: LiveOperationTracker;
  let registry: BackgroundOperationRegistry;
  /** The entries the audit trail holds, oldest first. */
  const trail = () => new AuditTrailStore(store).list().entries;

  /** A rehearsal that reads, asks, then sends its call, as the engine does. */
  function rehearsing(): ForgeRehearser & { rehearse: ReturnType<typeof vi.fn> } {
    return {
      rehearse: vi.fn(
        async (_graph: ForgeGraph, _config: ForgeConfig, options: RehearseOptions) => {
          options.onProgress?.({ phase: 'reading', objectApiName: 'Account' });
          options.onProgress?.({ phase: 'confirming', calls: 1 });
          await options.confirm({
            rows: 2,
            sampled: 2,
            calls: 1,
            maxCalls: 5,
            updates: [{ objectApiName: 'Contact', updates: 1 }],
            objects: [{ objectApiName: 'Account', rows: 1 }],
          });
          steps.push('sent');
          options.onProgress?.({ phase: 'rehearsing', call: 1, calls: 1 });
          return VERDICTS;
        },
      ),
    } as unknown as ForgeRehearser & { rehearse: ReturnType<typeof vi.fn> };
  }

  beforeEach(() => {
    questions = [];
    answers = [];
    orgType = 'Sandbox';
    steps = [];
    store = new ConfigStore(new InMemoryConfigStoreBackend());
    store.initialize();
    tracker = new LiveOperationTracker();
    registry = new BackgroundOperationRegistry();
    let n = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn((id: string) => ({ orgType, alias: id === 'tgt-org' ? 'DEV' : 'UAT' })),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as HandlerDeps['orgRegistry'],
      configStore: store,
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      infraServices: {
        productionGuard: new ProductionGuard({
          requestRunConfirmation: async (question) => {
            questions.push(question);
            return answers.shift() ?? true;
          },
        }),
        backgroundRegistry: registry,
      } as unknown as HandlerDeps['infraServices'],
      nextId: () => String(++n),
    };
    handler = new ForgeHandler(deps);
    handler.setLiveOperationTracker(tracker);
    rehearser = rehearsing();
    handler.setForgeOrchestrator({} as ForgeOrchestrator, {
      rehearser,
      targetAutomation: {
        readForGraph: vi.fn(async () => FIRES),
      } as unknown as TargetAutomationReader,
    });
  });

  afterEach(() => {
    tracker.dispose();
    registry.dispose();
  });

  function rehearse(payload: Record<string, unknown> = { graph: GRAPH, config: CONFIG }) {
    return handler.handle(
      inboundRequest({
        id: 'wv-rehearse',
        type: 'forge:rehearse:request',
        timestamp: Date.now(),
        payload,
      } as BaseMessage),
    );
  }

  function posted(type: string): Array<BaseMessage & { payload: Record<string, unknown> }> {
    return vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
      .filter((m) => m.type === type);
  }

  it('answers with the verdicts, correlated to the request', async () => {
    await expect(rehearse()).resolves.toBe(true);
    const [response] = posted('forge:rehearse:response');
    expect(response.payload).toEqual({ rehearsal: VERDICTS });
    expect(response.correlationId).toBe('wv-rehearse');
    expect(posted('forge:rehearse:error')).toEqual([]);
  });

  it('puts the calls, the records, the updates and what the target runs on both to the user before the first call', async () => {
    await rehearse();
    expect(questions).toEqual([
      {
        stage: 'rehearsal',
        org: 'DEV',
        orgTier: 'development',
        rows: 2,
        sampled: 2,
        updates: 1,
        calls: 1,
        maxCalls: 5,
        fired: [{ objectApiName: 'Contact', kind: 'trigger', name: 'ContactTrigger' }],
        firedOnUpdate: [{ objectApiName: 'Contact', kind: 'trigger', name: 'ContactTrigger' }],
        unread: [],
      },
    ]);
  });

  it('sends nothing when the user declines, and says so', async () => {
    answers = [false];
    await rehearse();
    expect(steps).toEqual([]);
    const [error] = posted('forge:rehearse:error');
    expect(error.payload).toMatchObject({ code: 'REHEARSAL_DECLINED', retryable: true });
    expect(String(error.payload.message)).toContain('Nothing was sent');
    expect(posted('forge:rehearse:response')).toEqual([]);
  });

  it('refuses a production target before reading anything', async () => {
    orgType = 'Production';
    await rehearse();
    expect(rehearser.rehearse).not.toHaveBeenCalled();
    expect(posted('forge:rehearse:error')[0].payload).toMatchObject({ code: 'PRODUCTION_TARGET' });
  });

  it('refuses without the guard, which has nobody to ask', async () => {
    deps.infraServices = {} as HandlerDeps['infraServices'];
    await rehearse();
    expect(rehearser.rehearse).not.toHaveBeenCalled();
    expect(posted('forge:rehearse:error')[0].payload).toMatchObject({ code: 'NOT_INITIALIZED' });
  });

  it('runs one rehearsal at a time', async () => {
    let release: () => void = () => {};
    rehearser.rehearse.mockImplementationOnce(
      () => new Promise<ForgeRehearsal>((resolve) => (release = () => resolve(VERDICTS))),
    );
    const first = rehearse();
    await vi.waitFor(() => expect(rehearser.rehearse).toHaveBeenCalledTimes(1));
    await rehearse();
    expect(posted('forge:rehearse:error')[0].payload).toMatchObject({ code: 'REHEARSAL_RUNNING' });
    release();
    await first;
    expect(posted('forge:rehearse:response')).toHaveLength(1);
  });

  it('says how far it has got: each phase, and the call under way', async () => {
    await rehearse();
    expect(posted('forge:rehearse:progress').map((m) => m.payload)).toEqual([
      { phase: 'reading', objectApiName: 'Account' },
      { phase: 'confirming', calls: 1 },
      { phase: 'rehearsing', call: 1, calls: 1 },
    ]);
  });

  it('answers a rehearsal that failed with its error', async () => {
    rehearser.rehearse.mockRejectedValueOnce(new Error('composite refused'));
    await rehearse();
    expect(posted('forge:rehearse:error')[0].payload).toMatchObject({
      code: 'REHEARSAL_ERROR',
      message: 'composite refused',
    });
  });

  it('refuses a payload that is no rehearsal request', async () => {
    await rehearse({ graph: GRAPH });
    expect(rehearser.rehearse).not.toHaveBeenCalled();
    expect(posted('forge:rehearse:error')).toHaveLength(1);
  });

  describe('in the audit trail', () => {
    it('records what a rehearsal judged, confirmed by the user, and no lineage', async () => {
      await rehearse();

      expect(trail()).toEqual([
        expect.objectContaining({
          action: 'forge_rehearse',
          module: 'forge',
          orgId: 'tgt-org',
          orgAlias: 'DEV',
          outcome: 'success',
          guard: 'confirmed',
          objects: [],
          details: {
            sampled: 2,
            judged: 2,
            passed: 2,
            refused: 0,
            notJudged: 0,
            updatesJudged: 0,
            updatesRefused: 0,
            updatesNotRehearsed: 0,
            calls: 1,
          },
        }),
      ]);
      expect(trail()[0]).not.toHaveProperty('sourceOrgId');
    });

    it('records a rehearsal declined at its confirmation as stopped, the user having declined', async () => {
      answers = [false];
      await rehearse();

      expect(trail()).toEqual([
        expect.objectContaining({
          action: 'forge_rehearse',
          outcome: 'stopped',
          guard: 'declined',
          details: { code: 'REHEARSAL_DECLINED' },
        }),
      ]);
    });

    it('records a rehearsal that failed as a failure', async () => {
      rehearser.rehearse.mockRejectedValueOnce(new Error('composite refused'));
      await rehearse();

      expect(trail()).toEqual([
        expect.objectContaining({ action: 'forge_rehearse', outcome: 'failure', objects: [] }),
      ]);
    });

    it('records a call that was not rolled back with the records it left, by object and never by id', async () => {
      rehearser.rehearse.mockRejectedValueOnce(
        new RehearsalNotRolledBackError(
          ['003000000000001AAA', '003000000000002AAA', '001000000000003AAA'],
          [
            { objectApiName: 'Contact', created: 2 },
            { objectApiName: 'Account', created: 1 },
          ],
        ),
      );
      await rehearse();

      const [entry] = trail();
      expect(entry).toMatchObject({
        action: 'forge_rehearse',
        outcome: 'failure',
        details: { code: 'REHEARSAL_NOT_ROLLED_BACK', recordsLeft: 3 },
        objects: [
          { objectApiName: 'Contact', created: 2, updated: 0, deleted: 0, failed: 0 },
          { objectApiName: 'Account', created: 1, updated: 0, deleted: 0, failed: 0 },
        ],
      });
      expect(JSON.stringify(entry)).not.toContain('003000000000001AAA');
    });

    it('records a rehearsal refused against a production org, under the request', async () => {
      orgType = 'Production';
      await rehearse();

      expect(trail()).toEqual([
        expect.objectContaining({
          action: 'forge_rehearse',
          operationId: 'wv-rehearse',
          outcome: 'stopped',
          details: { code: 'PRODUCTION_TARGET' },
        }),
      ]);
    });
  });

  describe('in Live Operations', () => {
    it('lists a rehearsal while it runs, call by call, under the id its Cancel reaches, then completes it', async () => {
      let listed: LiveOperation[] = [];
      let running: string[] = [];
      rehearser.rehearse.mockImplementationOnce(
        async (_graph: ForgeGraph, _config: ForgeConfig, options: RehearseOptions) => {
          await options.confirm({
            rows: 2,
            sampled: 2,
            calls: 2,
            maxCalls: 10,
            updates: [],
            objects: [],
          });
          options.onProgress?.({ phase: 'rehearsing', call: 2, calls: 2 });
          listed = tracker.getAll().map((op) => ({ ...op }));
          running = registry.getRunning().map((op) => op.operationId);
          return VERDICTS;
        },
      );

      await rehearse();

      expect(listed).toEqual([
        expect.objectContaining({
          module: 'forge',
          status: 'running',
          percentage: 50,
          processedRecords: 1,
          totalRecords: 2,
        }),
      ]);
      expect(running).toEqual([listed[0].operationId]);
      expect(tracker.get(listed[0].operationId)?.status).toBe('completed');
    });

    it('marks a failed rehearsal failed', async () => {
      rehearser.rehearse.mockRejectedValueOnce(new Error('composite refused'));
      await rehearse();

      expect(tracker.getAll()).toEqual([
        expect.objectContaining({ status: 'failed', error: 'composite refused' }),
      ]);
    });

    it('stops the rehearsal its Cancel reaches, and records it stopped with the calls it made', async () => {
      rehearser.rehearse.mockImplementationOnce(
        async (_graph: ForgeGraph, _config: ForgeConfig, options: RehearseOptions) => {
          await options.confirm({
            rows: 2,
            sampled: 2,
            calls: 3,
            maxCalls: 15,
            updates: [],
            objects: [],
          });
          options.onProgress?.({ phase: 'rehearsing', call: 1, calls: 3 });
          // Live Operations' Cancel: the registry aborts what the run registered.
          registry.abort(registry.getRunning()[0].operationId);
          if (options.signal?.aborted) throw new RehearsalCancelledError(1);
          return VERDICTS;
        },
      );

      await rehearse();

      expect(posted('forge:rehearse:error')[0].payload).toMatchObject({
        code: 'REHEARSAL_CANCELLED',
      });
      expect(tracker.getAll()).toEqual([expect.objectContaining({ status: 'cancelled' })]);
      expect(trail()).toEqual([
        expect.objectContaining({
          action: 'forge_rehearse',
          outcome: 'stopped',
          guard: 'confirmed',
          details: { calls: 1, code: 'REHEARSAL_CANCELLED' },
        }),
      ]);
    });
  });

  it('says so when no rehearsal is wired', async () => {
    const bare = new ForgeHandler(deps);
    await bare.handle(
      inboundRequest({
        id: 'wv-rehearse',
        type: 'forge:rehearse:request',
        timestamp: Date.now(),
        payload: { graph: GRAPH, config: CONFIG },
      } as BaseMessage),
    );
    expect(posted('forge:rehearse:error')[0].payload).toMatchObject({ code: 'NOT_INITIALIZED' });
  });
});
