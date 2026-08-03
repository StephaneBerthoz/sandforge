import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Plan 03-04 — DriftFeed.tsx — virtualized drift timeline + filter chips.
 *
 * # What this component owns
 *
 * The user-facing surface for the Drift v2 stream introduced by Plan 03-04.
 * Subscribes to the `monitor:drift:detected` envelope shipped on the
 * extension-side `MetricBus` (Plan 03-01) and renders an event timeline with
 * four filter chips: Object / Field / Permission / Setup.
 *
 * # Why a hand-rolled virtual list (and not @tanstack/react-virtual yet)
 *
 * The drift event count is naturally capped at 100 entries (this component
 * keeps only the latest 100 in state). At that size, a plain `.slice(0, 100)`
 * + a CSS `overflow-y: auto; max-height` outperforms any heavyweight virtual
 * list — DOM nodes are cheap and React's reconciliation handles 100 rows
 * without jank. If real-world traffic ever exceeds 100 visible rows we'll
 * graduate to `@tanstack/react-virtual` (already in webview deps).
 *
 * # Bridge subscription contract (P-03.7 H7)
 *
 * The `useEffect` below is mount-only. It registers a `window` message
 * listener for `monitor:drift:detected` envelopes — the slimmed envelope
 * shape per Plan 03-01 `DriftDetectedEventSchema`. The cleanup function
 * unsubscribes on unmount so the BridgeProvider mount-only `useEffect`
 * audit (P-03.7 H7) does not flag this component.
 *
 * # Stable testids (per Plan 03-04 task description)
 *
 * - `monitor-drift-feed` — root container.
 * - `monitor-drift-filter-{object,field,permission,setup}` — chips.
 * - `monitor-drift-event-row` — one per visible event.
 * - `monitor-drift-event-row-expanded` — appears when an event row is
 *   expanded.
 *
 * # Plan 03-04 stays in lane
 *
 * - Does NOT add a charting library — no recharts, no d3 (CONTEXT
 *   non-goal #2).
 * - Does NOT touch the existing `MonitorPage.tsx` — additive component.
 * - The Setup chip is **disabled** because Setup Audit Trail is deferred
 *   to v1.4 (CONTEXT non-goal — metadata-restricted API).
 */

/** Slim envelope shape carried over the bridge (Plan 03-01 contract). */
export interface DriftDetectedEnvelope {
  orgId: string;
  snapshotPairId: string;
  summary: string;
  deltaCount: number;
  severity: 'info' | 'breaking' | 'permission';
}

/** Optional richer payload the detail request may surface for an expanded row. */
export interface DriftDelta {
  objectApiName?: string;
  fieldApiName?: string;
  profileOrPermSetName?: string;
  changeKind: string;
  permission?: string;
  detectedAt: string;
}

interface DriftFeedEntry extends DriftDetectedEnvelope {
  /** Locally-assigned id used as the React key. */
  receivedAt: number;
  /** Optional richer details if the row gets expanded (lazy-loaded). */
  deltas?: DriftDelta[];
}

/** The four filter chip kinds — the timeline filters by these labels. */
type FilterChip = 'object' | 'field' | 'permission' | 'setup';

/** Maximum number of events kept in local state. */
const MAX_EVENTS = 100;

/** Bridge envelope type the component listens for. */
const DRIFT_DETECTED_TYPE = 'monitor:drift:detected';

/** Compute a relative time label like "2 min ago" / "just now". */
function relativeTime(receivedAt: number, now: number): string {
  const diffMs = Math.max(0, now - receivedAt);
  const sec = Math.floor(diffMs / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

/** Severity badge colors — kept inline so this file owns its visual contract. */
function severityClass(sev: DriftDetectedEnvelope['severity']): string {
  switch (sev) {
    case 'permission':
      return 'bg-amber-500/20 text-amber-300 border-amber-500/30';
    case 'breaking':
      return 'bg-red-500/20 text-red-300 border-red-500/30';
    case 'info':
    default:
      return 'bg-blue-500/20 text-blue-300 border-blue-500/30';
  }
}

/**
 * Map an event onto the filter chips it satisfies.
 *
 * The slim envelope only carries `severity`. We approximate:
 *   - `permission` -> 'permission' chip
 *   - `breaking` -> 'object' AND 'field' chips (covers wholesale removals)
 *   - `info` -> 'field' chip (most informational deltas are field-level)
 *
 * A richer mapping arrives once the `monitor:drift:detected:detail`
 * round-trip is wired (planned alongside Plan 03-04 follow-up).
 */
function eventTags(ev: DriftDetectedEnvelope): Set<FilterChip> {
  const tags = new Set<FilterChip>();
  if (ev.severity === 'permission') tags.add('permission');
  if (ev.severity === 'breaking') {
    tags.add('object');
    tags.add('field');
  }
  if (ev.severity === 'info') tags.add('field');
  return tags;
}

export interface DriftFeedProps {
  /** The org whose drift events should be displayed. Filters out other orgs. */
  orgId: string;
  /**
   * Optional initial events — useful for tests and for the E2E harness
   * which seeds state before bridge messages arrive.
   */
  initialEvents?: DriftFeedEntry[];
}

/** Plan 03-04 drift feed component. */
export const DriftFeed: React.FC<DriftFeedProps> = ({ orgId, initialEvents }) => {
  const [events, setEvents] = useState<DriftFeedEntry[]>(initialEvents ?? []);
  const [activeFilters, setActiveFilters] = useState<Set<FilterChip>>(new Set());
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const handlerRef = useRef<((ev: MessageEvent) => void) | null>(null);

  // Bridge subscription — mount-only useEffect with unsubscribe cleanup
  // (P-03.7 H7 mitigation).
  useEffect(() => {
    function listener(ev: MessageEvent): void {
      // SECURITY: only accept messages from VSCode webview (or the empty
      // origin used in tests / E2E harness).
      if (ev.origin && !ev.origin.startsWith('vscode-webview://') && ev.origin !== '') {
        return;
      }
      const data = ev.data as { type?: string; payload?: DriftDetectedEnvelope } | undefined;
      if (!data || data.type !== DRIFT_DETECTED_TYPE) return;
      const payload = data.payload;
      if (!payload || payload.orgId !== orgId) return;
      setEvents((prev) => {
        const next: DriftFeedEntry = {
          ...payload,
          receivedAt: Date.now(),
        };
        const merged = [next, ...prev];
        return merged.slice(0, MAX_EVENTS);
      });
    }
    handlerRef.current = listener;
    window.addEventListener('message', listener);
    return () => {
      window.removeEventListener('message', listener);
      handlerRef.current = null;
    };
  }, [orgId]);

  // Refresh the relative time labels every 30 s.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const toggleFilter = useCallback((chip: FilterChip) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(chip)) next.delete(chip);
      else next.add(chip);
      return next;
    });
  }, []);

  const visibleEvents = useMemo(() => {
    if (activeFilters.size === 0) return events;
    return events.filter((ev) => {
      const tags = eventTags(ev);
      for (const f of activeFilters) {
        if (tags.has(f)) return true;
      }
      return false;
    });
  }, [events, activeFilters]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedRow((current) => (current === id ? null : id));
  }, []);

  return (
    <div
      data-testid="monitor-drift-feed"
      className="flex flex-col gap-3 rounded-lg border border-subtle bg-surface-1 p-4"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-primary">Drift Feed</h3>
        <span className="text-xs text-text-muted">{visibleEvents.length} event(s)</span>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <FilterChipButton
          chip="object"
          label="Object"
          active={activeFilters.has('object')}
          onToggle={toggleFilter}
        />
        <FilterChipButton
          chip="field"
          label="Field"
          active={activeFilters.has('field')}
          onToggle={toggleFilter}
        />
        <FilterChipButton
          chip="permission"
          label="Permission"
          active={activeFilters.has('permission')}
          onToggle={toggleFilter}
        />
        <FilterChipButton
          chip="setup"
          label="Setup"
          active={activeFilters.has('setup')}
          onToggle={toggleFilter}
          disabled
        />
      </div>

      {visibleEvents.length === 0 ? (
        <div
          data-testid="monitor-drift-feed-empty"
          className="text-xs text-text-muted py-6 text-center"
        >
          No drift events yet. The feed updates as the extension detects schema or permission
          changes.
        </div>
      ) : (
        <ul
          className="flex flex-col divide-y divide-subtle max-h-[480px] overflow-y-auto"
          data-testid="monitor-drift-feed-list"
        >
          {visibleEvents.map((ev) => {
            const id = `${ev.snapshotPairId}-${ev.receivedAt}`;
            const isExpanded = expandedRow === id;
            return (
              <li
                key={id}
                data-testid="monitor-drift-event-row"
                data-event-id={id}
                className="py-2 px-1 hover:bg-surface-2 transition-colors cursor-pointer"
                onClick={() => toggleExpand(id)}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${severityClass(
                      ev.severity,
                    )}`}
                  >
                    {ev.severity}
                  </span>
                  <span className="flex-1 text-sm text-text-primary truncate">{ev.summary}</span>
                  <span className="text-[10px] text-text-muted shrink-0">
                    {relativeTime(ev.receivedAt, now)}
                  </span>
                </div>
                {isExpanded && (
                  <div
                    data-testid="monitor-drift-event-row-expanded"
                    className="mt-2 ml-4 text-xs text-text-secondary"
                  >
                    <div>
                      Snapshot pair:{' '}
                      <span className="font-mono text-text-primary">{ev.snapshotPairId}</span>
                    </div>
                    <div>Delta count: {ev.deltaCount}</div>
                    {ev.deltas && ev.deltas.length > 0 && (
                      <table className="mt-2 text-[10px] w-full">
                        <thead>
                          <tr className="text-left text-text-muted">
                            <th className="pr-2">Kind</th>
                            <th className="pr-2">Object</th>
                            <th className="pr-2">Field</th>
                            <th>Detected</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ev.deltas.map((d, i) => (
                            <tr key={`${id}-d-${i}`}>
                              <td className="pr-2">{d.changeKind}</td>
                              <td className="pr-2">{d.objectApiName ?? '-'}</td>
                              <td className="pr-2">{d.fieldApiName ?? '-'}</td>
                              <td>{d.detectedAt}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

interface FilterChipProps {
  chip: FilterChip;
  label: string;
  active: boolean;
  onToggle: (chip: FilterChip) => void;
  disabled?: boolean;
}

const FilterChipButton: React.FC<FilterChipProps> = ({
  chip,
  label,
  active,
  onToggle,
  disabled,
}) => (
  <button
    type="button"
    data-testid={`monitor-drift-filter-${chip}`}
    aria-pressed={active}
    disabled={disabled}
    onClick={() => !disabled && onToggle(chip)}
    className={`text-[11px] font-medium px-2 py-1 rounded border transition-colors ${
      disabled
        ? 'opacity-40 cursor-not-allowed border-subtle text-text-muted'
        : active
          ? 'bg-blue-500/20 text-blue-300 border-blue-500/40'
          : 'bg-surface-2 text-text-secondary border-subtle hover:bg-surface-3'
    }`}
  >
    {label}
  </button>
);

export default DriftFeed;
