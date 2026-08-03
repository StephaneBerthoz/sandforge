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
        id: string,
      ): BaseMessage & { payload: { orgId: string; objects: string[] } } => ({
        id,
        type: 'dataops:backup',
        timestamp: Date.now(),
        payload: { orgId, objects: ['Account'] },
      });

      // Both should proceed without blocking (distinct message ids, like the real webview)
      await Promise.all([
        handler.handle(makeMsg('org-A', 'msg-a')),
        handler.handle(makeMsg('org-B', 'msg-b')),
      ]);

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

      const makeMsg = (
        id: string,
      ): BaseMessage & { payload: { orgId: string; objects: string[] } } => ({
        id,
        type: 'dataops:backup',
        timestamp: Date.now(),
        payload: { orgId: 'org-123', objects: ['Account'] },
      });

      // First backup fails
      await handler.handle(makeMsg('msg-1'));

      // Second backup should NOT be blocked (lock was released in finally);
      // the retry arrives with a fresh message id, like the real webview.
      await handler.handle(makeMsg('msg-2'));

      const warnCalls = (deps.log as ReturnType<typeof vi.fn>).mock.calls.filter((c: string[]) =>
        c[0].includes('[WARN]'),
      );
      expect(warnCalls).toHaveLength(0);

      vi.restoreAllMocks();
    });
  });

  describe('payload validation', () => {
    it('rejects dataops:backup with injection-shaped object names', async () => {
      const msg = {
        id: 'bad-backup',
        type: 'dataops:backup',
        timestamp: Date.now(),
        payload: { orgId: 'org-1', objects: ['Account; DROP TABLE'] },
      } as BaseMessage;

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const errMsg = postToWebview.mock.calls[0][0] as {
        type: string;
        payload: { code: string };
      };
      expect(errMsg.type).toBe('dataops:error');
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
    });

    it('rejects dataops:rollback without operationId', async () => {
      const msg = {
        id: 'bad-rollback',
        type: 'dataops:rollback',
        timestamp: Date.now(),
        payload: { orgId: 'org-1' },
      } as BaseMessage;

      await handler.handle(msg);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const errMsg = postToWebview.mock.calls[0][0] as { payload: { code: string } };
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
    });

    it('rejects precheck:pii-scan with empty object list', async () => {
      const msg = {
        id: 'bad-pii',
        type: 'precheck:pii-scan',
        timestamp: Date.now(),
        payload: { orgId: 'org-1', objectNames: [] },
      } as BaseMessage;

      await handler.handle(msg);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const errMsg = postToWebview.mock.calls[0][0] as { payload: { code: string } };
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
    });
  });

  describe('backup retention (backup.maxCount)', () => {
    function createInMemoryConfigStore() {
      const data: Record<string, { value: string; category: string }> = {};
      return {
        get: vi.fn(<T>(key: string): T | undefined => {
          const entry = data[key];
          return entry ? (JSON.parse(entry.value) as T) : undefined;
        }),
        set: vi.fn(<T>(key: string, value: T, category: string): void => {
          data[key] = { value: JSON.stringify(value), category };
        }),
        delete: vi.fn((key: string): boolean => {
          if (!(key in data)) return false;
          delete data[key];
          return true;
        }),
        has: vi.fn((key: string): boolean => key in data),
        getKeysByPrefix: vi.fn((prefix: string): string[] =>
          Object.keys(data).filter((k) => k.startsWith(prefix)),
        ),
        getByCategory: vi.fn(),
        getAllKeys: vi.fn(() => Object.keys(data)),
        clearCategory: vi.fn(),
        clearAll: vi.fn(),
        initialize: vi.fn(),
      };
    }

    it('prunes oldest backups beyond sandforge.backup.maxCount for the org', async () => {
      // Pin the connection mock explicitly — this file registers several
      // hoisted vi.mock factories for ConnectionHelper, so the resolved
      // implementation is set per-test rather than via a new factory.
      const { getJsforceConnection } = await import('../../core/connection/ConnectionHelper.js');
      vi.mocked(getJsforceConnection).mockResolvedValue({
        query: vi.fn().mockResolvedValue({ records: [] }),
      } as never);

      const configStore = createInMemoryConfigStore();
      // Two pre-existing backups for org-1 (older timestamps) + one for org-2.
      configStore.set(
        'backup:old-1',
        {
          operationId: 'old-1',
          orgId: 'org-1',
          objects: [{ objectApiName: 'Account', recordCount: 1 }],
          timestamp: '2026-01-01T00:00:00.000Z',
          totalRecords: 1,
        },
        'backups',
      );
      configStore.set('backup:old-1:Account', [{ Id: 'r1' }], 'backups');
      configStore.set(
        'backup:old-2',
        {
          operationId: 'old-2',
          orgId: 'org-1',
          objects: [{ objectApiName: 'Contact', recordCount: 1 }],
          timestamp: '2026-02-01T00:00:00.000Z',
          totalRecords: 1,
        },
        'backups',
      );
      configStore.set('backup:old-2:Contact', [{ Id: 'r2' }], 'backups');
      configStore.set(
        'backup:other-org',
        {
          operationId: 'other-org',
          orgId: 'org-2',
          objects: [],
          timestamp: '2025-01-01T00:00:00.000Z',
          totalRecords: 0,
        },
        'backups',
      );

      deps.configStore = configStore as unknown as HandlerDeps['configStore'];
      deps.services = {
        getSandforgeSetting: (key: string, fallback: unknown) =>
          key === 'backup.maxCount' ? 2 : fallback,
      } as unknown as HandlerDeps['services'];

      const msg: BaseMessage & { payload: { orgId: string; objects: string[] } } = {
        id: 'new-backup',
        type: 'dataops:backup',
        timestamp: Date.now(),
        payload: { orgId: 'org-1', objects: ['Account'] },
      };
      await handler.handle(msg);

      // maxCount=2: oldest org-1 backup (old-1) pruned with its record payload;
      // newest (old-2) + the fresh one kept; other org untouched.
      expect(configStore.has('backup:old-1')).toBe(false);
      expect(configStore.has('backup:old-1:Account')).toBe(false);
      expect(configStore.has('backup:old-2')).toBe(true);
      expect(configStore.has('backup:new-backup')).toBe(true);
      expect(configStore.has('backup:other-org')).toBe(true);

      vi.restoreAllMocks();
    });
  });
});
