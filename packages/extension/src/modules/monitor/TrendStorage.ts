import type { LimitsSnapshot, TrendData } from '@sandforge/shared';
import type { ConfigStore } from '../../core/storage/ConfigStore';

/** Maximum age for trend data: 7 days in milliseconds. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Maximum size per org: 500 KB. */
const MAX_SIZE_BYTES = 500 * 1024;

/** Minimum interval between saves: 15 minutes in milliseconds. */
const RATE_LIMIT_MS = 15 * 60 * 1000;

/** Threshold in percentage change to be considered "stable". */
const STABLE_THRESHOLD = 2;

/** ConfigStore category for trend data. */
const TREND_CATEGORY = 'trends';

/**
 * Persists LimitsSnapshot history per org using ConfigStore.
 * Provides trend computation for individual limits.
 *
 * - 7-day retention with auto-purge
 * - 500 KB size limit per org
 * - 15-minute rate limiting per org
 */
export class TrendStorage {
  private configStore: ConfigStore;
  private lastSaveTimestamps: Map<string, number> = new Map();

  constructor(configStore: ConfigStore) {
    this.configStore = configStore;
  }

  /** Build the ConfigStore key for an org's trend data. */
  private trendKey(orgId: string): string {
    return `trend:${orgId}`;
  }

  /**
   * Record a new snapshot for the given org.
   * Respects rate limiting (max 1 save per 15 min per org).
   * Auto-purges old snapshots and enforces size limit.
   */
  record(orgId: string, snapshot: LimitsSnapshot): void {
    const now = Date.now();
    const lastSave = this.lastSaveTimestamps.get(orgId) ?? 0;

    if (now - lastSave < RATE_LIMIT_MS) {
      return;
    }

    const key = this.trendKey(orgId);
    const existing = this.configStore.get<LimitsSnapshot[]>(key) ?? [];

    // Append the new snapshot
    existing.push(snapshot);

    // Purge snapshots older than 7 days
    const cutoff = new Date(now - MAX_AGE_MS).toISOString();
    const filtered = existing.filter((s) => s.timestamp >= cutoff);

    // Enforce size limit: remove oldest until under 500 KB
    const trimmed = this.trimToSizeLimit(filtered);

    this.configStore.set(key, trimmed, TREND_CATEGORY);
    this.lastSaveTimestamps.set(orgId, now);
  }

  /**
   * Get all snapshots for an org within the given period.
   * @param orgId - Org identifier.
   * @param periodMs - Time window in milliseconds (default: 24 hours).
   */
  getHistory(orgId: string, periodMs: number = 24 * 60 * 60 * 1000): LimitsSnapshot[] {
    const key = this.trendKey(orgId);
    const snapshots = this.configStore.get<LimitsSnapshot[]>(key) ?? [];
    const cutoff = new Date(Date.now() - periodMs).toISOString();
    return snapshots.filter((s) => s.timestamp >= cutoff);
  }

  /**
   * Compute trend data for a specific limit.
   * @param orgId - Org identifier.
   * @param limitName - The limit name to compute trend for.
   */
  getTrendData(orgId: string, limitName: string): TrendData {
    const snapshots = this.getHistory(orgId);
    const sparklineData: number[] = [];

    for (const snapshot of snapshots) {
      const limit = snapshot.limits.find((l) => l.name === limitName);
      if (limit) {
        sparklineData.push(limit.usedPercent);
      }
    }

    if (sparklineData.length < 2) {
      return {
        limitName,
        direction: 'stable',
        changePercent: 0,
        sparklineData,
      };
    }

    const first = sparklineData[0];
    const last = sparklineData[sparklineData.length - 1];
    const changePercent = last - first;

    let direction: 'up' | 'down' | 'stable';
    if (Math.abs(changePercent) <= STABLE_THRESHOLD) {
      direction = 'stable';
    } else if (changePercent > 0) {
      direction = 'up';
    } else {
      direction = 'down';
    }

    // Predict time to 100% if trending up
    let predictedTimeToLimit: number | undefined;
    if (direction === 'up' && last < 100 && sparklineData.length >= 2) {
      const timeSpanMs = this.getTimeSpanMs(snapshots);
      if (timeSpanMs > 0) {
        const ratePerMs = changePercent / timeSpanMs;
        if (ratePerMs > 0) {
          const remainingPercent = 100 - last;
          const msToLimit = remainingPercent / ratePerMs;
          predictedTimeToLimit = Math.round((msToLimit / (60 * 60 * 1000)) * 10) / 10;
        }
      }
    }

    return {
      limitName,
      direction,
      changePercent: Math.round(changePercent * 10) / 10,
      predictedTimeToLimit,
      sparklineData,
    };
  }

  /** Clear all trend data for an org. */
  purge(orgId: string): void {
    const key = this.trendKey(orgId);
    this.configStore.delete(key);
    this.lastSaveTimestamps.delete(orgId);
  }

  /** Calculate time span between first and last snapshot in milliseconds. */
  private getTimeSpanMs(snapshots: LimitsSnapshot[]): number {
    if (snapshots.length < 2) return 0;
    const firstTime = new Date(snapshots[0].timestamp).getTime();
    const lastTime = new Date(snapshots[snapshots.length - 1].timestamp).getTime();
    return lastTime - firstTime;
  }

  /** Trim snapshots array to fit within the size limit. */
  private trimToSizeLimit(snapshots: LimitsSnapshot[]): LimitsSnapshot[] {
    const result = [...snapshots];
    while (result.length > 0) {
      const size = new TextEncoder().encode(JSON.stringify(result)).length;
      if (size <= MAX_SIZE_BYTES) break;
      result.shift();
    }
    return result;
  }
}
