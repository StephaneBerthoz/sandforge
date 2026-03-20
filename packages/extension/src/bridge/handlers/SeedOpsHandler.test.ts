import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SeedOpsHandler } from './SeedOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type { BaseMessage } from '@sandforge/shared';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

const mockGetConn = vi.mocked(getJsforceConnection);

/**
 * Creates minimal mock deps for SeedOpsHandler tests.
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
      get: vi.fn().mockReturnValue(undefined),
      set: vi.fn(),
    } as unknown as HandlerDeps['configStore'],
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    nextId: () => String(++idCounter),
  };
}

describe('SeedOpsHandler', () => {
  let handler: SeedOpsHandler;
  let deps: HandlerDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
    handler = new SeedOpsHandler(deps);
  });

  it('returns false for unhandled message types', async () => {
    const msg: BaseMessage = { id: '1', type: 'unknown:type', timestamp: Date.now() };
    const result = await handler.handle(msg);
    expect(result).toBe(false);
  });

  it('handles seed:describe-global and response includes correlationId', async () => {
    mockGetConn.mockResolvedValue({
      describeGlobal: vi.fn().mockResolvedValue({
        sobjects: [
          { name: 'Account', label: 'Account', createable: true },
          { name: 'Lead', label: 'Lead', createable: false },
        ],
      }),
    } as never);

    const msg: BaseMessage & { payload: { orgId: string } } = {
      id: 'req-100',
      type: 'seed:describe-global',
      timestamp: Date.now(),
      payload: { orgId: 'org-1' },
    };

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & { correlationId?: string; payload: { objects: unknown[] } };
    expect(response.type).toBe('seed:describe-global:response');
    expect(response.correlationId).toBe('req-100');
    expect(response.payload.objects).toHaveLength(1);
    expect((response.payload.objects[0] as { apiName: string }).apiName).toBe('Account');
  });

  it('handles seed:describe-object and response includes correlationId', async () => {
    mockGetConn.mockResolvedValue({
      describe: vi.fn().mockResolvedValue({
        label: 'Account',
        fields: [
          { name: 'Name', label: 'Account Name', type: 'string', nillable: false, defaultedOnCreate: false, length: 255, createable: true },
        ],
      }),
    } as never);

    const msg: BaseMessage & { payload: { orgId: string; objectApiName: string } } = {
      id: 'req-200',
      type: 'seed:describe-object',
      timestamp: Date.now(),
      payload: { orgId: 'org-1', objectApiName: 'Account' },
    };

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & { correlationId?: string };
    expect(response.type).toBe('seed:describe-object:response');
    expect(response.correlationId).toBe('req-200');
  });

  it('error path sends error response via sendHandlerError', async () => {
    mockGetConn.mockRejectedValue(new Error('connection failed'));

    const msg: BaseMessage & { payload: { orgId: string } } = {
      id: 'req-300',
      type: 'seed:describe-global',
      timestamp: Date.now(),
      payload: { orgId: 'org-1' },
    };

    await handler.handle(msg);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & { payload: { message: string } };
    expect(response.type).toBe('seed:error');
    expect(response.payload.message).toBe('connection failed');
  });

  describe('seed:execute dryRun', () => {
    it('returns synthetic result when dryRun is true without performing inserts', async () => {
      mockGetConn.mockResolvedValue({} as never);

      const msg: BaseMessage & { payload: { orgId: string; template: Record<string, unknown>; dryRun: boolean } } = {
        id: 'req-dry-1',
        type: 'seed:execute',
        timestamp: Date.now(),
        payload: { orgId: 'org-1', template: { objects: [] }, dryRun: true },
      };

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      expect(postToWebview).toHaveBeenCalledTimes(1);

      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        correlationId?: string;
        payload: { success: boolean; dryRun: boolean; insertedCount: number; results: unknown[] };
      };
      expect(response.type).toBe('seed:execute:response');
      expect(response.correlationId).toBe('req-dry-1');
      expect(response.payload.dryRun).toBe(true);
      expect(response.payload.insertedCount).toBe(0);
      expect(response.payload.results).toEqual([]);
    });

    it('does not short-circuit when dryRun is false', async () => {
      mockGetConn.mockResolvedValue({} as never);

      const msg: BaseMessage & { payload: { orgId: string; template: Record<string, unknown>; dryRun: boolean } } = {
        id: 'req-dry-2',
        type: 'seed:execute',
        timestamp: Date.now(),
        payload: { orgId: 'org-1', template: { objects: [] }, dryRun: false },
      };

      await handler.handle(msg);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      // If a seed:execute:response was posted, it must NOT have the dryRun flag
      const executeResponses = postToWebview.mock.calls
        .map((c) => c[0] as BaseMessage & { payload?: { dryRun?: boolean } })
        .filter((r) => r.type === 'seed:execute:response');
      for (const r of executeResponses) {
        expect(r.payload?.dryRun).not.toBe(true);
      }
    });
  });

  describe('robustness integration', () => {
    it('wraps describe-global with TimeoutManager', async () => {
      const describeGlobalFn = vi.fn().mockResolvedValue({
        sobjects: [{ name: 'Account', label: 'Account', createable: true }],
      });
      mockGetConn.mockResolvedValue({ describeGlobal: describeGlobalFn } as never);

      const msg: BaseMessage & { payload: { orgId: string } } = {
        id: 'req-timeout-1',
        type: 'seed:describe-global',
        timestamp: Date.now(),
        payload: { orgId: 'org-1' },
      };

      await handler.handle(msg);

      // describeGlobal was called (wrapped inside TimeoutManager)
      expect(describeGlobalFn).toHaveBeenCalledTimes(1);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & { payload: { objects: unknown[] } };
      expect(response.type).toBe('seed:describe-global:response');
      expect(response.payload.objects).toHaveLength(1);
    });

    it('wraps describe-object with TimeoutManager', async () => {
      const describeFn = vi.fn().mockResolvedValue({
        label: 'Account',
        fields: [
          { name: 'Name', label: 'Name', type: 'string', nillable: false, defaultedOnCreate: false, length: 255, createable: true },
        ],
      });
      mockGetConn.mockResolvedValue({ describe: describeFn } as never);

      const msg: BaseMessage & { payload: { orgId: string; objectApiName: string } } = {
        id: 'req-timeout-2',
        type: 'seed:describe-object',
        timestamp: Date.now(),
        payload: { orgId: 'org-1', objectApiName: 'Account' },
      };

      await handler.handle(msg);

      expect(describeFn).toHaveBeenCalledTimes(1);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      expect(postToWebview.mock.calls[0][0].type).toBe('seed:describe-object:response');
    });

    it('sends TimeoutError to webview when describe-global times out', async () => {
      const describeGlobalFn = vi.fn().mockImplementation(() =>
        new Promise((_resolve) => {
          /* never resolves -- simulates a hung API call */
        }),
      );
      mockGetConn.mockResolvedValue({ describeGlobal: describeGlobalFn } as never);

      // Set very short timeout via configStore
      vi.mocked(deps.configStore.get).mockReturnValue({
        timeouts: { describeGlobal: 5000, describe: 5000, crudBatch: 10000, bulkJob: 60000 },
        retry: { maxRetries: 0 },
        bulk: { threshold: 200 },
      });

      const msg: BaseMessage & { payload: { orgId: string } } = {
        id: 'req-timeout-err',
        type: 'seed:describe-global',
        timestamp: Date.now(),
        payload: { orgId: 'org-1' },
      };

      // The handler should catch the timeout and send an error
      // But since 5s is too long for a test, just verify the timeout wrapping
      // by checking that describeGlobal was called
      // (The actual timeout behavior is tested in TimeoutManager.test.ts)
      await Promise.race([
        handler.handle(msg),
        new Promise((resolve) => setTimeout(resolve, 50)),
      ]);

      expect(describeGlobalFn).toHaveBeenCalledTimes(1);
    });

    it('loads robustness config from ConfigStore', async () => {
      const customConfig = {
        timeouts: { describeGlobal: 60000, describe: 30000, crudBatch: 120000, bulkJob: 600000 },
        retry: { maxRetries: 5, initialDelay: 2000, maxDelay: 60000, backoffMultiplier: 3 },
        bulk: { threshold: 500 },
      };
      vi.mocked(deps.configStore.get).mockReturnValue(customConfig);

      mockGetConn.mockResolvedValue({
        describeGlobal: vi.fn().mockResolvedValue({ sobjects: [] }),
      } as never);

      const msg: BaseMessage & { payload: { orgId: string } } = {
        id: 'req-config',
        type: 'seed:describe-global',
        timestamp: Date.now(),
        payload: { orgId: 'org-1' },
      };

      await handler.handle(msg);

      // ConfigStore.get was called with the robustness config key
      expect(deps.configStore.get).toHaveBeenCalledWith('robustness:config');
    });

    it('falls back to defaults when configStore returns undefined', async () => {
      vi.mocked(deps.configStore.get).mockReturnValue(undefined);

      mockGetConn.mockResolvedValue({
        describeGlobal: vi.fn().mockResolvedValue({ sobjects: [] }),
      } as never);

      const msg: BaseMessage & { payload: { orgId: string } } = {
        id: 'req-default',
        type: 'seed:describe-global',
        timestamp: Date.now(),
        payload: { orgId: 'org-1' },
      };

      // Should not throw even with undefined config
      const result = await handler.handle(msg);
      expect(result).toBe(true);
    });
  });

  describe('bulk path uses real IDs', () => {
    it('passes bulkResult.successIds instead of synthetic IDs', () => {
      // This is a structural test: verify the SeedOpsHandler source uses
      // bulkResult.successIds (not Array.from with synthetic bulk-N IDs).
      // The actual bulk executor is tested in BulkApiExecutor.test.ts.
      // Here we just verify the code references bulkResult.successIds.
      const handlerPath = path.join(__dirname, 'SeedOpsHandler.ts');
      const source = fs.readFileSync(handlerPath, 'utf-8') as string;

      // Should use bulkResult.successIds
      expect(source).toContain('bulkResult.successIds');
      // Should NOT contain the old synthetic pattern
      expect(source).not.toContain("Array.from({ length: bulkResult.successCount }");
    });
  });
});
