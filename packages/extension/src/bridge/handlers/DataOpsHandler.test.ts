import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataOpsHandler } from './DataOpsHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import type { BaseMessage } from '@sandforge/shared';
import { inboundRequest } from '../../test/mockFactories.js';

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
    const msg: InboundRequest = inboundRequest({
      id: '1',
      type: 'unknown:type',
      timestamp: Date.now(),
    });
    const result = await handler.handle(msg);
    expect(result).toBe(false);
  });

  it('returns true for handled message types and response includes correlationId', async () => {
    const msg: InboundRequest & { payload: Record<string, unknown> } = inboundRequest({
      id: 'req-dataops-1',
      type: 'dataops:anonymization-templates',
      timestamp: Date.now(),
      payload: {},
    });
    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      correlationId?: string;
    };
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
      ): InboundRequest & { payload: { orgId: string; objects: string[] } } =>
        inboundRequest({
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
      const { getJsforceConnection } = await import('../../core/connection/ConnectionHelper.js');
      vi.mocked(getJsforceConnection).mockResolvedValue({
        describe: vi.fn().mockResolvedValue({ fields: [{ name: 'Id' }] }),
        query: vi.fn().mockResolvedValue({ records: [] }),
      } as never);

      const makeMsg = (
        orgId: string,
        id: string,
      ): InboundRequest & { payload: { orgId: string; objects: string[] } } =>
        inboundRequest({
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
      ): InboundRequest & { payload: { orgId: string; objects: string[] } } =>
        inboundRequest({
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

  describe('dataops:error channel', () => {
    /** Extracts all messages posted to the webview. */
    function postedMessages(): Array<
      BaseMessage & { payload: { message?: string; error?: string } }
    > {
      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      return postToWebview.mock.calls.map((c) => c[0]);
    }

    it('emits dataops:error with the real message exactly once when backup fails', async () => {
      // Pin the connection mock explicitly — this file registers several
      // hoisted vi.mock factories for ConnectionHelper, so the resolved
      // implementation is set per-test rather than via a new factory
      // (same rule as the backup-retention test below).
      vi.mock('../../core/connection/ConnectionHelper.js', () => ({
        getJsforceConnection: vi.fn(),
      }));
      const { getJsforceConnection } = await import('../../core/connection/ConnectionHelper.js');
      vi.mocked(getJsforceConnection).mockRejectedValue(new Error('connection failed'));

      const msg: InboundRequest & {
        payload: { orgId: string; objects: string[] };
      } = inboundRequest({
        id: 'msg-b1',
        type: 'dataops:backup',
        timestamp: Date.now(),
        payload: { orgId: 'org-123', objects: ['Account'] },
      });

      await handler.handle(msg);

      const posted = postedMessages();
      const errors = posted.filter((m) => m.type === 'dataops:error');
      expect(errors).toHaveLength(1);
      expect(errors[0].payload.message).toBe('connection failed');
      // The operation:failed lifecycle message is preserved alongside.
      const opFailed = posted.filter((m) => m.type === 'operation:failed');
      expect(opFailed).toHaveLength(1);
      expect(opFailed[0].payload.error).toBe('connection failed');

      vi.restoreAllMocks();
    });

    it('emits dataops:error once when anonymize is declined at the production guard', async () => {
      deps.infraServices = {
        performanceTracker: undefined,
        productionGuard: {
          check: vi.fn().mockReturnValue({ allowed: true }),
          logOperation: vi.fn(),
          confirmIfNeeded: vi.fn().mockResolvedValue(false),
        },
        offlineManager: undefined,
        piiDetector: undefined,
      } as unknown as NonNullable<HandlerDeps['infraServices']>;

      const msg: InboundRequest & {
        payload: { orgId: string; templateId: string; objects: string[] };
      } = inboundRequest({
        id: 'msg-a1',
        type: 'dataops:anonymize',
        timestamp: Date.now(),
        payload: {
          orgId: 'org-123',
          templateId: 'tmpl-1',
          objects: ['Account'],
        },
      });

      await handler.handle(msg);

      const posted = postedMessages();
      const errors = posted.filter((m) => m.type === 'dataops:error');
      expect(errors).toHaveLength(1);
      expect(errors[0].payload.message).toBe(
        'Operation cancelled by user (production confirmation declined).',
      );
      expect(posted.filter((m) => m.type === 'operation:failed')).toHaveLength(1);
    });
  });

  describe('payload validation', () => {
    it('rejects dataops:backup with injection-shaped object names', async () => {
      const msg = inboundRequest({
        id: 'bad-backup',
        type: 'dataops:backup',
        timestamp: Date.now(),
        payload: { orgId: 'org-1', objects: ['Account; DROP TABLE'] },
      } as BaseMessage);

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
      const msg = inboundRequest({
        id: 'bad-rollback',
        type: 'dataops:rollback',
        timestamp: Date.now(),
        payload: { orgId: 'org-1' },
      } as BaseMessage);

      await handler.handle(msg);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const errMsg = postToWebview.mock.calls[0][0] as {
        payload: { code: string };
      };
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
    });

    it('rejects precheck:pii-scan with empty object list', async () => {
      const msg = inboundRequest({
        id: 'bad-pii',
        type: 'precheck:pii-scan',
        timestamp: Date.now(),
        payload: { orgId: 'org-1', objectNames: [] },
      } as BaseMessage);

      await handler.handle(msg);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const errMsg = postToWebview.mock.calls[0][0] as {
        payload: { code: string };
      };
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
        describe: vi.fn().mockResolvedValue({ fields: [{ name: 'Id' }, { name: 'Name' }] }),
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

      const msg: InboundRequest & {
        payload: { orgId: string; objects: string[] };
      } = inboundRequest({
        id: 'new-backup',
        type: 'dataops:backup',
        timestamp: Date.now(),
        payload: { orgId: 'org-1', objects: ['Account'] },
      });
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

  describe('rollback safety', () => {
    /**
     * Describe fixture where only `Name` is writable; system fields are not.
     *
     * `permissionable` is carried deliberately, and it is what a real describe
     * returns: FLS cannot be set on Id or on the audit datetimes, so Salesforce
     * reports them `permissionable: false`. Leaving it out is what made an
     * earlier version of this fixture unable to distinguish "nobody may write
     * this" from "this org may not write this" — the very distinction the
     * restore depends on.
     */
    const accountDescribe = {
      name: 'Account',
      label: 'Account',
      labelPlural: 'Accounts',
      keyPrefix: '001',
      custom: false,
      createable: true,
      updateable: true,
      deletable: true,
      queryable: true,
      fields: [
        {
          name: 'Id',
          label: 'Id',
          type: 'id',
          createable: false,
          updateable: false,
          permissionable: false,
        },
        {
          name: 'Name',
          label: 'Name',
          type: 'string',
          createable: true,
          updateable: true,
          permissionable: true,
        },
        {
          name: 'CreatedDate',
          label: 'Created Date',
          type: 'datetime',
          createable: false,
          updateable: false,
          permissionable: false,
        },
        {
          name: 'LastModifiedDate',
          label: 'Last Modified Date',
          type: 'datetime',
          createable: false,
          updateable: false,
          permissionable: false,
        },
        {
          name: 'SystemModstamp',
          label: 'System Modstamp',
          type: 'datetime',
          createable: false,
          updateable: false,
          permissionable: false,
        },
      ],
      recordTypeInfos: [],
      childRelationships: [],
    };

    /** A backup record as `SELECT FIELDS(ALL)` returns it — system fields included. */
    const backedUpRecord = {
      attributes: { type: 'Account', url: '/x' },
      Id: '001000000000001',
      Name: 'Acme',
      CreatedDate: '2026-01-01T00:00:00.000Z',
      LastModifiedDate: '2026-01-02T00:00:00.000Z',
      SystemModstamp: '2026-01-02T00:00:00.000Z',
    };

    /** Wires a connection whose describe/upsert are observable. */
    async function mockConnection(describe: Record<string, unknown> = accountDescribe): Promise<{
      upsert: ReturnType<typeof vi.fn>;
      describe: ReturnType<typeof vi.fn>;
    }> {
      const upsert = vi.fn().mockResolvedValue([{ success: true, id: '001000000000001' }]);
      const describeFn = vi.fn().mockResolvedValue(describe);
      const { getJsforceConnection } = await import('../../core/connection/ConnectionHelper.js');
      vi.mocked(getJsforceConnection).mockResolvedValue({
        describe: describeFn,
        sobject: vi.fn(() => ({ upsert })),
      } as never);
      return { upsert, describe: describeFn };
    }

    /** ConfigStore stub holding one backup (meta + records) for `metaOrgId`. */
    function configStoreWithBackup(
      metaOrgId: string,
      records: Record<string, unknown>[] = [backedUpRecord],
    ): HandlerDeps['configStore'] {
      const entries: Record<string, unknown> = {
        'backup:bk-1': {
          operationId: 'bk-1',
          orgId: metaOrgId,
          objects: [{ objectApiName: 'Account', recordCount: records.length }],
          totalRecords: records.length,
        },
        'backup:bk-1:Account': records,
      };
      return {
        get: vi.fn((key: string) => entries[key]),
        set: vi.fn(),
        delete: vi.fn(),
        has: vi.fn((key: string) => key in entries),
        getKeysByPrefix: vi.fn((prefix: string) =>
          Object.keys(entries).filter((k) => k.startsWith(prefix)),
        ),
      } as unknown as HandlerDeps['configStore'];
    }

    /** Rollback message targeting `orgId` with the stored backup. */
    function rollbackMsg(orgId: string, id = 'msg-rb'): InboundRequest {
      return inboundRequest({
        id,
        type: 'dataops:rollback',
        timestamp: Date.now(),
        payload: { orgId, operationId: 'bk-1' },
      } as BaseMessage);
    }

    /** All messages posted to the webview. */
    function posted(): Array<BaseMessage & { payload: { message?: string; error?: string } }> {
      return (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    }

    it('refuses to restore a backup taken from another org', async () => {
      const { upsert } = await mockConnection();
      deps.configStore = configStoreWithBackup('org-B');

      await handler.handle(rollbackMsg('org-A'));

      expect(upsert).not.toHaveBeenCalled();
      const errors = posted().filter((m) => m.type === 'dataops:error');
      expect(errors).toHaveLength(1);
      expect(errors[0].payload.message).toContain('was taken from org org-B');
      expect(errors[0].payload.message).toContain('cannot be restored into org org-A');
    });

    it('blocks a rollback the Production Guard refuses', async () => {
      const { upsert } = await mockConnection();
      deps.configStore = configStoreWithBackup('org-prod');
      (deps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockReturnValue({
        orgType: 'Production',
      });
      const check = vi.fn().mockReturnValue({
        allowed: false,
        requiresConfirmation: false,
        requiresApproval: false,
        blockedReason: 'Production writes are blocked',
        warnings: [],
        impactSummary: '',
      });
      const logOperation = vi.fn();
      deps.infraServices = {
        productionGuard: { check, logOperation, confirmIfNeeded: vi.fn() },
      } as unknown as NonNullable<HandlerDeps['infraServices']>;

      await handler.handle(rollbackMsg('org-prod'));

      expect(upsert).not.toHaveBeenCalled();
      expect(check).toHaveBeenCalledWith(
        expect.objectContaining({
          orgTier: 'production',
          operation: 'upsert',
          module: 'dataops',
        }),
      );
      expect(logOperation).toHaveBeenCalledTimes(1);
      const errors = posted().filter((m) => m.type === 'dataops:error');
      expect(errors).toHaveLength(1);
      expect(errors[0].payload.message).toContain('Production writes are blocked');
    });

    it('aborts a rollback when the production confirmation is declined', async () => {
      const { upsert } = await mockConnection();
      deps.configStore = configStoreWithBackup('org-prod');
      (deps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockReturnValue({
        orgType: 'Production',
      });
      deps.infraServices = {
        productionGuard: {
          check: vi.fn().mockReturnValue({
            allowed: true,
            requiresConfirmation: true,
            requiresApproval: false,
            warnings: [],
            impactSummary: 'upsert 1 record',
          }),
          logOperation: vi.fn(),
          confirmIfNeeded: vi.fn().mockResolvedValue(false),
        },
      } as unknown as NonNullable<HandlerDeps['infraServices']>;

      await handler.handle(rollbackMsg('org-prod'));

      expect(upsert).not.toHaveBeenCalled();
      const errors = posted().filter((m) => m.type === 'dataops:error');
      expect(errors).toHaveLength(1);
      expect(errors[0].payload.message).toBe(
        'Operation cancelled by user (production confirmation declined).',
      );
      expect(posted().filter((m) => m.type === 'operation:failed')).toHaveLength(1);
    });

    it('strips system fields from the payload instead of failing the FLS check', async () => {
      const { upsert } = await mockConnection();
      deps.configStore = configStoreWithBackup('org-1');

      await handler.handle(rollbackMsg('org-1'));

      // The restore runs: system fields never reach the write, `Id` stays as
      // the upsert match key, and no FLS error is emitted.
      expect(posted().filter((m) => m.type === 'dataops:error')).toHaveLength(0);
      expect(upsert).toHaveBeenCalledTimes(1);
      expect(upsert.mock.calls[0][0]).toEqual([{ Id: '001000000000001', Name: 'Acme' }]);
      expect(upsert.mock.calls[0][1]).toBe('Id');
      const response = posted().find((m) => m.type === 'dataops:rollback:response');
      expect(response).toBeDefined();
    });

    /**
     * A restore counted only `r.success`. The rejects — validation rules,
     * required fields, triggers — were filtered out and never looked at again,
     * although the local result type already declared their `errors`. So a
     * restore where the org refused 900 records out of 1000 reported
     * "Rollback completed: 100 records restored", `status: 'success'`, and no
     * error anywhere: the user believed the sandbox was back.
     */
    describe('a partly rejected restore', () => {
      /** Three backed-up rows, so a mixed upsert result has something to map to. */
      const threeRecords = ['001000000000001', '001000000000002', '001000000000003'].map((id) => ({
        ...backedUpRecord,
        Id: id,
      }));

      /** The rollback response payload, whatever fields it carries. */
      function rollbackPayload(): Record<string, unknown> | undefined {
        const m = posted().find((x) => x.type === 'dataops:rollback:response');
        return m?.payload as unknown as Record<string, unknown> | undefined;
      }

      /** One row lands, two are refused by the org. */
      async function mixedRestore(): Promise<void> {
        const { upsert } = await mockConnection();
        upsert.mockResolvedValue([
          { success: true, id: '001000000000001' },
          {
            success: false,
            errors: [{ message: 'REQUIRED_FIELD_MISSING: [Industry]' }],
          },
          {
            success: false,
            errors: [{ message: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Rating' }],
          },
        ]);
        deps.configStore = configStoreWithBackup('org-1', threeRecords);
        await handler.handle(rollbackMsg('org-1'));
      }

      it('counts the failures instead of dropping them', async () => {
        await mixedRestore();

        expect(rollbackPayload()?.totalRestored).toBe(1);
        expect(rollbackPayload()?.totalFailed).toBe(2);
      });

      it('calls a partly rejected restore partial, not a success', async () => {
        await mixedRestore();

        // Same three words Seed and Sync use for a run that did not fully land.
        expect(rollbackPayload()?.status).toBe('partial');
        expect(rollbackPayload()?.message).toContain('2');
        expect(rollbackPayload()?.message).not.toBe('Rollback completed: 1 records restored');
      });

      it('carries a sample of what the org said', async () => {
        await mixedRestore();

        expect(rollbackPayload()?.errors).toEqual([
          {
            objectApiName: 'Account',
            message: 'REQUIRED_FIELD_MISSING: [Industry]',
          },
          {
            objectApiName: 'Account',
            message: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Rating',
          },
        ]);
      });

      it('tells the user, who only ever sees the error and notification channels', async () => {
        await mixedRestore();

        const notes = posted().filter((m) => m.type === 'notification');
        expect(notes).toHaveLength(1);
        expect(notes[0].payload.message).toContain('REQUIRED_FIELD_MISSING');
      });

      it('calls a restore the org refused outright a failure', async () => {
        const { upsert } = await mockConnection();
        upsert.mockResolvedValue([
          { success: false, errors: [{ message: 'ENTITY_IS_DELETED' }] },
          { success: false, errors: [{ message: 'ENTITY_IS_DELETED' }] },
          { success: false, errors: [{ message: 'ENTITY_IS_DELETED' }] },
        ]);
        deps.configStore = configStoreWithBackup('org-1', threeRecords);

        await handler.handle(rollbackMsg('org-1'));

        expect(rollbackPayload()?.status).toBe('failure');
        expect(rollbackPayload()?.totalRestored).toBe(0);
        expect(rollbackPayload()?.totalFailed).toBe(3);
      });

      it('leaves a clean restore saying success', async () => {
        await mockConnection();
        deps.configStore = configStoreWithBackup('org-1');

        await handler.handle(rollbackMsg('org-1'));

        expect(rollbackPayload()?.status).toBe('success');
        expect(rollbackPayload()?.totalFailed).toBe(0);
        expect(posted().filter((m) => m.type === 'notification')).toHaveLength(0);
      });
    });

    it('still refuses the rollback when a business field is not writable', async () => {
      const readOnlyName = {
        ...accountDescribe,
        fields: accountDescribe.fields.map((f) =>
          f.name === 'Name' ? { ...f, createable: false, updateable: false } : f,
        ),
      };
      const { upsert } = await mockConnection(readOnlyName);
      deps.configStore = configStoreWithBackup('org-1');

      await handler.handle(rollbackMsg('org-1'));

      expect(upsert).not.toHaveBeenCalled();
      const errors = posted().filter((m) => m.type === 'dataops:error');
      expect(errors).toHaveLength(1);
      expect(errors[0].payload.message).toContain('Name');
      expect(errors[0].payload.message).toContain('FLS violation');
    });
  });

  describe('backup query validity', () => {
    /**
     * `SELECT FIELDS(ALL) ... LIMIT 2000` is not a query Salesforce runs:
     * FIELDS(ALL) is capped at LIMIT 200, so the org rejected the backup query
     * for every object and the records only arrived through
     * queryWithFieldsFallback's describe-and-retry — three round trips to do
     * the work of two. The connection below answers exactly like the org.
     */
    function mockOrg(records: Record<string, unknown>[], fields: string[]) {
      const query = vi.fn(async (soql: string) => {
        if (soql.includes('FIELDS(')) {
          throw new Error(
            'MALFORMED_QUERY: The SOQL FIELDS function must have a LIMIT of at most 200',
          );
        }
        return { records, done: true };
      });
      const describe = vi.fn().mockResolvedValue({ fields: fields.map((name) => ({ name })) });
      return {
        query,
        describe,
        sobject: vi.fn(() => ({ update: vi.fn(), upsert: vi.fn() })),
      };
    }

    /** All messages posted to the webview. */
    function posted(): Array<BaseMessage & { payload: Record<string, unknown> }> {
      return (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    }

    beforeEach(() => {
      // Sandbox tier → defaultQueryLimit 2000, ten times the FIELDS(ALL) cap.
      (deps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockReturnValue({
        orgType: 'Sandbox',
      });
    });

    it('backs up each object with one query the org accepts, not a rejected FIELDS(ALL)', async () => {
      const conn = mockOrg(
        [{ Id: '001', Name: 'Acme', Custom__c: 'x' }],
        ['Id', 'Name', 'Custom__c'],
      );
      const { getJsforceConnection } = await import('../../core/connection/ConnectionHelper.js');
      vi.mocked(getJsforceConnection).mockResolvedValue(conn as never);
      // The default stub has no getKeysByPrefix, which retention needs.
      deps.configStore = {
        get: vi.fn(() => undefined),
        set: vi.fn(),
        delete: vi.fn(),
        getKeysByPrefix: vi.fn(() => []),
      } as unknown as HandlerDeps['configStore'];

      await handler.handle(
        inboundRequest({
          id: 'bk-query',
          type: 'dataops:backup',
          timestamp: Date.now(),
          payload: { orgId: 'org-1', objects: ['Account'] },
        } as BaseMessage),
      );

      // One describe + one query per object: no rejected first attempt.
      expect(conn.query).toHaveBeenCalledTimes(1);
      expect(conn.query.mock.calls[0][0]).toBe(
        'SELECT Id, Name, Custom__c FROM Account LIMIT 2000',
      );
      expect(conn.describe).toHaveBeenCalledTimes(1);
      // The LIMIT and the columns are unchanged, so the snapshot is the same.
      expect(posted().filter((m) => m.type === 'dataops:error')).toHaveLength(0);
      const response = posted().find((m) => m.type === 'dataops:backup:response');
      expect(response?.payload.totalRecords).toBe(1);
    });

    it('anonymize reads its records with the same first-attempt query', async () => {
      const conn = mockOrg([], ['Id', 'FirstName', 'Email']);
      const { getJsforceConnection } = await import('../../core/connection/ConnectionHelper.js');
      vi.mocked(getJsforceConnection).mockResolvedValue(conn as never);

      await handler.handle(
        inboundRequest({
          id: 'an-query',
          type: 'dataops:anonymize',
          timestamp: Date.now(),
          payload: {
            orgId: 'org-1',
            templateId: 'tpl-gdpr-standard',
            objects: ['Contact'],
          },
        } as BaseMessage),
      );

      expect(conn.query).toHaveBeenCalledTimes(1);
      expect(conn.query.mock.calls[0][0]).toBe(
        'SELECT Id, FirstName, Email FROM Contact LIMIT 2000',
      );
      expect(posted().filter((m) => m.type === 'dataops:error')).toHaveLength(0);
    });
  });

  /**
   * Anonymization counted its writes exactly the way the restore did — only
   * `r.success` — and always answered `status: 'success'`. A masking run the
   * org rejected therefore reported fewer records processed and called itself
   * done, leaving unmasked PII in a sandbox the user believed was scrubbed.
   */
  describe('a partly rejected anonymization', () => {
    /** A Contact describe the FLS guard accepts, and `selectAllFields` reads. */
    const contactDescribe = {
      name: 'Contact',
      label: 'Contact',
      createable: true,
      updateable: true,
      deletable: true,
      queryable: true,
      fields: [
        {
          name: 'Id',
          label: 'Id',
          type: 'id',
          createable: false,
          updateable: false,
        },
        {
          name: 'FirstName',
          label: 'First Name',
          type: 'string',
          createable: true,
          updateable: true,
          permissionable: true,
        },
      ],
      recordTypeInfos: [],
      childRelationships: [],
    };

    /** All messages posted to the webview. */
    function posted(): Array<BaseMessage & { payload: Record<string, unknown> }> {
      return (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    }

    /** The anonymize response payload, whatever fields it carries. */
    function anonymizePayload(): Record<string, unknown> | undefined {
      return posted().find((m) => m.type === 'dataops:anonymize:response')?.payload;
    }

    /** Two contacts read, one masked, one refused by the org. */
    async function mixedAnonymize(): Promise<void> {
      const update = vi.fn().mockResolvedValue([
        { success: true, id: '003000000000001' },
        {
          success: false,
          errors: [{ message: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Locked' }],
        },
      ]);
      const query = vi.fn(async () => ({
        records: [
          { Id: '003000000000001', FirstName: 'Ada' },
          { Id: '003000000000002', FirstName: 'Grace' },
        ],
        done: true,
      }));
      const { getJsforceConnection } = await import('../../core/connection/ConnectionHelper.js');
      vi.mocked(getJsforceConnection).mockResolvedValue({
        query,
        describe: vi.fn().mockResolvedValue(contactDescribe),
        sobject: vi.fn(() => ({ update })),
      } as never);
      (deps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockReturnValue({
        orgType: 'Sandbox',
      });

      await handler.handle(
        inboundRequest({
          id: 'an-partial',
          type: 'dataops:anonymize',
          timestamp: Date.now(),
          payload: {
            orgId: 'org-1',
            templateId: 'tpl-gdpr-standard',
            objects: ['Contact'],
          },
        } as BaseMessage),
      );
    }

    it('counts the records the org refused to mask', async () => {
      await mixedAnonymize();

      expect(anonymizePayload()?.recordsProcessed).toBe(1);
      expect(anonymizePayload()?.recordsFailed).toBe(1);
    });

    it('calls it partial, not a completed anonymization', async () => {
      await mixedAnonymize();

      expect(anonymizePayload()?.status).toBe('partial');
      expect(anonymizePayload()?.message).not.toBe('Anonymization completed: 1 records processed.');
    });

    it('tells the user what the org said', async () => {
      await mixedAnonymize();

      const notes = posted().filter((m) => m.type === 'notification');
      expect(notes).toHaveLength(1);
      expect(notes[0].payload.message).toContain('FIELD_CUSTOM_VALIDATION_EXCEPTION');
    });
  });

  describe('dataops:error correlation', () => {
    /**
     * `sendHandlerError` used to stamp `correlationId` only when handed the
     * request, as an optional 8th argument; its origin is now required, so
     * these tests pin the behaviour rather than a call-site habit.
     * `useMessageResponse` drops a response whose correlationId does
     * not match its own request — but accepts one carrying none, so an
     * uncorrelated `dataops:error` settled whichever dataops mutation was in
     * flight: a failed `backup:export` closed a running restore with the wrong
     * message.
     */
    function errors(): Array<BaseMessage & { correlationId?: string }> {
      return (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => c[0] as BaseMessage)
        .filter((m) => m.type === 'dataops:error');
    }

    it('correlates a backup failure to the backup request', async () => {
      const { getJsforceConnection } = await import('../../core/connection/ConnectionHelper.js');
      vi.mocked(getJsforceConnection).mockRejectedValue(new Error('connection failed'));

      await handler.handle(
        inboundRequest({
          id: 'backup-req',
          type: 'dataops:backup',
          timestamp: Date.now(),
          payload: { orgId: 'org-1', objects: ['Account'] },
        } as BaseMessage),
      );

      expect(errors()).toHaveLength(1);
      expect(errors()[0].correlationId).toBe('backup-req');
    });

    it('correlates a backup:export miss to the export request, not to a restore in flight', async () => {
      deps.configStore = {
        get: vi.fn(() => undefined),
        set: vi.fn(),
        getKeysByPrefix: vi.fn(() => []),
      } as unknown as HandlerDeps['configStore'];

      await handler.handle(
        inboundRequest({
          id: 'export-req',
          type: 'backup:export',
          timestamp: Date.now(),
          payload: { orgId: 'org-1', operationId: 'missing-op' },
        } as BaseMessage),
      );

      expect(errors()).toHaveLength(1);
      // The restore started under `restore-req` keeps running: this error is
      // addressed to the export, and the webview matches on correlationId.
      expect(errors()[0].correlationId).toBe('export-req');
      expect(errors()[0].correlationId).not.toBe('restore-req');
    });

    it('correlates a refused rollback to the rollback request', async () => {
      const { getJsforceConnection } = await import('../../core/connection/ConnectionHelper.js');
      vi.mocked(getJsforceConnection).mockResolvedValue({
        describe: vi.fn().mockResolvedValue({ fields: [] }),
        sobject: vi.fn(() => ({ upsert: vi.fn() })),
      } as never);
      deps.configStore = {
        get: vi.fn((key: string) =>
          key === 'backup:bk-1'
            ? {
                operationId: 'bk-1',
                orgId: 'org-OTHER',
                objects: [],
                totalRecords: 0,
              }
            : undefined,
        ),
        set: vi.fn(),
        getKeysByPrefix: vi.fn(() => []),
      } as unknown as HandlerDeps['configStore'];

      await handler.handle(
        inboundRequest({
          id: 'restore-req',
          type: 'dataops:rollback',
          timestamp: Date.now(),
          payload: { orgId: 'org-1', operationId: 'bk-1' },
        } as BaseMessage),
      );

      expect(errors()).toHaveLength(1);
      expect(errors()[0].correlationId).toBe('restore-req');
    });
  });
});
