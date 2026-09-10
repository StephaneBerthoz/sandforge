import { create } from 'zustand';
import type { ConflictStrategy, UIConflict, ConflictType } from '@sandforge/shared';
import { sendBridgeMessage } from '../bridge/sendBridgeMessage';
import { useConflictStore } from './useConflictStore';

/** A single event in the live CDC feed, displayed in the WebView. */
export interface CDCFeedEvent {
  /** Replay ID for ordering */
  replayId: number;
  /** API name of the changed object */
  objectApiName: string;
  /** Type of change (CREATE, UPDATE, DELETE, UNDELETE) */
  changeType: string;
  /** Affected record IDs */
  recordIds: string[];
  /** ISO timestamp of the commit */
  commitTimestamp: string;
  /**
   * Changed field values.
   *
   * Optional because the feed is fed by two channels: `realtime:events-batch`
   * declares this field, the singular `realtime:event` does not
   * (realtime.messages.ts:65-96). Absent means the channel never sent it —
   * filling it with `{}` would claim the commit changed nothing.
   */
  changedFields?: Record<string, unknown>;
  /** User who committed the change — batch channel only, same reason. */
  commitUser?: string;
  /** Whether the event was applied to the target */
  applied: boolean;
  /** Error message if application failed */
  error?: string;
}

/** Per-object auto-sync configuration. */
export interface AutoSyncConfig {
  /** Whether auto-sync is enabled for this object */
  enabled: boolean;
  /** Conflict resolution strategy */
  conflictStrategy: ConflictStrategy;
}

/** Connection status for the CDC stream. */
export type CDCConnectionStatus = 'disconnected' | 'connecting' | 'syncing' | 'paused' | 'error';

/** Ring buffer capacity for event feed. */
const RING_BUFFER_CAPACITY = 5000;

/** State and actions for the CDC live event store. */
export interface CDCLiveState {
  /** Current connection status */
  status: CDCConnectionStatus;
  /** Currently watched object API names */
  watchedObjects: string[];
  /** Per-object auto-sync configuration */
  autoSyncObjects: Record<string, AutoSyncConfig>;
  /** Ring buffer contents in chronological order (oldest to newest) */
  events: CDCFeedEvent[];
  /** Total events received (may exceed buffer capacity) */
  eventCount: number;
  /** Source org ID */
  sourceOrgId: string | null;
  /** Target org ID */
  targetOrgId: string | null;
  /**
   * Id of the stream the host opened, as named on `realtime:started` (or on a
   * `realtime:status:response` for a session that outlived a webview reload).
   * `null` while no channel has named one; `realtime:stop` needs it to say
   * which stream to close.
   */
  sessionId: string | null;

  /** Update connection status. */
  setStatus: (status: CDCConnectionStatus) => void;
  /** Set the list of watched objects. */
  setWatchedObjects: (objects: string[]) => void;
  /** Toggle auto-sync for a specific object. */
  toggleAutoSync: (objectName: string) => void;
  /** Set conflict strategy for a specific object. */
  setConflictStrategy: (objectName: string, strategy: ConflictStrategy) => void;
  /** Push a batch of events into the ring buffer. */
  pushEvents: (batch: CDCFeedEvent[]) => void;
  /** Clear all events from the ring buffer. */
  clearEvents: () => void;
  /** Set the source and target org IDs. */
  setOrgs: (sourceOrgId: string, targetOrgId: string) => void;
  /** Full reset to initial state. */
  reset: () => void;
  /** Start the CDC stream (posts message to extension). */
  startStream: () => void;
  /** Stop the CDC stream (posts message to extension). */
  stopStream: () => void;
}

/** Internal ring buffer state (not exposed in Zustand state). */
let ringBuffer: Array<CDCFeedEvent | undefined> = new Array(RING_BUFFER_CAPACITY);
let writeIndex = 0;
let bufferCount = 0;

/** Read ring buffer contents in chronological order. */
function readRingBuffer(): CDCFeedEvent[] {
  if (bufferCount === 0) return [];
  const result: CDCFeedEvent[] = [];
  const start = bufferCount < RING_BUFFER_CAPACITY ? 0 : writeIndex;
  for (let i = 0; i < bufferCount; i++) {
    const idx = (start + i) % RING_BUFFER_CAPACITY;
    const event = ringBuffer[idx];
    if (event) {
      result.push(event);
    }
  }
  return result;
}

/** Reset the ring buffer internals. */
function resetRingBuffer(): void {
  ringBuffer = new Array(RING_BUFFER_CAPACITY);
  writeIndex = 0;
  bufferCount = 0;
}

/**
 * The single conflict strategy `realtime:start` can carry for a whole session.
 *
 * The panel collects one strategy per auto-synced object; `RealTimeStartRequest`
 * has room for exactly one (realtime.messages.ts:4-14). This reads the session
 * value back out of what the user actually picked:
 *
 * - every auto-synced watched object agreeing on a strategy — the case the
 *   panel is normally driven into — makes that strategy the session strategy;
 * - objects disagreeing means no single value is what the user asked for, so
 *   the session degrades to 'manual': the only option that resolves nothing by
 *   itself and hands the collision back, rather than applying to one object a
 *   rule that was chosen for another;
 * - nothing auto-synced means no automatic replication was asked for, hence no
 *   automatic resolution either — 'manual' again.
 *
 * Only objects still in `watchedObjects` count: unticking an object leaves its
 * `autoSyncObjects` entry behind, and that stale choice is not part of the
 * subscription being opened.
 */
function sessionConflictStrategy(
  watchedObjects: string[],
  autoSyncObjects: Record<string, AutoSyncConfig>,
): ConflictStrategy {
  const picked = watchedObjects
    .map((objectName) => autoSyncObjects[objectName])
    .filter((config): config is AutoSyncConfig => config?.enabled === true)
    .map((config) => config.conflictStrategy);

  const first = picked[0];
  if (first === undefined) return 'manual';
  return picked.every((strategy) => strategy === first) ? first : 'manual';
}

const initialState = {
  status: 'disconnected' as CDCConnectionStatus,
  watchedObjects: [] as string[],
  autoSyncObjects: {} as Record<string, AutoSyncConfig>,
  events: [] as CDCFeedEvent[],
  eventCount: 0,
  sourceOrgId: null as string | null,
  targetOrgId: null as string | null,
  sessionId: null as string | null,
};

/** Zustand store for managing CDC live event feed and subscription state. */
export const useCDCLiveStore = create<CDCLiveState>((set, get) => ({
  ...initialState,

  setStatus(status: CDCConnectionStatus): void {
    set({ status });
  },

  setWatchedObjects(objects: string[]): void {
    set({ watchedObjects: objects });
  },

  toggleAutoSync(objectName: string): void {
    const current = get().autoSyncObjects;
    const existing = current[objectName];
    if (existing) {
      const updated = { ...current };
      delete updated[objectName];
      set({ autoSyncObjects: updated });
    } else {
      set({
        autoSyncObjects: {
          ...current,
          [objectName]: { enabled: true, conflictStrategy: 'source_wins' },
        },
      });
    }
  },

  setConflictStrategy(objectName: string, strategy: ConflictStrategy): void {
    const current = get().autoSyncObjects;
    const existing = current[objectName];
    if (existing) {
      set({
        autoSyncObjects: {
          ...current,
          [objectName]: { ...existing, conflictStrategy: strategy },
        },
      });
    }
  },

  pushEvents(batch: CDCFeedEvent[]): void {
    for (const event of batch) {
      ringBuffer[writeIndex] = event;
      writeIndex = (writeIndex + 1) % RING_BUFFER_CAPACITY;
      bufferCount = Math.min(bufferCount + 1, RING_BUFFER_CAPACITY);
    }
    set({
      events: readRingBuffer(),
      eventCount: get().eventCount + batch.length,
    });
  },

  clearEvents(): void {
    resetRingBuffer();
    set({ events: [], eventCount: 0 });
  },

  setOrgs(sourceOrgId: string, targetOrgId: string): void {
    set({ sourceOrgId, targetOrgId });
  },

  reset(): void {
    resetRingBuffer();
    set({ ...initialState });
  },

  startStream(): void {
    const state = get();
    set({ status: 'connecting' });
    sendBridgeMessage('realtime:start', {
      sourceOrgId: state.sourceOrgId ?? '',
      targetOrgId: state.targetOrgId ?? '',
      watchedObjects: state.watchedObjects,
      // The strategy the user picked in the panel, not a constant: this field
      // decides which org's data survives a collision, so a hardcoded
      // 'source_wins' made every selector in the panel a decoration.
      conflictStrategy: sessionConflictStrategy(state.watchedObjects, state.autoSyncObjects),
      flushIntervalMs: 150,
      maxBatchSize: 100,
    });
  },

  stopStream(): void {
    // Name the stream `realtime:started` opened. Posting '' unconditionally
    // asked the host to close "whichever" — with two panels open, or a session
    // that outlived a webview reload, that identifies nothing. The empty string
    // survives only for the case where no channel ever handed an id over: the
    // contract's `sessionId` is a required string with no way to say "unknown".
    sendBridgeMessage('realtime:stop', { sessionId: get().sessionId ?? '' });
  },
}));

/**
 * The events a CDC push message carries.
 *
 * `realtime:events-batch` carries the host flush timer's array; `realtime:event`
 * is the same event at arity one (realtime.messages.ts:65-96). Both are read
 * here, and both leave through the single `pushEvents` call below, so the
 * singular channel cannot drift from the batch one on feed order, the ring
 * buffer's retention cap or `eventCount`.
 */
function readPushedEvents(msg: {
  type: string;
  payload?: Record<string, unknown>;
}): CDCFeedEvent[] {
  if (msg.type === 'realtime:event') {
    return msg.payload ? [msg.payload as unknown as CDCFeedEvent] : [];
  }
  return (msg.payload?.events ?? []) as CDCFeedEvent[];
}

/**
 * Message listener for CDC events from the extension.
 * Listens for realtime:event, realtime:events-batch, realtime:started,
 * realtime:stopped, realtime:conflict and realtime:status:response.
 */
function handleExtensionMessage(event: MessageEvent): void {
  // SECURITY: Validate origin — only accept messages from the VSCode webview
  // host ('vscode-webview://...') or empty origin (tests, some environments).
  if (event.origin && !event.origin.startsWith('vscode-webview://')) {
    return;
  }
  const message = event.data;
  if (!message || typeof message !== 'object' || !('type' in message)) return;

  const msg = message as { type: string; payload?: Record<string, unknown> };

  switch (msg.type) {
    case 'realtime:event':
    case 'realtime:events-batch': {
      const events = readPushedEvents(msg);
      if (events.length > 0) {
        useCDCLiveStore.getState().pushEvents(events);
      }
      break;
    }
    case 'realtime:started': {
      // While CDC is unimplemented the extension answers this channel from
      // NoOpHandler with `{ success: false, comingSoon: true }`. Reporting
      // 'syncing' regardless flipped the badge to a success-green "Syncing"
      // that never changed and never received an event — the UI claimed a
      // live stream that does not exist.
      const started = msg.payload as { success?: boolean; sessionId?: string } | undefined;
      const opened = started?.success !== false;
      useCDCLiveStore.setState({
        status: opened ? 'syncing' : 'error',
        // `realtime:stop` has to name the stream this opened. A refused start
        // opened none, so it leaves no id behind to stop.
        sessionId: opened && typeof started?.sessionId === 'string' ? started.sessionId : null,
      });
      break;
    }
    case 'realtime:stopped': {
      // The stream is closed; its id no longer names anything stoppable.
      useCDCLiveStore.setState({ status: 'disconnected', sessionId: null });
      break;
    }
    case 'realtime:conflict': {
      const p = msg.payload as Record<string, unknown> | undefined;
      if (p) {
        const objectApiName = String(p.objectApiName ?? '');
        const recordIds = (p.recordIds ?? []) as string[];
        const changeType = String(p.changeType ?? 'UPDATE');
        const sourceValues = (p.sourceValues ?? {}) as Record<string, unknown>;
        const targetValues = (p.targetValues ?? {}) as Record<string, unknown>;
        const replayId = String(p.replayId ?? Date.now());
        const targetLastModified = String(p.targetLastModified ?? new Date().toISOString());

        const conflictTypeMap: Record<string, ConflictType> = {
          UPDATE: 'edit/edit',
          DELETE: 'delete/edit',
          CREATE: 'create/edit',
        };

        const conflictFields = Object.keys(sourceValues).filter(
          (k) => JSON.stringify(sourceValues[k]) !== JSON.stringify(targetValues[k]),
        );

        const uiConflict: UIConflict = {
          id: `${objectApiName}:${recordIds[0] ?? 'unknown'}:${replayId}`,
          objectApiName,
          recordId: recordIds[0] ?? 'unknown',
          conflictType: conflictTypeMap[changeType] ?? 'edit/edit',
          sourceValues,
          targetValues,
          conflictFields,
          timestamp: targetLastModified,
          resolved: false,
        };

        useConflictStore.getState().addConflict(uiConflict);
      }
      break;
    }
    case 'realtime:status:response': {
      const response = msg.payload as { status?: string; sessionId?: string } | undefined;
      // This is also how a reloaded webview learns the session the host still
      // has open — the id it needs to be able to stop it. A response without
      // one says nothing about the id, so it does not clear what is known.
      if (typeof response?.sessionId === 'string' && response.sessionId.length > 0) {
        useCDCLiveStore.setState({ sessionId: response.sessionId });
      }
      const status = response?.status as CDCConnectionStatus | undefined;
      if (status) {
        useCDCLiveStore.getState().setStatus(status);
      }
      break;
    }
    default:
      break;
  }
}

// HMR-safe listener registration — same pattern as useCDCMetricsStore:
// without the guard, Vite's hot-module replace re-imports this module and
// stacks N copies of the listener, duplicating every CDC event N times.
let cdcLiveListenerRegistered = false;
function registerCdcLiveListener(): void {
  if (cdcLiveListenerRegistered || typeof window === 'undefined') return;
  cdcLiveListenerRegistered = true;
  window.addEventListener('message', handleExtensionMessage);
  if (typeof import.meta !== 'undefined' && import.meta.hot) {
    import.meta.hot.dispose(() => {
      window.removeEventListener('message', handleExtensionMessage);
      cdcLiveListenerRegistered = false;
    });
  }
}
registerCdcLiveListener();
