import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForgeHandler } from './ForgeHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type {
  BaseMessage,
  ForgeConfig,
  ForgeExecutionResult,
  ForgeGraph,
  ForgeGraphNode,
  ForgeTargetAutomation,
  RunCheckpointEstimate,
} from '@sandforge/shared';
import { ForgeOrchestrator } from '../../modules/forge/ForgeOrchestrator.js';
import type { ForgeOrchestratorDeps } from '../../modules/forge/ForgeOrchestrator.js';
import type {
  ExecuteOptions,
  ExecutionSummary,
  ForgeWriteBoundary,
  WholeOrgBoundary,
} from '../../modules/forge/ForgeExecutor.js';
import {
  WHOLE_ORG_SOURCE_READS_PER_OBJECT,
  type WholeOrgDryRun,
} from '../../modules/forge/ForgeRunGate.js';
import type { TargetAutomationReader } from '../../modules/forge/TargetAutomationReader.js';
import type { ForgeRehearser } from '../../modules/forge/rehearsal/ForgeRehearser.js';
import { ForgeRunJournal } from '../../modules/forge/ForgeRunJournal.js';
import { ForgeAbortedError } from '../../modules/forge/ForgeExecutor.js';
import { keepPartialSummary } from '../../modules/forge/interruptedRun.js';
import { LostBulkJobs } from '../../modules/forge/lostBulkJobs.js';
import { muteOrgOf } from '../../modules/forge/AutomationMuteLease.js';
import type { BeforeRunCheckpoints } from '../../modules/checkpoint/beforeRunCheckpoint.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import type { RunConfirmation, WriteConfirmation } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { memoryPermissionOrg } from '../../test/memoryPermissionOrg.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));
vi.mock('../../core/common/sforceLimitParser.js', () => ({
  checkApiLimits: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

const mockGetConn = vi.mocked(getJsforceConnection);

/*
 * The clone of a whole org, from the panel's message to the executor and
 * back: what it is asked, what refuses it before anything is written, its
 * dry run, which stops at its gate, the Bulk API jobs it lost waited for
 * before its mute goes back, and what its history keeps. The executor is a
 * fake that hands its gate what the real one measures and writes nothing of
 * its own; the orchestrator between them is the real one, which tells the
 * executor how a whole org is read and written.
 */

const MB = 1024 * 1024;

function node(objectApiName: string, level: number, over: Partial<ForgeGraphNode> = {}) {
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
    createableFieldCount: 4,
    estimatedSizeMB: 0,
    estimatedApiCalls: 0,
    batchStrategy: 'auto',
    ...over,
  } satisfies ForgeGraphNode;
}

/** A whole org as discovery answers it: four objects, one of a package, two left out. */
function wholeOrgGraph(): ForgeGraph {
  return {
    nodes: [
      node('Account', 0, { recordCount: 500 }),
      node('Contact', 1, { recordCount: 300, piiFields: ['Email', 'Phone', 'Birthdate'] }),
      node('Big__c', 2, { recordCount: 12_000 }),
      node('ns__Widget__c', 2, { recordCount: 30 }),
    ],
    edges: [
      {
        sourceObject: 'Contact',
        targetObject: 'Account',
        relationshipName: 'AccountId',
        type: 'lookup',
      },
    ],
    totalRecords: 12_830,
    estimatedSizeMB: 25,
    estimatedDurationSeconds: 60,
    leftOut: [
      { objectApiName: 'AccountHistory', reason: 'history' },
      { objectApiName: 'Empty__c', reason: 'empty' },
    ],
  };
}

const WHOLE_ORG: ForgeConfig = {
  inputMode: 'org',
  depth: 'all',
  sourceOrgId: 'src-org',
  targetOrgId: 'tgt-org',
  anonymizePII: false,
  skipEmpty: true,
  batchSize: 'auto',
};

/** What the executor measured of both orgs before its gate. */
function measuresOf(over: Partial<WholeOrgBoundary> = {}): WholeOrgBoundary {
  return {
    writes: [
      { objectApiName: 'Big__c', rows: 12_000, jobs: 2, jobRows: 12_000, restRows: 0 },
      { objectApiName: 'Account', rows: 500, jobs: 0, jobRows: 0, restRows: 500 },
      { objectApiName: 'Contact', rows: 300, jobs: 0, jobRows: 0, restRows: 300 },
      { objectApiName: 'ns__Widget__c', rows: 30, jobs: 0, jobRows: 0, restRows: 30 },
    ],
    sourceReads: 12,
    // The target said no duplicate rule watches any of them.
    restOnly: new Set<string>(),
    contactPointsBlanked: 4,
    ...over,
  };
}

/** What the run hands its gate: every object counted, none read yet, and its measures. */
function boundaryOf(measures: WholeOrgBoundary = measuresOf()): ForgeWriteBoundary {
  return {
    objects: [
      { objectApiName: 'Big__c', rows: [], counted: { rows: 12_000 } },
      { objectApiName: 'Account', rows: [], counted: { rows: 500 } },
      { objectApiName: 'Contact', rows: [], counted: { rows: 300 } },
      { objectApiName: 'ns__Widget__c', rows: [], counted: { rows: 30 } },
    ],
    wholeOrg: measures,
    dryRun: false,
  };
}

function summary(over: Partial<ExecutionSummary> = {}): ExecutionSummary {
  return {
    successCount: 12_830,
    updatedCount: 0,
    linkedCount: 0,
    wouldInsertCount: 0,
    failedCount: 0,
    skippedCount: 0,
    remapCount: 12_830,
    errors: [],
    truncatedObjects: [],
    remapTable: {},
    existingRecords: [],
    existingSourceIds: [],
    updatedSourceIds: [],
    remapByObject: [],
    createdByObject: [],
    readByObject: [],
    failedReads: [],
    remapInJournal: true,
    ...over,
  };
}

/** What the target runs on the contacts: a flow its bypass keeps quiet, and a trigger. */
const MUTABLE: ForgeTargetAutomation = {
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
          permissions: [{ name: 'Load_Data', bypass: true }],
        },
      ],
      triggers: [{ name: 'ContactTrigger', events: ['beforeInsert'] }],
    },
  ],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 3,
  bypassGrants: [
    {
      permission: 'Load_Data',
      permissionSets: [{ name: 'Data_Load', label: 'Data load', grants: 1 }],
    },
  ],
};

/** A target that runs nothing on the run's objects, all of it read. */
const QUIET: ForgeTargetAutomation = { ...MUTABLE, objects: [], bypassGrants: [] };

function readerOf(automation: ForgeTargetAutomation): TargetAutomationReader {
  return { readForGraph: vi.fn(async () => automation) } as unknown as TargetAutomationReader;
}

/**
 * A disk in memory, keyed as the platform writes paths: the journal joins its
 * paths with the platform's separator, and a test names a file with forward
 * slashes. Both reach the same entry.
 */
class PathMap extends Map<string, string> {
  override get(key: string): string | undefined {
    return super.get(path.normalize(key));
  }
  override set(key: string, value: string): this {
    return super.set(path.normalize(key), value);
  }
  override has(key: string): boolean {
    return super.has(path.normalize(key));
  }
  override delete(key: string): boolean {
    return super.delete(path.normalize(key));
  }
}

/** A disk in memory under a real journal: each file's text, by its path. */
function journalOnMemory() {
  const files = new PathMap();
  const journal = new ForgeRunJournal({
    storagePath: '/storage',
    appendFile: async (filePath, content) => {
      files.set(filePath, (files.get(filePath) ?? '') + content);
    },
    readLines: (filePath) =>
      (async function* lines(): AsyncGenerator<string> {
        for (const line of (files.get(filePath) ?? '').split('\n')) yield line;
      })(),
    mkdir: async () => {},
    rm: async (filePath) => void files.delete(filePath),
    listFiles: async (dirPath) =>
      [...files.keys()]
        .filter((filePath) => path.dirname(filePath) === path.normalize(dirPath))
        .map((filePath) => path.basename(filePath)),
    openRunFile: (filePath) => ({
      size: () => Buffer.byteLength(files.get(filePath) ?? ''),
      append: (text) => void files.set(filePath, (files.get(filePath) ?? '') + text),
      read: (offset, length) =>
        Buffer.from(files.get(filePath) ?? '').subarray(offset, offset + length),
      close: () => {},
    }),
  });
  return { journal, files };
}

describe('forge:execute of the whole org', () => {
  let handler: ForgeHandler;
  let deps: HandlerDeps;
  let store: ConfigStore;
  let questions: RunConfirmation[];
  let answers: boolean[];
  /** What happened, in order: questions asked, limits read, writes, jobs read, assignments. */
  let calls: string[];
  /** What each org's `/limits` answer, by org; an error refuses the request. */
  let limits: Record<string, unknown>;
  let settings: Record<string, unknown>;
  /** The options the executor was handed, run by run. */
  let handed: Array<ExecuteOptions | undefined>;
  let disk: ReturnType<typeof journalOnMemory>;

  beforeEach(() => {
    mockGetConn.mockReset();
    questions = [];
    answers = [];
    calls = [];
    handed = [];
    settings = {};
    limits = {
      'tgt-org': {
        DataStorageMB: { Max: 2_000, Remaining: 1_500 },
        DailyApiRequests: { Max: 100_000, Remaining: 90_000 },
        DailyBulkApiBatches: { Max: 15_000, Remaining: 14_000 },
        FileStorageMB: { Max: 2_000, Remaining: 1_900 },
      },
      'src-org': {
        DataStorageMB: { Max: 2_000, Remaining: 1_000 },
        DailyApiRequests: { Max: 100_000, Remaining: 80_000 },
      },
    };
    store = new ConfigStore(new InMemoryConfigStoreBackend());
    store.initialize();
    let n = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn((id: string) => ({
          orgType: 'Sandbox',
          alias: id === 'tgt-org' ? 'DEV' : 'SRC',
        })),
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
          requestRunConfirmation: async (question) => {
            calls.push(`asked ${question.stage}`);
            questions.push(question);
            return answers.shift() ?? true;
          },
        }),
      } as unknown as HandlerDeps['infraServices'],
      nextId: () => String(++n),
    };
    // Both orgs answer their limits, and no record type; any other request
    // fails: a fake org that refuses whatever the run did not ask of it.
    mockGetConn.mockImplementation(async (orgId: string) => {
      return {
        query: vi.fn().mockResolvedValue({ records: [], done: true, totalSize: 0 }),
        queryMore: vi.fn(),
        request: vi.fn(async ({ method, url }: { method: string; url: string }) => {
          if (method !== 'GET' || url !== '/limits') throw new Error(`unexpected ${url}`);
          calls.push(`limits ${orgId}`);
          const answer = limits[orgId];
          if (answer instanceof Error) throw answer;
          return answer;
        }),
      } as never;
    });
    disk = journalOnMemory();
    handler = new ForgeHandler(deps);
  });

  /**
   * The real orchestrator over a fake executor that hands `boundary` to the
   * gate, then "writes" — `whileWriting` stands for what it does then — and
   * gives the lease the gate took back once its last write is through, as
   * the executor does.
   */
  function orchestratorHanding(
    boundary: ForgeWriteBoundary = boundaryOf(),
    whileWriting?: () => void,
  ): ForgeOrchestrator {
    const executor = {
      execute: vi.fn(
        async (
          _graph: ForgeGraph,
          _source: string,
          _target: string,
          _onProgress: unknown,
          options?: ExecuteOptions,
        ): Promise<ExecutionSummary> => {
          handed.push(options);
          const answer = await options?.beforeWrite?.({
            ...boundary,
            dryRun: options.dryRun === true,
          });
          whileWriting?.();
          calls.push('written');
          if (answer && answer.lease) await answer.lease.giveBack();
          return summary();
        },
      ),
      abort: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    };
    return new ForgeOrchestrator({
      discoveryService: {
        personalFields: () => [],
      } as unknown as ForgeOrchestratorDeps['discoveryService'],
      executor: executor as unknown as ForgeOrchestratorDeps['executor'],
    });
  }

  function use(
    orchestrator: ForgeOrchestrator,
    services: Parameters<ForgeHandler['setForgeOrchestrator']>[1] = {},
  ): void {
    handler.setForgeOrchestrator(orchestrator, {
      targetAutomation: readerOf(QUIET),
      runJournal: disk.journal,
      ...services,
    });
  }

  function execute(payload: Record<string, unknown> = {}): Promise<boolean> {
    return handler.handle(
      inboundRequest({
        id: 'wv-execute',
        type: 'forge:execute',
        timestamp: Date.now(),
        payload: { graph: wholeOrgGraph(), config: WHOLE_ORG, ...payload },
      } as BaseMessage),
    );
  }

  function posted(type: string): Array<BaseMessage & { payload: Record<string, unknown> }> {
    return vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
      .filter((m) => m.type === type);
  }

  const writeQuestions = (): WriteConfirmation[] =>
    questions.filter((q): q is WriteConfirmation => q.stage === 'write');
  const runs = () =>
    new AuditTrailStore(store).list().entries.filter((e) => e.action === 'forge_execute');

  /** Stopped before anything was written, under `code`: the error, no write, nothing kept. */
  function expectRefused(code: string): Record<string, unknown> {
    expect(calls).not.toContain('written');
    const errors = posted('forge:execute:error');
    expect(errors).toHaveLength(1);
    expect(errors[0].payload.code).toBe(code);
    expect(posted('forge:execute:response')).toEqual([]);
    expect(store.get('forge:history') ?? []).toEqual([]);
    return errors[0].payload;
  }

  describe('a run', () => {
    it('is always asked, whatever the setting, with what else it takes and does', async () => {
      settings['safety.confirmAboveRecords'] = 0;
      use(orchestratorHanding());

      await execute();

      expect(writeQuestions()).toHaveLength(1);
      const [question] = writeQuestions();
      expect(question).toMatchObject({ org: 'DEV', total: 12_830, counted: true });
      // The target's requests are said among its own lines, near or not.
      expect(question).not.toHaveProperty('apiRequests');
      expect(question.wholeOrg).toMatchObject({
        source: 'SRC',
        leftOut: 2,
        targetApi: { remaining: 90_000, max: 100_000 },
        // The 12 reads the run counted, and what it reads besides of each of
        // the four objects.
        sourceApi: {
          estimate: 12 + 4 * WHOLE_ORG_SOURCE_READS_PER_OBJECT,
          remaining: 80_000,
          max: 100_000,
        },
        bulk: {
          jobs: 2,
          jobRows: 12_000,
          restRows: 830,
          batches: { estimate: 2, remaining: 14_000, max: 15_000 },
        },
        restObjects: ['Account', 'Contact', 'ns__Widget__c'],
        // Their package's own triggers and flows run whatever the mute keeps quiet.
        managedPackages: ['ns__Widget__c'],
        contactPointsBlanked: 4,
        personalAsIs: [{ objectApiName: 'Contact', fields: ['Email', 'Phone', 'Birthdate'] }],
      });
      expect(question.wholeOrg?.targetApi.estimate).toBeGreaterThan(0);
      expect(question.wholeOrg?.durationSeconds).toBeGreaterThan(0);
      // The source's limits are read for its requests, the target's once.
      expect(calls.filter((call) => call.startsWith('limits'))).toEqual([
        'limits tgt-org',
        'limits src-org',
      ]);
      expect(posted('forge:execute:response')).toHaveLength(1);
    });

    it('says the personal fields it anonymizes are not copied as they are', async () => {
      use(orchestratorHanding());
      const graph = wholeOrgGraph();
      graph.nodes[1] = { ...graph.nodes[1], anonymizeFields: ['Email', 'Phone'] };

      await execute({ graph, config: { ...WHOLE_ORG, anonymizePII: true } });

      expect(writeQuestions()[0].wholeOrg?.personalAsIs).toEqual([
        { objectApiName: 'Contact', fields: ['Birthdate'] },
      ]);
    });

    it('hands the executor a run of everything, written through the Bulk API, its ceiling bounding what it reads whole', async () => {
      settings['forge.maxRecordsPerObject'] = 80_000;
      use(orchestratorHanding());

      await execute();

      const [options] = handed;
      expect(options).toMatchObject({
        writeApi: 'auto',
        stream: {
          everything: true,
          writeWindow: 10_000,
          secondPassPageSize: 10_000,
          wholeReadBound: 80_000,
        },
      });
      expect(options?.stream?.ceiling).toBeUndefined();
      // Its journal: what it maps, owes and where it stopped live on disk.
      expect(options?.stream?.store).toBeDefined();
      expect(disk.files.size).toBeGreaterThan(0);
    });

    it('tells Production Guard every record of what it copies, whatever cap a config carried over', async () => {
      const guard = deps.infraServices?.productionGuard;
      if (!guard) throw new Error('no guard');
      const check = vi.spyOn(guard, 'check');
      use(orchestratorHanding());

      await execute({ config: { ...WHOLE_ORG, maxRecordsPerObject: 100 } });

      // Capped, the guard was told 330 records of a run that copies 12 830.
      expect(check).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'insert', recordCount: 12_830 }),
      );
    });

    it('is taken up where it stopped, as a whole org, its files copied again', async () => {
      const FILES = { maxFileSizeMB: 25, acceptedAsIs: true };
      const ACCOUNT = '001000000000001AAA';
      let stopsAfterTheAccount = true;
      let resumedAt: unknown;
      let linkedEarlier: boolean | undefined;
      const executor = {
        execute: vi.fn(
          async (
            _graph: ForgeGraph,
            _source: string,
            _target: string,
            _onProgress: unknown,
            options?: ExecuteOptions,
          ): Promise<ExecutionSummary> => {
            handed.push(options);
            const store = options?.stream?.store;
            const answer = await options?.beforeWrite?.({ ...boundaryOf(), dryRun: false });
            if (answer && answer.lease) await answer.lease.giveBack();
            if (!stopsAfterTheAccount) {
              // The part taken up holds what the first wrote, an earlier
              // part's, and where its read of the accounts stood.
              resumedAt = store?.checkpoints().get('Account');
              store?.beginPart(new Date());
              linkedEarlier = store?.mapping(ACCOUNT)?.earlier;
              calls.push('written');
              return summary();
            }
            store?.beginPart(new Date());
            store?.setMapping('created', ACCOUNT, '001000000000901AAA', 'Account');
            store?.checkpoint('Account', { lastId: ACCOUNT, read: 1 });
            const error = new ForgeAbortedError('Forge execution was aborted by user request.');
            keepPartialSummary(error, summary({ successCount: 1, remapCount: 1 }));
            throw error;
          },
        ),
        abort: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
      };
      use(
        new ForgeOrchestrator({
          discoveryService: {
            personalFields: () => [],
          } as unknown as ForgeOrchestratorDeps['discoveryService'],
          executor: executor as unknown as ForgeOrchestratorDeps['executor'],
        }),
      );
      await execute({ files: FILES });
      const stopped = posted('forge:execute:error')[0]?.payload.result as ForgeExecutionResult;
      expect(stopped).toMatchObject({ cancelled: true, resumable: true });
      stopsAfterTheAccount = false;

      await handler.handle(
        inboundRequest({
          id: 'wv-resume',
          type: 'forge:resume-run',
          timestamp: Date.now(),
          payload: { forgeId: stopped.forgeId },
        } as BaseMessage),
      );

      expect(executor.execute).toHaveBeenCalledTimes(2);
      const resumed = handed[1];
      expect(resumed).toMatchObject({
        writeApi: 'auto',
        stream: { everything: true, writeWindow: 10_000 },
        files: { maxFileBytes: 25 * MB, acceptedAsIs: true },
      });
      expect(resumedAt).toEqual({ lastId: ACCOUNT, read: 1 });
      expect(linkedEarlier).toBe(true);
      // Asked again, as every run of the whole org is.
      expect(writeQuestions()).toHaveLength(2);
      const answer = posted('forge:execute:response').find((m) => m.correlationId === 'wv-resume');
      expect(answer?.payload.result).toMatchObject({ retryOf: stopped.forgeId, resumed: true });
      const [entry] = store.get<ForgeExecutionResult[]>('forge:history') ?? [];
      expect(entry.graph.withoutEdges).toBe(true);
    });

    it('keeps in the history its nodes without their relations, and what it left out counted', async () => {
      use(orchestratorHanding());

      await execute();

      const [entry] = store.get<ForgeExecutionResult[]>('forge:history') ?? [];
      expect(entry.graph.withoutEdges).toBe(true);
      expect(entry.graph.edges).toEqual([]);
      expect(entry.graph).not.toHaveProperty('leftOut');
      expect(entry.leftOutCounts).toEqual([
        { reason: 'empty', count: 1 },
        { reason: 'history', count: 1 },
      ]);
      expect(entry.config).toMatchObject({ inputMode: 'org', depth: 'all' });
      // The page is answered with the graph whole.
      const result = posted('forge:execute:response')[0].payload.result as ForgeExecutionResult;
      expect(result.graph.edges).toHaveLength(1);
      expect(result.graph.leftOut).toHaveLength(2);
    });

    it('refuses to run the graph its history entry keeps, which a Retry of the entry sends back', async () => {
      use(orchestratorHanding());
      await execute();
      const [entry] = store.get<ForgeExecutionResult[]>('forge:history') ?? [];
      vi.mocked(deps.broker.postToWebview).mockClear();
      store.set('forge:history', [], 'forge');
      calls = [];

      await execute({ graph: entry.graph, retryOf: entry.forgeId });

      const refused = expectRefused('GRAPH_WITHOUT_EDGES');
      expect(String(refused.message)).toContain('Discover the org again');
    });
  });

  describe('refused before anything is written', () => {
    it('when started by Clone directly: Review lists what it leaves out and copies as it is', async () => {
      use(orchestratorHanding());

      await execute({ reviewSkipped: true });

      expectRefused('WHOLE_ORG_DIRECT');
      expect(handed).toEqual([]);
      expect(runs()).toEqual([
        expect.objectContaining({ outcome: 'stopped', details: { code: 'WHOLE_ORG_DIRECT' } }),
      ]);
    });

    it('when its journal cannot be kept: it keeps on disk what a whole org does not fit in memory with', async () => {
      handler.setForgeOrchestrator(orchestratorHanding(), { targetAutomation: readerOf(QUIET) });

      await execute();

      const refused = expectRefused('EXECUTE_ERROR');
      expect(String(refused.message)).toContain('keeps its journal on disk');
      expect(handed).toEqual([]);
    });

    it('for an object it reads whole past the bound of such a read, before any limit is read', async () => {
      use(
        orchestratorHanding(
          boundaryOf(
            measuresOf({
              readWholeOver: [{ objectApiName: 'Product2', rows: 90_000, bound: 50_000 }],
            }),
          ),
        ),
      );

      await execute();

      const refused = expectRefused('READ_BOUND_EXCEEDED');
      expect(refused.gate).toMatchObject({
        code: 'READ_BOUND_EXCEEDED',
        readBound: { bound: 50_000, objects: [{ objectApiName: 'Product2', rows: 90_000 }] },
      });
      expect(calls.filter((call) => call.startsWith('limits'))).toEqual([]);
      expect(questions).toEqual([]);
    });

    it('for its records past the data storage the target has left', async () => {
      limits['tgt-org'] = {
        ...(limits['tgt-org'] as object),
        DataStorageMB: { Max: 2_000, Remaining: 1 },
      };
      use(orchestratorHanding());

      await execute();

      expect(expectRefused('STORAGE_EXCEEDED').gate).toMatchObject({ code: 'STORAGE_EXCEEDED' });
    });

    it('for its files past the file storage the target has left, from the same answer', async () => {
      limits['tgt-org'] = {
        ...(limits['tgt-org'] as object),
        FileStorageMB: { Max: 2_000, Remaining: 10 },
      };
      use(
        orchestratorHanding(
          boundaryOf(measuresOf({ files: { count: 40, bytes: 300 * MB, overCeiling: 0 } })),
        ),
      );

      await execute({ files: { maxFileSizeMB: 25, acceptedAsIs: true } });

      expect(expectRefused('STORAGE_EXCEEDED').gate).toMatchObject({
        storage: { kind: 'files', remainingMB: 10 },
      });
    });

    it('for files the source would neither sum nor list, as the file copier of any run refuses them', async () => {
      use(orchestratorHanding(boundaryOf(measuresOf({ files: { unmeasured: true } }))));

      await execute({ files: { maxFileSizeMB: 25, acceptedAsIs: true } });

      const refused = expectRefused('FILES_UNREAD');
      expect(String(refused.message)).toContain('turn the copy of files off');
      // A stop of the gate, as the page reads one: it goes back to Review and
      // says it in the user's language rather than the host's English.
      expect(refused.gate).toEqual({ code: 'FILES_UNREAD' });
    });

    it('for files whose fit the target would not tell', async () => {
      // A Developer Edition's limits that list no file storage.
      limits['tgt-org'] = {
        DataStorageMB: { Max: 2_000, Remaining: 1_500 },
        DailyApiRequests: { Max: 100_000, Remaining: 90_000 },
        DailyBulkApiBatches: { Max: 15_000, Remaining: 14_000 },
      };
      use(
        orchestratorHanding(
          boundaryOf(measuresOf({ files: { count: 40, bytes: 3 * MB, overCeiling: 0 } })),
        ),
      );

      await execute({ files: { maxFileSizeMB: 25, acceptedAsIs: true } });

      expect(expectRefused('FILE_STORAGE_UNREAD').gate).toEqual({ code: 'FILE_STORAGE_UNREAD' });
    });

    it.each([
      [
        'its writes past the requests the target has left today',
        { 'tgt-org': { DailyApiRequests: { Max: 100_000, Remaining: 5 } } },
        { kind: 'requests', org: 'target' },
      ],
      [
        'its jobs past the Bulk API batches the target has left today',
        { 'tgt-org': { DailyBulkApiBatches: { Max: 15_000, Remaining: 1 } } },
        { kind: 'bulkBatches', org: 'target' },
      ],
      [
        'its reads past the requests the source has left today',
        { 'src-org': { DailyApiRequests: { Max: 100_000, Remaining: 3 } } },
        { kind: 'requests', org: 'source' },
      ],
    ])('for %s', async (_label, over, api) => {
      for (const [org, answer] of Object.entries(over)) {
        limits[org] = { ...(limits[org] as object), ...answer };
      }
      use(orchestratorHanding());

      await execute();

      expect(expectRefused('API_BUDGET_EXCEEDED').gate).toMatchObject({
        code: 'API_BUDGET_EXCEEDED',
        api,
      });
      expect(questions).toEqual([]);
    });

    it('for the checkpoint it takes first of a target with too many records', async () => {
      const refused: RunCheckpointEstimate = {
        state: 'planned',
        estimate: {
          records: 900_000,
          apiRequests: 500,
          apiRequestsLeft: 90_000,
          seconds: 600,
          bytes: 900 * MB,
        },
        objects: ['Account', 'Contact'],
        added: [],
        notHeld: [],
        keepDays: 7,
        refusal: { code: 'TOO_MANY_RECORDS', message: 'Too many records to hold.' },
      };
      handler.setBeforeRunCheckpoints({
        scope: vi.fn(async () => refused),
        take: vi.fn(),
        settle: vi.fn(),
      } as unknown as BeforeRunCheckpoints);
      use(orchestratorHanding());

      await execute({ checkpointFirst: {} });

      expect(expectRefused('CHECKPOINT_REFUSED').gate).toMatchObject({
        reason: 'TOO_MANY_RECORDS',
      });
    });

    it('a rehearsal: it holds every row it prepares', async () => {
      use(orchestratorHanding(), { rehearser: {} as ForgeRehearser });

      await handler.handle(
        inboundRequest({
          id: 'wv-rehearse',
          type: 'forge:rehearse:request',
          timestamp: Date.now(),
          payload: { graph: wholeOrgGraph(), config: WHOLE_ORG },
        } as BaseMessage),
      );

      expect(posted('forge:rehearse:error').map((m) => m.payload.code)).toEqual([
        'WHOLE_ORG_REHEARSAL',
      ]);
      expect(calls).toEqual([]);
    });
  });

  describe('its dry run', () => {
    function simulate(): Promise<boolean> {
      return execute({ config: { ...WHOLE_ORG, dryRun: true } });
    }

    it('stops at its gate once counted: what it would insert and take, read from the limits alone, nothing written', async () => {
      use(orchestratorHanding());

      await simulate();

      expect(calls).toEqual(['limits tgt-org', 'limits src-org']);
      expect(questions).toEqual([]);
      const [response] = posted('forge:execute:response');
      expect(response.payload.result).toMatchObject({
        status: 'success',
        dryRun: true,
        wouldInsertCount: 12_830,
        createdCount: 0,
      });
      const dry = response.payload.wholeOrgDryRun as WholeOrgDryRun;
      expect(dry.wouldInsert).toEqual([
        { objectApiName: 'Big__c', rows: 12_000, jobs: 2, byRest: 0 },
        { objectApiName: 'Account', rows: 500, jobs: 0, byRest: 500 },
        { objectApiName: 'Contact', rows: 300, jobs: 0, byRest: 300 },
        { objectApiName: 'ns__Widget__c', rows: 30, jobs: 0, byRest: 30 },
      ]);
      expect(dry.leftOut.counts).toEqual([
        { reason: 'empty', count: 1 },
        { reason: 'history', count: 1 },
      ]);
      expect(dry.personalAsIs).toEqual([
        { objectApiName: 'Contact', fields: ['Email', 'Phone', 'Birthdate'] },
      ]);
      expect(dry.wouldBeRefused).toEqual([]);
      // No journal, no audit entry, no history: it wrote nothing.
      expect(disk.files.size).toBe(0);
      expect(runs()).toEqual([]);
      expect(store.get('forge:history') ?? []).toEqual([]);
    });

    it('prices the target’s requests as its run’s gate does: the read-backs its counts say, and the read of the deliverability it did not make, at the most', async () => {
      use(orchestratorHanding({ ...boundaryOf(), readBack: 3 }));

      await simulate();

      const [response] = posted('forge:execute:response');
      const dry = response.payload.wholeOrgDryRun as WholeOrgDryRun;
      // Told neither, its estimate stood under what the run's gate holds it to.
      expect(dry.targetRequests.parts).toMatchObject({ readBack: 3, deliverability: 2 });
      expect(calls).toEqual(['limits tgt-org', 'limits src-org']);
    });

    it('ends as a failure when its run would be refused, naming every refusal', async () => {
      limits['src-org'] = { DailyApiRequests: { Max: 100_000, Remaining: 3 } };
      limits['tgt-org'] = {
        ...(limits['tgt-org'] as object),
        DailyBulkApiBatches: { Max: 15_000, Remaining: 1 },
      };
      use(orchestratorHanding());

      await simulate();

      expect(calls).not.toContain('written');
      const [response] = posted('forge:execute:response');
      expect(response.payload.result).toMatchObject({ status: 'failure', dryRun: true });
      const dry = response.payload.wholeOrgDryRun as WholeOrgDryRun;
      expect(dry.wouldBeRefused.map((stop) => [stop.code, stop.api?.kind, stop.api?.org])).toEqual([
        ['API_BUDGET_EXCEEDED', 'bulkBatches', 'target'],
        ['API_BUDGET_EXCEEDED', 'requests', 'source'],
      ]);
    });

    it('is what the run of its case is measured against', async () => {
      use(orchestratorHanding());

      await simulate();
      await execute();

      expect(writeQuestions()[0].simulated).toMatchObject({ total: 12_830 });
    });
  });

  describe('the Bulk API jobs it lost, with the target’s automation muted', () => {
    const SET = '0PSxx0000000001AAA';
    const JOB = '750xx0000000001AAA';

    function muting(lost: LostBulkJobs) {
      const dir = mkdtempSync(path.join(tmpdir(), 'forge-whole-mute-'));
      const org = memoryPermissionOrg({
        sets: [{ id: SET, name: 'Data_Load' }],
        beforeWrite: (write) => {
          calls.push(`assignment ${write.kind}`);
        },
      });
      // The run closes a job and cannot read it back as it writes.
      use(
        orchestratorHanding(boundaryOf(), () =>
          lost.note({ orgId: 'tgt-org', objectApiName: 'Big__c', jobId: JOB }),
        ),
        {
          targetAutomation: readerOf(MUTABLE),
          muteOrg: async () => muteOrgOf(org.connection),
          muteLeases: { dir, renewEveryMs: 0 },
          lostBulkJobs: lost,
        },
      );
      return () => rmSync(dir, { recursive: true, force: true });
    }

    it('waits for each to end before the mute goes back', async () => {
      const states = ['InProgress', 'JobComplete'];
      const lost = new LostBulkJobs(
        async (_orgId, jobId) => {
          calls.push(`job read ${jobId}`);
          return states.shift() ?? 'JobComplete';
        },
        { sleep: async () => {} },
      );
      const done = muting(lost);

      await execute({ muteAutomation: true });

      expect(calls.slice(calls.indexOf('written'))).toEqual([
        'written',
        `job read ${JOB}`,
        `job read ${JOB}`,
        'assignment delete',
      ]);
      const result = posted('forge:execute:response')[0].payload.result as ForgeExecutionResult;
      expect(result).not.toHaveProperty('bulkJobsPastMute');
      expect(result.mutedAutomation).toMatchObject({ released: true });
      done();
    });

    it('names in its result and its notes a job still running past the bound of the wait', async () => {
      let at = 0;
      const lost = new LostBulkJobs(
        async (_orgId, jobId) => {
          calls.push(`job read ${jobId}`);
          return 'InProgress';
        },
        {
          waitMs: 30_000,
          now: () => at,
          sleep: async (ms) => {
            at += ms;
          },
        },
      );
      const done = muting(lost);

      await execute({ muteAutomation: true });

      const result = posted('forge:execute:response')[0].payload.result as ForgeExecutionResult;
      expect(result.bulkJobsPastMute).toEqual([{ objectApiName: 'Big__c', jobId: JOB }]);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ objectApiName: 'Big__c', stage: 'scope', failedCount: 0 }),
      );
      // Given back all the same, once the wait was over.
      expect(calls.at(-1)).toBe('assignment delete');
      expect(calls.filter((call) => call.startsWith('job read')).length).toBeGreaterThan(0);
      done();
    });
  });
});
