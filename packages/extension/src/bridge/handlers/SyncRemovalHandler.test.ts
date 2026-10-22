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
import { BackupRecordStore, nodeBackupFiles } from '../../modules/dataops/BackupRecordStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { MemoryRemovalOrg } from '../../test/memoryRemovalOrg.js';
import { MemoryRestoreOrg } from '../../test/memoryRestoreOrg.js';
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

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
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
        message: `Deleting records is not allowed in the production org ${TARGET}.`,
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

  describe('a run whose window closed during a Bulk API job', () => {
    const JOB = fakeId('750', 1);
    /** Two contacts the job created, and one it matched and updated: the target's before. */
    const C1 = fakeId('003', 1);
    const C2 = fakeId('003', 2);
    const UPDATED = fakeId('003', 3);
    let asked: string[];

    beforeEach(async () => {
      const recorder = creations.recorder({
        runId: 'run-job',
        configId: 'cfg-1',
        configName: 'Accounts',
        sourceOrgId: 'org-source',
        targetOrgId: TARGET,
        startedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      });
      recorder.sending?.('Contact', 3, { upsert: true });
      recorder.sending?.('Contact', 3, { job: JOB, upsert: true });
      await recorder.flush();
      // The job ran on to its end once the window had closed.
      const jobEnded = new Date(Date.now() - 60_000).toISOString();
      org.add('Contact', { Id: C1 }, jobEnded);
      org.add('Contact', { Id: C2 }, jobEnded);
      org.add('Contact', { Id: UPDATED }, jobEnded);
      asked = [];
      vi.mocked(getJsforceConnection).mockResolvedValue({
        bulk2: {
          job: (_type: string, { id }: { id: string }) => {
            asked.push(id);
            return {
              check: async () => ({ state: 'JobComplete', systemModstamp: jobEnded }),
              getSuccessfulResults: async () => [
                { sf__Id: C1, sf__Created: 'true' },
                { sf__Id: UPDATED, sf__Created: 'false' },
                { sf__Id: C2, sf__Created: 'true' },
              ],
              abort: async () => undefined,
            };
          },
        },
      } as unknown as Awaited<ReturnType<typeof getJsforceConnection>>);
    });

    it('is listed with what the job created, read back by its id once, and removed with it', async () => {
      await handler.handle(buildMsg('sync:removal:list'));

      expect(asked).toEqual([JOB]);
      const [response] = posted<BaseMessage & { payload: { runs: SyncRunRemovalInfo[] } }>(
        'sync:removal:list:response',
      );
      const listed = response.payload.runs.find((run) => run.runId === 'run-job');
      expect(listed).toMatchObject({ created: 2, left: [{ objectApiName: 'Contact', count: 2 }] });
      expect(listed?.inFlight).toBeUndefined();
      // Answered once: the next listing reads the run's file alone.
      await handler.handle(buildMsg('sync:removal:list'));
      expect(asked).toEqual([JOB]);

      await handler.handle(buildMsg('sync:remove', { runId: 'run-job' }));

      expect(errors()).toEqual([]);
      expect(answer()).toMatchObject({
        status: 'success',
        objects: [{ objectApiName: 'Contact', planned: 2, deleted: 2 }],
      });
      // The contact the upsert matched was the target's before, and stays.
      expect(org.all('Contact').map((row) => row.Id)).toEqual([UPDATED]);
    });

    it('is answered by its info and its removal too, with no listing first', async () => {
      await handler.handle(buildMsg('sync:removal:info', { runId: 'run-job' }));

      expect(info()).toMatchObject({ created: 2, left: [{ objectApiName: 'Contact', count: 2 }] });

      await handler.handle(buildMsg('sync:remove', { runId: 'run-job' }));
      expect(answer()?.objects).toEqual([
        expect.objectContaining({ objectApiName: 'Contact', planned: 2, deleted: 2 }),
      ]);
    });

    it('is answered once the run ended too: a job that failed while it was polled ended the run in failure', async () => {
      // The run's end, written as it failed, read as though nothing were
      // left under way, and its removal took none of the job's records.
      const recorder = creations.recorder({
        runId: 'run-failed',
        configId: 'cfg-1',
        configName: 'Accounts',
        sourceOrgId: 'org-source',
        targetOrgId: TARGET,
        startedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      });
      recorder.sending?.('Contact', 3, { upsert: true });
      recorder.sending?.('Contact', 3, { job: JOB, upsert: true });
      await recorder.end({ status: 'failure' });

      await handler.handle(buildMsg('sync:removal:info', { runId: 'run-failed' }));

      expect(asked).toEqual([JOB]);
      expect(info()).toMatchObject({ created: 2, left: [{ objectApiName: 'Contact', count: 2 }] });
      await handler.handle(buildMsg('sync:remove', { runId: 'run-failed' }));
      expect(answer()?.objects).toEqual([
        expect.objectContaining({ objectApiName: 'Contact', planned: 2, deleted: 2 }),
      ]);
    });

    it('is neither aborted nor removable from a second window while the window writing it is alive', async () => {
      // The run's file names this process as the one writing it, as the
      // first window's does; the second window is another process. It has
      // created two accounts, and its contacts' job is open, uploading.
      const live = creations.recorder({
        runId: 'run-live',
        configId: 'cfg-1',
        configName: 'Accounts',
        sourceOrgId: 'org-source',
        targetOrgId: TARGET,
        startedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      });
      live.note('Account', [A1, A2]);
      live.sending?.('Contact', 3, { upsert: true });
      live.sending?.('Contact', 3, { job: JOB, upsert: true });
      await live.flush();
      let aborted = 0;
      vi.mocked(getJsforceConnection).mockResolvedValue({
        bulk2: {
          job: (_type: string, { id }: { id: string }) => {
            asked.push(id);
            return {
              // Open for two hours: past the grace a job just opened is given.
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
      const second = new SyncRemovalHandler(deps, { list: () => history }, () => false, {
        pid: process.pid + 100_000,
        startedAt: new Date().toISOString(),
      });
      second.setRunCreations(creations);
      second.setRegistry(registry);

      await second.handle(buildMsg('sync:removal:list'));
      await second.handle(buildMsg('sync:removal:info', { runId: 'run-live' }));
      await second.handle(buildMsg('sync:remove', { runId: 'run-live' }));

      // No job of a run the live process writes is read back, nor aborted.
      expect(asked).toEqual([]);
      expect(aborted).toBe(0);
      expect(org.all('Account').map((row) => row.Id)).toEqual([A1, A2]);
      const [response] = posted<BaseMessage & { payload: { runs: SyncRunRemovalInfo[] } }>(
        'sync:removal:list:response',
      );
      expect(response.payload.runs.find((run) => run.runId === 'run-live')).toMatchObject({
        runningElsewhere: true,
        refusal: { code: 'RUNNING' },
      });
      expect(info()).toMatchObject({ runningElsewhere: true, refusal: { code: 'RUNNING' } });
      expect(errors()).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            code: 'RUNNING',
            message: expect.stringContaining('another window'),
          }),
        }),
      ]);
      expect(answer()).toBeUndefined();
    });

    it('asks nothing of the org for a run this window is still writing', async () => {
      running.add('run-job');

      await handler.handle(buildMsg('sync:removal:info', { runId: 'run-job' }));

      expect(asked).toEqual([]);
      expect(info()).toMatchObject({
        created: 0,
        inFlight: { objectApiName: 'Contact', rows: 3 },
      });
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

  describe('a run that wrote over records of the target', () => {
    const HELD = fakeId('001', 7);
    const BACKUP = 'sync-before-run-over';
    const TAKEN = new Date(Date.now() - 12 * 60_000).toISOString();
    let target: MemoryRestoreOrg;

    beforeEach(async () => {
      // An upsert that matched an account the target held: its name kept
      // in the DataOps store before the run wrote over it.
      const backups = new BackupRecordStore(nodeBackupFiles(dir));
      await backups.begin(BACKUP, 'Account');
      await backups.append(BACKUP, 'Account', [{ Id: HELD, Name: 'Before' }]);
      // Listed by its metadata, as the run keeps it: what the retention removes.
      store.set(`backup:${BACKUP}`, { operationId: BACKUP, timestamp: TAKEN }, 'backups');
      handler.setBackupRecordStore(backups);
      const recorder = creations.recorder({
        runId: 'run-over',
        configId: 'cfg-1',
        configName: 'Accounts',
        sourceOrgId: 'org-source',
        targetOrgId: TARGET,
        startedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
      });
      recorder.overwriting?.('Account', BACKUP, [HELD]);
      recorder.overwrote?.('Account', []);
      await recorder.end({ status: 'success' });
      target = new MemoryRestoreOrg();
      target.add(
        'Account',
        { Id: HELD, Name: 'After' },
        new Date(Date.now() - 60_000).toISOString(),
      );
      vi.mocked(removalOrg).mockReturnValue(target);
    });

    it('is listed and offered with what it wrote over, though it created nothing', async () => {
      await handler.handle(buildMsg('sync:removal:info', { runId: 'run-over' }));

      expect(info()).toMatchObject({
        runId: 'run-over',
        created: 0,
        left: [],
        overwritten: 1,
        putBack: [{ objectApiName: 'Account', count: 1 }],
      });
      expect(info()?.refusal).toBeUndefined();

      await handler.handle(buildMsg('sync:removal:list'));
      const [response] = posted<BaseMessage & { payload: { runs: SyncRunRemovalInfo[] } }>(
        'sync:removal:list:response',
      );
      expect(response.payload.runs.map((run) => run.runId)).toContain('run-over');
    });

    it('says until when the values are kept, and offers nothing to put back once their backup is gone', async () => {
      // The extension's settings, `sandforge.backup.maxAgeDays` at its default.
      deps.services = {
        getSandforgeSetting: <T>(_key: string, fallback: T): T => fallback,
      } as unknown as HandlerDeps['services'];
      await handler.handle(buildMsg('sync:removal:info', { runId: 'run-over' }));
      expect(info()?.putBackKeptUntil).toBe(
        new Date(Date.parse(TAKEN) + 30 * 24 * 60 * 60_000).toISOString(),
      );

      // The retention took the backup, its metadata with it.
      store.delete(`backup:${BACKUP}`);
      vi.mocked(deps.broker.postToWebview).mockClear();
      await handler.handle(buildMsg('sync:removal:info', { runId: 'run-over' }));

      expect(info()).toMatchObject({ overwritten: 1, putBackNotKept: 1 });
      expect(info()?.putBack).toBeUndefined();
      expect(info()?.putBackKeptUntil).toBeUndefined();
    });

    it('gives the record its values back, records it updated in the audit trail, and is not offered again', async () => {
      await handler.handle(buildMsg('sync:remove', { runId: 'run-over' }));

      expect(errors()).toEqual([]);
      expect(target.all('Account')).toEqual([
        expect.objectContaining({ Id: HELD, Name: 'Before' }),
      ]);
      expect(answer()).toMatchObject({
        status: 'success',
        objects: [],
        restored: [{ objectApiName: 'Account', planned: 1, restored: 1 }],
      });
      expect(trail()).toEqual([
        expect.objectContaining({
          action: 'cleanup_delete',
          module: 'sync',
          outcome: 'success',
          objects: [expect.objectContaining({ objectApiName: 'Account', updated: 1, failed: 0 })],
        }),
      ]);

      vi.mocked(deps.broker.postToWebview).mockClear();
      await handler.handle(buildMsg('sync:removal:info', { runId: 'run-over' }));
      expect(info()?.putBack).toBeUndefined();
      await handler.handle(buildMsg('sync:remove', { runId: 'run-over' }));
      expect(errors()[0]?.payload.code).toBe('ALREADY_REMOVED');
    });
  });

  describe('two upsert runs of a configuration that wrote the same records', () => {
    const HELD = fakeId('001', 8);
    const COPY = fakeId('001', 9);
    let target: MemoryRestoreOrg;
    const now = Date.now();
    const minutesAgo = (minutes: number): string => new Date(now - minutes * 60_000).toISOString();

    afterEach(() => {
      vi.useRealTimers();
    });

    beforeEach(async () => {
      // The first run wrote over an account the target held and created a
      // copy of another; the second, of the same keys, wrote over both: its
      // keeper kept what the first had written.
      const backups = new BackupRecordStore(nodeBackupFiles(dir));
      await backups.begin('sync-before-first', 'Account');
      await backups.append('sync-before-first', 'Account', [{ Id: HELD, Name: 'v0' }]);
      await backups.begin('sync-before-second', 'Account');
      await backups.append('sync-before-second', 'Account', [
        { Id: HELD, Name: 'v1' },
        { Id: COPY, Name: 'c1' },
      ]);
      for (const id of ['sync-before-first', 'sync-before-second']) {
        store.set(`backup:${id}`, { operationId: id, timestamp: minutesAgo(30) }, 'backups');
      }
      handler.setBackupRecordStore(backups);
      // Each run's lines dated when it wrote them.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.parse(minutesAgo(30)));
      const first = creations.recorder({
        runId: 'run-first',
        configId: 'cfg-1',
        configName: 'Accounts',
        sourceOrgId: 'org-source',
        targetOrgId: TARGET,
        startedAt: minutesAgo(31),
      });
      first.overwriting?.('Account', 'sync-before-first', [HELD]);
      first.overwrote?.('Account', []);
      first.note('Account', [COPY]);
      await first.end({ status: 'success' });
      vi.setSystemTime(Date.parse(minutesAgo(10)));
      const second = creations.recorder({
        runId: 'run-second',
        configId: 'cfg-1',
        configName: 'Accounts',
        sourceOrgId: 'org-source',
        targetOrgId: TARGET,
        startedAt: minutesAgo(11),
      });
      second.overwriting?.('Account', 'sync-before-second', [HELD, COPY]);
      second.overwrote?.('Account', []);
      await second.end({ status: 'success' });
      vi.useRealTimers();
      // The second run wrote a new name over the account, and the copy's
      // name again as it was: the org dated both by its write all the same.
      target = new MemoryRestoreOrg();
      target.add('Account', { Id: HELD, Name: 'v2' }, minutesAgo(10));
      target.add('Account', { Id: COPY, Name: 'c1' }, minutesAgo(10));
      vi.mocked(removalOrg).mockReturnValue(target);
    });

    it('names, on the earlier run, the later one that wrote its records again', async () => {
      await handler.handle(buildMsg('sync:removal:info', { runId: 'run-first' }));

      expect(info()?.writtenAgain).toEqual([
        { runId: 'run-second', configName: 'Accounts', startedAt: expect.any(String), records: 2 },
      ]);
    });

    it('takes both back newest first, each settled with nothing kept as changed since it', async () => {
      await handler.handle(buildMsg('sync:remove', { runId: 'run-second' }));
      expect(answer()).toMatchObject({
        status: 'success',
        restored: [{ objectApiName: 'Account', planned: 2, restored: 2, keptChanged: 0 }],
      });
      // When it ran, and as whom, kept on the earlier run too: what the
      // target posted under the records it gave back is a removal's doing.
      expect((await creations.get('run-first'))?.removal?.removalSpans).toEqual([
        { first: expect.any(String), last: expect.any(String), userId: expect.any(String) },
      ]);

      vi.mocked(deps.broker.postToWebview).mockClear();
      await handler.handle(buildMsg('sync:remove', { runId: 'run-first' }));

      expect(errors()).toEqual([]);
      expect(answer()).toMatchObject({
        status: 'success',
        objects: [{ objectApiName: 'Account', planned: 1, deleted: 1, keptChanged: 0 }],
        restored: [{ objectApiName: 'Account', planned: 1, restored: 1, keptChanged: 0 }],
      });
      expect(target.all('Account')).toEqual([expect.objectContaining({ Id: HELD, Name: 'v0' })]);
      for (const runId of ['run-first', 'run-second']) {
        vi.mocked(deps.broker.postToWebview).mockClear();
        await handler.handle(buildMsg('sync:remove', { runId }));
        expect(errors()[0]?.payload.code).toBe('ALREADY_REMOVED');
      }
    });
  });

  describe('a delta run that deleted in the target what the source deleted', () => {
    const C1 = fakeId('003', 21);
    const C2 = fakeId('003', 22);

    beforeEach(async () => {
      const recorder = creations.recorder({
        runId: 'run-deleted',
        configId: 'cfg-1',
        configName: 'Accounts',
        sourceOrgId: 'org-source',
        targetOrgId: TARGET,
        startedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
      });
      recorder.deleted?.('Contact', [C1, C2]);
      await recorder.end({ status: 'success' });
      // Contacts the target held before any run, tied by the write's key.
      for (const id of [C1, C2]) {
        org.add('Contact', { Id: id }, new Date(Date.now() - 400 * 24 * 60 * 60_000).toISOString());
        org.trash('Contact', id);
      }
      vi.mocked(getJsforceConnection).mockResolvedValue({
        soap: { undelete: (ids: string[]) => org.undelete(ids) },
      } as unknown as Awaited<ReturnType<typeof getJsforceConnection>>);
    });

    it('says what it deleted, and brings it back from the recycle bin with its removal', async () => {
      await handler.handle(buildMsg('sync:removal:info', { runId: 'run-deleted' }));
      expect(info()).toMatchObject({
        created: 0,
        deleted: 2,
        bringBack: [{ objectApiName: 'Contact', count: 2 }],
      });
      expect(info()?.refusal).toBeUndefined();

      await handler.handle(buildMsg('sync:remove', { runId: 'run-deleted' }));

      expect(errors()).toEqual([]);
      expect(answer()).toMatchObject({
        status: 'success',
        undeleted: [{ objectApiName: 'Contact', planned: 2, undeleted: 2, goneForGood: 0 }],
      });
      expect(org.all('Contact').map((row) => row.Id)).toEqual([C1, C2]);
      expect(trail()).toEqual([
        expect.objectContaining({
          objects: [expect.objectContaining({ objectApiName: 'Contact', created: 2 })],
        }),
      ]);
      vi.mocked(deps.broker.postToWebview).mockClear();
      await handler.handle(buildMsg('sync:remove', { runId: 'run-deleted' }));
      expect(errors()[0]?.payload.code).toBe('ALREADY_REMOVED');
    });

    it('counts one emptied from the recycle bin since as gone for good, and settles', async () => {
      org.purge(C2);

      await handler.handle(buildMsg('sync:remove', { runId: 'run-deleted' }));

      expect(answer()).toMatchObject({
        status: 'partial',
        undeleted: [{ objectApiName: 'Contact', undeleted: 1, goneForGood: 1 }],
      });
      vi.mocked(deps.broker.postToWebview).mockClear();
      await handler.handle(buildMsg('sync:removal:info', { runId: 'run-deleted' }));
      expect(info()?.bringBack).toBeUndefined();
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
