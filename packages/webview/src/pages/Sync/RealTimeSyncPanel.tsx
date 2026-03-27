import React, { useEffect } from 'react';
import { useCDCLiveStore } from '../../stores/useCDCLiveStore';
import { CDCSubscriptionPanel } from './CDCSubscriptionPanel';
import { CDCEventFeed } from './CDCEventFeed';

/** Props for the RealTimeSyncPanel component. */
export interface RealTimeSyncPanelProps {
  /** Source org ID for the CDC stream. */
  sourceOrgId: string;
  /** Target org ID for change replication. */
  targetOrgId: string;
  /** Available objects that can be watched for CDC events. */
  availableObjects: string[];
}

/**
 * Real-time CDC sync panel.
 * Composes CDCSubscriptionPanel (controls) with CDCEventFeed (live event list).
 * Sets org pair in the store on mount.
 */
export const RealTimeSyncPanel: React.FC<RealTimeSyncPanelProps> = ({
  sourceOrgId,
  targetOrgId,
  availableObjects,
}) => {
  const setOrgs = useCDCLiveStore((s) => s.setOrgs);

  useEffect(() => {
    setOrgs(sourceOrgId, targetOrgId);
  }, [sourceOrgId, targetOrgId, setOrgs]);

  return (
    <div
      className="flex flex-col gap-[var(--sf-space-4)] h-full"
      data-testid="realtime-sync-panel"
    >
      <CDCSubscriptionPanel availableObjects={availableObjects} />
      <CDCEventFeed />
    </div>
  );
};
