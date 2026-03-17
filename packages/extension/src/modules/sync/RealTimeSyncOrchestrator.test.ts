import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RealTimeSyncOrchestrator } from './RealTimeSyncOrchestrator';
import type { RealTimeSyncOrchestratorDeps } from './RealTimeSyncOrchestrator';
import type { CDCListener } from './CDCListener';
import type { CDCReplicator } from './CDCReplicator';
import type { RealTimeSyncConfig, CDCEvent } from '@sandforge/shared';

function createConfig(overrides?: Partial<RealTimeSyncConfig>): RealTimeSyncConfig {
  return {
    sessionId: 'session-001',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    watchedObjects: ['Account', 'Contact'],
    conflictStrategy: 'source_wins',
    flushIntervalMs: 1000,
    maxBatchSize: 100,
    ...overrides,
  };
}

function createMockListener(): CDCListener {
  const eventHandlers: Array<(event: CDCEvent) => void> = [];
  const connectionHandlers: Array<(connected: boolean) => void> = [];
  const errorHandlers: Array<(error: Error) => void> = [];

  return {
    onEvent: vi.fn((handler) => { eventHandlers.push(handler); }),
    onConnection: vi.fn((handler) => { connectionHandlers.push(handler); }),
    onError: vi.fn((handler) => { errorHandlers.push(handler); }),
    start: vi.fn(async () => {
      for (const handler of connectionHandlers) {
        handler(true);
      }
    }),
    stop: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    getLastReplayId: vi.fn().mockReturnValue(-1),
    getReconnectAttempts: vi.fn().mockReturnValue(0),
    // Expose handlers for testing
    _emitEvent: (event: CDCEvent) => {
      for (const handler of eventHandlers) {
        handler(event);
      }
    },
    _emitConnection: (connected: boolean) => {
      for (const handler of connectionHandlers) {
        handler(connected);
      }
    },
    _emitError: (error: Error) => {
      for (const handler of errorHandlers) {
        handler(error);
      }
    },
  } as unknown as CDCListener & {
    _emitEvent: (event: CDCEvent) => void;
    _emitConnection: (connected: boolean) => void;
    _emitError: (error: Error) => void;
  };
}

function createMockReplicator(): CDCReplicator {
  return {
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    receive: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    getTotalApplied: vi.fn().mockReturnValue(0),
    getTotalFailed: vi.fn().mockReturnValue(0),
    getBufferedCount: vi.fn().mockReturnValue(0),
    getAverageLagMs: vi.fn().mockReturnValue(0),
    getCurrentLagMs: vi.fn().mockReturnValue(0),
    isRunning: vi.fn().mockReturnValue(false),
  } as unknown as CDCReplicator;
}

function createMockDeps(
  listener?: ReturnType<typeof createMockListener>,
  replicator?: CDCReplicator,
): RealTimeSyncOrchestratorDeps {
  return {
    createListener: vi.fn().mockReturnValue(listener ?? createMockListener()),
    createReplicator: vi.fn().mockReturnValue(replicator ?? createMockReplicator()),
  };
}

function createTestEvent(overrides?: Partial<CDCEvent>): CDCEvent {
  return {
    replayId: 42,
    objectApiName: 'Account',
    changeType: 'UPDATE',
    recordIds: ['001xx0000001234'],
    changedFields: { Name: 'Acme Corp' },
    commitTimestamp: new Date().toISOString(),
    commitUser: '005xx0000001111',
    transactionKey: 'txn-abc-123',
    ...overrides,
  };
}

describe('RealTimeSyncOrchestrator', () => {
  let mockListener: ReturnType<typeof createMockListener>;
  let mockReplicator: CDCReplicator;
  let deps: RealTimeSyncOrchestratorDeps;
  let orchestrator: RealTimeSyncOrchestrator;

  beforeEach(() => {
    vi.useFakeTimers();
    mockListener = createMockListener();
    mockReplicator = createMockReplicator();
    deps = createMockDeps(mockListener, mockReplicator);
    orchestrator = new RealTimeSyncOrchestrator(deps);
  });

  afterEach(() => {
    void orchestrator.stop();
    vi.useRealTimers();
  });

  describe('start', () => {
    it('should create listener and replicator from config', async () => {
      const config = createConfig();
      await orchestrator.start(config);

      expect(deps.createListener).toHaveBeenCalledWith(config);
      expect(deps.createReplicator).toHaveBeenCalledWith(config);
    });

    it('should start both listener and replicator', async () => {
      await orchestrator.start(createConfig());

      expect(mockListener.start).toHaveBeenCalled();
      expect(mockReplicator.start).toHaveBeenCalled();
    });

    it('should transition to syncing status on successful connection', async () => {
      const statusHandler = vi.fn();
      orchestrator.onStatusChange(statusHandler);

      await orchestrator.start(createConfig());

      expect(statusHandler).toHaveBeenCalledWith('connecting');
      expect(statusHandler).toHaveBeenCalledWith('syncing');
    });

    it('should store session config', async () => {
      const config = createConfig();
      await orchestrator.start(config);

      expect(orchestrator.getConfig()).toBe(config);
      expect(orchestrator.getSessionId()).toBe('session-001');
    });

    it('should not start if already running', async () => {
      await orchestrator.start(createConfig());

      const callCount = vi.mocked(deps.createListener).mock.calls.length;
      await orchestrator.start(createConfig());

      expect(vi.mocked(deps.createListener).mock.calls.length).toBe(callCount);
    });
  });

  describe('stop', () => {
    it('should stop listener and replicator', async () => {
      await orchestrator.start(createConfig());
      await orchestrator.stop();

      expect(mockListener.stop).toHaveBeenCalled();
      expect(mockReplicator.stop).toHaveBeenCalled();
    });

    it('should transition to disconnected status', async () => {
      await orchestrator.start(createConfig());

      const statusHandler = vi.fn();
      orchestrator.onStatusChange(statusHandler);
      await orchestrator.stop();

      expect(statusHandler).toHaveBeenCalledWith('disconnected');
    });

    it('should clear references to listener and replicator', async () => {
      await orchestrator.start(createConfig());
      await orchestrator.stop();

      expect(orchestrator.getStatus()).toBe('disconnected');
    });
  });

  describe('pause and resume', () => {
    it('should transition to paused status', async () => {
      await orchestrator.start(createConfig());

      orchestrator.pause();

      expect(orchestrator.getStatus()).toBe('paused');
    });

    it('should transition back to syncing on resume', async () => {
      await orchestrator.start(createConfig());
      orchestrator.pause();

      orchestrator.resume();

      expect(orchestrator.getStatus()).toBe('syncing');
    });

    it('should not pause when not syncing', () => {
      orchestrator.pause();

      expect(orchestrator.getStatus()).toBe('disconnected');
    });

    it('should not resume when not paused', async () => {
      await orchestrator.start(createConfig());

      orchestrator.resume();

      expect(orchestrator.getStatus()).toBe('syncing');
    });
  });

  describe('event feed', () => {
    it('should forward CDC events to feed handlers', async () => {
      const feedHandler = vi.fn();
      orchestrator.onEventFeed(feedHandler);

      await orchestrator.start(createConfig());

      const event = createTestEvent();
      const typedListener = mockListener as unknown as { _emitEvent: (event: CDCEvent) => void };
      typedListener._emitEvent(event);

      expect(feedHandler).toHaveBeenCalledWith(event, true, undefined);
    });

    it('should forward events to replicator', async () => {
      await orchestrator.start(createConfig());

      const event = createTestEvent();
      const typedListener = mockListener as unknown as { _emitEvent: (event: CDCEvent) => void };
      typedListener._emitEvent(event);

      expect(mockReplicator.receive).toHaveBeenCalledWith(event);
    });

    it('should track events received count', async () => {
      await orchestrator.start(createConfig());

      const typedListener = mockListener as unknown as { _emitEvent: (event: CDCEvent) => void };
      typedListener._emitEvent(createTestEvent({ replayId: 1 }));
      typedListener._emitEvent(createTestEvent({ replayId: 2 }));
      typedListener._emitEvent(createTestEvent({ replayId: 3 }));

      const metrics = orchestrator.getMetrics();
      expect(metrics.eventsReceived).toBe(3);
    });
  });

  describe('metrics', () => {
    it('should return metrics with zero values initially', () => {
      const metrics = orchestrator.getMetrics();

      expect(metrics.eventsReceived).toBe(0);
      expect(metrics.eventsApplied).toBe(0);
      expect(metrics.eventsFailed).toBe(0);
      expect(metrics.eventsPerMinute).toBe(0);
      expect(metrics.errorRate).toBe(0);
    });

    it('should calculate error rate from replicator stats', async () => {
      vi.mocked(mockReplicator.getTotalApplied).mockReturnValue(8);
      vi.mocked(mockReplicator.getTotalFailed).mockReturnValue(2);

      await orchestrator.start(createConfig());

      const metrics = orchestrator.getMetrics();
      expect(metrics.errorRate).toBe(20);
    });

    it('should track lag from replicator', async () => {
      vi.mocked(mockReplicator.getAverageLagMs).mockReturnValue(250);
      vi.mocked(mockReplicator.getCurrentLagMs).mockReturnValue(100);

      await orchestrator.start(createConfig());

      const metrics = orchestrator.getMetrics();
      expect(metrics.averageLagMs).toBe(250);
      expect(metrics.currentLagMs).toBe(100);
    });

    it('should track events per minute', async () => {
      await orchestrator.start(createConfig());

      const typedListener = mockListener as unknown as { _emitEvent: (event: CDCEvent) => void };
      typedListener._emitEvent(createTestEvent({ replayId: 1 }));
      typedListener._emitEvent(createTestEvent({ replayId: 2 }));

      const metrics = orchestrator.getMetrics();
      expect(metrics.eventsPerMinute).toBe(2);
    });

    it('should update lastEventAt timestamp', async () => {
      await orchestrator.start(createConfig());

      const typedListener = mockListener as unknown as { _emitEvent: (event: CDCEvent) => void };
      typedListener._emitEvent(createTestEvent());

      const metrics = orchestrator.getMetrics();
      expect(metrics.lastEventAt).toBeDefined();
    });
  });

  describe('connection error handling', () => {
    it('should transition to error status on disconnect', async () => {
      await orchestrator.start(createConfig());

      const typedListener = mockListener as unknown as { _emitConnection: (connected: boolean) => void };
      typedListener._emitConnection(false);

      expect(orchestrator.getStatus()).toBe('error');
    });

    it('should emit error events to feed', async () => {
      const feedHandler = vi.fn();
      orchestrator.onEventFeed(feedHandler);

      await orchestrator.start(createConfig());

      const typedListener = mockListener as unknown as { _emitError: (error: Error) => void };
      typedListener._emitError(new Error('Streaming API error'));

      expect(feedHandler).toHaveBeenCalledWith(
        expect.any(Object),
        false,
        'Streaming API error',
      );
    });
  });

  describe('watched objects', () => {
    it('should return watched objects from config', async () => {
      await orchestrator.start(createConfig());

      expect(orchestrator.getWatchedObjects()).toEqual(['Account', 'Contact']);
    });

    it('should return empty array when no session', () => {
      expect(orchestrator.getWatchedObjects()).toEqual([]);
    });
  });
});
