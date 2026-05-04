import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataOpsHandler } from './DataOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type { BaseMessage } from '@sandforge/shared';

/**
 * Creates minimal mock deps for DataOpsHandler tests.
 */
function createMockDeps(): HandlerDeps {
  let idCounter = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: { getOrg: vi.fn() } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: {
      get: vi.fn(),
      set: vi.fn(),
    } as unknown as HandlerDeps['configStore'],
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    nextId: () => String(++idCounter),
  };
}

describe('DataOpsHandler', () => {
  let handler: DataOpsHandler;
  let deps: HandlerDeps;

  beforeEach(() => {
    deps = createMockDeps();
    handler = new DataOpsHandler(deps);
  });

  it('returns false for unhandled message types', async () => {
    const msg: BaseMessage = { id: '1', type: 'unknown:type', timestamp: Date.now() };
    const result = await handler.handle(msg);
    expect(result).toBe(false);
  });

  it('returns true for handled message types and response includes correlationId', async () => {
    const msg: BaseMessage & { payload: Record<string, unknown> } = {
      id: 'req-dataops-1',
      type: 'dataops:anonymization-templates',
      timestamp: Date.now(),
      payload: {},
    };
    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & { correlationId?: string };
    expect(response.type).toBe('dataops:anonymization-templates:response');
    expect(response.correlationId).toBe('req-dataops-1');
  });

  describe('race condition guard', () => {
    it('rejects concurrent backup operations on the same org', async () => {
      // Simulate a long-running backup by making getJsforceConnection hang
      const { getJsforceConnection } = await import('../../core/connection/ConnectionHelper.js');
      vi.mock('../../core/connection/ConnectionHelper.js', () => ({
        getJsforceConnection: vi.fn(),
      }));

      const mockGetConn = vi.mocked(getJsforceConnection);
      let resolveFirst: (() => void) | undefined;
      const firstCallPromise = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });

      const mockConn = {
        query: vi.fn().mockResolvedValue({ records: [] }),
      };

      // First call hangs until we resolve it
      mockGetConn.mockImplementationOnce(
        () => firstCallPromise.then(() => mockConn) as ReturnType<typeof getJsforceConnection>,
      );

      const makeMsg = (
        id: string,
      ): BaseMessage & { payload: { orgId: string; objects: string[] } } => ({
        id,
        type: 'dataops:backup',
        timestamp: Date.now(),
        payload: { orgId: 'org-123', objects: ['Account'] },
      });

      // Start first backup (will hang on connection)
      const first = handler.handle(makeMsg('1'));

      // Attempt second backup on same org - should be rejected
      await handler.handle(makeMsg('2'));

      // Verify the second call was rejected with a warning
      expect(deps.log).toHaveBeenCalledWith(
        expect.stringContaining('already running for org org-123'),
      );

      // Resolve the first call to clean up
      resolveFirst?.();
      await first;

      vi.restoreAllMocks();
    });

    it('allows backup operations on different orgs concurrently', async () => {
      vi.mock('../../core/connection/ConnectionHelper.js', () => ({
        getJsforceConnection: vi.fn().mockResolvedValue({
          query: vi.fn().mockResolvedValue({ records: [] }),
        }),
      }));

      const makeMsg = (
        orgId: string,
      ): BaseMessage & { payload: { orgId: string; objects: string[] } } => ({
        id: '1',
        type: 'dataops:backup',
        timestamp: Date.now(),
        payload: { orgId, objects: ['Account'] },
      });

      // Both should proceed without blocking
      await Promise.all([handler.handle(makeMsg('org-A')), handler.handle(makeMsg('org-B'))]);

      // No warning should have been logged
      const warnCalls = (deps.log as ReturnType<typeof vi.fn>).mock.calls.filter((c: string[]) =>
        c[0].includes('[WARN]'),
      );
      expect(warnCalls).toHaveLength(0);

      vi.restoreAllMocks();
    });

    it('releases the lock after a failed backup', async () => {
      vi.mock('../../core/connection/ConnectionHelper.js', () => ({
        getJsforceConnection: vi.fn().mockRejectedValue(new Error('connection failed')),
      }));

      const makeMsg = (): BaseMessage & { payload: { orgId: string; objects: string[] } } => ({
        id: '1',
        type: 'dataops:backup',
        timestamp: Date.now(),
        payload: { orgId: 'org-123', objects: ['Account'] },
      });

      // First backup fails
      await handler.handle(makeMsg());

      // Second backup should NOT be blocked (lock was released in finally)
      await handler.handle(makeMsg());

      const warnCalls = (deps.log as ReturnType<typeof vi.fn>).mock.calls.filter((c: string[]) =>
        c[0].includes('[WARN]'),
      );
      expect(warnCalls).toHaveLength(0);

      vi.restoreAllMocks();
    });
  });
});
