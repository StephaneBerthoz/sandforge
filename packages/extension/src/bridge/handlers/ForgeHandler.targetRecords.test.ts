import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseMessage } from '@sandforge/shared';
import { ForgeHandler } from './ForgeHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { inboundRequest } from '../../test/mockFactories.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const mockGetJsforceConnection = vi.fn();
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: (...args: unknown[]) => mockGetJsforceConnection(...args),
}));

/*
 * Review of a clone of the whole org says what the target holds already of
 * the objects the run copies, before the run adds its records to them: the
 * org's own figures, read in one request.
 */
describe('forge:target-records:request', () => {
  let deps: HandlerDeps;
  let handler: ForgeHandler;
  const request = vi.fn();

  function ask(payload: Record<string, unknown>): InboundRequest {
    return inboundRequest({
      id: 'wv-target-records',
      type: 'forge:target-records:request',
      timestamp: Date.now(),
      payload,
    } as BaseMessage);
  }

  function posted(): Array<BaseMessage & { payload: Record<string, unknown> }> {
    return vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map((call) => call[0] as BaseMessage & { payload: Record<string, unknown> });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetJsforceConnection.mockResolvedValue({ request, version: '62.0' });
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {} as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
      configStore: { get: vi.fn(), set: vi.fn() } as unknown as HandlerDeps['configStore'],
      secretVault: {} as unknown as HandlerDeps['secretVault'],
      authProvider: {} as unknown as HandlerDeps['authProvider'],
      sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
      nextId: () => 'ext-1',
    };
    handler = new ForgeHandler(deps);
  });

  it('answers with the objects asked that the target holds records of, the most first, in one request', async () => {
    request.mockResolvedValue({
      sObjects: [
        { name: 'Account', count: 12 },
        { name: 'Contact', count: 340 },
        { name: 'Case', count: 0 },
        // Not asked: the run does not copy it.
        { name: 'Lead', count: 9 },
      ],
    });

    expect(
      await handler.handle(
        ask({ targetOrgId: 'tgt-org', objectApiNames: ['Account', 'Contact', 'Case', 'Asset'] }),
      ),
    ).toBe(true);

    expect(mockGetJsforceConnection).toHaveBeenCalledWith('tgt-org', {}, {});
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('/services/data/v62.0/limits/recordCount');
    expect(posted()).toEqual([
      expect.objectContaining({
        type: 'forge:target-records:response',
        correlationId: 'wv-target-records',
        payload: {
          targetOrgId: 'tgt-org',
          objects: [
            { objectApiName: 'Contact', records: 340 },
            { objectApiName: 'Account', records: 12 },
          ],
        },
      }),
    ]);
  });

  it('answers with nothing held when the target holds none of them', async () => {
    request.mockResolvedValue({ sObjects: [{ name: 'Account', count: 0 }] });

    await handler.handle(ask({ targetOrgId: 'tgt-org', objectApiNames: ['Account'] }));

    expect(posted()[0]).toMatchObject({
      type: 'forge:target-records:response',
      payload: { objects: [] },
    });
  });

  // An answer of no known form is not a target that holds nothing: said as
  // a read that failed, Review says nothing of what the target holds.
  it('fails rather than answer an empty target when the org answers in no known form', async () => {
    request.mockResolvedValue({ unexpected: true });

    await handler.handle(ask({ targetOrgId: 'tgt-org', objectApiNames: ['Account'] }));

    expect(posted()).toEqual([
      expect.objectContaining({
        type: 'forge:target-records:error',
        payload: expect.objectContaining({ code: 'TARGET_RECORDS_ERROR' }),
      }),
    ]);
  });

  it('refuses a payload that names no target before anything is read', async () => {
    await handler.handle(ask({ objectApiNames: ['Account'] }));

    expect(mockGetJsforceConnection).not.toHaveBeenCalled();
    expect(posted()[0]).toMatchObject({ type: 'forge:target-records:error' });
  });
});
