import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataOpsHandler } from './DataOpsHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import type { BaseMessage } from '@sandforge/shared';
import { inboundRequest } from '../../test/mockFactories.js';
import { ErrorResolver } from '../../modules/ai/ErrorResolver.js';
import type { AIProvider } from '../../modules/ai/ErrorResolver.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import type { ConfigEntry } from '../../core/storage/ConfigStoreBackend.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { LineageStore } from '../../modules/audit/lineage.js';

/* The connection helper is replaced for the whole file: vi.mock is hoisted above
   the imports whichever block it is written in, so one factory is all there
   ever was. Each test sets the behaviour it needs on getJsforceConnection. */
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

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
      // Answered, not left undefined: retention reads it after every backup,
      // and a store that throws there is a different test from the one each
      // case here is written for.
      getKeysByPrefix: vi.fn(() => [] as string[]),
      // The template list reads the templates the user saved from here.
      getByCategory: vi.fn(() => ({})),
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
          type: 'backup:execute',
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
          type: 'backup:execute',
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
      const { getJsforceConnection } = await import('../../core/connection/ConnectionHelper.js');
      vi.mocked(getJsforceConnection).mockRejectedValue(new Error('connection failed'));

      const makeMsg = (
        id: string,
      ): InboundRequest & { payload: { orgId: string; objects: string[] } } =>
        inboundRequest({
          id,
          type: 'backup:execute',
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
      const { getJsforceConnection } = await import('../../core/connection/ConnectionHelper.js');
      vi.mocked(getJsforceConnection).mockRejectedValue(new Error('connection failed'));

      const msg: InboundRequest & {
        payload: { orgId: string; objects: string[] };
      } = inboundRequest({
        id: 'msg-b1',
        type: 'backup:execute',
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

    it('tells the model which module and request a failed backup came from', async () => {
      // The prompt is all the model sees: an org error with no run behind it
      // gets an answer that fits any operation.
      const { getJsforceConnection } = await import('../../core/connection/ConnectionHelper.js');
      vi.mocked(getJsforceConnection).mockRejectedValue(
        new Error('SOMETHING_WE_HAVE_NEVER_SEEN: odd'),
      );
      const provider = vi.fn<AIProvider>(() =>
        Promise.resolve(JSON.stringify({ explanation: 'why', suggestions: [], confidence: 0.4 })),
      );
      deps.errorResolver = new ErrorResolver(provider);
      deps.broker = {
        postToWebview: vi.fn(),
        panelCount: 1,
        showFixSuggestion: vi.fn(),
      } as unknown as HandlerDeps['broker'];

      await handler.handle(
        inboundRequest({
          id: 'msg-b2',
          type: 'backup:execute',
          timestamp: Date.now(),
          payload: { orgId: 'org-123', objects: ['Account'] },
        }),
      );
      await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));

      const [prompt] = provider.mock.calls[0];
      expect(prompt).toContain('Module: dataops');
      expect(prompt).toContain('Operation: backup:execute');

      vi.restoreAllMocks();
    });

    it('names the object a backup was reading when it failed, not the whole request', async () => {
      // A backup walks its objects one at a time, so a failure has one object
      // behind it — the run's list would point the answer at the wrong one.
      const { getJsforceConnection } = await import('../../core/connection/ConnectionHelper.js');
      vi.mocked(getJsforceConnection).mockResolvedValue({
        describe: vi.fn().mockResolvedValue({ fields: [{ name: 'Id' }] }),
        query: vi.fn((soql: string) =>
          soql.includes('FROM Contact')
            ? Promise.reject(new Error('SOMETHING_WE_HAVE_NEVER_SEEN: odd'))
            : Promise.resolve({ records: [], done: true }),
        ),
      } as never);
      const provider = vi.fn<AIProvider>(() =>
        Promise.resolve(JSON.stringify({ explanation: 'why', suggestions: [], confidence: 0.4 })),
      );
      deps.errorResolver = new ErrorResolver(provider);
      deps.broker = {
        postToWebview: vi.fn(),
        panelCount: 1,
        showFixSuggestion: vi.fn(),
      } as unknown as HandlerDeps['broker'];

      await handler.handle(
        inboundRequest({
          id: 'msg-b3',
          type: 'backup:execute',
          timestamp: Date.now(),
          payload: { orgId: 'org-123', objects: ['Account', 'Contact'] },
        }),
      );
      await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));

      const [prompt] = provider.mock.calls[0];
      expect(prompt).toContain('Target object: Contact');
      expect(prompt).not.toContain('Target object: Account');

      vi.restoreAllMocks();
    });

    it('names the objects a masking run addresses to the production guard', async () => {
      const check = vi.fn().mockReturnValue({
        allowed: true,
        requiresConfirmation: false,
        requiresApproval: false,
        warnings: [],
        impactSummary: '',
      });
      deps.infraServices = {
        performanceTracker: undefined,
        productionGuard: { check, logOperation: vi.fn(), confirmIfNeeded: vi.fn() },
        offlineManager: undefined,
        piiDetector: undefined,
      } as unknown as NonNullable<HandlerDeps['infraServices']>;

      await handler.handle(
        inboundRequest({
          id: 'msg-a2',
          type: 'dataops:anonymize',
          timestamp: Date.now(),
          payload: {
            orgId: 'org-123',
            templateId: 'tmpl-1',
            objects: ['Account', 'Contact'],
          },
        } as BaseMessage),
      );

      expect(check.mock.calls[0][0]).toMatchObject({
        operation: 'update',
        objectName: 'Account, Contact',
        recordCount: 'unknown',
        module: 'dataops',
      });
    });

    it('names the objects of the template to the production guard when the request lists none', async () => {
      const check = vi.fn().mockReturnValue({
        allowed: true,
        requiresConfirmation: false,
        requiresApproval: false,
        warnings: [],
        impactSummary: '',
      });
      deps.infraServices = {
        performanceTracker: undefined,
        productionGuard: { check, logOperation: vi.fn(), confirmIfNeeded: vi.fn() },
        offlineManager: undefined,
        piiDetector: undefined,
      } as unknown as NonNullable<HandlerDeps['infraServices']>;

      await handler.handle(
        inboundRequest({
          id: 'msg-a3',
          type: 'dataops:anonymize',
          timestamp: Date.now(),
          payload: { orgId: 'org-123', templateId: 'tpl-gdpr-standard' },
        } as BaseMessage),
      );

      // The GDPR template masks Contact, then Lead, then Account fields.
      expect(check.mock.calls[0][0]).toMatchObject({
        operation: 'update',
        objectName: 'Contact, Lead, Account',
        recordCount: 'unknown',
        module: 'dataops',
      });
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

    it('asks before masking an org the registry does not know, and opens no connection when declined', async () => {
      // A real guard, and getOrg left unstubbed: nothing shows 'org-unknown'
      // is a sandbox. It was classed as development, so the masking started
      // without a word to the user.
      const { getJsforceConnection } = await import('../../core/connection/ConnectionHelper.js');
      vi.mocked(getJsforceConnection).mockClear();
      const requestConfirmation = vi.fn().mockResolvedValue(false);
      const guard = new ProductionGuard({ requestConfirmation });
      deps.infraServices = {
        performanceTracker: undefined,
        productionGuard: guard,
        offlineManager: undefined,
        piiDetector: undefined,
      } as unknown as NonNullable<HandlerDeps['infraServices']>;

      await handler.handle(
        inboundRequest({
          id: 'msg-a4',
          type: 'dataops:anonymize',
          timestamp: Date.now(),
          payload: { orgId: 'org-unknown', templateId: 'tpl-gdpr-standard', objects: ['Contact'] },
        } as BaseMessage),
      );

      expect(requestConfirmation).toHaveBeenCalledWith(
        'UPDATE an unknown number of Contact record(s) on production org org-unknown [module: dataops]',
      );
      expect(guard.getAuditLog().map((entry) => entry.request.orgTier)).toEqual(['production']);
      expect(getJsforceConnection).not.toHaveBeenCalled();
      const errors = postedMessages().filter((m) => m.type === 'dataops:error');
      expect(errors).toHaveLength(1);
      expect(errors[0].payload.message).toBe(
        'Operation cancelled by user (production confirmation declined).',
      );
    });
  });

  describe('payload validation', () => {
    it('rejects backup:execute with injection-shaped object names', async () => {
      const msg = inboundRequest({
        id: 'bad-backup',
        type: 'backup:execute',
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
        type: 'backup:execute',
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

  describe('background registry', () => {
    let registry: BackgroundOperationRegistry;
    /** Lifecycle events the registry emitted, in order. */
    let events: string[];

    beforeEach(() => {
      registry = new BackgroundOperationRegistry();
      events = [];
      registry.onEvent((_operationId, type) => events.push(type));
      // The registry reaches a handler through the shared infra bundle, the
      // way composition supplies it.
      deps.infraServices = {
        backgroundRegistry: registry,
      } as unknown as NonNullable<HandlerDeps['infraServices']>;
    });

    it('stops a backup before the next object when the registry is disposed', async () => {
      const describe = vi.fn().mockResolvedValue({ fields: [{ name: 'Id' }] });
      // The first object's read is what the dispose lands in the middle of.
      let disposed = false;
      const query = vi.fn(async () => {
        if (!disposed) {
          registry.dispose();
          disposed = true;
        }
        return { records: [{ Id: '001' }], done: true };
      });
      const { getJsforceConnection } = await import('../../core/connection/ConnectionHelper.js');
      vi.mocked(getJsforceConnection).mockResolvedValue({ query, describe } as never);
      (deps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockReturnValue({ orgType: 'Sandbox' });

      await handler.handle(
        inboundRequest({
          id: 'bk-dispose',
          type: 'backup:execute',
          timestamp: Date.now(),
          payload: { orgId: 'org-1', objects: ['Account', 'Contact', 'Opportunity'] },
        } as BaseMessage),
      );

      // Only the object that was already under way was read.
      expect(query).toHaveBeenCalledTimes(1);
      const posted = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[0] as BaseMessage,
      );
      expect(posted.filter((m) => m.type === 'dataops:backup:response')).toHaveLength(0);
      expect(posted.filter((m) => m.type === 'dataops:error')).toHaveLength(1);
      // Nothing reached storage: the snapshot is written after the last object.
      expect(deps.configStore.set).not.toHaveBeenCalled();
    });

    it('lists a backup that errored as failed, not as completed', async () => {
      const { getJsforceConnection } = await import('../../core/connection/ConnectionHelper.js');
      vi.mocked(getJsforceConnection).mockResolvedValue({
        describe: vi.fn().mockResolvedValue({ fields: [{ name: 'Id' }] }),
        query: vi.fn().mockRejectedValue(new Error('INVALID_TYPE: Account is not queryable')),
      } as never);
      (deps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockReturnValue({ orgType: 'Sandbox' });

      await handler.handle(
        inboundRequest({
          id: 'bk-failed',
          type: 'backup:execute',
          timestamp: Date.now(),
          payload: { orgId: 'org-1', objects: ['Account'] },
        } as BaseMessage),
      );

      expect(events).toEqual(['started', 'failed']);
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

    it('brings a record deleted since the snapshot back from the recycle bin before restoring it', async () => {
      // Run for real: "204 restored, 1 rejected — entity is deleted", the one
      // record the user had lost.
      const upsert = vi.fn().mockResolvedValue([{ success: true, id: '001000000000001' }]);
      const query = vi.fn().mockResolvedValue({ records: [{ Id: '001000000000001' }] });
      const undelete = vi.fn().mockResolvedValue([{ success: true, id: '001000000000001' }]);
      const { getJsforceConnection } = await import('../../core/connection/ConnectionHelper.js');
      vi.mocked(getJsforceConnection).mockResolvedValue({
        describe: vi.fn().mockResolvedValue(accountDescribe),
        sobject: vi.fn(() => ({ upsert })),
        query,
        soap: { undelete },
      } as never);
      deps.configStore = configStoreWithBackup('org-A');
      (deps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockReturnValue({ orgType: 'Sandbox' });

      await handler.handle(rollbackMsg('org-A'));

      expect(query).toHaveBeenCalledWith(
        "SELECT Id FROM Account WHERE Id IN ('001000000000001') AND IsDeleted = true",
        { scanAll: true },
      );
      expect(undelete).toHaveBeenCalledWith(['001000000000001']);
      expect(undelete.mock.invocationCallOrder[0]).toBeLessThan(upsert.mock.invocationCallOrder[0]);
      const response = posted().find((m) => m.type === 'dataops:rollback:response') as unknown as {
        payload: { totalRestored: number; totalFailed: number };
      };
      expect(response.payload).toMatchObject({ totalRestored: 1, totalFailed: 0 });
    });

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

    it('asks before restoring into an org stored with a type outside OrgType, and restores nothing when declined', async () => {
      // The connection only opens for an org the registry holds, and the
      // registry hands back whatever type was stored: it loads orgs without a
      // shape check. A type outside OrgType shows nothing of a sandbox; it was
      // classed as development, and the restore wrote over live data unasked.
      const { upsert } = await mockConnection();
      deps.configStore = configStoreWithBackup('org-A');
      (deps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockReturnValue({ orgType: 'Unknown' });
      const requestConfirmation = vi.fn().mockResolvedValue(false);
      const guard = new ProductionGuard({ requestConfirmation });
      deps.infraServices = {
        productionGuard: guard,
      } as unknown as NonNullable<HandlerDeps['infraServices']>;

      await handler.handle(rollbackMsg('org-A'));

      expect(requestConfirmation).toHaveBeenCalledWith(
        'UPSERT 1 Account record(s) on production org org-A [module: dataops]',
      );
      expect(guard.getAuditLog().map((entry) => entry.request.orgTier)).toEqual(['production']);
      expect(upsert).not.toHaveBeenCalled();
      const errors = posted().filter((m) => m.type === 'dataops:error');
      expect(errors).toHaveLength(1);
      expect(errors[0].payload.message).toBe(
        'Operation cancelled by user (production confirmation declined).',
      );
    });

    it('tells the model the object and batch size a restore was writing with', async () => {
      // The write loop is where a restore meets the org: the answer is only
      // useful if it knows which object, and how many records went per call.
      const { upsert } = await mockConnection();
      upsert.mockRejectedValue(new Error('SOMETHING_WE_HAVE_NEVER_SEEN: odd'));
      deps.configStore = configStoreWithBackup('org-1');
      const provider = vi.fn<AIProvider>(() =>
        Promise.resolve(JSON.stringify({ explanation: 'why', suggestions: [], confidence: 0.4 })),
      );
      deps.errorResolver = new ErrorResolver(provider);
      deps.broker = {
        postToWebview: vi.fn(),
        panelCount: 1,
        showFixSuggestion: vi.fn(),
      } as unknown as HandlerDeps['broker'];

      await handler.handle(rollbackMsg('org-1'));
      await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));

      const [prompt] = provider.mock.calls[0];
      expect(prompt).toContain('Module: dataops');
      expect(prompt).toContain('Operation: dataops:rollback');
      expect(prompt).toContain('Target object: Account');
      expect(prompt).toContain('Batch size: 200');
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

    describe('audit trail', () => {
      /** A real store holding one backup, taken at a known time, that also records the run. */
      function storeWithBackup(records: Record<string, unknown>[]): ConfigStore {
        const store = new ConfigStore(new InMemoryConfigStoreBackend());
        store.initialize();
        store.set(
          'backup:bk-1',
          {
            operationId: 'bk-1',
            orgId: 'org-1',
            objects: [{ objectApiName: 'Account', recordCount: records.length }],
            totalRecords: records.length,
            timestamp: '2026-09-20T10:00:00.000Z',
          },
          'backups',
        );
        store.set('backup:bk-1:Account', records, 'backups');
        deps.configStore = store;
        return store;
      }

      it('records a restore once: what it wrote over, what the org refused, from which backup', async () => {
        const { upsert } = await mockConnection();
        upsert.mockResolvedValue([
          { success: true, id: '001000000000001' },
          { success: false, errors: [{ message: 'REQUIRED_FIELD_MISSING: [Industry]' }] },
        ]);
        const store = storeWithBackup([
          backedUpRecord,
          { ...backedUpRecord, Id: '001000000000002' },
        ]);

        await handler.handle(rollbackMsg('org-1'));

        const { entries } = new AuditTrailStore(store).list();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          action: 'backup_restore',
          module: 'dataops',
          operationId: 'msg-rb',
          orgId: 'org-1',
          outcome: 'partial',
          objects: [{ objectApiName: 'Account', created: 0, updated: 1, deleted: 0, failed: 1 }],
        });
        expect(new LineageStore(store).get('msg-rb')?.nodes[0]).toMatchObject({
          type: 'source',
          origin: 'backup',
          label: '2026-09-20 10:00',
        });
        const trail = JSON.stringify(store.get('audit:trail'));
        expect(trail).not.toContain('001000000000002');
        expect(trail).not.toContain('Industry');
      });

      it('records a restore that stopped at an object it may not write as failed', async () => {
        await mockConnection({
          ...accountDescribe,
          fields: accountDescribe.fields.map((f) =>
            f.name === 'Name' ? { ...f, createable: false, updateable: false } : f,
          ),
        });
        const store = storeWithBackup([backedUpRecord]);

        await handler.handle(rollbackMsg('org-1'));

        expect(new AuditTrailStore(store).list().entries).toEqual([
          expect.objectContaining({ action: 'backup_restore', outcome: 'failure', objects: [] }),
        ]);
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
          type: 'backup:execute',
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

    it('records the masking run once, read from the org and written back to it', async () => {
      const store = new ConfigStore(new InMemoryConfigStoreBackend());
      store.initialize();
      deps.configStore = store;

      await mixedAnonymize();

      const { entries } = new AuditTrailStore(store).list();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        action: 'anonymize_execute',
        module: 'dataops',
        orgId: 'org-1',
        sourceOrgId: 'org-1',
        outcome: 'partial',
        objects: [{ objectApiName: 'Contact', created: 0, updated: 1, deleted: 0, failed: 1 }],
      });
      // Neither the value masked nor the value it was masked with.
      const stored = JSON.stringify([store.get('audit:trail'), store.get('lineage:runs')]);
      expect(stored).not.toContain('Ada');
      expect(stored).not.toContain('003000000000001');
    });

    it('calls it partial, not a completed anonymization', async () => {
      await mixedAnonymize();

      expect(anonymizePayload()?.status).toBe('partial');
      expect(anonymizePayload()?.message).not.toBe('Anonymization completed: 1 records processed.');
    });

    /** The FirstName one masking run wrote back for `Ada`. */
    async function maskedFirstName(
      target: DataOpsHandler,
      targetDeps: HandlerDeps,
      id: string,
    ): Promise<unknown> {
      const update = vi.fn().mockResolvedValue([{ success: true, id: '003000000000001' }]);
      const { getJsforceConnection } = await import('../../core/connection/ConnectionHelper.js');
      vi.mocked(getJsforceConnection).mockResolvedValue({
        query: vi.fn(async () => ({
          records: [{ Id: '003000000000001', FirstName: 'Ada' }],
          done: true,
        })),
        describe: vi.fn().mockResolvedValue(contactDescribe),
        sobject: vi.fn(() => ({ update })),
      } as never);
      (targetDeps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockReturnValue({
        orgType: 'Sandbox',
      });

      await target.handle(
        inboundRequest({
          id,
          type: 'dataops:anonymize',
          timestamp: Date.now(),
          payload: { orgId: 'org-1', templateId: 'tpl-gdpr-standard', objects: ['Contact'] },
        } as BaseMessage),
      );

      const batch = update.mock.calls[0][0] as Array<Record<string, unknown>>;
      return batch[0]['FirstName'];
    }

    it('gives a record the same fake identity in two runs of one panel session', async () => {
      const first = await maskedFirstName(handler, deps, 'an-key-1');
      const second = await maskedFirstName(handler, deps, 'an-key-2');

      expect(first).not.toBe('Ada');
      expect(second).toBe(first);

      // Another session picks its own key, so the same record gets another
      // identity — the replacement is not derivable from the record alone.
      const elsewhere = new Set([first]);
      for (let k = 0; k < 8; k++) {
        elsewhere.add(await maskedFirstName(new DataOpsHandler(deps), deps, `an-key-other-${k}`));
      }
      expect(elsewhere.size).toBeGreaterThan(1);
    });

    it('tells the model the object and batch size a refused masking used', async () => {
      // Masking fails inside the same write loop as the restore, and needs the
      // same two lines to be answered usefully.
      const update = vi.fn().mockRejectedValue(new Error('SOMETHING_WE_HAVE_NEVER_SEEN: odd'));
      const { getJsforceConnection } = await import('../../core/connection/ConnectionHelper.js');
      vi.mocked(getJsforceConnection).mockResolvedValue({
        query: vi.fn(async () => ({
          records: [{ Id: '003000000000001', FirstName: 'Ada' }],
          done: true,
        })),
        describe: vi.fn().mockResolvedValue(contactDescribe),
        sobject: vi.fn(() => ({ update })),
      } as never);
      (deps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockReturnValue({ orgType: 'Sandbox' });
      const provider = vi.fn<AIProvider>(() =>
        Promise.resolve(JSON.stringify({ explanation: 'why', suggestions: [], confidence: 0.4 })),
      );
      deps.errorResolver = new ErrorResolver(provider);
      deps.broker = {
        postToWebview: vi.fn(),
        panelCount: 1,
        showFixSuggestion: vi.fn(),
      } as unknown as HandlerDeps['broker'];

      await handler.handle(
        inboundRequest({
          id: 'an-failed',
          type: 'dataops:anonymize',
          timestamp: Date.now(),
          payload: { orgId: 'org-1', templateId: 'tpl-gdpr-standard', objects: ['Contact'] },
        } as BaseMessage),
      );
      await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));

      const [prompt] = provider.mock.calls[0];
      expect(prompt).toContain('Module: dataops');
      expect(prompt).toContain('Operation: dataops:anonymize');
      expect(prompt).toContain('Target object: Contact');
      expect(prompt).toContain('Batch size: 200');
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
          type: 'backup:execute',
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

  it('does not claim dataops:backup or the per-object masking lookup, which no page sends', async () => {
    const handler = new DataOpsHandler(createMockDeps());
    for (const type of ['dataops:backup', 'dataops:masking-templates-by-object']) {
      const msg = inboundRequest({ id: `req-${type}`, type, timestamp: Date.now() });
      expect(await handler.handle(msg)).toBe(false);
    }
  });
});

describe('DataOpsHandler — housekeeping after a written snapshot', () => {
  it('reports the backup as done when retention fails', async () => {
    // Pruning runs after the records are on disk. Told the snapshot failed, a
    // user takes it again or carries on without the one they already have.
    const deps = createMockDeps();
    vi.mocked(deps.configStore.getKeysByPrefix).mockImplementation(() => {
      throw new Error('storage is unhappy');
    });
    const { getJsforceConnection } = await import('../../core/connection/ConnectionHelper.js');
    vi.mocked(getJsforceConnection).mockResolvedValue({
      describe: vi.fn().mockResolvedValue({ fields: [{ name: 'Id' }] }),
      query: vi.fn().mockResolvedValue({ records: [] }),
    } as never);
    const handler = new DataOpsHandler(deps);

    await handler.handle({
      id: 'op-retention',
      type: 'backup:execute',
      payload: { orgId: 'org-1', objects: ['Account'] },
    } as never);

    const posted = vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map((c) => (c[0] as { type?: string }).type);
    expect(posted).toContain('dataops:backup:response');
    expect(posted.some((t) => t === 'dataops:error')).toBe(false);
  });
});

/**
 * Templates of the user's own. The library used to be the four that ship:
 * nothing could be added to it, and the Create Template button said so.
 */
describe('DataOpsHandler — templates the user saves', () => {
  let deps: HandlerDeps;
  let handler: DataOpsHandler;

  beforeEach(() => {
    deps = createMockDeps();
    // The real store over memory, as globalState keeps it between sessions.
    let data: Record<string, ConfigEntry> = {};
    const configStore = new ConfigStore({
      getData: () => data,
      setData: (next) => {
        data = next;
      },
    });
    configStore.initialize();
    deps.configStore = configStore;
    handler = new DataOpsHandler(deps);
  });

  /** Everything the handler posted, in order. */
  function posted(): Array<BaseMessage & { payload: Record<string, unknown> }> {
    return (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
  }

  /** The last message of a type the handler posted. */
  function last(type: string): (BaseMessage & { payload: Record<string, unknown> }) | undefined {
    return posted()
      .filter((m) => m.type === type)
      .at(-1);
  }

  async function send(type: string, payload: Record<string, unknown>, id = type): Promise<void> {
    await handler.handle(
      inboundRequest({ id, type, timestamp: Date.now(), payload } as BaseMessage),
    );
  }

  async function listed(): Promise<Array<Record<string, unknown>>> {
    await send('dataops:anonymization-templates', {}, `list-${posted().length}`);
    const response = last('dataops:anonymization-templates:response');
    return response?.payload.templates as Array<Record<string, unknown>>;
  }

  const rules = [
    { fieldPattern: 'Contact.FirstName', ruleType: 'fake' },
    { fieldPattern: 'Contact.Phone', ruleType: 'mask' },
  ];

  it('saves rules as a named template, listed after the ones that ship and marked as saved', async () => {
    const shipped = await listed();

    await send('dataops:anonymization-template:save', { name: '  Support desk  ', rules });

    const saved = last('dataops:anonymization-template:save:response')?.payload.template as Record<
      string,
      unknown
    >;
    expect(saved).toMatchObject({
      name: 'Support desk',
      complianceFramework: 'custom',
      saved: true,
      rules: [
        { fieldPattern: 'Contact.FirstName', ruleType: 'fake', description: '' },
        { fieldPattern: 'Contact.Phone', ruleType: 'mask', description: '' },
      ],
    });
    const all = await listed();
    expect(all).toHaveLength(shipped.length + 1);
    expect(all.at(-1)).toEqual(saved);
    expect(shipped.every((t) => t.saved === undefined)).toBe(true);
  });

  it('keeps a saved template for the next session, which opens the same store', async () => {
    await send('dataops:anonymization-template:save', { name: 'Support desk', rules });

    handler = new DataOpsHandler(deps);
    expect((await listed()).map((t) => t.name)).toContain('Support desk');
  });

  it('masks with a saved template the way it masks with one that ships', async () => {
    await send('dataops:anonymization-template:save', {
      name: 'First names only',
      rules: [{ fieldPattern: 'Contact.FirstName', ruleType: 'nullify' }],
    });
    const templateId = (
      last('dataops:anonymization-template:save:response')?.payload.template as { id: string }
    ).id;

    const update = vi.fn().mockResolvedValue([{ success: true, id: '003000000000001' }]);
    const { getJsforceConnection } = await import('../../core/connection/ConnectionHelper.js');
    vi.mocked(getJsforceConnection).mockResolvedValue({
      query: vi.fn(async () => ({
        records: [{ Id: '003000000000001', FirstName: 'Ada', LastName: 'Lovelace' }],
        done: true,
      })),
      describe: vi.fn().mockResolvedValue({
        name: 'Contact',
        label: 'Contact',
        createable: true,
        updateable: true,
        deletable: true,
        queryable: true,
        fields: [
          { name: 'Id', label: 'Id', type: 'id', createable: false, updateable: false },
          {
            name: 'FirstName',
            label: 'First Name',
            type: 'string',
            createable: true,
            updateable: true,
          },
          {
            name: 'LastName',
            label: 'Last Name',
            type: 'string',
            createable: true,
            updateable: true,
          },
        ],
        recordTypeInfos: [],
        childRelationships: [],
      }),
      sobject: vi.fn(() => ({ update })),
    } as never);
    (deps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockReturnValue({ orgType: 'Sandbox' });

    // No object named: the run addresses the objects the template's rules do.
    await send('dataops:anonymize', { orgId: 'org-1', templateId });

    expect(last('dataops:error')).toBeUndefined();
    expect(update).toHaveBeenCalledTimes(1);
    const [record] = update.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(record.FirstName).toBeNull();
    expect(record.LastName).toBe('Lovelace');
    expect(last('dataops:anonymize:response')?.payload).toMatchObject({
      templateId,
      status: 'success',
      recordsProcessed: 1,
    });
  });

  it('refuses a name a template already goes by, whatever its case', async () => {
    await send('dataops:anonymization-template:save', { name: 'gdpr standard', rules });

    expect(last('dataops:anonymization-template:save:response')).toBeUndefined();
    expect(last('dataops:error')?.payload).toMatchObject({ code: 'DUPLICATE_NAME' });
    expect(String(last('dataops:error')?.payload.message)).toContain('already exists');
  });

  it.each([
    ['a method that needs a salt', [{ fieldPattern: 'Contact.Email', ruleType: 'hash' }]],
    ['a field written without its object', [{ fieldPattern: 'Email', ruleType: 'fake' }]],
    [
      'a field with two rules',
      [
        { fieldPattern: 'Contact.Email', ruleType: 'fake' },
        { fieldPattern: 'contact.email', ruleType: 'mask' },
      ],
    ],
    ['no rule at all', []],
  ])('refuses %s, and saves nothing', async (_what, badRules) => {
    await send('dataops:anonymization-template:save', { name: 'Bad', rules: badRules });

    expect(last('dataops:error')?.payload).toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect((await listed()).map((t) => t.name)).not.toContain('Bad');
  });

  it('deletes a saved template, which is then neither listed nor applied', async () => {
    await send('dataops:anonymization-template:save', { name: 'Support desk', rules });
    const templateId = (
      last('dataops:anonymization-template:save:response')?.payload.template as { id: string }
    ).id;

    await send('dataops:anonymization-template:delete', { templateId });

    expect(last('dataops:anonymization-template:delete:response')?.payload).toEqual({
      templateId,
      deleted: true,
    });
    expect((await listed()).map((t) => t.id)).not.toContain(templateId);

    const { getJsforceConnection } = await import('../../core/connection/ConnectionHelper.js');
    const update = vi.fn();
    vi.mocked(getJsforceConnection).mockResolvedValue({
      sobject: vi.fn(() => ({ update })),
    } as never);
    await send('dataops:anonymize', { orgId: 'org-1', templateId });
    expect(update).not.toHaveBeenCalled();
  });

  it('says so when the template to delete was not there', async () => {
    await send('dataops:anonymization-template:delete', { templateId: 'tpl-saved-gone' });

    expect(last('dataops:anonymization-template:delete:response')?.payload).toEqual({
      templateId: 'tpl-saved-gone',
      deleted: false,
    });
  });

  it('refuses to delete a template that ships', async () => {
    await send('dataops:anonymization-template:delete', { templateId: 'tpl-gdpr-standard' });

    expect(last('dataops:anonymization-template:delete:response')).toBeUndefined();
    expect(last('dataops:error')?.payload).toMatchObject({ code: 'BUILT_IN' });
    expect((await listed()).map((t) => t.id)).toContain('tpl-gdpr-standard');
  });
});

describe('DataOpsHandler — a snapshot taken for a pipeline', () => {
  /** A connection that reads one record of each object and writes nothing. */
  function readOnlyConnection(
    query = vi.fn(async () => ({ records: [{ Id: '001' }], done: true })),
  ) {
    return {
      describe: vi.fn().mockResolvedValue({ fields: [{ name: 'Id' }, { name: 'Name' }] }),
      query,
      // A pipeline's Backup only reads: none of these may be reached.
      sobject: vi.fn(),
      soap: { undelete: vi.fn() },
    };
  }

  it('takes the snapshot the Backup button takes, into local storage, and says what it holds', async () => {
    const deps = createMockDeps();
    const conn = readOnlyConnection();
    const { getJsforceConnection } = await import('../../core/connection/ConnectionHelper.js');
    vi.mocked(getJsforceConnection).mockResolvedValue(conn as never);
    vi.mocked(deps.orgManager.getOrg).mockReturnValue({ orgType: 'Sandbox' } as never);
    const handler = new DataOpsHandler(deps);

    const taken = await handler.backupForPipeline({
      operationId: 'snap-1',
      orgId: 'org-1',
      objects: ['Account', 'Contact'],
    });

    expect(taken).toMatchObject({
      operationId: 'snap-1',
      totalRecords: 2,
      partial: false,
      objects: [
        { objectApiName: 'Account', recordCount: 1, truncated: false },
        { objectApiName: 'Contact', recordCount: 1, truncated: false },
      ],
    });
    // Where the DataOps page lists it, under the snapshot's id.
    expect(deps.configStore.set).toHaveBeenCalledWith(
      'backup:snap-1',
      expect.objectContaining({ orgId: 'org-1', totalRecords: 2 }),
      'backups',
    );
    expect(conn.sobject).not.toHaveBeenCalled();
    expect(conn.soap.undelete).not.toHaveBeenCalled();
    // The lifecycle Live Operations reads; the step, not a page, gets the answer.
    const types = vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([message]) => (message as BaseMessage).type);
    expect(types).toContain('operation:started');
    expect(types).toContain('operation:completed');
    expect(types).not.toContain('dataops:backup:response');
  });

  it('waits on the lock a snapshot from the DataOps page holds on the same org', async () => {
    const deps = createMockDeps();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { getJsforceConnection } = await import('../../core/connection/ConnectionHelper.js');
    vi.mocked(getJsforceConnection).mockImplementation(
      () => held.then(() => readOnlyConnection()) as never,
    );
    const handler = new DataOpsHandler(deps);

    const fromThePage = handler.handle(
      inboundRequest({
        id: 'page-backup',
        type: 'backup:execute',
        timestamp: Date.now(),
        payload: { orgId: 'org-1', objects: ['Account'] },
      } as BaseMessage),
    );

    await expect(
      handler.backupForPipeline({ operationId: 'snap-2', orgId: 'org-1', objects: ['Account'] }),
    ).rejects.toThrow('A backup or rollback operation is already running for org org-1.');

    release();
    await fromThePage;
  });

  it('stops between two objects when the run is stopped, and saves nothing', async () => {
    const deps = createMockDeps();
    const stop = new AbortController();
    const query = vi.fn(async () => {
      stop.abort();
      return { records: [{ Id: '001' }], done: true };
    });
    const { getJsforceConnection } = await import('../../core/connection/ConnectionHelper.js');
    vi.mocked(getJsforceConnection).mockResolvedValue(readOnlyConnection(query) as never);
    const handler = new DataOpsHandler(deps);

    await expect(
      handler.backupForPipeline(
        { operationId: 'snap-3', orgId: 'org-1', objects: ['Account', 'Contact'] },
        stop.signal,
      ),
    ).rejects.toThrow('Backup was cancelled before it finished. Nothing was saved');
    expect(query).toHaveBeenCalledTimes(1);
    expect(deps.configStore.set).not.toHaveBeenCalled();
  });
});
