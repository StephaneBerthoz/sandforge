import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RealTimeSyncMetrics } from '@sandforge/shared';
import {
  useCDCMetricsStore,
  getEventsPerSecondHistory,
  getLagHistory,
  getUptimeSeconds,
} from './useCDCMetricsStore';

vi.mock('../hooks/useVSCodeApi', () => ({
  getVscodeApi: () => ({
    postMessage: vi.fn(),
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

/** Create a fake metrics snapshot with sensible defaults. */
function fakeMetrics(overrides?: Partial<RealTimeSyncMetrics>): RealTimeSyncMetrics {
  return {
    eventsReceived: 100,
    eventsApplied: 95,
    eventsFailed: 5,
    eventsPerMinute: 120,
    averageLagMs: 200,
    currentLagMs: 150,
    errorRate: 5,
    startedAt: '2026-03-27T10:00:00.000Z',
    lastEventAt: '2026-03-27T10:05:00.000Z',
    ...overrides,
  };
}

describe('useCDCMetricsStore', () => {
  beforeEach(() => {
    useCDCMetricsStore.getState().reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should update metrics and append to history', () => {
    const m = fakeMetrics();
    useCDCMetricsStore.getState().updateMetrics(m);

    const state = useCDCMetricsStore.getState();
    expect(state.metrics).toEqual(m);
    expect(state.metricsHistory).toHaveLength(1);
    expect(state.metricsHistory[0]).toEqual(m);
  });

  it('should cap history at 60 entries', () => {
    for (let i = 0; i < 65; i++) {
      useCDCMetricsStore.getState().updateMetrics(fakeMetrics({ eventsReceived: i }));
    }

    const state = useCDCMetricsStore.getState();
    expect(state.metricsHistory).toHaveLength(60);
    expect(state.metricsHistory[0]?.eventsReceived).toBe(5);
    expect(state.metricsHistory[59]?.eventsReceived).toBe(64);
  });

  it('should set polling to true on startPolling', () => {
    useCDCMetricsStore.getState().startPolling();

    expect(useCDCMetricsStore.getState().polling).toBe(true);
  });

  it('should clear interval on stopPolling', () => {
    useCDCMetricsStore.getState().startPolling();
    expect(useCDCMetricsStore.getState().polling).toBe(true);

    useCDCMetricsStore.getState().stopPolling();
    expect(useCDCMetricsStore.getState().polling).toBe(false);
  });

  it('should reset all state', () => {
    useCDCMetricsStore.getState().updateMetrics(fakeMetrics());
    useCDCMetricsStore.getState().startPolling();

    useCDCMetricsStore.getState().reset();

    const state = useCDCMetricsStore.getState();
    expect(state.metrics).toBeNull();
    expect(state.metricsHistory).toHaveLength(0);
    expect(state.polling).toBe(false);
  });

  it('should not start duplicate polling intervals', () => {
    useCDCMetricsStore.getState().startPolling();
    useCDCMetricsStore.getState().startPolling();

    expect(useCDCMetricsStore.getState().polling).toBe(true);
  });
});

describe('getEventsPerSecondHistory', () => {
  it('should extract events per second from history', () => {
    const history = [
      fakeMetrics({ eventsPerMinute: 60 }),
      fakeMetrics({ eventsPerMinute: 120 }),
      fakeMetrics({ eventsPerMinute: 180 }),
    ];

    const result = getEventsPerSecondHistory(history);
    expect(result).toEqual([1, 2, 3]);
  });

  it('should return empty array for empty history', () => {
    expect(getEventsPerSecondHistory([])).toEqual([]);
  });
});

describe('getLagHistory', () => {
  it('should extract currentLagMs from history', () => {
    const history = [
      fakeMetrics({ currentLagMs: 100 }),
      fakeMetrics({ currentLagMs: 200 }),
      fakeMetrics({ currentLagMs: 300 }),
    ];

    const result = getLagHistory(history);
    expect(result).toEqual([100, 200, 300]);
  });

  it('should return empty array for empty history', () => {
    expect(getLagHistory([])).toEqual([]);
  });
});

describe('getUptimeSeconds', () => {
  it('should compute correct duration in seconds', () => {
    const now = new Date('2026-03-27T10:05:00.000Z').getTime();
    vi.setSystemTime(now);

    const result = getUptimeSeconds('2026-03-27T10:00:00.000Z');
    expect(result).toBe(300);
  });

  it('should return 0 for future startedAt', () => {
    const now = new Date('2026-03-27T10:00:00.000Z').getTime();
    vi.setSystemTime(now);

    const result = getUptimeSeconds('2026-03-27T10:05:00.000Z');
    expect(result).toBe(0);
  });
});
