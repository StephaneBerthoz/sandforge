import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  BaseMessage,
  SyncConfig,
  SyncHistoryEntry,
  SyncRemovalResult,
  SyncRunRemovalInfo,
} from '@sandforge/shared';

import { SyncRemovalHandler } from './SyncRemovalHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import { SyncConfigStore } from '../../modules/sync/SyncConfigStore.js';
import {
  nodeSyncRunCreations,
  type SyncRunCreations,
} from '../../modules/sync/SyncRunCreations.js';
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
const A2 = fakeId('001', 2);
const DOC = fakeId('069', 1);

function buildMsg(type: string, payload?: unknown): InboundRequest {
  return inboundRequest({
    id: `req-${type}`,
    type,
    timestamp: Date.now(),
    ...(payload !== undefined ? { payload } : {}),
  } as BaseMessage);
}

/** A saved delta configuration, as the run that created the records ran it. */
function deltaConfig(): SyncConfig {
  return {
    id: 'cfg-1',
    name: 'Accounts',
    description: '',
    sourceOrgId: 'org-source',
    targetOrgId: TARGET,
    direction: 'source_to_target',
    mode: 'delta',
    objects: [],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

describe('SyncRemovalHandler', () => {
  let dir: string;
  let store: ConfigStore;
  let creations: SyncRunCreations;
  let deps: HandlerDeps;
  let handler: SyncRemovalHandler;
  let registry: BackgroundOperationRegistry;
  let org: MemoryRemovalOrg;
  let history: SyncHistoryEntry[];
  let running: Set<string>;
  let orgType: string;
  let edition: string | undefined;

  const posted = <T extends BaseMessage>(type: string): T[] =>
    vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as T)
      .filter((m) => m.type === type);
  const errors = () =>
    posted<BaseMessage & { payload: { code: string; message: string } }>('sync:remove:error');
  const answer = (): SyncRemovalResult | undefined =>
    posted<BaseMessage & { payload: { result: SyncRemovalResult } }>('sync:remove:response')[0]
      ?.payload.result;
  const info = (): SyncRunRemovalInfo | null | undefined =>
    posted<BaseMessage & { payload: { info: SyncRunRemovalInfo | null } }>(
      'sync:removal:info:response',
    )[0]?.payload.info;
  const trail = () => new AuditTrailStore(store).list().entries;

  /** A run ten minutes ago that created two accounts and a file. */
  async function ran(runId = 'run-1'): Promise<void> {
    const recorder = creations.recorder({
      runId,
      configId: 'cfg-1',
      configName: 'Accounts',
      sourceOrgId: 'org-source',
      targetOrgId: TARGET,
      startedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
    });
    recorder.note('Account', [A1, A2]);
    recorder.note('ContentDocument', [DOC]);
    await recorder.end({ status: 'success' });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-sync-remove-'));
    store = new ConfigStore(new InMemoryConfigStoreBackend());
    store.initialize();
    creations = nodeSyncRunCreations(dir);
    registry = new BackgroundOperationRegistry();
    history = [];
    running = new Set();
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
    handler = new SyncRemovalHandler(deps, { list: () => history }, (runId) => running.has(runId));
    handler.setRunCreations(creations);
    handler.setRegistry(registry);
    handler.setLiveOperationTracker(new LiveOperationTracker());

    org = new MemoryRemovalOrg();
    const at = new Date(Date.now() - 10 * 60_000).toISOString();
    org.add('Account', { Id: A1 }, at);
    org.add('Account', { Id: A2 }, at);
    org.add('ContentDocument', { Id: DOC }, at);
    vi.mocked(removalOrg).mockReturnValue(org);
    await ran();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('sync:removal:info', () => {
    it('says what the run created and what a removal takes, files first, with nothing asked of the org', async () => {
      await handler.handle(buildMsg('sync:removal:info', { runId: 'run-1' }));

      expect(info()).toMatchObject({
        runId: 'run-1',
        configName: 'Accounts',
        targetOrgId: TARGET,
        created: 3,
        left: [
          { objectApiName: 'ContentDocument', count: 1 },
          { objectApiName: 'Account', count: 2 },
        ],
      });
      expect(info()?.refusal).toBeUndefined();
      expect(removalOrg).not.toHaveBeenCalled();
    });

    it("offers nothing on a production org, with the guard's reason", async () => {
      orgType = 'Production';
      edition = 'Enterprise Edition';

      await handler.handle(buildMsg('sync:removal:info', { runId: 'run-1' }));

      expect(info()?.refusal).toEqual({
        code: 'GUARD_BLOCKED',
        message: `delete is not allowed on production org ${TARGET}`,
      });
    });

    it("offers the removal on a Developer Edition, as Forge's and Frozen's removals do", async () => {
      // Registered as a production org, as a Developer Edition says IsSandbox false.
      orgType = 'Production';
      edition = 'Developer Edition';

      await handler.handle(buildMsg('sync:removal:info', { runId: 'run-1' }));

      expect(info()?.refusal).toBeUndefined();
    });

    it('offers nothing while the run is still writing', async () => {
      running.add('run-1');

      await handler.handle(buildMsg('sync:removal:info', { runId: 'run-1' }));

      expect(info()?.refusal?.code).toBe('RUNNING');
    });

    it('answers null for a run nothing of which is kept', async () => {
      await handler.handle(buildMsg('sync:removal:info', { runId: 'never-ran' }));

      expect(info()).toBeNull();
    });
  });

  describe('sync:removal:list', () => {
    it('lists the runs kept that no history entry holds — a run a closed window stopped', async () => {
      await ran('run-2');
      history = [
        {
          result: { created: { runId: 'run-1', objects: [], files: 0 } },
        } as unknown as SyncHistoryEntry,
      ];

      await handler.handle(buildMsg('sync:removal:list'));

      const [response] = posted<BaseMessage & { payload: { runs: SyncRunRemovalInfo[] } }>(
        'sync:removal:list:response',
      );
      expect(response.payload.runs.map((run) => run.runId)).toEqual(['run-2']);
    });

    it('lists a run stopped during a call with the call it had under way, and not one that ended having created nothing', async () => {
      const start = {
        configId: 'cfg-1',
        configName: 'Accounts',
        sourceOrgId: 'org-source',
        targetOrgId: TARGET,
      };
      // Killed while its first Bulk API job ran: nothing kept, but its rows may be there.
      const cut = creations.recorder({ ...start, runId: 'run-cut' });
      cut.sending?.('Contact', 12_000);
      await cut.flush();
      // Every row refused: it ended, created nothing, and has nothing to take back.
      const refused = creations.recorder({ ...start, runId: 'run-refused' });
      refused.sending?.('Contact', 3);
      refused.answered?.('Contact', []);
      await refused.end({ status: 'failure' });

      await handler.handle(buildMsg('sync:removal:list'));

      const [response] = posted<BaseMessage & { payload: { runs: SyncRunRemovalInfo[] } }>(
        'sync:removal:list:response',
      );
      const listed = response.payload.runs.filter((run) => run.runId !== 'run-1');
      expect(listed).toEqual([
        expect.objectContaining({
          runId: 'run-cut',
          created: 0,
          inFlight: { objectApiName: 'Contact', rows: 12_000 },
        }),
      ]);
    });
  });

  describe('sync:remove', () => {
    const remove = (payload: Record<string, unknown> = {}) =>
      handler.handle(buildMsg('sync:remove', { runId: 'run-1', ...payload }));

    it('removes what the run created, records it in the audit trail, and is not offered again', async () => {
      await remove();

      expect(errors()).toEqual([]);
      expect(org.deletes.map((d) => d.objectApiName)).toEqual(['ContentDocument', 'Account']);
      expect(org.all('Account')).toEqual([]);
      expect(answer()).toMatchObject({
        runId: 'run-1',
        status: 'success',
        includeChanged: false,
        objects: [
          { objectApiName: 'ContentDocument', planned: 1, deleted: 1 },
          { objectApiName: 'Account', planned: 2, deleted: 2 },
        ],
      });
      expect(trail()).toEqual([
        expect.objectContaining({
          action: 'cleanup_delete',
          module: 'sync',
          operationId: 'req-sync:remove',
          orgId: TARGET,
          outcome: 'success',
          guard: 'allowed',
        }),
      ]);

      vi.mocked(deps.broker.postToWebview).mockClear();
      await handler.handle(buildMsg('sync:removal:info', { runId: 'run-1' }));
      expect(info()).toMatchObject({ left: [], removed: { deleted: 3 } });

      await remove();
      expect(errors()[0].payload.code).toBe('ALREADY_REMOVED');
    });

    it('has the configuration forget which source records the accounts it took were the copies of', async () => {
      const orgs = { sourceOrgId: 'org-source', targetOrgId: TARGET };
      await creations.idMap().record('cfg-1', orgs, 'Account', [
        [fakeId('001', 101), A1],
        [fakeId('001', 102), A2],
      ]);

      await remove();

      expect(errors()).toEqual([]);
      expect((await creations.idMap().load('cfg-1', orgs)).size).toBe(0);
    });

    it('drops what went from the configuration that ran: its next run reads the objects whole', async () => {
      const configs = new SyncConfigStore(store);
      configs.save(deltaConfig());
      configs.recordWatermark('cfg-1', {
        sourceOrgId: 'org-source',
        targetOrgId: TARGET,
        objectApiName: 'Account',
        watermark: '2026-10-13T09:00:00.000Z',
        fingerprint: 'a'.repeat(64),
        recordedAt: '2026-10-13T09:01:00.000Z',
      });
      configs.recordFile('cfg-1', {
        sourceOrgId: 'org-source',
        targetOrgId: TARGET,
        objectApiName: 'Account',
        kind: 'document',
        sourceId: fakeId('069', 9),
        targetId: DOC,
        sourceVersionId: fakeId('068', 9),
        linked: [A1],
        copiedAt: '2026-10-13T09:01:00.000Z',
      });

      await remove();

      expect(answer()).toMatchObject({ readWhole: ['Account'], filesForgotten: 1 });
      const delta = configs.loadDelta('cfg-1');
      expect(delta.kind === 'stored' && delta.state.entries[0].removedAt).toBe(
        answer()?.finishedAt,
      );
      const files = configs.loadFiles('cfg-1');
      expect(files.kind === 'stored' ? files.map.entries : undefined).toEqual([]);
    });

    it('removes from a Developer Edition what the run created there', async () => {
      orgType = 'Production';
      edition = 'Developer Edition';

      await remove();

      expect(errors()).toEqual([]);
      expect(answer()?.status).toBe('success');
      expect(org.all('Account')).toEqual([]);
      expect(trail()).toEqual([
        expect.objectContaining({ action: 'cleanup_delete', module: 'sync', outcome: 'success' }),
      ]);
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

    it('refuses a run still writing, and one nothing of which is kept', async () => {
      running.add('run-1');
      await remove();
      await handler.handle(buildMsg('sync:remove', { runId: 'never-ran' }));

      expect(errors().map((e) => e.payload.code)).toEqual(['RUNNING', 'NOT_KEPT']);
      expect(org.deletes).toEqual([]);
    });

    it('stops between two calls on a cancel through the registry, recorded as cancelled', async () => {
      org.beforeDelete = () => registry.abort('req-sync:remove');

      await remove();

      expect(answer()?.status).toBe('cancelled');
      expect(org.deletes).toHaveLength(1);
      expect(trail()).toEqual([
        expect.objectContaining({ action: 'cleanup_delete', module: 'sync', outcome: 'cancelled' }),
      ]);
      // What the cancel kept it from reaching is offered for the next removal.
      vi.mocked(deps.broker.postToWebview).mockClear();
      await handler.handle(buildMsg('sync:removal:info', { runId: 'run-1' }));
      expect(info()?.left).toEqual([{ objectApiName: 'Account', count: 2 }]);
    });

    it('does not start when cancelled while Production Guard asked', async () => {
      deps.infraServices = {
        productionGuard: {
          check: () => ({ allowed: true, requiresConfirmation: true, impactSummary: 'asks' }),
          confirmIfNeeded: async () => {
            registry.cancelBeforeStart('req-sync:remove');
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
          details: { code: 'ABORTED_BEFORE_START', runId: 'run-1' },
        }),
      ]);
    });

    it('takes the records changed since the run only when asked to', async () => {
      org.touch('Account', A2, new Date(Date.now() + 60_000).toISOString());

      await remove();
      expect(answer()?.objects.find((o) => o.objectApiName === 'Account')).toMatchObject({
        deleted: 1,
        keptChanged: 1,
      });

      vi.mocked(deps.broker.postToWebview).mockClear();
      await remove({ includeChanged: true });

      expect(answer()).toMatchObject({ status: 'success', includeChanged: true });
      expect(org.all('Account')).toEqual([]);
    });
  });
  describe('sync:earlier-copies', () => {
    const copies = () =>
      posted<BaseMessage & { payload: { copies: unknown } }>('sync:earlier-copies:response')[0]
        ?.payload.copies;

    it('counts what the last run between the two orgs created that the target still holds', async () => {
      const query = vi.fn(async (soql: string) => ({
        totalSize: soql.includes(A1) && soql.includes(A2) ? 1 : 0,
      }));
      const { getJsforceConnection } = await import('../../core/connection/ConnectionHelper.js');
      vi.mocked(getJsforceConnection).mockResolvedValue({ query } as never);

      await handler.handle(
        buildMsg('sync:earlier-copies', {
          sourceOrgId: 'org-source',
          targetOrgId: TARGET,
          objects: ['Account'],
        }),
      );

      expect(copies()).toEqual({
        leftAsIs: false,
        run: expect.objectContaining({ runId: 'run-1', configName: 'Accounts' }),
        objects: [{ objectApiName: 'Account', count: 1 }],
      });
      expect(query).toHaveBeenCalledWith(
        `SELECT COUNT() FROM Account WHERE Id IN ('${A2}', '${A1}')`,
      );
    });

    it('says a run of a saved configuration leaves what earlier runs of it copied as it is', async () => {
      new SyncConfigStore(store).save(deltaConfig());

      await handler.handle(
        buildMsg('sync:earlier-copies', {
          sourceOrgId: 'org-source',
          targetOrgId: TARGET,
          objects: ['Account'],
          configId: 'cfg-1',
        }),
      );

      expect(copies()).toEqual({ leftAsIs: true, objects: [] });
    });
  });
});
