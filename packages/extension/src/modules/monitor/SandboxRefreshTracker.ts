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
  /** Whether the read stopped at its bound: older refreshes were left unread. */
  truncated: boolean;
}

/** Function signature for querying sandbox refresh status */
export type QuerySandboxesFn = (orgId: string) => Promise<SandboxRefreshFetch>;

/** Callback invoked when a refresh completes while the tracker watches */
export type RefreshDetectedFn = (event: SandboxRefreshEvent) => void;

/**
 * Where the completed refreshes already seen on an org are remembered.
 *
 * Kept outside the tracker so it can outlive it: a tracker is built per
 * window, and one that started from nothing would file a refresh completed
 * while no window was open with the history it does not report.
 */
export interface SeenRefreshStore {
  /** Keys of the completed refreshes seen on `orgId`; `undefined` before its first read. */
  load(orgId: string): string[] | undefined;
  /** Replace what is remembered about `orgId`. */
  save(orgId: string, keys: string[]): void;
}

/** A {@link SeenRefreshStore} that lasts as long as the tracker holding it. */
function inMemorySeenStore(): SeenRefreshStore {
  const seen = new Map<string, string[]>();
  return {
    load: (orgId) => seen.get(orgId),
    save: (orgId, keys) => {
      seen.set(orgId, keys);
    },
  };
}

const IN_PROGRESS_STATUSES = new Set<SandboxRefreshEvent['status']>(['Pending', 'Processing']);

/** One sandbox process, across reads: the same sandbox started at the same instant. */
function refreshKey(event: SandboxRefreshEvent): string {
  return `${event.sandboxName}:${event.refreshDate}`;
}

/**
 * Tracks sandbox refresh events in Salesforce.
 *
 * Reports a refresh once, when a read first shows it Completed — the moment
 * the copy is activated and the sandbox the users knew is replaced. The first
 * read of an org only records what is already there: the org's history
 * reported as news on every start was the reason this callback went
 * unconnected, since it would have announced twenty old refreshes at once.
 */
export class SandboxRefreshTracker {
  private readonly querySandboxes: QuerySandboxesFn;
  private readonly onRefreshDetected: RefreshDetectedFn | undefined;
  private readonly seen: SeenRefreshStore;
  private readonly refreshCache: Map<string, SandboxRefreshEvent[]> = new Map();
  private readonly supportedCache: Map<string, boolean> = new Map();
  private readonly truncatedCache: Map<string, boolean> = new Map();

  constructor(
    querySandboxes: QuerySandboxesFn,
    onRefreshDetected?: RefreshDetectedFn,
    seen: SeenRefreshStore = inMemorySeenStore(),
  ) {
    this.querySandboxes = querySandboxes;
    this.onRefreshDetected = onRefreshDetected;
    this.seen = seen;
  }

  /** Fetch sandbox refresh events and report the refreshes completed since the last read */
  async fetch(orgId: string): Promise<SandboxRefreshEvent[]> {
    const { supported, events, truncated } = await this.querySandboxes(orgId);
    this.refreshCache.set(orgId, events);
    this.supportedCache.set(orgId, supported);
    this.truncatedCache.set(orgId, truncated);
    // An org that cannot be asked has no history to remember.
    if (!supported) return events;

    const completed = events.filter((event) => event.status === 'Completed');
    const known = this.seen.load(orgId);
    if (known !== undefined) {
      const already = new Set(known);
      for (const event of completed) {
        if (!already.has(refreshKey(event))) this.onRefreshDetected?.(event);
      }
    }

    // Only the rows of this read are kept: the query returns the most recent
    // processes, so a refresh that left the window never comes back into it.
    const keys = completed.map(refreshKey);
    if (known === undefined || keys.some((key) => !known.includes(key))) {
      this.seen.save(orgId, keys);
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

  /** Whether the last read of this org stopped at its bound. */
  isTruncated(orgId: string): boolean {
    return this.truncatedCache.get(orgId) ?? false;
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
