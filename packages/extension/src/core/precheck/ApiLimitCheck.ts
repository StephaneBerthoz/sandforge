import type {
  PreCheckConfig,
  PreCheckItem,
  PreCheckSeverity,
  ApiLimitCheckDetail,
} from '@sandforge/shared';
import { randomUUID } from 'crypto';

/** Raw API limit data returned by the fetch function */
export interface ApiLimitData {
  dailyApiRequests: { current: number; max: number };
  concurrentApiRequests: { current: number; max: number };
  bulkApiJobSlots: { current: number; max: number };
}

/** Dependency: fetches current API limits for a given org */
export type FetchLimitsFn = (orgId: string) => Promise<ApiLimitData>;

/** Threshold boundaries for limit severity classification */
const BLOCKER_THRESHOLD = 0.10;
const ERROR_THRESHOLD = 0.20;
const WARNING_THRESHOLD = 0.40;

/**
 * Checks API call limits including daily requests remaining,
 * concurrent request capacity, and Bulk API job slot availability.
 */
export class ApiLimitCheck {
  private readonly fetchLimits: FetchLimitsFn;

  constructor(fetchLimits: FetchLimitsFn) {
    this.fetchLimits = fetchLimits;
  }

  /** Run all API limit checks against the target org */
  async check(config: PreCheckConfig): Promise<PreCheckItem[]> {
    const data = await this.fetchLimits(config.targetOrgId);
    const estimatedApiCalls = this.estimateApiCalls(config);

    return [
      this.checkDailyApiRequests(data.dailyApiRequests, estimatedApiCalls),
      this.checkConcurrentRequests(data.concurrentApiRequests),
      this.checkBulkApiJobSlots(data.bulkApiJobSlots),
    ];
  }

  /** Estimate the number of API calls the operation will require */
  private estimateApiCalls(config: PreCheckConfig): number {
    const recordCount = (config.operationConfig['recordCount'] as number) ?? 0;
    const batchSize = (config.operationConfig['batchSize'] as number) ?? 200;

    if (recordCount === 0) return 10;

    const batches = Math.ceil(recordCount / batchSize);
    const overhead = 5;
    return batches + overhead;
  }

  /** Check daily API request availability */
  private checkDailyApiRequests(
    limits: { current: number; max: number },
    estimated: number
  ): PreCheckItem {
    const remaining = limits.max - limits.current;
    const remainingPercent = remaining / limits.max;
    const sufficient = remaining >= estimated;
    const severity = this.classifySeverity(remainingPercent, sufficient);

    const detail: ApiLimitCheckDetail = {
      limitName: 'DailyApiRequests',
      current: limits.current,
      max: limits.max,
      estimated,
      sufficient,
    };

    return {
      id: randomUUID(),
      category: 'api_limits',
      name: 'Daily API Requests',
      description: 'Checks remaining daily API call quota against estimated usage',
      severity,
      passed: sufficient && severity !== 'blocker',
      message: sufficient
        ? `API quota sufficient: ${remaining} remaining of ${limits.max} (need ~${estimated})`
        : `API quota insufficient: ${remaining} remaining of ${limits.max} (need ~${estimated})`,
      details: detail as unknown as Record<string, unknown>,
      autoFixable: false,
    };
  }

  /** Check concurrent API request capacity */
  private checkConcurrentRequests(
    limits: { current: number; max: number }
  ): PreCheckItem {
    const remaining = limits.max - limits.current;
    const remainingPercent = remaining / limits.max;
    const severity = this.classifySeverity(remainingPercent, remaining > 0);

    const detail: ApiLimitCheckDetail = {
      limitName: 'ConcurrentApiRequests',
      current: limits.current,
      max: limits.max,
      estimated: 1,
      sufficient: remaining > 0,
    };

    return {
      id: randomUUID(),
      category: 'api_limits',
      name: 'Concurrent API Requests',
      description: 'Checks available concurrent API request slots',
      severity,
      passed: remaining > 0,
      message: remaining > 0
        ? `Concurrent API slots available: ${remaining} of ${limits.max}`
        : `No concurrent API slots available (${limits.current}/${limits.max} in use)`,
      details: detail as unknown as Record<string, unknown>,
      autoFixable: false,
    };
  }

  /** Check Bulk API job slot availability */
  private checkBulkApiJobSlots(
    limits: { current: number; max: number }
  ): PreCheckItem {
    const remaining = limits.max - limits.current;
    const remainingPercent = remaining / limits.max;
    const severity = this.classifySeverity(remainingPercent, remaining > 0);

    const detail: ApiLimitCheckDetail = {
      limitName: 'BulkApiJobSlots',
      current: limits.current,
      max: limits.max,
      estimated: 1,
      sufficient: remaining > 0,
    };

    return {
      id: randomUUID(),
      category: 'api_limits',
      name: 'Bulk API Job Slots',
      description: 'Checks available Bulk API job slots',
      severity,
      passed: remaining > 0,
      message: remaining > 0
        ? `Bulk API job slots available: ${remaining} of ${limits.max}`
        : `No Bulk API job slots available (${limits.current}/${limits.max} in use)`,
      details: detail as unknown as Record<string, unknown>,
      autoFixable: false,
    };
  }

  /**
   * Classify severity based on remaining capacity percentage.
   * Blocker if < 10%, error if < 20%, warning if < 40%, info otherwise.
   */
  private classifySeverity(remainingPercent: number, sufficient: boolean): PreCheckSeverity {
    if (!sufficient) return 'blocker';
    if (remainingPercent < BLOCKER_THRESHOLD) return 'blocker';
    if (remainingPercent < ERROR_THRESHOLD) return 'error';
    if (remainingPercent < WARNING_THRESHOLD) return 'warning';
    return 'info';
  }
}
