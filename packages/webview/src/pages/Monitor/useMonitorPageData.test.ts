import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { useMonitorPageData } from './useMonitorPageData';

/* ------------------------------------------------------------------ */
/* Mock bridge hooks                                                   */
/* ------------------------------------------------------------------ */
const mockRefetch = vi.fn();

/** Mutable query state -- tests mutate this before rendering. */
let mockMonitorQueryState = {
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  refetch: mockRefetch,
};

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => {
    if (type === 'monitor:refresh') {
      return mockMonitorQueryState;
    }
    if (type === 'monitor:alerts') {
      return { data: { alerts: [] }, loading: false, error: null, refetch: vi.fn() };
    }
    return { data: null, loading: false, error: null, refetch: vi.fn() };
  },
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: () => ({
    mutate: vi.fn(),
    data: null,
    loading: false,
    error: null,
    reset: vi.fn(),
  }),
}));

/** Standard monitor:data payload for tests. */
const standardPayload = {
  limits: [
    { name: 'DailyApiRequests', max: 15000, remaining: 2550, usedPercent: 83 },
    { name: 'DataStorageMB', max: 5120, remaining: 1843, usedPercent: 64 },
    { name: 'FileStorageMB', max: 2048, remaining: 1024, usedPercent: 50 },
  ],
  jobs: [],
  healthScore: 78,
  lastUpdated: new Date().toISOString(),
};

describe('useMonitorPageData', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useOrgStore.setState({ selectedOrgId: 'org-1', orgs: [] });
    mockRefetch.mockClear();
    mockMonitorQueryState = {
      data: null,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return isRefreshing=true when loading with existing data', () => {
    mockMonitorQueryState = {
      data: standardPayload,
      loading: true,
      error: null,
      refetch: mockRefetch,
    };
    const { result } = renderHook(() => useMonitorPageData());
    expect(result.current.isRefreshing).toBe(true);
  });

  it('should return isRefreshing=false on initial load (no lastUpdated)', () => {
    mockMonitorQueryState = {
      data: null,
      loading: true,
      error: null,
      refetch: mockRefetch,
    };
    const { result } = renderHook(() => useMonitorPageData());
    expect(result.current.isRefreshing).toBe(false);
  });

  it('should return isStale=true after 2 minutes', () => {
    const twoMinutesAgo = new Date(Date.now() - 130_000).toISOString();
    mockMonitorQueryState = {
      data: { ...standardPayload, lastUpdated: twoMinutesAgo },
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    const { result } = renderHook(() => useMonitorPageData());
    expect(result.current.isStale).toBe(true);
    expect(result.current.minutesSinceUpdate).toBeGreaterThanOrEqual(2);
  });

  it('should return isStale=false when data is fresh', () => {
    mockMonitorQueryState = {
      data: standardPayload,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    const { result } = renderHook(() => useMonitorPageData());
    expect(result.current.isStale).toBe(false);
  });

  it('should track consecutive failures and set connectionLost after 3', () => {
    mockMonitorQueryState = {
      data: standardPayload,
      loading: true,
      error: null,
      refetch: mockRefetch,
    };
    const { result, rerender } = renderHook(() => useMonitorPageData());

    // Simulate 3 consecutive failures: each cycle goes loading->error
    for (let i = 1; i <= 3; i++) {
      mockMonitorQueryState = {
        data: standardPayload,
        loading: true,
        error: null,
        refetch: mockRefetch,
      };
      rerender();

      mockMonitorQueryState = {
        data: standardPayload,
        loading: false,
        error: `Error ${i}`,
        refetch: mockRefetch,
      };
      rerender();
    }

    expect(result.current.consecutiveFailures).toBe(3);
    expect(result.current.connectionLost).toBe(true);
  });

  it('should reset consecutiveFailures on successful refresh', () => {
    mockMonitorQueryState = {
      data: standardPayload,
      loading: true,
      error: null,
      refetch: mockRefetch,
    };
    const { result, rerender } = renderHook(() => useMonitorPageData());

    // Simulate 2 failures
    for (let i = 1; i <= 2; i++) {
      mockMonitorQueryState = { data: standardPayload, loading: true, error: null, refetch: mockRefetch };
      rerender();
      mockMonitorQueryState = { data: standardPayload, loading: false, error: `Error ${i}`, refetch: mockRefetch };
      rerender();
    }
    expect(result.current.consecutiveFailures).toBe(2);

    // Now simulate a successful refresh
    mockMonitorQueryState = { data: standardPayload, loading: true, error: null, refetch: mockRefetch };
    rerender();
    mockMonitorQueryState = { data: standardPayload, loading: false, error: null, refetch: mockRefetch };
    rerender();

    expect(result.current.consecutiveFailures).toBe(0);
    expect(result.current.connectionLost).toBe(false);
  });

  it('should toggle showErrorDetails', () => {
    mockMonitorQueryState = {
      data: standardPayload,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    const { result } = renderHook(() => useMonitorPageData());
    expect(result.current.showErrorDetails).toBe(false);

    act(() => result.current.toggleErrorDetails());
    expect(result.current.showErrorDetails).toBe(true);

    act(() => result.current.toggleErrorDetails());
    expect(result.current.showErrorDetails).toBe(false);
  });

  it('should call refetch when retryFailed is invoked', () => {
    mockMonitorQueryState = {
      data: standardPayload,
      loading: false,
      error: 'Some error',
      refetch: mockRefetch,
    };
    const { result } = renderHook(() => useMonitorPageData());

    mockRefetch.mockClear();
    act(() => result.current.retryFailed());
    expect(mockRefetch).toHaveBeenCalledOnce();
  });

  it('should return fileStorageLimit with correct values from limits', () => {
    mockMonitorQueryState = {
      data: standardPayload,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    const { result } = renderHook(() => useMonitorPageData());
    expect(result.current.fileStorageLimit.name).toBe('FileStorageMB');
    expect(result.current.fileStorageLimit.max).toBe(2048);
    expect(result.current.fileStorageLimit.remaining).toBe(1024);
    expect(result.current.fileStorageLimit.usedPercent).toBe(50);
  });

  it('should return default fileStorageLimit when not in limits', () => {
    mockMonitorQueryState = {
      data: {
        ...standardPayload,
        limits: [
          { name: 'DailyApiRequests', max: 15000, remaining: 2550, usedPercent: 83 },
        ],
      },
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    const { result } = renderHook(() => useMonitorPageData());
    expect(result.current.fileStorageLimit.name).toBe('FileStorageMB');
    expect(result.current.fileStorageLimit.max).toBe(0);
    expect(result.current.fileStorageLimit.remaining).toBe(0);
  });

  it('should use real timestamps in trendSeries when TrendData.timestamps is present', () => {
    const realTimestamps = [
      '2026-03-20T10:00:00Z',
      '2026-03-20T10:15:00Z',
      '2026-03-20T10:30:00Z',
    ];
    mockMonitorQueryState = {
      data: {
        ...standardPayload,
        trends: {
          DailyApiRequests: {
            limitName: 'DailyApiRequests',
            direction: 'up' as const,
            changePercent: 5,
            sparklineData: [50, 60, 70],
            timestamps: realTimestamps,
          },
        },
      },
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    const { result } = renderHook(() => useMonitorPageData());
    expect(result.current.trendSeries).toHaveLength(1);
    expect(result.current.trendSeries[0].data[0].timestamp).toBe(realTimestamps[0]);
    expect(result.current.trendSeries[0].data[1].timestamp).toBe(realTimestamps[1]);
    expect(result.current.trendSeries[0].data[2].timestamp).toBe(realTimestamps[2]);
  });

  it('should fall back to synthetic timestamps in trendSeries when timestamps is absent', () => {
    mockMonitorQueryState = {
      data: {
        ...standardPayload,
        trends: {
          DailyApiRequests: {
            limitName: 'DailyApiRequests',
            direction: 'stable' as const,
            changePercent: 0,
            sparklineData: [50, 60, 70],
          },
        },
      },
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    const { result } = renderHook(() => useMonitorPageData());
    expect(result.current.trendSeries).toHaveLength(1);
    // Synthetic timestamps are ISO strings, not matching any specific real timestamp
    const ts = result.current.trendSeries[0].data[0].timestamp;
    expect(typeof ts).toBe('string');
    expect(new Date(ts).getTime()).toBeGreaterThan(0);
  });

  it('should use real timestamps in trendChartData when TrendData.timestamps is present', () => {
    const realTimestamps = [
      '2026-03-20T10:00:00Z',
      '2026-03-20T10:15:00Z',
      '2026-03-20T10:30:00Z',
    ];
    mockMonitorQueryState = {
      data: {
        ...standardPayload,
        trends: {
          DailyApiRequests: {
            limitName: 'DailyApiRequests',
            direction: 'up' as const,
            changePercent: 5,
            sparklineData: [50, 60, 70],
            timestamps: realTimestamps,
          },
        },
      },
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    const { result } = renderHook(() => useMonitorPageData());
    expect(result.current.trendChartData).toHaveLength(3);
    expect(result.current.trendChartData[0].timestamp).toBe(new Date(realTimestamps[0]).getTime());
    expect(result.current.trendChartData[1].timestamp).toBe(new Date(realTimestamps[1]).getTime());
    expect(result.current.trendChartData[2].timestamp).toBe(new Date(realTimestamps[2]).getTime());
  });

  it('should return sectionErrors when monitor query fails', () => {
    mockMonitorQueryState = {
      data: standardPayload,
      loading: true,
      error: null,
      refetch: mockRefetch,
    };
    const { result, rerender } = renderHook(() => useMonitorPageData());

    mockMonitorQueryState = {
      data: standardPayload,
      loading: false,
      error: 'Connection timeout',
      refetch: mockRefetch,
    };
    rerender();

    expect(result.current.sectionErrors).toHaveProperty('monitor');
    expect(result.current.sectionErrors['monitor']).toBe('Connection timeout');
  });
});
