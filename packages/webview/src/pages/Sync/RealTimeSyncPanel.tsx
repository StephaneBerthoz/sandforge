import React from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import type { BadgeVariant } from '../../components/ui/Badge';

/** A single event entry in the live feed. */
export interface EventFeedEntry {
  replayId: number;
  objectApiName: string;
  changeType: string;
  recordIds: string[];
  commitTimestamp: string;
  applied: boolean;
  error?: string;
}

/** Conflict entry from the extension. */
export interface ConflictEntry {
  replayId: number;
  objectApiName: string;
  recordIds: string[];
  changeType: string;
  sourceValues: Record<string, unknown>;
  targetValues: Record<string, unknown>;
  targetLastModified: string;
}

/** Metrics snapshot from the extension. */
export interface MetricsSnapshot {
  eventsReceived: number;
  eventsApplied: number;
  eventsFailed: number;
  eventsPerMinute: number;
  averageLagMs: number;
  currentLagMs: number;
  errorRate: number;
  startedAt: string;
  lastEventAt?: string;
}

const statusVariantMap: Record<string, BadgeVariant> = {
  disconnected: 'default',
  connecting: 'warning',
  connected: 'success',
  syncing: 'success',
  paused: 'warning',
  error: 'error',
};

/** Props for the RealTimeSyncPanel component. */
export interface RealTimeSyncPanelProps {
  sourceOrgId: string;
  targetOrgId: string;
  availableObjects: string[];
}

/**
 * Real-time CDC sync panel.
 *
 * RealTime CDC sync is a planned feature (v2.0). The panel renders with
 * a "Coming Soon" badge and all interactive controls disabled.
 * Users can see the planned UI but cannot interact.
 */
export const RealTimeSyncPanel: React.FC<RealTimeSyncPanelProps> = ({
  availableObjects,
}) => {
  const { t } = useTranslation();

  return (
    <div
      className="relative"
      data-testid="realtime-sync-panel"
    >
      <span data-testid="realtime-coming-soon">
        <Badge variant="info">
          {t('sync.realtime.comingSoon')}
        </Badge>
      </span>
      <div className="opacity-50 pointer-events-none mt-2">
        <div className="flex flex-col gap-[var(--sf-space-4)]">
          {/* Header with status and toggle */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-[var(--sf-space-2)]">
              <h3 className="text-sm font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
                {t('sync.realtime.title')}
              </h3>
              <span data-testid="realtime-status">
                <Badge variant={statusVariantMap['disconnected']}>
                  {t('sync.realtime.status.disconnected')}
                </Badge>
              </span>
            </div>
            <Button
              variant="primary"
              size="sm"
              disabled
              data-testid="realtime-toggle"
            >
              {t('sync.realtime.start')}
            </Button>
          </div>

          {/* Object selection */}
          <Card data-testid="realtime-objects">
            <CardHeader title={t('sync.realtime.watchedObjects')} />
            <CardBody>
              <div className="flex flex-wrap gap-[var(--sf-space-2)]">
                {availableObjects.map((objectName) => (
                  <label
                    key={objectName}
                    className="flex items-center gap-1 text-xs"
                  >
                    <input
                      type="checkbox"
                      checked={false}
                      disabled
                      readOnly
                      data-testid={`realtime-object-${objectName}`}
                    />
                    {objectName}
                  </label>
                ))}
                {availableObjects.length === 0 && (
                  <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">
                    {t('sync.realtime.noObjects')}
                  </p>
                )}
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
};
