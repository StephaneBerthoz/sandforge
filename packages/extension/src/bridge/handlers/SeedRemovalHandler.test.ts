import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage, SeedRemovalResult, SeedRunRemovalInfo } from '@sandforge/shared';

import { SeedRemovalHandler } from './SeedRemovalHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import {
  nodeSeedRunCreations,
  type SeedRunCreations,
} from '../../modules/seed/SeedRunCreations.js';
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
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

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
  /** The extension's storage directory, where the runs are kept. */
  let storage: string;
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

  const lists = () =>
    posted<BaseMessage & { payload: { runs: SeedRunRemovalInfo[] } }>(
      'seed:removal:list:response',
    ).map((m) => m.payload.runs);

  afterEach(() => {
    rmSync(storage, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    storage = mkdtempSync(join(tmpdir(), 'sandforge-seed-removal-'));
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
    runs = nodeSeedRunCreations(storage);
    handler = new SeedRemovalHandler(deps);
    handler.setRunCreations(runs);
    handler.setRegistry(registry);
    handler.setLiveOperationTracker(new LiveOperationTracker());

    // A seed ten minutes ago: an account, then two contacts under it.
    const startedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    const at = new Date(Date.now() - 10 * 60_000).toISOString();
    await runs.record({
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
        message: `Deleting records is not allowed in the production org ${TARGET}.`,
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

  describe('seed:removal:list', () => {
    it('lists the runs kept, newest first, and says which can still be removed', async () => {
      await runs.record({
        runId: 'op-2',
        targetOrgId: TARGET,
        startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        finishedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
        status: 'partial',
        objectResults: [{ objectApiName: 'Contact', createdIds: [fakeId('003', 9)] }],
      });
      org.add('Contact', { Id: fakeId('003', 9) }, new Date(Date.now() - 4 * 60_000).toISOString());
      await remove();
      vi.mocked(deps.broker.postToWebview).mockClear();

      await handler.handle(buildMsg('seed:removal:list', {}));

      const [listed] = lists();
      expect(listed.map((run) => [run.runId, run.left.length > 0, run.removed?.deleted])).toEqual([
        ['op-2', true, undefined],
        ['op-1', false, 3],
      ]);
      expect(listed[0]).toMatchObject({ targetOrgId: TARGET, created: 1 });
      expect(listed[0].refusal).toBeUndefined();
    });

    it('lists a seed a pipeline ran by its pipeline, removable as a seed of the page', async () => {
      const at = new Date(Date.now() - 4 * 60_000).toISOString();
      const recorder = runs.recorder({
        runId: 'op-pipeline',
        targetOrgId: TARGET,
        startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        pipeline: { name: 'Nightly refresh' },
      });
      recorder.note('Contact', [fakeId('003', 7)]);
      await recorder.end({ status: 'success', finishedAt: at, objectResults: [] });

      await handler.handle(buildMsg('seed:removal:list', {}));

      const [listed] = lists();
      expect(listed.find((run) => run.runId === 'op-pipeline')).toMatchObject({
        pipeline: { name: 'Nightly refresh' },
        created: 1,
        left: [{ objectApiName: 'Contact', count: 1 }],
      });
      expect(listed.find((run) => run.runId === 'op-pipeline')?.refusal).toBeUndefined();
      // A seed of the page names no pipeline.
      expect(listed.find((run) => run.runId === 'op-1')?.pipeline).toBeUndefined();
    });

    it('lists a run whose window closed under it as unfinished, dated by its last write, and removes what it wrote', async () => {
      const recorder = runs.recorder({
        runId: 'op-cut',
        targetOrgId: TARGET,
        startedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      });
      const cut = fakeId('003', 7);
      recorder.note('Contact', [cut]);
      await vi.waitFor(async () => expect(await runs.get('op-cut')).toBeDefined());
      const written = (await runs.get('op-cut'))?.lastWrittenAt;
      org.add('Contact', { Id: cut }, new Date(Date.now() - 60_000).toISOString());

      await handler.handle(buildMsg('seed:removal:list', {}));

      const [listed] = lists();
      const unfinished = listed.find((run) => run.runId === 'op-cut');
      expect(unfinished).toMatchObject({
        unfinished: true,
        endedAt: written,
        created: 1,
        left: [{ objectApiName: 'Contact', count: 1 }],
      });
      expect(unfinished?.refusal).toBeUndefined();
      expect(listed.find((run) => run.runId === 'op-1')?.unfinished).toBeUndefined();

      await remove({ runId: 'op-cut' });
      expect(answer()).toMatchObject({
        status: 'success',
        objects: [{ objectApiName: 'Contact', planned: 1, deleted: 1 }],
      });
    });

    it('lists a run this window is still writing as running, not stopped, and refuses its removal', async () => {
      const writing = new Set(['op-live']);
      const live = new SeedRemovalHandler(deps, undefined, (runId) => writing.has(runId));
      live.setRunCreations(runs);
      live.setRegistry(registry);
      const recorder = runs.recorder({
        runId: 'op-live',
        targetOrgId: TARGET,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      });
      const account = fakeId('001', 5);
      recorder.note('Account', [account]);
      await vi.waitFor(async () => expect(await runs.get('op-live')).toBeDefined());
      org.add('Account', { Id: account }, new Date().toISOString());

      await live.handle(buildMsg('seed:removal:list', {}));
      await live.handle(buildMsg('seed:remove', { runId: 'op-live' }));

      const listed = lists()[0].find((run) => run.runId === 'op-live');
      expect(listed).toMatchObject({ running: true, refusal: { code: 'RUNNING' } });
      expect(listed?.unfinished).toBeUndefined();
      expect(errors()[0].payload).toMatchObject({ code: 'RUNNING' });
      expect(org.deletes).toEqual([]);

      // Once it ended, it is offered as any run.
      writing.clear();
      vi.mocked(deps.broker.postToWebview).mockClear();
      await live.handle(buildMsg('seed:removal:list', {}));
      const after = lists()[0].find((run) => run.runId === 'op-live');
      expect(after?.running).toBeUndefined();
      expect(after?.refusal).toBeUndefined();
    });

    it('lists a seed whose window closed during a Bulk API job with what the job wrote, read back by its id, and removes it all', async () => {
      const job = fakeId('750', 4);
      const account = fakeId('001', 5);
      const contacts = [fakeId('003', 7), fakeId('003', 8)];
      const recorder = runs.recorder({
        runId: 'op-job',
        targetOrgId: TARGET,
        startedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      });
      recorder.sending('Account', 1);
      recorder.answered('Account', [account]);
      recorder.sending('Contact', 2);
      recorder.sending('Contact', 2, { job });
      await vi.waitFor(async () => expect((await runs.get('op-job'))?.inFlight?.job).toBe(job));
      // The job ran on to its end once the window had closed.
      const jobEnded = new Date(Date.now() - 60_000).toISOString();
      org.add('Account', { Id: account }, new Date(Date.now() - 2 * 60_000).toISOString());
      for (const id of contacts) org.add('Contact', { Id: id, AccountId: account }, jobEnded);
      const asked: string[] = [];
      vi.mocked(getJsforceConnection).mockResolvedValue({
        bulk2: {
          job: (_type: string, { id }: { id: string }) => {
            asked.push(id);
            return {
              check: async () => ({ state: 'JobComplete', systemModstamp: jobEnded }),
              getSuccessfulResults: async () =>
                contacts.map((sf__Id) => ({ sf__Id, sf__Created: 'true' })),
              abort: async () => undefined,
            };
          },
        },
      } as unknown as Awaited<ReturnType<typeof getJsforceConnection>>);

      await handler.handle(buildMsg('seed:removal:list', {}));

      expect(asked).toEqual([job]);
      const listed = lists()[0].find((run) => run.runId === 'op-job');
      expect(listed).toMatchObject({
        unfinished: true,
        created: 3,
        left: [
          { objectApiName: 'Contact', count: 2 },
          { objectApiName: 'Account', count: 1 },
        ],
      });
      // Answered once: the next listing reads the run's file alone.
      await handler.handle(buildMsg('seed:removal:list', {}));
      expect(asked).toEqual([job]);

      await remove({ runId: 'op-job' });
      expect(answer()).toMatchObject({
        status: 'success',
        objects: [
          { objectApiName: 'Contact', planned: 2, deleted: 2 },
          { objectApiName: 'Account', planned: 1, deleted: 1 },
        ],
      });
      expect(org.all('Contact').filter((row) => contacts.includes(row.Id))).toEqual([]);
    });

    it('leaves a seed whose job the org still processes as it is, and asks nothing of a seed still writing', async () => {
      const job = fakeId('750', 5);
      const writing = new Set(['op-live']);
      const live = new SeedRemovalHandler(deps, undefined, (runId) => writing.has(runId));
      live.setRunCreations(runs);
      for (const runId of ['op-job', 'op-live']) {
        const recorder = runs.recorder({ runId, targetOrgId: TARGET });
        recorder.answered('Account', [fakeId('001', runId === 'op-job' ? 6 : 7)]);
        recorder.sending('Contact', 300, { job });
      }
      await vi.waitFor(async () => {
        expect((await runs.get('op-job'))?.inFlight?.job).toBe(job);
        expect((await runs.get('op-live'))?.inFlight?.job).toBe(job);
      });
      const asked: string[] = [];
      vi.mocked(getJsforceConnection).mockResolvedValue({
        bulk2: {
          job: (_type: string, { id }: { id: string }) => {
            asked.push(id);
            return {
              check: async () => ({ state: 'InProgress' }),
              getSuccessfulResults: async () => [],
              abort: async () => undefined,
            };
          },
        },
      } as unknown as Awaited<ReturnType<typeof getJsforceConnection>>);

      await live.handle(buildMsg('seed:removal:list', {}));

      // Only the run no window writes is read back, and its job runs on.
      expect(asked).toEqual([job]);
      expect((await runs.get('op-job'))?.inFlight?.job).toBe(job);
      expect(lists()[0].find((run) => run.runId === 'op-job')?.created).toBe(1);
    });

    it('lists a seed another window is writing as running there, aborting none of its jobs and removing nothing', async () => {
      // The file names this process as the one writing the seed, as the first
      // window's does; the second window is another process. Its contacts'
      // job has been open for two hours: past the grace a job just opened gets.
      const job = fakeId('750', 6);
      const account = fakeId('001', 8);
      const recorder = runs.recorder({ runId: 'op-other', targetOrgId: TARGET });
      recorder.answered('Account', [account]);
      recorder.sending('Contact', 5000, { job });
      await vi.waitFor(async () => expect((await runs.get('op-other'))?.inFlight?.job).toBe(job));
      org.add('Account', { Id: account });
      let aborted = 0;
      const asked: string[] = [];
      vi.mocked(getJsforceConnection).mockResolvedValue({
        bulk2: {
          job: (_type: string, { id }: { id: string }) => {
            asked.push(id);
            return {
              check: async () => ({
                state: 'Open',
                createdDate: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
              }),
              getSuccessfulResults: async () => [],
              abort: async () => {
                aborted++;
              },
            };
          },
        },
      } as unknown as Awaited<ReturnType<typeof getJsforceConnection>>);
      const second = new SeedRemovalHandler(deps, undefined, () => false, {
        pid: process.pid + 100_000,
        startedAt: new Date().toISOString(),
      });
      second.setRunCreations(runs);
      second.setRegistry(registry);

      await second.handle(buildMsg('seed:removal:list', {}));
      await second.handle(buildMsg('seed:remove', { runId: 'op-other' }));

      expect(asked).toEqual([]);
      expect(aborted).toBe(0);
      const listed = lists()[0].find((run) => run.runId === 'op-other');
      expect(listed).toMatchObject({ runningElsewhere: true, refusal: { code: 'RUNNING' } });
      expect(listed?.unfinished).toBeUndefined();
      expect(errors()).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            code: 'RUNNING',
            message: expect.stringContaining('another window'),
          }),
        }),
      ]);
      expect(org.all('Account').map((row) => row.Id)).toContain(account);
    });

    it('lists no run in a window given nowhere to keep them', async () => {
      const bare = new SeedRemovalHandler(deps);

      await bare.handle(buildMsg('seed:removal:list', {}));

      expect(lists()).toEqual([[]]);
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

    it('removes a run the window that ran it no longer holds: after a reload, from what the extension kept', async () => {
      // The window reloads: a new handler, and a new store over the same storage.
      const reloaded = new SeedRemovalHandler(deps);
      reloaded.setRunCreations(nodeSeedRunCreations(storage));
      reloaded.setRegistry(new BackgroundOperationRegistry());

      await reloaded.handle(buildMsg('seed:remove', { runId: 'op-1' }));

      expect(errors()).toEqual([]);
      expect(answer()).toMatchObject({ status: 'success' });
      expect(org.all('Contact')).toEqual([]);
      expect(org.all('Account')).toEqual([]);
      // And what it did is kept for the next reload.
      const kept = await nodeSeedRunCreations(storage).get('op-1');
      expect(kept?.removal?.undo).toMatchObject({ deleted: 3 });
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
            message: `Operation blocked by Production Guard: Deleting records is not allowed in the production org ${TARGET}.`,
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
