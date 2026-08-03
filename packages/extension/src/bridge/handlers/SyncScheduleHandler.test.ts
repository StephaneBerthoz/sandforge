import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncScheduleHandler } from './SyncScheduleHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type { BaseMessage, SyncExecutionResult } from '@sandforge/shared';

/** Fixed reference instant for every test (a Friday). */
const FIXED_NOW_ISO = '2026-03-27T12:00:00.000Z';

/** Creates minimal mock deps backed by an in-memory JSON store. */
function createMockDeps(): HandlerDeps & {
  store: Map<string, string>;
  posted: Array<{ type: string; payload: unknown }>;
} {
  let idCounter = 0;
  const store = new Map<string, string>();
  const posted: Array<{ type: string; payload: unknown }> = [];

  const deps = {
    log: vi.fn(),
    broker: {
      postToWebview: vi.fn((msg: { type: string; payload?: unknown }) => {
        posted.push({ type: msg.type, payload: msg.payload });
      }),
    } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: { getOrg: vi.fn() } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: {
      get: vi.fn((key: string) => {
        const raw = store.get(key);
        return raw ? JSON.parse(raw) : undefined;
      }),
      set: vi.fn((key: string, value: unknown) => {
        store.set(key, JSON.stringify(value));
      }),
      delete: vi.fn((key: string) => {
        const existed = store.has(key);
        store.delete(key);
        return existed;
      }),
      getKeysByPrefix: vi.fn((prefix: string) =>
        [...store.keys()].filter((k) => k.startsWith(prefix)),
      ),
      getByCategory: vi.fn(() => ({})),
      has: vi.fn((key: string) => store.has(key)),
    } as unknown as HandlerDeps['configStore'],
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    nextId: () => String(++idCounter),
  };

  return Object.assign(deps, { store, posted });
}

/** Schedule entry shape accepted by syncScheduleUpsertPayloadSchema. */
function validSchedule(id = 'sched-1'): Record<string, unknown> {
  return {
    id,
    name: 'Minutely sync',
    configId: 'cfg-1',
    cron: '* * * * *',
    timezone: 'UTC',
    enabled: true,
    maxRetries: 3,
    notifyOnComplete: false,
    notifyOnFailure: false,
    createdAt: '2026-03-20T00:00:00Z',
    updatedAt: '2026-03-20T00:00:00Z',
    version: 1,
  };
}

/** Seed the sync config the schedule points at (`sync:config:` prefix). */
function seedSyncConfig(deps: { store: Map<string, string> }, id = 'cfg-1'): void {
  deps.store.set(
    `sync:config:${id}`,
    JSON.stringify({ id, name: 'scheduled-config', objects: [] }),
  );
}

function upsertMessage(id = 'sched-1', overrides?: Record<string, unknown>): BaseMessage {
  return {
    id: `req-upsert-${id}`,
    type: 'sync:schedule:upsert',
    timestamp: Date.now(),
    payload: { schedule: { ...validSchedule(id), ...overrides } },
  } as BaseMessage;
}

function successResult(): SyncExecutionResult {
  return {
    configId: 'cfg-1',
    operationId: 'op-1',
    status: 'success',
    objectResults: [],
    totalProcessed: 10,
    totalSuccess: 10,
    totalFailed: 0,
    totalSkipped: 0,
    duration: 1000,
    timestamp: new Date().toISOString(),
  };
}

/** Persisted schedule entry read straight from the mock store. */
function persistedSchedule(deps: { store: Map<string, string> }, id = 'sched-1') {
  const raw = deps.store.get(`schedule:sync:${id}`);
  return raw
    ? (JSON.parse(raw) as {
        lastRunAt?: string;
        lastResult?: string;
        nextRunAt?: string;
      })
    : undefined;
}

describe('SyncScheduleHandler', () => {
  let handler: SyncScheduleHandler;
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW_ISO));
    deps = createMockDeps();
    handler = new SyncScheduleHandler(deps);
  });

  afterEach(() => {
    handler.stopScheduler();
    vi.useRealTimers();
  });

  it('returns false for unhandled message types', async () => {
    const msg: BaseMessage = { id: '1', type: 'unknown:type', timestamp: Date.now() };
    expect(await handler.handle(msg)).toBe(false);
  });

  it('upserts a schedule and lists it back', async () => {
    seedSyncConfig(deps);
    expect(await handler.handle(upsertMessage())).toBe(true);

    const upsertResp = deps.posted.find((m) => m.type === 'sync:schedule:upsert:response');
    expect(upsertResp).toBeDefined();
    const schedule = (upsertResp!.payload as { schedule: { nextRunAt?: string } }).schedule;
    expect(schedule.nextRunAt).toBeTruthy();

    await handler.handle({ id: 'req-list', type: 'sync:schedule:list', timestamp: Date.now() });
    const listResp = deps.posted.find((m) => m.type === 'sync:schedule:list:response');
    expect(
      (listResp!.payload as { schedules: Array<{ id: string }> }).schedules.map((s) => s.id),
    ).toContain('sched-1');
  });

  it('rejects an invalid upsert payload on sync:schedule:error', async () => {
    const msg = {
      id: 'req-bad',
      type: 'sync:schedule:upsert',
      timestamp: Date.now(),
      payload: { schedule: { id: 'x' } },
    } as BaseMessage;
    await handler.handle(msg);
    expect(deps.posted.some((m) => m.type === 'sync:schedule:error')).toBe(true);
  });

  it('executes a due schedule on the 60s tick once startScheduler is wired', async () => {
    seedSyncConfig(deps);
    await handler.handle(upsertMessage());

    const execute = vi.fn(async () => successResult());
    handler.startScheduler(execute);

    // cron '* * * * *' from 12:00:00Z -> nextRunAt 12:01:00Z; first tick at +60s.
    await vi.advanceTimersByTimeAsync(61_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ id: 'cfg-1' }));

    const persisted = persistedSchedule(deps);
    expect(persisted?.lastResult).toBe('success');
    expect(persisted?.lastRunAt).toBeTruthy();
  });

  it('marks the schedule as failed when the execution bridge rejects', async () => {
    seedSyncConfig(deps);
    await handler.handle(upsertMessage());

    const execute = vi.fn(async (): Promise<SyncExecutionResult> => {
      throw new Error('sync engine exploded');
    });
    handler.startScheduler(execute);

    await vi.advanceTimersByTimeAsync(61_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(persistedSchedule(deps)?.lastResult).toBe('failure');
  });

  it('does not fire after stopScheduler', async () => {
    seedSyncConfig(deps);
    await handler.handle(upsertMessage());

    const execute = vi.fn(async () => successResult());
    handler.startScheduler(execute);
    handler.stopScheduler();

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(execute).not.toHaveBeenCalled();
  });

  it('caps concurrent scheduled executions at sync.maxConcurrentOps', async () => {
    seedSyncConfig(deps);
    deps.services = {
      getSandforgeSetting: <T>(_key: string, _fallback: T): T => 1 as T,
    } as unknown as HandlerDeps['services'];
    // notifyOnFailure surfaces the skip reason through the notification-center log.
    await handler.handle(upsertMessage('sched-1', { notifyOnFailure: true }));

    // First execution never resolves -> stays in flight across the next tick.
    const execute = vi.fn(() => new Promise<SyncExecutionResult>(() => {}));
    handler.startScheduler(execute);

    // Tick 1 (12:01): schedule due, execution starts and stays in flight.
    await vi.advanceTimersByTimeAsync(61_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(1);

    // Tick 2 (12:02): still due (nextRunAt not recomputed yet) but the
    // in-flight cap (1) rejects the re-entry instead of stacking a second run.
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(persistedSchedule(deps)?.lastResult).toBe('failure');
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('already in flight'));
  });
});
