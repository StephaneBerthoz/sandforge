import type { BaseMessage, TrendData, OrgTrendPayload } from '@sandforge/shared';
import { SF_API_VERSION, MONITOR_PERIOD_MAP, MONITOR_KEY_LIMITS, DEFAULT_SOQL_LIMITS } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';
import { buildResponse, sendHandlerError, sendNotification } from './HandlerTypes.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { queryAll } from '../../core/common/soqlQueryHelper.js';
import { HealthScoreCalculator } from '../../modules/monitor/HealthScoreCalculator.js';
import { TrendStorage } from '../../modules/monitor/TrendStorage.js';
import { OrgInfoFetcher } from '../../modules/monitor/OrgInfoFetcher.js';
import type { OrgInfoConnection } from '../../modules/monitor/OrgInfoFetcher.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { computeTrendData } from '../../modules/monitor/trendUtils.js';
import { transformLimitsResponse } from '../../modules/monitor/transformLimitsResponse.js';
import type { RawLimitsResponse } from '../../modules/monitor/transformLimitsResponse.js';
import { checkApiLimits } from '../../core/common/sforceLimitParser.js';
import type { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';

/** Message types handled by MonitorOpsHandler. */
const MONITOR_TYPES = new Set([
  'monitor:refresh',
  'monitor:start',
  'monitor:trends',
  'monitor:abort-job',
  'monitor:live-operations',
]);

/**
 * Domain handler for monitor-related webview-to-extension messages.
 *
 * Routes monitor:* message types to health calculation, limits fetching,
 * trend computation, async job management, and full refresh operations.
 */
export class MonitorOpsHandler implements DomainHandler {
  private readonly trendStorage: TrendStorage;
  private readonly orgInfoFetcher = new OrgInfoFetcher();
  private readonly healthCalculator = new HealthScoreCalculator();
  private liveOperationTracker?: LiveOperationTracker;

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {
    this.trendStorage = new TrendStorage(deps.configStore);
  }

  /**
   * Inject the live operation tracker for real-time operation snapshots.
   * @param tracker - The LiveOperationTracker instance.
   */
  setLiveOperationTracker(tracker: LiveOperationTracker): void {
    this.liveOperationTracker = tracker;
  }

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: BaseMessage): Promise<boolean> {
    if (!MONITOR_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'monitor:refresh':
      case 'monitor:start':
        await this.handleRefresh(msg);
        return true;
      case 'monitor:trends':
        this.handleTrends(msg);
        return true;
      case 'monitor:abort-job':
        await this.handleAbortJob(msg);
        return true;
      case 'monitor:live-operations':
        this.handleLiveOperations(msg);
        return true;
      default:
        return false;
    }
  }

  private async handleRefresh(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { orgId: string } }).payload;

    try {
      const conn = await getJsforceConnection(payload.orgId, this.deps.orgRegistry, this.deps.orgManager);

      // 1. Get limits
      const limitsRaw = await conn.request(`/services/data/${SF_API_VERSION}/limits`) as RawLimitsResponse;
      const limits = transformLimitsResponse(limitsRaw);
      checkApiLimits(conn.limitInfo, 'monitor:refresh limits');

      // 2. Get async jobs
      const jobRecords = await queryAll<{ Id: string; JobType: string; Status: string; NumberOfErrors: number; CreatedDate: string; CreatedById: string }>(
        conn,
        `SELECT Id, JobType, Status, NumberOfErrors, CreatedDate, CreatedById FROM AsyncApexJob ORDER BY CreatedDate DESC LIMIT ${DEFAULT_SOQL_LIMITS.monitorJobs}`,
      );
      checkApiLimits(conn.limitInfo, 'monitor:refresh asyncJobs');
      const jobs = jobRecords.map(r => ({
        id: r.Id,
        jobType: r.JobType ?? 'Unknown',
        status: r.Status,
        createdBy: r.CreatedById,
        createdDate: r.CreatedDate,
        failedRecords: r.NumberOfErrors,
      }));

      // 3. Calculate health report
      const healthReport = this.healthCalculator.calculate(limits);
      const healthScore = healthReport.overallScore;

      // 4. Record snapshot and compute trends
      const snapshot = {
        orgId: payload.orgId,
        limits,
        timestamp: new Date().toISOString(),
      };
      this.trendStorage.record(payload.orgId, snapshot);

      const trends: Record<string, TrendData> = {};
      for (const limitName of MONITOR_KEY_LIMITS) {
        trends[limitName] = this.trendStorage.getTrendData(payload.orgId, limitName);
      }

      // 5. Fetch org info (cached, non-blocking failure)
      let orgInfo: import('@sandforge/shared').OrgInfo | undefined;
      try {
        const orgInfoConn: OrgInfoConnection = {
          identity: async () => {
            const id = await conn.identity();
            return {
              instanceName: (id as Record<string, unknown>).instance_name as string ?? '',
              apiVersion: conn.version ?? '62.0',
              lastLoginDate: (id as Record<string, unknown>).last_login_date as string ?? new Date().toISOString(),
            };
          },
          queryOrg: async () => {
            const org = this.deps.orgManager.getOrg(payload.orgId);
            const orgRecords = await queryAll<{ Name: string; Id: string; OrganizationType: string; NamespacePrefix: string | null; CreatedDate: string }>(
              conn,
              `SELECT Name, Id, OrganizationType, NamespacePrefix, CreatedDate FROM Organization LIMIT 1`,
            );
            checkApiLimits(conn.limitInfo, 'monitor:refresh orgInfo');
            const rec = orgRecords[0];
            const orgType = org?.orgType ?? 'Sandbox';
            return {
              name: rec?.Name ?? org?.alias ?? '',
              orgId: rec?.Id ?? payload.orgId,
              type: orgType as 'Production' | 'Sandbox' | 'Scratch' | 'Developer',
              edition: org?.metadata.edition ?? '',
            };
          },
          queryCount: async (soql: string) => {
            const result = await conn.query<{ expr0: number }>(soql);
            return result.totalSize;
          },
        };
        orgInfo = await this.orgInfoFetcher.fetch(payload.orgId, orgInfoConn);
      } catch (infoErr) {
        this.deps.log(`[WARN] OrgInfo fetch failed: ${String(infoErr)}`);
      }

      // 6. Send response
      const response = buildResponse(this.deps, msg, 'monitor:data', { limits, jobs, healthScore, healthReport, trends, orgInfo, lastUpdated: new Date().toISOString() });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'monitor:refresh', 'monitor:error', err);
    }
  }

  private handleTrends(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { orgId: string; period?: string } }).payload;
    const periodStr = payload.period ?? '24h';
    const periodMs = MONITOR_PERIOD_MAP[periodStr] ?? MONITOR_PERIOD_MAP['24h'];

    const trends: Record<string, TrendData> = {};
    for (const limitName of MONITOR_KEY_LIMITS) {
      const snapshots = this.trendStorage.getHistory(payload.orgId, periodMs);
      trends[limitName] = computeTrendData({ limitName, snapshots, predictTime: true });
    }

    const trendPayload: OrgTrendPayload = {
      orgId: payload.orgId,
      trends,
      periodLabel: periodStr,
    };

    const response = buildResponse(this.deps, msg, 'monitor:trends:data', trendPayload as unknown as Record<string, unknown>);
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ${response.type} id=${response.id}`);
  }

  private handleLiveOperations(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const operations = this.liveOperationTracker?.getAll() ?? [];
    const response = buildResponse(this.deps, msg, 'monitor:live-operations:response', { operations });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ${response.type} id=${response.id}`);
  }

  private async handleAbortJob(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { orgId: string; jobId: string } }).payload;

    try {
      const conn = await getJsforceConnection(payload.orgId, this.deps.orgRegistry, this.deps.orgManager);
      await conn.sobject('AsyncApexJob').update({ Id: payload.jobId, Status: 'Aborted' } as Record<string, unknown> & { Id: string });

      const response = buildResponse(this.deps, msg, 'monitor:abort-job:response', { jobId: payload.jobId, success: true, message: 'Job abort requested.' });
      this.deps.broker.postToWebview(response);
      sendNotification(this.deps, 'success', 'Monitor', `Job ${payload.jobId} abort requested.`);
    } catch (err: unknown) {
      const message = extractErrorMessage(err);
      this.deps.log(`[ERR] monitor:abort-job: ${message}`);
      const response = buildResponse(this.deps, msg, 'monitor:abort-job:response', { jobId: payload.jobId, success: false, message });
      this.deps.broker.postToWebview(response);
      sendNotification(this.deps, 'error', 'Monitor', `Failed to abort job: ${message}`);
    }
  }
}
