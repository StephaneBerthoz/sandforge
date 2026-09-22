import type {
  JobInsight,
  StorageObjectEntry,
  DeploymentEntry,
  ApiUsageCategory,
  OrgHealthStatus,
  MonitorOpenApexJobsResponse,
} from '@sandforge/shared';
import { MONITOR_KEY_LIMITS, DEFAULT_SOQL_LIMITS, SF_API_VERSION } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler, InboundRequest } from './HandlerTypes.js';
import { buildResponse, sendHandlerError, sendNotification } from './HandlerTypes.js';
import {
  validatePayload,
  monitorOrgPayloadSchema,
  monitorOpenApexJobsPayloadSchema,
  monitorAlertIdPayloadSchema,
} from '../validatePayload.js';
import { ExternalBrowserAdapter } from '../../adapters/browser/ExternalBrowserAdapter.js';
import { apexJobsSetupUrl } from '../../modules/monitor/apexJobsSetupUrl.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { queryAll } from '../../core/common/soqlQueryHelper.js';
import { UnifiedHealthScorer } from '../../modules/monitor/UnifiedHealthScorer.js';
import type { TrendStorage } from '../../modules/monitor/TrendStorage.js';
import { OrgInfoFetcher, newestApiVersion } from '../../modules/monitor/OrgInfoFetcher.js';
import type { OrgInfoConnection } from '../../modules/monitor/OrgInfoFetcher.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { transformLimitsResponse } from '../../modules/monitor/transformLimitsResponse.js';
import type { RawLimitsResponse } from '../../modules/monitor/transformLimitsResponse.js';
import { checkApiLimits } from '../../core/common/sforceLimitParser.js';
import type { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import type { Connection } from 'jsforce';
import type { ErrorLogMonitor } from '../../modules/monitor/ErrorLogMonitor.js';
import type { UserSessionMonitor } from '../../modules/monitor/UserSessionMonitor.js';
import type { ApexLogAnalyzer } from '../../modules/monitor/ApexLogAnalyzer.js';
import type { SandboxRefreshTracker } from '../../modules/monitor/SandboxRefreshTracker.js';
import type { HealthCheck } from '../../modules/monitor/HealthCheck.js';
import type { AlertEngine } from '../../modules/monitor/AlertEngine.js';
import type { AlertStateStore } from '../../modules/monitor/AlertStateStore.js';
import { createMonitorOps } from '../../modules/monitor/MonitorOpsFactory.js';
import { TimeoutManager } from '../../core/engine/TimeoutManager.js';

/** Bound for monitor:refresh org calls, kept below the 30 s bridge timeout. */
const MONITOR_REFRESH_TIMEOUT_MS = 25_000;

/**
 * The newest deployments, Apex logs and objects the panels list. Bounds, not
 * the org's whole history: a list that comes back full says so on the page.
 */
const DEPLOYMENT_LIST_BOUND = 20;
const APEX_LOG_SAMPLE = 20;
const STORAGE_LIST_BOUND = 20;

/**
 * Platform facts relied on below. Those marked (describe) were checked against
 * a live org's AsyncApexJob describe on 2026-09-11. Those marked (docs) come
 * from Salesforce documentation this session could not reach (HTTP 403), and
 * are relied on only in the direction that avoids a false alarm.
 */

/**
 * The recent AsyncApexJob window read by a monitor tick.
 *
 * `JobItemsProcessed` and `TotalJobItems` are labelled "Batches Processed" and
 * "Total Batches" (describe), and are what the stall detection reads. They are
 * two more columns of the query the tick already makes, not another call.
 */
const ASYNC_APEX_JOB_SOQL = `SELECT Id, JobType, Status, NumberOfErrors, JobItemsProcessed, TotalJobItems, CreatedDate, CreatedById FROM AsyncApexJob ORDER BY CreatedDate DESC LIMIT ${DEFAULT_SOQL_LIMITS.monitorJobs}`;

/**
 * The same window as the health check's jobs provider asks for it in
 * `MonitorOpsFactory`: fewer columns, same rows. Byte-identical to that query,
 * because {@link MonitorOpsHandler.withSharedJobQuery} matches on the string;
 * the shared-job-query tests go red if the two drift apart.
 */
const HEALTH_CHECK_JOB_SOQL = `SELECT Id, JobType, Status, NumberOfErrors, CreatedDate, CreatedById FROM AsyncApexJob ORDER BY CreatedDate DESC LIMIT ${DEFAULT_SOQL_LIMITS.monitorJobs}`;

/**
 * The queries the in-flight refresh's rows can answer. Serving the narrower
 * projection from the wider rows is sound: same object, same order, same
 * limit, and the provider maps only the columns it asked for.
 */
const SHAREABLE_JOB_SOQL: ReadonlySet<string> = new Set([
  ASYNC_APEX_JOB_SOQL,
  HEALTH_CHECK_JOB_SOQL,
]);

/** One AsyncApexJob row as read by {@link ASYNC_APEX_JOB_SOQL}. */
interface AsyncApexJobRecord extends Record<string, unknown> {
  Id: string;
  JobType: string;
  Status: string;
  NumberOfErrors: number;
  /**
   * Read defensively: a row without the column must degrade to "no progress
   * evidence", never to a stall.
   */
  JobItemsProcessed?: number | null;
  /** Nillable (describe). */
  TotalJobItems?: number | null;
  CreatedDate: string;
  CreatedById: string;
}

/**
 * Statuses of a job still in flight and not parked.
 *
 * The Status picklist is Queued, Processing, Aborted, Completed, Failed,
 * Preparing, Holding (describe). Completed, Failed and Aborted are terminal.
 * Holding is left out: it is the wait for a flex-queue slot (docs), which no
 * abort of the waiting job shortens.
 */
const IN_FLIGHT_STATUSES: ReadonlySet<string> = new Set(['Queued', 'Preparing', 'Processing']);

/**
 * The job types whose lifecycle this analysis models.
 *
 * BatchApex reports batch counters. Queueable and Future run as a single
 * transaction and report none. Every other JobType value (describe) is left
 * out on purpose, because a claim about a lifecycle SandForge has not modelled
 * is a guess shown in red:
 * - ScheduledApex: the row stays Queued until the schedule fires (docs), days
 *   away for a weekly job. Excluding it is the side that cannot band a healthy
 *   schedule. It also keeps the band's link honest: a scheduled job is not
 *   aborted from Setup > Apex Jobs, the page the band opens, but from Setup >
 *   All Scheduled Jobs (Salesforce help).
 * - BatchApexWorker: rows under a BatchApex parent, which carries the
 *   counters; a verdict pointed at a worker would name the wrong row.
 * - TestRequest, TestWorker: test runs, long by nature.
 * - SharingRecalculation, ApexToken: platform-initiated work.
 */
const MODELLED_JOB_TYPES: ReadonlySet<string> = new Set(['BatchApex', 'Queueable', 'Future']);

/**
 * How long a batch counter must stay unchanged, under this dashboard's own
 * observation, before the job is called stuck.
 *
 * The evidence: "Batches Processed" only counts up as batches complete, so the
 * same value at two sightings this far apart means no batch completed in
 * between. Age proves nothing of the kind: `CreatedDate` includes every minute
 * spent queued, and a large batch legitimately runs for hours. That is why age
 * alone never reaches this tier.
 *
 * The length: each batch is one `execute` transaction, which the Apex governor
 * limits cap at 10 minutes of execution (docs). A healthy job whose every
 * batch ran to that ceiling would still have moved several times in an hour.
 * The platform documents no bound on the wait between two batches, so the
 * window is set generously rather than tightly. Even past it SandForge aborts
 * nothing: the band links to Setup > Apex Jobs, where the reader decides.
 */
const STALL_WINDOW_MS = 60 * 60 * 1000;

/**
 * How long after submission an in-flight job is reported as unfinished.
 *
 * A warning, never a stall: without a counter that stood still under
 * observation, the only fact is that the job has not finished yet. The bound
 * is the stall window's: no job younger than an hour can have been watched
 * still for an hour, so this is the earliest point at which the tier above
 * could have spoken. Below it, a job in flight is ordinary work, and a warning
 * there would teach the reader to ignore the band.
 */
const UNFINISHED_AGE_MS = STALL_WINDOW_MS;

/**
 * Failures of one job type, inside the recent-job window, that make a pattern.
 *
 * One failure is an incident. Two can still be one incident counted twice: the
 * platform re-runs some async work after transient errors (row-lock contention
 * above all), and a retried job lands as a second failed row for a single root
 * cause. Three separate jobs of the same type failing inside the same window
 * of {@link DEFAULT_SOQL_LIMITS.monitorJobs} rows no longer fits that
 * explanation, and is worth a reader's attention.
 */
const REPEATED_FAILURE_THRESHOLD = 3;

/** One job as the `monitor:data` payload carries it. */
interface MonitorJobSummary {
  id: string;
  jobType: string;
  status: string;
  createdBy: string;
  createdDate: string;
  failedRecords: number;
}

/** A job as the insights read it: the payload summary plus its batch counters. */
interface ObservedJob extends MonitorJobSummary {
  /** `JobItemsProcessed`, or `null` when the org sent none. */
  batchesProcessed: number | null;
  /** `TotalJobItems`, or `null` when the org sent none. */
  totalBatches: number | null;
}

/** What this dashboard last saw of one in-flight job, and since when. */
interface JobSighting {
  status: string;
  batchesProcessed: number | null;
  totalBatches: number | null;
  /** Extension-host clock at the first sighting that showed these values. */
  unchangedSinceMs: number;
  /** Whether the values changed at least once while watched. */
  movedWhileWatched: boolean;
}

/** In-flight job id to its latest sighting, for one org. */
type JobProgressLog = ReadonlyMap<string, JobSighting>;

/** Renders a minute count as `3h10m` / `45m`, for insight copy. */
function formatJobAge(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h${String(minutes).padStart(2, '0')}m` : `${minutes}m`;
}

/** Whether a sighting shows exactly the values the job shows now. */
function looksTheSame(sighting: JobSighting, job: ObservedJob): boolean {
  return (
    sighting.status === job.status &&
    sighting.batchesProcessed === job.batchesProcessed &&
    sighting.totalBatches === job.totalBatches
  );
}

/**
 * Folds one refresh's window into the org's progress log.
 *
 * Only the jobs of this window are kept, so a job that left it is forgotten. Times come from the extension host's clock at each sighting,
 * never from the org's `CreatedDate`: the stall measure rests on nothing but
 * two of this dashboard's own observations.
 *
 * @param previous - The log after the org's previous refresh, if any.
 * @param jobs - This refresh's window.
 * @param nowMs - When the window was read.
 * @returns A new log; `previous` is left untouched.
 */
function trackJobProgress(
  previous: JobProgressLog | undefined,
  jobs: ObservedJob[],
  nowMs: number,
): JobProgressLog {
  const next = new Map<string, JobSighting>();
  for (const job of jobs) {
    const prior = previous?.get(job.id);
    if (prior !== undefined && looksTheSame(prior, job)) {
      next.set(job.id, prior);
      continue;
    }
    next.set(job.id, {
      status: job.status,
      batchesProcessed: job.batchesProcessed,
      totalBatches: job.totalBatches,
      unchangedSinceMs: nowMs,
      movedWhileWatched: prior !== undefined,
    });
  }
  return next;
}

/**
 * Derives the job insights the Monitor page bands, from the rows the refresh
 * already holds and what earlier refreshes saw of the same jobs.
 *
 * Asks the org for nothing. Each tier claims no more than its evidence:
 * - `stuck` (critical, one insight per job, the only tier the page links to
 *   Setup > Apex Jobs from): a job in Processing, with batches left to run, whose batch
 *   counter stayed unchanged across {@link STALL_WINDOW_MS} of watching. The
 *   counter is the proof, whatever the type; BatchApex is the type that has one.
 * - `frequent_failures` (critical, no action): see
 *   {@link REPEATED_FAILURE_THRESHOLD}.
 * - `long_running` (warning, no action): still in flight
 *   {@link UNFINISHED_AGE_MS} after submission, neither seen moving inside the
 *   stall window nor provably stalled.
 *
 * An empty result is a verdict, which is why the refresh emits the array even
 * when it is empty: the page tells a scan that found nothing from a scan that
 * never ran only if the producer always speaks.
 *
 * @param jobs - The recent AsyncApexJob window, newest first.
 * @param progress - The org's progress log, already updated with `jobs`.
 * @param nowMs - The instant `jobs` was read.
 * @returns Insights, critical first; `[]` when nothing is wrong.
 */
function computeJobInsights(
  jobs: ObservedJob[],
  progress: JobProgressLog,
  nowMs: number,
): JobInsight[] {
  const insights: JobInsight[] = [];
  const stalled: Array<{ job: ObservedJob; stillMs: number; done: number; total: number }> = [];
  const unfinished: Array<{ job: ObservedJob; ageMs: number; stillMs: number | null }> = [];

  for (const job of jobs) {
    if (!IN_FLIGHT_STATUSES.has(job.status) || !MODELLED_JOB_TYPES.has(job.jobType)) continue;

    const sighting = progress.get(job.id);
    const stillMs = sighting === undefined ? null : nowMs - sighting.unchangedSinceMs;
    const done = job.batchesProcessed;
    const total = job.totalBatches;

    if (
      job.status === 'Processing' &&
      done !== null &&
      total !== null &&
      done < total &&
      stillMs !== null &&
      stillMs >= STALL_WINDOW_MS
    ) {
      stalled.push({ job, stillMs, done, total });
      continue;
    }

    // Seen moving inside the stall window: progressing, whatever its age.
    if (sighting?.movedWhileWatched === true && stillMs !== null && stillMs < STALL_WINDOW_MS) {
      continue;
    }

    // A malformed CreatedDate parses to NaN, and every NaN comparison is
    // false, so a row the org sent unusable is never reported.
    const ageMs = nowMs - Date.parse(job.createdDate);
    if (ageMs >= UNFINISHED_AGE_MS) unfinished.push({ job, ageMs, stillMs });
  }

  // ── Stuck: one insight per job, longest stall first ──
  stalled.sort((a, b) => b.stillMs - a.stillMs);
  for (const { job, stillMs, done, total } of stalled) {
    const still = formatJobAge(Math.floor(stillMs / 60_000));
    insights.push({
      type: 'stuck',
      severity: 'critical',
      title: `${job.jobType} ${job.id}: no batch completed in ${still}`,
      detail:
        `${done} of ${total} batches processed, unchanged across ${still} of observation ` +
        `by this dashboard while ${job.status} (stall bound ${STALL_WINDOW_MS / 60_000}m).`,
      affectedJobs: [job.id],
      recommendation:
        'Check the job in Setup > Apex Jobs first. If it is still at the same batch, abort ' +
        'it and re-run it once the cause is known.',
    });
  }

  // ── Repeated failures: the same operation failing again and again ──
  //
  // "Same operation" is read as job type: the shared job query selects no
  // ApexClass name, and widening it would cost the reuse the health check
  // depends on. Type is the coarsest honest grouping, and the insight says so
  // by naming the type rather than pretending to name a class.
  const failuresByType = new Map<string, MonitorJobSummary[]>();
  for (const job of jobs) {
    // Aborted is a decision someone took, not a failure to report back.
    if (job.status === 'Aborted') continue;
    // A Completed batch with NumberOfErrors > 0 did fail, partially: the count
    // is the number of batch executions that threw.
    if (job.status !== 'Failed' && job.failedRecords <= 0) continue;
    const bucket = failuresByType.get(job.jobType) ?? [];
    bucket.push(job);
    failuresByType.set(job.jobType, bucket);
  }

  for (const [jobType, failed] of failuresByType) {
    if (failed.length < REPEATED_FAILURE_THRESHOLD) continue;
    const errorTotal = failed.reduce((sum, job) => sum + (job.failedRecords || 0), 0);
    insights.push({
      type: 'frequent_failures',
      severity: 'critical',
      title: `${failed.length} ${jobType} jobs failed`,
      detail:
        `${failed.length} of the last ${jobs.length} jobs are ${jobType} failures ` +
        `(${errorTotal} failed batch execution(s) reported) — at or above the ` +
        `${REPEATED_FAILURE_THRESHOLD}-failure pattern threshold.`,
      affectedJobs: failed.map((job) => job.id),
      recommendation:
        `Open the most recent ${jobType} failure and read its extended status: ` +
        'a repeat at this rate is a defect or a data problem, not contention.',
    });
  }

  // ── Unfinished: old, but nothing proves it stopped ──
  if (unfinished.length > 0) {
    unfinished.sort((a, b) => b.ageMs - a.ageMs);
    const oldest = unfinished[0];
    const age = formatJobAge(Math.floor(oldest.ageMs / 60_000));
    const { batchesProcessed: done, totalBatches: total } = oldest.job;
    const counter =
      done === null || total === null || total <= 0
        ? 'it reports no batch counter, so its progress cannot be observed'
        : oldest.stillMs === null || oldest.stillMs < 60_000
          ? `${done} of ${total} batches processed, first seen at these values on this refresh`
          : `${done} of ${total} batches processed, unchanged over the ` +
            `${formatJobAge(Math.floor(oldest.stillMs / 60_000))} watched so far`;
    insights.push({
      type: 'long_running',
      severity: 'warning',
      title:
        unfinished.length === 1
          ? `1 job unfinished ${age} after submission`
          : `${unfinished.length} jobs unfinished ${UNFINISHED_AGE_MS / 60_000}m or more after submission`,
      detail:
        `${oldest.job.jobType} ${oldest.job.id} is ${oldest.job.status}, submitted ${age} ago; ` +
        `${counter}. Time since submission includes time spent queued: it is not evidence of a stall.`,
      affectedJobs: unfinished.map(({ job }) => job.id),
      recommendation:
        'Keep this dashboard refreshing to measure progress, or check the job in Setup > Apex ' +
        `Jobs. A batch is called stuck only once its batch counter stays unchanged for ` +
        `${STALL_WINDOW_MS / 60_000}m of watching; a job without batch counters never is.`,
    });
  }

  return insights;
}

/** Message types handled by MonitorOpsHandler. */
const MONITOR_TYPES = new Set([
  'monitor:refresh',
  'monitor:open-apex-jobs',
  'monitor:live-operations',
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
 * trend computation, the Setup > Apex Jobs link, and full refresh operations.
 * Service construction (stores, alert pipeline, SOQL-backed monitors,
 * /limits cache, health providers) is delegated to {@link createMonitorOps};
 * this handler only orchestrates message handling.
 */
export class MonitorOpsHandler implements DomainHandler {
  private readonly trendStorage: TrendStorage;
  private readonly orgInfoFetcher = new OrgInfoFetcher();
  private readonly healthCalculator = new UnifiedHealthScorer();
  private liveOperationTracker?: LiveOperationTracker;
  private readonly getOrFetchLimits: (
    orgId: string,
    conn: Connection,
  ) => Promise<RawLimitsResponse>;
  /** Drops what the monitor services hold about one org (see {@link forgetOrg}). */
  private readonly forgetServicesOrg: (orgId: string) => void;
  private readonly errorLogMonitor: ErrorLogMonitor;
  private readonly userSessionMonitor: UserSessionMonitor;
  private readonly apexLogAnalyzer: ApexLogAnalyzer;
  private readonly sandboxRefreshTracker: SandboxRefreshTracker;
  private readonly healthCheck: HealthCheck;
  private readonly alertEngine: AlertEngine;
  private readonly alertStateStore: AlertStateStore;
  /**
   * AsyncApexJob rows already fetched by the refresh currently running for an
   * org, held only for the span of that refresh (see {@link withSharedJobQuery}).
   */
  private readonly inFlightJobRecords = new Map<string, AsyncApexJobRecord[]>();
  /**
   * Per org, what earlier refreshes saw of each in-flight job (see
   * {@link trackJobProgress}). Kept for the handler's lifetime: a stall is
   * only provable across two refreshes.
   */
  private readonly jobProgress = new Map<string, JobProgressLog>();
  /** Opens Setup > Apex Jobs in the system browser (see {@link handleOpenApexJobs}). */
  private readonly externalBrowser: ExternalBrowserAdapter;

  /**
   * @param deps - Injected handler dependencies.
   * @param externalBrowser - Injected for tests; defaults to VS Code's `openExternal`.
   */
  constructor(
    private readonly deps: HandlerDeps,
    externalBrowser?: ExternalBrowserAdapter,
  ) {
    this.externalBrowser = externalBrowser ?? new ExternalBrowserAdapter();
    const ops = createMonitorOps({
      configStore: deps.configStore,
      log: (message) => deps.log(message),
      notify: (level, message) => sendNotification(deps, level, 'Alert', message),
      getConnection: async (orgId) =>
        this.withSharedJobQuery(
          orgId,
          await getJsforceConnection(orgId, deps.orgRegistry, deps.orgManager),
        ),
      // A refresh a production org's history shows completing is recorded on
      // the registered sandbox it names, which is then told like any other.
      onSandboxRefreshCompleted: (event) => {
        deps.sandboxRefreshes?.noteCompletedRefresh(event);
      },
    });
    this.trendStorage = ops.trendStorage;
    this.forgetServicesOrg = ops.forgetOrg;
    this.alertStateStore = ops.alertStateStore;
    this.alertEngine = ops.alertEngine;
    this.errorLogMonitor = ops.errorLogMonitor;
    this.userSessionMonitor = ops.userSessionMonitor;
    this.apexLogAnalyzer = ops.apexLogAnalyzer;
    this.sandboxRefreshTracker = ops.sandboxRefreshTracker;
    this.healthCheck = ops.healthCheck;
    this.getOrFetchLimits = ops.getOrFetchLimits;
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
   * Drop what the Monitor holds about an org that is no longer the org it
   * was: a refreshed sandbox answers from a new org behind the same id.
   *
   * The org info and the /limits reading would be served for minutes more;
   * the job progress log watches jobs of the old org. The trend history goes
   * too: storage and API usage start over with a copy of production, and a
   * trend drawn across the refresh would predict from the jump.
   *
   * @param orgId - The registered org.
   */
  forgetOrg(orgId: string): void {
    this.forgetServicesOrg(orgId);
    this.orgInfoFetcher.clearCache(orgId);
    this.jobProgress.delete(orgId);
    this.trendStorage.purge(orgId);
  }

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: InboundRequest): Promise<boolean> {
    if (!MONITOR_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'monitor:refresh':
        await this.handleRefresh(msg);
        return true;
      case 'monitor:open-apex-jobs':
        await this.handleOpenApexJobs(msg);
        return true;
      case 'monitor:live-operations':
        this.handleLiveOperations(msg);
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

  /**
   * Hand the monitor services a connection that reuses the AsyncApexJob window
   * the in-flight refresh already fetched.
   *
   * The health check's jobs provider reads the window {@link executeRefresh}
   * has just read, as a narrower projection (see {@link SHAREABLE_JOB_SOQL}),
   * so every monitor tick asked the org for its job list twice. Serving the second read from the rows already in
   * hand keeps the tick at one AsyncApexJob call; any other query, and any
   * call made outside a refresh, still goes straight to the org.
   *
   * @param orgId - Org whose in-flight refresh rows may be reused.
   * @param conn - The real jsforce connection to delegate to.
   * @returns The connection, with `query` short-circuited for that one SOQL.
   */
  private withSharedJobQuery(orgId: string, conn: Connection): Connection {
    return new Proxy(conn, {
      get: (target, prop): unknown => {
        if (prop === 'query') {
          return (soql: string): unknown => {
            const shared = this.inFlightJobRecords.get(orgId);
            if (shared !== undefined && SHAREABLE_JOB_SOQL.has(soql)) {
              return Promise.resolve({ done: true, totalSize: shared.length, records: shared });
            }
            return target.query(soql);
          };
        }
        const value: unknown = Reflect.get(target, prop, target);
        // Bind so jsforce methods keep operating on (and writing to) the real
        // connection — `limitInfo` updates must not land on the wrapper.
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  }

  /**
   * Whether the refresh has outlived its bound.
   *
   * Once it has, `handleRefresh` has already replied `monitor:error` for this
   * request and the webview has closed the correlation: every further org call
   * is budget spent on a reply nobody can receive, and a late `monitor:data`
   * would only be discarded.
   *
   * @param deadline - The refresh bound's abort signal.
   * @param step - What is being skipped, for the log line.
   * @returns `true` when the caller must stop.
   */
  private pastDeadline(deadline: AbortSignal, step: string): boolean {
    if (!deadline.aborted) return false;
    this.deps.log(
      `[WARN] monitor:refresh outlived its ${MONITOR_REFRESH_TIMEOUT_MS}ms bound; skipping ${step}`,
    );
    return true;
  }

  private async handleRefresh(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(monitorOrgPayloadSchema, msg, 'monitor:error', this.deps);
    if (!parsed) return;
    const payload = parsed;

    try {
      // Bounded below the 30 s bridge timeout: a hanging org call must produce
      // a real monitor:error, not a generic webview timeout. The signal is
      // passed down so the abandoned work stops instead of racing to post a
      // second, contradictory reply.
      await new TimeoutManager(MONITOR_REFRESH_TIMEOUT_MS).withTimeout(
        'monitor:refresh',
        (signal) => this.executeRefresh(msg, payload, signal),
      );
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'monitor:refresh', 'monitor:error', msg, err);
    }
  }

  private async executeRefresh(
    msg: InboundRequest,
    payload: { orgId: string },
    deadline: AbortSignal,
  ): Promise<void> {
    try {
      const conn = await getJsforceConnection(
        payload.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );

      // 1. Get limits (uses shared 30s cache) and the recent async jobs at the
      // same time: neither call needs the other, and awaiting them in turn made
      // every tick wait for both round trips back to back.
      //
      // allSettled, not all: the tick keeps the outcome the sequential order
      // gave. A /limits failure is the one reported whichever call fails first,
      // and the alerts below are still evaluated when only the job query fails.
      const [limitsOutcome, jobsOutcome] = await Promise.allSettled([
        this.getOrFetchLimits(payload.orgId, conn),
        queryAll<AsyncApexJobRecord>(conn, ASYNC_APEX_JOB_SOQL),
      ]);
      if (limitsOutcome.status === 'rejected') throw limitsOutcome.reason;
      const limits = transformLimitsResponse(limitsOutcome.value);
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

      // 2. The async jobs — published for the rest of this refresh so the
      // health check's jobs signal reads them instead of re-querying the org.
      if (jobsOutcome.status === 'rejected') throw jobsOutcome.reason;
      const jobRecords = jobsOutcome.value;
      checkApiLimits(conn.limitInfo, 'monitor:refresh asyncJobs');
      this.inFlightJobRecords.set(payload.orgId, jobRecords);
      if (this.pastDeadline(deadline, 'org info and health check')) return;
      const observedAtMs = Date.now();
      const observed: ObservedJob[] = jobRecords.map((r) => ({
        id: r.Id,
        jobType: r.JobType ?? 'Unknown',
        status: r.Status,
        createdBy: r.CreatedById,
        createdDate: r.CreatedDate,
        failedRecords: r.NumberOfErrors,
        batchesProcessed: r.JobItemsProcessed ?? null,
        totalBatches: r.TotalJobItems ?? null,
      }));
      // The window is a bound, not the org's whole history: when it comes back
      // full the org may hold older jobs, and the page says so under the list
      // and the counts it draws from it.
      const jobsTruncated = jobRecords.length >= DEFAULT_SOQL_LIMITS.monitorJobs;
      // The payload keeps its contract: the batch counters feed the insights only.
      const jobs: MonitorJobSummary[] = observed.map(
        ({ id, jobType, status, createdBy, createdDate, failedRecords }) => ({
          id,
          jobType,
          status,
          createdBy,
          createdDate,
          failedRecords,
        }),
      );

      // 2b. Read the insights out of those rows and out of what earlier
      // refreshes saw of the same jobs. No extra org call.
      const progress = trackJobProgress(
        this.jobProgress.get(payload.orgId),
        observed,
        observedAtMs,
      );
      this.jobProgress.set(payload.orgId, progress);
      const jobInsights = computeJobInsights(observed, progress, observedAtMs);

      // 3. Record the snapshot and compute the trends, from one read of the
      // stored history: the series cover the week kept, the verdicts the last day.
      const snapshot = {
        orgId: payload.orgId,
        limits,
        timestamp: new Date().toISOString(),
      };
      const trends = this.trendStorage.recordAndGetTrends(
        payload.orgId,
        snapshot,
        MONITOR_KEY_LIMITS,
      );

      // 4. Fetch org info (cached, non-blocking failure)
      const orgInfo = await this.fetchOrgInfo(payload.orgId, conn);

      // 4b. The Organization row just read names the org this entry reaches:
      // a refreshed sandbox answers with a new id under the same entry.
      if (orgInfo) {
        this.deps.sandboxRefreshes?.observe(
          payload.orgId,
          { organizationId: orgInfo.orgId, instanceName: orgInfo.instanceName || undefined },
          'monitor',
        );
      }

      // 5. Calculate health report (after orgInfo so metadata dimensions can be
      // included). It reads the trends just computed rather than the store,
      // which would re-read and re-parse the history once per limit.
      const healthReport = this.healthCalculator.calculate({
        limits,
        orgId: payload.orgId,
        trends,
        orgInfo,
      });
      const healthScore = healthReport.overallScore;

      // 5b. Compute org health status
      let orgHealthStatus: OrgHealthStatus | undefined;
      try {
        orgHealthStatus = await this.healthCheck.computeHealth(payload.orgId);
      } catch (healthErr) {
        this.deps.log(`[WARN] HealthCheck failed: ${String(healthErr)}`);
      }

      // 6. Send response
      if (this.pastDeadline(deadline, 'the monitor:data reply')) return;
      const response = buildResponse(this.deps, msg, 'monitor:data', {
        limits,
        jobs,
        jobsTruncated,
        healthScore,
        healthReport,
        trends,
        jobInsights,
        orgInfo,
        orgHealthStatus,
        lastUpdated: new Date().toISOString(),
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      // Past the bound the request already carries its monitor:error; a second
      // one would only be a duplicate on a closed correlation.
      if (this.pastDeadline(deadline, `the failure "${extractErrorMessage(err)}"`)) return;
      sendHandlerError(this.deps, 'monitor:refresh', 'monitor:error', msg, err);
    } finally {
      this.inFlightJobRecords.delete(payload.orgId);
    }
  }

  /**
   * The org info the dashboard shows and the health score's metadata dimension
   * reads, through the fetcher's 5-minute cache. A failure is logged and gives
   * `undefined`: org info never fails the reply that asked for it.
   *
   * @param orgId - Org whose info to fetch.
   * @param conn - Connection to that org.
   */
  private async fetchOrgInfo(
    orgId: string,
    conn: Connection,
  ): Promise<import('@sandforge/shared').OrgInfo | undefined> {
    try {
      const orgInfoConn: OrgInfoConnection = {
        latestApiVersion: async () => newestApiVersion(await conn.request('/services/data')),
        queryOrg: async () => {
          const org = this.deps.orgManager.getOrg(orgId);
          const orgRecords = await queryAll<{
            Name: string;
            Id: string;
            OrganizationType: string;
            InstanceName: string | null;
            NamespacePrefix: string | null;
            CreatedDate: string;
          }>(
            conn,
            `SELECT Name, Id, OrganizationType, InstanceName, NamespacePrefix, CreatedDate FROM Organization LIMIT 1`,
          );
          checkApiLimits(conn.limitInfo, 'monitor:refresh orgInfo');
          const rec = orgRecords[0];
          return {
            name: rec?.Name ?? org?.alias ?? '',
            orgId: rec?.Id ?? orgId,
            // The registry's type, the one every guard reads. An org it no
            // longer knows, disconnected while this refresh ran, is shown as
            // Production: an unknown type fails closed here as in the guards,
            // where it used to read as a sandbox.
            type: org?.orgType ?? 'Production',
            // The org's own answer first. The stored edition is whatever the
            // connection path wrote: SFDX imports used to write the org's name
            // there, and an org imported then keeps it.
            edition: rec?.OrganizationType ?? org?.metadata.edition ?? '',
            instanceName: rec?.InstanceName ?? '',
            namespacePrefix: rec?.NamespacePrefix,
            createdDate: rec?.CreatedDate,
          };
        },
        queryCount: async (soql: string) => {
          const result = await conn.query<{ expr0: number }>(soql);
          return result.totalSize;
        },
      };
      return await this.orgInfoFetcher.fetch(orgId, orgInfoConn);
    } catch (infoErr) {
      this.deps.log(`[WARN] OrgInfo fetch failed: ${String(infoErr)}`);
      return undefined;
    }
  }

  private handleLiveOperations(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const operations = this.liveOperationTracker?.getAll() ?? [];
    const response = buildResponse(this.deps, msg, 'monitor:live-operations:response', {
      operations,
    });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ${response.type} id=${response.id}`);
  }

  /**
   * Handle monitor:storage -- per-object record count breakdown: the twenty
   * objects holding the most records, the total over every object, and how
   * many objects that total covers.
   *
   * The counts come from the Record Count API, which answers for all of the
   * org's objects in one call. They used to be read from
   * `EntityDefinition.RecordCount`, a column EntityDefinition does not have:
   * run against real orgs, the query came back INVALID_FIELD on every one, and
   * the panel said "No object storage data available" about orgs holding
   * thousands of records.
   *
   * Those counts cover setup and log objects too, and on a real sandbox they
   * lead the list: ObjectPermissions, FieldPermissions, LoginHistory, the setup
   * audit trail — 134,000 records counted where the org used 6 MB of data
   * storage, about 3,000 records' worth. No API says which objects use data
   * storage, so the panel says what the list is instead of calling it storage.
   *
   * @param msg - The incoming storage request message.
   */
  private async handleStorage(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(monitorOrgPayloadSchema, msg, 'monitor:error', this.deps);
    if (!parsed) return;
    const payload = parsed;

    try {
      const conn = await getJsforceConnection(
        payload.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );

      const counted = await conn.request<{ sObjects?: Array<{ name: string; count: number }> }>(
        `/services/data/${SF_API_VERSION}/limits/recordCount`,
      );
      checkApiLimits(conn.limitInfo, 'monitor:storage recordCount');
      const holding = (counted.sObjects ?? [])
        .filter((o) => o.count > 0)
        .sort((a, b) => b.count - a.count);
      const top = holding.slice(0, STORAGE_LIST_BOUND);

      // The counts carry API names only; the panel shows labels. The names are
      // the org's own, filtered to API-name characters all the same.
      const names = top.map((o) => o.name).filter((name) => /^[A-Za-z][A-Za-z0-9_]*$/.test(name));
      const labels = new Map<string, string>();
      if (names.length > 0) {
        const labelRecords = await queryAll<{ QualifiedApiName: string; Label: string | null }>(
          conn,
          `SELECT QualifiedApiName, Label FROM EntityDefinition WHERE QualifiedApiName IN (${names
            .map((name) => `'${name}'`)
            .join(', ')})`,
        );
        checkApiLimits(conn.limitInfo, 'monitor:storage entityDefinition');
        for (const r of labelRecords) {
          if (r.Label) labels.set(r.QualifiedApiName, r.Label);
        }
      }

      const objects: StorageObjectEntry[] = top.map((o) => ({
        objectName: o.name,
        label: labels.get(o.name) ?? o.name,
        recordCount: o.count,
      }));

      // Every object counted, not only the twenty listed: the panel heads the
      // list with this as the org's total.
      const totalRecords = holding.reduce((sum, o) => sum + o.count, 0);

      const response = buildResponse(this.deps, msg, 'monitor:storage:response', {
        success: true,
        objects,
        totalRecords,
        // The list stops at its bound: the page says out of how many.
        objectCount: holding.length,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'monitor:storage', 'monitor:error', msg, err);
    }
  }

  /**
   * Handle monitor:deployments -- recent deployment history.
   * Queries DeployRequest for the {@link DEPLOYMENT_LIST_BOUND} most recent
   * deployments, and says when the list came back full.
   * @param msg - The incoming deployments request message.
   */
  private async handleDeployments(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(monitorOrgPayloadSchema, msg, 'monitor:error', this.deps);
    if (!parsed) return;
    const payload = parsed;

    try {
      const conn = await getJsforceConnection(
        payload.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );

      // DeployRequest lives in the Tooling API — the standard REST query
      // endpoint rejects it with "sObject type 'DeployRequest' is not
      // supported" on every org. The LIMIT keeps the read to one page; a page
      // that comes back full is a list that stops there, and the page says so.
      const deployResult = await conn.tooling.query<{
        Id: string;
        Status: string;
        StartDate: string;
        CompletedDate: string | null;
        CreatedBy: { Name: string } | null;
        NumberComponentsTotal: number;
        NumberComponentErrors: number;
      }>(
        `SELECT Id, Status, StartDate, CompletedDate, CreatedBy.Name, NumberComponentsTotal, NumberComponentErrors FROM DeployRequest ORDER BY StartDate DESC LIMIT ${DEPLOYMENT_LIST_BOUND}`,
      );
      const deployRecords = deployResult.records;
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
        truncated: deployRecords.length >= DEPLOYMENT_LIST_BOUND,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'monitor:deployments', 'monitor:error', msg, err);
    }
  }

  /**
   * Handle monitor:api-usage -- per-category API limit breakdown.
   * Reads the /limits endpoint and groups key categories.
   * @param msg - The incoming API usage request message.
   */
  private async handleApiUsage(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(monitorOrgPayloadSchema, msg, 'monitor:error', this.deps);
    if (!parsed) return;
    const payload = parsed;

    try {
      const conn = await getJsforceConnection(
        payload.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const limitsRaw = await this.getOrFetchLimits(payload.orgId, conn);
      checkApiLimits(conn.limitInfo, 'monitor:api-usage limits');

      // Named as `/limits` names them at the API version SandForge calls.
      // Three names here matched nothing any org returns, so the panel skipped
      // them without a word: the Bulk API batch limit (called
      // DailyBulkApiRequests before API 49.0), which every Bulk API load
      // counts against; DailySoqlQueries, which is not a limit; and
      // standard-volume platform events, filed under a name ending in Messages.
      const apiCategories = [
        'DailyApiRequests',
        'DailyBulkApiBatches',
        'DailyBulkV2QueryJobs',
        'DailyBulkV2QueryFileStorageMB',
        'DailyStreamingApiEvents',
        'DailyGenericStreamingApiEvents',
        'DailyDurableStreamingApiEvents',
        'DailyAsyncApexExecutions',
        'HourlyAsyncReportRuns',
        'HourlyTimeBasedWorkflow',
        'DailyWorkflowEmails',
        'MassEmail',
        'SingleEmail',
        'HourlyPublishedPlatformEvents',
        'DailyStandardVolumePlatformEvents',
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
      sendHandlerError(this.deps, 'monitor:api-usage', 'monitor:error', msg, err);
    }
  }

  /**
   * Handle monitor:open-apex-jobs -- open the org's Setup > Apex Jobs page.
   *
   * The action the Monitor band offers on a stalled job. SandForge aborts
   * nothing itself: `AsyncApexJob` is not updateable (describe), so an update
   * of its Status fails on every attempt, and the documented abort is Apex
   * executed in the user's org (Salesforce help 000385103). The page opened
   * here is where an abort works, by the user's own hand.
   *
   * The webview names an org and nothing else: the schema refuses any other
   * key, so no address ever comes from the page. It is built here from the
   * org's stored instance URL, behind the HTTPS gate `sandforge.openOrgInBrowser`
   * uses. Refusals leave on `monitor:error`; the response carries what the
   * browser did.
   *
   * @param msg - The incoming open-apex-jobs request message.
   */
  private async handleOpenApexJobs(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = validatePayload(
      monitorOpenApexJobsPayloadSchema,
      msg,
      'monitor:error',
      this.deps,
    );
    if (!payload) return;

    const org = this.deps.orgManager.getOrg(payload.orgId);
    if (!org) {
      sendHandlerError(
        this.deps,
        'monitor:open-apex-jobs',
        'monitor:error',
        msg,
        new Error(`No registered org has the id "${payload.orgId}".`),
        { code: 'ORG_NOT_FOUND' },
      );
      return;
    }

    const target = apexJobsSetupUrl(org.instanceUrl);
    if (!target.ok) {
      const why =
        target.reason === 'not-https'
          ? `its instance URL must use HTTPS, got "${target.protocol}"`
          : 'its instance URL is not a valid URL';
      sendHandlerError(
        this.deps,
        'monitor:open-apex-jobs',
        'monitor:error',
        msg,
        new Error(`Cannot open Apex Jobs for "${org.alias}": ${why}.`),
        { code: 'INVALID_INSTANCE_URL' },
      );
      return;
    }

    try {
      const outcome: MonitorOpenApexJobsResponse['payload'] = await this.externalBrowser.open(
        target.url,
      );
      const response = buildResponse(this.deps, msg, 'monitor:open-apex-jobs:response', outcome);
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id} status=${outcome.status}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'monitor:open-apex-jobs', 'monitor:error', msg, err);
    }
  }

  /**
   * Handle monitor:error-logs -- fetch recent error log entries.
   * @param msg - The incoming error-logs request message.
   */
  private async handleErrorLogs(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(monitorOrgPayloadSchema, msg, 'monitor:error', this.deps);
    if (!parsed) return;
    const payload = parsed;

    try {
      const errors = await this.errorLogMonitor.fetch(payload.orgId);
      const errorsByTypeMap = this.errorLogMonitor.getErrorsByType(payload.orgId);
      const errorsByType = [...errorsByTypeMap.entries()].map(([type, count]) => ({ type, count }));

      const response = buildResponse(this.deps, msg, 'monitor:error-logs:response', {
        success: true,
        errors,
        errorsByType,
        totalCount: errors.length,
        truncated: this.errorLogMonitor.isTruncated(payload.orgId),
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'monitor:error-logs', 'monitor:error', msg, err);
    }
  }

  /**
   * Handle monitor:sessions -- fetch active user sessions.
   * @param msg - The incoming sessions request message.
   */
  private async handleSessions(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(monitorOrgPayloadSchema, msg, 'monitor:error', this.deps);
    if (!parsed) return;
    const payload = parsed;

    try {
      const sessions = await this.userSessionMonitor.fetch(payload.orgId);
      const activeUserCount = this.userSessionMonitor.getActiveUserCount(payload.orgId);

      const response = buildResponse(this.deps, msg, 'monitor:sessions:response', {
        success: true,
        sessions,
        activeUserCount,
        truncated: this.userSessionMonitor.isTruncated(payload.orgId),
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'monitor:sessions', 'monitor:error', msg, err);
    }
  }

  /**
   * Handle monitor:apex-insights -- fetch and analyze Apex logs.
   * @param msg - The incoming apex-insights request message.
   */
  private async handleApexInsights(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(monitorOrgPayloadSchema, msg, 'monitor:error', this.deps);
    if (!parsed) return;
    const payload = parsed;

    try {
      const analyses = await this.apexLogAnalyzer.fetchAndAnalyze(payload.orgId, APEX_LOG_SAMPLE);
      const topIssues = this.apexLogAnalyzer.getTopIssues(payload.orgId);

      const response = buildResponse(this.deps, msg, 'monitor:apex-insights:response', {
        success: true,
        analyses,
        topIssues,
        truncated: this.apexLogAnalyzer.isTruncated(payload.orgId),
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'monitor:apex-insights', 'monitor:error', msg, err);
    }
  }

  /**
   * Ask a registered sandbox which org it is, so the panel shows a refresh
   * the moment it opens rather than after the next identity check.
   *
   * A sandbox cannot list its own refreshes, but its Organization row names
   * the org it now is. A failure here is logged: it must not cost the panel
   * the answers it can give.
   *
   * @param orgId - The registered org the panel shows.
   */
  private async checkSandboxIdentity(orgId: string): Promise<void> {
    const detector = this.deps.sandboxRefreshes;
    if (!detector || this.deps.orgManager.getOrg(orgId)?.orgType !== 'Sandbox') return;
    try {
      const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
      const [row] = await queryAll<{ Id: string; InstanceName: string | null }>(
        conn,
        'SELECT Id, InstanceName FROM Organization',
      );
      checkApiLimits(conn.limitInfo, 'monitor:sandbox-refresh organization');
      if (row) {
        detector.observe(
          orgId,
          { organizationId: row.Id, instanceName: row.InstanceName ?? undefined },
          'monitor',
        );
      }
    } catch (err: unknown) {
      this.deps.log(`[WARN] monitor:sandbox-refresh identity check: ${extractErrorMessage(err)}`);
    }
  }

  /**
   * Handle monitor:sandbox-refresh -- fetch sandbox refresh events.
   * @param msg - The incoming sandbox-refresh request message.
   */
  private async handleSandboxRefresh(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(monitorOrgPayloadSchema, msg, 'monitor:error', this.deps);
    if (!parsed) return;
    const payload = parsed;

    try {
      await this.checkSandboxIdentity(payload.orgId);
      const refreshes = await this.sandboxRefreshTracker.fetch(payload.orgId);
      const inProgress = this.sandboxRefreshTracker.isRefreshInProgress(payload.orgId);

      const response = buildResponse(this.deps, msg, 'monitor:sandbox-refresh:response', {
        success: true,
        // A sandbox org cannot query SandboxProcess at all. Without this the
        // panel showed its "no refresh events" empty state, which reads as an
        // answer rather than as a question the org cannot be asked.
        supported: this.sandboxRefreshTracker.isSupported(payload.orgId),
        refreshes,
        inProgress,
        truncated: this.sandboxRefreshTracker.isTruncated(payload.orgId),
        // What the sandbox itself revealed: the org it answers as changed.
        detected: this.deps.sandboxRefreshes?.refreshesOf(payload.orgId) ?? [],
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'monitor:sandbox-refresh', 'monitor:error', msg, err);
    }
  }

  /**
   * Handle monitor:alerts -- return active alerts and history.
   * @param msg - The incoming alerts request message.
   */
  private handleAlerts(msg: InboundRequest): void {
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
  private handleAlertAcknowledge(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(monitorAlertIdPayloadSchema, msg, 'monitor:error', this.deps);
    if (!parsed) return;
    const payload = parsed;
    this.alertEngine.acknowledgeAlert(payload.alertId);
    this.alertStateStore.saveAlerts(this.alertEngine.getActiveAlerts());
    const response = buildResponse(this.deps, msg, 'monitor:alert:acknowledge:response', {
      success: true,
    });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ${response.type} id=${response.id}`);
  }

  /**
   * Handle monitor:alert:dismiss -- dismiss an active alert.
   * @param msg - The incoming dismiss request message.
   */
  private handleAlertDismiss(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(monitorAlertIdPayloadSchema, msg, 'monitor:error', this.deps);
    if (!parsed) return;
    const payload = parsed;
    this.alertEngine.dismissAlert(payload.alertId);
    this.alertStateStore.saveAlerts(this.alertEngine.getActiveAlerts());
    const response = buildResponse(this.deps, msg, 'monitor:alert:dismiss:response', {
      success: true,
    });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ${response.type} id=${response.id}`);
  }
}
