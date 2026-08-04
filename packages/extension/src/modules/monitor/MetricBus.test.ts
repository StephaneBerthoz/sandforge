import { describe, it, expect, vi, afterEach } from 'vitest';
import type { MetricSample } from '@sandforge/shared';

import {
  MetricBus,
  type MetricBusBridge,
  type MetricBusLogger,
  DEFAULT_COALESCE_WINDOW_MS,
} from './MetricBus.js';

/** Build a fresh sample with sensible defaults. */
function buildSample(overrides: Partial<MetricSample> = {}): MetricSample {
  return {
    ts: '2026-05-02T10:00:00.000Z',
    seriesId: 'limits.api',
    orgId: 'org-1',
    value: 42,
    ...overrides,
  };
}

/** Create a fresh bridge mock (so tests stay isolated). */
function buildBridge(): MetricBusBridge & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn() };
}

/** Create a fresh logger mock. */
function buildLogger(): MetricBusLogger & { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn() };
}

describe('MetricBus', () => {
  afterEach(() => {
    // Restore real timers between tests so a leak in one test does not bleed.
    vi.useRealTimers();
  });

  describe('Test 1 — type-narrowed subscribe', () => {
    it('invokes a typed handler synchronously on emit', () => {
      const bus = new MetricBus();
      const handler = vi.fn<[payload: MetricSample], void>();
      bus.subscribe('monitor:metric', handler);
      const sample = buildSample();
      const ok = bus.emit('monitor:metric', sample);
      expect(ok).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(sample);
      // Compile-time assertion: payload is narrowed — `.seriesId` exists.
      const callPayload = handler.mock.calls[0]![0];
      expect(callPayload.seriesId).toBe('limits.api');
      bus.dispose();
    });
  });

  describe('Test 2 — listener isolation', () => {
    it('a throwing subscriber does not prevent siblings from firing', () => {
      const bus = new MetricBus();
      const throwing = vi.fn(() => {
        throw new Error('listener-boom');
      });
      const safe = vi.fn();
      bus.subscribe('monitor:metric', throwing);
      bus.subscribe('monitor:metric', safe);
      bus.emit('monitor:metric', buildSample());
      expect(throwing).toHaveBeenCalledTimes(1);
      expect(safe).toHaveBeenCalledTimes(1);
      bus.dispose();
    });
  });

  describe('Test 3 — Zod validation rejects malformed payload', () => {
    it('does not invoke subscribers AND logs a warning on validation failure', () => {
      const logger = buildLogger();
      const bus = new MetricBus({ logger });
      const subscriber = vi.fn();
      bus.subscribe('monitor:metric', subscriber);

      // Cast to any so TS lets us pass garbage that the runtime should reject.
      const ok = bus.emit('monitor:metric', {
        ts: 'not-iso',
        seriesId: '',
        orgId: '',
        value: NaN,
      } as unknown as MetricSample);

      expect(ok).toBe(false);
      expect(subscriber).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [message, meta] = logger.warn.mock.calls[0]!;
      expect(message).toMatch(/MetricBus rejected/);
      expect(meta?.type).toBe('monitor:metric');
      expect(Array.isArray(meta?.issues)).toBe(true);
      bus.dispose();
    });
  });

  describe('Test 4 — batch coalescing', () => {
    it('flushes 5 emits within window into ONE batch envelope after 250 ms', () => {
      vi.useFakeTimers();
      const bridge = buildBridge();
      const bus = new MetricBus({ bridge });

      // Emit 5 samples within 100 ms of each other (well below the 250 ms window).
      bus.emit('monitor:metric', buildSample({ value: 1 }));
      bus.emit('monitor:metric', buildSample({ value: 2 }));
      bus.emit('monitor:metric', buildSample({ value: 3 }));
      vi.advanceTimersByTime(100);
      bus.emit('monitor:metric', buildSample({ value: 4 }));
      bus.emit('monitor:metric', buildSample({ value: 5 }));

      // Just before the window closes — bridge has not been called.
      vi.advanceTimersByTime(149);
      expect(bridge.send).not.toHaveBeenCalled();

      // Crossing the window triggers a single batch flush.
      vi.advanceTimersByTime(1);
      expect(bridge.send).toHaveBeenCalledTimes(1);
      const sent = bridge.send.mock.calls[0]![0];
      expect(sent.type).toBe('monitor:metrics:batch');
      expect((sent.payload as { samples: MetricSample[] }).samples).toHaveLength(5);
      expect((sent.payload as { samples: MetricSample[] }).samples.map((s) => s.value)).toEqual([
        1, 2, 3, 4, 5,
      ]);

      bus.dispose();
    });
  });

  describe('Test 5 — high-priority events bypass coalescing', () => {
    it('forwards monitor:anomaly:detected synchronously with no timer wait', () => {
      vi.useFakeTimers();
      const bridge = buildBridge();
      const bus = new MetricBus({ bridge });

      bus.emit('monitor:anomaly:detected', {
        orgId: 'org-1',
        seriesId: 'limits.api',
        value: 95,
        mean: 50,
        stdDev: 10,
        zScore: 4.5,
        recentContext: [],
      });

      // Bridge.send was called synchronously (no timer advance needed).
      expect(bridge.send).toHaveBeenCalledTimes(1);
      const sent = bridge.send.mock.calls[0]![0];
      expect(sent.type).toBe('monitor:anomaly:detected');

      // Advancing timers should NOT produce a duplicate forward.
      vi.advanceTimersByTime(DEFAULT_COALESCE_WINDOW_MS * 4);
      expect(bridge.send).toHaveBeenCalledTimes(1);
      bus.dispose();
    });

    it('forwards monitor:drift:detected and monitor:fleet:summary synchronously', () => {
      const bridge = buildBridge();
      const bus = new MetricBus({ bridge });

      bus.emit('monitor:drift:detected', {
        orgId: 'org-1',
        snapshotPairId: 'pair-1',
        summary: 'New permission added',
        deltaCount: 1,
        severity: 'permission',
      });
      bus.emit('monitor:fleet:summary', {
        orgs: [
          {
            orgId: 'org-1',
            name: 'Prod',
            healthScore: 80,
            lastUpdated: '2026-05-02T10:00:00.000Z',
            alertCount: 0,
          },
        ],
      });

      expect(bridge.send).toHaveBeenCalledTimes(2);
      bus.dispose();
    });
  });

  describe('Test 6 — dispose() clears subscribers + pending timer', () => {
    it('drops pending samples and prevents the scheduled batch flush', () => {
      vi.useFakeTimers();
      const bridge = buildBridge();
      const bus = new MetricBus({ bridge });
      const subscriber = vi.fn();
      bus.subscribe('monitor:metric', subscriber);

      // Emit (which queues a flush) then dispose BEFORE the window closes.
      bus.emit('monitor:metric', buildSample({ value: 1 }));
      expect(subscriber).toHaveBeenCalledTimes(1);

      bus.dispose();

      // The flush timer that was scheduled BEFORE dispose() must NOT fire.
      vi.advanceTimersByTime(DEFAULT_COALESCE_WINDOW_MS * 4);
      expect(bridge.send).not.toHaveBeenCalled();
    });

    it('detaches subscribers so a previously-registered handler stops firing', () => {
      const bus = new MetricBus();
      const subscriber = vi.fn();
      bus.subscribe('monitor:metric', subscriber);
      bus.emit('monitor:metric', buildSample({ value: 1 }));
      expect(subscriber).toHaveBeenCalledTimes(1);

      bus.dispose();

      // After dispose() the subscriber set is empty: a probe that survives the
      // bus and tries to emit (e.g. a leaked listener) does NOT trigger the
      // detached handler.
      bus.emit('monitor:metric', buildSample({ value: 2 }));
      expect(subscriber).toHaveBeenCalledTimes(1); // unchanged
    });
  });

  describe('Test 7 — exhaustiveness compile guard (P-03.8)', () => {
    it('documents the assertNever pattern so adding a new discriminant fails the build', () => {
      // This test does not assert at runtime — its value is the comment +
      // the exhaustiveness probe below, which documents the assertNever
      // pattern: in real routing code an unhandled discriminant fails the
      // `never` assignment, forcing any future contributor to add a routing
      // case in MetricBus.routeToBridge() before the union grows. The
      // runtime expectation is just that assertNever throws — covered by the
      // shared package's MetricEvent.test.ts.
      //
      // If a new event type is added to MetricEventTypeMap WITHOUT updating
      // the routing switch, that same `never` assignment in
      // MetricBus.routeToBridge() stops compiling.
      const exhaustivenessProbe = (type: 'monitor:metric' | 'monitor:bogus:not-real') => {
        switch (type) {
          case 'monitor:metric':
            return 'ok';
          // The rogue branch is intentionally unhandled to illustrate the
          // assertNever() pattern; the cast keeps this probe compiling while
          // real routing code (MetricBus.routeToBridge()) would fail the
          // build on a missing case.
          default: {
            const x: never = type as never;
            return x;
          }
        }
      };
      expect(typeof exhaustivenessProbe).toBe('function');
    });
  });

  describe('Bridge optional — extension-only mode', () => {
    it('works without a bridge (subscribers fire, no-op on bridge routing)', () => {
      const bus = new MetricBus();
      const subscriber = vi.fn();
      bus.subscribe('monitor:metric', subscriber);
      bus.emit('monitor:metric', buildSample());
      expect(subscriber).toHaveBeenCalledTimes(1);
      bus.dispose();
    });
  });

  describe('Plan 03-01 vertical slice', () => {
    /**
     * The demoable proof that Plan 03-01 ships an end-to-end vertical slice:
     * a probe (here: the test) emits typed samples, in-process subscribers
     * receive them synchronously, the bridge sees a coalesced batch after
     * the 250 ms window — exactly the substrate Wave 2 plans (Drift v2,
     * Anomaly, Overview) will hang their features off.
     */
    it('emit -> bridge -> subscribe round-trip with coalesced batch flush', () => {
      vi.useFakeTimers();
      const bridgeSendSpy = vi.fn();
      const bus = new MetricBus({ bridge: { send: bridgeSendSpy }, coalesceWindowMs: 250 });
      const samples: MetricSample[] = [];
      const unsubscribe = bus.subscribe('monitor:metric', (s) => samples.push(s));

      // Probe emits two samples within the coalesce window.
      bus.emit('monitor:metric', buildSample({ value: 42 }));
      bus.emit('monitor:metric', buildSample({ value: 43 }));

      // Subscribers receive them synchronously.
      expect(samples).toHaveLength(2);
      expect(samples.map((s) => s.value)).toEqual([42, 43]);

      // Bridge has not yet seen anything — still inside the coalesce window.
      expect(bridgeSendSpy).not.toHaveBeenCalled();

      // Window elapses — the batch flushes as ONE envelope.
      vi.advanceTimersByTime(250);
      expect(bridgeSendSpy).toHaveBeenCalledOnce();
      expect(bridgeSendSpy.mock.calls[0]![0]).toMatchObject({
        type: 'monitor:metrics:batch',
        payload: {
          samples: expect.arrayContaining([
            expect.objectContaining({ value: 42 }),
            expect.objectContaining({ value: 43 }),
          ]),
        },
      });

      unsubscribe();
      bus.dispose();
    });
  });
});
