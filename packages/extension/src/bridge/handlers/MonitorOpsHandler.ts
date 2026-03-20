import type { BaseMessage, TrendData, OrgTrendPayload, StorageObjectEntry, DeploymentEntry, ApiUsageCategory } from '@sandforge/shared';
import { SF_API_VERSION, MONITOR_PERIOD_MAP, MONITOR_KEY_LIMITS, DEFAULT_SOQL_LIMITS } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';
import { buildResponse, sendHandlerError, sendNotification } from './HandlerTypes.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { queryAll } from '../../core/common/soqlQueryHelper.js';
import { UnifiedHealthScorer } from '../../modules/monitor/UnifiedHealthScorer.js';
import { TrendStorage } from '../../modules/monitor/TrendStorage.js';
import { OrgInfoFetcher } from '../../modules/monitor/OrgInfoFetcher.js';
import type { OrgInfoConnection } from '../../modules/monitor/OrgInfoFetcher.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { computeTrendData } from '../../modules/monitor/trendUtils.js';
import { transformLimitsResponse } from '../../modules/monitor/transformLimitsResponse.js';
import type { RawLimitsResponse } from '../../modules/monitor/transformLimitsResponse.js';
import { checkApiLimits } from '../../core/common/sforceLimitParser.js';
import type { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import type { Connection } from 'jsforce';

/** Message types handled by MonitorOpsHandler. */
const MONITOR_TYPES = new Set([
  'monitor:refresh',
  'monitor:start',
  'monitor:trends',
  'monitor:abort-job',
  'monitor:live-operations',
  'monitor:health-score',
  'monitor:storage',
  'monitor:deployments',
  'monitor:api-usage',
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
  private readonly healthCalculator = new UnifiedHealthScorer();
  private liveOperationTracker?: LiveOperationTracker;
  private readonly limitsCache: Map<string, { data: RawLimitsResponse; fetchedAt: number }> = new Map();
  private static readonly LIMITS_CACHE_TTL_MS = 30_000;

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
   * Return a cached /limits response or fetch a fresh one.
   *
   * Keyed by orgId with a 30-second TTL so that within a single refresh
   * cycle, handleRefresh, handleHealthScore, and handleApiUsage share one
   * API call instead of each requesting /limits independently.
   *
   * @param orgId - The Salesforce org identifier used as cache key.
   * @param conn  - The active jsforce Connection to the target org.
   * @returns The raw limits response object.
   */
  private async getOrFetchLimits(orgId: string, conn: Connection): Promise<RawLimitsResponse> {
    const cached = this.limitsCache.get(orgId);
    if (cached && Date.now() - cached.fetchedAt < MonitorOpsHandler.LIMITS_CACHE_TTL_MS) {
      return cached.data;
    }
    const data = await conn.request(`/services/data/${SF_API_VERSION}/limits`) as RawLimitsResponse;
    this.limitsCache.set(orgId, { data, fetchedAt: Date.now() });
    return data;
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
      case 'monitor:health-score':
        await this.handleHealthScore(msg);
        return true;
      case 'monitor:storage':
        await this.handleStorage(msg);
        return true;
      case 'monitor:deployments':
        await this.handleDeployments(msg);
        return true;
      case 'monitor:api-usage':
        await this.handleApiUsage(msg);
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

      // 1. Get limits (uses shared 30s cache)
      const limitsRaw = await this.getOrFetchLimits(payload.orgId, conn);
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

      // 3. Record snapshot and compute trends
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

      // 4. Fetch org info (cached, non-blocking failure)
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

      // 5. Calculate health report (after orgInfo so metadata dimensions can be included)
      const healthReport = this.healthCalculator.calculate({
        limits,
        orgId: payload.orgId,
        trendStorage: this.trendStorage,
        orgInfo,
      });
      const healthScore = healthReport.overallScore;

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

  /**
   * Handle monitor:health-score -- compute full org health score breakdown.
   * @param msg - The incoming health-score request message.
   */
  private async handleHealthScore(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { orgId: string } }).payload;

    try {
      const conn = await getJsforceConnection(payload.orgId, this.deps.orgRegistry, this.deps.orgManager);
      const limitsRaw = await this.getOrFetchLimits(payload.orgId, conn);
      const limits = transformLimitsResponse(limitsRaw);
      const healthReport = this.healthCalculator.calculate({
        limits,
        orgId: payload.orgId,
        trendStorage: this.trendStorage,
      });

      const dimensions = healthReport.factors.map((f) => ({
        name: f.name,
        score: f.score,
        label: f.category,
        detail: f.detail,
        recommendation: f.recommendation,
      }));

      const response = buildResponse(this.deps, msg, 'monitor:health-score:response', {
        success: true,
        overallScore: healthReport.overallScore,
        dimensions,
        recommendations: healthReport.factors
          .filter((f) => f.status !== 'healthy')
          .map((f) => f.recommendation),
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'monitor:health-score', 'monitor:health-score:response', err);
    }
  }

  /**
   * Handle monitor:storage -- per-object record count breakdown.
   * Queries EntityDefinition for top 20 objects by QualifiedApiName.
   * @param msg - The incoming storage request message.
   */
  private async handleStorage(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { orgId: string } }).payload;

    try {
      const conn = await getJsforceConnection(payload.orgId, this.deps.orgRegistry, this.deps.orgManager);

      const entityRecords = await queryAll<{
        QualifiedApiName: string;
        Label: string;
        RecordCount: number;
      }>(
        conn,
        `SELECT QualifiedApiName, Label, COALESCE(RecordCount, 0) RecordCount FROM EntityDefinition WHERE RecordCount > 0 ORDER BY RecordCount DESC LIMIT 20`,
      );
      checkApiLimits(conn.limitInfo, 'monitor:storage entityDefinition');

      const objects: StorageObjectEntry[] = entityRecords.map((r) => ({
        objectName: r.QualifiedApiName,
        label: r.Label ?? r.QualifiedApiName,
        recordCount: r.RecordCount ?? 0,
      }));

      const totalRecords = objects.reduce((sum, o) => sum + o.recordCount, 0);

      const response = buildResponse(this.deps, msg, 'monitor:storage:response', {
        success: true,
        objects,
        totalRecords,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'monitor:storage', 'monitor:storage:response', err);
    }
  }

  /**
   * Handle monitor:deployments -- recent deployment history.
   * Queries DeployRequest for the 20 most recent deployments.
   * @param msg - The incoming deployments request message.
   */
  private async handleDeployments(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { orgId: string } }).payload;

    try {
      const conn = await getJsforceConnection(payload.orgId, this.deps.orgRegistry, this.deps.orgManager);

      const deployRecords = await queryAll<{
        Id: string;
        Status: string;
        StartDate: string;
        CompletedDate: string | null;
        CreatedBy: { Name: string } | null;
        NumberComponentsTotal: number;
        NumberComponentErrors: number;
      }>(
        conn,
        `SELECT Id, Status, StartDate, CompletedDate, CreatedBy.Name, NumberComponentsTotal, NumberComponentErrors FROM DeployRequest ORDER BY StartDate DESC LIMIT 20`,
      );
      checkApiLimits(conn.limitInfo, 'monitor:deployments deployRequest');

      const deployments: DeploymentEntry[] = deployRecords.map((r) => ({
        id: r.Id,
        status: r.Status as DeploymentEntry['status'],
        startDate: r.StartDate,
        completedDate: r.CompletedDate ?? undefined,
        createdBy: r.CreatedBy?.Name ?? 'Unknown',
        componentCount: r.NumberComponentsTotal ?? 0,
        errorCount: r.NumberComponentErrors ?? 0,
      }));

      const response = buildResponse(this.deps, msg, 'monitor:deployments:response', {
        success: true,
        deployments,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'monitor:deployments', 'monitor:deployments:response', err);
    }
  }

  /**
   * Handle monitor:api-usage -- per-category API limit breakdown.
   * Reads the /limits endpoint and groups key categories.
   * @param msg - The incoming API usage request message.
   */
  private async handleApiUsage(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { orgId: string } }).payload;

    try {
      const conn = await getJsforceConnection(payload.orgId, this.deps.orgRegistry, this.deps.orgManager);
      const limitsRaw = await this.getOrFetchLimits(payload.orgId, conn);
      checkApiLimits(conn.limitInfo, 'monitor:api-usage limits');

      const apiCategories = [
        'DailyApiRequests', 'DailyBulkApiRequests', 'DailyBulkV2QueryJobs',
        'DailyBulkV2QueryFileStorageMB', 'DailyStreamingApiEvents',
        'DailyGenericStreamingApiEvents', 'DailyDurableStreamingApiEvents',
        'DailyAsyncApexExecutions', 'HourlyAsyncReportRuns',
        'HourlyTimeBasedWorkflow', 'DailySoqlQueries',
      ];

      const categories: ApiUsageCategory[] = [];
      for (const key of apiCategories) {
        const entry = limitsRaw[key] as { Max: number; Remaining: number } | undefined;
        if (entry && typeof entry.Max === 'number') {
          const used = entry.Max - entry.Remaining;
          const usedPercent = entry.Max > 0 ? Math.round((used / entry.Max) * 100) : 0;
          categories.push({ category: key, used, max: entry.Max, usedPercent });
        }
      }

      categories.sort((a, b) => b.usedPercent - a.usedPercent);

      const response = buildResponse(this.deps, msg, 'monitor:api-usage:response', {
        success: true,
        categories,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'monitor:api-usage', 'monitor:api-usage:response', err);
    }
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
