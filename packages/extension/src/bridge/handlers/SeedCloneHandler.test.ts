import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseMessage } from '@sandforge/shared';
import { SeedCloneHandler } from './SeedCloneHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));
vi.mock('../../core/common/sforceLimitParser.js', () => ({
  checkApiLimits: vi.fn(),
}));

/**
 * The pipeline collaborators are constructed inside the handler, so they are
 * replaced at module level. `writer` doubles as the "did anything reach the
 * target org?" probe used by the production-guard cases.
 */
const writer = vi.hoisted(() => ({
  insert: vi.fn(),
  upsert: vi.fn(),
}));
const fetcher = vi.hoisted(() => ({
  fetchRecords: vi.fn(),
  countRecords: vi.fn(),
  fetchSample: vi.fn(),
}));
const linker = vi.hoisted(() => ({
  buildEdgesFromDescribe: vi.fn(),
  resolveInsertOrder: vi.fn(),
}));

vi.mock('../../modules/sync/BulkDataWriter.js', () => ({
  BulkDataWriter: vi.fn().mockImplementation(() => writer),
}));
vi.mock('../../modules/seed/CloneRecordFetcher.js', () => ({
  CloneRecordFetcher: vi.fn().mockImplementation(() => fetcher),
}));
vi.mock('../../modules/seed/CloneReferenceLinker.js', () => ({
  CloneReferenceLinker: vi.fn().mockImplementation(() => linker),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { inboundRequest } from '../../test/mockFactories.js';

const mockGetConn = vi.mocked(getJsforceConnection);

/** Message envelope shaped like what MessageBroker hands a handler. */
function buildMsg(type: string, payload?: unknown): InboundRequest {
  return inboundRequest({
    id: `msg-${type}`,
    type,
    timestamp: Date.now(),
    payload,
  } as BaseMessage);
}

/** A valid `seed:clone:execute` payload (one object, insert mode). */
function clonePayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    objects: [{ objectApiName: 'Account' }],
    ...overrides,
  };
}

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

/** All messages of one type posted to the webview, in emission order. */
function posted(deps: HandlerDeps, type: string): Array<BaseMessage & { payload: never }> {
  return vi
    .mocked(deps.broker.postToWebview)
    .mock.calls.map((call) => call[0] as BaseMessage & { payload: never })
    .filter((msg) => msg.type === type);
}

describe('SeedCloneHandler', () => {
  let deps: HandlerDeps;
  let handler: SeedCloneHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
    handler = new SeedCloneHandler(deps);

    mockGetConn.mockResolvedValue({
      describeGlobal: vi.fn().mockResolvedValue({ sobjects: [] }),
      describe: vi.fn().mockResolvedValue({ fields: [] }),
      limitInfo: undefined,
    } as unknown as Awaited<ReturnType<typeof getJsforceConnection>>);
    linker.buildEdgesFromDescribe.mockReturnValue([]);
    linker.resolveInsertOrder.mockReturnValue(['Account']);
    fetcher.fetchRecords.mockResolvedValue([{ Id: '001SRC', Name: 'Acme' }]);
    writer.insert.mockResolvedValue([{ id: '001TGT', success: true, errors: [] }]);
    writer.upsert.mockResolvedValue([{ id: '001TGT', success: true, errors: [] }]);
  });

  describe('routing', () => {
    it('ignores message types it does not own', async () => {
      expect(await handler.handle(buildMsg('sync:execute'))).toBe(false);
      expect(deps.broker.postToWebview).not.toHaveBeenCalled();
    });
  });

  describe('seed:clone:describe-source', () => {
    it('returns only createable and queryable objects', async () => {
      mockGetConn.mockResolvedValue({
        describeGlobal: vi.fn().mockResolvedValue({
          sobjects: [
            {
              name: 'Account',
              label: 'Account',
              createable: true,
              queryable: true,
            },
            {
              name: 'AccountShare',
              label: 'Share',
              createable: true,
              queryable: false,
            },
          ],
        }),
        limitInfo: undefined,
      } as unknown as Awaited<ReturnType<typeof getJsforceConnection>>);

      await handler.handle(buildMsg('seed:clone:describe-source', { sourceOrgId: 'src-org' }));

      const responses = posted(deps, 'seed:clone:describe-source:response');
      expect(responses).toHaveLength(1);
      expect(responses[0].payload).toEqual({
        objects: [{ apiName: 'Account', label: 'Account', recordCount: -1 }],
      });
    });

    it('reports connection failures on seed:clone:error', async () => {
      mockGetConn.mockRejectedValue(new Error('org unreachable'));

      await handler.handle(buildMsg('seed:clone:describe-source', { sourceOrgId: 'src-org' }));

      const errors = posted(deps, 'seed:clone:error');
      expect(errors).toHaveLength(1);
      expect((errors[0].payload as { message: string }).message).toContain('org unreachable');
    });
  });

  describe('seed:clone:execute', () => {
    it('writes through BulkDataWriter and reports a successful clone', async () => {
      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      expect(writer.insert).toHaveBeenCalledWith('Account', [{ Name: 'Acme' }], 200);
      expect(posted(deps, 'operation:started')).toHaveLength(1);
      const responses = posted(deps, 'seed:clone:execute:response');
      expect(responses).toHaveLength(1);
      expect(responses[0].payload as unknown).toMatchObject({
        status: 'success',
        totalInserted: 1,
        totalFailed: 0,
      });
    });

    it('reports execute failures on operation:failed as retryable', async () => {
      writer.insert.mockRejectedValue(new Error('bulk write exploded'));

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      const failures = posted(deps, 'operation:failed');
      expect(failures).toHaveLength(1);
      expect(failures[0].payload as unknown).toMatchObject({
        error: 'bulk write exploded',
        retryable: true,
      });
    });
  });

  describe('production guard', () => {
    /** Wire a mock ProductionGuard into deps.infraServices and return its spies. */
    function wireGuard(behavior: {
      allowed: boolean;
      requiresConfirmation?: boolean;
      blockedReason?: string;
      confirmed?: boolean;
    }): {
      check: ReturnType<typeof vi.fn>;
      logOperation: ReturnType<typeof vi.fn>;
      confirmIfNeeded: ReturnType<typeof vi.fn>;
    } {
      const check = vi.fn().mockReturnValue({
        allowed: behavior.allowed,
        requiresConfirmation: behavior.requiresConfirmation ?? false,
        requiresApproval: false,
        blockedReason: behavior.blockedReason,
        warnings: [],
        impactSummary: 'INSERT 1 Account record(s) on production org tgt-org [module: clone]',
      });
      const logOperation = vi.fn();
      const confirmIfNeeded = vi.fn().mockResolvedValue(behavior.confirmed ?? true);
      deps.infraServices = {
        performanceTracker: { start: vi.fn(), complete: vi.fn() },
        productionGuard: { check, logOperation, confirmIfNeeded },
        offlineManager: undefined,
        piiDetector: undefined,
      } as unknown as NonNullable<HandlerDeps['infraServices']>;
      return { check, logOperation, confirmIfNeeded };
    }

    function mockTargetOrgType(orgType: string): void {
      vi.mocked(deps.orgManager.getOrg).mockReturnValue({
        orgType,
      } as unknown as ReturnType<HandlerDeps['orgManager']['getOrg']>);
    }

    it('resolves the guard tier from the target org and clones once confirmed', async () => {
      const guard = wireGuard({
        allowed: true,
        requiresConfirmation: true,
        confirmed: true,
      });
      mockTargetOrgType('Production');

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      expect(guard.check.mock.calls[0][0]).toMatchObject({
        orgId: 'tgt-org',
        orgTier: 'production',
        operation: 'insert',
        objectName: 'Account',
        module: 'clone',
      });
      expect(guard.logOperation).toHaveBeenCalledTimes(1);
      expect(writer.insert).toHaveBeenCalledTimes(1);
      expect(posted(deps, 'seed:clone:execute:response')).toHaveLength(1);
    });

    it('declares an upsert clone as an upsert to the guard', async () => {
      const guard = wireGuard({ allowed: true });
      mockTargetOrgType('Sandbox');

      await handler.handle(
        buildMsg(
          'seed:clone:execute',
          clonePayload({ upsert: true, externalIdField: 'External_Id__c' }),
        ),
      );

      expect(guard.check.mock.calls[0][0]).toMatchObject({
        orgTier: 'development',
        operation: 'upsert',
      });
      expect(writer.upsert).toHaveBeenCalledWith(
        'Account',
        'External_Id__c',
        [{ Name: 'Acme' }],
        200,
      );
    });

    it('blocks the clone when the guard refuses — no write, retryable operation:failed', async () => {
      const guard = wireGuard({
        allowed: false,
        blockedReason: 'insert is not allowed on production org tgt-org',
      });
      mockTargetOrgType('Production');

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      expect(guard.logOperation).toHaveBeenCalledTimes(1);
      expect(guard.confirmIfNeeded).not.toHaveBeenCalled();
      expect(writer.insert).not.toHaveBeenCalled();
      expect(writer.upsert).not.toHaveBeenCalled();
      expect(posted(deps, 'seed:clone:execute:response')).toHaveLength(0);

      const failures = posted(deps, 'operation:failed');
      expect(failures).toHaveLength(1);
      expect(failures[0].payload as unknown).toEqual({
        operationId: 'msg-seed:clone:execute',
        error:
          'Operation blocked by Production Guard: insert is not allowed on production org tgt-org',
        retryable: true,
      });
    });

    it('falls back to the impact summary when the guard blocks without a reason', async () => {
      wireGuard({ allowed: false });
      mockTargetOrgType('Production');

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      const failures = posted(deps, 'operation:failed');
      expect((failures[0].payload as { error: string }).error).toBe(
        'Operation blocked by Production Guard: INSERT 1 Account record(s) on production org tgt-org [module: clone]',
      );
    });

    it('cancels the clone when the user declines confirmation — no write, not retryable', async () => {
      const guard = wireGuard({
        allowed: true,
        requiresConfirmation: true,
        confirmed: false,
      });
      mockTargetOrgType('Production');

      await handler.handle(buildMsg('seed:clone:execute', clonePayload()));

      expect(guard.confirmIfNeeded).toHaveBeenCalledTimes(1);
      expect(writer.insert).not.toHaveBeenCalled();
      expect(writer.upsert).not.toHaveBeenCalled();
      expect(posted(deps, 'operation:started')).toHaveLength(0);
      expect(posted(deps, 'seed:clone:execute:response')).toHaveLength(0);

      const failures = posted(deps, 'operation:failed');
      expect(failures).toHaveLength(1);
      expect(failures[0].payload as unknown).toEqual({
        operationId: 'msg-seed:clone:execute',
        error: 'Operation cancelled by user (production confirmation declined).',
        retryable: false,
      });
    });
  });
});
