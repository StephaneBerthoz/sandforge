import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useCDCLiveStore } from '../../stores/useCDCLiveStore';
import { CDCSubscriptionPanel } from './CDCSubscriptionPanel';
import { CDCMetricsDashboard } from './CDCMetricsDashboard';
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
  const { t } = useTranslation();
  const setOrgs = useCDCLiveStore((s) => s.setOrgs);
  const status = useCDCLiveStore((s) => s.status);

  useEffect(() => {
    setOrgs(sourceOrgId, targetOrgId);
  }, [sourceOrgId, targetOrgId, setOrgs]);

  const isStreaming = status === 'syncing' || status === 'paused';

  return (
    <div className="flex flex-col gap-[var(--sf-space-4)] h-full" data-testid="realtime-sync-panel">
      <CDCSubscriptionPanel availableObjects={availableObjects} />
      <details open={isStreaming} data-testid="cdc-metrics-section">
        <summary className="cursor-pointer text-sm font-medium text-[var(--sf-text)] mb-2">
          {t('sync.realtime.metrics')}
        </summary>
        <CDCMetricsDashboard />
      </details>
      <CDCEventFeed />
    </div>
  );
};
