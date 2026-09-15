import { MONITOR_KEY_LIMITS } from '@sandforge/shared';
import type { LimitsSnapshot, TrendData } from '@sandforge/shared';
import type { ConfigStore } from '../../core/storage/ConfigStore';

/** One day in milliseconds. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Maximum age for trend data: 7 days in milliseconds. */
const MAX_AGE_MS = 7 * DAY_MS;

/** Maximum size per org: 500 KB. */
const MAX_SIZE_BYTES = 500 * 1024;

/** Minimum interval between saves: 15 minutes in milliseconds. */
const RATE_LIMIT_MS = 15 * 60 * 1000;

/** Threshold in percentage change to be considered "stable". */
const STABLE_THRESHOLD = 2;

/** ConfigStore category for trend data. */
const TREND_CATEGORY = 'trends';

/**
 * The limits whose history is kept: the key limits the dashboard charts and
 * the health score reads a trend for.
 *
 * A /limits response carries some fifty limits, about 4.7 KB per snapshot. At
 * one save per 15 minutes the 500 KB cap then held about 27 hours, so the
 * seven days of retention never existed and a week-long chart showed one day.
 * The key limits take about 530 B per snapshot: a full week is about 350 KB.
 */
const TRENDED_LIMITS: ReadonlySet<string> = new Set(MONITOR_KEY_LIMITS);

/**
 * How far back direction, change and time-to-limit look.
 *
 * Most key limits are daily counters that reset every day: a change measured
 * across the week would compare one day's usage with another's and predict
 * nothing. The series still span the whole retention, for the chart.
 */
const VERDICT_WINDOW_MS = DAY_MS;

/**
 * Persists LimitsSnapshot history per org using ConfigStore.
 * Provides trend computation for individual limits.
 *
 * - 7-day retention with auto-purge
 * - key limits only (see {@link TRENDED_LIMITS})
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
    if (this.isRateLimited(orgId, now)) {
      return;
    }
    this.append(orgId, this.read(orgId), snapshot, now);
  }

  /**
   * Record a new snapshot (rate-limited like {@link record}) and compute the
   * trends of the given limits, from a single read of the stored history.
   *
   * Each series spans the whole retention, so a chart can show the week;
   * direction, change and time-to-limit read the last day only (see
   * {@link VERDICT_WINDOW_MS}). The Monitor refresh calls this on every tick,
   * and the stored history is a JSON blob parsed on every read: reading it once
   * per limit parsed it seven times a tick.
   *
   * @param orgId - Org identifier.
   * @param snapshot - The limits just fetched.
   * @param limitNames - The limits to compute a trend for.
   * @returns One trend per requested limit, keyed by limit name.
   */
  recordAndGetTrends(
    orgId: string,
    snapshot: LimitsSnapshot,
    limitNames: readonly string[],
  ): Record<string, TrendData> {
    const now = Date.now();
    const stored = this.read(orgId);
    const history = this.isRateLimited(orgId, now)
      ? stored
      : this.append(orgId, stored, snapshot, now);
    const series = history.filter((s) => s.timestamp >= isoAt(now - MAX_AGE_MS));
    const recent = series.filter((s) => s.timestamp >= isoAt(now - VERDICT_WINDOW_MS));

    const trends: Record<string, TrendData> = {};
    for (const limitName of limitNames) {
      trends[limitName] = this.computeTrend(limitName, series, recent);
    }
    return trends;
  }

  /**
   * Get all snapshots for an org within the given period.
   * @param orgId - Org identifier.
   * @param periodMs - Time window in milliseconds (default: 24 hours).
   */
  getHistory(orgId: string, periodMs: number = DAY_MS): LimitsSnapshot[] {
    const cutoff = isoAt(Date.now() - periodMs);
    return this.read(orgId).filter((s) => s.timestamp >= cutoff);
  }

  /**
   * Compute trend data for a specific limit over the last 24 hours.
   * @param orgId - Org identifier.
   * @param limitName - The limit name to compute trend for.
   */
  getTrendData(orgId: string, limitName: string): TrendData {
    const snapshots = this.getHistory(orgId);
    return this.computeTrend(limitName, snapshots, snapshots);
  }

  /** Clear all trend data for an org. */
  purge(orgId: string): void {
    const key = this.trendKey(orgId);
    this.configStore.delete(key);
    this.lastSaveTimestamps.delete(orgId);
  }

  /** The stored history of an org, oldest first. */
  private read(orgId: string): LimitsSnapshot[] {
    return this.configStore.get<LimitsSnapshot[]>(this.trendKey(orgId)) ?? [];
  }

  /** Whether an org's last save is too recent for another one. */
  private isRateLimited(orgId: string, now: number): boolean {
    return now - (this.lastSaveTimestamps.get(orgId) ?? 0) < RATE_LIMIT_MS;
  }

  /**
   * Append a snapshot to the history read from the store, purge what is past
   * retention, keep the trended limits only, trim to the size limit and save.
   * @returns The history as saved.
   */
  private append(
    orgId: string,
    existing: LimitsSnapshot[],
    snapshot: LimitsSnapshot,
    now: number,
  ): LimitsSnapshot[] {
    const cutoff = isoAt(now - MAX_AGE_MS);
    // Snapshots saved before the limits were narrowed are narrowed here too,
    // so an existing full-size history shrinks on its next save.
    const retained = [...existing, snapshot]
      .filter((s) => s.timestamp >= cutoff)
      .map((s) => ({ ...s, limits: s.limits.filter((l) => TRENDED_LIMITS.has(l.name)) }));
    const trimmed = this.trimToSizeLimit(retained);

    this.configStore.set(this.trendKey(orgId), trimmed, TREND_CATEGORY);
    this.lastSaveTimestamps.set(orgId, now);
    return trimmed;
  }

  /**
   * Trend of one limit: the points of `series`, judged on the points of `recent`.
   * @param limitName - The limit to read.
   * @param series - Snapshots the sparkline is drawn from.
   * @param recent - Snapshots direction, change and time-to-limit are read from.
   */
  private computeTrend(
    limitName: string,
    series: LimitsSnapshot[],
    recent: LimitsSnapshot[],
  ): TrendData {
    const { values: sparklineData, timestamps } = pointsOf(limitName, series);
    const { values: recentValues } = pointsOf(limitName, recent);

    if (recentValues.length < 2) {
      return {
        limitName,
        direction: 'stable',
        changePercent: 0,
        sparklineData,
        timestamps,
      };
    }

    const first = recentValues[0];
    const last = recentValues[recentValues.length - 1];
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
    if (direction === 'up' && last < 100) {
      const timeSpanMs = this.getTimeSpanMs(recent);
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
      timestamps,
    };
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

/** ISO timestamp of an epoch time, comparable with stored snapshot timestamps. */
function isoAt(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/** The used-percent values of one limit across snapshots, with their timestamps. */
function pointsOf(
  limitName: string,
  snapshots: LimitsSnapshot[],
): { values: number[]; timestamps: string[] } {
  const values: number[] = [];
  const timestamps: string[] = [];
  for (const snapshot of snapshots) {
    const limit = snapshot.limits.find((l) => l.name === limitName);
    if (limit) {
      values.push(limit.usedPercent);
      timestamps.push(snapshot.timestamp);
    }
  }
  return { values, timestamps };
}
