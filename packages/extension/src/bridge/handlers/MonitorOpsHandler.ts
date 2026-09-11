import type {
  JobInsight,
  TrendData,
  StorageObjectEntry,
  DeploymentEntry,
  ApiUsageCategory,
  OrgHealthStatus,
} from '@sandforge/shared';
import { MONITOR_KEY_LIMITS, DEFAULT_SOQL_LIMITS, SF_LIMITS } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler, InboundRequest } from './HandlerTypes.js';
import { buildResponse, sendHandlerError, sendNotification } from './HandlerTypes.js';
import {
  validatePayload,
  monitorOrgPayloadSchema,
  monitorAbortJobPayloadSchema,
  monitorAlertIdPayloadSchema,
} from '../validatePayload.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { queryAll } from '../../core/common/soqlQueryHelper.js';
import { UnifiedHealthScorer } from '../../modules/monitor/UnifiedHealthScorer.js';
import type { TrendStorage } from '../../modules/monitor/TrendStorage.js';
import { OrgInfoFetcher } from '../../modules/monitor/OrgInfoFetcher.js';
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
 * the PERF-07 tests go red if the two drift apart.
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
 *   away for a weekly job. Excluding it is the side that cannot put an Abort
 *   on a healthy schedule.
 * - BatchApexWorker: rows under a BatchApex parent, which carries the
 *   counters; an abort pointed at a worker would target the wrong row.
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
 * window is set generously rather than tightly, and even past it the abort
 * stays behind a typed confirmation that restates this evidence.
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
 * - `stuck` (critical, one insight per job, the only tier the page offers an
 *   abort on): a job in Processing, with batches left to run, whose batch
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
  'monitor:start',
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

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {
    const ops = createMonitorOps({
      configStore: deps.configStore,
      log: (message) => deps.log(message),
      notify: (level, message) => sendNotification(deps, level, 'Alert', message),
      getConnection: async (orgId) =>
        this.withSharedJobQuery(
          orgId,
          await getJsforceConnection(orgId, deps.orgRegistry, deps.orgManager),
        ),
    });
    this.trendStorage = ops.trendStorage;
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
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: InboundRequest): Promise<boolean> {
    if (!MONITOR_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'monitor:refresh':
      case 'monitor:start':
        await this.handleRefresh(msg);
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

      // 2. Get async jobs — published for the rest of this refresh so the
      // health check's jobs signal reads them instead of re-querying the org.
      const jobRecords = await queryAll<AsyncApexJobRecord>(conn, ASYNC_APEX_JOB_SOQL);
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
              instanceName: ((id as Record<string, unknown>).instance_name as string) ?? '',
              apiVersion: conn.version ?? SF_LIMITS.DEFAULT_API_VERSION,
              lastLoginDate:
                ((id as Record<string, unknown>).last_login_date as string) ??
                new Date().toISOString(),
            };
          },
          queryOrg: async () => {
            const org = this.deps.orgManager.getOrg(payload.orgId);
            const orgRecords = await queryAll<{
              Name: string;
              Id: string;
              OrganizationType: string;
              NamespacePrefix: string | null;
              CreatedDate: string;
            }>(
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
      if (this.pastDeadline(deadline, 'the monitor:data reply')) return;
      const response = buildResponse(this.deps, msg, 'monitor:data', {
        limits,
        jobs,
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
   * Handle monitor:health-score -- compute full org health score breakdown.
   * @param msg - The incoming health-score request message.
   */
  private async handleHealthScore(msg: InboundRequest): Promise<void> {
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
      sendHandlerError(this.deps, 'monitor:health-score', 'monitor:error', msg, err);
    }
  }

  /**
   * Handle monitor:storage -- per-object record count breakdown.
   * Queries EntityDefinition for top 20 objects by QualifiedApiName.
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

      const entityRecords = await queryAll<{
        QualifiedApiName: string;
        Label: string;
        RecordCount: number | null;
      }>(
        conn,
        // No COALESCE(): SOQL only supports it on recent API versions and the
        // query must parse on every org; null RecordCount is coalesced below.
        `SELECT QualifiedApiName, Label, RecordCount FROM EntityDefinition WHERE RecordCount > 0 ORDER BY RecordCount DESC LIMIT 20`,
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
      sendHandlerError(this.deps, 'monitor:storage', 'monitor:error', msg, err);
    }
  }

  /**
   * Handle monitor:deployments -- recent deployment history.
   * Queries DeployRequest for the 20 most recent deployments.
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
      // supported" on every org. LIMIT 20: no pagination needed.
      const deployResult = await conn.tooling.query<{
        Id: string;
        Status: string;
        StartDate: string;
        CompletedDate: string | null;
        CreatedBy: { Name: string } | null;
        NumberComponentsTotal: number;
        NumberComponentErrors: number;
      }>(
        `SELECT Id, Status, StartDate, CompletedDate, CreatedBy.Name, NumberComponentsTotal, NumberComponentErrors FROM DeployRequest ORDER BY StartDate DESC LIMIT 20`,
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

      const apiCategories = [
        'DailyApiRequests',
        'DailyBulkApiRequests',
        'DailyBulkV2QueryJobs',
        'DailyBulkV2QueryFileStorageMB',
        'DailyStreamingApiEvents',
        'DailyGenericStreamingApiEvents',
        'DailyDurableStreamingApiEvents',
        'DailyAsyncApexExecutions',
        'HourlyAsyncReportRuns',
        'HourlyTimeBasedWorkflow',
        'DailySoqlQueries',
        'DailyWorkflowEmails',
        'MassEmail',
        'SingleEmail',
        'HourlyPublishedPlatformEvents',
        'DailyStandardVolumePlatformMessages',
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

  private async handleAbortJob(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(monitorAbortJobPayloadSchema, msg, 'monitor:error', this.deps);
    if (!parsed) return;
    const payload = parsed;

    try {
      const conn = await getJsforceConnection(
        payload.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      await conn.sobject('AsyncApexJob').update({ Id: payload.jobId, Status: 'Aborted' } as Record<
        string,
        unknown
      > & {
        Id: string;
      });

      const response = buildResponse(this.deps, msg, 'monitor:abort-job:response', {
        jobId: payload.jobId,
        success: true,
        message: 'Job abort requested.',
      });
      this.deps.broker.postToWebview(response);
      sendNotification(this.deps, 'success', 'Monitor', `Job ${payload.jobId} abort requested.`);
    } catch (err: unknown) {
      const message = extractErrorMessage(err);
      this.deps.log(`[ERR] monitor:abort-job: ${message}`);
      const response = buildResponse(this.deps, msg, 'monitor:abort-job:response', {
        jobId: payload.jobId,
        success: false,
        message,
      });
      this.deps.broker.postToWebview(response);
      sendNotification(this.deps, 'error', 'Monitor', `Failed to abort job: ${message}`);
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
      sendHandlerError(this.deps, 'monitor:apex-insights', 'monitor:error', msg, err);
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
