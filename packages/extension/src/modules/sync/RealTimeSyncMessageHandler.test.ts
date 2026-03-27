import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseMessage, RealTimeSyncMetrics, RealTimeSyncStatus } from '@sandforge/shared';
import { RealTimeSyncMessageHandler } from './RealTimeSyncMessageHandler.js';

/* ------------------------------------------------------------------ */
/* Mock MessageBroker                                                  */
/* ------------------------------------------------------------------ */
function createMockBroker() {
  const handlers = new Map<string, Set<(msg: BaseMessage) => void | Promise<void>>>();
  return {
    on: vi.fn((type: string, handler: (msg: BaseMessage) => void | Promise<void>) => {
      let set = handlers.get(type);
      if (!set) {
        set = new Set();
        handlers.set(type, set);
      }
      set.add(handler);
      return () => { handlers.get(type)?.delete(handler); };
    }),
    postToWebview: vi.fn(),
    handlers,
    /** Simulate an incoming message. */
    dispatch(msg: BaseMessage): void {
      const set = handlers.get(msg.type);
      if (set) {
        for (const handler of set) {
          handler(msg);
        }
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Mock RealTimeSyncOrchestrator                                       */
/* ------------------------------------------------------------------ */
function createMockOrchestrator() {
  let statusHandler: ((status: RealTimeSyncStatus) => void) | null = null;
  let eventFeedHandler: ((event: unknown, applied: boolean, error?: string) => void) | null = null;

  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue('disconnected' as RealTimeSyncStatus),
    getMetrics: vi.fn().mockReturnValue({
      eventsReceived: 100,
      eventsApplied: 95,
      eventsFailed: 5,
      eventsPerMinute: 50,
      averageLagMs: 200,
      currentLagMs: 150,
      errorRate: 5,
      startedAt: '2026-03-27T00:00:00Z',
    } as RealTimeSyncMetrics),
    getWatchedObjects: vi.fn().mockReturnValue(['Account', 'Contact']),
    getSessionId: vi.fn().mockReturnValue('session-123'),
    onStatusChange: vi.fn((handler: (status: RealTimeSyncStatus) => void) => {
      statusHandler = handler;
      return () => { statusHandler = null; };
    }),
    onEventFeed: vi.fn((handler: (event: unknown, applied: boolean, error?: string) => void) => {
      eventFeedHandler = handler;
      return () => { eventFeedHandler = null; };
    }),
    /** Simulate a status change. */
    emitStatus(status: RealTimeSyncStatus): void {
      statusHandler?.(status);
    },
    /** Simulate an event feed. */
    emitEvent(event: unknown, applied: boolean, error?: string): void {
      eventFeedHandler?.(event, applied, error);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Mock CDCEventBatcher                                                */
/* ------------------------------------------------------------------ */
function createMockBatcher() {
  return {
    push: vi.fn(),
    flush: vi.fn(),
    dispose: vi.fn(),
    getBufferedCount: vi.fn().mockReturnValue(0),
  };
}

function makeMsg(type: string, payload?: Record<string, unknown>): BaseMessage {
  return {
    id: `test-${Date.now()}`,
    type,
    timestamp: Date.now(),
    ...(payload ? { payload } : {}),
  } as BaseMessage;
}

describe('RealTimeSyncMessageHandler', () => {
  let broker: ReturnType<typeof createMockBroker>;
  let orchestrator: ReturnType<typeof createMockOrchestrator>;
  let batcher: ReturnType<typeof createMockBatcher>;
  let handler: RealTimeSyncMessageHandler;

  beforeEach(() => {
    broker = createMockBroker();
    orchestrator = createMockOrchestrator();
    batcher = createMockBatcher();
    handler = new RealTimeSyncMessageHandler(
      broker as unknown as Parameters<typeof RealTimeSyncMessageHandler['prototype']['register']> extends [] ? never : never,
      orchestrator as unknown as Parameters<typeof RealTimeSyncMessageHandler['prototype']['register']> extends [] ? never : never,
      batcher as unknown as Parameters<typeof RealTimeSyncMessageHandler['prototype']['register']> extends [] ? never : never,
    );
    // Fix TypeScript casting - use direct construction
    handler = new (RealTimeSyncMessageHandler as unknown as new (...args: unknown[]) => RealTimeSyncMessageHandler)(broker, orchestrator, batcher);
    handler.register();
  });

  it('should register handlers for realtime:start, stop, status, metrics', () => {
    expect(broker.on).toHaveBeenCalledWith('realtime:start', expect.any(Function));
    expect(broker.on).toHaveBeenCalledWith('realtime:stop', expect.any(Function));
    expect(broker.on).toHaveBeenCalledWith('realtime:status', expect.any(Function));
    expect(broker.on).toHaveBeenCalledWith('realtime:metrics', expect.any(Function));
  });

  it('should trigger orchestrator.start with correct config on realtime:start', async () => {
    const msg = makeMsg('realtime:start', {
      sourceOrgId: 'org-src',
      targetOrgId: 'org-tgt',
      watchedObjects: ['Account'],
      conflictStrategy: 'source_wins',
      flushIntervalMs: 150,
      maxBatchSize: 100,
    });

    broker.dispatch(msg);
    // Allow async handler to resolve
    await vi.waitFor(() => {
      expect(orchestrator.start).toHaveBeenCalledTimes(1);
    });

    const config = orchestrator.start.mock.calls[0][0];
    expect(config.sourceOrgId).toBe('org-src');
    expect(config.targetOrgId).toBe('org-tgt');
    expect(config.watchedObjects).toEqual(['Account']);
  });

  it('should batch events from orchestrator feed into batcher', async () => {
    const msg = makeMsg('realtime:start', {
      sourceOrgId: 'org-src',
      targetOrgId: 'org-tgt',
      watchedObjects: ['Account'],
      conflictStrategy: 'source_wins',
      flushIntervalMs: 150,
      maxBatchSize: 100,
    });

    broker.dispatch(msg);
    await vi.waitFor(() => {
      expect(orchestrator.onEventFeed).toHaveBeenCalled();
    });

    // Simulate event from orchestrator
    const mockEvent = { replayId: 1, objectApiName: 'Account', changeType: 'CREATE', recordIds: ['001A'], changedFields: {}, commitTimestamp: '2026-03-27T00:00:00Z', commitUser: '005A', transactionKey: 'tx-1' };
    orchestrator.emitEvent(mockEvent, true);

    expect(batcher.push).toHaveBeenCalledWith(mockEvent);
  });

  it('should trigger orchestrator.stop on realtime:stop', async () => {
    const msg = makeMsg('realtime:stop', { sessionId: 'session-123' });
    broker.dispatch(msg);

    await vi.waitFor(() => {
      expect(orchestrator.stop).toHaveBeenCalledTimes(1);
    });

    await vi.waitFor(() => {
      expect(broker.postToWebview).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'realtime:stopped' }),
      );
    });
  });

  it('should return current status on realtime:status', () => {
    orchestrator.getStatus.mockReturnValue('syncing');
    const msg = makeMsg('realtime:status');
    broker.dispatch(msg);

    expect(broker.postToWebview).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'realtime:status:response',
        payload: expect.objectContaining({ status: 'syncing' }),
      }),
    );
  });

  it('should return metrics snapshot on realtime:metrics', () => {
    const msg = makeMsg('realtime:metrics');
    broker.dispatch(msg);

    expect(broker.postToWebview).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'realtime:metrics:response',
        payload: expect.objectContaining({
          eventsReceived: 100,
          eventsApplied: 95,
        }),
      }),
    );
  });

  it('should clean up handlers on dispose', () => {
    handler.dispose();
    expect(batcher.dispose).toHaveBeenCalled();
  });
});
