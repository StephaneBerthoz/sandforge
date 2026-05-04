import type { ApiLimit, LimitsSnapshot } from '@sandforge/shared';

/** Raw Salesforce limits response format */
export interface RawSalesforceLimits {
  [key: string]: { Max: number; Remaining: number };
}

/** Function signature for querying Salesforce limits */
export type QueryLimitsFn = (orgId: string) => Promise<RawSalesforceLimits>;

/** Maximum number of historical snapshots kept per org */
const MAX_HISTORY_SIZE = 100;

/**
 * Tracks Salesforce API limits via the Limits REST API.
 * Maintains a cache of the latest snapshot and a bounded history
 * of past snapshots for trend analysis.
 */
export class LimitsTracker {
  private readonly queryLimits: QueryLimitsFn;
  private readonly snapshots: Map<string, LimitsSnapshot> = new Map();
  private readonly history: Map<string, LimitsSnapshot[]> = new Map();

  constructor(queryLimits: QueryLimitsFn) {
    this.queryLimits = queryLimits;
  }

  /** Fetch current limits from Salesforce and cache the snapshot */
  async fetch(orgId: string): Promise<LimitsSnapshot> {
    const raw = await this.queryLimits(orgId);
    const limits = convertRawLimits(raw);
    const snapshot: LimitsSnapshot = {
      orgId,
      limits,
      timestamp: new Date().toISOString(),
    };

    this.snapshots.set(orgId, snapshot);
    this.appendToHistory(orgId, snapshot);

    return snapshot;
  }

  /** Return the most recently cached snapshot for an org */
  getSnapshot(orgId: string): LimitsSnapshot | undefined {
    return this.snapshots.get(orgId);
  }

  /** Return limits whose usage exceeds the given threshold percentage */
  getCriticalLimits(orgId: string, thresholdPercent: number): ApiLimit[] {
    const snapshot = this.snapshots.get(orgId);
    if (!snapshot) {
      return [];
    }
    return snapshot.limits.filter((limit) => limit.usedPercent >= thresholdPercent);
  }

  /** Return the full history of snapshots for an org */
  getHistory(orgId: string): LimitsSnapshot[] {
    return this.history.get(orgId) ?? [];
  }

  private appendToHistory(orgId: string, snapshot: LimitsSnapshot): void {
    const orgHistory = this.history.get(orgId) ?? [];
    orgHistory.push(snapshot);
    if (orgHistory.length > MAX_HISTORY_SIZE) {
      orgHistory.shift();
    }
    this.history.set(orgId, orgHistory);
  }
}

/** Convert raw Salesforce limit format to ApiLimit array */
function convertRawLimits(raw: RawSalesforceLimits): ApiLimit[] {
  return Object.entries(raw).map(([name, { Max, Remaining }]) => {
    const used = Max - Remaining;
    const usedPercent = Max > 0 ? (used / Max) * 100 : 0;
    return { name, max: Max, remaining: Remaining, usedPercent };
  });
}
