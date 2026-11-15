import type { Connection } from 'jsforce';
import { SF_API_VERSION, DEFAULT_SOQL_LIMITS } from '@sandforge/shared';
import type { ConfigStore } from '../../core/storage/ConfigStore.js';
import { queryAll, queryAllBounded } from '../../core/common/soqlQueryHelper.js';
import type { BoundedRecords } from '../../core/common/soqlQueryHelper.js';
import { checkApiLimits } from '../../core/common/sforceLimitParser.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { isAuthError } from '../../core/common/isAuthError.js';
import { networkFailureOf } from '../../core/common/isNetworkError.js';
import { OrgConnectionError } from '../../core/connection/OrgConnectionError.js';
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
import { SandboxRefreshTracker, sandboxProcessStatus } from './SandboxRefreshTracker.js';
import type {
  SandboxRefreshEvent,
  SandboxRefreshFetch,
  SeenRefreshStore,
} from './SandboxRefreshTracker.js';
import { HealthCheck } from './HealthCheck.js';
import type { HealthSignalProvider } from './HealthCheck.js';
import { JobMonitor } from './JobMonitor.js';
import type { JobInfo } from './JobMonitor.js';
import type { RawLimitsResponse } from './transformLimitsResponse.js';

/** TTL of the per-org /limits cache shared across a refresh cycle. */
const LIMITS_CACHE_TTL_MS = 30_000;

/** Window of error logs the health signal counts, in milliseconds. */
const ERROR_LOG_HEALTH_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How many rows each Monitor list reads, newest first: bounds the page states,
 * not silent caps. Each read goes through `queryAllBounded`, and a list that
 * came back full is marked truncated, which its panel then says in words. The
 * session and error-log reads used to stop at their LIMIT without a word, and
 * the active-user and per-type counts drawn from those rows stopped with them.
 */
const SESSION_LIST_BOUND = 100;
const ERROR_LOG_LIST_BOUND = 50;
const SANDBOX_REFRESH_LIST_BOUND = 20;

/** ConfigStore key prefix of the completed sandbox processes already seen, per org. */
const SEEN_REFRESHES_PREFIX = 'sandbox-process-seen:';

/**
 * The completed refreshes a production org's history already showed, kept in
 * the ConfigStore: a tracker is rebuilt with each window, and one that forgot
 * them would have nothing to tell a new refresh from an old one.
 */
function configSeenStore(configStore: ConfigStore): SeenRefreshStore {
  return {
    load: (orgId) => {
      const keys = configStore.get<unknown>(`${SEEN_REFRESHES_PREFIX}${orgId}`);
      return Array.isArray(keys)
        ? keys.filter((key: unknown): key is string => typeof key === 'string')
        : undefined;
    },
    save: (orgId, keys) => {
      configStore.set(`${SEEN_REFRESHES_PREFIX}${orgId}`, keys, 'sandbox-refresh');
    },
  };
}

/** The health signals the Monitor reads, by the name each one reports. */
export type HealthSignalName = 'apiLimits' | 'storage' | 'recentErrors' | 'activeJobs';

/**
 * Whether a read that failed with `err` may go through on a connection asked
 * anew: the org refused the session (`INVALID_SESSION_ID`, HTTP 401), the
 * session could not be renewed when the connection was asked for — the CLI
 * may have renewed it since —, or the org was not reached at all (a dropped
 * socket, a name that did not resolve). Not a refusal of the org's own, nor a
 * scratch org gone, nor an org a run of failures holds back.
 */
export function readAgainAfter(err: unknown): boolean {
  if (err instanceof OrgConnectionError) return err.code === 'ORG_AUTH_EXPIRED';
  return isAuthError(err) || networkFailureOf(err) !== undefined;
}

/**
 * Why a signal could not be read, as its message says it: the org's error,
 * or the connection's — the session that expired and could not be renewed,
 * with what renews it. A network failure is named by its word: its message
 * names the org's host, twice.
 */
export function unreadWhy(err: unknown): string {
  const network = networkFailureOf(err);
  if (network !== undefined && !(err instanceof OrgConnectionError)) {
    return `the org could not be reached (${network})`;
  }
  return extractErrorMessage(err);
}

/** Dependencies required by {@link createMonitorOps}. */
export interface MonitorOpsFactoryDeps {
  /** Persistence facade for trend snapshots and alert state. */
  configStore: ConfigStore;
  /** Extension log sink. */
  log: (message: string) => void;
  /** User-facing notification sink for triggered alerts. */
  notify: (level: 'error' | 'warning', message: string) => void;
  /**
   * Resolve an authenticated jsforce connection for an org. `again` asks once
   * more after a read met an expired session or a dropped connection: the
   * connection is checked anew, its session renewed through the CLI when the
   * org refuses it, and never handed back from what was held.
   */
  getConnection: (orgId: string, options?: { again?: boolean }) => Promise<Connection>;
  /**
   * Receives each sandbox refresh a production org's history shows completing
   * while SandForge watches it; the history already there is not reported.
   */
  onSandboxRefreshCompleted?: (event: SandboxRefreshEvent) => void;
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
  /** Aggregated org health computation. */
  healthCheck: HealthCheck;
  /**
   * The signals `healthCheck` aggregates, each on its own, by name: a
   * pipeline's Pre-check step reads the ones it names and no other.
   */
  healthSignals: Readonly<Record<HealthSignalName, HealthSignalProvider>>;
  /**
   * Return a cached /limits response or fetch a fresh one.
   *
   * Keyed by orgId with a 30-second TTL so that within a single refresh
   * cycle, refresh and api-usage handling share one
   * API call instead of each requesting /limits independently.
   */
  getOrFetchLimits: (orgId: string, conn: Connection) => Promise<RawLimitsResponse>;
  /** Drop what the services hold about an org that is no longer the org it was. */
  forgetOrg: (orgId: string) => void;
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

  /**
   * What `read` reads of an org through its connection, read once more on a
   * connection asked anew when the first try meets an expired session or a
   * dropped connection ({@link readAgainAfter}). A pipeline's Pre-check past
   * a Delay of 2 h 05 on an org whose sessions last 2 h lost its first
   * reading, the API usage, as "Unable to fetch limits", while the second,
   * the storage, went through on the session the CLI had renewed meanwhile:
   * the step failed, and the run with it, for the `/limits` the storage read
   * a moment later.
   *
   * @param signal - The signal the read is for, as the log line names it.
   */
  const readTwice = async <T>(
    orgId: string,
    signal: HealthSignalName,
    read: (conn: Connection) => Promise<T>,
  ): Promise<T> => {
    try {
      return await read(await deps.getConnection(orgId));
    } catch (first: unknown) {
      if (!readAgainAfter(first)) throw first;
      deps.log(
        `[WARN] monitor:${signal} ${orgId}: ${unreadWhy(first)}; read again on a new connection`,
      );
      try {
        return await read(await deps.getConnection(orgId, { again: true }));
      } catch (second: unknown) {
        // The org held back after failures in a row, these tries among them,
        // says nothing of why they failed: the first try's cause does.
        if (second instanceof OrgConnectionError && second.code === 'ORG_TEMPORARILY_UNREACHABLE') {
          throw first;
        }
        throw second;
      }
    }
  };

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
    async (orgId: string, since: string): Promise<BoundedRecords<ErrorLogEntry>> => {
      const conn = await deps.getConnection(orgId);
      const { records, truncated } = await queryAllBounded<{
        Id: string;
        Operation: string;
        Status: string;
        DurationMilliseconds: number;
        LogLength: number;
        StartTime: string;
        LogUser: { Username: string } | null;
      }>(
        conn,
        `SELECT Id, Operation, Status, DurationMilliseconds, LogLength, StartTime, LogUser.Username FROM ApexLog WHERE Status != 'Success' AND StartTime > ${since} ORDER BY StartTime DESC LIMIT ${ERROR_LOG_LIST_BOUND}`,
        ERROR_LOG_LIST_BOUND,
      );
      checkApiLimits(conn.limitInfo, 'monitor:error-logs apexLog');
      return {
        records: records.map((r) => ({
          id: r.Id,
          errorType: r.Status,
          message: `${r.Operation} - ${r.Status}`,
          timestamp: r.StartTime,
          user: r.LogUser?.Username ?? undefined,
          context: r.Operation,
        })),
        truncated,
      };
    },
  );

  // The health check counts the error logs of its window with COUNT(). It
  // used to count the rows of the panel's read, whose LIMIT that count could
  // never pass: past fifty failures a day, the panel said fifty.
  const countErrorLogs = async (conn: Connection, since: string): Promise<number> => {
    const result = await conn.query(
      `SELECT COUNT() FROM ApexLog WHERE Status != 'Success' AND StartTime > ${since}`,
    );
    checkApiLimits(conn.limitInfo, 'monitor:refresh apexLogCount');
    return result.totalSize;
  };

  const userSessionMonitor = new UserSessionMonitor(
    async (orgId: string): Promise<BoundedRecords<UserSessionInfo>> => {
      const conn = await deps.getConnection(orgId);
      const { records, truncated } = await queryAllBounded<{
        Id: string;
        UsersId: string;
        Users: { Username: string } | null;
        LoginType: string;
        SessionType: string;
        CreatedDate: string;
        SourceIp: string;
      }>(
        conn,
        `SELECT Id, UsersId, Users.Username, LoginType, SessionType, CreatedDate, SourceIp FROM AuthSession ORDER BY CreatedDate DESC LIMIT ${SESSION_LIST_BOUND}`,
        SESSION_LIST_BOUND,
      );
      checkApiLimits(conn.limitInfo, 'monitor:sessions authSession');
      return {
        records: records.map((r) => ({
          sessionId: r.Id,
          userId: r.UsersId,
          // The panel's first column is headed "Username" and showed the 18-char
          // user id, the same value twice. The relationship carries the login.
          username: r.Users?.Username ?? r.UsersId,
          sessionType: r.SessionType ?? r.LoginType ?? 'Unknown',
          loginTime: r.CreatedDate,
          sourceIp: r.SourceIp ?? '',
        })),
        truncated,
      };
    },
  );

  const apexLogAnalyzer = new ApexLogAnalyzer(
    async (orgId: string, count: number): Promise<BoundedRecords<ApexLogEntry>> => {
      const conn = await deps.getConnection(orgId);
      const { records, truncated } = await queryAllBounded<{
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
        count,
      );
      checkApiLimits(conn.limitInfo, 'monitor:apex-insights apexLog');
      return {
        records: records.map((r) => ({
          id: r.Id,
          operation: r.Operation ?? 'Unknown',
          status: r.Status,
          durationMs: r.DurationMilliseconds ?? 0,
          logSize: r.LogLength ?? 0,
          startTime: r.StartTime,
          user: r.LogUser?.Username ?? 'Unknown',
        })),
        truncated,
      };
    },
  );

  // SandboxProcess only exists on orgs that MANAGE sandboxes (production /
  // dev hub). On a sandbox org the query fails with "sObject type
  // 'SandboxProcess' is not supported" — remember that verdict per org and
  // answer with an empty list instead of erroring on every refresh cycle.
  const sandboxRefreshUnsupported = new Set<string>();
  const sandboxRefreshTracker = new SandboxRefreshTracker(
    async (orgId: string): Promise<SandboxRefreshFetch> => {
      if (sandboxRefreshUnsupported.has(orgId)) {
        return { supported: false, events: [], truncated: false };
      }
      const conn = await deps.getConnection(orgId);
      let read: BoundedRecords<{
        Id: string;
        SandboxName: string;
        Status: string | null;
        CreatedDate: string;
        Description: string | null;
      }>;
      try {
        read = await queryAllBounded(
          conn,
          `SELECT Id, SandboxName, Status, CreatedDate, Description FROM SandboxProcess ORDER BY CreatedDate DESC LIMIT ${SANDBOX_REFRESH_LIST_BOUND}`,
          SANDBOX_REFRESH_LIST_BOUND,
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('SandboxProcess') && message.includes('not supported')) {
          sandboxRefreshUnsupported.add(orgId);
          return { supported: false, events: [], truncated: false };
        }
        throw err;
      }
      checkApiLimits(conn.limitInfo, 'monitor:sandbox-refresh sandboxProcess');
      return {
        supported: true,
        events: read.records.map((r) => ({
          orgId,
          sandboxName: r.SandboxName ?? 'Unknown',
          refreshDate: r.CreatedDate,
          // Never `Completed` by default: that is the status the refresh
          // notice fires on, and a row with no status used to read as one.
          status: sandboxProcessStatus(r.Status),
          sourceOrg: r.Description ?? undefined,
        })),
        truncated: read.truncated,
      };
    },
    // The seen-set lives in the ConfigStore and a first read only fills it,
    // so the org's history is not announced as news on every start.
    (event) => deps.onSandboxRefreshCompleted?.(event),
    configSeenStore(deps.configStore),
  );

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

  // A signal that cannot be read says why: the Pre-check that lost its API
  // usage to an expired session failed on "Unable to fetch limits" alone, and
  // nothing told the session from the org.
  const apiLimitsProvider: HealthSignalProvider = async (orgId: string) => {
    try {
      const limitsRaw = await readTwice(orgId, 'apiLimits', (conn) =>
        getOrFetchLimits(orgId, conn),
      );
      const apiEntry = limitsRaw['DailyApiRequests'] as
        { Max: number; Remaining: number } | undefined;
      // A limit the org did not report is not a limit at 0%.
      if (!apiEntry || !apiEntry.Max) {
        return { name: 'apiLimits', status: 'unknown', score: 0, message: 'No API limit reported' };
      }
      const pct = Math.round(((apiEntry.Max - apiEntry.Remaining) / apiEntry.Max) * 100);
      const status =
        pct > 80 ? ('critical' as const) : pct > 60 ? ('warning' as const) : ('ok' as const);
      return {
        name: 'apiLimits',
        status,
        score: 100 - pct,
        message: `API usage at ${pct}%`,
        percent: pct,
      };
    } catch (err: unknown) {
      return {
        name: 'apiLimits',
        status: 'unknown' as const,
        score: 0,
        message: `Unable to fetch limits: ${unreadWhy(err)}`,
      };
    }
  };

  const storageProvider: HealthSignalProvider = async (orgId: string) => {
    try {
      const limitsRaw = await readTwice(orgId, 'storage', (conn) => getOrFetchLimits(orgId, conn));
      const storageEntry = limitsRaw['DataStorageMB'] as
        { Max: number; Remaining: number } | undefined;
      if (!storageEntry || !storageEntry.Max) {
        return {
          name: 'storage',
          status: 'unknown',
          score: 0,
          message: 'No storage limit reported',
        };
      }
      const pct = Math.round(
        ((storageEntry.Max - storageEntry.Remaining) / storageEntry.Max) * 100,
      );
      const status =
        pct > 85 ? ('critical' as const) : pct > 70 ? ('warning' as const) : ('ok' as const);
      return {
        name: 'storage',
        status,
        score: 100 - pct,
        message: `Storage usage at ${pct}%`,
        percent: pct,
      };
    } catch (err: unknown) {
      return {
        name: 'storage',
        status: 'unknown' as const,
        score: 0,
        message: `Unable to fetch storage: ${unreadWhy(err)}`,
      };
    }
  };

  // Counts the error logs of the last 24 hours itself. It used to count the
  // reading the Error Logs panel happened to hold, which a refresh leaves
  // untouched, so the signal stood still while the panel was closed and
  // counted nothing at all until the panel had been opened once.
  const errorsProvider: HealthSignalProvider = async (orgId: string) => {
    let errorCount: number;
    try {
      const since = new Date(Date.now() - ERROR_LOG_HEALTH_WINDOW_MS).toISOString();
      errorCount = await readTwice(orgId, 'recentErrors', (conn) => countErrorLogs(conn, since));
    } catch (err: unknown) {
      return {
        name: 'recentErrors',
        status: 'unknown' as const,
        score: 0,
        message: `Unable to fetch error logs: ${unreadWhy(err)}`,
      };
    }
    const score = Math.max(0, 100 - errorCount * 5);
    const status =
      errorCount > 10
        ? ('critical' as const)
        : errorCount > 3
          ? ('warning' as const)
          : ('ok' as const);
    return {
      name: 'recentErrors',
      status,
      score,
      count: errorCount,
      message: `${errorCount} recent errors`,
    };
  };

  // Jobs health from real AsyncApexJob data: each failed job in the recent
  // window costs 10 points; more than 5 failed jobs is critical, any failed
  // job is a warning. A fetch that fails is `unknown`, left out of the score.
  const recentJobsOf = async (conn: Connection): Promise<JobInfo[]> => {
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
    checkApiLimits(conn.limitInfo, 'monitor:refresh asyncJobs');
    return records.map((r) => ({
      id: r.Id,
      jobType: (r.JobType ?? 'Batch') as JobInfo['jobType'],
      status: r.Status as JobInfo['status'],
      createdBy: r.CreatedById,
      createdDate: r.CreatedDate,
      failedRecords: r.NumberOfErrors,
    }));
  };
  const jobMonitor = new JobMonitor((orgId: string): Promise<JobInfo[]> =>
    readTwice(orgId, 'activeJobs', recentJobsOf),
  );

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
        count: stats.failed,
        // The read stops at the newest DEFAULT_SOQL_LIMITS.monitorJobs jobs,
        // so the failures are those of this many jobs, not of the org.
        outOf: stats.total,
        message: `${stats.active} active, ${stats.failed} failed of ${stats.total} recent jobs`,
      };
    } catch (err: unknown) {
      return {
        name: 'activeJobs',
        status: 'unknown' as const,
        score: 0,
        message: `Unable to fetch jobs: ${unreadWhy(err)}`,
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
    healthSignals: {
      apiLimits: apiLimitsProvider,
      storage: storageProvider,
      recentErrors: errorsProvider,
      activeJobs: jobsProvider,
    },
    getOrFetchLimits,
    forgetOrg: (orgId) => {
      limitsCache.delete(orgId);
    },
  };
}
