import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForgeHandler } from './ForgeHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import type { BaseMessage, ForgeConfig, ForgeGraph, ForgeExecutionResult } from '@sandforge/shared';
import type { ForgeOrchestrator } from '../../modules/forge/ForgeOrchestrator.js';
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
vi.mock('../../core/common/soqlValidator.js', () => ({
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
    recordId: '001AP00000j2CEg',
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
    orgManager: { getOrg: vi.fn() } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore,
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
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
      recordId: '001AP00000j2CEg',
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
    expect(listed?.payload.history[0].config?.recordId).toBe('001AP00000j2CEg');
  });

  it('keeps pre-existing entries readable when they carry no config', () => {
    const legacy: ForgeExecutionResult = createResult();
    data.set('forge:history', [legacy]);

    // A legacy entry stays a valid history row; it simply cannot offer a
    // re-run — which is why `config` is optional rather than required.
    expect((data.get('forge:history') as ForgeExecutionResult[])[0].config).toBeUndefined();
  });
});
