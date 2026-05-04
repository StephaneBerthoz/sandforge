import React, { useEffect, useRef } from 'react';
import { useFleetStore } from '../store/useFleetStore';
import { useVisibilityGate } from '../hooks/useVisibilityGate';
import { useSendMessage } from '../hooks/useMessageBus';
import type { OrgFleetSummary } from '@sandforge/shared';

/** Plan 03-07 polling cadence — backend caches 60 s, re-requests are harmless. */
const POLL_INTERVAL_MS = 60_000;

/**
 * Plan 03-07 fleet-overview default landing.
 *
 * - useVisibilityGate posts monitor:visibility on document.visibilitychange
 *   so the extension pauses polling when the panel is hidden (audit M1).
 * - useFleetStore (Record-based, audit M5) holds per-org summaries and
 *   triggers re-renders on each refresh.
 * - Boot sequencing (audit H7): the initial monitor:fleet:summary:request
 *   fires from useEffect after the bridge is mounted; the 60 s polling
 *   interval is cleared on unmount.
 */
export interface MonitorOverviewPageProps {
  /** Optional drilldown handler — called with the orgId of the clicked card. */
  onDrilldown?: (orgId: string) => void;
}

export const MonitorOverviewPage: React.FC<MonitorOverviewPageProps> = ({ onDrilldown }) => {
  useVisibilityGate();
  const { partitions, loading } = useFleetStore();
  const sendMessage = useSendMessage();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const requestFleet = (): void => {
      sendMessage({
        id: `fleet-${Date.now()}`,
        type: 'monitor:fleet:summary:request',
        timestamp: Date.now(),
        payload: {},
      } as Parameters<typeof sendMessage>[0]);
    };
    requestFleet();
    intervalRef.current = setInterval(requestFleet, POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [sendMessage]);

  const orgs = Object.values(partitions);

  if (orgs.length === 0) {
    return (
      <div data-testid="monitor-overview-page" className="p-6">
        <h1 className="text-xl font-semibold mb-4">Fleet Overview</h1>
        <p data-testid="monitor-overview-empty" className="text-sm opacity-70">
          {loading ? 'Loading fleet summary…' : 'No connected orgs.'}
        </p>
      </div>
    );
  }

  return (
    <div data-testid="monitor-overview-page" className="p-6">
      <h1 className="text-xl font-semibold mb-4">Fleet Overview</h1>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {orgs.map((org) => (
          <OrgFleetCard key={org.orgId} org={org} onDrilldown={onDrilldown} />
        ))}
      </div>
    </div>
  );
};

interface OrgFleetCardProps {
  org: OrgFleetSummary;
  onDrilldown?: (orgId: string) => void;
}

const OrgFleetCard: React.FC<OrgFleetCardProps> = ({ org, onDrilldown }) => {
  const healthClass =
    org.healthScore >= 80 ? 'bg-green-500' : org.healthScore >= 60 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div
      data-testid="monitor-overview-org-card"
      data-org-id={org.orgId}
      className="border rounded-md p-4 flex flex-col gap-3"
    >
      <div className="flex items-center justify-between">
        <div data-testid="monitor-overview-org-name" className="font-medium truncate">
          {org.alias ?? org.orgId}
        </div>
        {org.stale ? (
          <span
            data-testid="monitor-overview-org-stale"
            className="text-xs px-2 py-0.5 rounded bg-amber-200 text-amber-900"
          >
            stale
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <div
          data-testid="monitor-overview-org-health"
          className="h-2 w-full rounded bg-gray-200 overflow-hidden"
          aria-label={`Health ${org.healthScore}`}
        >
          <div className={`h-full ${healthClass}`} style={{ width: `${org.healthScore}%` }} />
        </div>
        <div className="text-xs tabular-nums w-10 text-right">{org.healthScore}</div>
      </div>
      <div className="flex items-center justify-between text-xs opacity-80">
        <div data-testid="monitor-overview-org-alerts">
          {org.activeAlerts} alert{org.activeAlerts === 1 ? '' : 's'}
        </div>
        <div className="opacity-60">api {org.apiUsedPercent}%</div>
      </div>
      <button
        type="button"
        data-testid="monitor-overview-org-drilldown-btn"
        onClick={() => onDrilldown?.(org.orgId)}
        className="text-xs underline self-start"
      >
        Open dashboard →
      </button>
    </div>
  );
};
