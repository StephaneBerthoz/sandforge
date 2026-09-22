/** A single error entry from Salesforce logs */
export interface ErrorLogEntry {
  id: string;
  errorType: string;
  message: string;
  stackTrace?: string;
  timestamp: string;
  user?: string;
  context?: string;
}

/** Function signature for querying Salesforce error logs */
export type QueryErrorsFn = (orgId: string, since: string) => Promise<ErrorLogEntry[]>;

/**
 * Tracks recent errors from Salesforce debug/error logs.
 * Fetches error entries since a given timestamp and provides
 * grouping and counting utilities.
 */
export class ErrorLogMonitor {
  private readonly queryErrors: QueryErrorsFn;
  private readonly errorCache: Map<string, ErrorLogEntry[]> = new Map();

  constructor(queryErrors: QueryErrorsFn) {
    this.queryErrors = queryErrors;
  }

  /**
   * Fetch the error log entries of the last 24 hours from Salesforce.
   *
   * The whole window, every time. Each fetch used to start at the last entry
   * of the previous one; the query returns them newest first, which made that
   * the oldest, and `StartTime >` left it out. Every load of the panel listed
   * one error fewer than the one before, down to "No recent errors detected",
   * then started over.
   */
  async fetch(orgId: string): Promise<ErrorLogEntry[]> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const errors = await this.queryErrors(orgId, since);
    this.errorCache.set(orgId, errors);
    return errors;
  }

  /** Return the cached error entries for an org */
  getRecentErrors(orgId: string): ErrorLogEntry[] {
    return this.errorCache.get(orgId) ?? [];
  }

  /** Group cached errors by their error type and count occurrences */
  getErrorsByType(orgId: string): Map<string, number> {
    const errors = this.getRecentErrors(orgId);
    const grouped = new Map<string, number>();
    for (const error of errors) {
      const count = grouped.get(error.errorType) ?? 0;
      grouped.set(error.errorType, count + 1);
    }
    return grouped;
  }
}
