import { create } from 'zustand';
import type { ConflictStrategy } from '@sandforge/shared';
import { buildMessage } from '../bridge/messageHelpers';
import { getVscodeApi } from '../hooks/useVSCodeApi';

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
  /** Changed field values */
  changedFields: Record<string, unknown>;
  /** User who committed the change */
  commitUser: string;
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

const initialState = {
  status: 'disconnected' as CDCConnectionStatus,
  watchedObjects: [] as string[],
  autoSyncObjects: {} as Record<string, AutoSyncConfig>,
  events: [] as CDCFeedEvent[],
  eventCount: 0,
  sourceOrgId: null as string | null,
  targetOrgId: null as string | null,
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
    getVscodeApi().postMessage(
      buildMessage('realtime:start', {
        sourceOrgId: state.sourceOrgId ?? '',
        targetOrgId: state.targetOrgId ?? '',
        watchedObjects: state.watchedObjects,
        conflictStrategy: 'source_wins',
        flushIntervalMs: 150,
        maxBatchSize: 100,
      }),
    );
  },

  stopStream(): void {
    getVscodeApi().postMessage(
      buildMessage('realtime:stop', { sessionId: '' }),
    );
  },
}));

/**
 * Message listener for CDC events from the extension.
 * Listens for realtime:events-batch, realtime:started, realtime:stopped, realtime:status:response.
 */
function handleExtensionMessage(event: MessageEvent): void {
  const message = event.data;
  if (!message || typeof message !== 'object' || !('type' in message)) return;

  const msg = message as { type: string; payload?: Record<string, unknown> };

  switch (msg.type) {
    case 'realtime:events-batch': {
      const events = (msg.payload?.events ?? []) as CDCFeedEvent[];
      if (events.length > 0) {
        useCDCLiveStore.getState().pushEvents(events);
      }
      break;
    }
    case 'realtime:started': {
      useCDCLiveStore.getState().setStatus('syncing');
      break;
    }
    case 'realtime:stopped': {
      useCDCLiveStore.getState().setStatus('disconnected');
      break;
    }
    case 'realtime:status:response': {
      const status = msg.payload?.status as CDCConnectionStatus | undefined;
      if (status) {
        useCDCLiveStore.getState().setStatus(status);
      }
      break;
    }
    default:
      break;
  }
}

// Register message listener
if (typeof window !== 'undefined') {
  window.addEventListener('message', handleExtensionMessage);
}
