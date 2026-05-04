import type {
  BaseMessage,
  RealTimeSyncConfig,
  CDCConflict,
  ConflictStrategy,
  FieldResolution,
} from '@sandforge/shared';
import type { MessageBroker } from '../../bridge/MessageBroker.js';
import type { RealTimeSyncOrchestrator } from './RealTimeSyncOrchestrator.js';
import type { CDCEventBatcher } from './CDCEventBatcher.js';
import { ConflictResolver } from './ConflictResolver.js';

/**
 * Wires WebView <-> Extension messaging for real-time CDC sync.
 * Registers MessageBroker handlers for realtime:* messages and
 * routes them to the RealTimeSyncOrchestrator. Uses CDCEventBatcher
 * to batch events before posting to the WebView.
 */
export class RealTimeSyncMessageHandler {
  private readonly broker: MessageBroker;
  private readonly orchestrator: RealTimeSyncOrchestrator;
  private readonly batcher: CDCEventBatcher;
  private readonly conflictResolver: ConflictResolver;
  private unsubscribers: Array<() => void> = [];
  private statusUnsub: (() => void) | null = null;
  private eventFeedUnsub: (() => void) | null = null;
  private conflictFeedUnsub: (() => void) | null = null;

  /**
   * @param broker - Central message broker for WebView communication
   * @param orchestrator - Real-time sync orchestrator instance
   * @param batcher - CDC event batcher for throttled WebView delivery
   */
  constructor(
    broker: MessageBroker,
    orchestrator: RealTimeSyncOrchestrator,
    batcher: CDCEventBatcher,
  ) {
    this.broker = broker;
    this.orchestrator = orchestrator;
    this.batcher = batcher;
    this.conflictResolver = new ConflictResolver();
  }

  /**
   * Register message handlers for all realtime:* message types.
   * Must be called once during extension activation.
   */
  register(): void {
    this.unsubscribers.push(
      this.broker.on('realtime:start', (msg) => this.handleStart(msg)),
      this.broker.on('realtime:stop', (msg) => this.handleStop(msg)),
      this.broker.on('realtime:status', (msg) => this.handleStatus(msg)),
      this.broker.on('realtime:metrics', (msg) => this.handleMetrics(msg)),
      this.broker.on('realtime:resolve-conflict', (msg) => this.handleResolveConflict(msg)),
    );

    // Subscribe to conflict feed from orchestrator
    this.conflictFeedUnsub?.();
    this.conflictFeedUnsub = this.orchestrator.onConflictDetected((conflict: CDCConflict) => {
      this.broker.postToWebview({
        id: `rt-conflict-${Date.now()}`,
        type: 'realtime:conflict',
        timestamp: Date.now(),
        payload: {
          replayId: conflict.event.replayId,
          objectApiName: conflict.event.objectApiName,
          recordIds: conflict.event.recordIds,
          changeType: conflict.event.changeType,
          sourceValues: conflict.event.changedFields,
          targetValues: conflict.targetValues,
          targetLastModified: conflict.targetLastModified,
        },
      } as BaseMessage);
    });
  }

  /**
   * Dispose all handlers and cleanup resources.
   * Flushes any remaining batched events.
   */
  dispose(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
    this.statusUnsub?.();
    this.statusUnsub = null;
    this.eventFeedUnsub?.();
    this.eventFeedUnsub = null;
    this.conflictFeedUnsub?.();
    this.conflictFeedUnsub = null;
    this.batcher.dispose();
  }

  private async handleStart(msg: BaseMessage): Promise<void> {
    const payload = (msg as BaseMessage & { payload: RealTimeSyncConfig }).payload;

    // Wire orchestrator event feed to batcher
    this.eventFeedUnsub?.();
    this.eventFeedUnsub = this.orchestrator.onEventFeed((event, _applied, _error) => {
      this.batcher.push({
        ...event,
      });
    });

    // Wire orchestrator status changes to WebView
    this.statusUnsub?.();
    this.statusUnsub = this.orchestrator.onStatusChange((status) => {
      this.broker.postToWebview({
        id: `rt-status-${Date.now()}`,
        type: 'realtime:status:response',
        timestamp: Date.now(),
        payload: {
          status,
          watchedObjects: this.orchestrator.getWatchedObjects(),
          sessionId: this.orchestrator.getSessionId(),
        },
      } as BaseMessage);
    });

    const config: RealTimeSyncConfig = {
      sessionId: payload.sessionId ?? `cdc-${Date.now()}`,
      sourceOrgId: payload.sourceOrgId,
      targetOrgId: payload.targetOrgId,
      watchedObjects: payload.watchedObjects,
      conflictStrategy: payload.conflictStrategy ?? 'source_wins',
      flushIntervalMs: payload.flushIntervalMs ?? 150,
      maxBatchSize: payload.maxBatchSize ?? 100,
    };

    await this.orchestrator.start(config);

    this.broker.postToWebview({
      id: `rt-started-${Date.now()}`,
      type: 'realtime:started',
      timestamp: Date.now(),
      payload: {
        sessionId: config.sessionId,
        watchedObjects: config.watchedObjects,
      },
    } as BaseMessage);
  }

  private async handleStop(_msg: BaseMessage): Promise<void> {
    const sessionId = this.orchestrator.getSessionId() ?? '';
    await this.orchestrator.stop();

    this.broker.postToWebview({
      id: `rt-stopped-${Date.now()}`,
      type: 'realtime:stopped',
      timestamp: Date.now(),
      payload: {
        sessionId,
        reason: 'user_requested',
      },
    } as BaseMessage);
  }

  private handleStatus(_msg: BaseMessage): void {
    const status = this.orchestrator.getStatus();
    this.broker.postToWebview({
      id: `rt-status-${Date.now()}`,
      type: 'realtime:status:response',
      timestamp: Date.now(),
      payload: {
        status,
        watchedObjects: this.orchestrator.getWatchedObjects(),
        sessionId: this.orchestrator.getSessionId(),
      },
    } as BaseMessage);
  }

  private handleResolveConflict(msg: BaseMessage): void {
    const payload = (
      msg as BaseMessage & {
        payload: {
          conflictId: string;
          eventReplayId?: number;
          resolution: string;
          fieldResolutions?: Record<string, FieldResolution>;
        };
      }
    ).payload;

    const { conflictId, resolution, fieldResolutions } = payload;

    let resolvedValues: Record<string, unknown> | undefined;
    let success = true;

    try {
      if (fieldResolutions && Object.keys(fieldResolutions).length > 0) {
        // Per-field resolution via ConflictResolver.resolvePerField
        // Build a minimal ConflictRecord from the payload
        const conflictFields = Object.keys(fieldResolutions);
        resolvedValues = ConflictResolver.resolvePerField(
          {
            objectApiName: '',
            recordId: conflictId,
            sourceValues: {},
            targetValues: {},
            conflictFields,
          },
          fieldResolutions,
        );
      } else {
        // Bulk strategy resolution -- delegate to ConflictResolver
        const strategy = resolution as ConflictStrategy;
        const resolved = this.conflictResolver.resolve(
          [
            {
              objectApiName: '',
              recordId: conflictId,
              sourceValues: {},
              targetValues: {},
              conflictFields: [],
            },
          ],
          strategy,
        );
        resolvedValues = resolved[0]?.resolvedValues;
      }
    } catch {
      success = false;
    }

    this.broker.postToWebview({
      id: `rt-conflict-resolved-${Date.now()}`,
      type: 'realtime:conflict-resolved',
      timestamp: Date.now(),
      payload: {
        conflictId,
        resolution,
        success,
        resolvedValues,
      },
    } as BaseMessage);
  }

  private handleMetrics(_msg: BaseMessage): void {
    const metrics = this.orchestrator.getMetrics();
    this.broker.postToWebview({
      id: `rt-metrics-${Date.now()}`,
      type: 'realtime:metrics:response',
      timestamp: Date.now(),
      payload: metrics,
    } as BaseMessage);
  }
}
