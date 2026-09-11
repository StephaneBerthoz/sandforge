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
      // Spread into a fresh object on every call: the real useBridgeQuery
      // returns a new object literal each render (only `refetch` is stable),
      // which is exactly the condition the auto-refresh effect must survive.
      return { ...mockMonitorQueryState };
    }
    if (type === 'monitor:alerts') {
      return { data: { alerts: [] }, loading: false, error: null, refetch: vi.fn() };
    }
    return { data: null, loading: false, error: null, refetch: vi.fn() };
  },
}));

const mockAbortMutate = vi.fn();

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => ({
    mutate: type === 'monitor:abort-job' ? mockAbortMutate : vi.fn(),
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
    expect(result.current.consecutiveFailures).toBe(2);

    // Now simulate a successful refresh
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
      error: null,
      refetch: mockRefetch,
    };
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
        limits: [{ name: 'DailyApiRequests', max: 15000, remaining: 2550, usedPercent: 83 }],
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
    const realTimestamps = ['2026-03-20T10:00:00Z', '2026-03-20T10:15:00Z', '2026-03-20T10:30:00Z'];
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
    const realTimestamps = ['2026-03-20T10:00:00Z', '2026-03-20T10:15:00Z', '2026-03-20T10:30:00Z'];
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

  it('should auto-refresh after the 30s interval despite intermediate re-renders', () => {
    mockMonitorQueryState = {
      data: standardPayload,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    const { result, rerender } = renderHook(() => useMonitorPageData());

    act(() => result.current.setAutoRefresh(true));
    mockRefetch.mockClear();

    // The time-ago ticker fires every 10 s and re-renders the hook; these
    // intermediate renders must not reset the 30 s auto-refresh interval.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    rerender();
    expect(mockRefetch).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(mockRefetch).toHaveBeenCalledTimes(1);

    // The interval keeps firing on subsequent cycles.
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(mockRefetch).toHaveBeenCalledTimes(2);
  });

  it('should not auto-refresh when autoRefresh is disabled', () => {
    mockMonitorQueryState = {
      data: standardPayload,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    renderHook(() => useMonitorPageData());
    mockRefetch.mockClear();

    act(() => {
      vi.advanceTimersByTime(90_000);
    });
    expect(mockRefetch).not.toHaveBeenCalled();
  });

  /* ---------------------------------------------------------------- */
  /* Job insights verdict                                              */
  /* ---------------------------------------------------------------- */

  // `[]` is the extension's verdict ("scanned, nothing found"). No payload,
  // or a payload without the field, is no verdict at all, and must not be
  // flattened into `[]` where the page would read it as a clean scan.
  describe('job insights verdict', () => {
    it('reports no verdict before any payload arrives', () => {
      const { result } = renderHook(() => useMonitorPageData());
      expect(result.current.jobInsights).toBeNull();
    });

    it('reports no verdict when the payload carries none', () => {
      mockMonitorQueryState = { ...mockMonitorQueryState, data: { ...standardPayload } };
      const { result } = renderHook(() => useMonitorPageData());
      expect(result.current.jobInsights).toBeNull();
    });

    it('passes an empty verdict through as a verdict', () => {
      mockMonitorQueryState = {
        ...mockMonitorQueryState,
        data: { ...standardPayload, jobInsights: [] },
      };
      const { result } = renderHook(() => useMonitorPageData());
      expect(result.current.jobInsights).toEqual([]);
    });
  });

  /* ---------------------------------------------------------------- */
  /* Job abort — never one call                                        */
  /* ---------------------------------------------------------------- */

  // The hook exposes no one-shot abort. A request only arms a confirmation;
  // the org call leaves on confirm, and only for a job a critical stuck
  // verdict still names at that moment.
  describe('job abort', () => {
    const stalled = {
      type: 'stuck',
      severity: 'critical',
      title: 'BatchApex 707x0000000STAL: no batch completed in 1h05m',
      detail: '3 of 10 batches processed, unchanged across 1h05m of observation.',
      affectedJobs: ['707x0000000STAL'],
      recommendation: 'Check the job, then abort it if it is still at the same batch.',
    };
    const unfinished = {
      type: 'long_running',
      severity: 'warning',
      title: '1 job unfinished 3h10m after submission',
      detail: 'Queueable 707x0000000SLOW is Processing.',
      affectedJobs: ['707x0000000SLOW'],
      recommendation: 'Keep watching.',
    };

    function withInsights(jobInsights: unknown[]): void {
      mockMonitorQueryState = {
        ...mockMonitorQueryState,
        data: { ...standardPayload, jobInsights },
      };
    }

    beforeEach(() => {
      mockAbortMutate.mockClear();
    });

    it('sends nothing when an abort is requested: the request only arms the confirmation', () => {
      withInsights([stalled]);
      const { result } = renderHook(() => useMonitorPageData());

      act(() => result.current.requestAbortJob('707x0000000STAL'));

      expect(result.current.pendingAbortJobId).toBe('707x0000000STAL');
      expect(mockAbortMutate).not.toHaveBeenCalled();
    });

    it('sends the armed abort once confirmed, then disarms', () => {
      withInsights([stalled]);
      const { result } = renderHook(() => useMonitorPageData());

      act(() => result.current.requestAbortJob('707x0000000STAL'));
      act(() => result.current.confirmAbortJob());

      expect(mockAbortMutate).toHaveBeenCalledTimes(1);
      expect(mockAbortMutate).toHaveBeenCalledWith({ orgId: 'org-1', jobId: '707x0000000STAL' });
      expect(result.current.pendingAbortJobId).toBeNull();

      // A second confirm has nothing armed.
      act(() => result.current.confirmAbortJob());
      expect(mockAbortMutate).toHaveBeenCalledTimes(1);
    });

    it('sends nothing when the confirmation is cancelled', () => {
      withInsights([stalled]);
      const { result } = renderHook(() => useMonitorPageData());

      act(() => result.current.requestAbortJob('707x0000000STAL'));
      act(() => result.current.cancelAbortJob());
      act(() => result.current.confirmAbortJob());

      expect(result.current.pendingAbortJobId).toBeNull();
      expect(mockAbortMutate).not.toHaveBeenCalled();
    });

    it('refuses to arm an abort for a job no stuck verdict names', () => {
      withInsights([stalled, unfinished]);
      const { result } = renderHook(() => useMonitorPageData());

      act(() => result.current.requestAbortJob('707x0000000SLOW'));
      expect(result.current.pendingAbortJobId).toBeNull();

      act(() => result.current.confirmAbortJob());
      expect(mockAbortMutate).not.toHaveBeenCalled();
    });

    it('disarms a pending abort when a refresh withdraws the stall evidence', () => {
      withInsights([stalled]);
      const { result, rerender } = renderHook(() => useMonitorPageData());
      act(() => result.current.requestAbortJob('707x0000000STAL'));
      expect(result.current.pendingAbortJobId).toBe('707x0000000STAL');

      // The job moved again before the reader confirmed.
      withInsights([]);
      rerender();
      expect(result.current.pendingAbortJobId).toBeNull();
      act(() => result.current.confirmAbortJob());
      expect(mockAbortMutate).not.toHaveBeenCalled();

      // Evidence coming back later does not reopen a confirmation by itself.
      withInsights([stalled]);
      rerender();
      expect(result.current.pendingAbortJobId).toBeNull();
    });
  });
});
