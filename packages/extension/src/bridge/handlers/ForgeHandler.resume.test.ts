import path from 'node:path';
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
} from '@sandforge/shared';
import type { ForgeOrchestrator } from '../../modules/forge/ForgeOrchestrator.js';
import { ForgeAbortedError } from '../../modules/forge/ForgeExecutor.js';
import type { ExecuteOptions, ExecutionSummary } from '../../modules/forge/ForgeExecutor.js';
import { ForgeRunJournal } from '../../modules/forge/ForgeRunJournal.js';
import { keepPartialSummary } from '../../modules/forge/interruptedRun.js';
import type { TargetAutomationReader } from '../../modules/forge/TargetAutomationReader.js';
import { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { inboundRequest } from '../../test/mockFactories.js';

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

/*
 * A run that stops part way — a cancel, a failure, a window closed under
 * it — is kept with its journal, which says how it was set up,
 * what it wrote and where it stood: the run is offered to be taken up where
 * it stopped, from Forge's history, its results and Live Operations, and is
 * refused when the org it wrote to or its setup is no longer what it was.
 */

const CONTACT = '003000000000001AAA';
const NEW_CONTACT = '003000000000901AAA';
const TARGET_ORG = '00D000000000001AAA';
const REFRESHED_ORG = '00D000000000002AAA';

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
  inputMode: 'soql',
  soqlQuery: 'SELECT Id FROM Contact',
  depth: 'direct',
  sourceOrgId: 'src-org',
  targetOrgId: 'tgt-org',
  anonymizePII: false,
  skipEmpty: false,
  batchSize: 'auto',
};

const QUIET: ForgeTargetAutomation = {
  objectsRead: ['Account', 'Contact'],
  objects: [],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 3,
};

const reader = { readForGraph: vi.fn(async () => QUIET) } as unknown as TargetAutomationReader;

/** What the executor kept of a run that stopped once it had created the one contact. */
function stoppedSummary(): ExecutionSummary {
  return {
    successCount: 1,
    updatedCount: 0,
    linkedCount: 0,
    wouldInsertCount: 0,
    failedCount: 0,
    skippedCount: 0,
    remapCount: 1,
    errors: [],
    truncatedObjects: [],
    remapTable: { [CONTACT]: NEW_CONTACT },
    existingRecords: [],
    existingSourceIds: [],
    updatedSourceIds: [],
    remapByObject: [{ objectApiName: 'Contact', created: 1, linked: 0 }],
    createdByObject: [{ objectApiName: 'Contact', sourceIds: [CONTACT] }],
    readByObject: [{ objectApiName: 'Contact', read: 5 }],
    failedReads: [],
  };
}

const DONE: ForgeExecutionResult = {
  forgeId: 'forge-done',
  status: 'success',
  graph: GRAPH,
  duration: 10,
  timestamp: '2026-10-14T00:00:00.000Z',
  idRemapCount: 2,
  createdCount: 1,
};

/**
 * A disk in memory, keyed as the platform writes paths: the journal joins its
 * paths with the platform's separator (a backslash on Windows), and a test
 * names a file with forward slashes. Both reach the same entry.
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
function journalOnMemory(files: Map<string, string>): ForgeRunJournal {
  return new ForgeRunJournal({
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
}

type Execute = (
  graph: ForgeGraph,
  config: ForgeConfig,
  options?: Pick<ExecuteOptions, 'beforeWrite' | 'stream' | 'writtenBefore'>,
) => Promise<ForgeExecutionResult>;

describe('a run taken up where it stopped', () => {
  let deps: HandlerDeps;
  let configStore: ConfigStore;
  let settings: Record<string, unknown>;
  let files: Map<string, string>;
  let tracker: LiveOperationTracker;
  /** The org the registry holds as the target, as Salesforce knows it; none once it is gone. */
  let targetOrg: string | undefined;

  beforeEach(() => {
    settings = {};
    files = new PathMap();
    targetOrg = TARGET_ORG;
    tracker = new LiveOperationTracker();
    configStore = new ConfigStore(new InMemoryConfigStoreBackend());
    configStore.initialize();
    let n = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn((id: string) =>
          id === 'tgt-org'
            ? targetOrg && { orgType: 'Sandbox', alias: 'DEV', orgId: targetOrg }
            : { orgType: 'Sandbox', alias: 'UAT', orgId: '00D000000000009AAA' },
        ),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as HandlerDeps['orgRegistry'],
      configStore,
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      services: {
        getSandforgeSetting: <T>(key: string, fallback: T): T =>
          (key in settings ? settings[key] : fallback) as T,
      } as unknown as HandlerDeps['services'],
      infraServices: {
        productionGuard: new ProductionGuard({ requestRunConfirmation: async () => true }),
      } as unknown as HandlerDeps['infraServices'],
      nextId: () => String(++n),
    };
    vi.mocked(getJsforceConnection).mockImplementation(
      async () =>
        ({
          query: vi.fn().mockResolvedValue({ records: [], done: true, totalSize: 0 }),
          queryMore: vi.fn(),
          request: vi.fn(async () => ({ DataStorageMB: { Max: 200, Remaining: 150 } })),
        }) as never,
    );
  });

  /** A handler of a window, whose orchestrator runs `execute`. */
  function windowRunning(execute: Execute): {
    handler: ForgeHandler;
    execute: ReturnType<typeof vi.fn>;
  } {
    const handler = new ForgeHandler(deps);
    const run = vi.fn(execute);
    handler.setForgeOrchestrator(
      {
        execute: run,
        on: vi.fn().mockReturnValue(vi.fn()),
        abort: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
        clearDiscoveryCache: vi.fn(),
      } as unknown as ForgeOrchestrator,
      { targetAutomation: reader, runJournal: journalOnMemory(files) },
    );
    handler.setLiveOperationTracker(tracker);
    return { handler, execute: run };
  }

  /** A run that writes the one contact through its journal, then is cancelled. */
  const cancelledAfterOne: Execute = async (_graph, _config, options) => {
    const store = options?.stream?.store;
    store?.beginPart(new Date());
    store?.setMapping('created', CONTACT, NEW_CONTACT, 'Contact');
    store?.checkpoint('Contact', { lastId: CONTACT, read: 5 });
    const error = new ForgeAbortedError('Forge execution was aborted by user request.');
    keepPartialSummary(error, stoppedSummary());
    throw error;
  };

  function send(
    handler: ForgeHandler,
    id: string,
    type: string,
    payload: unknown,
  ): Promise<boolean> {
    return handler.handle(
      inboundRequest({ id, type, timestamp: Date.now(), payload } as BaseMessage),
    );
  }

  function posted(type: string): Array<BaseMessage & { payload: Record<string, unknown> }> {
    return vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
      .filter((m) => m.type === type);
  }

  async function history(handler: ForgeHandler): Promise<ForgeExecutionResult[]> {
    await send(
      handler,
      `wv-history-${posted('forge:history:list:response').length}`,
      'forge:history:list',
      {},
    );
    return posted('forge:history:list:response').at(-1)?.payload.history as ForgeExecutionResult[];
  }

  /** The run cancelled after its first contact, kept with its journal. */
  async function cancelledRun(): Promise<{ handler: ForgeHandler; stopped: ForgeExecutionResult }> {
    const { handler } = windowRunning(cancelledAfterOne);
    await send(handler, 'wv-execute', 'forge:execute', { graph: GRAPH, config: CONFIG });
    const stopped = posted('forge:execute:error')[0]?.payload.result as ForgeExecutionResult;
    return { handler, stopped };
  }

  function refusal(id: string): Record<string, unknown> | undefined {
    return posted('forge:execute:error').find((m) => m.correlationId === id)?.payload;
  }

  it('keeps a run a cancel stopped with its journal, and offers it to be taken up wherever it is shown', async () => {
    const { handler, stopped } = await cancelledRun();

    expect(stopped).toMatchObject({ cancelled: true, resumable: true });
    expect(stopped.journalId).toMatch(/^forge-run-/);
    // Listed in the history, it says so; the stored entry never does.
    const listed = await history(handler);
    expect(listed[0]).toMatchObject({ forgeId: stopped.forgeId, resumable: true });
    expect(
      configStore.get<ForgeExecutionResult[]>('forge:history')?.[0]?.resumable,
    ).toBeUndefined();
    // Live Operations offers it while it lists the run.
    expect(tracker.getAll()).toEqual([
      expect.objectContaining({ status: 'cancelled', resumeRun: stopped.forgeId }),
    ]);
  });

  it('takes the run up from its journal: as it was set up, what it wrote found and linked to', async () => {
    const { stopped } = await cancelledRun();
    const { handler, execute } = windowRunning(async (_graph, _config, options) => {
      const store = options?.stream?.store;
      // What the first part wrote is there, an earlier part's, and where it stood.
      expect(store?.mapping(CONTACT)).toMatchObject({ targetId: NEW_CONTACT });
      expect(store?.checkpoints().get('Contact')).toEqual({ lastId: CONTACT, read: 5 });
      store?.beginPart(new Date());
      expect(store?.mapping(CONTACT)?.earlier).toBe(true);
      return DONE;
    });

    await send(handler, 'wv-resume', 'forge:resume-run', { forgeId: stopped.forgeId });

    expect(execute).toHaveBeenCalledTimes(1);
    const [graph, config, options] = execute.mock.calls[0] as Parameters<Execute>;
    expect(graph).toEqual(GRAPH);
    expect(config).toEqual(CONFIG);
    expect(options?.writtenBefore).toBeUndefined();
    const answer = posted('forge:execute:response').find((m) => m.correlationId === 'wv-resume');
    expect(answer?.payload.result).toMatchObject({ retryOf: stopped.forgeId, resumed: true });
    // The run ended: its journal goes, and nothing is left to take up.
    expect(files.size).toBe(0);
    expect((await history(handler)).some((entry) => entry.resumable)).toBe(false);
  });

  it('takes it up from its results page too, when the page holds the run as it was set up', async () => {
    const { stopped } = await cancelledRun();
    const { handler, execute } = windowRunning(async () => DONE);

    await send(handler, 'wv-resume', 'forge:resume-run', {
      forgeId: stopped.forgeId,
      graph: {
        ...GRAPH,
        nodes: GRAPH.nodes.map((n) => ({ ...n, status: 'done', successCount: 4 })),
      },
      config: { ...CONFIG, dryRun: false },
    });

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('offers a run a closed window stopped, from its journal, and takes it up', async () => {
    // The window closes while the run writes: its run never ends.
    const first = windowRunning(async (_graph, _config, options) => {
      const store = options?.stream?.store;
      store?.beginPart(new Date());
      store?.setMapping('created', CONTACT, NEW_CONTACT, 'Contact');
      store?.flush();
      return new Promise<ForgeExecutionResult>(() => {});
    });
    void send(first.handler, 'wv-execute', 'forge:execute', { graph: GRAPH, config: CONFIG });
    await vi.waitFor(() => expect(first.execute).toHaveBeenCalled());

    // The next window finds the journal with no end.
    const { handler, execute } = windowRunning(async () => DONE);
    const listed = await history(handler);
    expect(listed).toEqual([
      expect.objectContaining({
        status: 'partial',
        interrupted: true,
        resumable: true,
        createdCount: 1,
        idRemapTable: { [CONTACT]: NEW_CONTACT },
        targetOrgId: 'tgt-org',
      }),
    ]);

    await send(handler, 'wv-resume', 'forge:resume-run', { forgeId: listed[0].forgeId });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('refuses to take it up in an org refreshed since, or no longer registered', async () => {
    const { stopped } = await cancelledRun();
    const { handler, execute } = windowRunning(async () => DONE);

    targetOrg = REFRESHED_ORG;
    await send(handler, 'wv-refreshed', 'forge:resume-run', { forgeId: stopped.forgeId });
    targetOrg = undefined;
    await send(handler, 'wv-gone', 'forge:resume-run', { forgeId: stopped.forgeId });

    expect(execute).not.toHaveBeenCalled();
    expect(refusal('wv-refreshed')).toMatchObject({ code: 'RESUME_TARGET_CHANGED' });
    expect(refusal('wv-gone')).toMatchObject({ code: 'RESUME_TARGET_CHANGED' });
    const audited = new AuditTrailStore(configStore)
      .list()
      .entries.filter((e) => e.details?.['code'] === 'RESUME_TARGET_CHANGED');
    expect(audited.map((e) => e.outcome)).toEqual(['stopped', 'stopped']);
    // Still there to take up once the org is back.
    targetOrg = TARGET_ORG;
    expect((await history(handler))[0]?.resumable).toBe(true);
  });

  it('refuses to take it up set up otherwise: another read ceiling, or another clone on the page', async () => {
    const { stopped } = await cancelledRun();
    const { handler, execute } = windowRunning(async () => DONE);

    settings['forge.maxRecordsPerObject'] = 20_000;
    await send(handler, 'wv-ceiling', 'forge:resume-run', { forgeId: stopped.forgeId });
    delete settings['forge.maxRecordsPerObject'];
    await send(handler, 'wv-page', 'forge:resume-run', {
      forgeId: stopped.forgeId,
      graph: GRAPH,
      config: { ...CONFIG, objectSoqlFilters: { Contact: "LastName != 'x'" } },
    });

    expect(execute).not.toHaveBeenCalled();
    expect(refusal('wv-ceiling')).toMatchObject({ code: 'RESUME_CHANGED' });
    expect(refusal('wv-page')).toMatchObject({ code: 'RESUME_CHANGED' });
  });

  it('refuses a run whose records were removed, and one taken up already', async () => {
    const { stopped } = await cancelledRun();
    const kept = configStore.get<ForgeExecutionResult[]>('forge:history') ?? [];
    configStore.set(
      'forge:history',
      kept.map((entry) => ({
        ...entry,
        undo: { removedAt: '2026-10-14T01:00:00.000Z', status: 'success', deleted: 1, left: 0 },
      })),
      'forge',
    );
    const { handler, execute } = windowRunning(async () => DONE);
    await send(handler, 'wv-removed', 'forge:resume-run', { forgeId: stopped.forgeId });
    expect(refusal('wv-removed')).toMatchObject({ code: 'RESUME_UNAVAILABLE' });

    configStore.set('forge:history', kept, 'forge');
    await send(handler, 'wv-resume', 'forge:resume-run', { forgeId: stopped.forgeId });
    await send(handler, 'wv-again', 'forge:resume-run', { forgeId: stopped.forgeId });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(refusal('wv-again')).toMatchObject({ code: 'RESUME_UNAVAILABLE' });
  });

  it('keeps the journal of a clone of one record that stopped, and takes it up reading its scope again', async () => {
    const recordConfig: ForgeConfig = {
      ...CONFIG,
      inputMode: 'record',
      recordId: CONTACT,
      soqlQuery: undefined,
    };
    const first = windowRunning(cancelledAfterOne);
    await send(first.handler, 'wv-execute', 'forge:execute', {
      graph: GRAPH,
      config: recordConfig,
    });
    const stopped = posted('forge:execute:error')[0]?.payload.result as ForgeExecutionResult;
    expect(stopped).toMatchObject({ cancelled: true, resumable: true });
    expect(stopped.journalId).toMatch(/^forge-run-/);

    const { handler, execute } = windowRunning(async (_graph, _config, options) => {
      const store = options?.stream?.store;
      store?.beginPart(new Date());
      // What the first part wrote is linked to, never written again.
      expect(store?.mapping(CONTACT)).toMatchObject({ targetId: NEW_CONTACT, earlier: true });
      return DONE;
    });
    expect((await history(handler))[0]).toMatchObject({
      forgeId: stopped.forgeId,
      resumable: true,
    });
    await send(handler, 'wv-resume', 'forge:resume-run', { forgeId: stopped.forgeId });

    expect(execute).toHaveBeenCalledTimes(1);
    const [, config] = execute.mock.calls[0] as Parameters<Execute>;
    expect(config).toEqual(recordConfig);
    const answer = posted('forge:execute:response').find((m) => m.correlationId === 'wv-resume');
    expect(answer?.payload.result).toMatchObject({ retryOf: stopped.forgeId, resumed: true });
  });

  it('leaves the part it resumed the one to take up when the resumed part stops before writing', async () => {
    const { stopped } = await cancelledRun();
    const { handler } = windowRunning(async (_graph, _config, options) => {
      options?.stream?.store?.beginPart(new Date());
      const error = new ForgeAbortedError('Forge execution was aborted by user request.');
      keepPartialSummary(error, { ...stoppedSummary(), successCount: 0, createdByObject: [] });
      throw error;
    });

    await send(handler, 'wv-resume', 'forge:resume-run', { forgeId: stopped.forgeId });

    const listed = await history(handler);
    expect(listed.find((entry) => entry.forgeId === stopped.forgeId)?.resumable).toBe(true);
  });
});
