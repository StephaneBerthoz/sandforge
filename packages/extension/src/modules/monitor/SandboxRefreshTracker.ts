/** Information about a sandbox refresh event */
export interface SandboxRefreshEvent {
  orgId: string;
  sandboxName: string;
  refreshDate: string;
  status: 'Pending' | 'Processing' | 'Completed' | 'Failed';
  sourceOrg?: string;
}

/**
 * What one read of an org's refresh history returned.
 *
 * `supported: false` is not the same answer as an empty list: SandboxProcess
 * only exists on an org that manages sandboxes, and a sandbox org used to get
 * the same `[]` as a dev hub with no refresh on record — the panel then said
 * "no sandbox refresh events" about a query the org cannot answer at all.
 */
export interface SandboxRefreshFetch {
  supported: boolean;
  events: SandboxRefreshEvent[];
}

/** Function signature for querying sandbox refresh status */
export type QuerySandboxesFn = (orgId: string) => Promise<SandboxRefreshFetch>;

/** Callback invoked when a new refresh event is detected */
export type RefreshDetectedFn = (event: SandboxRefreshEvent) => void;

const IN_PROGRESS_STATUSES = new Set<SandboxRefreshEvent['status']>(['Pending', 'Processing']);

/**
 * Tracks sandbox refresh events in Salesforce.
 * Detects new refresh operations and notifies via callback when
 * a previously unseen refresh is found. Useful for triggering
 * post-refresh data seeding pipelines.
 */
export class SandboxRefreshTracker {
  private readonly querySandboxes: QuerySandboxesFn;
  private readonly onRefreshDetected: RefreshDetectedFn | undefined;
  private readonly refreshCache: Map<string, SandboxRefreshEvent[]> = new Map();
  private readonly supportedCache: Map<string, boolean> = new Map();
  private readonly knownRefreshIds: Set<string> = new Set();

  constructor(querySandboxes: QuerySandboxesFn, onRefreshDetected?: RefreshDetectedFn) {
    this.querySandboxes = querySandboxes;
    this.onRefreshDetected = onRefreshDetected;
  }

  /** Fetch sandbox refresh events and detect new ones */
  async fetch(orgId: string): Promise<SandboxRefreshEvent[]> {
    const { supported, events } = await this.querySandboxes(orgId);
    this.refreshCache.set(orgId, events);
    this.supportedCache.set(orgId, supported);

    for (const event of events) {
      const key = `${event.orgId}:${event.sandboxName}:${event.refreshDate}`;
      if (!this.knownRefreshIds.has(key)) {
        this.knownRefreshIds.add(key);
        if (this.onRefreshDetected) {
          this.onRefreshDetected(event);
        }
      }
    }

    return events;
  }

  /**
   * Whether the last read of this org could ask for its refresh history.
   *
   * Optimistic before the first read: nothing has been refused yet.
   */
  isSupported(orgId: string): boolean {
    return this.supportedCache.get(orgId) ?? true;
  }

  /** Return cached refresh events for an org */
  getRecentRefreshes(orgId: string): SandboxRefreshEvent[] {
    return this.refreshCache.get(orgId) ?? [];
  }

  /** Check if any sandbox refresh is currently in progress */
  isRefreshInProgress(orgId: string): boolean {
    const events = this.refreshCache.get(orgId) ?? [];
    return events.some((e) => IN_PROGRESS_STATUSES.has(e.status));
  }
}
