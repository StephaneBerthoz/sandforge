import type { BaseMessage, TrendData, OrgTrendPayload, StorageObjectEntry, DeploymentEntry, ApiUsageCategory, OrgHealthStatus, ApexLogEntry } from '@sandforge/shared';
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
import { ErrorLogMonitor } from '../../modules/monitor/ErrorLogMonitor.js';
import type { ErrorLogEntry } from '../../modules/monitor/ErrorLogMonitor.js';
import { UserSessionMonitor } from '../../modules/monitor/UserSessionMonitor.js';
import type { UserSessionInfo } from '../../modules/monitor/UserSessionMonitor.js';
import { ApexLogAnalyzer } from '../../modules/monitor/ApexLogAnalyzer.js';
import { SandboxRefreshTracker } from '../../modules/monitor/SandboxRefreshTracker.js';
import type { SandboxRefreshEvent } from '../../modules/monitor/SandboxRefreshTracker.js';
import { HealthCheck } from '../../modules/monitor/HealthCheck.js';
import type { HealthSignalProvider } from '../../modules/monitor/HealthCheck.js';
import { AlertEngine } from '../../modules/monitor/AlertEngine.js';
import { AlertStateStore } from '../../modules/monitor/AlertStateStore.js';
import { DEFAULT_ALERT_DEFINITIONS } from '../../modules/monitor/defaultAlertDefinitions.js';

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
  'monitor:error-logs',
  'monitor:sessions',
  'monitor:apex-insights',
  'monitor:sandbox-refresh',
  'monitor:alerts',
  'monitor:alert:acknowledge',
  'monitor:alert:dismiss',
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
  private readonly errorLogMonitor: ErrorLogMonitor;
  private readonly userSessionMonitor: UserSessionMonitor;
  private readonly apexLogAnalyzer: ApexLogAnalyzer;
  private readonly sandboxRefreshTracker: SandboxRefreshTracker;
  private readonly healthCheck: HealthCheck;
  private readonly alertEngine: AlertEngine;
  private readonly alertStateStore: AlertStateStore;

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {
    this.trendStorage = new TrendStorage(deps.configStore);

    // Alert subsystem: state store, engine, and definition seeding
    this.alertStateStore = new AlertStateStore(deps.configStore);
    this.alertEngine = new AlertEngine((alert) => {
      deps.log(`[ALERT] ${alert.severity}: ${alert.message}`);
      const level = alert.severity === 'critical' ? 'error' as const : 'warning' as const;
      sendNotification(deps, level, 'Alert', alert.message);
      this.alertStateStore.saveAlerts(this.alertEngine.getActiveAlerts());
    });

    // Seed definitions from persistence, or use defaults on first launch
    const persistedDefs = this.alertStateStore.loadDefinitions();
    const defsToLoad = persistedDefs.length > 0 ? persistedDefs : DEFAULT_ALERT_DEFINITIONS;
    for (const def of defsToLoad) {
      this.alertEngine.addDefinition(def);
    }
    if (persistedDefs.length === 0) {
      this.alertStateStore.saveDefinitions(DEFAULT_ALERT_DEFINITIONS);
    }

    // Restore previously active alerts
    const persistedAlerts = this.alertStateStore.loadAlerts();
    this.alertEngine.restoreAlerts(persistedAlerts);

    this.errorLogMonitor = new ErrorLogMonitor(async (orgId: string, since: string): Promise<ErrorLogEntry[]> => {
      const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
      const records = await queryAll<{ Id: string; Operation: string; Status: string; DurationMilliseconds: number; LogLength: number; StartTime: string; LogUser: { Username: string } | null }>(
        conn,
        `SELECT Id, Operation, Status, DurationMilliseconds, LogLength, StartTime, LogUser.Username FROM ApexLog WHERE Status != 'Success' AND StartTime > ${since} ORDER BY StartTime DESC LIMIT 50`,
      );
      checkApiLimits(conn.limitInfo, 'monitor:error-logs apexLog');
      return records.map(r => ({
        id: r.Id,
        errorType: r.Status,
        message: `${r.Operation} - ${r.Status}`,
        timestamp: r.StartTime,
        user: r.LogUser?.Username ?? undefined,
        context: r.Operation,
      }));
    });

    this.userSessionMonitor = new UserSessionMonitor(async (orgId: string): Promise<UserSessionInfo[]> => {
      const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
      const records = await queryAll<{ Id: string; UsersId: string; LoginType: string; SessionType: string; CreatedDate: string; SourceIp: string }>(
        conn,
        'SELECT Id, UsersId, LoginType, SessionType, CreatedDate, SourceIp FROM AuthSession ORDER BY CreatedDate DESC LIMIT 100',
      );
      checkApiLimits(conn.limitInfo, 'monitor:sessions authSession');
      return records.map(r => ({
        userId: r.UsersId,
        username: r.UsersId,
        sessionType: r.SessionType ?? r.LoginType ?? 'Unknown',
        loginTime: r.CreatedDate,
        sourceIp: r.SourceIp ?? '',
      }));
    });

    this.apexLogAnalyzer = new ApexLogAnalyzer(async (orgId: string, count: number): Promise<ApexLogEntry[]> => {
      const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
      const records = await queryAll<{ Id: string; Operation: string; Status: string; DurationMilliseconds: number; LogLength: number; StartTime: string; LogUser: { Username: string } | null }>(
        conn,
        `SELECT Id, Operation, Status, DurationMilliseconds, LogLength, StartTime, LogUser.Username FROM ApexLog ORDER BY StartTime DESC LIMIT ${count}`,
      );
      checkApiLimits(conn.limitInfo, 'monitor:apex-insights apexLog');
      return records.map(r => ({
        id: r.Id,
        operation: r.Operation ?? 'Unknown',
        status: r.Status,
        durationMs: r.DurationMilliseconds ?? 0,
        logSize: r.LogLength ?? 0,
        startTime: r.StartTime,
        user: r.LogUser?.Username ?? 'Unknown',
      }));
    });

    this.sandboxRefreshTracker = new SandboxRefreshTracker(async (orgId: string): Promise<SandboxRefreshEvent[]> => {
      const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
      const records = await queryAll<{ Id: string; SandboxName: string; Status: string; CreatedDate: string; Description: string | null }>(
        conn,
        'SELECT Id, SandboxName, Status, CreatedDate, Description FROM SandboxProcess ORDER BY CreatedDate DESC LIMIT 20',
      );
      checkApiLimits(conn.limitInfo, 'monitor:sandbox-refresh sandboxProcess');
      return records.map(r => ({
        orgId,
        sandboxName: r.SandboxName ?? 'Unknown',
        refreshDate: r.CreatedDate,
        status: (r.Status as SandboxRefreshEvent['status']) ?? 'Completed',
        sourceOrg: r.Description ?? undefined,
      }));
    });
    // No onRefreshDetected callback -- see Pitfall 9 in research

    const apiLimitsProvider: HealthSignalProvider = async (orgId: string) => {
      try {
        const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
        const limitsRaw = await this.getOrFetchLimits(orgId, conn);
        const apiEntry = limitsRaw['DailyApiRequests'] as { Max: number; Remaining: number } | undefined;
        const pct = apiEntry ? Math.round(((apiEntry.Max - apiEntry.Remaining) / apiEntry.Max) * 100) : 0;
        const status = pct > 80 ? 'critical' as const : pct > 60 ? 'warning' as const : 'ok' as const;
        return { name: 'apiLimits', status, score: 100 - pct, message: `API usage at ${pct}%` };
      } catch { return { name: 'apiLimits', status: 'ok' as const, score: 100, message: 'Unable to fetch limits' }; }
    };

    const storageProvider: HealthSignalProvider = async (orgId: string) => {
      try {
        const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
        const limitsRaw = await this.getOrFetchLimits(orgId, conn);
        const storageEntry = limitsRaw['DataStorageMB'] as { Max: number; Remaining: number } | undefined;
        const pct = storageEntry ? Math.round(((storageEntry.Max - storageEntry.Remaining) / storageEntry.Max) * 100) : 0;
        const status = pct > 85 ? 'critical' as const : pct > 70 ? 'warning' as const : 'ok' as const;
        return { name: 'storage', status, score: 100 - pct, message: `Storage usage at ${pct}%` };
      } catch { return { name: 'storage', status: 'ok' as const, score: 100, message: 'Unable to fetch storage' }; }
    };

    const errorsProvider: HealthSignalProvider = async (orgId: string) => {
      const errorCount = this.errorLogMonitor.getErrorCount(orgId);
      const score = Math.max(0, 100 - errorCount * 5);
      const status = errorCount > 10 ? 'critical' as const : errorCount > 3 ? 'warning' as const : 'ok' as const;
      return { name: 'recentErrors', status, score, message: `${errorCount} recent errors` };
    };

    const jobsProvider: HealthSignalProvider = async () => {
      return { name: 'activeJobs', status: 'ok' as const, score: 90, message: 'Jobs nominal' };
    };

    this.healthCheck = new HealthCheck([apiLimitsProvider, storageProvider, errorsProvider, jobsProvider]);
  }

  /**
   * Inject the live operation tracker for real-time operation snapshots.
   * @param tracker - The LiveOperationTracker instance.
   */
  setLiveOperationTracker(tracker: LiveOperationTracker): void {
    this.liveOperationTracker = tracker;
  }

  /**
   * Expose the AlertEngine instance so other handlers (e.g. GovernanceOpsHandler)
   * can feed governance-sourced violations into the unified alert pipeline.
   *
   * @returns The AlertEngine instance managed by this handler.
   */
  getAlertEngine(): AlertEngine {
    return this.alertEngine;
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
      case 'monitor:error-logs':
        await this.handleErrorLogs(msg);
        return true;
      case 'monitor:sessions':
        await this.handleSessions(msg);
        return true;
      case 'monitor:apex-insights':
        await this.handleApexInsights(msg);
        return true;
      case 'monitor:sandbox-refresh':
        await this.handleSandboxRefresh(msg);
        return true;
      case 'monitor:alerts':
        this.handleAlerts(msg);
        return true;
      case 'monitor:alert:acknowledge':
        this.handleAlertAcknowledge(msg);
        return true;
      case 'monitor:alert:dismiss':
        this.handleAlertDismiss(msg);
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

      // 1b. Evaluate alerts against each limit
      const triggeredAlerts: import('@sandforge/shared').AlertInstance[] = [];
      for (const limit of limits) {
        const triggered = this.alertEngine.evaluate(limit.name, limit.usedPercent, payload.orgId);
        if (triggered) {
          triggeredAlerts.push(triggered);
        }
      }
      this.alertStateStore.saveAlerts(this.alertEngine.getActiveAlerts());
      if (triggeredAlerts.length > 0) {
        this.alertStateStore.saveHistory(triggeredAlerts);
      }

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

      // 5b. Compute org health status (WIRE-05)
      let orgHealthStatus: OrgHealthStatus | undefined;
      try {
        orgHealthStatus = await this.healthCheck.computeHealth(payload.orgId);
      } catch (healthErr) {
        this.deps.log(`[WARN] HealthCheck failed: ${String(healthErr)}`);
      }

      // 6. Send response
      const response = buildResponse(this.deps, msg, 'monitor:data', { limits, jobs, healthScore, healthReport, trends, orgInfo, orgHealthStatus, lastUpdated: new Date().toISOString() });
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
        'DailyWorkflowEmails', 'MassEmail', 'SingleEmail',
        'HourlyPublishedPlatformEvents', 'DailyStandardVolumePlatformMessages',
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

  /**
   * Handle monitor:error-logs -- fetch recent error log entries.
   * @param msg - The incoming error-logs request message.
   */
  private async handleErrorLogs(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { orgId: string } }).payload;

    try {
      const errors = await this.errorLogMonitor.fetch(payload.orgId);
      const errorsByTypeMap = this.errorLogMonitor.getErrorsByType(payload.orgId);
      const errorsByType = [...errorsByTypeMap.entries()].map(([type, count]) => ({ type, count }));

      const response = buildResponse(this.deps, msg, 'monitor:error-logs:response', {
        success: true,
        errors,
        errorsByType,
        totalCount: errors.length,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'monitor:error-logs', 'monitor:error-logs:response', err);
    }
  }

  /**
   * Handle monitor:sessions -- fetch active user sessions.
   * @param msg - The incoming sessions request message.
   */
  private async handleSessions(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { orgId: string } }).payload;

    try {
      const sessions = await this.userSessionMonitor.fetch(payload.orgId);
      const activeUserCount = this.userSessionMonitor.getActiveUserCount(payload.orgId);

      const response = buildResponse(this.deps, msg, 'monitor:sessions:response', {
        success: true,
        sessions,
        activeUserCount,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'monitor:sessions', 'monitor:sessions:response', err);
    }
  }

  /**
   * Handle monitor:apex-insights -- fetch and analyze Apex logs.
   * @param msg - The incoming apex-insights request message.
   */
  private async handleApexInsights(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { orgId: string } }).payload;

    try {
      const analyses = await this.apexLogAnalyzer.fetchAndAnalyze(payload.orgId, 20);
      const topIssues = this.apexLogAnalyzer.getTopIssues(payload.orgId);

      const response = buildResponse(this.deps, msg, 'monitor:apex-insights:response', {
        success: true,
        analyses,
        topIssues,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'monitor:apex-insights', 'monitor:apex-insights:response', err);
    }
  }

  /**
   * Handle monitor:sandbox-refresh -- fetch sandbox refresh events.
   * @param msg - The incoming sandbox-refresh request message.
   */
  private async handleSandboxRefresh(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { orgId: string } }).payload;

    try {
      const refreshes = await this.sandboxRefreshTracker.fetch(payload.orgId);
      const inProgress = this.sandboxRefreshTracker.isRefreshInProgress(payload.orgId);

      const response = buildResponse(this.deps, msg, 'monitor:sandbox-refresh:response', {
        success: true,
        refreshes,
        inProgress,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'monitor:sandbox-refresh', 'monitor:sandbox-refresh:response', err);
    }
  }

  /**
   * Handle monitor:alerts -- return active alerts and history.
   * @param msg - The incoming alerts request message.
   */
  private handleAlerts(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const alerts = this.alertEngine.getActiveAlerts();
    const history = this.alertStateStore.loadHistory();
    const response = buildResponse(this.deps, msg, 'monitor:alerts:result', { alerts, history });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ${response.type} id=${response.id}`);
  }

  /**
   * Handle monitor:alert:acknowledge -- acknowledge an active alert.
   * @param msg - The incoming acknowledge request message.
   */
  private handleAlertAcknowledge(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { alertId: string } }).payload;
    this.alertEngine.acknowledgeAlert(payload.alertId);
    this.alertStateStore.saveAlerts(this.alertEngine.getActiveAlerts());
    const response = buildResponse(this.deps, msg, 'monitor:alert:acknowledge:response', { success: true });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ${response.type} id=${response.id}`);
  }

  /**
   * Handle monitor:alert:dismiss -- dismiss an active alert.
   * @param msg - The incoming dismiss request message.
   */
  private handleAlertDismiss(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { alertId: string } }).payload;
    this.alertEngine.dismissAlert(payload.alertId);
    this.alertStateStore.saveAlerts(this.alertEngine.getActiveAlerts());
    const response = buildResponse(this.deps, msg, 'monitor:alert:dismiss:response', { success: true });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ${response.type} id=${response.id}`);
  }
}
