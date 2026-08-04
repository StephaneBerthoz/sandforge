import React from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Select } from '../../components/ui/Select';
import type { BadgeVariant } from '../../components/ui/Badge';
import type { ConflictStrategy } from '@sandforge/shared';
import { useCDCLiveStore } from '../../stores/useCDCLiveStore';
import type { CDCConnectionStatus } from '../../stores/useCDCLiveStore';

/** Map connection status to badge variant color. */
const statusVariantMap: Record<CDCConnectionStatus, BadgeVariant> = {
  disconnected: 'default',
  connecting: 'warning',
  syncing: 'success',
  paused: 'warning',
  error: 'error',
};

/** Conflict strategy options for the select dropdown. */
const conflictOptions: { value: ConflictStrategy; label: string }[] = [
  { value: 'source_wins', label: 'Source Wins' },
  { value: 'target_wins', label: 'Target Wins' },
  { value: 'newest_wins', label: 'Newest Wins' },
  { value: 'manual', label: 'Manual' },
  { value: 'merge', label: 'Merge' },
];

/** Props for the CDCSubscriptionPanel component. */
export interface CDCSubscriptionPanelProps {
  /** Available objects that can be watched for CDC events. */
  availableObjects: string[];
}

/**
 * CDC subscription panel: object picker, start/stop button, connection status,
 * and per-object auto-sync toggle with conflict strategy selector.
 */
export const CDCSubscriptionPanel: React.FC<CDCSubscriptionPanelProps> = ({ availableObjects }) => {
  const { t } = useTranslation();
  const status = useCDCLiveStore((s) => s.status);
  const watchedObjects = useCDCLiveStore((s) => s.watchedObjects);
  const autoSyncObjects = useCDCLiveStore((s) => s.autoSyncObjects);
  const setWatchedObjects = useCDCLiveStore((s) => s.setWatchedObjects);
  const toggleAutoSync = useCDCLiveStore((s) => s.toggleAutoSync);
  const setConflictStrategy = useCDCLiveStore((s) => s.setConflictStrategy);
  const startStream = useCDCLiveStore((s) => s.startStream);
  const stopStream = useCDCLiveStore((s) => s.stopStream);

  const isStreaming = status === 'syncing' || status === 'connecting' || status === 'paused';
  const isConnecting = status === 'connecting';

  /** Toggle an object in the watched list. */
  const handleObjectToggle = (objectName: string, checked: boolean): void => {
    if (checked) {
      setWatchedObjects([...watchedObjects, objectName]);
    } else {
      setWatchedObjects(watchedObjects.filter((o) => o !== objectName));
    }
  };

  return (
    <div className="flex flex-col gap-[var(--sf-space-3)]" data-testid="cdc-subscription-panel">
      {/* Header with status and start/stop */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-[var(--sf-space-2)]">
          <h3 className="text-sm font-medium text-text-primary">{t('sync.realtime.title')}</h3>
          <span data-testid="cdc-status-badge">
            <Badge variant={statusVariantMap[status]}>{t(`sync.realtime.status.${status}`)}</Badge>
          </span>
        </div>
        <div className="flex items-center gap-[var(--sf-space-2)]">
          {status === 'disconnected' || status === 'error' ? (
            <Button
              variant="primary"
              size="sm"
              onClick={startStream}
              disabled={watchedObjects.length === 0}
              data-testid="cdc-start-btn"
            >
              {t('sync.realtime.start')}
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={stopStream}
              disabled={isConnecting}
              data-testid="cdc-stop-btn"
            >
              {t('sync.realtime.stop')}
            </Button>
          )}
        </div>
      </div>

      {/* Object selection */}
      <Card data-testid="cdc-object-picker">
        <CardHeader title={t('sync.realtime.objectPicker')} />
        <CardBody>
          <div className="flex flex-wrap gap-[var(--sf-space-2)]">
            {availableObjects.map((objectName) => (
              <label key={objectName} className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={watchedObjects.includes(objectName)}
                  disabled={isStreaming}
                  onChange={(e) => handleObjectToggle(objectName, e.target.checked)}
                  data-testid={`cdc-object-checkbox-${objectName}`}
                />
                {objectName}
              </label>
            ))}
            {availableObjects.length === 0 && (
              <p className="text-xs text-text-secondary">{t('sync.realtime.noObjects')}</p>
            )}
          </div>
        </CardBody>
      </Card>

      {/* Per-object auto-sync toggles */}
      {watchedObjects.length > 0 && (
        <Card data-testid="cdc-autosync-section">
          <CardHeader title={t('sync.realtime.autoSync')} />
          <CardBody>
            <div className="flex flex-col gap-[var(--sf-space-2)]">
              {watchedObjects.map((objectName) => {
                const config = autoSyncObjects[objectName];
                return (
                  <div
                    key={objectName}
                    className="flex items-center gap-[var(--sf-space-2)] text-xs"
                  >
                    <label className="flex items-center gap-1 min-w-[120px]">
                      <input
                        type="checkbox"
                        checked={!!config}
                        onChange={() => toggleAutoSync(objectName)}
                        data-testid={`cdc-autosync-toggle-${objectName}`}
                      />
                      {objectName}
                    </label>
                    {config && (
                      <Select
                        options={conflictOptions}
                        value={config.conflictStrategy}
                        onChange={(e) =>
                          setConflictStrategy(objectName, e.target.value as ConflictStrategy)
                        }
                        data-testid={`cdc-conflict-select-${objectName}`}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
};
