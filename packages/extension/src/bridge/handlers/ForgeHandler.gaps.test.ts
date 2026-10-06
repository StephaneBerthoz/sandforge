import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForgeHandler } from './ForgeHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import type { BaseMessage, ForgeConfig, ForgeGraph, ForgeTargetGaps } from '@sandforge/shared';
import { buildSyntheticForgeGraph, forgeGapId } from '@sandforge/shared';
import type { ForgeOrchestrator } from '../../modules/forge/ForgeOrchestrator.js';
import type { TargetGapReader } from '../../modules/forge/TargetGapReader.js';
import { TimeoutError } from '../../core/engine/TimeoutManager.js';
import { inboundRequest } from '../../test/mockFactories.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

/*
 * `forge:gaps:request`: Review asks, as it opens, what the target's metadata
 * holds against the rows of the run — and the answer, or the reason there is
 * none, comes back on `forge:gaps:response` or `forge:gaps:error`, never
 * leaving the page waiting.
 */

const CONFIG: ForgeConfig = {
  inputMode: 'record',
  recordId: '001000000000123',
  depth: 'direct',
  sourceOrgId: 'src-org',
  targetOrgId: 'tgt-org',
  anonymizePII: false,
  skipEmpty: false,
  batchSize: 'auto',
  fieldExclusions: { Account: ['Description'] },
};

const GRAPH: ForgeGraph = buildSyntheticForgeGraph(['Account', 'Contact']);

/** What the reader answers: one gap, one part it could not read. */
const READ: ForgeTargetGaps = {
  gaps: [
    {
      id: forgeGapId('required_field_missing', 'Account', 'Region__c'),
      kind: 'required_field_missing',
      severity: 'blocking',
      source: 'metadata',
      objectApiName: 'Account',
      field: 'Region__c',
      rows: 0,
      detail: { type: 'picklist', reason: 'notInSource' },
      decisions: ['set_default', 'exclude_object'],
    },
  ],
  unread: [{ part: 'apiBudget', reason: 'INSUFFICIENT_ACCESS' }],
  requests: 7,
};

function buildMsg(type: string, payload?: unknown): InboundRequest {
  return inboundRequest({
    id: `test-${type}`,
    type,
    timestamp: Date.now(),
    ...(payload !== undefined ? { payload } : {}),
  } as BaseMessage);
}

function createDeps(): HandlerDeps {
  let id = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: {} as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: { get: vi.fn(), set: vi.fn() } as unknown as HandlerDeps['configStore'],
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    nextId: () => String(++id),
  };
}

describe('ForgeHandler forge:gaps:request', () => {
  let deps: HandlerDeps;
  let handler: ForgeHandler;
  const orchestrator = { on: vi.fn() } as unknown as ForgeOrchestrator;

  /** The messages of `type` the page was sent. */
  function posted(type: string): Array<BaseMessage & { payload: Record<string, unknown> }> {
    return vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
      .filter((m) => m.type === type);
  }

  /** How the one operation the request started ended. */
  function endOfTheOperation(): unknown[] {
    const [started] = posted('operation:started');
    return posted('operation:completed')
      .filter((m) => m.payload.operationId === started.payload.operationId)
      .map((m) => m.payload.result);
  }

  /** A reader answering `read`, or failing with `error`. */
  function withReader(answer: () => Promise<ForgeTargetGaps>): TargetGapReader {
    const targetGaps = { read: vi.fn(answer) } as unknown as TargetGapReader;
    handler.setForgeOrchestrator(orchestrator, { targetGaps });
    return targetGaps;
  }

  beforeEach(() => {
    deps = createDeps();
    handler = new ForgeHandler(deps);
  });

  it('reads the gaps of the graph from the target under the config, and answers the request with them', async () => {
    const reader = withReader(async () => READ);
    const msg = buildMsg('forge:gaps:request', { graph: GRAPH, config: CONFIG });

    expect(await handler.handle(msg)).toBe(true);

    expect(reader.read).toHaveBeenCalledWith(
      'src-org',
      'tgt-org',
      GRAPH,
      expect.objectContaining({ fieldExclusions: { Account: ['Description'] } }),
    );
    const [response] = posted('forge:gaps:response');
    expect(response.correlationId).toBe(msg.id);
    expect(response.payload).toEqual({ gaps: READ });
    expect(endOfTheOperation()).toEqual([{ objectCount: 2 }]);
  });

  it('says the reader is missing instead of leaving the page waiting', async () => {
    handler.setForgeOrchestrator(orchestrator, {});
    await handler.handle(buildMsg('forge:gaps:request', { graph: GRAPH, config: CONFIG }));
    expect(posted('forge:gaps:error').map((m) => m.payload.code)).toEqual(['NOT_INITIALIZED']);
  });

  it('refuses a request without a config, before anything is read', async () => {
    const reader = withReader(async () => READ);
    await handler.handle(buildMsg('forge:gaps:request', { graph: GRAPH }));
    expect(reader.read).not.toHaveBeenCalled();
    expect(posted('forge:gaps:error')).toHaveLength(1);
    expect(posted('forge:gaps:response')).toHaveLength(0);
  });

  it('ends with one error, and the operation it started ended, when the read throws', async () => {
    withReader(async () => {
      throw new Error('session expired');
    });
    await handler.handle(buildMsg('forge:gaps:request', { graph: GRAPH, config: CONFIG }));
    expect(posted('operation:failed')).toHaveLength(0);
    expect(posted('forge:gaps:error').map((m) => m.payload)).toEqual([
      expect.objectContaining({ code: 'GAPS_ERROR', retryable: false }),
    ]);
    expect(endOfTheOperation()).toEqual([{ status: 'failure' }]);
  });

  it('says a read that ran out of time may be asked again', async () => {
    withReader(async () => {
      throw new TimeoutError('forge:gaps', 60_000);
    });
    await handler.handle(buildMsg('forge:gaps:request', { graph: GRAPH, config: CONFIG }));
    expect(posted('forge:gaps:error').map((m) => m.payload)).toEqual([
      expect.objectContaining({ code: 'TIMEOUT', retryable: true }),
    ]);
  });
});
