import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForgeHandler } from './ForgeHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import type { BaseMessage, ForgeConfig, ForgeGraph, ForgeExecutionResult } from '@sandforge/shared';
import type { ForgeOrchestrator } from '../../modules/forge/ForgeOrchestrator.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
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

/*
 * Retry failed runs the clone again against what the run it retries wrote,
 * which that run's entry in the history holds.
 */

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
    depth: 'direct',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    anonymizePII: false,
    skipEmpty: false,
    batchSize: 'auto',
  };
}

/** What the run retried wrote: an account, and a contact of its two. */
const WRITTEN = {
  '001000000000123': '001000000000TGT',
  '003000000000001': '003000000000TGT',
};

/** A run of the history, partial, as the handler kept it. */
function pastRun(overrides: Partial<ForgeExecutionResult> = {}): ForgeExecutionResult {
  return {
    forgeId: 'forge-partial',
    status: 'partial',
    graph: createGraph(),
    duration: 1000,
    timestamp: '2026-09-24T08:00:00.000Z',
    idRemapCount: 2,
    idRemapTable: { ...WRITTEN },
    createdCount: 2,
    targetOrgId: 'tgt-org',
    ...overrides,
  };
}

function createDeps(data: Map<string, unknown>): HandlerDeps {
  let idCounter = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: { getOrg: vi.fn() } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: {
      get: vi.fn((key: string) => data.get(key)),
      set: vi.fn((key: string, value: unknown) => {
        data.set(key, value);
      }),
    } as unknown as HandlerDeps['configStore'],
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    infraServices: {
      productionGuard: new ProductionGuard(),
    } as unknown as HandlerDeps['infraServices'],
    nextId: () => String(++idCounter),
  };
}

function buildMsg(id: string, payload: unknown): InboundRequest {
  return inboundRequest({
    id,
    type: 'forge:execute',
    timestamp: Date.now(),
    payload,
  } as BaseMessage);
}

describe('forge:execute, retrying a run', () => {
  let handler: ForgeHandler;
  let deps: HandlerDeps;
  let data: Map<string, unknown>;
  let execute: ReturnType<typeof vi.fn>;

  /** What the handler posted to the webview of `type`. */
  function posted(type: string): Array<BaseMessage & { payload: Record<string, unknown> }> {
    return vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map((c) => c[0] as BaseMessage & { payload: Record<string, unknown> })
      .filter((m) => m.type === type);
  }

  /** Retry the run `retryOf`, as the results page asks for it. */
  function retry(retryOf: string, id = 'wv-retry'): Promise<boolean> {
    return handler.handle(buildMsg(id, { graph: createGraph(), config: createConfig(), retryOf }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    data = new Map();
    deps = createDeps(data);
    handler = new ForgeHandler(deps);
    execute = vi.fn().mockResolvedValue({
      ...pastRun({ forgeId: 'forge-retry', status: 'success', createdCount: 1 }),
      targetOrgId: undefined,
    });
    handler.setForgeOrchestrator({
      discover: vi.fn(),
      execute,
      on: vi.fn().mockReturnValue(vi.fn()),
      abort: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    } as unknown as ForgeOrchestrator);
  });

  it('runs the clone against what the run it retries wrote, and names that run', async () => {
    data.set('forge:history', [pastRun()]);

    await retry('forge-partial');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][2]).toMatchObject({ writtenBefore: WRITTEN });
    const [response] = posted('forge:execute:response');
    expect(response.payload.result).toMatchObject({
      forgeId: 'forge-retry',
      retryOf: 'forge-partial',
    });
    const history = data.get('forge:history') as ForgeExecutionResult[];
    expect(history.map((run) => [run.forgeId, run.retryOf])).toEqual([
      ['forge-retry', 'forge-partial'],
      ['forge-partial', undefined],
    ]);
  });

  it('runs a clone from Review with nothing written before', async () => {
    await handler.handle(buildMsg('wv-run', { graph: createGraph(), config: createConfig() }));

    expect(execute.mock.calls[0][2]).toMatchObject({ writtenBefore: undefined });
    expect(posted('forge:execute:response')[0].payload.result).not.toHaveProperty('retryOf');
  });

  /** The one error the retry was answered with, and that nothing ran. */
  function refusedWith(): string {
    expect(execute).not.toHaveBeenCalled();
    const errors = posted('forge:execute:error');
    expect(errors).toHaveLength(1);
    expect(errors[0].payload.code).toBe('RETRY_UNAVAILABLE');
    return String(errors[0].payload.message);
  }

  it('refuses a retry of a run the history no longer holds: what it wrote is not known', async () => {
    await retry('forge-gone');
    expect(refusedWith()).toContain('no longer in the history');
  });

  it('refuses a retry of a run whose records were removed: nothing is left to link to', async () => {
    data.set('forge:history', [
      pastRun({
        undo: {
          removedAt: '2026-09-24T09:00:00.000Z',
          deleted: 2,
          alreadyGone: 0,
          kept: 0,
          refused: 0,
        },
      }),
    ]);
    await retry('forge-partial');
    expect(refusedWith()).toContain('were removed on 2026-09-24T09:00:00.000Z');
  });

  it('refuses a retry built on a run whose records were removed', async () => {
    // The retry holds the first run's ids among its own; they are gone.
    data.set('forge:history', [
      pastRun({ forgeId: 'forge-retried-once', retryOf: 'forge-partial' }),
      pastRun({
        undo: {
          removedAt: '2026-09-24T09:00:00.000Z',
          deleted: 2,
          alreadyGone: 0,
          kept: 0,
          refused: 0,
        },
      }),
    ]);
    await retry('forge-retried-once');
    expect(refusedWith()).toContain('a run it was built on');
  });

  it('refuses a retry of a run that wrote to another org', async () => {
    data.set('forge:history', [pastRun({ targetOrgId: 'other-org' })]);
    await retry('forge-partial');
    expect(refusedWith()).toContain('another org');
  });

  it('refuses a retry of a run recorded before runs kept what they wrote', async () => {
    data.set('forge:history', [pastRun({ idRemapTable: undefined })]);
    await retry('forge-partial');
    expect(refusedWith()).toContain('kept no record');
  });

  it('takes a retry sent the minute after the run it retries wrote: it is not that run twice', async () => {
    execute.mockResolvedValueOnce(pastRun());
    await handler.handle(buildMsg('wv-run', { graph: createGraph(), config: createConfig() }));

    await retry('forge-partial');

    expect(execute).toHaveBeenCalledTimes(2);
    expect(posted('forge:execute:error')).toEqual([]);
  });
});
