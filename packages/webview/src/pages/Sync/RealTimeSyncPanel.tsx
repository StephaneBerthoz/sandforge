import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ProgressBar } from '../../components/ui/ProgressBar';
import type { BadgeVariant } from '../../components/ui/Badge';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useMessageListener } from '../../hooks/useMessageBus';

/** Max entries to keep in the live event feed. */
const MAX_FEED_ENTRIES = 100;

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
 * Provides start/stop toggle, object selection, live event feed,
 * metrics dashboard, and conflict resolution UI.
 */
export const RealTimeSyncPanel: React.FC<RealTimeSyncPanelProps> = ({
  sourceOrgId,
  targetOrgId,
  availableObjects,
}) => {
  const { t } = useTranslation();

  // State
  const [status, setStatus] = useState<string>('disconnected');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [selectedObjects, setSelectedObjects] = useState<string[]>([]);
  const [eventFeed, setEventFeed] = useState<EventFeedEntry[]>([]);
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [conflicts, setConflicts] = useState<ConflictEntry[]>([]);
  const feedRef = useRef<HTMLDivElement>(null);

  // Bridge mutations
  const startMutation = useBridgeMutation<{ sessionId: string; watchedObjects: string[] }>(
    'realtime:start',
    { responseType: 'realtime:started' },
  );
  const stopMutation = useBridgeMutation<{ sessionId: string; reason: string }>(
    'realtime:stop',
    { responseType: 'realtime:stopped' },
  );
  const metricsMutation = useBridgeMutation<MetricsSnapshot>(
    'realtime:metrics',
    { responseType: 'realtime:metrics:response' },
  );
  const resolveMutation = useBridgeMutation<Record<string, unknown>>(
    'realtime:resolve-conflict',
  );

  // Listen for push events from extension
  useMessageListener<{ type: string; id: string; timestamp: number; payload: EventFeedEntry }>(
    'realtime:event',
    useCallback((msg) => {
      setEventFeed((prev) => {
        const next = [msg.payload, ...prev];
        return next.length > MAX_FEED_ENTRIES ? next.slice(0, MAX_FEED_ENTRIES) : next;
      });
    }, []),
  );

  useMessageListener<{ type: string; id: string; timestamp: number; payload: { status: string; sessionId?: string } }>(
    'realtime:status:response',
    useCallback((msg) => {
      setStatus(msg.payload.status);
      if (msg.payload.sessionId) {
        setSessionId(msg.payload.sessionId);
      }
    }, []),
  );

  useMessageListener<{ type: string; id: string; timestamp: number; payload: MetricsSnapshot }>(
    'realtime:metrics:response',
    useCallback((msg) => {
      setMetrics(msg.payload);
    }, []),
  );

  useMessageListener<{ type: string; id: string; timestamp: number; payload: ConflictEntry }>(
    'realtime:conflict',
    useCallback((msg) => {
      setConflicts((prev) => [...prev, msg.payload]);
    }, []),
  );

  // Handle start response
  useEffect(() => {
    if (startMutation.data) {
      setSessionId(startMutation.data.sessionId);
      setStatus('syncing');
    }
  }, [startMutation.data]);

  // Handle stop response
  useEffect(() => {
    if (stopMutation.data) {
      setStatus('disconnected');
      setSessionId(null);
    }
  }, [stopMutation.data]);

  // Poll metrics while syncing
  useEffect(() => {
    if (status !== 'syncing' && status !== 'paused') {
      return;
    }
    const interval = setInterval(() => {
      metricsMutation.mutate();
    }, 5000);
    return () => clearInterval(interval);
  }, [status, metricsMutation]);

  const handleStart = useCallback(() => {
    if (selectedObjects.length === 0) {
      return;
    }
    startMutation.mutate({
      sourceOrgId,
      targetOrgId,
      watchedObjects: selectedObjects,
      conflictStrategy: 'source_wins',
      flushIntervalMs: 5000,
      maxBatchSize: 100,
    });
    setStatus('connecting');
  }, [sourceOrgId, targetOrgId, selectedObjects, startMutation]);

  const handleStop = useCallback(() => {
    if (sessionId) {
      stopMutation.mutate({ sessionId });
    }
  }, [sessionId, stopMutation]);

  const handleObjectToggle = useCallback((objectName: string) => {
    setSelectedObjects((prev) =>
      prev.includes(objectName)
        ? prev.filter((o) => o !== objectName)
        : [...prev, objectName],
    );
  }, []);

  const handleResolveConflict = useCallback(
    (replayId: number, resolution: string) => {
      resolveMutation.mutate({ eventReplayId: replayId, resolution });
      setConflicts((prev) => prev.filter((c) => c.replayId !== replayId));
    },
    [resolveMutation],
  );

  const isActive = status === 'syncing' || status === 'connecting' || status === 'paused';

  return (
    <div
      className="flex flex-col gap-[var(--sf-space-4)]"
      data-testid="realtime-sync-panel"
    >
      {/* Header with status and toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-[var(--sf-space-2)]">
          <h3 className="text-sm font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
            {t('sync.realtime.title')}
          </h3>
          <span data-testid="realtime-status">
            <Badge variant={statusVariantMap[status] ?? 'default'}>
              {t(`sync.realtime.status.${status}`)}
            </Badge>
          </span>
        </div>
        <Button
          variant={isActive ? 'danger' : 'primary'}
          size="sm"
          onClick={isActive ? handleStop : handleStart}
          disabled={!isActive && selectedObjects.length === 0}
          loading={startMutation.loading || stopMutation.loading}
          data-testid="realtime-toggle"
        >
          {isActive
            ? t('sync.realtime.stop')
            : t('sync.realtime.start')}
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
                className="flex items-center gap-1 text-xs cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selectedObjects.includes(objectName)}
                  onChange={() => handleObjectToggle(objectName)}
                  disabled={isActive}
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

      {/* Metrics dashboard */}
      {metrics && (
        <Card data-testid="realtime-metrics">
          <CardHeader title={t('sync.realtime.metrics')} />
          <CardBody>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-[var(--sf-space-3)]">
              <MetricItem
                label={t('sync.realtime.eventsPerMin')}
                value={String(metrics.eventsPerMinute)}
                testId="metric-epm"
              />
              <MetricItem
                label={t('sync.realtime.avgLag')}
                value={`${metrics.averageLagMs}ms`}
                testId="metric-lag"
              />
              <MetricItem
                label={t('sync.realtime.errorRate')}
                value={`${metrics.errorRate}%`}
                testId="metric-errors"
              />
              <MetricItem
                label={t('sync.realtime.applied')}
                value={`${metrics.eventsApplied}/${metrics.eventsReceived}`}
                testId="metric-applied"
              />
            </div>
            {metrics.eventsReceived > 0 && (
              <ProgressBar
                value={metrics.eventsApplied}
                max={metrics.eventsReceived}
                label={t('sync.realtime.replicationProgress')}
                showPercent
                variant={metrics.errorRate > 10 ? 'error' : 'default'}
              />
            )}
          </CardBody>
        </Card>
      )}

      {/* Live event feed */}
      {isActive && (
        <Card data-testid="realtime-feed">
          <CardHeader
            title={t('sync.realtime.eventFeed')}
            subtitle={`${eventFeed.length} ${t('sync.realtime.events')}`}
          />
          <CardBody>
            <div
              ref={feedRef}
              className="max-h-[300px] overflow-y-auto flex flex-col gap-1"
              data-testid="realtime-feed-list"
            >
              {eventFeed.length === 0 ? (
                <p className="text-xs text-center text-[var(--vscode-descriptionForeground,#868686)] py-2">
                  {t('sync.realtime.waitingForEvents')}
                </p>
              ) : (
                eventFeed.map((entry) => (
                  <div
                    key={entry.replayId}
                    className={`flex items-center gap-2 text-[10px] px-2 py-1 rounded ${
                      entry.applied
                        ? 'bg-[var(--vscode-diffEditor-insertedTextBackground,#2ea04320)]'
                        : 'bg-[var(--vscode-diffEditor-removedTextBackground,#f4877120)]'
                    }`}
                    data-testid={`feed-entry-${entry.replayId}`}
                  >
                    <Badge
                      variant={entry.applied ? 'success' : 'error'}
                      className="text-[9px]"
                    >
                      {entry.changeType}
                    </Badge>
                    <span className="font-medium">{entry.objectApiName}</span>
                    <span className="text-[var(--vscode-descriptionForeground,#868686)]">
                      {entry.recordIds[0]}
                    </span>
                    {entry.error && (
                      <span className="text-[var(--vscode-errorForeground,#f48771)] ml-auto truncate max-w-[200px]">
                        {entry.error}
                      </span>
                    )}
                  </div>
                ))
              )}
            </div>
          </CardBody>
        </Card>
      )}

      {/* Conflict resolution */}
      {conflicts.length > 0 && (
        <Card data-testid="realtime-conflicts">
          <CardHeader
            title={t('sync.realtime.conflicts')}
            subtitle={`${conflicts.length} ${t('sync.realtime.pendingConflicts')}`}
          />
          <CardBody>
            <div className="flex flex-col gap-2">
              {conflicts.map((conflict) => (
                <div
                  key={conflict.replayId}
                  className="flex items-center justify-between text-xs border border-[var(--vscode-panel-border,#2b2b2b)] rounded p-2"
                  data-testid={`conflict-${conflict.replayId}`}
                >
                  <div>
                    <span className="font-medium">{conflict.objectApiName}</span>
                    {' — '}
                    <span>{conflict.recordIds.join(', ')}</span>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() =>
                        handleResolveConflict(conflict.replayId, 'source_wins')
                      }
                      data-testid={`resolve-source-${conflict.replayId}`}
                    >
                      {t('sync.realtime.useSource')}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        handleResolveConflict(conflict.replayId, 'target_wins')
                      }
                      data-testid={`resolve-target-${conflict.replayId}`}
                    >
                      {t('sync.realtime.useTarget')}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
};

/** Small metric display item. */
const MetricItem: React.FC<{ label: string; value: string; testId: string }> = ({
  label,
  value,
  testId,
}) => (
  <div className="flex flex-col" data-testid={testId}>
    <span className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)]">
      {label}
    </span>
    <span className="text-sm font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
      {value}
    </span>
  </div>
);
