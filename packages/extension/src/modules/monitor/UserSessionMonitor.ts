import type { BoundedRecords } from '../../core/common/soqlQueryHelper.js';

/** Information about an active Salesforce user session */
export interface UserSessionInfo {
  /** AuthSession row id: one user can hold several sessions at once. */
  sessionId: string;
  userId: string;
  username: string;
  sessionType: string;
  loginTime: string;
  sourceIp: string;
}

/**
 * Function signature for querying active user sessions: the newest first, and
 * whether the read stopped at its bound.
 */
export type QuerySessionsFn = (orgId: string) => Promise<BoundedRecords<UserSessionInfo>>;

/**
 * Tracks active Salesforce user sessions.
 * Fetches session data and provides counts of active users.
 */
export class UserSessionMonitor {
  private readonly querySessions: QuerySessionsFn;
  private readonly sessionCache: Map<string, UserSessionInfo[]> = new Map();
  private readonly truncatedCache: Map<string, boolean> = new Map();

  constructor(querySessions: QuerySessionsFn) {
    this.querySessions = querySessions;
  }

  /** Fetch active user sessions from Salesforce */
  async fetch(orgId: string): Promise<UserSessionInfo[]> {
    const { records, truncated } = await this.querySessions(orgId);
    this.sessionCache.set(orgId, records);
    this.truncatedCache.set(orgId, truncated);
    return records;
  }

  /** Return the cached active sessions for an org */
  getActiveSessions(orgId: string): UserSessionInfo[] {
    return this.sessionCache.get(orgId) ?? [];
  }

  /**
   * Whether the last read of this org stopped at its bound: the org then holds
   * more sessions than the cache, and {@link getActiveUserCount} counts the
   * users of the cached ones only.
   */
  isTruncated(orgId: string): boolean {
    return this.truncatedCache.get(orgId) ?? false;
  }

  /** Return the number of distinct users among the cached sessions of an org */
  getActiveUserCount(orgId: string): number {
    const sessions = this.getActiveSessions(orgId);
    const uniqueUsers = new Set(sessions.map((s) => s.userId));
    return uniqueUsers.size;
  }
}
