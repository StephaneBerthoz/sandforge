import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import type * as vscode from 'vscode';
import { ForgeHandler } from './ForgeHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type {
  BaseMessage,
  ForgeConfig,
  ForgeExecutionResult,
  ForgeGraph,
  ForgeGraphNode,
} from '@sandforge/shared';
import { PROTOCOL_VERSION, forgeRunCountsLeft } from '@sandforge/shared';
import type { ForgeOrchestrator } from '../../modules/forge/ForgeOrchestrator.js';
import type { DiscoveryOptions } from '../../modules/forge/GraphDiscoveryService.js';
import { ForgeAbortedError } from '../../modules/forge/ForgeExecutor.js';
import type { ExecutionSummary } from '../../modules/forge/ForgeExecutor.js';
import { keepPartialSummary } from '../../modules/forge/interruptedRun.js';
import { MAX_DISCOVERIES } from '../../modules/forge/ForgeStops.js';
import { ForgeRunJournal } from '../../modules/forge/ForgeRunJournal.js';
import { MessageBroker } from '../MessageBroker.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
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
 * What a Forge stop takes, and what a discovery answers, with two panels on
 * one handler. A stop named nothing and stopped everything — the run of one
 * panel with the discovery of another — and a newer discovery silenced every
 * other, whose page waited for an answer that never came.
 */

function node(objectApiName: string): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 2,
    fieldCount: 2,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    errors: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    createableFieldCount: 0,
    estimatedSizeMB: 0,
    estimatedApiCalls: 0,
    batchStrategy: 'auto',
  };
}

function graphOf(objectApiName: string): ForgeGraph {
  return {
    nodes: [node(objectApiName)],
    edges: [],
    totalRecords: 2,
    estimatedSizeMB: 0,
    estimatedDurationSeconds: 0,
  };
}

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

const RESULT: ForgeExecutionResult = {
  forgeId: 'forge-run-a',
  status: 'success',
  graph: graphOf('Account'),
  duration: 10,
  timestamp: '2026-10-16T00:00:00.000Z',
  idRemapCount: 2,
};

/** Two source accounts, and the copies a run created of them. */
const SOURCE_IDS = ['001000000000001AAA', '001000000000002AAA'] as const;
const TARGET_IDS = ['001000000000011AAA', '001000000000012AAA'] as const;

/** What a run held when a cancel stopped it: two accounts created. */
function cancelledAfterTwoAccounts(): ForgeAbortedError {
  const cancel = new ForgeAbortedError('Forge execution was aborted by user request.');
  const summary: ExecutionSummary = {
    successCount: 2,
    updatedCount: 0,
    linkedCount: 0,
    wouldInsertCount: 0,
    failedCount: 0,
    skippedCount: 0,
    remapCount: 2,
    errors: [],
    truncatedObjects: [],
    remapTable: { [SOURCE_IDS[0]]: TARGET_IDS[0], [SOURCE_IDS[1]]: TARGET_IDS[1] },
    existingRecords: [],
    existingSourceIds: [],
    updatedSourceIds: [],
    remapByObject: [{ objectApiName: 'Account', created: 2, linked: 0 }],
    createdByObject: [{ objectApiName: 'Account', sourceIds: [...SOURCE_IDS] }],
    readByObject: [{ objectApiName: 'Account', read: 2 }],
    failedReads: [],
  };
  keepPartialSummary(cancel, summary);
  return cancel;
}

/** A webview at the far end of the broker: it records every message it is posted. */
interface FakePanel {
  /** Every message posted to the panel, its own and every other panel's. */
  readonly posted: BaseMessage[];
  /** The requests this panel sent. */
  readonly sent: Set<string>;
}

/**
 * What a page takes of what its panel is posted: only the messages correlated
 * to a request it sent, as the discovery screen and the run's store take them.
 */
function taken(
  panel: FakePanel,
  type: string,
): Array<BaseMessage & { payload: Record<string, unknown> }> {
  return panel.posted.filter(
    (m): m is BaseMessage & { payload: Record<string, unknown> } =>
      m.type === type && typeof m.correlationId === 'string' && panel.sent.has(m.correlationId),
  );
}

describe('ForgeHandler stops and discoveries, with two panels', () => {
  let handler: ForgeHandler;
  let deps: HandlerDeps;
  let broker: MessageBroker;
  let registry: BackgroundOperationRegistry;
  let store: ConfigStore;
  let panelA: FakePanel;
  let panelB: FakePanel;
  /** Each discovery's options, in the order they were asked for. */
  let walks: DiscoveryOptions[];
  /** Settles each discovery, in the order they were asked for. */
  let answerWalk: Array<(graph: ForgeGraph) => void>;
  /** Fails each discovery, in the order they were asked for. */
  let failWalk: Array<(error: Error) => void>;
  /** Settles the run the executor holds. */
  let finishRun: (result: ForgeExecutionResult) => void;
  /** Fails the run the executor holds. */
  let stopRun: (error: Error) => void;
  /** Whether Production Guard's next question waits on a person. */
  let holdTheNextQuestion: boolean;
  /** Answers each question that waits, in order. */
  let answerQuestion: Array<(confirmed: boolean) => void>;
  let orchestrator: ForgeOrchestrator & {
    discover: ReturnType<typeof vi.fn>;
    execute: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
  };

  function panel(): FakePanel {
    const fake: FakePanel = { posted: [], sent: new Set() };
    broker.registerPanel(
      {
        webview: {
          postMessage: (message: BaseMessage) => {
            fake.posted.push(message);
            return Promise.resolve(true);
          },
          onDidReceiveMessage: () => ({ dispose: () => {} }),
        },
      } as unknown as vscode.WebviewPanel,
      { inbound: false },
    );
    return fake;
  }

  /** Send a request from `from`, as its page builds one: an id no other panel has. */
  function send(from: FakePanel, id: string, type: string, payload?: unknown): Promise<boolean> {
    from.sent.add(id);
    return handler.handle(
      inboundRequest({
        id,
        type,
        timestamp: Date.now(),
        ...(payload !== undefined ? { payload } : {}),
      } as BaseMessage),
    );
  }

  beforeEach(() => {
    broker = new MessageBroker();
    panelA = panel();
    panelB = panel();
    registry = new BackgroundOperationRegistry();
    store = new ConfigStore(new InMemoryConfigStoreBackend());
    store.initialize();
    walks = [];
    answerWalk = [];
    failWalk = [];
    finishRun = () => {};
    stopRun = () => {};
    holdTheNextQuestion = false;
    answerQuestion = [];
    let ids = 0;
    deps = {
      log: vi.fn(),
      broker,
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn(() => ({ orgType: 'Sandbox' })),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
      configStore: store,
      secretVault: {} as unknown as HandlerDeps['secretVault'],
      authProvider: {} as unknown as HandlerDeps['authProvider'],
      sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
      infraServices: {
        backgroundRegistry: registry,
        productionGuard: {
          check: vi.fn().mockReturnValue({
            allowed: true,
            requiresConfirmation: true,
            warnings: [],
            impactSummary: 'INSERT 2 Account record(s) on tgt-org [module: forge]',
          }),
          confirmIfNeeded: vi.fn(() => {
            if (!holdTheNextQuestion) return Promise.resolve(true);
            holdTheNextQuestion = false;
            return new Promise<boolean>((resolve) => answerQuestion.push(resolve));
          }),
          canAskForConfirmation: true,
          confirmRun: vi.fn().mockResolvedValue('confirmed'),
        },
      } as unknown as NonNullable<HandlerDeps['infraServices']>,
      nextId: () => `ext-${++ids}`,
    };
    handler = new ForgeHandler(deps);
    orchestrator = {
      discover: vi.fn(
        (_config: ForgeConfig, options: DiscoveryOptions) =>
          new Promise<ForgeGraph>((resolve, reject) => {
            walks.push(options);
            answerWalk.push(resolve);
            failWalk.push(reject);
          }),
      ),
      execute: vi.fn(
        () =>
          new Promise<ForgeExecutionResult>((resolve, reject) => {
            finishRun = resolve;
            stopRun = reject;
          }),
      ),
      on: vi.fn().mockReturnValue(vi.fn()),
      abort: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      clearDiscoveryCache: vi.fn(),
      readPersonalFields: vi.fn(async (graph: ForgeGraph) => graph),
    } as unknown as typeof orchestrator;
    handler.setForgeOrchestrator(orchestrator);
  });

  afterEach(() => {
    registry.dispose();
    broker.dispose();
  });

  describe('discoveries', () => {
    it('answers the discoveries of two panels, each to its own page, the first left walking', async () => {
      const first = send(panelA, 'wv-discover-a', 'forge:discover', { config: CONFIG });
      const second = send(panelB, 'wv-discover-b', 'forge:discover', { config: CONFIG });
      await vi.waitFor(() => expect(walks).toHaveLength(2));

      // The second did not stop the first, which went on walking.
      expect(walks[0].signal?.aborted).toBe(false);
      answerWalk[0](graphOf('Account'));
      answerWalk[1](graphOf('Contact'));
      await Promise.all([first, second]);

      expect(taken(panelA, 'forge:discover:response').map((m) => m.payload.graph)).toEqual([
        graphOf('Account'),
      ]);
      expect(taken(panelB, 'forge:discover:response').map((m) => m.payload.graph)).toEqual([
        graphOf('Contact'),
      ]);
      expect(taken(panelA, 'forge:discover:error')).toEqual([]);
      expect(taken(panelB, 'forge:discover:error')).toEqual([]);
    });

    it('sends the graph of a discovery to the page that asked, and to no other', async () => {
      // Broadcast, a large org's graph was copied to every open panel and the
      // sidebar, each deserializing it to find it was not theirs.
      const asking: FakePanel = { posted: [], sent: new Set(['wv-discover-c']) };
      let deliver: (raw: unknown) => void = () => undefined;
      broker.registerPanel({
        webview: {
          postMessage: (message: BaseMessage) => {
            asking.posted.push(message);
            return Promise.resolve(true);
          },
          onDidReceiveMessage: (listener: (raw: unknown) => void) => {
            deliver = listener;
            return { dispose: () => {} };
          },
        },
      } as unknown as vscode.WebviewPanel);
      broker.on('forge:discover', async (message) => {
        await handler.handle(inboundRequest(message));
      });

      deliver({
        protocolVersion: PROTOCOL_VERSION,
        payload: {
          id: 'wv-discover-c',
          type: 'forge:discover',
          timestamp: Date.now(),
          payload: { config: CONFIG },
        },
      });
      await vi.waitFor(() => expect(walks).toHaveLength(1));
      answerWalk[0](graphOf('Account'));

      await vi.waitFor(() => expect(taken(asking, 'forge:discover:response')).toHaveLength(1));
      for (const other of [panelA, panelB]) {
        expect(other.posted.filter((m) => m.type === 'forge:discover:response')).toEqual([]);
      }
    });

    it('correlates the progress of each discovery to its own request, which only its page takes', async () => {
      const first = send(panelA, 'wv-discover-a', 'forge:discover', { config: CONFIG });
      const second = send(panelB, 'wv-discover-b', 'forge:discover', { config: CONFIG });
      await vi.waitFor(() => expect(walks).toHaveLength(2));

      walks[0].onProgress?.({ phase: 'object', discoveredCount: 1, queueRemaining: 4 });
      walks[1].onProgress?.({ phase: 'object', discoveredCount: 7, queueRemaining: 9 });
      answerWalk[0](graphOf('Account'));
      answerWalk[1](graphOf('Contact'));
      await Promise.all([first, second]);

      // Both panels are posted both walks' progress; each page takes its own.
      expect(panelA.posted.filter((m) => m.type === 'forge:discover:progress')).toHaveLength(2);
      expect(
        taken(panelA, 'forge:discover:progress').map((m) => m.payload.discoveredCount),
      ).toEqual([1]);
      expect(
        taken(panelB, 'forge:discover:progress').map((m) => m.payload.discoveredCount),
      ).toEqual([7]);
    });

    it('answers a discovery superseded past the number walked at once as stopped, under its own request', async () => {
      const oldest = send(panelA, 'wv-discover-a', 'forge:discover', { config: CONFIG });
      await vi.waitFor(() => expect(walks).toHaveLength(1));
      const [supersededId] = registry.getRunning().map((o) => o.operationId);
      const newer = Array.from({ length: MAX_DISCOVERIES }, (_unused, i) =>
        send(panelB, `wv-discover-b${i}`, 'forge:discover', { config: CONFIG }),
      );
      await vi.waitFor(() => expect(walks).toHaveLength(MAX_DISCOVERIES + 1));

      expect(walks[0].signal?.aborted).toBe(true);
      expect(walks.slice(1).every((walk) => walk.signal?.aborted === false)).toBe(true);
      // The walk hands back what it had reached, which is no answer.
      answerWalk[0]({ ...graphOf('Account'), nodes: [] });
      await oldest;

      expect(taken(panelA, 'forge:discover:response')).toEqual([]);
      expect(taken(panelA, 'forge:discover:error')).toEqual([
        expect.objectContaining({
          correlationId: 'wv-discover-a',
          payload: expect.objectContaining({ code: 'DISCOVERY_SUPERSEDED', retryable: true }),
        }),
      ]);
      // Listed stopped in Live Operations, not as completed.
      expect(registry.get(supersededId)?.status).toBe('aborted');

      for (const answer of answerWalk.slice(1)) answer(graphOf('Contact'));
      await Promise.all(newer);
      expect(taken(panelB, 'forge:discover:response')).toHaveLength(MAX_DISCOVERIES);
    });

    it('answers a discovery cancelled from Live Operations as stopped, so its page stops waiting', async () => {
      const walking = send(panelA, 'wv-discover-a', 'forge:discover', { config: CONFIG });
      await vi.waitFor(() => expect(walks).toHaveLength(1));
      const [operationId] = registry.getRunning().map((o) => o.operationId);

      // What execution:abort does with the id Live Operations lists it under.
      registry.abort(operationId);
      // A walk cut short can still throw on its way out.
      failWalk[0](new Error('describeGlobal failed'));
      await walking;

      expect(taken(panelA, 'forge:discover:error')).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ code: 'DISCOVERY_STOPPED', retryable: true }),
        }),
      ]);
    });
  });

  describe('a stop that names what it stops', () => {
    it('stops the discovery it names alone, the run of another panel writing on', async () => {
      const run = send(panelA, 'wv-run-a', 'forge:execute', {
        graph: graphOf('Account'),
        config: CONFIG,
      });
      await vi.waitFor(() => expect(orchestrator.execute).toHaveBeenCalledTimes(1));
      const walking = send(panelB, 'wv-discover-b', 'forge:discover', { config: CONFIG });
      await vi.waitFor(() => expect(walks).toHaveLength(1));

      await send(panelB, 'wv-stop-b', 'forge:abort', { requestId: 'wv-discover-b' });

      expect(walks[0].signal?.aborted).toBe(true);
      expect(orchestrator.abort).not.toHaveBeenCalled();
      answerWalk[0]({ ...graphOf('Contact'), nodes: [] });
      await walking;
      finishRun(RESULT);
      await run;

      expect(taken(panelB, 'forge:discover:error')).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ code: 'DISCOVERY_STOPPED' }),
        }),
      ]);
      expect(taken(panelA, 'forge:execute:response')).toHaveLength(1);
      expect(new AuditTrailStore(store).list().entries).toEqual([
        expect.objectContaining({ action: 'forge_execute', outcome: 'success' }),
      ]);
    });

    it('stops the run it names alone: recorded cancelled with what it wrote, offered for removal, the discovery of another panel walking on', async () => {
      const run = send(panelA, 'wv-run-a', 'forge:execute', {
        graph: graphOf('Account'),
        config: CONFIG,
      });
      await vi.waitFor(() => expect(orchestrator.execute).toHaveBeenCalledTimes(1));
      const walking = send(panelB, 'wv-discover-b', 'forge:discover', { config: CONFIG });
      await vi.waitFor(() => expect(walks).toHaveLength(1));
      orchestrator.abort.mockImplementation(() => stopRun(cancelledAfterTwoAccounts()));

      await send(panelA, 'wv-stop-a', 'forge:abort', { requestId: 'wv-run-a' });
      await run;

      expect(orchestrator.abort).toHaveBeenCalled();
      expect(walks[0].signal?.aborted).toBe(false);
      expect(new AuditTrailStore(store).list().entries).toEqual([
        expect.objectContaining({
          action: 'forge_execute',
          outcome: 'cancelled',
          objects: [{ objectApiName: 'Account', created: 2, updated: 0, deleted: 0, failed: 0 }],
        }),
      ]);
      // The page is told what the run wrote, kept in the history, whose
      // removal takes it back.
      const [stopped] = taken(panelA, 'forge:execute:error');
      const kept = stopped.payload.result as ForgeExecutionResult;
      expect(kept).toMatchObject({ status: 'partial', cancelled: true });
      expect(forgeRunCountsLeft(kept)).toEqual([{ objectApiName: 'Account', count: 2 }]);

      answerWalk[0](graphOf('Contact'));
      await walking;
      expect(taken(panelB, 'forge:discover:response')).toHaveLength(1);
    });

    it('stops the run it names while Production Guard asks: nothing written, recorded stopped before it started, the run of another panel writing on', async () => {
      const writing = send(panelA, 'wv-run-a', 'forge:execute', {
        graph: graphOf('Account'),
        config: CONFIG,
      });
      await vi.waitFor(() => expect(orchestrator.execute).toHaveBeenCalledTimes(1));
      holdTheNextQuestion = true;
      const asking = send(panelB, 'wv-run-b', 'forge:execute', {
        graph: graphOf('Contact'),
        config: CONFIG,
      });
      await vi.waitFor(() => expect(answerQuestion).toHaveLength(1));

      await send(panelB, 'wv-stop-b', 'forge:abort', { requestId: 'wv-run-b' });
      answerQuestion[0](true);
      await asking;

      expect(orchestrator.execute).toHaveBeenCalledTimes(1);
      expect(orchestrator.abort).not.toHaveBeenCalled();
      expect(taken(panelB, 'forge:execute:error')).toEqual([
        expect.objectContaining({
          correlationId: 'wv-run-b',
          payload: expect.objectContaining({ code: 'ABORTED_BEFORE_START' }),
        }),
      ]);
      expect(new AuditTrailStore(store).list().entries).toEqual([
        expect.objectContaining({
          operationId: 'wv-run-b',
          outcome: 'stopped',
          details: { code: 'ABORTED_BEFORE_START' },
        }),
      ]);

      finishRun(RESULT);
      await writing;
      expect(taken(panelA, 'forge:execute:response')).toHaveLength(1);
    });

    it('stops nothing for a request no operation answers any more', async () => {
      const walking = send(panelA, 'wv-discover-a', 'forge:discover', { config: CONFIG });
      await vi.waitFor(() => expect(walks).toHaveLength(1));

      await send(panelB, 'wv-stop-b', 'forge:abort', { requestId: 'wv-discover-ended' });

      expect(walks[0].signal?.aborted).toBe(false);
      expect(taken(panelB, 'forge:abort:error')).toEqual([]);
      answerWalk[0](graphOf('Account'));
      await walking;
    });
  });

  describe('a stop that names nothing', () => {
    it('stops the one operation under way', async () => {
      const walking = send(panelA, 'wv-discover-a', 'forge:discover', { config: CONFIG });
      await vi.waitFor(() => expect(walks).toHaveLength(1));

      await send(panelA, 'wv-stop-a', 'forge:abort');

      expect(walks[0].signal?.aborted).toBe(true);
      answerWalk[0]({ ...graphOf('Account'), nodes: [] });
      await walking;
      expect(taken(panelA, 'forge:discover:error')).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ code: 'DISCOVERY_STOPPED' }),
        }),
      ]);
    });

    it('is refused with a message, and stops nothing, while several operations are under way', async () => {
      const run = send(panelA, 'wv-run-a', 'forge:execute', {
        graph: graphOf('Account'),
        config: CONFIG,
      });
      await vi.waitFor(() => expect(orchestrator.execute).toHaveBeenCalledTimes(1));
      const walking = send(panelB, 'wv-discover-b', 'forge:discover', { config: CONFIG });
      await vi.waitFor(() => expect(walks).toHaveLength(1));

      await send(panelB, 'wv-stop-b', 'forge:abort', {});

      expect(walks[0].signal?.aborted).toBe(false);
      expect(orchestrator.abort).not.toHaveBeenCalled();
      expect(registry.getRunning()).toHaveLength(2);
      expect(taken(panelB, 'forge:abort:error')).toEqual([
        expect.objectContaining({
          correlationId: 'wv-stop-b',
          payload: expect.objectContaining({
            code: 'FORGE_STOP_AMBIGUOUS',
            message: expect.stringContaining('2 Forge operations are under way'),
          }),
        }),
      ]);

      answerWalk[0](graphOf('Contact'));
      finishRun(RESULT);
      await Promise.all([walking, run]);
      expect(taken(panelB, 'forge:discover:response')).toHaveLength(1);
      expect(taken(panelA, 'forge:execute:response')).toHaveLength(1);
    });

    it('stops nothing, and tells the executor nothing, when nothing is under way', async () => {
      await send(panelA, 'wv-stop-a', 'forge:abort');

      expect(orchestrator.abort).not.toHaveBeenCalled();
      expect(taken(panelA, 'forge:abort:error')).toEqual([]);
    });
  });

  describe('a stopped run that kept a journal', () => {
    /**
     * A journal on a disk in memory whose run file refuses a second close, as
     * a file on disk does (`closeSync` of a closed descriptor: EBADF).
     */
    function journalRefusingASecondClose(files: Map<string, string>): ForgeRunJournal {
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
        openRunFile: (filePath) => {
          let open = true;
          return {
            size: () => Buffer.byteLength(files.get(filePath) ?? ''),
            append: (text) => void files.set(filePath, (files.get(filePath) ?? '') + text),
            read: (offset, length) =>
              Buffer.from(files.get(filePath) ?? '').subarray(offset, offset + length),
            close: () => {
              if (!open) throw new Error('EBADF: bad file descriptor, close');
              open = false;
            },
          };
        },
      });
    }

    it('ends the run the user stopped, its journal told so, and lets the next run start', async () => {
      // The journal's file was closed as the executor settled, and again as
      // the run ended: on disk the second close threw, and the end of the run
      // stopped there — its journal never told how it ended, and the window
      // kept it as under way, refusing the next run with FORGE_RUNNING.
      const files = new Map<string, string>();
      const journal = journalRefusingASecondClose(files);
      const stop = vi.spyOn(journal, 'stop');
      handler.setForgeOrchestrator(orchestrator, { runJournal: journal });
      orchestrator.abort.mockImplementation(() => stopRun(cancelledAfterTwoAccounts()));

      const run = send(panelA, 'wv-run-a', 'forge:execute', {
        graph: graphOf('Account'),
        config: CONFIG,
      });
      await vi.waitFor(() => expect(orchestrator.execute).toHaveBeenCalledTimes(1));
      await send(panelA, 'wv-stop-a', 'forge:abort', { requestId: 'wv-run-a' });

      await expect(run).resolves.toBe(true);
      expect(stop).toHaveBeenCalledWith(expect.any(String), 'cancelled', expect.any(String));

      const next = send(panelA, 'wv-run-b', 'forge:execute', {
        graph: graphOf('Contact'),
        config: CONFIG,
      });
      await vi.waitFor(() => expect(orchestrator.execute).toHaveBeenCalledTimes(2));
      finishRun(RESULT);
      await next;
      expect(taken(panelA, 'forge:execute:error').map((m) => m.payload.code)).not.toContain(
        'FORGE_RUNNING',
      );
      expect(taken(panelA, 'forge:execute:response')).toHaveLength(1);
    });
  });
});
