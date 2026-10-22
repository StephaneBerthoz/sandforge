import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { RealTimePublishingObject } from '@sandforge/shared';
import { useCDCLiveStore } from '../../stores/useCDCLiveStore';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { CDCSubscriptionPanel } from './CDCSubscriptionPanel';
import { CDCMetricsDashboard } from './CDCMetricsDashboard';
import { CDCEventFeed } from './CDCEventFeed';

/** The standard channel every object selected in Setup → Change Data Capture publishes on. */
const STANDARD_CHANNEL = 'ChangeEvents';

/** Props for the RealTimeSyncPanel component. */
export interface RealTimeSyncPanelProps {
  /** Source org ID for the CDC stream. */
  sourceOrgId: string;
  /** Target org ID for change replication. */
  targetOrgId: string;
}

/**
 * Real-time CDC sync panel.
 *
 * Asks the host which objects the source org publishes change events for — the
 * org says so itself, per channel — and offers only those: subscribing to
 * any other is refused by the org. Composes CDCSubscriptionPanel (controls)
 * with the metrics and CDCEventFeed (live event list), and says in the org's
 * own words what was refused and why a session stopped.
 */
export const RealTimeSyncPanel: React.FC<RealTimeSyncPanelProps> = ({
  sourceOrgId,
  targetOrgId,
}) => {
  const { t } = useTranslation();
  const setOrgs = useCDCLiveStore((s) => s.setOrgs);
  const status = useCDCLiveStore((s) => s.status);
  const refused = useCDCLiveStore((s) => s.refused);
  const notes = useCDCLiveStore((s) => s.notes);
  const error = useCDCLiveStore((s) => s.error);
  const pickedBoth = sourceOrgId !== '' && targetOrgId !== '';

  useEffect(() => {
    setOrgs(sourceOrgId, targetOrgId);
  }, [sourceOrgId, targetOrgId, setOrgs]);

  // A session outlives the panel: a panel that opens again asks what runs.
  useEffect(() => {
    sendBridgeMessage('realtime:status');
  }, []);

  const publishing = useBridgeQuery<{ objects: RealTimePublishingObject[] }>(
    'realtime:objects',
    { sourceOrgId, targetOrgId },
    { skip: !pickedBoth },
  );
  const objects = publishing.data?.objects ?? [];

  const isStreaming = status === 'syncing' || status === 'paused';

  if (!pickedBoth) {
    return (
      <div className="text-xs text-text-secondary" data-testid="realtime-sync-panel">
        <p data-testid="realtime-pick-orgs">{t('sync.realtime.pickOrgs')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-(--sf-space-4) h-full" data-testid="realtime-sync-panel">
      {publishing.loading && (
        <p className="text-xs text-text-secondary" data-testid="realtime-objects-loading">
          {t('sync.realtime.loadingObjects')}
        </p>
      )}
      {publishing.error && (
        <ErrorBanner
          message={t('sync.realtime.objectsError', { message: publishing.error })}
          code={publishing.errorCode}
          data-testid="realtime-objects-error"
        />
      )}
      {publishing.data && objects.length === 0 && (
        <div
          className="flex flex-col gap-1 text-xs text-text-primary"
          data-testid="realtime-no-publishing"
        >
          <p>{t('sync.realtime.noPublishingObjects')}</p>
          <p className="text-text-secondary">{t('sync.realtime.howToEnable')}</p>
        </div>
      )}
      {objects.length > 0 && <CDCSubscriptionPanel objects={objects} />}

      {error && (
        <ErrorBanner
          message={t('sync.realtime.sessionError', { message: error })}
          data-testid="realtime-session-error"
        />
      )}
      {refused.length > 0 && (
        <div
          className="flex flex-col gap-1 text-xs text-text-primary"
          data-testid="realtime-refused"
          role="status"
        >
          <p className="font-medium">{t('sync.realtime.refusedTitle')}</p>
          <ul className="list-disc pl-5">
            {refused.map(({ objectApiName, reason }) => (
              <li key={objectApiName}>
                {objectApiName}: <span className="font-mono">{reason}</span>
              </li>
            ))}
          </ul>
          {/* The objects offered are those the org publishes change events
              for: a refusal is most often the permission the subscription
              needs. Listed on the standard channel, it is that alone; on
              another channel, the object may also not be selected for the
              standard one. Every refusal was said to be the selection. */}
          <p className="text-text-secondary" data-testid="realtime-refused-hint">
            {refused.every(
              ({ objectApiName }) =>
                objects.find((o) => o.objectApiName === objectApiName)?.channel ===
                STANDARD_CHANNEL,
            )
              ? t('sync.realtime.refusedHintPermission')
              : t('sync.realtime.refusedHint')}
          </p>
        </div>
      )}
      {notes.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-text-primary" data-testid="realtime-notes">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}

      <details open={isStreaming} data-testid="cdc-metrics-section">
        <summary className="cursor-pointer text-sm font-medium text-(--sf-text-primary) mb-2">
          {t('sync.realtime.metrics')}
        </summary>
        <CDCMetricsDashboard />
      </details>
      <CDCEventFeed />
    </div>
  );
};
