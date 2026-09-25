import React from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Select } from '../../components/ui/Select';
import type { BadgeVariant } from '../../components/ui/Badge';
import type { ConflictStrategy, RealTimeMatch, RealTimePublishingObject } from '@sandforge/shared';
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

/** Conflict strategy options for the select dropdown, resolved at render. */
const conflictOptions: { value: ConflictStrategy; labelKey: string }[] = [
  { value: 'source_wins', labelKey: 'sync.realtime.conflict.source_wins' },
  { value: 'target_wins', labelKey: 'sync.realtime.conflict.target_wins' },
  { value: 'newest_wins', labelKey: 'sync.realtime.conflict.newest_wins' },
  { value: 'manual', labelKey: 'sync.realtime.conflict.manual' },
  { value: 'merge', labelKey: 'sync.realtime.conflict.merge' },
];

/** A match as the value of a `<select>` option. */
function matchValue(match: RealTimeMatch): string {
  switch (match.kind) {
    case 'id':
      return 'id';
    case 'externalId':
      return `externalId:${match.field}`;
    case 'syncConfig':
      return `syncConfig:${match.configId}`;
  }
}

/** The match an option value stands for. */
function matchOf(value: string): RealTimeMatch {
  if (value.startsWith('externalId:')) {
    return { kind: 'externalId', field: value.slice('externalId:'.length) };
  }
  if (value.startsWith('syncConfig:')) {
    return { kind: 'syncConfig', configId: value.slice('syncConfig:'.length) };
  }
  return { kind: 'id' };
}

/**
 * The match an object starts with: the first external id of the target, which
 * can find a record made since the orgs were copied, and the record Id when the
 * target has none.
 */
export function defaultMatch(object: RealTimePublishingObject): RealTimeMatch {
  const field = object.externalIdFields[0];
  return field ? { kind: 'externalId', field } : { kind: 'id' };
}

/** Props for the CDCSubscriptionPanel component. */
export interface CDCSubscriptionPanelProps {
  /** Objects the source org publishes change events for. */
  objects: RealTimePublishingObject[];
}

/**
 * CDC subscription panel: object picker, start/stop button, connection status,
 * and per-object writing to the target — how its record is found, whether
 * deletions follow, and what a collision with a newer target edit comes to.
 */
export const CDCSubscriptionPanel: React.FC<CDCSubscriptionPanelProps> = ({ objects }) => {
  const { t } = useTranslation();
  const status = useCDCLiveStore((s) => s.status);
  const watchedObjects = useCDCLiveStore((s) => s.watchedObjects);
  const autoSyncObjects = useCDCLiveStore((s) => s.autoSyncObjects);
  const setWatchedObjects = useCDCLiveStore((s) => s.setWatchedObjects);
  const toggleAutoSync = useCDCLiveStore((s) => s.toggleAutoSync);
  const setConflictStrategy = useCDCLiveStore((s) => s.setConflictStrategy);
  const setMatch = useCDCLiveStore((s) => s.setMatch);
  const setApplyDeletes = useCDCLiveStore((s) => s.setApplyDeletes);
  const startStream = useCDCLiveStore((s) => s.startStream);
  const stopStream = useCDCLiveStore((s) => s.stopStream);

  const isStreaming = status === 'syncing' || status === 'connecting' || status === 'paused';
  const isConnecting = status === 'connecting';
  const byName = React.useMemo(
    () => new Map(objects.map((object) => [object.objectApiName, object])),
    [objects],
  );

  const conflictSelectOptions = React.useMemo(
    () => conflictOptions.map((opt) => ({ value: opt.value, label: t(opt.labelKey) })),
    [t],
  );

  /** The ways the target record of an object's change can be found. */
  const matchOptions = (object: RealTimePublishingObject) => [
    ...object.externalIdFields.map((field) => ({
      value: matchValue({ kind: 'externalId', field }),
      label: t('sync.realtime.match.externalId', { field }),
    })),
    ...object.syncConfigs.map((config) => ({
      value: matchValue({ kind: 'syncConfig', configId: config.id }),
      label: t('sync.realtime.match.syncConfig', { name: config.name }),
    })),
    { value: matchValue({ kind: 'id' }), label: t('sync.realtime.match.id') },
  ];

  /** Toggle an object in the watched list. */
  const handleObjectToggle = (objectName: string, checked: boolean): void => {
    if (checked) {
      setWatchedObjects([...watchedObjects, objectName]);
    } else {
      setWatchedObjects(watchedObjects.filter((o) => o !== objectName));
    }
  };

  return (
    <div className="flex flex-col gap-(--sf-space-3)" data-testid="cdc-subscription-panel">
      {/* Header with status and start/stop */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-(--sf-space-2)">
          <h3 className="text-sm font-medium text-text-primary">{t('sync.realtime.title')}</h3>
          <span data-testid="cdc-status-badge">
            <Badge variant={statusVariantMap[status]}>{t(`sync.realtime.status.${status}`)}</Badge>
          </span>
        </div>
        <div className="flex items-center gap-(--sf-space-2)">
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
          <div className="flex flex-wrap gap-(--sf-space-3)">
            {objects.map((object) => (
              <label
                key={object.objectApiName}
                className="flex items-center gap-1 text-xs text-text-primary"
              >
                <input
                  type="checkbox"
                  checked={watchedObjects.includes(object.objectApiName)}
                  disabled={isStreaming}
                  onChange={(e) => handleObjectToggle(object.objectApiName, e.target.checked)}
                  data-testid={`cdc-object-checkbox-${object.objectApiName}`}
                />
                {object.objectApiName}{' '}
                <span className="text-text-secondary">
                  {t('sync.realtime.channel', { channel: object.channel })}
                </span>
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-text-secondary" data-testid="cdc-how-to-enable">
            {t('sync.realtime.howToEnable')}
          </p>
        </CardBody>
      </Card>

      {/* Per-object writing to the target */}
      {watchedObjects.length > 0 && (
        <Card data-testid="cdc-autosync-section">
          <CardHeader title={t('sync.realtime.autoSync')} />
          <CardBody>
            <p className="mb-2 text-xs text-text-secondary">{t('sync.realtime.autoSyncHint')}</p>
            <div className="flex flex-col gap-(--sf-space-3)">
              {watchedObjects.map((objectName) => {
                const config = autoSyncObjects[objectName];
                const object = byName.get(objectName);
                const writable = object?.inTarget !== false;
                return (
                  <div
                    key={objectName}
                    className="flex flex-wrap items-center gap-(--sf-space-2) text-xs"
                    data-testid={`cdc-autosync-row-${objectName}`}
                  >
                    <label className="flex items-center gap-1 min-w-[120px] text-text-primary">
                      <input
                        type="checkbox"
                        checked={!!config}
                        disabled={isStreaming || !writable}
                        onChange={() =>
                          toggleAutoSync(objectName, object ? defaultMatch(object) : { kind: 'id' })
                        }
                        data-testid={`cdc-autosync-toggle-${objectName}`}
                      />
                      {objectName}
                    </label>
                    {!writable && (
                      <span className="text-text-secondary">{t('sync.realtime.notInTarget')}</span>
                    )}
                    {config && object && (
                      <>
                        <Select
                          options={matchOptions(object)}
                          value={config.match ? matchValue(config.match) : ''}
                          onChange={(e) => setMatch(objectName, matchOf(e.target.value))}
                          disabled={isStreaming}
                          aria-label={t('sync.realtime.matchLabel', { object: objectName })}
                          data-testid={`cdc-match-select-${objectName}`}
                        />
                        <Select
                          options={conflictSelectOptions}
                          value={config.conflictStrategy}
                          onChange={(e) =>
                            setConflictStrategy(objectName, e.target.value as ConflictStrategy)
                          }
                          disabled={isStreaming}
                          aria-label={t('sync.realtime.conflictLabel', { object: objectName })}
                          data-testid={`cdc-conflict-select-${objectName}`}
                        />
                        <label className="flex items-center gap-1 text-text-primary">
                          <input
                            type="checkbox"
                            checked={config.applyDeletes}
                            disabled={isStreaming}
                            onChange={(e) => setApplyDeletes(objectName, e.target.checked)}
                            data-testid={`cdc-delete-toggle-${objectName}`}
                          />
                          {t('sync.realtime.applyDeletes')}
                        </label>
                      </>
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
