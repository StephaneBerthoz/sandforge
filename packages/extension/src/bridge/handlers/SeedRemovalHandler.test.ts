import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseMessage, SeedRemovalResult, SeedRunRemovalInfo } from '@sandforge/shared';

import { SeedRemovalHandler } from './SeedRemovalHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import { SeedRunCreations } from '../../modules/seed/SeedRunCreations.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { MemoryRemovalOrg } from '../../test/memoryRemovalOrg.js';
import { inboundRequest } from '../../test/mockFactories.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(async () => ({})),
}));
vi.mock('../../modules/forge/ForgeRunRemoval.js', async (original) => ({
  ...(await original<typeof import('../../modules/forge/ForgeRunRemoval.js')>()),
  removalOrg: vi.fn(),
}));

import { removalOrg } from '../../modules/forge/ForgeRunRemoval.js';

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const TARGET = 'org-target';
const A1 = fakeId('001', 1);
const C1 = fakeId('003', 1);
const C2 = fakeId('003', 2);

function buildMsg(type: string, payload?: unknown): InboundRequest {
  return inboundRequest({
    id: `req-${type}`,
    type,
    timestamp: Date.now(),
    ...(payload !== undefined ? { payload } : {}),
  } as BaseMessage);
}

describe('SeedRemovalHandler', () => {
  let store: ConfigStore;
  let runs: SeedRunCreations;
  let deps: HandlerDeps;
  let handler: SeedRemovalHandler;
  let registry: BackgroundOperationRegistry;
  let org: MemoryRemovalOrg;
  let orgType: string;
  let edition: string | undefined;

  const posted = <T extends BaseMessage>(type: string): T[] =>
    vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as T)
      .filter((m) => m.type === type);
  const errors = () =>
    posted<BaseMessage & { payload: { code: string; message: string } }>('seed:remove:error');
  const answer = (): SeedRemovalResult | undefined =>
    posted<BaseMessage & { payload: { result: SeedRemovalResult } }>('seed:remove:response')[0]
      ?.payload.result;
  const info = (): SeedRunRemovalInfo | null | undefined =>
    posted<BaseMessage & { payload: { info: SeedRunRemovalInfo | null } }>(
      'seed:removal:info:response',
    )[0]?.payload.info;
  const trail = () => new AuditTrailStore(store).list().entries;
  const remove = (payload: Record<string, unknown> = {}) =>
    handler.handle(buildMsg('seed:remove', { runId: 'op-1', ...payload }));

  beforeEach(() => {
    vi.clearAllMocks();
    store = new ConfigStore(new InMemoryConfigStoreBackend());
    store.initialize();
    registry = new BackgroundOperationRegistry();
    orgType = 'Sandbox';
    edition = undefined;
    let n = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn((orgId: string) =>
          orgId === TARGET
            ? { orgType, alias: 'TARGET', metadata: edition ? { edition } : {} }
            : undefined,
        ),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as HandlerDeps['orgRegistry'],
      configStore: store,
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      infraServices: {
        productionGuard: new ProductionGuard(),
      } as unknown as HandlerDeps['infraServices'],
      nextId: () => String(++n),
    };
    runs = new SeedRunCreations();
    handler = new SeedRemovalHandler(deps);
    handler.setRunCreations(runs);
    handler.setRegistry(registry);
    handler.setLiveOperationTracker(new LiveOperationTracker());

    // A seed ten minutes ago: an account, then two contacts under it.
    const startedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    const at = new Date(Date.now() - 10 * 60_000).toISOString();
    runs.record({
      runId: 'op-1',
      targetOrgId: TARGET,
      startedAt,
      finishedAt: at,
      status: 'success',
      objectResults: [
        { objectApiName: 'Account', createdIds: [A1] },
        { objectApiName: 'Contact', createdIds: [C1, C2] },
      ],
    });
    org = new MemoryRemovalOrg();
    org.add('Account', { Id: A1 }, at);
    org.add('Contact', { Id: C1, AccountId: A1 }, at);
    org.add('Contact', { Id: C2, AccountId: A1 }, at);
    vi.mocked(removalOrg).mockReturnValue(org);
  });

  describe('seed:removal:info', () => {
    it('says what the run created and what a removal takes, the contacts first, nothing asked of the org', async () => {
      await handler.handle(buildMsg('seed:removal:info', { runId: 'op-1' }));

      expect(info()).toMatchObject({
        runId: 'op-1',
        targetOrgId: TARGET,
        created: 3,
        left: [
          { objectApiName: 'Contact', count: 2 },
          { objectApiName: 'Account', count: 1 },
        ],
      });
      expect(info()?.refusal).toBeUndefined();
      expect(removalOrg).not.toHaveBeenCalled();
    });

    it("offers nothing on a production org, with the guard's reason", async () => {
      orgType = 'Production';
      edition = 'Enterprise Edition';

      await handler.handle(buildMsg('seed:removal:info', { runId: 'op-1' }));

      expect(info()?.refusal).toEqual({
        code: 'GUARD_BLOCKED',
        message: `delete is not allowed on production org ${TARGET}`,
      });
    });

    it('offers the removal on a Developer Edition, as Forge’s removal does', async () => {
      orgType = 'Production';
      edition = 'Developer Edition';

      await handler.handle(buildMsg('seed:removal:info', { runId: 'op-1' }));

      expect(info()?.refusal).toBeUndefined();
    });

    it('answers null for a run nothing of which is kept', async () => {
      await handler.handle(buildMsg('seed:removal:info', { runId: 'never-ran' }));

      expect(info()).toBeNull();
    });
  });

  describe('seed:remove', () => {
    it('removes what the run created, children first, records it in the audit trail, and is not offered again', async () => {
      await remove();

      expect(errors()).toEqual([]);
      expect(org.deletes.map((d) => d.objectApiName)).toEqual(['Contact', 'Account']);
      expect(org.all('Contact')).toEqual([]);
      expect(org.all('Account')).toEqual([]);
      expect(answer()).toMatchObject({
        runId: 'op-1',
        status: 'success',
        includeChanged: false,
        objects: [
          { objectApiName: 'Contact', planned: 2, deleted: 2 },
          { objectApiName: 'Account', planned: 1, deleted: 1 },
        ],
      });
      expect(trail()).toEqual([
        expect.objectContaining({
          action: 'cleanup_delete',
          module: 'seed',
          operationId: 'req-seed:remove',
          orgId: TARGET,
          outcome: 'success',
          guard: 'allowed',
        }),
      ]);

      vi.mocked(deps.broker.postToWebview).mockClear();
      await handler.handle(buildMsg('seed:removal:info', { runId: 'op-1' }));
      expect(info()).toMatchObject({ left: [], removed: { deleted: 3 } });

      await remove();
      expect(errors()[0].payload.code).toBe('ALREADY_REMOVED');
    });

    it('keeps a record changed since the run unless told to take it too', async () => {
      org.touch('Contact', C2, new Date().toISOString());

      await remove();

      expect(org.all('Contact').map((r) => r.Id)).toEqual([C2]);
      expect(answer()?.status).toBe('partial');

      vi.mocked(deps.broker.postToWebview).mockClear();
      await remove({ includeChanged: true });
      expect(errors()).toEqual([]);
      expect(org.all('Contact')).toEqual([]);
    });

    it('refuses on a production org, recorded as stopped, nothing deleted', async () => {
      orgType = 'Production';
      edition = 'Enterprise Edition';

      await remove();

      expect(errors()).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            code: 'GUARD_BLOCKED',
            message: `Operation blocked by Production Guard: delete is not allowed on production org ${TARGET}`,
          }),
        }),
      ]);
      expect(org.deletes).toEqual([]);
      expect(removalOrg).not.toHaveBeenCalled();
      expect(trail()).toEqual([
        expect.objectContaining({ action: 'cleanup_delete', outcome: 'stopped', guard: 'refused' }),
      ]);
    });

    it('refuses without Production Guard, deleting nothing', async () => {
      deps.infraServices = undefined;

      await remove();

      expect(errors()[0].payload.code).toBe('NOT_INITIALIZED');
      expect(org.deletes).toEqual([]);
    });

    it('refuses a run nothing of which is kept, and one whose org is gone', async () => {
      await handler.handle(buildMsg('seed:remove', { runId: 'never-ran' }));
      vi.mocked(deps.orgManager.getOrg).mockReturnValue(undefined);
      await remove();

      expect(errors().map((e) => e.payload.code)).toEqual(['NOT_KEPT', 'ORG_GONE']);
      expect(org.deletes).toEqual([]);
    });

    it('stops between two calls on a cancel through the registry, and offers what it left', async () => {
      org.beforeDelete = () => registry.abort('req-seed:remove');

      await remove();

      expect(answer()?.status).toBe('cancelled');
      expect(org.deletes).toHaveLength(1);
      expect(trail()).toEqual([
        expect.objectContaining({ action: 'cleanup_delete', module: 'seed', outcome: 'cancelled' }),
      ]);
      vi.mocked(deps.broker.postToWebview).mockClear();
      await handler.handle(buildMsg('seed:removal:info', { runId: 'op-1' }));
      expect(info()?.left).toEqual([{ objectApiName: 'Account', count: 1 }]);
    });

    it('does not start when cancelled while Production Guard asked', async () => {
      deps.infraServices = {
        productionGuard: {
          check: () => ({ allowed: true, requiresConfirmation: true, impactSummary: 'asks' }),
          confirmIfNeeded: async () => {
            registry.cancelBeforeStart('req-seed:remove');
            return true;
          },
        },
      } as unknown as HandlerDeps['infraServices'];

      await remove();

      expect(answer()).toMatchObject({ status: 'cancelled', objects: [] });
      expect(org.deletes).toEqual([]);
      expect(trail()).toEqual([
        expect.objectContaining({
          outcome: 'stopped',
          details: { code: 'ABORTED_BEFORE_START', runId: 'op-1' },
        }),
      ]);
    });

    it('refuses a second removal of the run while the first waits on the confirmation', async () => {
      let second: Promise<boolean> | undefined;
      deps.infraServices = {
        productionGuard: {
          check: () => ({ allowed: true, requiresConfirmation: true, impactSummary: 'asks' }),
          confirmIfNeeded: async () => {
            second = handler.handle(buildMsg('seed:remove', { runId: 'op-1' }));
            await second;
            return true;
          },
        },
      } as unknown as HandlerDeps['infraServices'];

      await remove();

      expect(errors().map((e) => e.payload.code)).toEqual(['DUPLICATE']);
      expect(answer()?.status).toBe('success');
    });
  });
});
