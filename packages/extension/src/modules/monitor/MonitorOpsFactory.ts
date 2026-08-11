import type { Connection } from 'jsforce';
import { SF_API_VERSION, DEFAULT_SOQL_LIMITS } from '@sandforge/shared';
import type { ConfigStore } from '../../core/storage/ConfigStore.js';
import { queryAll } from '../../core/common/soqlQueryHelper.js';
import { checkApiLimits } from '../../core/common/sforceLimitParser.js';
import { TrendStorage } from './TrendStorage.js';
import { AlertEngine } from './AlertEngine.js';
import { AlertStateStore } from './AlertStateStore.js';
import { DEFAULT_ALERT_DEFINITIONS } from './defaultAlertDefinitions.js';
import { ErrorLogMonitor } from './ErrorLogMonitor.js';
import type { ErrorLogEntry } from './ErrorLogMonitor.js';
import { UserSessionMonitor } from './UserSessionMonitor.js';
import type { UserSessionInfo } from './UserSessionMonitor.js';
import { ApexLogAnalyzer } from './ApexLogAnalyzer.js';
import type { ApexLogEntry } from '@sandforge/shared';
import { SandboxRefreshTracker } from './SandboxRefreshTracker.js';
import type { SandboxRefreshEvent } from './SandboxRefreshTracker.js';
import { HealthCheck } from './HealthCheck.js';
import type { HealthSignalProvider } from './HealthCheck.js';
import { JobMonitor } from './JobMonitor.js';
import type { JobInfo } from './JobMonitor.js';
import type { RawLimitsResponse } from './transformLimitsResponse.js';

/** TTL of the per-org /limits cache shared across a refresh cycle. */
const LIMITS_CACHE_TTL_MS = 30_000;

/** Dependencies required by {@link createMonitorOps}. */
export interface MonitorOpsFactoryDeps {
  /** Persistence facade for trend snapshots and alert state. */
  configStore: ConfigStore;
  /** Extension log sink. */
  log: (message: string) => void;
  /** User-facing notification sink for triggered alerts. */
  notify: (level: 'error' | 'warning', message: string) => void;
  /** Resolve an authenticated jsforce connection for an org. */
  getConnection: (orgId: string) => Promise<Connection>;
}

/** Ready-made monitor services consumed by MonitorOpsHandler. */
export interface MonitorOpsServices {
  /** Time-series storage for limits snapshots. */
  trendStorage: TrendStorage;
  /** Durable alert state (active alerts, definitions, history). */
  alertStateStore: AlertStateStore;
  /** Alert evaluation engine, seeded and restored from persistence. */
  alertEngine: AlertEngine;
  /** Recent Apex error log monitor. */
  errorLogMonitor: ErrorLogMonitor;
  /** Active user session monitor. */
  userSessionMonitor: UserSessionMonitor;
  /** Apex log analyzer for performance insights. */
  apexLogAnalyzer: ApexLogAnalyzer;
  /** Sandbox refresh event tracker. */
  sandboxRefreshTracker: SandboxRefreshTracker;
  /** Aggregated org health computation (WIRE-05). */
  healthCheck: HealthCheck;
  /**
   * Return a cached /limits response or fetch a fresh one.
   *
   * Keyed by orgId with a 30-second TTL so that within a single refresh
   * cycle, refresh, health-score, and api-usage handling share one
   * API call instead of each requesting /limits independently.
   */
  getOrFetchLimits: (orgId: string, conn: Connection) => Promise<RawLimitsResponse>;
}

/**
 * Build the monitor subsystem for MonitorOpsHandler: stores, alert pipeline
 * (seeded from persistence or defaults), SOQL-backed monitors, the shared
 * /limits cache, and the health-check providers.
 *
 * Extracted from the MonitorOpsHandler constructor so the handler only
 * routes messages while this factory owns service construction.
 *
 * @param deps - Factory dependencies (storage, logging, notifications, connections).
 * @returns The ready-made monitor services.
 */
export function createMonitorOps(deps: MonitorOpsFactoryDeps): MonitorOpsServices {
  const trendStorage = new TrendStorage(deps.configStore);

  // Alert subsystem: state store, engine, and definition seeding
  const alertStateStore = new AlertStateStore(deps.configStore);
  const alertEngine = new AlertEngine((alert) => {
    deps.log(`[ALERT] ${alert.severity}: ${alert.message}`);
    const level = alert.severity === 'critical' ? ('error' as const) : ('warning' as const);
    deps.notify(level, alert.message);
    alertStateStore.saveAlerts(alertEngine.getActiveAlerts());
  });

  // Seed definitions from persistence, or use defaults on first launch
  const persistedDefs = alertStateStore.loadDefinitions();
  const defsToLoad = persistedDefs.length > 0 ? persistedDefs : DEFAULT_ALERT_DEFINITIONS;
  for (const def of defsToLoad) {
    alertEngine.addDefinition(def);
  }
  if (persistedDefs.length === 0) {
    alertStateStore.saveDefinitions(DEFAULT_ALERT_DEFINITIONS);
  }

  // Restore previously active alerts
  const persistedAlerts = alertStateStore.loadAlerts();
  alertEngine.restoreAlerts(persistedAlerts);

  const errorLogMonitor = new ErrorLogMonitor(
    async (orgId: string, since: string): Promise<ErrorLogEntry[]> => {
      const conn = await deps.getConnection(orgId);
      const records = await queryAll<{
        Id: string;
        Operation: string;
        Status: string;
        DurationMilliseconds: number;
        LogLength: number;
        StartTime: string;
        LogUser: { Username: string } | null;
      }>(
        conn,
        `SELECT Id, Operation, Status, DurationMilliseconds, LogLength, StartTime, LogUser.Username FROM ApexLog WHERE Status != 'Success' AND StartTime > ${since} ORDER BY StartTime DESC LIMIT 50`,
      );
      checkApiLimits(conn.limitInfo, 'monitor:error-logs apexLog');
      return records.map((r) => ({
        id: r.Id,
        errorType: r.Status,
        message: `${r.Operation} - ${r.Status}`,
        timestamp: r.StartTime,
        user: r.LogUser?.Username ?? undefined,
        context: r.Operation,
      }));
    },
  );

  const userSessionMonitor = new UserSessionMonitor(
    async (orgId: string): Promise<UserSessionInfo[]> => {
      const conn = await deps.getConnection(orgId);
      const records = await queryAll<{
        Id: string;
        UsersId: string;
        LoginType: string;
        SessionType: string;
        CreatedDate: string;
        SourceIp: string;
      }>(
        conn,
        'SELECT Id, UsersId, LoginType, SessionType, CreatedDate, SourceIp FROM AuthSession ORDER BY CreatedDate DESC LIMIT 100',
      );
      checkApiLimits(conn.limitInfo, 'monitor:sessions authSession');
      return records.map((r) => ({
        userId: r.UsersId,
        username: r.UsersId,
        sessionType: r.SessionType ?? r.LoginType ?? 'Unknown',
        loginTime: r.CreatedDate,
        sourceIp: r.SourceIp ?? '',
      }));
    },
  );

  const apexLogAnalyzer = new ApexLogAnalyzer(
    async (orgId: string, count: number): Promise<ApexLogEntry[]> => {
      const conn = await deps.getConnection(orgId);
      const records = await queryAll<{
        Id: string;
        Operation: string;
        Status: string;
        DurationMilliseconds: number;
        LogLength: number;
        StartTime: string;
        LogUser: { Username: string } | null;
      }>(
        conn,
        `SELECT Id, Operation, Status, DurationMilliseconds, LogLength, StartTime, LogUser.Username FROM ApexLog ORDER BY StartTime DESC LIMIT ${count}`,
      );
      checkApiLimits(conn.limitInfo, 'monitor:apex-insights apexLog');
      return records.map((r) => ({
        id: r.Id,
        operation: r.Operation ?? 'Unknown',
        status: r.Status,
        durationMs: r.DurationMilliseconds ?? 0,
        logSize: r.LogLength ?? 0,
        startTime: r.StartTime,
        user: r.LogUser?.Username ?? 'Unknown',
      }));
    },
  );

  // SandboxProcess only exists on orgs that MANAGE sandboxes (production /
  // dev hub). On a sandbox org the query fails with "sObject type
  // 'SandboxProcess' is not supported" — remember that verdict per org and
  // answer with an empty list instead of erroring on every refresh cycle.
  const sandboxRefreshUnsupported = new Set<string>();
  const sandboxRefreshTracker = new SandboxRefreshTracker(
    async (orgId: string): Promise<SandboxRefreshEvent[]> => {
      if (sandboxRefreshUnsupported.has(orgId)) return [];
      const conn = await deps.getConnection(orgId);
      let records;
      try {
        records = await queryAll<{
          Id: string;
          SandboxName: string;
          Status: string;
          CreatedDate: string;
          Description: string | null;
        }>(
          conn,
          'SELECT Id, SandboxName, Status, CreatedDate, Description FROM SandboxProcess ORDER BY CreatedDate DESC LIMIT 20',
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('SandboxProcess') && message.includes('not supported')) {
          sandboxRefreshUnsupported.add(orgId);
          return [];
        }
        throw err;
      }
      checkApiLimits(conn.limitInfo, 'monitor:sandbox-refresh sandboxProcess');
      return records.map((r) => ({
        orgId,
        sandboxName: r.SandboxName ?? 'Unknown',
        refreshDate: r.CreatedDate,
        status: (r.Status as SandboxRefreshEvent['status']) ?? 'Completed',
        sourceOrg: r.Description ?? undefined,
      }));
    },
  );
  // No onRefreshDetected callback -- see Pitfall 9 in research

  // Shared /limits cache: one API call per org per 30-second window.
  const limitsCache = new Map<string, { data: RawLimitsResponse; fetchedAt: number }>();
  const getOrFetchLimits = async (orgId: string, conn: Connection): Promise<RawLimitsResponse> => {
    const cached = limitsCache.get(orgId);
    if (cached && Date.now() - cached.fetchedAt < LIMITS_CACHE_TTL_MS) {
      return cached.data;
    }
    const data = (await conn.request(
      `/services/data/${SF_API_VERSION}/limits`,
    )) as RawLimitsResponse;
    limitsCache.set(orgId, { data, fetchedAt: Date.now() });
    return data;
  };

  const apiLimitsProvider: HealthSignalProvider = async (orgId: string) => {
    try {
      const conn = await deps.getConnection(orgId);
      const limitsRaw = await getOrFetchLimits(orgId, conn);
      const apiEntry = limitsRaw['DailyApiRequests'] as
        | { Max: number; Remaining: number }
        | undefined;
      const pct = apiEntry
        ? Math.round(((apiEntry.Max - apiEntry.Remaining) / apiEntry.Max) * 100)
        : 0;
      const status =
        pct > 80 ? ('critical' as const) : pct > 60 ? ('warning' as const) : ('ok' as const);
      return { name: 'apiLimits', status, score: 100 - pct, message: `API usage at ${pct}%` };
    } catch {
      return {
        name: 'apiLimits',
        status: 'ok' as const,
        score: 100,
        message: 'Unable to fetch limits',
      };
    }
  };

  const storageProvider: HealthSignalProvider = async (orgId: string) => {
    try {
      const conn = await deps.getConnection(orgId);
      const limitsRaw = await getOrFetchLimits(orgId, conn);
      const storageEntry = limitsRaw['DataStorageMB'] as
        | { Max: number; Remaining: number }
        | undefined;
      const pct = storageEntry
        ? Math.round(((storageEntry.Max - storageEntry.Remaining) / storageEntry.Max) * 100)
        : 0;
      const status =
        pct > 85 ? ('critical' as const) : pct > 70 ? ('warning' as const) : ('ok' as const);
      return { name: 'storage', status, score: 100 - pct, message: `Storage usage at ${pct}%` };
    } catch {
      return {
        name: 'storage',
        status: 'ok' as const,
        score: 100,
        message: 'Unable to fetch storage',
      };
    }
  };

  const errorsProvider: HealthSignalProvider = async (orgId: string) => {
    const errorCount = errorLogMonitor.getErrorCount(orgId);
    const score = Math.max(0, 100 - errorCount * 5);
    const status =
      errorCount > 10
        ? ('critical' as const)
        : errorCount > 3
          ? ('warning' as const)
          : ('ok' as const);
    return { name: 'recentErrors', status, score, message: `${errorCount} recent errors` };
  };

  // Jobs health from real AsyncApexJob data: each failed job in the recent
  // window costs 10 points; more than 5 failed jobs is critical, any failed
  // job is a warning. Fetch failures degrade to a neutral "ok" signal rather
  // than a fabricated score.
  const jobMonitor = new JobMonitor(async (orgId: string): Promise<JobInfo[]> => {
    const conn = await deps.getConnection(orgId);
    const records = await queryAll<{
      Id: string;
      JobType: string;
      Status: string;
      NumberOfErrors: number;
      CreatedDate: string;
      CreatedById: string;
    }>(
      conn,
      `SELECT Id, JobType, Status, NumberOfErrors, CreatedDate, CreatedById FROM AsyncApexJob ORDER BY CreatedDate DESC LIMIT ${DEFAULT_SOQL_LIMITS.monitorJobs}`,
    );
    checkApiLimits(conn.limitInfo, 'monitor:health-score asyncJobs');
    return records.map((r) => ({
      id: r.Id,
      jobType: (r.JobType ?? 'Batch') as JobInfo['jobType'],
      status: r.Status as JobInfo['status'],
      createdBy: r.CreatedById,
      createdDate: r.CreatedDate,
      failedRecords: r.NumberOfErrors,
    }));
  });

  const jobsProvider: HealthSignalProvider = async (orgId: string) => {
    try {
      await jobMonitor.fetch(orgId);
      const stats = jobMonitor.getJobStats(orgId);
      const score = Math.max(0, 100 - stats.failed * 10);
      const status =
        stats.failed > 5
          ? ('critical' as const)
          : stats.failed > 0
            ? ('warning' as const)
            : ('ok' as const);
      return {
        name: 'activeJobs',
        status,
        score,
        message: `${stats.active} active, ${stats.failed} failed of ${stats.total} recent jobs`,
      };
    } catch {
      return {
        name: 'activeJobs',
        status: 'ok' as const,
        score: 100,
        message: 'Unable to fetch jobs',
      };
    }
  };

  const healthCheck = new HealthCheck([
    apiLimitsProvider,
    storageProvider,
    errorsProvider,
    jobsProvider,
  ]);

  return {
    trendStorage,
    alertStateStore,
    alertEngine,
    errorLogMonitor,
    userSessionMonitor,
    apexLogAnalyzer,
    sandboxRefreshTracker,
    healthCheck,
    getOrFetchLimits,
  };
}
