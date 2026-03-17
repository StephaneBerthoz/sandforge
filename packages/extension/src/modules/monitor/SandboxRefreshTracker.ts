/** Information about a sandbox refresh event */
export interface SandboxRefreshEvent {
  orgId: string;
  sandboxName: string;
  refreshDate: string;
  status: 'Pending' | 'Processing' | 'Completed' | 'Failed';
  sourceOrg?: string;
}

/** Function signature for querying sandbox refresh status */
export type QuerySandboxesFn = (
  orgId: string
) => Promise<SandboxRefreshEvent[]>;

/** Callback invoked when a new refresh event is detected */
export type RefreshDetectedFn = (event: SandboxRefreshEvent) => void;

const IN_PROGRESS_STATUSES = new Set<SandboxRefreshEvent['status']>([
  'Pending',
  'Processing',
]);

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
  private readonly knownRefreshIds: Set<string> = new Set();

  constructor(
    querySandboxes: QuerySandboxesFn,
    onRefreshDetected?: RefreshDetectedFn
  ) {
    this.querySandboxes = querySandboxes;
    this.onRefreshDetected = onRefreshDetected;
  }

  /** Fetch sandbox refresh events and detect new ones */
  async fetch(orgId: string): Promise<SandboxRefreshEvent[]> {
    const events = await this.querySandboxes(orgId);
    this.refreshCache.set(orgId, events);

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
