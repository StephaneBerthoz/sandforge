import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForgeHandler } from './ForgeHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import type { BaseMessage, ForgeConfig, ForgeGraph, ForgeExecutionResult } from '@sandforge/shared';
import type { ForgeOrchestrator } from '../../modules/forge/ForgeOrchestrator.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ForgeRunJournal } from '../../modules/forge/ForgeRunJournal.js';
import { inboundRequest } from '../../test/mockFactories.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));
vi.mock('../../core/common/soqlQueryHelper.js', () => ({
  queryWithFieldsFallback: vi.fn(),
}));
// Partial mock: only the escaping is stubbed. The module's other exports stay
// real so adding one does not break this suite.
vi.mock('../../core/common/soqlValidator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/common/soqlValidator.js')>()),
  sanitizeSoqlValue: vi.fn((v: string) => v),
}));
vi.mock('../../core/common/sforceLimitParser.js', () => ({
  checkApiLimits: vi.fn(),
}));

function createGraph(): ForgeGraph {
  return {
    nodes: [
      {
        objectApiName: 'Account',
        recordCount: 10,
        fieldCount: 5,
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
      },
    ],
    edges: [],
    totalRecords: 10,
    estimatedSizeMB: 0.01,
    estimatedDurationSeconds: 0.1,
  };
}

function createConfig(): ForgeConfig {
  return {
    inputMode: 'record',
    recordId: '001000000000123',
    depth: 'custom',
    customDepth: 3,
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    anonymizePII: true,
    skipEmpty: true,
    batchSize: 'auto',
    maxRecordsPerObject: 50,
  };
}

function createResult(): ForgeExecutionResult {
  return {
    forgeId: 'forge-123',
    status: 'success',
    graph: createGraph(),
    duration: 1000,
    timestamp: '2026-03-07T00:00:00.000Z',
    idRemapCount: 5,
  };
}

/** ConfigStore double that actually remembers what the handler persisted. */
function createConfigStore(): {
  store: HandlerDeps['configStore'];
  data: Map<string, unknown>;
} {
  const data = new Map<string, unknown>();
  const store = {
    get: vi.fn((key: string) => data.get(key)),
    set: vi.fn((key: string, value: unknown) => {
      data.set(key, value);
    }),
  } as unknown as HandlerDeps['configStore'];
  return { store, data };
}

function createDeps(configStore: HandlerDeps['configStore']): HandlerDeps {
  let idCounter = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    // A sandbox: a clone refuses a production org before anything is read.
    orgManager: {
      getOrg: vi.fn(() => ({ orgType: 'Sandbox' })),
    } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore,
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    // A run refuses to write without a Production Guard, and the extension
    // always injects one.
    infraServices: {
      // Its run's questions, answered yes.
      productionGuard: new ProductionGuard({ requestRunConfirmation: async () => true }),
    } as unknown as HandlerDeps['infraServices'],
    nextId: () => String(++idCounter),
  };
}

function buildMsg(type: string, payload?: unknown): InboundRequest {
  return inboundRequest({
    id: `test-${type}`,
    type,
    timestamp: Date.now(),
    ...(payload !== undefined ? { payload } : {}),
  } as BaseMessage);
}

describe('forge history entries are replayable', () => {
  let handler: ForgeHandler;
  let deps: HandlerDeps;
  let data: Map<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    const store = createConfigStore();
    data = store.data;
    deps = createDeps(store.store);
    handler = new ForgeHandler(deps);
    const orchestrator = {
      discover: vi.fn(),
      execute: vi.fn().mockResolvedValue(createResult()),
      on: vi.fn().mockReturnValue(vi.fn()),
      abort: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    } as unknown as ForgeOrchestrator;
    handler.setForgeOrchestrator(orchestrator);
  });

  it('persists the config that produced the run', async () => {
    await handler.handle(
      buildMsg('forge:execute', {
        graph: createGraph(),
        config: createConfig(),
      }),
    );

    const history = data.get('forge:history') as ForgeExecutionResult[];
    expect(history).toHaveLength(1);
    // Without this the entry is inspectable but not repeatable — there is
    // nothing to rebuild a forge:execute from.
    expect(history[0].config).toEqual({
      inputMode: 'record',
      recordId: '001000000000123',
      depth: 'custom',
      customDepth: 3,
      anonymizePII: true,
      skipEmpty: true,
      batchSize: 'auto',
      maxRecordsPerObject: 50,
    });
  });

  it('strips the org pair so a re-run cannot silently replay yesterday orgs', async () => {
    await handler.handle(
      buildMsg('forge:execute', {
        graph: createGraph(),
        config: createConfig(),
      }),
    );

    const history = data.get('forge:history') as ForgeExecutionResult[];
    const stored = history[0].config as Record<string, unknown> | undefined;
    expect(stored).toBeDefined();
    expect(stored).not.toHaveProperty('sourceOrgId');
    expect(stored).not.toHaveProperty('targetOrgId');
  });

  it('keeps the org the run wrote to beside the config, for removing what it created', async () => {
    await handler.handle(
      buildMsg('forge:execute', {
        graph: createGraph(),
        config: createConfig(),
      }),
    );

    const history = data.get('forge:history') as ForgeExecutionResult[];
    expect(history[0].targetOrgId).toBe('tgt-org');
    // A re-run still re-picks both orgs: the config it refills stays free of them.
    expect(history[0].config).not.toHaveProperty('targetOrgId');
  });

  it('serves stored entries back on forge:history:list', async () => {
    await handler.handle(
      buildMsg('forge:execute', {
        graph: createGraph(),
        config: createConfig(),
      }),
    );
    vi.mocked(deps.broker.postToWebview).mockClear();

    await handler.handle(buildMsg('forge:history:list'));

    const listed = vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(
        (c) =>
          c[0] as BaseMessage & {
            payload: { history: ForgeExecutionResult[] };
          },
      )
      .find((m) => m.type === 'forge:history:list:response');
    expect(listed?.payload.history[0].config?.recordId).toBe('001000000000123');
  });

  it('keeps pre-existing entries readable when they carry no config', () => {
    const legacy: ForgeExecutionResult = createResult();
    data.set('forge:history', [legacy]);

    // A legacy entry stays a valid history row; it simply cannot offer a
    // re-run — which is why `config` is optional rather than required.
    expect((data.get('forge:history') as ForgeExecutionResult[])[0].config).toBeUndefined();
  });
});

/** A journal of runs on a disk in memory, keyed by path as the platform writes it. */
function journalOnMemory(): ForgeRunJournal {
  const files = new Map<string, string>();
  const at = (filePath: string): string => path.normalize(filePath);
  return new ForgeRunJournal({
    storagePath: '/storage',
    appendFile: async (filePath, content) => {
      files.set(at(filePath), (files.get(at(filePath)) ?? '') + content);
    },
    readLines: (filePath) =>
      (async function* lines(): AsyncGenerator<string> {
        for (const line of (files.get(at(filePath)) ?? '').split('\n')) yield line;
      })(),
    mkdir: async () => {},
    rm: async (filePath) => void files.delete(at(filePath)),
    listFiles: async (dirPath) =>
      [...files.keys()]
        .filter((filePath) => path.dirname(filePath) === at(dirPath))
        .map((filePath) => path.basename(filePath)),
    openRunFile: (filePath) => ({
      size: () => Buffer.byteLength(files.get(at(filePath)) ?? ''),
      append: (text) => void files.set(at(filePath), (files.get(at(filePath)) ?? '') + text),
      read: (offset, length) =>
        Buffer.from(files.get(at(filePath)) ?? '').subarray(offset, offset + length),
      close: () => {},
    }),
  });
}

/*
 * The history lives in the extension's global state, rewritten whole at every
 * change, twenty runs of it: a clone of the whole org keeps there its nodes,
 * without the thousands of relations and left-out objects its graph names.
 */
describe('the history entry of a clone of the whole org', () => {
  const WHOLE_ORG: ForgeConfig = {
    inputMode: 'org',
    depth: 'all',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    anonymizePII: false,
    skipEmpty: true,
    batchSize: 'auto',
  };

  /** The graph a clone of the whole org ran: two objects, a relation, three objects left out. */
  function wholeOrgGraph(): ForgeGraph {
    const [account] = createGraph().nodes;
    return {
      ...createGraph(),
      nodes: [account, { ...account, objectApiName: 'Contact', level: 1 }],
      edges: [
        {
          sourceObject: 'Contact',
          targetObject: 'Account',
          relationshipName: 'AccountId',
          type: 'lookup',
        },
      ],
      leftOut: [
        { objectApiName: 'AccountHistory', reason: 'history' },
        { objectApiName: 'Widget__c', reason: 'empty' },
        { objectApiName: 'ContactHistory', reason: 'history' },
      ],
    };
  }

  let handler: ForgeHandler;
  let deps: HandlerDeps;
  let data: Map<string, unknown>;
  let execute: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    const store = createConfigStore();
    data = store.data;
    deps = createDeps(store.store);
    handler = new ForgeHandler(deps);
    execute = vi.fn();
    handler.setForgeOrchestrator(
      {
        discover: vi.fn(),
        execute,
        on: vi.fn().mockReturnValue(vi.fn()),
        abort: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
      } as unknown as ForgeOrchestrator,
      // A clone of the whole org writes nothing without its journal.
      { runJournal: journalOnMemory() },
    );
  });

  function run(config: ForgeConfig, graph: ForgeGraph): Promise<boolean> {
    return handler.handle(buildMsg('forge:execute', { graph, config }));
  }

  it('keeps its nodes, no relation, and what it left out counted by reason; its page has the graph whole', async () => {
    const graph = wholeOrgGraph();
    execute.mockResolvedValue({
      ...createResult(),
      graph,
      // Past the bound, its ids and the records they go with are marked in its journal.
      remapInJournal: true,
      idRemapWithTheirRecord: ['003000000000001AAA'],
      linkedWithTheirRecordCount: 1,
    } satisfies ForgeExecutionResult);

    await run(WHOLE_ORG, graph);

    const [entry] = data.get('forge:history') as ForgeExecutionResult[];
    expect(entry.graph.nodes.map((node) => node.objectApiName)).toEqual(['Account', 'Contact']);
    expect(entry.graph.edges).toEqual([]);
    expect(entry.graph.withoutEdges).toBe(true);
    expect(entry.graph).not.toHaveProperty('leftOut');
    expect(entry.leftOutCounts).toEqual([
      { reason: 'history', count: 2 },
      { reason: 'empty', count: 1 },
    ]);
    expect(entry).not.toHaveProperty('idRemapWithTheirRecord');
    expect(entry.linkedWithTheirRecordCount).toBe(1);
    expect(entry.config).toMatchObject({ inputMode: 'org', depth: 'all' });

    const response = vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map((c) => c[0] as BaseMessage & { payload: { result?: ForgeExecutionResult } })
      .find((m) => m.type === 'forge:execute:response');
    expect(response?.payload.result?.graph.edges).toHaveLength(1);
    expect(response?.payload.result?.graph.leftOut).toHaveLength(3);
    expect(response?.payload.result?.graph).not.toHaveProperty('withoutEdges');
  });

  it('refuses to run the graph its entry keeps, which a Retry of the entry opened from the history sends back', async () => {
    // Without its relations, its parents went unordered and its lookups unmapped.
    const graph = wholeOrgGraph();
    execute.mockResolvedValue({ ...createResult(), graph } satisfies ForgeExecutionResult);
    await run(WHOLE_ORG, graph);
    const [entry] = data.get('forge:history') as ForgeExecutionResult[];
    vi.mocked(deps.broker.postToWebview).mockClear();

    await handler.handle(
      buildMsg('forge:execute', { graph: entry.graph, config: WHOLE_ORG, retryOf: entry.forgeId }),
    );

    expect(execute).toHaveBeenCalledTimes(1);
    const posted = vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(
        (c) => c[0] as BaseMessage & { payload: { code?: string; message?: string } },
      );
    const refused = posted.find((m) => m.type === 'forge:execute:error');
    expect(refused?.payload.code).toBe('GRAPH_WITHOUT_EDGES');
    expect(refused?.payload.message).toContain('Discover the org again');
    expect(posted.find((m) => m.type === 'forge:execute:response')).toBeUndefined();
  });

  it('keeps the records that go with one it created when its ids are in the entry, as any run does', async () => {
    const graph = wholeOrgGraph();
    execute.mockResolvedValue({
      ...createResult(),
      graph,
      idRemapWithTheirRecord: ['003000000000001AAA'],
    } satisfies ForgeExecutionResult);

    await run(WHOLE_ORG, graph);

    const [entry] = data.get('forge:history') as ForgeExecutionResult[];
    expect(entry.idRemapWithTheirRecord).toEqual(['003000000000001AAA']);
    expect(entry.graph.edges).toEqual([]);
  });

  it('keeps the graph of any other run whole', async () => {
    const graph = { ...wholeOrgGraph(), leftOut: undefined };
    execute.mockResolvedValue({ ...createResult(), graph } satisfies ForgeExecutionResult);

    await run(createConfig(), graph);

    const [entry] = data.get('forge:history') as ForgeExecutionResult[];
    expect(entry.graph.edges).toHaveLength(1);
    expect(entry.graph).not.toHaveProperty('withoutEdges');
    expect(entry).not.toHaveProperty('leftOutCounts');
  });
});
