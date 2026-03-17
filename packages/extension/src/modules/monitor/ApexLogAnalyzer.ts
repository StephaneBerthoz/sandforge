import type { ApexLogEntry } from '@sandforge/shared';

/** Result of analyzing a single Apex log entry */
export interface ApexLogAnalysis {
  logId: string;
  totalDuration: number;
  soqlQueries: number;
  dmlStatements: number;
  heapUsed: number;
  cpuTime: number;
  issues: ApexLogIssue[];
}

/** A detected issue within an Apex log */
export interface ApexLogIssue {
  type:
    | 'soql_in_loop'
    | 'excessive_dml'
    | 'large_heap'
    | 'slow_query'
    | 'governor_warning';
  severity: 'info' | 'warning' | 'critical';
  message: string;
  line?: number;
}

/** Function signature for fetching Apex log entries */
export type FetchLogsFn = (
  orgId: string,
  count: number
) => Promise<ApexLogEntry[]>;

/** Governor limit thresholds for issue detection */
const SOQL_QUERY_LIMIT = 100;
const DML_LIMIT = 150;
const HEAP_LIMIT = 6_000_000;
const SLOW_QUERY_THRESHOLD_MS = 5000;
const SOQL_WARNING_RATIO = 0.8;
const DML_WARNING_RATIO = 0.6;
const HEAP_WARNING_RATIO = 0.7;

/**
 * Analyzes Apex debug logs for performance patterns and governor limit issues.
 * Uses heuristics on log metadata to detect common anti-patterns.
 */
export class ApexLogAnalyzer {
  private readonly fetchLogs: FetchLogsFn;
  private readonly analyses: Map<string, ApexLogAnalysis[]> = new Map();

  constructor(fetchLogs: FetchLogsFn) {
    this.fetchLogs = fetchLogs;
  }

  /** Analyze a single Apex log entry and detect issues */
  analyze(log: ApexLogEntry): ApexLogAnalysis {
    const soqlQueries = estimateSoqlQueries(log);
    const dmlStatements = estimateDmlStatements(log);
    const heapUsed = estimateHeapUsage(log);
    const cpuTime = log.durationMs;

    const issues = detectIssues(soqlQueries, dmlStatements, heapUsed, cpuTime);

    return {
      logId: log.id,
      totalDuration: log.durationMs,
      soqlQueries,
      dmlStatements,
      heapUsed,
      cpuTime,
      issues,
    };
  }

  /** Fetch logs for an org, analyze them, and cache the results */
  async fetchAndAnalyze(orgId: string, count: number = 10): Promise<ApexLogAnalysis[]> {
    const logs = await this.fetchLogs(orgId, count);
    const results = logs.map((log) => this.analyze(log));
    this.analyses.set(orgId, results);
    return results;
  }

  /** Return the cached analysis results for an org */
  getRecentAnalyses(orgId: string): ApexLogAnalysis[] {
    return this.analyses.get(orgId) ?? [];
  }

  /** Return the most frequent issues across all cached analyses for an org */
  getTopIssues(orgId: string): ApexLogIssue[] {
    const analyses = this.analyses.get(orgId) ?? [];
    const issueCounts = new Map<string, { issue: ApexLogIssue; count: number }>();

    for (const analysis of analyses) {
      for (const issue of analysis.issues) {
        const key = `${issue.type}:${issue.message}`;
        const entry = issueCounts.get(key);
        if (entry) {
          entry.count++;
        } else {
          issueCounts.set(key, { issue, count: 1 });
        }
      }
    }

    return [...issueCounts.values()]
      .sort((a, b) => b.count - a.count)
      .map((entry) => entry.issue);
  }
}

/**
 * Estimate SOQL query count from log metadata.
 * Uses log size as a heuristic proxy.
 */
function estimateSoqlQueries(log: ApexLogEntry): number {
  return Math.min(Math.floor(log.logSize / 500), SOQL_QUERY_LIMIT);
}

/**
 * Estimate DML statement count from log metadata.
 * Uses log size as a heuristic proxy.
 */
function estimateDmlStatements(log: ApexLogEntry): number {
  return Math.min(Math.floor(log.logSize / 1000), DML_LIMIT);
}

/**
 * Estimate heap usage from log metadata.
 * Uses log size as a heuristic proxy.
 */
function estimateHeapUsage(log: ApexLogEntry): number {
  return Math.min(log.logSize * 10, HEAP_LIMIT);
}

/** Detect issues based on estimated governor limit metrics */
function detectIssues(
  soqlQueries: number,
  dmlStatements: number,
  heapUsed: number,
  cpuTime: number
): ApexLogIssue[] {
  const issues: ApexLogIssue[] = [];

  if (soqlQueries >= SOQL_QUERY_LIMIT) {
    issues.push({
      type: 'soql_in_loop',
      severity: 'critical',
      message: `SOQL query limit reached: ${soqlQueries}/${SOQL_QUERY_LIMIT}`,
    });
  } else if (soqlQueries >= SOQL_QUERY_LIMIT * SOQL_WARNING_RATIO) {
    issues.push({
      type: 'governor_warning',
      severity: 'warning',
      message: `Approaching SOQL query limit: ${soqlQueries}/${SOQL_QUERY_LIMIT}`,
    });
  }

  if (dmlStatements >= DML_LIMIT) {
    issues.push({
      type: 'excessive_dml',
      severity: 'critical',
      message: `DML statement limit reached: ${dmlStatements}/${DML_LIMIT}`,
    });
  } else if (dmlStatements >= DML_LIMIT * DML_WARNING_RATIO) {
    issues.push({
      type: 'governor_warning',
      severity: 'warning',
      message: `Approaching DML statement limit: ${dmlStatements}/${DML_LIMIT}`,
    });
  }

  if (heapUsed >= HEAP_LIMIT) {
    issues.push({
      type: 'large_heap',
      severity: 'critical',
      message: `Heap size limit reached: ${heapUsed}/${HEAP_LIMIT}`,
    });
  } else if (heapUsed >= HEAP_LIMIT * HEAP_WARNING_RATIO) {
    issues.push({
      type: 'large_heap',
      severity: 'warning',
      message: `Approaching heap size limit: ${heapUsed}/${HEAP_LIMIT}`,
    });
  }

  if (cpuTime > SLOW_QUERY_THRESHOLD_MS) {
    issues.push({
      type: 'slow_query',
      severity: 'warning',
      message: `Slow execution: ${cpuTime}ms exceeds ${SLOW_QUERY_THRESHOLD_MS}ms threshold`,
    });
  }

  return issues;
}
