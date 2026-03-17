/** Status of a token refresh schedule */
export type RefreshStatus = 'scheduled' | 'refreshing' | 'completed' | 'failed' | 'cancelled' | 'expired';

/** Token refresh information for an org */
export interface TokenRefreshInfo {
  orgId: string;
  status: RefreshStatus;
  expiresAt: Date;
  scheduledRefreshAt: Date;
  lastRefreshAt?: string;
  consecutiveFailures: number;
  timeRemainingMs?: number;
}

/** Function that performs the actual token refresh */
export type TokenRefreshExecutor = (orgId: string) => Promise<{
  accessToken: string;
  expiresAt: Date;
}>;

/** Event types emitted by TokenRefresher */
export type TokenEventType = 'token:refreshed' | 'token:expired' | 'token:failed' | 'token:circuitOpen';

/** Token refresh event */
export interface TokenEvent {
  type: TokenEventType;
  orgId: string;
  info: TokenRefreshInfo;
}

/** Listener for token events */
export type TokenEventListener = (event: TokenEvent) => void;

/** Callback invoked when circuit breaker trips for an org */
export type DisconnectHandler = (orgId: string) => void;

/**
 * Automatically refreshes authentication tokens before they expire.
 * Schedules refresh 5 minutes before expiration by default.
 * Includes circuit breaker: after 3 consecutive failures, disconnects the org.
 * Emits events for monitoring in the Monitor dashboard.
 */
export class TokenRefresher {
  private static readonly DEFAULT_BUFFER_MS = 5 * 60 * 1000;
  private static readonly MAX_CONSECUTIVE_FAILURES = 3;

  private schedules: Map<string, TokenRefreshInfo> = new Map();
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private executor: TokenRefreshExecutor | undefined;
  private disconnectHandler: DisconnectHandler | undefined;
  private readonly listeners: Set<TokenEventListener> = new Set();
  private readonly bufferMs: number;
  private readonly maxFailures: number;

  constructor(bufferMs: number = TokenRefresher.DEFAULT_BUFFER_MS, maxFailures: number = TokenRefresher.MAX_CONSECUTIVE_FAILURES) {
    this.bufferMs = bufferMs;
    this.maxFailures = maxFailures;
  }

  /** Set the token refresh executor */
  setExecutor(executor: TokenRefreshExecutor): void {
    this.executor = executor;
  }

  /** Set the handler called when circuit breaker trips (org disconnect) */
  setDisconnectHandler(handler: DisconnectHandler): void {
    this.disconnectHandler = handler;
  }

  /** Schedule a token refresh before the given expiration time */
  scheduleRefresh(orgId: string, expiresAt: Date): void {
    this.cancelRefresh(orgId);

    const now = Date.now();
    const refreshAt = new Date(expiresAt.getTime() - this.bufferMs);
    const delay = Math.max(0, refreshAt.getTime() - now);

    const info: TokenRefreshInfo = {
      orgId,
      status: 'scheduled',
      expiresAt,
      scheduledRefreshAt: refreshAt,
      consecutiveFailures: 0,
      timeRemainingMs: expiresAt.getTime() - now,
    };

    this.schedules.set(orgId, info);

    const timer = setTimeout(() => {
      void this.performRefresh(orgId);
    }, delay);

    this.timers.set(orgId, timer);
  }

  /** Cancel a scheduled refresh for an org */
  cancelRefresh(orgId: string): void {
    const timer = this.timers.get(orgId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(orgId);
    }

    const info = this.schedules.get(orgId);
    if (info && info.status === 'scheduled') {
      info.status = 'cancelled';
    }
  }

  /** Force an immediate token refresh for an org */
  async refreshNow(orgId: string): Promise<boolean> {
    return this.performRefresh(orgId);
  }

  /** Get the refresh info for an org */
  getRefreshInfo(orgId: string): TokenRefreshInfo | undefined {
    const info = this.schedules.get(orgId);
    if (info) {
      info.timeRemainingMs = Math.max(0, info.expiresAt.getTime() - Date.now());
    }
    return info;
  }

  /** Check if a refresh is scheduled for an org */
  isScheduled(orgId: string): boolean {
    const info = this.schedules.get(orgId);
    return info?.status === 'scheduled';
  }

  /** Get all scheduled refresh info */
  getAllSchedules(): TokenRefreshInfo[] {
    return Array.from(this.schedules.values());
  }

  /** Get a summary of token health for the Monitor dashboard */
  getHealthSummary(): Array<{
    orgId: string;
    status: RefreshStatus;
    timeRemainingMs: number;
    lastRefreshAt?: string;
    consecutiveFailures: number;
  }> {
    return Array.from(this.schedules.values()).map((info) => ({
      orgId: info.orgId,
      status: info.status,
      timeRemainingMs: Math.max(0, info.expiresAt.getTime() - Date.now()),
      lastRefreshAt: info.lastRefreshAt,
      consecutiveFailures: info.consecutiveFailures,
    }));
  }

  /** Register an event listener */
  onEvent(listener: TokenEventListener): void {
    this.listeners.add(listener);
  }

  /** Remove an event listener */
  offEvent(listener: TokenEventListener): void {
    this.listeners.delete(listener);
  }

  /** Dispose all timers and clean up */
  dispose(): void {
    for (const [orgId] of this.timers) {
      this.cancelRefresh(orgId);
    }
    this.schedules.clear();
    this.timers.clear();
    this.listeners.clear();
  }

  /** Perform the actual token refresh */
  private async performRefresh(orgId: string): Promise<boolean> {
    const info = this.schedules.get(orgId);

    if (!this.executor) {
      if (info) {
        info.status = 'failed';
      }
      return false;
    }

    if (info) {
      info.status = 'refreshing';
    }

    try {
      const result = await this.executor(orgId);

      if (info) {
        info.status = 'completed';
        info.lastRefreshAt = new Date().toISOString();
        info.consecutiveFailures = 0;
      }

      this.emit({ type: 'token:refreshed', orgId, info: info ?? this.createDefaultInfo(orgId) });

      // Schedule the next refresh based on the new expiration
      this.scheduleRefresh(orgId, result.expiresAt);

      return true;
    } catch {
      if (info) {
        info.status = 'failed';
        info.consecutiveFailures++;
        info.lastRefreshAt = new Date().toISOString();
      }

      const failCount = info?.consecutiveFailures ?? 1;

      this.emit({ type: 'token:failed', orgId, info: info ?? this.createDefaultInfo(orgId) });

      // Circuit breaker: disconnect after maxFailures consecutive failures
      if (failCount >= this.maxFailures) {
        if (info) {
          info.status = 'expired';
        }
        this.emit({ type: 'token:expired', orgId, info: info ?? this.createDefaultInfo(orgId) });
        this.emit({ type: 'token:circuitOpen', orgId, info: info ?? this.createDefaultInfo(orgId) });

        if (this.disconnectHandler) {
          this.disconnectHandler(orgId);
        }

        // Cancel any future refresh attempts
        this.cancelRefresh(orgId);
      }

      return false;
    }
  }

  private createDefaultInfo(orgId: string): TokenRefreshInfo {
    return {
      orgId,
      status: 'failed',
      expiresAt: new Date(),
      scheduledRefreshAt: new Date(),
      consecutiveFailures: 0,
    };
  }

  private emit(event: TokenEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
