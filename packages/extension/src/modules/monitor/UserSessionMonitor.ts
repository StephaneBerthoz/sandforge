/** Information about an active Salesforce user session */
export interface UserSessionInfo {
  userId: string;
  username: string;
  sessionType: string;
  loginTime: string;
  sourceIp: string;
}

/** Function signature for querying active user sessions */
export type QuerySessionsFn = (
  orgId: string
) => Promise<UserSessionInfo[]>;

/**
 * Tracks active Salesforce user sessions.
 * Fetches session data and provides counts of active users.
 */
export class UserSessionMonitor {
  private readonly querySessions: QuerySessionsFn;
  private readonly sessionCache: Map<string, UserSessionInfo[]> = new Map();

  constructor(querySessions: QuerySessionsFn) {
    this.querySessions = querySessions;
  }

  /** Fetch active user sessions from Salesforce */
  async fetch(orgId: string): Promise<UserSessionInfo[]> {
    const sessions = await this.querySessions(orgId);
    this.sessionCache.set(orgId, sessions);
    return sessions;
  }

  /** Return the cached active sessions for an org */
  getActiveSessions(orgId: string): UserSessionInfo[] {
    return this.sessionCache.get(orgId) ?? [];
  }

  /** Return the number of distinct active users in the org */
  getActiveUserCount(orgId: string): number {
    const sessions = this.getActiveSessions(orgId);
    const uniqueUsers = new Set(sessions.map((s) => s.userId));
    return uniqueUsers.size;
  }
}
