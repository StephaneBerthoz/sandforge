import { create } from 'zustand';
import type { RealTimeSyncMetrics } from '@sandforge/shared';
import { buildMessage } from '../bridge/messageHelpers';
import { getVscodeApi } from '../hooks/useVSCodeApi';

/** Maximum number of metric snapshots kept for sparkline data (5 min at 5s intervals). */
const MAX_HISTORY = 60;

/** Polling interval in milliseconds. */
const POLL_INTERVAL_MS = 5000;

/** State and actions for the CDC metrics store. */
export interface CDCMetricsState {
  /** Latest metrics snapshot from the extension. */
  metrics: RealTimeSyncMetrics | null;
  /** History of metric snapshots for sparkline rendering (capped at 60). */
  metricsHistory: RealTimeSyncMetrics[];
  /** Whether metrics polling is active. */
  polling: boolean;
  /** Update metrics with a new snapshot and append to history. */
  updateMetrics: (m: RealTimeSyncMetrics) => void;
  /** Start polling metrics from the extension every 5 seconds. */
  startPolling: () => void;
  /** Stop polling metrics. */
  stopPolling: () => void;
  /** Full reset to initial state. */
  reset: () => void;
}

/** Interval ID stored outside Zustand for cleanup. */
let pollingIntervalId: ReturnType<typeof setInterval> | null = null;

/** Zustand store for managing CDC real-time metrics and polling. */
export const useCDCMetricsStore = create<CDCMetricsState>((set, get) => ({
  metrics: null,
  metricsHistory: [],
  polling: false,

  updateMetrics(m: RealTimeSyncMetrics): void {
    set((state) => {
      const history = [...state.metricsHistory, m];
      if (history.length > MAX_HISTORY) {
        history.splice(0, history.length - MAX_HISTORY);
      }
      return { metrics: m, metricsHistory: history };
    });
  },

  startPolling(): void {
    if (get().polling) return;
    set({ polling: true });

    const poll = (): void => {
      getVscodeApi().postMessage(buildMessage('realtime:metrics'));
    };

    poll();
    pollingIntervalId = setInterval(poll, POLL_INTERVAL_MS);
  },

  stopPolling(): void {
    if (pollingIntervalId !== null) {
      clearInterval(pollingIntervalId);
      pollingIntervalId = null;
    }
    set({ polling: false });
  },

  reset(): void {
    get().stopPolling();
    set({ metrics: null, metricsHistory: [], polling: false });
  },
}));

/**
 * Extract events-per-second values from a metrics history array.
 * Converts eventsPerMinute to events per second.
 * @param history - Array of metric snapshots.
 * @returns Array of events/second values.
 */
export function getEventsPerSecondHistory(history: RealTimeSyncMetrics[]): number[] {
  return history.map((m) => m.eventsPerMinute / 60);
}

/**
 * Extract currentLagMs values from a metrics history array.
 * @param history - Array of metric snapshots.
 * @returns Array of lag values in milliseconds.
 */
export function getLagHistory(history: RealTimeSyncMetrics[]): number[] {
  return history.map((m) => m.currentLagMs);
}

/**
 * Compute the number of seconds elapsed since a given ISO date string.
 * @param startedAt - ISO date string of the session start.
 * @returns Number of seconds since startedAt.
 */
export function getUptimeSeconds(startedAt: string): number {
  const start = new Date(startedAt).getTime();
  const now = Date.now();
  return Math.max(0, Math.floor((now - start) / 1000));
}

/**
 * Message listener for CDC metrics responses from the extension.
 * Listens for realtime:metrics:response and updates the store.
 */
function handleMetricsMessage(event: MessageEvent): void {
  const message = event.data;
  if (!message || typeof message !== 'object' || !('type' in message)) return;

  const msg = message as { type: string; payload?: Record<string, unknown> };

  if (msg.type === 'realtime:metrics:response') {
    const metrics = msg.payload?.metrics as RealTimeSyncMetrics | undefined;
    if (metrics) {
      useCDCMetricsStore.getState().updateMetrics(metrics);
    }
  }
}

// HMR-safe listener registration — without the guard, Vite's hot-module
// replace re-imports this module and stacks N copies of the listener,
// duplicating every metric N times and growing memory in O(N²).
let cdcMetricsListenerRegistered = false;
function registerCdcMetricsListener(): void {
  if (cdcMetricsListenerRegistered || typeof window === 'undefined') return;
  cdcMetricsListenerRegistered = true;
  window.addEventListener('message', handleMetricsMessage);
  if (typeof import.meta !== 'undefined' && import.meta.hot) {
    import.meta.hot.dispose(() => {
      window.removeEventListener('message', handleMetricsMessage);
      cdcMetricsListenerRegistered = false;
    });
  }
}
registerCdcMetricsListener();
